process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";

const { ensureStateInitialized, trackPosition, updatePnlAndCheckExits, closeTrackedPosition } = await import("../state.js");
await ensureStateInitialized();

const base = {
  trailingTakeProfit: false, roundTripHarvestEnabled: false, stopLossPct: -15, takeProfitPct: null, twapGuardEnabled: false,
  outOfRangeBinsToClose: 50,
  outOfRangeWaitMinutesAbove: 720,
  outOfRangeWaitMinutesBelow: 60,
  minFeePerTvl24h: 1,
  minAgeBeforeYieldCheck: 60,
};
const data = (over) => ({ lower_bin: -100, upper_bin: -31, in_range: false, minutes_out_of_range: 5, fee_per_tvl_24h: 5, age_minutes: 10, pnl_quality: "valid", ...over });
const run = (cfg, over) => {
  const P = `UNF_${Math.random().toString(36).slice(2)}`;
  trackPosition({ position: P, pool: "POOL_U", pool_name: "U-SOL", strategy: "spot", amount_sol: 1, initial_value_usd: 1, bin_range: [-100, -31], active_bin: -50 });
  try { return updatePnlAndCheckExits(P, data(over), cfg); } finally { try { closeTrackedPosition(P, "test"); } catch {} }
};

test("unfilled cap disabled (null) ⇒ only the generic 50-bin rule applies", () => {
  const cfg = { ...base, outOfRangeBinsToCloseUnfilled: null };
  assert.equal(run(cfg, { active_bin: -1, pnl_pct: 0.0 }), null); // 30 bins above
  const r = run(cfg, { active_bin: 20, pnl_pct: 0.0 }); // 51 bins above
  assert.equal(r?.action, "PUMPED_ABOVE");
  assert.equal(r?.rule, "pumped_above");
  assert.equal(r?.family, "oor_above");
  assert.equal(r?.unfilled, undefined);
});

test("unfilled cap closes an unfilled ladder at the tighter distance", () => {
  const cfg = { ...base, outOfRangeBinsToCloseUnfilled: 25, unfilledMaxPnlPct: 1.0 };
  assert.equal(run(cfg, { active_bin: -10, pnl_pct: 0.0 }), null); // 21 bins — under the cap
  const r = run(cfg, { active_bin: -5, pnl_pct: 0.12 }); // 26 bins
  assert.equal(r?.action, "UNFILLED_ABOVE");
  assert.equal(r?.rule, "unfilled_above");
  assert.equal(r?.family, "oor_above_unfilled");
  assert.equal(r?.unfilled, true);
  assert.equal(r?.oor_direction, "above");
  assert.equal(r?.urgent, false);
  assert.match(r.reason, /unfilled ladder/);
});

test("unfilled cap never fires on a filled ladder or without a pnl reading", () => {
  const cfg = { ...base, outOfRangeBinsToCloseUnfilled: 25, unfilledMaxPnlPct: 1.0 };
  assert.equal(run(cfg, { active_bin: -5, pnl_pct: 2.4 }), null); // filled + unwound: harvest territory
  assert.equal(run(cfg, { active_bin: -5, pnl_pct: null }), null); // no valuation ⇒ no close
  assert.equal(run(cfg, { active_bin: -5, pnl_pct: 1.0 }), null); // at the bar, not below it
  const r = run(cfg, { active_bin: 20, pnl_pct: 2.4 }); // 51 bins: the generic rule still applies
  assert.equal(r?.action, "PUMPED_ABOVE");
  assert.equal(r?.unfilled, undefined);
});
