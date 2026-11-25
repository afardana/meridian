process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Reading guard on non-held positions — LOG ONLY (reading-guard-shadow.js, 2026-11-25;
// docs/experiments/reading-guard.md). A PnL move more than 5 pp beyond what the active-bin move
// since the last accepted reading explains opens an episode on `reading_guard_shadow`; nothing
// live changes. Pure-step tests (the two motivating cases, real moves, persistence, capital
// change), then the on/off equivalence through the real state functions the poller calls.

const G = await import("../reading-guard-shadow.js");
const S = await import("../state.js");
const { config } = await import("../config.js");
const { advanceHeldReadingRef } = await import("../hold-observer.js");
const { buildPerfRecord } = await import("../perf-record.js");
await S.ensureStateInitialized();

const T0 = Date.parse("2026-11-25T06:00:00+07:00");
const at = (sec) => T0 + sec * 1000;
const reading = (pnl, bin, binStep = 100) => G.readingGuardReading({ pnl_pct: pnl, active_bin: bin, bin_step: binStep, pnl_basis: "sol", pnl_management_ready: true });
const CTX = { suspect: false, peakRose: false, exitSignal: null, exitFired: null, capitalChange: false, capitalPendingAfter: false };
// [sec, pnl, bin, ctx?] → runs the pure step; returns the final { store, refEntry } and every event
function run(seq, { binStep = 100, store = null, refEntry = null } = {}) {
  const events = [];
  for (const [sec, pnl, bin, ctx] of seq) {
    const r = G.stepReadingGuard(store, refEntry, reading(pnl, bin, binStep), { ...CTX, ...(ctx || {}) }, at(sec));
    store = r.store; refEntry = r.refEntry;
    events.push(...r.events);
  }
  return { store, refEntry, events };
}

test("config: default shadow, no enforce, the four config lists", () => {
  assert.equal(config.management.readingGuardMode, "shadow");
  assert.equal(G.readingGuardMode({}), "shadow");
  assert.equal(G.readingGuardMode({ readingGuardMode: "off" }), "off");
  assert.equal(G.readingGuardMode({ readingGuardMode: "enforce" }), "shadow", "there is no enforce");
  assert.equal(G.readingGuardMode({ readingGuardMode: "bogus" }), "shadow");
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exe, /readingGuardMode: \["management", "readingGuardMode"\]/);
  assert.match(exe, /"readingGuardMode" && !\["off", "shadow"\]\.includes\(val\)/);
  assert.match(fs.readFileSync(new URL("../config.js", import.meta.url), "utf8"), /fresh\.readingGuardMode/);
  assert.match(fs.readFileSync(new URL("../tools/definitions.js", import.meta.url), "utf8"), /readingGuardMode/);
});

test("the explanation matches the held guard's decision (flagged ⇔ excess > 5 pp)", () => {
  for (const [refPnl, refBin, pnl, bin, bs] of [[12, 50, -37.27, 49, 100], [12, 50, -37.27, 49, 80], [7, -600, 58.93, -599, 100], [0, 0, -9, -10, 100], [0, 0, 9, 10, 100], [0, 0, 16, 10, 100], [5, 0, -20, 3, 100]]) {
    const ref = { pnl_pct: refPnl, bin: refBin, at: 0, seen_at: 0, unexplained_since: null };
    const held = advanceHeldReadingRef(ref, { pnl_pct: pnl, bin }, bs, 1000);
    const d = G.explainReadingMove(refPnl, refBin, pnl, bin, bs);
    const moved = Math.abs(pnl - refPnl) > 5;
    assert.equal(!held.plausible, moved && d.excess_pp > 5, `${refPnl}→${pnl} bins ${refBin}→${bin}`);
  }
});

test("Huss-SOL-style: +12 % → −37.27 % with the bin one lower → flagged down, trusted; reverted two readings later", () => {
  for (const bs of [80, 100]) {
    const { store, events } = run([[0, 11.5, -500], [5, 12.0, -500], [15, -37.27, -501], [20, -37.27, -501], [25, 11.9, -500]], { binStep: bs });
    assert.equal(store.episodes, 1);
    assert.equal(store.open, null);
    const ep = store.recent[0];
    assert.equal(ep.direction, "down");
    assert.equal(ep.from_pct, 12);
    assert.equal(ep.to_pct, -37.27);
    assert.equal(ep.bins_moved, -1);
    assert.ok(ep.explained_pp < 1.2, `explains ≈ 1 pp at bin step ${bs}`);
    assert.equal(ep.already_suspect, false, "the live drop guard lets it through (the bin fell)");
    assert.equal(ep.ended, "reverted");
    assert.equal(ep.duration_s, 10);
    assert.equal(ep.readings, 1, "a repeat valuation is one reading");
    assert.deepEqual(events.map((e) => e.type), ["start", "end"]);
    assert.equal(store.counts.reverted, 1);
    assert.equal(store.counts.trusted, 1);
  }
  const line = G.readingGuardStartLine("Huss-SOL", run([[0, 12, -500], [10, -37.27, -501]]).store.open);
  assert.equal(line, "[READING_GUARD_SHADOW] would-suspect Huss-SOL: PnL 12.00% → -37.27% while the price moved 1 bins down (explains at most 1.1 pp) — TRUSTED by the live path (readingGuardMode=shadow)");
});

test("JIMMY-SOL-style: 7 % → 58.93 % with the bin one higher → flagged up; flags and the end line", () => {
  const { store } = run([
    [0, 7.0, -600], [24, 58.93, -599, { suspect: true }], [30, 58.9, -599, { peakRose: true }],
    [45, 58.5, -599, { exitSignal: { action: "TAKE_PROFIT", family: "take_profit" } }], [64, 7.1, -600],
  ]);
  const ep = store.recent[0];
  assert.equal(ep.direction, "up");
  assert.equal(ep.from_pct, 7);
  assert.equal(ep.to_pct, 58.93, "the most extreme flagged reading");
  assert.equal(ep.bins_moved, 1);
  assert.equal(ep.already_suspect, false, "one flagged reading was trusted by the live path");
  assert.equal(ep.peak_confirmed, true);
  assert.equal(ep.exit_signal, "TAKE_PROFIT");
  assert.equal(ep.exit_signal_family, "take_profit");
  assert.equal(ep.exit_fired, null);
  assert.equal(ep.readings, 3);
  assert.equal(ep.ended, "reverted");
  assert.equal(store.counts.trusted_effect, 1);
  assert.equal(G.readingGuardEndLine("JIMMY-SOL", ep), "[READING_GUARD_SHADOW] JIMMY-SOL: episode ended reverted after 40s; peak_confirmed=true, exit_signal=TAKE_PROFIT, exit_fired=null");
  const allSuspect = run([[0, 7.0, -600], [24, 58.93, -599, { suspect: true }], [30, 7, -600]]).store.recent[0];
  assert.equal(allSuspect.already_suspect, true, "every flagged reading suspect → already_suspect");
});

test("a real dump and a real rally are never flagged", () => {
  const dump = run([[0, 0, 0], [5, -3, -3], [10, -9, -10], [15, -14, -16], [20, -20, -23]]);
  assert.equal(dump.store, null, "PnL falls with the bins, within the explained drop");
  const rally = run([[0, 0, 0], [5, 4, 4], [10, 9, 10], [15, 15, 16]]);
  assert.equal(rally.store, null);
  const small = run([[0, 0, 0], [5, -4.9, 0], [10, 0, 0]]);
  assert.equal(small.store, null, "≤ 5 pp is always plausible");
});

test("persistence: a flagged level that stands 15 min is accepted (persisted)", () => {
  const { store, refEntry } = run([[0, 2, 100], [10, -30, 100], [300, -30.1, 100], [600, -30.2, 100], [910, -30.2, 100]]);
  assert.equal(store.recent[0].ended, "persisted");
  assert.equal(store.recent[0].duration_s, 900);
  assert.equal(refEntry.ref.pnl_pct, -30.2, "the accepted reading is the new reference");
  // no reading for > 10 min drops the reference: the open episode ends unresolved
  const gap = run([[0, 2, 100], [10, -30, 100], [10 + 601, -30, 100]]);
  assert.equal(gap.store.recent[0].ended, "unresolved");
});

test("capital change: the episode ends capital_rebase, the reference is dropped until the re-base settles", () => {
  let r = run([[0, 7, -600], [10, 40, -599]]);
  assert.ok(r.store.open);
  let s = G.stepReadingGuard(r.store, r.refEntry, reading(20, -599), { ...CTX, capitalChange: true, capitalPendingAfter: true }, at(20));
  assert.equal(s.store.recent[0].ended, "capital_rebase");
  assert.equal(s.refEntry, null);
  assert.equal(s.changed, true);
  // next reading still pending → nothing seeded; then the settle reading starts a new reference
  s = G.stepReadingGuard(s.store, s.refEntry, reading(8, -599), { ...CTX, capitalChange: true, capitalPendingAfter: true }, at(25));
  assert.equal(s.refEntry, null);
  s = G.stepReadingGuard(s.store, s.refEntry, reading(8, -599), { ...CTX, capitalChange: true, capitalPendingAfter: false }, at(30));
  assert.equal(s.refEntry.ref.pnl_pct, 8);
  assert.equal(s.store.counts.capital_rebase, 1);
  // readingGuardContext: amount_sol moved, or a re-base pending before / after
  const c = G.readingGuardContext({ peak_pnl_pct: 2, amount_sol: 0.3, capital_rebase_pending: false }, { peak_pnl_pct: 2, amount_sol: 0.65, capital_rebase_pending: true }, {});
  assert.equal(c.capitalChange, true);
  assert.equal(c.suspect, true);
  assert.equal(G.readingGuardContext({ peak_pnl_pct: 2, amount_sol: 0.3 }, { peak_pnl_pct: 2.5, amount_sol: 0.3 }, {}).peakRose, true);
});

test("unusable readings neither count nor reset", () => {
  assert.equal(G.readingGuardReading({ pnl_pct: 1, active_bin: 1, bin_step: 100, pnl_management_ready: false }).ok, false);
  assert.equal(G.readingGuardReading({ pnl_pct: 1, active_bin: 1, bin_step: 100, pnl_basis: "usd" }).ok, false);
  assert.equal(G.readingGuardReading({ pnl_pct: null, active_bin: 1, bin_step: 100 }).ok, false);
  assert.equal(G.readingGuardReading({ pnl_pct: 1, active_bin: null, bin_step: 100 }).ok, false);
  assert.equal(G.readingGuardReading({ pnl_pct: 1, active_bin: 1 }).ok, false, "no bin step → the guard stays out");
  assert.equal(G.readingGuardReading({ pnl_pct: 1, active_bin: 1 }, { bin_step: 80 }).ok, true, "bin step from the tracked row");
  const r = run([[0, 12, 0], [10, -37, -1]]);
  const s = G.stepReadingGuard(r.store, r.refEntry, { ok: false }, CTX, at(20));
  assert.ok(s.store.open, "still open");
  assert.equal(s.refEntry, r.refEntry);
  assert.equal(s.changed, false);
});

test("exit flags: management exits are signal + fire; poller registration stale does not advance", () => {
  const exit = { action: "STOP_LOSS", family: "stop_loss" };
  const m = G.readingGuardContext({}, {}, {}, { exit, source: "management" });
  assert.deepEqual([m.exitSignal?.action, m.exitFired?.action], ["STOP_LOSS", "STOP_LOSS"]);
  const p1 = G.readingGuardContext({}, {}, {}, { exit, registration: { action: "STOP_LOSS", count: 1, fire: false }, source: "poller" });
  assert.deepEqual([p1.exitSignal?.action, p1.exitFired], ["STOP_LOSS", null]);
  const p2 = G.readingGuardContext({}, {}, {}, { exit, registration: { action: "STOP_LOSS", count: 1, fire: false, stale: true }, source: "poller" });
  assert.equal(p2.exitSignal, null);
  const p3 = G.readingGuardContext({}, {}, {}, { exit, registration: { action: "STOP_LOSS", count: 2, fire: true }, source: "poller" });
  assert.equal(p3.exitFired.family, "stop_loss");
  // a persisted episode with a stop-class signal is counted for check 3
  const { store } = run([[0, 2, 100], [10, -30, 100, { exitSignal: exit }], [600, -30, 100], [910, -30.1, 100]]);
  assert.equal(store.counts.persisted, 1);
  assert.equal(store.counts.persisted_stop_class, 1);
});

test("at most 6 episodes are kept; counts keep the total", () => {
  const seq = [[0, 0, 0]];
  for (let i = 0; i < 8; i++) seq.push([10 + i * 20, -30, 0], [20 + i * 20, 0, 0]);
  const { store } = run(seq);
  assert.equal(store.episodes, 8);
  assert.equal(store.recent.length, 6);
  assert.equal(store.counts.reverted, 8);
});

// ── through the real state functions: the shadow changes no live field and no exit ────────────

const realNow = Date.now;
let clock = realNow();
const mgmt = {
  trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5,
  stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 60, harvestStraddleGraceMinutes: 60,
  graceShadowEnabled: true, graceLockShadowMode: "shadow", readingGuardMode: "shadow",
};
const row = (pnl, bin) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: bin, lower_bin: -700, upper_bin: -400, bin_step: 100, pnl_basis: "sol", pnl_management_ready: true, pnl_quality: "valid" });
let seq = 0;
const made = [];
const mk = (tag) => {
  const a = `TEST_READING_GUARD_${tag}_${realNow()}_${seq++}`;
  S.trackPosition({ position: a, pool: "POOL_RG", pool_name: "RG-SOL", amount_sol: 1, initial_value_usd: 1, strategy: "spot", bin_range: { min: -700, max: -400 }, active_bin: -500, bin_step: 100 });
  made.push(a);
  return a;
};
const pos = (a) => S.getTrackedPosition(a);
// The poller's order: snapshot → confirmPeak → evaluator → registerExitSignal → the guard.
const read = (a, sec, pnl, bin, cfg, fresh = true) => {
  clock = at(sec);
  const p = row(pnl, bin);
  const before = G.readingGuardSnapshot(pos(a), cfg);
  if (fresh) S.confirmPeak(a, pnl, 2);
  const exit = S.updatePnlAndCheckExits(a, p, cfg);
  const registration = S.registerExitSignal(a, exit?.action ?? null, exit?.confirm_ticks ?? 2, null, { fresh });
  S.noteReadingGuardReading(a, p, { before, suspect: false, exit, registration, source: "poller" }, cfg);
  return { exit, fire: registration.fire };
};
const strip = (p) => {
  const o = { ...p };
  for (const k of ["position", "reading_guard_shadow"]) delete o[k];
  return JSON.stringify(o, (k, v) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Math.abs(Date.parse(v) - realNow()) < 600_000 ? "<wall clock>" : v));
};
// Huss-like false drop (starts a stop-loss signal), JIMMY-like spike (confirms a peak, arms
// trailing; the revert then fires trailing TP), a real dump to the stop.
const LIVE_SEQ = [
  [0, 1.0, -500], [5, 1.2, -500], [10, 1.1, -500],
  [15, -37.27, -501], [20, 1.0, -500],
  [30, 1.5, -500], [35, 7.0, -499], [40, 7.0, -499, false], [45, 58.93, -498], [50, 58.9, -498], [55, 7.1, -499], [60, 7.0, -499],
  [120, 3, -502], [125, -6, -511], [130, -12, -518], [135, -16, -522], [140, -17, -523],
];

test("the shadow changes no live field and no exit (same sequence with readingGuardMode off)", () => {
  Date.now = () => clock;
  const on = mk("ON"), off = mk("OFF");
  const cfgOff = { ...mgmt, readingGuardMode: "off" };
  try {
    const exits = [];
    for (const [t, v, b, fresh = true] of LIVE_SEQ) {
      const a = read(on, t, v, b, mgmt, fresh), c = read(off, t, v, b, cfgOff, fresh);
      assert.deepEqual(a, c, `exit at ${t}`);
      assert.equal(strip(pos(on)), strip(pos(off)), `every other field at ${t}`);
      if (a.exit) exits.push([t, a.exit.action, a.fire]);
    }
    assert.ok(exits.some(([, act]) => act === "STOP_LOSS"), `the live stop loss signals (${JSON.stringify(exits)})`);
    assert.equal(pos(off).reading_guard_shadow, undefined, "mode off: the field stays absent");
    const s = pos(on).reading_guard_shadow;
    assert.equal(s.episodes, 2, JSON.stringify(s));
    const [huss, jimmy] = s.recent;
    assert.equal(huss.direction, "down");
    assert.equal(huss.exit_signal, "STOP_LOSS", "the false drop started a stop-loss signal");
    assert.equal(huss.exit_signal_family, "stop_loss");
    assert.equal(huss.exit_fired, null);
    assert.equal(huss.ended, "reverted");
    assert.equal(jimmy.direction, "up");
    assert.equal(jimmy.peak_confirmed, true, "the spike confirmed a peak");
    assert.equal(jimmy.ended, "reverted");
    assert.equal(s.open, null, "the real dump is never flagged");
    // perf record carries the field (null without an episode)
    const rec = (tracked) => buildPerfRecord({ source: "closed_api", tracked, close: { position: "x", pool: "y", pool_name: "z", minutes_held: 10, minutes_oor: 0 } });
    assert.equal(rec(pos(on)).reading_guard_shadow.episodes, 2);
    assert.equal(rec(pos(off)).reading_guard_shadow, null);
  } finally { Date.now = realNow; }
});

test("hold ends an open episode `hold`; a close ends it `closed` (record and state)", () => {
  Date.now = () => clock;
  try {
    const h = mk("HOLD"), h2 = mk("HOLD2");
    for (const a of [h, h2]) { read(a, 200, 2, -500, a === h ? mgmt : { ...mgmt, readingGuardMode: "off" }); read(a, 205, -30, -500, a === h ? mgmt : { ...mgmt, readingGuardMode: "off" }); }
    assert.ok(pos(h).reading_guard_shadow.open);
    S.setPositionHold(h, true, "test"); S.setPositionHold(h2, true, "test");
    assert.equal(pos(h).reading_guard_shadow.recent[0].ended, "hold");
    assert.equal(strip(pos(h)), strip(pos(h2)));
    assert.equal(G._readingGuardRef(h), null, "reference dropped");
    // held readings are not fed
    S.noteReadingGuardReading(h, row(-50, -500), { before: G.readingGuardSnapshot(pos(h), mgmt), source: "poller" }, mgmt);
    assert.equal(pos(h).reading_guard_shadow.episodes, 1);

    const c = mk("CLOSE");
    read(c, 300, 2, -500, mgmt); read(c, 305, -30, -500, mgmt);
    const field = G.readingGuardRecordField(pos(c), at(320));
    assert.equal(field.recent[0].ended, "closed");
    assert.equal(field.recent[0].duration_s, 15);
    assert.ok(pos(c).reading_guard_shadow.open, "the record helper does not mutate the position");
    S.noteReadingGuardClosed(c);
    assert.ok(pos(c).reading_guard_shadow.open, "not closed yet → kept");
    S.recordClose(c, "test");
    S.noteReadingGuardClosed(c);
    assert.equal(pos(c).reading_guard_shadow.recent[0].ended, "closed");
  } finally { Date.now = realNow; }
});

test("wiring: both non-held call sites feed the guard around the live path", () => {
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /const valuation = assessValuation\(p\);\n\s*const rgBefore = readingGuardBefore\(p\);[^\n]*\n\s*if \(!valuation\.suspect\) confirmPeak\(p\.position, p\.pnl_pct, 1\);[\s\S]{0,400}const exit = await applyExitGates\(p, updatePnlAndCheckExits\(p\.position, p, config\.management\)\);\n\s*readingGuardAfter\(p, rgBefore, valuation, \{ exit, source: "management" \}\);/);
  assert.match(idx, /const valuation = assessValuation\(p\);\n\s*const rgBefore = readingGuardBefore\(p\);[^\n]*\n\s*if \(valuation\.fresh && !valuation\.suspect\) confirmPeak\(p\.position, p\.pnl_pct, confirmTicks\);/);
  assert.match(idx, /const registration = registerExitSignal\([^\n]*\);\n\s*readingGuardAfter\(p, rgBefore, valuation, \{ exit, registration, source: "poller" \}\);/);
  assert.match(idx, /function clearPriceHistory\(positionAddress\) \{[\s\S]*?noteReadingGuardClosed\(positionAddress\);[\s\S]*?\n\}/);
  const pr = fs.readFileSync(new URL("../perf-record.js", import.meta.url), "utf8");
  assert.equal((pr.match(/reading_guard_shadow: readingGuardRecordField\(tracked\)/g) || []).length, 1);
});

test("no rule module reads reading_guard_shadow", () => {
  const root = new URL("..", import.meta.url).pathname;
  const files = [
    ...fs.readdirSync(root).filter((f) => f.endsWith(".js")),
    ...fs.readdirSync(path.join(root, "tools")).filter((f) => f.endsWith(".js")).map((f) => path.join("tools", f)),
  ];
  const allowed = new Set(["reading-guard-shadow.js", "perf-record.js"]);
  for (const f of files) {
    if (allowed.has(f)) continue;
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!src.includes("reading_guard_shadow"), `${f} must not read reading_guard_shadow`);
  }
});

test.after(() => {
  Date.now = realNow;
  for (const a of made) { try { S.recordClose(a, "test"); } catch {} }
});
