import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

test("Autonomous Roll-Up: rebalancePosition clamps single-sided ladder to <= 70 bins", async () => {
  const { rebalancePosition } = await import("../tools/dlmm.js");

  // 1. Exact 69 below + 0 above (total 70 bins)
  const res1 = await rebalancePosition({
    position_address: "MOCK_ROLLUP_ADDR_1",
    target_strategy: "spot",
    bins_below: 69,
    bins_above: 0,
    reason: "Autonomous roll-up: 4-candle 15m trend increasing",
  });

  assert.equal(res1.dry_run, true);
  assert.equal(res1.would_rebalance.bins_below, 69);
  assert.equal(res1.would_rebalance.bins_above, 0);
  assert.equal(res1.would_rebalance.total_bins, 70, "Total bins must equal 70 (69 + 0 + 1)");
  assert.equal(res1.would_rebalance.target_strategy, "spot");

  // 2. Oversized 80 below + 0 above should clamp to <= 70 bins
  const res2 = await rebalancePosition({
    position_address: "MOCK_ROLLUP_ADDR_2",
    target_strategy: "spot",
    bins_below: 80,
    bins_above: 0,
    reason: "Autonomous roll-up clamp check",
  });

  assert.equal(res2.dry_run, true);
  assert.ok(res2.would_rebalance.total_bins <= 70, "Total bins must clamp to <= 70");
  assert.equal(res2.would_rebalance.bins_above, 0);
});

test("Autonomous Roll-Up: state transition preserves fee history and increments rebalance_count", async () => {
  const { trackPosition, rebalancePositionState, getTrackedPosition, ensureStateInitialized } = await import("../state.js");
  await ensureStateInitialized();

  const oldAddr = "TEST_ROLLUP_OLD_" + Date.now();
  const newAddr = "TEST_ROLLUP_NEW_" + Date.now();

  trackPosition({
    position: oldAddr,
    pool: "TEST_ROLLUP_POOL",
    pool_name: "Rollup-SOL",
    base_mint: "MINT_ROLLUP",
    amount_sol: 1.5,
    amount_x: 0,
    strategy: "spot",
    total_fees_claimed_sol: 0.12,
    total_fees_claimed_true_usd: 18.0,
    initial_value_usd: 220,
  });

  const oldPos = getTrackedPosition(oldAddr);
  assert.equal(oldPos.rebalance_count ?? 0, 0);

  rebalancePositionState({
    old_position_address: oldAddr,
    new_position_address: newAddr,
    new_bin_range: { min: -100, max: -31, active: -31, bins_below: 69, bins_above: 0 },
    new_strategy: "spot",
    amount_sol: 1.62,
    amount_x: 0,
    active_bin: -31,
    reason: "Autonomous roll-up test",
  });

  const oldAfter = getTrackedPosition(oldAddr);
  assert.equal(oldAfter.closed, true, "Old position should be closed");

  const newAfter = getTrackedPosition(newAddr);
  assert.equal(newAfter.rebalance_count, 1, "rebalance_count should be incremented");
  assert.equal(newAfter.parent_position, oldAddr, "parent_position linked");
  assert.equal(newAfter.total_fees_claimed_sol, 0.12, "Claimed fees SOL preserved");
  assert.equal(newAfter.total_fees_claimed_true_usd, 18.0, "Claimed fees USD preserved");
  assert.equal(newAfter.strategy, "spot");
});
