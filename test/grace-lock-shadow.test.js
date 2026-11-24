process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Grace profit lock — LOG ONLY (grace-lock-shadow.js, 2026-11-24). The registered rule
// (docs/experiments/grace-profit-lock.md): inside a profit grace, an own confirmed in-grace peak
// (two distinct readings above it, the lower one), armed at ≥ 10 %, fires on the second
// consecutive distinct reading ≤ peak − 5 pp. Pure-module tests, two cases of the replay's
// fires through the live module, and the on/off equivalence through the real state functions.

const L = await import("../grace-lock-shadow.js");
const S = await import("../state.js");
const { config } = await import("../config.js");
const { confirmPeakStep } = await import("../grace-shadow.js");
await S.ensureStateInitialized();

const T = (hms) => Date.parse(`2026-11-24T${hms}Z`);
const MGMT = { adoptedProfitGraceMinutes: 60, harvestStraddleGraceMinutes: 60, graceLockShadowMode: "shadow", graceLockShadowArmPct: 10, graceLockShadowDropPct: 5 };
const straddled = (startHms = "10:00:00", over = {}) => ({
  position: "P", pool_name: "X-SOL", straddle_count: 1,
  straddled_at: new Date(T(startHms)).toISOString(),
  profit_grace_until: new Date(T(startHms) + 60 * 60_000).toISOString(),
  ...over,
});
// [hms, pnl, bin]
const feed = (p, seq, mgmt = MGMT) => seq.map(([hms, pnl, bin]) => L.advanceGraceLockShadow(p, { pnlPct: pnl, activeBin: bin, nowMs: T(hms), mgmt }));
const RUN = [
  ["10:00:30", 1.0, 50], ["10:02:00", 6.0, 51], ["10:02:15", 10.5, 52], // peak 1 → 6 (lower of 6 / 10.5)
  ["10:03:00", 12.0, 53], ["10:03:15", 12.6, 54], // → 12.0, armed
  ["10:04:00", 13.0, 55], ["10:04:15", 12.9, 55], // → 12.9
];

test("config: defaults, the mode parse (no enforce) and the four config lists", () => {
  assert.equal(config.management.graceLockShadowMode, "shadow");
  assert.equal(config.management.graceLockShadowArmPct, 10);
  assert.equal(config.management.graceLockShadowDropPct, 5);
  assert.deepEqual(L.graceLockShadowConfig({}), { mode: "shadow", armPct: 10, dropPct: 5 });
  assert.equal(L.graceLockShadowConfig({ graceLockShadowMode: "off" }).mode, "off");
  assert.equal(L.graceLockShadowConfig({ graceLockShadowMode: "enforce" }).mode, "shadow", "there is no enforce");
  assert.equal(L.graceLockShadowConfig({ graceLockShadowMode: "bogus" }).mode, "shadow");
  assert.deepEqual(L.graceLockShadowConfig({ graceLockShadowArmPct: 0, graceLockShadowDropPct: -2 }), { mode: "shadow", armPct: 10, dropPct: 5 }, "must be > 0");
  assert.deepEqual(L.graceLockShadowConfig({ graceLockShadowArmPct: "8", graceLockShadowDropPct: 3 }), { mode: "shadow", armPct: 8, dropPct: 3 });
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  for (const k of ["graceLockShadowMode", "graceLockShadowArmPct", "graceLockShadowDropPct"]) {
    assert.match(exe, new RegExp(`${k}: \\["management", "${k}"\\]`));
    const cfgSrc = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
    assert.match(cfgSrc, new RegExp(`fresh\\.${k}`));
    assert.match(fs.readFileSync(new URL("../tools/definitions.js", import.meta.url), "utf8"), new RegExp(k));
  }
  assert.match(exe, /"graceLockShadowMode" && !\["off", "shadow"\]\.includes\(val\)/);
});

test("confirmPeakStep is state.confirmPeak's rule (streak minimum)", () => {
  let c = confirmPeakStep({ peak: 1 }, 6, 2);
  assert.deepEqual(c, { peak: 1, pending: 6, count: 1, raised: false });
  c = confirmPeakStep(c, 10.5, 2);
  assert.deepEqual(c, { peak: 6, pending: null, count: 0, raised: true });
  assert.deepEqual(confirmPeakStep({ peak: 6, pending: 7, count: 1 }, 6, 2), { peak: 6, pending: null, count: 0, raised: false }, "≤ peak drops the pending one");
  assert.equal(confirmPeakStep({ peak: 0 }, 3, 1).peak, 3, "one reading with ticks 1");
});

test("arms at a confirmed peak ≥ 10 % and fires on the second distinct reading ≤ peak − 5", () => {
  const p = straddled();
  const r = feed(p, RUN);
  assert.equal(r[0].event, "started");
  let s = p.grace_lock_shadow;
  assert.equal(s.kind, "straddle");
  assert.equal(s.started_at, new Date(T("10:00:00")).toISOString());
  assert.equal(s.peak_pct, 12.9);
  assert.equal(s.armed_at, new Date(T("10:03:15")).toISOString(), "armed when 12.0 was confirmed");
  assert.equal(s.fired_at, null);
  const after = feed(p, [["10:05:00", 9.0, 50], ["10:06:00", 7.8, 47], ["10:06:15", 7.5, 46], ["10:07:00", 2.0, 40]]);
  assert.deepEqual(after.map((x) => x.event), [null, null, "fired", null]);
  s = p.grace_lock_shadow;
  assert.equal(s.fire_pnl_pct, 7.5, "the would-close pnl is the SECOND breach");
  assert.equal(s.fire_peak_pct, 12.9);
  assert.equal(s.fire_threshold_pct, 7.9);
  assert.equal(s.sim_first_breach_pct, 7.8);
  assert.equal(s.fired_at, new Date(T("10:06:15")).toISOString());
  assert.equal(s.minutes_into_grace, 6.3);
  assert.equal(s.last_pct, 7.5, "nothing is simulated after the fire");
  assert.equal(after[3].changed, false);
  assert.equal(
    L.graceLockShadowLine(s, "X-SOL"),
    "[GRACE_LOCK_SHADOW] would-close X-SOL: confirmed in-grace peak 12.90% ≥ 10% arm, pnl 7.50% ≤ 7.90% (peak − 5 pp) at 6 min into the straddle grace (graceLockShadowMode=shadow)",
  );
});

test("no arm under A: a raw high above 10 % that is never confirmed does not arm", () => {
  const p = straddled();
  feed(p, [["10:00:30", 2.0, 50], ["10:01:00", 9.5, 51], ["10:01:15", 14.0, 52], ["10:01:30", 3.0, 49], ["10:01:45", 2.0, 48], ["10:02:00", 1.5, 47]]);
  const s = p.grace_lock_shadow;
  assert.equal(s.peak_pct, 9.5, "9.5 / 14.0 confirm the lower, 9.5");
  assert.equal(s.armed_at, null);
  assert.equal(s.fired_at, null);
  assert.equal(s.sim_breach_count, 0);
});

test("a single dip does not fire; a repeat (same pnl and bin) neither confirms nor resets", () => {
  const p = straddled();
  feed(p, RUN);
  feed(p, [["10:05:00", 7.6, 46], ["10:05:15", 8.5, 48], ["10:05:30", 7.7, 46]]);
  let s = p.grace_lock_shadow;
  assert.equal(s.fired_at, null, "7.6 then a reading above the threshold resets the streak");
  assert.equal(s.sim_breach_count, 1);
  const rep = L.advanceGraceLockShadow(p, { pnlPct: 7.7, activeBin: 46, nowMs: T("10:05:45"), mgmt: MGMT });
  assert.equal(rep.changed, false, "the poller's unchanged valuation is not a second distinct reading");
  assert.equal(p.grace_lock_shadow.sim_breach_count, 1);
  const same = L.advanceGraceLockShadow(p, { pnlPct: 7.7, activeBin: 45, nowMs: T("10:06:00"), mgmt: MGMT });
  assert.equal(same.event, "fired", "same pnl, a different bin is distinct (the replay's key)");
  s = p.grace_lock_shadow;
  assert.equal(s.fire_pnl_pct, 7.7);
});

test("the first fire is kept: a later grace (new straddle) does not restart it", () => {
  const p = straddled();
  feed(p, [...RUN, ["10:06:00", 7.8, 47], ["10:06:15", 7.5, 46]]);
  const fired = { ...p.grace_lock_shadow };
  assert.ok(fired.fired_at);
  L.finishGraceLockShadow(p, { endedBy: "timer", endPct: 3.0, nowMs: T("11:00:10") });
  assert.equal(p.grace_lock_shadow.ended_by, "timer", "the grace end is stamped on a fired record too");
  assert.equal(p.grace_lock_shadow.end_pct, 3.0);
  Object.assign(p, straddled("12:00:00"), { straddle_count: 2 });
  const r = feed(p, [["12:00:30", 1.0, 30], ["12:01:00", 2.0, 31]]);
  assert.equal(r[0].changed, false);
  assert.equal(p.grace_lock_shadow.fired_at, fired.fired_at);
  assert.equal(p.grace_lock_shadow.started_at, fired.started_at);
});

test("a grace that ended without a fire is replaced by a fresh simulation of the next grace", () => {
  const p = straddled();
  feed(p, [["10:00:30", 1.0, 50], ["10:10:00", 4.0, 52], ["10:10:15", 5.0, 53]]);
  assert.equal(L.finishGraceLockShadow(p, { endedBy: "timer", nowMs: T("11:00:05") }), true);
  assert.equal(p.grace_lock_shadow.end_pct, 5.0, "no trusted end reading: the last one fed in");
  assert.equal(feed(p, [["11:00:30", 9, 60]])[0].changed, false, "no grace, no reading");
  Object.assign(p, straddled("12:00:00"), { straddle_count: 2 });
  const r = feed(p, [["12:00:30", 0.5, 30]]);
  assert.equal(r[0].event, "restarted");
  const s = p.grace_lock_shadow;
  assert.equal(s.started_at, new Date(T("12:00:00")).toISOString());
  assert.equal(s.peak_pct, 0.5, "peak reset at the new grace's first reading");
  assert.equal(s.ended_by, null);
  assert.equal(s.readings, 1);
});

test("HOLD while a simulation is open and unfired: interrupted, stopped, and the release does not resume it", () => {
  const p = straddled();
  feed(p, RUN);
  assert.equal(L.interruptGraceLockShadow(p, { nowMs: T("10:05:00"), mgmt: MGMT }), true);
  assert.equal(p.grace_lock_shadow.interrupted, "hold");
  p.hold_mode = true;
  assert.equal(feed(p, [["10:06:00", 7.0, 40]])[0].changed, false);
  p.hold_mode = false;
  feed(p, [["10:07:00", 7.0, 40], ["10:07:15", 6.5, 39]]);
  assert.equal(p.grace_lock_shadow.fired_at, null, "no fire after the release in the same grace");
  assert.equal(L.finishGraceLockShadow(p, { endedBy: "timer", nowMs: T("11:00:05") }), false, "an interrupted record keeps ended_by null");
  assert.equal(L.graceLockShadowRecordField(p).interrupted, "hold");
  assert.equal(L.graceLockShadowRecordField(p).ended_by, null);
  // A hold inside a grace with no record yet leaves a stub, so the remainder is not simulated
  // from a mid-grace "start"; a fired record is not touched by a hold.
  const q = straddled();
  assert.equal(L.interruptGraceLockShadow(q, { nowMs: T("10:10:00"), mgmt: MGMT }), true);
  assert.equal(q.grace_lock_shadow.interrupted, "hold");
  assert.equal(q.grace_lock_shadow.readings, 0);
  const f = straddled();
  feed(f, [...RUN, ["10:06:00", 7.8, 47], ["10:06:15", 7.5, 46]]);
  assert.equal(L.interruptGraceLockShadow(f, { nowMs: T("10:07:00"), mgmt: MGMT }), false);
  assert.equal(f.grace_lock_shadow.interrupted, null);
  // Outside any grace a hold changes nothing.
  const g = straddled();
  assert.equal(L.interruptGraceLockShadow(g, { nowMs: T("11:30:00"), mgmt: MGMT }), false);
  assert.equal(g.grace_lock_shadow, undefined);
});

test("mode off writes nothing; closed positions are skipped; an open grace at the close ends 'close'", () => {
  const p = straddled();
  feed(p, RUN, { ...MGMT, graceLockShadowMode: "off" });
  assert.equal(p.grace_lock_shadow, undefined);
  assert.equal(L.graceLockShadowRecordField(p), null);
  feed(p, RUN);
  const rec = L.graceLockShadowRecordField(p, T("10:20:00"));
  assert.equal(rec.ended_by, "close");
  assert.equal(rec.end_pct, 12.9);
  assert.equal(p.grace_lock_shadow.ended_by, null, "the record field does not write the position");
  const c = straddled("10:00:00", { closed: true });
  assert.equal(feed(c, RUN)[0].changed, false);
});

test("adoption grace (operator position): kind adoption, operator records are captured", () => {
  const p = { position: "A", adopted: true, adopted_at: new Date(T("09:00:00")).toISOString() };
  feed(p, [["09:00:20", 0.5, 10], ["09:10:00", 11.0, 12], ["09:10:20", 11.5, 13]]);
  assert.equal(p.grace_lock_shadow.kind, "adoption");
  assert.equal(p.grace_lock_shadow.peak_pct, 11.0);
  assert.ok(p.grace_lock_shadow.armed_at);
});

test("replay fires reproduced by the live module (CRAWL-SOL G1cNfPFe, SATPAD-SOL 3EH4RCLT)", () => {
  const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/grace-lock-replay-cases.json", import.meta.url), "utf8"));
  assert.equal(FIX.cases.length, 2);
  for (const c of FIX.cases) {
    const start = Date.parse(c.grace_start);
    const p = c.kind === "straddle"
      ? { position: c.position, straddle_count: 1, straddled_at: c.grace_start, profit_grace_until: new Date(start + 60 * 60_000).toISOString() }
      : { position: c.position, adopted: true, adopted_at: c.grace_start };
    let fired = null;
    for (const [t, bin, pnl] of c.readings) {
      const r = L.advanceGraceLockShadow(p, { pnlPct: pnl, activeBin: bin, nowMs: t, mgmt: MGMT });
      if (r.event === "fired") fired = t;
    }
    const s = p.grace_lock_shadow;
    assert.equal(s.fire_peak_pct, c.expected.peak, `${c.pool_name} peak`);
    assert.equal(s.fire_pnl_pct, c.expected.exit_pnl, `${c.pool_name} exit`);
    assert.equal(s.fire_threshold_pct, c.expected.threshold, `${c.pool_name} threshold`);
    assert.equal(new Date(fired).toISOString(), c.expected.fire_at, `${c.pool_name} fire time`);
  }
  const crawl = FIX.cases.find((c) => c.pool_name === "CRAWL-SOL");
  assert.deepEqual([crawl.expected.peak, crawl.expected.exit_pnl], [12.41, 7.35], "the registry log's 12.41 → 7.35");
});

// ── through the real state functions: the shadow changes no live field and no exit ────────────

const realNow = Date.now;
let clock = realNow();
const W = (wib) => Date.parse(`2026-11-24T${wib}+07:00`);
const mgmt = {
  trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5,
  stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 60, harvestStraddleGraceMinutes: 60,
  trailStraddleShadowTrigger: 3, graceShadowEnabled: true, graceLockShadowMode: "shadow", graceLockShadowArmPct: 10, graceLockShadowDropPct: 5,
};
const row = (pnl, bin) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: bin, lower_bin: 0, upper_bin: 100, pnl_basis: "sol", pnl_management_ready: true, pnl_quality: "valid" });
let seq = 0;
const made = [];
const mk = (tag) => {
  const a = `TEST_GRACE_LOCK_${tag}_${realNow()}_${seq++}`;
  S.trackPosition({ position: a, pool: "POOL_GL", pool_name: "GL-SOL", amount_sol: 1, initial_value_usd: 1, strategy: "spot", bin_range: [0, 100], active_bin: 50 });
  made.push(a);
  return a;
};
const pos = (a) => S.getTrackedPosition(a);
const read = (a, wib, pnl, bin, cfg) => {
  clock = W(wib);
  S.confirmPeak(a, pnl, 2);
  S.noteGraceShadowReading(a, pnl, { confirmTicks: 2 }, cfg);
  S.noteGraceLockShadowReading(a, pnl, { activeBin: bin }, cfg);
  return S.updatePnlAndCheckExits(a, row(pnl, bin), cfg);
};
const straddleAt = (a, wib) => {
  const p = pos(a);
  p.straddle_count = 1;
  p.straddled_at = new Date(W(wib)).toISOString();
  p.profit_grace_until = new Date(W(wib) + 60 * 60_000).toISOString();
  p.lane = "straddle";
};
const LIVE_SEQ = [
  ["15:00:30", 1.2, 50], ["15:03:00", 6.0, 52], ["15:03:15", 10.5, 54], ["15:04:00", 12.0, 55], ["15:04:15", 12.6, 56],
  ["15:05:00", 13.0, 57], ["15:05:15", 12.9, 57], ["15:08:00", 9.0, 53], ["15:09:00", 7.8, 51], ["15:09:15", 7.5, 50],
  ["15:20:00", 4.0, 47], ["15:40:00", 5.5, 49], ["16:00:30", 6.0, 50], ["16:02:00", 6.4, 51], ["16:02:30", 6.3, 51],
  ["16:05:00", 4.4, 48], ["16:05:30", 4.3, 47],
];
// Every field but the address and the shadow's own record. Wall-clock stamps written with
// `new Date()` (not the mocked Date.now — deployed_at, pending_peak_started_at, …) differ by
// the milliseconds between the two positions' calls and are masked.
const T0 = realNow();
const strip = (p) => {
  const o = { ...p };
  for (const k of ["position", "grace_lock_shadow"]) delete o[k];
  return JSON.stringify(o, (k, v) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Math.abs(Date.parse(v) - T0) < 600_000 ? "<wall clock>" : v));
};

test("the shadow changes no live field and no exit (same sequence with graceLockShadowMode off)", () => {
  Date.now = () => clock;
  const on = mk("ON"), off = mk("OFF");
  const cfgOff = { ...mgmt, graceLockShadowMode: "off" };
  try {
    clock = W("15:00:00");
    straddleAt(on, "15:00:00"); straddleAt(off, "15:00:00");
    let exitOn = null;
    for (const [t, v, b] of LIVE_SEQ) {
      const a = read(on, t, v, b, mgmt), c = read(off, t, v, b, cfgOff);
      assert.deepEqual(a, c, `exit at ${t}`);
      assert.equal(strip(pos(on)), strip(pos(off)), `every other field at ${t}`);
      exitOn = exitOn || a;
    }
    assert.equal(exitOn?.action, "TRAILING_TP", "live trailing closes after the grace (peak re-based at the grace end)");
    assert.equal(pos(off).grace_lock_shadow, undefined);
    const s = pos(on).grace_lock_shadow;
    assert.equal(s.fire_pnl_pct, 7.5);
    assert.equal(s.fire_peak_pct, 12.9);
    assert.equal(s.ended_by, "timer", "[GRACE_END] stamps the timer end");
    assert.equal(s.end_pct, 6.0);
    // Hold inside a grace through setPositionHold → interrupted; the hold itself is unchanged.
    const h = mk("HOLD"), h2 = mk("HOLD2");
    clock = W("17:00:00");
    straddleAt(h, "17:00:00"); straddleAt(h2, "17:00:00");
    read(h, "17:00:30", 1.0, 50, mgmt); read(h2, "17:00:30", 1.0, 50, cfgOff);
    clock = W("17:01:00");
    S.setPositionHold(h, true, "test"); S.setPositionHold(h2, true, "test");
    assert.equal(pos(h).grace_lock_shadow.interrupted, "hold");
    assert.equal(strip(pos(h)), strip(pos(h2)));
    // Release by the operator stamps "release" on the record of that grace.
    const r = mk("REL");
    clock = W("18:00:00");
    straddleAt(r, "18:00:00");
    read(r, "18:00:30", 2.0, 50, mgmt);
    clock = W("18:10:00");
    S.releasePositionProfitGrace(r, mgmt);
    assert.equal(pos(r).grace_lock_shadow.ended_by, "release");
  } finally { Date.now = realNow; }
});

test("wiring: index.js feeds from feedGraceShadow, perf-record.js copies the field once", () => {
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /function feedGraceShadow\(p, confirmTicks\) \{[\s\S]*?noteGraceLockShadowReading\(p\.position, p\.pnl_pct, \{ activeBin: p\.active_bin \}, config\.management\);/);
  const pr = fs.readFileSync(new URL("../perf-record.js", import.meta.url), "utf8");
  assert.equal((pr.match(/grace_lock_shadow: graceLockShadowRecordField\(tracked\)/g) || []).length, 1);
});

test.after(() => {
  Date.now = realNow;
  for (const a of made) { try { S.closeTrackedPosition(a, "test"); } catch {} }
});
