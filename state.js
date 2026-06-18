/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { recordError } from "./error-telemetry.js";

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

const STATE_BACKUP_FILE = repoPath("state.json.bak");
const STATE_TMP_FILE = repoPath("state.json.tmp");

function parseStateFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return parseStateFile(STATE_FILE);
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    recordError("state_corruption", `Failed to read state.json: ${err.message}`);
    // Try the last-known-good backup before doing anything destructive.
    if (fs.existsSync(STATE_BACKUP_FILE)) {
      try {
        const recovered = parseStateFile(STATE_BACKUP_FILE);
        log("state_error", "Recovered state from state.json.bak after corruption");
        recordError("state_recovered", "Recovered position state from backup");
        return recovered;
      } catch (bakErr) {
        recordError("state_corruption", `Backup also unreadable: ${bakErr.message}`);
      }
    }
    // Preserve the corrupt file for forensics and HALT rather than silently
    // returning empty positions — an empty load would make the agent forget
    // every live on-chain position and stop managing real capital.
    try {
      fs.renameSync(STATE_FILE, repoPath(`state.json.corrupt-${Date.now()}`));
    } catch { /* ignore */ }
    throw new Error(
      "state.json is corrupt and no usable backup exists — refusing to start with empty positions. " +
        "Inspect the saved state.json.corrupt-* file and restore manually."
    );
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    const json = JSON.stringify(state, null, 2);
    // Atomic write: write to a temp file, then rename over the target so a
    // crash mid-write (incl. the 512M max_memory_restart) can never truncate
    // the live state file.
    fs.writeFileSync(STATE_TMP_FILE, json);
    // Keep the current good copy as a backup before replacing it.
    if (fs.existsSync(STATE_FILE)) {
      try { fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE); } catch { /* ignore */ }
    }
    fs.renameSync(STATE_TMP_FILE, STATE_FILE);
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
    recordError("state_corruption", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
  lazy = false,
  gas_cost_sol = 0,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    lazy: !!lazy,
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_started_at: null,
    pending_trailing_current_pnl_pct: null,
    pending_trailing_peak_pnl_pct: null,
    pending_trailing_drop_pct: null,
    pending_trailing_started_at: null,
    confirmed_trailing_exit_reason: null,
    confirmed_trailing_exit_until: null,
    trailing_active: false,
    gas_cost_sol: gas_cost_sol || 0,
    total_gas_sol: gas_cost_sol || 0,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Add gas cost to an existing position (e.g. from claims or swaps during its lifetime).
 */
export function addGasToPosition(positionAddress, gasSol) {
  const state = load();
  const pos = state.positions[positionAddress];
  if (pos) {
    pos.total_gas_sol = (pos.total_gas_sol ?? 0) + gasSol;
  }
  state.cumulative_gas_sol = (state.cumulative_gas_sol ?? 0) + gasSol;
  save(state);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * Toggle or set the lazy flag on a tracked position.
 */
export function setPositionLazy(position_address, lazyValue) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return null;
  pos.lazy = !!lazyValue;
  save(state);
  log("state", `Position ${position_address} lazy mode set to ${pos.lazy}`);
  return pos.lazy;
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position, new_position) {
  const state = load();
  const old = state.positions[old_position];
  if (old) {
    old.closed = true;
    old.closed_at = new Date().toISOString();
    old.notes.push(`Rebalanced into ${new_position} at ${old.closed_at}`);
  }
  const newPos = state.positions[new_position];
  if (newPos) {
    newPos.rebalance_count = (old?.rebalance_count || 0) + 1;
    newPos.notes.push(`Rebalanced from ${old_position}`);
  }
  save(state);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

export function queuePeakConfirmation(position_address, candidatePnlPct, options = {}) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;

  if (options.immediate) {
    pos.peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL accepted at ${candidatePnlPct.toFixed(2)}% from rpc poll`);
    return true;
  }

  const changed =
    pos.pending_peak_pnl_pct == null ||
    candidatePnlPct > pos.pending_peak_pnl_pct;

  if (!changed) return false;

  pos.pending_peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} peak candidate ${candidatePnlPct.toFixed(2)}% queued for 15s confirmation`);
  return true;
}

export function resolvePendingPeak(position_address, currentPnlPct, toleranceRatio = 0.85) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) return { confirmed: false, pending: false };

  const pendingPeak = pos.pending_peak_pnl_pct;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;

  if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
    pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% after recheck`);
    return { confirmed: true, peak: pos.peak_pnl_pct };
  }

  save(state);
  log("state", `Position ${position_address} rejected pending peak ${pendingPeak.toFixed(2)}% after 15s recheck (current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true, pendingPeak };
}

export function queueTrailingDropConfirmation(position_address, peakPnlPct, currentPnlPct, trailingDropPct) {
  if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;
  const dropFromPeak = peakPnlPct - currentPnlPct;
  if (dropFromPeak < trailingDropPct) return false;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const changed =
    pos.pending_trailing_current_pnl_pct == null ||
    currentPnlPct < pos.pending_trailing_current_pnl_pct ||
    dropFromPeak > (pos.pending_trailing_drop_pct ?? -Infinity);

  if (!changed) return false;

  pos.pending_trailing_peak_pnl_pct = peakPnlPct;
  pos.pending_trailing_current_pnl_pct = currentPnlPct;
  pos.pending_trailing_drop_pct = dropFromPeak;
  pos.pending_trailing_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} trailing drop candidate queued: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}%`);
  return true;
}

export function resolvePendingTrailingDrop(position_address, currentPnlPct, trailingDropPct, tolerancePct = 1.0) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_trailing_current_pnl_pct == null || pos.pending_trailing_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingCurrent = pos.pending_trailing_current_pnl_pct;
  const pendingPeak = pos.pending_trailing_peak_pnl_pct;
  const pendingDrop = pos.pending_trailing_drop_pct ?? (pendingPeak - pendingCurrent);

  pos.pending_trailing_current_pnl_pct = null;
  pos.pending_trailing_peak_pnl_pct = null;
  pos.pending_trailing_drop_pct = null;
  pos.pending_trailing_started_at = null;

  const stillNearCrash = currentPnlPct != null && currentPnlPct <= pendingCurrent + tolerancePct;
  const stillDroppedEnough = currentPnlPct != null && (pendingPeak - currentPnlPct) >= trailingDropPct;

  if (stillNearCrash && stillDroppedEnough) {
    const reason = `Trailing TP: peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${(pendingPeak - currentPnlPct).toFixed(2)}% >= ${trailingDropPct}%)`;
    pos.confirmed_trailing_exit_reason = reason;
    pos.confirmed_trailing_exit_until = new Date(Date.now() + 30_000).toISOString();
    save(state);
    log("state", `Position ${position_address} trailing drop confirmed after recheck: pending drop ${pendingDrop.toFixed(2)}%, current ${currentPnlPct.toFixed(2)}%`);
    return { confirmed: true, reason };
  }

  save(state);
  log("state", `Position ${position_address} rejected trailing drop after 15s recheck (pending current: ${pendingCurrent.toFixed(2)}%, current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h, active_bin, lower_bin, upper_bin } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  if (pos.confirmed_trailing_exit_until) {
    if (new Date(pos.confirmed_trailing_exit_until).getTime() > Date.now() && pos.confirmed_trailing_exit_reason) {
      const reason = pos.confirmed_trailing_exit_reason;
      pos.confirmed_trailing_exit_reason = null;
      pos.confirmed_trailing_exit_until = null;
      save(state);
      return { action: "TRAILING_TP", reason, confirmed_recheck: true };
    }
    pos.confirmed_trailing_exit_reason = null;
    pos.confirmed_trailing_exit_until = null;
  }

  let changed = false;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  if (pos.lazy) return null; // Lazy LP mode: bypass all exits

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    if (!pos.stop_loss_violated_since) {
      pos.stop_loss_violated_since = new Date().toISOString();
      save(state);
      log("state", `Position ${position_address} stop-loss threshold violated (${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%). Waiting for confirmation.`);
    } else {
      const violatedDurationMs = Date.now() - new Date(pos.stop_loss_violated_since).getTime();
      const minConfirmationMs = 15000; // 15 seconds
      if (violatedDurationMs >= minConfirmationMs) {
        return {
          action: "STOP_LOSS",
          reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}% (confirmed over ${Math.round(violatedDurationMs / 1000)}s)`,
        };
      }
    }
  } else if (pos.stop_loss_violated_since) {
    pos.stop_loss_violated_since = null;
    save(state);
    log("state", `Position ${position_address} stop-loss violation cleared (recovered to ${currentPnlPct.toFixed(2)}%)`);
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    const activeBin = active_bin != null ? Number(active_bin) : null;
    const lowerBin = lower_bin != null ? Number(lower_bin) : null;
    const upperBin = upper_bin != null ? Number(upper_bin) : null;

    let isBelowRange = false;
    if (activeBin != null && lowerBin != null && activeBin < lowerBin) {
      isBelowRange = true;
    }

    if (isBelowRange) {
      const limitBelow = mgmtConfig.outOfRangeWaitMinutesBelow ?? mgmtConfig.outOfRangeWaitMinutes ?? 180;
      if (limitBelow > 0 && minutesOOR >= limitBelow) {
        return {
          action: "OUT_OF_RANGE",
          reason: `Out of range below for ${minutesOOR}m (limit: ${limitBelow}m)`,
        };
      }
    }
    // OOR-above is NOT handled here — it's handled by getDeterministicCloseRule
    // in index.js where the price stabilization check (isPriceStable) can gate it.
    // This prevents the "hard exit" path from bypassing the stabilization guard.
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}

export function updateClosedPositionPnL(position_address, exit_pnl_pct, exit_pnl_usd, fees_earned_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.exit_pnl_pct = Number(exit_pnl_pct);
  pos.exit_pnl_usd = Number(exit_pnl_usd);
  if (fees_earned_usd !== undefined && fees_earned_usd !== null && !isNaN(fees_earned_usd)) {
    pos.total_fees_claimed_usd = Number(fees_earned_usd);
  }
  save(state);
  log("state", `Position ${position_address} updated PnL: pct=${exit_pnl_pct}%, usd=$${exit_pnl_usd}, fees=$${fees_earned_usd}`);
}

export function getBaselineState() {
  const state = load();
  return state.baseline || { total_deposited: 0, last_signature: null, deposits: [] };
}

export function saveBaselineState(baseline) {
  const state = load();
  state.baseline = baseline;
  save(state);
}

/**
 * Run on-chain state reconciliation.
 * - Auto-closes phantom positions (open in state, missing on-chain)
 * - Alerts on orphaned positions (active on-chain, untracked/closed in state)
 * - Alerts on PnL discrepancies > 5.0%
 */
export async function reconcileStateWithChain() {
  log("state", "Starting on-chain state reconciliation check");
  const { getMyPositions } = await import("./tools/dlmm.js");
  const { sendTelegramMessage } = await import("./telegram.js");

  const liveResult = await getMyPositions({ force: true, silent: true }).catch(() => null);
  if (!liveResult) {
    log("state_error", "Failed to fetch live positions for reconciliation");
    recordError("state_corruption", "Failed to fetch live positions for reconciliation");
    return;
  }

  const state = load();
  const onChainPositions = liveResult.positions || [];
  const onChainSet = new Set(onChainPositions.map(p => p.position));
  let changed = false;
  const now = Date.now();

  // 1. Detect Phantom Positions (open in state.json but missing on-chain)
  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || onChainSet.has(posId)) continue;

    // Grace period check (5 minutes) to avoid race conditions during deploy
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (now - deployedAt < 5 * 60 * 1000) {
      continue;
    }

    // Auto-heal local state
    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push("Auto-closed during state reconciliation (not found on-chain)");
    changed = true;
    log("state", `Reconciliation: Auto-closed phantom position ${posId}`);

    await sendTelegramMessage(
      `⚠️ <b>Drift Warning: Phantom Position</b>\nPosition <code>${posId}</code> (${pos.pool_name || pos.pool}) was tracked as open in local state, but not found on-chain. Local state has been auto-healed and marked as closed.`
    ).catch(e => log("telegram_error", `Failed to send phantom alert: ${e.message}`));
  }

  // 2. Detect Orphaned Positions (active on-chain but untracked/closed in state)
  for (const p of onChainPositions) {
    const posId = p.position;
    const pos = state.positions[posId];
    if (!pos || pos.closed) {
      log("state_error", `Reconciliation: Orphaned position found on-chain: ${posId} (${p.pair})`);
      recordError("state_corruption", `Orphaned position found on-chain: ${posId} (${p.pair})`);

      await sendTelegramMessage(
        `🚨 <b>Drift Alert: Orphaned Position</b>\nPosition <code>${posId}</code> (${p.pair}) is active on-chain, but is NOT tracked as open in local state.\n<b>Action Required:</b> Re-import or manage this position manually.`
      ).catch(e => log("telegram_error", `Failed to send orphaned alert: ${e.message}`));
    }
  }

  // 3. Detect PnL Discrepancy > 5.0%
  for (const p of onChainPositions) {
    if (p.pnl_pct_diff != null && p.pnl_pct_diff > 5.0) {
      log("state_error", `Reconciliation: PnL discrepancy for ${p.position} (${p.pair}): diff=${p.pnl_pct_diff}%`);

      await sendTelegramMessage(
        `⚠️ <b>Drift Warning: PnL Discrepancy</b>\nPosition <code>${p.position.slice(0, 8)}...</code> (${p.pair}) has a PnL discrepancy.\nOn-chain derived: ${p.pnl_pct}%\nMeteora reported: ${(p.pnl_pct - p.pnl_pct_diff).toFixed(2)}%\nDifference: ${p.pnl_pct_diff}%.`
      ).catch(e => log("telegram_error", `Failed to send PnL discrepancy alert: ${e.message}`));
    }
  }

  if (changed) {
    save(state);
  }
  log("state", "State reconciliation check complete");
}

