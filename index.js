// Sync Node.js process timezone with the VM's local system timezone
process.env.TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jakarta";

import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import http from "node:http";
import { recordError } from "./error-telemetry.js";
import { getMyPositions, getActiveBin, estimateExitGasCost, setPositionDiscoveryTrigger, reconcileExternallyClosedPosition } from "./tools/dlmm.js";
import { getSolBalance, getWalletBalances, getWalletAddress, getSwapQuote } from "./tools/wallet.js";
import { getTopCandidates, degenScore } from "./tools/screening.js";
import { formatFeeEfficiency } from "./fee-efficiency.js";
import { formatPoolSimLine } from "./pool-simulator.js";
import { formatOrganicMomentum } from "./organic-momentum.js";
import { config, reloadScreeningThresholds, computeDeployAmount, DEFAULT_LLM_MODEL } from "./config.js";
import { evolveThresholds, getPerformanceSummary, getAllPerformance, recordPostCloseProbe, markPostCloseUnprobeable, getExitQualitySummary, formatSimilarDeploysLine, applyStarvationRelaxation } from "./lessons.js";
import { executeTool, registerCronRestarter, sweepWalletDust } from "./tools/executor.js";
import { checkAndExecuteAutoSkim, getAutoSkimStatus, transferSol } from "./tools/transfer.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  sendHTMLWithButtons,
  editMessage,
  editMessageWithButtons,
  editHTMLWithButtons,
  deleteMessage,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
  createTypingIndicator,
  markdownToTelegramHTML,
  escapeHTML,
  fmtDuration,
  fmtPct,
  fmtSolUsd,
  meteoraPool,
  solscanAcct,
  solscanTx,
} from "./telegram.js";
import {
  readLastOutboundId,
  readRollingMessageId,
  recordRollingMessageId,
  clearRollingMessageId,
} from "./telegram-marker.js";
import { generateBriefing, generateBriefingData, saveDailyBriefing, getDailyBriefing } from "./briefing.js";
import { publishDashboardReport, pgNotify, setLastScreeningFunnel } from "./report.js";
import { decideHarvestStraddle } from "./harvest-straddle.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, setPositionHold, updatePnlAndCheckExits, confirmPeak, registerExitSignal, getBaselineState, initState, flushState, persistWalletAddress, getScreeningStarvation, saveScreeningStarvation, evaluateCloseEfficiency, estimateBaseTokenFraction, recordCloseEffTracking, setAdoptionEnricher, attachEntryMetrics, attachAssetProfile, markPositionClosedByReconciliation, syncConfiguredManagementProfiles, evaluateHoldGiveBack, noteHoldGiveBackAlert, clearRecentActiveBins, finalizeExit } from "./state.js";
import { initAllDocStores, flushAllDocStores } from "./db/doc-store.js";
import { recordTick, flushTicks } from "./db/tick-store.js";
import { recordLiquidityTicks, flushLiquidityTicks } from "./db/liquidity-tick-store.js";
import { latestBalanceTs, recordBalanceEntry } from "./balance-history.js";
import { runLedgerTruth } from "./ledger-truth.js";
import { getActiveStrategy } from "./strategy-library.js";
import { getSolPriceUsd } from "./sol-price.js";
import { formatDeployTimingAdvisory, formatDeployTimingReport, getDeployTimingGate } from "./deploy-timing.js";
import { getCachedLpStudy, formatTopLperStyle, lperConsensusStyle } from "./lper-signal.js";
import { recordPositionSnapshot, recallForPool, addPoolNote, getPoolSnapshots } from "./pool-memory.js";
import { analyzePositionHealth, getPoolHealthConfig, formatHealthAlertLines } from "./position-alerts.js";
import { checkPositionsPvp, formatPvpAlert } from "./pvp.js";
import { getPoolDetail, fetchPoolDiscoveryDetail } from "./tools/screening.js";

// ── Plan #12: adoption entry-metrics enricher ────────────────────────────────
// Adopted (manual) positions were tracked with entry_* = null, so the learning
// engine (similar_past, evolution, TVL-band tables) was blind to the operator's
// cohort. Registered into state.js at boot; runs fire-and-forget after every
// adoption (poller auto-adopt, reconcile cron, /adopt). One discovery GET.
async function captureAdoptedEntryMetrics(positionAddress, poolAddress, observedPosition = null) {
  if (!positionAddress || !poolAddress) return;
  const tf = config.screening.timeframe || "1h";
  const detail = await fetchPoolDiscoveryDetail({ poolAddress, timeframe: tf });
  if (!detail) { log("state", `[ADOPT_ENRICH] no pool detail for ${poolAddress.slice(0, 8)} — entry metrics left null`); return; }
  const tokenXMint = observedPosition?.token_x_mint || detail?.token_x?.address || null;
  const tokenYMint = observedPosition?.token_y_mint || detail?.token_y?.address || null;
  const tokenXSymbol = observedPosition?.token_x_symbol || detail?.token_x?.symbol || null;
  const tokenYSymbol = observedPosition?.token_y_symbol || detail?.token_y?.symbol || null;
  const assetPair = tokenXSymbol && tokenYSymbol ? `${tokenXSymbol}-${tokenYSymbol}` : null;
  const assetProfileChanged = attachAssetProfile(positionAddress, {
    token_x_mint: tokenXMint,
    token_y_mint: tokenYMint,
    token_x_symbol: tokenXSymbol,
    token_y_symbol: tokenYSymbol,
    token_x_decimals: observedPosition?.token_x_decimals,
    token_y_decimals: observedPosition?.token_y_decimals,
    source: "meteora_discovery",
    validated_at: new Date().toISOString(),
  }, { pairName: assetPair });
  const written = attachEntryMetrics(positionAddress, {
    entry_mcap: detail?.token_x?.market_cap ?? detail?.base_token_market_cap,
    entry_tvl: detail?.tvl ?? detail?.active_tvl,
    entry_volume: detail?.volume,
    entry_holders: detail?.base_token_holders ?? detail?.token_x?.holders,
    fee_tvl_ratio: detail?.fee_active_tvl_ratio,
    organic_score: detail?.token_x?.organic_score,
    volatility: detail?.volatility,
    entry_price_change_pct: detail?.pool_price_change_pct,
    base_mint: detail?.token_x?.address,
  });
  const fields = [...written, ...(assetProfileChanged ? ["asset_profile"] : [])];
  log("state", `[ADOPT_ENRICH] ${positionAddress.slice(0, 8)} (${detail?.name || poolAddress.slice(0, 8)}): filled ${fields.length ? fields.join(", ") : "nothing (already populated)"} @${tf}`);
}
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { extractRugSignals, evaluateRugFilter, getRugFilterConfig, formatRugTrips, computeClusterRiskIndex, evaluateClusterRisk, formatClusterRisk } from "./rug-signals.js";
import { checkGmgnSmartExodus } from "./tools/gmgn.js";
import { computeDevScore } from "./dev-scoring.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";
import { checkCircuitBreaker, resetCircuitBreaker, getCircuitBreakerStatus, updateSolPrice } from "./circuit-breaker.js";
import { recordSolPrice, checkSolVolatility, getSolVolatilityStatus } from "./sol-volatility.js";
import { formatRpcHealth } from "./tools/rpc.js";
import { monitorEventLoopDelay } from "perf_hooks";
import { startSocketMonitor, stopSocketMonitor, syncSocketSubscriptions, setBinEventSink, setPositionDiscoverySignalSink } from "./tools/socket-monitor.js";
import { getPnlConnectionWithFailover, isPositionAccountLive } from "./tools/pnl.js";

import { REPO_ROOT, repoPath } from "./repo-root.js";

// ─── Heartbeat for Watchdog ─────────────────────────────────────
const _eld = monitorEventLoopDelay({ resolution: 20 });
_eld.enable();
const HEARTBEAT_FILE = repoPath(".heartbeat");

function writeHeartbeat(cycle) {
  try {
    const data = JSON.stringify({
      timestamp: Date.now(),
      cycle,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      heap_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      event_loop_lag_ms: Math.round(_eld.mean / 1e6 * 100) / 100,
    });
    fs.writeFileSync(HEARTBEAT_FILE, data);
  } catch { /* non-blocking — watchdog is best-effort */ }
}

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const indexPath = fileURLToPath(import.meta.url);
const isMain = process.env.pm_id != null
  || (entrypointPath ? path.resolve(entrypointPath) === indexPath : false);

if (isMain) {
  log("startup", "DLMM LP Agent starting...");
  log("startup", `Repo: ${REPO_ROOT} | cwd: ${process.cwd()}${process.env.pm_id ? ` | PM2 id: ${process.env.pm_id}` : ""}`);
  if (path.resolve(process.cwd()) !== path.resolve(REPO_ROOT)) {
    log("startup_warn", `process.cwd() differs from repo root — use "npm run pm2:start" (not "pm2 start index.js" from another directory)`);
  }
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
  log("startup", `Model: ${process.env.LLM_MODEL || DEFAULT_LLM_MODEL}`);
  // Initialise the persistence cache before any state accessor runs. Required
  // for the pg backend (Postgres can't be read synchronously); harmless for json.
  await initState();
  await initAllDocStores();
  // One-time relabel of pre-2026-08-21 adoptions recorded with the old "spot"
  // default (see normalizeAdoptedStrategies in state.js). Idempotent.
  try {
    const { normalizeAdoptedStrategies } = await import("./state.js");
    const n = normalizeAdoptedStrategies();
    if (n) log("startup", `Normalized ${n} adopted position(s) strategy spot → manual`);
  } catch (e) {
    log("startup_warn", `adopted-strategy normalization failed (non-fatal): ${e.message}`);
  }
  try {
    const n = syncConfiguredManagementProfiles();
    if (n) log("startup", `Applied ${n} pool-scoped range-harvest profile update(s)`);
  } catch (e) {
    log("startup_warn", `range-harvest profile sync failed (non-fatal): ${e.message}`);
  }
  // Publish the wallet address to state_meta so read-only consumers (dashboard)
  // resolve it from the DB instead of the stale monitor-status.json file.
  await persistWalletAddress(getWalletAddress());
  log("startup", `Persistence backend: ${(process.env.PERSIST_BACKEND || "json").toLowerCase()}`);
  ensureAgentId();
  bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  startHiveMindBackgroundSync();
}

const DEPLOY = config.management.deployAmountSol;

// Per-position last VALUATION seen by the exit evaluators (audit 01 §8, 2026-09-25).
// 82% of consecutive 5 s poller ticks repeat the previous PnL reading (the valuation
// refreshes ~every 15 s), so "N consecutive ticks" was mostly one valuation seen N
// times: a single spurious reading confirmed peaks and exit signals on its own
// (GO-SOL closed on a one-valuation +1.01% blip; a +223% blip fired take-profit).
// Confirmation now only advances on a DISTINCT valuation, and a positive PnL jump
// larger than pnlJumpSuspectPp between two valuations is treated as suspect for as
// long as that reading persists (downward jumps are left alone: crashes are real).
const _lastValuation = new Map(); // position -> { key, pnl, suspect }
function assessValuation(p) {
  const key = `${p.pnl_pct}|${p.active_bin}|${p.total_value_usd ?? ""}`;
  const last = _lastValuation.get(p.position);
  if (last && last.key === key) {
    if (last.suspect) p.pnl_pct_suspicious = true;
    return { fresh: false, suspect: !!last.suspect };
  }
  let suspect = false;
  const cap = Number(config.management?.pnlJumpSuspectPp ?? 15);
  if (last && cap > 0 && Number.isFinite(last.pnl) && Number.isFinite(Number(p.pnl_pct))) {
    const jump = Number(p.pnl_pct) - last.pnl;
    if (jump > cap) {
      suspect = true;
      log("pnl_jump", `[PNL_JUMP] ${p.pair}: +${jump.toFixed(2)}pp in one valuation (${last.pnl.toFixed(2)}% → ${Number(p.pnl_pct).toFixed(2)}%) — treating as suspect, exit rules and peak confirmation skipped while it persists`);
    }
  }
  _lastValuation.set(p.position, { key, pnl: Number(p.pnl_pct), suspect });
  if (suspect) p.pnl_pct_suspicious = true;
  return { fresh: true, suspect };
}

/** Clear price history for a closed position. */
function clearPriceHistory(positionAddress) {
  clearRecentActiveBins(positionAddress);
  _lastValuation.delete(positionAddress);
  _binTrail.delete(positionAddress);
  _rugTrail.delete(positionAddress);
  _crashFired.delete(positionAddress);
  _socketBinTrail.delete(positionAddress);
  _socketCrashEpisode.delete(positionAddress);
  _lastSmartMoneyExodusCheck.delete(positionAddress);
}

// Positions where the crash/rug fast-path fired this process (cleared on close).
const _crashFired = new Set(); // position_address
const _lastSmartMoneyExodusCheck = new Map(); // position_address -> timestamp

// ─── Price-crash fast-path (plan #04) ──────────────────────────
// Velocity-gated downside-break detector, hooked into the PnL poller tick.
// In-process only (like _recentActiveBins) — never persisted, so a detector
// fault can never corrupt state. Pure + total: returns {crash,reason} | null,
// never throws (caller also wraps in try/catch).
// Three gates: (1) OOR-below only — never fires up-range or in-range;
// (2) already ≥ crashMinBinDistance bins below the lower edge (anti-flicker);
// (3) downward velocity ≥ crashBinsPerMin sustained over ≥ crashMinSpanSec.
// See docs/plans/04-price-crash-fastpath.md for the bin math + thresholds.
const _binTrail = new Map(); // position_address -> [{ t: ms, bin: number }]

// ─── In-range rug detector (TrumpCoin 2026-07-14 class) ────────
// The crash fast-path above only fires OOR-below — a rug that dumps INSIDE a wide
// bid ladder (117 bins bought the collapse "at 100% efficiency", then the drained
// pool charged 48.9% exit slippage) is invisible to it. This sibling fires while
// STILL IN RANGE when descent velocity is high AND PnL is already meaningfully
// negative. The joint gate is the empirical separator (12-position tick study,
// 2026-07-15): winners dip at up to ~11 b/min and flat pools spike to 18 b/min at
// pnl≈0, but only genuine dumps combine ≥12 b/min with pnl ≤ −3%. Own trail with
// a longer window — extending _binTrail's cutoff would dilute the crash detector's
// first-vs-last velocity math. In-process only; pure + total like detectPriceCrash.
const _rugTrail = new Map(); // position_address -> [{ t: ms, bin: number }]

function detectInRangeRug(position, tick, cfg, now = Date.now()) {
  const activeBin = tick.active_bin != null ? Number(tick.active_bin) : null;
  const lowerBin  = tick.lower_bin  != null ? Number(tick.lower_bin)  : null;
  const pnlPct    = tick.pnl_pct    != null ? Number(tick.pnl_pct)    : null;
  if (!Number.isFinite(activeBin) || !Number.isFinite(lowerBin)) return null;

  const trail = _rugTrail.get(position) ?? [];
  trail.push({ t: now, bin: activeBin });
  const cutoff = now - Number(cfg.rugWindowSec ?? 300) * 1000;
  while (trail.length && trail[0].t < cutoff) trail.shift();
  _rugTrail.set(position, trail);

  if (activeBin < lowerBin) return null;                              // GATE 1: in-range only (below = crash detector's turf)
  if (!Number.isFinite(pnlPct) || pnlPct > Number(cfg.rugMaxPnlPct ?? -3)) return null; // GATE 2: already losing
  if (trail.length < 2) return null;
  const first = trail[0], last = trail[trail.length - 1];
  const spanSec = (last.t - first.t) / 1000;
  if (spanSec < Number(cfg.rugMinSpanSec ?? 60)) return null;         // GATE 3a: min time base
  const binsDropped = first.bin - last.bin;
  if (binsDropped < Number(cfg.rugMinBinsDropped ?? 10)) return null; // GATE 3b: min depth
  const binsPerMin = binsDropped / (spanSec / 60);
  if (binsPerMin < Number(cfg.rugBinsPerMin ?? 12)) return null;      // GATE 3c: velocity
  return {
    rug: true,
    reason: `in-range rug ${binsDropped} bins/${spanSec.toFixed(0)}s ` +
            `(${binsPerMin.toFixed(1)} b/min ≥ ${cfg.rugBinsPerMin ?? 12}, pnl ${pnlPct.toFixed(2)}% ≤ ${cfg.rugMaxPnlPct ?? -3}%)`,
  };
}

// Shared crash-gate math (pure): same three gates for the poller-fed detector and
// the socket-fed shadow twin below. Callers own their trails — this never mutates.
function evaluateCrashGatesOnTrail(trail, activeBin, lowerBin, cfg) {
  if (!(activeBin < lowerBin)) return null;                          // GATE 1: OOR-below only
  const distBelow = lowerBin - activeBin;
  if (distBelow < Number(cfg.crashMinBinDistance ?? 8)) return null; // GATE 2: min distance
  if (trail.length < 2) return null;
  const first = trail[0], last = trail[trail.length - 1];
  const spanSec = (last.t - first.t) / 1000;
  if (spanSec < Number(cfg.crashMinSpanSec ?? 9)) return null;       // GATE 3a: min time base
  const binsDropped = first.bin - last.bin;                          // positive = price fell
  if (binsDropped <= 0) return null;                                 // net not falling
  const binsPerMin = binsDropped / (spanSec / 60);
  if (binsPerMin < Number(cfg.crashBinsPerMin ?? 12)) return null;   // GATE 3b: velocity
  return { distBelow, spanSec, binsDropped, binsPerMin };
}

function detectPriceCrash(position, tick, cfg, now = Date.now()) {
  const activeBin = tick.active_bin != null ? Number(tick.active_bin) : null;
  const lowerBin  = tick.lower_bin  != null ? Number(tick.lower_bin)  : null;
  if (!Number.isFinite(activeBin) || !Number.isFinite(lowerBin)) return null;

  // Maintain the trail regardless of range state (so history exists the
  // moment the position goes OOR), trimmed to the trailing window.
  const trail = _binTrail.get(position) ?? [];
  trail.push({ t: now, bin: activeBin });
  const cutoff = now - Number(cfg.crashWindowSec ?? 90) * 1000;
  while (trail.length && trail[0].t < cutoff) trail.shift();
  _binTrail.set(position, trail);

  const hit = evaluateCrashGatesOnTrail(trail, activeBin, lowerBin, cfg);
  if (!hit) return null;
  return {
    crash: true,
    reason: `crash-below ${hit.binsDropped} bins/${hit.spanSec.toFixed(0)}s ` +
            `(${hit.binsPerMin.toFixed(1)} b/min ≥ ${cfg.crashBinsPerMin ?? 12}, dist ${hit.distBelow})`,
  };
}

// ─── Socket-fed crash detection — Phase 1: SHADOW ONLY ─────────
// Every websocket lbPair write feeds a socket-side twin of the crash detector, so
// live dumps measure how much earlier the socket sees a crash than the poller.
// ZERO behavior change: never closes, never touches _binTrail/_crashFired, faults
// are swallowed. crashSocketMode: "off" | "shadow" (default). Phase 2 ("enforce")
// is deliberately NOT implemented — an unknown mode value degrades to shadow.
// Episode logs (one each per below-range episode; episode resets on range recovery):
//   armed            — first socket event where all crash gates pass
//   would-close      — Phase-2 confirm semantics met (≥ crashConfirmTicks gate-passing
//                      events spanning ≥ crashSocketConfirmSpanSec since arm)
//   poller confirmed — lead time socket→poller detection (the payoff metric)
//   recovered        — armed but price re-entered range with no poller confirm (false arm)
const _socketBinTrail = new Map();      // position_address -> [{ t, bin }]
const _socketCrashEpisode = new Map();  // position_address -> episode state

function handleSocketBinEvent(poolAddress, activeBinRaw, now) {
  const cfg = config.management;
  if (String(cfg.crashSocketMode ?? "shadow") === "off") return;
  const activeBin = Number(activeBinRaw);
  if (!Number.isFinite(activeBin)) return;
  const tracked = getTrackedPositions(true).find((p) => p.pool === poolAddress);
  if (!tracked) return;
  const lowerBin = Number(tracked.bin_range?.min);
  if (!Number.isFinite(lowerBin)) return;
  const pos = tracked.position;

  const trail = _socketBinTrail.get(pos) ?? [];
  trail.push({ t: now, bin: activeBin });
  const cutoff = now - Number(cfg.crashWindowSec ?? 90) * 1000;
  while (trail.length && trail[0].t < cutoff) trail.shift();
  _socketBinTrail.set(pos, trail);

  const ep = _socketCrashEpisode.get(pos);
  if (activeBin >= lowerBin) {
    // Back in range: close out the episode. An arm with no poller confirm is the
    // false-arm case Phase 2 must not fire on — log it with the wick duration.
    if (ep && !ep.pollerLogged) {
      log("crash_socket_shadow", `[CRASH_SOCKET_SHADOW] recovered ${tracked.pair}: back in range ${((now - ep.armedAt) / 1000).toFixed(0)}s after arm, poller never confirmed (false arm)`);
    }
    _socketCrashEpisode.delete(pos);
    return;
  }

  const hit = evaluateCrashGatesOnTrail(trail, activeBin, lowerBin, cfg);
  if (!hit) return;

  if (!ep) {
    _socketCrashEpisode.set(pos, { armedAt: now, confirms: 1, wouldCloseLogged: false, pollerLogged: false });
    log("crash_socket_shadow", `[CRASH_SOCKET_SHADOW] armed ${tracked.pair}: ${hit.binsDropped} bins/${hit.spanSec.toFixed(0)}s (${hit.binsPerMin.toFixed(1)} b/min, dist ${hit.distBelow})`);
    return;
  }
  ep.confirms += 1;
  const confirmSpanSec = (now - ep.armedAt) / 1000;
  const needed = Math.max(1, Number(cfg.crashConfirmTicks ?? 3));
  if (!ep.wouldCloseLogged && ep.confirms >= needed && confirmSpanSec >= Number(cfg.crashSocketConfirmSpanSec ?? 15)) {
    ep.wouldCloseLogged = true;
    log("crash_socket_shadow", `[CRASH_SOCKET_SHADOW] would-close ${tracked.pair} ${confirmSpanSec.toFixed(0)}s after arm (${ep.confirms} confirming events — Phase 2 would fire here)`);
  }
}

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _pnlDiscoveryRetryTimer = null;
let _managementBusy = false; // prevents overlapping management cycles
let _mgmtCycleCount = 0; // drives the periodic dust-sweep cadence (every ~10th cycle)
let _screeningBusy = false;  // prevents overlapping screening cycles

let _skimProposalNotifiedAt = 0; // plan #15 item 4: skim-proposal Telegram rate limit

let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
// Declined-candidates suppressor: when a screening LLM decision declines a candidate set,
// remember its fingerprint and skip re-asking the LLM about the IDENTICAL set for
// opportunity.retriggerCooldownMin. Any change in the set (new pool, one drops out)
// changes the fingerprint and re-enables the LLM immediately. Covers all trigger paths
// (cron, post-management, opportunity poll). In-memory — clears on restart.
let _lastDeclinedCandidates = { fp: null, at: 0 };
// Per-pool NO-DEPLOY verdict cache (Charon decision-cache pattern, 2026-07-30).
// Finer-grained sibling of the fingerprint suppressor above: that one only skips
// when the ENTIRE candidate set is identical; this one skips when every candidate
// individually carries a recent NO-DEPLOY verdict with unmoved metrics (mcap
// within ±20%, holders within ±30% of judgment time — the drift bounds that
// invalidate a verdict). Cuts redundant LLM burn during droughts where the same
// 1-3 pools cycle through screening for hours (LLM quota). Entries
// only written on a genuine judgment decline (not no-tool fallbacks, not failed
// deploy attempts); cleared entirely on any successful deploy. In-memory.
const _verdictCache = new Map(); // pool_address → { at, mcap, holders, name }
let _lastNotifiedMgmtSig = null; // last management state (status+action+set) we notified on — suppresses unchanged "all STAY" spam
// Persisted separately from the last-outbound marker so these ids survive a PM2
// restart without allowing another worker's direct message to be overwritten.
let _lastMgmtMsgId = readRollingMessageId("management"); // message_id of the rolling management-cycle bubble
let _lastScreenMsgId = readRollingMessageId("screening"); // message_id of the rolling screening-cycle bubble

function rememberRollingMessage(role, messageId) {
  const currentId = messageId ?? null;
  if (role === "management") {
    const previousId = _lastMgmtMsgId;
    _lastMgmtMsgId = currentId;
    if (currentId != null) recordRollingMessageId(role, currentId);
    else clearRollingMessageId(role, previousId);
    return;
  }
  if (role === "screening") {
    const previousId = _lastScreenMsgId;
    _lastScreenMsgId = currentId;
    if (currentId != null) recordRollingMessageId(role, currentId);
    else clearRollingMessageId(role, previousId);
  }
}

// The management and screening bubbles alternate every few minutes, so requiring a
// bubble to be THE last outbound message meant each stream permanently invalidated
// the other — both posted a brand-new message every cycle (audited 2026-08-21: the
// chat was one full-size cycle report every 3 minutes, the roll never held). The two
// rolling bubbles sit adjacent at the bottom of the chat, so either of them being
// last means nothing REAL (deploy/close/alert/briefing) has interposed — each stream
// still edits only its OWN bubble.
function isRollingBubbleLast() {
  const last = readLastOutboundId();
  return last != null && (last === _lastMgmtMsgId || last === _lastScreenMsgId);
}
let _lastTickNotify = 0; // epoch ms — throttles the meridian_tick pg NOTIFY to at most 1/2s (runs synchronously with PnL poll)
// The IPC file is intentionally global because one management cycle evaluates
// every open position. A flapping OOR position must not start another cycle on
// every socket transition while the previous result is still fresh.
const FORCE_SYNC_MIN_INTERVAL_MS = 60 * 1000;
let _lastForceSyncAt = 0;

// Position addresses in the most recent dashboard-report publish — lets the
// PnL poller detect a fresh deploy the report doc doesn't know about yet and
// fast-publish, instead of leaving the dashboard's card degraded (bin-id
// "prices", zero token lines) until the next management cycle.
let _lastReportPositionSet = new Set();
function publishReportTracked(args) {
  try {
    publishDashboardReport(args);
    _lastReportPositionSet = new Set((args.positions || []).map((p) => p.position).filter(Boolean));
  } catch (e) {
    try { log("cron_warn", `report publish failed (non-fatal): ${e.message}`); } catch { /* never throw */ }
  }
}
// Exit/peak confirmation is now done by consecutive-tick counting in state.js
// (registerExitSignal / confirmPeak), driven by the 3s RPC poller — no setTimeout rechecks.

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const data = await generateBriefingData();
    if (telegramEnabled()) {
      await sendHTML(data.raw_text);
    }
    setLastBriefingDate();
    await saveDailyBriefing(data);
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  setPositionDiscoveryTrigger(null);
  setPositionDiscoverySignalSink(null);
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_cronTasks._pnlDiscoveryInterval) clearInterval(_cronTasks._pnlDiscoveryInterval);
  if (_cronTasks._adoptionBurstInterval) clearInterval(_cronTasks._adoptionBurstInterval);
  if (_pnlDiscoveryRetryTimer) {
    clearTimeout(_pnlDiscoveryRetryTimer);
    _pnlDiscoveryRetryTimer = null;
  }
  if (_cronTasks._opportunityPollInterval) clearInterval(_cronTasks._opportunityPollInterval);
  _cronTasks = [];
  try {
    stopSocketMonitor();
  } catch (e) {
    log("cron_error", `Failed to stop WebSocket active bin monitor: ${e.message}`);
  }
}

/**
 * Post-close outcome probes (plan #05). Scan-based and idempotent — no timers, so
 * restarts just pick up due slots on the next cycle. Scans recent perf records
 * (newest-first, early-stopping past the probe horizon +1h since the list is
 * append-ordered) and fetches the pool's current mcap for any due, unfilled
 * configured slot. Slots that missed their grace window (restart gap) are
 * marked stale rather than retried forever. Exit-review Telegram notification
 * is emitted when the m60 anchor is written (or m180 fallback), while longer
 * slots remain analytics-only. 0–2 fetches/cycle in steady state.
 */
async function runPostCloseProbes() {
  const mins = (Array.isArray(config.management.postCloseProbeMinutes) && config.management.postCloseProbeMinutes.length)
    ? config.management.postCloseProbeMinutes
    : [30, 60, 180];
  const maxAgeMin = Math.max(...mins) + 60;
  const graceMin = 20;
  const now = Date.now();
  for (const perf of [...getAllPerformance()].reverse()) { // newest-first
    const ageMin = (now - Date.parse(perf.recorded_at)) / 60000;
    if (!Number.isFinite(ageMin)) continue;
    if (ageMin > maxAgeMin) break; // append-ordered → everything older is done or out of scope
    if (perf.post_close?.complete) continue;
    if (perf.exit_mcap == null) { markPostCloseUnprobeable(perf.position); continue; }
    for (const m of mins) {
      if (perf.post_close?.[`m${m}`] != null) continue; // idempotent
      if (ageMin < m) continue;                          // not due yet
      if (ageMin >= m + graceMin) {                      // missed its window (restart gap)
        recordPostCloseProbe(perf.position, m, { status: "stale", minutes: mins });
        continue;
      }
      try {
        const detail = await getPoolDetail({ pool_address: perf.pool, timeframe: "5m" });
        const mcap = parseFloat(detail?.token_x?.market_cap) || null;
        recordPostCloseProbe(perf.position, m, { mcap, minutes: mins });
        log("probe", `Post-close m${m} for ${perf.pool_name || perf.pool.slice(0, 8)}: mcap ${mcap ?? "n/a"} (exit ${perf.exit_mcap})`);
      } catch {
        recordPostCloseProbe(perf.position, m, { status: "delisted", minutes: mins });
        log("probe", `Post-close m${m} for ${perf.pool_name || perf.pool.slice(0, 8)}: pool gone from discovery API → delisted`);
      }
    }
  }
}

/**
 * End-of-cycle maintenance, shared by BOTH management-cycle paths (with
 * positions and the zero-positions early return — probes are due precisely
 * after closes empty the book). Post-close probes every cycle; dust sweep
 * after any close, on the first cycle after boot, and every ~10th cycle.
 * Each pass is individually contained — a failure never affects the cycle.
 */
async function runPostCloseMaintenance({ closedCount = 0 } = {}) {
  if (config.management.postCloseProbeEnabled) {
    try { await runPostCloseProbes(); }
    catch (e) { log("probe_warn", `Post-close probe pass failed (non-fatal): ${e.message}`); }
  }
  _mgmtCycleCount++;
  if (config.management.dustSweepEnabled && (closedCount > 0 || _mgmtCycleCount % 10 === 1)) {
    try { await sweepWalletDust(); }
    catch (e) { log("cron_warn", `Dust sweep failed (non-fatal): ${e.message}`); }
  }
}

/**
 * Execute the actions decided by the deterministic rules. CLOSE/CLAIM run directly
 * via executeTool (no LLM) — preserving all post-effects (notify, auto-swap,
 * recordPerformance, decision-log, HiveMind). INSTRUCTION positions (free-text
 * condition) and REVIEW positions (health-alert judgment) — which JS can't evaluate —
 * are handed to the MANAGER LLM. Returns a one-line-per-position result string.
 */
// Tools whose execution means the cycle actually changed position/on-chain state
// (as opposed to read-only judgment). Used to decide whether the cycle's Telegram
// finalize must be a NEW, notifying message instead of a silent bubble edit.
const STATE_CHANGING_TOOLS = new Set(["close_position", "claim_fees", "swap_token"]);

// Exit urgency (may skip closePosition's redundant pre-close claim, fastCloseSkipClaim)
// travels on the exit object itself (`urgent`, stamped by state.js finalizeExit) —
// the single evaluator is the only source of exit objects besides the crash/rug
// fast paths below, which build the same shape.
const EXIT_LABEL = {
  young_stop: "Young stop", stop_loss: "Stop loss", trailing_tp: "Trailing TP", take_profit: "Take profit",
  round_trip: "Round-trip harvest", pumped_above: "Pumped above", unfilled_above: "Unfilled ladder",
  oor_below: "OOR below", oor_above: "OOR above", low_yield: "Low yield", surge_decay: "Surge decay",
  toxic_conversion: "Toxic conversion", crash: "Crash fast-path",
};
// A rate-limited RPC close should not be retried on every 5-second PnL tick.
// Keep this in-process because it is only a safety valve for a transient
// provider outage; a restart naturally gives the endpoint health pool a fresh
// chance while exponential backoff prevents a live failure storm.
const _closeRetryState = new Map();
const CLOSE_RETRY_INITIAL_MS = 30_000;
const CLOSE_RETRY_MAX_MS = 5 * 60_000;

async function executeManagementActions(actionPositions, actionMap, { liveMessage = null, cur = "$", onStateChange = null } = {}) {
  const lines = [];
  // Fired as soon as this cycle does something that changes on-chain/position
  // state (close/flip/claim). The caller uses it to finalize the cycle with a
  // NEW Telegram message instead of a silent in-place edit — an edit produces no
  // push notification, so mechanical closes were landing unannounced.
  const markStateChanged = () => { try { onStateChange?.(); } catch { /* never break the cycle on a notify concern */ } };
  // INSTRUCTION (free-text condition) and REVIEW (health-alert judgment) need the LLM;
  // CLOSE/CLAIM run mechanically.
  const llmActions = new Set(["INSTRUCTION", "REVIEW"]);
  const llmPositions = [];

  const mechanical = actionPositions.filter(p => !llmActions.has(actionMap.get(p.position).action));
  if (mechanical.length) {
    log("cron", `Management: executing ${mechanical.length} mechanical action(s) — no LLM`);
  }

  for (const p of actionPositions) {
    const act = actionMap.get(p.position);
    if (getTrackedPosition(p.position)?.hold_mode === true && act.action !== "CLAIM" && act.action !== "STAY") {
      log("safety_block", "Automatic " + act.action.toLowerCase() + " suppressed for " + p.pair + ": operator HOLD is active");
      lines.push(p.pair + ": " + act.action.toLowerCase() + " suppressed — On Hold");
      continue;
    }
    if (llmActions.has(act.action)) { llmPositions.push(p); continue; }

    if (act.action === "STRADDLE") {
      // Harvest → straddle (operator technique): rebalance_position with straddle=true.
      // Refused before the close (executor gates: pool validation, chain depth) → plain
      // close below. Aborted after the close → the leg is already cash; nothing to do.
      markStateChanged();
      const sp = act.straddle || {};
      const sctx = { pair: p.pair, reason: act.reason, key: `straddle:${p.position}` };
      await liveMessage?.toolStart("rebalance_position", sctx);
      const res = await executeTool("rebalance_position", {
        position_address: p.position,
        target_strategy: sp.shape || "spot",
        bins_below: sp.bins ?? 34,
        bins_above: sp.bins ?? 34,
        straddle: true,
        straddle_ratio: sp.ratio ?? 0.5,
        straddle_max_impact_pct: sp.maxImpactPct ?? 3,
        in_place: sp.inPlace !== false,
        lane: "straddle",
        reason: `harvest straddle: ${act.reason}`,
      }).catch((e) => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("rebalance_position", res, ok, sctx);
      if (ok) {
        lines.push(`${p.pair}: harvest → straddle${res.in_place ? " in place" : ""} ${res.bin_range?.min}..${res.bin_range?.max} (${res.strategy}, ◎${Number(res.amount_sol || 0).toFixed(3)} + ${res.amount_x} base)${res.in_place ? "" : ` → ${String(res.position || "").slice(0, 8)}`}`);
        continue;
      }
      if (res?.in_place && res?.position_intact) {
        lines.push(`${p.pair}: straddle ${res.aborted ? "aborted" : "failed"} at stage ${res.stage} — position intact (${res.error})`);
        continue;
      }
      if (res?.closed_leg) {
        lines.push(`${p.pair}: straddle aborted after the close — cashed out (${res.error || res.reason})`);
        continue;
      }
      log("straddle", `[STRADDLE] ${p.pair}: rebalance refused before the close (${res?.error || res?.reason}) — closing to cash`);
      act.action = "CLOSE";
    }

    if (act.action === "CLOSE") {
      const reason = act.reason || (act.rule ? `Rule ${act.rule}` : "rule close");
      const retryState = _closeRetryState.get(p.position);
      if (retryState && Date.now() < retryState.retryAt) {
        const waitSeconds = Math.ceil((retryState.retryAt - Date.now()) / 1000);
        lines.push(`${p.pair}: close deferred — RPC retry backoff (${waitSeconds}s)`);
        continue;
      }
      markStateChanged(); // announce even if the close ultimately fails — a failed close matters too
      const closeCtx = { pair: p.pair, reason, key: `close:${p.position}` };
      await liveMessage?.toolStart("close_position", closeCtx);
      const res = await executeTool("close_position", {
        position_address: p.position,
        reason,
        urgent: act.urgent === true,
        exit_context: act.exit_context || null,
      }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("close_position", res, ok, closeCtx);
      if (ok) {
        _closeRetryState.delete(p.position);
      } else {
        const errorText = String(res?.error || res?.reason || "");
        const rateLimited = /429|too many requests|rate.?limit|rpc/i.test(errorText);
        if (rateLimited) {
          const delayMs = Math.min(
            retryState?.delayMs ? retryState.delayMs * 2 : CLOSE_RETRY_INITIAL_MS,
            CLOSE_RETRY_MAX_MS,
          );
          _closeRetryState.set(p.position, { retryAt: Date.now() + delayMs, delayMs });
          log("cron_warn", `[CLOSE_BACKOFF] ${p.pair}: RPC/rate-limit failure; retrying in ${Math.round(delayMs / 1000)}s`);
        }
      }
      // escapeHTML: these lines land in a parse_mode=HTML Telegram message, and close
      // reasons routinely contain "<=" (e.g. "stop loss: pnl -20.71% <= limit -15.00%").
      // Telegram reads that as a malformed tag and 400s the send; telegram.js then
      // retries as raw plain text, so nothing was lost — but the message arrived
      // unformatted. 37 sends degraded this way between 2026-06-22 and 07-25.
      lines.push(`${p.pair}: ${ok ? `closed (${escapeHTML(reason)})` : `close FAILED — ${escapeHTML(res?.error || res?.reason || "unknown")}`}`);
    } else if (act.action === "CLAIM") {
      markStateChanged();
      const feeSol = p.unclaimed_fees_usd;
      const feeUsd = p.unclaimed_fees_true_usd;
      const feeStr = config.management.solMode
        ? `◎${Number(feeSol ?? 0).toFixed(4)}${feeUsd ? ` / $${Number(feeUsd).toFixed(2)}` : ""}`
        : `$${Number(feeSol ?? 0).toFixed(2)}`;
      const claimCtx = { pair: p.pair, detail: feeStr, feeSol, feeUsd, key: `claim:${p.position}` };
      await liveMessage?.toolStart("claim_fees", claimCtx);
      const res = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("claim_fees", res, ok, claimCtx);
      lines.push(`${p.pair}: ${ok ? "fees claimed" : `claim FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    }
  }

  // INSTRUCTION positions (free-text condition) and REVIEW positions (health alert fired)
  // need the LLM to judge — JS can't evaluate them.
  if (llmPositions.length > 0) {
    log("cron", `Management: ${llmPositions.length} position(s) need LLM judgment (instruction/review) — invoking LLM [model: ${config.llm.managementModel}]`);
    const actionBlocks = llmPositions.map((p) => {
      const act = actionMap.get(p.position);
      // Bin drift over the last ~30 min (10 snapshots at 3-min cycles) — gives the
      // LLM price direction/momentum, not just the current point-in-time bin.
      // Snapshots are per-pool; filter to THIS position so a redeploy into the
      // same pool can't splice another position's history into the trend.
      let driftLine = null;
      try {
        const snaps = getPoolSnapshots(p.pool).filter((s) => s.position === p.position && s.active_bin != null);
        if (snaps.length >= 2 && p.active_bin != null) {
          const back = snaps[Math.max(0, snaps.length - 10)];
          const drift = Number(p.active_bin) - Number(back.active_bin);
          const spanMin = Math.max(1, Math.round((Date.now() - new Date(back.ts).getTime()) / 60000));
          const dir = drift < 0 ? "falling" : drift > 0 ? "rising" : "flat";
          driftLine = `  bin_drift: ${drift >= 0 ? "+" : ""}${drift} bins over ${spanMin}m (${dir})`;
        }
      } catch { /* advisory only — never block the judgment prompt */ }
      return [
        `POSITION: ${p.pair} (${p.position})`,
        `  pool: ${p.pool}`,
        `  action: ${act.action}${act.reason ? ` (${act.reason})` : ""}`,
        `  pnl_pct: ${p.pnl_pct}%${p.pnl_pct_derived != null ? ` (incl_fees: ${p.pnl_pct_derived}%)` : ""} | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
        `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
        driftLine,
        p.health?.alerts?.length ? `  health_alerts: ${p.health.alerts.map((a) => a.message).join("; ")}` : null,
        p.pvp ? `  pvp_alert: rival ${p.pvp.rival_name} (${p.pvp.rival_mint.slice(0, 8)}…) has pool tvl=$${p.pvp.rival_tvl}, holders=${p.pvp.rival_holders}, fees=${p.pvp.rival_fees}SOL` : null,
        p.instruction ? `  instruction: "${p.instruction}"` : null,
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    const { content } = await agentLoop(`
MANAGEMENT JUDGMENT REQUIRED — ${llmPositions.length} position(s)

${actionBlocks}

RULES:
- INSTRUCTION: evaluate the instruction condition against the live data. If MET → call close_position (it claims fees internally; do NOT call claim_fees first). If NOT met → HOLD, do nothing.
- REVIEW: a health alert fired (yield decay / fee-share dilution / volume death). Call get_position_pnl and judge: close_position ONLY if yield has genuinely vanished or the pool is dying; otherwise HOLD. Bias to hold.
- pvp_alert: a rival mint with the same symbol has emerged. This is informational — note it in your result but do NOT close solely for PVP. Only factor it if combined with other negatives (yield decay, OOR, etc).

After evaluating, write a brief one-line result per position.
    `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
      onToolStart: async ({ name, input }) => {
        const pair = input?.position_address ? actionPositions.find(p => p.position === input.position_address)?.pair : null;
        await liveMessage?.toolStart(name, { pair, key: input?.position_address ? `${name}:${input.position_address}` : name });
      },
      onToolFinish: async ({ name, input, result, success }) => {
        // An LLM-judged INSTRUCTION/REVIEW position can be closed by the model
        // itself — treat that as state-changing too, so the cycle finalizes with
        // a real (notifying) message rather than a silent bubble edit.
        if (STATE_CHANGING_TOOLS.has(name)) markStateChanged();
        const pair = input?.position_address ? actionPositions.find(p => p.position === input.position_address)?.pair : null;
        await liveMessage?.toolFinish(name, result, success, { pair, key: input?.position_address ? `${name}:${input.position_address}` : name });
      },
    });
    if (content) lines.push(content);
  }

  return lines.join("\n");
}

// silent: notify only when an action is needed (poll/trailing rechecks).
// quiet:  notify on action OR a change vs the last notified cycle (routine cron) —
//         suppresses the every-interval "all STAY" repeats.
// neither: always notify (manual /forcesync, explicit runs).
export async function runManagementCycle({ silent = false, quiet = false } = {}) {
  if (_managementBusy || _commandCloseInFlight || busy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  writeHeartbeat("management");

  // Log heap usage and telemetry warning if > 70% of 2048MB
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  log("memory", `Heap usage: ${heapUsedMb} MB / 2048 MB (limit)`);
  if (heapUsedMb > 1433) {
    log("memory_warn", `Heap usage is high: ${heapUsedMb} MB (> 70% of limit)`);
    recordError("memory_warning", `High memory usage: ${heapUsedMb} MB`);
  }

  // Tag the model, mirroring the screening cycle line. Without it there is no
  // per-cycle record of which model handled a management decision (a provider
  // error silently falls back to the fallback model).
  log("cron", `Starting management cycle [model: ${config.llm.managementModel}]`);
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  let needsAction = [];
  let mgmtSig = null; // status+action+composition fingerprint for change detection
  let cycleFailed = false; // force-notify on error even in quiet mode
  // Set when this cycle closes/flips/claims. Such a cycle must finalize with a
  // NEW Telegram message (which pushes a notification) — the default in-place
  // bubble edit is silent, which is why real closes went unannounced.
  let stateChanged = false;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      // Reuse (edit) the previous management bubble when the chat still ends in
      // the rolling-bubble pair (mgmt or screening); start a fresh one if anything
      // else (deploy/close/alert, other processes) has posted since.
      const canReuse = _lastMgmtMsgId != null && isRollingBubbleLast();
      liveMessage = await createLiveMessage("🔄 Management Cycle", "🔍 Scanning portfolio positions...", {
        role: "management",
        reuseMessageId: canReuse ? _lastMgmtMsgId : null,
      });
      rememberRollingMessage("management", liveMessage?.getMessageId?.());
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];
    if (positions.length > 0) {
      await liveMessage?.note(`📊 Evaluating ${positions.length} active position(s)...`);
    }

    if (positions.length === 0) {
      const timeSinceLastScreen = Date.now() - _screeningLastTriggered;
      if (timeSinceLastScreen > screeningCooldownMs) {
        log("cron", "No open positions — triggering screening cycle");
        mgmtReport = "No open positions. Triggering screening cycle.";
        runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      } else {
        const remainingSec = Math.round((screeningCooldownMs - timeSinceLastScreen) / 1000);
        log("cron", `No open positions — screening on cooldown (${remainingSec}s remaining)`);
        mgmtReport = `No open positions. Screening is on cooldown (${remainingSec}s remaining).`;
      }
      // Keep the dashboard fresh even with nothing open (0-position report).
      publishReportTracked({ positions: [], actions: null, nextScreenSec: null, aum: _lastSampledAum });
      // Maintenance still runs with an empty book — post-close probes are due
      // precisely AFTER closes empty it, and orphaned dust needs sweeping.
      await runPostCloseMaintenance();
      return mgmtReport;
    }

    // Snapshot + load pool memory (+ pool-level metrics for health alerts)
    const poolHealthCfg = getPoolHealthConfig(config.management);
    const positionData = await Promise.all(positions.map(async (p) => {
      let poolMetrics = null;
      if (poolHealthCfg.enabled) {
        try {
          const detail = await getPoolDetail({ pool_address: p.pool, timeframe: config.screening.timeframe });
          if (detail) {
            poolMetrics = {
              pool_tvl: Number(detail.tvl ?? detail.active_tvl) || null,
              pool_volume: Number(detail.volume) || null,
              pool_fee_active_tvl_ratio: Number(detail.fee_active_tvl_ratio) || null,
            };
          }
        } catch { /* advisory only — never block the cycle on pool detail */ }
      }
      const enriched = poolMetrics ? { ...p, ...poolMetrics } : p;
      const priorSnaps = getPoolSnapshots(p.pool).filter((s) => s.position === p.position);
      const prevSnap = priorSnaps.length > 0 ? priorSnaps[priorSnaps.length - 1] : null;
      recordPositionSnapshot(p.pool, enriched);
      const snaps = getPoolSnapshots(p.pool);
      const health = poolHealthCfg.enabled
        ? analyzePositionHealth({ position: enriched, snapshots: snaps, config: poolHealthCfg })
        : { alerts: [], review: false };
      // Count THIS position's own snapshots (isolated from any prior position in
      // the same pool) so updatePnlAndCheckExits can floor the low-yield exit on
      // real accumulated history — a just-adopted row starts at ~1 and must not be
      // judged on a missing-data fee/TVL of 0. See adoptGraceMinutes.
      const fresh_snapshots = snaps.filter((s) => s.position === p.position).length;
      return { ...enriched, recall: recallForPool(p.pool), health, fresh_snapshots, prevSnap };
    }));

    // PVP rival check for open positions
    const pvpMap = await checkPositionsPvp(positionData).catch((e) => {
      log("pvp", `PVP check failed (non-fatal): ${e.message}`);
      return new Map();
    });
    for (const p of positionData) {
      const pvp = pvpMap.get(p.position);
      if (pvp) p.pvp = pvp;
    }

    // JS exit checks. Management is the slow cron backstop: raise peak immediately
    // (confirmTicks=1) and act on detected exits directly. Real-time 2-tick
    // confirmation lives in the fast 3s poller below.
    const exitMap = new Map();
    for (const p of positionData) {
      const operatorHold = getTrackedPosition(p.position)?.hold_mode === true;
      const valuationUnsafe = p.pnl_management_ready === false;
      if (operatorHold) {
        registerExitSignal(p.position, null, 1);
        log("state", "Automatic exits suppressed for " + p.pair + ": operator HOLD is active");
      }
      if (valuationUnsafe && !operatorHold) {
        registerExitSignal(p.position, null, 1);
        log("pnl_safety", `Automatic exits suppressed for ${p.pair}: valuation is not management-ready (${p.pnl_quality || "unknown"}${p.pnl_quality_reason ? `; ${p.pnl_quality_reason}` : ""})`);
      }
      if (!operatorHold && !valuationUnsafe) {
        const valuation = assessValuation(p);
        if (!valuation.suspect) confirmPeak(p.position, p.pnl_pct, 1);
        // Single ordered evaluator (state.js) + the close-efficiency gate.
        const exit = await applyExitGates(p, updatePnlAndCheckExits(p.position, p, config.management));
        if (exit) {
          exitMap.set(p.position, exit); // the full exit object — urgency/family/rule travel with it
          log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
        }
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM) | REVIEW (needs LLM)
    const actionMap = new Map();
    let _claimPriceWarned = false; // rate-limit the cold-start price warning to once per cycle
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, await buildExitAction(p, exitMap.get(p.position)));
        continue;
      }
      const tracked = getTrackedPosition(p.position);
      if (tracked?.hold_mode === true) {
        // Hold-cohort visibility (audit 01 §4.3): no rule touches a held position, but the
        // operator is told when it has given back another 10 pp from its confirmed peak.
        try {
          const gb = evaluateHoldGiveBack(tracked, p.pnl_pct, config.management);
          if (gb.alert) {
            noteHoldGiveBackAlert(p.position, gb.level_pp);
            const amt = Number(tracked.amount_sol) || 0;
            const giveBackSol = amt > 0 ? (gb.drop_pp / 100) * amt : null;
            const solText = giveBackSol != null ? `, ≈◎${giveBackSol.toFixed(3)} unrealised` : "";
            log("hold_giveback", `[HOLD_GIVEBACK] ${p.pair}: peak ${gb.peak.toFixed(2)}% → now ${gb.current.toFixed(2)}% (−${gb.drop_pp.toFixed(1)} pp${solText}) — held position, no rule fires`);
            sendHTML(
              `🧊 <b>Held position giving back</b>\n${escapeHTML(p.pair)}: peak ${fmtPct(gb.peak)} → now ${fmtPct(gb.current)} (−${gb.drop_pp.toFixed(1)} pp${solText}).\nHold mode is yours — the bot will not close it. /unset hands it back to the rules.`
            ).catch(() => {});
          } else if (gb.reset) {
            noteHoldGiveBackAlert(p.position, 0);
          }
        } catch (e) {
          log("hold_giveback_warn", `[HOLD_GIVEBACK] ${p.pair}: ${e.message}`);
        }
        let holdClaimThresholdSol = config.management.minClaimAmount;
        if (config.management.solMode) {
          const solPx = getSolPriceUsd();
          holdClaimThresholdSol = solPx > 0 ? config.management.minClaimAmount / solPx : Infinity;
        }
        if ((p.unclaimed_fees_usd ?? 0) >= holdClaimThresholdSol) {
          actionMap.set(p.position, { action: "CLAIM", hold_mode: true });
        } else {
          actionMap.set(p.position, { action: "STAY", hold_mode: true });
        }
        continue;
      }
      if (p.pnl_management_ready === false) {
        actionMap.set(p.position, {
          action: "STAY",
          pnl_quality: p.pnl_quality || "unknown",
          reason: `automatic management paused: ${p.pnl_quality_reason || p.pnl_quality || "valuation not ready"}`,
        });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      // Claim rule — unit-aware. Unit landmine (CLAUDE.md): under solMode the
      // `*_usd` fields (incl. unclaimed_fees_usd) carry SOL, while minClaimAmount
      // is configured in USD. Convert the USD floor to SOL via the cached price so
      // the comparison is apples-to-apples; if no price is known yet (cold start)
      // skip claiming this tick rather than compare mismatched units.
      let claimThresholdSol = config.management.minClaimAmount;
      if (config.management.solMode) {
        const solPx = getSolPriceUsd();
        if (solPx > 0) {
          claimThresholdSol = config.management.minClaimAmount / solPx;
        } else {
          claimThresholdSol = Infinity; // conservative: never claim without a price
          if (!_claimPriceWarned) {
            log("cron_warn", "CLAIM skipped this cycle: SOL price unavailable (cold start) — cannot convert minClaimAmount USD→SOL");
            _claimPriceWarned = true;
          }
        }
      }
      if ((p.unclaimed_fees_usd ?? 0) >= claimThresholdSol) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      // Health-alert review (only when autoReview is enabled; advisory otherwise)
      if (p.health?.review && p.health.alerts?.length) {
        actionMap.set(p.position, { action: "REVIEW", reason: p.health.alerts.map((a) => a.code).join(", ") });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build HTML report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);
    // True-USD sums for dual display (the *_usd fields above carry SOL under solMode)
    const totalValueTrueUsd = positionData.reduce((s, p) => s + (p.total_value_true_usd ?? 0), 0);
    const totalUnclaimedTrueUsd = positionData.reduce((s, p) => s + (p.unclaimed_fees_true_usd ?? 0), 0);
    // Dual-currency renderer: solMode → "◎X ($Y)", plain USD otherwise.
    const dualCur = (val, trueUsd, dec = 4) => config.management.solMode
      ? `◎${Number(val ?? 0).toFixed(dec)}${trueUsd != null && trueUsd !== 0 ? ` ($${Number(trueUsd).toFixed(2)})` : ""}`
      : `$${Number(val ?? 0).toFixed(2)}`;

    const reportLines = positionData.map((p, index) => {
      const act = actionMap.get(p.position);
      
      const activeBin = p.active_bin != null ? Number(p.active_bin) : null;
      const lowerBin = p.lower_bin != null ? Number(p.lower_bin) : null;
      const upperBin = p.upper_bin != null ? Number(p.upper_bin) : null;
      
      let OorDetail = "";
      let statusText = "🟢 IN RANGE";

      if (p.in_range === false) {
        let direction = "OOR";
        let binDiff = 0;
        // Direction-specific auto-close limit; null = explicitly disabled.
        let limit = null;

        if (activeBin != null && lowerBin != null && activeBin < lowerBin) {
          direction = "Below";
          binDiff = lowerBin - activeBin;
          limit = config.management.outOfRangeWaitMinutesBelow;
        } else if (activeBin != null && upperBin != null && activeBin > upperBin) {
          direction = "Above";
          binDiff = activeBin - upperBin;
          limit = config.management.outOfRangeWaitMinutesAbove;
        }

        statusText = `🔴 OOR ${direction} ${fmtDuration(p.minutes_out_of_range ?? 0)}`;
        const autoCloseText = act.hold_mode === true
          ? "auto-close disabled (On Hold)"
          : limit == null
            ? "auto-close disabled (config)"
            : `auto-close ${fmtDuration(p.minutes_out_of_range ?? 0)}/${fmtDuration(limit)}`;
        OorDetail = `\n   └ <i>bin ${activeBin ?? "?"} vs ${direction === "Below" ? lowerBin : upperBin} (${direction === "Below" ? "-" : "+"}${binDiff}) · ${autoCloseText}</i>`;
      }

      // LP Trend compared to previous cycle snapshot (increasing ↗, decreasing ↘, flat →)
      let trendArrow = "→";
      if (p.prevSnap) {
        const currPnl = p.pnl_pct_derived ?? p.pnl_pct;
        const prevPnl = p.prevSnap.pnl_pct_derived ?? p.prevSnap.pnl_pct;
        if (currPnl != null && prevPnl != null) {
          const diff = currPnl - prevPnl;
          if (diff >= 0.01) {
            trendArrow = "↗";
          } else if (diff <= -0.01) {
            trendArrow = "↘";
          } else {
            trendArrow = "→";
          }
        } else {
          const currVal = p.total_value_true_usd ?? p.total_value_usd;
          const prevVal = p.prevSnap.total_value_usd;
          if (currVal != null && prevVal != null) {
            const valDiff = currVal - prevVal;
            if (valDiff >= 0.01) {
              trendArrow = "↗";
            } else if (valDiff <= -0.01) {
              trendArrow = "↘";
            } else {
              trendArrow = "→";
            }
          }
        }
      }

      const val = dualCur(p.total_value_usd, p.total_value_true_usd);
      const unclaimed = dualCur(p.unclaimed_fees_usd, p.unclaimed_fees_true_usd);
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.hold_mode ? "On Hold" : act.action;
      // pnl_pct is the API's (lags fee accrual); pnl_pct_derived is the local
      // fee-inclusive total (balance + unclaimed fees − deposit). Show Σ when
      // it meaningfully differs so accruing fees are visible pre-claim.
      let pnlStr = p.pnl_pct != null ? `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(2)}%` : "?%";
      if (p.pnl_pct_derived != null && p.pnl_pct != null && Math.abs(p.pnl_pct_derived - p.pnl_pct) >= 0.05) {
        pnlStr += ` (Σ${p.pnl_pct_derived >= 0 ? "+" : ""}${p.pnl_pct_derived.toFixed(2)}%)`;
      }
      const pnlNum = p.pnl_pct_derived ?? p.pnl_pct ?? 0;
      const pnlEmoji = pnlNum >= 0 ? "📈" : "📉";
      const yieldStr = p.fee_per_tvl_24h != null ? `${p.fee_per_tvl_24h.toFixed(2)}%` : "?%";

      // Two compact lines per position: identity/status/action, then the numbers.
      const ageStr = p.age_minutes != null ? fmtDuration(p.age_minutes) : "?";
      let line = `<b>${index + 1}.</b> <a href="https://app.meteora.ag/dlmm/${p.pool}"><b>${escapeHTML(p.pair)}</b></a> ${trendArrow} · ${statusText} · <b>${statusLabel}</b>` +
                 `\n   💰<code>${val}</code> · ${pnlEmoji} ${pnlStr} · ⏱️ ${ageStr} · 💎<code>${unclaimed}</code> (${yieldStr}/24h)` +
                 OorDetail;

      if (p.instruction) line += `\n   └ 📝 <i>"${escapeHTML(p.instruction)}"</i>`;
      if (p.pnl_management_ready === false) {
        line += `\n   └ 🛡️ <i>Automatic management paused: ${escapeHTML(p.pnl_quality_reason || p.pnl_quality || "valuation not ready")}</i>`;
      }
      if (act.action === "CLOSE" || act.action === "STRADDLE") line += `\n   └ ⚠️ <i>${EXIT_LABEL[act.rule] ?? act.rule ?? "Exit"}: ${escapeHTML(act.reason)}</i>`;
      if (act.action === "CLAIM") line += `\n   └ 🔄 <i>Claiming fees</i>`;
      const healthLines = formatHealthAlertLines(p.health?.alerts);
      if (healthLines.length) line += "\n" + healthLines.join("\n");
      const pvpLine = formatPvpAlert(p.pvp);
      if (pvpLine) line += "\n   " + pvpLine;
      return line;
    });

    needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    // Fingerprint the meaningful state (open set + per-position range status + action),
    // deliberately excluding PnL/fees so routine drift doesn't count as a "change".
    mgmtSig = positionData
      .map(p => `${p.position}:${p.in_range ? 1 : 0}:${actionMap.get(p.position)?.action ?? "?"}`)
      .sort()
      .join("|");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    const displayValue = config.management.solMode
      ? `${totalValue.toFixed(4)}${totalValueTrueUsd > 0 ? ` ($${totalValueTrueUsd.toFixed(2)})` : ""}`
      : totalValue.toFixed(2);
    const displayUnclaimed = config.management.solMode
      ? `${totalUnclaimed.toFixed(4)}${totalUnclaimedTrueUsd > 0 ? ` ($${totalUnclaimedTrueUsd.toFixed(2)})` : ""}`
      : totalUnclaimed.toFixed(2);
    await liveMessage?.note(`📊 Evaluating ${positions.length} active position(s) · ${cur}${displayValue} AUM...`);
    
    // Calculate countdown remaining for next screening
    const timeSinceLastScreen = Date.now() - _screeningLastTriggered;
    const remainingSec = Math.max(0, Math.round((screeningCooldownMs - timeSinceLastScreen) / 1000));
    const nextScreenText = remainingSec > 0 
      ? `${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s`
      : "Immediate";
    
    // Bubbles are edited in place, so the Telegram timestamp is frozen at creation
    // — surface the actual refresh time in the content.
    const updatedAt = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    mgmtReport = `💼 <b>${cur}${displayValue}</b> · 💵 fees <b>${cur}${displayUnclaimed}</b> · ⏱️ next screen <code>${nextScreenText}</code>` +
                 `\n\n` +
                 reportLines.join("\n\n") +
                 `\n\n<b>${positions.length} position(s)</b> · ${actionSummary} · 🕐 updated <code>${updatedAt}</code>`;

    // Publish the same data to the dashboard-report doc (single source of
    // truth for the web dashboard — it renders this instead of re-deriving).
    publishReportTracked({ positions: positionData, actions: actionMap, nextScreenSec: remainingSec, aum: _lastSampledAum });

    // Piggyback AUM sample: the cycle just force-fetched positions, so reuse
    // that cache (freshPositions:false → no rescan). Gives the balance chart
    // ~3-min resolution for the cost of one Helius balance call; the 5-min
    // cron remains as the idle-period fallback. Fire-and-forget — never
    // delays or fails the cycle.
    recordBalanceHistory({ freshPositions: false })
      .catch((e) => log("cron_error", `Piggyback balance sample failed: ${e.message}`));

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      await liveMessage?.note(`⚡ Executing ${actionPositions.length} management action(s)...`);
      const execReport = await executeManagementActions(actionPositions, actionMap, {
        liveMessage,
        cur,
        onStateChange: () => { stateChanged = true; },
      });
      if (execReport) mgmtReport += `\n\n${markdownToTelegramHTML(execReport)}`;
    } else {
      log("cron", "Management: all positions STAY — skipping");
      await liveMessage?.note(`All ${positions.length} position(s) within parameters · No actions needed.`);
    }

    // Clean up price history for positions that were closed
    const closedActions = [...actionMap.entries()].filter(([, a]) => a.action === "CLOSE");
    for (const [posAddr] of closedActions) {
      clearPriceHistory(posAddr);
    }

    // Post-close probes + dust sweep — shared with the zero-positions early
    // return above so an empty book still gets maintained.
    await runPostCloseMaintenance({ closedCount: closedActions.length });

    // Trigger screening after management if available slots exist
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const excludeHold = config.risk.maxPositionsExcludeHold !== false;
    const afterCount = excludeHold
      ? (afterPositions?.positions || []).filter(p => !p.hold_mode).length
      : (afterPositions?.positions?.length ?? 0);
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    recordError("llm_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `🚨 <b>Management cycle failed:</b> <code>${escapeHTML(error.message)}</code>`;
    cycleFailed = true;
  } finally {
    _managementBusy = false;
    // Notify decision (for the separate OOR alerts + the silent-cycle one-off):
    // silent → actions only; quiet → actions or a state change; otherwise → always.
    const changed = mgmtSig !== _lastNotifiedMgmtSig;
    let wantNotify;
    if (silent) wantNotify = needsAction.length > 0;
    else if (quiet) wantNotify = needsAction.length > 0 || changed;
    else wantNotify = true;
    const shouldNotify = (wantNotify || cycleFailed) && telegramEnabled();

    // Rolling Management Cycle bubble. For a NO-OP/STAY tick we edit it in place:
    // editing is silent (no push), so consecutive STAY ticks update one bubble
    // instead of spamming new ones. But when the cycle actually CHANGED STATE
    // (close/flip/claim) we must post a NEW message instead — an in-place edit
    // never reaches the user's phone, which is why the Jimothy-SOL close on
    // 2026-07-18 was never announced. The new message becomes the bubble that
    // subsequent STAY ticks edit. Silent cycles have no bubble → one-off send.
    if (liveMessage) {
      await liveMessage
        .finalize(stripThink(mgmtReport || "Cycle finished."), { asNewMessage: stateChanged })
        .catch((e) => log("telegram_error", `Management cycle finalize failed: ${e.message}`));
      rememberRollingMessage("management", liveMessage.getMessageId?.());
    } else if (shouldNotify && mgmtReport) {
      sendHTML(`🔄 <b>Management Cycle</b>\n\n${stripThink(mgmtReport)}`)
        .catch((e) => log("telegram_error", `Management cycle send failed: ${e.message}`));
    }

    if (shouldNotify) {
      for (const p of positions) {
        const held = p.hold_mode === true || getTrackedPosition(p.position)?.hold_mode === true;
        if (!held && !p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          const aBin = p.active_bin != null ? Number(p.active_bin) : null;
          const lBin = p.lower_bin != null ? Number(p.lower_bin) : null;
          const uBin = p.upper_bin != null ? Number(p.upper_bin) : null;
          let oorDir = null, oorDist = null, oorLimit = null;
          if (aBin != null && lBin != null && aBin < lBin) {
            oorDir = "Below"; oorDist = lBin - aBin; oorLimit = config.management.outOfRangeWaitMinutesBelow;
          } else if (aBin != null && uBin != null && aBin > uBin) {
            oorDir = "Above"; oorDist = aBin - uBin; oorLimit = config.management.outOfRangeWaitMinutesAbove;
          }
          // Direction limit explicitly null = OOR auto-close disabled — no alert
          // (the "auto-close in Xm" premise the alert is built on would be false).
          if (oorLimit == null) continue;
          notifyOutOfRange({
            pair: p.pair,
            minutesOOR: p.minutes_out_of_range,
            direction: oorDir,
            binDistance: oorDist,
            limitMinutes: oorLimit,
            pool: p.pool,
            pnlPct: p.pnl_pct ?? null,
            valueSol: config.management.solMode ? (p.total_value_usd ?? null) : null,
            valueUsd: p.total_value_true_usd ?? null,
            holdMode: p.hold_mode === true || getTrackedPosition(p.position)?.hold_mode === true,
          }).catch((e) => log("telegram_error", `notifyOutOfRange failed for ${p.pair}: ${e.message}`));
        }
      }
    }
    // Remember the state we last surfaced (bubble edit counts), so the next
    // cycle's `changed` check compares against what the user last saw.
    if (mgmtSig != null && (liveMessage || shouldNotify)) _lastNotifiedMgmtSig = mgmtSig;
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy || _commandCloseInFlight || busy) {
    log("cron", "Screening skipped — previous cycle or close operation in flight");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();
  writeHeartbeat("screening");

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  let candidatesReachedLLM = false; // set true once ≥1 candidate is handed to the LLM
  let funnelRan = false;            // set true once the funnel executed to completion
  // Function-scoped mirror of the inner `deploySucceeded` so the finally block can
  // see it. An opportunity-triggered cycle runs silent (no live bubble), which used
  // to discard the LLM's rationale entirely — the user got only the bare "🚀
  // Deployed" notify with no reasoning. A cycle that actually deployed always
  // reports, silent or not.
  let deployedThisCycle = false;
  try {
    // ── Circuit breaker guard ──
    const cb = checkCircuitBreaker();
    if (cb.tripped) {
      log("cron", `Screening skipped — circuit breaker active: ${cb.reason}. Resumes at ${cb.resumesAt}`);
      screenReport = `Screening skipped — circuit breaker: ${cb.reason}`;
      appendDecision({ type: "skip", actor: "SCREENER", summary: "Circuit breaker active", reason: cb.reason });
      _screeningBusy = false;
      return screenReport;
    }

    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);

    // ── Record SOL price for volatility tracking + circuit breaker ──
    if (preBalance.sol_price) {
      recordSolPrice(preBalance.sol_price);
      updateSolPrice(preBalance.sol_price);
    }

    // ── SOL volatility guard ──
    const solVol = checkSolVolatility(config.screening.solVolatilityThresholdPct);
    if (solVol.volatile) {
      log("cron", `Screening skipped — SOL volatility guard: ${solVol.changePct.toFixed(1)}% ${solVol.direction} move in 1h`);
      screenReport = `Screening skipped — SOL volatility: ${solVol.changePct.toFixed(1)}% ${solVol.direction}`;
      appendDecision({ type: "skip", actor: "SCREENER", summary: `SOL volatility: ${solVol.changePct.toFixed(1)}% ${solVol.direction}` });
      _screeningBusy = false;
      return screenReport;
    }

    const excludeHold = config.risk.maxPositionsExcludeHold !== false;
    const activeManagedPositions = excludeHold
      ? (prePositions.positions || []).filter((p) => !p.hold_mode && getTrackedPosition(p.position)?.hold_mode !== true).length
      : prePositions.total_positions;

    if (activeManagedPositions >= config.risk.maxPositions) {
      const skipReason = `Max positions reached (${activeManagedPositions}/${config.risk.maxPositions}${excludeHold ? " managed" : ""})`;
      log("cron", `Screening skipped — ${skipReason}`);
      screenReport = `Screening skipped — ${skipReason}.`;
      setLastScreeningFunnel({
        ts: new Date().toISOString(),
        total_scanned: 0,
        candidates_found: 0,
        passing_count: 0,
        llm_evaluated: 0,
        deployed: 0,
        skipped_reason: skipReason,
        stage_counts: null,
        top_reasons: []
      });
      publishReportTracked();
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: skipReason,
      });
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (preBalance.error) {
      throw new Error(`Balance check failed: ${preBalance.error}`);
    }
    if (!isDryRun && preBalance.sol < minRequired) {
      const skipReason = `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`;
      log("cron", `Screening skipped — ${skipReason} needed for deploy + gas)`);
      screenReport = `Screening skipped — ${skipReason} needed for deploy + gas.`;
      setLastScreeningFunnel({
        ts: new Date().toISOString(),
        total_scanned: 0,
        candidates_found: 0,
        passing_count: 0,
        llm_evaluated: 0,
        deployed: 0,
        skipped_reason: skipReason,
        stage_counts: null,
        top_reasons: []
      });
      publishReportTracked();
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: skipReason,
      });
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `🚨 <b>Screening pre-check failed:</b> <code>${escapeHTML(e.message)}</code>`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    // Same rolling-bubble reuse as the management cycle (see isRollingBubbleLast).
    const canReuse = _lastScreenMsgId != null && isRollingBubbleLast();
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...", {
      role: "screening",
      reuseMessageId: canReuse ? _lastScreenMsgId : null,
    });
    rememberRollingMessage("screening", liveMessage?.getMessageId?.());
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    let deployAmount = computeDeployAmount(currentBalance.sol);

    // Deploy-timing gate (plan #1 Phase 2) — autonomous screener only. Skip or size-down in
    // historically weak UTC blocks. No-op unless config.timing.gateEnabled.
    const timingGate = getDeployTimingGate();
    if (timingGate.gated && timingGate.action === "skip") {
      const msg = `⏸️ Deploy-timing gate: skipping this cycle — ${timingGate.reason}.`;
      log("cron", msg);
      appendDecision({ type: "no_deploy", actor: "SCREENER", summary: "Timing gate skip", reason: timingGate.reason });
      return msg;
    }
    if (timingGate.gated && timingGate.action === "size_down") {
      const reduced = Math.round(deployAmount * timingGate.sizeMultiplier * 1000) / 1000;
      log("cron", `Deploy-timing gate: size-down ${deployAmount} → ${reduced} SOL (${timingGate.reason})`);
      deployAmount = reduced;
    }

    const deployUsd = deployAmount * (currentBalance.sol_price || 0);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const deployStrategy = config.strategy.strategy;
    const strategyBlock = `DEPLOY STRATEGY: ${deployStrategy} (from config) | bins_above: 0 (FIXED — never change) | deposit: SOL only (amount_y, amount_x=0)`
      + (activeStrategy ? `\nSTRATEGY CONTEXT: ${activeStrategy.name} — entry: ${activeStrategy.entry?.condition || "n/a"} | exit: ${activeStrategy.exit?.notes || "n/a"} | best for: ${activeStrategy.best_for}` : "");

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch((e) => ({ _error: e.message }));
    if (topCandidates?._error) {
      screenReport = `🚨 <b>Screening failed:</b> <code>${escapeHTML(topCandidates._error)}</code>`;
      return screenReport;
    }
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];
    // Funnel telemetry — the rank-admission stage_counts; feeds buildFunnelReport.
    const funnelStageCounts = topCandidates?.stage_counts ?? null;
    const funnelAllFiltered = topCandidates?.all_filtered ?? [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // ── Rug-signal detection (rug-signals.js) — ALWAYS runs, data-only by default ──
    // Reads the audit block the recon loop above already fetched via getTokenInfo, so
    // this costs zero extra API calls and needs no cache or per-cycle cap. Runs here
    // rather than inside tools/screening.js so the post-admission recon loop is the
    // single insertion point. The verdict is computed even while rugFilterMode is
    // "off" so `rug_checks_tripped` still reaches the deploy snapshot below; that is
    // what makes these heuristics backtestable against our own closes before we gate.
    const rugCfg = getRugFilterConfig(config.screening);
    for (const c of allCandidates) {
      c.pool._rugSignals = extractRugSignals(c.ti, c.pool);
      c.pool._rugVerdict = evaluateRugFilter(c.pool._rugSignals, rugCfg);
      c.pool.cri = computeClusterRiskIndex(c.pool._rugSignals, { holders: c.ti?.audit?.top_holders });
      c.pool._criVerdict = evaluateClusterRisk(c.pool.cri, rugCfg);
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      // Rug-signal filter — inert unless rugFilterMode says otherwise (see config.js).
      if (rugCfg.mode !== "off" && pool._rugVerdict?.reject) {
        const detail = formatRugTrips(pool._rugVerdict);
        log("screening", `[RUG_FILTER] ${rugCfg.mode === "enforce" ? "reject" : "would-reject"} ${pool.name}: ${detail}`);
        if (rugCfg.mode === "enforce") {
          filteredOut.push({ name: pool.name, reason: `rug filter: ${detail}` });
          return false;
        }
      }
      // Cluster Risk Index (CRI) filter — inert unless criFilterMode says otherwise
      if (rugCfg.criFilterMode !== "off" && pool._criVerdict?.would_reject) {
        log("screening", `[CRI_SHADOW] ${rugCfg.criFilterMode === "enforce" ? "reject" : "would-reject"} ${pool.name}: ${pool._criVerdict.reason}`);
        if (rugCfg.criFilterMode === "enforce" && pool._criVerdict?.reject) {
          filteredOut.push({ name: pool.name, reason: `CRI filter: ${pool._criVerdict.reason}` });
          return false;
        }
      }
      return true;
    });

    funnelRan = true; // the funnel executed to completion this cycle (empty or not)

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 5)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      const funnelBlock = buildFunnelReport(funnelStageCounts, funnelAllFiltered);
      const thresholds = `Thresholds: tvl>$${config.screening.minTvl} | intel>=${config.screening.rankMinIntelScore} | fee/tvl>${config.screening.minFeeActiveTvlRatio}%`;
      screenReport = funnelBlock
        ? `No candidates available.\n\n${funnelBlock}`
        : combinedExamples
          ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
          : `No candidates available (all filtered).\n${thresholds}`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: funnelBlock || combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length <= 1 && funnelStageCounts) {
      const funnelBlock = buildFunnelReport(funnelStageCounts, funnelAllFiltered);
      if (funnelBlock) log("screening", `funnel (sparse):\n${funnelBlock}`);
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        const funnelBlock = buildFunnelReport(funnelStageCounts, funnelAllFiltered);
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
          funnelBlock ? `\n─────────────\n${funnelBlock}` : null,
        ].filter(Boolean).join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
        });
        return screenReport;
      }
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // LPAgent winning-LPer study (advisory) — only the few post-filter candidates, rate-limit-aware.
    const lpStudies = {};
    if (config.screening.lpStudyEnabled) {
      for (const { pool } of passing.slice(0, config.screening.lpStudyMaxPools ?? 4)) {
        lpStudies[pool.pool] = await getCachedLpStudy(pool.pool);
        await new Promise((r) => setTimeout(r, 250)); // gentler than the recon spacing; respect LPAgent rate limit
      }
    }

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;
      const scoutLine = pool._scoutTier
        ? `  scout_tier: TVL below the $${config.screening.minTvl} floor — admitted as a HISTORY-BUILDING scout. The executor will cap the deploy at ${config.screening.scoutSizeSol ?? 0.12} SOL regardless of the amount you pass. Judge it on token quality and momentum; the small size already prices in the thin-pool risk.`
        : null;
      const simLine = formatPoolSimLine(pool, {
        deposit_usd: deployUsd,
        minBinsBelow: config.strategy.minBinsBelow,
        maxBinsBelow: config.strategy.maxBinsBelow,
      });
      const momentumLine = formatOrganicMomentum(pool);
      // Live-vs-trailing fee-velocity comparison ("flow:") — separates a pool whose
      // fee engine is paying NOW from one coasting on its 24h average. Motivated by
      // MANLET-SOL 2026-08-21: our deploy caught a flow trough and fee-death-closed
      // in 2h; hours later flow returned and a manual re-entry ran +4%/hr. The 24h
      // fee/TVL looked identical both times — only the windowed live reading differs.
      let flowLine = null;
      try {
        const tfMin = { "5m": 5, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "12h": 720, "24h": 1440 }[config.screening.timeframe] || 60;
        const liveRatio = Number(pool.fee_active_tvl_ratio);
        const ratio24 = Number(pool.fee_tvl_24h); // set by condensePool for steady-envelope extras only
        if (Number.isFinite(liveRatio) && liveRatio >= 0 && Number.isFinite(ratio24) && ratio24 > 0) {
          const liveHourly = liveRatio * (60 / tfMin);
          const trailHourly = ratio24 / 24;
          const factor = trailHourly > 0 ? liveHourly / trailHourly : null;
          if (factor != null && Number.isFinite(factor)) {
            const label = factor >= 1.5 ? "ACCELERATING" : factor <= 0.5 ? "FADING" : "steady";
            flowLine = `flow: live fee velocity ${liveHourly.toFixed(2)}%/hr vs 24h-avg ${trailHourly.toFixed(2)}%/hr → ${label} (x${factor.toFixed(1)})`;
          }
        }
      } catch { /* advisory line only — never blocks the block build */ }
      let similarPastLine = null;
      try {
        similarPastLine = formatSimilarDeploysLine(pool);
      } catch (e) {
        log("screening", `similar_past retrieval failed for ${pool.name}: ${e.message}`);
      }
      const lperLine = config.screening.lpStudyEnabled ? formatTopLperStyle(lpStudies[pool.pool]) : null;
      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        formatFeeEfficiency(pool) ? `  ${formatFeeEfficiency(pool)}` : null,
        simLine ? `  ${simLine}` : null,
        flowLine ? `  ${flowLine}` : null,
        momentumLine ? `  ${momentumLine}` : null,
        similarPastLine ? `  ${similarPastLine}` : null,
        lperLine ? `  ${lperLine}` : null,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        scoutLine,
        pool.steady_envelope
          ? `  steady_envelope: surfaced by the 24h steady-payer pass, i.e. it did NOT clear the ${config.screening.timeframe} burst floor — fee/TVL 24h ${pool.fee_active_tvl_ratio_24h != null ? pool.fee_active_tvl_ratio_24h.toFixed(2) + "%" : "?"} (own hourly avg ${pool.fee_active_tvl_ratio_24h != null ? (pool.fee_active_tvl_ratio_24h / 24).toFixed(3) + "%/hr" : "?"}) vs this ${config.screening.timeframe} window ${pool.fee_active_tvl_ratio != null ? Number(pool.fee_active_tvl_ratio).toFixed(3) + "%" : "?"}. Steady ≠ calm: check the pool_price_change line below — a SOL-below ladder opened at the top of an up-move goes OOR-above on the first uptick and earns nothing (GTA6-SOL 2026-08-22: +18% window move → OOR in 7 min, 0 fees, low-yield close).`
          : null,
        Number.isFinite(Number(pool.price_change_pct))
          ? `  pool_price_change: ${config.screening.timeframe} ${Number(pool.price_change_pct) >= 0 ? "+" : ""}${Number(pool.price_change_pct).toFixed(1)}% (Meteora pool price over the screening window; persisted as entry_price_change_pct so the ANTI-LVR threshold can be backtested — weigh a large positive value against the ANTI-LVR rule: bins_above=0 means a continued move earns nothing)`
          : null,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
      ].filter(Boolean).join("\n");

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(pool.pool, {
          base_mint:             baseMint,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          // Jupiter-audit bot-holder % at entry — the maxBotHoldersPct filter censors
          // everything above the cap, so our perf records carry NO outcome data on
          // high-bot pools and "should the cap move?" is unanswerable from our own
          // closes. Persisting the sub-cap distribution at least calibrates the
          // low side (does 25-35% underperform <15%?) with real outcomes.
          bot_holders_pct:       ti?.audit?.bot_holders_pct ?? null,
          top10_pct:             ti?.audit?.top_holders_pct ?? null,
          // Entry momentum — shown to the LLM in the candidate block but never
          // persisted, so "do deploys into a rising 1h candle gap OOR-above and
          // fee-die?" (KET/CATE 2026-07-31/08-01: OOR-above from t≈0, zero fees,
          // low-yield close at 121m) was unanswerable from our own closes.
          price_change_1h:       ti?.stats_1h?.price_change ?? null,
          net_buyers_1h:         ti?.stats_1h?.net_buyers   ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
          // Already computed per candidate but never persisted, so "do young tokens rug
          // more?" was untestable against our own closes (minTokenAgeHours defaults to
          // null = no floor on the Meteora path). Practitioner claim to validate: tokens
          // that rug do so <24h old. TrumpCoin (worst loss, -64% in-range) was ~7h old.
          token_age_hours:       pool.token_age_hours       ?? null,
          // ── Practitioner rug heuristics (rug-signals.js) — capture only ──
          // Free (projected off the getTokenInfo recon call), fail-open, and gated by
          // nothing: rugFilterMode="off" still records these. In a few weeks these
          // columns make "do insider-heavy / concentrated / factory-minted tokens rug
          // more?" answerable against our own closes instead of on practitioner say-so.
          // NOTE: sparse by nature — a null means the audit omitted the field, which is
          // ambiguous between "zero" and "unknown". Do not read null as 0 when analysing.
          rug_insider_pct:       pool._rugSignals?.insider_pct     ?? null,
          rug_sniper_pct:        pool._rugSignals?.sniper_pct      ?? null,
          rug_top10_pct:         pool._rugSignals?.top10_pct       ?? null,
          rug_dev_balance_pct:   pool._rugSignals?.dev_balance_pct ?? null,
          rug_bundler_pct:       pool._rugSignals?.bundler_pct     ?? null,
          rug_bundler_pct_ath:   pool._rugSignals?.bundler_pct_ath ?? null,
          rug_dev_mints:         pool._rugSignals?.dev_mints       ?? null,
          rug_dev_migrations:    pool._rugSignals?.dev_migrations  ?? null,
          rug_permanent_control: pool._rugSignals?.permanent_control ?? null,
          rug_liq_burnt:         pool._rugSignals?.liq_burnt       ?? null,
          // Which checks WOULD have rejected this deploy at the current thresholds —
          // recorded even while the gate is off, so the counterfactual is measurable.
          rug_checks_tripped:    pool._rugVerdict?.tripped?.map((t) => t.check).join(",") || null,
          cri_score:             pool.cri?.cri                     ?? null,
          cri_risk_level:        pool.cri?.risk_level              ?? null,
          cri_concentration:     pool.cri?.concentration           ?? null,
          smart_flow_ratio:      pool._intelScore?.breakdown?.smart_flow_ratio ?? null,
          // Intel score dimensions
          intel_safety:          pool._intelScore?.safety   ?? null,
          intel_yield:           pool._intelScore?.yield    ?? null,
          intel_momentum:        pool._intelScore?.momentum ?? null,
          intel_trust:           pool._intelScore?.trust    ?? null,
          intel_total:           pool._intelScore?.total    ?? null,
          intel_safety_enriched: pool._intelSafetyEnriched  ?? null,
          intel_total_enriched:  pool._intelTotalEnriched   ?? null,
          // LPAgent winning-LPer signal (plan #3) — for later "did matching style help?" validation
          lper_suggested_style:  lpStudies[pool.pool]?.patterns?.suggested_style ?? null,
          lper_consensus_style:  lperConsensusStyle(lpStudies[pool.pool])?.name ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;
    // Advisory only (Phase 1): null until there's enough history to be meaningful.
    const timingAdvisory = formatDeployTimingAdvisory();

    let deployAttempted = false;
    let deploySucceeded = false;
    candidatesReachedLLM = true; // ≥1 candidate survived the funnel and is being evaluated by the LLM

    // Declined-candidates suppressor — identical set was declined by the LLM within the
    // cooldown: skip the call, the answer won't change. candidatesReachedLLM stays true
    // (candidates DID exist — this must not feed the starvation counter).
    const candidateFp = passing.map((p) => p.pool).sort().join(",");
    {
      const cooldownMs = Math.max(0, Number(config.opportunity.retriggerCooldownMin ?? 30)) * 60 * 1000;
      const age = Date.now() - _lastDeclinedCandidates.at;
      if (candidateFp && candidateFp === _lastDeclinedCandidates.fp && age < cooldownMs) {
        const minLeft = Math.ceil((cooldownMs - age) / 60000);
        log("cron", `Screening: identical candidate set declined ${Math.round(age / 60000)}m ago — skipping LLM re-ask (${minLeft}m cooldown left)`);
        screenReport = `Screening skipped — same candidate set already declined ${Math.round(age / 60000)}m ago.`;
        return screenReport;
      }
    }
    // Per-pool verdict cache — skips even when the SET differs, as long as every
    // individual candidate was recently declined and its metrics haven't moved.
    if (config.screening.verdictCacheEnabled !== false) {
      const ttlMin = Math.max(1, Number(config.screening.verdictCacheTtlMin ?? 30));
      const ttlMs = ttlMin * 60_000;
      const now = Date.now();
      for (const [k, v] of _verdictCache) if (now - v.at > ttlMs) _verdictCache.delete(k); // prune expired
      const needsJudgment = passing.filter(({ pool }) => {
        const cached = _verdictCache.get(pool.pool);
        if (!cached) return true;
        // Condensed-candidate field names (audit 01 §2: this read pool.base.market_cap /
        // base_token_holders, which condensePool never emits, so every pool counted as
        // drifted and the cache never skipped a call).
        const mcapNow = Number(pool.mcap) || 0;
        const holdersNow = Number(pool.holders) || 0;
        // Missing data on either side → treat as drifted (fail-open: re-judge).
        const mcapDrift = mcapNow > 0 && cached.mcap > 0 ? Math.abs(mcapNow / cached.mcap - 1) : 1;
        const holderDrift = holdersNow > 0 && cached.holders > 0 ? Math.abs(holdersNow / cached.holders - 1) : 0;
        // Renewed-flow invalidation: a NO-DEPLOY issued during a fee trough must not
        // suppress re-judgment once live fee velocity recovers (MANLET 2026-08-21).
        const feeNow = Number(pool.fee_active_tvl_ratio) || 0;
        const feeFlowRecovered = feeNow > 0 && cached.fee_tvl > 0 && feeNow / cached.fee_tvl >= 1.6;
        return mcapDrift > 0.20 || holderDrift > 0.30 || feeFlowRecovered;
      });
      if (needsJudgment.length === 0) {
        log("cron", `[VERDICT_CACHE] all ${passing.length} candidate(s) carry a fresh NO-DEPLOY verdict (<${ttlMin}m, mcap ±20% / holders ±30% unmoved) — skipping LLM re-ask`);
        screenReport = `Screening skipped — all ${passing.length} candidate(s) recently declined with unchanged metrics (verdict cache).`;
        return screenReport;
      }
      if (needsJudgment.length < passing.length) {
        log("cron", `[VERDICT_CACHE] ${passing.length - needsJudgment.length}/${passing.length} candidate(s) cached NO-DEPLOY, ${needsJudgment.length} changed/new — running LLM on the full set`);
      }
    }
    const { content, noToolFallback } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL${timingAdvisory ? `\n${timingAdvisory}` : ""}

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Decide whether any candidate is worth deploying. A single remaining candidate is the NORMAL state in this thin universe (most cycles surface 0–1 pools) — it is not evidence that nothing is good enough, and not automatically good either. Judge it on its own merits.
2. Deploy the best candidate when it has real conviction from at least one of: narrative quality, strong degen/pool-metric conviction, or ACCELERATING flow with a clean safety profile. Smart wallets are a CONFIDENCE BOOST, never a requirement — "zero smart wallets" is not a reason to skip. Skip when none of those hold or a safety flag is present.${config.screening.probeTierEnabled ? `
   PROBE TIER (enabled): if the best candidate is safety-clean but your conviction is below full size (CONFIDENCE < 60), call deploy_position with tier="probe" instead of NO DEPLOY — the executor caps size at ${config.screening.probeSizeSol ?? 0.25} SOL whatever amount you pass. Probe is for conviction gaps only, never a way around a safety flag.` : ""}
3. If a pool qualifies, call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   strategy = ${config.strategy.strategy} (always use this, never change it).
   shape (bin distribution, optional): default spot (uniform) — omit unless you have an edge. curve only with strong consolidation conviction (steady momentum + low volatility); bidask for a dip-entry thesis; when unsure, spot.
   RENEWED-FLOW RE-ENTRY: pool-memory low-yield/fee-death closes are TIME-STAMPED evidence from a specific flow regime, not a permanent verdict on the pool. When a candidate's "flow:" line reads ACCELERATING (live fee velocity >=1.5x its 24h average), a prior same-pool low-yield close is STALE — the fee engine has restarted and the setup is fresh; judge it on current conditions. Strong ACCELERATING flow plus a clean safety profile also counts as the "exceptional case" that can clear the solo-candidate bar in place of smart-wallet confirmation. The reverse also binds: a FADING flow means the headline 24h fee/TVL is a rear-view mirror — do not deploy on it regardless of how good the trailing number looks.
   playstyle = ${config.strategy.playstyle} → range [${config.strategy.minBinsBelow}, ${config.strategy.maxBinsBelow}] bins.
   ${config.strategy.targetDownsidePct != null
     ? `bins_below: Omit this parameter. The deploy_position tool will automatically calculate the required number of bins to cover a ${config.strategy.targetDownsidePct}% downside price drop.`
     : `bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*${config.strategy.maxBinsBelow - config.strategy.minBinsBelow}) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].`
   }
   pass deploy_position.volatility = the candidate volatility value.
   bins_above = 0. Single-side SOL only: set amount_y, keep amount_x = 0.
4. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     strategy (the actual resolved strategy deployed, e.g. spot or bid_ask)
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
5. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name, input }) => {
          if (name === "deploy_position") deployAttempted = true;
          let poolName = null;
          if (input?.pool_address) {
            poolName = passing.find(c => c.pool?.pool === input.pool_address)?.pool?.name;
          }
          await liveMessage?.toolStart(name, { poolName, amountSol: input?.amount_y || input?.amount_sol });
        },
        onToolFinish: async ({ name, input, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
            if (deploySucceeded) deployedThisCycle = true;
          }
          let poolName = null;
          if (input?.pool_address) {
            poolName = passing.find(c => c.pool?.pool === input.pool_address)?.pool?.name;
          }
          await liveMessage?.toolFinish(name, result, success, { poolName, amountSol: input?.amount_y || input?.amount_sol });
        },
      });
    if (deploySucceeded) {
      _lastDeclinedCandidates = { fp: null, at: 0 }; // set changed by the deploy — next cycle re-evaluates
      _verdictCache.clear(); // the book changed — stale NO-DEPLOY judgments no longer apply
    } else {
      _lastDeclinedCandidates = { fp: candidateFp, at: Date.now() }; // declined (incl. structured NO DEPLOY / no-tool fallback)
      // Cache per-pool NO-DEPLOY verdicts — only on a genuine judgment decline.
      // A no-tool fallback is a model failure, not a verdict; a failed deploy
      // attempt means the model WANTED one of these pools (executor blocked it).
      if (!noToolFallback && !deployAttempted && config.screening.verdictCacheEnabled !== false) {
        for (const { pool } of passing) {
          _verdictCache.set(pool.pool, {
            at: Date.now(),
            mcap: Number(pool.mcap) || 0,
            holders: Number(pool.holders) || 0,
            fee_tvl: Number(pool.fee_active_tvl_ratio) || 0,
            name: pool.name || null,
          });
        }
      }
    }
    const funnelAppend = buildFunnelReport(funnelStageCounts, funnelAllFiltered);
    if (noToolFallback) {
      // Model declined to emit a tool call this cycle — present as a calm info
      // notice, not a deploy/no-deploy report, and don't log it as a decision.
      log("cron", "Screening: model returned no tool call — no action this cycle");
      screenReport = `ℹ️ ${content}`;
    } else {
      screenReport = funnelAppend ? `${content}\n\n─────────────\n${funnelAppend}` : content;
    }
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
        metrics: {
          candidates: passing.map(p => ({
            name: p.pool?.name,
            pool: p.pool?.pool,
            intel_score: p.pool?._intelScore ? {
              total: p.pool._intelScore.total,
              safety: p.pool._intelScore.safety,
              yield: p.pool._intelScore.yield,
              momentum: p.pool._intelScore.momentum,
              trust: p.pool._intelScore.trust,
            } : null
          }))
        }
      });
    } else if (!deploySucceeded) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
        metrics: {
          candidates: passing.map(p => ({
            name: p.pool?.name,
            pool: p.pool?.pool,
            intel_score: p.pool?._intelScore ? {
              total: p.pool._intelScore.total,
              safety: p.pool._intelScore.safety,
              yield: p.pool._intelScore.yield,
              momentum: p.pool._intelScore.momentum,
              trust: p.pool._intelScore.trust,
            } : null
          }))
        }
      });
    }

    try {
      const counts = {};
      for (const f of funnelAllFiltered) {
        const reason = String(f.reason || "filtered").split(/[:(]/)[0].trim();
        counts[reason] = (counts[reason] || 0) + 1;
      }
      const topReasons = Object.entries(counts)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const screeningFunnelData = {
        ts: new Date().toISOString(),
        total_scanned: topCandidates?.total_screened || 0,
        candidates_found: candidates.length,
        passing_count: passing?.length || 0,
        llm_evaluated: candidatesReachedLLM ? (passing?.length || 0) : 0,
        deployed: deployedThisCycle ? 1 : 0,
        skipped_reason: null,
        stage_counts: funnelStageCounts || null,
        top_reasons: topReasons,
      };
      setLastScreeningFunnel(screeningFunnelData);
      publishReportTracked({ screeningFunnel: screeningFunnelData });
    } catch (funnelErr) {
      log("cron_warn", `Failed to compile screening funnel telemetry: ${funnelErr.message}`);
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    recordError("llm_error", `Screening cycle failed: ${error.message}`);
    screenReport = `🚨 <b>Screening cycle failed:</b> <code>${escapeHTML(error.message)}</code>`;
  } finally {
    _screeningBusy = false;
    // Cycle-based starvation tracking + relaxer (deadlock breaker). Never allowed
    // to break the cycle — fully try/catch-isolated.
    if (candidatesReachedLLM || funnelRan) {
      await maybeRelaxOnStarvation({ reachedLLM: candidatesReachedLLM }).catch((e) =>
        log("cron_error", `Starvation relaxer failed (non-fatal): ${e.message}`));
    }
    // Report gate. Normally silent cycles (the 45s opportunity poller) stay quiet —
    // that's the point of `silent`. But a cycle that actually DEPLOYED must always
    // report, because the report IS the reasoning: `screenReport` is the LLM's own
    // rationale for the entry. Without this, an opportunity-triggered deploy emitted
    // only the bare "🚀 Deployed" notify and the rationale was written to the log and
    // then thrown away (regression since c915e6c added the silent poller).
    // Silent + deployed → no live bubble exists, so this takes the sendHTML branch:
    // a brand-new message, which pushes a notification.
    if ((!silent || deployedThisCycle) && telegramEnabled()) {
      if (screenReport) {
        // Bubbles are edited in place, so the Telegram timestamp is frozen at
        // creation — surface the actual refresh time in the content (same as the
        // management bubble's 🕐 stamp).
        const updatedAt = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const htmlReport = `${markdownToTelegramHTML(stripThink(screenReport))}\n\n🕐 updated <code>${updatedAt}</code>`;
        if (liveMessage) {
          await liveMessage.finalize(htmlReport)
            .catch((e) => log("telegram_error", `Screening cycle finalize failed: ${e.message}`));
          // finalize(asNewMessage) can move the bubble — track the id we'll edit next.
          rememberRollingMessage("screening", liveMessage.getMessageId?.());
        } else sendHTML(`🔍 <b>Screening Cycle</b>\n\n${htmlReport}`)
          .catch((e) => log("telegram_error", `Screening cycle send failed: ${e.message}`));
      }
    }
  }
  return screenReport;
}

/**
 * Consecutive-empty-cycle tracker + cycle-based starvation relaxer.
 *
 * Breaks the zero-deploy deadlock: the closed-loop evolution relaxer only fires
 * on a close, so a screener returning zero candidates can never loosen its own
 * floors. When ≥1 candidate reaches the LLM the counter resets; otherwise it
 * accrues, and once it crosses starvationRelaxAfterEmptyCycles (with the cooldown
 * satisfied) we step the tightest evolution-owned floor back toward baseline.
 *
 * @param {{ reachedLLM: boolean }} opts
 */
async function maybeRelaxOnStarvation({ reachedLLM }) {
  const cfg = config.screening;
  const prev = getScreeningStarvation();

  if (reachedLLM) {
    if (prev.emptyCycles !== 0) saveScreeningStarvation({ ...prev, emptyCycles: 0 });
    return;
  }

  const emptyCycles = (prev.emptyCycles || 0) + 1;
  const threshold = Number(cfg.starvationRelaxAfterEmptyCycles ?? 12);
  if (emptyCycles >= threshold) {
    log("cron", `⚠️ ${emptyCycles} consecutive empty screening cycles`);
  } else {
    log("cron", `Screening produced no candidates (${emptyCycles} consecutive empty cycle${emptyCycles === 1 ? "" : "s"})`);
  }

  // Audit 01 §2: the relaxer is the other half of the evolution loop — while evolution is
  // frozen for ledger reconciliation it must not move floors either (it lowered
  // minIntelScore 61→52 on 2026-09-24 with the freeze on).
  if (cfg.starvationRelaxEnabled === false || cfg.evolutionEnabled === false) {
    saveScreeningStarvation({ ...prev, emptyCycles });
    return;
  }

  const cooldownMs = Number(cfg.starvationRelaxCooldownHours ?? 3) * 3_600_000;
  const lastRelaxedAt = prev.lastRelaxedAt ? Date.parse(prev.lastRelaxedAt) : null;
  const cooldownOk = lastRelaxedAt == null || (Date.now() - lastRelaxedAt) >= cooldownMs;

  if (emptyCycles >= threshold && cooldownOk) {
    const result = await applyStarvationRelaxation({ trigger: `cycle-based: ${emptyCycles} empty cycles` });
    // Advance lastRelaxedAt regardless of whether a floor actually moved — otherwise
    // an already-at-baseline set would retry every cycle. Counter keeps accruing so
    // the next step fires after another full cooldown if still starved.
    saveScreeningStarvation({ emptyCycles, lastRelaxedAt: new Date().toISOString() });
    if (result.changed && Object.keys(result.changes).length > 0) {
      const summary = Object.entries(result.changes).map(([k, v]) => `${k}→${v}`).join(", ");
      log("evolve", `Starvation relaxer stepped floors: ${summary}`);
      if (telegramEnabled()) {
        sendHTML(`🔧 <b>Starvation relaxer</b> (${emptyCycles} empty cycles)\nRelaxed: <code>${escapeHTML(summary)}</code>`)
          .catch((e) => log("telegram_error", `notify starvation-relaxer failed: ${e.message}`));
      }
    } else {
      log("evolve", "Starvation relaxer triggered but all floors already at baseline — nothing to relax");
    }
  } else {
    saveScreeningStarvation({ ...prev, emptyCycles });
  }
}

// Most recent wallet AUM object from the piggyback balance sample, reused by the
// dashboard-report publish so it can carry the held-token list without making its
// own (network) wallet call. See the assignment in recordBalanceHistory().
let _lastSampledAum = null;

async function recordBalanceHistory({ freshPositions = true } = {}) {
  try {
    const lastTs = await latestBalanceTs();
    if (lastTs != null) {
      const timeDiff = Date.now() - lastTs;
      // Min-gap guard: below the management cadence so the piggyback sample
      // (end of each 3-min cycle) isn't skipped, while still deduping the
      // 5-min cron against a just-recorded piggyback sample (and vice versa).
      if (timeDiff < 2.5 * 60 * 1000) {
        log("state", `[Balance History] Skipping logging, last entry is only ${Math.round(timeDiff / 1000 / 60)} minutes old.`);
        return;
      }
    }

    const wallet = await getWalletBalances({ freshPositions });
    if (wallet.error) {
      log("cron_error", `Failed to get wallet balance for history: ${wallet.error}`);
      return;
    }
    const aum = wallet.aum || {};
    if (aum.untracked_position_count > 0 && aum.valuation_complete !== true) {
      log("state", `[Balance History] Skipping sample: ${aum.untracked_position_count} newly discovered position(s) have incomplete valuation`);
      return;
    }
    // Hand the AUM to the next dashboard-report publish. The report is published
    // BEFORE this piggyback sample runs (it must not wait on a Helius call), so
    // the doc carries the previous sample's held-token list — at most one cycle
    // (~3 min) stale, which is fine for a "what's sitting unsold" panel and costs
    // no extra network call. Null until the first sample lands after a restart,
    // and report.js omits the block when it's null.
    _lastSampledAum = aum;
    const idleSol = aum.idle_sol || 0;
    const deployedSol = aum.deployed_sol || 0;
    const unclaimedFeesSol = aum.unclaimed_sol || 0;
    // Fold recoverable ATA rent into the stored rent component so totalSol stays
    // = idle+deployed+unclaimed+rent+tokens (keeps the dashboard's recompute
    // consistent and the chart flat across open/close — see ATA rent reclaim
    // work). tokensSol is the held-SPL-token component (base tokens left over
    // from the exit-swap guard / dust sweeper) — without it the recompute would
    // silently disagree with the stored totalSol.
    const rentSol = (aum.rent_sol || 0) + (aum.recoverable_rent_sol || 0);
    const tokensSol = aum.tokens_sol || 0;
    const totalSol = aum.total_sol || 0;
    const solPriceUsd = wallet.sol_price || 0;
    const totalUsd = aum.total_usd || 0;

    await recordBalanceEntry({
      ts: new Date().toISOString(),
      idleSol: Math.round(idleSol * 100000) / 100000,
      deployedSol: Math.round(deployedSol * 100000) / 100000,
      unclaimedFeesSol: Math.round(unclaimedFeesSol * 100000) / 100000,
      rentSol: Math.round(rentSol * 100000) / 100000,
      tokensSol: Math.round(tokensSol * 100000) / 100000,
      totalSol: Math.round(totalSol * 100000) / 100000,
      solPriceUsd: Math.round(solPriceUsd * 100) / 100,
      totalUsd: Math.round(totalUsd * 100) / 100
    });
    log("state", `[Balance History] Logged entry. Total SOL: ${totalSol.toFixed(4)}, Total USD: $${totalUsd.toFixed(2)}`);
  } catch (err) {
    log("cron_error", `Failed to record balance history: ${err.message}`);
  }
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  // Populate initially
  recordBalanceHistory().catch((e) => log("cron_error", `Initial balance history log failed: ${e.message}`));

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    // quiet: only message Telegram when an action is taken or the position
    // state changed since the last notification (no every-interval STAY spam).
    await runManagementCycle({ quiet: true });
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  // healthCheckIntervalMin (default 60 → `0 */1 * * *`, i.e. the historical hourly :00 tick).
  const healthEveryMin = Math.max(1, Math.round(Number(config.schedule.healthCheckIntervalMin) || 60));
  const healthCron = healthEveryMin >= 60
    ? `0 */${Math.max(1, Math.round(healthEveryMin / 60))} * * *`
    : `*/${healthEveryMin} * * * *`;
  const healthTask = cron.schedule(healthCron, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      // Health telemetry must be read-only. A MANAGER agent exposes close/claim
      // tools, so using agentLoop here allowed a health summary to become an
      // autonomous close (Qenis-SOL, 2026-08-30). Keep the hourly check useful
      // without granting it any action-capable tool path.
      const [wallet, live] = await Promise.all([
        getWalletBalances({ freshPositions: false }),
        getMyPositions({ force: true, silent: true }),
      ]);
      const open = live?.positions || [];
      const held = open.filter((p) => p.hold_mode === true || getTrackedPosition(p.position)?.hold_mode === true).length;
      const oor = open.filter((p) => p.in_range === false).length;
      const totalSol = Number(wallet?.aum?.total_sol ?? wallet?.sol ?? 0);
      log("cron", `Health check: ${open.length} open position(s), ${held} On Hold, ${oor} OOR, wallet/AUM ${Number.isFinite(totalSol) ? totalSol.toFixed(4) : "?"} SOL`);
      if (live?.error) log("cron_warn", `Health check position read degraded: ${live.error}`);
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Fast PnL poller — the real-time exit path between management cycles, no LLM.
  // Runs on public infra (RPC + Jupiter + Meteora deposits) so it can poll aggressively.
  // Exits require `confirmTicks` consecutive confirming polls (registerExitSignal) so a
  // single noisy tick can't close a position; confirmed exits close DIRECTLY here (no
  // management-interval cooldown gate that used to swallow rule hits).
  const pnlPollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  let _pnlPollBusy = false;
  // Keep a short dwell before adopting an untracked on-chain position so a
  // deploy that is still finishing its local trackPosition write is not
  // double-counted. This is elapsed-time based rather than sighting-count
  // based because the poll interval can change at runtime.
  const ORPHAN_ADOPTION_DWELL_MS = 10_000;
  const ORPHAN_ADOPTION_BURST_INTERVAL_MS = Math.max(1, Number(config.pnl.adoptionBurstIntervalSec ?? 5)) * 1000;
  const ORPHAN_ADOPTION_BURST_WINDOW_MS = Math.max(30, Number(config.pnl.adoptionBurstWindowSec ?? 120)) * 1000;
  const _orphanCandidates = new Map(); // position_address -> { position, firstSeenAt, expiresAt }
  let _adoptionBurstBusy = false;
  const _missingTrackedCheckAt = new Map();
  const MISSING_TRACKED_CHECK_INTERVAL_MS = 30_000;
  const _externalCloseRepairAt = new Map();
  const EXTERNAL_CLOSE_REPAIR_INTERVAL_MS = 60_000;

  // Manual-position discovery remains owner-wide only as a fallback. Once a
  // candidate is seen, the bounded burst below checks only that position's
  // account every few seconds until it is adopted or the candidate expires.
  const observeOrphanPositions = async (result) => {
    if (!result?.positions) return;
    try {
      const trackedSet = new Set(getTrackedPositions(true).map((t) => t.position));
      const nowMs = Date.now();
      for (const p of result.positions) {
        if (!p?.position) continue;
        const trackedState = getTrackedPosition(p.position);
        const closedAt = trackedState?.closed_at ? new Date(trackedState.closed_at).getTime() : NaN;
        const snapshotAt = result.snapshot_at ? new Date(result.snapshot_at).getTime() : NaN;
        // A discovery result can be older than a close that completed while the
        // scan was being processed. Never treat that stale result as evidence that
        // the closed position is still an orphan.
        if (trackedState?.closed && Number.isFinite(closedAt) && Number.isFinite(snapshotAt) && closedAt >= snapshotAt) {
          _orphanCandidates.delete(p.position);
          log("state", `[PNL_DISCOVERY] suppressing stale orphan ${p.position}: state closed after snapshot`);
          continue;
        }
        if (trackedSet.has(p.position)) { _orphanCandidates.delete(p.position); continue; }
        const existing = _orphanCandidates.get(p.position);
        const firstSeenAt = existing?.firstSeenAt ?? nowMs;
        _orphanCandidates.set(p.position, {
          position: p,
          firstSeenAt,
          lastSeenAt: nowMs,
          expiresAt: firstSeenAt + ORPHAN_ADOPTION_BURST_WINDOW_MS,
        });
      }
      for (const k of [..._orphanCandidates.keys()]) {
        if (!result.positions.some((p) => p?.position === k)) _orphanCandidates.delete(k);
      }
    } catch (e) {
      log("cron_warn", `poller auto-adoption error (ignored): ${e.message}`);
    }
  };

  const adoptOrphanCandidate = async (candidate) => {
    const p = candidate?.position;
    if (!p?.position) return;
    const tracked = getTrackedPosition(p.position);
    if (tracked && !tracked.closed) {
      _orphanCandidates.delete(p.position);
      return;
    }
    const nowMs = Date.now();
    if (nowMs < candidate.firstSeenAt + ORPHAN_ADOPTION_DWELL_MS) return;
    if (nowMs >= candidate.expiresAt) {
      _orphanCandidates.delete(p.position);
      log("state", `[PNL_DISCOVERY] adoption burst expired for ${p.position}`);
      return;
    }

    // The discovery payload is a point-in-time observation. Recheck the
    // position account immediately before adoption so a close that landed
    // after the scan cannot reopen a just-closed state row. null means the
    // provider failed; retain the candidate for the next burst check.
    const stillLive = await isPositionAccountLive(p.position);
    if (stillLive === null) return;
    if (!stillLive) {
      _orphanCandidates.delete(p.position);
      log("state", `[PNL_DISCOVERY] dropping stale orphan ${p.position}: position account is closed`);
      return;
    }

    // The liveness read yields to the event loop. Re-read local state before
    // the synchronous adoption so a close completing during that read cannot
    // be undone by the discovery payload.
    const stateBeforeAdoption = getTrackedPosition(p.position);
    if (stateBeforeAdoption?.closed) {
      _orphanCandidates.delete(p.position);
      log("state", `[PNL_DISCOVERY] dropping stale orphan ${p.position}: state closed before adoption`);
      return;
    }

    const { adoptOrphanPosition } = await import("./state.js");
    const adopted = adoptOrphanPosition(p, { reason: "poller auto-adoption (manual deploy)" });
    _orphanCandidates.delete(p.position);
    if (!adopted) return;

    log("state", `Poller auto-adopted untracked position ${p.position} (${p.pair}) via 5s adoption burst`);
    // Keep the notification behind one final state/liveness check. The
    // adoption itself is synchronous, but a fast close can complete while
    // Telegram is still accepting the request; suppress that misleading
    // after-the-fact message instead of announcing a position no longer open.
    setTimeout(async () => {
      try {
        const current = getTrackedPosition(p.position);
        const live = await isPositionAccountLive(p.position);
        if (!current || current.closed || live !== true) {
          log("state", `[PNL_DISCOVERY] suppressed adoption notification for ${p.position}: position closed before send`);
          return;
        }
        const dwellSeconds = Math.max(10, Math.round((Date.now() - candidate.firstSeenAt) / 1000));
        await sendMessage(`🩹 <b>Position Adopted</b>\n<code>${p.position.slice(0, 8)}…</code> (${p.pair}) remained untracked for ~${dwellSeconds}s and was adopted — now tracked and protected. PnL baseline = value at adoption.`, "HTML");
      } catch (error) {
        log("telegram_error", `Position adoption notification failed: ${error.message}`);
      }
    }, 300);
  };

  const runAdoptionBurst = async () => {
    if (_adoptionBurstBusy || _orphanCandidates.size === 0) return;
    // Never compete with a management action, poll, or discovery read.
    // Candidates stay queued and the next 5s slot retries them.
    if (_managementBusy || _pnlPollBusy || _pnlDiscoveryBusy) return;
    _adoptionBurstBusy = true;
    try {
      for (const candidate of [..._orphanCandidates.values()]) {
        if (_managementBusy || _pnlPollBusy || _pnlDiscoveryBusy) break;
        await adoptOrphanCandidate(candidate);
      }
    } catch (e) {
      log("cron_warn", `adoption burst check failed (ignored): ${e.message}`);
    } finally {
      _adoptionBurstBusy = false;
    }
  };

  // Discovery can be incomplete while the provider is catching up, so a
  // missing state row is never closed from set subtraction alone. Confirm each
  // missing account directly first; this moves the existing safe phantom-heal
  // behavior from the 15-minute reconciliation schedule into the discovery
  // fallback path without making partial scans authoritative.
  const repairPendingExternalCloses = async () => {
    const performancePositions = new Set(getAllPerformance().map((p) => p.position));
    const pending = getTrackedPositions(false).filter((p) =>
      p?.closed && p.external_close_pending === true && p.position && !performancePositions.has(p.position)
    );
    for (const tracked of pending) {
      const lastAttempt = _externalCloseRepairAt.get(tracked.position) || 0;
      if (Date.now() - lastAttempt < EXTERNAL_CLOSE_REPAIR_INTERVAL_MS) continue;
      _externalCloseRepairAt.set(tracked.position, Date.now());
      const repaired = await reconcileExternallyClosedPosition(tracked.position).catch((error) => ({
        recovered: false,
        error: error.message,
      }));
      if (repaired.recovered) {
        log("state", `[RECONCILIATION] recovered external close for ${tracked.position}: ${repaired.pnl_pct?.toFixed?.(2) ?? "?"}%`);
      } else if (repaired.error) {
        log("state", `[RECONCILIATION] external close repair deferred for ${tracked.position}: ${repaired.error}`);
      }
    }
  };

  const reconcileMissingTrackedPositions = async (result) => {
    if (!Array.isArray(result?.positions)) return;
    await repairPendingExternalCloses();
    const discovered = new Set(result.positions.map((p) => p?.position).filter(Boolean));
    const nowMs = Date.now();
    const missing = getTrackedPositions(true).filter((p) => p?.position && !discovered.has(p.position));
    for (const tracked of missing) {
      const lastChecked = _missingTrackedCheckAt.get(tracked.position) || 0;
      if (nowMs - lastChecked < MISSING_TRACKED_CHECK_INTERVAL_MS) continue;
      _missingTrackedCheckAt.set(tracked.position, nowMs);
      const stillLive = await isPositionAccountLive(tracked.position);
      if (stillLive === false) {
        const repaired = await reconcileExternallyClosedPosition(tracked.position, {
          reason: "External close detected during discovery reconciliation",
        }).catch((error) => ({ recovered: false, error: error.message }));
        if (repaired.recovered) {
          log("state", `[RECONCILIATION] external close realized for ${tracked.position}: ${repaired.pnl_pct?.toFixed?.(2) ?? "?"}%`);
        } else {
          markPositionClosedByReconciliation(tracked.position, {
            minAgeMinutes: 5,
            note: repaired.error
              ? `Auto-closed during discovery reconciliation (position account absent); closed PnL lookup deferred: ${repaired.error}`
              : "Auto-closed during discovery reconciliation (position account absent); closed PnL lookup pending",
          });
        }
      } else if (stillLive === true) {
        log("pnl_safety", `[PNL_DISCOVERY] missing tracked position is still live: ${tracked.position}`);
      }
    }
    for (const position of _missingTrackedCheckAt.keys()) {
      if (discovered.has(position) || !getTrackedPosition(position)?.closed) continue;
      _missingTrackedCheckAt.delete(position);
    }
  };

  let _pnlDiscoveryBusy = false;
  let _pnlDiscoveryPending = false;
  let _pnlDiscoveryReason = null;
  const pnlDiscoveryMs = Math.max(10, Number(config.pnl.discoveryIntervalSec ?? 30)) * 1000;
  const pnlDiscoveryFallbackMs = Math.max(
    pnlDiscoveryMs,
    Math.max(30, Number(config.pnl.discoveryFallbackIntervalSec ?? 300)) * 1000,
  );
  let _ownerDiscoveryWsHealthy = false;
  let _lastPnlDiscoveryAt = 0;
  const queuePnlDiscovery = (delayMs = 0, reason = null) => {
    _pnlDiscoveryPending = true;
    if (reason) _pnlDiscoveryReason = reason;
    if (_pnlDiscoveryRetryTimer || _pnlDiscoveryBusy) return;
    _pnlDiscoveryRetryTimer = setTimeout(() => {
      _pnlDiscoveryRetryTimer = null;
      runPnlDiscovery().catch((e) => log("cron_warn", `Queued PnL discovery failed (ignored): ${e.message}`));
    }, delayMs);
  };
  const runPnlDiscovery = async () => {
    // A busy guard must defer discovery, not drop it. The old return-only guard
    // could starve the 30s owner scan because the 5s PnL tick usually occupied
    // the entire gap between discovery attempts. That left manual positions
    // visible on-chain but absent from persisted state and therefore absent from
    // the dashboard. Management/screening retries are deliberately delayed by
    // one second; the fast-poller case is drained from its finally block.
    if (_managementBusy) {
      queuePnlDiscovery(1_000);
      return;
    }
    if (_pnlPollBusy || _pnlDiscoveryBusy) {
      _pnlDiscoveryPending = true;
      return;
    }
    _pnlDiscoveryPending = false;
    const triggerReason = _pnlDiscoveryReason;
    _pnlDiscoveryReason = null;
    _pnlDiscoveryBusy = true;
    _lastPnlDiscoveryAt = Date.now();
    try {
      if (triggerReason) log("state", `[PNL_DISCOVERY] immediate scan requested: ${triggerReason}`);
      const result = await getMyPositions({
        force: true,
        silent: true,
        discovery: true,
        persist: false,
      }).catch(() => null);
      if (!result?.positions) return;
      await reconcileMissingTrackedPositions(result);
      await observeOrphanPositions(result);
      if (result.discovery_added?.length || result.discovery_removed?.length) {
        log("state", `[PNL_DISCOVERY] added=${result.discovery_added?.length ?? 0} removed=${result.discovery_removed?.length ?? 0} positions=${result.positions.length}`);
      }
    } finally {
      _pnlDiscoveryBusy = false;
      if (_pnlDiscoveryPending && !_managementBusy && !_pnlPollBusy) {
        queuePnlDiscovery();
      }
    }
  };
  setPositionDiscoveryTrigger((reason) => queuePnlDiscovery(0, reason));
  setPositionDiscoverySignalSink((healthy) => {
    _ownerDiscoveryWsHealthy = healthy === true;
    log("socket_monitor", `Wallet PositionV2 discovery WebSocket ${_ownerDiscoveryWsHealthy ? "ready" : "unavailable"}; owner-scan fallback ${_ownerDiscoveryWsHealthy ? "5m" : `${Math.round(pnlDiscoveryMs / 1000)}s`}`);
  });
  const adoptionBurstInterval = setInterval(() => {
    runAdoptionBurst().catch((e) => log("cron_warn", `Adoption burst failed (ignored): ${e.message}`));
  }, ORPHAN_ADOPTION_BURST_INTERVAL_MS);
  const pnlDiscoveryInterval = setInterval(() => {
    const cadenceMs = _ownerDiscoveryWsHealthy ? pnlDiscoveryFallbackMs : pnlDiscoveryMs;
    if (_lastPnlDiscoveryAt && Date.now() - _lastPnlDiscoveryAt < cadenceMs) return;
    writeHeartbeat("pnl_discovery");
    runPnlDiscovery().catch((e) => log("cron_warn", `PnL discovery failed (ignored): ${e.message}`));
  }, pnlDiscoveryMs);
  // Run once immediately so a manually deployed position is not delayed until
  // the first discovery interval, while the fast poller remains independent.
  runPnlDiscovery().catch((e) => log("cron_warn", `Initial PnL discovery failed (ignored): ${e.message}`));

  const pnlPollInterval = setInterval(async () => {
    writeHeartbeat("pnl_poll");
    // R1: Live Force Sync check
    const forceSyncFile = repoPath(".force-sync");
    if (fs.existsSync(forceSyncFile)) {
      if (!_managementBusy) {
        try {
          fs.unlinkSync(forceSyncFile);
          const now = Date.now();
          const sinceLastForceSync = now - _lastForceSyncAt;
          if (sinceLastForceSync < FORCE_SYNC_MIN_INTERVAL_MS) {
            const remainingSec = Math.ceil((FORCE_SYNC_MIN_INTERVAL_MS - sinceLastForceSync) / 1000);
            log("state", `[Force Sync] Suppressed duplicate trigger; ${remainingSec}s cooldown remains.`);
          } else {
            _lastForceSyncAt = now;
            log("state", "[Force Sync] IPC file .force-sync detected, deleting file and triggering runManagementCycle immediately.");
            runManagementCycle({ silent: false }).catch((e) => {
              log("cron_error", `Force-sync triggered management failed: ${e.message}`);
            });
          }
        } catch (err) {
          log("cron_error", `Failed to unlink/process force-sync: ${err.message}`);
        }
      }
    }

    if (_managementBusy || _screeningBusy || _pnlPollBusy || _pnlDiscoveryBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions) return;
      // The fast path intentionally contains tracked positions only. Do not
      // pass it through observeOrphanPositions: its cleanup treats an absent
      // address as no longer on-chain, which would erase a manual orphan's
      // first-seen dwell timer on every 5s tick before discovery can adopt it.
      if (!result.positions.length) return;

      // Fresh-deploy fast publish: a brand-new position won't reach the
      // dashboard-report doc until the next management cycle (~3 min), during
      // which the dashboard card renders bin ids for prices and zeroed token
      // lines. The poller's positions carry the full card payload (same
      // buildPosition shape the cycle publishes), so publish immediately when
      // an address is missing from the last report. Health/pvp enrichment and
      // actions arrive with the next cycle publish; restart's first tick
      // fast-publishes once (empty set), which is just a fresh report.
      try {
        if (result.positions.some((p) => p.position && !_lastReportPositionSet.has(p.position))) {
          publishReportTracked({ positions: result.positions, actions: null, nextScreenSec: null, aum: _lastSampledAum });
          log("state", `[REPORT] fast publish — new position detected by poller`);
        }
      } catch (e) { log("cron_warn", `poller fast report publish failed (ignored): ${e.message}`); }

      for (const p of result.positions) {
        const operatorHold = getTrackedPosition(p.position)?.hold_mode === true;
        if (operatorHold) {
          registerExitSignal(p.position, null, confirmTicks);
          recordTick({ pool_address: p.pool, position_address: p.position, active_bin: p.active_bin, pnl_pct: p.pnl_pct, source: "poller" });
          continue;
        }
        if (p.pnl_management_ready === false) {
          registerExitSignal(p.position, null, confirmTicks);
          recordTick({ pool_address: p.pool, position_address: p.position, active_bin: p.active_bin, pnl_pct: p.pnl_pct, source: "poller" });
          continue;
        }
        const valuation = assessValuation(p);
        if (valuation.fresh && !valuation.suspect) confirmPeak(p.position, p.pnl_pct, confirmTicks);

        // Persist this tick's already-computed price/bin data (DATA CAPTURE ONLY —
        // no new RPC calls, no behavior change; ground truth for the replay harness).
        // recordTick is synchronous + never-throws + no-ops unless pg + capture on.
        recordTick({ pool_address: p.pool, position_address: p.position, active_bin: p.active_bin, pnl_pct: p.pnl_pct, source: "poller" });

        // Detect an exit signal this tick (rule-based exits, then deterministic close rules).
        // Supply this position's own snapshot count so the low-yield exit's history
        // floor + adoption grace apply here too (the poller can fire low-yield).
        p.fresh_snapshots = getPoolSnapshots(p.pool).filter((s) => s.position === p.position).length;
        // Single ordered evaluator (state.js) + the close-efficiency gate (a deferred
        // trailing exit is dropped for this tick; the crash/rug paths below still run).
        let exit = await applyExitGates(p, updatePnlAndCheckExits(p.position, p, config.management));

        // Price-crash fast-path (plan #04) — outranks the (slow) OOR-time rule when a
        // downside break is moving fast enough to be a rug. The detector always runs
        // (shadow mode): when the flag is OFF a would-fire is only logged as
        // `crash_shadow` for live threshold calibration — zero closes. Detector is
        // total; still wrapped so a fault can't break the poller loop — on error we
        // simply keep the normal signal above.
        try {
          const crash = detectPriceCrash(p.position, p, config.management);
          if (crash) {
            // Socket-shadow lead-time metric: how long before this poller detection
            // did the socket twin arm? (One log per episode.)
            const sep = _socketCrashEpisode.get(p.position);
            if (sep && !sep.pollerLogged) {
              sep.pollerLogged = true;
              log("crash_socket_shadow", `[CRASH_SOCKET_SHADOW] poller confirmed ${p.pair} ${((Date.now() - sep.armedAt) / 1000).toFixed(0)}s after socket armed`);
            }
            // Mark this position as a velocity-crash even in shadow mode, so the
            _crashFired.add(p.position);
            if (config.management.crashFastPathEnabled) {
              exit = finalizeExit({ action: "CRASH_FASTPATH", rule: "crash", reason: crash.reason, urgent: true, confirm_ticks: Math.max(1, Number(config.management.crashConfirmTicks ?? 3)) });
            } else {
              log("crash_shadow", `[shadow] would fast-close ${p.pair}: ${crash.reason} (crashFastPathEnabled=false)`);
            }
          }
        } catch (e) {
          log("cron_warn", `crash detector error (ignored): ${e.message}`);
        }
        // In-range rug detector — same contract as the crash fast-path (always runs,
        // shadow-logs while OFF, crash outranks it when both fire on one tick).
        try {
          if (exit?.rule !== "crash") {
            const rug = detectInRangeRug(p.position, p, config.management);
            if (rug) {
              _crashFired.add(p.position);
              if (config.management.inRangeRugEnabled) {
                exit = finalizeExit({ action: "RUG_FASTPATH", rule: "crash", reason: rug.reason, urgent: true, confirm_ticks: Math.max(1, Number(config.management.crashConfirmTicks ?? 3)) });
              } else {
                log("rug_shadow", `[RUG_SHADOW] would fast-close ${p.pair}: ${rug.reason} (inRangeRugEnabled=false)`);
              }
            }
          }
        } catch (e) {
          log("cron_warn", `rug detector error (ignored): ${e.message}`);
        }
        // ── Event-Driven Smart Money Exodus Watcher ──
        if (config.screening?.smartExodusAlertEnabled) {
          try {
            const distBelow = (p.lower_bin != null && p.active_bin != null) ? (p.lower_bin - p.active_bin) : 0;
            const sharpDrop = (p.pnl_pct != null && p.pnl_pct <= -4) || distBelow >= 8;
            const now = Date.now();
            const lastCheck = _lastSmartMoneyExodusCheck.get(p.position) || 0;
            if (sharpDrop && (now - lastCheck) >= 15 * 60 * 1000) {
              _lastSmartMoneyExodusCheck.set(p.position, now);
              const tracked = getTrackedPosition(p.position);
              const mint = tracked?.base_mint || tracked?.token_x || p.base_mint;
              if (mint) {
                checkGmgnSmartExodus(mint).then((exodus) => {
                  if (exodus && (exodus.smart_exiting > 2 || (exodus.smart_accumulating === 0 && exodus.smart_exiting >= 1))) {
                    log("smart_money", `[EXODUS] ${p.pair}: ${exodus.smart_exiting} smart wallets exiting (acc: ${exodus.smart_accumulating})`);
                    sendHTML([
                      `⚠️ <b>Smart Money Exodus Alert:</b> <code>${escapeHTML(p.pair)}</code>`,
                      `• Smart wallets dumping: <code>${exodus.smart_exiting}</code> exiting (<code>${exodus.smart_accumulating}</code> accumulating)`,
                      `• Current PnL: <code>${fmtPct(p.pnl_pct)}</code> (dist below: <code>${distBelow}</code> bins)`,
                      `• <i>Trailing stop ratchet armed. Consider reviewing position with /positions.</i>`,
                    ].join("\n")).catch(() => {});
                  }
                }).catch((err) => {
                  log("cron_warn", `smart exodus async check failed (ignored): ${err.message}`);
                });
              }
            }
          } catch (e) {
            log("cron_warn", `smart exodus detector error (ignored): ${e.message}`);
          }
        }
        // Per-rule confirmation rides on the object (crash/rug: crashConfirmTicks;
        // trailing overshoot: 1); everything else uses the poller default.
        const effectiveConfirm = exit?.confirm_ticks ?? confirmTicks;
        const signalContext = exit?.action === "TRAILING_TP"
          ? {
              kind: "TRAILING_TP",
              threshold_pnl_pct: exit.threshold_pnl_pct ?? null,
              threshold_source: exit.threshold_source ?? "drop-from-peak",
              peak_pnl_pct: exit.peak_pnl_pct ?? null,
              current_pnl_pct: exit.current_pnl_pct ?? null,
              overshoot_pct: exit.overshoot_pct ?? null,
              overshoot_threshold_pct: exit.overshoot_threshold_pct ?? null,
              immediate: !!exit.bypass_confirmation,
            }
          : null;

        // Require N consecutive confirming ticks before acting, except for a
        // materially overshot trailing breach, which is safe to act on now.
        const registration = registerExitSignal(p.position, exit?.action ?? null, effectiveConfirm, signalContext, { fresh: valuation.fresh });
        const firstContext = registration.first_context || signalContext;
        if (exit?.action === "TRAILING_TP" && registration.count === 1) {
          log(
            "exit_telemetry",
            `[EXIT_TELEMETRY] phase=first_breach position=${p.position} pair=${p.pair} ` +
              `peak_pnl_pct=${Number(firstContext?.peak_pnl_pct ?? p.peak_pnl_pct ?? 0).toFixed(2)} ` +
              `first_breach_pnl_pct=${Number(firstContext?.current_pnl_pct ?? p.pnl_pct ?? 0).toFixed(2)} ` +
              `threshold_pnl_pct=${Number(firstContext?.threshold_pnl_pct ?? 0).toFixed(2)} ` +
              `threshold_source=${firstContext?.threshold_source || "drop-from-peak"} ` +
              `overshoot_pct=${Number(firstContext?.overshoot_pct ?? 0).toFixed(2)} ` +
              `overshoot_threshold_pct=${Number(firstContext?.overshoot_threshold_pct ?? 0).toFixed(2)} ` +
              `confirmation_required=${effectiveConfirm} first_breach_at=${registration.started_at || new Date().toISOString()}`
          );
        }
        if (!exit || !registration.fire) continue;

        if (exit.action === "TRAILING_TP") {
          const confirmedAt = new Date().toISOString();
          const firstBreachAtMs = registration.started_at ? new Date(registration.started_at).getTime() : NaN;
          const confirmationDelayMs = Number.isFinite(firstBreachAtMs) ? Math.max(0, Date.now() - firstBreachAtMs) : null;
          log(
            "exit_telemetry",
            `[EXIT_TELEMETRY] phase=confirmed position=${p.position} pair=${p.pair} ` +
              `peak_pnl_pct=${Number(firstContext?.peak_pnl_pct ?? p.peak_pnl_pct ?? 0).toFixed(2)} ` +
              `first_breach_pnl_pct=${Number(firstContext?.current_pnl_pct ?? p.pnl_pct ?? 0).toFixed(2)} ` +
              `confirmed_pnl_pct=${Number(p.pnl_pct ?? 0).toFixed(2)} ` +
              `threshold_pnl_pct=${Number(firstContext?.threshold_pnl_pct ?? 0).toFixed(2)} ` +
              `overshoot_pct=${Number(firstContext?.overshoot_pct ?? 0).toFixed(2)} ` +
              `confirm_ticks=${effectiveConfirm} confirmation_delay_ms=${confirmationDelayMs ?? "unknown"} ` +
              `first_breach_at=${registration.started_at || "unknown"} confirmed_at=${confirmedAt}`
          );
        }

        const exitContext = exit.action === "TRAILING_TP"
          ? {
              kind: "TRAILING_TP",
              first_breach_at: registration.started_at || null,
              confirmed_at: new Date().toISOString(),
              confirmation_ticks: effectiveConfirm,
              confirmation_delay_ms: registration.started_at
                ? Math.max(0, Date.now() - new Date(registration.started_at).getTime())
                : null,
              threshold_pnl_pct: firstContext?.threshold_pnl_pct ?? null,
              threshold_source: firstContext?.threshold_source ?? "drop-from-peak",
              first_breach_pnl_pct: firstContext?.current_pnl_pct ?? null,
              confirmed_pnl_pct: p.pnl_pct ?? null,
              peak_pnl_pct: firstContext?.peak_pnl_pct ?? p.peak_pnl_pct ?? null,
              overshoot_pct: firstContext?.overshoot_pct ?? null,
              overshoot_threshold_pct: firstContext?.overshoot_threshold_pct ?? null,
            }
          : null;
        const actionSpec = await buildExitAction(p, exit, { exit_context: exitContext });
        log("state", `[PnL poll] ${exit.action} confirmed (${effectiveConfirm} ticks${exit.bypass_confirmation ? "; overshoot-immediate" : ""}): ${p.pair} — ${exit.reason} — ${actionSpec.action === "STRADDLE" ? "straddling" : "closing directly"}`);
        // Hold the management lock so the cron cycle can't double-act on this position.
        _managementBusy = true;
        try {
          const actMap = new Map([[p.position, actionSpec]]);
          const rpt = await executeManagementActions([p], actMap, {});
          clearPriceHistory(p.position); // drop _recentActiveBins + _binTrail for the closed position
          log("state", `[PnL poll] ${p.pair}: ${rpt || "closed"}`);
        } catch (e) {
          log("cron_error", `Poll-triggered close failed: ${e.message}`);
        } finally {
          _managementBusy = false;
        }
        break; // one action per tick
      }

      // Lightweight real-time tick for the dashboard's pg LISTEN → SSE bridge.
      // Built from the position data the poller already holds (no extra RPC).
      // Throttled to ≤1/15s and fully try/catch-isolated so it can NEVER break
      // the poll loop; pgNotify itself is fire-and-forget + fail-open.
      try {
        const now = Date.now();
        if (now - _lastTickNotify >= 2_000) {
          _lastTickNotify = now;
          const tickTs = new Date(now).toISOString();
          // value_sol/fees_sol: explicit SOL-basis position value for the
          // dashboard's live Current Balance interpolation. Only shipped under
          // solMode (where *_usd already carries SOL) — the dashboard skips the
          // interpolation entirely when they're null, so a non-solMode config
          // can never leak a USD figure into a SOL sum.
          const tickSolMode = !!config.management?.solMode;
          // The tick is complete only when the fast RPC result exactly covers
          // the persisted open LP set. During restart/discovery the known-address
          // reader can temporarily return a partial set; marking that partial
          // result complete would make the dashboard close still-live rows.
          const liveTickPositions = (result.positions || []).filter((p) => !getTrackedPosition(p.position)?.closed);
          const expectedPositionIds = new Set(getTrackedPositions(true).map((p) => p.position));
          const tickPositionIds = new Set(liveTickPositions.map((p) => p.position));
          const completeTick = expectedPositionIds.size === tickPositionIds.size
            && [...expectedPositionIds].every((position) => tickPositionIds.has(position));
          if (!completeTick) {
            log("pnl_safety", `[TICK] partial active set — expected=${expectedPositionIds.size} received=${tickPositionIds.size}; dashboard reconciliation deferred`);
          }
          const positions = liveTickPositions.map((p) => ({
            position: p.position ?? null,
            pair: p.pair ?? null,
            pnl_pct: p.pnl_pct ?? null,
            pnl_pct_usd: p.pnl_pct_usd ?? null,
            pnl_usd: p.pnl_usd ?? null,
            pnl_true_usd: p.pnl_true_usd ?? null,
            in_range: p.in_range ?? null,
            minutes_out_of_range: p.minutes_out_of_range ?? null,
            value_sol: tickSolMode ? (p.total_value_usd ?? null) : null,
            fees_sol: tickSolMode ? (p.unclaimed_fees_usd ?? null) : null,
            active_bin: p.active_bin ?? null,
            lower_bin: p.lower_bin ?? null,
            upper_bin: p.upper_bin ?? null,
            price_active: p.price_active ?? null,
            price_lower: p.price_lower ?? null,
            price_upper: p.price_upper ?? null,
            bins: Array.isArray(p.bins) && p.bins.length > 0 ? p.bins : null,
          }));
          // Dashboard movement telemetry uses the same already-computed PnL
          // snapshot. It is display-only and intentionally records even when
          // deposit basis temporarily pauses automatic exits.
          const solPriceUsd = getSolPriceUsd();
          recordLiquidityTicks(
            liveTickPositions.map((p) => ({ ...p, sol_price_usd: solPriceUsd })),
            new Date(now),
          );
          let json = JSON.stringify({ ts: tickTs, complete: completeTick, positions });
          // NOTIFY payloads must stay < 7900 bytes; tier-strip if large.
          if (Buffer.byteLength(json, "utf8") > 7500) {
            json = JSON.stringify({
              ts: tickTs,
              complete: completeTick,
              positions: positions.map(({ bins: _b, ...rest }) => rest),
            });
          }
          if (Buffer.byteLength(json, "utf8") > 7500) {
            json = JSON.stringify({
              ts: tickTs,
              complete: completeTick,
              positions: positions.map((p) => ({ position: p.position, pnl_pct: p.pnl_pct, active_bin: p.active_bin })),
            });
          }
          pgNotify("meridian_tick", json); // fire-and-forget
        }
      } catch (e) {
        log("cron_warn", `tick notify build error (ignored): ${e.message}`);
      }
    } finally {
      _pnlPollBusy = false;
      // If the discovery timer fired during this tick, run that scan as soon
      // as the fast read releases the guard instead of waiting another 15s.
      if (_pnlDiscoveryPending && !_managementBusy && !_screeningBusy) {
        queuePnlDiscovery();
      }
    }
  }, pnlPollMs);

  // Opportunity poller — catches strong pools between the (slow) screening cycles.
  // Reuses the getTopCandidates pipeline (discovery + holder audit + filters + score);
  // when the best candidate clears the score pre-gate it triggers the existing screening
  // deploy decision (runScreeningCycle), which re-checks guards and forces the deploy LLM.
  let opportunityPollInterval = null;
  if (config.opportunity.enabled) {
    const oppMs = Math.max(15, Number(config.opportunity.pollIntervalSec ?? 45)) * 1000;
    const oppCooldownMs = 5 * 60 * 1000; // don't re-trigger the deploy LLM more than every 5m
    // Per-pool: once a pool triggers the fast-path, it can't trigger again for
    // retriggerCooldownMin (the 15-min screening cron still sees it every cycle).
    const _oppPoolLastTriggered = new Map();
    let _opportunityPollBusy = false;
    opportunityPollInterval = setInterval(async () => {
      if (_screeningBusy || _managementBusy || _opportunityPollBusy) return;
      if (Date.now() - _screeningLastTriggered < oppCooldownMs) return;
      _opportunityPollBusy = true;
      try {
        // Capacity is the cheapest guard and normally blocks deployments first.
        // Only read native SOL when a slot is actually available; a full AUM
        // snapshot here previously drove the paid Wallet API every 45 seconds.
        const positions = await getMyPositions({ force: true, silent: true }).catch(() => null);
        if (!positions || (positions.total_positions ?? 0) >= config.risk.maxPositions) return;
        const minRequired = config.management.deployAmountSol + config.management.gasReserve;
        const solBalance = process.env.DRY_RUN === "true"
          ? Infinity
          : await getSolBalance().catch(() => null);
        if (process.env.DRY_RUN !== "true" && (solBalance == null || solBalance < minRequired)) return;

        const top = await getTopCandidates({ limit: config.opportunity.limit }).catch(() => null);
        const candidates = (top?.candidates || []).slice().sort((a, b) => degenScore(b, config.opportunity) - degenScore(a, config.opportunity));
        if (!candidates.length) return;

        const minScore = config.opportunity.minScore;
        const bonus = Number(config.opportunity.smartWalletScoreBonus ?? 0);
        const floor = minScore - bonus; // lowest degen that could qualify, only WITH a smart wallet

        // A pool qualifies if degen >= minScore, OR it's borderline (floor..minScore) AND a
        // tracked smart wallet sits on it (checkSmartWalletsOnPool, on-chain positions of our
        // tracked KOL list). The smart-wallet lookup runs only for borderline pools to keep
        // the 45s poll cheap.
        const poolCooldownMs = Math.max(0, Number(config.opportunity.retriggerCooldownMin ?? 30)) * 60 * 1000;
        let trigger = null;
        for (const c of candidates) {
          const s = degenScore(c, config.opportunity);
          if (s < floor) break; // sorted desc — nothing below can qualify either
          const lastTs = _oppPoolLastTriggered.get(c.pool);
          if (lastTs && Date.now() - lastTs < poolCooldownMs) continue; // recently triggered (likely declined) — let the cron re-evaluate
          if (s >= minScore) { trigger = { c, s, smart: [] }; break; }
          if (bonus <= 0) continue; // borderline but smart-wallet rescue disabled
          const smart = (await checkSmartWalletsOnPool({ pool_address: c.pool }).catch(() => null))?.in_pool || [];
          if (smart.length > 0) { trigger = { c, s, smart }; break; }
        }
        if (!trigger) return;
        _oppPoolLastTriggered.set(trigger.c.pool, Date.now());
        if (_oppPoolLastTriggered.size > 100) {
          for (const [k, ts] of _oppPoolLastTriggered) if (Date.now() - ts > poolCooldownMs) _oppPoolLastTriggered.delete(k);
        }

        const smartTag = trigger.smart.length
          ? ` + smart wallet [${trigger.smart.map((w) => w.name || w.address?.slice(0, 4)).join(", ")}] (bar lowered ${minScore}→${floor})`
          : "";
        log("cron", `[Opportunity] ${trigger.c.name} degen ${trigger.s.toFixed(1)} >= ${trigger.smart.length ? floor : minScore}${smartTag} — triggering screening deploy decision`);
        runScreeningCycle({ silent: true }).catch((e) => log("cron_error", `Opportunity-triggered screening failed: ${e.message}`));
      } catch (e) {
        log("cron_error", `Opportunity poll failed: ${e.message}`);
      } finally {
        _opportunityPollBusy = false;
      }
    }, oppMs);
  }

  const balanceHistoryTask = cron.schedule(`*/5 * * * *`, recordBalanceHistory);

  // ⚠️ Schedule offset is load-bearing: `*/15` fires at :00/:15/:30/:45 — minutes
  // divisible by 3, i.e. the exact seconds the every-3-min management cycle starts —
  // so the busy-guard skipped nearly every tick (observed 2026-08-21: last successful
  // run 7h stale; a manually-created position sat unadopted/unprotected the whole
  // time). Minutes ≡1 (mod 3) never collide with a management-cycle start; the
  // busy-retry covers screening overlap.
  const runReconciliation = async (attempt = 0) => {
    if (_managementBusy || _screeningBusy) {
      if (attempt < 3) {
        setTimeout(() => { runReconciliation(attempt + 1).catch(() => {}); }, 45_000);
      } else {
        log("cron_warn", "State reconciliation skipped: busy through all retries");
      }
      return;
    }
    try {
      const { reconcileStateWithChain } = await import("./state.js");
      await reconcileStateWithChain();
    } catch (e) {
      log("cron_error", `State reconciliation failed: ${e.message}`);
    }
  };
  const reconciliationTask = cron.schedule(`7,22,37,52 * * * *`, () => { runReconciliation().catch(() => {}); });

  // Daily: reclaim rent from empty token accounts (closed positions leave ~0.002
  // SOL stranded per ATA). Skipped while busy to avoid concurrent wallet txs.
  const ataSweepTask = cron.schedule(`30 3 * * *`, async () => {
    if (_managementBusy || _screeningBusy || busy) return;
    try {
      const { sweepEmptyTokenAccounts } = await import("./tools/wallet.js");
      const r = await sweepEmptyTokenAccounts();
      if (r.closed > 0) log("cron", `ATA sweep: closed ${r.closed}, reclaimed ~${r.reclaimed_sol} SOL${r.remaining ? ` (${r.remaining} left)` : ""}`);
    } catch (e) {
      log("cron_error", `ATA sweep failed: ${e.message}`);
    }
  });

  // Hourly: scan for new on-chain deposits so baseline capital (ROI denominator)
  // stays current without a manual `cli.js baseline` run. Incremental via the
  // last_signature checkpoint — typically one getSignaturesForAddress call.
  // Minute 50 deliberately avoids the */3 management and */15 screening grids
  // (a :45 schedule was starved every hour by the busy-guard — both cycles
  // start at :45:00 sharp).
  const baselineTask = cron.schedule(`50 * * * *`, async () => {
    if (_managementBusy || _screeningBusy || busy) {
      log("cron", "Baseline deposit scan skipped: agent busy");
      return;
    }
    try {
      const beforeState = getBaselineState();
      const beforeDeposited = beforeState.total_deposited || 0;
      const beforeWithdrawn = beforeState.total_withdrawn || 0;
      const { getBaselineDeposits } = await import("./tools/wallet.js");
      const res = await getBaselineDeposits();
      if (!res.error && (res.total_deposited || 0) > beforeDeposited) {
        const added = Math.round((res.total_deposited - beforeDeposited) * 1e6) / 1e6;
        log("cron", `Baseline: detected new deposit(s) +${added} SOL → total ${res.total_deposited}`);
        await sendHTML(`💰 <b>Deposit detected</b>: +${fmtSolUsd(added)}\nBaseline is now ◎${res.total_deposited.toFixed(4)} — ROI rebased.`)
          .catch((e) => log("telegram_error", `notify deposit-detected failed: ${e.message}`));
      }
      if (!res.error && (res.total_withdrawn || 0) > beforeWithdrawn) {
        const pulled = Math.round((res.total_withdrawn - beforeWithdrawn) * 1e6) / 1e6;
        log("cron", `Baseline: detected new withdrawal(s) -${pulled} SOL → total withdrawn ${res.total_withdrawn}`);
        await sendHTML(`📤 <b>Withdrawal detected</b>: −${fmtSolUsd(pulled)} — Net Profit rebased.`)
          .catch((e) => log("telegram_error", `notify withdrawal-detected failed: ${e.message}`));
      }
    } catch (e) {
      log("cron_error", `Baseline deposit scan failed: ${e.message}`);
    }
  });

  // Periodic autonomous profit skim to Pionex when conditions are met
  const autoSkimTask = cron.schedule(`*/5 * * * *`, async () => {
    if (!config.autoSkim?.enabled) return;
    if (_managementBusy || _screeningBusy || busy) {
      log("auto_skim", "Auto-skim skipped: agent busy");
      return;
    }
    try {
      const skimOutcome = await checkAndExecuteAutoSkim({
        onSuccess: async (result, status) => {
          const solPrice = config.solPriceUsd || 0;
          const usdVal = solPrice > 0 ? ` ($${(result.amountSol * solPrice).toFixed(2)})` : "";
          const msg = [
            `💸 <b>Profit Skimmed to Pionex</b>`,
            `━━━━━━━━━━━━━━━━━━━━`,
            `Amount: <b>◎${result.amountSol.toFixed(4)}</b>${usdVal}`,
            `Destination: <code>${result.destination.slice(0, 4)}…${result.destination.slice(-4)}</code>`,
            `Remaining Wallet: <b>◎${result.remainingSol.toFixed(4)}</b>`,
            `━━━━━━━━━━━━━━━━━━━━`,
            `📊 <b>Capital Tracking:</b>`,
            `• Net Capital at Risk: <b>◎${status.netCapitalAtRisk.toFixed(4)}</b>`,
            `• Target Working Capital: <b>◎${status.targetWorkingCapitalSol.toFixed(4)}</b>`,
            `🔗 <a href="${solscanTx(result.tx)}">View on Solscan</a>`,
          ].join("\n");
          await sendHTML(msg).catch((e) => log("telegram_error", `notify auto-skim failed: ${e.message}`));
        },
      });
      // Plan #15 item 4: with requireTelegramConfirmation the cron proposes instead
      // of transferring — announce at most once per 6h so the operator can /skim now.
      if (skimOutcome?.reason === "confirmation_required" && Date.now() - _skimProposalNotifiedAt > 6 * 60 * 60 * 1000) {
        _skimProposalNotifiedAt = Date.now();
        const st = skimOutcome.status || {};
        await sendHTML(
          `💸 <b>Skim available (confirmation required)</b>\n` +
          `Surplus above target working capital: <b>◎${(st.surplusSol ?? 0).toFixed(4)}</b> · transferable now <b>◎${skimOutcome.proposedAmountSol.toFixed(4)}</b>\n` +
          `Nothing was sent. Reply <code>/skim now</code> to execute, or <code>/skim off</code> to silence.`
        ).catch((e) => log("telegram_error", `skim proposal notify failed: ${e.message}`));
      }
    } catch (e) {
      log("auto_skim_error", `Auto-skim check failed: ${e.message}`);
    }
  });

  // Plan #15: wallet-truth reconciliation of the perf ledger (24h + 7d), read-only.
  // Minute 11 of every 4th hour: never a */3 management or */15 screening boundary.
  const ledgerTruthTask = cron.schedule(`11 */4 * * *`, async () => {
    try { await runLedgerTruth(); } catch (e) { log("ledger_truth_warn", `ledger-truth cron failed: ${e.message}`); }
  });
  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog, balanceHistoryTask, reconciliationTask, ataSweepTask, baselineTask, autoSkimTask, ledgerTruthTask];
  // Store interval refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = pnlPollInterval;
  _cronTasks._pnlDiscoveryInterval = pnlDiscoveryInterval;
  _cronTasks._adoptionBurstInterval = adoptionBurstInterval;
  _cronTasks._opportunityPollInterval = opportunityPollInterval;

  // WebSocket active bin monitor for low-latency range checks
  setBinEventSink(handleSocketBinEvent); // socket-fed crash-detector shadow (Phase 1)
  setAdoptionEnricher(captureAdoptedEntryMetrics); // plan #12: entry metrics for adopted positions
  getPnlConnectionWithFailover().then(async (pnlConn) => {
    await startSocketMonitor(pnlConn, { walletAddress: getWalletAddress() });
    const openPositions = getTrackedPositions(true);
    await syncSocketSubscriptions(openPositions);
  }).catch((err) => {
    log("cron_error", `Failed to initialize WebSocket active bin monitor: ${err.message}`);
  });

  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m, PnL every ${config.pnl.pollIntervalSec}s, discovery every ${config.pnl.discoveryIntervalSec}s${config.opportunity.enabled ? `, opportunity poll every ${config.opportunity.pollIntervalSec}s` : ""}`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();
  _commandServer?.close();

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  // Drain any pending async state persists before exiting so the last mutation
  // (e.g. a position close) is not lost on restart.
  await withTimeout(flushState().catch(() => {}), 5000);
  await withTimeout(flushAllDocStores().catch(() => {}), 5000);
  // Drain any buffered price/bin ticks (data-capture ring) before exit.
  await withTimeout(flushTicks().catch(() => {}), 5000);
  await withTimeout(flushLiquidityTicks().catch(() => {}), 5000);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ─── Close-efficiency gate orchestration (async seam for state.js's pure
//     evaluateCloseEfficiency) ────────────────────────────────────────────
//
// updatePnlAndCheckExits is synchronous and can't await a Jupiter quote, so the
// net-of-cost check runs just-in-time here (both async call sites: the mgmt cycle
// and the 3s PnL poller) when a TRAILING_TP exit has been detected. Gathers the
// two cost inputs — a rate-limited read-only base-side swap-impact quote (cached
// per position for closeEffQuoteMinIntervalSec) + a conservative claim+close+swap
// gas estimate — then delegates the math/decision to state.evaluateCloseEfficiency.
//
// `kind`:
//   "TRAILING_TP" → the real gate. Returns { defer } — true only in enforce mode;
//                   in shadow mode always false (logs `[CLOSE_EFF_SHADOW] would-defer`).
//   "LOW_YIELD"   → calibration only. NEVER defers (returns { defer:false }); logs
//                   a `[CLOSE_EFF_SHADOW] lowyield-cost` breakdown for tuning.
// Fail-open everywhere: any quote/data error logs once and returns { defer:false }.
/**
 * Close-efficiency gate applied to an exit object from the single evaluator:
 * a TRAILING_TP exit may be deferred (enforce mode → null); LOW_YIELD only gets
 * the calibration cost-log. Everything else passes through untouched.
 */
async function applyExitGates(p, exit) {
  if (!exit) return null;
  if (exit.action === "TRAILING_TP") {
    const g = await evaluateCloseEfficiencyGate(p, "TRAILING_TP").catch(() => ({ defer: false }));
    if (g.defer) return null;
  } else if (exit.action === "LOW_YIELD") {
    await evaluateCloseEfficiencyGate(p, "LOW_YIELD").catch(() => {});
  }
  return exit;
}

/**
 * Turn a confirmed exit object into the management action the executor runs:
 * a ROUND_TRIP_HARVEST becomes a STRADDLE when the harvest→straddle decision says
 * so (enforce mode + up-trend), otherwise every exit is a CLOSE carrying the
 * rule/family/urgency the evaluator stamped on it.
 */
async function buildExitAction(p, exit, extra = {}) {
  if (exit.action === "ROUND_TRIP_HARVEST") {
    const sd = await decideHarvestStraddle({ p, tracked: getTrackedPosition(p.position), cfg: config.management, log });
    if (sd.enforce) {
      return { action: "STRADDLE", rule: exit.rule, family: exit.family, reason: exit.reason, straddle: sd.params, ...extra };
    }
  }
  return {
    action: "CLOSE",
    rule: exit.rule,
    family: exit.family,
    reason: exit.reason,
    urgent: exit.urgent === true,
    oor_direction: exit.oor_direction ?? null,
    ...extra,
  };
}

async function evaluateCloseEfficiencyGate(p, kind) {
  try {
    const mc = config.management;
    const enabled = !!mc.closeEffGateEnabled;
    const grossPnlPct = Number(p.pnl_pct);
    if (!Number.isFinite(grossPnlPct)) return { defer: false };

    // Position value in SOL (unit-safe): solMode already carries SOL in *_usd
    // fields; otherwise convert the always-USD field via the cached SOL price.
    let positionValueSol;
    if (mc.solMode) {
      positionValueSol = Number(p.total_value_usd);
    } else {
      const px = getSolPriceUsd();
      const usd = Number(p.total_value_true_usd);
      positionValueSol = px > 0 && Number.isFinite(usd) ? usd / px : NaN;
    }
    if (!Number.isFinite(positionValueSol) || positionValueSol <= 0) return { defer: false };

    // Base-token remainder that will be swapped to SOL on close (bin-geometry
    // estimate) and its SOL value.
    const baseFrac = estimateBaseTokenFraction(p.active_bin, p.lower_bin, p.upper_bin);
    const baseValueSol = positionValueSol * baseFrac;

    // Swap-cost estimate, rate-limited per position via the cached %. Skip the
    // network calls for a dust base side (cost ~0). We don't know the in-position
    // base amount pre-close, so measure with a ROUND-TRIP quote pair: SOL→base for
    // the base side's SOL value, then base→SOL of the quoted out_amount (via
    // amount_raw, no decimals lookup). Half the round-trip loss ≈ the one-way
    // all-in sell cost (route fees + impact) — same out_amount-based measure the
    // proven exit-swap guard uses; deliberately NOT Jupiter's priceImpactPct field
    // (ambiguous scale, excludes route fees).
    const tracked = getTrackedPosition(p.position);
    const minIntervalMs = Number(mc.closeEffQuoteMinIntervalSec ?? 60) * 1000;
    const nowMs = Date.now();
    const lastQuoteAt = tracked?.close_eff_last_quote_at ? new Date(tracked.close_eff_last_quote_at).getTime() : 0;
    const cacheFresh = tracked?.close_eff_cached_impact_pct != null && (nowMs - lastQuoteAt) < minIntervalMs;
    let quotedImpactPct = cacheFresh ? Number(tracked.close_eff_cached_impact_pct) : null;

    if (!cacheFresh && baseValueSol > 0.0005 && p.base_mint) {
      // Quote FAILURE fails the whole gate open (log once, allow the close).
      let sellQuote;
      try {
        // skip_taker on BOTH legs: the sell leg prices a base token the wallet only
        // receives after the close, and a taker quote would 400 "Insufficient funds".
        const buyQuote = await getSwapQuote({ input_mint: "SOL", output_mint: p.base_mint, amount: baseValueSol, skip_taker: true });
        if (!(buyQuote?.out_amount > 0)) throw new Error("buy-leg quote returned no out_amount");
        sellQuote = await getSwapQuote({ input_mint: p.base_mint, output_mint: "SOL", amount_raw: buyQuote.out_amount, skip_taker: true });
        if (!(sellQuote?.out_amount > 0)) throw new Error("sell-leg quote returned no out_amount");
      } catch (e) {
        log("close_eff_shadow", `[CLOSE_EFF_SHADOW] quote failed for ${p.pair} (fail-open, allowing close): ${e.message}`);
        return { defer: false };
      }
      const roundTripSol = sellQuote.out_amount / 1e9;
      quotedImpactPct = Math.max(0, ((baseValueSol - roundTripSol) / baseValueSol) * 100 / 2);
      recordCloseEffTracking(p.position, {
        close_eff_cached_impact_pct: quotedImpactPct,
        close_eff_last_quote_at: new Date(nowMs).toISOString(),
      });
    } else if (!cacheFresh) {
      // Dust base side (nothing meaningful to swap) — impact ~0, no quote needed.
      quotedImpactPct = 0;
    }

    const gasSol = estimateExitGasCost();
    const decision = evaluateCloseEfficiency({
      grossPnlPct,
      positionValueSol,
      baseValueSol,
      quotedImpactPct,
      gasSol,
      minNetPnlPct: Number(mc.closeEffMinNetPnlPct ?? 0.5),
    });

    const floor = Number(mc.closeEffMinNetPnlPct ?? 0.5);
    const fmt = (v) => (v == null || !Number.isFinite(v) ? "?" : v.toFixed(2));
    const breakdown =
      `gross=${fmt(grossPnlPct)}% cost=${fmt(decision.costPct)}% ` +
      `(impact ${fmt(decision.impactCostPct)}% + gas ${fmt(decision.gasCostPct)}%) net=${fmt(decision.netPnlPct)}% ` +
      `[baseFrac=${baseFrac.toFixed(2)}, impact=${fmt(quotedImpactPct)}%, gas=◎${gasSol.toFixed(6)}]`;

    if (kind === "LOW_YIELD") {
      // Calibration only — never gates LOW_YIELD, in shadow or enforce.
      log("close_eff_shadow", `[CLOSE_EFF_SHADOW] lowyield-cost ${p.pair}: ${breakdown}`);
      return { defer: false };
    }

    if (!decision.defer) return { defer: false };

    // Rate-limit the defer log to ~1/10min per position (both modes).
    const CLOSE_EFF_LOG_INTERVAL_MS = 10 * 60 * 1000;
    const lastLog = tracked?.close_eff_shadow_last_log_at ? new Date(tracked.close_eff_shadow_last_log_at).getTime() : 0;
    if (nowMs - lastLog >= CLOSE_EFF_LOG_INTERVAL_MS) {
      const verb = enabled ? "deferring" : "would-defer";
      log("close_eff_shadow", `[CLOSE_EFF_SHADOW] ${verb} ${p.pair}: ${breakdown} < floor ${floor}% (closeEffGateEnabled=${enabled})`);
    }
    recordCloseEffTracking(p.position, {
      close_eff_defer_count: (tracked?.close_eff_defer_count ?? 0) + 1,
      close_eff_last_defer_at: new Date(nowMs).toISOString(),
      ...(nowMs - lastLog >= CLOSE_EFF_LOG_INTERVAL_MS ? { close_eff_shadow_last_log_at: new Date(nowMs).toISOString() } : {}),
    });

    return { defer: enabled }; // shadow mode: logged only, never actually defers
  } catch (e) {
    log("close_eff_shadow", `[CLOSE_EFF_SHADOW] gate error for ${p?.pair} (fail-open, allowing close): ${e.message}`);
    return { defer: false };
  }
}

function buildFunnelReport(stageCounts, allFiltered = []) {
  if (!stageCounts) return null;
  const sc = stageCounts;
  // Rank-admission stage counts (tools/screening.js getTopCandidatesRank stage_counts).
  const order = ["universe", "safety", "gates", "admitted"];
  const stageLine = "funnel[rank]: " + order.filter((k) => sc[k] != null).map((k) => `${k}=${sc[k]}`).join(" → ");
  // Compact reason breakdown from the accumulated pushFilteredReason list.
  const reasonCounts = {};
  for (const f of allFiltered) {
    const fam = String(f.reason || "?").split(/[:(]/)[0].trim().slice(0, 48);
    reasonCounts[fam] = (reasonCounts[fam] || 0) + 1;
  }
  const breakdown = Object.entries(reasonCounts)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 8)
    .map(([reason, n]) => `  • ${reason}: ${n}`)
    .join("\n");
  return [stageLine, breakdown ? `rejects:\n${breakdown}` : null].filter(Boolean).join("\n");
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  // Degen Score is the conviction signal for a solo deploy. Smart wallet is NO LONGER a
  // gate here — it's a confidence boost surfaced to the LLM, not a requirement.
  const degen = degenScore(pool, config.opportunity);
  const degenStrong = degen >= (config.screening.loneCandidateMinDegen ?? 50);
  const globalFeesSol = Number(tokenInfo.global_fees_sol);
  // gmgn_top10_holder_pct / gmgn_bot_degen_pct are the safety-enrichment field names (enforce mode).
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);

  // Hard flags — no override.
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }

  // Risk flags need strong conviction (degen) to deploy solo.
  if (pool.is_pvp && !degenStrong) {
    return `PVP symbol conflict without strong degen conviction (degen ${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  // Conviction: a solo deploy needs a narrative OR a strong degen score.
  if (!hasNarrative && !degenStrong) {
    return `only candidate has no narrative and weak degen score (${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  return null;
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;
let _pendingInput = null; // { key, page, menuMsgId }

// ═══════════════════════════════════════════
//  LOCALHOST COMMAND SERVER (dashboard → bot)
// ═══════════════════════════════════════════
// The dashboard holds no keys; manual closes from its UI are executed HERE, in
// the process that owns the wallet. Binds loopback by default (MERIDIAN_COMMAND_HOST
// to relax deliberately, e.g. if the dashboard is ever split onto another host);
// MERIDIAN_COMMAND_TOKEN adds an optional shared-secret check. Only started from
// the isMain-gated startup blocks below, so `cli.js` imports never bind a port.
const COMMAND_PORT = Number(process.env.MERIDIAN_COMMAND_PORT || 3001);
const COMMAND_HOST = process.env.MERIDIAN_COMMAND_HOST || "127.0.0.1";
const COMMAND_TOKEN = process.env.MERIDIAN_COMMAND_TOKEN || "";
const COMMAND_BODY_LIMIT = 10 * 1024;
const COMMAND_BUSY_WAIT_MS = 90_000;
let _commandServer = null;
let _commandCloseInFlight = false;

function engineBusy() {
  return busy || _managementBusy || _screeningBusy;
}

function commandJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readCommandBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > COMMAND_BODY_LIMIT) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Politeness wait only — `busy` is set by the TTY REPL and is permanently false
// under PM2, so this is NOT the real serialization mechanism. The actual
// double-close guard lives inside closePosition (tools/dlmm.js, in-flight set).
async function waitForEngineIdle(timeoutMs = COMMAND_BUSY_WAIT_MS) {
  const start = Date.now();
  while (engineBusy()) {
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(500);
  }
  return true;
}

async function handleCommandClose(req, res) {
  if (!COMMAND_TOKEN) {
    return commandJson(res, 503, { success: false, error: "Command authentication is not configured" });
  }
  if (COMMAND_TOKEN && req.headers["x-meridian-token"] !== COMMAND_TOKEN) {
    return commandJson(res, 401, { success: false, error: "Unauthorized" });
  }

  let body;
  try {
    body = JSON.parse((await readCommandBody(req)) || "{}");
  } catch {
    return commandJson(res, 400, { success: false, error: "Invalid JSON body" });
  }

  const positionAddress = typeof body.position === "string" ? body.position.trim() : "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(positionAddress)) {
    return commandJson(res, 400, { success: false, error: "Missing or malformed `position` (base58 address expected)" });
  }

  if (_commandCloseInFlight) {
    return commandJson(res, 503, { success: false, error: "A close is already in progress" });
  }

  // Reserve the command slot before any asynchronous lookup/wait.
  _commandCloseInFlight = true;
  const isStreaming = req.headers["accept"]?.includes("application/x-ndjson");
  if (isStreaming) {
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    });
  }

  const sendProgress = (stage, step, pct, message, meta = {}) => {
    if (isStreaming) {
      try {
        res.write(JSON.stringify({ stage, step, pct, message, ...meta }) + "\n");
      } catch (_) {}
    }
  };

  sendProgress("initiating", 0, 15, "Contacting bot engine & verifying position…");

  try {
    const tracked = getTrackedPosition(positionAddress);
    if (tracked && tracked.closed) {
      const err = "Position is already closed in the bot";
      if (isStreaming) {
        res.write(JSON.stringify({ stage: "error", error: err, status: 404 }) + "\n");
        return res.end();
      }
      return commandJson(res, 404, {
        success: false,
        error: err,
      });
    }

    // Make inbound Telegram commands queue (index.js telegramHandler gate) instead
    // of interleaving with the close.
    busy = true;
    let result;
    try {
      sendProgress("withdrawing", 1, 35, "Withdrawing liquidity & claiming fees on Solana…");
      result = await executeTool("close_position", {
        position_address: positionAddress,
        reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "manual close (dashboard)",
        skip_swap: body.skip_swap === true,
        onProgress: (stage, msg, meta = {}) => {
          if (stage === "withdrawing") sendProgress("withdrawing", 1, 35, msg, meta);
          else if (stage === "confirming") sendProgress("confirming", 1, 50, msg, meta);
          else if (stage === "pnl_settling") sendProgress("pnl_settling", body.skip_swap ? 2 : 2, 65, msg, meta);
          else if (stage === "swapping") sendProgress("swapping", 2, 75, msg, meta);
          else if (stage === "cleaning_ata") sendProgress("cleaning_ata", 3, 90, msg, meta);
        },
      }, { operatorOverride: true });
    } finally {
      busy = false;
    }

    if (result?.blocked === true) {
      const err = result.reason || "Close blocked by the bot";
      if (isStreaming) {
        res.write(JSON.stringify({ stage: "error", error: err, status: 409 }) + "\n");
        return res.end();
      }
      return commandJson(res, 409, { success: false, error: err });
    }
    if (result?.dry_run === true) {
      // DRY_RUN returns no `success` field — treat it as success.
      const payload = { success: true, dry_run: true, message: result.message || "DRY RUN — no transaction sent", position: positionAddress };
      if (isStreaming) {
        res.write(JSON.stringify({ stage: "completed", step: body.skip_swap ? 2 : 3, pct: 100, result: payload }) + "\n");
        return res.end();
      }
      return commandJson(res, 200, payload);
    }
    if (result?.success === true) {
      const payload = {
        success: true,
        position: positionAddress,
        pool_name: result.pool_name ?? null,
        pnl_usd: result.pnl_usd ?? null,
        pnl_pct: result.pnl_pct ?? null,
        close_txs: result.close_txs ?? result.txs ?? [],
        claim_txs: result.claim_txs ?? [],
        auto_swapped: result.auto_swapped === true,
        base_mint: result.base_mint ?? null,
      };
      if (isStreaming) {
        res.write(JSON.stringify({ stage: "completed", step: body.skip_swap ? 2 : 3, pct: 100, result: payload }) + "\n");
        return res.end();
      }
      return commandJson(res, 200, payload);
    }
    const err = result?.error || result?.reason || "Close failed";
    if (isStreaming) {
      res.write(JSON.stringify({ stage: "error", error: err, status: 500, result }) + "\n");
      return res.end();
    }
    return commandJson(res, 500, { success: false, error: err, result });
  } catch (err) {
    log("command_error", `close ${positionAddress}: ${err.message}`);
    if (isStreaming) {
      res.write(JSON.stringify({ stage: "error", error: err.message, status: 500 }) + "\n");
      return res.end();
    }
    return commandJson(res, 500, { success: false, error: err.message });
  } finally {
    _commandCloseInFlight = false;
  }
}

async function handleCommandSetHold(req, res) {
  if (!COMMAND_TOKEN) {
    return commandJson(res, 503, { success: false, error: "Command authentication is not configured" });
  }
  if (req.headers["x-meridian-token"] !== COMMAND_TOKEN) {
    return commandJson(res, 401, { success: false, error: "Unauthorized" });
  }

  let body;
  try {
    body = JSON.parse((await readCommandBody(req)) || "{}");
  } catch {
    return commandJson(res, 400, { success: false, error: "Invalid JSON body" });
  }

  const positionAddress = typeof body.position === "string" ? body.position.trim() : "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(positionAddress)) {
    return commandJson(res, 400, { success: false, error: "Missing or malformed `position` (base58 address expected)" });
  }
  if (typeof body.hold !== "boolean") {
    return commandJson(res, 400, { success: false, error: "`hold` must be a boolean" });
  }
  if (_commandCloseInFlight) {
    return commandJson(res, 409, { success: false, error: "A close is already in progress for the bot" });
  }

  try {
    const { positions } = await getMyPositions({ force: true });
    const open = (positions || []).find((p) => p.position === positionAddress);
    if (!open) {
      return commandJson(res, 404, { success: false, error: "Position is not open in the bot" });
    }

    const reason = body.hold ? "dashboard operator hold" : null;
    const ok = setPositionHold(positionAddress, body.hold, reason);
    if (!ok) return commandJson(res, 404, { success: false, error: "Position is not tracked locally" });

    return commandJson(res, 200, {
      success: true,
      position: positionAddress,
      pair: open.pair ?? null,
      hold_mode: body.hold,
    });
  } catch (err) {
    log("command_error", `hold ${positionAddress}: ${err.message}`);
    return commandJson(res, 500, { success: false, error: err.message });
  }
}

function startCommandServer() {
  if (_commandServer) return;
  _commandServer = http.createServer(async (req, res) => {
    const url = req.url?.split("?")[0];
    try {
      if (req.method === "GET" && url === "/command/health") {
        return commandJson(res, 200, {
          ok: true,
          dry_run: process.env.DRY_RUN === "true",
          busy: engineBusy(),
          auth_configured: !!COMMAND_TOKEN,
        });
      }
      if (req.method === "POST" && url === "/command/close") {
        log("command", "POST /command/close");
        return await handleCommandClose(req, res);
      }
      if (req.method === "POST" && url === "/command/set-hold") {
        log("command", "POST /command/set-hold");
        return await handleCommandSetHold(req, res);
      }
      return commandJson(res, 404, { success: false, error: "Not found" });
    } catch (err) {
      log("command_error", `${req.method} ${url}: ${err.message}`);
      return commandJson(res, 500, { success: false, error: err.message });
    }
  });
  // PM2's kill_timeout can still abort an in-flight close mid-transaction on a
  // `pm2 restart` — a pre-existing risk for every close path, unchanged here.
  _commandServer.on("error", (err) => {
    log("command_error", `Command server error: ${err.message}`);
    if (err.code === "EADDRINUSE") _commandServer = null;
  });
  _commandServer.listen(COMMAND_PORT, COMMAND_HOST, () => {
    log("startup", `Command server on http://${COMMAND_HOST}:${COMMAND_PORT}`);
  });
}

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function formatCandidatesList(candidates, { title = "Screened Candidates", timestamp = null } = {}) {
  if (!candidates || candidates.length === 0) return "ℹ️ <i>No cached candidates yet. Run <code>/screen</code> first.</i>";
  const lines = candidates.map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct != null ? ` · In-range: <code>${pool.active_pct}%</code>` : "";
    const source = pool.organic_score != null ? ` · Organic: <code>${pool.organic_score}</code>` : "";
    const criBadge = pool.cri?.cri != null ? ` · ${formatClusterRisk(pool.cri)}` : "";
    const smartFlow = pool._intelScore?.breakdown?.smart_flow_ratio != null
      ? ` · Flow: <code>${pool._intelScore.breakdown.smart_flow_ratio > 0 ? "+" : ""}${pool._intelScore.breakdown.smart_flow_ratio}</code>`
      : "";
    const poolLink = pool.pool ? `<a href="${meteoraPool(pool.pool)}">${escapeHTML(pool.name)}</a>` : escapeHTML(pool.name);
    return `<b>${i + 1}. ${poolLink}</b>\n   • Fee/aTVL: <code>${feeTvl}%</code> · Vol: <code>$${vol}</code>${active}${source}${criBadge}${smartFlow}`;
  });
  const timeStr = timestamp ? ` · <i>${new Date(timestamp).toLocaleTimeString("en-US", { hour12: false, timeZone: "Asia/Jakarta" })} WIB</i>` : "";
  return `🔍 <b>${title} (${candidates.length})</b>${timeStr}\n\n${lines.join("\n")}\n\n<i>Use <code>/deploy &lt;n&gt;</code> to deploy</i>`;
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "ℹ️ <i>No cached candidates yet. Run <code>/screen</code> first.</i>";
  return formatCandidatesList(_latestCandidates.slice(0, limit), {
    title: "Screened Candidates",
    timestamp: _latestCandidatesAt,
  });
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled() ? "on" : "off";
  const aum = wallet.aum || {
    idle_sol: wallet.sol || 0,
    idle_usd: wallet.sol_usd || 0,
    deployed_sol: 0,
    deployed_usd: 0,
    unclaimed_sol: 0,
    unclaimed_usd: 0,
    rent_sol: 0,
    rent_usd: 0,
    total_sol: wallet.sol || 0,
    total_usd: wallet.sol_usd || 0,
  };

  const baseline = getBaselineState();
  const totalDeposited = baseline.total_deposited || 0;
  const totalWithdrawn = baseline.total_withdrawn || 0;
  let roiHtml = "";
  if (totalDeposited > 0) {
    // Withdrawn capital is added back so a user withdrawal doesn't read as a loss.
    const netProfitSol = aum.total_sol + totalWithdrawn - totalDeposited;
    const netProfitPct = (netProfitSol / totalDeposited) * 100;
    const sign = netProfitSol >= 0 ? "+" : "";
    roiHtml = `\n• <b>Net Profit/ROI:</b> <code>${sign}${netProfitSol.toFixed(4)} SOL</code> (${sign}${netProfitPct.toFixed(2)}%)`;
    if (totalWithdrawn > 0) {
      roiHtml += `\n• <b>Withdrawn:</b> <code>${totalWithdrawn.toFixed(4)} SOL</code>`;
    }
  }

  const unclaimedSol = aum.unclaimed_sol || 0;
  const unclaimedUsd = aum.unclaimed_usd || 0;
  const rentSol = aum.rent_sol || 0;
  const rentUsd = aum.rent_usd || 0;
  const recoverableRentSol = aum.recoverable_rent_sol || 0;
  const recoverableRentUsd = aum.recoverable_rent_usd || 0;
  const heldTokensSol = aum.tokens_sol || 0;
  const heldTokensUsd = aum.tokens_usd || 0;

  let feeHtml = "";
  if (unclaimedSol > 0) {
    feeHtml = `\n• <b>Unclaimed Fees:</b> <code>${unclaimedSol.toFixed(4)} SOL</code> ($${unclaimedUsd.toFixed(2)})`;
  }
  let rentHtml = "";
  if (rentSol > 0) {
    rentHtml = `\n• <b>Locked Rent:</b> <code>${rentSol.toFixed(4)} SOL</code> ($${rentUsd.toFixed(2)})`;
  }
  let recoverableRentHtml = "";
  if (recoverableRentSol > 0) {
    recoverableRentHtml = `\n• <b>Recoverable ATA Rent:</b> <code>${recoverableRentSol.toFixed(4)} SOL</code> ($${recoverableRentUsd.toFixed(2)})`;
  }
  let heldTokensHtml = "";
  if (heldTokensSol > 0 || heldTokensUsd > 0) {
    heldTokensHtml = `\n• <b>Held Tokens:</b> <code>${heldTokensSol.toFixed(4)} SOL</code> ($${heldTokensUsd.toFixed(2)})`;
  }

  const cbStatus = getCircuitBreakerStatus();
  const volStatus = getSolVolatilityStatus();

  return [
    `💼 <b>Meridian Portfolio Status</b>`,
    ``,
    `• <b>Wallet (Idle):</b> <code>${aum.idle_sol.toFixed(4)} SOL</code> ($${aum.idle_usd.toFixed(2)})`,
    `• <b>Deployed (LP):</b> <code>${aum.deployed_sol.toFixed(4)} SOL</code> ($${aum.deployed_usd.toFixed(2)})${feeHtml}${rentHtml}${recoverableRentHtml}${heldTokensHtml}`,
    `• <b>Total AUM:</b> <code>${aum.total_sol.toFixed(4)} SOL</code> ($${aum.total_usd.toFixed(2)})${roiHtml}`,
    `• <b>SOL Price:</b> <code>$${wallet.sol_price}</code>`,
    ``,
    `⚡️ <b>Execution & Rules</b>`,
    `• <b>Open Positions:</b> <code>${positions.total_positions}/${config.risk.maxPositions}</code>`,
    `• <b>Next Deploy:</b> <code>${deployAmount} SOL</code>`,
    `• <b>Dry Run:</b> <code>${process.env.DRY_RUN === "true" ? "yes" : "no"}</code>`,
    `• <b>HiveMind:</b> <code>${hive}</code>`,
    ``,
    `🔌 <b>Circuit Breaker Status</b>`,
    `<code>${escapeHTML(cbStatus)}</code>`,
    ``,
    `📈 <b>Market Context</b>`,
    `<code>${escapeHTML(volStatus)}</code>`,
  ].join("\n");
}

function formatConfigSnapshot() {
  return [
    "⚙️ <b>Meridian Runtime Configuration</b>",
    "",
    "🎯 <b>Strategy &amp; Sizing</b>",
    `• <b>Strategy:</b> <code>${escapeHTML(config.strategy.strategy)}</code> (bins: <code>-${config.strategy.minBinsBelow}..+${config.strategy.maxBinsBelow}</code>)`,
    `• <b>Deploy Size:</b> <code>${config.management.deployAmountSol} SOL</code> · <b>Gas Reserve:</b> <code>${config.management.gasReserve} SOL</code>`,
    `• <b>Max Positions:</b> <code>${config.risk.maxPositions}</code> (exclude HOLD: <code>${config.risk.maxPositionsExcludeHold ? "yes" : "no"}</code>)`,
    "",
    "🛡️ <b>Risk &amp; Exits</b>",
    `• <b>Stop Loss:</b> <code>${config.management.stopLossPct}%</code> · <b>Take Profit:</b> <code>${config.management.takeProfitPct}%</code>`,
    `• <b>Trailing TP:</b> <code>${config.management.trailingTakeProfit ? "active" : "off"}</code> (trigger <code>+${config.management.trailingTriggerPct}%</code>, drop <code>-${config.management.trailingDropPct}pp</code>)`,
    `• <b>OOR Timeout:</b> <code>${config.management.outOfRangeWaitMinutes}m</code> (cooldown <code>${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h</code>)`,
    `• <b>Yield Floor:</b> <code>${config.management.minFeePerTvl24h}%/24h</code> (after <code>${config.management.minAgeBeforeYieldCheck}m</code>)`,
    "",
    "🔄 <b>Rebalance &amp; Flow</b>",
    `• <b>Rebalance:</b> manual <code>/rebalance</code> only (chain cap <code>${config.management.rebalanceMaxCount}x</code>)`,
    `• <b>Target Bins:</b> <code>-${config.management.rebalanceBinsBelow}..+${config.management.rebalanceBinsAbove}</code>`,
    `• <b>PnL Polling:</b> <code>every ${config.pnl.pollIntervalSec}s</code> (confirm <code>${config.pnl.confirmTicks} ticks</code>)`,
    "",
    "🔍 <b>Screening &amp; Schedule</b>",
    `• <b>Discovery:</b> <code>${escapeHTML(config.screening.category)}/${escapeHTML(config.screening.timeframe)}</code> · TVL: <code>$${config.screening.minTvl}-$${config.screening.maxTvl}</code>`,
    `• <b>Cron Intervals:</b> Management <code>${config.schedule.managementIntervalMin}m</code> · Screening <code>${config.schedule.screeningIntervalMin}m</code>`,
    `• <b>HiveMind:</b> <code>${isHiveMindEnabled() ? "connected" : "disabled"}</code>${config.hiveMind.agentId ? ` (<code>${escapeHTML(config.hiveMind.agentId)}</code>)` : ""}`,
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    trailingTakeProfit: config.management.trailingTakeProfit,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    topPerformersEnabled: config.screening.topPerformersEnabled,
    topPerformersLimit: config.screening.topPerformersLimit,
    topPerformersMinTvl: config.screening.topPerformersMinTvl,
    topPerformersRequireTrend: config.screening.topPerformersRequireTrend,
    topPerformerTrendTimeframe: config.screening.topPerformerTrendTimeframe,
    topPerformerTrendCandles: config.screening.topPerformerTrendCandles,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    rebalanceMaxCount: config.management.rebalanceMaxCount,
    rebalanceBinsBelow: config.management.rebalanceBinsBelow,
    rebalanceBinsAbove: config.management.rebalanceBinsAbove,
    minTxPerMin: config.screening.minTxPerMin,
    minVolumeTvlRatio: config.screening.minVolumeTvlRatio,
    toxicConversionEnabled: config.management.toxicConversionEnabled,
    toxicConversionThresholdPct: config.management.toxicConversionThresholdPct,
    surgeDecayExitEnabled: config.management.surgeDecayExitEnabled,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxPositionsExcludeHold: config.risk.maxPositionsExcludeHold,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    trailingMinPnlPct: config.management.trailingMinPnlPct,
    trailingOvershootPct: config.management.trailingOvershootPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function inputButton(key, label, { digits = 0 } = {}) {
  const value = settingValue(key);
  const shown = value == null ? "off" : Number.isFinite(Number(value)) ? String(parseFloat(Number(value).toFixed(digits))) : String(value);
  return [settingButton(`${label}: ${shown} ✏`, `cfg:input:${key}`)];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"}`,
    `Screening: TopPerf: ${config.screening.topPerformersEnabled ? "on" : "off"} (min $${config.screening.topPerformersMinTvl ?? 15000}, ${config.screening.topPerformerTrendCandles ?? 6}x ${config.screening.topPerformerTrendTimeframe ?? "5m"})`,
    `Strategy: ${config.strategy.strategy}`,
    `Deploy: ${config.management.deployAmountSol} SOL | Max Pos: ${config.risk.maxPositions}${config.risk.maxPositionsExcludeHold ? " (excl HOLD)" : ""}`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Strategy", "cfg:page:strategy"),
    ],
    [
      settingButton("Screen", "cfg:page:screen"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      inputButton("deployAmountSol", "Deploy SOL", { digits: 2 }),
      inputButton("gasReserve", "Gas reserve", { digits: 2 }),
      inputButton("maxPositions", "Max positions"),
      [toggleButton("maxPositionsExcludeHold", "Excl HOLD from Max Pos")],
      inputButton("maxDeployAmount", "Max SOL"),
      inputButton("takeProfitPct", "TP %"),
      inputButton("stopLossPct", "SL %"),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      inputButton("trailingTriggerPct", "Trail trigger", { digits: 1 }),
      inputButton("trailingDropPct", "Trail drop", { digits: 1 }),
      inputButton("trailingMinPnlPct", "Trail floor", { digits: 1 }),
      inputButton("trailingOvershootPct", "Trail overshoot", { digits: 1 }),
      [toggleButton("toxicConversionEnabled", "Toxic Conv Guard")],
      inputButton("toxicConversionThresholdPct", "Toxic Conv %"),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("topPerformersEnabled", "Top Performers"), toggleButton("topPerformersRequireTrend", "Top Trend Filter")],
      [
        settingButton("Top TF: 5m", "cfg:set:topPerformerTrendTimeframe:5m"),
        settingButton("Top TF: 15m", "cfg:set:topPerformerTrendTimeframe:15m"),
      ],
      [
        inputButton("topPerformersMinTvl", "Top min TVL ($)")[0],
        inputButton("topPerformersLimit", "Top limit")[0],
      ],
      inputButton("topPerformerTrendCandles", "Top trend candles"),
      [
        inputButton("minTxPerMin", "Min Tx/min", { digits: 1 })[0],
        inputButton("minVolumeTvlRatio", "Min Vol/TVL", { digits: 2 })[0],
      ],
      [toggleButton("blockPvpSymbols", "PVP hard block")],
      inputButton("managementIntervalMin", "Manage interval (min)"),
      inputButton("screeningIntervalMin", "Screen interval (min)"),
    ];
  } else if (page === "strategy") {
    rows = [
      [
        settingButton("spot", "cfg:set:strategy:spot"),
        settingButton("bid_ask", "cfg:set:strategy:bid_ask"),
      ],
      inputButton("minBinsBelow", "Min bins"),
      inputButton("maxBinsBelow", "Max bins"),
      inputButton("rebalanceMaxCount", "Rebal max count"),
      [
        inputButton("rebalanceBinsBelow", "Rebal bins below")[0],
        inputButton("rebalanceBinsAbove", "Rebal bins above")[0],
      ],
    ];
  } else {
    rows = [
      [toggleButton("solMode", "SOL mode")],
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "input") {
    const inputKey = parts[2];
    const currentVal = settingValue(inputKey);
    const inputPage = ["topPerformersMinTvl", "topPerformersLimit", "topPerformerTrendCandles", "minTxPerMin", "minVolumeTvlRatio"].includes(inputKey) ? "screen"
      : ["minBinsBelow", "maxBinsBelow", "rebalanceMaxCount", "rebalanceBinsBelow", "rebalanceBinsAbove"].includes(inputKey) ? "strategy"
      : ["blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "topPerformersEnabled", "topPerformersRequireTrend", "topPerformerTrendTimeframe"].includes(inputKey) ? "screen"
      : "risk";
    _pendingInput = { key: inputKey, page: inputPage, menuMsgId: msg.messageId };
    await answerCallbackQuery(msg.callbackQueryId);
    await sendMessage(`Enter new value for ${inputKey} (current: ${currentVal ?? "off"}):\nSend a number, or "off" to clear.`);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = ["topPerformersMinTvl", "topPerformersLimit", "topPerformerTrendCandles", "topPerformersEnabled", "topPerformersRequireTrend", "topPerformerTrendTimeframe", "minTxPerMin", "minVolumeTvlRatio"].includes(key) ? "screen"
      : ["minBinsBelow", "maxBinsBelow", "rebalanceMaxCount", "rebalanceBinsBelow", "rebalanceBinsAbove"].includes(key)
          ? "strategy"
          : ["blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin"].includes(key)
            ? "screen"
            : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

// ─── Interactive Position Manager ─────────────────────────────

export function renderPositionsMenu(positions) {
  if (!positions || positions.length === 0) {
    return {
      text: "ℹ️ <b>No open positions.</b>\nThere are currently no active LP positions to manage.",
      keyboard: [
        [{ text: "🔄 Refresh", callback_data: "pos:list" }],
      ],
    };
  }

  const cur = config.management.solMode ? "◎" : "$";
  const dual = (val, trueUsd) => config.management.solMode && trueUsd != null && trueUsd !== 0
    ? `${cur}${val} ($${Number(trueUsd).toFixed(2)})`
    : `${cur}${val}`;

  const summary = [
    `🕹️ <b>Meridian Position Manager</b> (${positions.length} active)`,
    ``,
    `<i>Tap any position below to manage HOLD status, rebalance, or close:</i>`,
  ].join("\n");

  const posButtons = positions.map((p, i) => {
    const holdChip = p.hold_mode ? "🛡️" : (p.in_range ? "🟢" : "🔴");
    const valStr = `${cur}${Number(p.total_value_usd || 0).toFixed(2)}`;
    return [{
      text: `${i + 1}. ${p.pair} (${holdChip}) · ${valStr}`,
      callback_data: `pos:view:${i}`,
    }];
  });

  const controls = [
    [
      { text: "🔄 Refresh", callback_data: "pos:list" },
      { text: "❌ Close Menu", callback_data: "pos:dismiss" },
    ],
  ];

  return { text: summary, keyboard: [...posButtons, ...controls] };
}

export function renderPositionActionCard(pos, idx) {
  const cur = config.management.solMode ? "◎" : "$";
  const dual = (val, trueUsd) => config.management.solMode && trueUsd != null && trueUsd !== 0
    ? `${cur}${val} ($${Number(trueUsd).toFixed(2)})`
    : `${cur}${val}`;
  const pnl = (pos.pnl_usd ?? 0) >= 0 ? `+${cur}${pos.pnl_usd}` : `-${cur}${Math.abs(pos.pnl_usd)}`;
  const pct = pos.pnl_pct != null ? ` (${pos.pnl_pct >= 0 ? "+" : ""}${pos.pnl_pct}%` +
    (pos.pnl_pct_derived != null && Math.abs(pos.pnl_pct_derived - pos.pnl_pct) >= 0.05
      ? `, Σ${pos.pnl_pct_derived >= 0 ? "+" : ""}${pos.pnl_pct_derived}%` : "") + ")" : "";
  const rangeStatus = pos.in_range ? "🟢 In Range" : `🔴 OOR (${pos.minutes_out_of_range ?? 0}m)`;
  const holdStatus = pos.hold_mode ? " · 🛡️ <b>On Hold</b>" : " · ⚡ <b>Active Auto</b>";
  const stratStr = pos.strategy ? ` · <code>${escapeHTML(pos.strategy)}</code>` : "";

  const links = [
    pos.pool ? `<a href="${meteoraPool(pos.pool)}">Meteora Pool</a>` : null,
    pos.position ? `<a href="${solscanAcct(pos.position)}">Solscan Position</a>` : null,
  ].filter(Boolean).join(" · ");

  const cardText = [
    `🏊 <b>Position #${idx + 1} · ${escapeHTML(pos.pair)}</b>`,
    ``,
    `• <b>Status:</b> ${rangeStatus}${holdStatus}${stratStr}`,
    `• <b>Value:</b> <code>${dual(pos.total_value_usd, pos.total_value_true_usd)}</code>`,
    `• <b>PnL:</b> <code>${pnl}${pct}</code>`,
    `• <b>Unclaimed Fees:</b> <code>${dual(pos.unclaimed_fees_usd, pos.unclaimed_fees_true_usd)}</code>`,
    `• <b>Range Bins:</b> <code>${pos.lower_bin} → ${pos.upper_bin}</code> (active: <code>${pos.active_bin}</code>)`,
    `• <b>Age:</b> <code>${pos.age_minutes ?? "?"}m</code>`,
    pos.instruction ? `• <b>Instruction:</b> <i>${escapeHTML(pos.instruction)}</i>` : null,
    links ? `\n🔗 ${links}` : null,
  ].filter(Boolean).join("\n");

  const holdBtn = pos.hold_mode
    ? { text: "▶️ Resume Management (Unhold)", callback_data: `pos:hold:${idx}` }
    : { text: "🛡️ Put On Hold", callback_data: `pos:hold:${idx}` };

  const keyboard = [
    [holdBtn],
    [
      { text: "🏁 Close Position", callback_data: `pos:confirmclose:${idx}` },
      { text: "🔄 Rebalance (≤70)", callback_data: `pos:rebal:${idx}` },
    ],
    [
      { text: "⬅️ All Positions", callback_data: "pos:list" },
      { text: "🔄 Refresh", callback_data: `pos:view:${idx}` },
    ],
  ];

  return { text: cardText, keyboard };
}

export function renderConfirmCloseCard(pos, idx) {
  const cardText = [
    `⚠️ <b>Confirm Close: #${idx + 1} ${escapeHTML(pos.pair)}</b>`,
    ``,
    `Are you sure you want to exit and close this position?`,
    `• <b>Liquidity:</b> Unwound from Meteora DLMM`,
    `• <b>Fees:</b> Harvested to wallet`,
    `• <b>Swap:</b> Base tokens auto-swapped back to SOL`,
    ``,
    `<i>This action will withdraw capital on-chain.</i>`,
  ].join("\n");

  const keyboard = [
    [{ text: `🔴 Yes, Close ${pos.pair}`, callback_data: `pos:close:${idx}` }],
    [{ text: "❌ Cancel", callback_data: `pos:view:${idx}` }],
  ];

  return { text: cardText, keyboard };
}

async function showPositionsMenu({ messageId = null } = {}) {
  const { positions } = await getMyPositions({ force: true });
  const menu = renderPositionsMenu(positions);
  if (messageId) {
    await editHTMLWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendHTMLWithButtons(menu.text, menu.keyboard);
  }
}

async function handlePositionMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  const idx = parts[2] != null ? parseInt(parts[2], 10) : null;

  if (action === "list") {
    await answerCallbackQuery(msg.callbackQueryId, "Refreshing positions...").catch(() => {});
    await showPositionsMenu({ messageId: msg.messageId });
    return;
  }

  if (action === "dismiss") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed").catch(() => {});
    await deleteMessage(msg.messageId).catch(() => {});
    return;
  }

  const { positions } = await getMyPositions({ force: true });
  if (idx == null || idx < 0 || idx >= positions.length) {
    await answerCallbackQuery(msg.callbackQueryId, "Position not found (reloading)...").catch(() => {});
    await showPositionsMenu({ messageId: msg.messageId });
    return;
  }

  const pos = positions[idx];

  if (action === "view") {
    await answerCallbackQuery(msg.callbackQueryId, `${pos.pair} loaded`).catch(() => {});
    const card = renderPositionActionCard(pos, idx);
    await editHTMLWithButtons(card.text, msg.messageId, card.keyboard);
    return;
  }

  if (action === "hold") {
    const nextHold = !pos.hold_mode;
    setPositionHold(pos.position, nextHold, "telegram_button");
    const toast = nextHold ? `🛡️ ${pos.pair} is now On Hold` : `▶️ ${pos.pair} management resumed`;
    await answerCallbackQuery(msg.callbackQueryId, toast).catch(() => {});
    const refetched = await getMyPositions({ force: true });
    const updatedPos = refetched?.positions?.[idx] || { ...pos, hold_mode: nextHold };
    const card = renderPositionActionCard(updatedPos, idx);
    await editHTMLWithButtons(card.text, msg.messageId, card.keyboard);
    return;
  }

  if (action === "confirmclose") {
    await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
    const confirm = renderConfirmCloseCard(pos, idx);
    await editHTMLWithButtons(confirm.text, msg.messageId, confirm.keyboard);
    return;
  }

  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, `Closing ${pos.pair}...`).catch(() => {});
    await editHTMLWithButtons(`⏳ <b>Closing ${escapeHTML(pos.pair)}...</b>\nUnwinding on-chain liquidity and harvesting fees...`, msg.messageId, []);
    try {
      const result = await executeTool("close_position", {
        position_address: pos.position,
        reason: "manual close (button menu)",
      }, { operatorOverride: true });
      if (result?.success) {
        await editHTMLWithButtons(
          `✅ <b>Closed ${escapeHTML(pos.pair)}</b> successfully!\nLiquidity withdrawn and base tokens swapped back to SOL.`,
          msg.messageId,
          [[{ text: "⬅️ Return to Positions", callback_data: "pos:list" }]]
        );
      } else {
        await editHTMLWithButtons(
          `❌ <b>Failed to close ${escapeHTML(pos.pair)}:</b> <code>${escapeHTML(result?.reason || result?.error || "unknown")}</code>`,
          msg.messageId,
          [[{ text: "⬅️ Return to Positions", callback_data: "pos:list" }]]
        );
      }
    } catch (err) {
      await editHTMLWithButtons(
        `❌ <b>Error closing ${escapeHTML(pos.pair)}:</b> <code>${escapeHTML(err.message)}</code>`,
        msg.messageId,
        [[{ text: "⬅️ Return to Positions", callback_data: "pos:list" }]]
      );
    }
    return;
  }

  if (action === "rebal") {
    await answerCallbackQuery(msg.callbackQueryId, `Rebalancing ${pos.pair}...`).catch(() => {});
    await editHTMLWithButtons(`🔄 <b>Rebalancing ${escapeHTML(pos.pair)} (curve, ≤70 bins)...</b>`, msg.messageId, []);
    try {
      const result = await executeTool("rebalance_position", {
        position_address: pos.position,
        target_strategy: "curve",
        bins_below: 35,
        bins_above: 34,
        reason: "manual rebalance (button menu)",
      }, { operatorOverride: true });
      if (result?.success) {
        await editHTMLWithButtons(
          `✅ <b>Rebalanced ${escapeHTML(pos.pair)}</b> successfully!`,
          msg.messageId,
          [[{ text: "⬅️ Return to Positions", callback_data: "pos:list" }]]
        );
      } else if (result?.blocked) {
        await editHTMLWithButtons(
          `🚫 <b>Rebalance blocked:</b> ${escapeHTML(result.reason)}`,
          msg.messageId,
          [[{ text: "⬅️ Return to Positions", callback_data: "pos:list" }]]
        );
      } else {
        await editHTMLWithButtons(
          `❌ <b>Rebalance failed:</b> <code>${escapeHTML(result?.error || JSON.stringify(result))}</code>`,
          msg.messageId,
          [[{ text: "⬅️ Return to Positions", callback_data: "pos:list" }]]
        );
      }
    } catch (err) {
      await editHTMLWithButtons(
        `❌ <b>Error rebalancing ${escapeHTML(pos.pair)}:</b> <code>${escapeHTML(err.message)}</code>`,
        msg.messageId,
        [[{ text: "⬅️ Return to Positions", callback_data: "pos:list" }]]
      );
    }
    return;
  }
}

function formatSkimCard(status) {
  const solPrice = config.solPriceUsd || 0;
  const fmtVal = (sol) => solPrice > 0 ? `◎${sol.toFixed(4)} ($${(sol * solPrice).toFixed(2)})` : `◎${sol.toFixed(4)}`;
  const destStr = status.destination
    ? `<a href="https://solscan.io/account/${status.destination}">${status.destination.slice(0, 4)}…${status.destination.slice(-4)}</a>`
    : "<i>Not configured</i>";

  const lines = [
    `💸 <b>Pionex Profit Skimmer</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `• <b>Status:</b> ${status.enabled ? "🟢 Enabled (Autonomous)" : "⏸️ Disabled"}`,
    `• <b>Destination:</b> ${destStr}`,
    `• <b>Target Working Capital:</b> <code>◎${status.targetWorkingCapitalSol.toFixed(4)}</code>`,
    `• <b>Net Capital at Risk:</b> <code>◎${status.netCapitalAtRisk.toFixed(4)}</code>`,
    `• <b>Total Equity:</b> <code>${fmtVal(status.totalEquitySol)}</code>`,
    `• <b>Wallet Cash:</b> <code>◎${status.walletFreeSol.toFixed(4)}</code> (reserve: ◎${status.minWalletReserveSol})`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📊 <b>Transfer Readiness:</b>`,
    `• <b>Surplus:</b> <code>◎${status.surplusSol.toFixed(4)}</code> (min: ◎${status.minTransferAmountSol})`,
    `• <b>Transferable Now:</b> <b>◎${status.transferableSol.toFixed(4)}</b>`,
    `• <b>24h Transferred:</b> <code>◎${status.transferredLast24h.toFixed(4)} / ◎${status.maxDailyTransferSol}</code>`,
  ];

  if (status.inCooldown) {
    lines.push(`• <b>Cooldown:</b> ⏳ ${status.cooldownRemainingSec}s remaining`);
  }
  if (status.blockReason && status.enabled) {
    lines.push(`• <b>Auto-Skim Blocked:</b> <code>${escapeHTML(status.blockReason)}</code>`);
  }

  lines.push(
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>Commands: <code>/skim on</code> · <code>/skim off</code> · <code>/skim now</code></i>`
  );

  const keyboard = [
    [
      { text: status.enabled ? "⏸️ Disable" : "▶️ Enable", callback_data: status.enabled ? "skim:off" : "skim:on" },
      { text: "⚡ Skim Now", callback_data: "skim:now" },
      { text: "🔄 Refresh", callback_data: "skim:refresh" },
    ],
  ];

  return { text: lines.join("\n"), keyboard };
}

async function handleSkimMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];

  if (action === "refresh") {
    await answerCallbackQuery(msg.callbackQueryId, "Refreshing...").catch(() => {});
    const status = await getAutoSkimStatus({ freshPositions: true });
    const card = formatSkimCard(status);
    await editHTMLWithButtons(card.text, msg.messageId, card.keyboard);
    return;
  }

  if (action === "on" || action === "off") {
    const enabled = action === "on";
    await answerCallbackQuery(msg.callbackQueryId, enabled ? "Enabling..." : "Disabling...").catch(() => {});
    await executeTool("update_config", {
      changes: { autoSkimEnabled: enabled },
      reason: `Telegram button skim:${action}`,
    });
    const status = await getAutoSkimStatus({ freshPositions: false });
    const card = formatSkimCard(status);
    await editHTMLWithButtons(card.text, msg.messageId, card.keyboard);
    return;
  }

  if (action === "now") {
    const status = await getAutoSkimStatus({ freshPositions: true });
    if (!status.destinationValid) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid destination address").catch(() => {});
      return;
    }
    if (status.surplusSol < status.minTransferAmountSol) {
      await answerCallbackQuery(msg.callbackQueryId, `Surplus < ${status.minTransferAmountSol} SOL`).catch(() => {});
      return;
    }
    if (status.transferableSol < status.minTransferAmountSol) {
      await answerCallbackQuery(msg.callbackQueryId, "Cash constrained by gas reserve").catch(() => {});
      return;
    }
    if (status.dailyCapReached) {
      await answerCallbackQuery(msg.callbackQueryId, "Daily transfer cap reached").catch(() => {});
      return;
    }

    await answerCallbackQuery(msg.callbackQueryId, "Executing transfer...").catch(() => {});
    await editHTMLWithButtons("⏳ <b>Transferring profit to Pionex...</b>\nSending transaction to Solana network...", msg.messageId, []);

    const transferChunk = Math.floor(status.transferableSol / status.minTransferAmountSol) * status.minTransferAmountSol;
    const amount = Math.round(transferChunk * 1e4) / 1e4;

    const result = await transferSol({
      destination: status.destination,
      amountSol: amount,
      reason: "telegram_button_skim",
    });

    if (result.success) {
      const solPrice = config.solPriceUsd || 0;
      const usdVal = solPrice > 0 ? ` ($${(result.amountSol * solPrice).toFixed(2)})` : "";
      const msgText = [
        `💸 <b>Profit Skimmed to Pionex</b>`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Amount: <b>◎${result.amountSol.toFixed(4)}</b>${usdVal}`,
        `Destination: <code>${result.destination.slice(0, 4)}…${result.destination.slice(-4)}</code>`,
        `Remaining Wallet: <b>◎${result.remainingSol.toFixed(4)}</b>`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📊 <b>Capital Tracking:</b>`,
        `• Net Capital at Risk: <b>◎${status.netCapitalAtRisk.toFixed(4)}</b>`,
        `• Target Working Capital: <b>◎${status.targetWorkingCapitalSol.toFixed(4)}</b>`,
        `🔗 <a href="${solscanTx(result.tx)}">View on Solscan</a>`,
      ].join("\n");
      await editHTMLWithButtons(msgText, msg.messageId, [[{ text: "⬅️ Skimmer Status", callback_data: "skim:refresh" }]]);
    } else {
      await editHTMLWithButtons(
        `❌ <b>Transfer Failed:</b> <code>${escapeHTML(result.error || "unknown")}</code>`,
        msg.messageId,
        [[{ text: "⬅️ Skimmer Status", callback_data: "skim:refresh" }]]
      );
    }
    return;
  }
}

function formatHelpText() {
  return [
    "📋 <b>Meridian Command Center</b>",
    "",
    "📊 <b>Portfolio &amp; Monitoring</b>",
    "• <code>/manage</code> — Interactive position control buttons",
    "• <code>/positions</code> — List open positions &amp; status",
    "• <code>/status</code> — Wallet + positions snapshot",
    "• <code>/wallet</code> — Balance, sizing &amp; baseline metrics",
    "• <code>/pool &lt;n&gt;</code> — Detailed info for one open position",
    "• <code>/health</code> — System health check &amp; telemetry",
    "• <code>/briefing</code> — 24h market &amp; portfolio briefing",
    "",
    "⚙️ <b>Position Management</b>",
    "• <code>/close &lt;n&gt;</code> — Safely close position by number",
    "• <code>/rebalance &lt;n&gt; [strat]</code> — Rebalance bins (≤70 bins)",
    "• <code>/hold &lt;n|pair&gt;</code> — Operator HOLD (disable auto-exits)",
    "• <code>/unhold &lt;n|pair&gt;</code> — Resume autonomous management",
    "• <code>/adopt</code> — Adopt on-chain manual LP position",
    "• <code>/closeall</code> — Close all active positions",
    "• <code>/set &lt;n&gt; &lt;note&gt;</code> — Set custom instructions",
    "• <code>/unset &lt;n&gt;</code> — Clear custom instructions",
    "",
    "🔍 <b>Screening &amp; Discovery</b>",
    "• <code>/screen</code> — Run live candidate screening",
    "• <code>/candidates</code> — View latest screened pools",
    "• <code>/deploy &lt;n&gt;</code> — Deploy candidate by number",
    "• <code>/cri &lt;mint|n&gt;</code> — Cluster risk &amp; smart money audit",
    "• <code>/timing</code> — Deploy-timing profile by hour",
    "• <code>/exits</code> — Exit quality &amp; probe performance",
    "",
    "🛠️ <b>Config &amp; Controls</b>",
    "• <code>/config</code> — Active configuration overview",
    "• <code>/settings</code> — Interactive settings menu",
    "• <code>/setcfg &lt;key&gt; &lt;val&gt;</code> — Update runtime parameter",
    "• <code>/skim [on|off|now]</code> — Profit skimmer status &amp; controls",
    "• <code>/pause</code> | <code>/resume</code> — Pause/resume cron loops",
    "• <code>/hive</code> | <code>/hive pull</code> — HiveMind sync status",
    "",
    "🤖 <b>Agent &amp; System</b>",
    "• <code>/agy &lt;prompt&gt;</code> — Google Antigravity session",
    "• <code>/sessions</code> — List/resume past Agy sessions",
    "• <code>/gitstatus</code> — Git repo sync status",
    "• <code>/gitpull [force]</code> — Pull updates &amp; restart",
    "• <code>/restart</code> — Restart PM2 daemon",
    "• <code>/sync</code> — Trigger manual repo sync check",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    return formatCandidatesList(candidates, { title: "Top Candidates" });
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `• <b>${escapeHTML(entry.name)}:</b> <i>${escapeHTML(entry.reason)}</i>`)
    .join("\n");
  return examples
    ? `⚠️ <b>No candidates met screening criteria.</b>\n\n<b>Filtered Examples:</b>\n${examples}`
    : "⚠️ <i>No candidates available right now.</i>";
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (_latestCandidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow = computeBinsBelow(candidate.volatility);
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

// ─── Google Antigravity Session Management ──────────────────────
let _agySessionActive = false;
let _agyLastResponse = "";
let _agyActiveConversationId = null;
let _agyLastActiveTime = 0;
const AGY_SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours (1 day)

function checkAgySessionTimeout() {
  if (_agySessionActive && Date.now() - _agyLastActiveTime > AGY_SESSION_TIMEOUT) {
    _agySessionActive = false;
    _agyLastResponse = "";
    _agyActiveConversationId = null;
    log("telegram", "Google Antigravity session timed out after 24 hours of inactivity.");
    sendMessage("🚪 *Agy session closed* due to 24-hour inactivity timeout.", "Markdown").catch(() => {});
  }
}

async function getAgyConversationHistory(conversationId) {
  const path = await import("path");
  const os = await import("os");
  const fs = await import("fs");
  const transcriptPath = path.join(
    os.homedir(),
    `.gemini/antigravity-cli/brain/${conversationId}/.system_generated/logs/transcript.jsonl`
  );
  if (!fs.existsSync(transcriptPath)) return "";
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").trim().split("\n");
    let history = "";
    for (const line of lines) {
      if (!line) continue;
      const step = JSON.parse(line);
      if (step.source === "MODEL" && step.type === "PLANNER_RESPONSE" && step.content) {
        if (history) history += "\n";
        history += step.content.trim();
      }
    }
    return history.trim();
  } catch (e) {
    console.error("Failed to parse transcript history:", e.message);
    return "";
  }
}

async function getAgyConversations() {
  const path = await import("path");
  const os = await import("os");
  const fs = await import("fs");
  const convsDir = path.join(os.homedir(), ".gemini/antigravity-cli/conversations");
  if (!fs.existsSync(convsDir)) return [];
  
  try {
    const files = fs.readdirSync(convsDir)
      .filter(f => f.endsWith(".db"))
      .map(f => {
        const id = f.replace(".db", "");
        const stat = fs.statSync(path.join(convsDir, f));
        return { id, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5); // top 5
    
    const list = [];
    for (const item of files) {
      const transcriptPath = path.join(
        os.homedir(),
        `.gemini/antigravity-cli/brain/${item.id}/.system_generated/logs/transcript.jsonl`
      );
      let preview = "No prompt found";
      if (fs.existsSync(transcriptPath)) {
        try {
          const firstLine = fs.readFileSync(transcriptPath, "utf8").split("\n")[0];
          if (firstLine) {
            const step = JSON.parse(firstLine);
            if (step.content) {
              // Strip off system instruction block if present in preview
              let content = step.content.trim();
              if (content.startsWith("[SYSTEM INSTRUCTION]")) {
                const endTag = "[END OF SYSTEM INSTRUCTION]";
                const idx = content.indexOf(endTag);
                if (idx !== -1) {
                  content = content.substring(idx + endTag.length).trim();
                }
              }
              preview = content.slice(0, 35) + (content.length > 35 ? "..." : "");
            }
          }
        } catch {}
      }
      list.push({
        id: item.id,
        mtime: item.mtime,
        preview
      });
    }
    return list;
  } catch (e) {
    console.error("Failed to read agy conversations:", e.message);
    return [];
  }
}

// ─── Block Splitting Helper ──────────────────────────────────────
// Paginate text into chunks of ≤ AGY_PAGE_CHARS, preferring line boundaries so no
// single Telegram message exceeds the 4096-char cap. A lone over-long line is
// hard-split. Conservative size leaves room for markdown→HTML expansion + footer.
const AGY_PAGE_CHARS = 3500;
function paginateForTelegram(text, max = AGY_PAGE_CHARS) {
  const out = [];
  let cur = "";
  for (const rawLine of String(text).split("\n")) {
    let line = rawLine;
    // Hard-split a single line longer than the page size.
    while (line.length > max) {
      if (cur) { out.push(cur); cur = ""; }
      out.push(line.slice(0, max));
      line = line.slice(max);
    }
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

async function runAgyCommand(promptText, isContinuation) {
  let args = ["--dangerously-skip-permissions", "--print"];
  
  if (isContinuation && _agyActiveConversationId) {
    args.push("--conversation", _agyActiveConversationId);
  }
  
  let finalPrompt = promptText;
  if (!isContinuation) {
    // System runtime rules to prevent interactive tool errors
    const sysInstruction = 
      "[SYSTEM INSTRUCTION]\n" +
      "=== SYSTEM RUNTIME RULES ===\n" +
      "1. This is a non-interactive CLI wrapper. The stdin is ignored and the output is streamed to a chat interface.\n" +
      "2. DO NOT use the `ask_question` or `ask_permission` tools. Calling them will result in an immediate execution error.\n" +
      "3. If you need clarification, require confirmation, or want to ask the user a question, simply output the question as plain text in your final response. The user will reply in the chat to continue the conversation.\n" +
      "4. The active project workspace is `/opt/meridian`. Limit all file reads, writes, and grep searches to `/opt/meridian`. DO NOT search or view files outside `/opt/meridian` (such as in `/home/angga` or `/home/angga/Repos`).\n" +
      "[END OF SYSTEM INSTRUCTION]\n\n";
    finalPrompt = sysInstruction + promptText;
  }

  args.push(finalPrompt);

  const typingIndicator = createTypingIndicator();

  const { spawn } = await import("child_process");
  
  // Clean environment to use user's keyring credentials / Ultra plan quota
  const cleanEnv = { ...process.env };
  delete cleanEnv.GEMINI_API_KEY;
  delete cleanEnv.LLM_API_KEY;

  const child = spawn("/home/angga/.local/bin/agy", args, {
    cwd: REPO_ROOT,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  
  let currentStep = "Initializing...";
  let stepCount = 0;
  const stepSummary = [];
  const startTime = Date.now();

  // Rolling + spillover pages: pages[i] = { messageId, text }. The last page is
  // the live bubble (edited each tick); earlier pages are frozen once full.
  const pages = [];

  function formatToolName(rawName) {
    const mapped = {
      ReadFile: "Read File",
      ViewFile: "Read File",
      WriteFile: "Write File",
      WriteToFile: "Create File",
      ReplaceFileContent: "Modify File",
      GrepSearch: "Grep Search",
      SearchWeb: "Web Search",
      RunCommand: "Execute Command",
      InvokeSubagent: "Invoke Subagent",
    };
    return mapped[rawName] || rawName.replace(/_/g, " ");
  }

  function parseStderr(chunk) {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.includes("Starting conversation update stream")) {
        currentStep = "Starting agent loop...";
      } else if (line.includes("Auto-approving tool confirmation") || line.includes("approved=true")) {
        const match = line.match(/confirmation:\s*\"([^\"]+)\"/i) || line.match(/type=\*[a-zA-Z0-9_]+\.?([a-zA-Z0-9_]+)/i);
        let toolName = match ? match[1] : "tool";
        if (toolName.startsWith("Step_")) toolName = toolName.substring(5);
        
        const cleanName = formatToolName(toolName);
        if (!stepSummary.includes(`✅ ${cleanName}`)) {
          stepSummary.push(`✅ ${cleanName}`);
          stepCount++;
        }
        currentStep = `Step ${stepCount}: Executed ${cleanName}`;
      } else if (line.includes("error executing cascade step")) {
        currentStep = "Step execution error";
      } else {
        if (line.includes("grep_search") || line.includes("GREP_SEARCH")) {
          currentStep = "Searching codebase...";
        } else if (line.includes("view_file") || line.includes("ViewFile")) {
          currentStep = "Reading file...";
        } else if (line.includes("run_command") || line.includes("RunCommand")) {
          currentStep = "Running terminal command...";
        } else if (line.includes("search_web")) {
          currentStep = "Searching the web...";
        } else if (line.includes("read_url_content")) {
          currentStep = "Fetching URL content...";
        } else if (line.includes("write_to_file") || line.includes("replace_file_content") || line.includes("multi_replace_file_content")) {
          currentStep = "Saving file modifications...";
        }
      }
    }
  }

  // Render the current output across rolling pages. Only the last page carries the
  // live footer; earlier pages are frozen (body only). Edits are by stored id, so
  // streaming new lines just replaces the live bubble's content (spilling into a
  // fresh bubble when a page fills) rather than spamming a bubble per chunk.
  let rendering = false;
  async function render(isFinal = false) {
    if (rendering) return;
    rendering = true;
    try {
      let clean = stripThink(stdoutBuffer).trim();
      if (isContinuation && _agyLastResponse && clean.startsWith(_agyLastResponse)) {
        clean = clean.substring(_agyLastResponse.length).trim();
      }
      if (!clean) return; // nothing to show yet (or no new content) — close handles empties

      const chunks = paginateForTelegram(clean);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const listStr = stepSummary.length > 0 ? stepSummary.join(" | ") : "Thinking";
      const footer = isFinal
        ? `\n\n<tg-spoiler>⚡ [${listStr} — Completed in ${elapsed}s]</tg-spoiler>`
        : `\n\n<tg-spoiler>⚡ [${listStr} — ${currentStep} (${elapsed}s)]</tg-spoiler>`;

      for (let i = 0; i < chunks.length; i++) {
        const isLive = i === chunks.length - 1;
        const body = markdownToTelegramHTML(chunks[i]);
        const wantText = (isLive ? body + footer : body).slice(0, 4096);

        if (!pages[i]) {
          // New page → send a fresh bubble (this records the cross-process marker
          // via postTelegram, so the management cycle starts a new bubble after us).
          const init = (i === 0 && isContinuation && _agyActiveConversationId)
            ? `⏳ <i>Antigravity thinking…</i> (resuming <code>${_agyActiveConversationId.slice(0, 8)}…</code>)`
            : `⏳ <i>Antigravity thinking…</i>`;
          const sent = await sendHTML(init);
          pages[i] = { messageId: sent?.result?.message_id ?? null, text: null };
        }
        if (pages[i].messageId && pages[i].text !== wantText) {
          await editMessage(wantText, pages[i].messageId, "HTML").catch(() => {});
          pages[i].text = wantText;
        }
      }
    } finally {
      rendering = false;
    }
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    parseStderr(text);
  });

  const updateTimer = setInterval(() => { render(false).catch(() => {}); }, 1500);

  const killTimeout = setTimeout(() => {
    child.kill("SIGKILL");
    if (updateTimer) clearInterval(updateTimer);
    typingIndicator.stop();
    sendMessage("⚠️ Google Antigravity CLI execution timed out (5 minutes). Process killed.").catch(() => {});
  }, 300000);

  child.on("error", async (err) => {
    clearTimeout(killTimeout);
    if (updateTimer) clearInterval(updateTimer);
    typingIndicator.stop();
    busy = false;
    const errMessage = `❌ Process error: ${err.message}`;
    await sendMessage(errMessage).catch(() => {});
  });

  child.on("close", async (code) => {
    clearTimeout(killTimeout);
    if (updateTimer) clearInterval(updateTimer);
    typingIndicator.stop();
    busy = false;

    // Let any in-flight timer render finish so the final render isn't skipped by
    // the re-entrancy guard.
    for (let i = 0; i < 40 && rendering; i++) await new Promise((r) => setTimeout(r, 50));

    // Render the final state (completed footer). Uses the prior _agyLastResponse to
    // strip the continuation echo — so this MUST run before we overwrite it below.
    await render(true);

    const fullStdout = stripThink(stdoutBuffer).trim();
    let finalResponse = fullStdout;
    if (isContinuation && _agyLastResponse && finalResponse.startsWith(_agyLastResponse)) {
      finalResponse = finalResponse.substring(_agyLastResponse.length).trim();
    }

    if (!finalResponse) {
      if (pages.length === 0) await sendMessage("✅ Executed successfully (no output).").catch(() => {});
      return;
    }

    if (!_agyActiveConversationId) {
      try {
        const list = await getAgyConversations();
        if (list.length > 0) _agyActiveConversationId = list[0].id;
      } catch (err) {
        log("error", `Failed to detect conversation ID: ${err.message}`);
      }
    }

    _agySessionActive = true;
    _agyLastResponse = fullStdout;
    _agyLastActiveTime = Date.now();

    // After a short beat, strip the footer from the live (last) page for a clean read.
    const live = pages[pages.length - 1];
    if (live?.messageId) {
      setTimeout(async () => {
        const chunks = paginateForTelegram(finalResponse);
        const cleanLast = markdownToTelegramHTML(chunks[chunks.length - 1]).slice(0, 4096);
        if (cleanLast && cleanLast !== live.text) {
          await editMessage(cleanLast, live.messageId, "HTML").catch(() => {});
          live.text = cleanLast;
        }
      }, 5000);
    }
  });
}


async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

function isExplicitHoldRequest(text) {
  const value = String(text || "").trim();
  if (!value || /^\/(?:hold|unhold)\b/i.test(value)) return false;
  if (!/\bhold\b/i.test(value)) return false;
  if (/\b(?:until|when|if|after)\b/i.test(value) &&
      !/\b(?:do not|don't|nothing|only claim|no action)\b/i.test(value)) {
    return false;
  }
  return /\b(?:position|lp|set|keep|leave|manage|close|tp|sl|claim|nothing|anything)\b/i.test(value);
}

function matchesTelegramPosition(position, text) {
  const value = String(text || "").toLowerCase();
  return [position?.pair, position?.pool_name, position?.position, position?.pool]
    .filter(Boolean)
    .some((candidate) => value.includes(String(candidate).toLowerCase()));
}

function selectTelegramPosition(positions, selector, text) {
  if (selector) {
    const value = String(selector).trim().toLowerCase();
    if (/^\d+$/.test(value)) {
      const index = Number(value) - 1;
      return index >= 0 && index < positions.length ? positions[index] : null;
    }
    return positions.find((position) =>
      [position?.pair, position?.pool_name, position?.position, position?.pool]
        .filter(Boolean)
        .some((candidate) => String(candidate).toLowerCase() === value)
    ) || null;
  }

  const matches = positions.filter((position) => matchesTelegramPosition(position, text));
  if (matches.length === 1) return matches[0];
  return matches.length === 0 && positions.length === 1 ? positions[0] : null;
}

async function handleTelegramHoldControl(text) {
  const command = String(text || "").trim().match(/^\/(hold|unhold)(?:\s+(.+))?$/i);
  const natural = !command && isExplicitHoldRequest(text);
  if (!command && !natural) return false;

  const holding = natural || command[1].toLowerCase() === "hold";
  const selector = command?.[2]?.trim() || null;
  try {
    const result = await getMyPositions({ force: true });
    const positions = result?.positions || [];
    const position = selectTelegramPosition(positions, selector, text);
    if (!position) {
      const targetHint = positions.length > 1
        ? "Use <code>/positions</code>, then <code>/hold &lt;n&gt;</code> or <code>/unhold &lt;n&gt;</code>."
        : "No matching open position was found.";
      await sendHTML("⚠️ <b>Hold request not applied.</b> " + targetHint).catch(() => {});
      return true;
    }

    const ok = setPositionHold(position.position, holding, text);
    if (!ok) {
      await sendHTML("❌ <b>Hold request failed:</b> position is not tracked locally.").catch(() => {});
      return true;
    }

    const index = positions.indexOf(position) + 1;
    if (holding) {
      await sendHTML(
        `🛡️ <b>Operator HOLD Active</b> · <code>${escapeHTML(position.pair)}</code>\n` +
        `• Automatic exits (TP/SL/trailing/OOR) disabled\n` +
        `• Autonomous fee claims remain enabled\n\n` +
        `<i>Clear with <code>/unhold ${index}</code> or <code>/unset ${index}</code>.</i>`
      ).catch(() => {});
    } else {
      await sendHTML(
        `▶️ <b>Automatic Management Resumed</b> · <code>${escapeHTML(position.pair)}</code>\n` +
        `• Autonomous TP, SL, trailing, and OOR monitors re-armed\n` +
        `• Existing notes/instructions kept (clear with <code>/unset ${index}</code> if needed)`
      ).catch(() => {});
    }
  } catch (error) {
    await sendHTML("❌ <b>Hold request failed:</b> <code>" + escapeHTML(error.message) + "</code>").catch(() => {});
  }
  return true;
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;

  // Check timeout on incoming messages
  checkAgySessionTimeout();

  // Handle agy session resumption callback
  if (msg?.isCallback && text.startsWith("resumeagy:")) {
    try {
      const convId = text.substring(10).trim();
      _agySessionActive = true;
      _agyActiveConversationId = convId;
      _agyLastActiveTime = Date.now();
      await answerCallbackQuery(msg.callbackQueryId, "Resuming session...").catch(() => {});
      
      _agyLastResponse = await getAgyConversationHistory(convId);
      
      await sendMessage(`✅ *Google Antigravity Session Resumed*\nID: \`${convId}\`\n\nYou are now in a two-way chat session. Send any message directly to the agent. Type \`/exit\` to end.`, "Markdown");
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, `Error: ${e.message}`).catch(() => {});
      await sendMessage(`❌ Failed to resume session: ${e.message}`);
    }
    return;
  }

  // Auto-route non-command messages if session is active
  if (_agySessionActive && !msg.isCallback && !text.startsWith("/")) {
    busy = true;
    _agyLastActiveTime = Date.now();
    try {
      runAgyCommand(text, true);
    } catch (e) {
      sendMessage(`Error: ${e.message}`).catch(() => {});
      busy = false;
    }
    return;
  }

  if (_pendingInput && !msg.isCallback && !text.startsWith("/")) {
    const { key, page, menuMsgId } = _pendingInput;
    _pendingInput = null;
    let value;
    if (text.toLowerCase() === "off" || text.toLowerCase() === "null") {
      value = null;
    } else {
      value = Number(text);
      if (!Number.isFinite(value)) {
        await sendMessage(`Invalid value "${text}" — must be a number or "off".`);
        return;
      }
    }
    const result = await executeTool("update_config", { changes: { [key]: value }, reason: "Telegram input field" });
    if (!result?.success) {
      await sendMessage(`Failed to update ${key}.`);
      return;
    }
    await showSettingsMenu({ messageId: menuMsgId, page });
    return;
  }
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (msg?.isCallback && text.startsWith("relcb:")) {
    try {
      const parts = text.split(":");
      const type = parts[1];
      const address = parts[2];
      
      const { releaseCooldown } = await import("./pool-memory.js");
      const released = releaseCooldown({ type, address });
      
      if (released) {
        await answerCallbackQuery(msg.callbackQueryId, "Cooldown released!").catch(() => {});
        await editMessage(`✅ Released ${type} cooldown for address: \`${address}\``, msg.messageId);
      } else {
        await answerCallbackQuery(msg.callbackQueryId, "Cooldown not found or already released.").catch(() => {});
      }
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, `Error: ${e.message}`).catch(() => {});
      await sendMessage(`❌ Failed to release cooldown: ${e.message}`);
    }
    return;
  }
  if (msg?.isCallback && text.startsWith("pos:")) {
    try {
      await handlePositionMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (msg?.isCallback && text.startsWith("skim:")) {
    try {
      await handleSkimMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/manage" || text === "/control") {
    await showPositionsMenu().catch((e) => sendHTML(`❌ <b>Manager error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {}));
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (await handleTelegramHoldControl(text)) {
    return;
  }
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/exit" || text === "/done") {
    _agySessionActive = false;
    _agyLastResponse = "";
    _agyActiveConversationId = null;
    await sendMessage("🚪 *Google Antigravity Session Closed.*\nBack to normal Meridian bot control.", "Markdown");
    return;
  }

  if (text === "/sessions") {
    try {
      const list = await getAgyConversations();
      if (list.length === 0) {
        await sendMessage("No previous Google Antigravity sessions found.");
        return;
      }
      const inlineKeyboard = list.map((item, i) => {
        const label = `${i + 1}. ${item.preview}`;
        return [{
          text: label,
          callback_data: `resumeagy:${item.id}`
        }];
      });
      await sendMessageWithButtons("Select a Google Antigravity session to resume:", inlineKeyboard);
    } catch (e) {
      await sendMessage(`Failed to fetch sessions: ${e.message}`);
    }
    return;
  }

  if (text.startsWith("/agy ") || text === "/agy") {
    const promptText = text.substring(4).trim();
    if (!promptText) {
      await sendMessage("Usage: /agy <prompt>");
      return;
    }

    const isNew = promptText.startsWith("new ") || promptText.startsWith("reset ");
    let actualPrompt = promptText;
    if (isNew) {
      actualPrompt = promptText.substring(promptText.indexOf(" ") + 1).trim();
      _agySessionActive = false;
      _agyLastResponse = "";
      _agyActiveConversationId = null;
    }

    busy = true;
    try {
      const isContinuation = _agySessionActive && _agyActiveConversationId !== null;
      runAgyCommand(actualPrompt, isContinuation);
    } catch (e) {
      sendMessage(`Error: ${e.message}`).catch(() => {});
      busy = false;
    }
    return;
  }

  if (text === "/help") {
    await sendHTML(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/health") {
    try {
      const { getTelemetrySummary } = await import("./error-telemetry.js");
      const { getRpcHealthReport, getRpcTelemetrySnapshot } = await import("./tools/rpc.js");
      const telemetry = getTelemetrySummary();
      const rpcReport = getRpcHealthReport().map(r => `  ${r.status} ${r.pool}/${r.url}: ${r.avgLatencyMs}ms (${r.errorRate} err)`).join("\n");
      const rpcMetrics = getRpcTelemetrySnapshot({ kind: "wire" }).slice(0, 10)
        .map(r => `  ${r.kind}/${r.transport} ${r.pool}/${r.method}: ${r.requests} req, ${r.attempts} attempts, ${r.retries} retries, ${r.inFlight} in-flight, ${r.avgLatencyMs}ms avg`)
        .join("\n") || "  No RPC calls recorded yet";

      const mem = process.memoryUsage();
      const heapUsed = Math.round(mem.heapUsed / 1024 / 1024);
      const heapTotal = Math.round(mem.heapTotal / 1024 / 1024);

      const healthMsg = [
        `📊 <b>System Health Check</b>`,
        ``,
        `💻 <b>Resource Usage:</b>`,
        `  Heap Used: ${heapUsed} MB / ${heapTotal} MB`,
        `  Uptime: ${Math.round(process.uptime() / 60)} minutes`,
        ``,
        `🌐 <b>RPC Endpoints Status:</b>`,
        rpcReport,
        ``,
        `📈 <b>RPC Method Counters:</b>`,
        rpcMetrics,
        ``,
        `⚠️ <b>Error Telemetry:</b>`,
        telemetry
      ].join("\n");
      await sendHTML(healthMsg).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Health check error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nUse <b>/positions</b> for the numbered list.`
        : "";
      await sendHTML(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Status error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendHTML(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/adopt") {
    // Instant adoption of manually-created positions (operator deployed via wallet UI).
    // Bypasses the reconcile cron's 5-min age grace — the busy-guard covers the only
    // genuine race (a bot deploy whose trackPosition write is seconds behind its tx).
    if (_managementBusy || _screeningBusy) {
      await sendHTML("⏳ <i>A cycle is running (a bot deploy could be in flight) — retrying adoption in ~20s...</i>").catch(() => {});
      await new Promise((r) => setTimeout(r, 20_000));
      if (_managementBusy || _screeningBusy) {
        await sendHTML("⚠️ <i>Still busy — run <code>/adopt</code> again in a minute, or wait for the reconciliation cron (:07/:22/:37/:52).</i>").catch(() => {});
        return;
      }
    }
    try {
      const before = getTrackedPositions(true).length;
      const { reconcileStateWithChain } = await import("./state.js");
      await reconcileStateWithChain({ minAgeMinutes: 0 });
      const after = getTrackedPositions(true).length;
      const delta = after - before;
      await sendHTML(
        delta > 0
          ? `🩹 <b>Adopted ${delta} Position(s)</b>\nNow tracked and protected (${after} open total). PnL baseline = value at adoption.`
          : `ℹ️ <b>No untracked positions found on-chain</b> (${after} open, all tracked). If you deployed seconds ago, wait for the tx to finalize and run <code>/adopt</code> again.`
      ).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>/adopt failed:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendHTML("ℹ️ <b>No open positions.</b>"); return; }
      const cur = config.management.solMode ? "◎" : "$";
      // Dual display: under solMode the *_usd fields carry SOL; the *_true_usd
      // fields carry real USD. Σ = fee-inclusive total PnL (pnl_pct_derived).
      const dual = (val, trueUsd) => config.management.solMode && trueUsd != null && trueUsd !== 0
        ? `${cur}${val} ($${Number(trueUsd).toFixed(2)})`
        : `${cur}${val}`;
      const lines = positions.map((p, i) => {
        const pnl = (p.pnl_usd ?? 0) >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const pct = p.pnl_pct != null ? ` (${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%` +
          (p.pnl_pct_derived != null && Math.abs(p.pnl_pct_derived - p.pnl_pct) >= 0.05
            ? `, Σ${p.pnl_pct_derived >= 0 ? "+" : ""}${p.pnl_pct_derived}%` : "") + ")" : "";
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const rangeChip = p.in_range ? "🟢" : "🔴 OOR";
        const holdBadge = p.hold_mode ? " · 🛡️ <b>[HOLD]</b>" : "";
        const poolLink = p.pool ? `<a href="${meteoraPool(p.pool)}">${escapeHTML(p.pair)}</a>` : escapeHTML(p.pair);
        return [
          `<b>${i + 1}.</b> ${rangeChip} ${poolLink}${holdBadge}`,
          `   • Value: <code>${dual(p.total_value_usd, p.total_value_true_usd)}</code> · PnL: <code>${pnl}${pct}</code>`,
          `   • Fees: <code>${dual(p.unclaimed_fees_usd, p.unclaimed_fees_true_usd)}</code> · Age: <code>${age}</code>`,
        ].join("\n");
      });
      const summaryHeader = `📊 <b>Open Positions (${total_positions})</b>\n\n`;
      const footer = `\n\n<i>Quick commands: <code>/manage</code> · <code>/pool &lt;n&gt;</code> · <code>/close &lt;n&gt;</code> · <code>/rebalance &lt;n&gt;</code> · <code>/hold &lt;n&gt;</code></i>`;
      const keyboard = [
        [{ text: "🕹️ Manage Positions (Buttons)", callback_data: "pos:list" }]
      ];
      await sendHTMLWithButtons(`${summaryHeader}${lines.join("\n\n")}${footer}`, keyboard).catch(() => {});
    } catch (e) { await sendHTML(`❌ <b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {}); }
    return;
  }

  async function resolveTelegramPositionByIndex(idxStr) {
    const idx = parseInt(idxStr, 10) - 1;
    const { positions } = await getMyPositions({ force: true });
    if (!Number.isFinite(idx) || idx < 0 || idx >= positions.length) {
      await sendHTML("⚠️ <b>Invalid number.</b> Use <code>/positions</code> first.").catch(() => {});
      return null;
    }
    return { pos: positions[idx], idx, positions };
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const target = await resolveTelegramPositionByIndex(poolMatch[1]);
      if (!target) return;
      const card = renderPositionActionCard(target.pos, target.idx);
      await sendHTMLWithButtons(card.text, card.keyboard).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const target = await resolveTelegramPositionByIndex(closeMatch[1]);
      if (!target) return;
      const pos = target.pos;
      await sendHTML(`⏳ <b>Closing</b> <code>${escapeHTML(pos.pair)}</code>...`);
      // Route through executeTool (NOT closePosition directly) so all close
      // post-effects fire: the rich 🏁 close notification, base-token auto-swap
      // back to SOL, pool notes, and WebSocket resync. Manual closes previously
      // bypassed all of these.
      const result = await executeTool("close_position", { position_address: pos.position, reason: "manual close (/close)" }, { operatorOverride: true });
      if (result?.blocked) {
        await sendHTML(`🚫 <b>Close blocked:</b> ${escapeHTML(result.reason)}`);
      } else if (!result?.success) {
        await sendHTML(`❌ <b>Close failed:</b> <code>${escapeHTML(result?.error || JSON.stringify(result))}</code>`);
      }
      // On success the executor already sent the full 🏁 summary — no duplicate.
    } catch (e) { await sendHTML(`❌ <b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {}); }
    return;
  }

  const rebalanceMatch = text.match(/^\/rebalance\s+(\d+)(?:\s+(\w+))?$/i);
  if (rebalanceMatch) {
    try {
      const target = await resolveTelegramPositionByIndex(rebalanceMatch[1]);
      if (!target) return;
      const pos = target.pos;
      const targetStrategy = rebalanceMatch[2]?.toLowerCase() || "curve";
      await sendHTML(`🔄 <b>Rebalancing</b> <code>${escapeHTML(pos.pair)}</code> (${escapeHTML(targetStrategy)}, ≤70 bins)...`);
      const result = await executeTool("rebalance_position", {
        position_address: pos.position,
        target_strategy: targetStrategy,
        bins_below: 35,
        bins_above: 34,
        reason: "manual rebalance (/rebalance)",
      }, { operatorOverride: true });
      if (result?.blocked) {
        await sendHTML(`🚫 <b>Rebalance blocked:</b> ${escapeHTML(result.reason)}`);
      } else if (!result?.success) {
        await sendHTML(`❌ <b>Rebalance failed:</b> <code>${escapeHTML(result?.error || JSON.stringify(result))}</code>`);
      } else if (result?.dry_run) {
        await sendHTML(`ℹ️ <b>Dry run:</b> would rebalance <code>${escapeHTML(pos.pair)}</code> (${result.would_rebalance?.total_bins ?? 70} bins)`);
      }
      // On success the executor already sent the full 🔄 summary — no duplicate.
    } catch (e) { await sendHTML(`❌ <b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendHTML("ℹ️ <b>No open positions.</b>"); return; }
      await sendHTML(`⏳ <b>Closing ${positions.length} position(s)...</b>`);
      const results = [];
      for (const pos of positions) {
        try {
          // Through executeTool so each close gets the rich 🏁 notification,
          // auto-swap to SOL, pool notes, and socket resync (was bypassed).
          const result = await executeTool("close_position", { position_address: pos.position, reason: "manual close (/closeall)" }, { operatorOverride: true });
          const status = result?.success ? "✅ Closed" : `❌ Failed (${escapeHTML(result?.reason || result?.error || "unknown")})`;
          results.push(`• <b>${escapeHTML(pos.pair)}:</b> ${status}`);
        } catch (error) {
          results.push(`• <b>${escapeHTML(pos.pair)}:</b> ❌ Failed (${escapeHTML(error.message)})`);
        }
      }
      await sendHTML(`🏁 <b>Close-all Summary</b>\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Close-all Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const target = await resolveTelegramPositionByIndex(setMatch[1]);
      if (!target) return;
      const pos = target.pos;
      const note = setMatch[2].trim();
      setPositionInstruction(pos.position, note);
      await sendHTML(`📝 <b>Instruction Set</b> · <code>${escapeHTML(pos.pair)}</code>\n<i>"${escapeHTML(note)}"</i>`);
    } catch (e) { await sendHTML(`❌ <b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {}); }
    return;
  }

  const unsetMatch = text.match(/^\/unset\s+(\d+)$/i);
  if (unsetMatch) {
    try {
      const target = await resolveTelegramPositionByIndex(unsetMatch[1]);
      if (!target) return;
      const pos = target.pos;
      setPositionInstruction(pos.position, null);
      setPositionHold(pos.position, false);
      await sendHTML(`🧹 <b>Instruction Cleared</b> · <code>${escapeHTML(pos.pair)}</code>\n<i>Autonomous management restored.</i>`);
    } catch (e) { await sendHTML(`❌ <b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendHTML(`❌ <b>Config update failed.</b>\nUnknown keys: <code>${escapeHTML((result?.unknown || []).join(", ") || "none")}</code>`).catch(() => {});
        return;
      }
      await sendHTML(`✅ <b>Config Updated</b>\n<code>${escapeHTML(key)}</code> = <code>${escapeHTML(JSON.stringify(value))}</code>`).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/skim" || text.startsWith("/skim ")) {
    const sub = text.replace(/^\/skim\s*/i, "").trim().toLowerCase();

    if (sub === "on" || sub === "off") {
      const enabled = sub === "on";
      await executeTool("update_config", {
        changes: { autoSkimEnabled: enabled },
        reason: `Telegram slash command /skim ${sub}`,
      });
      const toast = enabled
        ? "✅ <b>Profit Skimmer Enabled</b>\nSurplus above target working capital will be transferred to Pionex automatically when ≥0.5 SOL."
        : "⏸️ <b>Profit Skimmer Disabled</b>\nAutonomous transfers paused.";
      await sendHTML(toast).catch(() => {});
      return;
    }

    if (sub === "now") {
      await sendHTML("⏳ <b>Evaluating Profit Skim...</b>").catch(() => {});
      const status = await getAutoSkimStatus({ freshPositions: true });
      if (!status.destinationValid) {
        await sendHTML(`❌ <b>Transfer Blocked:</b> Invalid destination address (${escapeHTML(status.destinationError || "unknown")})`).catch(() => {});
        return;
      }
      if (status.surplusSol < status.minTransferAmountSol) {
        await sendHTML(`ℹ️ <b>No Surplus to Skim:</b>\n• Total Equity: <b>◎${status.totalEquitySol.toFixed(4)}</b>\n• Target Capital: <b>◎${status.targetWorkingCapitalSol.toFixed(4)}</b>\n• Surplus: <b>◎${status.surplusSol.toFixed(4)}</b> (min: ◎${status.minTransferAmountSol})`).catch(() => {});
        return;
      }
      if (status.transferableSol < status.minTransferAmountSol) {
        await sendHTML(`⚠️ <b>Cash Constrained:</b>\n• Surplus is ◎${status.surplusSol.toFixed(4)}, but free wallet cash is ◎${status.walletFreeSol.toFixed(4)}.\n• Gas reserve floor: ◎${status.minWalletReserveSol.toFixed(4)}\n• Transferable cash: <b>◎${status.transferableSol.toFixed(4)}</b> (min: ◎${status.minTransferAmountSol})`).catch(() => {});
        return;
      }
      if (status.dailyCapReached) {
        await sendHTML(`⚠️ <b>Daily Cap Reached:</b>\nTransferred ◎${status.transferredLast24h.toFixed(4)} / ◎${status.maxDailyTransferSol.toFixed(4)} in last 24h.`).catch(() => {});
        return;
      }

      const transferChunk = Math.floor(status.transferableSol / status.minTransferAmountSol) * status.minTransferAmountSol;
      const amount = Math.round(transferChunk * 1e4) / 1e4;

      await sendHTML(`🚀 <b>Transferring ◎${amount.toFixed(4)} to Pionex...</b>`).catch(() => {});
      const result = await transferSol({
        destination: status.destination,
        amountSol: amount,
        reason: "manual_telegram_skim",
      });

      if (!result.success) {
        await sendHTML(`❌ <b>Transfer Failed:</b> <code>${escapeHTML(result.error)}</code>`).catch(() => {});
        return;
      }

      const solPrice = config.solPriceUsd || 0;
      const usdVal = solPrice > 0 ? ` ($${(result.amountSol * solPrice).toFixed(2)})` : "";
      const msgText = [
        `💸 <b>Profit Skimmed to Pionex</b>`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Amount: <b>◎${result.amountSol.toFixed(4)}</b>${usdVal}`,
        `Destination: <code>${result.destination.slice(0, 4)}…${result.destination.slice(-4)}</code>`,
        `Remaining Wallet: <b>◎${result.remainingSol.toFixed(4)}</b>`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📊 <b>Capital Tracking:</b>`,
        `• Net Capital at Risk: <b>◎${status.netCapitalAtRisk.toFixed(4)}</b>`,
        `• Target Working Capital: <b>◎${status.targetWorkingCapitalSol.toFixed(4)}</b>`,
        `🔗 <a href="${solscanTx(result.tx)}">View on Solscan</a>`,
      ].join("\n");
      await sendHTML(msgText).catch(() => {});
      return;
    }

    // Default: Show rich status card with buttons
    try {
      const status = await getAutoSkimStatus({ freshPositions: true });
      const card = formatSkimCard(status);
      await sendHTMLWithButtons(card.text, card.keyboard).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendHTML(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Screening Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendHTML(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  if (text === "/exits") {
    try {
      const { total_probed, families } = getExitQualitySummary({ limit: 30 });
      if (!total_probed) {
        await sendHTML("ℹ️ <i>No probed closes yet — post-close probes need ≥30 min after a close to start filling in. Check back after a few closes.</i>").catch(() => {});
        return;
      }
      const rows = families.map((f) => {
        const avg = f.avg_missed_pct != null && (f.early > f.good)
          ? `avg missed +${f.avg_missed_pct}%`
          : f.avg_saved_pct != null
            ? `avg saved +${f.avg_saved_pct}%`
            : "";
        const warn = f.selling_bottoms ? "  ⚠ selling bottoms" : "";
        return `${f.family.padEnd(12)} n=${String(f.n).padEnd(3)} good ${f.good} / early ${f.early} / flat ${f.flat}${f.delisted ? ` / dead ${f.delisted}` : ""}  ${avg}${warn}`;
      });
      await sendHTML(`🚪 <b>Exit Quality</b> (last ${total_probed} probed closes)\n<pre>${escapeHTML(rows.join("\n"))}</pre>\n<i>good = price kept falling after close · early = it bounced (sold the bottom)</i>`).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/timing") {
    try {
      await sendHTML(`<pre>${escapeHTML(formatDeployTimingReport())}</pre>`).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  const criMatch = text.match(/^\/cri(?:\s+(.+))?$/i);
  if (criMatch) {
    try {
      const query = criMatch[1]?.trim();
      if (!query) {
        await sendHTML("ℹ️ <i>Usage: <code>/cri &lt;mint|n&gt;</code> — inspect cluster risk and smart money flow.</i>").catch(() => {});
        return;
      }
      let mint = query;
      let poolObj = null;
      if (/^\d+$/.test(query)) {
        const idx = parseInt(query, 10) - 1;
        if (!_latestCandidates || !_latestCandidates[idx]) {
          await sendHTML(`❌ <i>Invalid candidate index #${query}. Run <code>/screen</code> first.</i>`).catch(() => {});
          return;
        }
        poolObj = _latestCandidates[idx];
        mint = poolObj.base?.mint || poolObj.mint;
      }

      await sendHTML(`⏳ <i>Auditing supply clusters &amp; smart money for <code>${escapeHTML(mint)}</code>...</i>`).catch(() => {});

      const tokenInfoRes = await getTokenInfo({ query: mint }).catch(() => null);
      const ti = tokenInfoRes?.results?.[0] || null;
      const targetMint = ti?.mint || mint;

      const signals = extractRugSignals(ti, poolObj || { base: { mint: targetMint } });
      const criResult = computeClusterRiskIndex(signals, { holders: ti?.audit?.top_holders });

      let devAnalysis = null;
      const devInput = ti?.dev || poolObj?.dev || (signals.dev_mints ? { creator_open_count: signals.dev_mints, dev_balance_pct: signals.dev_balance_pct } : null);
      if (devInput) {
        devAnalysis = computeDevScore({ dev: devInput });
      }

      const symbol = ti?.symbol || poolObj?.symbol || poolObj?.name || targetMint.slice(0, 8);
      const name = ti?.name || poolObj?.name || symbol;
      const badge = formatClusterRisk(criResult);

      const lines = [
        `🔍 <b>Cluster Risk &amp; Smart Money Audit</b>`,
        `Token: <b>${escapeHTML(name)}</b> (<code>${escapeHTML(symbol)}</code>)`,
        `Mint: <code>${escapeHTML(targetMint)}</code>`,
        ``,
        `<b>${badge}</b>`,
        `• <b>Top 10 Concentration:</b> <code>${criResult.concentration != null ? criResult.concentration.toFixed(1) + "%" : "N/A"}</code>`,
        `• <b>Bundler Supply:</b> <code>${criResult.bundler_pct != null ? criResult.bundler_pct.toFixed(1) + "%" : "N/A"}</code>`,
        `• <b>Fresh Wallets (&lt;24h):</b> <code>${criResult.fresh_wallet_pct != null ? criResult.fresh_wallet_pct.toFixed(1) + "%" : "N/A"}</code>`,
      ];

      if (signals.insider_pct != null) {
        lines.push(`• <b>Insider Holdings:</b> <code>${signals.insider_pct.toFixed(1)}%</code>`);
      }
      if (signals.sniper_pct != null) {
        lines.push(`• <b>Snipers:</b> <code>${signals.sniper_pct.toFixed(1)}%</code>`);
      }

      if (devAnalysis?.total != null) {
        lines.push(``, `👨‍💻 <b>Developer Reputation:</b> <code>${devAnalysis.total}/100</code>`);
        if (devAnalysis.components) {
          const c = devAnalysis.components;
          lines.push(`• Launch: <code>${c.launch_history ?? "?"}/25</code> · ATH: <code>${c.ath_record ?? "?"}/30</code> · Align: <code>${c.alignment ?? "?"}/20</code>`);
        }
      }

      await sendHTML(lines.join("\n")).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>CRI Audit Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `${result.strategy || config.strategy.strategy} | binsBelow: ${binsBelow}`;
      const links = [
        candidate.pool ? `<a href="${meteoraPool(candidate.pool)}">pool</a>` : null,
        result.position ? `<a href="${solscanAcct(result.position)}">position</a>` : null,
        result.txs?.length ? `<a href="${solscanTx(result.txs[0])}">tx</a>` : null,
      ].filter(Boolean).join(" · ");
      await sendHTML([
        `🚀 <b>Deployed Candidate</b> · <code>${escapeHTML(candidate.name)}</code>`,
        `• <b>Amount:</b> <code>${deployAmount} SOL</code>`,
        `• <b>Coverage:</b> <code>${coverage}</code>`,
        links ? `🔗 ${links}` : (result.position ? `Position: <code>${result.position.slice(0, 8)}...</code>` : null),
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Deploy Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/gitstatus" || text === "/git") {
    try {
      const { execSync } = await import("child_process");
      try {
        execSync("git fetch origin", { cwd: REPO_ROOT, timeout: 10000 });
      } catch (fetchErr) {
        console.error("Fetch failed in /gitstatus:", fetchErr.message);
      }
      const branch = execSync("git branch --show-current", { cwd: REPO_ROOT }).toString().trim();
      const localHash = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
      let statusLines = [
        `🐙 <b>Git Repository Status</b>`,
        ``,
        `• <b>Branch:</b> <code>${escapeHTML(branch)}</code>`,
        `• <b>Commit:</b> <code>${escapeHTML(localHash.slice(0, 7))}</code>`,
      ];
      
      let remoteExists = false;
      try {
        execSync(`git rev-parse --verify origin/${branch}`, { cwd: REPO_ROOT });
        remoteExists = true;
      } catch {}

      if (remoteExists) {
        const remoteHash = execSync(`git rev-parse origin/${branch}`, { cwd: REPO_ROOT }).toString().trim();
        if (localHash === remoteHash) {
          statusLines.push(`• <b>Upstream:</b> 🟢 Up-to-date with <code>origin/${escapeHTML(branch)}</code>`);
        } else {
          const mergeBase = execSync(`git merge-base HEAD origin/${branch}`, { cwd: REPO_ROOT }).toString().trim();
          if (mergeBase === localHash) {
            const commits = execSync(`git log HEAD..origin/${branch} --oneline`, { cwd: REPO_ROOT }).toString().trim();
            const commitCount = commits.split("\n").length;
            statusLines.push(
              `• <b>Upstream:</b> ⚠️ Behind <code>origin/${escapeHTML(branch)}</code> by ${commitCount} commit(s)`,
              ``,
              `<b>New Commits:</b>`,
              `<pre>${escapeHTML(commits)}</pre>`,
              ``,
              `<i>Use <code>/gitpull</code> to pull updates.</i>`
            );
          } else if (mergeBase === remoteHash) {
            statusLines.push(`• <b>Upstream:</b> 🚀 Ahead of <code>origin/${escapeHTML(branch)}</code>`);
          } else {
            statusLines.push(`• <b>Upstream:</b> ⚠️ Diverged from <code>origin/${escapeHTML(branch)}</code>`);
          }
        }
      }
      
      const uncommitted = execSync("git status --porcelain", { cwd: REPO_ROOT }).toString().trim();
      if (uncommitted) {
        statusLines.push(``, `⚠️ <b>Local uncommitted files:</b>`, `<pre>${escapeHTML(uncommitted)}</pre>`);
      } else {
        statusLines.push(`• <b>Working Tree:</b> 🟢 Clean (no uncommitted changes)`);
      }
      
      await sendHTML(statusLines.join("\n")).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>Git Error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/gitpull" || text === "/gitpull force") {
    try {
      const { execSync } = await import("child_process");
      const uncommitted = execSync("git status --porcelain", { cwd: REPO_ROOT }).toString().trim();
      const isForce = text === "/gitpull force";
      
      if (uncommitted && !isForce) {
        await sendHTML(
          `⚠️ <b>Uncommitted changes detected:</b>\n<pre>${escapeHTML(uncommitted)}</pre>\n` +
          `Pull aborted. Use <code>/gitpull force</code> to stash modifications, pull, and pop stash.`
        ).catch(() => {});
        return;
      }
      
      await sendHTML("⏳ <i>Fetching and pulling changes...</i>").catch(() => {});
      let stashed = false;
      if (uncommitted && isForce) {
        execSync("git stash", { cwd: REPO_ROOT });
        stashed = true;
      }
      
      execSync("git pull", { cwd: REPO_ROOT });
      await sendHTML("📦 <i>Updating dependencies...</i>").catch(() => {});
      execSync("npm install", { cwd: REPO_ROOT });
      
      if (stashed) {
        try {
          execSync("git stash pop", { cwd: REPO_ROOT });
          await sendHTML("✅ <b>Pull complete</b> (local changes stashed and popped back).").catch(() => {});
        } catch (popError) {
          await sendHTML("⚠️ <b>Pull complete, but stashed pop encountered conflicts.</b> Please resolve manually on the VM.").catch(() => {});
        }
      } else {
        await sendHTML("✅ <b>Pull complete</b> (clean update).").catch(() => {});
      }
      
      await sendHTML("🔄 <i>Restarting PM2 meridian daemon...</i>").catch(() => {});
      execSync("pm2 restart meridian --update-env");
    } catch (e) {
      await sendHTML(`❌ <b>Pull failed:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/restart") {
    try {
      const { execSync } = await import("child_process");
      await sendHTML("🔄 <i>Restarting PM2 meridian daemon...</i>").catch(() => {});
      execSync("pm2 restart meridian --update-env");
    } catch (e) {
      await sendHTML(`❌ <b>Restart failed:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/sync") {
    try {
      const { exec } = await import("child_process");
      await sendHTML("⏳ <i>Triggering upstream sync check...</i>").catch(() => {});
      exec(`node ${repoPath("scripts/repo_syncer.js")}`, (err, stdout, stderr) => {
        if (err) {
          sendHTML(`❌ <b>Sync failed:</b> <code>${escapeHTML(err.message)}</code>`).catch(() => {});
        } else {
          const out = stdout.trim() || stderr.trim();
          if (out.includes("Up to date")) {
            sendHTML(`✅ <b>Syncer:</b> <code>${escapeHTML(out)}</code>`).catch(() => {});
          }
        }
      });
    } catch (e) {
      await sendHTML(`❌ <b>Sync trigger failed:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendHTML("⏸ <b>Autonomous Cycles Paused</b>\nTelegram control still works. Use <code>/resume</code> to start again.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    // Reset circuit breaker if it was tripped
    const cb = checkCircuitBreaker();
    if (cb.tripped) {
      resetCircuitBreaker();
    }
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendHTML("▶️ <b>Autonomous Cycles Resumed</b>" + (cb.tripped ? "\n<i>Circuit breaker has been reset.</i>" : "")).catch(() => {});
    } else {
      await sendHTML("ℹ️ <b>Autonomous cycles are already running.</b>" + (cb.tripped ? "\n<i>Circuit breaker has been reset.</i>" : "")).catch(() => {});
    }
    return;
  }

  if (text === "/cooldowns" || text === "/cooldown" || text === "/release") {
    try {
      const { getActiveCooldowns } = await import("./pool-memory.js");
      const list = getActiveCooldowns();
      if (list.length === 0) {
        await sendHTML("ℹ️ <b>No active pool or token cooldowns.</b>");
        return;
      }
      
      const inlineKeyboard = list.map((item) => {
        const typeLabel = item.type === "pool" ? "Pool" : "Token";
        const timeStr = new Date(item.until).toLocaleTimeString("en-US", { hour12: false, timeZone: "Asia/Jakarta" }) + " WIB";
        const label = `❌ Release ${typeLabel}: ${item.name} (${item.reason || "cooldown"} until ${timeStr})`;
        return [{
          text: label,
          callback_data: `relcb:${item.type}:${item.address}`
        }];
      });
      
      await sendHTMLWithButtons("🧊 <b>Active Cooldowns</b>\nSelect a cooldown to release manually:", inlineKeyboard);
    } catch (e) {
      await sendHTML(`❌ <b>Failed to fetch cooldowns:</b> <code>${escapeHTML(e.message)}</code>`);
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendHTML(`🧠 <b>HiveMind:</b> <code>disabled</code>\nAgent ID: <code>${escapeHTML(agentId)}</code>\nSet <code>HIVE_MIND_URL</code> + <code>HIVE_MIND_API_KEY</code> in .env to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendHTML([
        "🧠 <b>HiveMind Network Status</b>",
        "",
        `• <b>Status:</b> 🟢 Active`,
        `• <b>Agent ID:</b> <code>${escapeHTML(agentId)}</code>`,
        `• <b>URL:</b> <code>${escapeHTML(config.hiveMind.url)}</code>`,
        `• <b>Pull Mode:</b> <code>${escapeHTML(pullMode)}</code>`,
        `• <b>Registration:</b> <code>${registerResult ? "✅ ok" : "⚠️ warn"}</code>`,
        `• <b>Shared Lessons:</b> <code>${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}</code>`,
        `• <b>Presets:</b> <code>${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}</code>`,
        isManualPull ? "\n✅ <i>Manual pull completed successfully.</i>" : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendHTML(`❌ <b>HiveMind error:</b> <code>${escapeHTML(e.message)}</code>`).catch(() => {});
    }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`, true);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name, input }) => {
        const pair = input?.pair || (input?.position_address ? `pos ${input.position_address.slice(0, 8)}...` : null);
        await liveMessage?.toolStart(name, { pair, poolName: input?.pool_name, detail: input?.reason });
      },
      onToolFinish: async ({ name, input, result, success }) => {
        const pair = input?.pair || (input?.position_address ? `pos ${input.position_address.slice(0, 8)}...` : null);
        await liveMessage?.toolFinish(name, result, success, { pair, poolName: input?.pool_name, detail: input?.reason });
      },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isMain && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);
  startCommandServer();

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /timing        Show deploy-timing profile by hour-of-day (advisory)
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is screening for a deploy-worthy candidate...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, decide whether any candidate is worth deploying, and only call deploy_position with ${DEPLOY} SOL if conviction is strong. A single returned candidate is the normal state — judge it on its own merits (narrative, degen/pool-metric conviction, or ACCELERATING flow with a clean safety profile); smart wallets are a boost, not a requirement. If nothing qualifies, report NO DEPLOY. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/timing") {
      console.log("\n" + formatDeployTimingReport() + "\n");
      rl.prompt();
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  rankMinIntelScore:    ${s.rankMinIntelScore}`);
      console.log(`  rankAdmitCount:       ${s.rankAdmitCount}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const { getAllPerformance } = await import("./lessons.js");
        const result = evolveThresholds(getAllPerformance(), config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  startCommandServer();
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
