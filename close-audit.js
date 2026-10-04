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

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Wallet deltas of one parsed transaction (as returned by getParsedTransaction).
 * @returns {{ dSol:number, dTok:number, touchesMint:boolean }|null} null for a failed/missing tx
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
  return { dSol, dTok, touchesMint };
}

/**
 * Sum the flows. `posTxs` are the position account's transactions, `walletTxs` the wallet's
 * other transactions in the position's lifetime; a wallet transaction counts only when it
 * touches the wallet's account of the base token (a swap of it, or closing that account).
 */
export function summarizeFlows({ posTxs = [], walletTxs = [], wallet, baseMint }) {
  let netSol = 0, netTok = 0, counted = 0, unreadable = 0, lastSwapPrice = null;
  for (const tx of posTxs) {
    const d = walletDeltas(tx, wallet, baseMint);
    if (!d) { unreadable++; continue; }
    netSol += d.dSol; netTok += d.dTok; counted++;
  }
  for (const tx of walletTxs) {
    const d = walletDeltas(tx, wallet, baseMint);
    if (!d || !d.touchesMint) continue;
    netSol += d.dSol; netTok += d.dTok; counted++;
    if (Math.abs(d.dTok) > 0 && Math.abs(d.dSol) > 0 && Math.sign(d.dTok) !== Math.sign(d.dSol)) lastSwapPrice = Math.abs(d.dSol / d.dTok);
  }
  const lastPosTime = posTxs.reduce((m, tx) => Math.max(m, Number(tx?.blockTime) || 0), 0) || null;
  return { net_sol: netSol, net_tokens: netTok, tx_count: counted, unreadable, last_swap_sol_per_token: lastSwapPrice, last_position_tx_time: lastPosTime };
}

export function auditTolerance(capitalSol) {
  return Math.max(0.01, 0.015 * (num(capitalSol) ?? 0));
}

/**
 * Verdict for one record. status:
 *   ok          — booked net result within tolerance of the wallet's
 *   mismatch    — outside tolerance (alert)
 *   incomplete  — tokens bought/sold do not net out (a remainder is still held, or the operator
 *                 brought or took tokens), or a position transaction could not be read
 *   no_data     — nothing to compare
 */
export function evaluateCloseAudit(record, flows) {
  const booked = num(record?.pnl_sol_net) ?? num(record?.pnl_sol);
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
  if (flows.unreadable > 0) return { status: "incomplete", retry: true, why: `${flows.unreadable} position transaction(s) unreadable`, ...base };
  // The closing transaction must be among those seen: a rate-limited signature listing can
  // come back short, and then the proceeds are simply missing (three false "mismatches" of
  // −0.28…−0.99 SOL in the first dry run).
  const closedAt = new Date(record?.recorded_at || 0).getTime() / 1000;
  const lastSeen = num(flows.last_position_tx_time);
  if (Number.isFinite(closedAt) && closedAt > 0 && (lastSeen == null || closedAt - lastSeen > 300)) {
    return { status: "incomplete", retry: true, why: "the closing transaction was not among those read", ...base };
  }
  const residualMatters = Math.abs(residualTok) > 1e-6 && (residualSol == null || residualSol > Math.max(0.002, 0.005 * (capital ?? 0)));
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
  for (let page = 0; page < maxWalletPages; page++) {
    const batch = await rpc((c) => c.getSignaturesForAddress(new PublicKey(wallet), { limit: 1000, before }));
    if (!batch.length) break;
    for (const s of batch) if (!s.err && s.blockTime >= t0 && s.blockTime <= t1 && !inPos.has(s.signature)) walletSigs.push(s);
    before = batch[batch.length - 1].signature;
    if (batch[batch.length - 1].blockTime < t0) break;
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
    posTxs.push(tx ? { ...tx, blockTime: tx.blockTime ?? s.blockTime } : { meta: { err: "unreadable" } });
    await sleep(120);
  }
  const walletTxs = [];
  for (const s of walletSigs) { const tx = await get(s.signature); if (tx) walletTxs.push(tx); await sleep(120); }
  // failed position transactions change nothing on chain: drop them rather than count as unreadable
  return summarizeFlows({ posTxs: posTxs.filter((t) => t !== null), walletTxs, wallet, baseMint });
}
