process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Testing Dynamic Take Profit & Risk Management Engine ===");

const {
  resolveDynamicTrailingParams,
  evaluateTrailingTakeProfit,
  estimateBaseTokenFraction,
  trackPosition,
  updatePnlAndCheckExits,
  confirmPeak,
  closeTrackedPosition,
  ensureStateInitialized,
} = await import("../state.js");

const { getDeterministicCloseRule } = await import("../index.js");

await ensureStateInitialized();

// ── 1. Test resolveDynamicTrailingParams ─────────────────────────
console.log("\n1. Testing resolveDynamicTrailingParams...");
{
  // Case A: Low volatility (vol = 2.0) -> clamp to min trigger 8.0%, drop = 1.6%
  const lowVol = resolveDynamicTrailingParams({ volatility: 2.0 });
  assert.equal(lowVol.isDynamic, true);
  assert.equal(lowVol.triggerPct, 8.0, "Low vol should clamp to 8.0% min trigger");
  assert.equal(lowVol.dropPct, 1.6, "Drop should be 0.2 * 8.0 = 1.6%");

  // Case B: Medium volatility (vol = 8.0) -> trigger = 12.0%, drop = 2.4%
  const medVol = resolveDynamicTrailingParams({ volatility: 8.0 });
  assert.equal(medVol.isDynamic, true);
  assert.equal(medVol.triggerPct, 12.0, "Med vol trigger should be 1.5 * 8.0 = 12.0%");
  assert.equal(medVol.dropPct, 2.4, "Drop should be 0.2 * 12.0 = 2.4%");

  // Case C: High volatility (vol = 18.0) -> clamp to max trigger 25.0%, drop clamp to max 3.0%
  const highVol = resolveDynamicTrailingParams({ volatility: 18.0 });
  assert.equal(highVol.isDynamic, true);
  assert.equal(highVol.triggerPct, 25.0, "High vol trigger should clamp to 25.0%");
  assert.equal(highVol.dropPct, 3.0, "High vol drop should clamp to 3.0%");

  // Case D: Fallback when volatility is missing
  const fallback = resolveDynamicTrailingParams({}, { trailingTriggerPct: 5, trailingDropPct: 2 });
  assert.equal(fallback.isDynamic, false);
  assert.equal(fallback.triggerPct, 5);
  assert.equal(fallback.dropPct, 2);

  console.log("✅ resolveDynamicTrailingParams calculation verified");
}

// ── 2. Test estimateBaseTokenFraction ────────────────────────────
console.log("\n2. Testing estimateBaseTokenFraction...");
{
  // Lower = 0, Upper = 100
  // Active = 90 -> (100 - 90) / 100 = 0.10 (10% base token, 90% SOL)
  const frac90 = estimateBaseTokenFraction(90, 0, 100);
  assert.equal(Math.round(frac90 * 100) / 100, 0.10);

  // Active = 50 -> 50% base token
  const frac50 = estimateBaseTokenFraction(50, 0, 100);
  assert.equal(Math.round(frac50 * 100) / 100, 0.50);

  // Active = 10 -> 90% base token
  const frac10 = estimateBaseTokenFraction(10, 0, 100);
  assert.equal(Math.round(frac10 * 100) / 100, 0.90);

  // Active above upper -> 0% base token (100% SOL)
  const fracAbove = estimateBaseTokenFraction(105, 0, 100);
  assert.equal(fracAbove, 0);

  console.log("✅ estimateBaseTokenFraction calculation verified");
}

// ── 3. Test Inventory Exhaustion Ratchet in updatePnlAndCheckExits ─
console.log("\n3. Testing Inventory Exhaustion Ratchet in updatePnlAndCheckExits...");
const POS_EXHAUSTION = `TEST_EXHAUSTION_${Date.now()}`;
try {
  trackPosition({
    position: POS_EXHAUSTION,
    pool: "POOL_EXHAUSTION_TEST",
    pool_name: "MCAT-SOL",
    strategy: "curve",
    amount_sol: 0.5,
    initial_value_usd: 75.0,
    bin_range: [0, 100],
    active_bin: 90,
    bin_step: 25,
    volatility: 10.0, // trigger = 15%, drop = 3.0%
  });

  const mgmtConfig = {
    trailingTakeProfit: true,
    trailingTriggerPct: 3,
    trailingDropPct: 1.5,
    trailingMinPnlPct: null,
    trailingOvershootPct: 0.5,
    stopLossPct: -18,
    twapGuardEnabled: false,
  };

  // Tick 1: Position peaks at +25% (active_bin = 90 -> base fraction = 10% <= 20%)
  // Confirm peak at 25% via confirmPeak
  confirmPeak(POS_EXHAUSTION, 25.0, 2);
  confirmPeak(POS_EXHAUSTION, 25.0, 2);

  // Dynamic trigger for vol=10 is 15.0%. At confirmed peak +25%, trailing TP activates.
  const tick1 = updatePnlAndCheckExits(
    POS_EXHAUSTION,
    {
      pnl_pct: 25.0,
      effective_pnl_pct: 25.0,
      in_range: true,
      active_bin: 90,
      lower_bin: 0,
      upper_bin: 100,
      pnl_quality: "valid",
    },
    mgmtConfig
  );
  assert.equal(tick1, null, "First tick at peak should not exit");

  // Tick 2: PnL drops from peak +25.0% to +23.8% (drop of 1.2pp).
  // Standard drop is 3.0pp (would NOT exit at 1.2pp drop).
  // BUT Inventory Exhaustion Ratchet tightens drop to 1.0pp!
  // Since drop 1.2pp >= 1.0pp, it should trigger TRAILING_TP!
  const tick2 = updatePnlAndCheckExits(
    POS_EXHAUSTION,
    {
      pnl_pct: 23.8,
      effective_pnl_pct: 23.8,
      in_range: true,
      active_bin: 90,
      lower_bin: 0,
      upper_bin: 100,
      pnl_quality: "valid",
    },
    mgmtConfig
  );

  assert.ok(tick2, "Inventory exhaustion ratchet should trigger exit on 1.2pp drop");
  assert.equal(tick2.action, "TRAILING_TP");
  assert.ok(
    tick2.reason.includes("Inventory Exhaustion"),
    `Reason should mention Inventory Exhaustion: ${tick2.reason}`
  );
  console.log("✅ Inventory Exhaustion Ratchet successfully triggered exit:", tick2.reason);
} finally {
  try { closeTrackedPosition(POS_EXHAUSTION, "test complete"); } catch {}
}

// ── 4. Test Continuous Rebalance Lineage Take Profit ──────────────
console.log("\n4. Testing Continuous Rebalance Lineage Take Profit...");
const POS_LINEAGE_ROOT = `TEST_ROOT_${Date.now()}`;
const POS_LINEAGE_CHILD = `TEST_CHILD_${Date.now()}`;
try {
  trackPosition({
    position: POS_LINEAGE_ROOT,
    pool: "POOL_LINEAGE_TEST",
    pool_name: "JEANPHIL-SOL",
    strategy: "curve",
    amount_sol: 1.0,
    initial_value_usd: 150.0,
    bin_range: [-35, 34],
    active_bin: 50,
  });

  // Track child position (rebalance_count = 1, root_initial_sol = 1.0, cumulative fees = 0.05)
  trackPosition({
    position: POS_LINEAGE_CHILD,
    pool: "POOL_LINEAGE_TEST",
    pool_name: "JEANPHIL-SOL",
    strategy: "curve",
    amount_sol: 0.95,
    initial_value_usd: 142.5,
    bin_range: [-35, 34],
    active_bin: 50,
    rebalance_count: 1,
    parent_position: POS_LINEAGE_ROOT,
    root_parent_position: POS_LINEAGE_ROOT,
    root_initial_sol: 1.0,
    root_initial_usd: 150.0,
    cumulative_fees_claimed_sol: 0.05,
  });

  const mgmtConfig = {
    rebalanceLineageTakeProfitPct: 8.0,
    twapGuardEnabled: false,
  };

  // Case A: Sub-threshold lineage PnL
  // current value = 0.96 SOL + claimed fees 0.05 SOL = 1.01 SOL (+1.0% < 8.0%)
  const exitSub = updatePnlAndCheckExits(
    POS_LINEAGE_CHILD,
    {
      pnl_pct: 1.0,
      effective_pnl_pct: 1.0,
      balances_sol: 0.96,
      in_range: true,
      active_bin: 50,
      lower_bin: 15,
      upper_bin: 84,
      pnl_quality: "valid",
    },
    mgmtConfig
  );
  assert.equal(exitSub, null, "Sub-threshold lineage profit should not trigger exit");

  // Case B: Profitable lineage meeting threshold (+10% >= 8%)
  // current value = 1.05 SOL + claimed fees 0.05 SOL = 1.10 SOL (+10.0% >= 8.0%)
  // Even though in_range = true (not OOR!), continuous lineage TP should trigger!
  const exitSuper = updatePnlAndCheckExits(
    POS_LINEAGE_CHILD,
    {
      pnl_pct: 5.0,
      effective_pnl_pct: 5.0,
      balances_sol: 1.05,
      in_range: true,
      active_bin: 50,
      lower_bin: 15,
      upper_bin: 84,
      pnl_quality: "valid",
    },
    mgmtConfig
  );
  assert.ok(exitSuper, "Continuous lineage take-profit should trigger");
  assert.equal(exitSuper.action, "LINEAGE_TAKE_PROFIT");
  assert.ok(
    exitSuper.reason.includes("Lineage take-profit"),
    `Reason should mention Lineage take-profit: ${exitSuper.reason}`
  );
  console.log("✅ Continuous Lineage Take Profit successfully triggered exit:", exitSuper.reason);

  // Case C: Also verify getDeterministicCloseRule triggers
  const ruleExit = getDeterministicCloseRule(
    {
      position: POS_LINEAGE_CHILD,
      balances_sol: 1.05,
      in_range: true,
      active_bin: 50,
      lower_bin: 15,
      upper_bin: 84,
      effective_pnl_pct: 5.0,
    },
    mgmtConfig
  );
  assert.ok(ruleExit, "getDeterministicCloseRule should return lineage take profit");
  assert.equal(ruleExit.action, "CLOSE");
  assert.ok(ruleExit.reason.includes("lineage take profit"));
  console.log("✅ getDeterministicCloseRule lineage take profit verified:", ruleExit.reason);
} finally {
  try { closeTrackedPosition(POS_LINEAGE_ROOT, "test complete"); } catch {}
  try { closeTrackedPosition(POS_LINEAGE_CHILD, "test complete"); } catch {}
}

console.log("\n🎉 ALL DYNAMIC TAKE PROFIT & RISK ENGINE TESTS PASSED!");
