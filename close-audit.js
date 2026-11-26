// close-audit.js — does a closed position's booked result match what the wallet actually got?
//
// 2026-10-04: four accounting errors (fees double-counted after a straddle, dollars booked in
// SOL fields, a hand "correction" that included claimed fees, a briefing sum) were found only
// because the operator questioned a number. The check that settled each one was the same:
// add up the wallet's SOL and base-token changes over every transaction of the position
// account, plus the wallet's swaps of that token while the position lived. This runs that
// check after every close and stores the verdict on the record. Read-only on chain.
//
// On-chain net = Σ wallet SOL deltas (fees and rent included). It is compared with the record's
// modelled pnl_sol_net (pnl − gas − exit slippage; since 2026-11-25 also the exit swap's gas and a
// measured entry premium — modelled-net.js). They differ by things the record does not model
// (slippage on mid-life fee swaps, a straddle's buy impact, price drift between the close and
// the exit swap, bin-array rent), so the tolerance is max(◎0.01, 1.5 % of the capital).
//
// 2026-10-07 (v6): the Meteora UI builds a two-sided position with a four-transaction bundle in
// one slot — RebalanceLiquidity withdraws the SOL as wSOL, a wSOL account is created, a Jupiter
// Route swaps wSOL for the base token, ZapInDlmmForInitializedPosition deposits both and closes
// the wSOL account. The swap's native SOL change is only its 5,000-lamport fee, so every flow is
// now measured in SOL-equivalent (native + the lamports of the wallet's own wSOL accounts), a
// purchase whose tokens this position deposits within 60 s is a position flow, and what makes a
// close unattributable is ANOTHER position in the same token overlapping this one.
// v7: in the tail after the last position transaction, counting stops where a later position
// in the same token begins (its zap purchase and wSOL legs were being counted here).
// v8: rent still sitting in the wallet's own token account of the mint when the window ends is
// a recoverable deposit, not a result; and a few tokens left with no swap to price them are
// dust when the record and the wallet agree without them (never-filled ladders got no verdict).
// v9: the mirror of v8's rent rule — rent RELEASED from the wallet's token account of the mint
// (an account an earlier position opened, closed in this window) is that position's deposit
// coming back, not a result. Across an opener/closer pair the audits summed ◎0.001514 above
// the wallet (baton J4oFb2LY → 4b98tgF6: Σ wallet 0.027681 vs Σ audits 0.029195).
// v10 (2026-11-25): the same rule for the wallet's token accounts of OTHER mints. A Jupiter exit
// swap (or a straddle buy) routed through an intermediate token (USDC, USDT, cbBTC, JUP, NVDAx …)
// opens a wallet token account for that mint (◎0.00149–0.00156 of rent) and leaves it open; the
// refund arrives when the sweeper closes it, in a transaction that does not touch this position's
// mint and so is never counted. 30-day study (docs/research/2026-11-25-wallet-vs-modelled-gap.md):
// 29 such accounts on 18 bot closes, ◎0.044 charged to the positions, all 29 since closed with the
// rent back. That rent is set aside like v8's (route_account_rent_sol).

import { fmtWib } from "./wib-time.js";

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// Bump when the audit's method changes: records audited by an older version are re-queued.
export const CLOSE_AUDIT_VERSION = 10;

const WSOL_MINT = "So11111111111111111111111111111111111111112";
// A purchase is this position's own when it deposits >= this share of the tokens within the window.
const BUY_MATCH_MIN_SHARE = 0.9;
const BUY_MATCH_WINDOW_SEC = 60;
// A "swap" that moved less SOL than this is not a price (fees only).
const MIN_SWAP_SOL = 1e-4;

/**
 * Is this a liquidity-position operation (deploy / add / remove / claim / rebalance / close)?
 * Read from the instruction log, NOT from "does it invoke the DLMM program": a Jupiter swap
 * routed through the pool invokes the same program, and skipping it dropped the exit swap
 * (CRAWL Dn5ux1Aq: ok → "tokens do not net out" under the first version of this filter).
 */
const POSITION_OP = /Instruction: (InitializePosition|AddLiquidity|RemoveLiquidity|RemoveAllLiquidity|ClaimFee|ClaimReward|RebalanceLiquidity|ClosePosition)/;
export function isPositionOperation(tx) {
  return (tx?.meta?.logMessages || []).some((l) => typeof l === "string" && POSITION_OP.test(l));
}

/**
 * Wallet deltas of one parsed transaction (as returned by getParsedTransaction).
 * dSol is the native change; dWsolSol the lamports that moved in/out of the wallet's own wSOL
 * token accounts (wrapped amount + rent); dSolEq = dSol + dWsolSol is what the wallet's SOL
 * really did (a withdrawal paid out as wSOL is SOL received; a swap that spends wSOL is SOL
 * paid). Over a bundle that opens and closes its wSOL account the wSOL legs cancel, so the
 * total equals the native total — nothing is counted twice.
 * `otherAccounts` (v10): lamport change of each of the wallet's own token accounts of a mint that
 * is neither the base mint nor wSOL, by account address — the rent a routed swap parks in an
 * intermediate-token account it opens (+) or gets back when one is closed (−).
 * @returns {{ dSol:number, dTok:number, touchesMint:boolean, dMintAccountsSol:number|null, dWsolSol:number, dSolEq:number, otherAccounts:Map<string,number> }|null} null for a failed/missing tx
 */
export function walletDeltas(tx, wallet, baseMint) {
  if (!tx || tx.meta?.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (k?.pubkey ?? k)?.toString?.() ?? String(k));
  const i = keys.indexOf(wallet);
  const dSol = i >= 0 ? ((tx.meta.postBalances?.[i] ?? 0) - (tx.meta.preBalances?.[i] ?? 0)) / 1e9 : 0;
  let dTok = 0, touchesMint = false;
  for (const b of tx.meta.postTokenBalances || []) {
    if (b.owner === wallet && b.mint === baseMint) { dTok += Number(b.uiTokenAmount?.uiAmountString ?? 0) || 0; touchesMint = true; }
  }
  for (const b of tx.meta.preTokenBalances || []) {
    if (b.owner === wallet && b.mint === baseMint) { dTok -= Number(b.uiTokenAmount?.uiAmountString ?? 0) || 0; touchesMint = true; }
  }
  // Lamports that moved in/out of the wallet's OWN token accounts of this mint (rent paid
  // when one is created, returned when one is closed) — see summarizeFlows.
  const idx = new Set();
  for (const b of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
    if (b.owner === wallet && b.mint === baseMint && Number.isInteger(b.accountIndex)) idx.add(b.accountIndex);
  }
  let dAcct = 0;
  for (const k of idx) dAcct += ((tx.meta.postBalances?.[k] ?? 0) - (tx.meta.preBalances?.[k] ?? 0)) / 1e9;
  // The wallet's own wSOL token accounts: their lamports are SOL the wallet still holds.
  const wIdx = new Set();
  if (baseMint !== WSOL_MINT) {
    for (const b of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
      if (b.owner === wallet && b.mint === WSOL_MINT && Number.isInteger(b.accountIndex) && b.accountIndex !== i) wIdx.add(b.accountIndex);
    }
  }
  let dWsol = 0;
  for (const k of wIdx) dWsol += ((tx.meta.postBalances?.[k] ?? 0) - (tx.meta.preBalances?.[k] ?? 0)) / 1e9;
  // The wallet's own token accounts of every OTHER mint (route / intermediate tokens).
  const oIdx = new Set();
  for (const b of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
    if (b.owner === wallet && b.mint !== baseMint && b.mint !== WSOL_MINT && Number.isInteger(b.accountIndex) && b.accountIndex !== i) oIdx.add(b.accountIndex);
  }
  const otherAccounts = new Map();
  for (const k of oIdx) {
    const lam = (tx.meta.postBalances?.[k] ?? 0) - (tx.meta.preBalances?.[k] ?? 0);
    if (lam !== 0) otherAccounts.set(keys[k] ?? `#${k}`, lam / 1e9);
  }
  return { dSol, dTok, touchesMint, dMintAccountsSol: idx.size ? dAcct : null, dWsolSol: dWsol, dSolEq: dSol + dWsol, otherAccounts };
}

/**
 * What a confirmed swap actually delivered to the wallet, from its parsed transaction. Pure.
 * Jupiter's /execute `outputAmountResult` is reported before Jupiter's own fee is taken from a SOL
 * output: on every sampled exit swap the wallet received exactly 0.100 % less (2026-11-25 study,
 * 37 / 37 swaps; 8sLU39cp recorded ◎0.344001, landed ◎0.343657).
 *   SOL out   lamports: the wallet's native change + its own wSOL accounts, plus the transaction
 *             fee when the wallet paid it (the swap's gas is booked apart, as `gas_sol`), plus the
 *             rent the transaction moved into (or out of) the wallet's other token accounts — a
 *             route account it opened, the input token's account if closed — which is a deposit
 *             that comes back, not swap output
 *   token out raw units: the change of the wallet's own token accounts of `outputMint`
 * @returns {{ amount_raw:number, fee_lamports:number|null, fee_paid_by_wallet:boolean, route_rent_lamports:number }|null}
 *   null when the transaction is missing, failed, or the wallet is not in it
 */
export function swapLandedOutput(tx, wallet, outputMint) {
  if (!tx || tx.meta?.err) return null;
  const m = tx.meta || {};
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (k?.pubkey ?? k)?.toString?.() ?? String(k));
  const i = keys.indexOf(wallet);
  if (i < 0) return null;
  const lam = (k) => (Number(m.postBalances?.[k]) || 0) - (Number(m.preBalances?.[k]) || 0);
  const own = [...(m.preTokenBalances || []), ...(m.postTokenBalances || [])].filter((b) => b?.owner === wallet && Number.isInteger(b.accountIndex) && b.accountIndex !== i);
  const fee = Number.isFinite(Number(m.fee)) ? Number(m.fee) : null;
  const payer = keys[0] === wallet;
  if (normalizeSolMint(outputMint) === WSOL_MINT) {
    const wsol = new Set(own.filter((b) => b.mint === WSOL_MINT).map((b) => b.accountIndex));
    const other = new Set(own.filter((b) => b.mint !== WSOL_MINT).map((b) => b.accountIndex));
    let out = lam(i);
    for (const k of wsol) out += lam(k);
    let rent = 0;
    for (const k of other) rent += lam(k);
    out += rent + (payer && fee != null ? fee : 0);
    return { amount_raw: out, fee_lamports: fee, fee_paid_by_wallet: payer, route_rent_lamports: rent };
  }
  const raw = (l) => (l || []).filter((b) => b?.owner === wallet && b.mint === outputMint)
    .reduce((s, b) => s + BigInt(String(b.uiTokenAmount?.amount ?? "0").replace(/\D/g, "") || "0"), 0n);
  return { amount_raw: Number(raw(m.postTokenBalances) - raw(m.preTokenBalances)), fee_lamports: fee, fee_paid_by_wallet: payer, route_rent_lamports: 0 };
}

const normalizeSolMint = (m) => (m === "SOL" || m === "native" ? WSOL_MINT : m);

/** Is this mint SOL (wrapped SOL, or the "SOL" / "native" aliases)? Pure. */
export function isSolMint(m) {
  return typeof m === "string" && normalizeSolMint(m) === WSOL_MINT;
}

export const NOT_SOL_QUOTED_WHY = "pool is not SOL-quoted";

/**
 * Is the record's pool NOT SOL-quoted (2026-11-26)? The bot deploys only into X-SOL pools, but
 * it adopts, manages and closes operator positions in any pool, and the audit's model — "the
 * wallet's SOL net plus the base token netting to zero" — does not hold when the other leg is
 * not SOL. SOL-HYPE Hm6oyHv3 (2026-11-25): token X = wSOL, so the record's base_mint is wSOL,
 * the HYPE leg was never looked at and the wallet "net" read −◎0.664 against a booked
 * +◎0.0008 → a false MISMATCH alert.
 * Decided from the record alone and failing SAFE toward auditing as before:
 *   - base_mint is SOL (SOL is token X: SOL-USDC, SOL-HYPE), or
 *   - asset_profile.token_x_mint is SOL, or
 *   - a known quote mint (asset_profile.token_y_mint, quote_mint) that is not SOL.
 * A record with no quote information and a non-SOL base mint is audited as before (522 of the
 * 1,482 records of 2026-11-26 carry no asset_profile; all are SOL-quoted bot deploys).
 * Returns NOT_SOL_QUOTED_WHY or null. Pure.
 */
export function nonSolQuotedReason(record) {
  if (!record) return null;
  const ap = record.asset_profile || {};
  if (isSolMint(record.base_mint) || isSolMint(ap.token_x_mint)) return NOT_SOL_QUOTED_WHY;
  for (const q of [ap.token_y_mint, record.quote_mint]) {
    if (typeof q === "string" && q && !isSolMint(q)) return NOT_SOL_QUOTED_WHY;
  }
  return null;
}

/**
 * A non-SOL-quoted record whose stored verdict is not yet the non-verdict (audited before
 * 2026-11-26, e.g. SOL-HYPE's stored v10 `mismatch`). The queues take it once more whatever its
 * version — restamping costs no chain read. Pure.
 */
export function needsNonSolQuotedRestamp(record) {
  return !!record?.chain_audit?.status && record.chain_audit.non_sol_quoted !== true && nonSolQuotedReason(record) != null;
}

/** The non-verdict a non-SOL-quoted record gets: no retry, no alert, nothing applied. */
export function nonSolQuotedVerdict() {
  return { status: "incomplete", why: NOT_SOL_QUOTED_WHY, non_sol_quoted: true };
}

const txOrder = (a, b) => ((Number(a?.slot) || 0) - (Number(b?.slot) || 0)) || ((Number(a?.blockTime) || 0) - (Number(b?.blockTime) || 0));

/** Σ of the per-account nets with the given sign (1: put in, −1: taken out), as a positive number. */
function routeRentOf(routeNet, sign) {
  let s = 0;
  for (const v of routeNet.values()) if (sign * v > 1e-9) s += sign * v;
  return s > 1e-7 ? Math.round(s * 1e9) / 1e9 : 0;
}

/**
 * Sum the flows. `posTxs` are the position account's transactions, `walletTxs` the wallet's
 * other transactions in the position's lifetime; a wallet transaction counts only when it
 * touches the wallet's account of the base token (a swap of it, or closing that account).
 * Both lists are processed in chain order whatever order they arrive in.
 */
export function summarizeFlows({ posTxs = [], walletTxs = [], wallet, baseMint }) {
  let netSol = 0, netTok = 0, counted = 0, unreadable = 0, lastSwapPrice = null;
  let walletBought = 0, matchedBought = 0, siblingOps = 0, acctLamports = 0;
  // v10: net lamports the counted transactions moved into each of the wallet's token accounts of
  // other mints (route accounts), by address. Only transactions counted IN FULL add here — an
  // account-only transaction is counted as this mint's account alone, so its other accounts
  // never reached the sum in the first place.
  const routeNet = new Map();
  const addRoute = (d) => { for (const [k, v] of d.otherAccounts || []) routeNet.set(k, (routeNet.get(k) ?? 0) + v); };
  // This position's own token deposits (wallet → position), each usable once for matching.
  const deposits = [];
  for (const tx of [...posTxs].sort(txOrder)) {
    const d = walletDeltas(tx, wallet, baseMint);
    if (!d) { unreadable++; continue; }
    netSol += d.dSolEq; netTok += d.dTok; counted++;
    acctLamports += d.dMintAccountsSol ?? 0;
    addRoute(d);
    if (d.dTok < 0) deposits.push({ t: Number(tx?.blockTime) || 0, slot: Number(tx?.slot) || 0, left: -d.dTok });
  }
  const posTimes = posTxs.map((tx) => Number(tx?.blockTime) || 0).filter((t) => t > 0);
  const firstPosTime = posTimes.length ? Math.min(...posTimes) : null;
  const lastPosTime = posTimes.length ? Math.max(...posTimes) : null;
  // The tail (after this position's last transaction) exists for the exit swap, a deferred or
  // dust sale of the remainder, and the token account's close. Once ANOTHER position in the
  // same token starts moving the token there, nothing from that point on is attributable, so
  // counting stops at its first sign: a position operation that moves the token or wSOL, a
  // token purchase (never this position's after its last transaction: an unwind is a sale and
  // a straddle buys before its stage C), or a wSOL account being opened for a zap. The whole
  // slot of that sign is dropped (a zap bundle is one slot, in no particular order here).
  // TWEETCRAFT-SOL Ebt68po9 2026-10-07: the operator's next position zapped in 119 s after the
  // close; its purchase (−◎0.476759, +27,113.66 tokens) was counted here and the straddle
  // exemption hid that it was foreign. A SOL-only redeploy moves no token and cuts nothing.
  const lastPosSlot = posTxs.reduce((m, tx) => Math.max(m, Number(tx?.slot) || 0), 0);
  const inTail = (tx) => {
    const slot = Number(tx?.slot) || 0, t = Number(tx?.blockTime) || 0;
    return lastPosTime != null && (slot && lastPosSlot ? slot > lastPosSlot : t > lastPosTime);
  };
  let cut = null;
  for (const tx of [...walletTxs].sort(txOrder)) {
    if (!inTail(tx)) continue;
    const d = walletDeltas(tx, wallet, baseMint);
    if (!d || !d.touchesMint) continue;
    const foreign = isPositionOperation(tx) ? (d.dTok !== 0 || d.dWsolSol !== 0) : (d.dTok > 0 || (d.dTok === 0 && d.dWsolSol > 0));
    if (foreign) { cut = { slot: Number(tx?.slot) || 0, t: Number(tx?.blockTime) || 0 }; break; }
  }
  const pastCut = (tx) => {
    if (!cut || !inTail(tx)) return false;
    const slot = Number(tx?.slot) || 0;
    return cut.slot && slot ? slot >= cut.slot : (Number(tx?.blockTime) || 0) >= cut.t;
  };
  let tailExcluded = 0;
  for (const tx of [...walletTxs].sort(txOrder)) {
    const d = walletDeltas(tx, wallet, baseMint);
    if (!d || !d.touchesMint) continue;
    if (pastCut(tx)) { tailExcluded++; continue; }
    // Every position operation of THIS position is already in posTxs. One on the wallet side
    // belongs to another position — typically the bot redeploying into the same pool minutes
    // after the close, whose deposit lists the wallet's (empty) token account and was counted
    // as a ◎0.4–1.0 outflow (four false mismatches on the first live pass).
    if (isPositionOperation(tx)) {
      // …but when it MOVES this token while this position is alive (a sibling's claim, close
      // or zap deposit), the wallet's swaps of the token can no longer be told apart: the
      // sibling's fee and exit swaps are in the same list as this position's (DUST-SOL 9Zy1Fn,
      // HIGGS-SOL 4eXkXhyo).
      const t = Number(tx?.blockTime) || 0;
      if (d.dTok !== 0 && firstPosTime != null && t >= firstPosTime && t <= lastPosTime) siblingOps++;
      continue;
    }
    // No token of this mint moved: the transaction only opened or closed the wallet's token
    // account (rent). The empty-account sweep closes SEVERAL mints' accounts in one
    // transaction, and counting the wallet's whole SOL change credited all of their rent to
    // this position (Ash-SOL 2026-10-05: one sweep +◎0.0133, of which ◎0.0020 was this mint's
    // — four closes that evening read ≈ ◎0.011 above their records). Count this mint's
    // account only: what left the account is what the wallet got back.
    // Exception: the transaction that OPENS a wSOL account for a zap (lamports into the
    // wallet's wSOL account). Its rent comes back in the zap transaction, which is counted in
    // full, so the opening has to be counted in full too or the refund reads as income.
    const acctOnly = d.dTok === 0 && d.dMintAccountsSol != null && !(d.dWsolSol > 0);
    const sol = acctOnly ? -d.dMintAccountsSol : d.dSolEq;
    netSol += sol; netTok += d.dTok; counted++;
    acctLamports += d.dMintAccountsSol ?? 0;
    if (!acctOnly) addRoute(d);
    if (d.dTok > 0) {
      // A purchase. It is this position's own when the position deposits the tokens right
      // after it (the UI zap: same slot; a straddle's stage C: seconds later).
      const t = Number(tx?.blockTime) || 0, slot = Number(tx?.slot) || 0;
      const usable = deposits.filter((dep) => dep.left > 0 && dep.t >= t && dep.t - t <= BUY_MATCH_WINDOW_SEC && (!slot || !dep.slot || dep.slot >= slot));
      const available = usable.reduce((sum, dep) => sum + dep.left, 0);
      if (available >= BUY_MATCH_MIN_SHARE * d.dTok) {
        let need = d.dTok;
        for (const dep of usable) { const take = Math.min(dep.left, need); dep.left -= take; need -= take; if (need <= 0) break; }
        matchedBought += d.dTok;
      } else {
        walletBought += d.dTok;
      }
    }
    // Price of the last real swap, for valuing a token remainder. A swap that moved almost no
    // SOL is not a price (before v6 the zap's wSOL swap read as fee ÷ tokens ≈ 4e-11, and with
    // the list newest-first that was the price used: DUST's 432,913-token remainder was valued
    // at ◎0.00002 and passed as a mismatch).
    if (Math.abs(d.dTok) > 0 && Math.abs(d.dSolEq) >= MIN_SWAP_SOL && Math.sign(d.dTok) !== Math.sign(d.dSolEq)) lastSwapPrice = Math.abs(d.dSolEq / d.dTok);
  }
  return {
    net_sol: netSol, net_tokens: netTok, tx_count: counted, unreadable, last_swap_sol_per_token: lastSwapPrice,
    first_position_tx_time: firstPosTime, last_position_tx_time: lastPosTime,
    wallet_bought_tokens: walletBought, matched_bought_tokens: matchedBought, sibling_position_ops: siblingOps,
    // Lamports the counted transactions left in the wallet's own token account(s) of the mint:
    // the account was opened by this position (the deploy creates it) and is still open when
    // the window ends — a few fee tokens from the close sit in it, too little to sell. The rent
    // comes back when the account is closed (AUTON GzuXX2i4: 1 h 52 min later, by the next
    // position's close), so it is a deposit, not a loss. 0 when opened and closed in the window
    // or when the account was there before (a release of older rent: released_account_rent_sol).
    open_account_rent_sol: acctLamports > 1e-7 ? acctLamports : 0,
    // The mirror (v9): lamports the counted transactions took OUT of the wallet's own token
    // account(s) of the mint, net of what they put in. The account was there before this
    // window (an earlier position opened it and had its rent set aside) and was closed in it,
    // so the rent is that deposit coming back. Netted over the window: open → close is 0,
    // close → reopen is 0, close → reopen → close is one release.
    released_account_rent_sol: acctLamports < -1e-7 ? -acctLamports : 0,
    // v10: rent the counted transactions left in the wallet's token accounts of OTHER mints that
    // they opened (Jupiter route accounts): Σ over accounts of the positive net. An account opened
    // and closed by counted transactions nets 0; one opened twice with an uncounted close in
    // between (the sweeper) is charged twice by the counted flows and set aside twice.
    route_account_rent_sol: routeRentOf(routeNet, 1),
    // …and the mirror, NOT applied: rent a counted transaction took back from such an account that
    // was open before. Not seen in the 2026-11-25 study (route accounts are closed by the sweeper's
    // one-account transactions or by a third-party batch close, neither of which touches this
    // mint); kept so a case would show on the verdict.
    route_account_released_sol: routeRentOf(routeNet, -1),
    // set when another position's activity in the tail ended the count early
    tail_cutoff_time: cut ? cut.t : null, tail_excluded: tailExcluded,
  };
}

export function auditTolerance(capitalSol) {
  return Math.max(0.01, 0.015 * (num(capitalSol) ?? 0));
}

/**
 * Verdict for one record. status:
 *   ok          — booked net result within tolerance of the wallet's
 *   mismatch    — outside tolerance (alert)
 *   incomplete  — the flows cannot be attributed to this position alone (another position in
 *                 the same token overlapped it, or the wallet acquired the token without
 *                 depositing it here), tokens do not net out (a remainder is still held, or
 *                 tokens were brought or taken), or a position transaction could not be read
 *   no_data     — nothing to compare
 */
export function evaluateCloseAudit(record, flows) {
  // A pool that is not SOL-quoted: the flows model does not apply (see nonSolQuotedReason).
  if (nonSolQuotedReason(record)) return nonSolQuotedVerdict();
  // Compare against the modelled figure: once applied, pnl_sol_net IS the wallet figure.
  const booked = num(record?.pnl_sol_net_modelled) ?? num(record?.pnl_sol_net) ?? num(record?.pnl_sol);
  const capital = num(record?.deposit_sol_true) ?? num(record?.amount_sol);
  if (booked == null || !flows || !(flows.tx_count > 0)) return { status: "no_data" };
  const tol = auditTolerance(capital);
  const residualTok = num(flows.net_tokens) ?? 0;
  const px = num(flows.last_swap_sol_per_token);
  const residualSol = px != null ? Math.abs(residualTok) * px : null;
  // Rent parked in the wallet's still-open token account of this mint is not part of the result.
  const openRent = Math.max(0, num(flows.open_account_rent_sol) ?? 0);
  // …and rent released from an account that was open before the window is not income (v9).
  const releasedRent = Math.max(0, num(flows.released_account_rent_sol) ?? 0);
  // …and rent parked in route-token accounts the counted swaps opened is not a cost (v10).
  const routeRent = Math.max(0, num(flows.route_account_rent_sol) ?? 0);
  const routeReleased = Math.max(0, num(flows.route_account_released_sol) ?? 0);
  const netSol = flows.net_sol + openRent - releasedRent + routeRent;
  const base = {
    net_sol: Math.round(netSol * 1e6) / 1e6, booked_sol: Math.round(booked * 1e6) / 1e6,
    diff_sol: Math.round((booked - netSol) * 1e6) / 1e6, tolerance_sol: Math.round(tol * 1e6) / 1e6,
    tx_count: flows.tx_count, residual_tokens: Math.round(residualTok * 1e6) / 1e6,
    ...(openRent > 0 ? { open_account_rent_sol: Math.round(openRent * 1e6) / 1e6 } : {}),
    ...(releasedRent > 0 ? { released_account_rent_sol: Math.round(releasedRent * 1e6) / 1e6 } : {}),
    ...(routeRent > 0 ? { route_account_rent_sol: Math.round(routeRent * 1e6) / 1e6 } : {}),
    // diagnostic only — not in net_sol (see summarizeFlows)
    ...(routeReleased > 0 ? { route_account_released_sol: Math.round(routeReleased * 1e6) / 1e6 } : {}),
  };
  if (flows.wallet_history_complete === false) return { status: "incomplete", why: "wallet history not read back to the position's first transaction (long-lived position)", ...base };
  if (flows.unreadable > 0) return { status: "incomplete", retry: true, why: `${flows.unreadable} position transaction(s) unreadable`, ...base };
  // The closing transaction must be among those seen: a rate-limited signature listing can
  // come back short, and then the proceeds are simply missing (three false "mismatches" of
  // −0.28…−0.99 SOL in the first dry run).
  const closedAt = new Date(record?.recorded_at || 0).getTime() / 1000;
  const lastSeen = num(flows.last_position_tx_time);
  if (Number.isFinite(closedAt) && closedAt > 0 && (lastSeen == null || closedAt - lastSeen > 300)) {
    return { status: "incomplete", retry: true, why: "the closing transaction was not among those read", ...base };
  }
  // Another position in the same token moved tokens while this one was alive. The wallet's
  // swaps of the token (fee swaps, exit swaps, zap buys) then belong to both and cannot be
  // split. DUST-SOL 9Zy1Fn: four sibling positions over 2.6 days turned a real ≈ −◎1.89 into
  // a wallet "net" of −◎0.56. No verdict, no alert, nothing applied.
  if (num(flows.sibling_position_ops) > 0) {
    return { status: "incomplete", why: "another position in this token overlapped", ...base };
  }
  // The wallet acquired this token and this position did not deposit it within 60 s. What it
  // was for is not known from the flows (a hand trade, a transfer in, a purchase for something
  // else), so they cannot be attributed. A straddle's buy is the position's own even when it
  // was unwound instead of deposited. (A UI zap's purchase is deposited in the same slot and
  // never reaches here.)
  const straddled = Number(record?.straddle_count) > 0 || record?.lane === "straddle";
  if (num(flows.wallet_bought_tokens) > 0 && !straddled) {
    return { status: "incomplete", why: "the wallet acquired this token without depositing it into this position", ...base };
  }
  // Tokens still in the wallet and no swap in the window to price them. The record counts
  // them at the pool price and the wallet figure does not, so the difference between the two
  // IS their value (plus everything else the tolerance exists for). When that difference is
  // dust-sized the remainder is dust: a never-filled SOL ladder hands back a few fee tokens at
  // the close (0.98 baton, 19.19 swordcat, 26.31 BORDR, 58.19 HIGGS) that are never sold. A
  // real unsold remainder makes the difference as large as the remainder and stays incomplete.
  const dustFloor = Math.max(0.0005, 0.001 * (capital ?? 0));
  const unpricedDust = residualSol == null && residualTok > 1e-6 && Math.abs(booked - netSol) <= dustFloor;
  if (unpricedDust) return { status: "ok", dust_residual: true, residual_sol: Math.round(Math.abs(booked - netSol) * 1e6) / 1e6, ...base };
  const residualMatters = Math.abs(residualTok) > 1e-6 && (residualSol == null || residualSol > Math.max(0.002, 0.005 * (capital ?? 0)));
  // Another position took over the token before this one's remainder was sold: whatever
  // happened to the remainder afterwards is mixed with the new position's flows.
  if (residualMatters && flows.tail_cutoff_time != null) {
    return { status: "incomplete", why: "another position in this token started before this one's remainder was sold", residual_sol: residualSol != null ? Math.round(residualSol * 1e6) / 1e6 : null, ...base };
  }
  if (residualMatters) return { status: "incomplete", why: "token flows do not net to zero", residual_sol: residualSol != null ? Math.round(residualSol * 1e6) / 1e6 : null, ...base };
  return { status: Math.abs(base.diff_sol) <= tol ? "ok" : "mismatch", ...base };
}

/**
 * Fetch the transactions for one closed position. `rpc(fn)` runs fn(connection) on the read pool.
 * The wallet side is limited to [first position tx, last position tx + tailSec].
 */
export async function fetchCloseFlows({ rpc, PublicKey, wallet, positionAddress, baseMint, tailSec = 180, maxWalletPages = 4 }) {
  const posSigs = (await rpc((c) => c.getSignaturesForAddress(new PublicKey(positionAddress), { limit: 300 }))).reverse();
  if (!posSigs.length) return null;
  const t0 = posSigs[0].blockTime, t1 = posSigs[posSigs.length - 1].blockTime + tailSec;
  const inPos = new Set(posSigs.map((s) => s.signature));
  const walletSigs = [];
  let before;
  let reachedStart = false;
  for (let page = 0; page < maxWalletPages; page++) {
    const batch = await rpc((c) => c.getSignaturesForAddress(new PublicKey(wallet), { limit: 1000, before }));
    if (!batch.length) { reachedStart = true; break; }
    for (const s of batch) if (!s.err && s.blockTime >= t0 && s.blockTime <= t1 && !inPos.has(s.signature)) walletSigs.push(s);
    before = batch[batch.length - 1].signature;
    if (batch[batch.length - 1].blockTime < t0) { reachedStart = true; break; }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = async (sig) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tx = await rpc((c) => c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }));
        if (tx) return tx;
      } catch (e) {
        // an unsupported transaction version never parses: unrelated wallet traffic
        if (/version/i.test(String(e?.message))) return undefined;
      }
      await sleep(400 * (attempt + 1));
    }
    return undefined; // counted as unreadable for the position
  };
  const posTxs = [];
  for (const s of posSigs) {
    if (s.err) { posTxs.push(null); continue; }
    const tx = await get(s.signature);
    posTxs.push(tx ? { ...tx, blockTime: tx.blockTime ?? s.blockTime, slot: tx.slot ?? s.slot } : { meta: { err: "unreadable" } });
    await sleep(120);
  }
  const walletTxs = [];
  for (const s of walletSigs) { const tx = await get(s.signature); if (tx) walletTxs.push({ ...tx, blockTime: tx.blockTime ?? s.blockTime, slot: tx.slot ?? s.slot }); await sleep(120); }
  // failed position transactions change nothing on chain: drop them rather than count as unreadable
  const flows = summarizeFlows({ posTxs: posTxs.filter((t) => t !== null), walletTxs, wallet, baseMint });
  // A long-lived position: the wallet's history back to its first transaction did not fit in
  // the pages read, so its fee swaps are only partly counted — no verdict.
  flows.wallet_history_complete = reachedStart;
  return flows;
}

/**
 * A re-audit (version bump, retry) that reproduces the stored verdict to the figure: the
 * operator has already been told, so the Telegram alert is not sent again.
 */
export function isRepeatVerdict(prev, verdict) {
  if (!prev || !verdict || prev.status !== verdict.status) return false;
  const same = (k) => num(prev[k]) != null && num(prev[k]) === num(verdict[k]);
  return same("net_sol") && same("booked_sol");
}

/** `closeAuditReauditSince`: an ISO timestamp, or null (unset / unparseable). Pure. */
export function normalizeReauditSince(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Backfill re-audit (closeAuditReauditSince): what to do with one result. Pure.
 *   keep   — the wallet history could not be read back (or nothing to compare): the stored
 *            verdict stays, the record is not looked at again at this version
 *   retry  — a transient short read; try again next cycle (at most 3 times, then keep)
 *   store  — a real verdict replaces the stored one (no per-record Telegram alert)
 */
export function backfillOutcome(flows, verdict, attempts = 1) {
  // decided without a chain read: the non-verdict replaces the stored one at the current version
  if (verdict?.non_sol_quoted === true) return "store";
  if (!flows || flows.wallet_history_complete === false || !verdict || verdict.status === "no_data") return "keep";
  if (verdict.retry === true) return attempts >= 3 ? "keep" : "retry";
  return "store";
}

/**
 * One management cycle of audits. Pure. Fresh closes (`freshQueue`: never audited, or the last
 * 24 h after a version bump) come first and the backfill only gets what is left of the
 * cycle's budget, so it cannot starve them. `pickBackfill(limit, exclude)` is only called
 * while a backfill is set, not latched (`doneKey`) and there is room; when it returns nothing
 * the backfill is `complete` — the caller logs once and latches `backfillKey`.
 */
export function planCloseAuditCycle({ freshQueue = [], since = null, version, doneKey = null, perCycle = 2, pickBackfill = () => [] } = {}) {
  const fresh = freshQueue.slice(0, perCycle);
  const backfillKey = since ? `${since}|${version}` : null;
  const items = fresh.map((rec) => ({ rec, isBackfill: false }));
  let complete = false;
  if (backfillKey && doneKey !== backfillKey && fresh.length < perCycle) {
    const picked = pickBackfill(perCycle - fresh.length, fresh.map((r) => r.position)) || [];
    if (!picked.length) complete = true;
    for (const rec of picked) items.push({ rec, isBackfill: true });
  }
  return { items, backfillKey, complete };
}

/**
 * Telegram line sent ONCE when a backfill completes (instead of per-record mismatch alerts).
 * `since` is the config ISO timestamp, shown in WIB ("27 Sep 07:00 WIB"); anything that does
 * not parse is shown as given.
 */
export function backfillSummaryText(since, sum) {
  const d = Number(sum?.ledger_delta_sol) || 0;
  return `🧾 <b>Close audit backfill complete</b>\nSince ${fmtWib(since, "datetime") ?? since}: ${sum.reaudited} re-audited, ${sum.changed} changed${sum.kept ? `, ${sum.kept} kept (history not readable)` : ""}.\nNet effect on the ledger: ◎${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(6)}.`;
}
