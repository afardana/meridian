#!/usr/bin/env node
/**
 * scripts/replay/bidask_flip_replay.js — OFFLINE, read-only replay that decides the registered
 * hypothesis docs/experiments/bidask-flip.md (bid-ask flip of the converted bins on the way down).
 *
 * Inputs (both local files, nothing else is read — no .env, no DB, no network):
 *   --records  a JSON array of perf records (scripts/experiments/export.sh → performance.json)
 *   --ticks    the poller tick export (scripts/replay/bidask_flip_export.sql, run on the VM),
 *              CSV or gzip CSV: position_address,t(epoch s),active_bin,pnl_pct
 *
 *   node scripts/replay/bidask_flip_replay.js --records .experiments/status/performance.json \
 *     --ticks ticks.csv.gz [--json out.json] [--from 2026-09-26T00:00:00Z] [--to 2026-11-14T00:00:00Z]
 *
 * Model (all values in SOL; p(i) = (1+binStep/1e4)^(i − hi), so p(hi) = 1):
 *   - bin i holds X_i tokens; value at active bin a = Σ_{i≤a} X_i·p(i) + Σ_{i>a} X_i·p(a)
 *     (the active bin itself is counted at p(a)); token value held = p(a)·(Σ_{i>a} X_i + ½·X_a).
 *   - initial SOL per bin: spot C/n; bid_ask linear, top bin weight 1 … bottom bin weight n.
 *   - flip at a: pool the tokens of every in-range bin above a and re-add them over those bins,
 *     SOL-value weights rising linearly from the bin just above a to the top bin (bid-ask) or flat.
 *   - fees attributed to bin crossings by the SOL value of the crossed bin, scaled so the passive
 *     ladder's modelled fees equal the recorded fees.
 * The spec is pre-registered; do not tune it here. See the hypothesis file for the pass rule.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const GAS_PER_FLIP_SOL = 0.0001;
export const TIE_SOL = 0.0005;
export const BOOT_RESAMPLES = 2000;
export const BOOT_SEED = 20261123;
export const DEFAULT_FROM = "2026-09-26T00:00:00Z";
export const DEFAULT_TO = "2026-11-14T00:00:00Z";
export const TRAIL_ARM_PCT = 2;
export const TRAIL_DROP_PP = 1.5;

export const PRIMARY = { id: "N15_bidask_step", N: 15, readd: "bidask", mode: "step", primary: true };
export const VARIANTS = [
  PRIMARY,
  { id: "N10_bidask_step", N: 10, readd: "bidask", mode: "step" },
  { id: "N20_bidask_step", N: 20, readd: "bidask", mode: "step" },
  { id: "N15_spot_step", N: 15, readd: "spot", mode: "step" },
  { id: "bottom_bidask", N: null, readd: "bidask", mode: "bottom" },
];

export const EXCLUSION_REASONS = [
  "adopted",
  "rebalance_leg",
  "no_close_time",
  "before_from",
  "at_or_after_to",
  "straddled",
  "re_ranged",
  "was_held",
  "strategy_not_spot_or_bid_ask",
  "missing_geometry",
  "non_sol_quote",
  "no_minutes_held",
  "fewer_than_2_ticks_in_window",
  "first_tick_late",
];

// ─── bin model ─────────────────────────────────────────────────────────────

/** p(i) relative to the top bin, for ANY integer i. */
export function priceOf(L, i) {
  return Math.pow(1 + L.s, i - L.hi);
}

/** Build the initial (all-SOL) ladder. strategy: "spot" | "bid_ask". */
export function initLadder({ lo, hi, binStep, C, strategy }) {
  const n = hi - lo + 1;
  const s = binStep / 1e4;
  const L = { lo, hi, n, s, C, pr: new Float64Array(n), X: new Float64Array(n), reshaped: new Uint8Array(n) };
  let wSum = 0;
  if (strategy === "bid_ask") for (let i = lo; i <= hi; i++) wSum += hi - i + 1;
  for (let k = 0; k < n; k++) {
    const i = lo + k;
    L.pr[k] = Math.pow(1 + s, i - hi);
    const y = strategy === "bid_ask" ? (C * (hi - i + 1)) / wSum : C / n;
    L.X[k] = y / L.pr[k];
  }
  return L;
}

export function cloneLadder(L) {
  return { ...L, X: Float64Array.from(L.X), reshaped: Uint8Array.from(L.reshaped) };
}

/** V(X, a). */
export function ladderValue(L, a) {
  const pa = priceOf(L, a);
  let v = 0;
  for (let k = 0; k < L.n; k++) {
    const i = L.lo + k;
    v += i <= a ? L.X[k] * L.pr[k] : L.X[k] * pa;
  }
  return v;
}

/** Tok(X, a) = p(a)·(Σ_{i>a} X_i + 0.5·X_a if lo≤a≤hi). */
export function tokenValue(L, a) {
  const pa = priceOf(L, a);
  let x = 0;
  for (let k = 0; k < L.n; k++) {
    const i = L.lo + k;
    if (i > a) x += L.X[k];
    else if (i === a) x += 0.5 * L.X[k];
  }
  return pa * x;
}

/** Σ X_i over in-range bins. */
export function tokenCount(L) {
  let t = 0;
  for (let k = 0; k < L.n; k++) t += L.X[k];
  return t;
}

/**
 * Flip at active bin a: S = in-range bins above a. Returns true when a flip happened
 * (S non-empty). readd: "bidask" (w_i = i − i0 + 1) | "spot" (w_i = 1).
 */
export function flipAt(L, a, readd) {
  const start = Math.max(a + 1, L.lo);
  if (start > L.hi) return false;
  let T = 0;
  for (let i = start; i <= L.hi; i++) T += L.X[i - L.lo];
  let denom = 0;
  for (let i = start; i <= L.hi; i++) {
    const w = readd === "spot" ? 1 : i - start + 1;
    denom += w / L.pr[i - L.lo];
  }
  for (let i = start; i <= L.hi; i++) {
    const k = i - L.lo;
    const w = readd === "spot" ? 1 : i - start + 1;
    L.X[k] = (T * (w / L.pr[k])) / denom;
    L.reshaped[k] = 1;
  }
  return true;
}

/** Bins crossed by a move aPrev → aCur (up: aPrev … aCur−1; down: aCur+1 … aPrev). */
export function crossedRange(aPrev, aCur) {
  if (aPrev === aCur) return null;
  return aCur > aPrev ? [aPrev, aCur - 1] : [aCur + 1, aPrev];
}

/** Fee weight of a crossing: { w: Σ X_i·p(i) over crossed in-range bins, wReshaped }. */
export function accrueCrossing(L, aPrev, aCur) {
  const r = crossedRange(aPrev, aCur);
  if (!r) return { w: 0, wReshaped: 0 };
  const from = Math.max(r[0], L.lo);
  const to = Math.min(r[1], L.hi);
  let w = 0, wR = 0;
  for (let i = from; i <= to; i++) {
    const k = i - L.lo;
    const li = L.X[k] * L.pr[k];
    w += li;
    if (L.reshaped[k]) wR += li;
  }
  return { w, wReshaped: wR };
}

// ─── trailing rule ─────────────────────────────────────────────────────────

/**
 * First index where the trailing rule fires on a pnl path (null entries are skipped).
 * peak = running max; armed once peak ≥ 2; fires when armed and pnl ≤ peak − 1.5.
 */
export function trailingFireIndex(pnls, armPct = TRAIL_ARM_PCT, dropPp = TRAIL_DROP_PP) {
  let peak = -Infinity;
  for (let k = 0; k < pnls.length; k++) {
    const v = pnls[k];
    if (v == null || !Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak >= armPct && v <= peak - dropPp) return k;
  }
  return null;
}

// ─── record helpers ────────────────────────────────────────────────────────

export function closeTimeSec(rec) {
  const t = Date.parse(rec?.recorded_at);
  return Number.isFinite(t) ? t / 1000 : null;
}

export function feesSol(rec) {
  const a = Number(rec?.fees_sol_true);
  if (rec?.fees_sol_true != null && Number.isFinite(a)) return a;
  const b = Number(rec?.fees_earned_usd);
  if (rec?.fees_earned_usd != null && Number.isFinite(b)) return b;
  return null;
}

/** The record's own exit-slippage ratio, clamped to [0, 0.10]; null when not computable. */
export function ownExitSlipRatio(rec) {
  const es = rec?.exit_swap;
  if (!es || es.slippage_basis !== "pool") return null;
  const slip = Number(rec.exit_slippage_sol);
  const recv = Number(es.sol_received);
  if (rec.exit_slippage_sol == null || es.sol_received == null) return null;
  if (!Number.isFinite(slip) || !Number.isFinite(recv)) return null;
  const den = recv + slip;
  if (!(den > 0)) return null;
  return Math.min(0.1, Math.max(0, slip / den));
}

/** Ticks inside [t_open − 60, t_close + 60]. */
export function windowTicks(ticks, tOpen, tClose) {
  if (!ticks) return [];
  return ticks.filter((x) => x.t >= tOpen - 60 && x.t <= tClose + 60);
}

/**
 * Population filter. Returns { reason } for an excluded record, or
 * { reason: null, tOpen, tClose, ticks } for an included one. Reasons in EXCLUSION_REASONS order.
 */
export function classifyRecord(rec, ticksByPos, { from = DEFAULT_FROM, to = DEFAULT_TO } = {}) {
  if (rec.adopted) return { reason: "adopted" };
  if (rec.rebalance_leg) return { reason: "rebalance_leg" };
  const tClose = closeTimeSec(rec);
  if (tClose == null) return { reason: "no_close_time" };
  const fromS = Date.parse(from) / 1000, toS = Date.parse(to) / 1000;
  if (tClose < fromS) return { reason: "before_from" };
  if (tClose >= toS) return { reason: "at_or_after_to" };
  if ((rec.straddle_count || 0) != 0) return { reason: "straddled" };
  if ((rec.rebalance_count || 0) != 0) return { reason: "re_ranged" };
  if (rec.was_held === true) return { reason: "was_held" };
  if (rec.strategy !== "spot" && rec.strategy !== "bid_ask") return { reason: "strategy_not_spot_or_bid_ask" };
  const br = rec.bin_range;
  const lo = Number(br?.min), hi = Number(br?.max), bs = Number(rec.bin_step), C = Number(rec.amount_sol);
  if (br?.min == null || br?.max == null || !Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo
    || rec.bin_step == null || !(bs > 0) || !(C > 0)) return { reason: "missing_geometry" };
  const ym = rec.asset_profile?.token_y_mint;
  if (ym != null && ym !== SOL_MINT) return { reason: "non_sol_quote" };
  const mh = Number(rec.minutes_held);
  if (rec.minutes_held == null || !Number.isFinite(mh)) return { reason: "no_minutes_held" };
  const tOpen = tClose - mh * 60;
  const ticks = windowTicks(ticksByPos?.get?.(rec.position), tOpen, tClose);
  if (ticks.length < 2) return { reason: "fewer_than_2_ticks_in_window" };
  if (ticks[0].t > tOpen + 15 * 60) return { reason: "first_tick_late" };
  return { reason: null, tOpen, tClose, ticks, lo, hi, binStep: bs, C };
}

// ─── per-position simulation ───────────────────────────────────────────────

/** Passive ladder over the ticks → { W_p, ladder, a_end, perTick: [{Wp}] }. */
export function simulatePassive(geom, ticks) {
  const L = initLadder(geom);
  let Wp = 0;
  const WpAt = new Float64Array(ticks.length);
  for (let k = 0; k < ticks.length; k++) {
    if (k > 0) Wp += accrueCrossing(L, ticks[k - 1].a, ticks[k].a).w;
    WpAt[k] = Wp;
  }
  return { L, Wp, WpAt, a_end: ticks[ticks.length - 1].a };
}

/**
 * Simulate one variant on one position.
 * geom = { lo, hi, binStep, C, strategy }; ticks = [{ t, a, pnl }]; F = recorded fees (SOL);
 * r = exit-slippage ratio; pnlRec = record.pnl_pct.
 */
export function simulateVariant(geom, ticks, variant, { F, r, pnlRec, passive = null }) {
  const P = passive || simulatePassive(geom, ticks);
  const Lp = P.L;
  const Lf = initLadder(geom);
  const nT = ticks.length;
  let Wf = 0, WfR = 0, flips = 0, anchor = geom.hi, bottomDone = false;
  const flipEvents = [];
  const WfAt = new Float64Array(nT);
  const dVAt = new Float64Array(nT);
  const flipsAt = new Int32Array(nT);
  const tokFAt = new Float64Array(nT);
  for (let k = 0; k < nT; k++) {
    const a = ticks[k].a;
    if (k > 0) {
      const acc = accrueCrossing(Lf, ticks[k - 1].a, a); // accrue first, on the pre-flip X
      Wf += acc.w;
      WfR += acc.wReshaped;
    }
    let doFlip = false;
    if (variant.mode === "step") {
      if (a <= anchor - variant.N) doFlip = true;
    } else if (variant.mode === "bottom") {
      if (!bottomDone && a < geom.lo) doFlip = true;
    }
    if (doFlip) {
      const did = flipAt(Lf, a, variant.readd);
      if (did) {
        flips++;
        flipEvents.push({ t: ticks[k].t, bin: a });
        if (variant.mode === "step") anchor = a;
        else bottomDone = true;
      }
    }
    WfAt[k] = Wf;
    flipsAt[k] = flips;
    if (flips > 0) {
      dVAt[k] = ladderValue(Lf, a) - ladderValue(Lp, a);
      tokFAt[k] = tokenValue(Lf, a);
    } else {
      dVAt[k] = 0;
      tokFAt[k] = tokenValue(Lp, a);
    }
  }
  const aEnd = P.a_end;
  const Wp = P.Wp;
  const dCapital = ladderValue(Lf, aEnd) - ladderValue(Lp, aEnd);
  const c = Wp > 0 ? F / Wp : 0;
  const dFee = Wp > 0 ? c * Wf - F : 0;
  const dFeeRobust = Wp > 0 ? c * (Wf - 0.5 * WfR) - F : 0;
  const gas = GAS_PER_FLIP_SOL * flips;
  const tokPEnd = tokenValue(Lp, aEnd);
  const tokFEnd = tokenValue(Lf, aEnd);
  const exitExtra = Math.max(0, tokFEnd - tokPEnd) * r;
  const delta = dCapital + dFee - gas - exitExtra;
  const deltaRobust = dCapital + dFeeRobust - gas - exitExtra;

  // exit interaction: trailing re-run on the recorded and the flipped pnl paths
  const C = geom.C;
  const pnlRecPath = new Array(nT);
  const pnlFPath = new Array(nT);
  for (let k = 0; k < nT; k++) {
    const pr = ticks[k].pnl;
    if (pr == null || !Number.isFinite(pr)) { pnlRecPath[k] = null; pnlFPath[k] = null; continue; }
    pnlRecPath[k] = pr;
    pnlFPath[k] = pr + (100 * (dVAt[k] + c * (WfAt[k] - P.WpAt[k]) - GAS_PER_FLIP_SOL * flipsAt[k])) / C;
  }
  const kRec = trailingFireIndex(pnlRecPath);
  const kF = trailingFireIndex(pnlFPath);
  let early = false, deltaInt = delta;
  if (kF != null && (kRec == null || kF < kRec)) {
    early = true;
    deltaInt = ((pnlFPath[kF] - pnlRec) / 100) * C - r * (tokFAt[kF] - tokPEnd);
  }
  return {
    flips, flip_events: flipEvents,
    W_p: Wp, W_f: Wf, W_f_reshaped: WfR, c,
    d_capital: dCapital, d_fee: dFee, d_fee_robust: dFeeRobust, gas,
    tok_p_end: tokPEnd, tok_f_end: tokFEnd, exit_extra: exitExtra,
    delta, delta_robust: deltaRobust,
    delta_int: deltaInt, early_close: early,
    k_rec_t: kRec != null ? ticks[kRec].t : null, k_f_t: kF != null ? ticks[kF].t : null,
    pnl_f_at_kf: kF != null ? pnlFPath[kF] : null,
    a_end: aEnd,
  };
}

// ─── statistics ────────────────────────────────────────────────────────────

export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded bootstrap 90 % CI of Σ xs. */
export function bootstrapSumCI(xs, resamples = BOOT_RESAMPLES, seed = BOOT_SEED) {
  if (!xs.length) return { lo: null, hi: null };
  const rnd = mulberry32(seed);
  const sums = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rnd() * xs.length)];
    sums[b] = s;
  }
  const sorted = Array.from(sums).sort((a, b) => a - b);
  return { lo: sorted[Math.floor(0.05 * resamples)], hi: sorted[Math.floor(0.95 * resamples)] };
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** Aggregate one variant's rows (rows of positions with ≥ 1 flip are the decision set). */
export function summarizeVariant(rows) {
  const flipped = rows.filter((r) => r.flips > 0).sort((a, b) => a.t_close - b.t_close);
  const deltas = flipped.map((r) => r.delta);
  const n = flipped.length;
  const largestIdx = deltas.length ? deltas.indexOf(Math.max(...deltas)) : -1;
  const withoutLargest = deltas.filter((_, i) => i !== largestIdx);
  const better = deltas.filter((d) => d > TIE_SOL).length;
  const worse = deltas.filter((d) => d < -TIE_SOL).length;
  const tie = n - better - worse;
  const h = Math.floor(n / 2);
  const early = flipped.filter((r) => r.early_close);
  return {
    n_positions: rows.length,
    n_flipped: n,
    total_flips: sum(flipped.map((r) => r.flips)),
    sum_d_capital: sum(flipped.map((r) => r.d_capital)),
    sum_d_fee: sum(flipped.map((r) => r.d_fee)),
    sum_gas: sum(flipped.map((r) => r.gas)),
    sum_exit_extra: sum(flipped.map((r) => r.exit_extra)),
    sum_delta: sum(deltas),
    sum_delta_without_largest: sum(withoutLargest),
    largest_delta: largestIdx >= 0 ? deltas[largestIdx] : null,
    better, worse, tie,
    half1_n: h, half1_sum: sum(deltas.slice(0, h)),
    half2_n: n - h, half2_sum: sum(deltas.slice(h)),
    sum_delta_robust: sum(flipped.map((r) => r.delta_robust)),
    sum_delta_int: sum(flipped.map((r) => r.delta_int)),
    n_early_close: early.length,
    sum_delta_int_early: sum(early.map((r) => r.delta_int)),
    boot90: bootstrapSumCI(deltas),
  };
}

export function verdictFor(summary, validity) {
  const checks = [
    { id: 1, name: "n >= 30 positions with a flip", pass: summary.n_flipped >= 30, value: summary.n_flipped },
    { id: 2, name: "sum delta > 0", pass: summary.sum_delta > 0, value: summary.sum_delta },
    { id: 3, name: "sum delta without the largest delta > 0", pass: summary.sum_delta_without_largest > 0, value: summary.sum_delta_without_largest },
    { id: 4, name: "better >= 2 x worse (|delta| <= 0.0005 tie)", pass: summary.better >= 2 * summary.worse, value: `${summary.better} / ${summary.worse} / ${summary.tie}` },
    { id: 5, name: "both halves by close time sum delta > 0", pass: summary.half1_sum > 0 && summary.half2_sum > 0, value: `${summary.half1_sum} / ${summary.half2_sum}` },
    { id: 6, name: "fee-robust sum delta > 0", pass: summary.sum_delta_robust > 0, value: summary.sum_delta_robust },
    { id: 7, name: "exit interaction sum delta > 0", pass: summary.sum_delta_int > 0, value: summary.sum_delta_int },
  ];
  let verdict;
  if (!validity.valid) verdict = "invalid_model";
  else if (!checks[0].pass) verdict = "insufficient";
  else verdict = checks.every((c) => c.pass) ? "met" : "not_met";
  return { verdict, checks, model_valid: validity.valid };
}

function maeBucket(mae) {
  if (mae == null || !Number.isFinite(Number(mae))) return "unknown";
  const m = Number(mae);
  if (m > -3) return "> -3";
  if (m > -6) return "-3 … -6";
  if (m > -10) return "-6 … -10";
  if (m > -15) return "-10 … -15";
  return "<= -15";
}
const MAE_ORDER = ["> -3", "-3 … -6", "-6 … -10", "-10 … -15", "<= -15", "unknown"];

// ─── input parsing ─────────────────────────────────────────────────────────

/** Parse the tick CSV text → { byPos: Map(position → [{t, a, pnl}]), stats }. */
export function parseTicksCsv(text) {
  const byPos = new Map();
  const stats = { rows: 0, header_skipped: 0, bad_rows: 0, empty_pnl: 0 };
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, "");
    start = end + 1;
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 3) { stats.bad_rows++; continue; }
    const t = Number(parts[1]);
    const a = Number(parts[2]);
    if (!Number.isFinite(t) || parts[2] === "" || !Number.isInteger(a)) {
      if (stats.rows === 0 && byPos.size === 0 && !Number.isFinite(t)) stats.header_skipped++;
      else stats.bad_rows++;
      continue;
    }
    const pRaw = parts[3];
    let pnl = null;
    if (pRaw != null && pRaw !== "") {
      const v = Number(pRaw);
      pnl = Number.isFinite(v) ? v : null;
    }
    if (pnl == null) stats.empty_pnl++;
    stats.rows++;
    const pos = parts[0];
    let arr = byPos.get(pos);
    if (!arr) { arr = []; byPos.set(pos, arr); }
    arr.push({ t, a, pnl });
  }
  for (const arr of byPos.values()) arr.sort((x, y) => x.t - y.t);
  stats.positions = byPos.size;
  return { byPos, stats };
}

export function readTicksFile(p) {
  const buf = fs.readFileSync(p);
  const text = (p.endsWith(".gz") || (buf[0] === 0x1f && buf[1] === 0x8b)) ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return parseTicksCsv(text);
}

// ─── whole replay ──────────────────────────────────────────────────────────

export function runReplay(records, ticksByPos, { from = DEFAULT_FROM, to = DEFAULT_TO, variants = VARIANTS } = {}) {
  const exclusions = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0]));
  const excludedStrategies = {};
  const pop = [];
  for (const rec of records) {
    const c = classifyRecord(rec, ticksByPos, { from, to });
    if (c.reason) {
      exclusions[c.reason] = (exclusions[c.reason] || 0) + 1;
      if (c.reason === "strategy_not_spot_or_bid_ask") {
        const k = String(rec.strategy);
        excludedStrategies[k] = (excludedStrategies[k] || 0) + 1;
      }
      continue;
    }
    pop.push({ rec, ...c });
  }

  // exit-slippage ratios: own, else the population median
  const ownRatios = pop.map((p) => ownExitSlipRatio(p.rec));
  const computable = ownRatios.filter((x) => x != null);
  const medianR = computable.length ? quantile(computable, 0.5) : 0;

  // data notes
  const notes = {
    fees_missing: 0, first_bin_eq_hi: 0, first_bin_above_hi: 0, first_bin_below_hi: 0,
    first_bin_below_hi_offsets: [], first_bin_above_hi_offsets: [], first_bin_below_lo: 0,
    first_tick_before_open: 0, ticks_below_lo: 0, ticks_above_hi: 0, ticks_total: 0,
    max_bins_below_lo: 0, max_bins_above_hi: 0, positions_with_no_pnl_ticks: 0,
    negative_exit_slippage_clamped: 0, exit_slippage_above_cap: 0,
    bins_below_mismatch: 0, duplicate_positions: 0,
    r_own: computable.length, r_median: medianR,
  };
  const seen = new Set();
  for (const p of pop) {
    if (seen.has(p.rec.position)) notes.duplicate_positions++;
    seen.add(p.rec.position);
    if (feesSol(p.rec) == null) notes.fees_missing++;
    const a0 = p.ticks[0].a;
    if (a0 === p.hi) notes.first_bin_eq_hi++;
    else if (a0 > p.hi) { notes.first_bin_above_hi++; notes.first_bin_above_hi_offsets.push(a0 - p.hi); }
    else { notes.first_bin_below_hi++; notes.first_bin_below_hi_offsets.push(p.hi - a0); if (a0 < p.lo) notes.first_bin_below_lo++; }
    if (p.ticks[0].t < p.tOpen) notes.first_tick_before_open++;
    if (!p.ticks.some((x) => x.pnl != null)) notes.positions_with_no_pnl_ticks++;
    for (const x of p.ticks) {
      notes.ticks_total++;
      if (x.a < p.lo) { notes.ticks_below_lo++; notes.max_bins_below_lo = Math.max(notes.max_bins_below_lo, p.lo - x.a); }
      if (x.a > p.hi) { notes.ticks_above_hi++; notes.max_bins_above_hi = Math.max(notes.max_bins_above_hi, x.a - p.hi); }
    }
    const es = p.rec.exit_swap;
    if (es?.slippage_basis === "pool" && Number(p.rec.exit_slippage_sol) < 0) notes.negative_exit_slippage_clamped++;
    const raw = Number(p.rec.exit_slippage_sol) / (Number(es?.sol_received) + Number(p.rec.exit_slippage_sol));
    if (es?.slippage_basis === "pool" && Number.isFinite(raw) && raw > 0.1) notes.exit_slippage_above_cap++;
    const bb = p.rec.bin_range?.bins_below;
    if (bb != null && Number(bb) !== p.hi - p.lo) notes.bins_below_mismatch++;
  }
  const summarizeOffsets = (xs) => xs.length ? { n: xs.length, median: quantile(xs, 0.5), p90: quantile(xs, 0.9), max: Math.max(...xs) } : { n: 0 };
  notes.first_bin_below_hi_offsets = summarizeOffsets(notes.first_bin_below_hi_offsets);
  notes.first_bin_above_hi_offsets = summarizeOffsets(notes.first_bin_above_hi_offsets);

  // validity (variant independent) + passive sims
  const posRows = pop.map((p, idx) => {
    const geom = { lo: p.lo, hi: p.hi, binStep: p.binStep, C: p.C, strategy: p.rec.strategy };
    const passive = simulatePassive(geom, p.ticks);
    const F = feesSol(p.rec) ?? 0;
    const pnlRec = Number(p.rec.pnl_pct);
    const err = (100 * (ladderValue(passive.L, passive.a_end) - p.C)) / p.C + (100 * F) / p.C - pnlRec;
    const r = ownRatios[idx] != null ? ownRatios[idx] : medianR;
    return { p, geom, passive, F, pnlRec, err, r, r_source: ownRatios[idx] != null ? "own" : "median" };
  });
  const validOf = (rows) => {
    const abs = rows.map((x) => Math.abs(x.err)).filter(Number.isFinite);
    return { n: abs.length, median_abs_err: quantile(abs, 0.5), p75_abs_err: quantile(abs, 0.75), p90_abs_err: quantile(abs, 0.9) };
  };
  const validity = validOf(posRows);
  validity.valid = validity.median_abs_err != null && validity.median_abs_err <= 1;
  validity.by_strategy = {};
  for (const st of ["spot", "bid_ask"]) validity.by_strategy[st] = validOf(posRows.filter((x) => x.p.rec.strategy === st));
  validity.by_exit_family = {};
  const fams = [...new Set(posRows.map((x) => x.p.rec.exit_family ?? "unknown"))].sort();
  for (const f of fams) validity.by_exit_family[f] = validOf(posRows.filter((x) => (x.p.rec.exit_family ?? "unknown") === f));
  validity.largest_abs_err = [...posRows].filter((x) => Number.isFinite(x.err)).sort((a, b) => Math.abs(b.err) - Math.abs(a.err)).slice(0, 10)
    .map((x) => ({ position: x.p.rec.position, pool_name: x.p.rec.pool_name, recorded_at: x.p.rec.recorded_at, strategy: x.p.rec.strategy, exit_family: x.p.rec.exit_family, pnl_pct: x.pnlRec, err: x.err }));

  // variants
  const variantResults = [];
  for (const v of variants) {
    const rows = posRows.map((x) => {
      const res = simulateVariant(x.geom, x.p.ticks, v, { F: x.F, r: x.r, pnlRec: x.pnlRec, passive: x.passive });
      return {
        position: x.p.rec.position, pool_name: x.p.rec.pool_name, recorded_at: x.p.rec.recorded_at,
        t_close: x.p.tClose, strategy: x.p.rec.strategy, exit_family: x.p.rec.exit_family ?? null,
        pnl_pct: x.pnlRec, mae_pnl_pct: x.p.rec.mae_pnl_pct ?? null, amount_sol: x.p.C,
        bin_lo: x.p.lo, bin_hi: x.p.hi, bin_step: x.p.binStep, first_bin: x.p.ticks[0].a, ticks: x.p.ticks.length,
        F: x.F, r: x.r, r_source: x.r_source, model_err: x.err,
        ...res,
      };
    });
    const summary = summarizeVariant(rows);
    const out = { variant: v, summary, rows };
    if (v.primary) {
      const fam = {}, mae = {};
      for (const r of rows) {
        const f = r.exit_family ?? "unknown";
        fam[f] ||= { n: 0, n_flipped: 0, sum_delta: 0 };
        fam[f].n++; if (r.flips > 0) { fam[f].n_flipped++; fam[f].sum_delta += r.delta; }
        const b = maeBucket(r.mae_pnl_pct);
        mae[b] ||= { n: 0, n_flipped: 0, sum_delta: 0 };
        mae[b].n++; if (r.flips > 0) { mae[b].n_flipped++; mae[b].sum_delta += r.delta; }
      }
      out.by_exit_family = fam;
      out.by_mae_bucket = Object.fromEntries(MAE_ORDER.filter((k) => mae[k]).map((k) => [k, mae[k]]));
      const fl = rows.filter((r) => r.flips > 0);
      const pick = (r) => ({ pool_name: r.pool_name, recorded_at: r.recorded_at, exit_family: r.exit_family, pnl_pct: r.pnl_pct, flips: r.flips, d_capital: r.d_capital, d_fee: r.d_fee, exit_extra: r.exit_extra, delta: r.delta });
      out.largest = [...fl].sort((a, b) => b.delta - a.delta).slice(0, 10).map(pick);
      out.smallest = [...fl].sort((a, b) => a.delta - b.delta).slice(0, 10).map(pick);
      out.verdict = verdictFor(summary, validity);
    }
    variantResults.push(out);
  }

  return {
    generated_at: new Date().toISOString(),
    window: { from, to },
    population: { records: records.length, included: pop.length, exclusions, excluded_strategies: excludedStrategies,
      by_strategy: { spot: pop.filter((p) => p.rec.strategy === "spot").length, bid_ask: pop.filter((p) => p.rec.strategy === "bid_ask").length } },
    data_notes: notes,
    validity,
    variants: variantResults,
    primary: variantResults.find((v) => v.variant.primary) || null,
  };
}

// ─── text report ───────────────────────────────────────────────────────────

const f4 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(4));
const f2 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(2));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

export function formatCheckLine(c) {
  const v = typeof c.value === "number" ? (Number.isInteger(c.value) ? String(c.value) : f4(c.value)) : String(c.value)
    .split(" / ").map((x) => (x !== "" && Number.isFinite(Number(x)) && !Number.isInteger(Number(x)) ? f4(Number(x)) : x)).join(" / ");
  return `  check ${c.id}: ${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${v})`;
}

export function formatReport(rep) {
  const L = [];
  L.push("BID-ASK FLIP REPLAY (docs/experiments/bidask-flip.md) — offline, read-only");
  L.push(`window: ${rep.window.from} ≤ close < ${rep.window.to}`);
  L.push("");
  L.push("POPULATION");
  L.push(`  records in file: ${rep.population.records}   included: ${rep.population.included}  (spot ${rep.population.by_strategy.spot}, bid_ask ${rep.population.by_strategy.bid_ask})`);
  L.push("  exclusions (first failing reason):");
  for (const [k, v] of Object.entries(rep.population.exclusions)) L.push(`    ${pad(k, 32)} ${lpad(v, 6)}`);
  const es = Object.entries(rep.population.excluded_strategies);
  if (es.length) L.push(`    strategy values excluded: ${es.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  L.push("");
  const n = rep.data_notes;
  L.push("DATA NOTES");
  L.push(`  first tick bin = bin_range.max: ${n.first_bin_eq_hi}; above: ${n.first_bin_above_hi} (median ${n.first_bin_above_hi_offsets.median ?? "-"}, max ${n.first_bin_above_hi_offsets.max ?? "-"} bins); below: ${n.first_bin_below_hi} (median ${n.first_bin_below_hi_offsets.median ?? "-"}, p90 ${n.first_bin_below_hi_offsets.p90 ?? "-"}, max ${n.first_bin_below_hi_offsets.max ?? "-"} bins; ${n.first_bin_below_lo} below bin_range.min)`);
  L.push(`  first window tick before t_open: ${n.first_tick_before_open}; positions with no pnl tick: ${n.positions_with_no_pnl_ticks}`);
  L.push(`  ticks used ${n.ticks_total}: below range ${n.ticks_below_lo} (max ${n.max_bins_below_lo} bins), above range ${n.ticks_above_hi} (max ${n.max_bins_above_hi} bins)`);
  L.push(`  fees missing (taken as 0): ${n.fees_missing}; bin_range.bins_below ≠ max−min: ${n.bins_below_mismatch}; duplicate positions: ${n.duplicate_positions}`);
  L.push(`  exit-slippage ratio: own ${n.r_own} of ${rep.population.included}, population median ${(n.r_median * 100).toFixed(3)} %; negative clamped to 0: ${n.negative_exit_slippage_clamped}; above 10 % cap: ${n.exit_slippage_above_cap}`);
  L.push("");
  const v = rep.validity;
  L.push("MODEL VALIDITY  err = passive capital pnl % + fees % − recorded pnl_pct");
  L.push(`  all (n ${v.n}): median |err| ${f2(v.median_abs_err)} pp, p75 ${f2(v.p75_abs_err)}, p90 ${f2(v.p90_abs_err)} → valid = ${v.valid}`);
  for (const [k, s] of Object.entries(v.by_strategy)) L.push(`  ${pad(k, 8)} (n ${s.n}): median ${f2(s.median_abs_err)}, p75 ${f2(s.p75_abs_err)}, p90 ${f2(s.p90_abs_err)}`);
  L.push("  by exit family:");
  for (const [k, s] of Object.entries(v.by_exit_family)) L.push(`    ${pad(k, 22)} n ${lpad(s.n, 4)}  median ${lpad(f2(s.median_abs_err), 7)}  p90 ${lpad(f2(s.p90_abs_err), 7)}`);
  L.push("  largest |err|:");
  for (const x of v.largest_abs_err) L.push(`    ${pad(x.pool_name, 18)} ${String(x.recorded_at).slice(0, 10)} ${pad(x.strategy, 8)} ${pad(x.exit_family, 18)} pnl ${lpad(f2(x.pnl_pct), 7)}  err ${lpad(f2(x.err), 8)}`);
  L.push("");
  L.push("VARIANTS (sums over positions with ≥ 1 flip, SOL)");
  for (const r of rep.variants) {
    const s = r.summary;
    L.push(`  ${r.variant.id}${r.variant.primary ? "  [PRIMARY]" : ""}`);
    L.push(`    n flipped ${s.n_flipped} / ${s.n_positions}, total flips ${s.total_flips}`);
    L.push(`    ΣΔcapital ${f4(s.sum_d_capital)}  ΣΔfee ${f4(s.sum_d_fee)}  Σgas ${f4(-s.sum_gas)}  Σexit_extra ${f4(-s.sum_exit_extra)}`);
    L.push(`    ΣΔ ${f4(s.sum_delta)}  w/o largest (${f4(s.largest_delta)}) ${f4(s.sum_delta_without_largest)}  better/worse/tie ${s.better}/${s.worse}/${s.tie}`);
    L.push(`    half 1 (n ${s.half1_n}) ${f4(s.half1_sum)}  half 2 (n ${s.half2_n}) ${f4(s.half2_sum)}  ΣΔ_robust ${f4(s.sum_delta_robust)}`);
    L.push(`    ΣΔ_int ${f4(s.sum_delta_int)}  (early closes ${s.n_early_close}, their Σ ${f4(s.sum_delta_int_early)})  bootstrap 90 % CI of ΣΔ [${f4(s.boot90.lo)}, ${f4(s.boot90.hi)}]`);
  }
  const P = rep.primary;
  if (P) {
    L.push("");
    L.push(`PRIMARY ${P.variant.id} — by exit family (n / n flipped / ΣΔ)`);
    for (const [k, s] of Object.entries(P.by_exit_family).sort((a, b) => b[1].n - a[1].n)) L.push(`    ${pad(k, 22)} ${lpad(s.n, 4)} ${lpad(s.n_flipped, 4)}  ${f4(s.sum_delta)}`);
    L.push("PRIMARY — by mae_pnl_pct bucket (n / n flipped / ΣΔ)");
    for (const [k, s] of Object.entries(P.by_mae_bucket)) L.push(`    ${pad(k, 22)} ${lpad(s.n, 4)} ${lpad(s.n_flipped, 4)}  ${f4(s.sum_delta)}`);
    const row = (x) => `    ${pad(x.pool_name, 18)} ${String(x.recorded_at).slice(0, 10)} ${pad(x.exit_family ?? "-", 18)} pnl ${lpad(f2(x.pnl_pct), 7)} flips ${lpad(x.flips, 2)}  Δcap ${f4(x.d_capital)}  Δfee ${f4(x.d_fee)}  exit ${f4(-x.exit_extra)}  Δ ${f4(x.delta)}`;
    L.push("PRIMARY — 10 largest Δ");
    for (const x of P.largest) L.push(row(x));
    L.push("PRIMARY — 10 smallest Δ");
    for (const x of P.smallest) L.push(row(x));
    L.push("");
    L.push(`VERDICT (primary ${P.variant.id}): ${P.verdict.verdict}${P.verdict.model_valid ? "" : "  (model validity failed — nothing is concluded)"}`);
    for (const c of P.verdict.checks) L.push(formatCheckLine(c));
    L.push(`  model validity (precondition): ${P.verdict.model_valid ? "PASS" : "FAIL"}  median |err| ${f2(rep.validity.median_abs_err)} pp ≤ 1`);
  }
  return L.join("\n") + "\n";
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const recordsPath = opt("--records", null);
  const ticksPath = opt("--ticks", null);
  if (!recordsPath || !ticksPath) {
    console.error("usage: node scripts/replay/bidask_flip_replay.js --records <performance.json> --ticks <ticks.csv[.gz]> [--json out.json] [--from ISO] [--to ISO]");
    process.exit(2);
  }
  const from = opt("--from", DEFAULT_FROM);
  const to = opt("--to", DEFAULT_TO);
  const records = JSON.parse(fs.readFileSync(recordsPath, "utf8"));
  if (!Array.isArray(records)) throw new Error("--records must be a JSON array");
  const { byPos, stats } = readTicksFile(ticksPath);
  const rep = runReplay(records, byPos, { from, to });
  rep.inputs = { records: path.resolve(recordsPath), ticks: path.resolve(ticksPath), tick_stats: stats };
  const text = formatReport(rep) + `\n(tick file: ${stats.rows} rows, ${stats.positions} positions, ${stats.empty_pnl} with empty pnl, ${stats.bad_rows} unreadable)\n`;
  process.stdout.write(text);
  const jsonOut = opt("--json", null);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rep, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
