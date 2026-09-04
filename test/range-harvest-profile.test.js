import assert from "node:assert/strict";
import fs from "node:fs";
import {
  inferPositionStrategyFromBins,
  isRangeHarvestProfitExitSuppressed,
} from "../state.js";

const bins = (values) => values.map((v, b) => ({ b, v }));

assert.equal(inferPositionStrategyFromBins(bins(Array(15).fill(0.8))), "spot");
assert.equal(inferPositionStrategyFromBins(bins([0.1,0.2,0.3,0.5,0.7,0.9,1,0.9,0.7,0.5,0.3,0.2,0.1])), "curve");
assert.equal(inferPositionStrategyFromBins(bins([1,0.9,0.8,0.5,0.3,0.2,0.1,0.2,0.3,0.5,0.8,0.9,1])), "bid_ask");
assert.equal(inferPositionStrategyFromBins(bins([0,0,0,0,1,1,1,1,0,0,0,0])), null);

for (const action of ["TAKE_PROFIT", "TRAILING_TP", "PROFIT_RATCHET"]) {
  assert.equal(isRangeHarvestProfitExitSuppressed("range_harvest", action), true);
}
for (const action of ["STOP_LOSS", "YOUNG_STOP", "CRASH_FASTPATH", "RUG_FASTPATH", "LOW_YIELD", "ROUND_TRIP_HARVEST"]) {
  assert.equal(isRangeHarvestProfitExitSuppressed("range_harvest", action), false);
}

const indexSource = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
const stateSource = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
const reportSource = fs.readFileSync(new URL("../report.js", import.meta.url), "utf8");
const pnlSource = fs.readFileSync(new URL("../tools/pnl.js", import.meta.url), "utf8");

assert.match(indexSource, /isRangeHarvestProfitExitSuppressed\(tracked\?\.management_profile, "TAKE_PROFIT"\)/);
assert.match(stateSource, /!rangeHarvest && mgmtConfig\.trailingTakeProfit/);
assert.match(stateSource, /!rangeHarvest && !pnl_pct_suspicious && currentPnlPct/);
assert.match(stateSource, /!rangeHarvest && !pnl_pct_suspicious && pos\.trailing_active/);
assert.match(stateSource, /action: "rebalance_external"/);
assert.match(reportSource, /management_profile: p\.management_profile/);
assert.match(pnlSource, /reconcileAdoptedPositionStrategy\(f\.position, bins\)/);

console.log("Range-harvest profile coverage passed.");
