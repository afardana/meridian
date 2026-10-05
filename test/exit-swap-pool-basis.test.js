process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { exitSwapSlippageSol } = await import("../lessons.js");
const { exitRefPriceSolPerBase } = await import("../tools/dlmm.js");

const WSOL = "So11111111111111111111111111111111111111112";

test("reference price: active-bin price in SOL per whole base token, SOL-quoted pools only", () => {
  const p = exitRefPriceSolPerBase({ activeId: -455, binStep: 100, decX: 6, decY: 9, quoteMint: WSOL });
  assert.ok(Math.abs(p - Math.pow(1.01, -455) * 1e-3) < 1e-15);
  assert.equal(exitRefPriceSolPerBase({ activeId: -455, binStep: 100, decX: 6, decY: 9, quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), null);
  assert.equal(exitRefPriceSolPerBase({ activeId: null, binStep: 100, decX: 6, decY: 9, quoteMint: WSOL }), null);
  assert.equal(exitRefPriceSolPerBase({ activeId: -455, binStep: 100, decX: undefined, decY: 9, quoteMint: WSOL }), null);
});

test("BACKERS-SOL 2026-10-05: the swap is a cost against the pool price (the feed booked a gain)", () => {
  // 18,840 tokens at bin -455 (step 100, 6 decimals) sold for 0.20099 SOL.
  const ref = exitRefPriceSolPerBase({ activeId: -455, binStep: 100, decX: 6, decY: 9, quoteMint: WSOL });
  const slip = exitSwapSlippageSol({ tokens_swapped: 18840, ref_price_sol: ref, sol_received: 0.20099 });
  assert.ok(slip > 0.002 && slip < 0.004, `expected ≈ 0.0027 (wallet: 0.0037), got ${slip}`);
});

test("a better-than-pool fill is a negative cost; missing or implausible inputs fall back", () => {
  assert.ok(exitSwapSlippageSol({ tokens_swapped: 1000, ref_price_sol: 0.0001, sol_received: 0.101 }) < 0);
  assert.equal(exitSwapSlippageSol({ tokens_swapped: 1000, ref_price_sol: null, sol_received: 0.1 }), null);
  assert.equal(exitSwapSlippageSol({ tokens_swapped: null, ref_price_sol: 0.0001, sol_received: 0.1 }), null);
  assert.equal(exitSwapSlippageSol({ tokens_swapped: 1000, ref_price_sol: 0.0001, sol_received: 0 }), null);
  // wrong decimals (reference 1000× the fill) must not be booked
  assert.equal(exitSwapSlippageSol({ tokens_swapped: 1000, ref_price_sol: 0.1, sol_received: 0.1 }), null);
});
