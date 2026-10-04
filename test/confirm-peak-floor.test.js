process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Peak confirmation takes the level the whole streak reached ===");

const { trackPosition, confirmPeak, getTrackedPosition, ensureStateInitialized, recordClose } = await import("../state.js");
await ensureStateInitialized();

const mk = (name) => {
  const addr = `TEST_PEAK_${name}_${Date.now()}`;
  trackPosition({ position: addr, pool: `POOL_${name}`, pool_name: `${name}-SOL`, amount_sol: 0.25, strategy: "spot" });
  return addr;
};
const peak = (a) => getTrackedPosition(a).peak_pnl_pct ?? 0;

// SPLICE-SOL 2026-10-04: confirmed 3.40, then 4.32, then a one-off 8.30.
{
  const a = mk("SPLICE");
  assert.equal(confirmPeak(a, 3.36), false);
  assert.equal(confirmPeak(a, 3.40), true);
  assert.equal(peak(a), 3.36);                 // both readings reached 3.36
  assert.equal(confirmPeak(a, 4.32), false);   // first reading above the peak
  assert.equal(confirmPeak(a, 8.30), true);    // outlier confirms the streak…
  assert.equal(peak(a), 4.32);                 // …at the level both readings reached, not 8.30
  recordClose(a, "test cleanup");
}
// A real sustained high is still confirmed in two readings, at the lower of them.
{
  const a = mk("RISE");
  confirmPeak(a, 5.0);
  assert.equal(confirmPeak(a, 5.4), true);
  assert.equal(peak(a), 5.0);
  confirmPeak(a, 6.1);
  assert.equal(confirmPeak(a, 5.8), true);     // dipped but stayed above the old peak
  assert.equal(peak(a), 5.8);
  recordClose(a, "test cleanup");
}
// A reading back at or under the confirmed peak drops the pending streak.
{
  const a = mk("DROP");
  confirmPeak(a, 2.0); confirmPeak(a, 2.0);
  assert.equal(peak(a), 2.0);
  confirmPeak(a, 9.0);                          // lone spike
  assert.equal(confirmPeak(a, 1.5), false);     // gone on the next reading
  assert.equal(peak(a), 2.0);
  assert.equal(getTrackedPosition(a).pending_peak_pnl_pct, null);
  recordClose(a, "test cleanup");
}

console.log("✅ peak confirmation floor verified");
process.exit(0);
