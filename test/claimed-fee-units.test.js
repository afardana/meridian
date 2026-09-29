process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";

const { calculateAssetAwareValue } = await import("../tools/pnl.js");
const { config } = await import("../config.js");

// baton-SOL (An5omTNd…), 2026-09-29: Meteora −$37.55 / −0.4724 SOL; Meridian showed −$24.27
// because the claimed-fee floor re-priced 0.7037 claimed SOL at today's $119.56.
const SOL = config.tokens.SOL;
const BATON = "BatonMint11111111111111111111111111111111111";
const solUsd = 119.56;
const prices = { [BATON]: 92.1729 / 23809.349626, [SOL]: solUsd };
const f = { tokenXMint: BATON, tokenYMint: SOL, decX: 6, decY: 9, xRaw: "23809349626", yRaw: "0", feeXRaw: "0", feeYRaw: "0" };
const meteora = {
  allTimeDeposits: { total: { usd: 308.7364, sol: 3.0642187 } },
  allTimeWithdrawals: { total: { usd: 108.1461, sol: 1.1176940 } },
  allTimeFees: { total: { usd: 70.8595, sol: 0.7032157 } },
};
const ledger = { total_fees_claimed_true_usd: 70.9217, total_fees_claimed_sol: 0.7037248, total_fees_claimed_usd: 0.7037248 };

test("claimed fees are not re-priced at today's SOL price (baton-SOL)", () => {
  const v = calculateAssetAwareValue(f, prices, solUsd, meteora, true, ledger);
  assert.ok(Math.abs(v.claimedUsd - 70.9217) < 1e-6, `claimed USD ${v.claimedUsd}`);
  assert.ok(Math.abs(v.pnlUsd - -37.49) < 0.05, `USD PnL ${v.pnlUsd} should match Meteora's −37.55 within the ledger/indexer gap`);
  assert.ok(Math.abs(v.pnlSol - -0.4716) < 0.002, `SOL PnL ${v.pnlSol}`);
});

test("SOL fell since the claims: the SOL ledger is used, not USD ÷ today's price", () => {
  const v = calculateAssetAwareValue(f, { ...prices, [SOL]: 80 }, 80, meteora, true, ledger);
  assert.ok(Math.abs(v.claimedSol - 0.7037248) < 1e-6, `claimed SOL ${v.claimedSol} (70.92 / 80 would be 0.8865)`);
});

test("indexer lag right after a claim: the ledger still floors both units", () => {
  const lagging = { ...meteora, allTimeFees: { total: { usd: 0, sol: 0 } } };
  const v = calculateAssetAwareValue(f, prices, solUsd, lagging, true, ledger);
  assert.ok(Math.abs(v.claimedUsd - 70.9217) < 1e-6);
  assert.ok(Math.abs(v.claimedSol - 0.7037248) < 1e-6);
});

test("a ledger with only one unit falls back to converting it", () => {
  const lagging = { ...meteora, allTimeFees: { total: { usd: 0, sol: 0 } } };
  const onlySol = calculateAssetAwareValue(f, prices, solUsd, lagging, false, { total_fees_claimed_sol: 0.5 });
  assert.ok(Math.abs(onlySol.claimedUsd - 0.5 * solUsd) < 1e-6);
  const onlyUsd = calculateAssetAwareValue(f, prices, solUsd, lagging, false, { total_fees_claimed_true_usd: 60 });
  assert.ok(Math.abs(onlyUsd.claimedSol - 60 / solUsd) < 1e-9);
});
