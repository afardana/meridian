process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { ensureStateInitialized, trackPosition, updatePnlAndCheckExits, confirmPeak, closeTrackedPosition, getTrackedPosition, finalizeExit, EXIT_FAMILY_BY_ACTION, URGENT_EXIT_ACTIONS } = await import("../state.js");
await ensureStateInitialized();

const mgmt = {
  trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5,
  stopLossPct: -15, takeProfitPct: 35, twapGuardEnabled: false, roundTripHarvestEnabled: false,
  outOfRangeBinsToClose: 50, outOfRangeBinsToCloseUnfilled: 25, unfilledMaxPnlPct: 1.0,
  outOfRangeWaitMinutesAbove: 720, outOfRangeWaitMinutesBelow: 60, oorAboveStableTicks: 2,
  minFeePerTvl24h: 1, minAgeBeforeYieldCheck: 60, poolHealthMinSnapshots: 0,
};
const data = (over) => ({ pnl_pct: 0, effective_pnl_pct: 0, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100, fee_per_tvl_24h: 5, age_minutes: 200, fresh_snapshots: 10, pnl_quality: "valid", ...over });
function withPos(fn) {
  const P = `ORD_${Math.random().toString(36).slice(2)}`;
  trackPosition({ position: P, pool: "POOL_O", pool_name: "ORD-SOL", strategy: "spot", amount_sol: 1, initial_value_usd: 1, bin_range: [0, 100], active_bin: 50 });
  try { return fn(P); } finally { try { closeTrackedPosition(P, "test"); } catch {} }
}

test("every exit carries family, urgent and confirm_ticks", () => {
  for (const action of Object.keys(EXIT_FAMILY_BY_ACTION)) {
    const e = finalizeExit({ action, reason: "x" });
    assert.equal(e.family, EXIT_FAMILY_BY_ACTION[action]);
    assert.equal(e.urgent, URGENT_EXIT_ACTIONS.has(action));
    assert.equal(e.confirm_ticks, null);
  }
  assert.equal(finalizeExit({ action: "TRAILING_TP", bypass_confirmation: true }).confirm_ticks, 1);
  assert.equal(finalizeExit({ action: "CRASH_FASTPATH", confirm_ticks: 3 }).confirm_ticks, 3);
});

test("stop loss outranks trailing when both fire on one tick", () => withPos((P) => {
  confirmPeak(P, 5, 1);
  assert.equal(updatePnlAndCheckExits(P, data({ pnl_pct: 5, effective_pnl_pct: 5 }), mgmt), null);
  assert.equal(getTrackedPosition(P).trailing_active, true);
  const e = updatePnlAndCheckExits(P, data({ pnl_pct: -16, effective_pnl_pct: -16 }), mgmt);
  assert.equal(e.action, "STOP_LOSS");
  assert.equal(e.urgent, true);
  assert.equal(e.family, "stop_loss");
}));

test("trailing overshoot carries confirm_ticks 1, a plain breach carries the default", () => withPos((P) => {
  confirmPeak(P, 5, 1);
  updatePnlAndCheckExits(P, data({ pnl_pct: 5, effective_pnl_pct: 5 }), mgmt);
  const plain = updatePnlAndCheckExits(P, data({ pnl_pct: 3.4, effective_pnl_pct: 3.4 }), mgmt); // drop 1.6 ≥ 1.5, overshoot 0.1
  assert.equal(plain.action, "TRAILING_TP"); assert.equal(plain.confirm_ticks, null); assert.equal(plain.urgent, false);
  const big = updatePnlAndCheckExits(P, data({ pnl_pct: 1.0, effective_pnl_pct: 1.0 }), mgmt); // overshoot 2.5 ≥ 0.5
  assert.equal(big.action, "TRAILING_TP"); assert.equal(big.confirm_ticks, 1);
}));

test("pumped-above (generic cap) precedes the unfilled cap; unfilled fires at the tighter distance", () => withPos((P) => {
  const far = updatePnlAndCheckExits(P, data({ in_range: false, active_bin: 160, pnl_pct: 0, effective_pnl_pct: 0, minutes_out_of_range: 3 }), mgmt); // 60 above
  assert.equal(far.action, "PUMPED_ABOVE"); assert.equal(far.family, "oor_above");
  const near = updatePnlAndCheckExits(P, data({ in_range: false, active_bin: 130, pnl_pct: 0.2, effective_pnl_pct: 0.2, minutes_out_of_range: 3 }), mgmt); // 30 above, pnl < 1
  assert.equal(near.action, "UNFILLED_ABOVE"); assert.equal(near.family, "oor_above_unfilled"); assert.equal(near.unfilled, true);
}));

test("OOR-above waits for price stability and no longer masks the rules after it", () => withPos((P) => {
  const cfg = { ...mgmt, outOfRangeBinsToClose: 500, outOfRangeBinsToCloseUnfilled: null };
  // 800 min above the range, price still moving (bin changes every tick) and fees dead → LOW_YIELD is reachable
  const e1 = updatePnlAndCheckExits(P, data({ in_range: false, active_bin: 110, minutes_out_of_range: 800, fee_per_tvl_24h: 0.1 }), cfg);
  assert.equal(e1.action, "LOW_YIELD");
  // fees fine: the bin moves (110 → 111) so the first evaluation is not stable; two
  // consecutive evaluations at 111 (oorAboveStableTicks 2) then fire OOR-above
  assert.equal(updatePnlAndCheckExits(P, data({ in_range: false, active_bin: 111, minutes_out_of_range: 801 }), cfg), null);
  const e2 = updatePnlAndCheckExits(P, data({ in_range: false, active_bin: 111, minutes_out_of_range: 802 }), cfg);
  assert.equal(e2.action, "OUT_OF_RANGE_ABOVE"); assert.equal(e2.family, "oor_above"); assert.equal(e2.oor_direction, "above");
}));

test("OOR-below fires on the tracked clock, take profit fires on effective pnl", () => withPos((P) => {
  getTrackedPosition(P).out_of_range_since = new Date(Date.now() - 61 * 60_000).toISOString();
  const e = updatePnlAndCheckExits(P, data({ in_range: false, active_bin: -5, minutes_out_of_range: 61 }), mgmt);
  assert.equal(e.action, "OUT_OF_RANGE"); assert.equal(e.family, "oor_below");
  const tp = updatePnlAndCheckExits(P, data({ pnl_pct: 30, effective_pnl_pct: 36 }), mgmt);
  assert.equal(tp.action, "TAKE_PROFIT"); assert.equal(tp.family, "take_profit");
}));

test("a suspect valuation (≤ −90 % with value) fires nothing", () => withPos((P) => {
  assert.equal(updatePnlAndCheckExits(P, data({ pnl_pct: -95, effective_pnl_pct: -95, total_value_usd: 0.5 }), mgmt), null);
}));

test("index.js no longer carries a second evaluator", () => {
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /function getDeterministicCloseRule/);
  assert.doesNotMatch(src, /URGENT_EXIT_ACTIONS\.has/);
  assert.match(src, /async function applyExitGates\(p, exit\)/);
  assert.match(src, /async function buildExitAction\(p, exit, extra = \{\}\)/);
  assert.match(src, /const effectiveConfirm = exit\?\.confirm_ticks \?\? confirmTicks;/);
});
