import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { getTrackedPositions, markOutOfRange, markInRange } from "../state.js";
import { recordTick } from "../db/tick-store.js";

let _connection = null;
let _DLMM = null;
let _coder = null;
const _subscriptions = new Map(); // poolAddress -> subscriptionId

async function loadDlmmSdk() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

/**
 * Initialize the WebSocket monitor with the Solana Connection instance.
 */
export async function startSocketMonitor(connection) {
  _connection = connection;
  log("socket_monitor", "WebSocket monitor initialized");
}

/**
 * Stop the WebSocket monitor and unsubscribe from all active pool accounts.
 */
export async function stopSocketMonitor() {
  if (!_connection) return;
  for (const [pool, subId] of _subscriptions.entries()) {
    try {
      await _connection.removeAccountChangeListener(subId);
    } catch (err) {
      log("socket_monitor_error", `Failed to unsubscribe from ${pool.slice(0, 8)}: ${err.message}`);
    }
  }
  _subscriptions.clear();
  log("socket_monitor", "WebSocket monitor stopped and all connections closed");
}

/**
 * Sync WebSocket subscriptions with the list of currently open positions.
 */
export async function syncSocketSubscriptions(openPositions) {
  if (!_connection) return;
  
  const activePools = new Set(openPositions.map(p => p.pool));

  // 1. Unsubscribe from pools that are no longer active
  for (const [pool, subId] of _subscriptions.entries()) {
    if (!activePools.has(pool)) {
      try {
        await _connection.removeAccountChangeListener(subId);
        _subscriptions.delete(pool);
        log("socket_monitor", `Unsubscribed from closed pool: ${pool.slice(0, 8)}`);
      } catch (err) {
        log("socket_monitor_error", `Unsubscribe failed for ${pool.slice(0, 8)}: ${err.message}`);
      }
    }
  }

  // 2. Subscribe to new active pools
  for (const poolAddr of activePools) {
    if (!_subscriptions.has(poolAddr)) {
      try {
        const pubkey = new PublicKey(poolAddr);
        
        // Lazy-load coder if not yet done
        if (!_coder) {
          const DLMM = await loadDlmmSdk();
          const dummyPool = await DLMM.create(_connection, pubkey);
          _coder = dummyPool.program.coder;
        }

        const subId = _connection.onAccountChange(
          pubkey,
          (accountInfo) => {
            handlePoolAccountChange(poolAddr, accountInfo);
          },
          "confirmed"
        );
        _subscriptions.set(poolAddr, subId);
        log("socket_monitor", `Subscribed to active pool: ${poolAddr.slice(0, 8)} (Sub ID: ${subId})`);
      } catch (err) {
        log("socket_monitor_error", `Subscription failed for ${poolAddr.slice(0, 8)}: ${err.message}`);
      }
    }
  }
}

function handlePoolAccountChange(poolAddress, accountInfo) {
  if (!_coder) return;
  try {
    const decoded = _coder.accounts.decode("lbPair", accountInfo.data);
    const activeId = decoded.activeId;
    if (activeId == null) return;

    // Persist this pool-level bin tick (DATA CAPTURE ONLY — ground truth for the
    // replay harness; no behavior change). Fires on every account-change event the
    // socket delivers, giving denser bin coverage than the poller. recordTick is
    // synchronous + never-throws + no-ops unless pg + capture on.
    recordTick({ pool_address: poolAddress, active_bin: activeId, source: "socket" });

    // Retrieve the open position associated with this pool
    const openPositions = getTrackedPositions(true);
    const position = openPositions.find(p => p.pool === poolAddress);

    if (position && !position.closed) {
      const minBin = position.bin_range?.min;
      const maxBin = position.bin_range?.max;
      if (minBin == null || maxBin == null) return;

      const isOor = activeId < minBin || activeId > maxBin;
      const currentOor = position.out_of_range_since != null;

      if (isOor && !currentOor) {
        log("socket_monitor", `Position ${position.position.slice(0, 8)} went OUT OF RANGE (Active bin: ${activeId} vs range: [${minBin}, ${maxBin}])`);
        markOutOfRange(position.position);
        
        // Trigger immediate force-sync to evaluate exit rules without waiting for the next cron tick
        triggerImmediateSync();
      } else if (!isOor && currentOor) {
        log("socket_monitor", `Position ${position.position.slice(0, 8)} returned IN RANGE (Active bin: ${activeId} vs range: [${minBin}, ${maxBin}])`);
        markInRange(position.position);
      }
    }
  } catch (err) {
    log("socket_monitor_error", `Failed to handle account change event: ${err.message}`);
  }
}

function triggerImmediateSync() {
  const forceSyncFile = repoPath(".force-sync");
  try {
    fs.writeFileSync(forceSyncFile, "true", "utf8");
  } catch (e) {
    // ignore
  }
}
