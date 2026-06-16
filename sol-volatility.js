import { log } from './logger.js';

/** @type {Array<{ ts: number, price: number }>} */
const _priceHistory = [];

/** Maximum age for price history entries (1 hour). */
const MAX_HISTORY_AGE_MS = 60 * 60 * 1000;

/**
 * Records a SOL/USD price sample into the rolling history.
 * Prunes entries older than 1 hour. Only records valid positive numbers.
 * @param {number} price - Current SOL/USD price.
 */
export function recordSolPrice(price) {
  if (typeof price !== 'number' || !isFinite(price) || price <= 0) return;

  const now = Date.now();

  // Prune stale entries
  const cutoff = now - MAX_HISTORY_AGE_MS;
  while (_priceHistory.length > 0 && _priceHistory[0].ts < cutoff) {
    _priceHistory.shift();
  }

  _priceHistory.push({ ts: now, price });
}

/**
 * Checks whether SOL/USD is experiencing extreme volatility within the
 * rolling 60-minute window.
 *
 * Detection logic:
 *  1. If fewer than 2 data points → not volatile.
 *  2. Find min and max prices across all history entries.
 *  3. Compute max deviation of the most recent price from both extremes.
 *  4. Also consider the overall range spread.
 *  5. If either metric exceeds `thresholdPct`, flag as volatile.
 *
 * @param {number} [thresholdPct=8] - Percentage move that triggers the guard.
 * @returns {{ volatile: boolean, changePct: number, direction: 'up'|'down'|null, since: string }}
 */
export function checkSolVolatility(thresholdPct = 8) {
  const safe = { volatile: false, changePct: 0, direction: null, since: '' };

  if (_priceHistory.length < 2) return safe;

  const current = _priceHistory[_priceHistory.length - 1];

  let min = current.price;
  let max = current.price;
  let minTs = current.ts;
  let maxTs = current.ts;

  for (const entry of _priceHistory) {
    if (entry.price < min) { min = entry.price; minTs = entry.ts; }
    if (entry.price > max) { max = entry.price; maxTs = entry.ts; }
  }

  // Deviation from extremes relative to the extreme itself
  const deviationFromMin = min > 0 ? (Math.abs(current.price - min) / min) * 100 : 0;
  const deviationFromMax = max > 0 ? (Math.abs(current.price - max) / max) * 100 : 0;
  const maxDeviation = Math.max(deviationFromMin, deviationFromMax);

  // Overall range spread
  const rangeSpread = min > 0 ? ((max - min) / min) * 100 : 0;

  const effectiveChange = Math.max(maxDeviation, rangeSpread);

  if (effectiveChange > thresholdPct) {
    // Determine direction: is the current price near the top or bottom?
    let direction = null;
    let sinceTs = current.ts;

    if (deviationFromMin >= deviationFromMax) {
      // Current is far from min → price went up
      direction = 'up';
      sinceTs = minTs;
    } else {
      // Current is far from max → price went down
      direction = 'down';
      sinceTs = maxTs;
    }

    const since = new Date(sinceTs).toISOString();
    log(`⚠️  SOL volatility guard: ${effectiveChange.toFixed(1)}% ${direction} move detected (threshold: ${thresholdPct}%)`);

    return { volatile: true, changePct: parseFloat(effectiveChange.toFixed(2)), direction, since };
  }

  return { ...safe, changePct: parseFloat(effectiveChange.toFixed(2)) };
}

/**
 * Returns a human-readable status string summarising the current SOL
 * price and 1-hour volatility window.
 *
 * @returns {string} Formatted status line.
 */
export function getSolVolatilityStatus() {
  if (_priceHistory.length === 0) return 'SOL: No price data';

  const current = _priceHistory[_priceHistory.length - 1];

  let min = current.price;
  let max = current.price;
  for (const entry of _priceHistory) {
    if (entry.price < min) min = entry.price;
    if (entry.price > max) max = entry.price;
  }

  const rangePct = min > 0 ? ((max - min) / min) * 100 : 0;
  const { volatile } = checkSolVolatility();
  const statusIcon = volatile ? '⚠️ Volatile' : '✅ Stable';

  return `SOL: $${current.price.toFixed(2)} | 1h range: $${min.toFixed(2)}-$${max.toFixed(2)} (${rangePct.toFixed(1)}%) | Status: ${statusIcon}`;
}
