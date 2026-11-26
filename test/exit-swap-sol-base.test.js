process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// The auto-swap never sells SOL for SOL (2026-11-26). SOL-HYPE Hm6oyHv3 (operator, closed
// 2026-11-25 22:18 WIB): token X = wSOL, so the close's base_mint was wSOL and the "after close"
// swap tried to sell the wallet's whole free SOL (◎2.5756) three times; Jupiter refused each
// (same-token swap). The HYPE leg is sold by the asset_mints call, which must keep working.
import { test } from "node:test";
import assert from "node:assert/strict";

const { swapBaseToSolWithRetry } = await import("../tools/executor.js");
const { config } = await import("../config.js");

const WSOL = "So11111111111111111111111111111111111111112";
const HYPE = "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g";

config.management.autoSwapRetryAttempts = 3;
config.management.autoSwapRetryDelayMs = 3000;
config.management.dustSweepMaxUsd = 25;
config.management.exitSwapGuardEnabled = false;
config.management.swapSlippageCapEnabled = false;

function captureLogs() {
  const lines = [];
  const orig = console.error;
  const origLog = console.log;
  console.error = (...a) => { lines.push(a.join(" ")); };
  console.log = (...a) => { lines.push(a.join(" ")); };
  return { lines, restore: () => { console.error = orig; console.log = origLog; } };
}

// Every dependency records its call; the SOL path must touch none of them.
function makeDeps({ mint, balance = 10, usd = 50 }) {
  const calls = { balances: 0, fresh: 0, quotes: 0, swaps: [], sleeps: 0, telegram: 0 };
  const deps = {
    now: () => 0,
    sleep: async () => { calls.sleeps++; },
    readWalletMintBalance: async () => { calls.fresh++; return { balance: 0, behind: false }; },
    getWalletBalances: async () => {
      calls.balances++;
      return { sol_price: 140, tokens: [{ mint, symbol: mint === WSOL ? "SOL" : "HYPE", balance, usd }] };
    },
    getSwapQuote: async () => { calls.quotes++; return { out_amount: null }; },
    swapToken: async (args) => { calls.swaps.push(args); return { success: true, tx: "SwapSig", amount_out: 350_000_000 }; },
    sendHTML: async () => { calls.telegram++; },
  };
  return { deps, calls };
}

test("base mint is wSOL → returns at once: no wait, read, quote, swap, retry, remainder check or Telegram", async () => {
  for (const mint of [WSOL, "SOL"]) {
    const { deps, calls } = makeDeps({ mint: WSOL, balance: 2.5756, usd: 360 });
    const cap = captureLogs();
    let out;
    try {
      out = await swapBaseToSolWithRetry(mint, "after close", {
        expectedTokens: 2.5756, minContextSlot: 455_000_000, refPriceSol: 1,
        checkRemainder: true, pair: "SOL-HYPE", deps,
      });
    } finally { cap.restore(); }
    assert.deepEqual(out, { swapped: false, result: null, token: null, base_is_sol: true });
    assert.equal(out.skipped_high_impact, undefined);
    assert.equal(out.remainder_above_ceiling, undefined);
    assert.deepEqual(calls, { balances: 0, fresh: 0, quotes: 0, swaps: [], sleeps: 0, telegram: 0 });
    const hits = cap.lines.filter((l) => l.includes("[EXIT_SWAP] SOL-HYPE: base token is SOL — nothing to swap"));
    assert.equal(hits.length, 1);
    assert.ok(!cap.lines.some((l) => /Auto-swap|attempt|unsold|waiting for the close/i.test(l)), cap.lines.join("\n"));
  }
});

test("dust-sweep / after-claim labels: same early return, label shown when no pair", async () => {
  const { deps, calls } = makeDeps({ mint: WSOL });
  const cap = captureLogs();
  let out;
  try { out = await swapBaseToSolWithRetry(WSOL, "dust sweep", { deps }); } finally { cap.restore(); }
  assert.equal(out.base_is_sol, true);
  assert.equal(calls.swaps.length, 0);
  assert.ok(cap.lines.some((l) => l.includes("[EXIT_SWAP] dust sweep: base token is SOL — nothing to swap")));
});

test("a normal base mint (the HYPE Y leg) still swaps", async () => {
  const { deps, calls } = makeDeps({ mint: HYPE, balance: 12.5, usd: 60 });
  const cap = captureLogs();
  let out;
  try { out = await swapBaseToSolWithRetry(HYPE, "after close", { urgent: true, deps }); } finally { cap.restore(); }
  assert.equal(out.swapped, true);
  assert.equal(out.base_is_sol, undefined);
  assert.equal(calls.swaps.length, 1);
  assert.equal(calls.swaps[0].input_mint, HYPE);
  assert.equal(calls.swaps[0].output_mint, "SOL");
  assert.equal(calls.swaps[0].amount, 12.5);
});
