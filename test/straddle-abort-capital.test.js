process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const S = await import("../state.js");
const { pnlPctBasisSol } = await import("../tools/pnl.js");
await S.ensureStateInitialized();

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingOvershootPct: 0.5, stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 0 };
const data = (pnl, over = {}) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: -408, lower_bin: -445, upper_bin: -379, pnl_quality: "valid", ...over });

// Agency-SOL BQUveLt9, 2026-10-03 14:09: harvest at +2.36 %, straddle stage A re-centred the
// account and withdrew 0.2022 SOL, the buy was refused (impact 3.78 % > 3 %). Meteora then
// showed deposits 0.6071 / withdrawals 0.3999 / pnl +0.00947 SOL — real +2.37 % on 0.4 SOL.
test("a straddle aborted after stage A counts as an in-place re-range: pnl % stays on the capital", () => {
  const P = `ABORT_${Date.now()}`;
  S.trackPosition({ position: P, pool: "POOL_A", pool_name: "Agency-SOL", strategy: "spot", amount_sol: 0.4, initial_value_usd: 47.4, bin_range: [-483, -418], active_bin: -411 });
  try {
    S.notePositionStraddleFailure(P, "straddle aborted at stage A", { bin_range: { min: -445, max: -379 } });
    const pos = S.getTrackedPosition(P);
    assert.equal(pos.in_place_rerange_count, 1);
    assert.equal(pnlPctBasisSol(pos, 0.6071), 0.4);
    assert.ok(Math.abs((0.00947 / pnlPctBasisSol(pos, 0.6071)) * 100 - 2.37) < 0.01);
    S.notePositionStraddleFailure(P, "same range again", { bin_range: { min: -445, max: -379 } });
    assert.equal(S.getTrackedPosition(P).in_place_rerange_count, 1, "no re-range, no count");
  } finally { try { S.closeTrackedPosition(P, "test"); } catch {} }
});

test("our own straddle withdrawal is not an external capital change; a real top-up still is", () => {
  const P = `ABORT2_${Date.now()}`;
  S.trackPosition({ position: P, pool: "POOL_A", pool_name: "Agency-SOL", strategy: "spot", amount_sol: 0.4, initial_value_usd: 47.4, bin_range: [-445, -379], active_bin: -408 });
  try {
    S.recordPendingFlow(P, { net_sol_expected: 0.1978, reason: "straddle withdraw" });
    // while the indexer still shows the old net, nothing is reconciled
    S.updatePnlAndCheckExits(P, data(2.36, { net_deposit_sol: 0.4 }), mgmt);
    assert.equal(S.getTrackedPosition(P).amount_sol, 0.4);
    S.clearPendingFlow(P);
    // indexer caught up: net 0.2072 (re-deposit incl. claimed fees) — still our own flow
    S.updatePnlAndCheckExits(P, data(2.37, { net_deposit_sol: 0.2072 }), mgmt);
    assert.equal(S.getTrackedPosition(P).amount_sol, 0.4, "capital unchanged by our own withdrawal");
    // the operator adds 0.2 SOL in the UI
    S.updatePnlAndCheckExits(P, data(1.6, { net_deposit_sol: 0.4072 }), mgmt);
    const pos = S.getTrackedPosition(P);
    assert.equal(pos.amount_sol, 0.6, "only the external part changes the capital");
    assert.equal(pos.expected_net_deposit_sol, 0.4072);
  } finally { try { S.closeTrackedPosition(P, "test"); } catch {} }
});

test("positions without our own flows keep the old reconciliation (amount_sol follows the net)", () => {
  const P = `ABORT3_${Date.now()}`;
  S.trackPosition({ position: P, pool: "POOL_A", pool_name: "X-SOL", strategy: "spot", amount_sol: 0.4, initial_value_usd: 47.4, bin_range: [-445, -379], active_bin: -408 });
  try {
    S.updatePnlAndCheckExits(P, data(0.5, { net_deposit_sol: 0.6 }), mgmt);
    assert.equal(S.getTrackedPosition(P).amount_sol, 0.6);
  } finally { try { S.closeTrackedPosition(P, "test"); } catch {} }
});
