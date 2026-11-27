/**
 * Relative TVL exit — SHADOW ONLY (tvl-relative-exit.js, 2026-11-27; experiment tvl-relative-exit).
 * Pure rule, state on the position, perf-record fields, and the guarantee that the LIVE TVL exit
 * (tvl-floor-exit.js / checkTvlFloorExit) behaves byte-identically with the shadow off and on.
 */
process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const R = await import("../tvl-relative-exit.js");
const {
  tvlRelativeExitConfig, usableTvlReading, ownValueForTvl, advanceTvlRelativeExit, crossCheckTvlRelative,
  applyTvlRelativeCrossCheck, noteOldReady, noteNewWouldFire, tvlRelativeRecordFields, tvlRelativeWouldCloseLine,
} = R;
const { modeFor } = await import("../rule-mode.js");
const S = await import("../state.js");
await S.ensureStateInitialized();
const PR = await import("../perf-record.js");

const MIN = 60_000;
const T0 = Date.parse("2026-11-27T03:00:00Z");
const cfg = tvlRelativeExitConfig({});
const rd = (v) => ({ ok: true, tvl_usd: v });
const failed = { ok: false, reason: "fetch failed: 502" };
const NO_OWN = { usd: 0, subtracted: false };

/** Feed readings [minutesFromT0, reading] through the pure rule; returns every step. */
function run(readings, { entry = null, own = NO_OWN, c = cfg, prev = null } = {}) {
  let st = prev;
  const steps = [];
  for (const [m, reading] of readings) {
    const r = advanceTvlRelativeExit(st, { reading, entryTvlUsd: entry, own, cfg: c, nowMs: T0 + m * MIN });
    st = r.state;
    steps.push(r);
  }
  return steps;
}

test("config: defaults, ranges, mode off | shadow, enforce reads as shadow", () => {
  assert.deepEqual(cfg, { mode: "shadow", enforceRequested: false, floorUsd: 10000, pct: 50, minReadings: 3, minMinutes: 30 });
  assert.equal(tvlRelativeExitConfig({ tvlRelativeExitMode: "off" }).mode, "off");
  const enf = tvlRelativeExitConfig({ tvlRelativeExitMode: "enforce" });
  assert.deepEqual([enf.mode, enf.enforceRequested], ["shadow", true]);
  assert.equal(tvlRelativeExitConfig({ tvlRelativeExitMode: "bogus" }).mode, "shadow");
  assert.equal(modeFor("tvlRelativeExitMode", undefined), "shadow");
  assert.equal(tvlRelativeExitConfig({ tvlFloorExitUsd: 8000 }).floorUsd, 8000); // the live rule's floor key
  assert.equal(tvlRelativeExitConfig({ tvlRelativeExitPct: 5 }).pct, 10);
  assert.equal(tvlRelativeExitConfig({ tvlRelativeExitPct: 95 }).pct, 90);
  assert.equal(tvlRelativeExitConfig({ tvlRelativeExitPct: "x" }).pct, 50);
  assert.equal(tvlRelativeExitConfig({ tvlRelativeExitMinReadings: 1 }).minReadings, 3);
  assert.equal(tvlRelativeExitConfig({ tvlRelativeExitMinReadings: 4 }).minReadings, 4);
  assert.equal(tvlRelativeExitConfig({ tvlRelativeExitMinMinutes: 2 }).minMinutes, 5);
  assert.equal(tvlRelativeExitConfig({ tvlRelativeExitMinMinutes: 40 }).minMinutes, 40);
});

test("config.js loads the keys; update_config accepts off | shadow and the ranges only", async () => {
  const { config } = await import("../config.js");
  assert.equal(config.management.tvlRelativeExitMode, "shadow");
  assert.equal(config.management.tvlRelativeExitPct, 50);
  assert.equal(config.management.tvlRelativeExitMinReadings, 3);
  assert.equal(config.management.tvlRelativeExitMinMinutes, 30);
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exe, /tvlRelativeExitMode: \["management", "tvlRelativeExitMode"\]/);
  assert.match(exe, /match\[0\] === "tvlRelativeExitMode" && !\["off", "shadow"\]\.includes\(val\)/);
});

test("usable reading = the live rule's: ok, finite, >= 0", () => {
  assert.equal(usableTvlReading(rd(0)), 0);
  assert.equal(usableTvlReading(rd(8412.5)), 8412.5);
  for (const bad of [null, undefined, failed, { ok: true }, { ok: true, tvl_usd: NaN }, { ok: true, tvl_usd: -1 }, { ok: true, tvl_usd: "9000" }, { ok: false, tvl_usd: 9000 }]) {
    assert.equal(usableTvlReading(bad), null, JSON.stringify(bad));
  }
});

test("own value: total_value_true_usd when finite >= 0 and the valuation is not flagged", () => {
  assert.deepEqual(ownValueForTvl({ total_value_true_usd: 1500 }), { usd: 1500, subtracted: true });
  assert.deepEqual(ownValueForTvl({ total_value_true_usd: 1500, pnl_quality: "valid" }), { usd: 1500, subtracted: true });
  for (const row of [{}, { total_value_true_usd: null }, { total_value_true_usd: NaN }, { total_value_true_usd: -3 }, { total_value_true_usd: "1500" },
    { total_value_true_usd: 1500, pnl_quality: "missing_price" }, { total_value_usd: 1500 }]) {
    assert.deepEqual(ownValueForTvl(row), { usd: 0, subtracted: false }, JSON.stringify(row));
  }
});

test("reference = max(entry, peak since first evaluated); source entry | peak", () => {
  let [a] = run([[0, rd(30000)]], { entry: 42900 });
  assert.deepEqual([a.state.ref_usd, a.state.ref_source, a.state.peak_usd], [42900, "entry", 30000]);
  [a] = run([[0, rd(50000)]], { entry: 42900 });
  assert.deepEqual([a.state.ref_usd, a.state.ref_source], [50000, "peak"]);
  const s = run([[0, rd(30000)], [3, rd(60000)], [6, rd(20000)]], { entry: null });
  assert.deepEqual([s[2].state.ref_usd, s[2].state.ref_source, s[2].state.peak_usd], [60000, "peak", 60000]);
  // entry 0 / missing / NaN is not a reference
  for (const e of [0, null, NaN, -5]) assert.equal(run([[0, rd(9000)]], { entry: e })[0].state.ref_source, "peak");
  // an unusable reading changes nothing (same object)
  const first = run([[0, rd(30000)]], { entry: 42900 })[0].state;
  const ig = advanceTvlRelativeExit(first, { reading: failed, entryTvlUsd: 42900, cfg, nowMs: T0 + 3 * MIN });
  assert.equal(ig.event, "ignored");
  assert.equal(ig.state, first);
});

test("qualifies only when BOTH bars hold", () => {
  const ev = (entry, tvl) => run([[0, rd(tvl)]], { entry })[0].event;
  assert.equal(ev(60000, 9000), "started");   // < $10K and 15 % of $60K
  assert.equal(ev(60000, 11000), "tracked");  // 18 % of the reference but above $10K
  assert.equal(ev(9000, 8000), "tracked");    // under $10K but 89 % of the reference
  assert.equal(ev(16000, 8000), "started");   // exactly 50 % → qualifies (at or under)
  assert.equal(ev(15999, 8000), "tracked");   // 50.003 %
});

test("own-value subtraction on / off", () => {
  // entry $20K, own $2K: reading $10.5K → adjusted $8.5K of $18K (47 %) — qualifies; raw $10.5K would not
  const on = run([[0, rd(10500)]], { entry: 20000, own: { usd: 2000, subtracted: true } })[0];
  assert.equal(on.event, "started");
  assert.equal(on.tvl_adj_usd, 8500);
  assert.equal(on.ref_adj_usd, 18000);
  assert.equal(on.state.own_value_subtracted, true);
  assert.equal(on.state.own_value_usd, 2000);
  const off = run([[0, rd(10500)]], { entry: 20000 })[0];
  assert.equal(off.event, "tracked");
  assert.deepEqual([off.state.own_value_subtracted, off.state.own_value_usd], [false, null]);
  // adjusted figures never go negative
  assert.equal(run([[0, rd(1000)]], { entry: 20000, own: { usd: 5000, subtracted: true } })[0].tvl_adj_usd, 0);
});

test("entered at $9K, stays at $8K: never qualifies (>= 50 % of its reference)", () => {
  const s = run(Array.from({ length: 30 }, (_, i) => [i * 3, rd(8000)]), { entry: 9000 });
  assert.ok(s.every((x) => x.event === "tracked" && !x.ready));
  assert.equal(s.at(-1).state.streak, null);
});

test("entered at $60K, falls to $9K: ready after 3 readings spanning >= 30 min, not before", () => {
  const s = run([[0, rd(9000)], [10, rd(8800)], [20, rd(8600)], [29, rd(8500)], [31, rd(8400)]], { entry: 60000 });
  assert.deepEqual(s.map((x) => x.event), ["started", "counted", "counted", "counted", "counted"]);
  assert.deepEqual(s.map((x) => x.ready), [false, false, false, false, true]);
  assert.equal(s[4].state.streak.count, 5);
  assert.equal(s[4].state.streak.min_tvl_usd, 8400);
  // 3 readings over 30 min exactly
  const t = run([[0, rd(9000)], [15, rd(8800)], [30, rd(8600)]], { entry: 60000 });
  assert.deepEqual(t.map((x) => x.ready), [false, false, true]);
  // two readings < 60 s apart are one reading
  const m = run([[0, rd(9000)], [0.5, rd(8900)]], { entry: 60000 });
  assert.equal(m[1].event, "merged");
  assert.equal(m[1].state.streak.count, 1);
});

test("reset on recovery above either bar; unusable readings neither count nor reset; gap > 45 min restarts", () => {
  // above the $10K bar
  let s = run([[0, rd(9000)], [10, rd(8800)], [20, rd(10500)]], { entry: 60000 });
  assert.equal(s[2].event, "reset");
  assert.equal(s[2].state.streak, null);
  // back above 50 % of the reference (peak raised to $20K, reading $9.5K is 47.5 %; then $9.9K of $20K... use a $15K entry)
  s = run([[0, rd(7000)], [10, rd(7200)], [20, rd(7600)]], { entry: 15000 }); // 46.7 %, 48 %, 50.7 %
  assert.deepEqual(s.map((x) => x.event), ["started", "counted", "reset"]);
  // unusable readings in between
  s = run([[0, rd(9000)], [10, failed], [15, { ok: true, tvl_usd: NaN }], [20, rd(8800)], [31, rd(8700)]], { entry: 60000 });
  assert.deepEqual(s.map((x) => x.event), ["started", "ignored", "ignored", "counted", "counted"]);
  assert.equal(s[4].ready, true);
  // a 46-minute gap between usable readings starts over
  s = run([[0, rd(9000)], [10, rd(8800)], [56, rd(8700)]], { entry: 60000 });
  assert.equal(s[2].event, "restarted");
  assert.equal(s[2].state.streak.count, 1);
  // a 45-minute gap does not
  s = run([[0, rd(9000)], [45, rd(8800)]], { entry: 60000 });
  assert.equal(s[1].event, "counted");
});

test("on-chain check: unavailable / disagree / confirmed with the same subtraction and bars", () => {
  const own = { usd: 1000, subtracted: true };
  assert.equal(crossCheckTvlRelative(null, { refUsd: 60000, own, cfg }).verdict, "unavailable");
  assert.equal(crossCheckTvlRelative({ ok: false, reason: "rpc" }, { refUsd: 60000, own, cfg }).reason, "rpc");
  assert.equal(crossCheckTvlRelative({ ok: true, tvl_usd: -1 }, { refUsd: 60000, own, cfg }).verdict, "unavailable");
  assert.equal(crossCheckTvlRelative({ ok: true, tvl_usd: 10800 }, { refUsd: 60000, own, cfg }).verdict, "confirmed"); // $9.8K after own
  assert.equal(crossCheckTvlRelative({ ok: true, tvl_usd: 11200 }, { refUsd: 60000, own, cfg }).verdict, "disagree");
  assert.equal(crossCheckTvlRelative({ ok: true, tvl_usd: 9000 }, { refUsd: 15000, own: NO_OWN, cfg }).verdict, "disagree"); // 60 % of the reference
  // applying: unavailable keeps the object, disagree resets, confirmed writes would_fire once
  const ready = run([[0, rd(9000)], [15, rd(8800)], [30, rd(8600)]], { entry: 60000 })[2];
  assert.equal(applyTvlRelativeCrossCheck(ready.state, { verdict: "unavailable" }), ready.state);
  assert.equal(applyTvlRelativeCrossCheck(ready.state, { verdict: "disagree" }).streak, null);
  const c = crossCheckTvlRelative({ ok: true, tvl_usd: 8650 }, { refUsd: ready.state.ref_usd, cfg });
  const fired = applyTvlRelativeCrossCheck(ready.state, c, { nowMs: T0 + 30 * MIN, pnlPct: -42.5, held: true, handsOff: true, refAdjUsd: ready.ref_adj_usd, pctOfRef: ready.pct_of_ref });
  assert.deepEqual(
    [fired.would_fire.tvl_usd, fired.would_fire.ref_usd, fired.would_fire.chain_tvl_usd, fired.would_fire.pnl_pct, fired.would_fire.held, fired.would_fire.hands_off, fired.would_fire.readings, fired.would_fire.span_min],
    [8600, 60000, 8650, -42.5, true, true, 3, 30],
  );
  assert.equal(Math.round(fired.would_fire.pct_of_ref * 100) / 100, 14.33);
  // never overwritten, and no further tracking once fired
  assert.equal(applyTvlRelativeCrossCheck(fired, c, { pnlPct: -80 }), fired);
  const after = advanceTvlRelativeExit(fired, { reading: rd(100), entryTvlUsd: 60000, cfg, nowMs: T0 + 60 * MIN });
  assert.equal(after.event, "done");
  assert.equal(after.state, fired);
  assert.match(tvlRelativeWouldCloseLine("FACTORY-SOL", fired.would_fire, cfg),
    /^\[TVL_RELATIVE_SHADOW\] would-close FACTORY-SOL: pool TVL \$8,600 under \$10,000 and 14\.3 % of its reference \$60,000 for 3 readings over 30m \(on-chain \$8,650\) — pnl -42\.50 %, nothing closed \(tvlRelativeExitMode=shadow\)/);
});

test("the six historical live fires (entry → fire TVL) never qualify; FACTORY-like 42.9K → 9.0K does", () => {
  const fires = { MCAT: [4700, 6100], "OpenIndex#1": [10000, 9700], "OpenIndex#2": [6300, 5500], "JIMMY#1": [12700, 9200], "JIMMY#2": [11700, 9300], PVE: [10400, 8200] };
  for (const [name, [entry, fire]] of Object.entries(fires)) {
    const s = run([[0, rd(fire)], [15, rd(fire)], [30, rd(fire)], [45, rd(fire)]], { entry });
    assert.ok(s.every((x) => !x.ready && x.state.streak == null), name);
  }
  const f = run([[0, rd(9000)], [15, rd(8900)], [30, rd(9000)]], { entry: 42900 });
  assert.deepEqual(f.map((x) => x.event), ["started", "counted", "counted"]);
  assert.equal(f[2].ready, true);
});

test("comparison object: first old-ready and first new would-fire, never overwritten", () => {
  let c = noteOldReady(null, { pnlPct: -59.96, nowMs: T0 });
  assert.deepEqual(c, { old_first_ready_at: new Date(T0).toISOString(), old_first_ready_pnl_pct: -59.96, old_closed: false, new_would_fire_at: null, new_would_fire_pnl_pct: null });
  assert.equal(noteOldReady(c, { pnlPct: -70, nowMs: T0 + MIN }), c);
  c = noteNewWouldFire(c, { at: "2026-11-27T04:00:00.000Z", pnlPct: -40 });
  assert.equal(c.new_would_fire_pnl_pct, -40);
  assert.equal(noteNewWouldFire(c, { at: "x", pnlPct: 1 }), c);
});

test("perf record carries both objects (null without them); old_closed from the close reason", () => {
  const tracked = (extra) => ({ pool_name: "X-SOL", pool: "P".repeat(44), amount_sol: 0.5, bin_range: { min: -10, max: 10 }, ...extra });
  const rec = (t, reason) => PR.closePositionPerfRecord({ tracked: t, position_address: "pos1", poolAddress: "P".repeat(44), poolMeta: { name: "X-SOL" }, closeBaseMint: "M", pnlSol: -0.1, pnlTrueUsd: -10, minutesHeld: 60, minutesOOR: 0, reason, close_gas_sol: 0 });
  const plain = rec(tracked({}), "t");
  assert.equal(plain.tvl_relative_exit, null);
  assert.equal(plain.tvl_floor_shadow_compare, null);
  const rel = { ...R.emptyTvlRelativeState(), ref_usd: 42900, would_fire: { at: "2026-11-27T04:00:00.000Z", pnl_pct: -40 } };
  const cmp = noteOldReady(null, { pnlPct: -60, nowMs: T0 });
  const byOld = rec(tracked({ tvl_relative_exit: rel, tvl_floor_shadow_compare: cmp }), "TVL exit: pool TVL $8,591 under the $10,000 minimum for 3 readings in 5m (on-chain reserves $9,300) — hard exit");
  assert.equal(byOld.tvl_relative_exit.would_fire.pnl_pct, -40);
  assert.notEqual(byOld.tvl_relative_exit, rel); // a copy
  assert.equal(byOld.tvl_floor_shadow_compare.old_closed, true);
  const byOther = rec(tracked({ tvl_relative_exit: rel, tvl_floor_shadow_compare: cmp }), "Stop loss: …");
  assert.equal(byOther.tvl_floor_shadow_compare.old_closed, false);
  // a TVL-exit close without an old-ready stamp (shadow was off then) does not invent one
  assert.equal(tvlRelativeRecordFields({ tvl_floor_shadow_compare: noteNewWouldFire(null, { at: "x", pnlPct: 1 }) }, "TVL exit: x").tvl_floor_shadow_compare.old_closed, false);
});

// ── Wiring through index.js: the live rule is byte-identical with the shadow off and on ──────
const I = await import("../index.js");
const { config } = await import("../config.js");
const { tvlFloorExitConfig } = await import("../tvl-floor-exit.js");

let seq = 0;
const mk = (tag, { hold = false, entry_tvl = 42900 } = {}) => {
  const addr = `TEST_TVL_REL_${tag}_${seq++}`;
  S.trackPosition({ position: addr, pool: "POOL_TR_" + tag, pool_name: tag + "-SOL", amount_sol: 1.48, strategy: "spot", entry_tvl });
  if (hold) S.setPositionHold(addr, true);
  return addr;
};
const pos = (a) => S.getTrackedPosition(a);

// TVL path of one position: 3-min management cycles. Values = Meteora `tvl`; null = a failed reading.
const PATH = [42000, 30000, 12000, 9969, 9050, null, 8591, 15000, 9800, 9500, 9300, 9100, 9000, 8800, 8700, 8600, 8500, 8400, 8300, 8200, 8100, 8000];
async function drive(mode, tag, { tvlFloorMode = "enforce", hold = false } = {}) {
  const prev = { rel: config.management.tvlRelativeExitMode, floor: config.management.tvlFloorExitMode };
  config.management.tvlRelativeExitMode = mode;
  config.management.tvlFloorExitMode = tvlFloorMode;
  const cfgFloor = tvlFloorExitConfig(config.management);
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const a = mk(tag, { hold });
  const chainTvl = async () => ({ ok: true, tvl_usd: 8000 });
  const trace = [];
  try {
    for (const v of PATH) {
      mock.timers.tick(3 * MIN);
      const row = { position: a, pool: pos(a).pool, pair: pos(a).pool_name, pnl_pct: -30, total_value_true_usd: 400,
        tvl_floor_reading: v == null ? { ok: false, reason: "fetch failed: 502" } : { ok: true, tvl_usd: v } };
      const exit = await I.checkTvlFloorExit(row, cfgFloor, hold, { chainTvl });   // the management cycle's order:
      const snap = JSON.stringify({ exit, tvl_floor_exit: pos(a).tvl_floor_exit ?? null, hold_mode: pos(a).hold_mode ?? null });
      await I.checkTvlRelativeShadow(row, hold, { chainTvl, nowMs: Date.now() });     // the shadow after the fixed rule's decision
      // the shadow leaves the fixed rule's state exactly as the fixed rule left it
      assert.equal(JSON.stringify({ exit, tvl_floor_exit: pos(a).tvl_floor_exit ?? null, hold_mode: pos(a).hold_mode ?? null }), snap);
      trace.push(snap);
    }
  } finally {
    mock.timers.reset();
    config.management.tvlRelativeExitMode = prev.rel;
    config.management.tvlFloorExitMode = prev.floor;
  }
  return { a, trace };
}

test("live TVL exit: return values and its state byte-identical with the shadow off and on (enforce and shadow, held and not)", async () => {
  for (const tvlFloorMode of ["enforce", "shadow"]) {
    for (const hold of [false, true]) {
      const off = await drive("off", `OFF_${tvlFloorMode}_${hold}`, { tvlFloorMode, hold });
      const on = await drive("shadow", `ON_${tvlFloorMode}_${hold}`, { tvlFloorMode, hold });
      assert.deepEqual(on.trace, off.trace, `${tvlFloorMode} held=${hold}`);
      assert.ok(off.trace.some((t) => JSON.parse(t).exit || JSON.parse(t).tvl_floor_exit?.shadow_logged_at), "the live rule completed its proof in the sequence");
      // mode off: nothing tracked
      assert.equal(pos(off.a).tvl_relative_exit, undefined);
      assert.equal(pos(off.a).tvl_floor_shadow_compare, undefined);
      // shadow: tracked, and the live rule's first ready recorded
      const cmp = pos(on.a).tvl_floor_shadow_compare;
      assert.ok(cmp?.old_first_ready_at, "old-ready stamped");
      assert.equal(cmp.old_first_ready_pnl_pct, -30);
      assert.ok(pos(on.a).tvl_relative_exit, "relative state tracked");
      S.recordClose(off.a, "test cleanup");
      S.recordClose(on.a, "test cleanup");
    }
  }
});

test("index wiring: FACTORY-like path would-fires once, held and hands-off positions are recorded, nothing closes", async () => {
  const prev = config.management.tvlRelativeExitMode;
  config.management.tvlRelativeExitMode = "shadow";
  try {
    const a = mk("WF", { hold: true, entry_tvl: 42900 });
    S.setPositionHandsOff(a, new Date(Date.now() + 8 * 3_600_000).toISOString());
    let calls = 0;
    const chainTvl = async () => { calls++; return { ok: true, tvl_usd: 9100 }; };
    const row = (v) => ({ position: a, pool: pos(a).pool, pair: "WF-SOL", pnl_pct: -51.2, total_value_true_usd: 300, tvl_floor_reading: { ok: true, tvl_usd: v } });
    const outs = [];
    for (const [m, v] of [[0, 9969], [10, 9050], [20, 8591], [31, 8400], [41, 8300]]) {
      outs.push(await I.checkTvlRelativeShadow(row(v), true, { chainTvl, nowMs: T0 + m * MIN }));
    }
    assert.equal(calls, 1, "one on-chain read: only on the completing reading");
    assert.ok(outs[3].would_fire);
    assert.equal(outs[4].event, "done");
    const wf = pos(a).tvl_relative_exit.would_fire;
    assert.deepEqual([wf.held, wf.hands_off, wf.readings, wf.pnl_pct, wf.own_value_subtracted, wf.ref_source], [true, true, 4, -51.2, true, "entry"]);
    assert.equal(wf.tvl_usd, 8100);       // $8,400 − own $300
    assert.equal(wf.ref_usd, 42600);      // $42,900 − own $300
    assert.equal(wf.chain_tvl_usd, 8800); // $9,100 − own $300
    assert.equal(pos(a).tvl_floor_shadow_compare.new_would_fire_at, wf.at);
    assert.equal(pos(a).tvl_floor_shadow_compare.old_first_ready_at, null);
    assert.equal(pos(a).closed, false);
    assert.equal(pos(a).hold_mode, true);
    assert.equal(pos(a).tvl_floor_exit ?? null, null, "the live rule's field is never written by the shadow");
    // the record keeps it after close (the closed row is inert, nothing clears it)
    S.recordClose(a, "test cleanup");
    assert.ok(pos(a).tvl_relative_exit.would_fire);
    assert.equal(await I.checkTvlRelativeShadow(row(100), true, { chainTvl, nowMs: T0 + 60 * MIN }), null);

    // on-chain unavailable → nothing this cycle, tried again next cycle; disagree → reset
    const b = mk("UNAV", { entry_tvl: 60000 });
    const rowB = (v) => ({ position: b, pool: pos(b).pool, pair: "UNAV-SOL", pnl_pct: -10, tvl_floor_reading: { ok: true, tvl_usd: v } });
    for (const m of [0, 15]) await I.checkTvlRelativeShadow(rowB(9000), false, { chainTvl, nowMs: T0 + m * MIN });
    let r = await I.checkTvlRelativeShadow(rowB(9000), false, { chainTvl: async () => ({ ok: false, reason: "rpc down" }), nowMs: T0 + 30 * MIN });
    assert.equal(r.check.verdict, "unavailable");
    assert.equal(pos(b).tvl_relative_exit.would_fire, null);
    assert.equal(pos(b).tvl_relative_exit.streak.count, 3);
    r = await I.checkTvlRelativeShadow(rowB(9000), false, { chainTvl: async () => ({ ok: true, tvl_usd: 40000 }), nowMs: T0 + 33 * MIN });
    assert.equal(r.check.verdict, "disagree");
    assert.equal(pos(b).tvl_relative_exit.streak, null);
    // a throw inside never escapes
    const bomb = { ...rowB(9000), tvl_floor_reading: { get ok() { throw new Error("boom"); } } };
    assert.equal(await I.checkTvlRelativeShadow(bomb, false, { chainTvl, nowMs: T0 + 36 * MIN }), null);
    // …and a throwing chain read on a completing proof neither
    for (const m of [40, 55]) await I.checkTvlRelativeShadow(rowB(9000), false, { chainTvl, nowMs: T0 + m * MIN });
    assert.equal(await I.checkTvlRelativeShadow(rowB(9000), false, { chainTvl: async () => { throw new Error("boom"); }, nowMs: T0 + 70 * MIN }), null);
    assert.equal(pos(b).tvl_relative_exit.would_fire, null);
    S.recordClose(b, "test cleanup");

    // mode off: nothing tracked; "enforce" runs as shadow
    const c = mk("OFFMODE");
    config.management.tvlRelativeExitMode = "off";
    assert.equal(await I.checkTvlRelativeShadow({ position: c, pool: pos(c).pool, pair: "C", tvl_floor_reading: { ok: true, tvl_usd: 100 } }, false, { chainTvl }), null);
    assert.equal(pos(c).tvl_relative_exit, undefined);
    config.management.tvlRelativeExitMode = "enforce";
    const e = await I.checkTvlRelativeShadow({ position: c, pool: pos(c).pool, pair: "C", tvl_floor_reading: { ok: true, tvl_usd: 100 } }, false, { chainTvl });
    assert.equal(e.event, "started");
    assert.equal(pos(c).closed, false);
    S.recordClose(c, "test cleanup");
  } finally {
    config.management.tvlRelativeExitMode = prev;
  }
});

test("index.js: the shadow runs AFTER the fixed rule's decision is recorded, detached; the live rule only gains a record-only hook", () => {
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /const tvlFloorExit = await checkTvlFloorExit\(p, tvlFloorCfg, operatorHold\);\s*if \(tvlFloorExit\) \{\s*exitMap\.set\(p\.position, tvlFloorExit\);\s*log\([^\n]*\n\s*\}\s*(\/\/[^\n]*\n\s*)*void checkTvlRelativeShadow\(p, operatorHold\);\s*if \(tvlFloorExit\) continue;/);
  assert.equal((idx.match(/checkTvlRelativeShadow\(p, operatorHold\)/g) || []).length, 1); // one call site, never awaited
  assert.doesNotMatch(idx, /await checkTvlRelativeShadow\(p/);
  assert.match(idx, /return null;\s*\}\s*noteTvlFloorReadyForShadow\(p\);[^\n]*\n\s*\/\/ Operator hands-off/);
  // shadow never builds an exit, never sends Telegram
  const body = idx.slice(idx.indexOf("export async function checkTvlRelativeShadow"), idx.indexOf("const usdInt ="));
  assert.doesNotMatch(body, /sendHTML|buildTvlFloorExit|exitMap|close_position|hold_override/);
  // close reasons never carry the tag
  assert.doesNotMatch(idx, /reason[^\n]*TVL_RELATIVE/);
});

test("grader tvl-relative-exit: threshold, the three checks, hand-graded cases hold the verdict", async () => {
  const { gradeExperiment } = await import("../scripts/experiments/lib.js");
  const { experimentById } = await import("../scripts/experiments/definitions.js");
  const def = experimentById("tvl-relative-exit");
  const at = (h) => new Date(Date.parse("2026-11-28T00:00:00Z") + h * 3_600_000).toISOString();
  let k = 0;
  const rec = ({ oldAt = null, oldPnl = null, newAt = null, newPnl = null, pnl, closeH = 0.5, reason = "Stop loss", adopted = true }) => ({
    position: `P${k++}`, pool_name: "X-SOL", adopted, recorded_at: at(closeH), pnl_pct: pnl, pnl_sol_net: pnl / 100, amount_sol: 1, close_reason: reason,
    tvl_floor_shadow_compare: { old_first_ready_at: oldAt, old_first_ready_pnl_pct: oldPnl, old_closed: false, new_would_fire_at: newAt, new_would_fire_pnl_pct: newPnl },
  });
  // 10 disagreements: old ready, new not, closed within 60 min at or above the old-ready PnL
  const recs = Array.from({ length: 10 }, () => rec({ oldAt: at(0), oldPnl: -5, pnl: -4, closeH: 0.5 }));
  assert.equal(gradeExperiment(def, recs, { now: Date.parse("2026-12-10T00:00:00Z") }).verdict, "insufficient"); // < 21 days
  const later = Date.parse("2026-12-19T00:00:00Z");
  let g = gradeExperiment(def, recs, { now: later });
  assert.equal(g.metrics.disagreements, 10);
  assert.equal(g.verdict, "met");
  // a case the record cannot answer (closed 3 h after old-ready) → graded by hand → insufficient
  g = gradeExperiment(def, [...recs, rec({ oldAt: at(0), oldPnl: -5, pnl: -6, closeH: 3 })], { now: later });
  assert.equal(g.verdict, "insufficient");
  assert.match(g.reason, /graded by hand from price_ticks/);
  // check 2: a −40 % close the new rule caught 12 pp worse → fails
  g = gradeExperiment(def, [...recs, rec({ oldAt: at(0), oldPnl: -20, newAt: at(0.2), newPnl: -32, pnl: -40, closeH: 0.4 })], { now: later });
  assert.equal(g.checks[1].pass, false);
  assert.equal(g.verdict, "not_met");
  // check 3: two would-fires that recovered > 10 pp
  g = gradeExperiment(def, [...recs, rec({ newAt: at(0), newPnl: -20, pnl: -5 }), rec({ newAt: at(0), newPnl: -25, pnl: -2 })], { now: later });
  assert.equal(g.checks[2].pass, false);
  // the old rule closed it and the new never fired → excluded from check 1
  g = gradeExperiment(def, [...recs, rec({ oldAt: at(0), oldPnl: -5, pnl: -5, closeH: 3, reason: "TVL exit: pool TVL $9,000 under the $10,000 minimum" })], { now: later });
  assert.equal(g.metrics.c1_excluded_old_closed, 1);
  assert.equal(g.verdict, "met");
  // 90 days force the verdict whatever the count
  assert.equal(gradeExperiment(def, recs.slice(0, 2), { now: Date.parse("2027-02-26T00:00:00Z") }).threshold.reached, true);
});

test("reference is tracked on OTHER liquidity (reviewer's case): peak $12K with own $8K, now own $4K and TVL $6K → 50 %, not 25 %", () => {
  const s = run([[0, rd(12000)]], { own: { usd: 8000, subtracted: true } });
  assert.equal(s[0].state.peak_usd, 4000);
  const r = advanceTvlRelativeExit(s[0].state, { reading: rd(6000), own: { usd: 4000, subtracted: true }, cfg, nowMs: T0 + 3 * MIN });
  assert.equal(r.tvl_adj_usd, 2000);
  assert.equal(r.ref_adj_usd, 4000);
  assert.equal(r.pct_of_ref, 50);
  assert.equal(r.state.own_value_subtracted, true);
  // entry reference = entry_tvl − own value at the first reading, then fixed
  const e = run([[0, rd(30000)], [3, rd(9000)]], { entry: 42900, own: { usd: 900, subtracted: true } });
  assert.deepEqual([e[0].state.entry_ref_usd, e[0].state.entry_own_value_usd, e[0].state.ref_source], [42000, 900, "entry"]);
  const later = advanceTvlRelativeExit(e[1].state, { reading: rd(9000), entryTvlUsd: 42900, own: { usd: 100, subtracted: true }, cfg, nowMs: T0 + 6 * MIN });
  assert.equal(later.state.entry_ref_usd, 42000); // not recomputed with the new own value
  // own value unknown at the first reading → nothing subtracted from the entry
  const u = run([[0, rd(30000)]], { entry: 42900 });
  assert.deepEqual([u[0].state.entry_ref_usd, u[0].state.entry_own_value_usd], [42900, null]);
});

test("write throttle: a reading that moves only last_at / the own value keeps the same object for 10 min", () => {
  const own = (v) => ({ usd: v, subtracted: true });
  const a = advanceTvlRelativeExit(null, { reading: rd(50000), own: own(500), cfg, nowMs: T0 });
  const b = advanceTvlRelativeExit(a.state, { reading: rd(49000), own: own(520), cfg, nowMs: T0 + 3 * MIN });
  assert.equal(b.state, a.state, "same object → updateTvlRelativeShadow does not save");
  assert.equal(b.event, "tracked");
  const c = advanceTvlRelativeExit(b.state, { reading: rd(49000), own: own(530), cfg, nowMs: T0 + 10 * MIN });
  assert.notEqual(c.state, a.state, "saved again after 10 min");
  assert.equal(c.state.own_value_usd, 530);
  const d = advanceTvlRelativeExit(c.state, { reading: rd(60000), own: own(530), cfg, nowMs: T0 + 11 * MIN });
  assert.notEqual(d.state, c.state, "a new peak is saved at once");
  // a qualifying reading always changes the streak → saved
  const q = run([[0, rd(9000)], [3, rd(9000)]], { entry: 60000 });
  assert.notEqual(q[1].state, q[0].state);
  // updateTvlRelativeShadow does not write when the object is unchanged
  const addr = mk("THROTTLE", { entry_tvl: 60000 });
  S.updateTvlRelativeShadow(addr, () => ({ relative: a.state }));
  const before = pos(addr).tvl_relative_exit;
  S.updateTvlRelativeShadow(addr, ({ relative }) => ({ relative }));
  assert.equal(pos(addr).tvl_relative_exit, before);
  S.recordClose(addr, "test cleanup");
});

test("the shadow's on-chain read is capped: a hanging read is 'unavailable this cycle'", async () => {
  const prev = config.management.tvlRelativeExitMode;
  config.management.tvlRelativeExitMode = "shadow";
  try {
    const a = mk("TIMEOUT", { entry_tvl: 60000 });
    const row = { position: a, pool: pos(a).pool, pair: "TO-SOL", pnl_pct: -10, tvl_floor_reading: { ok: true, tvl_usd: 9000 } };
    const ok = async () => ({ ok: true, tvl_usd: 9000 });
    for (const m of [0, 15]) await I.checkTvlRelativeShadow(row, false, { chainTvl: ok, nowMs: T0 + m * MIN });
    const t0 = Date.now();
    const r = await I.checkTvlRelativeShadow(row, false, { chainTvl: () => new Promise(() => {}), nowMs: T0 + 30 * MIN, chainTimeoutMs: 50 });
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(r.check.verdict, "unavailable");
    assert.match(r.check.reason, /on-chain read over/);
    assert.equal(pos(a).tvl_relative_exit.would_fire, null);
    assert.equal(pos(a).tvl_relative_exit.streak.count, 3);
    assert.equal(I.TVL_RELATIVE_CHAIN_TIMEOUT_MS, 5000);
    // next cycle, the read answers → would-fire
    const r2 = await I.checkTvlRelativeShadow(row, false, { chainTvl: ok, nowMs: T0 + 33 * MIN });
    assert.ok(r2.would_fire);
    S.recordClose(a, "test cleanup");
  } finally {
    config.management.tvlRelativeExitMode = prev;
  }
});

test("grader minimums: no evidence is never met; check 2 needs the close in time", async () => {
  const { gradeExperiment } = await import("../scripts/experiments/lib.js");
  const { experimentById } = await import("../scripts/experiments/definitions.js");
  const def = experimentById("tvl-relative-exit");
  const at = (h) => new Date(Date.parse("2026-11-28T00:00:00Z") + h * 3_600_000).toISOString();
  let k = 0;
  const rec = ({ oldAt = null, oldPnl = null, newAt = null, newPnl = null, pnl, closeH = 0.5, reason = "Stop loss", oldClosed = false }) => ({
    position: `Q${k++}`, pool_name: "Y-SOL", adopted: true, recorded_at: at(closeH), pnl_pct: pnl, pnl_sol_net: pnl / 100, amount_sol: 1, close_reason: reason,
    tvl_floor_shadow_compare: { old_first_ready_at: oldAt, old_first_ready_pnl_pct: oldPnl, old_closed: oldClosed, new_would_fire_at: newAt, new_would_fire_pnl_pct: newPnl },
  });
  // zero records at the 90-day arm → insufficient, closed as such
  let g = gradeExperiment(def, [], { now: Date.parse("2027-02-26T00:00:00Z") });
  assert.equal(g.verdict, "insufficient");
  assert.equal(g.metrics.closed_insufficient, true);
  assert.match(g.reason, /fewer than 5 gradeable check-1 cases \(0\) at the 90-day arm — closed as insufficient, never met/);
  // ten disagreements, all closed by the old rule → 0 gradeable check-1 cases → insufficient at 21 days
  const oldOnly = Array.from({ length: 10 }, () => rec({ oldAt: at(0), oldPnl: -5, pnl: -5, oldClosed: true, reason: "TVL exit: x" }));
  g = gradeExperiment(def, oldOnly, { now: Date.parse("2026-12-19T00:00:00Z") });
  assert.equal(g.metrics.disagreements, 10);
  assert.equal(g.verdict, "insufficient");
  assert.equal(g.metrics.closed_insufficient, false);
  // four gradeable cases → still insufficient
  const four = Array.from({ length: 4 }, () => rec({ oldAt: at(0), oldPnl: -5, pnl: -4 }));
  g = gradeExperiment(def, [...four, ...oldOnly], { now: Date.parse("2026-12-19T00:00:00Z") });
  assert.equal(g.verdict, "insufficient");
  const five = [...four, rec({ oldAt: at(0), oldPnl: -5, pnl: -4 })];
  g = gradeExperiment(def, [...five, ...oldOnly], { now: Date.parse("2026-12-19T00:00:00Z") });
  // with five gradeable cases: check 2 has no ≤ −30 % case → passes, reported as "no cases"; the old-closed
  // ≤ −30 %-free set leaves check 2 empty
  assert.equal(g.checks[1].no_cases, true);
  assert.match(g.checks[1].detail, /^no cases/);
  assert.equal(g.verdict, "met");
  // the reviewer's case: hands-off, old ready at −20 %, new never fires, closed by hand at −60 % two days later → fails
  const missed = rec({ oldAt: at(0), oldPnl: -20, pnl: -60, closeH: 48, reason: "manual close" });
  g = gradeExperiment(def, [...five, missed], { now: Date.parse("2026-12-19T00:00:00Z") });
  assert.equal(g.checks[1].pass, false);
  assert.equal(g.checks[1].value, 1);
  // closed by another rule within 60 min of old-ready → passes check 2
  g = gradeExperiment(def, [...five, rec({ oldAt: at(0), oldPnl: -25, pnl: -38, closeH: 0.8, reason: "Stop loss" })], { now: Date.parse("2026-12-19T00:00:00Z") });
  assert.equal(g.checks[1].pass, true);
  // closed later but no more than 10 pp under the old-ready PnL → passes
  g = gradeExperiment(def, [...five, rec({ oldAt: at(0), oldPnl: -25, pnl: -33, closeH: 30, reason: "manual close" })], { now: Date.parse("2026-12-19T00:00:00Z") });
  assert.equal(g.checks[1].pass, true);
});
