process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
// A leftover env override must have no effect either.
process.env.JUPITER_REFERRAL_ACCOUNT = "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey";
process.env.JUPITER_REFERRAL_FEE_BPS = "50";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Jupiter /order request carries no referral parameters ===");

const { buildJupiterOrderQuery } = await import("../tools/wallet.js");
const { config } = await import("../config.js");

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TAKER = "11111111111111111111111111111111";

// Real swap: taker, no slippage cap.
{
  const q = buildJupiterOrderQuery({ inputMint: USDC, outputMint: SOL, amountRaw: "1000000", taker: TAKER });
  assert.deepEqual([...q.keys()].sort(), ["amount", "inputMint", "outputMint", "taker"]);
  assert.equal(q.get("amount"), "1000000");
}
// Capped auto-swap: slippageBps added, rounded; nothing else.
{
  const q = buildJupiterOrderQuery({ inputMint: USDC, outputMint: SOL, amountRaw: 1000000, taker: TAKER, slippageBps: 499.6 });
  assert.deepEqual([...q.keys()].sort(), ["amount", "inputMint", "outputMint", "slippageBps", "taker"]);
  assert.equal(q.get("slippageBps"), "500");
}
// Hypothetical quote (skip_taker): three parameters only; a null / zero cap is not sent.
for (const slippageBps of [null, undefined, 0, NaN]) {
  const q = buildJupiterOrderQuery({ inputMint: SOL, outputMint: USDC, amountRaw: "1000000000", slippageBps });
  assert.deepEqual([...q.keys()].sort(), ["amount", "inputMint", "outputMint"]);
}
for (const q of [
  buildJupiterOrderQuery({ inputMint: SOL, outputMint: USDC, amountRaw: "1" }),
  buildJupiterOrderQuery({ inputMint: SOL, outputMint: USDC, amountRaw: "1", taker: TAKER, slippageBps: 500 }),
]) {
  assert.equal(q.has("referralAccount"), false);
  assert.equal(q.has("referralFee"), false);
  assert.doesNotMatch(q.toString(), /referral/i);
}

// Config holds nothing of the feature, even with the old env vars set.
assert.deepEqual(Object.keys(config.jupiter), ["apiKey"]);

// Both /order call sites go through the builder.
const walletSrc = fs.readFileSync(new URL("../tools/wallet.js", import.meta.url), "utf8");
assert.equal((walletSrc.match(/buildJupiterOrderQuery\(\{/g) || []).length, 3); // definition + quote + swap
assert.equal((walletSrc.match(/new URLSearchParams\(/g) || []).length, 1);

// Source level: the word does not occur in live code.
const root = new URL("../", import.meta.url);
const files = ["config.js", "index.js", ...fs.readdirSync(new URL("tools/", root)).filter((f) => f.endsWith(".js")).map((f) => `tools/${f}`)];
for (const f of files) {
  assert.doesNotMatch(fs.readFileSync(new URL(f, root), "utf8"), /referral/i, `${f} mentions the removed feature`);
}

console.log("✅ jupiter order query tests passed");
process.exit(0);
