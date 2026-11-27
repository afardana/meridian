/**
 * Jupiter datapi asset read for the flow guard (flow-guard.js, 2026-11-27).
 *
 * The same keyless endpoint tools/token.js getTokenAudit / getTokenInfo use
 * (`/v1/assets/search?query=<mint>`), read here with a 3 s timeout, a 60 s per-mint cache (several
 * positions in one token share one read per cycle) and in-flight de-duplication. Returns the
 * reading `readFlowAsset` builds: { ok:true, mint, at, liquidity_usd, holders, price_usd, s5m,
 * s1h, … } or { ok:false, reason, at }. Never throws. Only the mint goes into the request.
 */
import { readFlowAsset } from "../flow-guard.js";

const DATAPI_BASE = "https://datapi.jup.ag/v1";
export const FLOW_ASSET_CACHE_MS = 60_000;
const TIMEOUT_MS = 3_000; // ≤ 3 s per fetch (the cycle bounds the whole prefetch at 4 s)

const _cache = new Map(); // mint -> { atMs, reading }
const _inflight = new Map(); // mint -> Promise<reading>

export function clearFlowAssetCache() {
  _cache.clear();
  _inflight.clear();
}

/**
 * @param {string} mint
 * @param {{ fetchImpl?: Function, nowMs?: number, timeoutMs?: number }} [opts]
 */
export async function getTokenFlowAsset(mint, { fetchImpl = fetch, nowMs = Date.now(), timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof mint !== "string" || !mint) return { ok: false, reason: "no mint", at: new Date(nowMs).toISOString() };
  const hit = _cache.get(mint);
  if (hit && nowMs - hit.atMs < FLOW_ASSET_CACHE_MS) return hit.reading;
  if (_inflight.has(mint)) return _inflight.get(mint);
  const p = (async () => {
    const startedMs = Date.now();
    try {
      const res = await fetchImpl(`${DATAPI_BASE}/assets/search?query=${encodeURIComponent(mint)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res || !res.ok) return { ok: false, reason: `Jupiter datapi HTTP ${res?.status ?? "?"}`, at: new Date(startedMs).toISOString(), mint };
      const data = await res.json();
      const reading = readFlowAsset(data, mint, startedMs);
      if (reading.ok) _cache.set(mint, { atMs: startedMs, reading });
      return reading;
    } catch (e) {
      return { ok: false, reason: `Jupiter datapi read failed: ${e?.message || e}`, at: new Date(startedMs).toISOString(), mint };
    } finally {
      _inflight.delete(mint);
    }
  })();
  _inflight.set(mint, p);
  return p;
}
