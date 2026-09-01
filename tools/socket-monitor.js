import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { getTrackedPosition, getTrackedPositions, markOutOfRange, markInRange } from "../state.js";
import { recordTick } from "../db/tick-store.js";
import { requestPositionDiscovery } from "./dlmm.js";

let _connection = null;
let _DLMM = null;
let _positionV2Filter = null;
let _positionOwnerFilter = null;
let _coder = null;
const _subscriptions = new Map(); // poolAddress -> subscriptionId
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const FORCE_SYNC_MIN_INTERVAL_MS = 60 * 1000;
let _lastForceSyncRequestAt = 0;
const POSITION_DISCOVERY_HINT_COOLDOWN_MS = 5_000;
let _positionSubscription = null;
let _lastPositionDiscoveryHintAt = 0;
let _positionDiscoverySignalSink = null;

// Optional bin-event sink (index.js registers the socket-fed crash-detector shadow
// here). Callback injection rather than an import so socket-monitor stays free of
// index.js circular deps. The sink must never break the socket handler.
let _binEventSink = null;
export function setBinEventSink(fn) {
  _binEventSink = typeof fn === "function" ? fn : null;
}

// Lets the scheduler slow its owner-wide fallback scan while this filtered
// wallet subscription is healthy. The periodic fallback remains enabled.
export function setPositionDiscoverySignalSink(fn) {
  _positionDiscoverySignalSink = typeof fn === "function" ? fn : null;
}

function signalPositionDiscoveryHealth(healthy) {
  try { _positionDiscoverySignalSink?.(healthy === true); } catch { /* sink is advisory */ }
}

async function loadDlmmSdk() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _positionV2Filter = mod.positionV2Filter;
    _positionOwnerFilter = mod.positionOwnerFilter;
  }
  return _DLMM;
}

/**
 * Initialize the WebSocket monitor with the Solana Connection instance.
 */
export async function startSocketMonitor(connection, { walletAddress = null } = {}) {
  _connection = connection;
  log("socket_monitor", "WebSocket monitor initialized");
  if (!walletAddress) {
    signalPositionDiscoveryHealth(false);
    log("socket_monitor", "Wallet position WebSocket discovery disabled: wallet address unavailable");
    return;
  }
  try {
    await loadDlmmSdk();
    if (typeof _positionV2Filter !== "function" || typeof _positionOwnerFilter !== "function") {
      throw new Error("Meteora PositionV2 account filters unavailable");
    }
    const owner = new PublicKey(walletAddress);
    _positionSubscription = _connection.onProgramAccountChange(
      DLMM_PROGRAM_ID,
      (pubkey, accountInfo) => handlePositionProgramAccountChange(pubkey, accountInfo),
      "confirmed",
      [_positionV2Filter(), _positionOwnerFilter(owner)],
    );
    signalPositionDiscoveryHealth(true);
    log("socket_monitor", `Subscribed to wallet PositionV2 changes: ${walletAddress.slice(0, 8)}`);
  } catch (err) {
    signalPositionDiscoveryHealth(false);
    log("socket_monitor_error", `Wallet position subscription failed: ${err.message}`);
  }
}

/**
 * Stop the WebSocket monitor and unsubscribe from all active pool accounts.
 */
export async function stopSocketMonitor() {
  if (!_connection) return;
  if (_positionSubscription != null) {
    try {
      await _connection.removeProgramAccountChangeListener(_positionSubscription);
    } catch (err) {
      log("socket_monitor_error", `Failed to unsubscribe wallet position stream: ${err.message}`);
    }
    _positionSubscription = null;
  }
  signalPositionDiscoveryHealth(false);
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

function handlePositionProgramAccountChange(pubkey, accountInfo) {
  try {
    const address = pubkey?.toBase58?.() || String(pubkey || "");
    if (!address) return;
    const tracked = getTrackedPosition(address);
    // Existing open positions are already covered by the 5s known-position PnL
    // poll. Only an unknown account (or a deletion event) should wake discovery.
    if (tracked && !tracked.closed && accountInfo) return;
    const now = Date.now();
    if (now - _lastPositionDiscoveryHintAt < POSITION_DISCOVERY_HINT_COOLDOWN_MS) return;
    _lastPositionDiscoveryHintAt = now;
    requestPositionDiscovery(`WebSocket PositionV2 change ${address.slice(0, 8)}`);
  } catch (err) {
    log("socket_monitor_error", `Wallet position change handler failed: ${err.message}`);
  }
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

    if (_binEventSink) {
      try { _binEventSink(poolAddress, activeId, Date.now()); } catch { /* sink faults never break the socket handler */ }
    }

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
    const now = Date.now();
    if (now - _lastForceSyncRequestAt < FORCE_SYNC_MIN_INTERVAL_MS) return;
    // Coalesce transitions that arrive before the PnL poller consumes the IPC
    // file. The consumer also applies a time-based cooldown for flapping state
    // that is observed across multiple poller intervals.
    if (fs.existsSync(forceSyncFile)) return;
    fs.writeFileSync(forceSyncFile, "true", "utf8");
    _lastForceSyncRequestAt = now;
  } catch (e) {
    // ignore
  }
}
