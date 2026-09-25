process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Testing Static Trailing Take Profit ===");

const {
  evaluateTrailingTakeProfit,
  estimateBaseTokenFraction,
  trackPosition,
  updatePnlAndCheckExits,
  confirmPeak,
  closeTrackedPosition,
  ensureStateInitialized,
} = await import("../state.js");

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

console.log("\n🎉 ALL TRAILING TP TESTS PASSED!");
