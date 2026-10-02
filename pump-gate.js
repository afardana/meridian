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
const CANDLE_LIMIT = 48;
const _cache = new Map(); // pool -> { at, change, stats }

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

/**
 * Where the price sits inside the pool's last ≤ 24 h, for pools the 24h change cannot
 * describe (2026-10-02 review: 81 of 226 bot deploys had under 24 h of candles; they were
 * the BETTER segment and "pumped since launch" inverted on them, so this is capture-only —
 * no gate reads it). All values are null when unusable.
 *   poolAgeHours     — hours since the first candle; null when the fetch window is full
 *                      (the pool is older than `limit` traded hours)
 *   runupFromLowPct  — price vs the lowest low of the window
 *   offHighPct       — price vs the highest high of the window (≤ 0)
 *   vsFirstOpenPct   — price vs the open of the window's oldest candle (launch open for a young pool)
 */
export function entryRangeStatsFromCandles(candles, nowSec = Math.floor(Date.now() / 1000), limit = CANDLE_LIMIT) {
  const none = { poolAgeHours: null, runupFromLowPct: null, offHighPct: null, vsFirstOpenPct: null };
  if (!Array.isArray(candles) || candles.length === 0) return none;
  const p0 = Number(candles[candles.length - 1]?.close);
  if (!(p0 > 0)) return none;
  const win = candles.filter((c) => Number(c.timestamp) >= nowSec - 24 * 3600);
  if (win.length === 0) return none;
  const lows = win.map((c) => Number(c.low)).filter((v) => v > 0);
  const highs = win.map((c) => Number(c.high)).filter((v) => v > 0);
  const firstOpen = Number(win[0].open);
  const pct = (base) => (base > 0 ? Math.round((p0 / base - 1) * 1000) / 10 : null);
  const firstTs = Number(candles[0].timestamp);
  return {
    poolAgeHours: candles.length < limit && Number.isFinite(firstTs) ? Math.round(((nowSec - firstTs) / 3600) * 10) / 10 : null,
    runupFromLowPct: lows.length ? pct(Math.min(...lows)) : null,
    offHighPct: highs.length ? pct(Math.max(...highs)) : null,
    vsFirstOpenPct: pct(firstOpen),
  };
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
export async function getPoolChange24h(poolAddress, opts = {}) {
  return (await loadPool(poolAddress, opts)).change;
}

/** Cached entry-range stats for a pool (same fetch and cache as the 24h change). */
export async function getPoolEntryStats(poolAddress, opts = {}) {
  return (await loadPool(poolAddress, opts)).stats;
}

async function loadPool(poolAddress, { fetchCandles = fetchPoolCandles, now = Date.now() } = {}) {
  const empty = { change: null, stats: entryRangeStatsFromCandles(null) };
  if (!poolAddress) return empty;
  const hit = _cache.get(poolAddress);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit;
  let entry = { at: now, ...empty };
  try {
    const candles = await fetchCandles(poolAddress, { timeframe: "1h", limit: CANDLE_LIMIT, currency: "token" });
    const nowSec = Math.floor(now / 1000);
    entry = { at: now, change: change24hFromCandles(candles, nowSec), stats: entryRangeStatsFromCandles(candles, nowSec) };
  } catch {
    // fail-open: no reading
  }
  _cache.set(poolAddress, entry);
  if (_cache.size > 500) _cache.delete(_cache.keys().next().value);
  return entry;
}

export function _resetPumpGateCache() {
  _cache.clear();
}
