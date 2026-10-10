/**
 * tools/limit-order-close.js — close (cancel / withdraw) one of the operator's Meteora
 * DLMM limit orders through the bot's wallet.
 *
 * OPERATOR-ONLY. Reached from the command server (POST /command/close-limit-order, the
 * dashboard button) and the Telegram /orders menu. It is NOT an LLM tool: it is absent
 * from tools/definitions.js, the executor toolMap and the agent role sets, and nothing
 * in the bot calls it on its own.
 *
 * A limit order is a keypair account of the DLMM program (header: lb_pair, owner,
 * bin_count; then one entry per bin). Cancelling IS the withdraw/claim — the Meteora UI
 * sends the same sequence for an unfilled, partly filled or 100 %-filled order:
 *   ATA createIdempotent (token X) · ATA createIdempotent (token Y) · CancelLimitOrder ·
 *   wSOL closeAccount · CloseLimitOrderIfEmpty
 * which is exactly what the SDK's `cancelLimitOrder` builds (one legacy Transaction).
 *
 * Safeguards: the order account is authoritative (owner, pool and bin ids are read on
 * chain, never taken from the feed); every transaction is simulated before it is sent
 * and any simulation error aborts; DRY_RUN stops after the simulation; returned tokens
 * stay in the wallet (no auto-swap is triggered here).
 */
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { log } from "../logger.js";
import { invalidateLimitOrderCaches } from "../limit-orders.js";

export const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
// Anchor discriminators (SDK 1.9.14 IDL; test/limit-order-close.test.js checks them against it).
export const LIMIT_ORDER_ACCOUNT_DISCRIMINATOR = [137, 183, 212, 91, 115, 29, 141, 227];
export const CANCEL_LIMIT_ORDER_DISCRIMINATOR = [132, 156, 132, 31, 67, 40, 232, 97];
export const CLOSE_LIMIT_ORDER_IF_EMPTY_DISCRIMINATOR = [57, 124, 36, 155, 126, 249, 93, 171];
// The SDK caps an order at 50 bins; 20 bin ids per transaction keeps each well inside
// the transaction size and compute limits.
export const CANCEL_BINS_PER_TX = 20;
// Fee + the temporary wSOL account + (first time for a mint) the base-token account.
export const MIN_FREE_SOL_FOR_CLOSE = 0.006;
// A "close:" label puts the send on the exit priority-fee tier (urgencyForLabel in
// tools/dlmm.js: p75 × exitPriorityFeeMultiplier, capped by maxExitPriorityFeeMicroLamports).
export const SEND_LABEL = "close:limitOrder";

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const str = (v) => (v == null ? "" : typeof v === "string" ? v : v.toBase58?.() ?? String(v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function fail(code, error, extra = {}) {
  return { success: false, error, code, ...extra };
}

export function isBase58Address(value) {
  if (typeof value !== "string" || !BASE58_ADDRESS.test(value)) return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

// ─── Pure helpers ──────────────────────────────────────────────

/**
 * Header of a limit-order account: 8-byte discriminator, lb_pair (32), owner (32),
 * bin_count (u16). Returns null when the data is not a limit-order account.
 */
export function decodeLimitOrderHeader(data) {
  if (!data || data.length < 74) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== LIMIT_ORDER_ACCOUNT_DISCRIMINATOR[i]) return null;
  const buf = Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.length);
  return {
    lbPair: new PublicKey(buf.subarray(8, 40)).toBase58(),
    owner: new PublicKey(buf.subarray(40, 72)).toBase58(),
    binCount: buf.readUInt16LE(72),
  };
}

/** Bin ids still holding something (unfilled deposit or unclaimed fill), from the on-chain account. */
export function selectCancelBinIds(parsedOrder) {
  const seen = new Set();
  for (const b of parsedOrder?.limitOrderBinData || []) {
    if (!b || b.empty === true) continue;
    const id = Number(b.binId);
    if (Number.isInteger(id)) seen.add(id);
  }
  return [...seen].sort((a, b) => a - b);
}

export function chunkBinIds(ids, size = CANCEL_BINS_PER_TX) {
  const n = Math.max(1, Math.floor(Number(size)) || CANCEL_BINS_PER_TX);
  const list = Array.isArray(ids) ? ids : [];
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * The order must belong to the bot wallet and to the pool the caller named.
 * `parsedOrder` carries `owner` and `lbPair` from the on-chain header.
 */
export function validateOrderOwnership(parsedOrder, wallet, pool) {
  const owner = str(parsedOrder?.owner);
  const lbPair = str(parsedOrder?.lbPair);
  if (!owner || !lbPair) {
    return { ok: false, code: "not_found", error: "Not a Meteora limit order account" };
  }
  if (owner !== str(wallet)) {
    return { ok: false, code: "not_owned", error: `Limit order belongs to ${owner}, not to the bot wallet` };
  }
  if (lbPair !== str(pool)) {
    return { ok: false, code: "pool_mismatch", error: `Limit order belongs to pool ${lbPair}, not ${str(pool)}` };
  }
  return { ok: true };
}

/**
 * Side, fill and expected proceeds of an order.
 * poolInfo: { name, tokenXMint, tokenYMint, tokenXSymbol, tokenYSymbol }.
 * `expected` is what a cancel pays out right now according to the account (unfilled
 * deposit + swapped proceeds + fees, net of a Token-2022 transfer fee), split into the
 * SOL leg and the other ("base") leg. A pool with no SOL leg reports token X as base and
 * token Y under `quote`.
 */
export function summarizeOrder(parsedOrder, poolInfo = {}) {
  const bins = (parsedOrder?.limitOrderBinData || []).filter((b) => b && b.empty !== true);
  const asks = bins.filter((b) => b.isAskSide === true).length;
  const depX = num(parsedOrder?.totalDepositAmountX);
  const depY = num(parsedOrder?.totalDepositAmountY);
  const isAsk = bins.length ? asks * 2 >= bins.length : depX > 0 || depY === 0;
  const deposited = isAsk ? depX : depY;
  const filled = isAsk ? num(parsedOrder?.totalFilledAmountX) : num(parsedOrder?.totalFilledAmountY);
  const filledPct = deposited > 0 ? Math.min(100, Math.max(0, (filled / deposited) * 100)) : 0;

  const outX = num(parsedOrder?.transferFeeExcludedWithdrawableAmountX);
  const outY = num(parsedOrder?.transferFeeExcludedWithdrawableAmountY);
  const xIsSol = str(poolInfo.tokenXMint) === WSOL_MINT;
  const yIsSol = str(poolInfo.tokenYMint) === WSOL_MINT;
  const baseIsX = !xIsSol;
  const baseSymbol = (baseIsX ? poolInfo.tokenXSymbol : poolInfo.tokenYSymbol) || null;
  const expected = {
    base: baseIsX ? outX : outY,
    base_symbol: baseSymbol,
    sol: xIsSol ? outX : yIsSol ? outY : 0,
  };
  if (!xIsSol && !yIsSol) expected.quote = { amount: outY, symbol: poolInfo.tokenYSymbol || null };

  return {
    pool_name: poolInfo.name || null,
    side: isAsk ? "ask" : "bid",
    filled_pct: Math.round(filledPct * 100) / 100,
    fully_filled: deposited > 0 && filledPct >= 99.995,
    base_symbol: baseSymbol,
    base_mint: str(baseIsX ? poolInfo.tokenXMint : poolInfo.tokenYMint) || null,
    bin_count: Number(parsedOrder?.binCount ?? (parsedOrder?.limitOrderBinData || []).length) || 0,
    open_bins: bins.length,
    expected,
  };
}

const sameBytes = (data, disc) => !!data && data.length >= 8 && disc.every((b, i) => data[i] === b);
const isDlmmIx = (ix, disc) => str(ix?.programId) === DLMM_PROGRAM_ID && sameBytes(ix.data, disc);

/** Removes CloseLimitOrderIfEmpty from a transaction that leaves bins behind (non-final chunk). */
export function stripCloseIfEmpty(tx) {
  tx.instructions = tx.instructions.filter((ix) => !isDlmmIx(ix, CLOSE_LIMIT_ORDER_IF_EMPTY_DISCRIMINATOR));
  return tx;
}

/** Program ids + DLMM instruction names of a built transaction, for logs and tests. */
export function describeInstructions(tx) {
  return (tx?.instructions || []).map((ix) => {
    const programId = str(ix.programId);
    let name = null;
    if (isDlmmIx(ix, CANCEL_LIMIT_ORDER_DISCRIMINATOR)) name = "CancelLimitOrder";
    else if (isDlmmIx(ix, CLOSE_LIMIT_ORDER_IF_EMPTY_DISCRIMINATOR)) name = "CloseLimitOrderIfEmpty";
    return { programId, name };
  });
}

/**
 * One transaction per chunk of bin ids, built by the SDK. `pool.cancelLimitOrder`
 * returns ONE legacy Transaction (an array is tolerated). Every chunk carries the ATA
 * creates and the wSOL unwrap; only the last keeps CloseLimitOrderIfEmpty. No bin ids
 * → a single CloseLimitOrderIfEmpty transaction.
 */
export async function buildCloseTransaction(pool, { order, owner, binIds, isLast }) {
  if (!binIds?.length) {
    const built = await pool.closeLimitOrderIfEmpty({ limitOrder: order, owner, rentReceiver: owner });
    return Array.isArray(built) ? built : [built];
  }
  const built = await pool.cancelLimitOrder({ limitOrderPubkey: order, owner, rentReceiver: owner, binIds });
  const txs = Array.isArray(built) ? built : [built];
  txs.forEach((tx, i) => { if (!(isLast && i === txs.length - 1)) stripCloseIfEmpty(tx); });
  return txs;
}

/** "InstructionError #2: InvalidLimitOrderOwner (6106)" from a simulation/transaction err. */
export function describeProgramError(err, idlErrors = []) {
  if (!err) return null;
  const ie = err.InstructionError;
  if (Array.isArray(ie)) {
    const [index, detail] = ie;
    if (detail && typeof detail === "object" && "Custom" in detail) {
      const code = Number(detail.Custom);
      const known = (idlErrors || []).find((e) => Number(e.code) === code);
      return `instruction ${index}: ${known ? `${known.name} (${code})${known.msg ? ` — ${known.msg}` : ""}` : `custom program error ${code} (0x${code.toString(16)})`}`;
    }
    return `instruction ${index}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

/**
 * What one confirmed transaction (getParsedTransaction shape) paid back to the wallet.
 * SOL proceeds = wallet lamport change + fee + rent of token accounts the wallet opened
 * in it − the order account's rent it got back + plain system transfers it made to
 * others. Token amounts are the change of the wallet's own token balances.
 */
export function returnedFromTxMeta(tx, { wallet, baseMint, quoteMint = null, order }) {
  const meta = tx?.meta;
  const keys = (tx?.transaction?.message?.accountKeys || []).map((k) => str(k?.pubkey ?? k));
  const wi = keys.indexOf(str(wallet));
  if (!meta || wi < 0) return null;
  const pre = meta.preBalances || [];
  const post = meta.postBalances || [];
  const tokenUi = (b) => num(b?.uiTokenAmount?.amount) / 10 ** num(b?.uiTokenAmount?.decimals);
  const mine = (list, mint) => (list || []).filter((b) => b.owner === str(wallet) && b.mint === str(mint));
  const tokenDelta = (mint) => (mint
    ? mine(meta.postTokenBalances, mint).reduce((s, b) => s + tokenUi(b), 0) - mine(meta.preTokenBalances, mint).reduce((s, b) => s + tokenUi(b), 0)
    : 0);
  let openedRent = 0;
  for (const b of meta.postTokenBalances || []) {
    if (b.owner !== str(wallet)) continue;
    if (num(pre[b.accountIndex]) === 0 && num(post[b.accountIndex]) > 0) openedRent += num(post[b.accountIndex]);
  }
  const oi = keys.indexOf(str(order));
  const orderRent = oi >= 0 && num(pre[oi]) > 0 && num(post[oi]) === 0 ? num(pre[oi]) : 0;
  let transfersOut = 0;
  for (const ix of tx.transaction.message.instructions || []) {
    const info = ix?.parsed?.info;
    if (ix?.program === "system" && ix.parsed?.type === "transfer" && info?.source === str(wallet) && info.destination !== str(wallet)) {
      transfersOut += num(info.lamports);
    }
  }
  const fee = num(meta.fee);
  const solLamports = num(post[wi]) - num(pre[wi]) + fee + openedRent - orderRent + transfersOut;
  return {
    base: tokenDelta(baseMint),
    quote: quoteMint && str(quoteMint) !== WSOL_MINT ? tokenDelta(quoteMint) : 0,
    sol_lamports: solLamports,
    fee_lamports: fee,
    order_rent_lamports: orderRent,
    opened_account_rent_lamports: openedRent,
  };
}

/** HTTP status for the command server (the contract the dashboard codes to). */
export function httpStatusForCloseResult(result) {
  if (result?.success) return 200;
  switch (result?.code) {
    case "invalid_input": return 400;
    case "pool_not_found":
    case "not_found": return 404;
    case "not_owned":
    case "pool_mismatch":
    case "busy":
    case "insufficient_sol": return 409;
    case "rpc_error": return 502;
    default: return 500; // simulation_failed, send_failed, not_closed, internal
  }
}

/** Pure. `{ pool, order }` body → validated addresses or a 400 message. */
export function parseCloseLimitOrderBody(body) {
  const pool = typeof body?.pool === "string" ? body.pool.trim() : "";
  const order = typeof body?.order === "string" ? body.order.trim() : "";
  if (!isBase58Address(pool)) return { ok: false, error: "Missing or malformed `pool` (base58 address expected)" };
  if (!isBase58Address(order)) return { ok: false, error: "Missing or malformed `order` (base58 address expected)" };
  if (pool === order) return { ok: false, error: "`pool` and `order` must be different addresses" };
  return { ok: true, pool, order };
}

// ─── The operation ─────────────────────────────────────────────

async function defaultDeps() {
  const { limitOrderCloseAccess } = await import("./dlmm.js");
  return limitOrderCloseAccess();
}

async function simulate(conn, tx, payer) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: tx.instructions }).compileToV0Message();
  const res = await conn.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  return res.value;
}

async function resolveDeps(deps) {
  const injected = deps?.getPool && deps?.getWallet && deps?.getConnection;
  return injected ? deps : { ...(await defaultDeps()), ...(deps || {}) };
}

/**
 * Read-only part shared by the close and the menus: pool → order account → ownership →
 * parsed bins. Returns { failure } | { closed: true, poolInfo, baseSymbol } |
 * { pool, poolInfo, parsed, summary, binIds, orderRentLamports }.
 */
async function loadOrder(d, conn, walletStr, poolStr, orderStr) {
  const poolPk = new PublicKey(poolStr);
  const orderPk = new PublicKey(orderStr);
  // 1. The pool must be a DLMM account before anything else (404 for an unknown pool).
  let poolAcc;
  try { poolAcc = await conn.getAccountInfo(poolPk); } catch (e) { return { failure: fail("rpc_error", `Could not read the pool account: ${e.message}`) }; }
  if (!poolAcc || str(poolAcc.owner) !== DLMM_PROGRAM_ID) return { failure: fail("pool_not_found", "Unknown pool: not a Meteora DLMM pool account") };
  let pool;
  try { pool = await d.getPool(poolStr); } catch (e) { return { failure: fail("pool_not_found", `Could not load the DLMM pool: ${e.message}`) }; }
  const meta = (await Promise.resolve(d.getPoolMetadata?.(poolStr)).catch(() => null)) || {};
  const poolInfo = {
    name: meta.name || null,
    tokenXMint: str(pool.tokenX?.mint?.address),
    tokenYMint: str(pool.tokenY?.mint?.address),
    tokenXSymbol: meta.token_x_symbol || null,
    tokenYSymbol: meta.token_y_symbol || null,
  };
  const baseSymbol = (poolInfo.tokenXMint !== WSOL_MINT ? poolInfo.tokenXSymbol : poolInfo.tokenYSymbol) || null;

  // 2. The order account. Gone → already closed (idempotent).
  let orderAcc;
  try { orderAcc = await conn.getAccountInfo(orderPk, "confirmed"); } catch (e) { return { failure: fail("rpc_error", `Could not read the order account: ${e.message}`) }; }
  if (!orderAcc) return { closed: true, poolInfo, baseSymbol };
  const header = str(orderAcc.owner) === DLMM_PROGRAM_ID ? decodeLimitOrderHeader(orderAcc.data) : null;
  if (!header) return { failure: fail("not_found", "Not a Meteora limit order account") };
  // Ownership and pool are checked on the raw header BEFORE the SDK parses the bins
  // against this pool's bin arrays.
  const headerCheck = validateOrderOwnership(header, walletStr, poolStr);
  if (!headerCheck.ok) return { failure: fail(headerCheck.code, headerCheck.error) };

  let parsed;
  try {
    const got = await pool.getLimitOrder(orderPk);
    parsed = { ...got.limitOrderData, owner: header.owner, lbPair: header.lbPair, binCount: header.binCount };
  } catch (e) {
    return { failure: fail("rpc_error", `Could not parse the order: ${e.message}`) };
  }
  const check = validateOrderOwnership(parsed, walletStr, poolStr);
  if (!check.ok) return { failure: fail(check.code, check.error) };
  return {
    pool, poolInfo, parsed,
    summary: summarizeOrder(parsed, poolInfo),
    binIds: selectCancelBinIds(parsed),
    orderRentLamports: num(orderAcc.lamports),
  };
}

/**
 * Read-only: what the chain says about an order right now. Used by the Telegram menu
 * at every tap. Returns { status: "open", summary, bins, rent_sol } |
 * { status: "closed", pool_name } | { status: "refused", code, error }.
 */
export async function inspectLimitOrder({ pool_address, order_address } = {}, deps = null) {
  const input = parseCloseLimitOrderBody({ pool: pool_address, order: order_address });
  if (!input.ok) return { status: "refused", code: "invalid_input", error: input.error };
  try {
    const d = await resolveDeps(deps);
    const loaded = await loadOrder(d, d.getConnection(), d.getWallet().publicKey.toBase58(), input.pool, input.order);
    if (loaded.failure) return { status: "refused", code: loaded.failure.code, error: loaded.failure.error };
    if (loaded.closed) return { status: "closed", pool_name: loaded.poolInfo.name };
    return { status: "open", summary: loaded.summary, bins: loaded.binIds.length, rent_sol: loaded.orderRentLamports / 1e9 };
  } catch (e) {
    return { status: "refused", code: "internal", error: e.message };
  }
}

/**
 * Close one limit order. Never throws: returns
 *   { success, pool_name, side, filled_pct, returned: { base, base_symbol, sol, source },
 *     rent_sol, txs, fee_lamports, already_closed?, dry_run?, simulated? }
 * or { success: false, error, code }.
 * `deps` (tests / read-only harness): getPool, getWallet, getConnection, send,
 * getPoolMetadata, getSdk, dryRun, invalidate, metaRetryMs.
 */
export async function closeLimitOrder({ pool_address, order_address, onProgress } = {}, deps = null) {
  const progress = (stage, message) => { try { onProgress?.(stage, message); } catch { /* observer only */ } };
  const parsedInput = parseCloseLimitOrderBody({ pool: pool_address, order: order_address });
  if (!parsedInput.ok) return fail("invalid_input", parsedInput.error);
  const { pool: poolStr, order: orderStr } = parsedInput;
  const short = `${orderStr.slice(0, 8)} (pool ${poolStr.slice(0, 8)})`;
  const txs = [];
  let feeLamports = 0;

  try {
    const d = await resolveDeps(deps);
    const dryRun = d.dryRun ?? process.env.DRY_RUN === "true";
    const conn = d.getConnection();
    const wallet = d.getWallet();
    const walletStr = wallet.publicKey.toBase58();
    const orderPk = new PublicKey(orderStr);
    const readOrder = () => conn.getAccountInfo(orderPk, "confirmed");

    progress("order", "Reading the pool and the order account");
    const loaded = await loadOrder(d, conn, walletStr, poolStr, orderStr);
    if (loaded.failure) {
      log("limit_order", `[LIMIT_ORDER_CLOSE] ${short}: refused — ${loaded.failure.error}`);
      return loaded.failure;
    }
    if (loaded.closed) {
      invalidate(d);
      log("limit_order", `[LIMIT_ORDER_CLOSE] ${short}: account does not exist — already closed`);
      return {
        success: true, already_closed: true, pool_name: loaded.poolInfo.name, side: null, filled_pct: null,
        returned: { base: 0, base_symbol: loaded.baseSymbol, sol: 0 }, rent_sol: 0, txs: [], fee_lamports: 0,
      };
    }
    const { pool, summary, binIds, orderRentLamports } = loaded;
    const chunks = binIds.length ? chunkBinIds(binIds, CANCEL_BINS_PER_TX) : [[]];
    const base = { pool_name: summary.pool_name, side: summary.side, filled_pct: summary.filled_pct };

    // 3. Free SOL for the fee and the temporary token accounts.
    const lamports = await conn.getBalance(wallet.publicKey, "confirmed");
    if (lamports < MIN_FREE_SOL_FOR_CLOSE * 1e9) {
      return fail("insufficient_sol", `Wallet has ◎${(lamports / 1e9).toFixed(4)} free; closing an order needs about ◎${MIN_FREE_SOL_FOR_CLOSE} for the fee and temporary token-account rent`, base);
    }

    const sdk = await d.getSdk?.().catch(() => null);
    const idlErrors = sdk?.IDL?.errors || sdk?.default?.IDL?.errors || [];
    let simulated = 0;
    let unitsConsumed = 0;

    // 4. Chunk by chunk: build → simulate → (send). A later chunk is built and simulated
    //    only after the previous one landed, so its simulation sees the real state.
    chunkLoop: for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      // Dry run: a later chunk cannot see the earlier ones land, so its
      // CloseLimitOrderIfEmpty is left out of the simulation.
      const keepClose = dryRun ? isLast && chunks.length === 1 : isLast;
      const built = await buildCloseTransaction(pool, { order: orderPk, owner: wallet.publicKey, binIds: chunks[i], isLast: keepClose });
      for (const tx of built) {
        progress("simulate", `Simulating transaction ${i + 1}/${chunks.length}`);
        const sim = await simulate(conn, tx, wallet.publicKey);
        if (sim.err) {
          const why = describeProgramError(sim.err, idlErrors);
          log("limit_order", `[LIMIT_ORDER_CLOSE] ${short}: simulation failed on tx ${i + 1}/${chunks.length} — ${why}`);
          return fail("simulation_failed", `Simulation failed: ${why}`, { ...base, txs, simulation_logs: (sim.logs || []).slice(-8) });
        }
        simulated++;
        unitsConsumed += num(sim.unitsConsumed);
        if (dryRun) continue;

        progress("send", `Sending transaction ${i + 1}/${chunks.length}`);
        try {
          const { txHash, fee } = await d.send(conn, tx, [wallet], SEND_LABEL);
          txs.push(txHash);
          feeLamports += num(fee);
        } catch (sendErr) {
          // The send can throw after the transaction landed (confirmation timeout).
          // The account is the evidence: gone → it landed.
          const after = await readOrder().catch(() => undefined);
          if (after === null) {
            if (sendErr?.confirmedSignature) txs.push(sendErr.confirmedSignature);
            log("limit_order", `[LIMIT_ORDER_CLOSE] ${short}: send threw (${sendErr.message}) but the order account is gone — treated as landed`);
            break chunkLoop;
          }
          invalidate(d);
          log("limit_order", `[LIMIT_ORDER_CLOSE] ${short}: send failed on tx ${i + 1}/${chunks.length} — ${sendErr.message}`);
          return fail("send_failed", `Transaction failed: ${sendErr.message}${txs.length ? ` (${txs.length} earlier transaction(s) landed — part of the order was withdrawn)` : ""}`, { ...base, txs, fee_lamports: feeLamports });
        }
      }
    }

    if (dryRun) {
      log("limit_order", `[LIMIT_ORDER_CLOSE] DRY_RUN ${short}: ${summary.side} ${summary.filled_pct}% filled, ${binIds.length} bin(s), ${simulated} tx simulated OK (${unitsConsumed} CU) — nothing sent`);
      return {
        success: true, dry_run: true, simulated: true, ...base,
        returned: { base: summary.expected.base, base_symbol: summary.base_symbol, sol: summary.expected.sol, source: "order_account", ...(summary.expected.quote ? { quote: summary.expected.quote } : {}) },
        rent_sol: orderRentLamports / 1e9, txs: [], fee_lamports: 0,
        bins: binIds.length, simulated_txs: simulated, units_consumed: unitsConsumed,
      };
    }

    // 5. Afterwards: the account must be gone; what came back is read from the
    //    confirmed transactions (wallet SOL and token changes), with the order's own
    //    pre-cancel figures as the fallback when a transaction cannot be read.
    invalidate(d);
    const after = await readOrder().catch(() => undefined);
    const closed = after === null;
    const returned = { base: 0, base_symbol: summary.base_symbol, sol: 0, source: "tx_meta" };
    let solLamports = 0;
    let rentLamports = 0;
    let readAll = txs.length > 0;
    for (const sig of txs) {
      let got = null;
      for (let a = 0; a < 4 && !got; a++) {
        const ptx = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
        got = ptx ? returnedFromTxMeta(ptx, { wallet: walletStr, baseMint: summary.base_mint, order: orderStr }) : null;
        if (!got && a < 3) await new Promise((r) => setTimeout(r, d.metaRetryMs ?? 800));
      }
      if (!got) { readAll = false; break; }
      returned.base += got.base;
      solLamports += got.sol_lamports;
      rentLamports += got.order_rent_lamports;
    }
    if (readAll) {
      returned.sol = solLamports / 1e9;
    } else {
      returned.base = summary.expected.base;
      returned.sol = summary.expected.sol;
      returned.source = "order_account";
      rentLamports = closed ? orderRentLamports : 0;
    }
    const result = { ...base, returned, rent_sol: rentLamports / 1e9, txs, fee_lamports: feeLamports };
    if (!closed) {
      log("limit_order", `[LIMIT_ORDER_CLOSE] ${short}: transactions landed but the order account still exists (${after === undefined ? "re-read failed" : "bins remain"})`);
      return fail("not_closed", "The transactions landed but the order account still exists — check it in the Meteora UI", result);
    }
    log("limit_order", `[LIMIT_ORDER_CLOSE] ${summary.pool_name || poolStr.slice(0, 8)} ${summary.side} ${orderStr}: closed (${summary.filled_pct}% filled, ${binIds.length} bin(s)) — returned ${returned.base} ${summary.base_symbol || "base"} + ◎${returned.sol.toFixed(6)} (${returned.source}), rent ◎${(rentLamports / 1e9).toFixed(6)}, fee ${feeLamports} lamports, tx ${txs.join(", ") || "n/a"}`);
    return { success: true, ...result };
  } catch (e) {
    log("limit_order", `[LIMIT_ORDER_CLOSE] ${short}: error — ${e.message}`);
    return fail("internal", e.message, { txs, fee_lamports: feeLamports });
  }
}

function invalidate(d) {
  try { (d.invalidate || invalidateLimitOrderCaches)(); } catch { /* cache only */ }
}
