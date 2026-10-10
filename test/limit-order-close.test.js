process.env.OPENAI_API_KEY = "mock-key";
process.env.PERSIST_BACKEND = "json";
delete process.env.DRY_RUN;

// Operator feature 2026-10-11: closing (cancelling / withdrawing) a Meteora DLMM limit
// order through the bot wallet. Everything here is offline: the pool, connection and
// sender are stubs, and the "what the chain expects" side comes from recorded
// Meteora-UI transactions of the bot wallet (test/fixtures/limit-order-close.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

const mod = await import("../tools/limit-order-close.js");
const {
  closeLimitOrder, inspectLimitOrder, selectCancelBinIds, chunkBinIds, validateOrderOwnership, summarizeOrder,
  decodeLimitOrderHeader, describeProgramError, returnedFromTxMeta, httpStatusForCloseResult,
  parseCloseLimitOrderBody, buildCloseTransaction, describeInstructions, stripCloseIfEmpty,
  DLMM_PROGRAM_ID, WSOL_MINT, SEND_LABEL, CANCEL_BINS_PER_TX,
  LIMIT_ORDER_ACCOUNT_DISCRIMINATOR, CANCEL_LIMIT_ORDER_DISCRIMINATOR, CLOSE_LIMIT_ORDER_IF_EMPTY_DISCRIMINATOR,
} = mod;
const { normalizeOpenOrderRow, listOpenLimitOrders, getOpenLimitOrderValue, invalidateLimitOrderCaches } = await import("../limit-orders.js");
const menu = await import("../limit-order-menu.js");
const { sanitizeTelegramHTML } = await import("../telegram.js");

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/limit-order-close.json", import.meta.url), "utf8"));
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DLMM = new PublicKey(DLMM_PROGRAM_ID);
const WALLET = Keypair.generate();
const OTHER = Keypair.generate().publicKey;
const POOL = Keypair.generate().publicKey;
const POOL2 = Keypair.generate().publicKey;
const ORDER = Keypair.generate().publicKey;
const BASE_MINT = Keypair.generate().publicKey;
const BLOCKHASH = PublicKey.default.toBase58();

const bin = (binId, over = {}) => ({ binId, empty: false, isAskSide: true, status: 0, ...over });
const askOrder = (bins, over = {}) => ({
  limitOrderBinData: bins,
  totalDepositAmountX: "1000", totalDepositAmountY: "0",
  totalFilledAmountX: "0", totalFilledAmountY: "0",
  transferFeeExcludedWithdrawableAmountX: "1000", transferFeeExcludedWithdrawableAmountY: "0",
  ...over,
});

// ─── pure helpers ──────────────────────────────────────────────

test("selectCancelBinIds: only bins still holding something, from the account, sorted and unique", () => {
  const order = { limitOrderBinData: [bin(-270), bin(-279), bin(-275, { empty: true }), bin(-279), bin("x"), null] };
  assert.deepEqual(selectCancelBinIds(order), [-279, -270]);
  assert.deepEqual(selectCancelBinIds({ limitOrderBinData: [bin(5, { empty: true })] }), []);
  assert.deepEqual(selectCancelBinIds(null), []);
  // a 100 %-filled bin is NOT empty: cancelling is how its proceeds are withdrawn
  assert.deepEqual(selectCancelBinIds({ limitOrderBinData: [bin(7, { status: 2 })] }), [7]);
});

test("chunkBinIds: 20 per transaction by default, nothing lost", () => {
  const ids = Array.from({ length: 50 }, (_, i) => i - 25);
  const chunks = chunkBinIds(ids);
  assert.equal(CANCEL_BINS_PER_TX, 20);
  assert.deepEqual(chunks.map((c) => c.length), [20, 20, 10]);
  assert.deepEqual(chunks.flat(), ids);
  assert.deepEqual(chunkBinIds([1, 2, 3], 2), [[1, 2], [3]]);
  assert.deepEqual(chunkBinIds([], 20), []);
  assert.deepEqual(chunkBinIds([1, 2], 0), [[1, 2]]); // a bad size falls back to the default
});

test("validateOrderOwnership: owner and pool must both match, with distinct codes", () => {
  const order = { owner: WALLET.publicKey.toBase58(), lbPair: POOL.toBase58() };
  assert.deepEqual(validateOrderOwnership(order, WALLET.publicKey, POOL), { ok: true });
  assert.equal(validateOrderOwnership({ ...order, owner: OTHER }, WALLET.publicKey, POOL).code, "not_owned");
  assert.equal(validateOrderOwnership(order, WALLET.publicKey, POOL2).code, "pool_mismatch");
  assert.equal(validateOrderOwnership({}, WALLET.publicKey, POOL).code, "not_found");
  // ownership is checked before the pool: someone else's order is "not owned" whatever the pool
  assert.equal(validateOrderOwnership({ owner: OTHER, lbPair: POOL2 }, WALLET.publicKey, POOL).code, "not_owned");
});

test("summarizeOrder: side, fill and the expected proceeds per leg", () => {
  const info = { name: "HOTBOT-SOL", tokenXMint: BASE_MINT.toBase58(), tokenYMint: WSOL_MINT, tokenXSymbol: "HOTBOT", tokenYSymbol: "SOL" };
  const unfilledAsk = summarizeOrder(askOrder([bin(-279)], { totalDepositAmountX: "8835.670465", transferFeeExcludedWithdrawableAmountX: "8835.670465", binCount: 1 }), info);
  assert.equal(unfilledAsk.side, "ask");
  assert.equal(unfilledAsk.filled_pct, 0);
  assert.equal(unfilledAsk.fully_filled, false);
  assert.deepEqual(unfilledAsk.expected, { base: 8835.670465, base_symbol: "HOTBOT", sol: 0 });
  assert.equal(unfilledAsk.base_mint, BASE_MINT.toBase58());

  const filledAsk = summarizeOrder(askOrder([bin(-279, { status: 2 })], { totalFilledAmountX: "1000", transferFeeExcludedWithdrawableAmountX: "0", transferFeeExcludedWithdrawableAmountY: "0.55" }), info);
  assert.equal(filledAsk.filled_pct, 100);
  assert.equal(filledAsk.fully_filled, true);
  assert.deepEqual(filledAsk.expected, { base: 0, base_symbol: "HOTBOT", sol: 0.55 });

  // the live 16-bin bid seen on 2026-10-11: 13 of 16 bins filled
  const bid = summarizeOrder({
    limitOrderBinData: Array.from({ length: 16 }, (_, i) => bin(-302 + i, { isAskSide: false })),
    totalDepositAmountX: "0", totalDepositAmountY: "0.05", totalFilledAmountX: "0", totalFilledAmountY: "0.040625",
    transferFeeExcludedWithdrawableAmountX: "758.314282", transferFeeExcludedWithdrawableAmountY: "0.009375", binCount: 16,
  }, info);
  assert.equal(bid.side, "bid");
  assert.equal(bid.filled_pct, 81.25);
  assert.equal(bid.fully_filled, false);
  assert.equal(bid.open_bins, 16);
  assert.deepEqual(bid.expected, { base: 758.314282, base_symbol: "HOTBOT", sol: 0.009375 });

  // SOL as token X: the other token is the base leg
  const flipped = summarizeOrder(askOrder([bin(1)], { transferFeeExcludedWithdrawableAmountX: "2", transferFeeExcludedWithdrawableAmountY: "30" }), { tokenXMint: WSOL_MINT, tokenYMint: BASE_MINT.toBase58(), tokenXSymbol: "SOL", tokenYSymbol: "USDX" });
  assert.deepEqual(flipped.expected, { base: 30, base_symbol: "USDX", sol: 2 });
  // no SOL leg at all: token Y is reported as the quote
  const noSol = summarizeOrder(askOrder([bin(1)], { transferFeeExcludedWithdrawableAmountY: "7" }), { tokenXMint: BASE_MINT.toBase58(), tokenYMint: OTHER.toBase58(), tokenXSymbol: "AAA", tokenYSymbol: "USDC" });
  assert.equal(noSol.expected.sol, 0);
  assert.deepEqual(noSol.expected.quote, { amount: 7, symbol: "USDC" });
});

function orderAccountData({ lbPair = POOL, owner = WALLET.publicKey, binCount = 1, disc = LIMIT_ORDER_ACCOUNT_DISCRIMINATOR } = {}) {
  const buf = Buffer.alloc(8 + 112 + binCount * 32);
  Buffer.from(disc).copy(buf, 0);
  lbPair.toBuffer().copy(buf, 8);
  owner.toBuffer().copy(buf, 40);
  buf.writeUInt16LE(binCount, 72);
  return buf;
}

test("decodeLimitOrderHeader: lb_pair, owner, bin_count; anything else is not an order", () => {
  assert.deepEqual(decodeLimitOrderHeader(orderAccountData({ binCount: 15 })), { lbPair: POOL.toBase58(), owner: WALLET.publicKey.toBase58(), binCount: 15 });
  assert.equal(decodeLimitOrderHeader(orderAccountData({ disc: [1, 2, 3, 4, 5, 6, 7, 8] })), null);
  assert.equal(decodeLimitOrderHeader(Buffer.alloc(10)), null);
  assert.equal(decodeLimitOrderHeader(null), null);
});

test("describeProgramError names the DLMM error", () => {
  const idl = [{ code: 6106, name: "InvalidLimitOrderOwner", msg: "Invalid limit order owner" }];
  assert.match(describeProgramError({ InstructionError: [2, { Custom: 6106 }] }, idl), /instruction 2: InvalidLimitOrderOwner \(6106\)/);
  assert.match(describeProgramError({ InstructionError: [2, { Custom: 1 }] }, idl), /custom program error 1 \(0x1\)/);
  assert.match(describeProgramError({ InstructionError: [0, "ProgramFailedToComplete"] }), /instruction 0: ProgramFailedToComplete/);
  assert.equal(describeProgramError("BlockhashNotFound"), "BlockhashNotFound");
  assert.equal(describeProgramError(null), null);
});

// ─── command-handler input validation and status mapping ───────

test("command body: both addresses must be base58 public keys", () => {
  const pool = POOL.toBase58(), order = ORDER.toBase58();
  assert.deepEqual(parseCloseLimitOrderBody({ pool, order }), { ok: true, pool, order });
  assert.deepEqual(parseCloseLimitOrderBody({ pool: ` ${pool} `, order }), { ok: true, pool, order });
  assert.match(parseCloseLimitOrderBody({ order }).error, /`pool`/);
  assert.match(parseCloseLimitOrderBody({ pool }).error, /`order`/);
  assert.match(parseCloseLimitOrderBody({ pool, order: "not-base58-0OIl" }).error, /`order`/);
  assert.match(parseCloseLimitOrderBody({ pool: 42, order }).error, /`pool`/);
  assert.match(parseCloseLimitOrderBody({ pool, order: "1".repeat(50) }).error, /`order`/);
  assert.match(parseCloseLimitOrderBody({ pool, order: pool }).error, /different/);
  assert.equal(parseCloseLimitOrderBody(null).ok, false);
});

test("HTTP status per result (the contract the dashboard codes to)", () => {
  assert.equal(httpStatusForCloseResult({ success: true }), 200);
  assert.equal(httpStatusForCloseResult({ success: true, already_closed: true }), 200);
  assert.equal(httpStatusForCloseResult({ success: false, code: "invalid_input" }), 400);
  assert.equal(httpStatusForCloseResult({ success: false, code: "pool_not_found" }), 404);
  assert.equal(httpStatusForCloseResult({ success: false, code: "not_found" }), 404);
  for (const code of ["not_owned", "pool_mismatch", "busy", "insufficient_sol"]) assert.equal(httpStatusForCloseResult({ success: false, code }), 409, code);
  assert.equal(httpStatusForCloseResult({ success: false, code: "rpc_error" }), 502);
  for (const code of ["simulation_failed", "send_failed", "not_closed", "internal", undefined]) assert.equal(httpStatusForCloseResult({ success: false, code }), 500, String(code));
});

// ─── closeLimitOrder with a stubbed pool / connection ──────────

const dlmmIx = (disc, tag = 0) => new TransactionInstruction({ programId: DLMM, keys: [{ pubkey: ORDER, isSigner: false, isWritable: true }], data: Buffer.from([...disc, tag]) });
const otherIx = (programId) => new TransactionInstruction({ programId: new PublicKey(programId), keys: [], data: Buffer.from([1]) });

function harness({
  orderData = orderAccountData(), orderOwnerProgram = DLMM, poolOwnerProgram = DLMM, parsed = askOrder([bin(-279)]),
  lamports = 1e9, simErr = null, dryRun = false, sendImpl = null, goneAfterSend = true, parsedTx = null, returnArray = false,
} = {}) {
  const calls = { cancel: [], closeIfEmpty: 0, simulate: [], send: [], invalidate: 0, getLimitOrder: 0 };
  let orderExists = orderData != null;
  const conn = {
    async getAccountInfo(pk) {
      const k = pk.toBase58();
      if (k === POOL.toBase58() || k === POOL2.toBase58()) return poolOwnerProgram ? { owner: poolOwnerProgram, data: Buffer.alloc(8), lamports: 1 } : null;
      if (k === ORDER.toBase58()) return orderExists ? { owner: orderOwnerProgram, data: orderData, lamports: 1_422_400 } : null;
      return null;
    },
    async getBalance() { return lamports; },
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 1 }; },
    async simulateTransaction(vtx, cfg) {
      calls.simulate.push({ ixCount: vtx.message.compiledInstructions.length, cfg });
      return { value: { err: typeof simErr === "function" ? simErr(calls.simulate.length) : simErr, logs: ["Program log: Instruction: CancelLimitOrder"], unitsConsumed: 55_000 } };
    },
    async getParsedTransaction() { return parsedTx; },
    sendTransaction() { throw new Error("the module must send through deps.send only"); },
    sendRawTransaction() { throw new Error("the module must send through deps.send only"); },
  };
  const pool = {
    tokenX: { mint: { address: BASE_MINT } },
    tokenY: { mint: { address: new PublicKey(WSOL_MINT) } },
    async getLimitOrder() { calls.getLimitOrder++; return { publicKey: ORDER, limitOrderData: parsed }; },
    async cancelLimitOrder(args) {
      calls.cancel.push(args);
      const tx = new Transaction({ feePayer: args.owner, recentBlockhash: BLOCKHASH }).add(
        otherIx(ATA_PROGRAM), otherIx(ATA_PROGRAM), dlmmIx(CANCEL_LIMIT_ORDER_DISCRIMINATOR, args.binIds.length),
        otherIx(TOKEN_PROGRAM), dlmmIx(CLOSE_LIMIT_ORDER_IF_EMPTY_DISCRIMINATOR),
      );
      return returnArray ? [tx] : tx;
    },
    async closeLimitOrderIfEmpty(args) {
      calls.closeIfEmpty++;
      return new Transaction({ feePayer: args.owner, recentBlockhash: BLOCKHASH }).add(dlmmIx(CLOSE_LIMIT_ORDER_IF_EMPTY_DISCRIMINATOR));
    },
  };
  const deps = {
    dryRun,
    metaRetryMs: 1,
    getConnection: () => conn,
    getWallet: () => WALLET,
    getPool: async () => pool,
    getPoolMetadata: async () => ({ name: "HOTBOT-SOL", token_x_symbol: "HOTBOT", token_y_symbol: "SOL" }),
    getSdk: async () => ({ IDL: { errors: [{ code: 6106, name: "InvalidLimitOrderOwner", msg: "Invalid limit order owner" }] } }),
    invalidate: () => { calls.invalidate++; },
    send: async (c, tx, signers, label) => {
      calls.send.push({ label, signers, ix: describeInstructions(tx) });
      if (sendImpl) return sendImpl(calls.send.length, () => { orderExists = false; });
      if (goneAfterSend) orderExists = false;
      return { txHash: `sig${calls.send.length}`, fee: 6000 };
    },
  };
  const run = (over = {}) => closeLimitOrder({ pool_address: POOL.toBase58(), order_address: ORDER.toBase58(), ...over }, deps);
  return { run, calls, deps };
}

test("refuses an order that is not the bot wallet's (no build, no simulation, no send)", async () => {
  const h = harness({ orderData: orderAccountData({ owner: OTHER }) });
  const r = await h.run();
  assert.equal(r.success, false);
  assert.equal(r.code, "not_owned");
  assert.match(r.error, /not to the bot wallet/);
  assert.equal(h.calls.getLimitOrder, 0, "refused on the raw header, before the SDK parses bins");
  assert.equal(h.calls.cancel.length + h.calls.simulate.length + h.calls.send.length, 0);
  assert.equal(httpStatusForCloseResult(r), 409);
});

test("refuses an order that belongs to another pool", async () => {
  const h = harness({ orderData: orderAccountData({ lbPair: POOL2 }) });
  const r = await h.run();
  assert.equal(r.code, "pool_mismatch");
  assert.equal(h.calls.cancel.length + h.calls.simulate.length + h.calls.send.length, 0);
  assert.equal(httpStatusForCloseResult(r), 409);
});

test("an account that is not a limit order, an unknown pool, bad input", async () => {
  assert.equal((await harness({ orderData: orderAccountData({ disc: [9, 9, 9, 9, 9, 9, 9, 9] }) }).run()).code, "not_found");
  assert.equal((await harness({ orderOwnerProgram: new PublicKey(TOKEN_PROGRAM) }).run()).code, "not_found");
  const unknownPool = await harness({ poolOwnerProgram: null }).run();
  assert.equal(unknownPool.code, "pool_not_found");
  assert.equal(httpStatusForCloseResult(unknownPool), 404);
  assert.equal((await harness({ poolOwnerProgram: new PublicKey(TOKEN_PROGRAM) }).run()).code, "pool_not_found");
  const bad = await harness().run({ order_address: "nope" });
  assert.equal(bad.code, "invalid_input");
});

test("a missing order account is success (already closed): idempotent, nothing sent", async () => {
  const h = harness({ orderData: null });
  const r = await h.run();
  assert.equal(r.success, true);
  assert.equal(r.already_closed, true);
  assert.equal(r.pool_name, "HOTBOT-SOL");
  assert.deepEqual(r.returned, { base: 0, base_symbol: "HOTBOT", sol: 0 });
  assert.deepEqual(r.txs, []);
  assert.equal(h.calls.simulate.length + h.calls.send.length, 0);
  assert.equal(h.calls.invalidate, 1, "caches dropped so a stale 'open' row disappears");
  assert.equal(httpStatusForCloseResult(r), 200);
});

test("DRY_RUN: simulates, reports the expected proceeds, sends nothing", async () => {
  const h = harness({ dryRun: true, parsed: askOrder([bin(-279)], { transferFeeExcludedWithdrawableAmountX: "8835.670465" }) });
  const r = await h.run();
  assert.equal(r.success, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.simulated, true);
  assert.equal(h.calls.simulate.length, 1);
  assert.equal(h.calls.send.length, 0);
  assert.deepEqual(r.txs, []);
  assert.equal(r.side, "ask");
  assert.equal(r.returned.base, 8835.670465);
  assert.equal(r.returned.base_symbol, "HOTBOT");
  assert.equal(r.returned.sol, 0);
  assert.equal(r.returned.source, "order_account");
  assert.equal(r.rent_sol, 0.0014224);
  // the simulation never needs a signature
  assert.equal(h.calls.simulate[0].cfg.sigVerify, false);
  assert.equal(h.calls.simulate[0].cfg.replaceRecentBlockhash, true);
});

test("DRY_RUN comes from the environment when not injected", async () => {
  const h = harness();
  delete h.deps.dryRun;
  process.env.DRY_RUN = "true";
  try {
    const r = await h.run();
    assert.equal(r.dry_run, true);
    assert.equal(h.calls.send.length, 0);
  } finally {
    delete process.env.DRY_RUN;
  }
});

test("a simulation error aborts with the program error name; nothing is sent", async () => {
  const h = harness({ simErr: { InstructionError: [2, { Custom: 6106 }] } });
  const r = await h.run();
  assert.equal(r.success, false);
  assert.equal(r.code, "simulation_failed");
  assert.match(r.error, /InvalidLimitOrderOwner \(6106\)/);
  assert.equal(h.calls.send.length, 0);
  assert.equal(httpStatusForCloseResult(r), 500);
});

test("real close: one SDK transaction, exit-tier label, bin ids from the account, proceeds from the tx", async () => {
  const rec = fixture.txs.term_filled_ask_JEANPHIL;
  // the recorded transaction stands in for ours: same wallet-side accounting
  const wallet = { publicKey: new PublicKey(fixture.wallet) };
  const order = rec.transaction.message.instructions.find((ix) => ix.programId === DLMM_PROGRAM_ID && ix.accounts.length === 5).accounts[0];
  const direct = returnedFromTxMeta(rec, { wallet: fixture.wallet, baseMint: "GTBxUiw6wJdmmkCGZgRHLyYxqu1vG4KtRpeox6yDpump", order });
  assert.equal(direct.sol_lamports, 1_306_165_314, "exactly what the pool's SOL reserve paid out");
  assert.equal(direct.base, 0);
  assert.equal(direct.order_rent_lamports, 1_422_400);
  assert.equal(direct.opened_account_rent_lamports, 1_513_840);

  const h = harness({ parsed: askOrder([bin(-279), bin(-278), bin(-277, { empty: true })]), parsedTx: null, returnArray: true });
  const r = await h.run();
  assert.equal(r.success, true);
  assert.equal(h.calls.simulate.length, 1, "simulated before the send");
  assert.equal(h.calls.send.length, 1);
  assert.equal(h.calls.send[0].label, SEND_LABEL);
  assert.match(SEND_LABEL, /^close:/, "close: labels are the exit priority-fee tier");
  assert.deepEqual(h.calls.send[0].signers, [WALLET]);
  assert.deepEqual(h.calls.cancel[0].binIds, [-279, -278]);
  assert.equal(h.calls.cancel[0].owner.toBase58(), WALLET.publicKey.toBase58());
  assert.equal(h.calls.cancel[0].rentReceiver.toBase58(), WALLET.publicKey.toBase58());
  assert.deepEqual(h.calls.send[0].ix.map((i) => i.name || i.programId), [ATA_PROGRAM, ATA_PROGRAM, "CancelLimitOrder", TOKEN_PROGRAM, "CloseLimitOrderIfEmpty"]);
  assert.deepEqual(r.txs, ["sig1"]);
  assert.equal(r.fee_lamports, 6000);
  assert.equal(h.calls.invalidate, 1);
  // getParsedTransaction returned nothing → the order's own figures, flagged
  assert.equal(r.returned.source, "order_account");
  assert.equal(r.returned.base, 1000);
  assert.equal(r.rent_sol, 0.0014224);
  assert.equal(wallet.publicKey.toBase58(), fixture.wallet);
});

test("what came back is read from the confirmed transaction (wallet SOL and token changes)", async () => {
  const ata = Keypair.generate().publicKey.toBase58();
  const proceeds = 500_000_000, ataRent = 2_039_280, orderRent = 1_422_400, fee = 6000;
  const parsedTx = {
    transaction: { message: { accountKeys: [{ pubkey: WALLET.publicKey }, { pubkey: new PublicKey(ata) }, { pubkey: ORDER }], instructions: [] } },
    meta: {
      fee,
      preBalances: [1e9, 0, orderRent],
      postBalances: [1e9 - fee - ataRent + orderRent + proceeds, ataRent, 0],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 1, mint: BASE_MINT.toBase58(), owner: WALLET.publicKey.toBase58(), uiTokenAmount: { amount: "12500000", decimals: 6 } }],
    },
  };
  const r = await harness({ parsedTx }).run();
  assert.equal(r.success, true);
  assert.deepEqual(r.returned, { base: 12.5, base_symbol: "HOTBOT", sol: 0.5, source: "tx_meta" });
  assert.equal(r.rent_sol, 0.0014224);
});

test("multi-bin order: 20 bin ids per transaction, only the last one closes the account", async () => {
  const bins = Array.from({ length: 45 }, (_, i) => bin(100 + i));
  const h = harness({ parsed: askOrder(bins), sendImpl: (n, closeAccount) => { if (n === 3) closeAccount(); return { txHash: `sig${n}`, fee: 5000 }; } });
  const r = await h.run();
  assert.equal(r.success, true);
  assert.deepEqual(h.calls.cancel.map((c) => c.binIds.length), [20, 20, 5]);
  assert.equal(h.calls.simulate.length, 3, "each chunk is simulated right before it is sent");
  const names = h.calls.send.map((s) => s.ix.map((i) => i.name).filter(Boolean));
  assert.deepEqual(names, [["CancelLimitOrder"], ["CancelLimitOrder"], ["CancelLimitOrder", "CloseLimitOrderIfEmpty"]]);
  assert.deepEqual(r.txs, ["sig1", "sig2", "sig3"]);
  assert.equal(r.fee_lamports, 15000);
});

test("an order with no open bins only closes the account", async () => {
  const h = harness({ parsed: askOrder([bin(1, { empty: true })]) });
  const r = await h.run();
  assert.equal(r.success, true);
  assert.equal(h.calls.cancel.length, 0);
  assert.equal(h.calls.closeIfEmpty, 1);
  assert.deepEqual(h.calls.send[0].ix.map((i) => i.name), ["CloseLimitOrderIfEmpty"]);
});

test("a thrown send whose transaction landed (account gone) is a success", async () => {
  const h = harness({ sendImpl: (n, closeAccount) => { closeAccount(); const e = new Error("block height exceeded"); e.confirmedSignature = "landedSig"; throw e; } });
  const r = await h.run();
  assert.equal(r.success, true);
  assert.deepEqual(r.txs, ["landedSig"]);
});

test("a thrown send with the account still there is a failure that reports what landed", async () => {
  const bins = Array.from({ length: 25 }, (_, i) => bin(i));
  const h = harness({ parsed: askOrder(bins), sendImpl: (n) => { if (n === 2) throw new Error("Simulation failed"); return { txHash: "sig1", fee: 5000 }; } });
  const r = await h.run();
  assert.equal(r.success, false);
  assert.equal(r.code, "send_failed");
  assert.deepEqual(r.txs, ["sig1"]);
  assert.match(r.error, /1 earlier transaction/);
  assert.equal(h.calls.invalidate, 1);
  assert.equal(httpStatusForCloseResult(r), 500);
});

test("transactions landed but the account is still there → not_closed", async () => {
  const h = harness({ goneAfterSend: false });
  const r = await h.run();
  assert.equal(r.success, false);
  assert.equal(r.code, "not_closed");
  assert.deepEqual(r.txs, ["sig1"]);
});

test("too little free SOL is refused before anything is built", async () => {
  const h = harness({ lamports: 2_000_000 });
  const r = await h.run();
  assert.equal(r.code, "insufficient_sol");
  assert.match(r.error, /0\.006/);
  assert.equal(h.calls.cancel.length + h.calls.simulate.length + h.calls.send.length, 0);
});

test("inspectLimitOrder is the same read-only check the menu runs at every tap", async () => {
  const open = await inspectLimitOrder({ pool_address: POOL.toBase58(), order_address: ORDER.toBase58() }, harness().deps);
  assert.equal(open.status, "open");
  assert.equal(open.summary.side, "ask");
  assert.equal(open.bins, 1);
  const closed = await inspectLimitOrder({ pool_address: POOL.toBase58(), order_address: ORDER.toBase58() }, harness({ orderData: null }).deps);
  assert.equal(closed.status, "closed");
  const refused = await inspectLimitOrder({ pool_address: POOL.toBase58(), order_address: ORDER.toBase58() }, harness({ orderData: orderAccountData({ owner: OTHER }) }).deps);
  assert.deepEqual([refused.status, refused.code], ["refused", "not_owned"]);
});

// ─── recorded transactions: what the chain accepted ────────────

const SDK = await import("@meteora-ag/dlmm").catch(() => null);
const DlmmClass = SDK?.default?.default || SDK?.default;

test("discriminators match the installed SDK's IDL", { skip: !SDK }, () => {
  const idl = SDK.IDL;
  const ix = (name) => idl.instructions.find((i) => i.name === name).discriminator;
  assert.deepEqual(ix("cancel_limit_order"), CANCEL_LIMIT_ORDER_DISCRIMINATOR);
  assert.deepEqual(ix("close_limit_order_if_empty"), CLOSE_LIMIT_ORDER_IF_EMPTY_DISCRIMINATOR);
  assert.deepEqual([...SDK.getAccountDiscriminator("limitOrder")], LIMIT_ORDER_ACCOUNT_DISCRIMINATOR);
  assert.equal(String(SDK.MAX_BIN_PER_LIMIT_ORDER), "50");
  assert.equal(SDK.LIMIT_ORDER_MIN_SIZE, 112);
});

// Rebuild each recorded Meteora-UI transaction with the SDK builder this module calls
// (offline: a pool object carrying only what cancelLimitOrder reads) and compare.
function poolFromRecorded(rec) {
  const cancel = rec.transaction.message.instructions.find((ix) => ix.programId === DLMM_PROGRAM_ID && ix.accounts?.length > 5);
  const [lbPair, , reserveX, reserveY, mintX, mintY, order, , , owner, progX, progY] = cancel.accounts;
  const conn = { getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }) };
  const pool = Object.create(DlmmClass.prototype);
  Object.assign(pool, {
    pubkey: new PublicKey(lbPair),
    program: SDK.createProgram(conn),
    lbPair: { reserveX: new PublicKey(reserveX), reserveY: new PublicKey(reserveY) },
    tokenX: { mint: { address: new PublicKey(mintX) }, owner: new PublicKey(progX), transferHookAccountMetas: [] },
    tokenY: { mint: { address: new PublicKey(mintY) }, owner: new PublicKey(progY), transferHookAccountMetas: [] },
    opt: {},
  });
  const data = Buffer.from(bs58.decode(cancel.data));
  const n = data.readUInt32LE(8);
  const binIds = Array.from({ length: n }, (_, i) => data.readInt32LE(12 + i * 4));
  return { pool, cancel, order, owner, binIds, data };
}

for (const [name, rec] of Object.entries(fixture.txs)) {
  test(`SDK builder reproduces the recorded transaction: ${name}`, { skip: !SDK }, async () => {
    const { pool, cancel, order, owner, binIds, data } = poolFromRecorded(rec);
    assert.equal(rec.meta.err, null);
    assert.ok(binIds.length >= 1);
    const built = await buildCloseTransaction(pool, { order: new PublicKey(order), owner: new PublicKey(owner), binIds, isLast: true });
    assert.equal(built.length, 1, "the SDK returns ONE legacy Transaction");
    const tx = built[0];
    assert.ok(tx instanceof Transaction);
    assert.equal(tx.feePayer.toBase58(), owner);

    // instruction sequence / program ids: what the UI sent, minus its compute-budget
    // and tip instructions (ours come from the retrying sender's priority fee)
    const recorded = rec.transaction.message.instructions
      .filter((ix) => ix.programId !== "ComputeBudget111111111111111111111111111111" && ix.program !== "system")
      .map((ix) => ix.programId);
    assert.deepEqual(recorded, [ATA_PROGRAM, ATA_PROGRAM, DLMM_PROGRAM_ID, TOKEN_PROGRAM, DLMM_PROGRAM_ID]);
    assert.deepEqual(tx.instructions.map((ix) => ix.programId.toBase58()), recorded);
    assert.deepEqual(describeInstructions(tx).map((i) => i.name), [null, null, "CancelLimitOrder", null, "CloseLimitOrderIfEmpty"]);
    assert.deepEqual(rec.meta.logInstructions.filter((l) => /LimitOrder/.test(l)), ["CancelLimitOrder", "CloseLimitOrderIfEmpty"]);

    // the CancelLimitOrder instruction is byte-identical, with the same accounts in order
    const ours = tx.instructions[2];
    assert.deepEqual([...ours.data], [...data]);
    assert.deepEqual(ours.keys.map((k) => k.pubkey.toBase58()), cancel.accounts);
    // and CloseLimitOrderIfEmpty too
    const recClose = rec.transaction.message.instructions.find((ix) => ix.programId === DLMM_PROGRAM_ID && ix.accounts?.length === 5);
    assert.deepEqual([...tx.instructions[4].data], [...bs58.decode(recClose.data)]);
    assert.deepEqual(tx.instructions[4].keys.map((k) => k.pubkey.toBase58()), recClose.accounts);
    // wSOL unwrap = closeAccount of the wallet's wSOL account back to the wallet
    const recUnwrap = rec.transaction.message.instructions.find((ix) => ix.parsed?.type === "closeAccount").parsed.info;
    assert.deepEqual(tx.instructions[3].keys.map((k) => k.pubkey.toBase58()), [recUnwrap.account, recUnwrap.destination, recUnwrap.owner]);

    // a non-final chunk is the same transaction without the account close
    const [partial] = await buildCloseTransaction(pool, { order: new PublicKey(order), owner: new PublicKey(owner), binIds, isLast: false });
    assert.deepEqual(describeInstructions(partial).map((i) => i.name), [null, null, "CancelLimitOrder", null]);
    assert.equal(stripCloseIfEmpty(partial).instructions.length, 4);
  });
}

test("returnedFromTxMeta on the recorded transactions: each side pays out the right leg", () => {
  const out = {};
  for (const [name, rec] of Object.entries(fixture.txs)) {
    const cancel = rec.transaction.message.instructions.find((ix) => ix.programId === DLMM_PROGRAM_ID && ix.accounts?.length > 5);
    out[name] = returnedFromTxMeta(rec, { wallet: fixture.wallet, baseMint: cancel.accounts[4], order: cancel.accounts[6] });
    assert.ok(out[name].order_rent_lamports > 0, `${name}: the order account's rent came back`);
    assert.equal(out[name].fee_lamports, rec.meta.fee);
  }
  // unfilled ask → the tokens come back, no SOL
  assert.ok(out.term_cancel_unfilled_ask_JEANPHIL.base > 0);
  assert.equal(out.term_cancel_unfilled_ask_JEANPHIL.sol_lamports, 0);
  assert.equal(out.term_cancel_unfilled_ask_HOTBOT.sol_lamports, 0);
  assert.ok(Math.abs(out.term_cancel_unfilled_ask_HOTBOT.base - 8835.670465) < 1e-6, "Token-2022 ask: the full deposit back");
  // filled ask → SOL, no tokens
  assert.equal(out.term_filled_ask_JEANPHIL.base, 0);
  assert.equal(out.term_filled_ask_JEANPHIL.sol_lamports, 1_306_165_314);
  // unfilled bid → the SOL comes back, no tokens
  assert.equal(out.term_cancel_unfilled_bid_STACY.base, 0);
  assert.ok(out.term_cancel_unfilled_bid_STACY.sol_lamports > 0);
  // filled bid → tokens, no SOL
  assert.ok(out.term_filled_bid_GOLD.base > 0);
  assert.equal(out.term_filled_bid_GOLD.sol_lamports, 0);
  assert.equal(returnedFromTxMeta({ meta: null }, { wallet: fixture.wallet }), null);
});

// ─── feed rows, caches, menu ───────────────────────────────────

test("feed row → menu row; rows without an order address are UI-only", () => {
  const row = normalizeOpenOrderRow(fixture.feed_open.row, fixture.feed_open.pool);
  assert.equal(row.address, "EJV68m6HWqvBPVy4RQxPzF1RYsSXrYkW26zptyqMvnc6");
  assert.equal(row.pool, "6D4EWF22HfQamimKhX47tqiu9DVCkcxDMrmhnSvewKAo");
  assert.equal(row.pair, "HOTBOT-SOL");
  assert.equal(row.side, "ask");
  assert.equal(row.input_amount, 8835.670465);
  assert.equal(row.filled_pct, 0);
  assert.equal(row.fully_filled, false);
  assert.ok(Math.abs(row.value_sol - 0.5070143656654555) < 1e-12);
  assert.equal(row.bins, 1);

  const noAddr = normalizeOpenOrderRow({ ...fixture.feed_open.row, limit_order_address: undefined }, fixture.feed_open.pool);
  assert.equal(noAddr.address, null);
  const m = menu.renderOrdersMenu([row, noAddr]);
  assert.equal(m.keyboard.length, 2, "one order button + the controls row");
  assert.equal(m.keyboard[0][0].callback_data, `ord:view:${row.address}`);
  assert.ok(Buffer.byteLength(`ord:confirm:${row.address}`) <= 64, "fits Telegram's callback_data limit");
  assert.match(m.text, /Close in the Meteora UI/);
  assert.match(m.text, /2 open/);
  assert.match(menu.renderOrdersMenu([]).text, /No open limit orders/);
  assert.equal(sanitizeTelegramHTML(m.text), m.text, "already valid Telegram HTML");
});

test("cards: 'Cancel order' vs 'Withdraw proceeds', confirm-gated, results", () => {
  const row = normalizeOpenOrderRow(fixture.feed_open.row, fixture.feed_open.pool);
  const info = { name: "HOTBOT-SOL", tokenXMint: fixture.feed_open.pool.token_x_mint, tokenYMint: WSOL_MINT, tokenXSymbol: "HOTBOT", tokenYSymbol: "SOL" };
  const open = { status: "open", bins: 1, rent_sol: 0.0014224, summary: summarizeOrder(askOrder([bin(-279)]), info) };
  const filled = { ...open, summary: summarizeOrder(askOrder([bin(-279, { status: 2 })], { totalFilledAmountX: "1000", transferFeeExcludedWithdrawableAmountX: "0", transferFeeExcludedWithdrawableAmountY: "0.55" }), info) };
  assert.equal(menu.closeActionLabel(false), "Cancel order");
  assert.equal(menu.closeActionLabel(true), "Withdraw proceeds");

  const card = menu.renderOrderCard(row, open);
  assert.match(card.keyboard[0][0].text, /Cancel order/);
  assert.equal(card.keyboard[0][0].callback_data, `ord:confirm:${row.address}`, "the card leads to the confirm card, never straight to the close");
  assert.match(menu.renderOrderCard(row, filled).keyboard[0][0].text, /Withdraw proceeds/);

  const confirm = menu.renderConfirmOrderCard(row, filled, { dryRun: true });
  assert.match(confirm.text, /Confirm: Withdraw proceeds/);
  assert.match(confirm.text, /DRY_RUN/);
  assert.equal(confirm.keyboard[0][0].callback_data, `ord:go:${row.address}`);
  assert.equal(confirm.keyboard[1][0].callback_data, `ord:view:${row.address}`);
  assert.doesNotMatch(menu.renderConfirmOrderCard(row, open).text, /DRY_RUN/);

  const ok = menu.renderOrderCloseResult({ success: true, pool_name: "A<B-SOL", side: "ask", filled_pct: 0, returned: { base: 8835.670465, base_symbol: "HOTBOT", sol: 0 }, rent_sol: 0.0014224, txs: ["5TtW"] }, { source: "dashboard" });
  assert.match(ok, /Limit order closed — A&lt;B-SOL/);
  assert.match(ok, /8,835\.670465 HOTBOT/);
  assert.match(ok, /solscan\.io\/tx\/5TtW/);
  assert.equal(sanitizeTelegramHTML(ok), ok);
  assert.match(menu.renderOrderCloseResult({ success: true, dry_run: true, pool_name: "X-SOL", returned: { base: 0, sol: 0.5 }, rent_sol: 0.001 }), /nothing was sent/);
  assert.match(menu.renderOrderCloseResult({ success: true, already_closed: true, pool_name: "X-SOL" }), /already closed/);
  const failed = menu.renderOrderCloseResult({ success: false, error: "Simulation failed: instruction 2 < bad >" }, { pair: "X-SOL" });
  assert.match(failed, /not closed/);
  assert.equal(sanitizeTelegramHTML(failed), failed);
});

test("listOpenLimitOrders reads the feed uncached; invalidateLimitOrderCaches drops the value cache", async () => {
  let calls = 0;
  const page = (data) => ({ ok: true, json: async () => ({ data, pages: 1 }) });
  const fetchImpl = async (url) => {
    calls++;
    if (url.includes("/open/pools/6D4E")) return page([fixture.feed_open.row]);
    if (url.includes("/open/pools?")) return page([{ pool: fixture.feed_open.pool, total_orders: 1, total_current_value_sol: "0.51", total_current_value_usd: "56.2" }]);
    return page([]);
  };
  const rows = await listOpenLimitOrders("W1", { fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pair, "HOTBOT-SOL");
  assert.equal(rows[0].pool, fixture.feed_open.pool.pool_address);
  await listOpenLimitOrders("W1", { fetchImpl });
  assert.equal(calls, 4, "two requests per listing, no cache");

  invalidateLimitOrderCaches();
  calls = 0;
  const now = Date.now();
  assert.equal((await getOpenLimitOrderValue("W1", { fetchImpl, now })).sol, 0.51);
  await getOpenLimitOrderValue("W1", { fetchImpl, now: now + 1000 });
  assert.equal(calls, 1, "cached for 60 s");
  invalidateLimitOrderCaches();
  await getOpenLimitOrderValue("W1", { fetchImpl, now: now + 2000 });
  assert.equal(calls, 2, "refetched right after an order close");
  invalidateLimitOrderCaches();
});

// ─── source-level: operator-only wiring ────────────────────────

test("closing a limit order is operator-only: not an LLM tool, no auto-swap", () => {
  const defs = read("../tools/definitions.js");
  assert.doesNotMatch(defs, /limit[_-]?order|closeLimitOrder|cancelLimitOrder/i);
  const executor = read("../tools/executor.js");
  assert.doesNotMatch(executor, /limit-order-close|closeLimitOrder|close_limit_order/);
  const agent = read("../agent.js");
  assert.doesNotMatch(agent, /limit[_-]?order|closeLimitOrder/i);
  const src = read("../tools/limit-order-close.js");
  assert.doesNotMatch(src, /swapToken|swapBaseToSol|executeTool|sweepWalletDust|from "\.\/wallet\.js"|from "\.\/executor\.js"/, "returned tokens stay in the wallet");
  assert.doesNotMatch(src, /sendTransaction|sendRawTransaction|sendAndConfirmTransaction/, "sends only through the shared retrying sender");
  assert.match(src, /simulateTransaction/);
  const dlmm = read("../tools/dlmm.js");
  assert.match(dlmm, /export function limitOrderCloseAccess\(\)/);
  assert.match(dlmm, /const EXIT_URGENCY_LABEL_PREFIXES = \["close:"\]/);
});

test("index.js: the endpoint, the shared close slot and the confirm-gated /orders menu", () => {
  const index = read("../index.js");
  assert.match(index, /url === "\/command\/close-limit-order"[\s\S]{0,200}handleCommandCloseLimitOrder\(req, res\)/);
  const handler = index.slice(index.indexOf("async function handleCommandCloseLimitOrder"), index.indexOf("function startCommandServer"));
  assert.match(handler, /x-meridian-token"\] !== COMMAND_TOKEN[\s\S]{0,120}401/);
  assert.match(handler, /parseCloseLimitOrderBody\(body\)[\s\S]{0,120}commandJson\(res, 400/);
  assert.match(handler, /httpStatusForCloseResult\(result\)/);
  assert.match(handler, /!result\.dry_run && !result\.already_closed[\s\S]{0,120}sendHTML\(renderOrderCloseResult/);
  const runner = index.slice(index.indexOf("async function runLimitOrderClose"), index.indexOf("async function handleCommandCloseLimitOrder"));
  assert.match(runner, /if \(_commandCloseInFlight\) \{[\s\S]{0,120}code: "busy"/);
  assert.match(runner, /_commandCloseInFlight = true;[\s\S]*finally \{\s*_commandCloseInFlight = false;/);
  assert.equal((index.match(/closeLimitOrder\(\{/g) || []).length, 1, "exactly one call site, inside the slot");

  assert.match(index, /if \(text === "\/orders"\) \{/);
  assert.match(index, /text\.startsWith\("ord:"\)/);
  const cb = index.slice(index.indexOf("async function handleOrdersMenuCallback"), index.indexOf("async function showPositionsMenu"));
  // every view / confirm / go tap re-reads the feed row and the order account first
  assert.ok(cb.indexOf("inspectLimitOrder(") > 0 && cb.indexOf("inspectLimitOrder(") < cb.indexOf('action === "view"'));
  assert.ok(cb.indexOf("runLimitOrderClose(") > cb.indexOf('action === "confirm"'), "the close only runs from the go branch");
  assert.equal((index.match(/runLimitOrderClose\(\{/g) || []).length, 3, "definition + dashboard + Telegram go");
  const tg = read("../telegram.js");
  assert.match(tg, /command: "orders"/);
});
