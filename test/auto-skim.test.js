// Profit skimmer — decision, destination, proposals, config surface (2026-11-25).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  skimConfig,
  checkSkimDestination,
  checkSkimDestinationAccount,
  computeSkimDecision,
  skimLedger,
  reduceSkimJournal,
  createSkimProposalStore,
  confirmationRefusal,
  skimCommandRefusal,
  resolveSkimStatus,
  bookSkimWithdrawal,
  maskAddress,
  SYSTEM_PROGRAM_ID,
  skimIntegrity,
  isSkimWithdrawal,
  untrackedSwapSol,
  validateSkimSetting,
  operatorResolveRefusal,
  newOperatorWithdrawalSol,
  withDeadline,
  SKIM_HARD_MAX_PER_SKIM_SOL,
} from "../skim-policy.js";
import { config, reloadScreeningThresholds, skimOffLatched, setSkimOffLatch } from "../config.js";
import { executeTool } from "../tools/executor.js";
import { applySkimSetting } from "../tools/transfer.js";
import { operatorSetSkim, skimCommandGate, skimCommandNeedsPrivate } from "../skim-flow.js";
import os from "node:os";
import { initTokenSwapEvictedTotal, trimTokenSwapRing, walkSignaturesInOrder } from "../baseline-classify.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = Keypair.generate().publicKey.toBase58();
const WALLET = Keypair.generate().publicKey.toBase58();
const NOW = Date.parse("2026-11-25T12:16:00Z");
const H = 3600e3;
const okDest = { ok: true, address: DEST, masked: maskAddress(DEST), error: null };
const cfgOn = (over = {}) => ({ ...skimConfig({ enabled: true }, { env: {} }), ...over });
const base = (over = {}) => ({ total_deposited: 10, total_withdrawn: 0, deposits: [], withdrawals: [], stuck_signature: null, ...over });
const decide = (over = {}) => computeSkimDecision({
  cfg: cfgOn(), destination: okDest, baseline: base(), skims: [], baselineFresh: true, integrity: { ok: true, toBook: [] },
  wallet: { freeSol: 12, valuationComplete: true, positions: [] }, inFlight: [], now: NOW, ...over,
});

// ─── config ────────────────────────────────────────────────────────
test("skimConfig: confirmation is env-only and required unless exactly 'false' (raw compare)", () => {
  assert.equal(skimConfig({}).requireConfirmation, true);
  assert.equal(skimConfig({ requireTelegramConfirmation: false }, { env: {} }).requireConfirmation, true, "a config value is never read");
  for (const v of ["0", "False", "FALSE", " false", "false ", "no", ""]) {
    assert.equal(skimConfig({}, { env: { AUTO_SKIM_REQUIRE_CONFIRMATION: v } }).requireConfirmation, true, JSON.stringify(v));
  }
  assert.equal(skimConfig({}, { env: { AUTO_SKIM_REQUIRE_CONFIRMATION: "false" } }).requireConfirmation, false);
});

test("skimConfig: code ceilings always apply; .env ceilings can only lower them", () => {
  assert.equal(skimConfig({ maxPerSkimSol: 100, maxDailyTransferSol: 100 }).maxPerSkimSol, SKIM_HARD_MAX_PER_SKIM_SOL);
  assert.equal(skimConfig({ maxDailyTransferSol: 100 }).maxDailyTransferSol, 10);
  const env = { AUTO_SKIM_MAX_PER_SKIM_SOL: "0.3", AUTO_SKIM_MAX_DAILY_SOL: "0.6" };
  const c = skimConfig({ maxPerSkimSol: 1, maxDailyTransferSol: 2 }, { env });
  assert.equal(c.maxPerSkimSol, 0.3);
  assert.equal(c.maxDailyTransferSol, 0.6);
  assert.equal(skimConfig({ maxPerSkimSol: 1 }, { env: { AUTO_SKIM_MAX_PER_SKIM_SOL: "50" } }).maxPerSkimSol, 1, "env cannot raise above the code ceiling");
});

test("validateSkimSetting: operator setter bounds", () => {
  assert.deepEqual(validateSkimSetting("enabled", "on", {}), { ok: true, field: "enabled", value: true });
  assert.equal(validateSkimSetting("enabled", "yes", {}).ok, false);
  assert.equal(validateSkimSetting("perskim", "6", {}).ok, false, "above the code ceiling");
  assert.equal(validateSkimSetting("perskim", "0.4", {}, { env: { AUTO_SKIM_MAX_PER_SKIM_SOL: "0.3" } }).ok, false, "above the env ceiling");
  assert.equal(validateSkimSetting("perskim", "0", {}).ok, false);
  assert.equal(validateSkimSetting("daily", "0.5", { maxPerSkimSol: 1 }).ok, false, "daily < per-skim");
  assert.equal(validateSkimSetting("perskim", "3", { maxDailyTransferSol: 2 }).ok, false, "per-skim > daily");
  assert.equal(validateSkimSetting("target", "-1", {}).ok, false);
  assert.equal(validateSkimSetting("min", "2", { maxPerSkimSol: 1 }).ok, false, "min > per-skim");
  assert.equal(validateSkimSetting("reserve", "0.01", {}).ok, false);
  assert.equal(validateSkimSetting("interval", "5", {}).ok, false);
  assert.equal(validateSkimSetting("destination", DEST, {}).ok, false, "no such setting");
  assert.equal(validateSkimSetting("daily", "3", { maxPerSkimSol: 1 }).value, 3);
});

test("skimConfig: off unless enabled === true; hard floors on reserve, interval and amount", () => {
  assert.equal(skimConfig({ enabled: "true" }).enabled, false);
  assert.equal(skimConfig({ enabled: 1 }).enabled, false);
  assert.equal(skimConfig({ enabled: true }).enabled, true);
  const c = skimConfig({ minWalletReserveSol: 0, transferIntervalMin: 0, minTransferAmountSol: 0 }, { gasReserveSol: 0.2 });
  assert.equal(c.minWalletReserveSol, 0.2, "never below the management gas reserve");
  assert.equal(c.transferIntervalMin, 10);
  assert.equal(c.minTransferAmountSol, 0.01);
  assert.equal(skimConfig({ minWalletReserveSol: 0 }).minWalletReserveSol, 0.05);
});

test("prod config defaults: skimmer off, no destination or confirmation key", () => {
  assert.equal(typeof config.autoSkim.enabled, "boolean");
  assert.equal("destinationAddress" in config.autoSkim, false);
  assert.equal("requireTelegramConfirmation" in config.autoSkim, false);
  assert.equal(config.autoSkim.maxPerSkimSol, 1);
});

// ─── destination ───────────────────────────────────────────────────
test("checkSkimDestination: refuses empty, malformed, whitespace, off-curve, programs, mints and the wallet", () => {
  assert.match(checkSkimDestination("").error, /not set/);
  assert.match(checkSkimDestination(null).error, /not set/);
  assert.match(checkSkimDestination("not-an-address").error, /base58/);
  assert.match(checkSkimDestination(`${DEST} x`).error, /whitespace/);
  const pda = PublicKey.findProgramAddressSync([Buffer.from("t")], new PublicKey(SYSTEM_PROGRAM_ID))[0].toBase58();
  assert.match(checkSkimDestination(pda).error, /off-curve/);
  for (const id of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "So11111111111111111111111111111111111111112", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"]) {
    const r = checkSkimDestination(id);
    assert.equal(r.ok, false, id);
  }
  assert.match(checkSkimDestination(WALLET, { walletAddress: WALLET }).error, /bot wallet/);
  const ok = checkSkimDestination(`  ${DEST}\n`, { walletAddress: WALLET });
  assert.equal(ok.ok, true);
  assert.equal(ok.address, DEST);
  assert.equal(ok.masked, `${DEST.slice(0, 4)}…${DEST.slice(-4)}`);
});

test("checkSkimDestinationAccount: plain system wallet or not created yet; nothing else", () => {
  assert.equal(checkSkimDestinationAccount(null).ok, true);
  assert.equal(checkSkimDestinationAccount({ owner: new PublicKey(SYSTEM_PROGRAM_ID), executable: false }).ok, true);
  assert.match(checkSkimDestinationAccount({ owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), executable: false }).error, /not the System Program/);
  assert.match(checkSkimDestinationAccount({ owner: SYSTEM_PROGRAM_ID, executable: true }).error, /executable/);
  assert.equal(checkSkimDestinationAccount(undefined).ok, false);
});

// ─── the decision ──────────────────────────────────────────────────
test("production figures 2026-11-25: lifetime net capital ◎13.39 vs equity ◎8.61 → no skim (the old rule proposed ◎2.0)", () => {
  const b = base({ total_deposited: 41.515384, total_withdrawn: 28.127406 });
  const d = decide({ baseline: b, wallet: { freeSol: 4.16398, valuationComplete: true, positions: [{ valueSol: 4.4502, costSol: 4.6 }] } });
  assert.equal(d.ok, false);
  assert.match(d.reason, /no realised profit/);
  assert.equal(d.figures.netCapital, 13.387978);
  assert.ok(d.figures.profitSol < -4.5);
  // the pre-2026-11-25 rule: equity (free SOL only — deployed_sol was read from the wrong level) − 6.2529
  const oldEquity = 4.16398; // with deployed: 8.614 → surplus 2.36 → ◎2.0
  assert.equal(oldEquity - 6.2529 < 0.5, true);
});

test("an operator deposit is never profit; an operator payment from the wallet changes nothing", () => {
  const before = decide({ wallet: { freeSol: 10, valuationComplete: true, positions: [] } });
  assert.equal(before.figures.profitSol, 0);
  const afterDeposit = decide({ baseline: base({ total_deposited: 17.8 }), wallet: { freeSol: 17.8, valuationComplete: true, positions: [] } });
  assert.equal(afterDeposit.ok, false);
  assert.equal(afterDeposit.figures.profitSol, 0);
  const afterPayment = decide({ baseline: base({ total_withdrawn: 1, withdrawals: [{ signature: "pay1", amount: 1, timestamp: new Date(NOW - 48 * H).toISOString() }] }), wallet: { freeSol: 9, valuationComplete: true, positions: [] } });
  assert.equal(afterPayment.figures.profitSol, 0);
});

test("unrealised gains are left out, unrealised losses count", () => {
  const gain = decide({ wallet: { freeSol: 5, valuationComplete: true, positions: [{ valueSol: 8, costSol: 5 }] } });
  assert.equal(gain.figures.profitSol, 0, "◎3 paper gain is not profit");
  assert.equal(gain.figures.unrealisedGainExcludedSol, 3);
  const loss = decide({ wallet: { freeSol: 6, valuationComplete: true, positions: [{ valueSol: 3, costSol: 5 }] } });
  assert.equal(loss.figures.profitSol, -1);
  assert.equal(loss.ok, false);
});

test("realised profit is skimmable, bounded by per-skim cap, target floor, reserve and 24 h cap", () => {
  const d = decide({ wallet: { freeSol: 12, valuationComplete: true, positions: [] } });
  assert.equal(d.ok, true);
  assert.equal(d.amountSol, 1, "per-skim cap ◎1 (profit ◎2)");
  const floor = decide({ cfg: cfgOn({ targetWorkingCapitalSol: 11.6, maxPerSkimSol: 5 }) });
  assert.equal(floor.ok, false, "equity ◎12 within ◎0.5 of the ◎11.6 target");
  const reserve = decide({ cfg: cfgOn({ maxPerSkimSol: 5 }), wallet: { freeSol: 1.3, valuationComplete: true, positions: [{ valueSol: 10.7, costSol: 10.7 }] } });
  assert.equal(reserve.amountSol, 1, "free ◎1.3 − reserve ◎0.1 = ◎1.2 → chunk ◎1.0");
  const cap = decide({ cfg: cfgOn({ maxPerSkimSol: 5 }), baseline: base({ total_deposited: 11.6, total_withdrawn: 1.6, withdrawals: [{ signature: "w", amount: 1.6, timestamp: new Date(NOW - H).toISOString() }] }) });
  assert.equal(cap.figures.used24h, 1.6, "operator withdrawals count toward the 24 h cap (as before)");
  assert.equal(cap.ok, false, "◎0.4 left of the ◎2 cap < min ◎0.5");
  const capClamp = decide({ cfg: cfgOn({ maxPerSkimSol: 5, minTransferAmountSol: 0.1 }), baseline: base({ total_deposited: 11.3, total_withdrawn: 1.3, withdrawals: [{ signature: "w", amount: 1.3, timestamp: new Date(NOW - H).toISOString() }] }) });
  assert.equal(capClamp.amountSol, 0.7, "clamped to what is left of the cap (the old /skim now sent more)");
});

test("amount is a whole multiple of the minimum, exact in lamports", () => {
  const d = decide({ cfg: cfgOn({ minTransferAmountSol: 0.1, maxPerSkimSol: 5 }), wallet: { freeSol: 10.7999999, valuationComplete: true, positions: [] } });
  assert.equal(d.amountSol, 0.7);
  assert.equal(Number.isInteger(Math.round(d.amountSol * 1e9)), true);
});

test("a skim lowers the profit left by its own amount, booked or still pending", () => {
  const skim = { signature: "skim1", amount_sol: 1, status: "landed", created_at: new Date(NOW - 2 * H).toISOString() };
  const booked = base({ total_withdrawn: 1, withdrawals: [{ signature: "skim1", amount: 1, timestamp: skim.created_at }] });
  const d = decide({ baseline: booked, skims: [skim], wallet: { freeSol: 11, valuationComplete: true, positions: [] } });
  assert.equal(d.figures.netCapital, 10, "the skim is not an operator withdrawal");
  assert.equal(d.figures.profitSol, 1);
  // journal says failed, but the chain booked it: still a skim, capital untouched
  const mislabeled = decide({ baseline: booked, skims: [{ ...skim, status: "failed" }], wallet: { freeSol: 11, valuationComplete: true, positions: [] } });
  assert.equal(mislabeled.figures.netCapital, 10);
});

test("H1: a skim-flagged or legacy-reason withdrawal is a skim even with no journal entry", () => {
  const at = new Date(NOW - 48 * H).toISOString();
  for (const w of [{ signature: "f", amount: 1, timestamp: at, skim: true }, { signature: "l", amount: 1, timestamp: at, reason: "manual_telegram_skim" }, { signature: "b", amount: 1, timestamp: at, reason: "telegram_button_skim" }, { signature: "p", amount: 1, timestamp: at, reason: "profit_skim" }]) {
    assert.equal(isSkimWithdrawal(w), true);
    const l = skimLedger(base({ total_withdrawn: 1, withdrawals: [w] }), [], NOW);
    assert.equal(l.netCapital, 10, `${w.signature}: not an operator withdrawal`);
  }
  assert.equal(isSkimWithdrawal({ signature: "op", amount: 1 }), false);
});

test("H1: skimIntegrity fails closed", () => {
  const sk = (sig, status = "landed") => ({ signature: sig, status, amount_sol: 1, created_at: "t" });
  const ok = skimIntegrity({ journal: { exists: true, corrupt: 0, skims: [sk("a")] }, mirror: { entries: { a: {} } }, baseline: base({ withdrawals: [{ signature: "a", amount: 1, skim: true }] }) });
  assert.equal(ok.ok, true);
  assert.match(skimIntegrity({ journal: { exists: true, corrupt: 1, skims: [] } }).reason, /unreadable line/);
  assert.match(skimIntegrity({ journal: { exists: false, corrupt: 0, skims: [] }, mirror: { entries: { a: {} } } }).reason, /missing.*mirror/);
  assert.match(skimIntegrity({ journal: { exists: true, corrupt: 0, skims: [sk("a")] }, mirror: { entries: { a: {}, b: {} } } }).reason, /mirror lists 1 skim/);
  assert.match(skimIntegrity({ journal: { exists: true, corrupt: 0, skims: [] }, mirror: { entries: {} }, baseline: base({ withdrawals: [{ signature: "z", amount: 1, skim: true }] }) }).reason, /does not know/);
  assert.match(skimIntegrity({ journal: { exists: false, corrupt: 0, skims: [] }, mirror: null, baseline: base({ withdrawals: [{ signature: "z", amount: 1, reason: "profit_skim" }] }) }).reason, /does not know/);
  const toBook = skimIntegrity({ journal: { exists: true, corrupt: 0, skims: [sk("a"), sk("p", "pending")] }, mirror: { entries: {} }, baseline: base() });
  assert.equal(toBook.ok, true);
  assert.deepEqual(toBook.toBook.map((s) => s.signature), ["a"], "landed + unbooked → booked by the caller, not a refusal");
  assert.match(decide({ integrity: { ok: false, reason: "journal broken" } }).reason, /journal broken/);
  assert.match(decide({ integrity: null }).reason, /not checked/);
});

test("M2: SOL from selling tokens sent in is netted out of profit", () => {
  const known = new Set(["POSMINT"]);
  const swaps = [{ mint: "AIRDROP", sol: 1.5, tokens: -100 }, { mint: "BUYHOLD", sol: -0.4, tokens: 50 }, { mint: "POSMINT", sol: 3, tokens: -1 }];
  assert.equal(untrackedSwapSol(swaps, known), 1.1);
  const d = decide({ wallet: { freeSol: 12, valuationComplete: true, positions: [] }, untrackedSwapSolTotal: 1.5 });
  assert.equal(d.figures.adjustedCapital, 11.5);
  assert.equal(d.figures.profitSol, 0.5);
  assert.equal(decide({ untrackedSwapSolTotal: 1.6 }).ok, false, "◎0.4 left after netting is under the ◎0.5 minimum");
  assert.equal(decide({ untrackedSwapSolTotal: 0 }).figures.profitSol, 2);
  assert.equal(decide({ untrackedSwapSolTotal: -3 }).figures.adjustedCapital, 10, "a net buy never lowers capital");
  assert.match(decide({ tokenSwapCount: 300, tokenSwapsEvictedSol: null }).reason, /full.*no running total/, "legacy full ring without the total");
  assert.equal(decide({ tokenSwapCount: 300, tokenSwapsEvictedSol: 0.2 }).ok, true, "N4: a full ring with the running total is fine");
  assert.equal(decide({ tokenSwapCount: 120, tokenSwapsEvictedSol: null }).ok, true);
});

test("N4: the token-swap ring carries evicted rows' SOL in a running total", () => {
  const b = { token_swaps: [] };
  initTokenSwapEvictedTotal(b, 3);
  assert.equal(b.token_swaps_evicted_sol, 0);
  b.token_swaps = [{ sol: 1 }, { sol: -0.25 }, { sol: 2 }, { sol: 0.5 }, { sol: 0.1 }];
  trimTokenSwapRing(b, 3);
  assert.equal(b.token_swaps.length, 3);
  assert.equal(b.token_swaps_evicted_sol, 0.75);
  const legacy = { token_swaps: [{ sol: 1 }, { sol: 1 }, { sol: 1 }] };
  initTokenSwapEvictedTotal(legacy, 3);
  assert.equal(legacy.token_swaps_evicted_sol, undefined, "a ring already full stays unknown");
  legacy.token_swaps.push({ sol: 1 });
  trimTokenSwapRing(legacy, 3);
  assert.equal(legacy.token_swaps_evicted_sol, undefined);
});

test("N3: the deposit walk can be cancelled between transactions without counting a stuck signature", async () => {
  let n = 0;
  const sigs = [{ signature: "a" }, { signature: "b" }, { signature: "c" }];
  const handled = [];
  const r = await walkSignaturesInOrder(sigs, async () => ({ ok: true }), (s) => { handled.push(s.signature); n++; }, { isAborted: () => n >= 2 });
  assert.deepEqual(handled, ["a", "b"]);
  assert.equal(r.aborted, true);
  assert.equal(r.checkpoint, "b");
  assert.equal(r.stoppedAt, null);
});

test("M2/N2: a wallet read that saw a closed position account refuses", () => {
  assert.match(decide({ wallet: { freeSol: 12, valuationComplete: false, invalidReason: "a listed position account no longer exists (x closed during the read)", positions: [] } }).reason, /no longer exists/);
});

test("M2: balance read twice, positions from the RPC path only, no closed or unready rows", () => {
  assert.match(decide({ wallet: { freeSol: 11.9, freeSolBefore: 12, freeSolAfter: 11.9, valuationComplete: true, positions: [] } }).reason, /moved during the read/);
  const small = decide({ wallet: { freeSol: 11.995, freeSolBefore: 12, freeSolAfter: 11.995, valuationComplete: true, positions: [] } });
  assert.equal(small.figures.freeSol, 11.995, "within tolerance: the lower figure");
  assert.match(decide({ wallet: { freeSol: 12, valuationComplete: true, source: "meteora", positions: [] } }).reason, /meteora fallback/);
  assert.match(decide({ wallet: { freeSol: 12, valuationComplete: true, source: "rpc", positions: [{ valueSol: 1, costSol: 1, closed: true }] } }).reason, /closed/);
  assert.match(decide({ wallet: { freeSol: 12, valuationComplete: true, source: "rpc", positions: [{ valueSol: 1, costSol: 1, ready: false }] } }).reason, /management-ready/);
  assert.equal(decide({ wallet: { freeSol: 12, valuationComplete: true, source: "rpc", positions: [] } }).ok, true);
});

test("refusals: disabled, destination, pending, busy, baseline, valuation, cost, cooldown", () => {
  assert.match(decide({ cfg: cfgOn({ enabled: false }) }).reason, /disabled/);
  assert.match(decide({ destination: { ok: false, error: "x" } }).reason, /destination refused/);
  assert.match(decide({ skims: [{ signature: "p1", amount_sol: 1, status: "pending", created_at: new Date(NOW).toISOString() }] }).reason, /unresolved/);
  assert.match(decide({ inFlight: ["management cycle running"] }).reason, /busy: management/);
  assert.match(decide({ baseline: base({ stuck_signature: "abc" }) }).reason, /stuck/);
  assert.match(decide({ baselineFresh: false }).reason, /did not complete/);
  assert.match(decide({ baseline: base({ total_deposited: 0 }) }).reason, /no deposit baseline/);
  assert.match(decide({ wallet: { freeSol: NaN, valuationComplete: true, positions: [] } }).reason, /balance unavailable/);
  assert.match(decide({ wallet: { freeSol: 12, valuationComplete: false, positions: [] } }).reason, /valuation incomplete/);
  assert.match(decide({ wallet: { freeSol: 12, valuationComplete: true, positions: [{ valueSol: 1, costSol: NaN }] } }).reason, /no recorded cost/);
  const recent = { signature: "s0", amount_sol: 0.5, status: "landed", created_at: new Date(NOW - 20 * 60e3).toISOString() };
  assert.match(decide({ skims: [recent], baseline: base({ total_deposited: 10.5, total_withdrawn: 0.5, withdrawals: [{ signature: "s0", amount: 0.5, timestamp: recent.created_at }] }), wallet: { freeSol: 12, valuationComplete: true, positions: [] } }).reason, /cooldown/);
});

test("skimLedger: pending skims not yet booked count toward the 24 h cap once", () => {
  const at = new Date(NOW - H).toISOString();
  const l = skimLedger(base({ total_withdrawn: 0.5, withdrawals: [{ signature: "a", amount: 0.5, timestamp: at }] }),
    [{ signature: "a", amount_sol: 0.5, status: "landed", created_at: at }, { signature: "b", amount_sol: 0.7, status: "pending", created_at: at }], NOW);
  assert.equal(l.used24h, 1.2);
  assert.equal(l.pending.length, 1);
});

test("reduceSkimJournal: landed is final; a later failed never overrides it", () => {
  const r = reduceSkimJournal([
    { event: "pending", signature: "s", amount_sol: 1, at: "t0", last_valid_block_height: 10 },
    { event: "landed", signature: "s", at: "t1" },
    { event: "failed", signature: "s", at: "t2" },
    { event: "pending", signature: "x", amount_sol: 0.5, at: "t0" },
    { event: "failed", signature: "x", at: "t3" },
    { garbage: true },
  ]);
  assert.equal(r.find((s) => s.signature === "s").status, "landed");
  assert.equal(r.find((s) => s.signature === "x").status, "failed");
  assert.equal(r.length, 2);
});

// ─── proposals and confirmation ────────────────────────────────────
test("proposal store: one live proposal, one use, expiry, supersede", () => {
  let n = 0;
  const store = createSkimProposalStore({ ttlMs: 600e3, randomId: () => `id${++n}` });
  const p1 = store.create({ amountSol: 1, destination: DEST, now: NOW });
  const p2 = store.create({ amountSol: 0.5, destination: DEST, now: NOW });
  assert.match(store.consume(p1.id, NOW).reason, /superseded/);
  const c = store.consume(p2.id, NOW + 1000);
  assert.equal(c.ok, true);
  assert.equal(c.proposal.amountSol, 0.5);
  assert.match(store.consume(p2.id, NOW + 2000).reason, /already used/);
  const p3 = store.create({ amountSol: 1, destination: DEST, now: NOW });
  assert.match(store.consume(p3.id, NOW + 600e3 + 1).reason, /expired/);
  assert.match(store.consume("", NOW).reason, /no proposal id/);
  assert.throws(() => store.create({ amountSol: 0, destination: DEST }));
});

test("confirmation re-checks the decision: amount may not grow, destination may not change", () => {
  const p = { amountSol: 1, destination: DEST };
  assert.equal(confirmationRefusal(p, { ok: true, amountSol: 1 }, okDest), null);
  assert.equal(confirmationRefusal(p, { ok: true, amountSol: 1.5 }, okDest), null, "sends the proposed ◎1, not more");
  assert.match(confirmationRefusal(p, { ok: true, amountSol: 0.5 }, okDest), /fell/);
  assert.match(confirmationRefusal(p, { ok: false, reason: "busy: x" }, okDest), /no longer allowed/);
  assert.match(confirmationRefusal(p, { ok: true, amountSol: 1 }, { ...okDest, address: WALLET }), /destination changed/);
});

test("skimCommandRefusal: private chat, human, not forwarded", () => {
  assert.equal(skimCommandRefusal({ chat: { type: "private" }, from: { is_bot: false } }), null);
  assert.match(skimCommandRefusal({ chat: { type: "group" }, from: {} }), /private chat/);
  assert.match(skimCommandRefusal({ chat: { type: "supergroup" }, from: {} }), /private chat/);
  assert.match(skimCommandRefusal({ chat: { type: "private" }, from: { is_bot: true } }), /bot/);
  assert.match(skimCommandRefusal({ chat: { type: "private" }, from: {}, forward_origin: { type: "user" } }), /forwarded/);
  assert.match(skimCommandRefusal({ chat: { type: "private" }, from: {}, forward_date: 1 }), /forwarded/);
});

test("resolveSkimStatus: unknown signature fails only after the blockhash expired by a margin", () => {
  const s = { last_valid_block_height: 1000 };
  assert.equal(resolveSkimStatus(s, { confirmationStatus: "confirmed", err: null }, 900), "landed");
  assert.equal(resolveSkimStatus(s, { confirmationStatus: "finalized", err: null }, null), "landed");
  assert.equal(resolveSkimStatus(s, { confirmationStatus: "processed", err: null }, 5000), "pending");
  assert.equal(resolveSkimStatus(s, { confirmationStatus: "confirmed", err: { InstructionError: [0, "x"] } }, 900), "failed");
  assert.equal(resolveSkimStatus(s, null, 1100), "pending");
  assert.equal(resolveSkimStatus(s, null, 1151), "pending", "L1: past expiry but getTransaction not asked → pending");
  assert.equal(resolveSkimStatus(s, null, 1151, { txLookup: undefined }), "pending", "lookup failed → pending");
  assert.equal(resolveSkimStatus(s, null, 1151, { txLookup: null }), "failed", "expired AND not found on the primary");
  assert.equal(resolveSkimStatus(s, null, 1151, { txLookup: { meta: { err: null } } }), "landed", "a null status but the primary has it");
  assert.equal(resolveSkimStatus(s, null, 1151, { txLookup: { meta: { err: { x: 1 } } } }), "failed");
  assert.equal(resolveSkimStatus(s, null, null), "pending");
});

test("L2: operatorResolveRefusal — only what the chain shows", () => {
  const p = { signature: "s", status: "pending" };
  assert.equal(operatorResolveRefusal("landed", "landed", p), null);
  assert.equal(operatorResolveRefusal("failed", "failed", p), null);
  assert.match(operatorResolveRefusal("failed", "landed", p), /chain says landed/);
  assert.match(operatorResolveRefusal("landed", "pending", p), /chain says pending/);
  assert.match(operatorResolveRefusal("failed", "failed", { ...p, status: "landed" }), /already landed/);
  assert.match(operatorResolveRefusal("failed", "failed", null), /no such skim/);
  assert.match(operatorResolveRefusal("maybe", "failed", p), /landed or failed/);
});

test("L5: the withdrawal notice leaves skims out", () => {
  const before = new Set(["old"]);
  const ws = [{ signature: "old", amount: 5 }, { signature: "skim", amount: 1, skim: true }, { signature: "j", amount: 0.5 }, { signature: "op", amount: 0.2 }];
  assert.equal(newOperatorWithdrawalSol(before, ws, new Set(["j"])), 0.2);
});

test("withDeadline rejects a hung step with .deadline", async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 20, "x"), (e) => e.deadline === true);
  assert.equal(await withDeadline(Promise.resolve(7), 1000), 7);
});

test("bookSkimWithdrawal books once by signature", () => {
  const b = base({ total_withdrawn: 2, withdrawals: [{ signature: "w", amount: 2 }] });
  assert.equal(bookSkimWithdrawal(b, { signature: "s", amountSol: 0.5, at: "t" }), true);
  assert.equal(bookSkimWithdrawal(b, { signature: "s", amountSol: 0.5, at: "t" }), false);
  assert.equal(b.total_withdrawn, 2.5);
  assert.equal(b.withdrawals.length, 2);
  assert.equal(b.withdrawals[1].skim, true);
});

// ─── config surface ────────────────────────────────────────────────
test("M3: update_config (the LLM's tool and /setcfg) cannot reach any skimmer setting", async () => {
  const before = JSON.stringify(config.autoSkim);
  const keys = ["autoSkimEnabled", "autoSkimMaxPerSkimSol", "autoSkimMaxDailyTransferSol", "autoSkimTargetWorkingCapitalSol", "autoSkimMinTransferAmountSol", "autoSkimMinWalletReserveSol", "autoSkimTransferIntervalMin", "autoSkimRequireTelegramConfirmation", "autoskimenabled"];
  for (const k of keys) {
    const r = await executeTool("update_config", { changes: { [k]: k.toLowerCase().includes("enabled") ? true : 0 }, reason: "test" });
    assert.equal(r.success, false, k);
    assert.deepEqual(r.unknown, [k]);
  }
  assert.equal(JSON.stringify(config.autoSkim), before);
});

test("no LLM tool, role set or prompt can reach the transfer; only index.js imports it", () => {
  const defs = fs.readFileSync(path.join(ROOT, "tools/definitions.js"), "utf8");
  assert.equal(/skim|transfer_sol|transferSol|sendSkim/i.test(defs), false);
  const agent = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
  assert.equal(/skim|transfer/i.test(agent), false);
  const importers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "test") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && /from\s+["'][./]*(tools\/)?transfer\.js["']/.test(fs.readFileSync(p, "utf8"))) importers.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  assert.deepEqual(importers.sort(), ["index.js"]);
  const executor = fs.readFileSync(path.join(ROOT, "tools/executor.js"), "utf8");
  assert.equal(/requireTelegramConfirmation|destinationAddress|autoSkim/.test(executor), false);
  // index.js: the only send call is the flow's `send` dependency; the /skim handler never uses update_config
  const idx = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  assert.equal((idx.match(/executeSkim\(/g) || []).length, 1, "one send call site");
  assert.ok(/send: \(args, hooks\) => executeSkim\(args, hooks\)/.test(idx));
  const handler = idx.slice(idx.indexOf("async function handleSkimTextCommand("), idx.indexOf("function formatHelpText("));
  assert.ok(handler.length > 1000);
  assert.equal(/executeTool|update_config/.test(handler), false, "/skim never passes through the tool executor");
  // N6: the /skim text commands are handled before the busy queue
  const tg = idx.slice(idx.indexOf("async function telegramHandler("));
  const at = tg.indexOf("await handleSkimTextCommand(text, msg)");
  const queue = tg.indexOf("_telegramQueue.push(msg)");
  assert.ok(at > 0 && queue > 0 && at < queue, "/skim is handled before the busy queue");
  assert.equal((idx.match(/handleSkimTextCommand\(/g) || []).length, 2, "defined once, called once");
  const cb = idx.slice(idx.indexOf("async function handleSkimMenuCallback("), idx.indexOf("function formatHelpText("));
  assert.equal(/executeTool|update_config/.test(cb), false);
  const cfg = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
  assert.equal(/u\.autoSkim\?\.destinationAddress|process\.env\.PIONEX_DEPOSIT_ADDRESS|requireTelegramConfirmation:/.test(cfg), false, "config.js does not read the destination or the confirmation switch");
});

// ─── R1: a failed settings write ───────────────────────────────────
const unwritable = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skimcfg-")), "no-such-dir", "user-config.json");

test("R1: applySkimSetting writes the file first; a failed write leaves memory unchanged (on / set)", () => {
  const saved = { ...config.autoSkim };
  config.autoSkim.enabled = false;
  config.autoSkim.maxPerSkimSol = 1;
  const on = applySkimSetting("enabled", true, { userConfigPath: unwritable() });
  assert.equal(on.persisted, false);
  assert.equal(config.autoSkim.enabled, false, "on not applied");
  const set = applySkimSetting("maxPerSkimSol", 0.3, { userConfigPath: unwritable() });
  assert.equal(set.persisted, false);
  assert.equal(config.autoSkim.maxPerSkimSol, 1, "set not applied");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skimcfg-"));
  const file = path.join(dir, "user-config.json");
  fs.writeFileSync(file, JSON.stringify({ keep: 1, autoSkim: { enabled: false } }));
  assert.equal(applySkimSetting("maxPerSkimSol", 0.3, { userConfigPath: file }).persisted, true);
  assert.equal(config.autoSkim.maxPerSkimSol, 0.3);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { keep: 1, autoSkim: { enabled: false, maxPerSkimSol: 0.3 } });
  Object.assign(config.autoSkim, saved);
  setSkimOffLatch(false);
});

test("R1: a failed write on OFF keeps memory off, latches, and a reload of the stale file cannot re-enable", () => {
  const saved = { ...config.autoSkim };
  config.autoSkim.enabled = true;
  const r = applySkimSetting("enabled", false, { userConfigPath: unwritable() });
  assert.equal(r.persisted, false);
  assert.equal(r.inMemory, true);
  assert.equal(config.autoSkim.enabled, false);
  assert.equal(skimOffLatched(), true);
  reloadScreeningThresholds({ autoSkim: { enabled: true } }); // the stale file still says on
  assert.equal(config.autoSkim.enabled, false, "the reload does not turn it back on");
  // a successful write clears the latch; a reload can then set it again
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skimcfg-"));
  assert.equal(applySkimSetting("enabled", false, { userConfigPath: path.join(dir, "user-config.json") }).persisted, true);
  assert.equal(skimOffLatched(), false);
  reloadScreeningThresholds({ autoSkim: { enabled: true } });
  assert.equal(config.autoSkim.enabled, true);
  Object.assign(config.autoSkim, saved);
  setSkimOffLatch(false);
});

test("R1: operatorSetSkim — off always stops the confirm and answers; on/set failures answer and change nothing", () => {
  const stops = [];
  const fail = () => ({ persisted: false, inMemory: false, error: new Error("EROFS") });
  const failOff = (field, v) => (field === "enabled" && v === false ? { persisted: false, inMemory: true, error: new Error("EROFS") } : fail());
  const off = operatorSetSkim({ name: "enabled", value: "off", apply: failOff, stop: (why) => { stops.push(why); return "stopped"; } });
  assert.equal(off.ok, true);
  assert.equal(off.value, false);
  assert.equal(off.persisted, false);
  assert.match(off.warning, /could not be written.*OFF in memory/);
  assert.deepEqual(stops, ["the skimmer was turned off"], "abort requested");
  let forced = 0;
  const thrown = operatorSetSkim({ name: "enabled", value: "off", apply: () => { throw new Error("disk"); }, stop: () => "s", forceOff: () => { forced++; } });
  assert.equal(thrown.ok, true);
  assert.equal(forced, 1, "memory forced off when apply itself threw");
  const on = operatorSetSkim({ name: "enabled", value: "on", apply: fail, stop: () => { stops.push("x"); } });
  assert.equal(on.ok, false);
  assert.match(on.error, /nothing changed/);
  const set = operatorSetSkim({ name: "perskim", value: "0.5", apply: fail, stop: () => {} });
  assert.equal(set.ok, false);
  assert.equal(stops.length, 1, "on/set never stop");
  assert.equal(operatorSetSkim({ name: "perskim", value: "99", apply: fail, stop: () => {} }).ok, false, "validation first");
  assert.equal(operatorSetSkim({ name: "perskim", value: "0.5", apply: () => ({ persisted: true, inMemory: true }), stop: () => {} }).ok, true);
});

// ─── R5: private chat for everything but status / journal check / off / cancel ─────────
test("R5: skimCommandGate", () => {
  const group = { chat: { type: "group" }, from: { is_bot: false } };
  const fwd = { chat: { type: "private" }, from: { is_bot: false }, forward_date: 1 };
  const priv = { chat: { type: "private" }, from: { is_bot: false } };
  for (const sub of ["on", "set", "now", "confirm", "resolve", "adopt", "foo"]) {
    assert.equal(skimCommandNeedsPrivate(sub), true, sub);
    assert.match(skimCommandGate(sub, group), /private chat/, sub);
    assert.match(skimCommandGate(sub, fwd), /forwarded/, sub);
    assert.equal(skimCommandGate(sub, priv), null, sub);
  }
  for (const sub of ["", "status", "refresh", "journal", "journal check", "off", "cancel"]) {
    assert.equal(skimCommandGate(sub, group), null, `${sub || "(status)"}: any authorised chat`);
  }
  // wiring: both entry points call the gate before anything else
  const idx = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const text = idx.slice(idx.indexOf("async function handleSkimTextCommand("), idx.indexOf("function formatHelpText("));
  assert.ok(text.indexOf("skimCommandGate(gateKey, msg)") > 0 && text.indexOf("skimCommandGate(gateKey, msg)") < text.indexOf('sub === "on"'));
  const cb = idx.slice(idx.indexOf("async function handleSkimMenuCallback("), idx.indexOf("function formatSkimJournalReport("));
  assert.ok(cb.indexOf("skimCommandGate(action, msg)") > 0 && cb.indexOf("skimCommandGate(action, msg)") < cb.indexOf('action === "refresh"'));
});
