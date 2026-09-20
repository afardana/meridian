process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Testing syncClaimedFeesFloor ===");

const {
  trackPosition,
  getTrackedPosition,
  syncClaimedFeesFloor,
  ensureStateInitialized,
} = await import("../state.js");

await ensureStateInitialized();

const POS_ADDR = `TEST_SYNC_FEES_${Date.now()}`;
const POOL_ADDR = "POOL_TEST_SYNC_123";

try {
  // 1. Initial Position Deploy with 0 claimed fees
  trackPosition({
    position: POS_ADDR,
    pool: POOL_ADDR,
    pool_name: "SYNC-SOL",
    strategy: "spot",
    amount_sol: 1.0,
    initial_value_usd: 150.0,
    bin_range: [-10, 10],
    active_bin: 0,
    bin_step: 20,
  });

  const pos1 = getTrackedPosition(POS_ADDR);
  assert.equal(pos1.total_fees_claimed_sol, 0, "Initial claimed sol should be 0");
  assert.equal(pos1.total_fees_claimed_true_usd, 0, "Initial claimed true usd should be 0");

  // 2. Indexer reports 0.032 SOL / $3.54 USD (external or pre-adoption claim)
  const updated1 = syncClaimedFeesFloor(POS_ADDR, { sol: 0.032, usd: 3.54 });
  assert.equal(updated1, true, "Should update when indexer reports higher amounts");

  const pos2 = getTrackedPosition(POS_ADDR);
  assert.equal(pos2.total_fees_claimed_sol, 0.032, "Claimed sol should be floored up to 0.032");
  assert.equal(pos2.total_fees_claimed_true_usd, 3.54, "Claimed true usd should be floored up to 3.54");
  assert.equal(pos2.cumulative_fees_claimed_sol, 0.032, "Cumulative fees should track the delta");
  assert.equal(pos2.cumulative_fees_claimed_true_usd, 3.54, "Cumulative true usd should track the delta");

  // 3. Indexer lags or reports lower/equal amount — should NOT downgrade
  const updated2 = syncClaimedFeesFloor(POS_ADDR, { sol: 0.020, usd: 2.50 });
  assert.equal(updated2, false, "Should not update when indexer reports lower amounts");

  const pos3 = getTrackedPosition(POS_ADDR);
  assert.equal(pos3.total_fees_claimed_sol, 0.032, "Claimed sol should remain at 0.032");
  assert.equal(pos3.total_fees_claimed_true_usd, 3.54, "Claimed true usd should remain at 3.54");

  // 4. Subsequent external claim raises indexer to 0.080 SOL / $8.90 USD
  const updated3 = syncClaimedFeesFloor(POS_ADDR, { sol: 0.080, usd: 8.90 });
  assert.equal(updated3, true, "Should update when indexer increases further");

  const pos4 = getTrackedPosition(POS_ADDR);
  assert.equal(pos4.total_fees_claimed_sol, 0.080, "Claimed sol should be floored to 0.080");
  assert.equal(pos4.total_fees_claimed_true_usd, 8.90, "Claimed true usd should be floored to 8.90");
  assert.equal(pos4.cumulative_fees_claimed_sol, 0.080, "Cumulative fees sol should equal 0.080");
  assert.equal(pos4.cumulative_fees_claimed_true_usd, 8.90, "Cumulative fees true usd should equal 8.90");

  console.log("✓ All syncClaimedFeesFloor tests passed!");
} catch (e) {
  console.error("Test failed:", e);
  process.exit(1);
}
