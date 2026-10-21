// After-close auto-swap: wait for the close's base tokens before selling (2026-10-18).
//
// CLAUDIA-SOL DpCydkE7 (straddled bot position, trailing TP 07:01:01.9 WIB): the close returned
// ~2,724 CLAUDIA to the wallet, but the auto-swap's balance read 1.8 s later (getWalletBalances,
// served by the read-only failover pool with no minimum slot) still showed only the 31.55 tokens
// of stage-C headroom the straddle had left in the wallet. It sold those ($0.26); 2,692.88 tokens
// ($22.25) waited 11 minutes for the dust sweeper — and only because they were under its $25
// ceiling. The close path knows what the position held just before the close, so the swap now
// re-reads the mint on the primary RPC (at or after the close's slot) until the wallet holds
// ≥ 90 % of that, for at most 6 reads 2 s apart, then sells whatever is there. Unknown
// expectation → no wait (the old behaviour).
//
// Amended 2026-10-21 (Pokémon-SOL FSgfg7FK take-profit): a read at or after the close's slot is
// authoritative. The expectation is the position as read ~5 s BEFORE the send; when the price
// moves a bin while the close lands, the position converts base tokens to SOL inside the account
// and the close returns fewer tokens than expected (45.99 vs ≈ 489.23). The wallet cannot hold
// tokens the close has not delivered once the read is at or after the close's slot, so such a
// reading is accepted as final even under the target; the expectation-based polling only
// remains for a read without a known close slot (minContextSlot null) or an unproven one.
//
// Dependencies are injected (readBalance, sleep, log, now) so the logic is testable without RPC.

export const EXIT_SWAP_WAIT_TRIES = 6;
export const EXIT_SWAP_WAIT_INTERVAL_MS = 2000;
export const EXIT_SWAP_WAIT_FRACTION = 0.9;
// Below this expected value (SOL at the pool price) waiting is not worth an exit's time.
const MIN_EXPECTED_VALUE_SOL = 0.0005;

const finite = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** "2,724" for large amounts, "31.55" for ordinary ones, 3 significant digits below 1. */
export function fmtTokens(n) {
  const v = finite(n);
  if (v == null) return "?";
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (v === 0) return "0";
  return Number(v.toPrecision(3)).toString();
}

/**
 * Base tokens a close returns to the wallet (whole tokens), from the position as read just
 * before the close. Pure. Prefers the on-chain position account the close itself read
 * (`totalXAmount` + unclaimed `feeX`, both raw; the transfer-fee-excluded figures when present,
 * since that is what reaches the wallet), else the pre-close scan row (`liq_x_amount` +
 * `fee_x_amount`, already whole tokens). Null when neither is usable.
 */
export function expectedCloseBaseTokens({ positionData = null, decimals = null, cachedRow = null } = {}) {
  const raw = (v) => {
    if (v == null) return null;
    const n = Number(typeof v === "object" && typeof v.toString === "function" ? v.toString() : v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const dec = finite(decimals);
  if (positionData && dec != null && dec >= 0) {
    const liq = raw(positionData.totalXAmountExcludeTransferFee) ?? raw(positionData.totalXAmount);
    const fee = raw(positionData.feeXExcludeTransferFee) ?? raw(positionData.feeX) ?? 0;
    if (liq != null) return { tokens: (liq + fee) / Math.pow(10, dec), source: "position_account" };
  }
  const liq = finite(cachedRow?.liq_x_amount);
  if (liq != null && liq >= 0) {
    return { tokens: liq + Math.max(0, finite(cachedRow?.fee_x_amount) ?? 0), source: "scan_row" };
  }
  return null;
}

/** Whether to wait at all: a positive expectation worth more than dust (when its price is known). */
export function shouldWaitForCloseTokens(expectedTokens, refPriceSol = null) {
  const exp = finite(expectedTokens);
  if (exp == null || !(exp > 0)) return false;
  const px = finite(refPriceSol);
  if (px != null && px > 0 && exp * px < MIN_EXPECTED_VALUE_SOL) return false;
  return true;
}

/**
 * Poll `readBalance(mint, { minContextSlot })` until the wallet holds ≥ fraction × expected, or the
 * tries run out. Returns { balance, caught_up, tries, waited_ms, waited: boolean } — `balance` is the
 * last successful reading (null when none succeeded: the caller then keeps its pooled read).
 * A successful, non-`behind` reading whose `slot` is ≥ `minContextSlot` is final even when it is
 * under the target (`final_at_slot: true`); with no `minContextSlot` the expectation decides.
 */
export async function waitForCloseTokens({
  mint, symbol = null, expectedTokens, minContextSlot = null, expectedSource = null,
  readBalance, sleep, log = () => {}, now = () => Date.now(),
  tries = EXIT_SWAP_WAIT_TRIES, intervalMs = EXIT_SWAP_WAIT_INTERVAL_MS, fraction = EXIT_SWAP_WAIT_FRACTION,
}) {
  const sym = symbol || String(mint || "").slice(0, 8);
  const expected = finite(expectedTokens);
  const target = expected * fraction;
  const minSlot = finite(minContextSlot) != null && Number(minContextSlot) > 0 ? Number(minContextSlot) : null;
  const start = now();
  const secs = () => Math.round((now() - start) / 1000);
  let last = null;
  let waited = false;
  for (let i = 1; i <= tries; i++) {
    let reading = null;
    let note = null;
    try {
      reading = await readBalance(mint, { minContextSlot });
    } catch (e) {
      note = `unreadable (${e?.message || e})`;
    }
    const bal = finite(reading?.balance);
    if (bal != null) last = bal;
    if (bal != null && bal >= target) {
      if (waited) log("executor", `[EXIT_SWAP] ${sym} balance caught up after ${secs()} s: wallet ${fmtTokens(bal)} vs expected ≈ ${fmtTokens(expected)}`);
      return { balance: bal, caught_up: true, final_at_slot: false, tries: i, waited_ms: now() - start, waited };
    }
    const slot = finite(reading?.slot);
    if (bal != null && !reading?.behind && minSlot != null && slot != null && slot >= minSlot) {
      log("executor", `[EXIT_SWAP] ${sym}: close returned ${fmtTokens(bal)} vs ≈ ${fmtTokens(expected)} read before the send (slot ${slot} ≥ close ${minSlot}) — price moved while the close landed; selling what is there`);
      return { balance: bal, caught_up: false, final_at_slot: true, tries: i, waited_ms: now() - start, waited };
    }
    if (note == null) note = reading?.behind ? "RPC behind the close's slot" : `wallet ${fmtTokens(bal)}`;
    const readMin = finite(reading?.min_slot);
    const slotNote = slot != null || readMin != null ? ` [slot ${slot ?? "?"}, min ${readMin ?? "?"}]` : "";
    const srcNote = i === 1 && expectedSource ? ` (expected from ${expectedSource})` : "";
    log("executor", `[EXIT_SWAP] waiting for the close's tokens: ${note} vs expected ≈ ${fmtTokens(expected)} ${sym}${srcNote}${slotNote} (try ${i}/${tries})`);
    waited = true;
    if (i < tries) await sleep(intervalMs);
  }
  log("executor_warn", `[EXIT_SWAP] ${sym} balance did not catch up after ${secs()} s (wallet ${fmtTokens(last)} vs expected ≈ ${fmtTokens(expected)}) — swapping what is there`);
  return { balance: last, caught_up: false, final_at_slot: false, tries, waited_ms: now() - start, waited };
}

/**
 * USD value of the wallet's remainder of `mint` after an exit swap, priced at the swap's own
 * reading (usd ÷ balance of the token it swapped) or else the pool price × SOL price. Pure.
 * Null when the remainder or every price is unknown.
 */
export function remainderUsd({ remainderTokens, swappedToken = null, refPriceSol = null, solPriceUsd = null }) {
  const rem = finite(remainderTokens);
  if (rem == null) return null;
  if (!(rem > 0)) return 0;
  const tb = finite(swappedToken?.balance);
  const tu = finite(swappedToken?.usd);
  if (tb != null && tb > 0 && tu != null && tu > 0) return rem * (tu / tb);
  const px = finite(refPriceSol);
  const sp = finite(solPriceUsd);
  if (px != null && px > 0 && sp != null && sp > 0) return rem * px * sp;
  return null;
}

/** The one-line Telegram text for an exit remainder the dust sweeper will never sell. Pure. */
export function remainderAboveCeilingMessage({ symbol, pair = null, usd, tokens, ceilingUsd, escape = (s) => String(s) }) {
  const who = pair ? `${escape(pair)} — ` : "";
  return `⚠️ <b>Exit remainder left unsold</b> ${who}${escape(symbol)} ${fmtTokens(tokens)} ($${Number(usd).toFixed(2)}) is above the $${Number(ceilingUsd).toFixed(0)} dust-sweeper ceiling, so nothing will sell it automatically — sell it by hand or with swap_token.`;
}
