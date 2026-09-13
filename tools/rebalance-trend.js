import { log } from "../logger.js";

/**
 * Fetch 15-minute OHLCV candles for a Solana pool via GeckoTerminal public API.
 * Returns array of { timestamp, open, high, low, close, volume } ordered oldest to newest.
 */
export async function fetch15mCandles(poolAddress, limit = 6) {
  if (!poolAddress) return [];
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=15&limit=${limit}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      log("candle_warn", `GeckoTerminal 15m candle fetch returned HTTP ${res.status} for ${poolAddress}`);
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
    log("candle_error", `Failed fetching 15m candles for ${poolAddress}: ${err.message}`);
    return [];
  }
}

/**
 * Check if the past 4 15-minute candles are trending increasing.
 * Operator heuristic: "I usually do the rebalancing when I see the 15min candles
 * for the past 4 ones are trending increasing. Otherwise I keep it as-is."
 *
 * @param {string} poolAddress
 * @returns {Promise<{ confirmed: boolean, reason: string, candles: Array }>}
 */
export async function isRebalanceTrendIncreasing(poolAddress) {
  const candles = await fetch15mCandles(poolAddress, 5);
  if (candles.length < 4) {
    return {
      confirmed: false,
      reason: `Insufficient 15m candle history (found ${candles.length}/4 candles)`,
      candles,
    };
  }

  // Take the last 4 chronological candles: [c0 (oldest), c1, c2, c3 (newest)]
  const past4 = candles.slice(-4);
  const [c0, c1, c2, c3] = past4;

  const netGainPct = c0.close > 0 ? ((c3.close - c0.close) / c0.close) * 100 : 0;
  const higherLows = c3.low >= c1.low && c2.low >= c0.low;
  const higherCloses = c3.close >= c2.close && c2.close >= c1.close;
  const latestAdvancing = c3.close >= c2.close;
  const greenCount = past4.filter((c) => c.isGreen).length;

  // Criteria for trending increasing:
  // 1. Net price gain over the 1-hour window (c3.close > c0.close)
  // 2. Latest candle is advancing (c3.close >= c2.close)
  // 3. Demonstrates upward structure: either higher closes, higher lows, or predominantly green candles (>= 3 of 4)
  const isTrendingUp = netGainPct > 0 && latestAdvancing && (higherCloses || higherLows || greenCount >= 3);

  if (isTrendingUp) {
    return {
      confirmed: true,
      reason: `Past 4 15m candles trending increasing: net +${netGainPct.toFixed(2)}%, ${greenCount}/4 green, latest close ${c3.close} >= prev ${c2.close}`,
      candles: past4,
      netGainPct,
    };
  }

  return {
    confirmed: false,
    reason: `15m candles not trending increasing: net ${netGainPct >= 0 ? "+" : ""}${netGainPct.toFixed(2)}%, ${greenCount}/4 green (c0=${c0.close.toFixed(6)} -> c3=${c3.close.toFixed(6)})`,
    candles: past4,
    netGainPct,
  };
}
