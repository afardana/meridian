process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { evaluateBurnEligibility } = await import("../tools/wallet.js");
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("burn rails: only cheap, orphaned, non-core tokens are burnable", () => {
  const opts = { openMints: new Set(["OPENMINT"]), maxUsd: 1, usdcMint: USDC };
  assert.equal(evaluateBurnEligibility({ mint: "M1", symbol: "MCAT", balance: 0.000001, usd: 0 }, opts).ok, true);
  assert.equal(evaluateBurnEligibility({ mint: "M2", symbol: "+++++", balance: 0.000001, usd: null }, opts).ok, true);
  assert.match(evaluateBurnEligibility({ mint: SOL, balance: 1, usd: 100 }, opts).reason, /SOL/);
  assert.match(evaluateBurnEligibility({ mint: USDC, balance: 5, usd: 5 }, opts).reason, /USDC/);
  assert.match(evaluateBurnEligibility({ mint: "OPENMINT", balance: 100, usd: 0.1 }, opts).reason, /open position/);
  assert.match(evaluateBurnEligibility({ mint: "M3", balance: 1000, usd: 4.2 }, opts).reason, /burnMaxUsd/);
  assert.match(evaluateBurnEligibility({ mint: "M4", balance: 0, usd: 0 }, opts).reason, /empty/);
  assert.equal(evaluateBurnEligibility({ mint: "M3", balance: 1000, usd: 4.2 }, { ...opts, maxUsd: 5 }).ok, true);
});

test("/burn is a confirm-gated Telegram menu, never an LLM tool", () => {
  const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(index, /if \(text === "\/burn"\) \{/);
  assert.match(index, /text\.startsWith\("burn:"\)/);
  // the burn itself only runs from the "go" branch, after the confirm card
  assert.match(index, /if \(action === "go"\) \{[\s\S]*?burnAndCloseTokenAccount\(mint\)/);
  assert.match(index, /callback_data: `burn:confirm:\$\{t\.mint\}`/);
  assert.match(index, /callback_data: `burn:go:\$\{t\.mint\}`/);
  assert.equal((index.match(/burnAndCloseTokenAccount\(/g) || []).length, 1, "exactly one call site");
  assert.match(index, /process\.env\.DRY_RUN === "true"[\s\S]{0,200}would burn/);
  const defs = fs.readFileSync(new URL("../tools/definitions.js", import.meta.url), "utf8");
  assert.doesNotMatch(defs, /burn_token|burnAndClose/);
  const tg = fs.readFileSync(new URL("../telegram.js", import.meta.url), "utf8");
  assert.match(tg, /command: "burn"/);
});
