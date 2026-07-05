// Shared cached SOL/USD price for display-layer dual-currency rendering.
//
// Fed opportunistically by tools/wallet.js getWalletBalances() (which runs at
// least every 5 minutes via the balance-history sampler) — so any module can
// cheaply render "◎X ($Y)" without an extra network call. This is a DISPLAY
// convenience: accounting paths must keep using the dual .sol/.usd values that
// come from the Meteora API directly (see closePosition in tools/dlmm.js).
//
// Returns 0 when no price has been observed yet (cold start) — callers must
// degrade to SOL-only rendering in that case, never divide by it.

let _priceUsd = 0;
let _ts = 0;

const STALE_MS = 30 * 60 * 1000; // warn threshold only — a stale price beats none for display

export function setSolPriceUsd(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return;
  _priceUsd = p;
  _ts = Date.now();
}

/** Latest observed SOL/USD price, or 0 if none seen yet. */
export function getSolPriceUsd() {
  return _priceUsd;
}

/** True when the cached price is older than 30 min (or never set). */
export function isSolPriceStale() {
  return !_ts || Date.now() - _ts > STALE_MS;
}
