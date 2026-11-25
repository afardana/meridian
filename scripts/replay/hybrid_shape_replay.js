#!/usr/bin/env node
/**
 * scripts/replay/hybrid_shape_replay.js — OFFLINE, read-only replay that decides the registered
 * hypothesis docs/experiments/hybrid-shape.md (50 % spot + 50 % bid-ask INITIAL shape on the same
 * single-sided SOL range, close times unchanged).
 *
 * Inputs (local files only — no .env, no DB, no network):
 *   --records  JSON array of perf records (scripts/experiments/export.sh → performance.json)
 *   --ticks    poller tick export (scripts/replay/bidask_flip_export.sql, run on the VM),
 *              CSV or gzip CSV: position_address,t(epoch s),active_bin,pnl_pct
 *
 *   node scripts/replay/hybrid_shape_replay.js --records performance.json --ticks ticks.csv.gz \
 *     [--json out.json] [--from 2026-09-26T00:00:00Z] [--to 2026-11-26T00:00:00Z]
 *
 * Bin model and helpers come from scripts/replay/bidask_flip_replay.js (not modified). A ladder is
 * never re-shaped here, so bin i's SOL value stays its deposit y_i: value at active bin a =
 * Σ_{i≤a} y_i + Σ_{i>a} y_i·p(a)/p(i); token value held = Σ_{i>a} y_i·p(a)/p(i) + ½·y_a·… (as
 * tokenValue). Fees: crossing-weighted (W = Σ crossings of bin i × y_i), anchored c = F / W_actual.
 * The spec is pre-registered; do not tune it here.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOL_MINT, TIE_SOL, closeTimeSec, feesSol, ownExitSlipRatio, windowTicks, crossedRange,
  ladderValue, tokenValue, trailingFireIndex, quantile, bootstrapSumCI, readTicksFile,
} from "./bidask_flip_replay.js";

export const DEFAULT_FROM = "2026-09-26T00:00:00Z";
export const DEFAULT_TO = "2026-11-26T00:00:00Z";
export const MAX_FIRST_TICK_UNDER_TOP = 10;
export const MAX_MODEL_ERR_PP = 0.5;
export const FALLBACK_EXIT_RATE = 0.003;
export const TRAIL_ARM = 2;
export const TRAIL_DROP = 1.5;
export const STOP_PCT = -15;
export const STOP_CLASS = new Set(["stop_loss", "rug", "crash", "young_stop", "probation_stop"]);
/** Known-held positions whose records predate the `was_held` field (2026-10-11). Prefix match. */
export const KNOWN_HELD = ["69F2FsPS"];

export const PRIMARY = { id: "hybrid_50_50", mix: { spot: 0.5, bidask: 0.5 }, primary: true };
export const VARIANTS = [
  { id: "actual", mix: null, control: true },
  PRIMARY,
  { id: "bidask_100", mix: { bidask: 1 } },
  { id: "curve_100", mix: { curve: 1 } },
  { id: "hybrid_30_70", mix: { spot: 0.3, bidask: 0.7 } },
  { id: "hybrid_70_30", mix: { spot: 0.7, bidask: 0.3 } },
  { id: "spot_100", mix: { spot: 1 } },
];

export const EXCLUSION_REASONS = [
  "adopted", "rebalance_leg", "no_close_time", "before_from", "at_or_after_to",
  "straddled", "re_ranged", "was_held", "known_held", "strategy_not_spot_bid_ask_curve",
  "missing_geometry", "non_sol_quote", "no_minutes_held", "fewer_than_2_ticks_in_window",
  "first_tick_late", "first_tick_far_under_top", "model_err_over_0_5pp",
];

// ─── shapes ────────────────────────────────────────────────────────────────

/** Capital fractions per bin (index k = i − lo), summing to 1. kind: spot | bidask | curve. */
export function shapeFractions(n, kind) {
  const w = new Float64Array(n);
  let s = 0;
  for (let k = 0; k < n; k++) {
    // k = 0 is the bottom bin (lo), k = n−1 the top bin (hi)
    w[k] = kind === "spot" ? 1 : kind === "bidask" ? n - k : k + 1;
    s += w[k];
  }
  for (let k = 0; k < n; k++) w[k] /= s;
  return w;
}

export function mixFractions(n, mix) {
  const out = new Float64Array(n);
  for (const [kind, a] of Object.entries(mix)) {
    const f = shapeFractions(n, kind);
    for (let k = 0; k < n; k++) out[k] += a * f[k];
  }
  return out;
}

export function actualKind(strategy) {
  return strategy === "spot" ? "spot" : strategy === "bid_ask" ? "bidask" : strategy === "curve" ? "curve" : null;
}

/** Ladder object compatible with the flip harness helpers (ladderValue / tokenValue). */
export function ladderFromFractions({ lo, hi, binStep, C }, frac) {
  const n = hi - lo + 1;
  const s = binStep / 1e4;
  const L = { lo, hi, n, s, C, pr: new Float64Array(n), X: new Float64Array(n), y: new Float64Array(n), reshaped: new Uint8Array(n) };
  for (let k = 0; k < n; k++) {
    L.pr[k] = Math.pow(1 + s, lo + k - hi);
    L.y[k] = C * frac[k];
    L.X[k] = L.y[k] / L.pr[k];
  }
  return L;
}

/** Per-bin crossing counts and active-bin time (seconds, in range) over a tick path. */
export function pathStats(lo, hi, ticks) {
  const n = hi - lo + 1;
  const cross = new Float64Array(n);
  const dwell = new Float64Array(n);
  const crossAt = []; // per tick: list of crossed in-range bin indexes since previous tick
  for (let k = 0; k < ticks.length; k++) {
    const list = [];
    if (k > 0) {
      const r = crossedRange(ticks[k - 1].a, ticks[k].a);
      if (r) for (let i = Math.max(r[0], lo); i <= Math.min(r[1], hi); i++) { cross[i - lo]++; list.push(i - lo); }
      const a = ticks[k - 1].a;
      if (a >= lo && a <= hi) dwell[a - lo] += Math.max(0, ticks[k].t - ticks[k - 1].t);
    }
    crossAt.push(list);
  }
  return { cross, dwell, crossAt };
}

const dot = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; return s; };

/** First index where pnl ≥ arm; first trailing fire; first index ≤ stop. */
export function exitIndexes(pnls) {
  let arm = null, stop = null;
  for (let k = 0; k < pnls.length; k++) {
    const v = pnls[k];
    if (v == null || !Number.isFinite(v)) continue;
    if (arm == null && v >= TRAIL_ARM) arm = k;
    if (stop == null && v <= STOP_PCT) stop = k;
  }
  return { arm, trail: trailingFireIndex(pnls, TRAIL_ARM, TRAIL_DROP), stop };
}

// ─── population ────────────────────────────────────────────────────────────

export function classifyRecord(rec, ticksByPos, { from = DEFAULT_FROM, to = DEFAULT_TO } = {}) {
  if (rec.adopted) return { reason: "adopted" };
  if (rec.rebalance_leg) return { reason: "rebalance_leg" };
  const tClose = closeTimeSec(rec);
  if (tClose == null) return { reason: "no_close_time" };
  if (tClose < Date.parse(from) / 1000) return { reason: "before_from" };
  if (tClose >= Date.parse(to) / 1000) return { reason: "at_or_after_to" };
  if ((rec.straddle_count || 0) != 0) return { reason: "straddled" };
  if ((rec.rebalance_count || 0) != 0 || (rec.in_place_rerange_count || 0) != 0) return { reason: "re_ranged" };
  if (rec.was_held === true) return { reason: "was_held" };
  if (KNOWN_HELD.some((p) => String(rec.position || "").startsWith(p))) return { reason: "known_held" };
  if (!actualKind(rec.strategy)) return { reason: "strategy_not_spot_bid_ask_curve" };
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
  if (hi - ticks[0].a > MAX_FIRST_TICK_UNDER_TOP) return { reason: "first_tick_far_under_top" };
  return { reason: null, tOpen, tClose, ticks, lo, hi, binStep: bs, C };
}

// ─── per position ──────────────────────────────────────────────────────────

/**
 * Evaluate every variant on one position. Returns { err, rows: { [variantId]: {...} } } where err
 * is the actual-shape model error (pp) and each row carries Δ components.
 */
export function evaluatePosition(geom, strategy, ticks, { F, r, pnlRec, variants = VARIANTS }) {
  const n = geom.hi - geom.lo + 1;
  const fracA = shapeFractions(n, actualKind(strategy));
  const LA = ladderFromFractions(geom, fracA);
  const ps = pathStats(geom.lo, geom.hi, ticks);
  const aEnd = ticks[ticks.length - 1].a;
  const C = geom.C;
  const VA = ladderValue(LA, aEnd);
  const err = (100 * (VA - C)) / C + (100 * F) / C - pnlRec;
  const WA = dot(ps.cross, LA.y);
  const TA = dot(ps.dwell, LA.y);
  const c = WA > 0 ? F / WA : null;
  const cT = TA > 0 ? F / TA : null;
  const tokA = tokenValue(LA, aEnd);
  const recPath = ticks.map((x) => (x.pnl != null && Number.isFinite(x.pnl) ? x.pnl : null));
  const exA = exitIndexes(recPath);
  const out = {};
  for (const v of variants) {
    const frac = v.mix ? mixFractions(n, v.mix) : fracA;
    const LV = ladderFromFractions(geom, frac);
    const dCap = ladderValue(LV, aEnd) - VA;
    const WV = dot(ps.cross, LV.y);
    let wRob = 0;
    for (let k = 0; k < n; k++) wRob += ps.cross[k] * (Math.min(LV.y[k], LA.y[k]) + 0.5 * Math.max(0, LV.y[k] - LA.y[k]));
    const dFee = c != null ? c * WV - F : 0;
    const dFeeRobust = c != null ? c * wRob - F : 0;
    const dFeeTime = cT != null ? cT * dot(ps.dwell, LV.y) - F : 0;
    const tokV = tokenValue(LV, aEnd);
    const dExit = (tokV - tokA) * r;
    const dExitLit = (tokV - tokA) * (r === FALLBACK_EXIT_RATE ? r : r + FALLBACK_EXIT_RATE);
    const delta = dCap + dFee - dExit;
    // pnl path under the variant (fees accrued by crossings to date)
    let changed = { arm: false, trail: false, stop: false, any: false };
    if (v.mix) {
      let Wv = 0, Wa = 0;
      const pV = new Array(ticks.length);
      for (let k = 0; k < ticks.length; k++) {
        for (const idx of ps.crossAt[k]) { Wv += LV.y[idx]; Wa += LA.y[idx]; }
        if (recPath[k] == null) { pV[k] = null; continue; }
        const dv = ladderValue(LV, ticks[k].a) - ladderValue(LA, ticks[k].a) + (c != null ? c * (Wv - Wa) : 0);
        pV[k] = recPath[k] + (100 * dv) / C;
      }
      const exV = exitIndexes(pV);
      changed = { arm: exV.arm !== exA.arm, trail: exV.trail !== exA.trail, stop: exV.stop !== exA.stop };
      changed.any = changed.arm || changed.trail || changed.stop;
      changed.trail_earlier = exV.trail != null && (exA.trail == null || exV.trail < exA.trail);
      changed.stop_earlier = exV.stop != null && (exA.stop == null || exV.stop < exA.stop);
    }
    out[v.id] = {
      d_capital: dCap, d_fee: dFee, d_fee_robust: dFeeRobust, d_fee_time: dFeeTime, d_exit: dExit,
      delta, delta_robust: dCap + dFeeRobust - dExit, delta_time: dCap + dFeeTime - dExit,
      delta_exit_literal: dCap + dFee - dExitLit, tok_end: tokV, exit_sens: changed,
    };
  }
  return { err, W_actual: WA, T_actual: TA, c, tok_actual_end: tokA, rows: out };
}

// ─── summaries / verdict ───────────────────────────────────────────────────

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

export function summarize(rows, key = "delta") {
  const sorted = [...rows].sort((a, b) => a.t_close - b.t_close);
  const d = sorted.map((x) => x[key]);
  const n = d.length;
  const h = Math.floor(n / 2);
  const stop = sorted.filter((x) => STOP_CLASS.has(x.exit_family));
  return {
    n,
    sum_d_capital: sum(sorted.map((x) => x.d_capital)),
    sum_d_fee: sum(sorted.map((x) => x.d_fee)),
    sum_d_exit: sum(sorted.map((x) => x.d_exit)),
    sum_delta: sum(d),
    sum_delta_robust: sum(sorted.map((x) => x.delta_robust)),
    sum_delta_time: sum(sorted.map((x) => x.delta_time)),
    sum_delta_exit_literal: sum(sorted.map((x) => x.delta_exit_literal)),
    better: d.filter((x) => x > TIE_SOL).length,
    worse: d.filter((x) => x < -TIE_SOL).length,
    tie: d.filter((x) => Math.abs(x) <= TIE_SOL).length,
    half1_n: h, half1_sum: sum(d.slice(0, h)), half2_n: n - h, half2_sum: sum(d.slice(h)),
    min_delta: n ? Math.min(...d) : null, max_delta: n ? Math.max(...d) : null,
    stop_n: stop.length, stop_sum: sum(stop.map((x) => x[key])),
    boot90: bootstrapSumCI(d),
    sens: {
      any: sorted.filter((x) => x.exit_sens?.any).length,
      arm: sorted.filter((x) => x.exit_sens?.arm).length,
      trail: sorted.filter((x) => x.exit_sens?.trail).length,
      trail_earlier: sorted.filter((x) => x.exit_sens?.trail_earlier).length,
      stop: sorted.filter((x) => x.exit_sens?.stop).length,
      stop_earlier: sorted.filter((x) => x.exit_sens?.stop_earlier).length,
    },
  };
}

export function verdictFor(s) {
  const checks = [
    { id: 1, name: "n >= 100 positions in the verdict set", pass: s.n >= 100, value: s.n },
    { id: 2, name: "sum delta > 0 and bootstrap 90 % lower bound > 0", pass: s.sum_delta > 0 && s.boot90.lo > 0, value: `${s.sum_delta} [${s.boot90.lo}, ${s.boot90.hi}]` },
    { id: 3, name: "better >= worse (|delta| <= 0.0005 tie)", pass: s.better >= s.worse, value: `${s.better} / ${s.worse} / ${s.tie}` },
    { id: 4, name: "sum delta > 0 in each half by close time", pass: s.half1_sum > 0 && s.half2_sum > 0, value: `${s.half1_sum} / ${s.half2_sum}` },
    { id: 5, name: "fee-robust sum delta > 0 (extra liquidity earns half)", pass: s.sum_delta_robust > 0, value: s.sum_delta_robust },
    { id: 6, name: "|worst delta| <= half of sum delta", pass: s.min_delta != null && s.sum_delta > 0 && Math.abs(s.min_delta) <= 0.5 * s.sum_delta, value: `${s.min_delta} vs ${0.5 * s.sum_delta}` },
    { id: 7, name: "stop-class sum delta > 0 or >= -25 % of the total gain", pass: s.stop_sum > 0 || (s.sum_delta > 0 && s.stop_sum >= -0.25 * s.sum_delta), value: `${s.stop_sum} (n ${s.stop_n})` },
  ];
  const verdict = !checks[0].pass ? "insufficient" : checks.every((c) => c.pass) ? "met" : "not_met";
  return { verdict, checks };
}

// ─── whole replay ──────────────────────────────────────────────────────────

export function runReplay(records, ticksByPos, { from = DEFAULT_FROM, to = DEFAULT_TO, variants = VARIANTS } = {}) {
  const exclusions = Object.fromEntries(EXCLUSION_REASONS.map((x) => [x, 0]));
  const excludedList = [];
  const cand = [];
  for (const rec of records) {
    const c = classifyRecord(rec, ticksByPos, { from, to });
    if (c.reason) {
      exclusions[c.reason]++;
      if (!["adopted", "before_from", "at_or_after_to", "rebalance_leg"].includes(c.reason)) {
        excludedList.push({ reason: c.reason, pool_name: rec.pool_name, position: rec.position, recorded_at: rec.recorded_at });
      }
      continue;
    }
    cand.push({ rec, ...c });
  }
  const own = cand.map((p) => ownExitSlipRatio(p.rec));
  const rows = {};
  for (const v of variants) rows[v.id] = [];
  const errs = [];
  let noCross = 0;
  for (let j = 0; j < cand.length; j++) {
    const p = cand[j];
    const F = feesSol(p.rec) ?? 0;
    const pnlRec = Number(p.rec.pnl_pct);
    const r = own[j] != null ? own[j] : FALLBACK_EXIT_RATE;
    const ev = evaluatePosition({ lo: p.lo, hi: p.hi, binStep: p.binStep, C: p.C }, p.rec.strategy, p.ticks, { F, r, pnlRec, variants });
    errs.push(Math.abs(ev.err));
    if (!(Math.abs(ev.err) <= MAX_MODEL_ERR_PP)) {
      exclusions.model_err_over_0_5pp++;
      excludedList.push({ reason: "model_err_over_0_5pp", pool_name: p.rec.pool_name, position: p.rec.position, recorded_at: p.rec.recorded_at, err: ev.err, exit_family: p.rec.exit_family });
      continue;
    }
    if (!(ev.W_actual > 0)) noCross++;
    for (const v of variants) {
      rows[v.id].push({
        position: p.rec.position, pool_name: p.rec.pool_name, recorded_at: p.rec.recorded_at, t_close: p.tClose,
        strategy: p.rec.strategy, exit_family: p.rec.exit_family ?? "unknown", pnl_pct: pnlRec, amount_sol: p.C,
        F, r, r_source: own[j] != null ? "own" : "fallback", model_err: ev.err, n_bins: p.hi - p.lo + 1,
        ...ev.rows[v.id],
      });
    }
  }
  const variantOut = variants.map((v) => {
    const s = summarize(rows[v.id]);
    const byFam = {};
    for (const x of rows[v.id]) {
      byFam[x.exit_family] ||= { n: 0, sum_delta: 0, sum_d_capital: 0, sum_d_fee: 0 };
      const b = byFam[x.exit_family];
      b.n++; b.sum_delta += x.delta; b.sum_d_capital += x.d_capital; b.sum_d_fee += x.d_fee;
    }
    const o = { variant: v, summary: s, by_exit_family: byFam };
    if (v.primary) {
      o.verdict = verdictFor(s);
      const pick = (x) => ({ pool_name: x.pool_name, recorded_at: x.recorded_at, exit_family: x.exit_family, pnl_pct: x.pnl_pct, amount_sol: x.amount_sol, d_capital: x.d_capital, d_fee: x.d_fee, d_exit: x.d_exit, delta: x.delta });
      o.largest = [...rows[v.id]].sort((a, b) => b.delta - a.delta).slice(0, 8).map(pick);
      o.smallest = [...rows[v.id]].sort((a, b) => a.delta - b.delta).slice(0, 8).map(pick);
    }
    return o;
  });
  const ctl = rows.actual || [];
  return {
    generated_at: new Date().toISOString(),
    window: { from, to },
    population: {
      records: records.length, candidates: cand.length, verdict_set: ctl.length, exclusions,
      by_strategy: ctl.reduce((m, x) => ((m[x.strategy] = (m[x.strategy] || 0) + 1), m), {}),
      no_crossing_positions: noCross,
      own_exit_ratio: ctl.filter((x) => x.r_source === "own").length,
      model_err_candidates: { n: errs.length, median: quantile(errs, 0.5), p90: quantile(errs, 0.9) },
      model_err_verdict_set: { median: quantile(ctl.map((x) => Math.abs(x.model_err)), 0.5), p90: quantile(ctl.map((x) => Math.abs(x.model_err)), 0.9) },
      control_max_abs_delta: ctl.length ? Math.max(...ctl.map((x) => Math.abs(x.delta))) : null,
      capital_sol: sum(ctl.map((x) => x.amount_sol)),
      fees_sol: sum(ctl.map((x) => x.F)),
    },
    excluded: excludedList,
    variants: variantOut,
    primary: variantOut.find((x) => x.variant.primary),
  };
}

// ─── report ────────────────────────────────────────────────────────────────

const f4 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(4));
const pad = (s, n) => String(s).padEnd(n);

export function formatReport(rep) {
  const L = [];
  L.push("HYBRID SHAPE REPLAY (docs/experiments/hybrid-shape.md) — offline, read-only");
  L.push(`window: ${rep.window.from} ≤ close < ${rep.window.to}`);
  const P = rep.population;
  L.push(`records ${P.records}; candidates ${P.candidates}; verdict set ${P.verdict_set} ${JSON.stringify(P.by_strategy)}; capital ◎${P.capital_sol.toFixed(2)}, fees ◎${P.fees_sol.toFixed(4)}`);
  L.push(`model |err| candidates median ${P.model_err_candidates.median?.toFixed(3)} p90 ${P.model_err_candidates.p90?.toFixed(3)}; verdict set median ${P.model_err_verdict_set.median?.toFixed(3)} p90 ${P.model_err_verdict_set.p90?.toFixed(3)}; control max |Δ| ${P.control_max_abs_delta}`);
  L.push(`no in-range crossing (Δfee 0): ${P.no_crossing_positions}; own exit ratio ${P.own_exit_ratio}`);
  L.push("exclusions:");
  for (const [k, v] of Object.entries(P.exclusions)) if (v) L.push(`  ${pad(k, 34)} ${v}`);
  L.push("");
  L.push("variant           n   ΣΔcap     ΣΔfee     ΣΔexit    ΣΔ        CI90                 b/w/t        halves               robust    time-fee  exit-lit  stop(n)        sens any/trail/stop");
  for (const o of rep.variants) {
    const s = o.summary;
    L.push(`${pad(o.variant.id, 16)} ${String(s.n).padStart(3)} ${f4(s.sum_d_capital)} ${f4(s.sum_d_fee)} ${f4(-s.sum_d_exit)} ${f4(s.sum_delta)} [${f4(s.boot90.lo)},${f4(s.boot90.hi)}] ${pad(`${s.better}/${s.worse}/${s.tie}`, 12)} ${f4(s.half1_sum)}/${f4(s.half2_sum)} ${f4(s.sum_delta_robust)} ${f4(s.sum_delta_time)} ${f4(s.sum_delta_exit_literal)} ${f4(s.stop_sum)}(${s.stop_n}) ${s.sens.any}/${s.sens.trail}/${s.sens.stop}`);
  }
  const pr = rep.primary;
  if (pr) {
    L.push("");
    L.push(`PRIMARY ${pr.variant.id} by exit family (n, ΣΔ, ΣΔcap, ΣΔfee):`);
    for (const [k, b] of Object.entries(pr.by_exit_family).sort((a, b) => b[1].n - a[1].n)) L.push(`  ${pad(k, 20)} ${String(b.n).padStart(4)} ${f4(b.sum_delta)} ${f4(b.sum_d_capital)} ${f4(b.sum_d_fee)}`);
    const row = (x) => `  ${pad(x.pool_name, 16)} ${String(x.recorded_at).slice(0, 10)} ${pad(x.exit_family, 18)} pnl ${x.pnl_pct.toFixed(2).padStart(7)} ◎${x.amount_sol.toFixed(2)} Δcap ${f4(x.d_capital)} Δfee ${f4(x.d_fee)} Δexit ${f4(-x.d_exit)} Δ ${f4(x.delta)}`;
    L.push("largest Δ:"); for (const x of pr.largest) L.push(row(x));
    L.push("smallest Δ:"); for (const x of pr.smallest) L.push(row(x));
    const se = pr.summary.sens;
    L.push(`exit sensitivity (primary): any ${se.any}, arm-time ${se.arm}, trailing-fire ${se.trail} (earlier ${se.trail_earlier}), stop ${se.stop} (earlier ${se.stop_earlier})`);
    L.push("");
    L.push(`VERDICT: ${pr.verdict.verdict}`);
    for (const c of pr.verdict.checks) L.push(`  check ${c.id}: ${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.value})`);
  }
  return L.join("\n") + "\n";
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const recordsPath = opt("--records", null), ticksPath = opt("--ticks", null);
  if (!recordsPath || !ticksPath) {
    console.error("usage: node scripts/replay/hybrid_shape_replay.js --records <performance.json> --ticks <ticks.csv[.gz]> [--json out.json] [--from ISO] [--to ISO]");
    process.exit(2);
  }
  const records = JSON.parse(fs.readFileSync(recordsPath, "utf8"));
  const { byPos, stats } = readTicksFile(ticksPath);
  const rep = runReplay(records, byPos, { from: opt("--from", DEFAULT_FROM), to: opt("--to", DEFAULT_TO) });
  rep.inputs = { records: path.resolve(recordsPath), ticks: path.resolve(ticksPath), tick_stats: stats };
  process.stdout.write(formatReport(rep));
  const j = opt("--json", null);
  if (j) fs.writeFileSync(j, JSON.stringify(rep, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
