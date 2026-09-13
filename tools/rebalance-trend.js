import { log } from "../logger.js";
import { config } from "../config.js";

/**
 * Fetch OHLCV candles for a Solana pool via GeckoTerminal public API.
 * Supports "1m", "5m", "15m", "1h". Defaults to "5m".
 * Returns array of { timestamp, open, high, low, close, volume } ordered oldest to newest.
 */
export async function fetchPoolCandles(poolAddress, { timeframe = "5m", limit = 10 } = {}) {
  if (!poolAddress) return [];
  try {
    let aggregate = 5;
    let type = "minute";
    if (timeframe === "1m") { aggregate = 1; type = "minute"; }
    else if (timeframe === "5m") { aggregate = 5; type = "minute"; }
    else if (timeframe === "15m") { aggregate = 15; type = "minute"; }
    else if (timeframe === "1h") { aggregate = 1; type = "hour"; }

    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/${type}?aggregate=${aggregate}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      log("candle_warn", `GeckoTerminal ${timeframe} candle fetch returned HTTP ${res.status} for ${poolAddress}`);
      return [];
    }
    const data = await res.json();
    const list = data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list) || list.length === 0) return [];

    // list is returned newest first: [timestamp, open, high, low, close, volume]
    // Reverse to chronological order (oldest -> newest)
    return list.slice(0, limit).reverse().map(([ts, open, high, low, close, volume]) => ({
      timestamp: ts,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      isGreen: Number(close) >= Number(open),
    }));
  } catch (err) {
    log("candle_error", `Failed fetching ${timeframe} candles for ${poolAddress}: ${err.message}`);
    return [];
  }
}

/** Legacy / backwards-compatible alias for 15m candles */
export async function fetch15mCandles(poolAddress, limit = 6) {
  return fetchPoolCandles(poolAddress, { timeframe: "15m", limit });
}

/**
 * Check if recent candles are trending increasing.
 * Evaluates momentum, price structure (higher lows / higher closes), and candle color ratio.
 * Default: 6x 5m candles (30-minute lookback).
 *
 * @param {string} poolAddress
 * @param {object} [options]
 * @param {string} [options.timeframe] "5m" | "15m" (defaults to config.management.rebalanceTrendTimeframe ?? "5m")
 * @param {number} [options.candleCount] number of candles (defaults to config.management.rebalanceTrendCandles ?? 6)
 * @returns {Promise<{ confirmed: boolean, reason: string, candles: Array, netGainPct: number }>}
 */
export async function isRebalanceTrendIncreasing(poolAddress, options = {}) {
  const timeframe = options.timeframe || config.management?.rebalanceTrendTimeframe || "5m";
  const count = Math.max(3, Number(options.candleCount || config.management?.rebalanceTrendCandles || 6));

  const candles = await fetchPoolCandles(poolAddress, { timeframe, limit: count + 2 });
  if (candles.length < count) {
    return {
      confirmed: false,
      reason: `Insufficient ${timeframe} candle history (found ${candles.length}/${count} candles)`,
      candles,
      netGainPct: 0,
    };
  }

  // Take the last `count` chronological candles: oldest -> newest
  const slice = candles.slice(-count);
  const cOldest = slice[0];
  const cLatest = slice[slice.length - 1];
  const cPrev = slice[slice.length - 2];

  const basePrice = cOldest.open > 0 ? cOldest.open : cOldest.close;
  const netGainPct = basePrice > 0 ? ((cLatest.close - basePrice) / basePrice) * 100 : 0;

  // Advancing check: latest close is higher than or equal to previous, or within tiny -0.5% boundary
  const latestAdvancing = cLatest.close >= cPrev.close || (cPrev.close > 0 && (cLatest.close - cPrev.close) / cPrev.close >= -0.005);

  const greenCount = slice.filter((c) => c.isGreen).length;
  const minGreens = Math.ceil(count * 0.6); // e.g. 4 of 6 (66%), or 3 of 4 (75%)

  // Higher lows check: compare average low of second half vs first half
  const mid = Math.floor(count / 2);
  const avgLowFirst = slice.slice(0, mid).reduce((s, c) => s + c.low, 0) / mid;
  const avgLowSecond = slice.slice(mid).reduce((s, c) => s + c.low, 0) / (count - mid);
  const higherLows = avgLowSecond >= avgLowFirst;

  // Higher closes check: latest two closes advancing
  const higherCloses = cLatest.close >= cPrev.close && cPrev.close >= slice[slice.length - 3].close;

  const hasUpwardStructure = higherCloses || higherLows || greenCount >= minGreens;
  const isTrendingUp = netGainPct > 0 && latestAdvancing && hasUpwardStructure;

  if (isTrendingUp) {
    return {
      confirmed: true,
      reason: `Past ${count} ${timeframe} candles trending increasing: net +${netGainPct.toFixed(2)}%, ${greenCount}/${count} green, latest close ${cLatest.close} vs prev ${cPrev.close}`,
      candles: slice,
      netGainPct,
    };
  }

  return {
    confirmed: false,
    reason: `${count} ${timeframe} candles not trending increasing: net ${netGainPct >= 0 ? "+" : ""}${netGainPct.toFixed(2)}%, ${greenCount}/${count} green (c0=${basePrice.toFixed(6)} -> c${count - 1}=${cLatest.close.toFixed(6)})`,
    candles: slice,
    netGainPct,
  };
}
