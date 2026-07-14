import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  compoundFees,
  estimateCompoundGasCost,
  shouldCompound,
  peekUnclaimedSolFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken, getSwapQuote } from "./wallet.js";
import { getCachedSymbol } from "./pnl.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons, classifyOutcome } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition, getTrackedPositions } from "../state.js";
import { simulatePnlCurve } from "../pnl-curve.js";
import { simulatePool } from "../pool-simulator.js";
import { predictRangeSurvival, binsToRangePct } from "../range-survival.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW, PLAYSTYLE_PRESETS } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { normalizeTimeframe, scaleScreeningToTimeframe } from "../screening-scales.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, sendHTML, escapeHTML } from "../telegram.js";

const SENSITIVE_CONFIG_KEYS = new Set([
  "gmgnApiKey",
  "hiveMindApiKey",
  "publicApiKey",
]);

function redactConfigValue(key, value) {
  if (!SENSITIVE_CONFIG_KEYS.has(key)) return value;
  return typeof value === "string" && value ? "***redacted***" : value;
}

function redactAppliedConfig(applied) {
  return Object.fromEntries(
    Object.entries(applied || {}).map(([key, value]) => [key, redactConfigValue(key, value)]),
  );
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  const baseMint = detail?.token_x?.address || detail?.base_token_address || null;
  const entryMarketData = {
    entry_mcap: numberOrNull(detail?.token_x?.market_cap ?? detail?.base_token_market_cap),
    entry_tvl: tvl,
    entry_volume: numberOrNull(detail?.volume),
    entry_holders: numberOrNull(detail?.base_token_holders ?? detail?.token_x?.holders),
  };

  return { pass: true, entryMarketData };
}

/**
 * Tool handler: simulate_pnl_curve
 * Builds a price-vs-PnL curve for an open position by pulling its live value/bins
 * (getMyPositions) + tracked deposit/bin_step, then running the CL simulator.
 */
async function simulatePositionPnlCurve({ position_address, pool_address, points } = {}) {
  if (!position_address) return { error: "position_address required" };
  const payload = await getMyPositions({ force: true, silent: true }).catch((e) => ({ _error: e.message }));
  if (payload?._error) return { error: `failed to load positions: ${payload._error}` };
  const p = (payload?.positions || []).find(
    (pos) => pos.position === position_address && (!pool_address || pos.pool === pool_address)
  );
  if (!p) return { error: "open position not found for this wallet" };

  const tracked = getTrackedPosition(position_address) || {};
  const binStep = tracked.bin_step ?? null;
  if (binStep == null) {
    return { error: "bin_step unavailable for this position (not tracked) — cannot simulate" };
  }
  const fees = (Number(p.unclaimed_fees_usd) || 0) + (Number(p.collected_fees_usd) || 0);

  const result = simulatePnlCurve({
    lower_bin: p.lower_bin,
    upper_bin: p.upper_bin,
    active_bin: p.active_bin,
    bin_step: binStep,
    current_value_usd: p.total_value_true_usd ?? p.total_value_usd,
    initial_value_usd: tracked.initial_value_usd ?? null,
    fees_usd: fees,
    points: points ?? 21,
  });

  return {
    position: position_address,
    pool: p.pool,
    pair: p.pair,
    in_range: p.in_range,
    ...result,
  };
}

/**
 * Tool handler: simulate_pool
 * Pre-deploy what-if. Pulls live pool window metrics via getPoolDetail, then runs
 * the pool simulator for a proposed range + deposit. Deposit can be given in USD
 * directly, or in SOL with a sol_price_usd.
 */
async function simulatePoolDeployment({
  pool_address,
  deposit_usd,
  deposit_sol,
  sol_price_usd,
  downside_pct,
  upside_pct,
  timeframe,
} = {}) {
  if (!pool_address) return { error: "pool_address required" };

  let depositUsd = Number(deposit_usd) || 0;
  if (!depositUsd && deposit_sol != null) {
    const price = Number(sol_price_usd);
    if (!Number.isFinite(price) || price <= 0) {
      return { error: "provide deposit_usd, or deposit_sol together with sol_price_usd" };
    }
    depositUsd = Number(deposit_sol) * price;
  }
  if (!depositUsd || depositUsd <= 0) return { error: "deposit_usd (or deposit_sol + sol_price_usd) required" };

  const tf = timeframe || config.screening.timeframe || "5m";
  const detail = await getPoolDetail({ pool_address, timeframe: tf }).catch((e) => ({ _error: e.message }));
  if (!detail || detail._error) return { error: `failed to load pool detail: ${detail?._error || "not found"}` };

  const result = simulatePool({
    deposit_usd: depositUsd,
    active_tvl: Number(detail.active_tvl ?? detail.tvl),
    fee_active_tvl_ratio: Number(detail.fee_active_tvl_ratio),
    volatility: Number(detail.volatility),
    timeframe: tf,
    downside_pct,
    upside_pct,
    bin_step: detail.dlmm_params?.bin_step ?? null,
  });

  return {
    pool: pool_address,
    name: detail.name ?? null,
    ...result,
  };
}

/**
 * Tool handler: predict_range_survival
 * Forecasts the probability an open position's range stays in range over several
 * horizons (1h/6h/24h), from the pool's live volatility and the position's range
 * edges. A "weather forecast" for the range.
 */
async function predictPositionRangeSurvival({ position_address, pool_address } = {}) {
  if (!position_address) return { error: "position_address required" };
  const payload = await getMyPositions({ force: true, silent: true }).catch((e) => ({ _error: e.message }));
  if (payload?._error) return { error: `failed to load positions: ${payload._error}` };
  const p = (payload?.positions || []).find(
    (pos) => pos.position === position_address && (!pool_address || pos.pool === pool_address)
  );
  if (!p) return { error: "open position not found for this wallet" };

  const tracked = getTrackedPosition(position_address) || {};
  const binStep = tracked.bin_step ?? null;
  const edges = binsToRangePct({
    lower_bin: p.lower_bin,
    upper_bin: p.upper_bin,
    active_bin: p.active_bin,
    bin_step: binStep,
  });
  if (!edges) return { error: "cannot derive range edges (missing bins or bin_step)" };

  const tf = config.screening.timeframe || "5m";
  const detail = await getPoolDetail({ pool_address: p.pool, timeframe: tf }).catch(() => null);
  const volatility = Number(detail?.volatility);
  if (!Number.isFinite(volatility) || volatility <= 0) {
    return { error: "pool volatility unavailable — cannot forecast" };
  }

  const result = predictRangeSurvival({
    downside_pct: edges.downside_pct,
    upside_pct: edges.upside_pct,
    volatility,
    timeframe: tf,
  });

  return {
    position: position_address,
    pool: p.pool,
    pair: p.pair,
    in_range: p.in_range,
    ...result,
  };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

/**
 * Profit-gated fee compounding trigger (Kamino/Revert Compoundor pattern).
 * The management cycle's CLAIM rule (index.js, "minClaimAmount") always calls
 * `executeTool("claim_fees", { position_address })` — this is the single call
 * path (confirmed: index.js has no direct dlmm.js import for claims), so
 * wrapping the toolMap entry here covers every claim, whether triggered by
 * the deterministic rule engine or an LLM tool call.
 *
 * While `feeCompoundEnabled` is FALSE (the shipped default — this feature
 * creates new on-chain txs), this is a pure pass-through to the original
 * `claimFees` PLUS a cheap shadow-mode log: `peekUnclaimedSolFees` does one
 * extra read-only RPC call to see what the gate WOULD have decided, so the
 * threshold can be calibrated against real fee accrual before flipping the
 * flag. The peek is best-effort — if it fails for any reason, claim_fees
 * still proceeds normally (peekUnclaimedSolFees never throws, returns 0).
 *
 * While `feeCompoundEnabled` is TRUE, the same peek result feeds
 * `shouldCompound(...)` for real: on a pass, route to `compoundFees` instead
 * of `claimFees` (claim + re-add the SOL-side fees into the same position);
 * on a fail (or on any peek error), fall back to plain `claimFees`.
 */
async function claimFeesWithCompoundGate({ position_address }) {
  const enabled = !!config.management.feeCompoundEnabled;
  let unclaimedSolFees = 0;
  let estGasSol = 0;
  try {
    estGasSol = estimateCompoundGasCost();
    unclaimedSolFees = await peekUnclaimedSolFees({ position_address });
  } catch (e) {
    log("compound_warn", `Fee-compound gate peek failed for ${position_address} (non-fatal, falling back to claim): ${e.message}`);
    unclaimedSolFees = 0;
  }

  const gateArgs = {
    unclaimed_fees_sol: unclaimedSolFees,
    est_gas_sol: estGasSol,
    min_multiple: config.management.feeCompoundMinMultiple,
    min_fees_sol: config.management.feeCompoundMinFeesSol,
  };
  const wouldCompound = shouldCompound(gateArgs);

  if (!enabled) {
    if (wouldCompound) {
      log(
        "fee_compound_shadow",
        `[FEE_COMPOUND_SHADOW] would compound ${position_address}: unclaimed_sol=${unclaimedSolFees.toFixed(6)} ` +
        `>= max(min_fees=${gateArgs.min_fees_sol}, ${gateArgs.min_multiple}x gas=${estGasSol.toFixed(6)}) ` +
        `(feeCompoundEnabled=false — claiming only)`,
      );
    }
    return claimFees({ position_address });
  }

  if (!wouldCompound) {
    return claimFees({ position_address });
  }

  const result = await compoundFees({ position_address });
  // compoundFees never throws (wrapped internally), but degrade gracefully to
  // plain claim on an unexpected shape or explicit failure — a real claim is
  // strictly better than silently doing nothing.
  if (!result || result.success === false) {
    log("compound_warn", `compoundFees failed for ${position_address} (${result?.error || "unknown"}) — falling back to plain claim`);
    return claimFees({ position_address });
  }
  return result;
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  simulate_pnl_curve: simulatePositionPnlCurve,
  simulate_pool: simulatePoolDeployment,
  predict_range_survival: predictPositionRangeSurvival,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFeesWithCompoundGate,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: REPO_ROOT,
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      screeningSource: ["screening", "source"],
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minLps: ["screening", "minLps"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      minDevScore:      ["screening", "minDevScore"],
      // Adversarial bear-debate pass on deploy candidates (bear-debate workstream).
      bearDebateEnabled: ["screening", "bearDebateEnabled"],
      bearDebateAction: ["screening", "bearDebateAction"],
      // cycle-based starvation relaxer (deadlock breaker)
      starvationRelaxEnabled: ["screening", "starvationRelaxEnabled"],
      starvationRelaxAfterEmptyCycles: ["screening", "starvationRelaxAfterEmptyCycles"],
      starvationRelaxCooldownHours: ["screening", "starvationRelaxCooldownHours"],
      // "rank, don't gate" candidate admission (screening redesign). See tools/screening.js
      // computeAdmissionScore() + the rank-mode client pipeline / RANK_SHADOW logging.
      screeningAdmissionMode: ["screening", "screeningAdmissionMode"],
      rankAdmitCount: ["screening", "rankAdmitCount"],
      rankMinIntelScore: ["screening", "rankMinIntelScore"],
      rankShadowEnabled: ["screening", "rankShadowEnabled"],
      // intel Safety-input enrichment (Meteora path); calibration-first, flag-gated.
      safetyEnrichMode: ["screening", "safetyEnrichMode"],
      safetyEnrichMaxPerCycle: ["screening", "safetyEnrichMaxPerCycle"],
      // organic-momentum filter (crowd growing/decaying classification)
      organicMomentumEnabled: ["screening", "organicMomentumEnabled"],
      organicMomentumDecayTraderPct: ["screening", "organicMomentumDecayTraderPct"],
      organicMomentumDecayVolumePct: ["screening", "organicMomentumDecayVolumePct"],
      organicMomentumGrowTraderPct: ["screening", "organicMomentumGrowTraderPct"],
      organicMomentumMinUniqueTraders: ["screening", "organicMomentumMinUniqueTraders"],
      organicMomentumHardFilter: ["screening", "organicMomentumHardFilter"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      loneCandidateMinDegen: ["screening", "loneCandidateMinDegen"],
      // LPAgent winning-LPer signal + playstyle steer
      lpStudyEnabled: ["screening", "lpStudyEnabled"],
      lpStudyMaxPools: ["screening", "lpStudyMaxPools"],
      lpStudyMinWinnersForStyle: ["screening", "lpStudyMinWinnersForStyle"],
      lpStyleSteerEnabled: ["screening", "lpStyleSteerEnabled"],
      // deploy-timing gate (plan #1 Phase 2)
      timingGateEnabled: ["timing", "gateEnabled"],
      timingMinBucketN: ["timing", "minBucketN"],
      timingDeadHourSuccessFloor: ["timing", "deadHourSuccessFloor"],
      timingDeadHourAction: ["timing", "deadHourAction"],
      timingSizeDownPct: ["timing", "sizeDownPct"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      autoSwapRetryAttempts: ["management", "autoSwapRetryAttempts"],
      autoSwapRetryDelayMs: ["management", "autoSwapRetryDelayMs"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      outOfRangeWaitMinutesAbove: ["management", "outOfRangeWaitMinutesAbove"],
      outOfRangeWaitMinutesBelow: ["management", "outOfRangeWaitMinutesBelow"],
      crashFastPathEnabled: ["management", "crashFastPathEnabled"],
      crashBinsPerMin: ["management", "crashBinsPerMin"],
      crashMinBinDistance: ["management", "crashMinBinDistance"],
      crashConfirmTicks: ["management", "crashConfirmTicks"],
      crashWindowSec: ["management", "crashWindowSec"],
      crashMinSpanSec: ["management", "crashMinSpanSec"],
      inRangeRugEnabled: ["management", "inRangeRugEnabled"],
      rugBinsPerMin: ["management", "rugBinsPerMin"],
      rugMinBinsDropped: ["management", "rugMinBinsDropped"],
      rugMaxPnlPct: ["management", "rugMaxPnlPct"],
      rugWindowSec: ["management", "rugWindowSec"],
      rugMinSpanSec: ["management", "rugMinSpanSec"],
      postCloseProbeEnabled: ["management", "postCloseProbeEnabled"],
      dustSweepEnabled: ["management", "dustSweepEnabled"],
      dustSweepMinUsd: ["management", "dustSweepMinUsd"],
      dustSweepMaxUsd: ["management", "dustSweepMaxUsd"],
      // exit-swap price-impact guard (skip auto-swaps into >cap quoted slippage)
      exitSwapGuardEnabled: ["management", "exitSwapGuardEnabled"],
      exitSwapMaxImpactPct: ["management", "exitSwapMaxImpactPct"],
      // open-position health alerts (fee dilution, yield decay, volume death, fee-ratio collapse)
      poolHealthAlertsEnabled: ["management", "poolHealthAlertsEnabled"],
      poolHealthAutoReview: ["management", "poolHealthAutoReview"],
      poolHealthMinSnapshots: ["management", "poolHealthMinSnapshots"],
      poolHealthMinAgeMinutes: ["management", "poolHealthMinAgeMinutes"],
      poolHealthWindowSize: ["management", "poolHealthWindowSize"],
      poolHealthYieldDecayPct: ["management", "poolHealthYieldDecayPct"],
      poolHealthTvlDilutionRisePct: ["management", "poolHealthTvlDilutionRisePct"],
      poolHealthVolumeDeathPct: ["management", "poolHealthVolumeDeathPct"],
      poolHealthFeeRatioCollapsePct: ["management", "poolHealthFeeRatioCollapsePct"],
      // Profit-gated fee compounding (Kamino/Revert Compoundor pattern) — default OFF,
      // creates new on-chain txs when enabled. See claimFeesWithCompoundGate above.
      feeCompoundEnabled: ["management", "feeCompoundEnabled"],
      feeCompoundMinMultiple: ["management", "feeCompoundMinMultiple"],
      feeCompoundMinFeesSol: ["management", "feeCompoundMinFeesSol"],
      // OOR-below flip tactic + swap-free redeposit (plan #07) — default OFF, shadow mode.
      oorFlipEnabled: ["management", "oorFlipEnabled"],
      oorFlipBailHours: ["management", "oorFlipBailHours"],
      oorFlipMaxPerPosition: ["management", "oorFlipMaxPerPosition"],
      swapFreeRedepositEnabled: ["management", "swapFreeRedepositEnabled"],
      swapFreeRedepositBins: ["management", "swapFreeRedepositBins"],
      // TWAP wick guard (Charm maxTwapDeviation pattern) — default OFF, shadow mode.
      // See state.js applyTwapWickGuard()/evaluateTwapWickGuard().
      twapGuardEnabled: ["management", "twapGuardEnabled"],
      twapGuardTicks: ["management", "twapGuardTicks"],
      twapGuardDeviationPct: ["management", "twapGuardDeviationPct"],
      twapGuardMaxDeferrals: ["management", "twapGuardMaxDeferrals"],
      // postCloseProbeMinutes intentionally NOT in update_config (array value); edit user-config.json.
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      // Breakeven profit ratchet (default OFF, shadow mode). See state.js updatePnlAndCheckExits().
      profitRatchetEnabled: ["management", "profitRatchetEnabled"],
      profitRatchetArmPct: ["management", "profitRatchetArmPct"],
      profitRatchetStopPct: ["management", "profitRatchetStopPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      // pnl poller
      pnlConfirmTicks: ["pnl", "confirmTicks"],
      // opportunity poller (interval/enabled changes apply on next restart)
      opportunityPollEnabled: ["opportunity", "enabled"],
      opportunityPollIntervalSec: ["opportunity", "pollIntervalSec"],
      opportunityPollLimit: ["opportunity", "limit"],
      opportunityMinScore: ["opportunity", "minScore"],
      opportunitySmartWalletBonus: ["opportunity", "smartWalletScoreBonus"],
      opportunityRetriggerCooldownMin: ["opportunity", "retriggerCooldownMin"],
      degenTargetVolRatio: ["opportunity", "targetVolRatio"],
      degenTargetLpCount: ["opportunity", "targetLpCount"],
      degenTargetFeeRatio: ["opportunity", "targetFeeRatio"],
      degenTargetLiquidity: ["opportunity", "targetLiquidity"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      bearDebateModel: ["llm", "bearDebateModel"],
      claudeCliTimeoutMs: ["llm", "claudeCliTimeoutMs"],
      claudeCliFallbackModel: ["llm", "claudeCliFallbackModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy:     ["strategy", "strategy"],
      playstyle:    ["strategy", "playstyle"],
      binsBelow:    ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      dynamicVolatilityThreshold: ["strategy", "dynamicVolatilityThreshold"],
      targetDownsidePct: ["strategy", "targetDownsidePct"],
      defaultShape:  ["strategy", "defaultShape"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // pnl fetcher / poller
      pnlSource: ["pnl", "source"],
      pnlRpcUrl: ["pnl", "rpcUrl"],
      pnlPollIntervalSec: ["pnl", "pollIntervalSec"],
      pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec"],
      // transaction priority fees (exit-urgency tier, AutoLP-Orca pattern)
      enablePriorityFees: ["tx", "enablePriorityFees"],
      priorityFeeMultiplier: ["tx", "priorityFeeMultiplier"],
      maxPriorityFeeMicroLamports: ["tx", "maxPriorityFeeMicroLamports"],
      txMaxRetries: ["tx", "txMaxRetries"],
      exitPriorityFeeEnabled: ["tx", "exitPriorityFeeEnabled"],
      exitPriorityFeeMultiplier: ["tx", "exitPriorityFeeMultiplier"],
      maxExitPriorityFeeMicroLamports: ["tx", "maxExitPriorityFeeMicroLamports"],
      // GMGN screening
      gmgnFeeSource: ["gmgn", "feeSource"],
      gmgnApiKey: ["gmgn", "apiKey"],
      gmgnBaseUrl: ["gmgn", "baseUrl"],
      gmgnInterval: ["gmgn", "interval"],
      gmgnOrderBy: ["gmgn", "orderBy"],
      gmgnDirection: ["gmgn", "direction"],
      gmgnLimit: ["gmgn", "limit"],
      gmgnEnrichLimit: ["gmgn", "enrichLimit"],
      gmgnRequestDelayMs: ["gmgn", "requestDelayMs"],
      gmgnMaxRetries: ["gmgn", "maxRetries"],
      gmgnHoldersLimit: ["gmgn", "holdersLimit"],
      gmgnKlineResolution: ["gmgn", "klineResolution"],
      gmgnKlineLookbackMinutes: ["gmgn", "klineLookbackMinutes"],
      gmgnFilters: ["gmgn", "filters"],
      gmgnPlatforms: ["gmgn", "platforms"],
      gmgnMinMcap: ["gmgn", "minMcap"],
      gmgnMaxMcap: ["gmgn", "maxMcap"],
      gmgnMinVolume: ["gmgn", "minVolume"],
      gmgnMinHolders: ["gmgn", "minHolders"],
      gmgnMinTokenAgeHours: ["gmgn", "minTokenAgeHours"],
      gmgnMaxTokenAgeHours: ["gmgn", "maxTokenAgeHours"],
      gmgnAthFilterPct: ["gmgn", "athFilterPct"],
      gmgnMaxTop10HolderRate: ["gmgn", "maxTop10HolderRate"],
      gmgnMaxBundlerRate: ["gmgn", "maxBundlerRate"],
      gmgnMaxRatTraderRate: ["gmgn", "maxRatTraderRate"],
      gmgnMaxFreshWalletRate: ["gmgn", "maxFreshWalletRate"],
      gmgnMaxDevTeamHoldRate: ["gmgn", "maxDevTeamHoldRate"],
      gmgnMaxBotDegenRate: ["gmgn", "maxBotDegenRate"],
      gmgnMaxSniperCount: ["gmgn", "maxSniperCount"],
      gmgnMaxSniperHoldRate: ["gmgn", "maxSniperHoldRate"],
      gmgnPreferredKolNames: ["gmgn", "preferredKolNames"],
      gmgnPreferredKolMinHoldPct: ["gmgn", "preferredKolMinHoldPct"],
      gmgnDumpKolNames: ["gmgn", "dumpKolNames"],
      gmgnDumpKolMinHoldPct: ["gmgn", "dumpKolMinHoldPct"],
      gmgnRequireKol: ["gmgn", "requireKol"],
      gmgnMinKolCount: ["gmgn", "minKolCount"],
      gmgnMinSmartDegenCount: ["gmgn", "minSmartDegenCount"],
      gmgnMinTotalFeeSol: ["gmgn", "minTotalFeeSol"],
      gmgnIndicatorFilter: ["gmgn", "indicatorFilter"],
      gmgnIndicatorInterval: ["gmgn", "indicatorInterval"],
      gmgnRequireBullishSt: ["gmgn", "indicatorRules", "requireBullishSupertrend"],
      gmgnRejectAtBottom: ["gmgn", "indicatorRules", "rejectAlreadyAtBottom"],
      gmgnRequireAboveSt: ["gmgn", "indicatorRules", "requireAboveSupertrend"],
      gmgnMinRsi: ["gmgn", "indicatorRules", "minRsi"],
      gmgnMaxRsi: ["gmgn", "indicatorRules", "maxRsi"],
      gmgnRequireBbPosition: ["gmgn", "indicatorRules", "requireBbPosition"],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );
    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      let normalizedVal = val;
      if (STRATEGY_BIN_KEYS.has(match[0])) {
        const numericVal = Number(val);
        if (!Number.isFinite(numericVal)) {
          unknown.push(key);
          continue;
        }
        normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
      }
      applied[match[0]] = normalizedVal;
    }

    // Playstyle preset → resolve to a bins range (plan #2). Explicit bins in the same call win;
    // otherwise inject the preset's min/max/default so the existing bins apply+persist machinery
    // handles the rest. An invalid style is rejected (dropped to `unknown`).
    if (applied.playstyle != null) {
      const styleKey = String(applied.playstyle).toLowerCase();
      const preset = PLAYSTYLE_PRESETS[styleKey];
      if (!preset) {
        delete applied.playstyle;
        unknown.push("playstyle (must be tight|balanced|wide)");
      } else {
        applied.playstyle = styleKey;
        if (applied.minBinsBelow == null) applied.minBinsBelow = preset.min;
        if (applied.maxBinsBelow == null) applied.maxBinsBelow = preset.max;
        if (applied.defaultBinsBelow == null) applied.defaultBinsBelow = preset.max;
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Auto-scale fee/volume when timeframe changes (unless user set them explicitly in same call).
    if (applied.timeframe != null && applied.minFeeActiveTvlRatio == null && applied.minVolume == null) {
      const tf = normalizeTimeframe(applied.timeframe);
      applied.timeframe = tf;
      const scaled = scaleScreeningToTimeframe(tf);
      applied.minFeeActiveTvlRatio = scaled.minFeeActiveTvlRatio;
      applied.minVolume = scaled.minVolume;
      applied._timeframeScaled = true;
      log("config", `timeframe ${tf} → auto-scaled minFeeActiveTvlRatio=${scaled.minFeeActiveTvlRatio}, minVolume=${scaled.minVolume}`);
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const [section, field, third] = CONFIG_MAP[key];
      const isNestedField = typeof third === "string";
      if (isNestedField) {
        if (!config[section][field] || typeof config[section][field] !== "object") config[section][field] = {};
        const before = config[section][field][third];
        config[section][field][third] = val;
        log("config", `update_config: config.${section}.${field}.${third} ${redactConfigValue(key, before)} → ${redactConfigValue(key, val)}`);
      } else {
        const before = config[section][field];
        config[section][field] = val;
        log("config", `update_config: config.${section}.${field} ${redactConfigValue(key, before)} → ${redactConfigValue(key, val)} (verify: ${redactConfigValue(key, config[section][field])})`);
      }
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    // Persist GMGN tuning to gmgn-config.json, and everything else to user-config.json.
    let gmgnConfig = {};
    if (fs.existsSync(GMGN_CONFIG_PATH)) {
      try { gmgnConfig = JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    let wroteUserConfig = false;
    let wroteGmgnConfig = false;
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const [section, field, third] = CONFIG_MAP[key] || [];
      const persistPath = Array.isArray(third) ? third : null;
      const nestedField = typeof third === "string" ? third : null;
      if (section === "gmgn") {
        if (nestedField) {
          if (!gmgnConfig[field] || typeof gmgnConfig[field] !== "object") gmgnConfig[field] = {};
          gmgnConfig[field][nestedField] = val;
        } else {
          gmgnConfig[field] = val;
        }
        wroteGmgnConfig = true;
        continue;
      }
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
      wroteUserConfig = true;
    }
    const tunedAt = new Date().toISOString();
    if (wroteUserConfig) {
      userConfig._lastAgentTune = tunedAt;
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
    }
    if (wroteGmgnConfig) {
      gmgnConfig._lastAgentTune = tunedAt;
      fs.writeFileSync(GMGN_CONFIG_PATH, JSON.stringify(gmgnConfig, null, 2));
    }

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.pnlPollIntervalSec != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => !k.startsWith("_") && k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${redactConfigValue(k, applied[k])}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(redactAppliedConfig(applied))} — ${reason}`);
    return { success: true, applied: redactAppliedConfig(applied), unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Swap a base token back to SOL with retry. Jupiter can transiently fail (no route,
 * quote error) and a single attempt silently leaves the token unsold — this retries
 * with a delay, re-fetching the balance each attempt (amounts can shift on partial
 * fills). Treats both a throw AND result.success===false / missing tx as failure.
 * Returns { swapped, result, token, balances } — swapped=false if nothing to do or all
 * attempts failed. `balances`/`token` are surfaced so callers can capture exit-swap cost.
 */
async function swapBaseToSolWithRetry(baseMint, label) {
  const attempts = Math.max(1, Number(config.management.autoSwapRetryAttempts ?? 3));
  const delayMs = Math.max(0, Number(config.management.autoSwapRetryDelayMs ?? 3000));
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const balances = await getWalletBalances({});
      const token = balances.tokens?.find((t) => t.mint === baseMint);
      if (!token || token.usd < 0.10) {
        // Nothing left to swap (already sold or dust) — treat as done.
        return { swapped: attempt > 1, result: null, token: null };
      }
      // Exit-swap price-impact guard: quote first, compare against market value —
      // the same metric the [SWAP_FREE_SHADOW] slippage lines measure post-hoc.
      // Checked on attempt 1 only (impact won't recover within the retry delay).
      // Fail-open: any quote error proceeds to the normal swap.
      if (attempt === 1) {
        try {
          const maxImpact = Number(config.management.exitSwapMaxImpactPct ?? 5);
          const solPrice = Number(balances?.sol_price) || 0;
          // Only guard remainders the dust sweeper can retry later (<= dustSweepMaxUsd);
          // larger balances are urgent-exit inventory (e.g. a ratchet/stop close mid-dump,
          // brain-SOL $40.39 @ 11% impact 2026-07-14) — holding those to dodge slippage
          // strands a collapsing token with no auto-sell path. Pay the impact and exit.
          const sweeperCeiling = Number(config.management.dustSweepMaxUsd ?? 25);
          if (maxImpact > 0 && solPrice > 0 && token.usd > 0 && token.usd <= sweeperCeiling) {
            const quote = await getSwapQuote({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
            if (quote?.out_amount != null) {
              const quotedUsd = (quote.out_amount / 1e9) * solPrice;
              const impactPct = ((token.usd - quotedUsd) / token.usd) * 100;
              if (impactPct > maxImpact) {
                const sym = token.symbol || baseMint.slice(0, 8);
                if (config.management.exitSwapGuardEnabled) {
                  log("executor", `[EXIT_SWAP_GUARD] skipping ${label} swap of ${sym} ($${token.usd.toFixed(2)}): quoted impact ${impactPct.toFixed(1)}% > ${maxImpact}% cap — holding; dust sweeper re-quotes on later passes`);
                  return { swapped: false, skipped_high_impact: true, impact_pct: impactPct, result: null, token, balances };
                }
                log("executor", `[EXIT_SWAP_GUARD_SHADOW] would skip ${label} swap of ${sym} ($${token.usd.toFixed(2)}): quoted impact ${impactPct.toFixed(1)}% > ${maxImpact}% cap (exitSwapGuardEnabled=false)`);
              }
            }
          }
        } catch (e) {
          log("executor_warn", `[EXIT_SWAP_GUARD] quote check failed (fail-open): ${e.message}`);
        }
      }
      log("executor", `Auto-swapping ${label} ${token.symbol || baseMint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL (attempt ${attempt}/${attempts})`);
      const swapResult = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
      const ok = swapResult && swapResult.success !== false && !swapResult.error && (swapResult.tx || swapResult.amount_out);
      if (ok) return { swapped: true, result: swapResult, token, balances };
      lastErr = swapResult?.error || swapResult?.reason || "swap returned no tx";
    } catch (e) {
      lastErr = e.message;
    }
    log("executor_warn", `Auto-swap ${label} attempt ${attempt}/${attempts} failed: ${lastErr}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  log("executor_warn", `Auto-swap ${label} failed after ${attempts} attempts — base token left unsold (${baseMint.slice(0, 8)})`);
  return { swapped: false, result: null, token: null };
}

/**
 * Sweep leftover non-SOL wallet tokens back to SOL (net-positive dust only).
 * Catches residue from failed auto-swaps, bypassed close paths, and partial
 * fills. Rules:
 *   - skip SOL/USDC and any mint with an OPEN tracked position
 *   - skip below dustSweepMinUsd (swap gas + Jupiter route minimums make tiny
 *     dust net-negative; its ATA rent stays counted in AUM as recoverable)
 *   - skip above dustSweepMaxUsd (deliberate holdings, e.g. skip_swap closes —
 *     never auto-sold)
 * Each successful sweep also reclaims the ~0.002 SOL ATA rent, so anything
 * above the floor is net-positive. Never throws.
 */
export async function sweepWalletDust() {
  const out = { swept: [], skipped_large: [] };
  try {
    if (!config.management.dustSweepEnabled) return out;
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const minUsd = Number(config.management.dustSweepMinUsd ?? 0.25);
    const maxUsd = Number(config.management.dustSweepMaxUsd ?? 25);
    const balances = await getWalletBalances({});
    if (!Array.isArray(balances?.tokens)) return out;
    const openMints = new Set(getTrackedPositions(true).map((p) => p.base_mint).filter(Boolean));

    for (const t of balances.tokens) {
      if (!t.mint || t.mint === SOL_MINT || t.symbol === "SOL") continue;
      if (t.mint === config.tokens?.USDC) continue;
      if (openMints.has(t.mint)) continue;
      const usd = Number(t.usd) || 0;
      if (usd < minUsd) continue;
      if (usd > maxUsd) { out.skipped_large.push({ symbol: t.symbol, usd }); continue; }

      const { swapped, result: swapResult } = await swapBaseToSolWithRetry(t.mint, "dust sweep");
      if (!swapped) continue;
      const solOut = swapResult?.amount_out ? Number(swapResult.amount_out) / 1e9 : null;
      out.swept.push({ symbol: t.symbol || t.mint.slice(0, 8), usd, sol: solOut });
      // Reclaim the now-empty ATA's rent (same pattern as the close path).
      try {
        await sleep(2000);
        const { closeEmptyTokenAccount } = await import("./wallet.js");
        await closeEmptyTokenAccount(t.mint);
      } catch (e) {
        log("executor_warn", `Dust sweep: ATA rent reclaim failed for ${t.symbol}: ${e.message}`);
      }
    }

    if (out.swept.length) {
      const lines = out.swept
        .map((s) => `${escapeHTML(s.symbol)} $${s.usd.toFixed(2)}${s.sol ? ` → ◎${s.sol.toFixed(5)}` : ""}`)
        .join(" · ");
      log("executor", `Dust sweep: ${out.swept.length} token(s) swept — ${lines}`);
      sendHTML(`🧹 <b>Dust swept</b> ${lines} <i>(+◎0.002 rent each)</i>`).catch(() => {});
    }
  } catch (e) {
    log("executor_warn", `Dust sweep failed (non-fatal): ${e.message}`);
  }
  return out;
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        const symFor = (mint) => (mint === SOL_MINT || mint === "SOL")
          ? "SOL"
          : (getCachedSymbol(mint) || mint?.slice(0, 8) || "?");
        notifySwap({ inputSymbol: symFor(args.input_mint), outputSymbol: symFor(args.output_mint), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        // Enrich with the entry snapshot trackPosition just recorded (mcap,
        // fee yield, volatility, crowd momentum) — the "why we entered" context.
        const trackedNew = result.position ? getTrackedPosition(result.position) : null;
        notifyDeploy({
          pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8),
          amountSol: args.amount_y ?? args.amount_sol ?? 0,
          position: result.position,
          tx: result.txs?.[0] ?? result.tx,
          pool: result.pool || args.pool_address,
          priceRange: result.price_range,
          rangeCoverage: result.range_coverage,
          binStep: result.bin_step,
          baseFee: result.base_fee,
          lazy: !!args.lazy,
          strategy: args.strategy || trackedNew?.strategy,
          binCount: (Number(args.bins_below) || 0) + (Number(args.bins_above) || 0) + 1 || null,
          entryMcap: trackedNew?.entry_mcap ?? null,
          feeTvl24h: trackedNew?.fee_tvl_ratio ?? null,
          volatility: trackedNew?.volatility ?? null,
          momentum: trackedNew?.organic_momentum?.classification ?? null,
        }).catch(() => {});
      } else if (name === "close_position") {
        // Resolve currencies explicitly before notifying: under solMode the
        // legacy *_usd result fields carry SOL, so only the *_true fields (or
        // non-solMode legacy values) may be presented as dollars.
        const solMode = !!config.management.solMode;
        // Outcome classification (fee-death ≠ win) drives the emoji. Ratios
        // cancel units, so solMode SOL values classify identically.
        let closeOutcome = null;
        try {
          closeOutcome = classifyOutcome({
            pnl_pct: result.pnl_pct,
            fees_earned_usd: result.fees_usd ?? 0,
            initial_value_usd: result.deployed_usd ?? 0,
            close_reason: result.reason,
          });
        } catch { /* emoji falls back to pnl sign */ }
        notifyClose({
          pair: result.pool_name || args.position_address?.slice(0, 8),
          pnlSol: result.pnl_sol ?? (solMode ? result.pnl_usd : null) ?? 0,
          pnlUsd: result.pnl_usd_true ?? (solMode ? null : result.pnl_usd),
          pnlPct: result.pnl_pct ?? 0,
          deployedSol: result.deployed_sol_true ?? result.deployed_sol ?? 0,
          deployedUsd: result.deployed_usd_true ?? (solMode ? null : result.deployed_usd),
          feesSol: result.fees_sol_true ?? (solMode ? result.fees_usd : null) ?? 0,
          feesUsd: result.fees_usd_true ?? (solMode ? null : result.fees_usd),
          holdTime: result.hold_time,
          strategy: result.strategy,
          reason: result.reason,
          pool: result.pool,
          tx: result.close_txs?.[0] ?? result.txs?.[0],
          outcome: closeOutcome,
          gasSol: result.total_gas_sol ?? result.gas_cost_sol ?? null,
          peakPnlPct: result.peak_pnl_pct ?? null,
        }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold (retried).
        if (!args.skip_swap && result.base_mint) {
          const { swapped, result: swapResult, token, balances, skipped_high_impact, impact_pct } = await swapBaseToSolWithRetry(result.base_mint, "after close");
          if (skipped_high_impact) {
            // Guard held the token — steer the LLM away from re-selling it manually
            // at the same bad quote (mechanical closes never read this; agent closes do).
            result.auto_swapped = false;
            result.auto_swap_note = `Auto-swap intentionally SKIPPED: quoted price impact ${impact_pct.toFixed(1)}% exceeds the ${config.management.exitSwapMaxImpactPct}% cap. The base token is held for a better exit (dust sweeper re-quotes later). Do NOT call swap_token now.`;
          }
          if (swapped) {
            // Tell the model the swap already happened so it doesn't call swap_token again
            result.auto_swapped = true;
            result.auto_swap_note = `Base token already auto-swapped back to SOL (${token?.symbol || result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
            if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;

            // Thread the realized exit-swap cost back into the closed-performance
            // record. recordPerformance already ran inside closePosition with a
            // market-priced final value (before this swap), so its PnL omits the
            // exit slippage + swap gas. Advisory/additive — see recordExitSwapOutcome.
            if (swapResult?.amount_out && result.position) {
              try {
                const solReceived = Number(swapResult.amount_out) / 1e9; // SOL output is lamports (9 dp)
                const solPrice = Number(balances?.sol_price) || 0;
                const valueUsd = solPrice > 0 ? solReceived * solPrice : null;
                const { recordExitSwapOutcome } = await import("../lessons.js");
                recordExitSwapOutcome(result.position, {
                  sol_received: solReceived,
                  gas_sol: swapResult.gas_cost_sol ?? null,
                  market_usd: token?.usd ?? null,
                  value_usd: valueUsd,
                });
                // Surface the exit swap in Telegram with value + slippage-vs-quote
                // (auto-swaps bypass executeTool's swap_token notify path).
                const slippageUsd = (token?.usd != null && valueUsd != null)
                  ? Math.round((token.usd - valueUsd) * 100) / 100
                  : null;
                const slippagePct = (slippageUsd != null && token?.usd > 0)
                  ? (slippageUsd / token.usd) * 100
                  : null;
                notifySwap({
                  inputSymbol: token?.symbol || result.base_mint.slice(0, 8),
                  outputSymbol: "SOL",
                  amountIn: token?.balance,
                  amountOut: solReceived.toFixed(6),
                  tx: swapResult.tx,
                  valueSol: solReceived,
                  valueUsd,
                  slippageUsd,
                  slippagePct,
                }).catch(() => {});

                // Charm-style swap-free redeposit (companion to plan #07) — SHADOW MODE.
                // When swapFreeRedepositEnabled is OFF (the shipped default), log what the
                // Jupiter market-sell just cost in slippage vs. what a fee-earning ask-strip
                // redeposit would have looked like (no slippage, + fees on the conversion).
                // Calibration ground truth for enabling the strip path. Zero behavior change.
                if (!config.management.swapFreeRedepositEnabled && slippageUsd != null) {
                  const stripBins = Number(config.management.swapFreeRedepositBins ?? 20);
                  const sym = token?.symbol || result.base_mint.slice(0, 8);
                  log(
                    "swap_free_shadow",
                    `[SWAP_FREE_SHADOW] would redeposit ${sym} as a ${stripBins}-bin ask strip instead of Jupiter-selling: ` +
                    `swap cost slippage ≈ $${slippageUsd.toFixed(2)}${slippagePct != null ? ` (${slippagePct.toFixed(2)}%)` : ""} ` +
                    `on $${(token?.usd ?? 0).toFixed(2)} — strip would pay 0 slippage + earn fees on the conversion ` +
                    `(swapFreeRedepositEnabled=false)`,
                  );
                }
              } catch (err) {
                log("executor_warn", `Failed to record exit-swap outcome: ${err.message}`);
              }
            }

            // Reclaim rent from empty ATA
            try {
              log("executor", `Reclaiming rent from empty ATA for mint ${result.base_mint}`);
              await new Promise(r => setTimeout(r, 2000)); // wait for swap to settle
              const { closeEmptyTokenAccount } = await import("./wallet.js");
              const closeResult = await closeEmptyTokenAccount(result.base_mint);
              if (closeResult.success) {
                result.rent_reclaimed_sol = 0.002;
                log("executor", `Rent reclaimed successfully: 0.002 SOL`);
              }
            } catch (err) {
              log("executor_warn", `Failed to reclaim rent: ${err.message}`);
            }
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        await swapBaseToSolWithRetry(result.base_mint, "after claim");
      }

      if (name === "deploy_position" || name === "close_position") {
        try {
          const { getTrackedPositions } = await import("../state.js");
          const { syncSocketSubscriptions } = await import("./socket-monitor.js");
          await syncSocketSubscriptions(getTrackedPositions(true));
        } catch (e) {
          log("executor_warn", `Failed to sync WebSocket subscriptions after ${name}: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
