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
import { recordError } from "./error-telemetry.js";
import { getMyPositions, closePosition, getActiveBin, estimateCycleGasCost, gasBreakEvenMinutes, flipPositionInPlace } from "./tools/dlmm.js";
import { getWalletBalances, getWalletAddress } from "./tools/wallet.js";
import { getTopCandidates, degenScore } from "./tools/screening.js";
import { formatFeeEfficiency } from "./fee-efficiency.js";
import { formatPoolSimLine } from "./pool-simulator.js";
import { formatOrganicMomentum, getOrganicMomentumForPool } from "./organic-momentum.js";
import { formatGmgnCandidateForPrompt } from "./tools/gmgn.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary, getAllPerformance, recordPostCloseProbe, markPostCloseUnprobeable, getExitQualitySummary, formatSimilarDeploysLine, applyStarvationRelaxation } from "./lessons.js";
import { executeTool, registerCronRestarter, sweepWalletDust } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
  createTypingIndicator,
  markdownToTelegramHTML,
  escapeHTML,
  fmtDuration,
  fmtSolUsd,
} from "./telegram.js";
import { readLastOutboundId } from "./telegram-marker.js";
import { generateBriefing } from "./briefing.js";
import { publishDashboardReport, pgNotify } from "./report.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, updatePnlAndCheckExits, confirmPeak, registerExitSignal, getBaselineState, initState, flushState, persistWalletAddress, getScreeningStarvation, saveScreeningStarvation } from "./state.js";
import { initAllDocStores, flushAllDocStores } from "./db/doc-store.js";
import { recordTick, flushTicks } from "./db/tick-store.js";
import { latestBalanceTs, recordBalanceEntry } from "./balance-history.js";
import { getActiveStrategy } from "./strategy-library.js";
import { getSolPriceUsd } from "./sol-price.js";
import { formatDeployTimingAdvisory, formatDeployTimingReport, getDeployTimingGate } from "./deploy-timing.js";
import { getCachedLpStudy, formatTopLperStyle, lperConsensusStyle, lperBinsRecommendation } from "./lper-signal.js";
import { recordPositionSnapshot, recallForPool, addPoolNote, getPoolSnapshots, isPoolOnCooldown, isBaseMintOnCooldown } from "./pool-memory.js";
import { analyzePositionHealth, getPoolHealthConfig, formatHealthAlertLines } from "./position-alerts.js";
import { checkPositionsPvp, formatPvpAlert } from "./pvp.js";
import { getPoolDetail } from "./tools/screening.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { extractRugSignals, evaluateRugFilter, getRugFilterConfig, formatRugTrips } from "./rug-signals.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";
import { checkCircuitBreaker, resetCircuitBreaker, getCircuitBreakerStatus, updateSolPrice } from "./circuit-breaker.js";
import { recordSolPrice, checkSolVolatility, getSolVolatilityStatus } from "./sol-volatility.js";
import { formatRpcHealth } from "./tools/rpc.js";
import { monitorEventLoopDelay } from "perf_hooks";
import { startSocketMonitor, stopSocketMonitor, syncSocketSubscriptions } from "./tools/socket-monitor.js";
import { getPnlConnection } from "./tools/pnl.js";

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
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  // Initialise the persistence cache before any state accessor runs. Required
  // for the pg backend (Postgres can't be read synchronously); harmless for json.
  await initState();
  await initAllDocStores();
  // Publish the wallet address to state_meta so read-only consumers (dashboard)
  // resolve it from the DB instead of the stale monitor-status.json file.
  await persistWalletAddress(getWalletAddress());
  log("startup", `Persistence backend: ${(process.env.PERSIST_BACKEND || "json").toLowerCase()}`);
  ensureAgentId();
  bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  startHiveMindBackgroundSync();
}

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

// ─── OOR-Above Price Stabilization ─────────────────────────────
const _recentActiveBins = new Map();

/**
 * Track and check if a position's price has stabilized (active bin stopped moving).
 * Returns true if the active bin hasn't changed for `requiredStableTicks` consecutive checks.
 * Used to prevent closing OOR-above positions during active pumps.
 */
function isPriceStable(positionAddress, currentActiveBin) {
  const requiredStableTicks = config.management.oorAboveStableTicks ?? 2;
  const history = _recentActiveBins.get(positionAddress) ?? [];
  history.push(currentActiveBin);
  while (history.length > requiredStableTicks + 1) history.shift();
  _recentActiveBins.set(positionAddress, history);

  if (history.length < requiredStableTicks + 1) return false;
  const recent = history.slice(-requiredStableTicks);
  return recent.every(bin => bin === currentActiveBin);
}

/** Clear price history for a closed position. */
function clearPriceHistory(positionAddress) {
  _recentActiveBins.delete(positionAddress);
  _binTrail.delete(positionAddress);
  _rugTrail.delete(positionAddress);
  _crashFired.delete(positionAddress);
}

// ─── OOR-below flip tactic (plan #07) ──────────────────────────
// In-process marker of positions whose crash fast-path detector ever fired.
// Used by the flip gate ("crash never fired for this position") to keep flips
// off the velocity-crash population — flips are only ever for slow-drift OOR.
// In-process only, like _binTrail; cleared on close.
const _crashFired = new Set(); // position_address

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
  return {
    crash: true,
    reason: `crash-below ${binsDropped} bins/${spanSec.toFixed(0)}s ` +
            `(${binsPerMin.toFixed(1)} b/min ≥ ${cfg.crashBinsPerMin ?? 12}, dist ${distBelow})`,
  };
}

/**
 * OOR-below flip decision (plan #07). Pure + total predicate: given a live position
 * that would otherwise close for OOR-below, decide whether to FLIP instead —
 * withdraw the (now ~100% base-token) liquidity and re-add it as a single-sided
 * ask ladder in the same bins, so a mean-reverting recovery sells back at range
 * prices + fees, rather than close→zap-to-SOL at the local bottom.
 *
 * ALL gates must pass (any failing gate → no flip; a genuine rug must still close):
 *   1. must be an OOR-below break (active_bin < lower_bin)
 *   2. the crash fast-path never fired for this position (flip only for slow drift,
 *      never the velocity-crash population — plan §4 cross-check)
 *   3. organic momentum ≠ decaying (the crowd is not abandoning the pool)
 *   4. no active volume-death health alert (fee engine not dead)
 *   5. pool + base-mint not on a repeat-deploy cooldown
 *   6. flip cap not reached (flip_count < oorFlipMaxPerPosition)
 *
 * Returns { flip:true, reason } when all gates pass, else { flip:false, blocked_by }.
 * Never throws. The `oorFlipEnabled` flag is NOT checked here — the caller decides
 * whether to ACT on a true result or only shadow-log it, mirroring the crash fast-path.
 */
function shouldFlipOorBelow(position, tracked, cfg) {
  const activeBin = position?.active_bin != null ? Number(position.active_bin) : null;
  const lowerBin  = position?.lower_bin  != null ? Number(position.lower_bin)  : null;
  if (!Number.isFinite(activeBin) || !Number.isFinite(lowerBin)) return { flip: false, blocked_by: "no_bin_data" };
  if (!(activeBin < lowerBin)) return { flip: false, blocked_by: "not_oor_below" };

  // GATE 2 — crash fast-path never fired for this position.
  if (_crashFired.has(position.position)) return { flip: false, blocked_by: "crash_fired" };

  // GATE 3 — organic momentum must not be decaying (crowd leaving = flip rides to zero).
  const momentum = getOrganicMomentumForPool(position.pool);
  if (momentum?.classification === "decaying") return { flip: false, blocked_by: "momentum_decaying" };

  // GATE 4 — no volume-death alert (health signal that the fee engine is dying).
  const alerts = Array.isArray(position?.health?.alerts) ? position.health.alerts : [];
  if (alerts.some((a) => a?.code === "volume_death")) return { flip: false, blocked_by: "volume_death" };

  // GATE 5 — pool / base-mint not on a repeat-deploy cooldown.
  try {
    if (position.pool && isPoolOnCooldown(position.pool)) return { flip: false, blocked_by: "pool_cooldown" };
    const baseMint = tracked?.base_mint || position?.base_mint;
    if (baseMint && isBaseMintOnCooldown(baseMint)) return { flip: false, blocked_by: "mint_cooldown" };
  } catch { /* cooldown lookups are advisory — never block on a lookup fault */ }

  // GATE 6 — flip cap (plan §3: one chance only, then close for real).
  const flipCount = Number(tracked?.flip_count ?? 0);
  const flipMax = Math.max(0, Number(cfg?.oorFlipMaxPerPosition ?? 1));
  if (flipCount >= flipMax) return { flip: false, blocked_by: "flip_cap" };

  // GATE 7 — bail-out: if this position was already flipped and hasn't recovered
  // within oorFlipBailHours, stop waiting — close+zap for real (the loss was real).
  if (tracked?.flipped_at) {
    const bailMs = Math.max(0, Number(cfg?.oorFlipBailHours ?? 6)) * 3600 * 1000;
    if (bailMs > 0 && (Date.now() - new Date(tracked.flipped_at).getTime()) >= bailMs) {
      return { flip: false, blocked_by: "bail_timeout" };
    }
  }

  const distBelow = lowerBin - activeBin;
  return {
    flip: true,
    reason: `flip-below: OOR ${distBelow} bins below, momentum ${momentum?.classification ?? "unknown"}, ` +
            `no crash/volume-death/cooldown, flip ${flipCount}/${flipMax}`,
  };
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
let _managementBusy = false; // prevents overlapping management cycles
let _mgmtCycleCount = 0; // drives the periodic dust-sweep cadence (every ~10th cycle)
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
// Declined-candidates suppressor: when a screening LLM decision declines a candidate set,
// remember its fingerprint and skip re-asking the LLM about the IDENTICAL set for
// opportunity.retriggerCooldownMin. Any change in the set (new pool, one drops out)
// changes the fingerprint and re-enables the LLM immediately. Covers all trigger paths
// (cron, post-management, opportunity poll). In-memory — clears on restart.
let _lastDeclinedCandidates = { fp: null, at: 0 };
let _lastNotifiedMgmtSig = null; // last management state (status+action+set) we notified on — suppresses unchanged "all STAY" spam
let _lastMgmtMsgId = null; // message_id of the rolling management-cycle bubble (edited in place across ticks)
let _lastTickNotify = 0; // epoch ms — throttles the meridian_tick pg NOTIFY to at most 1/15s
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
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
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
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
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
 * 30/60/180-min slot. Slots that missed their grace window (restart gap) are
 * marked stale rather than retried forever. 0–2 fetches/cycle in steady state.
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
const STATE_CHANGING_TOOLS = new Set(["close_position", "claim_fees", "flip_position", "swap_token"]);

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
    if (llmActions.has(act.action)) { llmPositions.push(p); continue; }

    if (act.action === "CLOSE") {
      const reason = act.reason || (act.rule ? `Rule ${act.rule}` : "rule close");
      markStateChanged(); // announce even if the close ultimately fails — a failed close matters too
      await liveMessage?.toolStart("close_position");
      const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("close_position", res, ok);
      lines.push(`${p.pair}: ${ok ? `closed (${reason})` : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    } else if (act.action === "FLIP") {
      // OOR-below flip tactic (plan #07) — only reached when oorFlipEnabled is ON and
      // the flip gates passed. Withdraws + re-adds the base token as an ask ladder in
      // the same range instead of closing. On any failure we fall back to a real close
      // so a failed flip never strands the position OOR-below.
      const reason = act.reason || "oor-below flip";
      markStateChanged();
      await liveMessage?.toolStart("flip_position");
      const res = await flipPositionInPlace({ position_address: p.position, reason }).catch(e => ({ error: e.message }));
      const flipped = res?.success !== false && res?.flipped === true;
      await liveMessage?.toolFinish("flip_position", res, flipped);
      if (flipped) {
        lines.push(`${p.pair}: flipped (${reason}) → ask ladder ${res.bin_range?.min}-${res.bin_range?.max}`);
      } else {
        log("cron_warn", `Flip failed for ${p.pair} (${res?.error || "unknown"}) — falling back to close`);
        const cres = await executeTool("close_position", { position_address: p.position, reason: `flip-failed→close: ${reason}` }).catch(e => ({ error: e.message }));
        const cok = cres?.success !== false && !cres?.error && !cres?.blocked;
        lines.push(`${p.pair}: flip FAILED (${res?.error || "unknown"}) — ${cok ? "closed instead" : `close also FAILED — ${cres?.error || "unknown"}`}`);
      }
    } else if (act.action === "CLAIM") {
      markStateChanged();
      await liveMessage?.toolStart("claim_fees");
      const res = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("claim_fees", res, ok);
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
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => {
        // An LLM-judged INSTRUCTION/REVIEW position can be closed by the model
        // itself — treat that as state-changing too, so the cycle finalizes with
        // a real (notifying) message rather than a silent bubble edit.
        if (STATE_CHANGING_TOOLS.has(name)) markStateChanged();
        await liveMessage?.toolFinish(name, result, success);
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
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  writeHeartbeat("management");

  // Log heap usage and telemetry warning if > 70% of 512MB
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  log("memory", `Heap usage: ${heapUsedMb} MB / 512 MB (limit)`);
  if (heapUsedMb > 358) {
    log("memory_warn", `Heap usage is high: ${heapUsedMb} MB (> 70% of limit)`);
    recordError("memory_warning", `High memory usage: ${heapUsedMb} MB`);
  }

  log("cron", "Starting management cycle");
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
      // Reuse (edit) the previous management bubble when it's still the last
      // message in the chat; start a fresh one if anything (incl. other
      // processes) has posted since.
      const canReuse = _lastMgmtMsgId != null && readLastOutboundId() === _lastMgmtMsgId;
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...", {
        reuseMessageId: canReuse ? _lastMgmtMsgId : null,
      });
      _lastMgmtMsgId = liveMessage?.getMessageId?.() ?? _lastMgmtMsgId;
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

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
      publishDashboardReport({ positions: [], actions: null, nextScreenSec: null });
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
      return { ...enriched, recall: recallForPool(p.pool), health, fresh_snapshots };
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
      confirmPeak(p.position, p.pnl_pct, 1);
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM) | REVIEW (needs LLM)
    const actionMap = new Map();
    let _claimPriceWarned = false; // rate-limit the cold-start price warning to once per cycle
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        // OOR-below flip tactic (plan #07) — before committing a slow-drift OOR-below
        // close to a market sell at the local bottom, check the flip gates. While
        // `oorFlipEnabled` is OFF we only shadow-log; when ON we route to FLIP (which
        // withdraws + re-adds the base tokens as an ask ladder in the same range).
        // Never touches the crash/stop-loss/above paths — only the below-time rule.
        if (closeRule.oor_direction === "below") {
          try {
            const tracked = getTrackedPosition(p.position);
            const flip = shouldFlipOorBelow(p, tracked, config.management);
            if (flip.flip) {
              if (config.management.oorFlipEnabled) {
                actionMap.set(p.position, {
                  action: "FLIP",
                  rule: closeRule.rule,
                  reason: flip.reason,
                  oor_direction: "below",
                });
                continue;
              }
              log("oor_flip_shadow", `[OOR_FLIP_SHADOW] would flip ${p.pair}: ${flip.reason} (oorFlipEnabled=false — closing instead)`);
            } else {
              log("oor_flip_shadow", `[OOR_FLIP_SHADOW] no flip ${p.pair}: blocked_by=${flip.blocked_by} — closing`);
            }
          } catch (e) {
            log("cron_warn", `OOR-flip decision error (ignored): ${e.message}`);
          }
        }
        actionMap.set(p.position, closeRule);
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

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      
      const activeBin = p.active_bin != null ? Number(p.active_bin) : null;
      const lowerBin = p.lower_bin != null ? Number(p.lower_bin) : null;
      const upperBin = p.upper_bin != null ? Number(p.upper_bin) : null;
      
      let OorDetail = "";
      let statusText = "🟢 IN RANGE";

      if (p.in_range === false) {
        let direction = "OOR";
        let binDiff = 0;
        let limit = config.management.outOfRangeWaitMinutes ?? 15;

        if (activeBin != null && lowerBin != null && activeBin < lowerBin) {
          direction = "Below";
          binDiff = lowerBin - activeBin;
          limit = config.management.outOfRangeWaitMinutesBelow ?? limit;
        } else if (activeBin != null && upperBin != null && activeBin > upperBin) {
          direction = "Above";
          binDiff = activeBin - upperBin;
          limit = config.management.outOfRangeWaitMinutesAbove ?? limit;
        }

        statusText = `🔴 OOR ${direction} ${fmtDuration(p.minutes_out_of_range ?? 0)}`;
        OorDetail = `\n   └ <i>bin ${activeBin ?? "?"} vs ${direction === "Below" ? lowerBin : upperBin} (${direction === "Below" ? "-" : "+"}${binDiff}) · auto-close ${fmtDuration(p.minutes_out_of_range ?? 0)}/${fmtDuration(limit)}</i>`;
      }

      const val = dualCur(p.total_value_usd, p.total_value_true_usd);
      const unclaimed = dualCur(p.unclaimed_fees_usd, p.unclaimed_fees_true_usd);
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      // pnl_pct is the API's (lags fee accrual); pnl_pct_derived is the local
      // fee-inclusive total (balance + unclaimed fees − deposit). Show Σ when
      // it meaningfully differs so accruing fees are visible pre-claim.
      let pnlStr = p.pnl_pct != null ? `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(2)}%` : "?%";
      if (p.pnl_pct_derived != null && p.pnl_pct != null && Math.abs(p.pnl_pct_derived - p.pnl_pct) >= 0.05) {
        pnlStr += ` (Σ${p.pnl_pct_derived >= 0 ? "+" : ""}${p.pnl_pct_derived.toFixed(2)}%)`;
      }
      const yieldStr = p.fee_per_tvl_24h != null ? `${p.fee_per_tvl_24h.toFixed(2)}%` : "?%";

      // Two compact lines per position: identity/status/action, then the numbers.
      const ageStr = p.age_minutes != null ? fmtDuration(p.age_minutes) : "?";
      let line = `<a href="https://app.meteora.ag/dlmm/${p.pool}"><b>${escapeHTML(p.pair)}</b></a> · ${statusText} · <b>${statusLabel}</b>` +
                 `\n   💰<code>${val}</code> · 📈 ${pnlStr} · ⏱️ ${ageStr} · 💎<code>${unclaimed}</code> (${yieldStr}/24h)` +
                 OorDetail;

      if (p.instruction) line += `\n   └ 📝 <i>"${escapeHTML(p.instruction)}"</i>`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n   └ ⚠️ <i>Trailing TP: ${escapeHTML(act.reason)}</i>`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\n   └ ⚠️ <i>Rule ${act.rule}: ${escapeHTML(act.reason)}</i>`;
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
    publishDashboardReport({ positions: positionData, actions: actionMap, nextScreenSec: remainingSec });

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
      const execReport = await executeManagementActions(actionPositions, actionMap, {
        liveMessage,
        cur,
        onStateChange: () => { stateChanged = true; },
      });
      if (execReport) mgmtReport += `\n\n${markdownToTelegramHTML(execReport)}`;
    } else {
      log("cron", "Management: all positions STAY — skipping");
      await liveMessage?.note("No tool actions needed.");
    }

    // Clean up price history for positions that were closed
    const closedActions = [...actionMap.entries()].filter(([, a]) => a.action === "CLOSE");
    for (const [posAddr] of closedActions) {
      clearPriceHistory(posAddr);
    }

    // Post-close probes + dust sweep — shared with the zero-positions early
    // return above so an empty book still gets maintained.
    await runPostCloseMaintenance({ closedCount: closedActions.length });

    // Trigger screening after management — but NOT if we just closed an OOR-above position (anti-LVR)
    const hadOorAboveClose = [...actionMap.values()].some(a => a.action === "CLOSE" && a.oor_direction === "above");
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs && !hadOorAboveClose) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    } else if (hadOorAboveClose) {
      log("cron", `Post-management: skipping immediate screening — OOR-above close triggers anti-LVR cooldown`);
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
      _lastMgmtMsgId = liveMessage.getMessageId?.() ?? _lastMgmtMsgId;
    } else if (shouldNotify && mgmtReport) {
      sendHTML(`🔄 <b>Management Cycle</b>\n\n${stripThink(mgmtReport)}`)
        .catch((e) => log("telegram_error", `Management cycle send failed: ${e.message}`));
    }

    if (shouldNotify) {
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          const aBin = p.active_bin != null ? Number(p.active_bin) : null;
          const lBin = p.lower_bin != null ? Number(p.lower_bin) : null;
          const uBin = p.upper_bin != null ? Number(p.upper_bin) : null;
          let oorDir = null, oorDist = null, oorLimit = config.management.outOfRangeWaitMinutes ?? 15;
          if (aBin != null && lBin != null && aBin < lBin) {
            oorDir = "Below"; oorDist = lBin - aBin; oorLimit = config.management.outOfRangeWaitMinutesBelow ?? oorLimit;
          } else if (aBin != null && uBin != null && aBin > uBin) {
            oorDir = "Above"; oorDist = aBin - uBin; oorLimit = config.management.outOfRangeWaitMinutesAbove ?? oorLimit;
          }
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
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
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

    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
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
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
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
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
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
    // Funnel telemetry — populated for both GMGN (s1..s5) and Meteora (Stage-B)
    // paths; buildFunnelReport branches on stage_counts.source.
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
    // rather than inside tools/screening.js because getTopCandidates dispatches gate
    // vs. rank mode internally and both converge on this loop — one insertion point
    // covers both admission modes. The verdict is computed even while rugFilterMode is
    // "off" so `rug_checks_tripped` still reaches the deploy snapshot below; that is
    // what makes these heuristics backtestable against our own closes before we gate.
    const rugCfg = getRugFilterConfig(config.screening);
    for (const c of allCandidates) {
      c.pool._rugSignals = extractRugSignals(c.ti, c.pool);
      c.pool._rugVerdict = evaluateRugFilter(c.pool._rugSignals, rugCfg);
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    // Skipped for GMGN: platforms already filtered upstream; bundler/bot data from GMGN pipeline
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      if (pool.gmgn) return true;
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
      return true;
    });

    // ── Gas break-even filter ──────────────────────────────────────
    const maxBreakEven = config.screening.maxGasBreakEvenMinutes ?? 30;
    const gasFiltered = passing.filter(({ pool }) => {
      const feeTvl = pool.fee_tvl_24h ?? pool.fee_per_tvl_24h ?? 0;
      const isWide = (pool._binCount ?? 0) > 69;
      const gasCost = estimateCycleGasCost(isWide);
      const breakEven = gasBreakEvenMinutes(gasCost, feeTvl, deployAmount);
      if (Number.isFinite(breakEven) && breakEven > maxBreakEven) {
        log("screening", `Gas filter: ${pool.name} needs ${breakEven.toFixed(0)}m to break even on gas (limit: ${maxBreakEven}m, fee/tvl: ${feeTvl}%)`);
        filteredOut.push({ name: pool.name, reason: `gas break-even ${breakEven.toFixed(0)}m > ${maxBreakEven}m` });
        return false;
      }
      return true;
    });
    // Replace passing with gas-filtered results
    passing.length = 0;
    passing.push(...gasFiltered);
    funnelRan = true; // the funnel executed to completion this cycle (empty or not)

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 5)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      const funnelBlock = buildFunnelReport(funnelStageCounts, funnelAllFiltered, { fromStage: 2 });
      const thresholds = `Thresholds: tvl>$${config.screening.minTvl} | vol>$${config.screening.minVolume} | organic>${config.screening.minOrganic}% | holders>${config.screening.minHolders} | fee/tvl>${config.screening.minFeeActiveTvlRatio}%`;
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
      const funnelBlock = buildFunnelReport(funnelStageCounts, funnelAllFiltered, { fromStage: 2 });
      if (funnelBlock) log("screening", `GMGN funnel (sparse):\n${funnelBlock}`);
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        const funnelBlock = buildFunnelReport(funnelStageCounts, funnelAllFiltered, { fromStage: 2 });
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
      const simLine = formatPoolSimLine(pool, {
        deposit_usd: deployUsd,
        minBinsBelow: config.strategy.minBinsBelow,
        maxBinsBelow: config.strategy.maxBinsBelow,
      });
      const momentumLine = formatOrganicMomentum(pool);
      let similarPastLine = null;
      try {
        similarPastLine = formatSimilarDeploysLine(pool);
      } catch (e) {
        log("screening", `similar_past retrieval failed for ${pool.name}: ${e.message}`);
      }
      const lperLine = config.screening.lpStudyEnabled ? formatTopLperStyle(lpStudies[pool.pool]) : null;
      // Playstyle Phase 2: winning-LPer-matched bins recommendation (advisory; only when steer on).
      const binsRec = config.screening.lpStyleSteerEnabled
        ? lperBinsRecommendation(lpStudies[pool.pool], {
            minBins: config.strategy.minBinsBelow,
            maxBins: config.strategy.maxBinsBelow,
            minWinners: config.screening.lpStudyMinWinnersForStyle,
          })
        : null;
      const binsHintLine = binsRec ? `bins_hint: ${binsRec.bins} (match winning LPers [${binsRec.basis}] — use as bins_below)` : null;
      let block;
      if (pool.gmgn) {
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          formatGmgnCandidateForPrompt(pool),
          formatFeeEfficiency(pool) ? `  ${formatFeeEfficiency(pool)}` : null,
          simLine ? `  ${simLine}` : null,
          momentumLine ? `  ${momentumLine}` : null,
          similarPastLine ? `  ${similarPastLine}` : null,
          lperLine ? `  ${lperLine}` : null,
          binsHintLine ? `  ${binsHintLine}` : null,
          pvpLine,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      } else {
        const gmgnPriceLine = pool.gmgn_price_action
          ? `  gmgn_price: rsi2=${pool.gmgn_price_action.rsi2 ?? "?"}, supertrend=${pool.gmgn_price_action.supertrend?.direction || "?"}, price_vs_ath=${pool.gmgn_price_action.priceVsAthPct ?? "?"}%, 1h_change=${pool.gmgn_price_action.priceChangePct ?? "?"}%, max_vol_candle=${pool.gmgn_price_action.maxVolumeShare ?? "?"}%`
          : null;
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
          formatFeeEfficiency(pool) ? `  ${formatFeeEfficiency(pool)}` : null,
          simLine ? `  ${simLine}` : null,
          momentumLine ? `  ${momentumLine}` : null,
          similarPastLine ? `  ${similarPastLine}` : null,
          lperLine ? `  ${lperLine}` : null,
          binsHintLine ? `  ${binsHintLine}` : null,
          `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
          gmgnPriceLine,
          pvpLine,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      }

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
    const { content, noToolFallback, deployVerdict } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL${timingAdvisory ? `\n${timingAdvisory}` : ""}

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Decide whether any candidate is worth deploying. A single remaining candidate is not automatically good enough.
2. Pick the best candidate only if it has real conviction from narrative quality, smart wallets, and pool metrics. If the list has only one pool and it lacks narrative or smart-wallet confirmation, skip the cycle.
3. If a pool qualifies, call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   strategy = ${config.strategy.strategy} (always use this, never change it).
   shape (bin distribution, optional): default spot (uniform) — omit unless you have an edge. curve only with strong consolidation conviction (steady momentum + low volatility); bidask for a dip-entry thesis; when unsure, spot.
   playstyle = ${config.strategy.playstyle} → range [${config.strategy.minBinsBelow}, ${config.strategy.maxBinsBelow}] bins.
   ${config.strategy.targetDownsidePct != null
     ? `bins_below: Omit this parameter. The deploy_position tool will automatically calculate the required number of bins to cover a ${config.strategy.targetDownsidePct}% downside price drop.`
     : `bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*${config.strategy.maxBinsBelow - config.strategy.minBinsBelow}) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].`
   }${config.screening.lpStyleSteerEnabled ? "\n   If the chosen candidate shows a bins_hint, use bins_below = that value (it matches the winning LPers on that pool) instead of the volatility formula." : ""}
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
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
            if (deploySucceeded) deployedThisCycle = true;
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    if (deploySucceeded) {
      _lastDeclinedCandidates = { fp: null, at: 0 }; // set changed by the deploy — next cycle re-evaluates
    } else {
      _lastDeclinedCandidates = { fp: candidateFp, at: Date.now() }; // declined (incl. structured NO DEPLOY / no-tool fallback)
    }
    const funnelAppend = buildFunnelReport(funnelStageCounts, funnelAllFiltered, { fromStage: 2 });
    if (noToolFallback) {
      // Model declined to emit a tool call this cycle — present as a calm info
      // notice, not a deploy/no-deploy report, and don't log it as a decision.
      log("cron", "Screening: model returned no tool call — no action this cycle");
      screenReport = `ℹ️ ${content}`;
    } else {
      screenReport = funnelAppend ? `${content}\n\n─────────────\n${funnelAppend}` : content;
    }
    // Surface the adversarial bear-case debate outcome when one ran this cycle.
    if (deployVerdict && !noToolFallback) {
      const dv = deployVerdict;
      const shadow = dv.bear_action !== "enforce";
      const wouldNote = dv.bear_verdict === "veto"
        ? (shadow ? " (shadow — would BLOCK)" : (dv.blocked ? " — BLOCKED deploy" : ""))
        : dv.bear_verdict === "size_down"
          ? (shadow ? " (shadow — would HALVE)" : (dv.enforced ? " — HALVED amount" : ""))
          : "";
      const bearLine =
        `🐻 Bear debate [${shadow ? "log_only" : "enforce"}]: ${dv.bear_verdict}${wouldNote}` +
        (dv.bear_parsed === false ? " · ⚠ unparsed (fail-open proceed)" : "") +
        (dv.bear_confidence != null ? ` · conf ${dv.bear_confidence}` : "") +
        (dv.deploy_confidence != null ? ` · screener ${dv.deploy_confidence}` : "") +
        (dv.bear_reason ? `\n   ${dv.bear_reason}` : "") +
        (dv.bear_error ? `\n   (debate errored, failed open: ${dv.bear_error})` : "");
      screenReport = `${screenReport}\n\n${bearLine}`;
      appendDecision({
        type: "bear_debate",
        actor: "RISK_MANAGER",
        summary: `Bear ${dv.bear_verdict}${shadow ? " (shadow)" : ""}`,
        reason: dv.bear_reason || null,
        metrics: {
          verdict: dv.bear_verdict,
          action: dv.bear_action,
          enforced: dv.enforced,
          blocked: dv.blocked,
          size_down: dv.size_down,
          bear_confidence: dv.bear_confidence,
          screener_confidence: dv.deploy_confidence,
        },
      });
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
        const htmlReport = markdownToTelegramHTML(stripThink(screenReport));
        if (liveMessage) await liveMessage.finalize(htmlReport)
          .catch((e) => log("telegram_error", `Screening cycle finalize failed: ${e.message}`));
        else sendHTML(`🔍 <b>Screening Cycle</b>\n\n${htmlReport}`)
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

  if (cfg.starvationRelaxEnabled === false) {
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
    const idleSol = aum.idle_sol || 0;
    const deployedSol = aum.deployed_sol || 0;
    const unclaimedFeesSol = aum.unclaimed_sol || 0;
    // Fold recoverable ATA rent into the stored rent component so totalSol stays
    // = idle+deployed+unclaimed+rent (keeps the dashboard's recompute consistent
    // and the chart flat across open/close — see ATA rent reclaim work).
    const rentSol = (aum.rent_sol || 0) + (aum.recoverable_rent_sol || 0);
    const totalSol = aum.total_sol || 0;
    const solPriceUsd = wallet.sol_price || 0;
    const totalUsd = aum.total_usd || 0;

    await recordBalanceEntry({
      ts: new Date().toISOString(),
      idleSol: Math.round(idleSol * 100000) / 100000,
      deployedSol: Math.round(deployedSol * 100000) / 100000,
      unclaimedFeesSol: Math.round(unclaimedFeesSol * 100000) / 100000,
      rentSol: Math.round(rentSol * 100000) / 100000,
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

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
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
  const pnlPollInterval = setInterval(async () => {
    writeHeartbeat("pnl_poll");
    // R1: Live Force Sync check
    const forceSyncFile = repoPath(".force-sync");
    if (fs.existsSync(forceSyncFile)) {
      if (!_managementBusy) {
        try {
          fs.unlinkSync(forceSyncFile);
          log("state", "[Force Sync] IPC file .force-sync detected, deleting file and triggering runManagementCycle immediately.");
          runManagementCycle({ silent: false }).catch((e) => {
            log("cron_error", `Force-sync triggered management failed: ${e.message}`);
          });
        } catch (err) {
          log("cron_error", `Failed to unlink/process force-sync: ${err.message}`);
        }
      }
    }

    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        confirmPeak(p.position, p.pnl_pct, confirmTicks);

        // Persist this tick's already-computed price/bin data (DATA CAPTURE ONLY —
        // no new RPC calls, no behavior change; ground truth for the replay harness).
        // recordTick is synchronous + never-throws + no-ops unless pg + capture on.
        recordTick({ pool_address: p.pool, position_address: p.position, active_bin: p.active_bin, pnl_pct: p.pnl_pct, source: "poller" });

        // Detect an exit signal this tick (rule-based exits, then deterministic close rules).
        // Supply this position's own snapshot count so the low-yield exit's history
        // floor + adoption grace apply here too (the poller can fire low-yield).
        p.fresh_snapshots = getPoolSnapshots(p.pool).filter((s) => s.position === p.position).length;
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        const closeRule = exit ? null : getDeterministicCloseRule(p, config.management);
        let signal = null, reason = null, rule = "exit";
        if (exit) { signal = exit.action; reason = exit.reason; }
        else if (closeRule) { signal = `RULE_${closeRule.rule}`; reason = closeRule.reason; rule = closeRule.rule; }

        // Price-crash fast-path (plan #04) — outranks the (slow) OOR-time rule when a
        // downside break is moving fast enough to be a rug. The detector always runs
        // (shadow mode): when the flag is OFF a would-fire is only logged as
        // `crash_shadow` for live threshold calibration — zero closes. Detector is
        // total; still wrapped so a fault can't break the poller loop — on error we
        // simply keep the normal signal above.
        try {
          const crash = detectPriceCrash(p.position, p, config.management);
          if (crash) {
            // Mark this position as a velocity-crash even in shadow mode, so the
            // OOR-flip gate keeps flips off the crash population regardless of flag.
            _crashFired.add(p.position);
            if (config.management.crashFastPathEnabled) {
              signal = "CRASH_FASTPATH"; reason = crash.reason; rule = "crash";
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
          if (rule !== "crash") {
            const rug = detectInRangeRug(p.position, p, config.management);
            if (rug) {
              _crashFired.add(p.position); // keep OOR-flips off this population too
              if (config.management.inRangeRugEnabled) {
                signal = "RUG_FASTPATH"; reason = rug.reason; rule = "crash";
              } else {
                log("rug_shadow", `[RUG_SHADOW] would fast-close ${p.pair}: ${rug.reason} (inRangeRugEnabled=false)`);
              }
            }
          }
        } catch (e) {
          log("cron_warn", `rug detector error (ignored): ${e.message}`);
        }
        const effectiveConfirm = rule === "crash"
          ? Math.max(1, Number(config.management.crashConfirmTicks ?? 3))
          : confirmTicks;

        // Require N consecutive confirming ticks before acting.
        const { fire } = registerExitSignal(p.position, signal, effectiveConfirm);
        if (!signal || !fire) continue;

        // OOR-below flip tactic (plan #07) — when the confirmed action is a slow-drift
        // OOR-below close (NOT a crash, NOT stop-loss), consult the flip gates before
        // committing to a market-sell close. Shadow-logs while oorFlipEnabled is OFF;
        // routes to FLIP when ON. The poller `p` lacks the mgmt-cycle health enrichment,
        // so the volume-death gate is simply absent here (backstop path); the crash,
        // momentum, cooldown, cap and bail gates all still apply.
        let action = "CLOSE";
        if (closeRule?.oor_direction === "below" && rule !== "crash") {
          try {
            const tracked = getTrackedPosition(p.position);
            const flip = shouldFlipOorBelow(p, tracked, config.management);
            if (flip.flip) {
              if (config.management.oorFlipEnabled) {
                action = "FLIP"; reason = flip.reason;
              } else {
                log("oor_flip_shadow", `[OOR_FLIP_SHADOW] would flip ${p.pair}: ${flip.reason} (oorFlipEnabled=false — closing instead)`);
              }
            } else {
              log("oor_flip_shadow", `[OOR_FLIP_SHADOW] no flip ${p.pair}: blocked_by=${flip.blocked_by} — closing`);
            }
          } catch (e) {
            log("cron_warn", `OOR-flip decision error (ignored): ${e.message}`);
          }
        }

        log("state", `[PnL poll] ${signal} confirmed (${effectiveConfirm} ticks): ${p.pair} — ${reason} — ${action === "FLIP" ? "flipping" : "closing"} directly`);
        // Hold the management lock so the cron cycle can't double-act on this position.
        _managementBusy = true;
        try {
          const actMap = new Map([[p.position, { action, rule, reason }]]);
          const rpt = await executeManagementActions([p], actMap, {});
          // On a real close drop all in-process history; on a FLIP the position stays
          // open (new ask ladder) — only reset the crash/bin trail so the recovered
          // ladder isn't judged against the pre-flip velocity.
          if (action === "FLIP") { _binTrail.delete(p.position); _rugTrail.delete(p.position); _crashFired.delete(p.position); }
          else clearPriceHistory(p.position); // drop _recentActiveBins + _binTrail for the closed position
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
        if (now - _lastTickNotify >= 15_000) {
          _lastTickNotify = now;
          const tickTs = new Date(now).toISOString();
          const positions = (result.positions || []).map((p) => ({
            position: p.position ?? null,
            pair: p.pair ?? null,
            pnl_pct: p.pnl_pct ?? null,
            pnl_pct_usd: p.pnl_pct_usd ?? null,
            pnl_usd: p.pnl_usd ?? null,
            pnl_true_usd: p.pnl_true_usd ?? null,
            in_range: p.in_range ?? null,
            minutes_out_of_range: p.minutes_out_of_range ?? null,
          }));
          let json = JSON.stringify({ ts: tickTs, positions });
          // NOTIFY payloads must stay < 7900 bytes; strip to the essentials if large.
          if (Buffer.byteLength(json, "utf8") > 7500) {
            json = JSON.stringify({
              ts: tickTs,
              positions: positions.map((p) => ({ position: p.position, pnl_pct: p.pnl_pct })),
            });
          }
          pgNotify("meridian_tick", json); // fire-and-forget
        }
      } catch (e) {
        log("cron_warn", `tick notify build error (ignored): ${e.message}`);
      }
    } finally {
      _pnlPollBusy = false;
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
        const [positions, balance] = await Promise.all([
          getMyPositions({ force: true, silent: true }).catch(() => null),
          getWalletBalances().catch(() => null),
        ]);
        if (!positions || (positions.total_positions ?? 0) >= config.risk.maxPositions) return;
        const minRequired = config.management.deployAmountSol + config.management.gasReserve;
        if (process.env.DRY_RUN !== "true" && (!balance || balance.sol < minRequired)) return;

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

  const reconciliationTask = cron.schedule(`*/15 * * * *`, async () => {
    if (_managementBusy || _screeningBusy) return;
    try {
      const { reconcileStateWithChain } = await import("./state.js");
      await reconcileStateWithChain();
    } catch (e) {
      log("cron_error", `State reconciliation failed: ${e.message}`);
    }
  });

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

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog, balanceHistoryTask, reconciliationTask, ataSweepTask, baselineTask];
  // Store interval refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = pnlPollInterval;
  _cronTasks._opportunityPollInterval = opportunityPollInterval;

  // WebSocket active bin monitor for low-latency range checks
  try {
    const pnlConn = getPnlConnection();
    startSocketMonitor(pnlConn);
    const openPositions = getTrackedPositions(true);
    syncSocketSubscriptions(openPositions);
  } catch (err) {
    log("cron_error", `Failed to initialize WebSocket active bin monitor: ${err.message}`);
  }

  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m${config.opportunity.enabled ? `, opportunity poll every ${config.opportunity.pollIntervalSec}s` : ""}`);
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

export function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);

  // Ignore completely untracked positions by default unless configured otherwise
  if (!tracked && !managementConfig.manageUntracked) {
    return null;
  }

  // Lazy LP mode: bypass all exits
  if (tracked?.lazy === true) {
    return null;
  }

  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  // NOTE on reason strings: lessons.js classifyExitFamily() matches these
  // case-insensitively IN ORDER — "stop loss" → "crash" → "trailing" → "take
  // profit" → "below" → "above" → "oor" → "yield" → "volume". Enrichment below is
  // strictly ADDITIVE: each reason keeps its family keyword and must NOT contain a
  // keyword from another family. In particular never write "below"/"above" into a
  // non-OOR reason (it would hijack classification into oor_below/oor_above and
  // corrupt exit-quality stats) — use symbols and neutral words instead.
  const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? "?" : `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`);

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: `stop loss: pnl ${pct(position.pnl_pct)} <= limit ${pct(managementConfig.stopLossPct)}` };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: `take profit: pnl ${pct(position.pnl_pct)} >= target ${pct(managementConfig.takeProfitPct)}` };
  }
  const activeBin = position.active_bin != null ? Number(position.active_bin) : null;
  const upperBin = position.upper_bin != null ? Number(position.upper_bin) : null;
  const lowerBin = position.lower_bin != null ? Number(position.lower_bin) : null;

  if (
    activeBin != null &&
    upperBin != null &&
    activeBin > upperBin + Number(managementConfig.outOfRangeBinsToClose)
  ) {
    // "above" is the family keyword here; deliberately no "below" anywhere.
    return {
      action: "CLOSE",
      rule: 3,
      reason: `pumped far above range: active bin ${activeBin} is ${activeBin - upperBin} bins past upper ${upperBin} (trigger ${managementConfig.outOfRangeBinsToClose})`,
      oor_direction: "above",
    };
  }
  if (
    activeBin != null &&
    upperBin != null &&
    activeBin > upperBin
  ) {
    const limitAbove = managementConfig.outOfRangeWaitMinutesAbove ?? managementConfig.outOfRangeWaitMinutes ?? 15;
    if (limitAbove > 0 && (position.minutes_out_of_range ?? 0) >= limitAbove) {
      // Price stabilization check: don't close during active pumps
      if (!isPriceStable(position.position, activeBin)) {
        return null; // Price still moving — defer close
      }
      return {
        action: "CLOSE",
        rule: 4,
        reason: `OOR (above): ${position.minutes_out_of_range ?? 0}m out of range >= limit ${limitAbove}m, ${activeBin - upperBin} bins past upper ${upperBin}`,
        oor_direction: "above",
      };
    }
  }
  if (
    activeBin != null &&
    lowerBin != null &&
    activeBin < lowerBin
  ) {
    const limitBelow = managementConfig.outOfRangeWaitMinutesBelow ?? managementConfig.outOfRangeWaitMinutes ?? 180;
    if (limitBelow > 0 && (position.minutes_out_of_range ?? 0) >= limitBelow) {
      return {
        action: "CLOSE",
        rule: 4,
        reason: `OOR (below): ${position.minutes_out_of_range ?? 0}m out of range >= limit ${limitBelow}m, ${lowerBin - activeBin} bins past lower ${lowerBin}`,
        oor_direction: "below",
      };
    }
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= (managementConfig.minAgeBeforeYieldCheck ?? 60)
  ) {
    // "yield" is the family keyword; "<" instead of the word "below" on purpose.
    return {
      action: "CLOSE",
      rule: 5,
      reason: `low yield: fee/TVL ${Number(position.fee_per_tvl_24h).toFixed(2)}% < min ${managementConfig.minFeePerTvl24h}% (age ${Math.round(position.age_minutes ?? 0)}m)`,
    };
  }
  return null;
}

function buildFunnelReport(stageCounts, allFiltered = [], { fromStage = 1 } = {}) {
  if (!stageCounts) return null;
  const sc = stageCounts;

  // Meteora Stage-B funnel (screening.js getTopCandidates stage_counts) —
  // separate shape from the GMGN pipeline's s1..s5.
  if (sc.source === "meteora") {
    const a = sc.stage_a || {};
    const stageALine = a.api_total != null || a.fetched != null
      ? `discovery: api_total=${a.api_total ?? "?"} fetched=${a.fetched ?? "?"} → recheck=${a.client_recheck ?? "?"} → blacklist=${a.after_blacklist ?? "?"}`
      : null;
    const order = ["input", "metrics", "dev_score", "dump_guard", "intel", "pvp", "indicators", "final"];
    const stageBLine = "funnel: " + order.filter((k) => sc[k] != null).map((k) => `${k}=${sc[k]}`).join(" → ");
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
    return [stageALine, stageBLine, breakdown ? `rejects:\n${breakdown}` : null].filter(Boolean).join("\n");
  }

  const funnel = `GMGN funnel: ranked=${sc.ranked ?? "?"} → S1=${sc.s1 ?? "?"} → S2=${sc.s2 ?? "?"} → S3=${sc.s3 ?? "?"} → S4=${sc.s4 ?? "?"} → final=${sc.s5 ?? "?"}`;
  const byStage = {};
  for (const f of allFiltered) {
    if (f.stage < fromStage) continue;
    const key = `s${f.stage}`;
    if (!byStage[key]) byStage[key] = [];
    byStage[key].push(`${f.name}: ${f.reason}`);
  }
  const stageLabels = { s2: "S2 info", s3: "S3 pool", s4: "S4 indicators", s5: "S5 pick" };
  const details = Object.entries(byStage)
    .map(([key, items]) => `${stageLabels[key] || key}:\n${items.map(r => `  • ${r}`).join("\n")}`)
    .join("\n");
  return details ? `${funnel}\n\n${details}` : funnel;
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  // Degen Score is the conviction signal for a solo deploy. Smart wallet is NO LONGER a
  // gate here — it's a confidence boost surfaced to the LLM, not a requirement.
  const degen = degenScore(pool, config.opportunity);
  const degenStrong = degen >= (config.screening.loneCandidateMinDegen ?? 50);
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);

  // Hard flags — no override.
  if (pool.is_wash) return "wash trading was flagged";
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
  if (pool.is_rugpull && !degenStrong) {
    return `rugpull risk flagged without strong degen conviction (degen ${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
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

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
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

  let feeHtml = "";
  if (unclaimedSol > 0) {
    feeHtml = `\n• <b>Unclaimed Fees:</b> <code>${unclaimedSol.toFixed(4)} SOL</code> ($${unclaimedUsd.toFixed(2)})`;
  }
  let rentHtml = "";
  if (rentSol > 0) {
    rentHtml = `\n• <b>Locked Rent:</b> <code>${rentSol.toFixed(4)} SOL</code> ($${rentUsd.toFixed(2)})`;
  }

  const cbStatus = getCircuitBreakerStatus();
  const volStatus = getSolVolatilityStatus();

  return [
    `💼 <b>Meridian Portfolio Status</b>`,
    ``,
    `• <b>Wallet (Idle):</b> <code>${aum.idle_sol.toFixed(4)} SOL</code> ($${aum.idle_usd.toFixed(2)})`,
    `• <b>Deployed (LP):</b> <code>${aum.deployed_sol.toFixed(4)} SOL</code> ($${aum.deployed_usd.toFixed(2)})${feeHtml}${rentHtml}`,
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
    "Config snapshot",
    "",
    `Screening source: ${config.screening.source}`,
    `Strategy: ${config.strategy.strategy} | bins: [${config.strategy.minBinsBelow}–${config.strategy.maxBinsBelow}] (volatility-scaled)`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | take profit: ${config.management.takeProfitPct}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: ${config.management.outOfRangeWaitMinutes}m | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl}`,
    `GMGN interval: ${config.gmgn.interval} | OrderBy: ${config.gmgn.orderBy} | Dir: ${config.gmgn.direction}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
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
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    screeningSource: config.screening.source,
    gmgnRequireKol: config.gmgn.requireKol,
    gmgnInterval: config.gmgn.interval,
    gmgnIndicatorFilter: config.gmgn.indicatorFilter,
    gmgnMinVolume: config.gmgn.minVolume,
    gmgnMinTokenAgeHours: config.gmgn.minTokenAgeHours,
    gmgnMaxTokenAgeHours: config.gmgn.maxTokenAgeHours,
    gmgnMaxBundlerRate: config.gmgn.maxBundlerRate,
    gmgnPreferredKolNames: config.gmgn.preferredKolNames,
    gmgnPreferredKolMinHoldPct: config.gmgn.preferredKolMinHoldPct,
    gmgnDumpKolNames: config.gmgn.dumpKolNames,
    gmgnDumpKolMinHoldPct: config.gmgn.dumpKolMinHoldPct,
    gmgnIndicatorInterval: config.gmgn.indicatorInterval,
    gmgnRequireBullishSt: config.gmgn.indicatorRules?.requireBullishSupertrend,
    gmgnRejectAtBottom: config.gmgn.indicatorRules?.rejectAlreadyAtBottom,
    gmgnRequireAboveSt: config.gmgn.indicatorRules?.requireAboveSupertrend,
    gmgnMinRsi: config.gmgn.indicatorRules?.minRsi,
    gmgnMaxRsi: config.gmgn.indicatorRules?.maxRsi,
    gmgnMinKolCount: config.gmgn.minKolCount,
    gmgnMinTotalFeeSol: config.gmgn.minTotalFeeSol,
    gmgnMinHolders: config.gmgn.minHolders,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
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
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Screening: ${config.screening.source} | GMGN KOL ${config.gmgn.requireKol ? "required" : "preferred"}`,
    `Strategy: ${config.strategy.strategy} | deploy ${config.management.deployAmountSol} SOL | max pos ${config.risk.maxPositions}`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Strategy", "cfg:page:strategy"),
    ],
    [
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indicators", "cfg:page:indicators"),
      settingButton("GMGN", "cfg:page:gmgn"),
      settingButton("KOL", "cfg:page:kol"),
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
      inputButton("maxDeployAmount", "Max SOL"),
      inputButton("takeProfitPct", "TP %"),
      inputButton("stopLossPct", "SL %"),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      inputButton("trailingTriggerPct", "Trail trigger", { digits: 1 }),
      inputButton("trailingDropPct", "Trail drop", { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      inputButton("repeatDeployCooldownTriggerCount", "Repeat count"),
      inputButton("repeatDeployCooldownHours", "Repeat hrs"),
      inputButton("repeatDeployCooldownMinFeeEarnedPct", "Min fee earned %", { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [
        settingButton("Source: Meteora", "cfg:set:screeningSource:meteora"),
        settingButton("Source: GMGN", "cfg:set:screeningSource:gmgn"),
      ],
      [toggleButton("gmgnRequireKol", "GMGN require KOL")],
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton("5m", "cfg:set:gmgnInterval:5m"),
        settingButton("1h", "cfg:set:gmgnInterval:1h"),
        settingButton("6h", "cfg:set:gmgnInterval:6h"),
        settingButton("24h", "cfg:set:gmgnInterval:24h"),
      ],
      [
        inputButton("gmgnMinVolume", "Min volume")[0],
        inputButton("gmgnMinTokenAgeHours", "Min token age (h)")[0],
      ],
      [
        inputButton("gmgnMaxTokenAgeHours", "Max token age (h)")[0],
        inputButton("gmgnMaxBundlerRate", "Max bundler %")[0],
      ],
      [settingButton("KOL settings", "cfg:page:kol")],
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
    ];
  } else if (page === "gmgn") {
    rows = [
      [toggleButton("gmgnIndicatorFilter", "Indicator filter"), toggleButton("gmgnRequireKol", "Require KOL")],
      [
        settingButton("TF: 5m", "cfg:set:gmgnIndicatorInterval:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:gmgnIndicatorInterval:15_MINUTE"),
        settingButton("TF: 1h", "cfg:set:gmgnIndicatorInterval:1h"),
      ],
      [toggleButton("gmgnRequireBullishSt", "Bullish ST"), toggleButton("gmgnRejectAtBottom", "Reject at bottom"), toggleButton("gmgnRequireAboveSt", "Above ST")],
      inputButton("gmgnMinRsi", "Min RSI"),
      inputButton("gmgnMaxRsi", "Max RSI"),
      inputButton("gmgnMinKolCount", "Min KOL"),
      inputButton("gmgnMinTotalFeeSol", "Min fee SOL"),
      inputButton("gmgnMinHolders", "Min holders"),
      [settingButton("KOL settings", "cfg:page:kol")],
    ];
  } else if (page === "kol") {
    rows = [
      inputButton("gmgnPreferredKolNames", "Preferred KOL (comma-sep)"),
      inputButton("gmgnPreferredKolMinHoldPct", "Preferred KOL min hold %"),
      inputButton("gmgnDumpKolNames", "Dump KOL (comma-sep)"),
      inputButton("gmgnDumpKolMinHoldPct", "Dump KOL min hold %"),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      inputButton("rsiLength", "RSI length"),
    ];
  } else {
    rows = [
      [
        settingButton("Source: Meteora", "cfg:set:screeningSource:meteora"),
        settingButton("Source: GMGN", "cfg:set:screeningSource:gmgn"),
      ],
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
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
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  if (key === "gmgnPreferredKolNames" || key === "gmgnDumpKolNames") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
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
    const inputPage = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(inputKey) ? "kol"
      : ["gmgnMinVolume", "gmgnMaxBundlerRate", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(inputKey) ? "screen"
      : inputKey.startsWith("gmgn") && inputKey !== "gmgnRequireKol" ? "gmgn"
      : inputKey.startsWith("indicator") || inputKey === "chartIndicatorsEnabled" || inputKey === "rsiLength" || inputKey === "requireAllIntervals" ? "indicators"
      : ["minBinsBelow", "maxBinsBelow"].includes(inputKey) ? "strategy"
      : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "screeningSource", "gmgnRequireKol"].includes(inputKey) ? "screen"
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
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
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
  page = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(key) ? "kol"
    : ["gmgnMinVolume", "gmgnMaxBundlerRate", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(key) ? "screen"
    : key.startsWith("gmgn") && key !== "gmgnRequireKol"
      ? "gmgn"
      : key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
        ? "indicators"
        : ["minBinsBelow", "maxBinsBelow"].includes(key)
          ? "strategy"
          : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "screeningSource", "gmgnRequireKol"].includes(key)
            ? "screen"
            : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/help — show commands",
    "/health — system health check and error telemetry",
    "/status — wallet + positions snapshot",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/set <n> <note> — set note/instruction on position",
    "/unset <n> — clear note/instruction on position",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/setcfg <key> <value> — update persisted config",
    "/screen — refresh deterministic candidate list",
    "/candidates — show latest cached candidates",
    "/timing — deploy-timing profile by hour-of-day",
    "/exits — exit-quality report (post-close price probes)",
    "/deploy <n> — deploy candidate by cached index",
    "/briefing — morning briefing",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/agy <prompt> — run Google Antigravity prompt",
    "/gitstatus — check git repository status and updates",
    "/gitpull — pull latest changes from upstream git",
    "/restart — restart PM2 meridian daemon",
    "/sync — manually trigger upstream repo check",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      const source = pool.gmgn ? ` | GMGN smart ${pool.gmgn_smart_wallets ?? "?"}, KOL ${pool.gmgn_kol_wallets ?? "?"}, total fee ${pool.gmgn_total_fee_sol ?? "?"} SOL` : ` | organic ${pool.organic_score ?? "?"}`;
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol}${source}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
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
    sendMessage("🚪 *Agy session closed* due to 24-hour inactivity timeout.").catch(() => {});
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
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
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
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/health") {
    try {
      const { getTelemetrySummary } = await import("./error-telemetry.js");
      const { getRpcHealthReport } = await import("./tools/rpc.js");
      const telemetry = getTelemetrySummary();
      const rpcReport = getRpcHealthReport().map(r => `  ${r.status} ${r.url}: ${r.avgLatencyMs}ms (${r.errorRate} err)`).join("\n");

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
        `⚠️ <b>Error Telemetry:</b>`,
        telemetry
      ].join("\n");
      await sendHTML(healthMsg).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
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
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      // Dual display: under solMode the *_usd fields carry SOL; the *_true_usd
      // fields carry real USD. Σ = fee-inclusive total PnL (pnl_pct_derived).
      const dual = (val, trueUsd) => config.management.solMode && trueUsd != null && trueUsd !== 0
        ? `${cur}${val} ($${Number(trueUsd).toFixed(2)})`
        : `${cur}${val}`;
      const lines = positions.map((p, i) => {
        const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const pct = p.pnl_pct != null ? ` (${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%` +
          (p.pnl_pct_derived != null && Math.abs(p.pnl_pct_derived - p.pnl_pct) >= 0.05
            ? `, Σ${p.pnl_pct_derived >= 0 ? "+" : ""}${p.pnl_pct_derived}%` : "") + ")" : "";
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        return `${i + 1}. ${p.pair} | ${dual(p.total_value_usd, p.total_value_true_usd)} | PnL: ${pnl}${pct} | fees: ${dual(p.unclaimed_fees_usd, p.unclaimed_fees_true_usd)} | ${age}${oor}`;
      });
      await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      // Route through executeTool (NOT closePosition directly) so all close
      // post-effects fire: the rich 🏁 close notification, base-token auto-swap
      // back to SOL, pool notes, and WebSocket resync. Manual closes previously
      // bypassed all of these.
      const result = await executeTool("close_position", { position_address: pos.position, reason: "manual close (/close)" });
      if (result?.blocked) {
        await sendMessage(`❌ Close blocked: ${result.reason}`);
      } else if (!result?.success) {
        await sendMessage(`❌ Close failed: ${result?.error || JSON.stringify(result)}`);
      }
      // On success the executor already sent the full 🏁 summary — no duplicate.
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          // Through executeTool so each close gets the rich 🏁 notification,
          // auto-swap to SOL, pool notes, and socket resync (was bypassed).
          const result = await executeTool("close_position", { position_address: pos.position, reason: "manual close (/closeall)" });
          results.push(`${pos.pair}: ${result?.success ? "closed" : `failed (${result?.reason || result?.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const unsetMatch = text.match(/^\/unset\s+(\d+)$/i);
  if (unsetMatch) {
    try {
      const idx = parseInt(unsetMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, null);
      await sendMessage(`🧹 Instruction cleared for ${pos.pair}`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
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
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  if (text === "/exits") {
    try {
      const { total_probed, families } = getExitQualitySummary({ limit: 30 });
      if (!total_probed) {
        await sendMessage("No probed closes yet — post-close probes need ≥30 min after a close to start filling in. Check back after a few closes.").catch(() => {});
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
      await sendHTML(`<b>Exit quality</b> (last ${total_probed} probed closes)\n<pre>${escapeHTML(rows.join("\n"))}</pre>\n<i>good = price kept falling after close · early = it bounced (sold the bottom)</i>`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/timing") {
    try {
      await sendHTML(`<pre>${escapeHTML(formatDeployTimingReport())}</pre>`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${result.strategy || config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
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
      let statusText = `Branch: \`${branch}\`\nCommit: \`${localHash.slice(0, 7)}\``;
      
      let remoteExists = false;
      try {
        execSync(`git rev-parse --verify origin/${branch}`, { cwd: REPO_ROOT });
        remoteExists = true;
      } catch {}

      if (remoteExists) {
        const remoteHash = execSync(`git rev-parse origin/${branch}`, { cwd: REPO_ROOT }).toString().trim();
        if (localHash === remoteHash) {
          statusText += `\nStatus: Up-to-date with \`origin/${branch}\``;
        } else {
          const mergeBase = execSync(`git merge-base HEAD origin/${branch}`, { cwd: REPO_ROOT }).toString().trim();
          if (mergeBase === localHash) {
            const commits = execSync(`git log HEAD..origin/${branch} --oneline`, { cwd: REPO_ROOT }).toString().trim();
            const commitCount = commits.split("\n").length;
            statusText += `\nStatus: ⚠️ Behind \`origin/${branch}\` by ${commitCount} commit(s).\n\n*New Commits:*\n${commits}\n\nUse \`/gitpull\` to pull updates.`;
          } else if (mergeBase === remoteHash) {
            statusText += `\nStatus: Ahead of \`origin/${branch}\``;
          } else {
            statusText += `\nStatus: ⚠️ Diverged from \`origin/${branch}\``;
          }
        }
      }
      
      const uncommitted = execSync("git status --porcelain", { cwd: REPO_ROOT }).toString().trim();
      if (uncommitted) {
        statusText += `\n\n⚠️ *Local uncommitted files:*\n\`\`\`\n${uncommitted}\n\`\`\``;
      } else {
        statusText += `\n\nClean working directory (no uncommitted changes).`;
      }
      
      await sendMessage(statusText).catch(() => {});
    } catch (e) {
      await sendMessage(`Git error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/gitpull" || text === "/gitpull force") {
    try {
      const { execSync } = await import("child_process");
      const uncommitted = execSync("git status --porcelain", { cwd: REPO_ROOT }).toString().trim();
      const isForce = text === "/gitpull force";
      
      if (uncommitted && !isForce) {
        await sendMessage(`⚠️ *Uncommitted changes detected:*\n\`\`\`\n${uncommitted}\n\`\`\`\nPull aborted. Use \`/gitpull force\` to stash modifications, pull, and pop stash.`).catch(() => {});
        return;
      }
      
      await sendMessage("⏳ Fetching and pulling changes...").catch(() => {});
      let stashed = false;
      if (uncommitted && isForce) {
        execSync("git stash", { cwd: REPO_ROOT });
        stashed = true;
      }
      
      execSync("git pull", { cwd: REPO_ROOT });
      await sendMessage("📦 Updating dependencies...").catch(() => {});
      execSync("npm install", { cwd: REPO_ROOT });
      
      if (stashed) {
        try {
          execSync("git stash pop", { cwd: REPO_ROOT });
          await sendMessage("✅ Pull complete (local changes stashed and popped back).").catch(() => {});
        } catch (popError) {
          await sendMessage("⚠️ Pull complete, but stashed pop encountered conflicts. Please resolve manually on the VM.").catch(() => {});
        }
      } else {
        await sendMessage("✅ Pull complete (clean update).").catch(() => {});
      }
      
      await sendMessage("🔄 *Restarting PM2 meridian daemon...*").catch(() => {});
      execSync("pm2 restart meridian --update-env");
    } catch (e) {
      await sendMessage(`Pull failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/restart") {
    try {
      const { execSync } = await import("child_process");
      await sendMessage("🔄 Restarting PM2 meridian daemon...").catch(() => {});
      execSync("pm2 restart meridian --update-env");
    } catch (e) {
      await sendMessage(`Restart failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/sync") {
    try {
      const { exec } = await import("child_process");
      await sendMessage("⏳ Triggering upstream sync check...").catch(() => {});
      exec(`node ${repoPath("scripts/repo_syncer.js")}`, (err, stdout, stderr) => {
        if (err) {
          sendMessage(`Sync failed: ${err.message}`).catch(() => {});
        } else {
          const out = stdout.trim() || stderr.trim();
          if (out.includes("Up to date")) {
            sendMessage(`✅ Syncer: ${out}`).catch(() => {});
          }
        }
      });
    } catch (e) {
      await sendMessage(`Sync trigger failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => {});
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
      await sendMessage("▶️ Autonomous cycles resumed." + (cb.tripped ? " Circuit breaker has been reset." : "")).catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running." + (cb.tripped ? " Circuit breaker has been reset." : "")).catch(() => {});
    }
    return;
  }

  if (text === "/cooldowns" || text === "/cooldown" || text === "/release") {
    try {
      const { getActiveCooldowns } = await import("./pool-memory.js");
      const list = getActiveCooldowns();
      if (list.length === 0) {
        await sendMessage("No active pool or token cooldowns.");
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
      
      await sendMessageWithButtons("Select a cooldown to release manually:", inlineKeyboard);
    } catch (e) {
      await sendMessage(`Failed to fetch cooldowns: ${e.message}`);
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
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
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
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

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
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
          `get_top_candidates, decide whether any candidate is worth deploying, and only call deploy_position with ${DEPLOY} SOL if conviction is strong. If only one candidate is returned and it lacks narrative or smart-wallet confirmation, skip and report NO DEPLOY. Execute now, don't ask.`,
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
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
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
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
