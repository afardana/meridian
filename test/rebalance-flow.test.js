process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";

import assert from "assert";

console.log("=== Testing Rebalance Execution Flow ===");

// 1. Test rebalancePositionState in state.js
{
  const { trackPosition, rebalancePositionState, getTrackedPosition } = await import("../state.js");
  const oldAddr = "TEST_OLD_POS_" + Date.now();
  const newAddr = "TEST_NEW_POS_" + Date.now();

  trackPosition({
    position: oldAddr,
    pool: "TEST_POOL_ADDR",
    pool_name: "ZCAT-SOL",
    base_mint: "MINT_ZCAT",
    amount_sol: 1.0,
    amount_x: 0,
    strategy: "spot",
    total_fees_claimed_sol: 0.05,
    total_fees_claimed_true_usd: 7.5,
    initial_value_usd: 150,
  });

  const oldPosBefore = getTrackedPosition(oldAddr);
  assert.strictEqual(oldPosBefore.rebalance_count ?? 0, 0);

  const newPos = rebalancePositionState({
    old_position_address: oldAddr,
    new_position_address: newAddr,
    new_bin_range: { min: -100, max: -31, active: -65, bins_below: 35, bins_above: 34 },
    new_strategy: "curve",
    amount_sol: 0.05,
    amount_x: 1000000,
    active_bin: -65,
    reason: "test rebalance",
  });

  const oldPosAfter = getTrackedPosition(oldAddr);
  assert.strictEqual(oldPosAfter.closed, true, "Old position should be marked closed");

  const trackedNew = getTrackedPosition(newAddr);
  assert.strictEqual(trackedNew.rebalance_count, 1, "New position rebalance_count should be 1");
  assert.strictEqual(trackedNew.parent_position, oldAddr, "New position parent_position should link to old position");
  assert.strictEqual(trackedNew.total_fees_claimed_sol, 0.05, "Claimed fees SOL should carry over to new position");
  assert.strictEqual(trackedNew.total_fees_claimed_true_usd, 7.5, "Claimed fees USD should carry over to new position");
  assert.strictEqual(trackedNew.strategy, "curve", "Strategy should be updated to target_strategy");

  console.log("✅ Test 1 Passed: rebalancePositionState correctly closes old pos, tracks new pos, carries over fees, links parent");
}

// 2. Test rebalancePosition in dlmm.js (Dry Run & Clamp to <= 70 bins)
{
  const { rebalancePosition } = await import("../tools/dlmm.js");

  // Case A: Requesting 80 bins total (40 below + 40 above) should be clamped to <= 70 bins
  const res = await rebalancePosition({
    position_address: "MOCK_ADDR",
    target_strategy: "curve",
    bins_below: 40,
    bins_above: 40,
    reason: "test clamp",
  });

  assert.strictEqual(res.dry_run, true);
  assert.ok(res.would_rebalance.total_bins <= 70, `Total bins ${res.would_rebalance.total_bins} must be <= 70`);
  console.log(`✅ Test 2 Passed: rebalancePosition dry-run clamps requested bins to <= 70 (resolved ${res.would_rebalance.total_bins} bins)`);
}

// 3. Test hold_mode safety guard for rebalance_position in executor.js
{
  const { trackPosition, setPositionHold, getTrackedPosition } = await import("../state.js");
  const { executeTool } = await import("../tools/executor.js");

  const holdPosAddr = "TEST_HOLD_POS_" + Date.now();
  trackPosition({
    position: holdPosAddr,
    pool: "TEST_POOL",
    pool_name: "TEST-HOLD",
    amount_sol: 1.0,
    strategy: "spot",
  });
  setPositionHold(holdPosAddr, true);
  assert.strictEqual(getTrackedPosition(holdPosAddr)?.hold_mode, true);

  // Attempt rebalance without operatorOverride -> MUST BE BLOCKED
  const blockedRes = await executeTool("rebalance_position", {
    position_address: holdPosAddr,
    reason: "autonomous test",
  }, { operatorOverride: false });

  assert.strictEqual(blockedRes.blocked, true, "rebalance_position must be blocked when hold_mode=true and operatorOverride=false");
  console.log("✅ Test 3 Passed: rebalance_position blocked by hold_mode when operatorOverride=false");

  // Attempt rebalance with operatorOverride -> MUST PROCEED (in dry run)
  const allowedRes = await executeTool("rebalance_position", {
    position_address: holdPosAddr,
    reason: "manual operator override",
  }, { operatorOverride: true });

  assert.strictEqual(allowedRes.blocked, undefined, "rebalance_position must not be blocked when operatorOverride=true");
  assert.strictEqual(allowedRes.dry_run, true, "rebalance_position proceeds to dry_run execution with operatorOverride=true");
  console.log("✅ Test 4 Passed: rebalance_position passes through with operatorOverride=true on On Hold position");
}

console.log("=== All Rebalance Execution Flow Tests Passed! ===");
process.exit(0);
