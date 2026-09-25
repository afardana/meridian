import { log } from './logger.js';

/** @type {Map<string, Array<{ ts: number, tvl: number }>>} */
const _tvlSnapshots = new Map();

/** Maximum number of snapshots retained per pool (~1h at 5-min intervals). */
const MAX_SNAPSHOTS_PER_POOL = 12;

/** Minimum interval between recordings for the same pool (2 minutes). */
const SNAPSHOT_MIN_INTERVAL_MS = 2 * 60 * 1000;

/** Snapshots older than this are pruned (2 hours). */
const MAX_SNAPSHOT_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Records a TVL data point for a pool.
 *
 * Guards:
 *  - Validates poolAddress (non-empty string) and tvl (positive finite number).
 *  - Enforces a minimum interval between consecutive recordings for the same pool.
 *  - Prunes snapshots older than 2 hours.
 *  - Enforces FIFO eviction at MAX_SNAPSHOTS_PER_POOL.
 *
 * @param {string} poolAddress - On-chain address of the DLMM pool.
 * @param {number} tvl - Current total value locked (in USD or SOL).
 * @param {object} [metrics] - Optional metrics: { dynamic_fee_pct, fee_per_tvl_24h }
 */
export function recordTvlSnapshot(poolAddress, tvl, metrics = {}) {
  if (typeof poolAddress !== 'string' || poolAddress.length === 0) return;
  if (typeof tvl !== 'number' || !isFinite(tvl) || tvl < 0) return;

  const now = Date.now();

  if (!_tvlSnapshots.has(poolAddress)) {
    _tvlSnapshots.set(poolAddress, []);
  }

  const snaps = _tvlSnapshots.get(poolAddress);

  // Enforce minimum interval
  if (snaps.length > 0) {
    const last = snaps[snaps.length - 1];
    if (now - last.ts < SNAPSHOT_MIN_INTERVAL_MS) return;
  }

  // Prune stale entries
  const cutoff = now - MAX_SNAPSHOT_AGE_MS;
  while (snaps.length > 0 && snaps[0].ts < cutoff) {
    snaps.shift();
  }

  // FIFO eviction
  if (snaps.length >= MAX_SNAPSHOTS_PER_POOL) {
    snaps.shift();
  }

  snaps.push({
    ts: now,
    tvl,
    dynamic_fee_pct: typeof metrics?.dynamic_fee_pct === 'number' ? metrics.dynamic_fee_pct : null,
    fee_per_tvl_24h: typeof metrics?.fee_per_tvl_24h === 'number' ? metrics.fee_per_tvl_24h : null,
  });
}

/**
 * Checks whether a pool's dynamic fee or fee/TVL yield has decayed from its recent peak.
 *
 * @param {string} poolAddress - On-chain address of the pool.
 * @param {object} currentMetrics - { dynamic_fee_pct, fee_per_tvl_24h }
 * @param {number} [thresholdPct=50] - Percentage drop from peak to trigger decay.
 * @returns {{ decayed: boolean, reason: string|null, peakDynamic: number, peakFeeTvl: number }}
 */
export function checkSurgeDecay(poolAddress, currentMetrics = {}, thresholdPct = 50) {
  const safe = { decayed: false, reason: null, peakDynamic: 0, peakFeeTvl: 0 };
  if (!poolAddress || typeof poolAddress !== 'string') return safe;

  const snaps = _tvlSnapshots.get(poolAddress);
  if (!snaps || snaps.length === 0) return safe;

  let peakDynamic = 0;
  let peakFeeTvl = 0;
  for (const snap of snaps) {
    if (snap.dynamic_fee_pct != null && snap.dynamic_fee_pct > peakDynamic) {
      peakDynamic = snap.dynamic_fee_pct;
    }
    if (snap.fee_per_tvl_24h != null && snap.fee_per_tvl_24h > peakFeeTvl) {
      peakFeeTvl = snap.fee_per_tvl_24h;
    }
  }

  const curDynamic = currentMetrics?.dynamic_fee_pct != null ? Number(currentMetrics.dynamic_fee_pct) : null;
  const curFeeTvl = currentMetrics?.fee_per_tvl_24h != null ? Number(currentMetrics.fee_per_tvl_24h) : null;

  if (peakDynamic >= 0.5 && curDynamic != null) {
    const drop = ((peakDynamic - curDynamic) / peakDynamic) * 100;
    if (drop >= thresholdPct) {
      return {
        decayed: true,
        reason: `Dynamic fee dropped ${drop.toFixed(1)}% from peak ${peakDynamic}% to ${curDynamic}%`,
        peakDynamic,
        peakFeeTvl,
      };
    }
  }

  if (peakFeeTvl >= 5.0 && curFeeTvl != null) {
    const drop = ((peakFeeTvl - curFeeTvl) / peakFeeTvl) * 100;
    if (drop >= thresholdPct) {
      return {
        decayed: true,
        reason: `Fee/TVL yield dropped ${drop.toFixed(1)}% from peak ${peakFeeTvl}% to ${curFeeTvl}%`,
        peakDynamic,
        peakFeeTvl,
      };
    }
  }

  return { decayed: false, reason: null, peakDynamic, peakFeeTvl };
}

/**
 * Checks whether a pool's TVL is draining relative to its recent peak.
 *
 * Detection logic:
 *  1. Retrieve snapshot history for the pool.
 *  2. If no snapshots exist, return not draining.
 *  3. Find the peak TVL across all stored snapshots.
 *  4. Compute `changePct = (currentTvl - peakTvl) / peakTvl * 100`.
 *  5. If `changePct <= thresholdPct` (negative), flag as draining.
 *
 * @param {string} poolAddress - On-chain address of the DLMM pool.
 * @param {number} currentTvl - The pool's current TVL.
 * @param {number} [thresholdPct=-30] - Negative percentage threshold to trigger (e.g. -30 = 30% drop).
 * @returns {{ draining: boolean, changePct: number, peakTvl: number, currentTvl: number }}
 */
export function checkTvlDrain(poolAddress, currentTvl, thresholdPct = -30) {
  const safe = { draining: false, changePct: 0, peakTvl: 0, currentTvl: currentTvl ?? 0 };

  if (typeof poolAddress !== 'string' || poolAddress.length === 0) return safe;
  if (typeof currentTvl !== 'number' || !isFinite(currentTvl) || currentTvl < 0) return safe;

  const snaps = _tvlSnapshots.get(poolAddress);
  if (!snaps || snaps.length === 0) return { ...safe, currentTvl };

  let peakTvl = 0;
  for (const snap of snaps) {
    if (snap.tvl > peakTvl) peakTvl = snap.tvl;
  }

  if (peakTvl <= 0) return { ...safe, currentTvl };

  const changePct = ((currentTvl - peakTvl) / peakTvl) * 100;
  const draining = changePct <= thresholdPct;

  if (draining) {
    log(`🚨 TVL drain detected on ${poolAddress.slice(0, 8)}…: ${changePct.toFixed(1)}% from peak $${peakTvl.toFixed(0)} → $${currentTvl.toFixed(0)}`);
  }

  return {
    draining,
    changePct: parseFloat(changePct.toFixed(2)),
    peakTvl,
    currentTvl,
  };
}

/**
 * Returns aggregate statistics about the TVL guard's tracked state.
 *
 * @returns {{ trackedPools: number, totalSnapshots: number }}
 */
export function getTvlGuardStats() {
  let totalSnapshots = 0;
  for (const snaps of _tvlSnapshots.values()) {
    totalSnapshots += snaps.length;
  }
  return { trackedPools: _tvlSnapshots.size, totalSnapshots };
}
