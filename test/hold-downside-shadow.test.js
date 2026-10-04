process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Hold that keeps the stop loss (shadow) ===");

const { evaluateHoldDownside, noteHoldDownsideShadow, trackPosition, setPositionHold, getTrackedPosition, ensureStateInitialized, recordClose, updatePnlAndCheckExits } = await import("../state.js");
await ensureStateInitialized();
const cfg = { stopLossPct: -15, youngStopEnabled: true, youngStopPct: -10, youngStopMaxAgeHours: 12, holdDownsideMode: "shadow" };

// Pure decision.
assert.equal(evaluateHoldDownside({ hold_mode: false }, -40, cfg).would_close, false);       // not held
assert.equal(evaluateHoldDownside({ hold_mode: true }, -14.9, cfg).would_close, false);      // above the stop
{
  const v = evaluateHoldDownside({ hold_mode: true }, -15.6, cfg);
  assert.deepEqual([v.would_close, v.rule, v.threshold_pct], [true, "stop_loss", -15]);
}
{
  const v = evaluateHoldDownside({ hold_mode: true, token_age_hours_at_deploy: 6 }, -10.5, cfg);
  assert.deepEqual([v.would_close, v.rule, v.threshold_pct], [true, "young_stop", -10]);
}
assert.equal(evaluateHoldDownside({ hold_mode: true, token_age_hours_at_deploy: 6 }, -10.5, { ...cfg, youngStopEnabled: false }).would_close, false);
assert.equal(evaluateHoldDownside({ hold_mode: true }, -50, { ...cfg, holdDownsideMode: "off" }).would_close, false);
assert.equal(evaluateHoldDownside({ hold_mode: true }, null, cfg).would_close, false);
assert.equal(evaluateHoldDownside({ hold_mode: true }, -50, { holdDownsideMode: "shadow" }).would_close, false); // no stop configured

// Record: first would-close once, then worst / latest pnl; a fresh hold starts over.
const addr = "TEST_HOLD_DOWNSIDE_" + Date.now();
trackPosition({ position: addr, pool: "POOL_HD", pool_name: "HD-SOL", amount_sol: 2, strategy: "spot" });
setPositionHold(addr, true);
const held = () => getTrackedPosition(addr);
assert.equal(noteHoldDownsideShadow(addr, evaluateHoldDownside(held(), -8, cfg), -8), false);
assert.equal(held().hold_downside_shadow ?? null, null);
assert.equal(noteHoldDownsideShadow(addr, evaluateHoldDownside(held(), -16.2, cfg), -16.2), true);   // first fire
assert.equal(held().hold_downside_shadow.first_pnl_pct, -16.2);
assert.equal(held().hold_downside_shadow.rule, "stop_loss");
assert.equal(noteHoldDownsideShadow(addr, evaluateHoldDownside(held(), -85, cfg), -85), false);      // not a second fire
assert.equal(held().hold_downside_shadow.worst_pnl_pct, -85);
noteHoldDownsideShadow(addr, evaluateHoldDownside(held(), -40, cfg), -40);
assert.equal(held().hold_downside_shadow.worst_pnl_pct, -85);
assert.equal(held().hold_downside_shadow.last_pnl_pct, -40);
assert.equal(held().hold_downside_shadow.first_pnl_pct, -16.2);

// Shadow only: the real evaluator still returns no exit for a held position.
assert.equal(updatePnlAndCheckExits(addr, { pnl_pct: -60, in_range: false, active_bin: -500, lower_bin: -400, upper_bin: -331 }, cfg), null);

setPositionHold(addr, false);
setPositionHold(addr, true);
assert.equal(held().hold_downside_shadow, null);
recordClose(addr, "test cleanup");

// Wired into the management cycle's hold block, behind trusted valuations.
const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
assert.match(idx, /p\.pnl_management_ready !== false && p\.pnl_pct_suspicious !== true[\s\S]{0,200}evaluateHoldDownside\(tracked, p\.pnl_pct, config\.management\)/);
assert.match(idx, /\[HOLD_DOWNSIDE_SHADOW\] would-close/);

console.log("✅ hold downside shadow verified");
process.exit(0);
