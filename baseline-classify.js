// baseline-classify.js — pure classification of one wallet transaction for the baseline ledger
// of the operator's own deposits/withdrawals (tools/wallet.js `getBaselineDeposits`). Leaf
// module: imports only close-audit.js (itself a leaf), so a script can load it without state.js.
//
// 2026-11-25: three Jupiter "QR code pay" payments (the wallet's SOL swapped to USDC and the
// USDC delivered straight to a merchant's account) were not booked as withdrawals. The plain
// classifier accepts only System-program transfers, and the untracked-swap bucket needs a token
// to change on a wallet-owned account — the payment's temporary wSOL / USDC accounts are created
// and closed inside the transaction, so the wallet shows a SOL drop and nothing else.
// `classifySwapPayment` books such a transaction: SOL left, nothing came back, a token arrived
// on an account the wallet does not own.

import { isPositionOperation, walletDeltas } from "./close-audit.js";

const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const WSOL_MINT_STR = "So11111111111111111111111111111111111111112";
export const WITHDRAWAL_MIN_LAMPORTS = 10_000_000; // 0.01 SOL floor (matches deposit dust filter)
// Meteora DLMM limit orders: placing escrows SOL/tokens in the pool, cancelling returns them.
const LIMIT_ORDER_OP = /Instruction: (PlaceLimitOrder|CancelLimitOrder|CloseLimitOrderIfEmpty)/;
const keyOf = (k) => (k?.pubkey ?? k)?.toString?.() ?? String(k);

/**
 * Classify a self-signed parsed transaction as a manual wallet WITHDRAWAL.
 *
 * Deliberately conservative so bot operations can NEVER be misread as a
 * withdrawal: deploys/closes/claims/swaps always carry DLMM/Jupiter/Token
 * program instructions, while a manual Phantom send is a pure System transfer.
 * A tx qualifies iff ALL of:
 *   (a) every non-ComputeBudget instruction is a System Program instruction,
 *   (b) it has >=1 parsed System `transfer`/`transferWithSeed` whose
 *       info.source === wallet and info.destination !== wallet,
 *   (c) summed outgoing lamports >= 0.01 SOL.
 *
 * Pure function (no I/O) — unit-testable in isolation.
 * @returns {{ isWithdrawal: boolean, amount: number }} amount in SOL.
 */
export function classifyWithdrawal(parsedTx, walletStr) {
  const NOT = { isWithdrawal: false, amount: 0 };
  const instructions = parsedTx?.transaction?.message?.instructions;
  if (!Array.isArray(instructions) || instructions.length === 0) return NOT;
  // A failed transaction moved nothing but its fee (2026-11-25: was booked if it parsed as a send).
  if (parsedTx?.meta?.err) return NOT;

  let lamports = 0;
  let hasOutgoing = false;

  for (const ix of instructions) {
    const programId = ix?.programId?.toString?.() ?? ix?.programId ?? null;
    const program = ix?.program ?? null;

    // ComputeBudget instructions are ignorable (fee/CU config only)
    if (program === "computeBudget" || programId === COMPUTE_BUDGET_PROGRAM_ID) continue;

    // (a) any non-System, non-ComputeBudget instruction disqualifies the tx
    const isSystem = program === "system" || programId === SYSTEM_PROGRAM_ID;
    if (!isSystem) return NOT;

    // (b) accumulate outgoing System transfers away from our wallet
    const type = ix?.parsed?.type;
    if (type === "transfer" || type === "transferWithSeed") {
      const info = ix.parsed.info || {};
      if (info.source === walletStr && info.destination !== walletStr) {
        const l = Number(info.lamports);
        if (Number.isFinite(l) && l > 0) {
          lamports += l;
          hasOutgoing = true;
        }
      }
    }
  }

  // (c) require an outgoing transfer clearing the dust floor
  if (!hasOutgoing || lamports < WITHDRAWAL_MIN_LAMPORTS) return NOT;
  return { isWithdrawal: true, amount: lamports / 1e9 };
}

const rawAmount = (b) => {
  try { return BigInt(b?.uiTokenAmount?.amount ?? "0"); } catch { return 0n; }
};

/**
 * Is this a PAYMENT routed through a swap (Jupiter "QR code pay", "swap and send")? Pure.
 * All of:
 *   - succeeded, signed by the wallet, not a liquidity-position operation (deploy / add /
 *     remove / claim / rebalance / close / zap) and not a DLMM limit-order place / cancel;
 *   - NO token other than wSOL changed on any wallet-owned account (nothing came back, and no
 *     token was spent — a bot swap, an untracked buy, a zap's swap leg all deliver tokens to
 *     the wallet; a sale or a burn takes them out);
 *   - the wallet's SOL-equivalent fell by >= 0.01 SOL: native lamports + the lamports of its
 *     own token accounts (wSOL held, rent of an account opened or closed stays the wallet's),
 *     the transaction fee left out when the wallet paid it (a plain transfer is booked at its
 *     transfer amount, fee excluded);
 *   - a token other than wSOL arrived on an account the wallet does not own, at an owner whose
 *     balances only rose (a pool both receives and pays out, so it is never the recipient).
 * @returns {{ isPayment: boolean, amount: number, delivered: Array<{mint:string, amount:number, owner:string}> }}
 *   amount = SOL spent; delivered = recipient credits, largest first (≤ 3).
 */
export function classifySwapPayment(parsedTx, walletStr) {
  const NOT = { isPayment: false, amount: 0, delivered: [] };
  const tx = parsedTx;
  if (!tx?.meta || tx.meta.err) return NOT;
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  const keys = accountKeys.map(keyOf);
  const wi = keys.indexOf(walletStr);
  if (wi < 0 || !accountKeys[wi]?.signer) return NOT;
  if (isPositionOperation(tx)) return NOT;
  if ((tx.meta.logMessages || []).some((l) => typeof l === "string" && LIMIT_ORDER_OP.test(l))) return NOT;

  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  // Per token account: owner, mint, raw pre / post amounts.
  const accts = new Map();
  for (const [list, side] of [[pre, "pre"], [post, "post"]]) {
    for (const b of list) {
      if (!Number.isInteger(b?.accountIndex)) continue;
      const a = accts.get(b.accountIndex) || { owner: b.owner, mint: b.mint, decimals: b.uiTokenAmount?.decimals ?? 0, pre: 0n, post: 0n };
      a[side] = rawAmount(b);
      a.owner ??= b.owner; a.mint ??= b.mint;
      accts.set(b.accountIndex, a);
    }
  }

  let ownTokenLamports = 0;
  const others = new Map(); // owner -> { gained: [{mint, raw, decimals}], lost: boolean }
  for (const [idx, a] of accts) {
    const d = a.post - a.pre;
    if (a.owner === walletStr) {
      if (a.mint !== WSOL_MINT_STR && d !== 0n) return NOT; // a token moved on the wallet's side
      if (idx !== wi) ownTokenLamports += (tx.meta.postBalances?.[idx] ?? 0) - (tx.meta.preBalances?.[idx] ?? 0);
      continue;
    }
    const o = others.get(a.owner) || { gained: [], lost: false };
    if (d < 0n) o.lost = true;
    else if (d > 0n && a.mint !== WSOL_MINT_STR) o.gained.push({ mint: a.mint, raw: d, decimals: a.decimals });
    others.set(a.owner, o);
  }

  const dNative = (tx.meta.postBalances?.[wi] ?? 0) - (tx.meta.preBalances?.[wi] ?? 0);
  const feePaid = wi === 0 ? Number(tx.meta.fee) || 0 : 0;
  const spent = -(dNative + ownTokenLamports) - feePaid;
  if (!(spent >= WITHDRAWAL_MIN_LAMPORTS)) return NOT;

  const delivered = [];
  for (const [owner, o] of others) {
    if (o.lost || !owner) continue;
    for (const g of o.gained) delivered.push({ mint: g.mint, amount: Number(g.raw) / 10 ** g.decimals, owner });
  }
  if (!delivered.length) return NOT;
  delivered.sort((x, y) => y.amount - x.amount);
  return { isPayment: true, amount: spent / 1e9, delivered: delivered.slice(0, 3) };
}

/**
 * The baseline withdrawal one signer transaction represents, or null: a plain System send
 * (booked as before, no `withdrawal_type`) or a swap payment (`withdrawal_type: "swap_payment"` + what was delivered
 * to whom). Shared by the hourly scan and scripts/backfill_baseline_payments.js.
 */
export function classifyBaselineWithdrawal(parsedTx, walletStr, sigInfo = {}) {
  const ts = Number.isFinite(Number(sigInfo.blockTime ?? parsedTx?.blockTime))
    ? new Date(Number(sigInfo.blockTime ?? parsedTx.blockTime) * 1000).toISOString()
    : null;
  const signature = sigInfo.signature ?? parsedTx?.transaction?.signatures?.[0] ?? null;
  const plain = classifyWithdrawal(parsedTx, walletStr);
  if (plain.isWithdrawal) return { signature, timestamp: ts, amount: plain.amount };
  const pay = classifySwapPayment(parsedTx, walletStr);
  if (!pay.isPayment) return null;
  const top = pay.delivered[0];
  return {
    signature,
    timestamp: ts,
    amount: pay.amount,
    withdrawal_type: "swap_payment", // not `kind`: the dashboard tags list rows with its own `kind`
    delivered_mint: top.mint,
    delivered_amount: top.amount,
    delivered_to: top.owner,
  };
}

/**
 * Walk signatures oldest→newest and stop at the first whose transaction cannot be
 * fetched. Returns the newest signature fully handled — the next scan checkpoint — so
 * a transient RPC miss is retried on the next scan instead of being skipped for good
 * (the scan used to `continue` past a null tx and then checkpoint the newest signature,
 * losing any deposit in it permanently). Pure apart from the injected callbacks.
 */
/**
 * baseline.token_swaps is a ring (newest `cap` rows). The profit skimmer nets the SOL of
 * untracked-token swaps out of profit, so the SOL of every evicted row is carried in
 * baseline.token_swaps_evicted_sol (2026-11-25). The running total starts at 0 only while
 * nothing has been evicted yet: a full ring without it is older state and stays unknown
 * (the skimmer refuses on that). Both mutate `baseline`.
 */
export function initTokenSwapEvictedTotal(baseline, cap) {
  const ring = Array.isArray(baseline?.token_swaps) ? baseline.token_swaps : [];
  if (baseline && baseline.token_swaps_evicted_sol == null && ring.length < cap) baseline.token_swaps_evicted_sol = 0;
}
export function trimTokenSwapRing(baseline, cap) {
  const ring = Array.isArray(baseline?.token_swaps) ? baseline.token_swaps : [];
  if (ring.length <= cap) return;
  const evicted = ring.slice(0, ring.length - cap);
  if (Number.isFinite(Number(baseline.token_swaps_evicted_sol)) && baseline.token_swaps_evicted_sol !== null) {
    const add = evicted.reduce((s, w) => s + (Number(w?.sol) || 0), 0);
    baseline.token_swaps_evicted_sol = Math.round((Number(baseline.token_swaps_evicted_sol) + add) * 1e9) / 1e9;
  }
  baseline.token_swaps = ring.slice(-cap);
}

export async function walkSignaturesInOrder(sortedSigs, fetchTx, handle, { isAborted = null } = {}) {
  let checkpoint = null;
  for (const sigInfo of sortedSigs) {
    // Cooperative cancel (the skimmer's bounded pre-skim scan): stop between transactions,
    // keep what was handled, and do NOT count it as a stuck signature.
    if (isAborted?.()) return { checkpoint, stoppedAt: null, aborted: true, handled: sortedSigs.indexOf(sigInfo) };
    const tx = await fetchTx(sigInfo);
    if (!tx) return { checkpoint, stoppedAt: sigInfo.signature, handled: sortedSigs.indexOf(sigInfo) };
    handle(sigInfo, tx);
    checkpoint = sigInfo.signature;
  }
  return { checkpoint, stoppedAt: null, handled: sortedSigs.length };
}

/**
 * Is this wallet transaction a swap between SOL and ONE other token? Pure.
 * Returns { mint, sol, tokens } — the wallet's SOL-equivalent change (native + its own wSOL
 * accounts, fees included) and the token change — or null: a liquidity-position operation, no
 * token or more than one token moved, SOL and token moving the same way (a transfer, an
 * airdrop, a burn), or less than ◎0.0001 moved. Used by the baseline scan to keep the swaps of
 * tokens that are not any position's base token (ledger-truth `untracked_token_swaps_sol`).
 */
export function classifyTokenSwap(parsedTx, walletStr) {
  if (!parsedTx || parsedTx.meta?.err || isPositionOperation(parsedTx)) return null;
  const mints = new Set();
  for (const b of [...(parsedTx.meta?.preTokenBalances || []), ...(parsedTx.meta?.postTokenBalances || [])]) {
    if (b?.owner === walletStr && b.mint && b.mint !== WSOL_MINT_STR) mints.add(b.mint);
  }
  let hit = null;
  for (const mint of mints) {
    const d = walletDeltas(parsedTx, walletStr, mint);
    if (!d || Math.abs(d.dTok) <= 0) continue;
    if (hit) return null; // token-for-token: not a SOL result
    hit = { mint, sol: d.dSolEq, tokens: d.dTok };
  }
  if (!hit || Math.abs(hit.sol) < 1e-4 || Math.sign(hit.sol) === Math.sign(hit.tokens)) return null;
  return { mint: hit.mint, sol: Math.round(hit.sol * 1e9) / 1e9, tokens: hit.tokens };
}

/**
 * Backfill plan (pure): which of `found` (withdrawals classified from chain) the baseline does
 * not have yet. Idempotent by signature — a signature already in `baseline.withdrawals`, or
 * twice in `found`, is never added again.
 * @returns {{ rows: Array<object & { status: "already_booked"|"would_add" }>, toAdd: object[] }}
 */
export function planBaselineBackfill(baseline, found) {
  const seen = new Set((baseline?.withdrawals || []).map((w) => w?.signature).filter(Boolean));
  const rows = [];
  const toAdd = [];
  for (const w of found || []) {
    if (!w?.signature) continue;
    if (seen.has(w.signature)) { rows.push({ ...w, status: "already_booked" }); continue; }
    seen.add(w.signature);
    rows.push({ ...w, status: "would_add" });
    toAdd.push(w);
  }
  return { rows, toAdd };
}

/** A copy of `baseline` with `toAdd` appended (time order kept) and total_withdrawn updated. */
export function applyBaselineBackfill(baseline, toAdd) {
  const b = { ...(baseline || {}) };
  const seen = new Set((b.withdrawals || []).map((w) => w?.signature));
  const add = (toAdd || []).filter((w) => w?.signature && !seen.has(w.signature));
  // Appended, not re-sorted: every consumer filters by timestamp, and the stored order of the
  // existing entries is left as it was.
  b.withdrawals = [...(b.withdrawals || []), ...add.map((w) => ({ ...w, backfilled_at: w.backfilled_at ?? new Date().toISOString() }))];
  const total = Number(b.total_withdrawn || 0) + add.reduce((s, w) => s + (Number(w.amount) || 0), 0);
  b.total_withdrawn = Math.round(total * 1e6) / 1e6;
  return b;
}
