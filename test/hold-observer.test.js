/**
 * The two hold branches (hold-observer.js) — what each makes of one reading of a position on HOLD.
 *
 * Characterization: test/fixtures/hold-observer.json holds, per case, the SEQUENCE of calls the
 * PnL poller's hold branch and the management cycle's hold branch (exit loop, then — when no
 * exit — the action loop's hold block) made on the code as it was in index.js (moved verbatim
 * into hold-observer.js), with stubbed state functions: function name + the arguments that
 * matter, every log line and every Telegram text. Regenerate (only on purpose):
 *   HOLD_OBSERVER_WRITE=1 node test/hold-observer.test.js
 */
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const HO = await import("../hold-observer.js");
const { tagPair } = await import("../owner-tag.js");
const { escapeHTML, fmtPct } = await import("../telegram.js");

const FIXTURE = new URL("./fixtures/hold-observer.json", import.meta.url);

const P = (o = {}) => ({ position: "POS_A", pool: "POOL_A", pair: "SIB-SOL", pnl_pct: 3.1, active_bin: -370, pnl_management_ready: true, pnl_pct_suspicious: false, ...o });
const T = (o = {}) => ({ position: "POS_A", pool_name: "SIB-SOL", hold_mode: true, adopted: true, amount_sol: 1.4679, ...o });
const QUIET_GB = { alert: false, reset: false };
const NO_HV = { would_close: false };
const THIN_EXIT = { action: "HOLD_THIN_LIMIT", rule: "hold_limit", family: "hold_limit", urgent: true, hold_override: "hold_limit", reason: "Thin-pool hold limit: PnL -26.10% at or under -25% for 65s on a held position (pool TVL at entry $42,623, under $100,000) — hard exit (overrides HOLD)" };

// Each case: the reading, the tracked position, and what the stubbed state functions answer.
const CASES = [
  { name: "trusted_quiet", p: P(), tracked: T(), gb: QUIET_GB, hv: NO_HV },
  { name: "not_management_ready", p: P({ pnl_management_ready: false, pnl_pct: -4 }), tracked: T(), gb: QUIET_GB, hv: NO_HV },
  { name: "suspicious", p: P({ pnl_pct_suspicious: true, pnl_pct: 22 }), tracked: T(), gb: QUIET_GB, hv: NO_HV },
  { name: "new_held_high", p: P({ pnl_pct: 14.8 }), tracked: T({ hold_peak_pnl_pct: 14.6 }), gb: QUIET_GB, hv: NO_HV },
  { name: "giveback_10pp", p: P({ pnl_pct: 4.6 }), tracked: T({ hold_peak_pnl_pct: 14.8 }),
    gb: { alert: true, reset: false, drop_pp: 10.2, level_pp: 10, peak: 14.8, current: 4.6 }, hv: NO_HV },
  { name: "giveback_20pp_bot_no_amount_html_pair", p: P({ pair: "A<B>-SOL", pnl_pct: -5.3 }), tracked: T({ adopted: false, amount_sol: 0 }),
    gb: { alert: true, reset: false, drop_pp: 20.1, level_pp: 20, peak: 14.8, current: -5.3 }, hv: NO_HV },
  { name: "giveback_reset", p: P({ pnl_pct: 12 }), tracked: T({ hold_giveback_alert_pp: 10 }),
    gb: { alert: false, reset: true, drop_pp: 2.8, level_pp: 0, peak: 14.8, current: 12 }, hv: NO_HV },
  { name: "downside_stop_thin_first", p: P({ pair: "FACTORY-SOL", pnl_pct: -15.4 }), tracked: T({ entry_tvl: 42622.68, hold_downside_shadow: { held_minutes_at_fire: 42 } }),
    gb: QUIET_GB, hv: { would_close: true, rule: "stop_loss", threshold_pct: -15, pnl_pct: -15.4 }, downsideFirst: true },
  { name: "downside_young_alert_off_mode_shadow", p: P({ pair: "CRAWL-SOL", pnl_pct: -10.5 }), tracked: T({ entry_tvl: 336184, hold_downside_shadow: { held_minutes_at_fire: null } }),
    gb: QUIET_GB, hv: { would_close: true, rule: "young_stop", threshold_pct: -10, pnl_pct: -10.5 }, downsideFirst: true,
    cfg: { holdDownsideMode: "shadow", holdDownsideAlertEnabled: false } },
  { name: "downside_repeat", p: P({ pnl_pct: -17 }), tracked: T({ hold_downside_shadow: { held_minutes_at_fire: 42 } }),
    gb: QUIET_GB, hv: { would_close: true, rule: "stop_loss", threshold_pct: -15, pnl_pct: -17 }, downsideFirst: false },
  { name: "downside_and_giveback_same_reading", p: P({ pnl_pct: -15.6 }), tracked: T({ hold_downside_shadow: { held_minutes_at_fire: 7 } }),
    gb: { alert: true, reset: false, drop_pp: 30.4, level_pp: 30, peak: 14.8, current: -15.6 },
    hv: { would_close: true, rule: "stop_loss", threshold_pct: -15, pnl_pct: -15.6 }, downsideFirst: true },
  { name: "thin_limit_confirmed", p: P({ pair: "FACTORY-SOL", pnl_pct: -26.1 }), tracked: T({ entry_tvl: 42622.68 }),
    gb: QUIET_GB, hv: { would_close: true, rule: "stop_loss", threshold_pct: -15, pnl_pct: -26.1 }, downsideFirst: false, thinExit: THIN_EXIT },
  { name: "throw_held_high", p: P({ pnl_pct: 4.6 }), tracked: T(), gb: { alert: true, reset: false, drop_pp: 10.2, level_pp: 10, peak: 14.8, current: 4.6 }, hv: NO_HV, throwOn: "noteHoldPeakReading" },
  { name: "throw_path", p: P({ pnl_pct: 4.6 }), tracked: T(), gb: { alert: true, reset: false, drop_pp: 10.2, level_pp: 10, peak: 14.8, current: 4.6 }, hv: NO_HV, throwOn: "noteHoldPathReading" },
  { name: "throw_giveback_eval", p: P({ pnl_pct: -16 }), tracked: T({ hold_downside_shadow: { held_minutes_at_fire: 3 } }), gb: QUIET_GB,
    hv: { would_close: true, rule: "stop_loss", threshold_pct: -15, pnl_pct: -16 }, downsideFirst: true, throwOn: "evaluateHoldGiveBack" },
  { name: "throw_downside_eval", p: P({ pnl_pct: -16 }), tracked: T(), gb: QUIET_GB, hv: NO_HV, throwOn: "evaluateHoldDownside" },
];

/** Stubbed dependencies that record every call (name + the arguments that matter). */
function makeDeps(c, calls) {
  const tag = (v) => (v === c.p ? "<p>" : v === c.tracked ? "<tracked>" : v === c.cfgObj ? "<cfg>" : v);
  const rec = (name, fn) => (...args) => {
    calls.push([name, ...args.map(tag)]);
    if (c.throwOn === name) throw new Error(`${name} failed`);
    return fn ? fn(...args) : undefined;
  };
  return {
    registerExitSignal: rec("registerExitSignal"),
    forgetValuationReference: rec("forgetValuationReference"),
    noteHoldPeakReading: rec("noteHoldPeakReading", () => ({ changed: true })),
    noteHoldPathReading: rec("noteHoldPathReading", () => true),
    recordTick: rec("recordTick"),
    checkHoldThinLimit: rec("checkHoldThinLimit", () => c.thinExit ?? null),
    evaluateHoldGiveBack: rec("evaluateHoldGiveBack", () => c.gb),
    noteHoldGiveBackAlert: rec("noteHoldGiveBackAlert", () => true),
    evaluateHoldDownside: rec("evaluateHoldDownside", () => c.hv),
    noteHoldDownsideShadow: rec("noteHoldDownsideShadow", () => c.downsideFirst === true),
    getTrackedPosition: () => c.tracked, // a read, not recorded
    holdDownsideAlertText: (a) => {
      calls.push(["holdDownsideAlertText", { ...a, tracked: tag(a.tracked), mgmt: tag(a.mgmt), owner: tag(a.owner) }]);
      return `ALERT_B ${a.pair} ${a.verdict.rule} ${a.heldMin}`;
    },
    sendHTML: (text) => { calls.push(["sendHTML", text]); return Promise.resolve(); },
    log: (t, msg) => { calls.push(["log", t, msg]); },
    tagPair, escapeHTML, fmtPct,
  };
}

const prep = (c) => { c.cfgObj = { ...(c.cfg || {}) }; return c; };

/** The poller's hold branch on one reading (confirmTicks 2). */
function runPollerOld(c) {
  const calls = [];
  const exit = HO.observeHeldPositionPoller(c.p, { confirmTicks: 2, deps: makeDeps(c, calls) });
  return { calls, exit };
}

/** The management cycle on one reading: exit-loop hold branch, then (no exit) the action-loop hold block. */
function runManagementOld(c) {
  const calls = [];
  const deps = makeDeps(c, calls);
  const exit = HO.observeHeldPositionManagementExit(c.p, { deps });
  if (!exit) HO.observeHeldPositionManagementAlerts(c.p, deps.getTrackedPosition(c.p.position), { cfg: c.cfgObj, deps });
  return { calls, exit };
}

const json = (v) => JSON.parse(JSON.stringify(v));
const observe = () => ({ cases: CASES.map((c0) => { const c = prep(structuredClone({ ...c0, cfgObj: undefined })); return { name: c.name, poller: json(runPollerOld(c)), management: json(runManagementOld(c)) }; }) });

if (process.env.HOLD_OBSERVER_WRITE === "1") {
  fs.mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify(observe(), null, 2) + "\n");
  console.log("wrote", FIXTURE.pathname);
}

const FIX = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

test("fixture covers every case, and the cases cover the readings that matter", () => {
  assert.deepEqual(FIX.cases.map((c) => c.name), CASES.map((c) => c.name));
  const mg = Object.fromEntries(FIX.cases.map((c) => [c.name, c.management]));
  const texts = FIX.cases.flatMap((c) => c.management.calls).filter((x) => x[0] === "log").map((x) => x[2]);
  assert.ok(texts.some((t) => t.startsWith("[HOLD_GIVEBACK] SIB-SOL: peak 14.80% → now 4.60% (−10.2 pp, ≈◎0.150 unrealised)")));
  assert.ok(texts.some((t) => t.startsWith("[HOLD_DOWNSIDE_SHADOW] would-close FACTORY-SOL: stop loss -15.40% <= -15% (42 min into the hold)")));
  assert.ok(mg.thin_limit_confirmed.exit && mg.thin_limit_confirmed.exit.action === "HOLD_THIN_LIMIT");
  assert.ok(!mg.not_management_ready.calls.some((x) => x[0] === "noteHoldPeakReading"), "held high gated on a trusted reading");
});

test("characterization: the two hold branches reproduce the fixture", () => {
  const now = observe();
  for (const [i, c] of FIX.cases.entries()) {
    assert.deepEqual(now.cases[i].poller, c.poller, `poller ${c.name}`);
    assert.deepEqual(now.cases[i].management, c.management, `management ${c.name}`);
  }
});
