process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Valuation: base token priced at the pool's active bin ===");

const { poolPriceUsdOfBase, calculateAssetAwareValue } = await import("../tools/pnl.js");
const { config } = await import("../config.js");

const SOL = config.tokens.SOL, X = "BASEMINT111111111111111111111111111111111111";
const solUsd = 120;
// bin −440, step 100, 6-decimal token vs 9-decimal SOL.
const perBase = Math.pow(1.01, -440) * 1e-3;                     // SOL per token
assert.ok(Math.abs(poolPriceUsdOfBase({ active: -440, binStep: 100 }, { decX: 6, decY: 9, priceY: solUsd }) - perBase * solUsd) < 1e-15);
assert.equal(poolPriceUsdOfBase({ active: null, binStep: 100 }, { decX: 6, decY: 9, priceY: solUsd }), null);
assert.equal(poolPriceUsdOfBase({ active: -440, binStep: null }, { decX: 6, decY: 9, priceY: solUsd }), null);
assert.equal(poolPriceUsdOfBase({ active: -440, binStep: 100 }, { decX: 6, decY: 9, priceY: 0 }), null);

// A position holding 20,000 tokens + 0.5 SOL. The market feed says the token is worth 4 % more
// than the pool's bin; the valuation must not move with the feed.
const f = { tokenXMint: X, tokenYMint: SOL, decX: 6, decY: 9, xRaw: 20000 * 1e6, yRaw: 0.5 * 1e9, feeXRaw: 0, feeYRaw: 0, active: -440, binStep: 100, lower: -470, upper: -410 };
const tracked = { amount_sol: 0.79 };
const value = (marketMult) => calculateAssetAwareValue(f, { [SOL]: solUsd, [X]: perBase * solUsd * marketMult }, solUsd, null, true, tracked);
const a = value(1.04), b = value(0.97);
const solOf = (v) => v.balancesSol ?? v.currentValueSol ?? null;
assert.ok(Number.isFinite(solOf(a)), "valuation exposes the SOL balance");
assert.ok(Math.abs(solOf(a) - solOf(b)) < 1e-9, "market-feed jitter does not move the valuation");
assert.ok(Math.abs(solOf(a) - (20000 * perBase + 0.5)) < 1e-9, "tokens are valued at the active-bin price");
assert.ok(Math.abs(a.priceX - perBase * solUsd) < 1e-12);

// Rollback switch: "market" restores the feed.
config.management.valuationPriceSource = "market";
assert.ok(Math.abs(solOf(value(1.04)) - (20000 * perBase * 1.04 + 0.5)) < 1e-9);
config.management.valuationPriceSource = "pool";
// No active bin known → falls back to the feed rather than valuing tokens at zero.
const g = { ...f, active: null };
assert.ok(Math.abs(solOf(calculateAssetAwareValue(g, { [SOL]: solUsd, [X]: perBase * solUsd * 1.04 }, solUsd, null, true, tracked)) - (20000 * perBase * 1.04 + 0.5)) < 1e-9);

console.log("✅ pool-price valuation verified");
process.exit(0);
