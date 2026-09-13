process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "assert";

console.log("=== Testing Net-Yield PnL Engine ===");

const { ensureStateInitialized } = await import("../state.js");
await ensureStateInitialized();

const { getDeterministicCloseRule } = await import("../index.js");

// Test 1: Stop-loss evaluation uses effective_pnl_pct when present
{
  const managementConfig = {
    stopLossPct: -15,
    takeProfitPct: 15,
    manageUntracked: true,
    outOfRangeBinsToClose: 50,
    outOfRangeWaitMinutesAbove: 60,
    outOfRangeWaitMinutesBelow: 60,
  };

  // Position with raw paper IL = -16.5%, but +5.5% fees claimed -> effective PnL = -11.0%
  // Historically with raw pnl_pct, this would trigger stop loss (-16.5% <= -15%).
  // With net-yield engine, effective PnL is -11.0% > -15%, so stop loss should NOT trigger!
  const positionProtectedByFees = {
    position: "TEST_POS_1",
    pnl_pct: -16.5,
    effective_pnl_pct: -11.0,
    fee_yield_pct: 5.5,
    in_range: true,
  };

  const ruleProtected = getDeterministicCloseRule(positionProtectedByFees, managementConfig);
  assert.strictEqual(ruleProtected, null, "Stop loss should NOT trigger because effective PnL (-11%) is above -15%");
  console.log("✅ Test 1 Passed: Earned fee yield cushions position against premature stop-loss (-16.5% raw, -11.0% effective vs -15% SL)");
}

// Test 2: Stop-loss DOES trigger when effective PnL breaches threshold
{
  const managementConfig = {
    stopLossPct: -15,
    takeProfitPct: 15,
    manageUntracked: true,
  };

  // Position with raw paper IL = -22.0%, and +4.0% fees claimed -> effective PnL = -18.0% <= -15%
  const positionRealStopLoss = {
    position: "TEST_POS_2",
    pnl_pct: -22.0,
    effective_pnl_pct: -18.0,
    fee_yield_pct: 4.0,
    in_range: true,
  };

  const ruleExit = getDeterministicCloseRule(positionRealStopLoss, managementConfig);
  assert.ok(ruleExit != null, "Stop loss should trigger when effective PnL <= -15%");
  assert.strictEqual(ruleExit.action, "CLOSE");
  assert.strictEqual(ruleExit.rule, 1);
  assert.ok(ruleExit.reason.includes("effective pnl -18.00% <= limit -15.00%"));
  console.log("✅ Test 2 Passed: Stop-loss correctly triggers when effective PnL (-18.0%) breaches stop-loss (-15%)");
}

// Test 3: Take-profit triggers when effective PnL reaches target even if raw PnL is lower
{
  const managementConfig = {
    stopLossPct: -15,
    takeProfitPct: 10,
    manageUntracked: true,
  };

  // Position with raw paper IL = +3.0%, but +8.0% fees claimed -> effective PnL = +11.0% >= +10%
  const positionTakeProfit = {
    position: "TEST_POS_3",
    pnl_pct: 3.0,
    effective_pnl_pct: 11.0,
    fee_yield_pct: 8.0,
    in_range: true,
  };

  const ruleTp = getDeterministicCloseRule(positionTakeProfit, managementConfig);
  assert.ok(ruleTp != null, "Take profit should trigger when effective PnL >= +10%");
  assert.strictEqual(ruleTp.action, "CLOSE");
  assert.strictEqual(ruleTp.rule, 2);
  assert.ok(ruleTp.reason.includes("effective pnl +11.00% >= target +10.00%"));
  console.log("✅ Test 3 Passed: Take-profit correctly recognizes fee-driven profit (+11.0% effective >= +10% TP)");
}

console.log("=== All Net-Yield PnL Engine Tests Passed! ===");
process.exit(0);
