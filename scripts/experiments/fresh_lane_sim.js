#!/usr/bin/env node
/**
 * scripts/experiments/fresh_lane_sim.js — READ-ONLY simulator and grader for the registered
 * experiment docs/experiments/fresh-top-lane.md (plan 16, fresh top-performer lane).
 *
 * Inputs: the lane's paper trades + ticks (fresh-lane-paper.js), either
 *   --pg                         two read-only SELECTs (lane_paper_trades, lane_paper_ticks; VM)
 *   --trades F --ticks F         JSON arrays or the JSONL files of the json backend / an export
 * Options: --lane paper|operator|all (default paper for the pass rule; operator entries are
 *   reported beside it), --capture-start YYYY-MM-DD (first capture day; default: the registered
 *   2026-11-27), --now ISO, --json out.json.
 *
 * Model (registered 2026-11-27; do not tune it here). Unit capital ◎1, values in SOL.
 *   Bin prices relative to the entry active bin a0: p(j) = (1 + binStep/1e4)^j, j = bin − a0.
 *   Every bin holds a fixed liquidity X_j (token-equivalents at the entry price); its value at
 *   active bin a is X_j·p(j) when j ≤ a − a0 (the price passed above it: SOL) and X_j·p(a − a0)
 *   otherwise (tokens) — the passive bin model of scripts/replay/bidask_flip_replay.js (there it
 *   reproduced recorded close PnL to a median 0.02 pp).
 *   Shape P (primary): two-sided spot ±34 around a0 (69 bins). ◎0.5 buys the base side; T = the
 *     buy quote's tokens × the active-bin price (entry cost = 0.5 − T). Bins −34…−1 hold
 *     0.5/34.5 SOL each, bins +1…+34 tokens worth T/34.5 each, a0 half of each.
 *   Shape S (secondary): SOL-only spot ladder, the active bin and the 68 below it (69 bins, the
 *     bot's single-account ladder ends at the active bin), 1/69 SOL each; no entry cost.
 *   Pool fees (reconstructFees): the API's 5m `fee` is the fee so far in the current clock-aligned
 *     5-minute bucket (it only rises inside a bucket and restarts at ≈ 0). The pool's fee over
 *     tick interval (k−1, k] = the rise of the reading inside one bucket; at a new bucket (the
 *     reading fell, or the lagged bucket index moved by ≥ 2) = the first reading of that bucket
 *     (fees of the old bucket after its last reading are lost — conservative); every bucket the
 *     ticks skipped entirely adds the latest 1h fee ÷ 12 at or before the gap (`fee_gap`; no 1h
 *     figure → nothing added, `fee_gap_no_1h`). A one-bucket move with a non-falling reading is
 *     read as the same bucket (undercounts a new bucket that already beat the old one's total).
 *   Fee income per interval = that pool fee × share ÷ SOL price, share = our liquidity in the
 *     active bin of tick k−1 ÷ (that + the pool's active-bin liquidity), the pool's active-bin
 *     liquidity ≈ active_tvl / SOL price / 69 (its active TVL assumed spread over 69 bins like
 *     ours). Halved-fee stress: the same with fee income × 0.5.
 *   PnL path = (value + fees − 1) × 100 (gross of the exit cost, like the live rules).
 *   Exits on each captured reading, in this order: pool TVL < $10,000; PnL ≤ stop; trailing
 *     (armed once the running peak ≥ 3 %, fires at a reading ≤ peak − 1.5 pp); time box (minutes
 *     since entry ≥ box). The fill is that reading: a gap through the stop fills at the first
 *     captured reading at or under it. No exit by the end of the data → the last reading
 *     ("data_end").
 *   Entry without a buy quote (entry_quote "missing"): entry cost = (the pool's base fee % + 1.0 pp)
 *     of the ◎0.5 bought (base fee unknown → 3 %); such entries are included and counted apart.
 *   Exit cost = token value held at the exit × the slippage ratio of the LATEST read-only sell
 *     quote taken at or before the exit (no look-ahead; the entry sell quote counts), ratio = 1 −
 *     quoted SOL out ÷ (tokens × active-bin price at the quote), clamped to [0, 0.5]; none → the
 *     entry cost ratio. Gas ◎0.0002 per trade (deploy, close, 2 swaps).
 *   Net = value at exit + fees − exit cost − gas − 1.
 *   Only ENDED entries are graded (tracking window complete, or the pool vanished); the entry
 *     snapshot is the first reading of the path.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CAPITAL_SOL = 1;
export const HALF_BINS_P = 34;
export const BINS_S = 69;
export const W_REF = 69;
export const GAS_SOL = 0.0002;
export const MAX_EXIT_RATIO = 0.5;
export const MISSING_QUOTE_EXTRA_PP = 1.0;   // registered: entry cost without a buy quote = base fee % + 1.0 pp
export const MISSING_QUOTE_UNKNOWN_FEE_PCT = 3;
export const FEE_BUCKET_MS = 5 * 60_000;
export const FEE_EPS_USD = 0.01;
export const REGISTERED_CAPTURE_START = "2026-11-27";
export const PRIMARY_EXITS = Object.freeze({ id: "primary", stopPct: -10, trailArmPct: 3, trailDropPp: 1.5, boxMin: 120, tvlExitUsd: 10_000 });
export const SECONDARY_EXITS = Object.freeze([
  Object.freeze({ ...PRIMARY_EXITS, id: "box60", boxMin: 60 }),
  Object.freeze({ ...PRIMARY_EXITS, id: "stop15", stopPct: -15 }),
]);
export const PASS = Object.freeze({ minEntries: 40, minSpanDays: 14, maxDisasterRate: 0.10, disasterPct: -10, timeArmDays: 60 });
const DAY = 86_400_000;

const num = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const ms = (t) => (typeof t === "number" ? t : Date.parse(t));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ─── bin model ───────────────────────────────────────────────────────────────────────────────
/** Ladder for shape "P" (needs tokenValueSol) or "S". Bins indexed relative to a0. */
export function buildLadder(shape, { binStep, tokenValueSol = 0 }) {
  const s = binStep / 1e4;
  const p = (j) => Math.pow(1 + s, j);
  const bins = new Map();
  if (shape === "P") {
    const T = tokenValueSol;
    const per = HALF_BINS_P + 0.5;
    for (let j = -HALF_BINS_P; j <= HALF_BINS_P; j++) {
      if (j < 0) bins.set(j, (0.5 / per) / p(j));
      else if (j === 0) bins.set(j, 0.5 / (2 * per) + T / (2 * per));
      else bins.set(j, T / per);
    }
    return { shape, s, lo: -HALF_BINS_P, hi: HALF_BINS_P, X: bins };
  }
  if (shape === "S") {
    for (let j = -(BINS_S - 1); j <= 0; j++) bins.set(j, (CAPITAL_SOL / BINS_S) / p(j));
    return { shape, s, lo: -(BINS_S - 1), hi: 0, X: bins };
  }
  throw new Error(`unknown shape ${shape}`);
}
const pr = (L, j) => Math.pow(1 + L.s, j);
/** Position value at relative active bin ja. */
export function valueAt(L, ja) {
  const pa = pr(L, ja);
  let v = 0;
  for (const [j, x] of L.X) v += j <= ja ? x * pr(L, j) : x * pa;
  return v;
}
/** Value of the tokens held at relative active bin ja (the active bin counts half). */
export function tokenValueAt(L, ja) {
  let x = 0;
  for (const [j, xj] of L.X) { if (j > ja) x += xj; else if (j === ja) x += 0.5 * xj; }
  return pr(L, ja) * x;
}
/** Our liquidity (SOL) in the active bin. */
export function activeLiquidity(L, ja) {
  const x = L.X.get(ja);
  return x == null ? 0 : x * pr(L, ja);
}

// ─── quotes ──────────────────────────────────────────────────────────────────────────────────
const clampRatio = (r) => (r == null ? null : Math.min(MAX_EXIT_RATIO, Math.max(0, r)));
export function sellQuotesOf(trade, ticks) {
  const out = [];
  const se = trade?.entry?.quotes?.sell_entry;
  if (se && num(se.ratio) != null) out.push({ t: ms(se.at), ratio: clampRatio(num(se.ratio)) });
  for (const k of ticks || []) {
    const q = typeof k.sell_quote === "string" ? safeJson(k.sell_quote) : k.sell_quote;
    if (q && num(q.ratio) != null) out.push({ t: ms(q.at ?? k.at), ratio: clampRatio(num(q.ratio)) });
  }
  return out.filter((q) => Number.isFinite(q.t)).sort((a, b) => a.t - b.t);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
/** Ratio of the latest quote taken at or before t (no look-ahead), or null. */
export function latestRatioAtOrBefore(quotes, t) {
  let best = null;
  for (const q of quotes) if (q.t <= t && (!best || q.t >= best.t)) best = q;
  return best ? best.ratio : null;
}

// ─── pool fees from the 5-minute bucket readings ──────────────────────────────────────────────
/**
 * ticks: the path (sorted, seen). Returns { inc: per-tick pool fee in USD for interval (k−1, k]
 * (inc[0] = 0, the baseline), missed_buckets, gap_usd, fee_gap, fee_gap_no_1h }.
 */
export function reconstructFees(ticks) {
  const inc = new Array(ticks.length).fill(0);
  let missed = 0, gapUsd = 0, gapNo1h = false, last1h = null;
  let prevFee = null, prevBucket = null;
  for (let k = 0; k < ticks.length; k++) {
    const tk = ticks[k];
    if (num(tk.fee_1h_usd) != null) last1h = num(tk.fee_1h_usd);
    const fee = num(tk.fee_usd);
    const bucket = ms(tk.fee_bucket_start);
    if (fee == null) continue; // no reading: the next one is compared with the last one seen
    if (prevFee == null) { prevFee = fee; prevBucket = Number.isFinite(bucket) ? bucket : null; continue; }
    const span = Number.isFinite(bucket) && prevBucket != null ? Math.round((bucket - prevBucket) / FEE_BUCKET_MS) : 0;
    const fell = fee < prevFee - FEE_EPS_USD;
    if (fell || span >= 2) {
      inc[k] = fee; // first reading of a new bucket
      const skipped = Math.max(0, span - 1);
      if (skipped > 0) {
        missed += skipped;
        if (last1h != null) { const add = skipped * (last1h / 12); inc[k] += add; gapUsd += add; } else gapNo1h = true;
      }
    } else {
      inc[k] = Math.max(0, fee - prevFee);
    }
    prevFee = fee;
    if (Number.isFinite(bucket)) prevBucket = bucket;
  }
  return { inc, missed_buckets: missed, gap_usd: gapUsd, fee_gap: missed > 0, fee_gap_no_1h: gapNo1h };
}

// ─── one trade ───────────────────────────────────────────────────────────────────────────────
export function simulateTrade(trade, ticks, { shape = "P", exits = PRIMARY_EXITS, feeFactor = 1 } = {}) {
  const base = { id: trade?.id, pool: trade?.pool, pair: trade?.pair, lane: trade?.lane, entered_at: trade?.entered_at, status: trade?.status ?? null, shape, exits: exits.id, fee_factor: feeFactor };
  const e = trade?.entry || {};
  const a0 = num(e.active_bin), binStep = num(e.bin_step);
  const t0 = ms(trade?.entered_at);
  if (a0 == null || binStep == null || binStep <= 0 || !Number.isFinite(t0)) return { ...base, excluded: "missing_geometry" };
  const buy = e.quotes?.buy || null;
  const buyT = num(buy?.tokens_value_sol);
  const quoteMissing = !(buyT != null && buyT > 0);
  const feePct = num(e.recorded?.fee_pct) ?? num(e.row?.fee_pct);
  const missingCostRatio = ((feePct ?? MISSING_QUOTE_UNKNOWN_FEE_PCT) + MISSING_QUOTE_EXTRA_PP) / 100;
  const entryRatio = quoteMissing ? missingCostRatio : clampRatio(1 - buyT / 0.5);
  let T = 0, entryCost = 0;
  if (shape === "P") { T = quoteMissing ? 0.5 * (1 - missingCostRatio) : buyT; entryCost = 0.5 - T; }
  const entryReading = { at: trade.entered_at, seen: true, active_bin: a0, tvl: num(e.tvl), active_tvl: num(e.active_tvl), fee_usd: null, sol_price_usd: num(e.sol_price_usd) };
  const later = (ticks || []).filter((k) => k.seen !== false && num(k.active_bin) != null && ms(k.at) > t0).sort((a, b) => ms(a.at) - ms(b.at));
  const atEntry = (ticks || []).filter((k) => k.seen !== false && num(k.active_bin) != null && ms(k.at) <= t0 && ms(k.at) >= t0 - 60_000);
  // the entry snapshot is the first reading (a tick at the entry poll carries the same state and its fee baseline)
  const path = [atEntry.length ? { ...atEntry[atEntry.length - 1], at: trade.entered_at } : entryReading, ...later];
  const quotes = sellQuotesOf(trade, ticks);
  const fees0 = reconstructFees(path);

  const L = buildLadder(shape, { binStep, tokenValueSol: T });
  let fees = 0, peak = -Infinity, mae = Infinity, exitIdx = null, rule = null, value = null, pnl = null;
  for (let k = 0; k < path.length; k++) {
    const tk = path[k];
    const ja = num(tk.active_bin) - a0;
    if (k > 0) {
      const prev = path[k - 1];
      const poolFeeUsd = fees0.inc[k];
      const atvl = num(tk.active_tvl), sol = num(tk.sol_price_usd);
      if (poolFeeUsd > 0 && atvl != null && sol && sol > 0) {
        const ours = activeLiquidity(L, num(prev.active_bin) - a0);
        const pool = atvl / sol / W_REF;
        if (ours > 0) fees += feeFactor * poolFeeUsd * (ours / (ours + pool)) / sol;
      }
    }
    value = valueAt(L, ja);
    pnl = (value + fees - CAPITAL_SOL) / CAPITAL_SOL * 100;
    if (pnl > peak) peak = pnl;
    if (pnl < mae) mae = pnl;
    const minutes = (ms(tk.at) - t0) / 60_000;
    const tvl = num(tk.tvl);
    if (tvl != null && tvl < exits.tvlExitUsd) rule = "tvl";
    else if (pnl <= exits.stopPct) rule = "stop";
    else if (peak >= exits.trailArmPct && pnl <= peak - exits.trailDropPp) rule = "trailing";
    else if (minutes >= exits.boxMin) rule = "time_box";
    if (rule) { exitIdx = k; break; }
  }
  if (exitIdx == null) { exitIdx = path.length - 1; rule = "data_end"; }
  const tExit = ms(path[exitIdx].at);
  const jaExit = num(path[exitIdx].active_bin) - a0;
  const qr = latestRatioAtOrBefore(quotes, tExit);
  const exitRatio = qr ?? entryRatio;
  const exitTok = tokenValueAt(L, jaExit);
  const exitCost = exitTok * (exitRatio ?? 0);
  const net = value + fees - exitCost - GAS_SOL - CAPITAL_SOL;
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return {
    ...base, excluded: null, ticks: path.length, exit_rule: rule, exit_at: new Date(tExit).toISOString(),
    minutes: Math.round((tExit - t0) / 60_000 * 10) / 10,
    peak_pct: r6(peak), mae_pct: r6(mae), gross_pct: r6((value + fees - CAPITAL_SOL) * 100),
    fees_sol: r6(fees), entry_cost_sol: r6(entryCost), entry_quote_missing: quoteMissing,
    exit_ratio: exitRatio == null ? null : r6(exitRatio), exit_ratio_source: qr != null ? "sell_quote" : "entry_cost", exit_cost_sol: r6(exitCost), gas_sol: GAS_SOL,
    fee_gap: fees0.fee_gap, fee_gap_buckets: fees0.missed_buckets, fee_gap_no_1h: fees0.fee_gap_no_1h,
    net_sol: r6(net), net_pct: r6(net / CAPITAL_SOL * 100),
    rank: num(e.rank), token_age_min: num(e.token_age_min), bot_holders_pct: num(e.recorded?.bot_holders_pct), fee_pct: feePct,
  };
}

// ─── the pass rule ───────────────────────────────────────────────────────────────────────────
function netChecks(rows) {
  const nets = rows.map((r) => r.net_sol);
  const s = sum(nets);
  const sorted = [...nets].sort((a, b) => b - a);
  const withoutTop2 = sum(sorted.slice(2));
  const dis = rows.filter((r) => r.net_pct <= PASS.disasterPct).length;
  const byTime = [...rows].sort((a, b) => ms(a.entered_at) - ms(b.entered_at));
  const h = Math.floor(byTime.length / 2);
  const first = sum(byTime.slice(0, h).map((r) => r.net_sol));
  const second = sum(byTime.slice(h).map((r) => r.net_sol));
  return {
    sum_net_sol: s, sum_without_two_best_sol: withoutTop2,
    disasters: dis, disaster_rate: rows.length ? dis / rows.length : null,
    first_half_sol: first, second_half_sol: second,
    pass_sum: s > 0 && withoutTop2 > 0,
    pass_disasters: rows.length > 0 && dis / rows.length <= PASS.maxDisasterRate,
    pass_halves: first > 0 && second > 0,
  };
}
/**
 * Pre-registered pass rule (shape P, primary exits, paper entries only).
 * primary / halved: graded rows (not excluded) for fees × 1 and × 0.5.
 */
export function gradePassRule(primary, halved, { now = Date.now(), captureStart = REGISTERED_CAPTURE_START } = {}) {
  const graded = (r) => !r.excluded && (r.status == null || r.status === "ended"); // never an open trade
  const rows = primary.filter(graded);
  const n = rows.length;
  const times = rows.map((r) => ms(r.entered_at)).filter(Number.isFinite);
  const spanDays = times.length ? (Math.max(...times) - Math.min(...times)) / DAY : 0;
  const startMs = Date.parse(`${captureStart}T00:00:00+07:00`);
  const timeArmPassed = Number.isFinite(startMs) && now >= startMs + PASS.timeArmDays * DAY;
  const sampleOk = n >= PASS.minEntries && spanDays >= PASS.minSpanDays;
  const full = netChecks(rows);
  const half = netChecks(halved.filter(graded));
  const checks = [
    { n: 1, name: "sample", need: `≥ ${PASS.minEntries} paper entries over ≥ ${PASS.minSpanDays} days`, value: `${n} entries over ${spanDays.toFixed(1)} days`, pass: sampleOk },
    { n: 2, name: "Σ net > 0 and > 0 without the two best", value: `${full.sum_net_sol.toFixed(4)} / ${full.sum_without_two_best_sol.toFixed(4)}`, pass: full.pass_sum },
    { n: 3, name: `disaster rate (net ≤ ${PASS.disasterPct} %) ≤ ${PASS.maxDisasterRate * 100} %`, value: full.disaster_rate == null ? "n/a" : `${full.disasters}/${n} = ${(full.disaster_rate * 100).toFixed(1)} %`, pass: full.pass_disasters },
    { n: 4, name: "positive in both halves (by entry time)", value: `${full.first_half_sol.toFixed(4)} / ${full.second_half_sol.toFixed(4)}`, pass: full.pass_halves },
    { n: 5, name: "checks 2–4 hold with fee income halved", value: `Σ ${half.sum_net_sol.toFixed(4)} / w/o 2 best ${half.sum_without_two_best_sol.toFixed(4)}; disasters ${half.disasters}; halves ${half.first_half_sol.toFixed(4)} / ${half.second_half_sol.toFixed(4)}`, pass: half.pass_sum && half.pass_disasters && half.pass_halves },
  ];
  let verdict, action;
  if (!sampleOk) {
    if (timeArmPassed && n < PASS.minEntries) { verdict = "drop"; action = "drop"; }
    else { verdict = "insufficient"; action = "wait"; }
  } else if (checks.slice(1).every((c) => c.pass)) { verdict = "met"; action = "build_enforce"; }
  else { verdict = "drop"; action = "drop"; }
  const missingQuote = rows.filter((r) => r.entry_quote_missing).length;
  const feeGap = rows.filter((r) => r.fee_gap).length;
  return { verdict, action, n, missing_entry_quote: missingQuote, fee_gap_entries: feeGap, open_not_graded: primary.filter((r) => !r.excluded && r.status && r.status !== "ended").length, span_days: spanDays, time_arm: Number.isFinite(startMs) ? new Date(startMs + PASS.timeArmDays * DAY + 7 * 3_600_000).toISOString().slice(0, 10) : null, checks, full, half }; // time_arm: a WIB date
}

// ─── run ─────────────────────────────────────────────────────────────────────────────────────
export function groupTicks(ticks) {
  const m = new Map();
  for (const k of ticks || []) { if (!k?.trade_id) continue; if (!m.has(k.trade_id)) m.set(k.trade_id, []); m.get(k.trade_id).push(k); }
  return m;
}
export function runSim(trades, ticks, { now = Date.now(), captureStart = REGISTERED_CAPTURE_START } = {}) {
  const byTrade = groupTicks(ticks);
  const variants = [PRIMARY_EXITS, ...SECONDARY_EXITS];
  const results = {};
  for (const lane of ["paper", "operator"]) {
    const ts = (trades || []).filter((t) => t.lane === lane).sort((a, b) => ms(a.entered_at) - ms(b.entered_at));
    results[lane] = {};
    for (const shape of ["P", "S"]) {
      for (const ex of variants) {
        for (const f of [1, 0.5]) {
          results[lane][`${shape}:${ex.id}:${f}`] = ts.map((t) => simulateTrade(t, byTrade.get(t.id) || [], { shape, exits: ex, feeFactor: f }));
        }
      }
    }
  }
  const grade = gradePassRule(results.paper["P:primary:1"], results.paper["P:primary:0.5"], { now, captureStart });
  return { generated_at: new Date(now).toISOString(), capture_start: captureStart, trades: (trades || []).length, ticks: (ticks || []).length, results, grade };
}

export function summarize(rows) {
  const g = rows.filter((r) => !r.excluded);
  const nets = g.map((r) => r.net_sol);
  const ex = {};
  for (const r of rows) if (r.excluded) ex[r.excluded] = (ex[r.excluded] || 0) + 1;
  const byRule = {};
  for (const r of g) byRule[r.exit_rule] = (byRule[r.exit_rule] || 0) + 1;
  return {
    n: g.length, excluded: ex, sum_net_sol: sum(nets), mean_net_pct: g.length ? sum(g.map((r) => r.net_pct)) / g.length : null,
    wins: g.filter((r) => r.net_sol > 0).length, disasters: g.filter((r) => r.net_pct <= PASS.disasterPct).length,
    sum_fees_sol: sum(g.map((r) => r.fees_sol)), by_exit: byRule,
    missing_entry_quote: g.filter((r) => r.entry_quote_missing).length,
    missing_entry_quote_net_sol: sum(g.filter((r) => r.entry_quote_missing).map((r) => r.net_sol)),
  };
}

const f4 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(4));
const f2 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(2));
export function formatReport(rep) {
  const L = [];
  L.push(`fresh-top-lane simulation — ${rep.generated_at} — ${rep.trades} trades, ${rep.ticks} ticks, capture start ${rep.capture_start}`);
  L.push("");
  L.push("Paper entries, shape P, primary exits (stop −10, trailing 3 / 1.5, box 120 min, TVL < $10K):");
  L.push("  entered_at               pair                 rank  exit      min     peak%    net%     fees◎    entry◎   exit◎  quote   gap");
  for (const r of rep.results.paper["P:primary:1"]) {
    if (r.excluded) { L.push(`  ${String(r.entered_at).slice(0, 19)}  ${String(r.pair).padEnd(20)} excluded: ${r.excluded}`); continue; }
    L.push(`  ${String(r.entered_at).slice(0, 19)}  ${String(r.pair).padEnd(20)} ${String(r.rank ?? "-").padStart(4)}  ${r.exit_rule.padEnd(8)} ${f2(r.minutes).padStart(6)} ${f2(r.peak_pct).padStart(8)} ${f2(r.net_pct).padStart(8)} ${f4(r.fees_sol).padStart(9)} ${f4(r.entry_cost_sol).padStart(8)} ${f4(r.exit_cost_sol).padStart(8)}  ${r.entry_quote_missing ? "MISSING" : "buy    "} ${r.fee_gap ? `${r.fee_gap_buckets}b` : "-"}${r.status && r.status !== "ended" ? "  (open, not graded)" : ""}`);
  }
  L.push("");
  L.push("Summary (graded rows; net in SOL on ◎1 unit capital):");
  for (const lane of ["paper", "operator"]) {
    for (const [k, rows] of Object.entries(rep.results[lane])) {
      const s = summarize(rows);
      if (!rows.length) continue;
      L.push(`  ${lane.padEnd(8)} ${k.padEnd(18)} n ${String(s.n).padStart(3)}  Σ net ${f4(s.sum_net_sol)}  mean ${f2(s.mean_net_pct)} %  wins ${s.wins}  ≤ −10 % ${s.disasters}  fees ${f4(s.sum_fees_sol)}  exits ${JSON.stringify(s.by_exit)}${Object.keys(s.excluded).length ? `  excluded ${JSON.stringify(s.excluded)}` : ""}`);
    }
  }
  L.push("");
  const g = rep.grade;
  L.push(`Pass rule (paper, shape P, primary): verdict ${g.verdict} → action ${g.action} (n ${g.n} ended, of which ${g.missing_entry_quote} without a buy quote and ${g.fee_gap_entries} with a fee gap; ${g.open_not_graded} still open, not graded; span ${g.span_days.toFixed(1)} d, time arm ${g.time_arm})`);
  for (const c of g.checks) L.push(`  ${c.n}. ${c.pass ? "PASS" : "fail"}  ${c.name}: ${c.value}${c.need ? ` (need ${c.need})` : ""}`);
  return L.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────
function readArrayFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const t = text.trim();
  if (t.startsWith("[")) return JSON.parse(t);
  return t.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
/** JSONL trades from the json backend are merged by id (insert + update lines). */
function mergeTrades(list) {
  const byId = new Map();
  for (const o of list) {
    if (!o?.id) continue;
    const { _op, ...rest } = o;
    const prev = byId.get(o.id);
    if (_op === "update") { if (prev) byId.set(o.id, { ...prev, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null)) }); }
    else if (!prev) byId.set(o.id, rest);
    else byId.set(o.id, { ...prev, ...rest });
  }
  return [...byId.values()];
}
function parseArgs(argv) {
  const a = { pg: false, trades: null, ticks: null, json: null, now: null, captureStart: REGISTERED_CAPTURE_START };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = argv[++i]; if (v == null) throw new Error(`${k} needs a value`); return v; };
    if (k === "--pg") a.pg = true;
    else if (k === "--trades") a.trades = val();
    else if (k === "--ticks") a.ticks = val();
    else if (k === "--json") a.json = val();
    else if (k === "--now") a.now = val();
    else if (k === "--capture-start") a.captureStart = val();
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.pg && (!a.trades || !a.ticks)) throw new Error("need --pg or --trades F --ticks F");
  return a;
}
export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  const now = a.now ? Date.parse(a.now) : Date.now();
  let trades, ticks;
  if (a.pg) {
    await import("../../envcrypt.js");
    const { query, closePool } = await import("../../db/pool.js");
    try {
      trades = (await query("SELECT id, pool, base_mint, pair, lane, position, entered_at, track_hours, entry, status, ended_at FROM lane_paper_trades ORDER BY entered_at")).rows
        .map((r) => ({ ...r, entered_at: new Date(r.entered_at).toISOString() }));
      ticks = (await query("SELECT trade_id, at, seen, active_bin, price, tvl, active_tvl, fee_usd, fee_window_min, volume_usd, market_cap, holders, rank, sol_price_usd, sell_quote FROM lane_paper_ticks ORDER BY trade_id, at")).rows
        .map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
    } finally { await closePool().catch(() => {}); }
  } else {
    trades = mergeTrades(readArrayFile(a.trades));
    ticks = readArrayFile(a.ticks);
  }
  const rep = runSim(trades, ticks, { now, captureStart: a.captureStart });
  console.log(formatReport(rep));
  if (a.json) fs.writeFileSync(a.json, JSON.stringify(rep, null, 2) + "\n");
  return 0;
}
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch((e) => { console.error(`[fresh_lane_sim] ${String(e?.message || e).split("\n")[0]}`); process.exit(1); });
}
