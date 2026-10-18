process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// After-close auto-swap waits for the close's own tokens (2026-10-18). CLAUDIA-SOL DpCydkE7:
// the close returned ~2,724 CLAUDIA, the swap's pooled balance read 1.8 s later still showed the
// 31.55 tokens of stage-C headroom and sold only those; 2,692.88 tokens ($22.25) waited 11 min
// for the dust sweeper.
import { test } from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import {
  waitForCloseTokens, expectedCloseBaseTokens, shouldWaitForCloseTokens, fmtTokens,
  remainderUsd, remainderAboveCeilingMessage,
} from "../exit-swap-wait.js";

const { swapBaseToSolWithRetry } = await import("../tools/executor.js");
const { config } = await import("../config.js");

const MINT = "CLAUDiaMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const USD_PER_TOKEN = 22.25 / 2692.88;
const SOL_PRICE = 103;

// Capture the logger's console.error lines.
function captureLogs() {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(" ")); };
  return { lines, restore: () => { console.error = orig; } };
}

// A fake wallet: the pooled read is stale (headroom only); the fresh primary-RPC reads follow `freshSeq`.
function makeDeps({ freshSeq, pooled = 31.55, swapOk = true, afterSwap = 0 }) {
  const calls = { fresh: 0, pooledArgs: [], swaps: [], sleeps: [], telegram: [] };
  let clock = 0;
  let swapped = false;
  const deps = {
    now: () => clock,
    sleep: async (ms) => { calls.sleeps.push(ms); clock += ms; },
    readWalletMintBalance: async (mint, opts = {}) => {
      calls.fresh++;
      if (swapped || opts.afterSignature) return { balance: afterSwap, behind: false };
      const v = freshSeq[Math.min(calls.fresh - 1, freshSeq.length - 1)];
      return { balance: v, behind: false };
    },
    getWalletBalances: async (opts = {}) => {
      calls.pooledArgs.push(opts);
      const bal = opts.mintOverride?.mint === MINT ? opts.mintOverride.balance : pooled;
      return {
        sol_price: SOL_PRICE,
        tokens: [{ mint: MINT, symbol: "CLAUDIA", balance: bal, usd: Math.round(bal * USD_PER_TOKEN * 100) / 100 }],
      };
    },
    getSwapQuote: async () => ({ out_amount: null }),
    swapToken: async (args) => {
      calls.swaps.push(args);
      if (!swapOk) return { success: false, error: "no route" };
      swapped = true;
      return { success: true, tx: "SwapSig111", amount_out: 216_000_000 };
    },
    sendHTML: async (html) => { calls.telegram.push(html); },
  };
  return { deps, calls };
}

config.management.autoSwapRetryAttempts = 3;
config.management.autoSwapRetryDelayMs = 3000;
config.management.dustSweepMaxUsd = 25;
config.management.exitSwapGuardEnabled = false;
config.management.swapSlippageCapEnabled = false;

test("stale first read (headroom only), full balance on the 3rd read → one swap of the full amount", async () => {
  const { deps, calls } = makeDeps({ freshSeq: [31.55, 31.55, 2755.78] });
  const cap = captureLogs();
  let out;
  try {
    out = await swapBaseToSolWithRetry(MINT, "after close", {
      expectedTokens: 2724.4, minContextSlot: 454_900_000, refPriceSol: 0.00008,
      checkRemainder: true, pair: "CLAUDIA-SOL", symbol: "CLAUDIA", deps,
    });
  } finally { cap.restore(); }
  assert.equal(out.swapped, true);
  assert.equal(calls.swaps.length, 1, "exactly one swap");
  assert.equal(calls.swaps[0].amount, 2755.78, "sold the full balance, not the 31.55 headroom");
  assert.equal(out.token.balance, 2755.78);
  assert.ok(out.token.usd > 22, "priced at the real balance");
  assert.deepEqual(calls.sleeps.slice(0, 2), [2000, 2000], "two 2 s waits before the 3rd read");
  assert.deepEqual(calls.pooledArgs[0], { mintOverride: { mint: MINT, balance: 2755.78 } });
  const text = cap.lines.join("\n");
  assert.match(text, /\[EXIT_SWAP\] waiting for the close's tokens: wallet 31\.55 vs expected ≈ 2,724 CLAUDIA \(try 1\/6\)/);
  assert.match(text, /\(try 2\/6\)/);
  assert.doesNotMatch(text, /\(try 3\/6\)/);
  assert.match(text, /\[EXIT_SWAP\] CLAUDIA balance caught up after 4 s: wallet 2,756 vs expected ≈ 2,724/);
  assert.equal(calls.telegram.length, 0, "nothing left → no remainder alert");
  assert.equal(out.remainder_above_ceiling, undefined);
});

test("first read already caught up → no wait, no wait log", async () => {
  const { deps, calls } = makeDeps({ freshSeq: [2755.78] });
  const cap = captureLogs();
  try {
    await swapBaseToSolWithRetry(MINT, "after close", { expectedTokens: 2724.4, symbol: "CLAUDIA", deps });
  } finally { cap.restore(); }
  assert.equal(calls.swaps.length, 1);
  assert.equal(calls.swaps[0].amount, 2755.78);
  assert.equal(calls.sleeps.length, 0);
  assert.doesNotMatch(cap.lines.join("\n"), /waiting for the close's tokens|caught up/);
});

test("expected unavailable → swaps at once from the pooled read (old behaviour)", async () => {
  const { deps, calls } = makeDeps({ freshSeq: [2755.78] });
  const cap = captureLogs();
  try {
    const out = await swapBaseToSolWithRetry(MINT, "after close", { expectedTokens: null, checkRemainder: false, deps });
    assert.equal(out.swapped, true);
  } finally { cap.restore(); }
  assert.equal(calls.fresh, 0, "no fresh read");
  assert.equal(calls.sleeps.length, 0, "no wait");
  assert.deepEqual(calls.pooledArgs, [{}], "getWalletBalances({}) as before");
  assert.equal(calls.swaps.length, 1);
  assert.equal(calls.swaps[0].amount, 31.55);
});

test("bounded wait expires → swaps what is there", async () => {
  const { deps, calls } = makeDeps({ freshSeq: [31.55] });
  const cap = captureLogs();
  try {
    const out = await swapBaseToSolWithRetry(MINT, "after close", { expectedTokens: 2724.4, symbol: "CLAUDIA", deps });
    assert.equal(out.swapped, true);
  } finally { cap.restore(); }
  assert.equal(calls.fresh, 6, "six reads");
  assert.deepEqual(calls.sleeps, [2000, 2000, 2000, 2000, 2000], "five 2 s waits = 10 s");
  assert.equal(calls.swaps.length, 1);
  assert.equal(calls.swaps[0].amount, 31.55);
  const text = cap.lines.join("\n");
  assert.match(text, /\(try 6\/6\)/);
  assert.match(text, /\[EXIT_SWAP\] CLAUDIA balance did not catch up after 10 s \(wallet 31\.55 vs expected ≈ 2,724\) — swapping what is there/);
});

test("remainder above the sweeper ceiling after the swap → warning + one Telegram line", async () => {
  // The swap fails on every attempt; 5,000 tokens (~$41) stay — the sweeper never sells > $25.
  const { deps, calls } = makeDeps({ freshSeq: [5000], pooled: 5000, swapOk: false, afterSwap: 5000 });
  const cap = captureLogs();
  let out;
  try {
    out = await swapBaseToSolWithRetry(MINT, "after close", {
      expectedTokens: 4990, checkRemainder: true, pair: "CLAUDIA-SOL", symbol: "CLAUDIA", deps,
    });
  } finally { cap.restore(); }
  assert.equal(out.swapped, false);
  assert.equal(calls.swaps.length, 3);
  assert.ok(out.remainder_above_ceiling, "remainder reported");
  assert.equal(out.remainder_above_ceiling.tokens, 5000);
  assert.ok(Math.abs(out.remainder_above_ceiling.usd - 41.31) < 0.05);
  assert.match(cap.lines.join("\n"), /\[EXIT_SWAP\] remainder \$41\.3\d left unsold above the sweeper ceiling \(\$25\): 5,000 CLAUDIA \(CLAUDIA-SOL\)/);
  assert.equal(calls.telegram.length, 1, "exactly one Telegram line");
  assert.match(calls.telegram[0], /Exit remainder left unsold/);
  assert.match(calls.telegram[0], /CLAUDIA-SOL/);
  assert.match(calls.telegram[0], /\$25 dust-sweeper ceiling/);
});

test("a remainder under the ceiling is the sweeper's — no alert", async () => {
  const { deps, calls } = makeDeps({ freshSeq: [2000], pooled: 2000, swapOk: false, afterSwap: 2000 });
  const cap = captureLogs();
  try {
    const out = await swapBaseToSolWithRetry(MINT, "after close", { expectedTokens: 2000, checkRemainder: true, symbol: "CLAUDIA", deps });
    assert.equal(out.remainder_above_ceiling, undefined);
  } finally { cap.restore(); }
  assert.equal(calls.telegram.length, 0);
});

test("waitForCloseTokens: an RPC behind the close's slot counts as not caught up", async () => {
  const seq = [{ balance: null, behind: true }, { balance: 2730, behind: false }];
  let i = 0;
  const lines = [];
  let clock = 0;
  const r = await waitForCloseTokens({
    mint: MINT, symbol: "CLAUDIA", expectedTokens: 2724, minContextSlot: 5,
    readBalance: async (_m, opts) => { assert.equal(opts.minContextSlot, 5); return seq[i++]; },
    sleep: async (ms) => { clock += ms; }, now: () => clock, log: (_c, m) => lines.push(m),
  });
  assert.equal(r.caught_up, true);
  assert.equal(r.balance, 2730);
  assert.match(lines[0], /RPC behind the close's slot vs expected ≈ 2,724 CLAUDIA \(try 1\/6\)/);
  assert.match(lines[1], /caught up after 2 s/);
});

test("waitForCloseTokens: reads that throw fall back to no reading (caller keeps its pooled read)", async () => {
  let clock = 0;
  const r = await waitForCloseTokens({
    mint: MINT, expectedTokens: 10, tries: 2,
    readBalance: async () => { throw new Error("boom"); },
    sleep: async (ms) => { clock += ms; }, now: () => clock,
  });
  assert.equal(r.caught_up, false);
  assert.equal(r.balance, null);
});

test("expectedCloseBaseTokens: position account first (transfer-fee-excluded), else the scan row", () => {
  const pd = { totalXAmount: "2700000000", feeX: new BN(24_400_000), totalXAmountExcludeTransferFee: new BN(2_690_000_000), feeXExcludeTransferFee: new BN(24_000_000) };
  assert.deepEqual(expectedCloseBaseTokens({ positionData: pd, decimals: 6 }), { tokens: 2714, source: "position_account" });
  assert.deepEqual(expectedCloseBaseTokens({ positionData: { totalXAmount: "2700000000", feeX: new BN(24_400_000) }, decimals: 6 }), { tokens: 2724.4, source: "position_account" });
  assert.deepEqual(expectedCloseBaseTokens({ cachedRow: { liq_x_amount: 2700, fee_x_amount: 24.4 } }), { tokens: 2724.4, source: "scan_row" });
  assert.equal(expectedCloseBaseTokens({ positionData: pd }), null, "no decimals and no row → unknown");
  assert.equal(expectedCloseBaseTokens({}), null);
});

test("shouldWaitForCloseTokens / fmtTokens / remainderUsd", () => {
  assert.equal(shouldWaitForCloseTokens(null), false);
  assert.equal(shouldWaitForCloseTokens(0), false, "all-SOL close returns no base");
  assert.equal(shouldWaitForCloseTokens(2724, 0.00008), true);
  assert.equal(shouldWaitForCloseTokens(1, 0.00008), false, "dust is not worth waiting for");
  assert.equal(fmtTokens(2724.4), "2,724");
  assert.equal(fmtTokens(31.55), "31.55");
  assert.equal(fmtTokens(0.000123456), "0.000123");
  assert.equal(remainderUsd({ remainderTokens: 100, swappedToken: { balance: 50, usd: 1 } }), 2);
  assert.equal(remainderUsd({ remainderTokens: 100, refPriceSol: 0.001, solPriceUsd: 100 }), 10);
  assert.equal(remainderUsd({ remainderTokens: 100 }), null);
  assert.match(remainderAboveCeilingMessage({ symbol: "<X>", usd: 30, tokens: 10, ceilingUsd: 25, escape: (s) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;") }), /&lt;X&gt; 10\.00 \(\$30\.00\)/);
});
