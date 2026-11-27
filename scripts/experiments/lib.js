// scripts/experiments/lib.js — pure grading functions for the shadow-rule experiments.
//
// Input: an array of closed-position perf records (an EXPORT — never the live DB), the
// experiment definitions (definitions.js) and a flat config object (prod user-config.json keys).
// Nothing here reads files, the network or the clock (`now` is passed in).
//
// Record conventions (verified on the 2026-11-23 export, 1,455 records):
//   bot deploy   adopted falsy AND not a rebalance leg (rebalance_leg / exit_family
//                rebalance_leg / close_reason "rebalance:" or "rebalance-failed:")
//   result       pnl_sol_net, fallback pnl_sol (SOL); percent = pnl_pct
//   disaster     pnl_pct ≤ −10
//   winner       pnl_sol_net > 0 (fallback pnl_pct > 0 when pnl_sol_net is missing)
//   population   only records CARRYING the experiment's tag field (key present, value not
//                undefined); "rest" = bot deploys carrying it with a false verdict. A definition
//                with population "bot_and_operator" pools adopted operator records too
//                (inPopulation; rebalance legs still out) — grace-profit-lock and reading-guard
//
// Verdicts: met | not_met | drop | insufficient | report_only | already_enforced.

import { modeFor, RULE_MODE_SPECS } from "../../rule-mode.js";
import { summarizeMaxHoldCf, maxHoldCfRecords, maxHoldConfig, MAX_HOLD_EVOLVE } from "../../max-hold.js";
import { exitFamilyOf } from "../../exit-family.js";

const DAY_MS = 86_400_000;
export const BOOTSTRAP_B = 2000;
export const BOOTSTRAP_SEED = 20261123;
export const SCORED_EXIT_QUALITY = Object.freeze(["good_exit", "early_exit", "flat", "marginal"]);
export const REVERT_MIN_N = 8;

// ── Record helpers ───────────────────────────────────────────────────────────────────────────

const fin = (v) => v != null && v !== "" && Number.isFinite(Number(v));
const num = (v) => (fin(v) ? Number(v) : null);
const r6 = (v) => (v == null || !Number.isFinite(v) ? v : Math.round(v * 1e6) / 1e6);
const r4 = (v) => (v == null || !Number.isFinite(v) ? v : Math.round(v * 1e4) / 1e4);

export function isRebalanceLeg(r) {
  return r?.rebalance_leg === true || r?.exit_family === "rebalance_leg" || /^rebalance(-failed)?:/i.test(String(r?.close_reason || ""));
}

export function isBotDeploy(r) {
  return !!r && !r.adopted && !isRebalanceLeg(r);
}

/**
 * Population of an experiment: bot deploys only (default), or — `population: "bot_and_operator"`
 * — bot and adopted operator records pooled, rebalance legs still excluded.
 */
export function inPopulation(def, r) {
  if (!r) return false;
  if (def?.population === "bot_and_operator") return !isRebalanceLeg(r);
  return isBotDeploy(r);
}

export const ownerOf = (r) => (r?.adopted ? "operator" : "bot");

// ── Generic record counter (schedule.json need.count) ────────────────────────────────────────
// Spec: { population: "bot" | "bot_and_operator", exit_family?: string | string[], since?: ISO }.
// Counts perf records in the population (inPopulation) whose family (stored exit_family, else
// derived from close_reason — exitFamilyOf) is one of exit_family, with since ≤ recorded_at ≤ asOf.
// Second source (2026-11-27, fresh-top-lane): { source: "lane_paper_trades", lane: "paper" |
// "operator", status?: "ended" | "open", since?: ISO } counts the lane's paper-trade rows
// (fresh-lane-paper.js) — by ended_at when status is "ended" (the pass rule grades only ended
// entries), else by entered_at; the caller passes those rows instead of perf records
// (scoreboard.js buildRows `laneTrades`). `source: "perf_records"` (or absent) is the counter above.
export const COUNT_POPULATIONS = Object.freeze(["bot", "bot_and_operator"]);
export const COUNT_SOURCES = Object.freeze(["perf_records", "lane_paper_trades"]);
export const COUNT_LANES = Object.freeze(["paper", "operator"]);
export const isLaneCount = (spec) => spec?.source === "lane_paper_trades";
export function countSpecError(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "count is not an object";
  if (spec.source !== undefined && !COUNT_SOURCES.includes(spec.source)) return `count.source must be one of ${COUNT_SOURCES.join(" | ")}`;
  if (isLaneCount(spec)) {
    for (const k of Object.keys(spec)) if (!["source", "lane", "status", "since"].includes(k)) return `unknown count key ${k} for source lane_paper_trades`;
    if (!COUNT_LANES.includes(spec.lane)) return `count.lane must be one of ${COUNT_LANES.join(" | ")}`;
    if (spec.status !== undefined && !["ended", "open"].includes(spec.status)) return "count.status must be ended | open";
  } else {
    for (const k of Object.keys(spec)) if (!["source", "population", "exit_family", "since"].includes(k)) return `unknown count key ${k}`;
    if (!COUNT_POPULATIONS.includes(spec.population)) return `count.population must be one of ${COUNT_POPULATIONS.join(" | ")}`;
    if (spec.exit_family !== undefined) {
      const fams = Array.isArray(spec.exit_family) ? spec.exit_family : [spec.exit_family];
      if (!fams.length || !fams.every((f) => typeof f === "string" && f)) return "count.exit_family must be a family name or a list of them";
    }
  }
  if (spec.since !== undefined && !Number.isFinite(Date.parse(spec.since))) return `count.since ${spec.since} is not a timestamp`;
  return null;
}
const countTime = (spec, r) => Date.parse(isLaneCount(spec) ? (spec.status === "ended" ? r?.ended_at : r?.entered_at) : r?.recorded_at);
function countMatches(spec, r) {
  if (isLaneCount(spec)) return r?.lane === spec.lane && (spec.status === undefined || (r?.status || "open") === spec.status);
  if (!inPopulation({ population: spec.population }, r)) return false;
  const fams = spec.exit_family === undefined ? null : Array.isArray(spec.exit_family) ? spec.exit_family : [spec.exit_family];
  return !fams || fams.includes(exitFamilyOf(r));
}
/** Number of matching records (perf records, or lane paper-trade rows for a lane spec), or null when the spec is invalid. */
export function countRecords(spec, records, asOfMs = Infinity) {
  if (countSpecError(spec)) return null;
  const since = spec.since === undefined ? -Infinity : Date.parse(spec.since);
  let n = 0;
  for (const r of Array.isArray(records) ? records : []) {
    const t = countTime(spec, r);
    if (!Number.isFinite(t) || t < since || t > asOfMs) continue;
    if (!countMatches(spec, r)) continue;
    n++;
  }
  return n;
}
/** Time of the earliest matching record (ms), or null. */
export function firstCountedAt(spec, records) {
  if (countSpecError(spec)) return null;
  let first = null;
  for (const r of Array.isArray(records) ? records : []) {
    const t = countTime(spec, r);
    if (Number.isFinite(t) && (first === null || t < first) && countRecords(spec, [r]) === 1) first = t;
  }
  return first;
}

/** pnl_sol_net, else pnl_sol, else null. */
export function netSol(r) {
  if (fin(r?.pnl_sol_net)) return Number(r.pnl_sol_net);
  if (fin(r?.pnl_sol)) return Number(r.pnl_sol);
  return null;
}

export function isWinner(r) {
  if (fin(r?.pnl_sol_net)) return Number(r.pnl_sol_net) > 0;
  return fin(r?.pnl_pct) ? Number(r.pnl_pct) > 0 : false;
}

export function isDisaster(r) {
  return fin(r?.pnl_pct) && Number(r.pnl_pct) <= -10;
}

/** The record carries the field: key present and value not undefined (null counts). */
export function hasField(r, field) {
  return !!r && Object.prototype.hasOwnProperty.call(r, field) && r[field] !== undefined;
}

const tsOf = (r) => Date.parse(r?.recorded_at);
const byTime = (a, b) => tsOf(a) - tsOf(b);
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) ?? 0), 0);

// ── Mode ─────────────────────────────────────────────────────────────────────────────────────

/** Effective mode as the running code would parse it: --config value, else the code default. */
export function resolveMode(def, cfg = {}) {
  const has = cfg && Object.prototype.hasOwnProperty.call(cfg, def.configKey) && cfg[def.configKey] != null;
  const raw = has ? cfg[def.configKey] : def.codeDefault;
  const source = has ? "config" : "code_default";
  if (def.modeKind === "trigger") {
    const v = Number(raw);
    const value = Number.isFinite(v) && v > 0 ? v : 0;
    return { mode: value > 0 ? "shadow" : "off", value, source };
  }
  if (def.modeKind === "flag") return { mode: raw === false ? "off" : "shadow", value: raw !== false, source };
  const mode = RULE_MODE_SPECS[def.configKey] ? modeFor(def.configKey, raw) : String(raw);
  return { mode, value: raw, source };
}

// ── Deterministic bootstrap ──────────────────────────────────────────────────────────────────

/** mulberry32 — small seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  if (!Number.isFinite(sorted[lo]) || !Number.isFinite(sorted[hi])) return sorted[hi];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const resample = (arr, rnd) => {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[Math.floor(rnd() * arr.length)];
  return out;
};

/** 90 % percentile CI of Σ values (resampling with replacement). null for an empty sample. */
export function bootstrapSumCI(values, { B = BOOTSTRAP_B, seed = BOOTSTRAP_SEED } = {}) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return null;
  const rnd = mulberry32(seed);
  const sums = [];
  for (let b = 0; b < B; b++) sums.push(resample(v, rnd).reduce((s, x) => s + x, 0));
  sums.sort((x, y) => x - y);
  return { lo: r6(quantile(sums, 0.05)), hi: r6(quantile(sums, 0.95)), B, seed };
}

/**
 * 90 % CI of rate(tagged) / rate(rest) for 0/1 flags, both groups resampled independently.
 * A resample with rest rate 0 gives Infinity (tagged > 0) or NaN (both 0, dropped); the
 * bounds are then "inf" when they land there.
 */
export function bootstrapRatioCI(taggedFlags, restFlags, { B = BOOTSTRAP_B, seed = BOOTSTRAP_SEED } = {}) {
  if (!taggedFlags.length || !restFlags.length) return null;
  const rnd = mulberry32(seed + 1);
  const ratios = [];
  let dropped = 0;
  const rate = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  for (let b = 0; b < B; b++) {
    const rt = rate(resample(taggedFlags, rnd)), rr = rate(resample(restFlags, rnd));
    const q = rr > 0 ? rt / rr : rt > 0 ? Infinity : NaN;
    if (Number.isNaN(q)) dropped++;
    else ratios.push(q);
  }
  ratios.sort((x, y) => x - y);
  const show = (v) => (v == null ? null : Number.isFinite(v) ? r4(v) : "inf");
  return { lo: show(quantile(ratios, 0.05)), hi: show(quantile(ratios, 0.95)), B, seed: seed + 1, dropped_both_zero: dropped };
}

// ── Sample / threshold helpers ───────────────────────────────────────────────────────────────

function sampleInfo(def, carrying, tagged, rest, now) {
  const times = carrying.map(tsOf).filter(Number.isFinite).sort((a, b) => a - b);
  const since = Date.parse(def.shadowSince);
  return {
    n_tagged: tagged.length,
    n_rest: rest.length,
    n_carrying: carrying.length,
    first_at: times.length ? new Date(times[0]).toISOString() : null,
    last_at: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    days_running: Number.isFinite(since) ? Math.round(((now - since) / DAY_MS) * 10) / 10 : null,
  };
}

/** Threshold: n ≥ minTagged OR (minDays set AND days since shadowSince ≥ minDays). */
function thresholdState(def, nTagged, now) {
  const since = Date.parse(def.shadowSince);
  const days = Number.isFinite(since) ? (now - since) / DAY_MS : null;
  const byN = nTagged >= def.minTagged;
  const byTime = def.minDays != null && days != null && days >= def.minDays;
  const parts = [];
  if (!byN) parts.push(`${def.minTagged - nTagged} more tagged closes`);
  if (def.minDays != null && !byTime) parts.push(`${new Date(since + def.minDays * DAY_MS).toISOString().slice(0, 10)} (${Math.ceil(def.minDays - days)} d)`);
  return {
    reached: byN || byTime,
    by: byN && byTime ? "n_and_time" : byN ? "n" : byTime ? "time" : null,
    need: def.minDays != null ? `${def.minTagged} tagged or ${def.minDays} days` : `${def.minTagged} tagged`,
    missing: byN || byTime ? null : parts.join(" or until "),
  };
}

const verdictFrom = (def, { reached, allPass, nTagged }) => {
  if (!reached) return "insufficient";
  if (allPass) return "met";
  if (def.dropClause) return "drop";
  if (def.dropAtN != null && nTagged >= def.dropAtN) return "drop";
  return "not_met";
};

const fmtSol = (v) => (v == null || !Number.isFinite(v) ? "n/a" : `◎${v >= 0 ? "+" : ""}${v.toFixed(4)}`);
const fmtPct = (v, d = 1) => (v == null || !Number.isFinite(v) ? "n/a" : `${v.toFixed(d)}%`);

// ── Disaster-ratio entry gates (reentry-gate, fee-edge, pump-gate) ───────────────────────────

function groupStats(rows) {
  const n = rows.length;
  const disasters = rows.filter(isDisaster).length;
  const winners = rows.filter(isWinner).length;
  const net = sum(rows, netSol);
  return {
    n,
    disasters,
    disaster_rate: n ? disasters / n : null,
    winners,
    net_sol: r6(net),
    mean_pnl_pct: n ? r4(sum(rows, (r) => num(r.pnl_pct)) / n) : null,
    missing_net: rows.filter((r) => netSol(r) == null).length,
    net_from_pnl_sol_fallback: rows.filter((r) => !fin(r.pnl_sol_net) && fin(r.pnl_sol)).length,
  };
}

/** The two checks of the disaster-ratio rules. A tagged rate of 0 never passes (0 ≥ 2 × 0 is not a separation). */
export function disasterRatioChecks(tagged, rest) {
  const t = groupStats(tagged), r = groupStats(rest);
  const ratio = r.disaster_rate > 0 ? t.disaster_rate / r.disaster_rate : t.disaster_rate > 0 ? Infinity : null;
  const ratioPass = t.n > 0 && r.n > 0 && t.disaster_rate > 0 && t.disaster_rate >= 2 * r.disaster_rate;
  return {
    stats: { tagged: t, rest: r, disaster_ratio: ratio == null ? null : Number.isFinite(ratio) ? r4(ratio) : "inf" },
    checks: [
      {
        name: "tagged ≤ −10 % rate ≥ 2× the rest's",
        value: ratio == null ? null : Number.isFinite(ratio) ? r4(ratio) : "inf",
        need: "≥ 2 (and tagged rate > 0)",
        pass: ratioPass,
        detail: `tagged ${t.disasters}/${t.n} = ${fmtPct(100 * (t.disaster_rate ?? NaN))} vs rest ${r.disasters}/${r.n} = ${fmtPct(100 * (r.disaster_rate ?? NaN))}`,
      },
      {
        name: "tagged Σ net < 0",
        value: t.net_sol,
        need: "< 0",
        pass: t.n > 0 && t.net_sol < 0,
        detail: `${fmtSol(t.net_sol)} over ${t.n} (winners ${t.winners}, mean pnl ${fmtPct(t.mean_pnl_pct, 2)})`,
      },
    ],
  };
}

function largestAbsNet(rows) {
  let best = null;
  for (const r of rows) {
    const v = netSol(r);
    if (v == null) continue;
    if (!best || Math.abs(v) > Math.abs(netSol(best))) best = r;
  }
  return best;
}

const recordRef = (r) => (r ? { position: r.position ?? null, pool_name: r.pool_name ?? null, recorded_at: r.recorded_at ?? null, net_sol: r6(netSol(r)), pnl_pct: num(r.pnl_pct) } : null);

/** Checks re-run on the records up to the moment the threshold was first reached (the pre-registered decision point). */
function decisionPointView(def, carryingSorted, isTagged, isRest, checksFn) {
  const tagged = carryingSorted.filter(isTagged);
  const since = Date.parse(def.shadowSince);
  const tN = tagged.length >= def.minTagged ? tsOf(tagged[def.minTagged - 1]) : Infinity;
  const tT = def.minDays != null && Number.isFinite(since) ? since + def.minDays * DAY_MS : Infinity;
  const at = Math.min(tN, tT);
  if (!Number.isFinite(at)) return null;
  const upTo = carryingSorted.filter((r) => tsOf(r) <= at);
  const c = checksFn(upTo.filter(isTagged), upTo.filter(isRest));
  return {
    at: new Date(at).toISOString(),
    reached_by: at === tN ? "n" : "time",
    n_tagged: upTo.filter(isTagged).length,
    n_rest: upTo.filter(isRest).length,
    checks: c.checks.map(({ name, value, pass }) => ({ name, value, pass })),
    all_pass: c.checks.every((k) => k.pass === true),
  };
}

function gradeDisasterRatioGate(def, records, { now }) {
  const carrying = records.filter((r) => hasField(r, def.tagField) && isBotDeploy(r)).sort(byTime);
  const isTagged = (r) => r[def.tagField] === true;
  const isRest = (r) => r[def.tagField] === false;
  const tagged = carrying.filter(isTagged), rest = carrying.filter(isRest);
  const { stats, checks } = disasterRatioChecks(tagged, rest);
  const th = thresholdState(def, tagged.length, now);
  const allPass = checks.every((c) => c.pass === true);
  const removed = largestAbsNet(tagged);
  const robustChecks = disasterRatioChecks(tagged.filter((r) => r !== removed), rest).checks;
  const adoptedCarrying = records.filter((r) => hasField(r, def.tagField) && r.adopted);
  const metrics = {
    ...stats,
    tagged_null_verdict: carrying.filter((r) => r[def.tagField] === null).length,
    adopted_carrying: adoptedCarrying.length,
    adopted_tagged: adoptedCarrying.filter(isTagged).length,
    ci90_tagged_net_sol: bootstrapSumCI(tagged.map(netSol).filter((v) => v != null)),
    ci90_disaster_ratio: bootstrapRatioCI(tagged.map((r) => (isDisaster(r) ? 1 : 0)), rest.map((r) => (isDisaster(r) ? 1 : 0))),
    largest_tagged: recordRef(removed),
    decision_point: th.reached ? decisionPointView(def, carrying, isTagged, isRest, disasterRatioChecks) : null,
  };
  return {
    sample: sampleInfo(def, carrying, tagged, rest, now),
    metrics,
    checks,
    robust: { removed: recordRef(removed), checks: robustChecks.map(({ name, value, pass }) => ({ name, value, pass })), all_pass: robustChecks.every((c) => c.pass === true) },
    threshold: th,
    allPass,
  };
}

// ── First-entry probation ────────────────────────────────────────────────────────────────────

/**
 * "finished at net worse than −8 % on their capital" = Σ pnl_sol_net ÷ Σ amount_sol × 100 < −8
 * over the would-fire positions (capital-weighted). "at most 1 in 4 winners" = winners / n ≤ 0.25.
 */
export function probationChecks(fires, def) {
  const n = fires.length;
  const net = sum(fires, netSol);
  const cap = sum(fires, (r) => num(r.amount_sol));
  const pctOnCap = cap > 0 ? (100 * net) / cap : null;
  const winners = fires.filter(isWinner).length;
  const share = n ? winners / n : null;
  const meanPct = n ? sum(fires, (r) => num(r.pnl_pct)) / n : null;
  return {
    stats: { n, net_sol: r6(net), capital_sol: r6(cap), net_pct_on_capital: r4(pctOnCap), mean_pnl_pct: r4(meanPct), winners, winner_share: r4(share) },
    checks: [
      {
        name: `would-fire positions' Σ net ÷ Σ capital < ${def.netOnCapitalBelowPct} %`,
        value: r4(pctOnCap),
        need: `< ${def.netOnCapitalBelowPct}`,
        pass: pctOnCap != null && pctOnCap < def.netOnCapitalBelowPct,
        detail: `${fmtSol(net)} on ◎${cap.toFixed(4)} = ${fmtPct(pctOnCap, 2)} (unweighted mean pnl_pct ${fmtPct(meanPct, 2)})`,
      },
      {
        name: "at most 1 in 4 would-fire positions were winners",
        value: r4(share),
        need: `≤ ${def.maxWinnerShare}`,
        pass: share != null && share <= def.maxWinnerShare,
        detail: `${winners}/${n} winners`,
      },
    ],
  };
}

function gradeFirstEntryProbation(def, records, { now }) {
  const carrying = records.filter((r) => hasField(r, def.tagField) && isBotDeploy(r)).sort(byTime);
  const isTagged = (r) => r.first_entry_probation != null && typeof r.first_entry_probation === "object";
  const isRest = (r) => r.first_entry === true && !isTagged(r);
  const fires = carrying.filter(isTagged), rest = carrying.filter(isRest);
  const { stats, checks } = probationChecks(fires, def);
  const th = thresholdState(def, fires.length, now);
  const allPass = checks.every((c) => c.pass === true);
  const removed = largestAbsNet(fires);
  const rob = probationChecks(fires.filter((r) => r !== removed), def).checks;
  const restStats = groupStats(rest);
  const dr = disasterRatioChecks(fires, rest).stats;
  const metrics = {
    would_fire: stats,
    would_fire_records: fires.map((r) => ({ ...recordRef(r), amount_sol: num(r.amount_sol), exit_family: r.exit_family ?? null, fire_pnl_pct: num(r.first_entry_probation?.pnl_pct), fire_min: num(r.first_entry_probation?.minutes_since_deploy) })),
    first_entries_without_fire: restStats,
    not_first_entry: carrying.filter((r) => r.first_entry === false).length,
    first_entry_unknown: carrying.filter((r) => r.first_entry == null).length,
    disaster_ratio_vs_other_first_entries: dr.disaster_ratio,
    ci90_tagged_net_sol: bootstrapSumCI(fires.map(netSol).filter((v) => v != null)),
    ci90_disaster_ratio: bootstrapRatioCI(fires.map((r) => (isDisaster(r) ? 1 : 0)), rest.map((r) => (isDisaster(r) ? 1 : 0))),
    largest_tagged: recordRef(removed),
    decision_point: th.reached ? decisionPointView(def, carrying, isTagged, isRest, (t) => probationChecks(t, def)) : null,
  };
  return {
    sample: sampleInfo(def, carrying, fires, rest, now),
    metrics,
    checks,
    robust: { removed: recordRef(removed), checks: rob.map(({ name, value, pass }) => ({ name, value, pass })), all_pass: rob.every((c) => c.pass === true) },
    threshold: th,
    allPass,
  };
}

// ── Max hold ─────────────────────────────────────────────────────────────────────────────────

/** The pre-registered checks on one max-hold.js summary row (all records, not the evolver's 60-window). */
export function maxHoldChecks(row) {
  const ok = row && row.n > 0;
  const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  return [
    { name: "Σ Δ◎ > 0", value: ok ? row.sum : null, need: "> 0", pass: ok && row.sum > 0 },
    { name: "Σ Δ◎ without the largest |Δ| > 0", value: ok ? row.sum_wo_largest : null, need: "> 0", pass: ok && row.sum_wo_largest > 0 },
    { name: "better ≥ worse", value: ok ? `${row.better}/${row.worse}` : null, need: "better ≥ worse", pass: ok && row.better >= row.worse, detail: `|Δ| ≤ ◎${MAX_HOLD_EVOLVE.tieSol} is a tie` },
    { name: "worst truncation ≤ ½ Σ", value: ok ? row.worst : null, need: ok ? `≥ −${r6(0.5 * row.sum)}` : "≤ ½ Σ", pass: ok && !(row.worst != null && row.worst < 0 && -row.worst > 0.5 * row.sum) },
    { name: "same sign in both halves", value: ok ? `${r6(row.half1)} / ${r6(row.half2)}` : null, need: "same sign, non-zero", pass: ok && sgn(row.half1) !== 0 && sgn(row.half1) === sgn(row.half2) },
  ];
}

function gradeMaxHold(def, records, { now, cfg }) {
  const mh = maxHoldConfig(cfg || {});
  const cap = mh.minutes;
  const cfRecs = maxHoldCfRecords(records);
  const all = summarizeMaxHoldCf(records, { window: Infinity });
  const row = all.rows.find((x) => x.T === cap) || null;
  const deltaOf = (r) => num(r.max_hold_cf?.grid?.[String(cap)]?.delta_sol);
  const affected = cfRecs.filter((r) => r.max_hold_cf.grid[String(cap)]?.affected === true && deltaOf(r) != null);
  const rest = cfRecs.filter((r) => !affected.includes(r));
  const checks = maxHoldChecks(row);
  const th = thresholdState(def, affected.length, now);
  const allPass = checks.every((c) => c.pass === true);
  // robust: drop the record with the largest |Δ| at the cap (the quantity graded) and re-run
  let removed = null;
  for (const r of affected) if (!removed || Math.abs(deltaOf(r)) > Math.abs(deltaOf(removed))) removed = r;
  const robRow = removed ? summarizeMaxHoldCf(records.filter((r) => r !== removed), { window: Infinity }).rows.find((x) => x.T === cap) : null;
  const rob = maxHoldChecks(robRow);
  const shadowFires = records.filter((r) => isBotDeploy(r) && r.max_hold_shadow && typeof r.max_hold_shadow === "object");
  const lastBot = records.filter(isBotDeploy).map(tsOf).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const metrics = {
    cap_min: cap,
    row_at_cap: row,
    grid: all.rows,
    records_with_cf: cfRecs.length,
    cf_from: all.from,
    cf_to: all.to,
    cf_computed_last: cfRecs.map((r) => r.max_hold_cf.computed_at).filter(Boolean).sort().pop() ?? null,
    last_bot_close: Number.isFinite(lastBot) ? new Date(lastBot).toISOString() : null,
    max_hold_shadow_would_fires: shadowFires.length,
    max_hold_shadow_with_cf: shadowFires.filter((r) => r.max_hold_cf?.grid).length,
    ci90_sum_delta_sol: bootstrapSumCI(affected.map(deltaOf)),
    ci90_disaster_ratio: null,
    largest_delta: removed ? { ...recordRef(removed), delta_sol: deltaOf(removed) } : null,
    decision_point: null,
  };
  return {
    sample: sampleInfo(def, cfRecs, affected, rest, now),
    metrics,
    checks,
    robust: { removed: removed ? { ...recordRef(removed), delta_sol: deltaOf(removed) } : null, removed_by: "largest |Δ◎| at the cap", checks: rob.map(({ name, value, pass }) => ({ name, value, pass })), all_pass: rob.every((c) => c.pass === true) },
    threshold: th,
    allPass,
  };
}

// ── Straddle trailing trigger ────────────────────────────────────────────────────────────────

function gradeTrailStraddle(def, records, { now, cfg }) {
  const stop = fin(cfg?.stopLossPct) ? Number(cfg.stopLossPct) : -15;
  const carrying = records.filter((r) => hasField(r, def.tagField) && isBotDeploy(r)).sort(byTime);
  const cases = carrying.filter((r) => r.trail_straddle_shadow && typeof r.trail_straddle_shadow === "object" && r.trail_straddle_shadow.verdict);
  const hold = cases.filter((r) => r.trail_straddle_shadow.verdict === "would_hold");
  const same = cases.filter((r) => r.trail_straddle_shadow.verdict === "same");
  const probed = hold.filter((r) => fin(r.post_close?.m60?.pct));
  const positive = probed.filter((r) => Number(r.post_close.m60.pct) > 0);
  const share = probed.length ? positive.length / probed.length : null;
  const tailPp = hold.map((r) => {
    const fire = num(r.trail_straddle_shadow.live_fire_pct) ?? num(r.pnl_pct);
    return fire == null ? null : fire - stop;
  });
  const tailSol = hold.map((r, i) => (tailPp[i] == null || !fin(r.amount_sol) ? null : (tailPp[i] / 100) * Number(r.amount_sol)));
  const sumTailPp = tailPp.reduce((s, v) => s + (v ?? 0), 0);
  const sumTailSol = tailSol.reduce((s, v) => s + (v ?? 0), 0);
  const checks = [
    {
      name: "would_hold cases' +60 min probe positive in ≥ 2/3",
      value: r4(share),
      need: "≥ 0.6667",
      pass: share != null && share >= def.probeShare,
      detail: `${positive.length}/${probed.length} probed would_hold cases (of ${hold.length}) — the probe is the pool mcap change 60 min after the close, not position pnl`,
    },
    {
      name: "Σ tail risk (live fire pnl − stop) < the gain",
      value: r4(sumTailPp),
      need: "< the gain (not computable from the records)",
      pass: null,
      detail: `Σ (fire − (${stop})) = ${sumTailPp.toFixed(2)} pp ≈ ${fmtSol(sumTailSol)} over ${hold.length} would_hold cases; the gain of holding past the live fire is not recorded`,
    },
  ];
  const th = thresholdState(def, cases.length, now);
  const removed = largestAbsNet(hold);
  const metrics = {
    stop_loss_pct: stop,
    straddled_trailing_closes: cases.length,
    would_hold: hold.length,
    same: same.length,
    would_hold_records: hold.map((r) => ({ ...recordRef(r), live_peak_pct: num(r.trail_straddle_shadow.live_peak_pct), live_fire_pct: num(r.trail_straddle_shadow.live_fire_pct), m60_pct: num(r.post_close?.m60?.pct), m180_pct: num(r.post_close?.m180?.pct) })),
    would_hold_net_sol: r6(sum(hold, netSol)),
    same_net_sol: r6(sum(same, netSol)),
    tail_risk_pp: r4(sumTailPp),
    tail_risk_sol: r6(sumTailSol),
    ci90_tagged_net_sol: bootstrapSumCI(hold.map(netSol).filter((v) => v != null)),
    ci90_disaster_ratio: null,
    largest_tagged: recordRef(removed),
    decision_point: null,
  };
  return {
    sample: sampleInfo(def, carrying, cases, carrying.filter((r) => !cases.includes(r)), now),
    metrics,
    checks,
    robust: { removed: recordRef(removed), checks: [], all_pass: null, note: "not applicable: the rule's second check cannot be computed" },
    threshold: th,
    allPass: false,
    forceInsufficient: th.reached ? "the rule's 'gain' (what holding past the live trailing fire would have earned) is not in the records — post_close probes are pool mcap moves, not position pnl" : null,
  };
}

// ── Grace profit lock ────────────────────────────────────────────────────────────────────────

/**
 * Δ◎ of one forward fire = (fire_pnl_pct − the record's pnl_pct) / 100 × amount_sol, minus
 * `costPct` % of amount_sol (the cost-robust check). Gross on both sides: both exits pay an exit
 * swap. null when a figure is missing.
 */
export function graceLockDelta(r, { costPct = 0 } = {}) {
  const fire = num(r?.grace_lock_shadow?.fire_pnl_pct), pnl = num(r?.pnl_pct), amt = num(r?.amount_sol);
  if (fire == null || pnl == null || amt == null) return null;
  return ((fire - pnl) / 100) * amt - (costPct / 100) * amt;
}

/** A gradable forward fire: fired, not interrupted by a hold. */
export const isGraceLockFire = (r) => {
  const g = r?.grace_lock_shadow;
  return !!g && typeof g === "object" && g.fired_at != null && !g.interrupted;
};

/** The pre-registered checks 2–7 over the fires (sorted by close time). Check 1 is the threshold. */
export function graceLockChecks(fires, def) {
  const tie = def.tieSol ?? 0.0005;
  const d = fires.map((r) => graceLockDelta(r));
  const n = d.length;
  const total = d.reduce((a, x) => a + x, 0);
  const largest = n ? Math.max(...d) : null;
  const woLargest = n ? total - largest : null;
  const better = d.filter((x) => x > tie).length, worse = d.filter((x) => x < -tie).length;
  const worst = n ? Math.min(0, ...d) : null;
  const h = Math.floor(n / 2);
  const half1 = d.slice(0, h).reduce((a, x) => a + x, 0), half2 = d.slice(h).reduce((a, x) => a + x, 0);
  const costed = fires.reduce((a, r) => a + graceLockDelta(r, { costPct: def.costPctOfCapital ?? 1 }), 0);
  const ratio = def.betterWorseRatio ?? 1.5;
  return {
    stats: { n, sum_delta_sol: r6(total), largest_delta_sol: r6(largest), sum_wo_largest_sol: r6(woLargest), better, worse, ties: n - better - worse, worst_delta_sol: r6(worst), half1_sol: r6(half1), half2_sol: r6(half2), sum_costed_sol: r6(costed) },
    checks: [
      { name: "Σ Δ◎ > 0", value: r6(total), need: "> 0", pass: n > 0 && total > 0 },
      { name: "Σ Δ◎ > 0 without the largest Δ", value: r6(woLargest), need: "> 0", pass: n > 0 && woLargest > 0, detail: `largest Δ ${fmtSol(largest)}` },
      { name: `better ≥ ${ratio} × worse`, value: `${better}/${worse}`, need: `better ≥ ${ratio} × worse`, pass: n > 0 && better >= ratio * worse, detail: `|Δ| ≤ ◎${tie} is a tie (${n - better - worse})` },
      { name: "worst truncation ≤ ½ Σ Δ◎", value: r6(worst), need: n ? `≥ −${r6(0.5 * total)}` : "≤ ½ Σ", pass: n > 0 && !(worst < 0 && -worst > 0.5 * total) },
      { name: "both halves by close time Σ Δ◎ > 0", value: `${r6(half1)} / ${r6(half2)}`, need: "> 0 / > 0", pass: n > 1 && half1 > 0 && half2 > 0 },
      { name: `Σ Δ◎ > 0 with ${def.costPctOfCapital ?? 1} % of amount_sol charged per fire`, value: r6(costed), need: "> 0", pass: n > 0 && costed > 0 },
    ],
  };
}

function gradeGraceLock(def, records, { now }) {
  const since = Date.parse(def.shadowSince);
  const carrying = records
    .filter((r) => inPopulation(def, r) && r.grace_lock_shadow && typeof r.grace_lock_shadow === "object" && !(tsOf(r) < since))
    .sort(byTime);
  const fired = carrying.filter(isGraceLockFire);
  const fires = fired.filter((r) => graceLockDelta(r) != null);
  const rest = carrying.filter((r) => !isGraceLockFire(r));
  const { stats, checks } = graceLockChecks(fires, def);
  const th = thresholdState(def, fires.length, now);
  const allPass = checks.every((c) => c.pass === true);
  let removed = null;
  for (const r of fires) if (!removed || graceLockDelta(r) > graceLockDelta(removed)) removed = r;
  const rob = graceLockChecks(fires.filter((r) => r !== removed), def).checks;
  const groupBy = (keyFn) => {
    const out = {};
    for (const r of fires) {
      const g = (out[keyFn(r)] ||= { n: 0, sum_delta_sol: 0, better: 0, worse: 0 });
      const d = graceLockDelta(r);
      g.n++; g.sum_delta_sol += d;
      if (d > (def.tieSol ?? 0.0005)) g.better++; else if (d < -(def.tieSol ?? 0.0005)) g.worse++;
    }
    for (const g of Object.values(out)) g.sum_delta_sol = r6(g.sum_delta_sol);
    return out;
  };
  const ref = (r) => ({ ...recordRef(r), owner: ownerOf(r), kind: r.grace_lock_shadow.kind ?? null, amount_sol: num(r.amount_sol), peak_pct: num(r.grace_lock_shadow.fire_peak_pct), fire_pnl_pct: num(r.grace_lock_shadow.fire_pnl_pct), minutes_into_grace: num(r.grace_lock_shadow.minutes_into_grace), delta_sol: r6(graceLockDelta(r)) });
  const metrics = {
    fires: stats,
    fire_records: fires.map(ref),
    by_owner: groupBy(ownerOf),
    by_kind: groupBy((r) => r.grace_lock_shadow.kind || "?"),
    fired_without_figures: fired.length - fires.length,
    interrupted_by_hold: carrying.filter((r) => r.grace_lock_shadow.interrupted).length,
    armed_not_fired: rest.filter((r) => r.grace_lock_shadow.armed_at && !r.grace_lock_shadow.interrupted).length,
    graces_without_fire: rest.length,
    ci90_sum_delta_sol: bootstrapSumCI(fires.map((r) => graceLockDelta(r))),
    ci90_disaster_ratio: null,
    largest_delta: removed ? ref(removed) : null,
    decision_point: null,
  };
  return {
    sample: sampleInfo(def, carrying, fires, rest, now),
    metrics,
    checks,
    robust: { removed: removed ? ref(removed) : null, removed_by: "largest Δ◎", checks: rob.map(({ name, value, pass }) => ({ name, value, pass })), all_pass: rob.every((c) => c.pass === true) },
    threshold: th,
    allPass,
  };
}

// ── Reading guard (episodes pooled across records; registered 2026-11-25) ─────────────────────

const RG_ENDS = ["reverted", "capital_rebase", "persisted", "closed", "hold", "unresolved"];

/** Episode counts of one record's reading_guard_shadow: the stored totals, else a recount of the kept episodes. */
export function readingGuardCounts(g, def = {}) {
  const out = { episodes: 0, trusted: 0, trusted_effect: 0, persisted_stop_class: 0 };
  for (const k of RG_ENDS) out[k] = 0;
  if (!g || typeof g !== "object") return out;
  if (g.counts && typeof g.counts === "object") {
    out.episodes = num(g.episodes) ?? 0;
    for (const k of Object.keys(out)) if (k !== "episodes") out[k] = num(g.counts[k]) ?? 0;
    return out;
  }
  const stop = def.stopFamilies || [];
  for (const ep of Array.isArray(g.recent) ? g.recent : []) {
    out.episodes++;
    if (RG_ENDS.includes(ep?.ended)) out[ep.ended]++;
    if (!ep?.already_suspect) { out.trusted++; if (ep?.peak_confirmed || ep?.exit_signal) out.trusted_effect++; }
    if (ep?.ended === "persisted" && (stop.includes(ep.exit_signal_family) || stop.includes(ep.exit_fired_family))) out.persisted_stop_class++;
  }
  return out;
}

function gradeReadingGuard(def, records, { now }) {
  const since = Date.parse(def.shadowSince);
  const carrying = records
    .filter((r) => inPopulation(def, r) && r.reading_guard_shadow && typeof r.reading_guard_shadow === "object" && !(tsOf(r) < since))
    .sort(byTime);
  const per = carrying.map((r) => ({ r, c: readingGuardCounts(r.reading_guard_shadow, def) }));
  const withEp = per.filter((x) => x.c.episodes > 0);
  const tot = (k, rows = per) => rows.reduce((s, x) => s + (x.c[k] || 0), 0);
  const episodes = tot("episodes"), positions = withEp.length;
  const explained = tot("reverted") + tot("capital_rebase");
  const share = episodes ? explained / episodes : null;
  const checks = [
    { name: `≥ ${100 * def.minExplainedShare} % of episodes ended reverted or capital_rebase`, value: r4(share), need: `≥ ${def.minExplainedShare}`, pass: episodes > 0 && share >= def.minExplainedShare, detail: `${explained}/${episodes}` },
    { name: "no persisted episode with a stop-class exit signal / fire on a flagged reading", value: tot("persisted_stop_class"), need: "0", pass: tot("persisted_stop_class") === 0 },
    { name: `≥ ${def.minTrustedEffect} episodes not already suspect with a peak confirmed or an exit signal`, value: tot("trusted_effect"), need: `≥ ${def.minTrustedEffect}`, pass: tot("trusted_effect") >= def.minTrustedEffect },
  ];
  const days = Number.isFinite(since) ? (now - since) / DAY_MS : null;
  const atN = episodes >= def.minTagged && positions >= def.minPositions;
  const atTime = days != null && days >= def.minDays;
  const threshold = {
    reached: atN || atTime,
    by: atN && atTime ? "n_and_time" : atN ? "n" : atTime ? "time" : null,
    need: `${def.minTagged} ep/${def.minPositions} pos or ${def.minDays} days`,
    missing: atN || atTime ? null : `${Math.max(0, def.minTagged - episodes)} more episodes / ${Math.max(0, def.minPositions - positions)} more positions or until ${new Date(since + def.minDays * DAY_MS).toISOString().slice(0, 10)}`,
  };
  const byOwner = {};
  for (const x of withEp) {
    const o = (byOwner[ownerOf(x.r)] ||= { positions: 0, episodes: 0, trusted_effect: 0 });
    o.positions++; o.episodes += x.c.episodes; o.trusted_effect += x.c.trusted_effect;
  }
  const sample = sampleInfo(def, carrying, withEp, per.filter((x) => x.c.episodes === 0), now);
  return {
    sample: { ...sample, n_tagged: episodes, n_positions: positions },
    metrics: {
      episodes, positions,
      by_end: Object.fromEntries(RG_ENDS.map((k) => [k, tot(k)])),
      trusted: tot("trusted"), already_suspect: episodes - tot("trusted"),
      trusted_effect: tot("trusted_effect"), persisted_stop_class: tot("persisted_stop_class"),
      by_owner: byOwner,
      decision_point: null,
    },
    checks,
    threshold,
    allPass: checks.every((c) => c.pass === true),
    // The rule's drop clause: at the threshold with check 2 under 50 %, or check 4 failing.
    forceDrop: threshold.reached && ((share ?? 0) < def.dropExplainedShareBelow || checks[2].pass !== true),
  };
}

// ── Relative TVL exit vs the fixed TVL exit (registered 2026-11-27) ──────────────────────────
//
// Population: records carrying tvl_floor_shadow_compare (bot + operator). "old ready" = the live
// rule's proof completed and its on-chain check agreed; "new fired" = the shadow's first
// would-fire. A disagreement = exactly one of the two. Check 1 needs the PnL 60 min after
// old-ready: from the record when it closed within 60 min (its close pnl_pct), else from
// price_ticks — graded by hand; the grader reports how many cases need ticks and holds the
// verdict at `insufficient` while any do.

const tvlCmp = (r) => (r?.tvl_floor_shadow_compare && typeof r.tvl_floor_shadow_compare === "object" ? r.tvl_floor_shadow_compare : null);
const tvlOldReady = (r) => !!tvlCmp(r)?.old_first_ready_at;
const tvlNewFired = (r) => !!tvlCmp(r)?.new_would_fire_at;
const tvlOldClosed = (r) => tvlCmp(r)?.old_closed === true || exitFamilyOf(r) === "tvl_floor";

export function tvlRelativeChecks(rows, def) {
  const H = 60 * 60_000;
  // Check 1: old ready, new never fired, old did not close it (closed → "new unknown", excluded).
  const c1 = rows.filter((r) => tvlOldReady(r) && !tvlNewFired(r));
  const c1Excluded = c1.filter(tvlOldClosed);
  const c1Cases = c1.filter((r) => !tvlOldClosed(r));
  const resolved = [], needTicks = [];
  for (const r of c1Cases) {
    const at = Date.parse(tvlCmp(r).old_first_ready_at), old = num(tvlCmp(r).old_first_ready_pnl_pct);
    if (old != null && fin(r.pnl_pct) && Number.isFinite(at) && tsOf(r) - at <= H) resolved.push({ r, d: Number(r.pnl_pct) - old });
    else needTicks.push(r);
  }
  const atOrAbove = resolved.filter((x) => x.d >= 0).length;
  const sumD = resolved.reduce((s, x) => s + x.d, 0);
  // Gradeable = a 60-min-later PnL exists: from the record (resolved) or, by hand, from price_ticks.
  const gradeable = resolved.length + needTicks.length;
  const c1Pass = gradeable < def.minCheck1Cases ? null : needTicks.length ? null : atOrAbove / resolved.length >= def.minHoldShare && sumD >= 0;
  // Check 2: every position that ended ≤ −30 % with the old rule ready.
  const deep = rows.filter((r) => tvlOldReady(r) && fin(r.pnl_pct) && Number(r.pnl_pct) <= def.collapsePct);
  const c2 = { caught: 0, closed_other: 0, failed: [], unknown: [] };
  for (const r of deep) {
    const c = tvlCmp(r), old = num(c.old_first_ready_pnl_pct), nw = num(c.new_would_fire_pnl_pct);
    if (tvlNewFired(r)) {
      if (old != null && nw != null && nw >= old - def.maxWorsePp) c2.caught++;
      else c2.failed.push(recordRef(r));
    } else if (tvlOldClosed(r)) c2.unknown.push(recordRef(r)); // the old rule closed it: the new one could not be observed after
    else {
      // "closed earlier by another rule": closed by something other than the fixed TVL exit within
      // 60 min of old-ready, or at a PnL no more than 10 pp under the old-ready PnL. Otherwise the
      // new rule missed a collapse the old one would have cut → fail.
      const at = Date.parse(c.old_first_ready_at);
      const soon = Number.isFinite(at) && tsOf(r) - at <= H;
      const bounded = old != null && Number(r.pnl_pct) >= old - def.maxWorsePp;
      if (soon || bounded) c2.closed_other++;
      else c2.failed.push(recordRef(r));
    }
  }
  const c2Pass = c2.failed.length ? false : c2.unknown.length ? null : true; // no cases → true ("no cases", reported)
  // Check 3: the new rule fired on at most 1 position that ended > 10 pp above its would-fire PnL.
  const recovered = rows.filter((r) => tvlNewFired(r) && fin(r.pnl_pct) && num(tvlCmp(r).new_would_fire_pnl_pct) != null && Number(r.pnl_pct) - Number(tvlCmp(r).new_would_fire_pnl_pct) > def.maxWorsePp);
  return {
    checks: [
      {
        name: `old ready & new never fired: PnL 60 min after old-ready ≥ old-ready PnL in ≥ ${100 * def.minHoldShare} % AND Σ diff ≥ 0`,
        value: resolved.length ? r4(atOrAbove / resolved.length) : null,
        need: `≥ ${def.minHoldShare} and Σ ≥ 0 (graded by hand from price_ticks where the record cannot answer)`,
        pass: c1Pass,
        detail: `${c1Cases.length} cases (${c1Excluded.length} more closed by the old rule → excluded): ${resolved.length} answered by the close PnL (closed ≤ 60 min after old-ready; ${atOrAbove} at/above, Σ ${sumD.toFixed(2)} pp), ${needTicks.length} need price_ticks; ${gradeable} gradeable, minimum ${def.minCheck1Cases}`,
      },
      {
        name: `every position ended ≤ ${def.collapsePct} % with the old rule ready was caught by the new rule (≤ ${def.maxWorsePp} pp worse) or closed by something else first`,
        value: c2.failed.length,
        need: "0 failed (and 0 unknown, else graded by hand)",
        pass: c2Pass,
        detail: deep.length
          ? `${deep.length} such positions: ${c2.caught} caught, ${c2.closed_other} closed otherwise in time (≤ 60 min after old-ready or ≤ ${def.maxWorsePp} pp under it), ${c2.failed.length} failed, ${c2.unknown.length} unknown (closed by the old rule before the new one fired)`
          : "no cases: no position ended ≤ " + def.collapsePct + " % with the old rule ready — passes, but checks nothing",
        no_cases: deep.length === 0,
      },
      {
        name: `new rule fired on ≤ ${def.maxRecoveredFires} position that ended > ${def.maxWorsePp} pp above its would-fire PnL`,
        value: recovered.length,
        need: `≤ ${def.maxRecoveredFires}`,
        pass: recovered.length <= def.maxRecoveredFires,
        detail: recovered.map((r) => `${r.pool_name || r.position}: ${Number(tvlCmp(r).new_would_fire_pnl_pct).toFixed(2)} → ${Number(r.pnl_pct).toFixed(2)} %`).join("; ") || "none",
      },
    ],
    stats: { c1_cases: c1Cases.length, c1_excluded_old_closed: c1Excluded.length, c1_resolved: resolved.length, c1_gradeable: gradeable, c1_need_ticks: needTicks.map(recordRef), c2, c2_no_cases: deep.length === 0, c3_recovered: recovered.map(recordRef) },
  };
}

function gradeTvlRelative(def, records, { now }) {
  const since = Date.parse(def.shadowSince);
  const carrying = records.filter((r) => inPopulation(def, r) && tvlCmp(r) && !(tsOf(r) < since)).sort(byTime);
  const disagree = carrying.filter((r) => tvlOldReady(r) !== tvlNewFired(r));
  const { checks, stats } = tvlRelativeChecks(carrying, def);
  const days = Number.isFinite(since) ? (now - since) / DAY_MS : null;
  const atN = days != null && days >= def.minDays && disagree.length >= def.minTagged;
  const atMax = days != null && days >= def.maxDays;
  const threshold = {
    reached: atN || atMax,
    by: atN ? "n_and_time" : atMax ? "time" : null,
    need: `${def.minDays} days AND ${def.minTagged} disagreements, or ${def.maxDays} days`,
    missing: atN || atMax ? null
      : `${Math.max(0, def.minTagged - disagree.length)} more disagreements and ${new Date(since + def.minDays * DAY_MS).toISOString().slice(0, 10)}, or until ${new Date(since + def.maxDays * DAY_MS).toISOString().slice(0, 10)}`,
  };
  const tooFew = stats.c1_gradeable < def.minCheck1Cases;
  const hand = checks.filter((c) => c.pass === null).map((c) => c.name);
  return {
    sample: { ...sampleInfo(def, carrying, disagree, carrying.filter((r) => !disagree.includes(r)), now), n_tagged: disagree.length },
    metrics: {
      disagreements: disagree.length,
      old_ready_new_not: carrying.filter((r) => tvlOldReady(r) && !tvlNewFired(r)).length,
      new_fired_old_not: carrying.filter((r) => tvlNewFired(r) && !tvlOldReady(r)).length,
      both: carrying.filter((r) => tvlOldReady(r) && tvlNewFired(r)).length,
      old_closed: carrying.filter((r) => tvlOldReady(r) && tvlOldClosed(r)).length,
      by_owner: Object.fromEntries(["bot", "operator"].map((o) => [o, disagree.filter((r) => ownerOf(r) === o).length])),
      ...stats,
      // At the 90-day arm with too few check-1 cases the experiment closes as insufficient — never met.
      closed_insufficient: atMax && tooFew,
      decision_point: null,
    },
    checks,
    threshold,
    allPass: !tooFew && checks.every((c) => c.pass === true),
    forceInsufficient: !threshold.reached ? null
      : tooFew ? `fewer than ${def.minCheck1Cases} gradeable check-1 cases (${stats.c1_gradeable})${atMax ? " at the 90-day arm — closed as insufficient, never met" : ""}`
      : hand.length ? `graded by hand from price_ticks: ${hand.join("; ")}` : null,
  };
}

// ── Flow guard shadow (default thresholds on non-armed positions; registered 2026-11-27) ──────

/** amount_sol the would-fire is valued on: captured at the fire, else the record's capital. */
const flowCapital = (r) => num(r?.flow_guard_shadow?.amount_sol_at_fire) ?? num(r?.amount_sol);

/** Δ◎ = final pnl_sol_net − the SOL value of pnl_pct_at_fire on the capital (negative = the close would have saved SOL). */
export function flowGuardDelta(r) {
  const g = r?.flow_guard_shadow;
  const atFire = num(g?.pnl_pct_at_fire), cap = flowCapital(r), net = netSol(r);
  if (atFire == null || cap == null || net == null) return null;
  return net - (atFire / 100) * cap;
}
export const isFlowGuardWouldFire = (r) => !!r?.flow_guard_shadow && typeof r.flow_guard_shadow === "object" && r.flow_guard_shadow.first_would_fire_at != null;

/** The registered checks (a) and (b) over the gradeable would-fires. */
export function flowGuardChecks(fires, def) {
  const n = fires.length;
  const lower = fires.filter((r) => num(r.pnl_pct) != null && Number(r.pnl_pct) < Number(r.flow_guard_shadow.pnl_pct_at_fire)).length;
  const share = n ? lower / n : null;
  const total = fires.reduce((s, r) => s + flowGuardDelta(r), 0);
  const need = def.minLowerShare ?? 2 / 3;
  return {
    stats: { n, closed_lower: lower, share_lower: r4(share), sum_delta_sol: r6(total) },
    checks: [
      { name: "(a) ≥ 2/3 of would-fire positions closed at a PnL lower than pnl_pct_at_fire", value: r4(share), need: `≥ ${r4(need)}`, pass: n > 0 && share >= need, detail: `${lower}/${n}` },
      { name: "(b) Σ (pnl_sol_net − pnl_pct_at_fire × capital) < 0", value: r6(total), need: "< 0", pass: n > 0 && total < 0 },
    ],
  };
}

function gradeFlowGuard(def, records, { now }) {
  const since = Date.parse(def.shadowSince);
  const carrying = records.filter((r) => inPopulation(def, r) && isFlowGuardWouldFire(r) && !(tsOf(r) < since)).sort(byTime);
  const fires = carrying.filter((r) => flowGuardDelta(r) != null);
  const { stats, checks: ab } = flowGuardChecks(fires, def);
  // (c) (a) and (b) without the single largest contributor (the most negative Δ — the record that
  // carries (b) most).
  let removed = null;
  for (const r of fires) if (!removed || flowGuardDelta(r) < flowGuardDelta(removed)) removed = r;
  const rob = flowGuardChecks(fires.filter((r) => r !== removed), def).checks;
  const checks = [
    ...ab,
    { name: "(c) (a) and (b) still hold without the single largest contributor", value: rob.map((c) => c.value).join(" / "), need: "both pass", pass: fires.length > 1 && rob.every((c) => c.pass === true), detail: removed ? `without ${removed.pool_name ?? removed.position} Δ ${fmtSol(flowGuardDelta(removed))}` : null },
  ];
  const th = thresholdState(def, fires.length, now);
  const days = Number.isFinite(since) ? (now - since) / DAY_MS : null;
  const ref = (r) => ({ ...recordRef(r), owner: ownerOf(r), condition: r.flow_guard_shadow.condition ?? null, pnl_pct_at_fire: num(r.flow_guard_shadow.pnl_pct_at_fire), amount_sol: flowCapital(r), delta_sol: r6(flowGuardDelta(r)) });
  return {
    sample: sampleInfo(def, carrying, fires, [], now),
    metrics: {
      fires: stats,
      fire_records: fires.map(ref),
      would_fires_without_figures: carrying.length - fires.length,
      by_condition: fires.reduce((o, r) => { const k = r.flow_guard_shadow.condition || "?"; o[k] = (o[k] || 0) + 1; return o; }, {}),
      ci90_sum_delta_sol: bootstrapSumCI(fires.map((r) => flowGuardDelta(r))),
      largest_contributor: removed ? ref(removed) : null,
      decision_point: null,
    },
    checks,
    robust: { removed: removed ? ref(removed) : null, removed_by: "most negative Δ◎", checks: rob.map(({ name, value, pass }) => ({ name, value, pass })), all_pass: rob.every((c) => c.pass === true) },
    threshold: th,
    allPass: checks.every((c) => c.pass === true),
    // 90 days without 15 would-fires → closed insufficient (the rule's own clause).
    forceInsufficient: !th.reached && days != null && def.closeAfterDays != null && days >= def.closeAfterDays
      ? `closed insufficient: ${def.closeAfterDays} days since ${def.shadowSince} with ${fires.length}/${def.minTagged} would-fires`
      : null,
  };
}

// ── Report-only graders ──────────────────────────────────────────────────────────────────────

function reportGraceShadow(def, records) {
  const rows = records.filter((r) => r.grace_shadow && typeof r.grace_shadow === "object");
  const kinds = {};
  for (const r of rows) {
    const g = r.grace_shadow;
    const k = (kinds[g.kind || "?"] ||= { n: 0, bot: 0, adopted: 0, with_fire: 0, sum_pnl_minus_fire_pp: 0, sum_pnl_minus_fire_sol: 0, end_above_fire: 0, end_known: 0, final_above_fire: 0, open_at_close: 0 });
    k.n++;
    if (r.adopted) k.adopted++; else k.bot++;
    if (g.open_at_close) k.open_at_close++;
    const fire = num(g.no_grace_fire_pct);
    if (fire == null || !fin(r.pnl_pct)) continue;
    k.with_fire++;
    const d = Number(r.pnl_pct) - fire;
    k.sum_pnl_minus_fire_pp += d;
    if (fin(r.amount_sol)) k.sum_pnl_minus_fire_sol += (d / 100) * Number(r.amount_sol);
    if (Number(r.pnl_pct) > fire) k.final_above_fire++;
    if (fin(g.end_pct)) { k.end_known++; if (Number(g.end_pct) > fire) k.end_above_fire++; }
  }
  for (const k of Object.values(kinds)) {
    k.sum_pnl_minus_fire_pp = r4(k.sum_pnl_minus_fire_pp);
    k.sum_pnl_minus_fire_sol = r6(k.sum_pnl_minus_fire_sol);
    k.mean_pnl_minus_fire_pp = k.with_fire ? r4(k.sum_pnl_minus_fire_pp / k.with_fire) : null;
    k.share_end_above_fire = k.end_known ? r4(k.end_above_fire / k.end_known) : null;
    k.share_final_above_fire = k.with_fire ? r4(k.final_above_fire / k.with_fire) : null;
  }
  return { n: rows.length, by_kind: kinds, note: "Σ (record pnl_pct − no_grace_fire_pct) > 0 = the grace did better than the no-grace trailing / take-profit fire" };
}

function reportGraceRelease(def, records) {
  const rows = records.filter((r) => r.grace_release_shadow && typeof r.grace_release_shadow === "object");
  const withPnl = rows.filter((r) => fin(r.pnl_pct) && fin(r.grace_release_shadow.pnl_pct));
  const d = withPnl.map((r) => Number(r.pnl_pct) - Number(r.grace_release_shadow.pnl_pct));
  const dSol = withPnl.map((r, i) => (fin(r.amount_sol) ? (d[i] / 100) * Number(r.amount_sol) : 0));
  return {
    n: rows.length,
    bot: rows.filter((r) => !r.adopted).length,
    adopted: rows.filter((r) => r.adopted).length,
    sum_final_minus_would_release_pp: r4(d.reduce((s, x) => s + x, 0)),
    sum_final_minus_would_release_sol: r6(dSol.reduce((s, x) => s + x, 0)),
    final_above_would_release: d.filter((x) => x > 0).length,
    final_below_would_release: d.filter((x) => x < 0).length,
    net_sol: r6(sum(rows, netSol)),
    note: "final pnl vs the pnl at the would-release moment; an early release would not have closed there, it would only have let the profit rules run — this bounds, it does not measure, the effect",
  };
}

function reportHoldDownside(def, records) {
  const rows = records.filter((r) => hasField(r, "hold_downside_shadow"));
  const fires = rows.filter((r) => r.hold_downside_shadow && typeof r.hold_downside_shadow === "object");
  const d = fires.filter((r) => fin(r.pnl_pct) && fin(r.hold_downside_shadow.first_pnl_pct)).map((r) => Number(r.pnl_pct) - Number(r.hold_downside_shadow.first_pnl_pct));
  return {
    n_carrying: rows.length,
    n_would_close: fires.length,
    sum_final_minus_first_pp: r4(d.reduce((s, x) => s + x, 0)),
    final_above_first: d.filter((x) => x > 0).length,
    final_below_first: d.filter((x) => x < 0).length,
    note: rows.length ? null : "hold_downside_shadow is kept on the position (state.js) but is not written into the perf record (perf-record.js has no such field) — nothing to grade until it is captured there",
  };
}

function reportStraddleCeiling(def, records) {
  const rows = records.filter((r) => Array.isArray(r.straddle_gate_events) && r.straddle_gate_events.length);
  const flagged = rows.filter((r) => r.straddle_gate_events.some((e) => e?.ceiling_would_skip === true));
  const notFlagged = rows.filter((r) => !flagged.includes(r) && r.straddle_gate_events.some((e) => e?.ceiling_would_skip === false));
  const straddled = (a) => a.filter((r) => Number(r.straddle_count) > 0);
  const desc = (a) => ({ n: a.length, bot: a.filter((r) => !r.adopted).length, ...groupStats(a) });
  return {
    records_with_gate_events: rows.length,
    ceiling_would_skip: desc(flagged),
    ceiling_would_skip_straddled: desc(straddled(flagged)),
    ceiling_would_skip_not_straddled: desc(flagged.filter((r) => !(Number(r.straddle_count) > 0))),
    no_ceiling_skip_straddled: desc(straddled(notFlagged)),
    note: "'straddled' = the record's straddle_count > 0 (the record does not say which gate event the straddle followed); with the ceiling in shadow and harvestStraddleMode enforce, flagged positions straddled anyway",
  };
}

function reportPostStop(def, records) {
  const rows = records.filter((r) => hasField(r, def.tagField));
  const bot = rows.filter(isBotDeploy);
  const skips = bot.filter((r) => r[def.tagField] === true);
  const winSum = sum(skips.filter((r) => (netSol(r) ?? 0) > 0), netSol);
  const lossSum = sum(skips.filter((r) => (netSol(r) ?? 0) < 0), netSol);
  return {
    n_carrying: rows.length,
    bot_carrying: bot.length,
    would_skips: skips.length,
    would_skip_net_sol: r6(sum(skips, netSol)),
    would_skip_winners_sol: r6(winSum),
    would_skip_losers_sol: r6(lossSum),
    first_at: bot.map((r) => r.recorded_at).sort()[0] ?? null,
    last_at: bot.map((r) => r.recorded_at).sort().pop() ?? null,
    pre_registered_rule_met: skips.length >= 10 && sum(skips, netSol) < 0 && winSum <= Math.abs(lossSum) / 3,
    note: "under enforce a would-skip deploy never happens, so no further records can grade it; a check needs the rejected-candidates counterfactual",
  };
}

const REPORTERS = {
  report_grace_shadow: reportGraceShadow,
  report_grace_release: reportGraceRelease,
  report_hold_downside: reportHoldDownside,
  report_straddle_ceiling: reportStraddleCeiling,
  report_post_stop: reportPostStop,
};

const PROMOTABLE = {
  disaster_ratio_gate: gradeDisasterRatioGate,
  first_entry_probation: gradeFirstEntryProbation,
  max_hold: gradeMaxHold,
  trail_straddle: gradeTrailStraddle,
  grace_lock: gradeGraceLock,
  reading_guard: gradeReadingGuard,
  tvl_relative: gradeTvlRelative,
  flow_guard: gradeFlowGuard,
};

// ── Grade one / all ──────────────────────────────────────────────────────────────────────────

/**
 * A definition's documented exclusions: `exclude` = { <full position address>: <reason> }. A
 * matching record is left out of the whole grade — tagged/fire count and comparison population
 * alike — and listed in the result's `excluded` [{ position, reason, pool_name, recorded_at }],
 * so the exclusion is visible wherever the grade is shown. No `exclude` → records untouched and
 * no `excluded` field (null).
 */
export function applyExclusions(def, records) {
  const map = def?.exclude && typeof def.exclude === "object" ? def.exclude : null;
  if (!map || !Object.keys(map).length) return { kept: records, excluded: null };
  const kept = [], excluded = [];
  for (const r of records) {
    const reason = r?.position != null && Object.prototype.hasOwnProperty.call(map, r.position) ? map[r.position] : null;
    if (reason) excluded.push({ position: r.position, reason, pool_name: r.pool_name ?? null, recorded_at: r.recorded_at ?? null });
    else kept.push(r);
  }
  return { kept, excluded };
}

export function gradeExperiment(def, records, { cfg = {}, now = Date.now() } = {}) {
  const m = resolveMode(def, cfg);
  const base = {
    id: def.id,
    title: def.title,
    configKey: def.configKey,
    mode: m.mode,
    mode_value: m.value,
    mode_source: m.source,
    enforceBuilt: def.enforceBuilt,
    registeredAt: def.registeredAt,
    shadowSince: def.shadowSince,
    rule: def.rule,
    ruleSource: def.ruleSource,
  };
  const { kept: recs, excluded } = applyExclusions(def, Array.isArray(records) ? records : []);
  if (excluded) base.excluded = excluded;
  if (REPORTERS[def.grader]) {
    const metrics = REPORTERS[def.grader](def, recs);
    const enforced = m.mode === "enforce";
    const carrying = recs.filter((r) => hasField(r, def.tagField));
    return {
      ...base,
      sample: { ...sampleInfo(def, carrying, [], [], now), n_tagged: null, n_rest: null },
      metrics,
      checks: [],
      verdict: enforced ? "already_enforced" : "report_only",
      reason: enforced
        ? `${def.configKey}=enforce — ${metrics.note || "graded only descriptively"}`
        : "descriptive only: no pre-registered pass rule / no enforce path to promote",
    };
  }
  const g = PROMOTABLE[def.grader];
  if (!g) throw new Error(`unknown grader ${def.grader} for ${def.id}`);
  const out = g(def, recs, { cfg, now });
  let verdict = verdictFrom(def, { reached: out.threshold.reached, allPass: out.allPass, nTagged: out.sample.n_tagged });
  if (out.forceDrop && verdict === "not_met") verdict = "drop"; // a grader's own drop clause (reading-guard)
  let reason;
  if (out.forceInsufficient) {
    verdict = "insufficient";
    reason = out.forceInsufficient;
  } else if (verdict === "insufficient") {
    reason = `threshold ${out.threshold.need} not reached: needs ${out.threshold.missing}`;
  } else {
    const failed = out.checks.filter((c) => c.pass !== true).map((c) => c.name);
    reason = verdict === "met"
      ? `threshold reached (${out.threshold.by}); every check passes`
      : `threshold reached (${out.threshold.by}); failed: ${failed.join("; ")}` +
        (verdict === "drop" ? (def.dropClause ? " — the rule says 'otherwise drop'" : out.forceDrop ? ` — the rule's drop clause: ${def.dropRule}` : ` — ${out.sample.n_tagged} ≥ ${def.dropAtN} tagged, the drop point`) : " — the rule has no drop clause: do not enforce; a later 'met' would be a second look");
  }
  if (def.grader === "trail_straddle" && !out.threshold.reached) reason += "; even at 30 closes the rule's 'gain' is not computable from the records";
  if (m.mode === "enforce") {
    reason = `${def.configKey}=enforce (graded verdict would be '${verdict}': ${reason})`;
    verdict = "already_enforced";
  }
  const { threshold, allPass, forceInsufficient, forceDrop, ...rest } = out;
  return { ...base, ...rest, threshold: { need: threshold.need, reached: threshold.reached, by: threshold.by, missing: threshold.missing }, verdict, reason };
}

/**
 * promote | escalate | build_enforce | drop | wait | none
 *
 * A recorded decision (decisions.json: the experiment was already dropped / closed / promoted)
 * ends the automatic path: action "none" whatever today's numbers say. Promotion guard: a rule
 * that is `met` is promoted automatically only when its robust re-run (largest record removed)
 * also passes every check; otherwise the action is "escalate" — the operator decides.
 */
export function actionFor(res, decision = null) {
  if (decision) return "none";
  switch (res.verdict) {
    case "met":
      if (!res.enforceBuilt) return "build_enforce";
      if (res.mode !== "shadow") return "none";
      return res.robust && res.robust.all_pass === true ? "promote" : "escalate";
    case "drop":
      return res.mode === "off" ? "none" : "drop";
    case "insufficient":
      return "wait";
    default:
      return "none";
  }
}

/**
 * Revert check for a promoted EXIT rule: closes BY the rule (exit_family) after promotion with a
 * scored post_close.exit_quality. n ≥ 8 and early_exit > good_exit → revert; n ≥ 8 → keep; else
 * insufficient. Entry gates cannot be graded from records.
 */
export function revertCheck(def, records, promotedAtIso) {
  if (def.kind === "entry_gate") {
    return { id: def.id, verdict: "not_gradable_from_records", reason: "enforce blocks the deploys that would be graded; needs the rejected-candidates counterfactual" };
  }
  if (!def.exitFamily) return { id: def.id, verdict: "not_applicable", reason: "no exit family: not a promotable exit rule" };
  const at = Date.parse(promotedAtIso);
  if (!Number.isFinite(at)) return { id: def.id, verdict: "insufficient", reason: `unreadable promotion time ${promotedAtIso}` };
  const closes = (Array.isArray(records) ? records : []).filter((r) => r?.exit_family === def.exitFamily && tsOf(r) > at);
  const scored = closes.filter((r) => SCORED_EXIT_QUALITY.includes(r?.post_close?.exit_quality?.verdict));
  const count = (v) => scored.filter((r) => r.post_close.exit_quality.verdict === v).length;
  const early = count("early_exit"), good = count("good_exit");
  const counts = { n_closes: closes.length, n_scored: scored.length, early_exit: early, good_exit: good, flat: count("flat"), marginal: count("marginal"), net_sol: r6(sum(closes, netSol)) };
  if (scored.length < REVERT_MIN_N) return { id: def.id, promoted_at: new Date(at).toISOString(), ...counts, verdict: "insufficient", reason: `${scored.length}/${REVERT_MIN_N} scored closes by the rule since promotion` };
  const revert = early > good;
  return { id: def.id, promoted_at: new Date(at).toISOString(), ...counts, verdict: revert ? "revert" : "keep", reason: `early_exit ${early} ${revert ? ">" : "≤"} good_exit ${good} over ${scored.length} scored closes` };
}

export function gradeAll(defs, records, { cfg = {}, now = Date.now(), only = null, promoted = {}, ungraded = [], decisions = {} } = {}) {
  const pick = only ? defs.filter((d) => d.id === only) : defs;
  const experiments = pick.map((d) => gradeExperiment(d, records, { cfg, now }));
  const reverts = Object.entries(promoted || {}).map(([id, iso]) => {
    const def = defs.find((d) => d.id === id);
    return def ? revertCheck(def, records, iso) : { id, verdict: "unknown_experiment", reason: `no experiment ${id}` };
  });
  return {
    generated_at: new Date(now).toISOString(),
    input_records: Array.isArray(records) ? records.length : 0,
    experiments,
    action_list: experiments.map((e) => {
      const decided = decisions && decisions[e.id] ? decisions[e.id] : null;
      return { id: e.id, action: actionFor(e, decided), verdict: e.verdict, mode: e.mode, ...(decided ? { decided } : {}) };
    }),
    revert_checks: reverts,
    ungraded: only ? [] : ungraded,
  };
}

// ── Human output ─────────────────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s ?? "").padEnd(n);
const showValue = (v) => (v == null ? "n/a" : typeof v === "object" ? JSON.stringify(v) : String(v));

function keyNumbers(e) {
  const m = e.metrics || {};
  if (e.id === "max-hold" && m.row_at_cap) {
    const r = m.row_at_cap;
    return `T=${m.cap_min} Σ${fmtSol(r.sum)} w/o max ${fmtSol(r.sum_wo_largest)} ${r.better}/${r.worse}`;
  }
  if (m.tagged && m.rest) {
    return `dis ${fmtPct(100 * (m.tagged.disaster_rate ?? NaN))} vs ${fmtPct(100 * (m.rest.disaster_rate ?? NaN))} (×${m.disaster_ratio ?? "n/a"}), Σ ${fmtSol(m.tagged.net_sol)}`;
  }
  if (m.would_fire) return `Σ ${fmtSol(m.would_fire.net_sol)} = ${fmtPct(m.would_fire.net_pct_on_capital, 2)} on cap, win ${m.would_fire.winners}/${m.would_fire.n}`;
  if (e.id === "grace-profit-lock" && m.fires) return `Σ Δ ${fmtSol(m.fires.sum_delta_sol)}, ${m.fires.better}/${m.fires.worse}, costed ${fmtSol(m.fires.sum_costed_sol)}`;
  if (e.id === "flow-guard" && m.fires) return `${m.fires.n} would-fires, lower ${m.fires.closed_lower}/${m.fires.n}, Σ Δ ${fmtSol(m.fires.sum_delta_sol)}`;
  if (e.id === "reading-guard" && m.by_end) return `${m.episodes} ep / ${m.positions} pos, reverted+capital ${m.by_end.reverted + m.by_end.capital_rebase}, trusted w/ effect ${m.trusted_effect}`;
  if (e.id === "trail-straddle-trigger") return `would_hold ${m.would_hold}, same ${m.same}, tail ${m.tail_risk_pp} pp`;
  if (e.id === "grace-shadow") return Object.entries(m.by_kind || {}).map(([k, v]) => `${k} ${v.with_fire}f Σ${v.sum_pnl_minus_fire_pp}pp`).join(", ");
  if (e.id === "grace-early-release") return `n ${m.n}, Σ final−release ${m.sum_final_minus_would_release_pp} pp`;
  if (e.id === "hold-downside") return `n ${m.n_carrying}`;
  if (e.id === "straddle-trend-ceiling") return `flagged ${m.ceiling_would_skip?.n}, straddled ${m.ceiling_would_skip_straddled?.n} Σ ${fmtSol(m.ceiling_would_skip_straddled?.net_sol)}`;
  if (e.id === "post-stop-cooldown") return `would-skips ${m.would_skips}/${m.bot_carrying}, Σ ${fmtSol(m.would_skip_net_sol)}`;
  return "";
}

export function formatHuman(report) {
  const L = [];
  L.push(`Shadow grader — ${report.input_records} records, now ${report.generated_at}`);
  L.push("");
  L.push(`${pad("id", 24)}${pad("mode", 9)}${pad("n / need", 14)}${pad("key numbers", 58)}${pad("verdict", 18)}action`);
  for (const e of report.experiments) {
    const a = report.action_list.find((x) => x.id === e.id)?.action ?? "";
    const need = e.threshold ? `${e.sample.n_tagged}/${e.threshold.need.replace(/ tagged/g, "").replace(" or ", "|").replace(" days", "d")}` : "—";
    L.push(`${pad(e.id, 24)}${pad(e.mode, 9)}${pad(need, 14)}${pad(keyNumbers(e), 58)}${pad(e.verdict, 18)}${a}`);
  }
  for (const e of report.experiments) {
    L.push("");
    L.push(`■ ${e.id} — ${e.title}`);
    L.push(`  ${e.configKey}=${JSON.stringify(e.mode_value)} (${e.mode_source}) → mode ${e.mode}; enforce ${e.enforceBuilt ? "built" : "NOT built"}; shadow since ${e.shadowSince}${e.registeredAt ? `, rule registered ${e.registeredAt}` : ""}`);
    if (e.rule) L.push(`  rule: ${e.rule}`);
    const s = e.sample;
    L.push(`  sample: tagged ${s.n_tagged ?? "—"}, rest ${s.n_rest ?? "—"}, carrying ${s.n_carrying}, ${s.first_at?.slice(0, 10) ?? "?"} … ${s.last_at?.slice(0, 10) ?? "?"}, ${s.days_running} d since the shadow shipped`);
    for (const c of e.checks || []) {
      const tag = c.pass === true ? "PASS" : c.pass === false ? "FAIL" : "n/a ";
      L.push(`  [${tag}] ${c.name}: ${showValue(c.value)} (need ${c.need})${c.detail ? ` — ${c.detail}` : ""}`);
    }
    const m = e.metrics || {};
    if (m.ci90_tagged_net_sol) L.push(`  context: 90 % CI tagged Σ net ${fmtSol(m.ci90_tagged_net_sol.lo)} … ${fmtSol(m.ci90_tagged_net_sol.hi)}${m.ci90_disaster_ratio ? `; disaster ratio ${m.ci90_disaster_ratio.lo} … ${m.ci90_disaster_ratio.hi}` : ""}`);
    if (e.id === "grace-profit-lock") L.push(`  by owner ${JSON.stringify(m.by_owner)}; by kind ${JSON.stringify(m.by_kind)}; interrupted by hold ${m.interrupted_by_hold}, armed not fired ${m.armed_not_fired}`);
    if (m.ci90_sum_delta_sol && e.id !== "max-hold") L.push(`  context: 90 % CI Σ Δ◎ ${fmtSol(m.ci90_sum_delta_sol.lo)} … ${fmtSol(m.ci90_sum_delta_sol.hi)}`);
    else if (m.ci90_sum_delta_sol) L.push(`  context: 90 % CI Σ Δ◎ at the cap ${fmtSol(m.ci90_sum_delta_sol.lo)} … ${fmtSol(m.ci90_sum_delta_sol.hi)}`);
    if (e.robust && e.robust.removed) {
      const rm = e.robust.removed;
      L.push(`  robust (without ${rm.pool_name} ${rm.recorded_at?.slice(0, 10)} ${rm.delta_sol != null ? `Δ ${fmtSol(rm.delta_sol)}` : fmtSol(rm.net_sol)}): ${e.robust.checks.length ? e.robust.checks.map((c) => `${c.pass === true ? "pass" : c.pass === false ? "fail" : "n/a"}`).join(" / ") : e.robust.note}`);
    }
    if (m.decision_point) L.push(`  at the decision point ${m.decision_point.at.slice(0, 10)} (by ${m.decision_point.reached_by}, tagged ${m.decision_point.n_tagged}): ${m.decision_point.checks.map((c) => `${c.pass ? "pass" : "fail"} (${showValue(c.value)})`).join(" / ")}`);
    if (e.id === "max-hold") L.push(`  cf records ${m.records_with_cf} (${m.cf_from?.slice(0, 10)} … ${m.cf_to?.slice(0, 10)}), last cf computed ${m.cf_computed_last}, last bot close ${m.last_bot_close}, max_hold_shadow would-fires ${m.max_hold_shadow_would_fires}`);
    if (e.verdict === "report_only" || e.verdict === "already_enforced") {
      const { note, by_kind, ...rest } = m;
      if (by_kind) for (const [k, v] of Object.entries(by_kind)) L.push(`  ${k}: ${JSON.stringify(v)}`);
      L.push(`  ${JSON.stringify(rest)}`);
      if (note) L.push(`  note: ${note}`);
    }
    if (e.excluded?.length) for (const x of e.excluded) L.push(`  excluded ${x.pool_name ?? "?"} ${String(x.position).slice(0, 8)} (${x.recorded_at?.slice(0, 10) ?? "?"}): ${x.reason}`);
    L.push(`  → ${e.verdict}: ${e.reason}`);
    const dec = report.action_list.find((x) => x.id === e.id)?.decided;
    if (dec) L.push(`  decided ${dec.at}: ${dec.decision} — ${dec.note ?? ""}`);
  }
  if (report.revert_checks?.length) {
    L.push("", "Revert checks:");
    for (const r of report.revert_checks) L.push(`  ${r.id}: ${r.verdict} — ${r.reason}`);
  }
  if (report.ungraded?.length) {
    L.push("", "Ungraded (no gradable capture):");
    for (const u of report.ungraded) L.push(`  ${u.id} (${u.configKey}): ${u.note}`);
  }
  return L.join("\n");
}
