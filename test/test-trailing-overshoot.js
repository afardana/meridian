import assert from "node:assert/strict";
import { evaluateTrailingTakeProfit } from "../state.js";

const options = { dropPct: 1.2, overshootPct: 0.5 };

assert.equal(evaluateTrailingTakeProfit(3.25, 2.10, options), null, "above threshold must not signal");

const normalBreach = evaluateTrailingTakeProfit(3.25, 2.00, options);
assert.equal(normalBreach.action, "TRAILING_TP");
assert.equal(normalBreach.threshold_pnl_pct, 2.05);
assert.equal(normalBreach.bypass_confirmation, false, "small breach still needs confirmation");

const overshootBreach = evaluateTrailingTakeProfit(3.25, 1.21, options);
assert.equal(overshootBreach.threshold_pnl_pct, 2.05);
assert.equal(Number(overshootBreach.overshoot_pct.toFixed(2)), 0.84);
assert.equal(overshootBreach.bypass_confirmation, true, "large first breach bypasses confirmation");

const floorBreach = evaluateTrailingTakeProfit(3.25, 2.40, {
  dropPct: 1.2,
  minPnlPct: 2.5,
  overshootPct: 0.5,
});
assert.equal(floorBreach.threshold_pnl_pct, 2.5);
assert.equal(floorBreach.threshold_source, "profit-floor");

// Replay the cc-SOL trigger path: the first sampled breach was already 1.21%,
// followed by a deeper 0.80% tick. The first breach must be actionable.
const ccSolSamples = [3.25, 2.49, 2.81, 1.21, 0.80];
const firstSignal = ccSolSamples
  .map((pnl) => evaluateTrailingTakeProfit(3.25, pnl, options))
  .find(Boolean);
assert.equal(firstSignal.current_pnl_pct, 1.21);
assert.equal(firstSignal.bypass_confirmation, true);

console.log("Trailing overshoot replay passed: cc-SOL would close on the 1.21% first breach.");
