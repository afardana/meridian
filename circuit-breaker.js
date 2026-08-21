/**
 * Portfolio Circuit Breaker
 *
 * Pauses all screening when cumulative realized losses exceed a threshold.
 * Monitors two independent trip conditions:
 *   1. Consecutive loss streak (from most-recent performance entries)
 *   2. Rolling 24h USD drawdown as a % of approximate portfolio value
 *
 * State is persisted in state.json under the `_circuitBreaker` key.
 * Cooldown auto-reset: once the cooldown period expires, the breaker
 * resets itself and screening resumes.
 */

import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getBaselineState, getCircuitBreakerState, saveCircuitBreakerState } from "./state.js";
import { sendMessage } from "./telegram.js";
import { usePg } from "./db/pool.js";
import { getAllPerformance } from "./lessons.js";

// ─── File Paths ────────────────────────────────────────────────

const STATE_FILE = repoPath("state.json");
const LESSONS_FILE = repoPath("lessons.json");

/**
 * Default SOL price estimate when no live price has been provided.
 * Updated at runtime via `updateSolPrice()`.
 * @type {number}
 */
let solPriceEstimate = 150;

// ─── Config Defaults ───────────────────────────────────────────

/**
 * Read a circuit-breaker config value with a fallback default.
 * Config lives under `config.risk.*`.
 *
 * @param {string} key
 * @param {*} fallback
 * @returns {*}
 */
function riskCfg(key, fallback) {
  return config.risk?.[key] ?? fallback;
}

// ─── State I/O ─────────────────────────────────────────────────

/**
 * Load full state.json (safe — returns {} on any error).
 * @returns {Object}
 */
function loadCbState() {
  return getCircuitBreakerState();
}

/**
 * Write the circuit breaker sub-state back into state.json.
 * @param {Object} cbState
 */
function saveCbState(cbState) {
  saveCircuitBreakerState(cbState);
}

// ─── Lessons I/O (direct fs to avoid circular deps) ────────────

/**
 * Read lessons.json performance array directly.
 * @returns {Array<Object>}
 */
function readPerformance() {
  if (usePg()) {
    return getAllPerformance();
  }
  try {
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    return Array.isArray(data.performance) ? data.performance : [];
  } catch {
    return [];
  }
}

// ─── Core Logic ────────────────────────────────────────────────

/**
 * Check the circuit breaker status and evaluate trip conditions.
 *
 * Logic:
 *   1. If disabled in config → returns `{ tripped: false }`
 *   2. If already tripped and cooldown expired → auto-resets
 *   3. Counts consecutive losses from most-recent performance entries
 *   4. Sums 24h realized P&L in USD
 *   5. Computes drawdown % against approximate portfolio value
 *   6. Trips if either threshold is exceeded
 *
 * @returns {{ tripped: boolean, reason?: string, resumesAt?: string, stats: { drawdownPct: number, consecutiveLosses: number, recentPnlUsd: number } }}
 */
export function checkCircuitBreaker() {
  const enabled = riskCfg("circuitBreakerEnabled", true);
  if (!enabled) {
    return {
      tripped: false,
      stats: { drawdownPct: 0, consecutiveLosses: 0, recentPnlUsd: 0 },
    };
  }

  const cbState = loadCbState();

  // ── 1. Already tripped — check cooldown expiry ────────────────
  if (cbState.tripped) {
    if (cbState.resumesAt && new Date(cbState.resumesAt).getTime() <= Date.now()) {
      log("circuit_breaker", `Cooldown expired — auto-resetting circuit breaker`);
      resetCircuitBreaker();
      // Fall through to re-evaluate from clean state
    } else {
      // Still in cooldown
      return {
        tripped: true,
        reason: cbState.reason,
        resumesAt: cbState.resumesAt,
        stats: { drawdownPct: 0, consecutiveLosses: 0, recentPnlUsd: 0 },
      };
    }
  }

  // ── 2. Read performance data ──────────────────────────────────
  const allPerf = readPerformance();
  if (allPerf.length === 0) {
    return {
      tripped: false,
      stats: { drawdownPct: 0, consecutiveLosses: 0, recentPnlUsd: 0 },
    };
  }

  // ── 3. Count consecutive losses (from most recent backwards) ──
  let consecutiveLosses = 0;
  for (let i = allPerf.length - 1; i >= 0; i--) {
    if ((allPerf[i].pnl_usd ?? 0) < 0) {
      consecutiveLosses++;
    } else {
      break;
    }
  }

  // ── 4. Sum 24h realized P&L ───────────────────────────────────
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  let recentPnlUsd = 0;
  for (const entry of allPerf) {
    const recordedAt = entry.recorded_at ? new Date(entry.recorded_at).getTime() : 0;
    if (recordedAt >= cutoff24h) {
      recentPnlUsd += entry.pnl_usd ?? 0;
    }
  }
  recentPnlUsd = Math.round(recentPnlUsd * 100) / 100;

  // ── 5. Compute drawdown % ────────────────────────────────────
  // Use the persisted SOL price if available, else the module-level estimate
  const effectiveSolPrice = cbState.lastSolPrice || solPriceEstimate;
  const baseline = getBaselineState();
  const baselineSol = baseline.total_deposited || 0;
  const portfolioValueUsd = baselineSol * effectiveSolPrice;

  let drawdownPct = 0;
  if (portfolioValueUsd > 0 && recentPnlUsd < 0) {
    drawdownPct = Math.round(((recentPnlUsd / portfolioValueUsd) * 100) * 100) / 100;
  }

  const stats = { drawdownPct, consecutiveLosses, recentPnlUsd };

  // ── 6. Evaluate trip conditions ───────────────────────────────
  const maxConsecutiveLosses = riskCfg("circuitBreakerConsecutiveLosses", 4);
  const drawdownThreshold = riskCfg("circuitBreakerDrawdownPct", -15);

  // Condition A: consecutive loss streak
  if (consecutiveLosses >= maxConsecutiveLosses) {
    const reason = `Consecutive loss streak: ${consecutiveLosses} losses in a row (threshold: ${maxConsecutiveLosses})`;
    tripCircuitBreaker(reason);
    return { tripped: true, reason, resumesAt: loadCbState().resumesAt, stats };
  }

  // Condition B: 24h drawdown exceeds threshold
  if (drawdownPct <= drawdownThreshold) {
    const reason = `24h drawdown ${drawdownPct.toFixed(2)}% exceeds threshold ${drawdownThreshold}% (24h P&L: $${recentPnlUsd.toFixed(2)}, portfolio: ~$${portfolioValueUsd.toFixed(0)})`;
    tripCircuitBreaker(reason);
    return { tripped: true, reason, resumesAt: loadCbState().resumesAt, stats };
  }

  return { tripped: false, stats };
}

/**
 * Trip the circuit breaker — persists the tripped state, logs the event,
 * and sends a Telegram alert.
 *
 * @param {string} reason - Human-readable reason for the trip
 */
export function tripCircuitBreaker(reason) {
  const cooldownHours = riskCfg("circuitBreakerCooldownHours", 6);
  const resumesAt = new Date(Date.now() + cooldownHours * 60 * 60 * 1000).toISOString();

  const cbState = {
    tripped: true,
    trippedAt: new Date().toISOString(),
    reason,
    resumesAt,
    lastSolPrice: loadCbState().lastSolPrice || solPriceEstimate,
  };

  saveCbState(cbState);
  log("circuit_breaker", `🚨 TRIPPED: ${reason} — screening paused until ${resumesAt}`);

  const msg = [
    `🚨 *Circuit Breaker Tripped*`,
    ``,
    `*Reason:* ${reason}`,
    `*Screening paused until:* ${new Date(resumesAt).toLocaleString()}`,
    `*Cooldown:* ${cooldownHours}h`,
    ``,
    `_Use /cbreset to manually reset early._`,
  ].join("\n");

  sendMessage(msg, "Markdown").catch((err) => {
    log("circuit_breaker_error", `Failed to send trip notification: ${err.message}`);
  });
}

/**
 * Reset the circuit breaker — clears the tripped state, logs the event,
 * and sends a Telegram notification. Screening will resume on the next cycle.
 */
export function resetCircuitBreaker() {
  const cbState = loadCbState();
  const wasTripped = cbState.tripped;
  const previousReason = cbState.reason;

  saveCbState({
    tripped: false,
    trippedAt: null,
    reason: null,
    resumesAt: null,
    lastSolPrice: cbState.lastSolPrice || solPriceEstimate,
  });

  log("circuit_breaker", `✅ Circuit breaker reset — screening will resume`);

  if (wasTripped) {
    const msg = [
      `✅ *Circuit Breaker Reset*`,
      ``,
      `Previous trip: ${previousReason || "unknown"}`,
      `Screening will resume on the next cycle.`,
    ].join("\n");

    sendMessage(msg, "Markdown").catch((err) => {
      log("circuit_breaker_error", `Failed to send reset notification: ${err.message}`);
    });
  }
}

/**
 * Get a formatted status string for the circuit breaker, suitable for
 * the /status Telegram command.
 *
 * @returns {string} Human-readable circuit breaker status
 */
export function getCircuitBreakerStatus() {
  const enabled = riskCfg("circuitBreakerEnabled", true);
  if (!enabled) return "🔌 Circuit Breaker: Disabled";

  const cbState = loadCbState();

  if (!cbState.tripped) {
    // Show live stats even when not tripped
    const allPerf = readPerformance();
    if (allPerf.length === 0) return "🟢 Circuit Breaker: OK (no performance data)";

    // Consecutive losses
    let consecutiveLosses = 0;
    for (let i = allPerf.length - 1; i >= 0; i--) {
      if ((allPerf[i].pnl_usd ?? 0) < 0) consecutiveLosses++;
      else break;
    }

    // 24h P&L
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    let recentPnlUsd = 0;
    for (const entry of allPerf) {
      const recordedAt = entry.recorded_at ? new Date(entry.recorded_at).getTime() : 0;
      if (recordedAt >= cutoff24h) recentPnlUsd += entry.pnl_usd ?? 0;
    }

    const maxLosses = riskCfg("circuitBreakerConsecutiveLosses", 4);
    const lossesWarning = consecutiveLosses >= maxLosses - 1 ? " ⚠️" : "";

    return [
      `🟢 Circuit Breaker: OK`,
      `   Consecutive losses: ${consecutiveLosses}/${maxLosses}${lossesWarning}`,
      `   24h P&L: $${recentPnlUsd >= 0 ? "+" : ""}${recentPnlUsd.toFixed(2)}`,
    ].join("\n");
  }

  // Currently tripped
  const trippedAt = cbState.trippedAt
    ? new Date(cbState.trippedAt).toLocaleString()
    : "unknown";
  const resumesAt = cbState.resumesAt
    ? new Date(cbState.resumesAt).toLocaleString()
    : "unknown";
  const remainingMs = cbState.resumesAt
    ? Math.max(0, new Date(cbState.resumesAt).getTime() - Date.now())
    : 0;
  const remainingMin = Math.ceil(remainingMs / 60_000);

  return [
    `🔴 Circuit Breaker: TRIPPED`,
    `   Reason: ${cbState.reason}`,
    `   Tripped at: ${trippedAt}`,
    `   Resumes at: ${resumesAt} (${remainingMin}m remaining)`,
  ].join("\n");
}

/**
 * Update the SOL price estimate used for drawdown calculations.
 * Call this from index.js or the management loop whenever a fresh
 * SOL price is available.
 *
 * @param {number} price - Current SOL price in USD
 */
export function updateSolPrice(price) {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return;

  solPriceEstimate = price;

  // Also persist to state so it survives restarts
  const cbState = loadCbState();
  cbState.lastSolPrice = price;
  saveCbState(cbState);
}
