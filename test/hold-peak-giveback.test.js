process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const {
  trackPosition, updatePnlAndCheckExits, confirmPeak, closeTrackedPosition, ensureStateInitialized, getTrackedPosition,
  setPositionHold, evaluateHoldGiveBack, noteHoldGiveBackAlert, noteHoldPeakReading, advanceHoldPeak,
  holdGiveBackReferencePct, HOLD_PEAK_RECONFIRM_MS,
} = await import("../state.js");
await ensureStateInitialized();

const cfg = { holdGiveBackAlertPp: 10 };
const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5, stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 0 };
const data = (pnl) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 90, lower_bin: 0, upper_bin: 100, pnl_quality: "valid" });
const track = (P, name) => trackPosition({ position: P, pool: `POOL_${P}`, pool_name: name, strategy: "spot", amount_sol: 1.4679, initial_value_usd: 1.4679, bin_range: [0, 100], active_bin: 90 });

// One management-cycle reading of a held position, as index.js does it.
function cycle(P, pnl, nowMs) {
  noteHoldPeakReading(P, pnl, nowMs);
  const gb = evaluateHoldGiveBack(getTrackedPosition(P), pnl, cfg);
  if (gb.alert) noteHoldGiveBackAlert(P, gb.level_pp);
  else if (gb.reset) noteHoldGiveBackAlert(P, 0);
  return gb;
}

test("SIB-SOL 2026-10-10: the give-back is measured from the high reached while held", () => {
  const P = `HOLDPEAK_SIB_${Date.now()}`;
  track(P, "SIB-SOL");
  try {
    confirmPeak(P, 0.15, 1); // the grace-end re-base left the exit peak at ≈ 0.15
    setPositionHold(P, true, "operator");
    assert.equal(getTrackedPosition(P).hold_peak_pnl_pct, 0.15, "seeded from the confirmed peak");

    let t = 1_000_000;
    const step = 180_000; // management cadence
    const alerts = [];
    const run = (pnl) => { t += step; const gb = cycle(P, pnl, t); if (gb.alert) alerts.push({ pnl, ...gb }); return gb; };

    for (const pnl of [1.2, 3.9, 6.5, 9.8, 12.4, 14.1, 14.8, 14.8, 14.6]) run(pnl);
    assert.equal(alerts.length, 0, "a rising held position never alerts");
    const high = getTrackedPosition(P).hold_peak_pnl_pct;
    assert.equal(high, 14.8, "the plateau reading stood twice");
    assert.equal(getTrackedPosition(P).peak_pnl_pct, 0.15, "exit peak untouched");
    assert.equal(getTrackedPosition(P).trailing_active, false, "trailing not armed by the held high");

    for (const pnl of [12.0, 8.3, 5.1]) run(pnl); // 9.7 pp down: under the step
    assert.equal(alerts.length, 0);
    run(4.6); // 10.2 pp from 14.8
    assert.equal(alerts.length, 1, "first step fires 10 pp under the held high");
    assert.equal(alerts[0].peak, 14.8);
    assert.equal(alerts[0].level_pp, 10);
    assert.ok(Math.abs(alerts[0].drop_pp - 10.2) < 1e-9);

    run(3.0); run(-1.0); // still inside the 10-pp step
    assert.equal(alerts.length, 1, "one alert per step");
    run(-5.3); // 20.1 pp
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1].level_pp, 20);
    const last = run(-13.84); // 28.64 pp: still the 20 step
    assert.equal(alerts.length, 2);
    assert.equal(last.peak, 14.8);
    assert.ok(Math.abs(last.drop_pp - 28.64) < 1e-9, "the real give-back, not 14.0 pp from 0.15");
    assert.equal(getTrackedPosition(P).hold_giveback_alert_pp, 20);
  } finally { closeTrackedPosition?.(P); }
});

test("a single outlier reading does not become the reference", () => {
  const P = `HOLDPEAK_OUT_${Date.now()}`;
  track(P, "OUT-SOL");
  try {
    confirmPeak(P, 1.0, 1);
    setPositionHold(P, true);
    let t = 5_000_000;
    // one wild valuation, repeated by the 5 s poller for one ~15 s refresh, then gone
    for (let i = 0; i < 3; i++) { t += 5000; noteHoldPeakReading(P, 31.0, t); }
    assert.equal(getTrackedPosition(P).hold_peak_pnl_pct, 1.0, "same valuation seen three times is one reading");
    t += 5000; noteHoldPeakReading(P, 0.8, t);
    assert.equal(getTrackedPosition(P).hold_peak_pnl_pct, 1.0);
    assert.equal(getTrackedPosition(P).hold_peak_pending, null, "streak dropped");
    assert.equal(cycle(P, -4.0, t + 5000).alert, false, "5 pp from 1.0, not 35 pp from the outlier");

    // SPLICE shape: an outlier right after a real small rise confirms only the small rise
    t += 60_000; noteHoldPeakReading(P, 4.32, t);
    t += 15_000; noteHoldPeakReading(P, 8.30, t);
    assert.equal(getTrackedPosition(P).hold_peak_pnl_pct, 4.32, "lower of the two readings");

    // an unchanged reading that still stands after the reconfirm window is a second reading
    t += 15_000; noteHoldPeakReading(P, 6.0, t);
    t += 5000; noteHoldPeakReading(P, 6.0, t);
    assert.equal(getTrackedPosition(P).hold_peak_pnl_pct, 4.32);
    t += HOLD_PEAK_RECONFIRM_MS; noteHoldPeakReading(P, 6.0, t);
    assert.equal(getTrackedPosition(P).hold_peak_pnl_pct, 6.0);
  } finally { closeTrackedPosition?.(P); }
});

test("a new high re-arms the steps without alerting; a second round trip alerts once", () => {
  const P = `HOLDPEAK_RT_${Date.now()}`;
  track(P, "RT-SOL");
  try {
    confirmPeak(P, 5, 1);
    setPositionHold(P, true);
    let t = 9_000_000; const step = 180_000; let n = 0;
    const run = (pnl) => { t += step; const gb = cycle(P, pnl, t); if (gb.alert) n++; return gb; };
    run(-6); assert.equal(n, 1);                       // 11 pp from 5
    for (const pnl of [2, 9, 15, 22, 22.5, 23]) run(pnl); // recovers and makes new highs
    assert.equal(n, 1, "new highs send nothing");
    assert.equal(getTrackedPosition(P).hold_giveback_alert_pp, 0, "latch reset on the recovery");
    assert.equal(getTrackedPosition(P).hold_peak_pnl_pct, 22, "lower of the last confirmed pair (23 is still pending)");
    run(14); assert.equal(n, 1);                        // 8 pp
    run(11.5); assert.equal(n, 2);                      // 10.5 pp from 22
    run(12.4); run(11.2); assert.equal(n, 2);
  } finally { closeTrackedPosition?.(P); }
});

test("a position already on HOLD without the field seeds from its confirmed peak on the first reading", () => {
  const pos = { hold_mode: true, peak_pnl_pct: 1.23, hold_giveback_alert_pp: 10 };
  assert.equal(holdGiveBackReferencePct(pos), 1.23, "falls back until seeded");
  const r = advanceHoldPeak(pos, -12, 1000);
  assert.equal(r.seeded, true);
  assert.equal(pos.hold_peak_pnl_pct, 1.23);
  assert.equal(pos.hold_giveback_alert_pp, 10, "existing latch kept: no repeat alert at deploy");
  assert.equal(evaluateHoldGiveBack(pos, -12, cfg).alert, false);
  // seeded above the current reading: a first reading above the old peak starts a streak instead
  const up = { hold_mode: true, peak_pnl_pct: 1.23 };
  advanceHoldPeak(up, 40, 1000);
  assert.equal(up.hold_peak_pnl_pct, 1.23);
  advanceHoldPeak(up, 38, 200_000);
  assert.equal(up.hold_peak_pnl_pct, 38);
  // not held / untrusted input: nothing happens
  assert.equal(advanceHoldPeak({ hold_mode: false, peak_pnl_pct: 1 }, 50, 1).changed, false);
  assert.equal(advanceHoldPeak({ hold_mode: true, peak_pnl_pct: 1 }, null, 1).changed, false);
});

test("release clears the held high; hold-resume re-base and trailing are unchanged", () => {
  const P = `HOLDPEAK_REL_${Date.now()}`;
  track(P, "REL-SOL");
  try {
    confirmPeak(P, 2.85, 1);
    assert.equal(updatePnlAndCheckExits(P, data(2.85), mgmt), null);
    assert.equal(getTrackedPosition(P).trailing_active, true);
    setPositionHold(P, true);
    let t = 20_000_000;
    for (const pnl of [10, 20, 20.5, 20.2]) { t += 180_000; cycle(P, pnl, t); }
    t += 180_000; assert.equal(cycle(P, 8, t).alert, true);
    const held = getTrackedPosition(P);
    assert.equal(held.hold_peak_pnl_pct, 20.2);
    assert.equal(held.peak_pnl_pct, 2.85, "exit peak frozen on hold, as before");
    assert.equal(updatePnlAndCheckExits(P, data(8), mgmt), null, "held: nothing fires");
    setPositionHold(P, true, "new reason"); // re-holding a held position keeps its reference and latch
    assert.equal(getTrackedPosition(P).hold_peak_pnl_pct, 20.2);
    assert.equal(getTrackedPosition(P).hold_giveback_alert_pp, 10);

    setPositionHold(P, false);
    const rel = getTrackedPosition(P);
    assert.equal(rel.hold_peak_pnl_pct, null);
    assert.equal(rel.hold_peak_pending, null);
    assert.equal(rel.hold_giveback_alert_pp, 0);
    assert.equal(rel.trailing_active, false);
    assert.equal(rel.hold_resume_rebase, true);
    assert.equal(noteHoldPeakReading(P, 50, t + 1).changed, false, "not held: no reference kept");
    assert.equal(evaluateHoldGiveBack(rel, -30, cfg).alert, false);

    assert.equal(updatePnlAndCheckExits(P, data(8), mgmt), null, "no trailing TP against the held high or the pre-hold peak");
    const rebased = getTrackedPosition(P);
    assert.equal(rebased.peak_pnl_pct, 8);
    assert.equal(rebased.hold_resume_rebase, false);

    setPositionHold(P, true); // a new hold starts from the re-based peak
    assert.equal(getTrackedPosition(P).hold_peak_pnl_pct, 8);
  } finally { closeTrackedPosition?.(P); }
});

test("wiring: both hold branches feed the held high; briefing and report read it", () => {
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.equal((idx.match(/p\.pnl_management_ready !== false && p\.pnl_pct_suspicious !== true\)[\s\S]{0,40}noteHoldPeakReading\(p\.position, p\.pnl_pct\)/g) || []).length, 2);
  const brief = fs.readFileSync(new URL("../briefing.js", import.meta.url), "utf8");
  assert.equal((brief.match(/holdGiveBackReferencePct\(p\)/g) || []).length, 2);
  assert.match(fs.readFileSync(new URL("../report.js", import.meta.url), "utf8"), /hold_peak_pnl_pct: p\.hold_peak_pnl_pct \?\? null/);
  assert.match(fs.readFileSync(new URL("../tools/pnl.js", import.meta.url), "utf8"), /hold_peak_pnl_pct: tracked\?\.hold_mode === true/);
});
