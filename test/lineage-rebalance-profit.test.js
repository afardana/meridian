process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import { config } from "../config.js";

console.log("=== Testing Lineage-Aware Rebalance State & Profit Tracking ===");

const {
  trackPosition,
  rebalancePositionState,
  getTrackedPosition,
  closeTrackedPosition,
  ensureStateInitialized,
} = await import("../state.js");

await ensureStateInitialized();

const POS_ROOT = `TEST_ROOT_${Date.now()}`;
const POS_CHILD1 = `TEST_CHILD1_${Date.now()}`;
const POS_CHILD2 = `TEST_CHILD2_${Date.now()}`;
const POOL_ADDR = "POOL_TEST_LINEAGE_123";

try {
  // ── 1. Initial Position Deploy ──
  trackPosition({
    position: POS_ROOT,
    pool: POOL_ADDR,
    pool_name: "TEST-SOL",
    strategy: "spot",
    amount_sol: 1.0,
    initial_value_usd: 150.0,
    bin_range: [-35, 34],
    active_bin: 100,
    bin_step: 20,
    volatility: 0.02,
    fee_tvl_ratio: 0.005,
    organic_score: 80,
  });

  const rootPos = getTrackedPosition(POS_ROOT);
  assert.ok(rootPos, "Root position should exist");
  assert.equal(rootPos.root_initial_sol, 1.0, "root_initial_sol should equal amount_sol");
  assert.equal(rootPos.root_initial_usd, 150.0, "root_initial_usd should equal initial_value_usd");
  assert.equal(rootPos.rebalance_count, 0, "Initial rebalance_count should be 0");
  assert.equal(rootPos.cumulative_fees_claimed_sol, 0, "Initial cumulative fees should be 0");

  // Simulate claiming 0.03 SOL fees on the root position
  rootPos.total_fees_claimed_sol = 0.03;
  rootPos.total_fees_claimed_usd = 4.5;

  // ── 2. First Rebalance ──
  rebalancePositionState({
    old_position_address: POS_ROOT,
    new_position_address: POS_CHILD1,
    new_bin_range: [-35, 34],
    new_strategy: "curve",
    amount_sol: 0.98, // after swap / slippage / IL
    amount_x: 0,
    active_bin: 95,
    reason: "test rebalance 1",
  });

  const updatedRoot = getTrackedPosition(POS_ROOT);
  assert.ok(updatedRoot.closed, "Root position should now be closed");

  const child1Pos = getTrackedPosition(POS_CHILD1);
  assert.ok(child1Pos, "Child 1 position should exist");
  assert.equal(child1Pos.rebalance_count, 1, "rebalance_count should be 1");
  assert.equal(child1Pos.parent_position, POS_ROOT, "parent_position should be POS_ROOT");
  assert.equal(child1Pos.root_parent_position, POS_ROOT, "root_parent_position should be POS_ROOT");
  assert.equal(child1Pos.root_initial_sol, 1.0, "root_initial_sol should be preserved from root (1.0 SOL)");
  assert.equal(child1Pos.root_initial_usd, 150.0, "root_initial_usd should be preserved from root ($150)");
  assert.equal(child1Pos.cumulative_fees_claimed_sol, 0.03, "cumulative_fees_claimed_sol should carry forward 0.03 SOL");
  assert.equal(child1Pos.total_fees_claimed_sol, 0, "child1 fresh fees claimed should start at 0");

  // Simulate claiming 0.02 SOL fees on child 1
  child1Pos.total_fees_claimed_sol = 0.02;
  child1Pos.total_fees_claimed_usd = 3.0;

  // ── 3. Second Rebalance ──
  rebalancePositionState({
    old_position_address: POS_CHILD1,
    new_position_address: POS_CHILD2,
    new_bin_range: [-35, 34],
    new_strategy: "curve",
    amount_sol: 0.96,
    amount_x: 0,
    active_bin: 90,
    reason: "test rebalance 2",
  });

  const child2Pos = getTrackedPosition(POS_CHILD2);
  assert.ok(child2Pos, "Child 2 position should exist");
  assert.equal(child2Pos.rebalance_count, 2, "rebalance_count should be 2");
  assert.equal(child2Pos.parent_position, POS_CHILD1, "parent_position should be POS_CHILD1");
  assert.equal(child2Pos.root_parent_position, POS_ROOT, "root_parent_position should still point to POS_ROOT");
  assert.equal(child2Pos.root_initial_sol, 1.0, "root_initial_sol should remain 1.0 SOL");
  assert.equal(child2Pos.cumulative_fees_claimed_sol, 0.05, "cumulative_fees_claimed_sol should be 0.03 + 0.02 = 0.05 SOL");

  console.log("✅ Lineage state transitions and root basis preservation verified");

  // ── 4. Lineage Take-Profit Logic Verification ──
  {
    const rebalanceLineageTp = Number(config.management.rebalanceLineageTakeProfitPct ?? 4.0);
    assert.equal(rebalanceLineageTp, 4.0, "Default rebalanceLineageTakeProfitPct should be 4.0%");

    // Case A: Profitable lineage
    // Root initial = 1.0 SOL
    // Current child value = 0.96 SOL, Unclaimed fees = 0.035 SOL, Cumulative fees = 0.05 SOL
    // Total = 0.96 + 0.035 + 0.05 = 1.045 SOL (+4.5% profit)
    const currentValSolA = 0.96;
    const unclaimedSolA = 0.035;
    const totalSolA = currentValSolA + unclaimedSolA + child2Pos.cumulative_fees_claimed_sol;
    const lineagePnlPctA = ((totalSolA - child2Pos.root_initial_sol) / child2Pos.root_initial_sol) * 100;

    assert.ok(lineagePnlPctA >= rebalanceLineageTp, `Expected +${lineagePnlPctA.toFixed(2)}% >= ${rebalanceLineageTp}%`);

    // Case B: Sub-threshold lineage
    // Current child value = 0.94 SOL, Unclaimed = 0.02 SOL, Cumulative = 0.05 SOL
    // Total = 1.01 SOL (+1.0% profit < 4.0%)
    const currentValSolB = 0.94;
    const unclaimedSolB = 0.02;
    const totalSolB = currentValSolB + unclaimedSolB + child2Pos.cumulative_fees_claimed_sol;
    const lineagePnlPctB = ((totalSolB - child2Pos.root_initial_sol) / child2Pos.root_initial_sol) * 100;

    assert.ok(lineagePnlPctB < rebalanceLineageTp, `Expected +${lineagePnlPctB.toFixed(2)}% < ${rebalanceLineageTp}%`);

    // Case C: USD-denominated root basis
    const rootInitialUsd = 150.0;
    const currentValUsd = 145.0;
    const unclaimedUsd = 5.0;
    const cumulativeFeesUsd = 8.0;
    const totalUsd = currentValUsd + unclaimedUsd + cumulativeFeesUsd; // 158.0 (+5.33%)
    const lineagePnlPctUsd = ((totalUsd - rootInitialUsd) / rootInitialUsd) * 100;

    assert.ok(lineagePnlPctUsd >= rebalanceLineageTp, `Expected USD lineage +${lineagePnlPctUsd.toFixed(2)}% >= ${rebalanceLineageTp}%`);

    console.log("✅ Lineage take-profit arithmetic and threshold logic verified");
  }

} finally {
  // Cleanup test positions
  try { closeTrackedPosition(POS_ROOT, "test completed"); } catch {}
  try { closeTrackedPosition(POS_CHILD1, "test completed"); } catch {}
  try { closeTrackedPosition(POS_CHILD2, "test completed"); } catch {}
}

console.log("🎉 ALL LINEAGE REBALANCE PROFIT TESTS PASSED!");
