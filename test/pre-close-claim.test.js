process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { preCloseClaimDecision } = await import("../tools/dlmm.js");

test("every close skips the standalone claim by default (trailing TP, harvest, OOR, stop)", () => {
  assert.equal(preCloseClaimDecision({}).skip, true);
  assert.equal(preCloseClaimDecision({ fastCloseSkipClaim: true }).skip, true);
  assert.equal(preCloseClaimDecision({ fastCloseSkipClaim: undefined }).skip, true);
});

test("fastCloseSkipClaim=false restores the claim on automatic closes only", () => {
  assert.equal(preCloseClaimDecision({ fastCloseSkipClaim: false }).skip, false);
  assert.equal(preCloseClaimDecision({ fastCloseSkipClaim: false, isManual: true }).skip, true);
  assert.equal(preCloseClaimDecision({ fastCloseSkipClaim: false, skipClaimArg: true }).skip, true);
  assert.equal(preCloseClaimDecision({ fastCloseSkipClaim: false, recentlyClaimed: true }).skip, true);
});
