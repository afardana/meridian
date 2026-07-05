/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import { log } from "./logger.js";
import { getSharedLessonsForPrompt, pushHiveLesson, pushHivePerformanceEvent } from "./hivemind.js";
import { repoPath } from "./repo-root.js";
import { makeDocStore } from "./db/doc-store.js";
import { analyzeFeeEfficiencyOutcomes } from "./fee-efficiency.js";
import { analyzeOrganicMomentumOutcomes } from "./organic-momentum.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

const LESSONS_FILE = repoPath("lessons.json");
const _store = makeDocStore("lessons", LESSONS_FILE, () => ({ lessons: [], performance: [] }));
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once
const RECENCY_WINDOW       = 40;  // evolve from the most recent N closes (adapts to current strategy) — P5
const MIN_GROUP_SAMPLE     = 3;   // need >=3 successes AND >=3 failures before adjusting — P3
const EFFECT_SIZE_MIN      = 0.35; // standardized success/failure gap required to act — P3
const REGRESSION_MARGIN    = 0.08; // success-rate drop that triggers auto-revert of a prior change — P3
const EVOLUTION_HISTORY_MAX = 50; // keep last N evolution events (dashboard) — P3/nice-to-have
const MAX_AUTO_LESSONS     = 60;  // cap stored performance-derived lessons — P6 hygiene
const STARVATION_CLOSES_PER_DAY = 1.5; // below this throughput, relax the tightest floor — P4
// Baseline defaults + hard bounds for the evolved floors — caps prevent runaway ratcheting (P4).
const EVOLVE_BASELINES = { minFeeActiveTvlRatio: 0.05, minOrganic: 60, minIntelScore: 45 };
const EVOLVE_BOUNDS = {
  minFeeActiveTvlRatio: { min: 0.05, max: 0.60 },
  minOrganic:           { min: 55,   max: 85 },
  minIntelScore:        { min: 30,   max: 70 },
};
const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
  "entry_mcap",
  "entry_tvl",
  "entry_volume",
];
const MAX_MANUAL_LESSON_LENGTH = 400;

function sanitizeLessonText(text, maxLen = MAX_MANUAL_LESSON_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() { return _store.get(); }
function save(data) { _store.set(data); }

function buildSignalSnapshot(perf) {
  const snapshot = { ...(perf.signal_snapshot || {}) };
  if (perf.base_mint && snapshot.base_mint == null) snapshot.base_mint = perf.base_mint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && perf[field] != null) {
      snapshot[field] = perf[field];
    }
  }
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(perf) {
  const data = load();

  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  const signalSnapshot = buildSignalSnapshot(perf);
  const entry = {
    ...perf,
    signal_snapshot: signalSnapshot,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);

  // Derive and store a lesson
  const lesson = derivLesson(entry);
  if (lesson) {
    pushPerformanceLesson(data, lesson); // P6: dedup + cap stored auto-lessons
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);
  if (lesson) {
    void pushHiveLesson(lesson);
  }

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      fees_earned_usd: perf.fees_earned_usd,
      fees_earned_sol: perf.fees_earned_sol,
      fee_earned_pct: perf.initial_value_usd > 0 ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100 : null,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
      fee_efficiency: perf.fee_efficiency ?? null,
      organic_momentum: perf.organic_momentum ?? null,
      entry_mcap: perf.entry_mcap,
      entry_tvl: perf.entry_tvl,
      entry_volume: perf.entry_volume,
      exit_mcap: perf.exit_mcap,
      exit_tvl: perf.exit_tvl,
      exit_volume: perf.exit_volume,
      gas_cost_sol: perf.gas_cost_sol ?? null,
      total_gas_sol: perf.total_gas_sol ?? null,
      gas_adjusted_pnl_sol: perf.total_gas_sol != null && perf.pnl_sol != null
        ? perf.pnl_sol - perf.total_gas_sol
        : null,
    });
  }

  // Evolve thresholds every 5 closed positions
  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("./config.js");
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }

    // Darwinian signal weight recalculation
    if (config.darwin?.enabled) {
      const { recalculateWeights } = await import("./signal-weights.js");
      const wResult = recalculateWeights(data.performance, config);
      if (wResult.changes.length > 0) {
        log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      }
    }
  }

  void pushHivePerformanceEvent({
    ...entry,
    base_mint: perf.base_mint || null,
    fees_earned_sol: perf.fees_earned_sol || 0,
    eventId: `close:${perf.position}:${entry.recorded_at}`,
  });

  // Check circuit breaker after recording new performance data
  try {
    const { checkCircuitBreaker, tripCircuitBreaker } = await import("./circuit-breaker.js");
    const cb = checkCircuitBreaker();
    if (cb.tripped && !cb._wasAlreadyTripped) {
      tripCircuitBreaker(cb.reason);
    }
  } catch (e) {
    log("circuit_breaker", `Circuit breaker check failed: ${e.message}`);
  }

}

/**
 * Amend the most recent closed-performance record for a position with the
 * realized base→SOL exit-swap outcome.
 *
 * recordPerformance() runs *inside* closePosition with a market-priced
 * `final_value_usd`, BEFORE the executor's auto base→SOL swap fires — so the
 * canonical PnL omits the exit-swap cost (price impact / Jupiter+referral fees /
 * swap gas), which for illiquid meme exits can exceed the tx fees. This records
 * that cost.
 *
 * Deliberately ADDITIVE: the canonical `pnl_pct`/`pnl_usd` are left untouched
 * (they were already consumed by derivLesson/evolveThresholds/hive at record
 * time; rewriting them would double-count). The realized cost lands in an
 * `exit_swap` sub-object plus a derived `pnl_usd_net_exit_swap` for later
 * reconciliation/analysis.
 *
 * @param {string} position
 * @param {Object} swap
 * @param {number} [swap.sol_received]      - SOL actually received from the swap
 * @param {number} [swap.gas_sol]           - swap transaction gas (SOL)
 * @param {number} [swap.market_usd]        - base token's market value pre-swap (the mark)
 * @param {number} [swap.value_usd]         - USD value of the SOL actually received
 * @returns {boolean} true if a record was found and amended
 */
export function recordExitSwapOutcome(position, { sol_received = null, gas_sol = null, market_usd = null, value_usd = null } = {}) {
  if (!position) return false;
  const data = load();
  let rec = null;
  for (let i = data.performance.length - 1; i >= 0; i--) {
    if (data.performance[i].position === position) { rec = data.performance[i]; break; }
  }
  if (!rec) return false; // recordPerformance may have skipped (suspicious record) — nothing to amend

  const slippage_usd = (market_usd != null && value_usd != null)
    ? Math.round((market_usd - value_usd) * 100) / 100
    : null;

  rec.exit_swap = {
    sol_received: sol_received != null ? Math.round(sol_received * 1e6) / 1e6 : null,
    gas_sol: gas_sol,
    market_usd: market_usd != null ? Math.round(market_usd * 100) / 100 : null,
    value_usd: value_usd != null ? Math.round(value_usd * 100) / 100 : null,
    slippage_usd,
  };
  if (slippage_usd != null && Number.isFinite(rec.pnl_usd)) {
    rec.pnl_usd_net_exit_swap = Math.round((rec.pnl_usd - slippage_usd) * 100) / 100;
  }
  save(data);
  return true;
}

// ─── Post-close outcome probe (plan #05) ─────────────────────────
// Samples the pool's mcap (∝ price) at ~30/60/180 min after close and scores exit
// quality — the ground truth for exit-timing knobs. Amend pattern mirrors
// recordExitSwapOutcome (find-by-position + load()/save()); canonical pnl_* fields
// are never rewritten. See docs/plans/05-post-close-probe.md.

const PROBE_FLAT_PCT = 3;  // |move| below this = mean noise, verdict "flat"
const PROBE_GOOD_PCT = 8;  // saved_pct at/above this = "good_exit"
const PROBE_MISS_PCT = 8;  // missed_pct at/above this = "early_exit"

function findPerfByPosition(data, position) {
  for (let i = data.performance.length - 1; i >= 0; i--) {
    if (data.performance[i].position === position) return data.performance[i];
  }
  return null;
}

/**
 * Score exit quality from the completed probe slots (pure). Anchor = m60 if
 * valid, else m180, else m30. Price fell after close → saved_pct (good exit);
 * price rose → missed_pct (early exit / sold the bottom).
 */
export function scoreExitQuality(perf) {
  const pc = perf?.post_close || {};
  const anchor = ["m60", "m180", "m30"].find((k) => pc[k]?.pct != null) || null;
  if (!anchor) {
    const anyDelisted = ["m30", "m60", "m180"].some((k) => pc[k]?.status === "delisted");
    return { verdict: anyDelisted ? "delisted" : "no_data" };
  }
  const p = pc[anchor].pct;
  const downsideExit = /stop loss|oor|out of range|below|crash|volume|yield/i
    .test(String(perf.close_reason || ""));
  const saved_pct = p < 0 ? Math.round(-p * 10) / 10 : null;
  const missed_pct = p > 0 ? Math.round(p * 10) / 10 : null;
  const verdict = Math.abs(p) < PROBE_FLAT_PCT ? "flat"
    : (saved_pct ?? 0) >= PROBE_GOOD_PCT ? "good_exit"
    : (missed_pct ?? 0) >= PROBE_MISS_PCT ? "early_exit"
    : "marginal";
  return { anchor, move_pct: p, saved_pct, missed_pct, downside_exit: downsideExit, verdict };
}

/**
 * Record one probe slot (idempotent — a filled slot is never overwritten).
 * `minutes` is the configured slot list (passed in by the caller so this module
 * keeps its import shape). Flips `complete` + computes exit_quality once every
 * slot is resolved (a value OR a stale/delisted status).
 */
export function recordPostCloseProbe(position, minute, { mcap = null, status = null, minutes = [30, 60, 180] } = {}) {
  if (!position || !minute) return false;
  const data = load();
  const rec = findPerfByPosition(data, position);
  if (!rec) return false;
  rec.post_close ||= { exit_mcap: rec.exit_mcap ?? null };
  const key = `m${minute}`;
  if (rec.post_close[key] != null) return false; // idempotent
  const base = rec.post_close.exit_mcap;
  if (status) {
    rec.post_close[key] = { mcap: null, pct: null, status };
  } else {
    const pct = mcap != null && base > 0 ? Math.round((mcap / base - 1) * 1000) / 10 : null;
    rec.post_close[key] = pct != null
      ? { mcap, pct, at: new Date().toISOString() }
      : { mcap: null, pct: null, status: "delisted" }; // present-but-0/null mcap = dead pool
  }
  if (minutes.every((m) => rec.post_close[`m${m}`] != null)) {
    rec.post_close.complete = true;
    rec.post_close.exit_quality = scoreExitQuality(rec);
    log("lessons", `Exit quality for ${rec.pool_name || position.slice(0, 8)}: ${rec.post_close.exit_quality.verdict}` +
      (rec.post_close.exit_quality.move_pct != null ? ` (${rec.post_close.exit_quality.move_pct > 0 ? "+" : ""}${rec.post_close.exit_quality.move_pct}% after close)` : ""));
    notifyExitReview(rec).catch(() => {});
  }
  save(data);
  return true;
}

/**
 * Telegram follow-up once a close's probes complete (~3h later) — closes the
 * loop the close notification opened. Only decisive verdicts notify
 * (good_exit / early_exit / delisted); flat/marginal stay log-only to keep
 * the channel high-signal. Failures are swallowed — this is decoration.
 */
async function notifyExitReview(rec) {
  const q = rec.post_close?.exit_quality;
  if (!q || !["good_exit", "early_exit", "delisted"].includes(q.verdict)) return;
  const { sendHTML, escapeHTML } = await import("./telegram.js");
  const horizon = q.anchor ? q.anchor.replace("m", "") + "m" : "";
  let line;
  if (q.verdict === "delisted") {
    line = `💀 pool delisted after close — exit was correct`;
  } else if (q.verdict === "good_exit") {
    line = `✅ good exit — token ${q.move_pct}% in the ${horizon} after close (saved ${q.saved_pct}%)`;
  } else {
    line = `⚠️ sold early — token +${q.missed_pct}% in the ${horizon} after close`;
  }
  await sendHTML(
    `🔬 <b>Exit review</b> — ${escapeHTML(rec.pool_name || "?")}\n${line}\n` +
    `<i>${escapeHTML(String(rec.close_reason || "").slice(0, 80))}</i>`
  );
}

/** No exit_mcap baseline → mark done immediately so the scan never re-visits it. */
export function markPostCloseUnprobeable(position) {
  const data = load();
  const rec = findPerfByPosition(data, position);
  if (!rec || rec.post_close?.complete) return false;
  rec.post_close = {
    exit_mcap: rec.exit_mcap ?? null,
    complete: true,
    exit_quality: { verdict: "unprobeable" },
  };
  save(data);
  return true;
}

/** Close-reason → family bucket for exit-quality rollups. Order matters. */
function reasonFamily(reason) {
  const r = String(reason || "").toLowerCase();
  if (r.includes("stop loss")) return "stop_loss";
  if (r.includes("crash")) return "crash";
  if (r.includes("trailing")) return "trailing_tp";
  if (r.includes("take profit")) return "take_profit";
  if (r.includes("below")) return "oor_below";
  if (r.includes("above")) return "oor_above";
  if (r.includes("out of range") || r.includes("oor")) return "oor_other";
  if (r.includes("yield")) return "low_yield";
  if (r.includes("volume")) return "volume_death";
  return "other";
}

/**
 * Rollup of recent probed closes grouped by close-reason family — shared by the
 * /exits Telegram command and the daily briefing. `selling_bottoms` fires when
 * early exits outnumber good exits with a meaningful sample (n≥6): the exact
 * fingerprint of a too-tight wait-minutes knob.
 */
export function getExitQualitySummary({ limit = 30 } = {}) {
  const probed = load().performance
    .filter((p) => p.post_close?.exit_quality?.verdict)
    .slice(-limit);
  const byFamily = new Map();
  for (const p of probed) {
    const fam = reasonFamily(p.close_reason);
    if (!byFamily.has(fam)) {
      byFamily.set(fam, { family: fam, n: 0, good: 0, early: 0, flat: 0, marginal: 0, delisted: 0, other: 0, saved: [], missed: [] });
    }
    const g = byFamily.get(fam);
    g.n++;
    const q = p.post_close.exit_quality;
    if (q.verdict === "good_exit") g.good++;
    else if (q.verdict === "early_exit") g.early++;
    else if (q.verdict === "flat") g.flat++;
    else if (q.verdict === "marginal") g.marginal++;
    else if (q.verdict === "delisted") g.delisted++;
    else g.other++;
    if (q.saved_pct != null) g.saved.push(q.saved_pct);
    if (q.missed_pct != null) g.missed.push(q.missed_pct);
  }
  const families = [...byFamily.values()]
    .map((g) => ({
      family: g.family,
      n: g.n,
      good: g.good,
      early: g.early,
      flat: g.flat,
      marginal: g.marginal,
      delisted: g.delisted,
      avg_saved_pct: g.saved.length ? Math.round((g.saved.reduce((a, b) => a + b, 0) / g.saved.length) * 10) / 10 : null,
      avg_missed_pct: g.missed.length ? Math.round((g.missed.reduce((a, b) => a + b, 0) / g.missed.length) * 10) / 10 : null,
      selling_bottoms: g.n >= 6 && g.early > g.good,
    }))
    .sort((a, b) => b.n - a.n);
  return { total_probed: probed.length, families };
}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
function derivLesson(perf) {
  const tags = [];
  const feeYieldPct = perf.initial_value_usd > 0
    ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100
    : 0;

  // P6: categorize by the corrected objective, NOT pnl-sign — a fee-death can
  // never become a "good"/PREFER lesson even if it closed marginally positive.
  const cls = classifyOutcome(perf);
  if (cls === "neutral") return null;          // tiny break-even round-trips — nothing to learn
  const outcome = cls === "success" ? "good" : "bad";

  // Build context description with entry/exit market conditions
  const fmtNum = (n) => n == null ? "?" : n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(0)}K` : String(Math.round(n));
  const contextParts = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ];
  if (perf.entry_mcap != null || perf.entry_tvl != null || perf.entry_volume != null) {
    contextParts.push(`entry(mcap=${fmtNum(perf.entry_mcap)}, tvl=${fmtNum(perf.entry_tvl)}, vol=${fmtNum(perf.entry_volume)})`);
  }
  if (perf.exit_mcap != null || perf.exit_tvl != null || perf.exit_volume != null) {
    contextParts.push(`exit(mcap=${fmtNum(perf.exit_mcap)}, tvl=${fmtNum(perf.exit_tvl)}, vol=${fmtNum(perf.exit_volume)})`);
  }
  const context = contextParts.join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      const entryNote = perf.entry_mcap != null ? ` Entry: mcap=${fmtNum(perf.entry_mcap)}, tvl=${fmtNum(perf.entry_tvl)}, vol=${fmtNum(perf.entry_volume)}.` : "";
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.${entryNote}`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const positiveEvidence =
    feeYieldPct >= 1 ||
    (perf.fees_earned_usd || 0) >= 3 ||
    perf.pnl_pct >= 3;
  const negativeEvidence =
    perf.pnl_pct <= -5 ||
    perf.range_efficiency <= 30 ||
    closeReasonText.includes("out of range") ||
    closeReasonText.includes("oor") ||
    closeReasonText.includes("low yield") ||
    closeReasonText.includes("volume");

  let confidence = 0.35;
  if (outcome === "good") {
    confidence = positiveEvidence ? 0.82 : 0.22;
  } else if (outcome === "bad") {
    confidence = negativeEvidence ? 0.88 : 0.45;
  } else if (outcome === "poor") {
    confidence = negativeEvidence ? 0.68 : 0.32;
  }

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    sourceType: "performance",
    confidence: Math.round(confidence * 100) / 100,
    context,
    pnl_pct: perf.pnl_pct,
    fees_earned_usd: perf.fees_earned_usd,
    initial_value_usd: perf.initial_value_usd,
    range_efficiency: perf.range_efficiency,
    close_reason: perf.close_reason,
    pool: perf.pool,
    entry_mcap: perf.entry_mcap ?? null,
    entry_tvl: perf.entry_tvl ?? null,
    entry_volume: perf.entry_volume ?? null,
    exit_mcap: perf.exit_mcap ?? null,
    exit_tvl: perf.exit_tvl ?? null,
    exit_volume: perf.exit_volume ?? null,
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} config   - Live config object (mutated in place)
 * @returns {{ changes: Object, rationale: Object } | null}
 */
export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  // P5: learn from the most recent window, not the entire history.
  const window = perfData.slice(-RECENCY_WINDOW);
  // P1: classify by meaningful outcome, NOT pnl-sign (fee-deaths are not wins).
  const { successes, failures } = outcomeGroups(window);
  const curRate = successRate(window);

  const changes   = {};
  const rationale = {};
  const detail    = {}; // key -> { from, to } (for revert + dashboard)

  const data = load();
  data.evolutions = data.evolutions || [];
  const s = config.screening;

  // ── P3: self-measurement — did the last adjustment help? If the success rate
  //        regressed since then, REVERT it instead of tightening further. ──────
  const lastAdjust = [...data.evolutions].reverse().find((e) => e.type === "adjust" && !e._superseded);
  if (lastAdjust && lastAdjust.metric_before != null && curRate != null &&
      curRate < lastAdjust.metric_before - REGRESSION_MARGIN) {
    for (const [key, d] of Object.entries(lastAdjust.changes || {})) {
      if (d?.from == null) continue;
      changes[key] = d.from;
      detail[key]  = { from: d.to, to: d.from };
      rationale[key] = `Auto-revert: success-rate ${(lastAdjust.metric_before * 100).toFixed(0)}%→${(curRate * 100).toFixed(0)}% after ${key}=${d.to}; restored ${d.from}`;
    }
    if (Object.keys(changes).length > 0) {
      lastAdjust._superseded = true;
      return persistEvolution({ config, data, changes, rationale, detail, window, perfData, curRate, type: "revert" });
    }
  }

  // ── P1/P5: floor adjustments on the corrected objective, only on clear,
  //          direction-correct separation (success values ABOVE failure values). ──
  if (successes.length >= MIN_GROUP_SAMPLE && failures.length >= MIN_GROUP_SAMPLE) {
    const floors = [
      { key: "minFeeActiveTvlRatio", val: (p) => p.fee_tvl_ratio },
      { key: "minOrganic",           val: (p) => p.organic_score },
      { key: "minIntelScore",        val: (p) => p.signal_snapshot?.intel_total },
    ];
    for (const f of floors) {
      const sv = successes.map(f.val).filter(isFiniteNum);
      const fv = failures.map(f.val).filter(isFiniteNum);
      const cur = s[f.key] ?? EVOLVE_BASELINES[f.key];
      const adj = adjustFloor(f.key, cur, sv, fv, EVOLVE_BOUNDS[f.key]);
      if (adj) {
        changes[f.key]   = adj.value;
        detail[f.key]    = { from: cur, to: adj.value };
        rationale[f.key] = `Successes ${f.key}≈${adj.sMean.toFixed(2)} vs failures ${adj.fMean.toFixed(2)} (d=${adj.d.toFixed(2)}) — raised ${cur} → ${adj.value}`;
      }
    }
  }

  // ── P2: organic-momentum filter, gated on ITS OWN validation loop. ─────────
  const omv = analyzeOrganicMomentumOutcomes(window);
  if (omv && omv.ready && /signal works/i.test(omv.verdict || "")) {
    const curT = s.organicMomentumDecayTraderPct ?? -22;
    const nv = Math.round(clamp(nudge(curT, -15, MAX_CHANGE_PER_STEP), -40, -10));
    if (nv > curT && changes.organicMomentumDecayTraderPct == null) {
      changes.organicMomentumDecayTraderPct = nv;
      detail.organicMomentumDecayTraderPct  = { from: curT, to: nv };
      rationale.organicMomentumDecayTraderPct = `Organic-momentum validated (${omv.verdict}) — widened decay-trader cutoff ${curT} → ${nv}`;
    }
    if (omv.count >= 12 && s.organicMomentumHardFilter !== true) {
      changes.organicMomentumHardFilter = true;
      detail.organicMomentumHardFilter  = { from: false, to: true };
      rationale.organicMomentumHardFilter = `Organic-momentum validated on ${omv.count} closes — enabled decay hard-filter`;
    }
  }

  // ── P4: starvation relaxer — if nothing tightened and throughput is low,
  //        relax the floor furthest above baseline (prevents over-restriction). ──
  if (Object.keys(changes).length === 0) {
    const rate = closesPerDay(window);
    if (rate != null && rate < STARVATION_CLOSES_PER_DAY) {
      const cand = ["minFeeActiveTvlRatio", "minOrganic", "minIntelScore"]
        .map((key) => ({ key, over: (s[key] ?? EVOLVE_BASELINES[key]) / EVOLVE_BASELINES[key] }))
        .filter((x) => x.over > 1.01)
        .sort((a, b) => b.over - a.over)[0];
      if (cand) {
        const cur = s[cand.key];
        const moved = clamp(nudge(cur, EVOLVE_BASELINES[cand.key], MAX_CHANGE_PER_STEP),
          EVOLVE_BOUNDS[cand.key].min, EVOLVE_BOUNDS[cand.key].max);
        const rounded = roundFor(cand.key, moved);
        if (rounded < cur) {
          changes[cand.key]   = rounded;
          detail[cand.key]    = { from: cur, to: rounded };
          rationale[cand.key] = `Low throughput (${rate.toFixed(1)} closes/day) — relaxed ${cand.key} ${cur} → ${rounded} toward baseline`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  return persistEvolution({ config, data, changes, rationale, detail, window, perfData, curRate, type: "adjust" });
}

/**
 * Raise a floor toward the boundary between failures and successes — but ONLY
 * when successes clearly sit above failures on this metric (direction-correct)
 * and the separation is statistically meaningful. Inverted/weak signal → no-op
 * (this is what prevents the old fee-floor ratchet toward fee-death spikes).
 */
function adjustFloor(key, current, successVals, failureVals, bounds) {
  if (successVals.length < MIN_GROUP_SAMPLE || failureVals.length < MIN_GROUP_SAMPLE) return null;
  const sMean = avg(successVals), fMean = avg(failureVals);
  const d = effectSize(successVals, failureVals);
  if (sMean - fMean <= 0 || d < EFFECT_SIZE_MIN) return null;
  const target = Math.max(percentile(failureVals, 50), percentile(successVals, 25) * 0.95);
  const moved = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), bounds.min, bounds.max);
  const rounded = roundFor(key, moved);
  if (rounded <= current) return null; // this path only raises; lowering = starvation relaxer
  return { value: rounded, sMean, fMean, d };
}

/** Atomic temp-file + rename write of user-config.json (P7). */
function writeUserConfigAtomic(obj) {
  const tmp = `${USER_CONFIG_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, USER_CONFIG_PATH);
}

/** Persist evolved keys (file + live config), record the event, log a lesson. */
function persistEvolution({ config, data, changes, rationale, detail, window, perfData, curRate, type }) {
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }
  Object.assign(userConfig, changes); // flat root keys
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;
  writeUserConfigAtomic(userConfig);

  // Apply live — every evolved key lives under config.screening.
  for (const [k, v] of Object.entries(changes)) config.screening[k] = v;

  data.evolutions = data.evolutions || [];
  data.evolutions.push({
    ts: new Date().toISOString(),
    type,                       // 'adjust' | 'revert'
    positions: perfData.length,
    window: window.length,
    metric_before: curRate,     // success-rate at decision time → checked next cycle
    changes: detail,            // key -> { from, to }
    rationale,
  });
  if (data.evolutions.length > EVOLUTION_HISTORY_MAX) {
    data.evolutions = data.evolutions.slice(-EVOLUTION_HISTORY_MAX);
  }

  data.lessons.push({
    id: Date.now(),
    rule: `[${type === "revert" ? "AUTO-REVERT" : "AUTO-EVOLVED"} @ ${perfData.length} closes] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change", type],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(data);

  return { changes, rationale };
}

/**
 * Evolution history for the dashboard / CLI — most recent first.
 * @returns {Array<{ts,type,positions,metric_before,changes,rationale}>}
 */
export function getEvolutionHistory({ limit = 20 } = {}) {
  const evs = load().evolutions || [];
  return evs.slice(-limit).reverse();
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = Math.abs(current) * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

/** Standardized mean difference (Cohen's-d-ish) between two samples. */
function effectSize(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const pooled = Math.sqrt((stddev(a) ** 2 + stddev(b) ** 2) / 2);
  if (pooled === 0) return 0;
  return (avg(a) - avg(b)) / pooled;
}

/**
 * Classify a closed position into a learnable outcome — the objective the
 * evolution + lessons machinery should optimize. Critically NOT pnl-sign: a
 * break-even fee-death (our dominant failure) must NOT count as success.
 *
 * @returns {"success"|"failure"|"neutral"}
 */
export function classifyOutcome(perf) {
  const pnl = isFiniteNum(perf?.pnl_pct) ? perf.pnl_pct : null;
  if (pnl == null) return "neutral";
  const feeYield = perf.initial_value_usd > 0
    ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100
    : 0;
  const reason = String(perf.close_reason || "").toLowerCase();
  const isFeeDeath = reason.includes("yield");
  const isStopLoss = reason.includes("stop loss");
  const isOorCollapse = (reason.includes("oor") || reason.includes("out of range") || reason.includes("below")) && pnl < 0;
  const rangeEff = isFiniteNum(perf.range_efficiency) ? perf.range_efficiency : 100;

  // Failure: bad exit or material loss.
  if (isStopLoss || pnl <= -5 || (isFeeDeath && feeYield < 1) || isOorCollapse || (rangeEff < 30 && pnl < 0)) {
    return "failure";
  }
  // Success: real economic value AND not a fee-death exit.
  if (!isFeeDeath && (pnl >= 2 || feeYield >= 2)) return "success";
  // Tiny break-even round-trips / marginal fee-deaths = noise (excluded from learning).
  return "neutral";
}

/** Partition perf records into success/failure/neutral buckets. */
function outcomeGroups(perfData) {
  const successes = [], failures = [], neutrals = [];
  for (const p of perfData) {
    const c = classifyOutcome(p);
    (c === "success" ? successes : c === "failure" ? failures : neutrals).push(p);
  }
  return { successes, failures, neutrals };
}

/** Rolling success-rate (success / decisive) over a window — the evolution's own KPI. */
function successRate(perfData) {
  const { successes, failures } = outcomeGroups(perfData);
  const decisive = successes.length + failures.length;
  return decisive > 0 ? successes.length / decisive : null;
}

/** Closes per day across a window's recorded_at timestamps (throughput proxy). */
function closesPerDay(perfData) {
  const ts = perfData.map((p) => Date.parse(p.recorded_at)).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 2) return null;
  const days = (ts[ts.length - 1] - ts[0]) / 86_400_000;
  return days > 0 ? ts.length / days : null;
}

function roundFor(key, val) {
  if (key === "minFeeActiveTvlRatio") return Number(val.toFixed(2));
  return Math.round(val);
}

/** P6: push a performance-derived lesson with dedup (collapse near-identical
 *  rules) and a cap (drop oldest, never pinned/manual/evolution lessons). */
function pushPerformanceLesson(data, lesson) {
  const key = (l) => String(l.rule || "").slice(0, 60).toLowerCase();
  const k = key(lesson);
  const ex = data.lessons.find((l) => l.sourceType === "performance" && key(l) === k);
  if (ex) {
    ex.created_at = lesson.created_at;
    ex.seen_count = (ex.seen_count || 1) + 1;
    if (isFiniteNum(lesson.confidence)) ex.confidence = Math.max(ex.confidence || 0, lesson.confidence);
    return;
  }
  data.lessons.push(lesson);
  const perfLessons = data.lessons.filter((l) => l.sourceType === "performance" && !l.pinned);
  if (perfLessons.length > MAX_AUTO_LESSONS) {
    const toDrop = new Set(
      [...perfLessons]
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .slice(0, perfLessons.length - MAX_AUTO_LESSONS)
    );
    data.lessons = data.lessons.filter((l) => !toDrop.has(l));
  }
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const safeRule = sanitizeLessonText(rule);
  if (!safeRule) return;
  const data = load();
  const lesson = {
    id: Date.now(),
    rule: safeRule,
    tags,
    outcome: "manual",
    sourceType: tags.includes("self_tune") || tags.includes("config_change") ? "config_change" : "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  };
  data.lessons.push(lesson);
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`);
  void pushHiveLesson(lesson);
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  let lessons = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

/**
 * Remove a lesson by ID.
 */
export function removeLesson(id) {
  const data = load();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter((l) => l.id !== id);
  save(data);
  return before - data.lessons.length;
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export function getLessonsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const data = load();
  if (data.lessons.length === 0) return null;

  // Smaller caps for automated cycles — they don't need the full lesson history
  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP  = isAutoCycle ? 5  : 10;
  const ROLE_CAP    = isAutoCycle ? 6  : 15;
  const RECENT_CAP  = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = data.lessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = data.lessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      // Include if: lesson has no role restriction OR matches this role
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      // Include if: lesson has role-relevant tags OR no tags (general)
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? data.lessons
        .filter((l) => !usedIds.has(l.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  const shared = getSharedLessonsForPrompt({
    agentType,
    maxLessons: isAutoCycle ? 4 : 6,
  });
  if (selected.length === 0 && !shared) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));
  if (shared)             sections.push(`── HIVEMIND ──\n${shared}`);

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
/** Full raw performance array (used by threshold evolution). */
export function getAllPerformance() {
  return load().performance || [];
}

export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = p.filter((x) => x.pnl_usd > 0).length;

  // P1/dashboard: outcome breakdown by the corrected objective (not pnl-sign).
  const { successes, failures, neutrals } = outcomeGroups(p);
  const feeDeaths = p.filter((x) => String(x.close_reason || "").toLowerCase().includes("yield")).length;
  const decisive = successes.length + failures.length;
  const recentRate = successRate(p.slice(-RECENCY_WINDOW));

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100), // legacy pnl-sign rate
    outcome_breakdown: {
      success: successes.length,
      failure: failures.length,
      neutral: neutrals.length,
      success_rate_pct: decisive > 0 ? Math.round((successes.length / decisive) * 100) : null,
      fee_death_rate_pct: Math.round((feeDeaths / p.length) * 100),
      recent_success_rate_pct: recentRate != null ? Math.round(recentRate * 100) : null,
    },
    threshold_drift: getThresholdDrift(),
    evolution_recent: getEvolutionHistory({ limit: 5 }),
    total_lessons: data.lessons.length,
    fee_efficiency_validation: analyzeFeeEfficiencyOutcomes(p),
    organic_momentum_validation: analyzeOrganicMomentumOutcomes(p),
  };
}

/**
 * Current evolved screening floors vs their baselines — a "how far has the
 * agent drifted, and is it self-correcting?" view for the dashboard.
 */
export function getThresholdDrift() {
  let uc = {};
  try { if (fs.existsSync(USER_CONFIG_PATH)) uc = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  const drift = {};
  for (const [key, baseline] of Object.entries(EVOLVE_BASELINES)) {
    const current = uc[key] ?? baseline;
    drift[key] = {
      baseline,
      current,
      bounds: EVOLVE_BOUNDS[key],
      x_baseline: baseline ? Math.round((current / baseline) * 100) / 100 : null,
    };
  }
  return { ...drift, last_evolved: uc._lastEvolved ?? null, positions_at_evolution: uc._positionsAtEvolution ?? null };
}
