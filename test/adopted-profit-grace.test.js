process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { trackPosition, updatePnlAndCheckExits, confirmPeak, closeTrackedPosition, ensureStateInitialized, isProfitExitSuppressed, getTrackedPosition } = await import("../state.js");
await ensureStateInitialized();

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5, stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 60, roundTripHarvestEnabled: true, roundTripMinPnlPct: 1, roundTripFrozenTicks: 6, roundTripFrozenEpsilonPct: 0.05, roundTripMinBinsAbove: 5 };
const data = (pnl, over = {}) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 90, lower_bin: 0, upper_bin: 100, pnl_quality: "valid", ...over });

test("adopted position: trailing TP does not arm or fire inside the grace, stop-loss still does", () => {
  const P = `GRACE_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_G", pool_name: "MAN-SOL", strategy: "manual", amount_sol: 1, initial_value_usd: 1, bin_range: [0, 100], active_bin: 90, adopted: true });
  try {
    const pos = getTrackedPosition(P);
    assert.ok(pos.adopted && pos.adopted_at, "adopted_at must be set");
    confirmPeak(P, 3.0, 1);
    assert.equal(updatePnlAndCheckExits(P, data(3.0), mgmt), null);
    assert.ok(!getTrackedPosition(P).trailing_active, "must not arm inside the grace");
    assert.equal(updatePnlAndCheckExits(P, data(0.5), mgmt), null, "a 2.5pp drop inside the grace must not close");
    assert.equal(isProfitExitSuppressed(getTrackedPosition(P), "TAKE_PROFIT", mgmt), true);
    assert.equal(isProfitExitSuppressed(getTrackedPosition(P), "STOP_LOSS", mgmt), false);
    const sl = updatePnlAndCheckExits(P, data(-16), mgmt);
    assert.ok(sl == null || sl.action !== "TRAILING_TP"); // stop-loss path is index.js RULE_1 in practice; must never be a profit exit
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});

test("adopted position: after the grace the normal trailing rule applies", () => {
  const P = `GRACE2_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_G", pool_name: "MAN-SOL", strategy: "manual", amount_sol: 1, initial_value_usd: 1, bin_range: [0, 100], active_bin: 90, adopted: true });
  try {
    const pos = getTrackedPosition(P);
    pos.adopted_at = new Date(Date.now() - 61 * 60_000).toISOString();
    confirmPeak(P, 3.0, 1);
    assert.equal(updatePnlAndCheckExits(P, data(3.0), mgmt), null);
    assert.equal(getTrackedPosition(P).trailing_active, true, "arms once the grace has elapsed");
    const exit = updatePnlAndCheckExits(P, data(0.5), mgmt);
    assert.equal(exit?.action, "TRAILING_TP");
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});

test("bot (non-adopted) positions are unaffected by the grace", () => {
  const P = `GRACE3_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_G", pool_name: "BOT-SOL", strategy: "spot", amount_sol: 1, initial_value_usd: 1, bin_range: [0, 100], active_bin: 90 });
  try {
    confirmPeak(P, 3.0, 1);
    assert.equal(updatePnlAndCheckExits(P, data(3.0), mgmt), null);
    assert.equal(getTrackedPosition(P).trailing_active, true);
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});

test("grace end re-bases the trailing reference: a peak seen inside the grace cannot fire trailing at a loss", () => {
  // SWARM-SOL 2026-09-26: peak +2.63 confirmed during the grace, −5.40 at grace end →
  // trailing armed against the stale peak and closed at −5.02 under the name "trailing TP".
  const P = `GRACE4_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_G", pool_name: "SWARM-SOL", strategy: "manual", amount_sol: 1, initial_value_usd: 1, bin_range: [0, 100], active_bin: 90, adopted: true });
  try {
    confirmPeak(P, 2.63, 1);
    assert.equal(updatePnlAndCheckExits(P, data(2.63), mgmt), null);          // inside the grace
    assert.equal(getTrackedPosition(P).profit_grace_active, true);
    assert.equal(updatePnlAndCheckExits(P, data(-5.4), mgmt), null);          // still inside
    getTrackedPosition(P).adopted_at = new Date(Date.now() - 61 * 60_000).toISOString(); // grace over
    const atEnd = updatePnlAndCheckExits(P, data(-5.4), mgmt);
    assert.equal(atEnd, null, "must not fire trailing at −5.4 off a peak seen inside the grace");
    const pos = getTrackedPosition(P);
    assert.equal(pos.profit_grace_active, false);
    assert.equal(pos.peak_pnl_pct, -5.4, "reference re-based to the current valuation");
    assert.equal(pos.trailing_active, false);
    // A NEW post-grace peak arms trailing normally and a 1.5 pp drop from it fires.
    confirmPeak(P, 2.5, 1);
    assert.equal(updatePnlAndCheckExits(P, data(2.5), mgmt), null);
    assert.equal(getTrackedPosition(P).trailing_active, true);
    assert.equal(updatePnlAndCheckExits(P, data(0.9), mgmt)?.action, "TRAILING_TP");
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});
