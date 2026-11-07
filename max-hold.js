// max-hold.js — a maximum position duration, LOG ONLY by default (2026-11-07, operator request).
//
// Study (read-only, session scratchpad maxhold/: out_main.md, out_variants_bot.md,
// out_periods.md, analyze5.py): for bot deploys since 2026-09-26 a flat cap nets ≈ 0 — the
// interval spans zero at every cap length, a cap under 240 min is clearly negative, the sign
// flips between 3-week periods, and a naive "best cap over the last 40 closes" evolver LOST out
// of sample (a d ≥ 0.35-gated one stepped rarely and came out ≈ 0). So the rule ships in shadow,
// with a pre-registered enforce rule and a strictly gated evolver that mostly stays still.
//
// Pre-registered enforce rule: after ≥ 30 would-fires at the cap or 6 weeks, enforce only if
// Σ Δ◎ > 0 and still > 0 without the largest |Δ|; better ≥ worse; worst truncation ≤ ½ Σ;
// same sign in both halves of the sample.
//
// Pieces:
//   evaluateMaxHold()   pure decision for one trusted reading (state.js evaluator, after LOW_YIELD)
//   computeMaxHoldCf()  per-close counterfactual from the position's own price_ticks: what
//                       closing at each grid age T would have changed (perf record max_hold_cf)
//   evolveMaxHold()     pure evolver over records carrying max_hold_cf (one grid step at most,
//                       ≤ 1 step / 7 days, revert check on the next 20 affected closes)
//   summarizeMaxHoldCf() table for /maxhold
//
// Keys (management): maxHoldMode off | shadow (default) | enforce, maxHoldMinutes 360 (one of
// MAX_HOLD_GRID, else the nearest), maxHoldEvolveMode off | shadow (default) | enforce,
// maxHoldAppliesToAdopted false (operator positions are log-only even in enforce).
// Leaf module: imports rule-mode.js only.

import { modeFor } from "./rule-mode.js";

export const MAX_HOLD_GRID = Object.freeze([240, 360, 480, 720, 1440]);
export const MAX_HOLD_DEFAULT_MIN = 360;
export const MAX_HOLD_MODES = Object.freeze(["off", "shadow", "enforce"]);
export const MAX_HOLD_CF_VERSION = 1;
// Exit cost of the counterfactual close (study common.py / analyze.py)
export const MAX_HOLD_EXIT_GAS_SOL = 0.00002;
export const MAX_HOLD_DEFAULT_SLIP_RATIO = 0.003;
export const MAX_HOLD_SLIP_RATIO_CAP = 0.15;
// Counterfactual reading: median of the first 3 readings at/after age T, none if the first
// one is more than 15 min late.
const CF_READINGS = 3;
const CF_MAX_LAG_MS = 15 * 60_000;
// Capture eligibility
export const MAX_HOLD_CF_MIN_AGE_MIN = 10;
export const MAX_HOLD_CF_MAX_AGE_DAYS = 14;
// Evolver gates
export const MAX_HOLD_EVOLVE = Object.freeze({
  window: 60,          // last N eligible closes with max_hold_cf
  minAffected: 20,     // affected closes at the candidate T
  minD: 0.35,          // Cohen's d of Δ◎ vs 0
  stepSpacingDays: 7,  // at most one grid step per 7 days
  revertAfter: 20,     // the next N affected closes at the new T decide the revert
  tieSol: 0.0005,      // |Δ| under this is neither better nor worse (study)
});

const num = (v) => (v == null || v === "" ? NaN : Number(v));
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r2 = (v) => Math.round(v * 100) / 100;

/** The grid value nearest to `v` (ties go to the shorter cap); the default when unreadable. */
export function nearestGridMinutes(v) {
  const n = num(v);
  if (!Number.isFinite(n)) return MAX_HOLD_DEFAULT_MIN;
  let best = MAX_HOLD_GRID[0];
  for (const g of MAX_HOLD_GRID) if (Math.abs(g - n) < Math.abs(best - n)) best = g;
  return best;
}

/** Resolved settings (unknown mode → shadow; minutes snapped to the grid). */
export function maxHoldConfig(mgmt = {}) {
  return {
    mode: modeFor("maxHoldMode", mgmt?.maxHoldMode),
    minutes: nearestGridMinutes(mgmt?.maxHoldMinutes ?? MAX_HOLD_DEFAULT_MIN),
    evolveMode: modeFor("maxHoldEvolveMode", mgmt?.maxHoldEvolveMode),
    appliesToAdopted: mgmt?.maxHoldAppliesToAdopted === true,
  };
}

const pctFmt = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

/**
 * Pure decision for one reading. null when not eligible:
 *   mode off · HOLD · untrusted reading (pnl_management_ready === false, pnl_pct_suspicious, no
 *   finite pnl) · an active profit grace (reading.graceRemainingMin > 0, else
 *   pos.profit_grace_until) · above its range past upper_bin (all SOL — harvest / unfilled /
 *   OOR-above rules own that) · a pending straddle flow / capital re-base · age unknown · age
 *   under the cap.
 * Age = now − deployed_at (never adopted_at).
 * An adopted position is evaluated but never closed unless maxHoldAppliesToAdopted (logOnly).
 * Returns { action, rule, family, urgent, reason, enforce, logOnly, mode, minutesHeld, capMin, pnlPct }.
 */
export function evaluateMaxHold(pos, nowMs = Date.now(), cfg = {}, reading = {}) {
  const c = maxHoldConfig(cfg);
  if (!pos || c.mode === "off") return null;
  if (pos.hold_mode === true) return null;
  if (reading.pnl_management_ready === false || reading.pnl_pct_suspicious === true) return null;
  const pnl = num(reading.pnl_pct);
  if (!Number.isFinite(pnl)) return null;
  let grace = num(reading.graceRemainingMin);
  if (!Number.isFinite(grace)) {
    const until = pos.profit_grace_until ? new Date(pos.profit_grace_until).getTime() : NaN;
    grace = Number.isFinite(until) ? (until - nowMs) / 60_000 : 0;
  }
  if (grace > 0) return null;
  const active = num(reading.active_bin), upper = num(reading.upper_bin ?? pos.bin_range?.max);
  if (Number.isFinite(active) && Number.isFinite(upper) && active > upper) return null;
  if (reading.pendingFlow === true || (reading.pendingFlow == null && pos.pending_flow)) return null;
  if (pos.capital_rebase_pending) return null;
  const deployedMs = pos.deployed_at ? new Date(pos.deployed_at).getTime() : NaN;
  if (!Number.isFinite(deployedMs)) return null;
  const minutesHeld = (nowMs - deployedMs) / 60_000;
  if (!(minutesHeld >= c.minutes)) return null;
  const logOnly = pos.adopted === true && !c.appliesToAdopted;
  const held = Math.round(minutesHeld);
  return {
    action: "MAX_HOLD",
    rule: "max_hold",
    family: "max_hold",
    urgent: false,
    reason: `Max hold: ${held} min held ≥ ${c.minutes} min cap at pnl ${pctFmt(pnl)} (maxHoldMode=${c.mode})`,
    enforce: c.mode === "enforce" && !logOnly,
    logOnly,
    mode: c.mode,
    minutesHeld,
    capMin: c.minutes,
    pnlPct: pnl,
  };
}

/** The shadow log line (once per position). */
export function maxHoldShadowLine(pair, d) {
  return `[MAX_HOLD_SHADOW] would-close ${pair}: ${Math.round(d.minutesHeld)} min ≥ ${d.capMin} cap at pnl ${pctFmt(d.pnlPct)} ` +
    `(maxHoldMode=${d.mode}${d.logOnly ? "; operator position — log only, maxHoldAppliesToAdopted=false" : ""})`;
}

/** The record kept on the position at the first would-fire (→ perf record `max_hold_shadow`). */
export function maxHoldShadowRecord(d, at = new Date().toISOString()) {
  const rec = { would_fire_at: at, pnl_pct: r2(d.pnlPct), minutes_held: Math.round(d.minutesHeld), cap_min: d.capMin, mode: d.mode };
  if (d.logOnly) rec.log_only = "adopted";
  return rec;
}

// ── Per-close counterfactual (max_hold_cf) ──────────────────────────────────────────────────

const isRebalanceLeg = (r) =>
  r?.rebalance_leg === true || r?.exit_family === "rebalance_leg" || /^rebalance(-failed)?:/i.test(String(r?.close_reason || ""));

/** Records the capture takes: bot, not a rebalance leg, never held, closed 10 min … 14 d ago. */
export function isMaxHoldCfEligible(r, now = Date.now()) {
  if (!r || !r.position || r.adopted || isRebalanceLeg(r) || r.was_held === true) return false;
  const t = Date.parse(r.recorded_at);
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  if (age < MAX_HOLD_CF_MIN_AGE_MIN * 60_000 || age > MAX_HOLD_CF_MAX_AGE_DAYS * 86_400_000) return false;
  return Number.isFinite(num(r.minutes_held)) && Number.isFinite(num(r.pnl_pct)) && num(r.amount_sol) > 0;
}

/** Up to `limit` eligible records without max_hold_cf, newest first. */
export function maxHoldCfQueue(records, { now = Date.now(), limit = 2, skip = null } = {}) {
  const out = [];
  if (!Array.isArray(records)) return out;
  for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
    const r = records[i];
    if (r?.max_hold_cf != null || !isMaxHoldCfEligible(r, now)) continue;
    if (skip && skip.has(r.position)) continue;
    out.push(r);
  }
  return out;
}

/** The time window of the position's ticks worth reading (start − 2 min … close + 1 min). */
export function maxHoldCfTickWindow(rec) {
  const close = Date.parse(rec?.recorded_at);
  const held = num(rec?.minutes_held);
  if (!Number.isFinite(close) || !Number.isFinite(held)) return null;
  return { from: new Date(close - held * 60_000 - 2 * 60_000), to: new Date(close + 60_000) };
}

/** Realized exit-swap cost of the record in SOL (study: exit_slippage_sol, else slippage_usd × sol / value). */
export function recordExitSlipSol(rec) {
  const s = num(rec?.exit_slippage_sol);
  if (Number.isFinite(s)) return s;
  const es = rec?.exit_swap || {};
  const su = num(es.slippage_usd), vu = num(es.value_usd), sr = num(es.sol_received);
  return Number.isFinite(su) && vu > 0 && sr > 0 ? (su * sr) / vu : 0;
}

/** Slippage ratio of the record's exit swap (slippage / market value, clamped 0 … 0.15), else null. */
export function recordExitSlipRatio(rec) {
  const es = rec?.exit_swap || {};
  const su = num(es.slippage_usd), mu = num(es.market_usd);
  if (!Number.isFinite(su) || !(mu > 0)) return null;
  return Math.min(Math.max(su / mu, 0), MAX_HOLD_SLIP_RATIO_CAP);
}

/** Share of the position held as base at `bin` (single-sided SOL ladder): 1 under, 0 above, linear in range, 0.5 unknown. */
export function baseFraction(bin, lo, hi) {
  if (![bin, lo, hi].every(Number.isFinite)) return 0.5;
  if (bin > hi) return 0;
  if (bin < lo) return 1;
  return (hi - bin) / Math.max(hi - lo + 1, 1);
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Counterfactual of closing at each grid age T, from the position's own poller ticks
 * ([{ ts, pnl_pct, active_bin }], any order). Pure.
 *   pnl_at    median of the first 3 readings at/after age T (null: not alive at T, or the
 *             first reading is > 15 min late)
 *   state_at  in | above | under — the first of those readings' active_bin vs the record's bin_range
 *   delta_sol (pnl_at − record pnl_pct)/100 × amount_sol − exit cost + the record's realized
 *             exit-swap cost (record pnl_pct is before the swap). Exit cost = 0 above range, else
 *             base_fraction × amount_sol × (1 + pnl_at/100) × slippage ratio (the record's own,
 *             else 0.3 %) + ◎0.00002. Positive = the cap would have done better.
 *   affected  open at T, a reading at T, and not above its range (where the rule never fires)
 * Note: the range is the record's final bin_range (a straddle / re-range before T is not
 * reconstructed — the study walked position_events back for that).
 */
export function computeMaxHoldCf(rec, ticks, { grid = MAX_HOLD_GRID, now = Date.now(), source = "price_ticks" } = {}) {
  const base = { version: MAX_HOLD_CF_VERSION, computed_at: new Date(now).toISOString() };
  const close = Date.parse(rec?.recorded_at);
  const held = num(rec?.minutes_held);
  if (!Number.isFinite(close) || !Number.isFinite(held)) return { ...base, unavailable: "no_age", source };
  const start = close - held * 60_000;
  const rows = (Array.isArray(ticks) ? ticks : [])
    .map((t) => ({ t: new Date(t.ts).getTime(), p: num(t.pnl_pct), b: num(t.active_bin) }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p) && Math.abs(x.p) <= 100
      && x.t >= start - 2 * 60_000 && x.t <= close + 60_000)
    .sort((a, b) => a.t - b.t);
  if (!rows.length) return { ...base, unavailable: "no_ticks", source };
  const final = num(rec.pnl_pct), amt = num(rec.amount_sol);
  const ratio = recordExitSlipRatio(rec) ?? MAX_HOLD_DEFAULT_SLIP_RATIO;
  const slip = recordExitSlipSol(rec);
  const lo = num(rec?.bin_range?.min), hi = num(rec?.bin_range?.max);
  const out = {};
  for (const T of grid) {
    const cell = { pnl_at: null, state_at: null, delta_sol: null, affected: false };
    out[String(T)] = cell;
    if (!(held > T)) continue;
    const target = start + T * 60_000;
    const after = rows.filter((x) => x.t >= target).slice(0, CF_READINGS);
    if (!after.length || after[0].t - target > CF_MAX_LAG_MS) continue;
    const p = median(after.map((x) => x.p));
    const b = after[0].b;
    const state = [b, lo, hi].every(Number.isFinite) ? (b > hi ? "above" : b < lo ? "under" : "in") : null;
    const cost = state === "above" ? 0 : baseFraction(b, lo, hi) * amt * (1 + p / 100) * ratio + MAX_HOLD_EXIT_GAS_SOL;
    cell.pnl_at = Math.round(p * 1e4) / 1e4;
    cell.state_at = state;
    cell.delta_sol = r6(((p - final) / 100) * amt - cost + slip);
    cell.affected = state !== "above";
  }
  return { ...base, grid: out, source, ticks: rows.length };
}

// ── Evolver ─────────────────────────────────────────────────────────────────────────────────

/** Records with a usable max_hold_cf (eligibility as the capture, minus the age bounds), oldest first. */
export function maxHoldCfRecords(records) {
  return (Array.isArray(records) ? records : [])
    .filter((r) => r && r.max_hold_cf?.grid && !r.max_hold_cf.unavailable && !r.adopted && !isRebalanceLeg(r) && r.was_held !== true)
    .sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
}

const affectedDeltas = (recs, T) => recs
  .map((r) => r.max_hold_cf.grid[String(T)])
  .filter((c) => c?.affected === true && Number.isFinite(num(c.delta_sol)))
  .map((c) => num(c.delta_sol));

function stats(deltas) {
  const n = deltas.length;
  const sum = deltas.reduce((s, x) => s + x, 0);
  const mean = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(deltas.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const tie = MAX_HOLD_EVOLVE.tieSol;
  const largest = n ? deltas.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0) : 0;
  return {
    n,
    sum: r6(sum),
    sum_wo_largest: r6(sum - largest),
    d: sd > 0 ? Math.round((mean / sd) * 100) / 100 : 0,
    better: deltas.filter((x) => x > tie).length,
    worse: deltas.filter((x) => x < -tie).length,
    worst: n ? r6(Math.min(...deltas)) : null,
  };
}

/** Per-T table over the evolver's window (last 60 records with a usable max_hold_cf). */
export function summarizeMaxHoldCf(records, { grid = MAX_HOLD_GRID, window = MAX_HOLD_EVOLVE.window } = {}) {
  const recs = maxHoldCfRecords(records).slice(-window);
  const half = Math.floor(recs.length / 2);
  const first = recs.slice(0, half), second = recs.slice(half);
  const rows = grid.map((T) => {
    const s = stats(affectedDeltas(recs, T));
    return { T, ...s, half1: r6(affectedDeltas(first, T).reduce((a, x) => a + x, 0)), half2: r6(affectedDeltas(second, T).reduce((a, x) => a + x, 0)) };
  });
  return { n_records: recs.length, from: recs[0]?.recorded_at ?? null, to: recs[recs.length - 1]?.recorded_at ?? null, rows };
}

const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "0");
const solFmt = (v) => `◎${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

/** The gates a candidate row must pass; returns the first failed one as a reason, else null. */
export function maxHoldGateFailure(row) {
  const E = MAX_HOLD_EVOLVE;
  if (row.n < E.minAffected) return `n=${row.n} affected < ${E.minAffected}`;
  if (!(row.sum > 0)) return `Σ ${solFmt(row.sum)} ≤ 0`;
  if (!(row.d >= E.minD)) return `d=${row.d} < ${E.minD}`;
  if (!(row.sum_wo_largest > 0)) return `Σ without the largest |Δ| ${solFmt(row.sum_wo_largest)} ≤ 0`;
  if (!(row.better > row.worse)) return `better ${row.better} ≤ worse ${row.worse}`;
  if (!(row.half1 > 0 && row.half2 > 0)) return `halves ${sgn(row.half1)}/${sgn(row.half2)}`;
  if (row.worst != null && row.worst < 0 && -row.worst > 0.5 * row.sum) return `worst truncation ${solFmt(row.worst)} > ½ Σ`;
  return null;
}

const statLine = (r) => `n=${r.n}, Σ${solFmt(r.sum)}, d=${r.d}, ${r.better}/${r.worse}, halves ${sgn(r.half1)}/${sgn(r.half2)}`;

/**
 * Pure evolver verdict. `state` = the persisted evolver state ({ last_step_at, step: { at,
 * from, to, metric_before, status } }). Returns
 *   { action: "step" | "revert" | "confirm" | "none", from, to, candidate, row, reason, text }
 * Order: a pending step is checked first (the first 20 affected closes after it at the new T:
 * Σ < 0 → revert, else confirm; until then no new step); then the 7-day spacing; then the
 * candidate (the T with the largest Σ in the window) must pass every gate, and the cap moves
 * ONE grid step toward it. The mode is never changed here.
 */
export function evolveMaxHold(records, { currentMinutes = MAX_HOLD_DEFAULT_MIN, state = {}, now = Date.now(), grid = MAX_HOLD_GRID } = {}) {
  const E = MAX_HOLD_EVOLVE;
  const cur = nearestGridMinutes(currentMinutes);
  const base = { from: cur, to: cur, candidate: null, row: null };
  const step = state?.step;
  if (step && step.status === "pending") {
    const at = Date.parse(step.at);
    const after = maxHoldCfRecords(records).filter((r) => Date.parse(r.recorded_at) > at);
    const deltas = affectedDeltas(after, step.to).slice(0, E.revertAfter);
    if (deltas.length < E.revertAfter) {
      return { ...base, action: "none", reason: `awaiting the check of the last step ${step.from} → ${step.to} (${deltas.length}/${E.revertAfter} affected closes)`, text: null };
    }
    const sum = r6(deltas.reduce((a, x) => a + x, 0));
    if (sum < 0) {
      return { ...base, action: "revert", from: cur, to: nearestGridMinutes(step.from), check_sum: sum,
        reason: `Σ ${solFmt(sum)} over the ${E.revertAfter} affected closes at ${step.to} min after the step (was ${solFmt(Number(step.metric_before) || 0)} at the decision)` };
    }
    return { ...base, action: "confirm", check_sum: sum, reason: `Σ ${solFmt(sum)} over the ${E.revertAfter} affected closes at ${step.to} min after the step` };
  }
  const summary = summarizeMaxHoldCf(records, { grid });
  const rows = summary.rows.filter((r) => r.n > 0);
  if (!rows.length) return { ...base, action: "none", reason: `no affected closes in the window (${summary.n_records} records with max_hold_cf)` };
  const best = rows.reduce((m, r) => (r.sum > m.sum ? r : m), rows[0]);
  const lastStep = Date.parse(state?.last_step_at);
  if (Number.isFinite(lastStep) && now - lastStep < E.stepSpacingDays * 86_400_000) {
    return { ...base, candidate: best.T, row: best, action: "none", reason: `last step ${((now - lastStep) / 86_400_000).toFixed(1)} d ago (< ${E.stepSpacingDays} d)` };
  }
  if (best.T === cur) return { ...base, candidate: best.T, row: best, action: "none", reason: `the best T is the current cap (${statLine(best)})` };
  const fail = maxHoldGateFailure(best);
  if (fail) return { ...base, candidate: best.T, row: best, action: "none", reason: `candidate ${best.T} min: ${fail}` };
  const i = grid.indexOf(cur), j = grid.indexOf(best.T);
  const to = grid[i + Math.sign(j - i)];
  return { ...base, to, candidate: best.T, row: best, action: "step", reason: statLine(best) };
}

/** The log line for one evaluation (prefix by evolve mode). */
export function maxHoldEvolveLine(v, mode) {
  const tag = mode === "enforce" ? "[MAX_HOLD_EVOLVE]" : "[MAX_HOLD_EVOLVE_SHADOW]";
  const would = mode === "enforce" ? "" : "would-";
  if (v.action === "step") return `${tag} ${would}step maxHoldMinutes ${v.from} → ${v.to} (${v.reason})`;
  if (v.action === "revert") return `${tag} ${would}revert maxHoldMinutes ${v.from} → ${v.to} (${v.reason})`;
  if (v.action === "confirm") return `${tag} step confirmed (${v.reason})`;
  return `${tag} no step (${v.reason})`;
}

/** /maxhold text (plain, for <pre>). */
export function formatMaxHoldReport(records, { cfg = {}, state = {}, now = Date.now() } = {}) {
  const c = maxHoldConfig(cfg);
  const s = summarizeMaxHoldCf(records);
  const v = evolveMaxHold(records, { currentMinutes: c.minutes, state, now });
  const lines = [
    `Max hold — maxHoldMode=${c.mode}, cap ${c.minutes} min, maxHoldEvolveMode=${c.evolveMode}`,
    `Window: ${s.n_records} closes with max_hold_cf${s.from ? ` (${s.from.slice(0, 10)} … ${s.to.slice(0, 10)})` : ""}`,
    "Δ◎ = capped at T − actual (positive = the cap was better)",
    "    T    n        Σ◎   w/o max    d   b/w  halves   worst",
  ];
  for (const r of s.rows) {
    lines.push(`${String(r.T).padStart(5)} ${String(r.n).padStart(4)} ${r.sum.toFixed(3).padStart(9)} ${r.sum_wo_largest.toFixed(3).padStart(9)} ${r.d.toFixed(2).padStart(5)} ${`${r.better}/${r.worse}`.padStart(5)}  ${sgn(r.half1)}/${sgn(r.half2)}    ${r.worst == null ? "—" : r.worst.toFixed(3)}`);
  }
  lines.push("", `Evolver: ${maxHoldEvolveLine(v, c.evolveMode).replace(/^\[[A-Z_]+\] /, "")}`);
  return lines.join("\n");
}
