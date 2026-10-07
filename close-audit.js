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
// pnl_sol_net (pnl − gas − exit slippage). They differ by things the record does not model
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

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// Bump when the audit's method changes: records audited by an older version are re-queued.
export const CLOSE_AUDIT_VERSION = 7;

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
 * @returns {{ dSol:number, dTok:number, touchesMint:boolean, dMintAccountsSol:number|null, dWsolSol:number, dSolEq:number }|null} null for a failed/missing tx
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
  return { dSol, dTok, touchesMint, dMintAccountsSol: idx.size ? dAcct : null, dWsolSol: dWsol, dSolEq: dSol + dWsol };
}

const txOrder = (a, b) => ((Number(a?.slot) || 0) - (Number(b?.slot) || 0)) || ((Number(a?.blockTime) || 0) - (Number(b?.blockTime) || 0));

/**
 * Sum the flows. `posTxs` are the position account's transactions, `walletTxs` the wallet's
 * other transactions in the position's lifetime; a wallet transaction counts only when it
 * touches the wallet's account of the base token (a swap of it, or closing that account).
 * Both lists are processed in chain order whatever order they arrive in.
 */
export function summarizeFlows({ posTxs = [], walletTxs = [], wallet, baseMint }) {
  let netSol = 0, netTok = 0, counted = 0, unreadable = 0, lastSwapPrice = null;
  let walletBought = 0, matchedBought = 0, siblingOps = 0;
  // This position's own token deposits (wallet → position), each usable once for matching.
  const deposits = [];
  for (const tx of [...posTxs].sort(txOrder)) {
    const d = walletDeltas(tx, wallet, baseMint);
    if (!d) { unreadable++; continue; }
    netSol += d.dSolEq; netTok += d.dTok; counted++;
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
  // Compare against the modelled figure: once applied, pnl_sol_net IS the wallet figure.
  const booked = num(record?.pnl_sol_net_modelled) ?? num(record?.pnl_sol_net) ?? num(record?.pnl_sol);
  const capital = num(record?.deposit_sol_true) ?? num(record?.amount_sol);
  if (booked == null || !flows || !(flows.tx_count > 0)) return { status: "no_data" };
  const tol = auditTolerance(capital);
  const residualTok = num(flows.net_tokens) ?? 0;
  const px = num(flows.last_swap_sol_per_token);
  const residualSol = px != null ? Math.abs(residualTok) * px : null;
  const base = {
    net_sol: Math.round(flows.net_sol * 1e6) / 1e6, booked_sol: Math.round(booked * 1e6) / 1e6,
    diff_sol: Math.round((booked - flows.net_sol) * 1e6) / 1e6, tolerance_sol: Math.round(tol * 1e6) / 1e6,
    tx_count: flows.tx_count, residual_tokens: Math.round(residualTok * 1e6) / 1e6,
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
