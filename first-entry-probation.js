// first-entry-probation.js — a tighter early stop for a pool's FIRST entry (2026-10-17), SHADOW by default.
//
// Replay (session scratchpad firstentry/, common.py + final.py + rules.py; bot deploys since
// 2026-09-26, rebalance legs excluded): a bot deploy into a pool with no BOT close in the prior
// 12 h ("first entry", n=112) netted −◎0.51 with 13 at ≤ −10 % (12 %), while quick re-entries
// (≤ 10 min after a close, n=71) netted +◎0.63. A stop at −8 % within 240 min of the deploy,
// first entries only, fires on 14, catches 11 of the 13 disasters, cuts 2 winners (−◎0.08,
// QI-SOL +5.0 %, BORDR-SOL +3.7 %) — net +◎0.44 (last 7 days +◎0.06; two large positions
// carry half). The same stop on re-entries would have cut CRAWL (+66 %) and HIGGS for −◎2.5,
// so it is first-entry only by construction.
//
// "Close" = a recorded close of this pool (perf record, same pool address) at most 12 h before
// the deploy; rebalance legs are not closes (the position continued). `first_entry` follows the
// replay: only BOT closes count — operator (adopted) positions do not. Counting operator
// closes as well (what pool-memory's deploy list would give, it carries no owner) turns 10 of
// the 112 into re-entries, and those 10 carried −◎0.49 and 3 of the 13 disasters: the stop
// then fires on 10 (8 disasters, 1 winner cut) for +◎0.25 instead of +◎0.44. Both are
// captured — `first_entry` (bot closes, drives the rule) and `first_entry_strict` (no close
// by anyone) — so the grade can use either.
//
// Pre-registered decision rule: after 15 would-fires or three weeks, enforce only if the
// would-fire positions finished at net worse than −8 % on their capital AND at most 1 in 4
// of them were winners.
//
// firstEntryProbationMode: off | shadow (default) | enforce. firstEntryProbationPct −8 (must be
// < 0), firstEntryProbationMin 240 (min 10). Leaf module (imports only reentry-gate.js).

import { previousCloseFromDeploys } from "./reentry-gate.js";

export const FIRST_ENTRY_PROBATION_MODES = ["off", "shadow", "enforce"];
export const FIRST_ENTRY_PROBATION_DEFAULT_PCT = -8;
export const FIRST_ENTRY_PROBATION_DEFAULT_MIN = 240;
export const FIRST_ENTRY_PROBATION_MIN_MIN = 10;

const num = (v) => (v == null || v === "" ? NaN : Number(v));

/** Resolved settings. Unknown mode = shadow; a pct ≥ 0 falls back to −8; minutes floored at 10. */
export function firstEntryProbationConfig(mgmt = {}) {
  const mode = FIRST_ENTRY_PROBATION_MODES.includes(mgmt?.firstEntryProbationMode) ? mgmt.firstEntryProbationMode : "shadow";
  const pct = num(mgmt?.firstEntryProbationPct);
  const min = num(mgmt?.firstEntryProbationMin);
  return {
    mode,
    pct: Number.isFinite(pct) && pct < 0 ? pct : FIRST_ENTRY_PROBATION_DEFAULT_PCT,
    min: Number.isFinite(min) ? Math.max(FIRST_ENTRY_PROBATION_MIN_MIN, min) : FIRST_ENTRY_PROBATION_DEFAULT_MIN,
  };
}

const isRebalanceLeg = (r) =>
  r?.rebalance_leg === true || r?.exit_family === "rebalance_leg" || /^rebalance(-failed)?:/i.test(String(r?.close_reason || ""));

/**
 * First-entry verdict for a deploy into `poolAddress` from the closed-position records
 * (lessons getAllPerformance). Pure. Returns
 *   { firstEntry, firstEntryStrict, prevBotCloseGapMin, prevAnyCloseGapMin }
 * firstEntry = no BOT close of this pool in the prior 12 h (the replay's cohort);
 * firstEntryStrict = no close by anyone (bot or operator). null when the records are unusable.
 */
export function firstEntryFromPerformance(records, poolAddress, now = Date.now()) {
  if (!poolAddress || !Array.isArray(records)) return { firstEntry: null, firstEntryStrict: null, prevBotCloseGapMin: null, prevAnyCloseGapMin: null };
  const asDeploys = (rows) => rows.map((r) => ({ closed_at: r.recorded_at, pnl_pct: r.pnl_pct, close_reason: r.close_reason }));
  const inPool = records.filter((r) => r && r.pool === poolAddress && !isRebalanceLeg(r));
  const bot = previousCloseFromDeploys(asDeploys(inPool.filter((r) => !r.adopted)), now, { requirePnl: false });
  const any = previousCloseFromDeploys(asDeploys(inPool), now, { requirePnl: false });
  return {
    firstEntry: bot == null,
    firstEntryStrict: any == null,
    prevBotCloseGapMin: bot ? bot.gapMin : null,
    prevAnyCloseGapMin: any ? any.gapMin : null,
  };
}

/** Exactly 75 — the value the replay found on 7 of 13 first-entry disasters (looks like a discovery-API placeholder). */
export function organicScoreExact75(score) {
  const n = num(score);
  return Number.isFinite(n) ? n === 75 : null;
}

/**
 * Pure decision for one trusted SOL-basis reading. Not eligible (null) when the mode is off, the
 * position is not a first entry, or the window since deploy has passed. Returns
 *   { wouldFire, mode, pct, windowMin, minutesSinceDeploy, pnlPct }
 */
export function evaluateFirstEntryProbation(pos, pnlPct, mgmt = {}, nowMs = Date.now()) {
  const cfg = firstEntryProbationConfig(mgmt);
  if (cfg.mode === "off" || pos?.first_entry !== true) return null;
  const deployedMs = pos?.deployed_at ? new Date(pos.deployed_at).getTime() : NaN;
  if (!Number.isFinite(deployedMs)) return null;
  const minutesSinceDeploy = (nowMs - deployedMs) / 60_000;
  if (!(minutesSinceDeploy >= 0) || minutesSinceDeploy > cfg.min) return null;
  const pnl = num(pnlPct);
  if (!Number.isFinite(pnl)) return null;
  return { wouldFire: pnl <= cfg.pct, mode: cfg.mode, pct: cfg.pct, windowMin: cfg.min, minutesSinceDeploy, pnlPct: pnl };
}

/** Close reason. Keeps the "first-entry probation" prefix (exit family `probation_stop`) and avoids "stop loss" / "below" / "oor". */
export function firstEntryProbationReason(d) {
  return `First-entry probation: PnL ${d.pnlPct.toFixed(2)}% <= ${d.pct}% at ${Math.round(d.minutesSinceDeploy)} min ` +
    `(no bot close in this pool in the prior 12 h; window ${d.windowMin} min)`;
}

/** Perf-record fields (three sites, tools/dlmm.js). */
export function firstEntryRecordFields(pos) {
  return {
    first_entry: typeof pos?.first_entry === "boolean" ? pos.first_entry : null,
    first_entry_strict: typeof pos?.first_entry_strict === "boolean" ? pos.first_entry_strict : null,
    organic_score_exact_75: typeof pos?.organic_score_exact_75 === "boolean" ? pos.organic_score_exact_75 : null,
    first_entry_probation: pos?.first_entry_probation && typeof pos.first_entry_probation === "object" ? pos.first_entry_probation : null,
  };
}
