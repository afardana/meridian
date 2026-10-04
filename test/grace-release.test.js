process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { trackPosition, updatePnlAndCheckExits, confirmPeak, closeTrackedPosition, ensureStateInitialized, isProfitExitSuppressed, getTrackedPosition, releasePositionProfitGrace, profitGraceRemainingMin, adoptedProfitGraceRemainingMin } = await import("../state.js");
await ensureStateInitialized();

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5, stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 60 };
const data = (pnl, over = {}) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 90, lower_bin: 0, upper_bin: 100, pnl_quality: "valid", ...over });

test("operator release ends an adoption grace: profit rules resume, trailing re-bases on the current valuation", () => {
  const P = `GREL_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_R", pool_name: "MAN-SOL", strategy: "manual", amount_sol: 1, initial_value_usd: 1, bin_range: [0, 100], active_bin: 90, adopted: true });
  try {
    confirmPeak(P, 6.0, 1);
    assert.equal(updatePnlAndCheckExits(P, data(6.0), mgmt), null);
    assert.ok(profitGraceRemainingMin(getTrackedPosition(P), mgmt) > 59);

    const r = releasePositionProfitGrace(P, mgmt);
    assert.equal(r.ok, true);
    assert.equal(r.was_active, true);
    const pos = getTrackedPosition(P);
    assert.ok(pos.profit_grace_released_at);
    assert.equal(adoptedProfitGraceRemainingMin(pos, mgmt), 0, "above-range caps un-pause too");
    assert.equal(profitGraceRemainingMin(pos, mgmt), 0);
    assert.equal(isProfitExitSuppressed(pos, "TRAILING_TP", mgmt), false);

    // First valuation after the release sits 2 pp under the in-grace peak: it must re-base,
    // not close as "trailing TP" against a peak the rule was never allowed to act on.
    assert.equal(updatePnlAndCheckExits(P, data(4.0), mgmt), null);
    assert.equal(getTrackedPosition(P).peak_pnl_pct, 4.0);
    assert.equal(updatePnlAndCheckExits(P, data(4.0), mgmt), null);
    assert.equal(getTrackedPosition(P).trailing_active, true, "armed from the re-based peak");
    assert.equal(updatePnlAndCheckExits(P, data(2.0), mgmt)?.action, "TRAILING_TP");
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});

test("release is a no-op outside a grace and unknown positions are refused", () => {
  const P = `GREL2_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_R2", pool_name: "BOT-SOL", strategy: "spot", amount_sol: 1, initial_value_usd: 1, bin_range: [0, 100], active_bin: 90 });
  try {
    assert.deepEqual(releasePositionProfitGrace(P, mgmt), { ok: true, was_active: false, remaining_min: 0 });
    assert.equal(getTrackedPosition(P).profit_grace_released_at, undefined);
    assert.equal(releasePositionProfitGrace("NOPE", mgmt).ok, false);
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});

test("release clears a straddle's explicit window", () => {
  const P = `GREL3_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_R3", pool_name: "STR-SOL", strategy: "spot", amount_sol: 1, initial_value_usd: 1, bin_range: [0, 100], active_bin: 90 });
  try {
    const pos = getTrackedPosition(P);
    pos.profit_grace_until = new Date(Date.now() + 45 * 60_000).toISOString();
    assert.ok(profitGraceRemainingMin(getTrackedPosition(P), mgmt) > 44);
    assert.equal(releasePositionProfitGrace(P, mgmt).was_active, true);
    assert.equal(getTrackedPosition(P).profit_grace_until, null);
    assert.equal(profitGraceRemainingMin(getTrackedPosition(P), mgmt), 0);
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});
