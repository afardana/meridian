process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Straddle trailing shadow — LOG ONLY (trail-straddle-shadow.js, 2026-10-19). Driven by the live
// confirmed peak; at a live trailing close on a straddled position the verdict says whether a
// 3 % trigger would have held it (would_hold) or fired at the same threshold (same).

const S = await import("../state.js");
const TS = await import("../trail-straddle-shadow.js");
const { config } = await import("../config.js");
await S.ensureStateInitialized();

const realNow = Date.now;
let clock = realNow();
const T = (wib) => Date.parse(`2026-10-19T${wib}+07:00`);
Date.now = () => clock;

const mgmt = {
  trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5,
  stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 60, harvestStraddleGraceMinutes: 60,
  trailStraddleShadowTrigger: 3,
};
const row = (pnl) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100, pnl_basis: "sol", pnl_management_ready: true, pnl_quality: "valid" });
let seq = 0;
const made = [];
const mk = (tag) => {
  const a = `TEST_TRAIL_STRADDLE_${tag}_${realNow()}_${seq++}`;
  S.trackPosition({ position: a, pool: "POOL_TSS_" + tag, pool_name: tag + "-SOL", amount_sol: 1, initial_value_usd: 1, strategy: "spot", bin_range: [0, 100], active_bin: 50 });
  made.push(a);
  return a;
};
const pos = (a) => S.getTrackedPosition(a);
const read = (a, wib, pnl, cfg = mgmt) => {
  clock = T(wib);
  S.confirmPeak(a, pnl, 2);
  S.noteGraceShadowReading(a, pnl, { confirmTicks: 2 }, cfg);
  return S.updatePnlAndCheckExits(a, row(pnl), cfg);
};
const straddle = (a, wib, graceMin = 60) => {
  const p = pos(a);
  p.straddle_count = (Number(p.straddle_count) || 0) + 1;
  p.straddled_at = new Date(T(wib)).toISOString();
  p.profit_grace_until = graceMin > 0 ? new Date(T(wib) + graceMin * 60_000).toISOString() : null;
  p.lane = "straddle";
  p.trailing_active = false;
};

test("trigger key: default 3, 0 = off, update_config-tunable", () => {
  assert.equal(TS.trailStraddleShadowTrigger({}), 3);
  assert.equal(TS.trailStraddleShadowTrigger({ trailStraddleShadowTrigger: 0 }), 0);
  assert.equal(TS.trailStraddleShadowTrigger({ trailStraddleShadowTrigger: 4.5 }), 4.5);
  assert.equal(TS.trailStraddleShadowTrigger({ trailStraddleShadowTrigger: -1 }), 0);
  assert.equal(config.management.trailStraddleShadowTrigger, 3);
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exe, /trailStraddleShadowTrigger: \["management", "trailStraddleShadowTrigger"\]/);
  const cfgSrc = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfgSrc, /fresh\.trailStraddleShadowTrigger/);
});

test("PIERRE-SOL: re-based peak 3.85 ≥ 3 → shadow armed, live fire at 2.25 → verdict same", () => {
  const P = mk("PIERRE");
  pos(P).peak_pnl_pct = 2.46;
  straddle(P, "15:44:00");
  try {
    for (const [t, v] of [["15:44:30", 1.46], ["15:47:00", 10.52], ["15:47:15", 10.68], ["15:49:00", 8.67], ["15:57:00", 5.34], ["15:59:00", 3.85]]) {
      assert.equal(read(P, t, v), null);
      assert.equal(pos(P).trail_straddle_shadow?.armed ?? false, false, `not armed inside the grace (${t})`);
    }
    clock = T("16:01:00");
    S.releasePositionProfitGrace(P, mgmt);
    assert.equal(read(P, "16:01:10", 3.85), null);
    const s = pos(P).trail_straddle_shadow;
    assert.equal(pos(P).trailing_active, true, "live trailing armed on the re-based 3.85");
    assert.equal(s.armed, true);
    assert.equal(s.armed_at, new Date(T("16:01:10")).toISOString());
    assert.equal(s.peak_pct, 3.85);
    const exit = read(P, "16:09:00", 2.25);
    assert.equal(exit?.action, "TRAILING_TP");
    const r = S.noteTrailStraddleShadowFire(P, 2.25, mgmt);
    assert.equal(r.verdict, "same");
    assert.equal(r.line, `[TRAIL_STRADDLE_SHADOW] same PIERRE-SOL: confirmed peak 3.85% ≥ 3% trigger — live trailing closed at 2.25%, the shadow fires at the same threshold (trailStraddleShadowTrigger=3)`);
    const rec = S.profitShadowRecordFields(pos(P)).trail_straddle_shadow;
    assert.deepEqual(
      { trigger: rec.trigger, verdict: rec.verdict, live_peak_pct: rec.live_peak_pct, live_fire_pct: rec.live_fire_pct, armed_at: rec.armed_at },
      { trigger: 3, verdict: "same", live_peak_pct: 3.85, live_fire_pct: 2.25, armed_at: new Date(T("16:01:10")).toISOString() },
    );
  } finally { clock = realNow(); }
});

test("VEIL-SOL: confirmed peak 2.73 < 3, live trailing fires at 0.85 → would_hold", () => {
  const V = mk("VEIL");
  straddle(V, "11:00:00", 0); // grace already over / none
  try {
    for (const [t, v] of [["11:01:00", 2.73], ["11:01:15", 2.73], ["11:03:00", 2.0]]) assert.equal(read(V, t, v), null);
    assert.equal(pos(V).peak_pnl_pct, 2.73);
    assert.equal(pos(V).trailing_active, true, "live trigger 2 armed");
    assert.equal(pos(V).trail_straddle_shadow.armed, false, "shadow trigger 3 not reached");
    const exit = read(V, "11:05:00", 0.85);
    assert.equal(exit?.action, "TRAILING_TP");
    const r = S.noteTrailStraddleShadowFire(V, 0.85, mgmt);
    assert.equal(r.verdict, "would_hold");
    assert.equal(r.line, "[TRAIL_STRADDLE_SHADOW] would-hold VEIL-SOL: confirmed peak 2.73% < 3% trigger — live trailing closed at 0.85% (trailStraddleShadowTrigger=3)");
    const s = pos(V).trail_straddle_shadow;
    assert.equal(s.verdict, "would_hold");
    assert.equal(s.live_fire_pct, 0.85);
    assert.equal(s.live_peak_pct, 2.73);
    assert.equal(s.armed_at, null);
  } finally { clock = realNow(); }
});

test("a new straddle disarms the shadow; a re-based peak under the trigger disarms it", () => {
  const p = { straddle_count: 1, peak_pnl_pct: 4, trailing_active: true };
  assert.equal(TS.advanceTrailStraddleShadow(p, { eligible: true, mgmt, nowMs: T("10:00:00") }).event, "armed");
  p.trailing_active = false; // a new straddle resets the live trailing and starts a grace
  assert.equal(TS.advanceTrailStraddleShadow(p, { eligible: false, mgmt }).event, "disarmed");
  p.peak_pnl_pct = 5;
  assert.equal(TS.advanceTrailStraddleShadow(p, { eligible: true, mgmt, nowMs: T("11:00:00") }).event, "armed");
  p.peak_pnl_pct = 2.5; // grace-end / rebalance re-base
  assert.equal(TS.advanceTrailStraddleShadow(p, { eligible: true, mgmt }).event, "disarmed");
});

test("off when the key is 0, and never on an unstraddled position", () => {
  const P = mk("OFF");
  straddle(P, "13:00:00", 0);
  const U = mk("UNSTRADDLED");
  const off = { ...mgmt, trailStraddleShadowTrigger: 0 };
  try {
    for (const [t, v] of [["13:01:00", 2.73], ["13:01:15", 2.73]]) { read(P, t, v, off); read(U, t, v, mgmt); }
    assert.equal(read(P, "13:03:00", 0.85, off)?.action, "TRAILING_TP");
    assert.equal(read(U, "13:03:00", 0.85, mgmt)?.action, "TRAILING_TP");
    assert.equal(S.noteTrailStraddleShadowFire(P, 0.85, off), null);
    assert.equal(S.noteTrailStraddleShadowFire(U, 0.85, mgmt), null);
    assert.equal(pos(P).trail_straddle_shadow, undefined);
    assert.equal(pos(U).trail_straddle_shadow, undefined);
  } finally { clock = realNow(); }
});

test("the shadow changes no live field and no exit", () => {
  const on = mk("LIVE_ON"); const off = mk("LIVE_OFF");
  const cfgOff = { ...mgmt, trailStraddleShadowTrigger: 0, graceShadowEnabled: false };
  for (const a of [on, off]) straddle(a, "17:00:00", 0);
  const LIVE = ["peak_pnl_pct", "trailing_active", "pending_peak_pnl_pct", "pending_peak_confirm_count", "pnl_tick_history", "pending_exit_action"];
  const snap = (a) => JSON.stringify(LIVE.map((k) => pos(a)[k] ?? null));
  try {
    for (const [t, v] of [["17:01:00", 1.0], ["17:02:00", 3.3], ["17:02:15", 3.4], ["17:03:00", 2.8], ["17:04:00", 1.7]]) {
      const a = read(on, t, v, mgmt), b = read(off, t, v, cfgOff);
      assert.equal(a?.action ?? null, b?.action ?? null, `exit at ${t}`);
      assert.equal(a?.reason ?? null, b?.reason ?? null);
      assert.equal(snap(on), snap(off), `live fields at ${t}`);
    }
    S.noteTrailStraddleShadowFire(on, 1.7, mgmt);
    assert.equal(snap(on), snap(off), "stamping the verdict touches no live field");
  } finally { clock = realNow(); }
});

test("index.js stamps the verdict where a trailing close is built (poller and management cycle)", () => {
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const s0 = idx.indexOf("async function buildExitAction(p, exit, extra = {}) {");
  assert.ok(s0 > 0);
  const body = idx.slice(s0, idx.indexOf("\n}\n", s0));
  assert.match(body, /if \(exit\?\.action === "TRAILING_TP"\) \{\s*try \{ noteTrailStraddleShadowFire\(p\.position, p\.pnl_pct, config\.management\); \}/);
  assert.equal((idx.match(/buildExitAction\(p, /g) || []).length >= 3, true);
});

test.after(() => {
  Date.now = realNow;
  for (const a of made) { try { S.closeTrackedPosition(a, "test"); } catch {} }
});
