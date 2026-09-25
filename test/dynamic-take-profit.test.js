process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Testing Static Trailing Take Profit & Lineage Engine ===");

const {
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

// ── 3. Static trailing TP in updatePnlAndCheckExits ───────────────
// The volatility-adaptive trigger and the inventory-exhaustion tightening were
// removed 2026-09-25 (audit 01 §3). Trailing is governed ONLY by the static
// trailingTriggerPct / trailingDropPct: a drop smaller than dropPct holds
// regardless of how much of the range has converted to SOL.
console.log("\n3. Testing static trailing TP in updatePnlAndCheckExits...");
const POS_TRAIL = `TEST_TRAIL_${Date.now()}`;
try {
  trackPosition({
    position: POS_TRAIL,
    pool: "POOL_TRAIL_TEST",
    pool_name: "MCAT-SOL",
    strategy: "curve",
    amount_sol: 0.5,
    initial_value_usd: 75.0,
    bin_range: [0, 100],
    active_bin: 90,
    bin_step: 25,
    volatility: 10.0, // must NOT influence the trigger/drop any more
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
  const tick = (pnl) => updatePnlAndCheckExits(
    POS_TRAIL,
    { pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 90, lower_bin: 0, upper_bin: 100, pnl_quality: "valid" },
    mgmtConfig
  );

  confirmPeak(POS_TRAIL, 25.0, 2);
  confirmPeak(POS_TRAIL, 25.0, 2);

  // Tick 1: at the confirmed peak (+25%) — trailing arms (peak >= 3%), no exit.
  assert.equal(tick(25.0), null, "First tick at peak should not exit");
  // Tick 2: 1.2pp drop < 1.5pp static drop — HOLD (base fraction 10% is irrelevant).
  assert.equal(tick(23.8), null, "A 1.2pp drop must hold at the static 1.5pp drop");
  // Tick 3: 1.6pp drop >= 1.5pp — TRAILING_TP fires (overshoot 0.1 < 0.5 → needs confirmation).
  const exit = tick(23.4);
  assert.ok(exit, "A 1.6pp drop must trigger trailing TP");
  assert.equal(exit.action, "TRAILING_TP");
  assert.ok(!/Inventory Exhaustion/.test(exit.reason), `Reason must not carry the removed tightening: ${exit.reason}`);
  console.log("✅ Static trailing TP verified:", exit.reason);
} finally {
  try { closeTrackedPosition(POS_TRAIL, "test complete"); } catch {}
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

console.log("\n🎉 ALL TRAILING TP & LINEAGE TESTS PASSED!");
