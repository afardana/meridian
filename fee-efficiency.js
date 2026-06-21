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

  return pools;
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
