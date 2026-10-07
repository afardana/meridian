process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { pnlPctBasisSol, rescalePctToCapital, calculateAssetAwareValue } = await import("../tools/pnl.js");
const { toStraddleCapitalBasis } = await import("../tools/dlmm.js");
const { config } = await import("../config.js");

// SAPLING-SOL ERM6jRNw (2026-10-03): 0.4 SOL capital, straddled in place once. Meteora's
// closed record: deposits 1.0315, withdrawals 0.9592, fees 0.0307 → pnl −0.0416 SOL,
// reported −4.03 % (on the gross deposits). On the capital it is −10.4 %.
const STRADDLED = { amount_sol: 0.4, straddle_count: 1 };
const close = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) < tol, `${a} ≈ ${b}`);

test("the percent basis is the capital only for a straddled position whose deposits were inflated", () => {
  assert.equal(pnlPctBasisSol(STRADDLED, 1.0315), 0.4);
  assert.equal(pnlPctBasisSol({ amount_sol: 0.4 }, 1.0315), 1.0315, "never re-ranged: Meteora's deposits");
  assert.equal(pnlPctBasisSol({ amount_sol: 2.03, rebalance_count: 1 }, 4.040), 2.03, "CTO-SOL: one Meteora-UI rebalance doubled the deposits");
  close(rescalePctToCapital(-41.0, { amount_sol: 2.03, rebalance_count: 1 }, 4.040), -81.6, 0.1);
  assert.equal(pnlPctBasisSol(STRADDLED, 0.39), 0.39, "indexer behind: deposits not inflated yet");
  close(rescalePctToCapital(-4.0325, STRADDLED, 1.0315), -10.4);
  assert.equal(rescalePctToCapital(5.86, { amount_sol: 0.4 }, 0.4), 5.86);
  assert.equal(rescalePctToCapital(null, STRADDLED, 1.0315), null);
});

test("live valuation: a straddled position's pnl % is on its capital (rules see the real move)", () => {
  config.tokens.SOL = config.tokens.SOL || "So11111111111111111111111111111111111111112";
  const SOL = config.tokens.SOL, X = "SaplingMint1111111111111111111111111111111";
  const f = { tokenXMint: X, tokenYMint: SOL, decX: 6, decY: 9, xRaw: "0", yRaw: String(0.42e9), feeXRaw: "0", feeYRaw: "0" };
  const meteora = { allTimeDeposits: { total: { usd: 120, sol: 1.0 } }, allTimeWithdrawals: { total: { usd: 72, sol: 0.6 } }, allTimeFees: { total: { usd: 0, sol: 0 } }, pnlSolPctChange: 2.0 };
  const prices = { [X]: 0.001, [SOL]: 120 };
  const plain = calculateAssetAwareValue(f, prices, 120, meteora, true, { amount_sol: 0.4 });
  const strad = calculateAssetAwareValue(f, prices, 120, meteora, true, STRADDLED);
  close(plain.pnlSol, 0.02, 1e-9);
  close(strad.pnlSol, 0.02, 1e-9);
  close(plain.pctSol, 2.0, 1e-6);
  close(strad.pctSol, 5.0, 1e-6, "0.02 SOL on 0.4 SOL");
  close(strad.reportedPct, 5.0, 1e-6, "Meteora's percent compared on the same basis (no false divergence)");
  close(strad.feeYieldPct + strad.ilPct, strad.pctSol, 1e-6);
});

test("closed record: percent on the capital, final + fees − initial still equals the pnl", () => {
  const rec = { pnl_sol: -0.0416, pnl_usd_true: -4.97, pnl_pct_sol: -4.0325, pnl_pct_usd: -4.0, initial_sol_true: 1.0315, initial_usd_true: 123.4,
    final_sol_true: 0.9592, final_usd_true: 114.8, fees_sol_true: 0.0307, fees_usd_true: 3.63, pnl_pct: -4.0325, initial_value: 1.0315, final_value: 0.9592 };
  const out = toStraddleCapitalBasis(rec, STRADDLED, true);
  close(out.pnl_pct, -10.4);
  assert.equal(out.initial_value, 0.4);
  close(out.final_value + rec.fees_sol_true - out.initial_value, rec.pnl_sol, 1e-9);
  assert.deepEqual(out.straddle_capital_basis, { capital_sol: 0.4, meteora_deposits_sol: 1.0315 });
  assert.equal(toStraddleCapitalBasis(rec, { amount_sol: 0.4 }, true), rec, "never re-ranged: unchanged");
});

test("wiring: every scan path and the close path measure straddled positions on capital; grace log names its source", () => {
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.match(dlmm, /reportedPnlPct = rescalePctToCapital\(maybeNum\(p\.pnlSolPctChange\), trackedPos, depSol\)/, "getPositionPnl");
  assert.match(dlmm, /rescalePctToCapital\(parseFloat\(binData\.pnlSolPctChange \|\| 0\), tracked, depSolForPct\)/, "getMyPositions fallback");
  assert.match(dlmm, /return toStraddleCapitalBasis\(rec, tracked, solMode\);/, "reconciliation closed record");
  assert.match(dlmm, /\[CAPITAL_BASIS\]/, "closePosition");
  const state = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
  assert.match(state, /\[STRADDLE_GRACE\] \$\{pos\.pool_name \|\| position_address\}: straddled position/);
  assert.match(state, /if \(adoptedProfitGraceRemainingMin\(pos, mgmtConfig\) > 0\) \{\s+log\("state", `\[ADOPT_GRACE\]/);
});

test("adoption rebase: a re-ranged account's re-deposits are not counted as top-ups", async () => {
  const { applyAdoptionBasis } = await import("../state.js");
  const basis = { at: "2026-09-25T00:00:00Z", deposits_sol: 1.0, withdrawals_sol: 0, pnl_sol: 0, fees_sol: 0, pnl_usd: 0, fees_usd: 0 };
  // adopted with 1.0 SOL, rebalanced once in Meteora's UI (+1.0 deposit, +1.0 withdrawal), closed +0.05 SOL
  const lifetime = { pnl_sol: 1.05, pnl_usd_true: 126, fees_sol_true: 0.02, fees_usd_true: 2.4, deposit_sol_true: 2.0, deposit_usd_true: 240, sol_price_usd: 120 };
  const rebalanced = applyAdoptionBasis({ adoption_basis: basis, amount_sol: 1.0, rebalance_count: 1 }, lifetime);
  close(rebalanced.pnl_sol, 0.05, 1e-9);
  close(rebalanced.pnl_pct, 5.0, 1e-9);
  const topUp = applyAdoptionBasis({ adoption_basis: basis, amount_sol: 1.0 }, lifetime);
  close(topUp.pnl_pct, 2.5, 1e-9, "never re-ranged: the extra deposit is a top-up (unchanged behaviour)");
});

test("adoption rebase: the USD deposit follows the SOL deposit in all three close paths", () => {
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal((dlmm.match(/recovered\.initial_usd_true \*= adj\.deposit_sol_true \/ recovered\.initial_sol_true/g) || []).length, 2);
  // closePosition (closed API and, since 2026-10-07, the cache fallback) goes through
  // rebaseCloseToAdoption — numbers in test/adoption-cache-fallback.test.js.
  assert.match(dlmm, /depUsdTrue: v\.depSolTrue > 0 \? v\.depUsdTrue \* \(adj\.deposit_sol_true \/ v\.depSolTrue\) : v\.depUsdTrue,\s+depSolTrue: adj\.deposit_sol_true,/);
});
