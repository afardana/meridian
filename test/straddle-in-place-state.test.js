process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { trackPosition, recordInPlaceStraddle, getTrackedPosition, isProfitExitSuppressed, closeTrackedPosition, ensureStateInitialized, updatePnlAndCheckExits, confirmPeak } = await import("../state.js");
await ensureStateInitialized();

test("in-place straddle keeps the same row, updates range/base, resets exit state and sets a profit grace", () => {
  const P = `STR_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_S", pool_name: "S-SOL", strategy: "spot", amount_sol: 1, amount_x: 0, bin_range: { min: -100, max: -31 }, active_bin: -20 });
  try {
    const before = getTrackedPosition(P);
    before.trailing_active = true; before.pnl_tick_history = [1, 1, 1];
    const rec = recordInPlaceStraddle(P, { bin_range: { min: -55, max: 14, active: -20 }, strategy: "curve", amount_x: 1234, swapped_sol: 0.5, gas_sol: 0.001, reason: "test" });
    assert.equal(rec.straddle_count, 1);
    const pos = getTrackedPosition(P);
    assert.equal(pos.position, P);
    assert.equal(pos.bin_range.min, -55); assert.equal(pos.bin_range.max, 14);
    assert.equal(pos.strategy, "curve"); assert.equal(pos.amount_x, 1234); assert.equal(pos.amount_sol, 1); // basis unchanged
    assert.equal(pos.lane, "straddle"); assert.equal(pos.trailing_active, false); assert.deepEqual(pos.pnl_tick_history, []);
    assert.ok(pos.profit_grace_until && new Date(pos.profit_grace_until) > new Date());
    assert.equal(isProfitExitSuppressed(pos, "TRAILING_TP", {}), true);
    assert.equal(isProfitExitSuppressed(pos, "ROUND_TRIP_HARVEST", {}), true);
    assert.equal(isProfitExitSuppressed(pos, "STOP_LOSS", {}), false);
    // trailing must not arm/fire on the fresh range during the grace
    confirmPeak(P, 4.0, 1);
    const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingOvershootPct: 0.5, stopLossPct: -15, twapGuardEnabled: false };
    assert.equal(updatePnlAndCheckExits(P, { pnl_pct: 4.0, effective_pnl_pct: 4.0, in_range: true, active_bin: -20, lower_bin: -55, upper_bin: 14, pnl_quality: "valid" }, mgmt), null);
    assert.equal(updatePnlAndCheckExits(P, { pnl_pct: 1.0, effective_pnl_pct: 1.0, in_range: true, active_bin: -20, lower_bin: -55, upper_bin: 14, pnl_quality: "valid" }, mgmt), null);
    // second straddle increments the count
    recordInPlaceStraddle(P, { bin_range: { min: -50, max: 19, active: -15 }, strategy: "spot", amount_x: 10, swapped_sol: 0.2 });
    assert.equal(getTrackedPosition(P).straddle_count, 2);
    assert.equal(getTrackedPosition(P).amount_x, 1244);
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});
