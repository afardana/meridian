import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

test("Settings Menu & update_config: surfaces and updates top performers, rebalance, and risk keys", async () => {
  const { config } = await import("../config.js");
  const { executeTool } = await import("../tools/executor.js");

  // Save originals
  const original = {
    topPerformersEnabled: config.screening.topPerformersEnabled,
    topPerformersLimit: config.screening.topPerformersLimit,
    topPerformersMinTvl: config.screening.topPerformersMinTvl,
    topPerformersRequireTrend: config.screening.topPerformersRequireTrend,
    topPerformerTrendTimeframe: config.screening.topPerformerTrendTimeframe,
    topPerformerTrendCandles: config.screening.topPerformerTrendCandles,
    rebalanceEnabled: config.management.rebalanceEnabled,
    rebalanceMinOorMinutes: config.management.rebalanceMinOorMinutes,
    rebalanceMaxCount: config.management.rebalanceMaxCount,
    rebalanceBinsBelow: config.management.rebalanceBinsBelow,
    rebalanceBinsAbove: config.management.rebalanceBinsAbove,
    rebalanceTrendTimeframe: config.management.rebalanceTrendTimeframe,
    rebalanceTrendCandles: config.management.rebalanceTrendCandles,
    maxPositionsExcludeHold: config.risk.maxPositionsExcludeHold,
  };

  // 1. Update all newly supported keys via update_config
  const updateRes = await executeTool("update_config", {
    changes: {
      topPerformersEnabled: false,
      topPerformersLimit: 15,
      topPerformersMinTvl: 25000,
      topPerformersRequireTrend: false,
      topPerformerTrendTimeframe: "15m",
      topPerformerTrendCandles: 4,
      rebalanceEnabled: false,
      rebalanceMinOorMinutes: 20,
      rebalanceMaxCount: 3,
      rebalanceBinsBelow: 30,
      rebalanceBinsAbove: 30,
      rebalanceTrendTimeframe: "15m",
      rebalanceTrendCandles: 4,
      maxPositionsExcludeHold: false,
    },
    reason: "Unit test settings update",
  });

  assert.equal(updateRes.success, true, `update_config should succeed: ${JSON.stringify(updateRes)}`);

  // Verify in-memory config updated
  assert.equal(config.screening.topPerformersEnabled, false);
  assert.equal(config.screening.topPerformersLimit, 15);
  assert.equal(config.screening.topPerformersMinTvl, 25000);
  assert.equal(config.screening.topPerformersRequireTrend, false);
  assert.equal(config.screening.topPerformerTrendTimeframe, "15m");
  assert.equal(config.screening.topPerformerTrendCandles, 4);

  assert.equal(config.management.rebalanceEnabled, false);
  assert.equal(config.management.rebalanceMinOorMinutes, 20);
  assert.equal(config.management.rebalanceMaxCount, 3);
  assert.equal(config.management.rebalanceBinsBelow, 30);
  assert.equal(config.management.rebalanceBinsAbove, 30);
  assert.equal(config.management.rebalanceTrendTimeframe, "15m");
  assert.equal(config.management.rebalanceTrendCandles, 4);

  assert.equal(config.risk.maxPositionsExcludeHold, false);

  // 2. Test bounds clamping for rebalance bins (<= 69, >= 1)
  const clampRes = await executeTool("update_config", {
    changes: {
      rebalanceBinsBelow: 99,
      rebalanceBinsAbove: 0,
    },
    reason: "Unit test clamping",
  });
  assert.equal(clampRes.success, true);
  assert.equal(config.management.rebalanceBinsBelow, 69);
  assert.equal(config.management.rebalanceBinsAbove, 1);

  // Restore originals
  await executeTool("update_config", {
    changes: original,
    reason: "Unit test restore",
  });

  assert.equal(config.screening.topPerformersEnabled, original.topPerformersEnabled);
  assert.equal(config.screening.topPerformersMinTvl, original.topPerformersMinTvl);
  assert.equal(config.management.rebalanceBinsBelow, original.rebalanceBinsBelow);
});
