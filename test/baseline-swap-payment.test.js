process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// 2026-11-25: three Jupiter "QR code pay" payments (the wallet's SOL swapped to USDC, the USDC
// delivered straight to a merchant) were not booked as baseline withdrawals. The plain
// classifier takes only System-program sends, the untracked-swap bucket needs a token change on
// a wallet-owned account, and the payment's temporary wSOL / USDC accounts are opened and closed
// inside the transaction. Fixtures are the real parsed transactions (public chain data).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/baseline-swap-payment.json", import.meta.url), "utf8"));
const W = fx.wallet;
const T = fx.txs;
const {
  classifySwapPayment, classifyBaselineWithdrawal, classifyWithdrawal, classifyTokenSwap,
  planBaselineBackfill, applyBaselineBackfill,
} = await import("../baseline-classify.js");
const wallet = await import("../tools/wallet.js");
const { agentStoppedVerdict, HEARTBEAT_STALE_MS } = await import("../scripts/backfill_baseline_payments.js");

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const clone = (o) => JSON.parse(JSON.stringify(o));
const sig = (name) => ({ signature: T[name].signature, blockTime: T[name].blockTime });
const book = (name) => classifyBaselineWithdrawal(T[name].tx, W, sig(name));

test("the three QR payments are swap-payment withdrawals of the SOL spent", () => {
  const expected = { qr_pay_1: [0.088993193, 6.0818], qr_pay_2: [0.120957271, 8.2812], qr_pay_3: [0.195334706, 13.3887] };
  for (const [name, [sol, usdc]] of Object.entries(expected)) {
    const w = book(name);
    assert.ok(w, name);
    assert.equal(w.withdrawal_type, "swap_payment");
    assert.ok(Math.abs(w.amount - sol) < 1e-9, `${name}: ${w.amount}`);
    assert.equal(w.delivered_mint, USDC);
    assert.ok(Math.abs(w.delivered_amount - usdc) < 1e-9);
    assert.notEqual(w.delivered_to, W);
    assert.equal(w.signature, T[name].signature);
    assert.equal(w.timestamp, new Date(T[name].blockTime * 1000).toISOString());
    // What the old code saw: not a plain send, not an untracked swap.
    assert.equal(classifyWithdrawal(T[name].tx, W).isWithdrawal, false);
    assert.equal(classifyTokenSwap(T[name].tx, W), null);
  }
});

test("the relayer paid the fee; when the wallet pays it, it is left out (as for a plain send)", () => {
  const tx = clone(T.qr_pay_1.tx);
  const keys = tx.transaction.message.accountKeys;
  const wi = keys.findIndex((k) => k.pubkey === W);
  assert.notEqual(wi, 0, "fee payer in the real payment is the relayer");
  // Make the wallet the fee payer: swap it to index 0 and charge the fee to it.
  const swapIdx = (arr) => { [arr[0], arr[wi]] = [arr[wi], arr[0]]; };
  swapIdx(keys); swapIdx(tx.meta.preBalances); swapIdx(tx.meta.postBalances);
  for (const b of [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]) {
    if (b.accountIndex === 0) b.accountIndex = wi; else if (b.accountIndex === wi) b.accountIndex = 0;
  }
  tx.meta.postBalances[0] -= tx.meta.fee;
  const r = classifySwapPayment(tx, W);
  assert.equal(r.isPayment, true);
  assert.ok(Math.abs(r.amount - 0.088993193) < 1e-9, String(r.amount));
});

test("negatives: bot swaps, DLMM operations, UI zap legs, limit orders, burns, housekeeping", () => {
  for (const name of [
    "bot_exit_swap_jupiter", "bot_exit_swap_multihop_usdc", "dlmm_deploy", "dlmm_close", "dlmm_claim",
    "ui_rebalance_withdraw", "ui_zap_rebalance_leg", "ui_zap_swap_leg", "ui_zap_deposit_leg",
    "token_account_close", "token22_account_close", "small_system_send", "limit_order_place",
    "limit_order_cancel", "burn", "deposit_in",
  ]) {
    assert.equal(classifySwapPayment(T[name].tx, W).isPayment, false, name);
    assert.equal(book(name), null, name);
  }
});

test("an untracked token buy (token comes back to the wallet) stays in the token-swap bucket", () => {
  // The UI zap's swap leg is exactly that shape: wSOL out, the base token into the wallet.
  const tx = T.ui_zap_swap_leg.tx;
  assert.equal(classifySwapPayment(tx, W).isPayment, false);
  const s = classifyTokenSwap(tx, W);
  assert.ok(s && s.sol < 0 && s.tokens > 0);
});

test("a failed payment, a limit-order placement and a DLMM operation are never payments", () => {
  const failed = clone(T.qr_pay_1.tx); failed.meta.err = { InstructionError: [6, { Custom: 1 }] };
  assert.equal(classifySwapPayment(failed, W).isPayment, false);
  const lo = clone(T.qr_pay_1.tx); lo.meta.logMessages.push("Program log: Instruction: PlaceLimitOrder");
  assert.equal(classifySwapPayment(lo, W).isPayment, false);
  const pos = clone(T.qr_pay_1.tx); pos.meta.logMessages.push("Program log: Instruction: AddLiquidityByStrategy2");
  assert.equal(classifySwapPayment(pos, W).isPayment, false);
  const notSigner = clone(T.qr_pay_1.tx);
  for (const k of notSigner.transaction.message.accountKeys) if (k.pubkey === W) k.signer = false;
  assert.equal(classifySwapPayment(notSigner, W).isPayment, false);
  // Under the 0.01 SOL floor.
  const dust = clone(T.qr_pay_1.tx);
  const wi = dust.transaction.message.accountKeys.findIndex((k) => k.pubkey === W);
  dust.meta.postBalances[wi] = dust.meta.preBalances[wi] - 9_000_000;
  assert.equal(classifySwapPayment(dust, W).isPayment, false);
  // A token that also came back to a wallet-owned account: not a payment.
  const back = clone(T.qr_pay_1.tx);
  back.meta.postTokenBalances.push({ accountIndex: 4, mint: USDC, owner: W, uiTokenAmount: { amount: "1000000", decimals: 6, uiAmountString: "1" } });
  assert.equal(classifySwapPayment(back, W).isPayment, false);
});

test("a plain SOL send is booked exactly as before; a failed one no longer is", () => {
  const w = book("plain_send_0_1");
  assert.deepEqual(w, { signature: T.plain_send_0_1.signature, timestamp: new Date(T.plain_send_0_1.blockTime * 1000).toISOString(), amount: 0.1 });
  assert.deepEqual(classifyWithdrawal(T.plain_send_0_1.tx, W), { isWithdrawal: true, amount: 0.1 });
  const failed = clone(T.plain_send_0_1.tx); failed.meta.err = { InstructionError: [0, "InsufficientFunds"] };
  assert.equal(classifyWithdrawal(failed, W).isWithdrawal, false);
  // The deposit is a non-signer transaction: nothing here books it as a withdrawal.
  assert.equal(book("deposit_in"), null);
});

test("tools/wallet.js re-exports the classifiers it used to define", () => {
  assert.equal(wallet.classifyWithdrawal, classifyWithdrawal);
  assert.equal(wallet.classifyTokenSwap, classifyTokenSwap);
  assert.equal(wallet.classifySwapPayment, classifySwapPayment);
  assert.equal(typeof wallet.walkSignaturesInOrder, "function");
});

test("backfill plan: dedupe by signature, idempotent apply, totals", () => {
  const pays = ["qr_pay_1", "qr_pay_2", "qr_pay_3"].map(book);
  const send = book("plain_send_0_1");
  const baseline = { total_withdrawn: 27.63, withdrawals: [send, { signature: "skimSig", amount: 1, timestamp: "2026-11-20T00:00:00.000Z" }] };
  const { rows, toAdd } = planBaselineBackfill(baseline, [send, ...pays, pays[0]]);
  assert.deepEqual(rows.map((r) => r.status), ["already_booked", "would_add", "would_add", "would_add", "already_booked"]);
  assert.equal(toAdd.length, 3);
  const next = applyBaselineBackfill(baseline, toAdd);
  assert.equal(next.withdrawals.length, 5);
  assert.ok(Math.abs(next.total_withdrawn - (27.63 + 0.405285170)) < 1e-6, String(next.total_withdrawn));
  assert.ok(next.withdrawals.slice(2).every((w) => w.withdrawal_type === "swap_payment" && w.backfilled_at));
  assert.deepEqual(baseline.withdrawals.length, 2, "input not mutated");
  // Second run: nothing to add, nothing changes.
  const again = planBaselineBackfill(next, [send, ...pays]);
  assert.equal(again.toAdd.length, 0);
  const same = applyBaselineBackfill(next, toAdd);
  assert.equal(same.withdrawals.length, 5);
  assert.equal(same.total_withdrawn, next.total_withdrawn);
});

test("ledger-truth counts a backfilled payment once, as a withdrawal", async () => {
  const { saveBaselineState } = await import("../state.js");
  const { flowsBetween } = await import("../ledger-truth.js");
  const pays = ["qr_pay_1", "qr_pay_2", "qr_pay_3"].map(book);
  saveBaselineState(applyBaselineBackfill({ deposits: [], total_deposited: 0, withdrawals: [], total_withdrawn: 0 }, pays));
  const f = flowsBetween(new Date("2026-11-25T00:00:00Z"), new Date("2026-11-25T12:00:00Z"));
  assert.ok(Math.abs(f.withdrawals - 0.405285170) < 1e-9, String(f.withdrawals));
  assert.equal(f.deposits, 0);
});

test("backfill --apply refuses unless the agent and its watchdog are stopped", () => {
  const app = (name, status) => ({ name, pm2_env: { status } });
  assert.equal(agentStoppedVerdict(null, null).ok, false, "PM2 not readable");
  assert.equal(agentStoppedVerdict([app("meridian", "online")], null).ok, false);
  assert.equal(agentStoppedVerdict([app("meridian", "stopped"), app("meridian-watchdog", "online")], null).ok, false);
  assert.equal(agentStoppedVerdict([app("meridian", "stopped"), app("meridian-watchdog", "stopped")], 5_000).ok, false, "fresh heartbeat");
  assert.equal(agentStoppedVerdict([app("meridian", "stopped"), app("meridian-watchdog", "stopped"), app("meridian-syncer", "stopped")], HEARTBEAT_STALE_MS + 1).ok, true);
  assert.equal(agentStoppedVerdict([app("meridian", "errored"), app("meridian-watchdog", "stopped")], null).ok, true);
});
