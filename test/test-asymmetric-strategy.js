/**
 * Unit tests for dynamic price range scaling and asymmetric OOR timeouts.
 * Run: node test/test-asymmetric-strategy.js
 */

import { config } from "../config.js";
import { deployPosition } from "../tools/dlmm.js";
import { updatePnlAndCheckExits, getTrackedPosition } from "../state.js";
import assert from "assert";
import fs from "fs";
import path from "path";

// Set dry-run env to true so no transactions are executed
process.env.DRY_RUN = "true";

// ── State isolation ────────────────────────────────────────────────────────────
// `deployPosition` calls `ensureStateInitialized()` before the DRY_RUN check,
// which loads state.json into _cache (once, lazily). We must write the mock
// position to state.json HERE — before any call to deployPosition — so that
// when initState loads the file, the mock position is already present in _cache.
// Doing this inside runTests() (after Cases 1+2) would be too late: _cache is
// already set and writeFileSync to state.json no longer affects the cache.
// ──────────────────────────────────────────────────────────────────────────────
const _statePath = path.resolve("state.json");
const _testAddr = "TEST_POSITION_ADDR_123";
{
  let _s = { positions: {} };
  if (fs.existsSync(_statePath)) {
    try { _s = JSON.parse(fs.readFileSync(_statePath, "utf8")); } catch (_) {}
  }
  if (!_s.positions) _s.positions = {};
  // Unconditionally inject fresh mock position (removes stale state from prior runs too)
  _s.positions[_testAddr] = {
    position: _testAddr,
    pool: "5BZwoJcZ9A63LiHKCNiJBZMVyJH8cyKPEdNwYdi3ev4p",
    out_of_range_since: new Date(Date.now() - 20 * 60000).toISOString(), // 20 mins ago
    closed: false,
    notes: [],
  };
  fs.writeFileSync(_statePath, JSON.stringify(_s, null, 2), "utf8");
}

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
    // Clamped by MAX_SAFE_BINS_BELOW = 69 (single position account limit)
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
    assert.strictEqual(res1.would_deploy.bins_below, 69);
    console.log("  ✅ Passed Case 1\n");

    // ----------------------------------------------------
    // Test Case 2: Dynamic Range scaling clamping (binStep = 100, targetDownsidePct = 75)
    // ln(1/0.25) / ln(1.01) = 139 bins -> Clamped by MAX_SAFE_BINS_BELOW = 69
    // ----------------------------------------------------
    console.log("Test Case 2: Dynamic range scaling clamping with targetDownsidePct = 75%, binStep = 100");
    config.strategy.targetDownsidePct = 75;

    const res2 = await deployPosition({
      pool_address: "FxtewwzHZFCYgkGJDCz8KymfFwW5nXV1B9UMeHTV2u2F",
      amount_sol: 0.1,
    });
    console.log("  Resolved bins_below:", res2.would_deploy.bins_below);
    assert.strictEqual(res2.would_deploy.bins_below, 69);
    console.log("  ✅ Passed Case 2\n");

    // ----------------------------------------------------
    // Test Case 3: Asymmetric OOR Exit Alerts (Above Range, 20 minutes OOR >= 15m limit)
    // The mock position was injected into state.json before Cases 1+2 triggered
    // ensureStateInitialized(), so it is present in _cache from the initial load.
    // ----------------------------------------------------
    console.log("Test Case 3: Asymmetric OOR timeout - Above range (20m OOR vs 15m limit)");
    config.management.outOfRangeWaitMinutesAbove = 15;
    config.management.outOfRangeWaitMinutesBelow = 180;

    const testAddr = _testAddr;

    // Mock active positionData — price above range
    const mockPosDataAbove = {
      pnl_pct: 2.5,
      pnl_pct_suspicious: false,
      in_range: false,
      fee_per_tvl_24h: 100,
      active_bin: -400,
      lower_bin: -554,
      upper_bin: -474, // active_bin (-400) > upper_bin (-474), price is above range
    };

    // Reset the OOR timestamp to a fresh 20m via _cache (since _cache is now set)
    const trackedCase3 = getTrackedPosition(testAddr);
    assert.ok(trackedCase3, "Mock position must be in _cache — was it written before deployPosition was called?");
    trackedCase3.out_of_range_since = new Date(Date.now() - 20 * 60000).toISOString();

    const exitAbove = updatePnlAndCheckExits(testAddr, mockPosDataAbove, config.management);
    console.log("  Resolved Exit Action:", exitAbove?.action);
    // OOR-above is intentionally handled by getDeterministicCloseRule in index.js (with stabilization check), so state returns null
    assert.strictEqual(exitAbove, null);
    console.log("  ✅ Passed Case 3 (OOR-above correctly delegated to index.js stabilization guard)\n");

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

    // Update the OOR timestamp to 20m via _cache
    const tracked = getTrackedPosition(testAddr);
    assert.ok(tracked, "tracked must not be null for Case 4");
    tracked.out_of_range_since = new Date(Date.now() - 20 * 60000).toISOString();

    const exitBelowShort = updatePnlAndCheckExits(testAddr, mockPosDataBelow, config.management);
    console.log("  Resolved Exit Action:", exitBelowShort?.action);
    assert.strictEqual(exitBelowShort, null); // should not trigger close yet
    console.log("  ✅ Passed Case 4\n");

    // ----------------------------------------------------
    // Test Case 5: Asymmetric OOR Exit Alerts (Below Range, 190 minutes OOR >= 180m limit)
    // Mutate the in-memory cache entry (tracked is a live reference to _cache.positions[addr])
    // so the OOR timer is now 190m, crossing the 180m limit.
    // ----------------------------------------------------
    console.log("Test Case 5: Asymmetric OOR timeout - Below range (190m OOR vs 180m limit)");
    assert.ok(tracked, "tracked must not be null for Case 5");
    tracked.out_of_range_since = new Date(Date.now() - 190 * 60000).toISOString();

    const exitBelowLong = updatePnlAndCheckExits(testAddr, mockPosDataBelow, config.management);
    console.log("  Resolved Exit Action:", exitBelowLong?.action);
    console.log("  Resolved Exit Reason:", exitBelowLong?.reason);
    assert.ok(exitBelowLong, "Expected OOR-below exit after 190m");
    assert.strictEqual(exitBelowLong.action, "OUT_OF_RANGE");
    assert.ok(exitBelowLong.reason.includes("Out of range below"));
    console.log("  ✅ Passed Case 5\n");

    console.log("=== All test cases completed successfully ===");
    process.exit(0);
  } finally {
    // Restore config
    config.strategy.targetDownsidePct = originalTargetDownsidePct;
    config.strategy.minBinsBelow = originalMinBinsBelow;
    config.strategy.maxBinsBelow = originalMaxBinsBelow;
    config.management.outOfRangeWaitMinutesAbove = originalWaitAbove;
    config.management.outOfRangeWaitMinutesBelow = originalWaitBelow;
    // Clean up mock position from state.json
    try {
      const s = JSON.parse(fs.readFileSync(_statePath, "utf8"));
      delete s.positions[_testAddr];
      fs.writeFileSync(_statePath, JSON.stringify(s, null, 2), "utf8");
    } catch (_) {}
  }
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
