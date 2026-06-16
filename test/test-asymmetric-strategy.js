/**
 * Unit tests for dynamic price range scaling and asymmetric OOR timeouts.
 * Run: node test/test-asymmetric-strategy.js
 */

import { config } from "../config.js";
import { deployPosition } from "../tools/dlmm.js";
import { updatePnlAndCheckExits } from "../state.js";
import assert from "assert";

// Set dry-run env to true so no transactions are executed
process.env.DRY_RUN = "true";

async function runTests() {
  console.log("=== Testing Wide-Range & Asymmetric OOR Strategy ===\n");

  const originalTargetDownsidePct = config.strategy.targetDownsidePct;
  const originalMinBinsBelow = config.strategy.minBinsBelow;
  const originalMaxBinsBelow = config.strategy.maxBinsBelow;
  const originalWaitAbove = config.management.outOfRangeWaitMinutesAbove;
  const originalWaitBelow = config.management.outOfRangeWaitMinutesBelow;

  try {
    // ----------------------------------------------------
    // Test Case 1: Dynamic Range scaling calculation (binStep = 100, targetDownsidePct = 50)
    // ln(1/0.5) / ln(1.01) = 69.66 -> Math.ceil = 70 bins
    // Clamped by maxBinsBelow = 80
    // ----------------------------------------------------
    console.log("Test Case 1: Dynamic range scaling with targetDownsidePct = 50%, binStep = 100");
    config.strategy.targetDownsidePct = 50;
    config.strategy.minBinsBelow = 35;
    config.strategy.maxBinsBelow = 80;

    const res1 = await deployPosition({
      pool_address: "FxtewwzHZFCYgkGJDCz8KymfFwW5nXV1B9UMeHTV2u2F", // TURTLE-SOL (binStep = 100)
      amount_sol: 0.1,
    });
    console.log("  Resolved bins_below:", res1.would_deploy.bins_below);
    assert.strictEqual(res1.would_deploy.bins_below, 70);
    console.log("  ✅ Passed Case 1\n");

    // ----------------------------------------------------
    // Test Case 2: Dynamic Range scaling clamping (binStep = 100, targetDownsidePct = 75)
    // ln(1/0.25) / ln(1.01) = 139 bins -> Clamped by maxBinsBelow = 80
    // ----------------------------------------------------
    console.log("Test Case 2: Dynamic range scaling clamping with targetDownsidePct = 75%, binStep = 100");
    config.strategy.targetDownsidePct = 75;

    const res2 = await deployPosition({
      pool_address: "FxtewwzHZFCYgkGJDCz8KymfFwW5nXV1B9UMeHTV2u2F",
      amount_sol: 0.1,
    });
    console.log("  Resolved bins_below:", res2.would_deploy.bins_below);
    assert.strictEqual(res2.would_deploy.bins_below, 80);
    console.log("  ✅ Passed Case 2\n");

    // ----------------------------------------------------
    // Test Case 3: Asymmetric OOR Exit Alerts (Above Range, 20 minutes OOR >= 15m limit)
    // ----------------------------------------------------
    console.log("Test Case 3: Asymmetric OOR timeout - Above range (20m OOR vs 15m limit)");
    config.management.outOfRangeWaitMinutesAbove = 15;
    config.management.outOfRangeWaitMinutesBelow = 180;

    // Mock active positionData
    const mockPosDataAbove = {
      pnl_pct: 2.5,
      pnl_pct_suspicious: false,
      in_range: false,
      fee_per_tvl_24h: 100,
      active_bin: -400,
      lower_bin: -554,
      upper_bin: -474, // active_bin (-400) > upper_bin (-474), price is above range
    };

    // We need to inject this position address into state first to mock outOfRangeSince
    const { default: fs } = await import("fs");
    const { default: path } = await import("path");
    const statePath = path.resolve("state.json");

    let state = { positions: {} };
    if (fs.existsSync(statePath)) {
      try {
        state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      } catch (_) {}
    }
    if (!state.positions) state.positions = {};

    const testAddr = "TEST_POSITION_ADDR_123";
    state.positions[testAddr] = {
      position: testAddr,
      pool: "5BZwoJcZ9A63LiHKCNiJBZMVyJH8cyKPEdNwYdi3ev4p",
      out_of_range_since: new Date(Date.now() - 20 * 60000).toISOString(), // 20 mins ago
      closed: false,
      notes: [],
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

    const exitAbove = updatePnlAndCheckExits(testAddr, mockPosDataAbove, config.management);
    console.log("  Resolved Exit Action:", exitAbove?.action);
    console.log("  Resolved Exit Reason:", exitAbove?.reason);
    assert.ok(exitAbove);
    assert.strictEqual(exitAbove.action, "OUT_OF_RANGE");
    assert.ok(exitAbove.reason.includes("Out of range above"));
    console.log("  ✅ Passed Case 3\n");

    // ----------------------------------------------------
    // Test Case 4: Asymmetric OOR Exit Alerts (Below Range, 20 minutes OOR < 180m limit)
    // ----------------------------------------------------
    console.log("Test Case 4: Asymmetric OOR timeout - Below range (20m OOR vs 180m limit)");
    const mockPosDataBelow = {
      pnl_pct: -5.0,
      pnl_pct_suspicious: false,
      in_range: false,
      fee_per_tvl_24h: 100,
      active_bin: -600,
      lower_bin: -554, // active_bin (-600) < lower_bin (-554), price is below range
      upper_bin: -474,
    };

    const exitBelowShort = updatePnlAndCheckExits(testAddr, mockPosDataBelow, config.management);
    console.log("  Resolved Exit Action:", exitBelowShort?.action);
    assert.strictEqual(exitBelowShort, null); // should not trigger close yet
    console.log("  ✅ Passed Case 4\n");

    // ----------------------------------------------------
    // Test Case 5: Asymmetric OOR Exit Alerts (Below Range, 190 minutes OOR >= 180m limit)
    // ----------------------------------------------------
    console.log("Test Case 5: Asymmetric OOR timeout - Below range (190m OOR vs 180m limit)");
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch (_) {}
    state.positions[testAddr].out_of_range_since = new Date(Date.now() - 190 * 60000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

    const exitBelowLong = updatePnlAndCheckExits(testAddr, mockPosDataBelow, config.management);
    console.log("  Resolved Exit Action:", exitBelowLong?.action);
    console.log("  Resolved Exit Reason:", exitBelowLong?.reason);
    assert.ok(exitBelowLong);
    assert.strictEqual(exitBelowLong.action, "OUT_OF_RANGE");
    assert.ok(exitBelowLong.reason.includes("Out of range below"));
    console.log("  ✅ Passed Case 5\n");

    // Clean up mock position in state
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      delete state.positions[testAddr];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    } catch (_) {}

    console.log("=== All test cases completed successfully ===");
    process.exit(0);
  } finally {
    // Restore config
    config.strategy.targetDownsidePct = originalTargetDownsidePct;
    config.strategy.minBinsBelow = originalMinBinsBelow;
    config.strategy.maxBinsBelow = originalMaxBinsBelow;
    config.management.outOfRangeWaitMinutesAbove = originalWaitAbove;
    config.management.outOfRangeWaitMinutesBelow = originalWaitBelow;
  }
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
