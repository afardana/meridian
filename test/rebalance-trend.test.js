import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

test("Rebalance Trend: handles insufficient history gracefully", async () => {
  const { isRebalanceTrendIncreasing } = await import("../tools/rebalance-trend.js");

  // Non-existent pool returns insufficient history
  const res = await isRebalanceTrendIncreasing("NON_EXISTENT_POOL", { timeframe: "5m", candleCount: 6 });
  assert.equal(res.confirmed, false);
  assert.ok(res.reason.includes("Insufficient 5m candle history"));
});

test("Rebalance Trend: config defaults support 5m and 6 candles", async () => {
  const { config, reloadScreeningThresholds } = await import("../config.js");

  assert.equal(config.screening.topPerformerTrendTimeframe, "5m");
  assert.equal(config.screening.topPerformerTrendCandles, 6);
  assert.equal(config.management.rebalanceTrendTimeframe, "5m");
  assert.equal(config.management.rebalanceTrendCandles, 6);

  // Test dynamic threshold reload
  reloadScreeningThresholds({
    topPerformerTrendTimeframe: "15m",
    topPerformerTrendCandles: 4,
    rebalanceTrendTimeframe: "15m",
    rebalanceTrendCandles: 4,
  });

  assert.equal(config.screening.topPerformerTrendTimeframe, "15m");
  assert.equal(config.screening.topPerformerTrendCandles, 4);
  assert.equal(config.management.rebalanceTrendTimeframe, "15m");
  assert.equal(config.management.rebalanceTrendCandles, 4);

  // Restore defaults
  reloadScreeningThresholds({
    topPerformerTrendTimeframe: "5m",
    topPerformerTrendCandles: 6,
    rebalanceTrendTimeframe: "5m",
    rebalanceTrendCandles: 6,
  });

  assert.equal(config.screening.topPerformerTrendTimeframe, "5m");
  assert.equal(config.screening.topPerformerTrendCandles, 6);
  assert.equal(config.management.rebalanceTrendTimeframe, "5m");
  assert.equal(config.management.rebalanceTrendCandles, 6);
});
