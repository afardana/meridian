/**
 * Fee Efficiency Ranking
 *
 * Ranks pool candidates by fee yield earned *per unit of impermanent-loss risk*,
 * rather than by raw APR / fee_active_tvl_ratio. A high fee ratio is often high
 * precisely because the pool is volatile (= high IL exposure); this metric
 * normalizes for that so the LLM sees "cheap" yield (lots of fees for little
 * price risk) separately from "expensive" yield.
 *
 * The metric is intentionally a ballpark:
 *
 *   efficiency = fee_active_tvl_ratio / volatility
 *
 * `fee_active_tvl_ratio` is fee revenue over active TVL for the screening
 * timeframe window (already in percent form — 0.29 = 0.29%). `volatility` is the
 * 30m-normalized IL proxy. IL is path-dependent and forward-looking, so it can't
 * be measured pre-deploy — volatility is the cheapest honest stand-in. Because
 * both inputs are timeframe-dependent, the *absolute* ratio scale shifts with the
 * screening timeframe, so this module ranks **relative to the candidate set**
 * (rank + percentile) and reports the raw ratio alongside, rather than pretending
 * an absolute 0-100 score is universally calibrated.
 */

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ─── Deploy-time capture cache ──────────────────────────────────
// The fee-efficiency annotation is computed on the *screening candidate*, which
// isn't threaded through to deploy_position. Cache the latest ranking per pool
// address so the deploy path can snapshot it onto the position for later
// outcome correlation (lessons.js). Capped to avoid unbounded growth.
const _byPool = new Map();
const _CACHE_CAP = 300;

function poolAddress(pool) {
  return pool?.pool || pool?.pool_address || pool?.address || null;
}

/**
 * Look up the most recent fee-efficiency snapshot for a pool address.
 * @returns {{ ratio, fee_ratio, volatility, rank, of, percentile } | null}
 */
export function getFeeEfficiencyForPool(address) {
  if (!address) return null;
  return _byPool.get(address) || null;
}

function poolFeeRatio(pool) {
  // The condensed candidate uses fee_active_tvl_ratio; raw discovery pools too.
  return numeric(pool?.fee_active_tvl_ratio);
}

function poolVolatility(pool) {
  return numeric(pool?.volatility);
}

/**
 * Compute the raw fee-efficiency ratio for a single pool.
 * @param {object} pool - condensed candidate or raw discovery pool
 * @returns {{ ratio: number, fee_ratio: number, volatility: number } | null}
 *          null when inputs are missing/unusable (no fees or zero volatility).
 */
export function computeFeeEfficiency(pool) {
  const feeRatio = poolFeeRatio(pool);
  const volatility = poolVolatility(pool);
  if (feeRatio == null || volatility == null || volatility <= 0) return null;
  const ratio = feeRatio / volatility;
  if (!Number.isFinite(ratio)) return null;
  return {
    ratio: Math.round(ratio * 10000) / 10000,
    fee_ratio: feeRatio,
    volatility,
  };
}

/**
 * Rank a set of candidate pools by fee efficiency and annotate each in place
 * with `pool._feeEfficiency = { ratio, fee_ratio, volatility, rank, of, percentile }`.
 *
 * Pools with unusable inputs are still annotated (`{ ratio: null, rank: null }`)
 * so callers can render a stable line. Ranking is 1 = most efficient. Percentile
 * is 0-100, where 100 = best of the set.
 *
 * @param {object[]} pools
 * @returns {object[]} the same array (sorted order untouched — only annotated)
 */
export function rankByFeeEfficiency(pools) {
  if (!Array.isArray(pools) || pools.length === 0) return pools;

  const scored = [];
  for (const pool of pools) {
    const fe = computeFeeEfficiency(pool);
    pool._feeEfficiency = fe
      ? { ...fe, rank: null, of: null, percentile: null }
      : { ratio: null, fee_ratio: poolFeeRatio(pool), volatility: poolVolatility(pool), rank: null, of: null, percentile: null };
    if (fe) scored.push(pool);
  }

  // Rank only the pools with a usable ratio (descending — higher = better).
  scored.sort((a, b) => b._feeEfficiency.ratio - a._feeEfficiency.ratio);
  const n = scored.length;
  scored.forEach((pool, i) => {
    pool._feeEfficiency.rank = i + 1;
    pool._feeEfficiency.of = n;
    // Percentile: best (i=0) → 100, worst → 0 (single-pool set → 100).
    pool._feeEfficiency.percentile = n > 1 ? Math.round(((n - 1 - i) / (n - 1)) * 100) : 100;
  });

  // Snapshot each ranked candidate for the deploy path to capture later.
  for (const pool of scored) {
    const addr = poolAddress(pool);
    if (!addr) continue;
    if (_byPool.has(addr)) _byPool.delete(addr); // refresh insertion order
    _byPool.set(addr, { ...pool._feeEfficiency });
    if (_byPool.size > _CACHE_CAP) _byPool.delete(_byPool.keys().next().value);
  }

  return pools;
}

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

function round2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}

/** Pearson correlation between two equal-length numeric arrays, or null. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  if (den === 0) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * Validate the fee-efficiency signal against realized outcomes: does a higher
 * fee-efficiency percentile at deploy correlate with better closed PnL?
 *
 * Pure — pass the closed-position performance records (each may carry the
 * `fee_efficiency` snapshot captured at deploy). Buckets by percentile tier and
 * reports avg PnL / win rate per tier plus the percentile↔PnL correlation.
 *
 * @param {Array<object>} performance - records with { fee_efficiency, pnl_pct }
 * @returns {object}
 */
export function analyzeFeeEfficiencyOutcomes(performance) {
  const rows = (Array.isArray(performance) ? performance : []).filter(
    (r) => r?.fee_efficiency && r.fee_efficiency.percentile != null && Number.isFinite(r.pnl_pct)
  );
  if (rows.length < 3) {
    return { ready: false, count: rows.length, note: "need ≥3 closed positions with a fee-efficiency snapshot" };
  }

  const tiers = { high: [], mid: [], low: [] };
  for (const r of rows) {
    const pct = r.fee_efficiency.percentile;
    if (pct >= 67) tiers.high.push(r);
    else if (pct >= 33) tiers.mid.push(r);
    else tiers.low.push(r);
  }
  const summarize = (arr) => ({
    n: arr.length,
    avg_pnl_pct: arr.length ? round2(mean(arr.map((r) => r.pnl_pct))) : null,
    win_rate_pct: arr.length ? Math.round((arr.filter((r) => r.pnl_pct > 0).length / arr.length) * 100) : null,
  });

  const corr = pearson(rows.map((r) => r.fee_efficiency.percentile), rows.map((r) => r.pnl_pct));
  let verdict = "inconclusive";
  if (corr != null) {
    if (corr >= 0.3) verdict = "fee-efficiency predicts better PnL (positive)";
    else if (corr <= -0.3) verdict = "INVERTED — higher fee-efficiency tracked worse PnL";
    else verdict = "weak/no correlation so far";
  }

  return {
    ready: true,
    count: rows.length,
    tiers: { high: summarize(tiers.high), mid: summarize(tiers.mid), low: summarize(tiers.low) },
    percentile_pnl_correlation: corr,
    verdict,
    note: rows.length < 12 ? "small sample — treat as directional, not conclusive" : null,
  };
}

/**
 * Compact one-line render of a pool's fee efficiency for prompt injection.
 * @param {object} pool - a pool annotated by rankByFeeEfficiency()
 * @returns {string|null}
 */
export function formatFeeEfficiency(pool) {
  const fe = pool?._feeEfficiency;
  if (!fe || fe.ratio == null) return null;
  const rankStr = fe.rank != null && fe.of != null ? `#${fe.rank}/${fe.of}` : "?";
  return `fee_efficiency=${fe.ratio} (fee%/volatility, ${rankStr}, p${fe.percentile})`;
}
