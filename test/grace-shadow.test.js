process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Grace counterfactual — LOG ONLY (grace-shadow.js, 2026-10-19). The PIERRE-SOL 72jUBSia
// sequence of 2026-10-19 (WIB = UTC+7) is replayed through the real state functions on a
// controlled clock: straddle 15:44 at +1.46 %, in-grace high 10.68 % at 15:47, release by the
// operator at 16:01 at 3.85 %, live trailing fires at 2.25 % at 16:09.

const S = await import("../state.js");
const G = await import("../grace-shadow.js");
const { config } = await import("../config.js");
await S.ensureStateInitialized();

const realNow = Date.now;
let clock = realNow();
const T = (wib) => Date.parse(`2026-10-19T${wib}+07:00`);
const setClock = (ms) => { clock = ms; };
Date.now = () => clock;

const mgmt = {
  trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5,
  stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 60, harvestStraddleGraceMinutes: 60,
  trailStraddleShadowTrigger: 3, graceShadowEnabled: true,
};
const row = (pnl, over = {}) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100, pnl_basis: "sol", pnl_management_ready: true, pnl_quality: "valid", ...over });
let seq = 0;
const made = [];
const mk = (tag, over = {}) => {
  const a = `TEST_GRACE_SHADOW_${tag}_${realNow()}_${seq++}`;
  S.trackPosition({ position: a, pool: "POOL_GS_" + tag, pool_name: tag + "-SOL", amount_sol: 1, initial_value_usd: 1, strategy: "spot", bin_range: [0, 100], active_bin: 50, ...over });
  made.push(a);
  return a;
};
const pos = (a) => S.getTrackedPosition(a);
// One trusted reading as the poller sees it: confirmPeak, the shadow feed, then the evaluator.
const read = (a, wib, pnl, cfg = mgmt, ticks = 2) => {
  setClock(T(wib));
  S.confirmPeak(a, pnl, ticks);
  S.noteGraceShadowReading(a, pnl, { confirmTicks: ticks }, cfg);
  return S.updatePnlAndCheckExits(a, row(pnl), cfg);
};
const straddle = (a, wib) => {
  const p = pos(a);
  p.straddle_count = (Number(p.straddle_count) || 0) + 1;
  p.straddled_at = new Date(T(wib)).toISOString();
  p.profit_grace_until = new Date(T(wib) + 60 * 60_000).toISOString();
  p.lane = "straddle";
  p.trailing_active = false;
  p.pending_peak_pnl_pct = null; p.pending_peak_confirm_count = 0;
};
const PIERRE = [
  ["15:44:30", 1.46], ["15:47:00", 10.52], ["15:47:15", 10.68], ["15:47:45", 10.68], ["15:48:00", 10.68],
  ["15:48:30", 9.40], ["15:49:00", 9.10], ["15:49:15", 9.05], ["15:49:45", 8.67], ["15:53:00", 7.10],
  ["15:57:00", 5.34], ["15:59:00", 3.85],
];
const AFTER = [["16:01:10", 3.85], ["16:01:30", 3.85], ["16:05:00", 3.10], ["16:09:00", 2.25]];

test("config defaults and update_config keys", () => {
  assert.equal(config.management.graceShadowEnabled, true);
  assert.equal(G.graceShadowEnabled({}), true);
  assert.equal(G.graceShadowEnabled({ graceShadowEnabled: false }), false);
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exe, /graceShadowEnabled: \["management", "graceShadowEnabled"\]/);
  const cfgSrc = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfgSrc, /fresh\.graceShadowEnabled/);
});

test("PIERRE-SOL: in-grace peak, the no-grace trailing fire, one [GRACE_SHADOW] line at the release", () => {
  const P = mk("PIERRE");
  pos(P).peak_pnl_pct = 2.46; // the harvest's confirmed peak, kept through the straddle
  straddle(P, "15:44:00");
  try {
    for (const [t, v] of PIERRE) assert.equal(read(P, t, v), null, `nothing fires inside the grace (${t})`);
    const s = pos(P).grace_shadow;
    assert.equal(s.kind, "straddle");
    assert.equal(s.started_at, new Date(T("15:44:00")).toISOString());
    assert.equal(s.planned_min, 60);
    assert.equal(s.peak_pct, 10.68);
    assert.equal(s.peak_at, new Date(T("15:47:15")).toISOString());
    assert.equal(s.sim_peak_pct, 10.68, "confirmed with the streak minimum: 10.52 first, then 10.68");
    assert.equal(s.no_grace_rule, "trailing_tp");
    assert.equal(s.no_grace_threshold_pct, 9.18);
    assert.equal(s.no_grace_fire_pct, 9.05, "second distinct breach (9.10 at 15:49:00 overshot 0.08 pp < 0.5)");
    assert.ok(Math.abs(s.no_grace_fire_pct - (10.68 - 1.5)) < 0.2);
    assert.equal(s.no_grace_fire_at, new Date(T("15:49:15")).toISOString());
    assert.equal(s.ended_by, null);

    setClock(T("16:01:00"));
    const rel = S.releasePositionProfitGrace(P, mgmt);
    assert.equal(rel.was_active, true);
    const e = pos(P).grace_shadow;
    assert.equal(e.ended_by, "release");
    assert.equal(e.end_pct, 3.85);
    assert.equal(e.elapsed_min, 17);
    assert.equal(
      G.graceShadowLine(e, "PIERRE-SOL", mgmt),
      "[GRACE_SHADOW] PIERRE-SOL: straddle grace 60 min (released by the operator after 17 min) — in-grace peak 10.68% at 15:47:15 WIB, reading at the end 3.85%; without the grace trailing would have closed at +9.05% at 15:49:15 WIB (confirmed peak 10.68% − 1.5 pp, threshold 9.18%)",
    );

    // After the release: [GRACE_END] re-bases the live peak to 3.85; the closed record is not re-opened.
    let exit = null;
    for (const [t, v] of AFTER) exit = read(P, t, v) || exit;
    assert.equal(exit?.action, "TRAILING_TP", "live trailing fires at 2.25 % (peak 3.85 − 1.5)");
    assert.equal(pos(P).peak_pnl_pct, 3.85);
    assert.deepEqual(pos(P).grace_shadow, e, "the grace end after a release writes nothing more");
    const rec = S.profitShadowRecordFields(pos(P));
    assert.equal(rec.grace_shadow.ended_by, "release");
    assert.equal(rec.grace_shadow.no_grace_fire_pct, 9.05);
    assert.equal(rec.grace_shadow.open_at_close, undefined);
  } finally { setClock(realNow()); }
});

test("adoption grace that runs to the end: timer verdict, would-not-fire line", () => {
  const A = mk("ADOPT", { adopted: true });
  try {
    pos(A).adopted_at = new Date(T("10:00:00")).toISOString();
    for (const [t, v] of [["10:00:20", 0.4], ["10:10:00", 1.2], ["10:20:00", 1.6], ["10:20:30", 1.7], ["10:40:00", 0.9]]) {
      assert.equal(read(A, t, v), null);
    }
    const s = pos(A).grace_shadow;
    assert.equal(s.kind, "adoption");
    assert.equal(s.planned_min, 60);
    assert.equal(s.peak_pct, 1.7);
    assert.equal(s.sim_peak_pct, 1.2, "1.2 then 1.6 confirm at the streak minimum 1.2; 1.7 never gets its second reading");
    assert.equal(s.no_grace_rule, null, "the confirmed peak never reached the 2 % trigger");
    read(A, "11:00:30", 1.1); // the grace is over: [GRACE_END] closes the record
    const e = pos(A).grace_shadow;
    assert.equal(e.ended_by, "timer");
    assert.equal(e.end_pct, 1.1);
    assert.equal(e.elapsed_min, 60.5);
    assert.equal(
      G.graceShadowLine(e, "MAN-SOL", mgmt),
      "[GRACE_SHADOW] MAN-SOL: adoption grace 60 min (ran to the end) — in-grace peak 1.70% at 10:20:30 WIB, reading at the end 1.10%; without the grace trailing would not have fired during the grace (confirmed peak 1.20%)",
    );
  } finally { setClock(realNow()); }
});

test("a new straddle restarts the shadow; an open grace at the close is marked", () => {
  const P = mk("RESTART", { adopted: true });
  try {
    pos(P).adopted_at = new Date(T("12:00:00")).toISOString();
    read(P, "12:00:30", 0.5);
    assert.equal(pos(P).grace_shadow.kind, "adoption");
    straddle(P, "12:30:00");
    read(P, "12:30:20", 0.8);
    const s = pos(P).grace_shadow;
    assert.equal(s.kind, "straddle", "the straddle's window is the longer one");
    assert.equal(s.started_at, new Date(T("12:30:00")).toISOString());
    assert.equal(s.readings, 1);
    assert.equal(s.peak_pct, 0.8);
    assert.equal(S.profitShadowRecordFields(pos(P)).grace_shadow.open_at_close, true);
  } finally { setClock(realNow()); }
});

test("graceShadowEnabled=false writes nothing; held positions are skipped", () => {
  const P = mk("OFF");
  straddle(P, "14:00:00");
  try {
    read(P, "14:00:30", 4.0, { ...mgmt, graceShadowEnabled: false });
    assert.equal(pos(P).grace_shadow, undefined);
    pos(P).hold_mode = true;
    setClock(T("14:01:00"));
    assert.equal(S.noteGraceShadowReading(P, 5, { confirmTicks: 2 }, mgmt).changed, false);
    assert.equal(pos(P).grace_shadow, undefined);
    assert.equal(S.profitShadowRecordFields(pos(P)).grace_shadow, null);
  } finally { pos(P).hold_mode = false; setClock(realNow()); }
});

test("take-profit counts when it fires before trailing; management-cycle cadence confirms at once", () => {
  const p = { straddle_count: 1, straddled_at: new Date(T("09:00:00")).toISOString(), profit_grace_until: new Date(T("10:00:00")).toISOString() };
  const cfg = { ...mgmt, takeProfitPct: 5 };
  const feed = (wib, v) => G.advanceGraceShadow(p, { pnlPct: v, confirmTicks: 1, nowMs: T(wib), mgmt: cfg, evaluateTrailing: S.evaluateTrailingTakeProfit });
  feed("09:00:10", 1);
  assert.equal(feed("09:05:00", 5.2).event, "fired");
  assert.equal(p.grace_shadow.no_grace_rule, "take_profit");
  assert.equal(p.grace_shadow.no_grace_fire_pct, 5.2);
  const line = G.finishGraceShadow(p, { endedBy: "timer", endPct: 4, nowMs: T("10:00:00"), mgmt: cfg, pair: "TP-SOL" });
  assert.equal(line, "[GRACE_SHADOW] TP-SOL: straddle grace 60 min (ran to the end) — in-grace peak 5.20% at 09:05:00 WIB, reading at the end 4.00%; without the grace take-profit would have closed at +5.20% at 09:05:00 WIB (target 5.00%)");
  assert.equal(G.finishGraceShadow(p, { endedBy: "timer", nowMs: T("10:01:00") }), null, "one line per grace");
});

test("the shadow changes no live field and no exit (same sequence with both shadows off)", () => {
  const on = mk("LIVE_ON"); const off = mk("LIVE_OFF");
  const cfgOff = { ...mgmt, graceShadowEnabled: false, trailStraddleShadowTrigger: 0 };
  for (const a of [on, off]) { pos(a).peak_pnl_pct = 2.46; straddle(a, "15:44:00"); }
  const LIVE = ["peak_pnl_pct", "trailing_active", "pending_peak_pnl_pct", "pending_peak_confirm_count", "profit_grace_until", "profit_grace_active", "pnl_tick_history", "grace_stop_paused", "pending_exit_action"];
  const snap = (a) => JSON.stringify(LIVE.map((k) => pos(a)[k] ?? null));
  try {
    for (const [t, v] of PIERRE) {
      assert.deepEqual(read(on, t, v, mgmt), read(off, t, v, cfgOff));
      assert.equal(snap(on), snap(off), `live fields at ${t}`);
    }
    setClock(T("16:01:00"));
    S.releasePositionProfitGrace(on, mgmt); S.releasePositionProfitGrace(off, cfgOff);
    for (const [t, v] of AFTER) {
      const a = read(on, t, v, mgmt), b = read(off, t, v, cfgOff);
      assert.equal(a?.action ?? null, b?.action ?? null, `exit at ${t}`);
      assert.equal(a?.reason ?? null, b?.reason ?? null);
      assert.equal(snap(on), snap(off), `live fields at ${t}`);
    }
    assert.equal(pos(off).grace_shadow, undefined);
    assert.ok(pos(on).grace_shadow);
  } finally { setClock(realNow()); }
});

test("index.js feeds the shadow from the confirmPeak stream at both sites", () => {
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /if \(!valuation\.suspect\) confirmPeak\(p\.position, p\.pnl_pct, 1\);\n\s*if \(!valuation\.suspect\) feedGraceShadow\(p, 1\);/);
  assert.match(idx, /if \(valuation\.fresh && !valuation\.suspect\) confirmPeak\(p\.position, p\.pnl_pct, confirmTicks\);\n\s*if \(valuation\.fresh && !valuation\.suspect\) feedGraceShadow\(p, confirmTicks\);/);
  assert.match(idx, /function feedGraceShadow\(p, confirmTicks\) \{\n\s*try \{\n\s*noteGraceShadowReading\(p\.position, p\.pnl_pct, \{ confirmTicks \}, config\.management\);/);
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal((dlmm.match(/\.\.\.profitShadowRecordFields\((snapshot|tracked)\)/g) || []).length, 3, "three perf-record sites");
});

test.after(() => {
  Date.now = realNow;
  for (const a of made) { try { S.closeTrackedPosition(a, "test"); } catch {} }
});
