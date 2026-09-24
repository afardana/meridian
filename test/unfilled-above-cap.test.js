process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";

const { getDeterministicCloseRule } = await import("../index.js");

const base = {
  manageUntracked: true,
  outOfRangeBinsToClose: 50,
  outOfRangeWaitMinutesAbove: 720,
  outOfRangeWaitMinutesBelow: 60,
  minFeePerTvl24h: 1,
  minAgeBeforeYieldCheck: 60,
};
const pos = (over) => ({ position: "P1", lower_bin: -100, upper_bin: -31, minutes_out_of_range: 5, fee_per_tvl_24h: 5, age_minutes: 10, ...over });

test("unfilled cap disabled (null) ⇒ byte-identical to the 50-bin rule", () => {
  const cfg = { ...base, outOfRangeBinsToCloseUnfilled: null };
  assert.equal(getDeterministicCloseRule(pos({ active_bin: -1, pnl_pct: 0.0 }), cfg), null); // 30 bins above
  const r = getDeterministicCloseRule(pos({ active_bin: 20, pnl_pct: 0.0 }), cfg); // 51 bins above
  assert.equal(r?.rule, 3);
  assert.equal(r?.unfilled, undefined);
});

test("unfilled cap closes an unfilled ladder at the tighter distance", () => {
  const cfg = { ...base, outOfRangeBinsToCloseUnfilled: 25, unfilledMaxPnlPct: 1.0 };
  assert.equal(getDeterministicCloseRule(pos({ active_bin: -10, pnl_pct: 0.0 }), cfg), null); // 21 bins — under the cap
  const r = getDeterministicCloseRule(pos({ active_bin: -5, pnl_pct: 0.12 }), cfg); // 26 bins
  assert.equal(r?.rule, 3);
  assert.equal(r?.unfilled, true);
  assert.equal(r?.oor_direction, "above");
  assert.match(r.reason, /unfilled ladder/);
});

test("unfilled cap never fires on a filled ladder or without a pnl reading", () => {
  const cfg = { ...base, outOfRangeBinsToCloseUnfilled: 25, unfilledMaxPnlPct: 1.0 };
  assert.equal(getDeterministicCloseRule(pos({ active_bin: -5, pnl_pct: 2.4 }), cfg), null); // filled + unwound: harvest territory
  assert.equal(getDeterministicCloseRule(pos({ active_bin: -5, pnl_pct: null }), cfg), null); // no valuation ⇒ no close
  assert.equal(getDeterministicCloseRule(pos({ active_bin: -5, pnl_pct: 1.0 }), cfg), null); // at the bar, not below it
  const r = getDeterministicCloseRule(pos({ active_bin: 20, pnl_pct: 2.4 }), cfg); // 51 bins: the generic rule still applies
  assert.equal(r?.rule, 3);
  assert.equal(r?.unfilled, undefined);
});
