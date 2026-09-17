process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "assert";

console.log("=== Testing External Capital Reconciliation & Lineage Basis Alignment ===");

const { trackPosition, updatePnlAndCheckExits, getTrackedPosition, ensureStateInitialized, resolveRootInitialBasis } = await import("../state.js");
await ensureStateInitialized();

// 1. Test external capital top-up (+0.5 SOL added to a 0.15 SOL position)
{
  const testPosAddr = "TEST_CAPITAL_POS_" + Date.now();
  
  trackPosition({
    position: testPosAddr,
    pool: "TEST_POOL_WIFOUT",
    pool_name: "wifout-SOL",
    base_mint: "MINT_WIFOUT",
    amount_sol: 0.15,
    initial_value_usd: 14.94,
    strategy: "curve",
    rebalance_count: 2, // simulated rebalanced position
    mfe_pnl_pct: 14.03,
  });

  const { confirmPeak } = await import("../state.js");
  confirmPeak(testPosAddr, 13.63, 1);

  const before = getTrackedPosition(testPosAddr);
  assert.strictEqual(before.amount_sol, 0.15);
  assert.strictEqual(before.root_initial_sol, 0.15);
  assert.strictEqual(before.peak_pnl_pct, 13.63);

  // Simulate incoming poll tick after user deposited 0.5 SOL on Meteora UI:
  // Net deposits on-chain = 0.6475 SOL, $64.57 USD
  // Current PnL = +3.6%
  const positionData = {
    pnl_pct: 3.6,
    effective_pnl_pct: 3.6,
    pnl_quality: "valid",
    pnl_pct_suspicious: false,
    pnl_management_ready: true,
    in_range: true,
    active_bin: -149,
    lower_bin: -199,
    upper_bin: -127,
    deposit_sol: 0.7975,
    deposit_usd: 79.52,
    withdraw_sol: 0.1500,
    withdraw_usd: 14.95,
    net_deposit_sol: 0.6475,
    net_deposit_usd: 64.57,
  };

  const mgmtConfig = {
    trailingTakeProfit: true,
    trailingTriggerPct: 15.0,
    trailingDropPct: 3.0,
    stopLossPct: -15.0,
  };

  const exit = updatePnlAndCheckExits(testPosAddr, positionData, mgmtConfig);
  assert.strictEqual(exit, null, "Position is healthy in-range and should not exit");

  const after = getTrackedPosition(testPosAddr);
  assert.strictEqual(after.amount_sol, 0.6475, "amount_sol must be reconciled to 0.6475");
  assert.strictEqual(after.initial_value_usd, 64.57, "initial_value_usd must be reconciled to 64.57");
  assert.strictEqual(after.root_initial_sol, 0.6475, "root_initial_sol must be reconciled to 0.6475");
  assert.strictEqual(after.root_initial_usd, 64.57, "root_initial_usd must be reconciled to 64.57");

  // Peak PnL must be scaled to prevent phantom trailing stop exits
  // Previous peak 13.63% scaled by 0.15 / 0.6475 = 3.16%, floored at current PnL 3.6%
  assert.strictEqual(after.peak_pnl_pct, 3.6, "peak_pnl_pct must be scaled to current PnL (not left at unscaled 13.63%)");

  // Verify Lineage Basis Walk matches updated capital
  const rootBasis = resolveRootInitialBasis(after);
  assert.strictEqual(rootBasis.sol, 0.6475, "resolveRootInitialBasis must return 0.6475 SOL");

  // Verify that Lineage Take-Profit math avoids phantom +340% exit
  const totalValSol = 0.66; // current holdings in SOL
  const lineagePnlPct = ((totalValSol - rootBasis.sol) / rootBasis.sol) * 100;
  assert.ok(lineagePnlPct < 4.0, `Lineage PnL (+${lineagePnlPct.toFixed(2)}%) must be under 4.0% threshold (was +340% before fix)`);

  console.log("✅ Test 1 Passed: External capital deposit correctly reconciles amount_sol, root basis, scales peak PnL, and protects lineage TP");
}

// 2. Test dust variation immunity (changes < 0.02 SOL or < 5% do not cause churn)
{
  const testPosAddr = "TEST_DUST_POS_" + Date.now();
  trackPosition({
    position: testPosAddr,
    pool: "TEST_POOL_DUST",
    amount_sol: 1.0,
    initial_value_usd: 150.0,
    strategy: "spot",
  });

  const positionData = {
    pnl_pct: 1.0,
    pnl_quality: "valid",
    pnl_pct_suspicious: false,
    pnl_management_ready: true,
    in_range: true,
    net_deposit_sol: 1.005, // 0.005 SOL dust variation (e.g. minor rounding)
    net_deposit_usd: 150.75,
  };

  updatePnlAndCheckExits(testPosAddr, positionData, {});
  const tracked = getTrackedPosition(testPosAddr);
  assert.strictEqual(tracked.amount_sol, 1.0, "amount_sol must not be modified by dust variation < 0.02 SOL");

  console.log("✅ Test 2 Passed: Minor dust variations (<0.02 SOL) are ignored to prevent state churn");
}

// 3. Test safety guard on invalid / suspicious valuation
{
  const testPosAddr = "TEST_SUSP_POS_" + Date.now();
  trackPosition({
    position: testPosAddr,
    pool: "TEST_POOL_SUSP",
    amount_sol: 0.5,
    initial_value_usd: 75.0,
    strategy: "curve",
  });

  const positionData = {
    pnl_pct: 0.0,
    pnl_quality: "missing_deposits", // suspicious / unverified
    pnl_pct_suspicious: true,
    pnl_management_ready: false,
    in_range: true,
    net_deposit_sol: 2.0,
    net_deposit_usd: 300.0,
  };

  updatePnlAndCheckExits(testPosAddr, positionData, {});
  const tracked = getTrackedPosition(testPosAddr);
  assert.strictEqual(tracked.amount_sol, 0.5, "amount_sol must not change when pnl_quality is invalid or suspicious");

  console.log("✅ Test 3 Passed: Suspicious or invalid valuations do not trigger capital changes");
}

console.log("=== All External Capital Reconciliation Tests Passed! ===");
process.exit(0);
