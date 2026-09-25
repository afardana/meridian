process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Testing Rebalance Lineage State & Root-Basis Reader ===");
// The lineage take-profit rule and the root_initial_* writers were removed
// 2026-09-25 (audit 01 §3). What remains: the rebalance chain bookkeeping
// (rebalance_count / parent_position / cumulative fees) used by the manual
// /rebalance path, and resolveRootInitialBasis as a READER that walks
// parent_position pointers (honouring legacy stored root_initial_* values).

const {
  trackPosition,
  rebalancePositionState,
  getTrackedPosition,
  closeTrackedPosition,
  resolveRootInitialBasis,
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
  assert.equal(rootPos.root_initial_sol, undefined, "root_initial_sol is no longer computed");
  assert.equal(rootPos.root_initial_usd, undefined, "root_initial_usd is no longer computed");
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
    amount_sol: 0.98,
    amount_x: 0,
    active_bin: 95,
    reason: "test rebalance 1",
  });

  assert.ok(getTrackedPosition(POS_ROOT).closed, "Root position should now be closed");

  const child1Pos = getTrackedPosition(POS_CHILD1);
  assert.ok(child1Pos, "Child 1 position should exist");
  assert.equal(child1Pos.rebalance_count, 1, "rebalance_count should be 1");
  assert.equal(child1Pos.parent_position, POS_ROOT, "parent_position should be POS_ROOT");
  assert.equal(child1Pos.root_parent_position, undefined, "root_parent_position is no longer computed");
  assert.equal(child1Pos.cumulative_fees_claimed_sol, 0.03, "cumulative_fees_claimed_sol should carry forward 0.03 SOL");
  assert.equal(child1Pos.total_fees_claimed_sol, 0, "child1 fresh fees claimed should start at 0");

  child1Pos.total_fees_claimed_sol = 0.02;
  child1Pos.total_fees_claimed_usd = 3.0;
  child1Pos.cumulative_fees_claimed_sol = (child1Pos.cumulative_fees_claimed_sol || 0) + 0.02;
  child1Pos.cumulative_fees_claimed_usd = (child1Pos.cumulative_fees_claimed_usd || 0) + 3.0;

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
  assert.equal(child2Pos.cumulative_fees_claimed_sol, 0.05, "cumulative_fees_claimed_sol should be 0.03 + 0.02 = 0.05 SOL");

  console.log("✅ Lineage state transitions verified");

  // ── 4. resolveRootInitialBasis walks parent pointers to the root's amount_sol ──
  {
    const basis2 = resolveRootInitialBasis(child2Pos);
    assert.equal(basis2.sol, 1.0, "Should resolve root basis (1.0 SOL) via the parent walk");
    assert.equal(basis2.usd, 150.0);
    assert.equal(basis2.rootPosition, POS_ROOT);

    // Legacy stored values are still honoured
    const legacyStored = { position: "LEGACY_STORED", parent_position: POS_ROOT, amount_sol: 0.85, root_initial_sol: 2.5, root_initial_usd: 300 };
    const storedBasis = resolveRootInitialBasis(legacyStored);
    assert.equal(storedBasis.sol, 2.5, "Stored root_initial_sol wins when present");
    assert.equal(storedBasis.usd, 300);

    // Orphan position with no parent
    const orphanBasis = resolveRootInitialBasis({ position: "ORPHAN_TEST", amount_sol: 0.5, initial_value_usd: 75.0 });
    assert.equal(orphanBasis.sol, 0.5);
    assert.equal(orphanBasis.usd, 75.0);

    console.log("✅ resolveRootInitialBasis reader verified (parent walk + legacy stored values)");
  }
} finally {
  try { closeTrackedPosition(POS_ROOT, "test completed"); } catch {}
  try { closeTrackedPosition(POS_CHILD1, "test completed"); } catch {}
  try { closeTrackedPosition(POS_CHILD2, "test completed"); } catch {}
}

console.log("🎉 ALL LINEAGE STATE TESTS PASSED!");
