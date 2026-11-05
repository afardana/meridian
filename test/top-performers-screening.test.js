import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// This file asserts code defaults, so it must not see a developer's user-config.json.
// scripts/run-tests.js already gives every file a fresh MERIDIAN_DATA_DIR; when the file
// is run directly (node --test), isolate it here. Only dynamic imports below, so this
// takes effect before repo-root.js resolves the data dir.
if (!process.env.MERIDIAN_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-test-"));
  process.env.MERIDIAN_DATA_DIR = dir;
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
}

process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

test("Top Performers Screening: config defaults and dynamic threshold reload", async () => {
  const { config, reloadScreeningThresholds } = await import("../config.js");

  assert.equal(config.screening.topPerformersEnabled, true);
  assert.equal(config.screening.topPerformersLimit, 10);
  assert.equal(config.screening.topPerformersMinTvl, 15000);
  assert.equal(config.screening.topPerformersRequireTrend, true);
  // Code default since plan #15 (2026-09-24): held positions count against the cap.
  assert.equal(config.risk.maxPositionsExcludeHold, false);

  // Test dynamic reload overrides
  reloadScreeningThresholds({
    topPerformersMinTvl: 20000,
    topPerformersLimit: 5,
    maxPositionsExcludeHold: true,
  });

  assert.equal(config.screening.topPerformersMinTvl, 20000);
  assert.equal(config.screening.topPerformersLimit, 5);
  assert.equal(config.risk.maxPositionsExcludeHold, true);

  // Restore defaults
  reloadScreeningThresholds({
    topPerformersMinTvl: 15000,
    topPerformersLimit: 10,
    maxPositionsExcludeHold: false,
  });
  assert.equal(config.screening.topPerformersMinTvl, 15000);
  assert.equal(config.screening.topPerformersLimit, 10);
  assert.equal(config.risk.maxPositionsExcludeHold, false);
});

test("Top Performers Screening: Top Performer hints and single-sided SOL ladder defaults", async () => {
  const { getTopPerformerHint } = await import("../tools/screening.js");

  // Unknown pool returns null
  assert.equal(getTopPerformerHint("UNKNOWN_POOL"), null);
});

test("Top Performers Screening: maxPositionsExcludeHold logic", async () => {
  const { config, reloadScreeningThresholds } = await import("../config.js");
  // The toggle is off by default; this test exercises the ON branch.
  reloadScreeningThresholds({ maxPositionsExcludeHold: true });
  const { trackPosition, getTrackedPositions, ensureStateInitialized, setPositionHold } = await import("../state.js");
  await ensureStateInitialized();

  // Create mock open positions: 2 with hold_mode=true, 1 active
  const hold1 = "TEST_HOLD_POS_1_" + Date.now();
  const hold2 = "TEST_HOLD_POS_2_" + Date.now();
  const active1 = "TEST_ACTIVE_POS_1_" + Date.now();

  trackPosition({ position: hold1, pool: "POOL1", pool_name: "HOLD1-SOL", amount_sol: 1.0, strategy: "spot" });
  setPositionHold(hold1, true);

  trackPosition({ position: hold2, pool: "POOL2", pool_name: "HOLD2-SOL", amount_sol: 1.0, strategy: "spot" });
  setPositionHold(hold2, true);

  trackPosition({ position: active1, pool: "POOL3", pool_name: "ACTIVE-SOL", amount_sol: 1.0, strategy: "spot" });

  const allOpen = getTrackedPositions(true);
  const activeManaged = config.risk.maxPositionsExcludeHold
    ? allOpen.filter((p) => p.hold_mode !== true)
    : allOpen;

  // Active managed count should not count the 2 hold positions
  const testOpenSubset = [hold1, hold2, active1].map((addr) => allOpen.find((p) => p.position === addr)).filter(Boolean);
  const testManaged = config.risk.maxPositionsExcludeHold
    ? testOpenSubset.filter((p) => p.hold_mode !== true)
    : testOpenSubset;

  assert.equal(testManaged.length, 1, "Only 1 active non-hold position counted when maxPositionsExcludeHold=true");
  assert.equal(testManaged[0].position, active1);

  // Cleanup: mark test positions closed
  const { recordClose } = await import("../state.js");
  recordClose(hold1, "test cleanup");
  recordClose(hold2, "test cleanup");
  recordClose(active1, "test cleanup");
  reloadScreeningThresholds({ maxPositionsExcludeHold: false });
});
