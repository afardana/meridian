process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "assert";

console.log("=== Testing Net-Yield PnL Engine (single evaluator) ===");

const { ensureStateInitialized, trackPosition, updatePnlAndCheckExits, closeTrackedPosition } = await import("../state.js");
await ensureStateInitialized();

const mgmt = { stopLossPct: -15, takeProfitPct: 15, trailingTakeProfit: false, roundTripHarvestEnabled: false, outOfRangeBinsToClose: 50, outOfRangeWaitMinutesAbove: 60, outOfRangeWaitMinutesBelow: 60, twapGuardEnabled: false };
const data = (pnl, eff, over = {}) => ({ pnl_pct: pnl, effective_pnl_pct: eff, fee_yield_pct: eff - pnl, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100, pnl_quality: "valid", ...over });
const withPos = (name, fn) => {
  const P = `NET_${name}_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_NY", pool_name: "NY-SOL", strategy: "spot", amount_sol: 1, initial_value_usd: 1, bin_range: [0, 100], active_bin: 50 });
  try { fn(P); } finally { try { closeTrackedPosition(P, "test"); } catch {} }
};

// Test 1: fee yield cushions the stop (raw −16.5, effective −11 > −15)
withPos("cushion", (P) => {
  assert.strictEqual(updatePnlAndCheckExits(P, data(-16.5, -11.0), mgmt), null, "Stop loss must NOT trigger: effective PnL (-11%) is above -15%");
  console.log("✅ Test 1 Passed: fee yield cushions the stop");
});

// Test 2: the stop fires on effective PnL, immediately and urgently
withPos("stop", (P) => {
  const exit = updatePnlAndCheckExits(P, data(-22.0, -18.0), mgmt);
  assert.ok(exit, "Stop loss should trigger when effective PnL <= -15%");
  assert.strictEqual(exit.action, "STOP_LOSS");
  assert.strictEqual(exit.rule, "stop_loss");
  assert.strictEqual(exit.family, "stop_loss");
  assert.strictEqual(exit.urgent, true);
  assert.ok(exit.reason.includes("Stop loss: effective PnL -18.00% <= -15%"), exit.reason);
  console.log("✅ Test 2 Passed: stop loss on effective PnL");
});

// Test 3: take profit on effective PnL (raw +3, effective +11 >= +10)
withPos("tp", (P) => {
  const exit = updatePnlAndCheckExits(P, data(3.0, 11.0), { ...mgmt, takeProfitPct: 10 });
  assert.ok(exit, "Take profit should trigger when effective PnL >= +10%");
  assert.strictEqual(exit.action, "TAKE_PROFIT");
  assert.strictEqual(exit.rule, "take_profit");
  assert.strictEqual(exit.family, "take_profit");
  assert.strictEqual(exit.urgent, false);
  assert.ok(exit.reason.includes("take profit: effective pnl +11.00% >= target +10.00%"), exit.reason);
  console.log("✅ Test 3 Passed: fee-driven take profit");
});

console.log("=== All Net-Yield PnL Engine Tests Passed! ===");
process.exit(0);
