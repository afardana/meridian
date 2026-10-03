process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Rebalance event capture ===");

const { buildRebalanceEvent } = await import("../state.js");
const now = Date.parse("2026-10-03T11:21:58Z");

// swordcat-SOL 2026-10-03: SOL-only ladder −482..−413, price 8 bins above for ~7 min,
// re-ranged to −440..−371 around bin −405 (two-sided).
{
  const pos = {
    adopted_at: "2026-10-03T11:02:43Z",
    peak_pnl_pct: 0.11,
    pnl_tick_history: [0.08, 0.11, 0.11],
    out_of_range_since: null,
    last_oor_ended_at: "2026-10-03T11:21:58Z",
    last_oor_minutes: 6.8,
  };
  const ev = buildRebalanceEvent(pos, { previousMin: -482, previousMax: -413, lower_bin: -440, upper_bin: -371, active_bin: -405, pnl_after: -0.39, now });
  assert.equal(ev.side, "above");
  assert.equal(ev.bins_outside, 8);
  assert.equal(ev.oor_minutes, 6.8);
  assert.equal(ev.new_bins_below, 35);
  assert.equal(ev.new_bins_above, 34);
  assert.equal(ev.two_sided, true);
  assert.equal(ev.pnl_before, 0.11);
  assert.equal(ev.pnl_after, -0.39);
  assert.equal(ev.age_minutes, 19);
  assert.deepEqual(ev.from, [-482, -413]);
  assert.deepEqual(ev.to, [-440, -371]);
}
// Still out of range at detection → live spell length; a stale ended spell is ignored.
{
  const ev = buildRebalanceEvent({ out_of_range_since: new Date(now - 300_000).toISOString(), pnl_tick_history: [] },
    { previousMin: -100, previousMax: -31, lower_bin: -180, upper_bin: -111, active_bin: -111, pnl_after: -4, now });
  assert.equal(ev.side, "below"); assert.equal(ev.bins_outside, 11); assert.equal(ev.oor_minutes, 5);
  assert.equal(ev.new_bins_above, 0); assert.equal(ev.two_sided, false); assert.equal(ev.pnl_before, null);
  const stale = buildRebalanceEvent({ last_oor_ended_at: new Date(now - 600_000).toISOString(), last_oor_minutes: 9 },
    { previousMin: -100, previousMax: -31, lower_bin: -90, upper_bin: -21, active_bin: -50, pnl_after: 1, now });
  assert.equal(stale.side, "in_range"); assert.equal(stale.oor_minutes, null);
}
// A suspect reading is not recorded as the after-value; missing bins degrade to nulls.
{
  const ev = buildRebalanceEvent({}, { previousMin: -10, previousMax: 0, lower_bin: -5, upper_bin: 5, active_bin: null, pnl_after: -49, suspicious: true, now });
  assert.equal(ev.pnl_after, null); assert.equal(ev.side, null); assert.equal(ev.two_sided, null);
}

console.log("✅ rebalance event capture verified");
