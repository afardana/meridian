process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

// 2026-10-20: estimateExitGasCost added the cached priority fee (micro-lamports per compute
// unit) to 5,000 lamports as if it were lamports, for 5 transactions that still included a
// standalone claim not sent since 2026-10-05. DOPE-SOL showed ◎0.0178 of "gas" (4 % of its
// 0.45 SOL capital) against a measured close + exit-swap gas of ≈ ◎0.00002–0.0003.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }), text: async () => "" });

const D = await import("../tools/dlmm.js");
const { exitGasLamports, estimateExitGasCost, EXIT_GAS_TXS } = D;

test("a close is 3 transactions: close (claim in-transaction), exit swap, ATA reclaim", () => {
  assert.deepEqual(EXIT_GAS_TXS.map((t) => t.label), ["close", "swap", "ata"]);
  assert.equal(EXIT_GAS_TXS.find((t) => t.label === "close").computeUnits, 400_000);
  assert.equal(EXIT_GAS_TXS.find((t) => t.label === "swap").computeUnits, 300_000);
});

test("an empty fee cache costs 3 base fees", () => {
  assert.equal(exitGasLamports(0), 3 * 5000);
  assert.equal(exitGasLamports(), 3 * 5000);
  // nothing has been fetched in this process: the live estimator reads the same empty cache
  assert.equal(estimateExitGasCost(), 15_000 / 1e9);
});

test("the fee is converted from micro-lamports per compute unit", () => {
  // 300,000 uL/CU: close 120,000 + swap 90,000 + ata 60,000 lamports, + 3 x 5,000 base
  const lamports = exitGasLamports(300_000);
  assert.equal(lamports, 15_000 + 120_000 + 90_000 + 60_000);
  const sol = lamports / 1e9;
  assert.ok(sol > 0.0002 && sol < 0.0006, `got ${sol}`);
  // the old model: 5 x (5,000 + 300,000) lamports = 0.001525 SOL, ~5x too high at this fee
  assert.ok(sol < (5 * (5000 + 300_000)) / 1e9 / 4);
});

test("a stale high fee is capped per transaction at the exit cap", () => {
  const capped = exitGasLamports(5_000_000, 300_000);
  assert.equal(capped, exitGasLamports(300_000));
  // at the default exit cap (3,000,000 uL/CU) the worst case is still bounded: 3 tx x 900k CU total
  assert.equal(exitGasLamports(50_000_000, 3_000_000), 15_000 + 3_000_000 * 900_000 / 1e6);
  // a fee under the cap is untouched
  assert.equal(exitGasLamports(10_000, 300_000), 15_000 + 10_000 * 900_000 / 1e6);
});

test("garbage fees fall back to the base fee", () => {
  assert.equal(exitGasLamports(NaN), 15_000);
  assert.equal(exitGasLamports(-5), 15_000);
  assert.equal(exitGasLamports(100, NaN), 15_000 + 100 * 900_000 / 1e6);
});
