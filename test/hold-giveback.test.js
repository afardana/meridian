process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Hold-cohort give-back alert (audit 01 §4.3) ===");

const { evaluateHoldGiveBack } = await import("../state.js");
const cfg = { holdGiveBackAlertPp: 10 };

// Not held → never alerts.
assert.deepEqual(evaluateHoldGiveBack({ hold_mode: false, peak_pnl_pct: 50 }, -10, cfg), { alert: false, reset: false });
// Held, below the first step → no alert, no reset when nothing was latched.
{
  const r = evaluateHoldGiveBack({ hold_mode: true, peak_pnl_pct: 20 }, 12, cfg);
  assert.equal(r.alert, false); assert.equal(r.reset, false); assert.equal(r.level_pp, 0);
}
// Held, 55 → −17 = 72 pp give-back → alert at the 70 step.
{
  const r = evaluateHoldGiveBack({ hold_mode: true, peak_pnl_pct: 55 }, -17, cfg);
  assert.equal(r.alert, true); assert.equal(r.level_pp, 70); assert.ok(Math.abs(r.drop_pp - 72) < 1e-9);
}
// Same step already latched → silent; a deeper step → alerts again.
assert.equal(evaluateHoldGiveBack({ hold_mode: true, peak_pnl_pct: 55, hold_giveback_alert_pp: 70 }, -17, cfg).alert, false);
assert.equal(evaluateHoldGiveBack({ hold_mode: true, peak_pnl_pct: 55, hold_giveback_alert_pp: 70 }, -26, cfg).level_pp, 80);
assert.equal(evaluateHoldGiveBack({ hold_mode: true, peak_pnl_pct: 55, hold_giveback_alert_pp: 70 }, -26, cfg).alert, true);
// Recovery under the first step resets the latch so a second round trip alerts again.
{
  const r = evaluateHoldGiveBack({ hold_mode: true, peak_pnl_pct: 55, hold_giveback_alert_pp: 70 }, 50, cfg);
  assert.equal(r.alert, false); assert.equal(r.reset, true);
}
// Off switch and missing peak.
assert.equal(evaluateHoldGiveBack({ hold_mode: true, peak_pnl_pct: 55 }, -17, { holdGiveBackAlertPp: 0 }).alert, false);
assert.equal(evaluateHoldGiveBack({ hold_mode: true }, -17, cfg).alert, false);

console.log("✅ hold give-back decision verified");
