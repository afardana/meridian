/**
 * observeHeldPosition (hold-observer.js) — what the bot makes of one reading of a position on HOLD.
 *
 * Characterization: test/fixtures/hold-observer.json holds, per case, the SEQUENCE of calls the
 * PnL poller's hold branch and the management cycle's hold branch (exit loop, then — when no
 * exit — the action loop's hold block) made on a053f88, where the two hand-copied branches had
 * been moved verbatim out of index.js, with stubbed state functions: function name + the
 * arguments that matter, every log line and every Telegram text. The fixture is frozen (the
 * old functions are gone); the unified function must reproduce it, apart from:
 *   (a) management: the held-high and path readings run BEFORE the thin-pool limit check (the
 *       poller's order) instead of after it in the action loop — so they are also recorded on
 *       the reading on which the limit fires (they were skipped then). Record-only fields; the
 *       limit reads neither.
 *   (b) THE behaviour change: management wraps those two record-only calls in their own silent
 *       try/catch, as the poller always did. Before, they shared the give-back alert's try, so a
 *       throw there skipped the path reading and the give-back alert and logged a
 *       `[HOLD_GIVEBACK] <pair>: <error>` warning; now the alert still runs and nothing is logged.
 * Everything else — call order, arguments, log and Telegram text — is identical.
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
function runPoller(c) {
  const calls = [];
  const exit = HO.observeHeldPosition(c.p, c.tracked, { source: "poller", confirmTicks: 2, deps: makeDeps(c, calls) });
  return { calls, exit };
}

/** The management cycle's hold branch on one reading. */
function runManagement(c) {
  const calls = [];
  const exit = HO.observeHeldPosition(c.p, c.tracked, { source: "management", cfg: c.cfgObj, deps: makeDeps(c, calls) });
  return { calls, exit };
}

const json = (v) => JSON.parse(JSON.stringify(v));
const observe = () => ({ cases: CASES.map((c0) => { const c = prep(structuredClone({ ...c0, cfgObj: undefined })); return { name: c.name, poller: json(runPoller(c)), management: json(runManagement(c)) }; }) });

const FIX = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const NOW = observe();
const names = (calls) => calls.map((x) => x[0]);
const RECORD_ONLY = new Set(["noteHoldPeakReading", "noteHoldPathReading"]);

/**
 * Drift (a): the old management sequence with the held-high / path calls moved to just before
 * checkHoldThinLimit. The calls themselves are the ones the poller made on the same reading
 * (same gate, same arguments) — which is what the old management code made, too, when it got there.
 */
function reorderedManagement(fx) {
  const core = fx.poller.calls.filter((x) => RECORD_ONLY.has(x[0]));
  const rest = fx.management.calls.filter((x) => !RECORD_ONLY.has(x[0]));
  const at = rest.findIndex((x) => x[0] === "checkHoldThinLimit");
  assert.ok(at > 0);
  return { calls: [...rest.slice(0, at), ...core, ...rest.slice(at)], exit: fx.management.exit };
}

// Drift (b): a throw in a record-only call. Expected management sequences, written out.
const SUPPRESSED = ["registerExitSignal", "forgetValuationReference", "log", "noteHoldPeakReading", "noteHoldPathReading", "checkHoldThinLimit"];
const GIVEBACK_ALERT = ["evaluateHoldGiveBack", "noteHoldGiveBackAlert", "log", "sendHTML"];
const DRIFT_THROW = {
  throw_held_high: [...SUPPRESSED, ...GIVEBACK_ALERT, "evaluateHoldDownside", "noteHoldDownsideShadow"],
  throw_path: [...SUPPRESSED, ...GIVEBACK_ALERT, "evaluateHoldDownside", "noteHoldDownsideShadow"],
};

test("fixture covers every case, and the cases cover the readings that matter", () => {
  assert.deepEqual(FIX.cases.map((c) => c.name), CASES.map((c) => c.name));
  const mg = Object.fromEntries(FIX.cases.map((c) => [c.name, c.management]));
  const texts = FIX.cases.flatMap((c) => c.management.calls).filter((x) => x[0] === "log").map((x) => x[2]);
  assert.ok(texts.some((t) => t.startsWith("[HOLD_GIVEBACK] SIB-SOL: peak 14.80% → now 4.60% (−10.2 pp, ≈◎0.150 unrealised)")));
  assert.ok(texts.some((t) => t.startsWith("[HOLD_DOWNSIDE_SHADOW] would-close FACTORY-SOL: stop loss -15.40% <= -15% (42 min into the hold)")));
  assert.ok(mg.thin_limit_confirmed.exit && mg.thin_limit_confirmed.exit.action === "HOLD_THIN_LIMIT");
  assert.ok(!mg.not_management_ready.calls.some((x) => x[0] === "noteHoldPeakReading"), "held high gated on a trusted reading");
});

test("poller: identical to the characterization, every case", () => {
  for (const [i, c] of FIX.cases.entries()) assert.deepEqual(NOW.cases[i].poller, c.poller, `poller ${c.name}`);
});

test("management: identical to the characterization apart from the reorder (a)", () => {
  for (const [i, c] of FIX.cases.entries()) {
    if (DRIFT_THROW[c.name]) continue;
    assert.deepEqual(NOW.cases[i].management, reorderedManagement(c), `management ${c.name}`);
  }
  // the reorder is visible exactly where expected: before, the thin-limit check came first ...
  const fx = FIX.cases.find((c) => c.name === "trusted_quiet").management.calls.map((x) => x[0]);
  assert.ok(fx.indexOf("checkHoldThinLimit") < fx.indexOf("noteHoldPeakReading"));
  // ... and on the reading where the limit fires, the record-only readings were skipped; now they run
  const fired = FIX.cases.find((c) => c.name === "thin_limit_confirmed");
  assert.deepEqual(names(fired.management.calls), ["registerExitSignal", "forgetValuationReference", "log", "checkHoldThinLimit"]);
  assert.deepEqual(names(NOW.cases.find((c) => c.name === "thin_limit_confirmed").management.calls),
    ["registerExitSignal", "forgetValuationReference", "log", "noteHoldPeakReading", "noteHoldPathReading", "checkHoldThinLimit"]);
  assert.equal(NOW.cases.find((c) => c.name === "thin_limit_confirmed").management.exit.action, "HOLD_THIN_LIMIT");
});

test("management, the one behaviour change (b): a throwing record-only tracker no longer skips the give-back alert", () => {
  for (const [name, expected] of Object.entries(DRIFT_THROW)) {
    const before = FIX.cases.find((c) => c.name === name).management.calls;
    const now = NOW.cases.find((c) => c.name === name).management.calls;
    // before: the throw was caught by the give-back try — warning logged, no give-back alert
    assert.ok(before.some((x) => x[0] === "log" && x[1] === "hold_giveback_warn" && x[2] === `[HOLD_GIVEBACK] SIB-SOL: ${name === "throw_held_high" ? "noteHoldPeakReading" : "noteHoldPathReading"} failed`), name);
    assert.ok(!before.some((x) => x[0] === "sendHTML"), name);
    // now: silent catch (as the poller), the alert runs with the same text as on a clean reading
    assert.deepEqual(names(now), expected, name);
    assert.ok(!now.some((x) => x[1] === "hold_giveback_warn"), name);
    const clean = NOW.cases.find((c) => c.name === "giveback_10pp").management.calls.filter((x) => x[0] === "log" || x[0] === "sendHTML");
    assert.deepEqual(now.filter((x) => x[0] === "log" || x[0] === "sendHTML"), clean, name);
  }
  // a throw INSIDE the give-back alert still logs the warning and still lets the downside shadow run
  const gbThrow = NOW.cases.find((c) => c.name === "throw_giveback_eval").management.calls;
  assert.ok(gbThrow.some((x) => x[0] === "log" && x[2] === "[HOLD_GIVEBACK] SIB-SOL: evaluateHoldGiveBack failed"));
  assert.ok(gbThrow.some((x) => x[0] === "log" && x[1] === "hold_downside_shadow"));
});

test("source is checked; the poller makes none of the management-only calls", () => {
  const c = prep(structuredClone(CASES[0]));
  assert.throws(() => HO.observeHeldPosition(c.p, c.tracked, { source: "cron", deps: makeDeps(c, []) }), /unknown source/);
  for (const k of NOW.cases) {
    const n = names(k.poller.calls);
    for (const m of ["evaluateHoldGiveBack", "noteHoldGiveBackAlert", "evaluateHoldDownside", "noteHoldDownsideShadow", "sendHTML", "log"]) assert.ok(!n.includes(m), `${k.name}: ${m}`);
    assert.ok(!names(k.management.calls).includes("recordTick"), k.name);
  }
});
