process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { trackPosition, updatePnlAndCheckExits, confirmPeak, closeTrackedPosition, ensureStateInitialized, getTrackedPosition, setPositionHold } = await import("../state.js");
await ensureStateInitialized();

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5, stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 0 };
const data = (pnl, over = {}) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 90, lower_bin: 0, upper_bin: 100, pnl_quality: "valid", ...over });

test("SI-SOL 2026-10-03: releasing a HOLD never fires trailing TP against the pre-hold peak", () => {
  const P = `HOLDRES_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_H", pool_name: "SI-SOL", strategy: "spot", amount_sol: 0.9, initial_value_usd: 0.9, bin_range: [0, 100], active_bin: 90 });
  try {
    confirmPeak(P, 2.85, 1);
    assert.equal(updatePnlAndCheckExits(P, data(2.85), mgmt), null);
    assert.equal(getTrackedPosition(P).trailing_active, true, "armed before the hold");
    setPositionHold(P, true, "operator");
    assert.equal(updatePnlAndCheckExits(P, data(-9.3), mgmt), null, "held: nothing fires");
    setPositionHold(P, false);
    const after = getTrackedPosition(P);
    assert.equal(after.trailing_active, false, "disarmed on release");
    assert.equal(after.hold_resume_rebase, true);
    assert.equal(updatePnlAndCheckExits(P, data(-9.3), mgmt), null, "first valuation after /unhold must not close as 'trailing TP'");
    const rebased = getTrackedPosition(P);
    assert.equal(rebased.peak_pnl_pct, -9.3);
    assert.equal(rebased.hold_resume_rebase, false);
    assert.equal(updatePnlAndCheckExits(P, data(-16), mgmt)?.action, "STOP_LOSS", "downside rules still apply");
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});

test("a suspect first valuation keeps trailing disarmed until a trusted one re-bases it", () => {
  const P = `HOLDRES2_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_H", pool_name: "SI-SOL", strategy: "spot", amount_sol: 0.9, initial_value_usd: 0.9, bin_range: [0, 100], active_bin: 90 });
  try {
    confirmPeak(P, 4.0, 1);
    updatePnlAndCheckExits(P, data(4.0), mgmt);
    setPositionHold(P, true);
    setPositionHold(P, false);
    assert.equal(updatePnlAndCheckExits(P, data(1.0, { pnl_pct_suspicious: true }), mgmt), null);
    assert.equal(getTrackedPosition(P).trailing_active, false, "the stale 4 % peak must not re-arm trailing");
    assert.equal(getTrackedPosition(P).hold_resume_rebase, true);
    updatePnlAndCheckExits(P, data(1.2), mgmt);
    assert.equal(getTrackedPosition(P).peak_pnl_pct, 1.2);
    // trailing re-arms normally from the new reference
    confirmPeak(P, 3.0, 1);
    updatePnlAndCheckExits(P, data(3.0), mgmt);
    assert.equal(getTrackedPosition(P).trailing_active, true);
    assert.equal(updatePnlAndCheckExits(P, data(1.2), mgmt)?.action, "TRAILING_TP");
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});
