// pump-gate.js — 24h pump gate (2026-09-29, CALI-SOL follow-up backtest).
//
// Backtest over 194 bot deploys / 31 d (24h change rebuilt from GeckoTerminal hourly
// candles): skipping deploys into FALLING tokens is noise (+0.04 SOL), but tokens that
// had already run ≥ +100 % in the prior 24 h carried 5 of the covered disasters (Token
// +717 %, OTC +546 %, ELON +433 %, YAP +406 %, OP +153 %); skipping them would have
// been +0.65 SOL on 27 deploys (9 winners lost). n is small and the 24h change was
// never captured at deploy, so the gate ships log-only: every admitted candidate gets
// its 24h change, `[PUMP_GATE_SHADOW] would-skip` is logged, and each deploy records
// `entry_price_change_24h_pct` + the verdict so the gate can be graded on live data.
//
// pumpGateMode: off | shadow (default) | enforce. pumpGateMax24hPct: 100.
import { fetchPoolCandles } from "./tools/rebalance-trend.js";

const CACHE_TTL_MS = 10 * 60_000;
const _cache = new Map(); // pool -> { at, change }

/**
 * 24h price change (%) from hourly candles (oldest → newest, timestamps in seconds).
 * Current price = the newest candle's close; base = the close of the last candle that
 * ended at or before now − 24 h (hours without trades have no candle, the price holds).
 * null when the pool has no candle that old (younger than a day) or data is unusable.
 */
export function change24hFromCandles(candles, nowSec = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const cutoff = nowSec - 24 * 3600;
  let base = null;
  for (const c of candles) {
    if (Number(c.timestamp) + 3600 <= cutoff) base = c;
    else break;
  }
  const last = candles[candles.length - 1];
  const p0 = Number(base?.close);
  const p1 = Number(last?.close);
  if (!base || !(p0 > 0) || !(p1 > 0)) return null;
  return (p1 / p0 - 1) * 100;
}

/** Gate verdict for one 24h change. Unknown change never skips. */
export function evaluatePumpGate(change24hPct, cfg = {}) {
  const max = Number(cfg.pumpGateMax24hPct ?? 100);
  const known = change24hPct != null && Number.isFinite(Number(change24hPct));
  const wouldSkip = known && Number.isFinite(max) && Number(change24hPct) >= max;
  return {
    change24hPct: known ? Number(change24hPct) : null,
    wouldSkip,
    reason: wouldSkip ? `24h price change +${Number(change24hPct).toFixed(0)}% ≥ +${max}% (pumped token)` : null,
  };
}

/**
 * Cached 24h change for a pool (SOL-quoted hourly candles). Fail-open: any fetch
 * error → null. `fetchCandles` is injectable for tests.
 */
export async function getPoolChange24h(poolAddress, { fetchCandles = fetchPoolCandles, now = Date.now() } = {}) {
  if (!poolAddress) return null;
  const hit = _cache.get(poolAddress);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.change;
  let change = null;
  try {
    const candles = await fetchCandles(poolAddress, { timeframe: "1h", limit: 48, currency: "token" });
    change = change24hFromCandles(candles, Math.floor(now / 1000));
  } catch {
    change = null;
  }
  _cache.set(poolAddress, { at: now, change });
  if (_cache.size > 500) _cache.delete(_cache.keys().next().value);
  return change;
}

export function _resetPumpGateCache() {
  _cache.clear();
}
