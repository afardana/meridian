// fee-per-tvl.js — leaf module (no imports).
//
// Meteora's per-position `feePerTvl24h` feeds the low-yield exit (state.js, step 10 of
// updatePnlAndCheckExits). A missing field must not read as a measured 0 % yield: the
// producers used `parseFloat(x || 0)` / `safeNum(x)`, which turned an absent, null or
// empty field into 0 and let the rule close an earning position (2026-11-27,
// Snowball-SOL). The rule already skips null.

/**
 * Parse Meteora's feePerTvl24h into a percent rounded to 2 decimals.
 * absent / null / "" / non-numeric / NaN / ±Infinity → null; a real 0 or "0" stays 0.
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseFeePerTvl24h(raw) {
  let n;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "") return null;
    n = Number(s);
  } else return null;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
