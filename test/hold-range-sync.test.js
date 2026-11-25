/**
 * Range sync on a HELD position (2026-11-25).
 *
 * The on-chain range sync / "External rebalance detected" block sat after the evaluator's HOLD
 * return, so a re-range the operator did in the Meteora UI while a position was held was never
 * recorded. JIMMY-SOL 9gH8jqU9 (held 18:53 -> 04:15 WIB): tracked range stayed -588..-519 while
 * the price was at bin -411, rebalance_count stayed 0, so the percent basis stayed on Meteora's
 * doubled deposits (live 11.69 % for a real 23.44 %) and the thin-pool hold limit's -25 % needed
 * a real -50 %. Now state.noteHoldRangeReading (called first from hold-observer's syncHeldCapital)
 * records it; the evaluator keeps its behaviour through the same extracted function.
 */
process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const S = await import("../state.js");
const HO = await import("../hold-observer.js");
await S.ensureStateInitialized();

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, stopLossPct: -15, holdGiveBackAlertPp: 10, adoptedProfitGraceMinutes: 0 };

// capture state-category log lines (logger writes to console.error)
const lines = [];
const origErr = console.error;
console.error = (...a) => { lines.push(a.join(" ")); };
const done = (P) => { try { S.recordClose(P, "test"); } catch { /* cleanup */ } };

let n = 0;
const mk = ({ hold = true, extra = {} } = {}) => {
  const P = `HOLDRNG_${Date.now()}_${++n}`;
  S.trackPosition({ position: P, pool: "POOL_JIMMY", pool_name: "JIMMY-SOL", strategy: "spot", amount_sol: 0.5, initial_value_usd: 35, bin_range: { min: -588, max: -519 }, active_bin: -540, bin_step: 100, entry_tvl: 40000, adopted: true });
  if (hold) S.setPositionHold(P, true);
  if (Object.keys(extra).length) {
    const st = S.getTrackedPosition(P);
    Object.assign(st, extra);
  }
  return P;
};
const row = (P, over = {}) => ({
  position: P, pool: "POOL_JIMMY", pair: "JIMMY-SOL", pnl_pct: 11.69, effective_pnl_pct: 11.69, in_range: true,
  active_bin: -430, lower_bin: -480, upper_bin: -411, pnl_quality: "valid", pnl_basis: "sol",
  pnl_management_ready: true, pnl_pct_suspicious: false, ...over,
});

test("a held position re-ranged in the UI: range, count, event; thin-limit state dropped; peak and trailing frozen", () => {
  const P = mk();
  try {
    const pos0 = S.getTrackedPosition(P);
    pos0.peak_pnl_pct = 7.5; pos0.trailing_active = true;
    pos0.hold_thin_limit = { ref: { pnl: 3 }, streak: { n: 1 } };
    lines.length = 0;
    const r = S.noteHoldRangeReading(P, row(P), mgmt);
    assert.deepEqual(r, { rangeChanged: true });
    const pos = S.getTrackedPosition(P);
    assert.deepEqual({ min: pos.bin_range.min, max: pos.bin_range.max }, { min: -480, max: -411 });
    assert.equal(pos.rebalance_count, 1);
    assert.ok(pos.last_rebalanced_at);
    assert.equal(pos.hold_thin_limit, null);
    assert.equal(pos.peak_pnl_pct, 7.5, "peak frozen on HOLD");
    assert.equal(pos.trailing_active, true, "trailing untouched on HOLD");
    assert.equal(pos.hold_mode, true);
    assert.ok(Array.isArray(pos.rebalance_events) && pos.rebalance_events.length === 1);
    assert.ok(pos.notes.some((x) => x.includes("External rebalance detected: bins -588..-519 → -480..-411")));
    assert.ok(lines.some((l) => l.includes(`External rebalance detected for ${P}: -588..-519 → -480..-411 — position on HOLD (re-range count 1)`)), "HOLD log line");
    assert.ok(lines.some((l) => l.includes("[CAPITAL_BASIS] JIMMY-SOL: re-ranged on HOLD")), "capital basis log");
  } finally { done(P); }
});

test("count already >= 1: range updated, count +1, hold_thin_limit not touched, no basis log", () => {
  const P = mk({ extra: { rebalance_count: 1 } });
  try {
    const pos0 = S.getTrackedPosition(P);
    pos0.hold_thin_limit = { ref: { pnl: 3 }, streak: null };
    lines.length = 0;
    assert.deepEqual(S.noteHoldRangeReading(P, row(P), mgmt), { rangeChanged: true });
    const pos = S.getTrackedPosition(P);
    assert.equal(pos.rebalance_count, 2);
    assert.deepEqual(pos.hold_thin_limit, { ref: { pnl: 3 }, streak: null });
    assert.equal(pos.bin_range.max, -411);
    assert.ok(!lines.some((l) => l.includes("[CAPITAL_BASIS]")));
  } finally { done(P); }
});

test("straddled / in-place re-ranged position keeps its thin-limit state on the first counted re-range", () => {
  const P = mk({ extra: { straddle_count: 1 } });
  try {
    S.getTrackedPosition(P).hold_thin_limit = { ref: { pnl: 3 }, streak: null };
    S.noteHoldRangeReading(P, row(P), mgmt);
    assert.equal(S.getTrackedPosition(P).rebalance_count, 1);
    assert.notEqual(S.getTrackedPosition(P).hold_thin_limit, null);
  } finally { done(P); }
});

test("unchanged range, missing bins, not held, closed: nothing changes", () => {
  const P = mk();
  try {
    assert.deepEqual(S.noteHoldRangeReading(P, row(P, { lower_bin: -588, upper_bin: -519 }), mgmt), { rangeChanged: false });
    assert.equal(S.getTrackedPosition(P).rebalance_count || 0, 0);
    for (const bad of [{ lower_bin: null }, { upper_bin: undefined }, { lower_bin: "x" }, { upper_bin: NaN }]) {
      assert.deepEqual(S.noteHoldRangeReading(P, row(P, bad), mgmt), { rangeChanged: false });
    }
    const pos = S.getTrackedPosition(P);
    assert.deepEqual({ min: pos.bin_range.min, max: pos.bin_range.max }, { min: -588, max: -519 });
    assert.deepEqual(S.noteHoldRangeReading("NOPE", row("NOPE"), mgmt), { rangeChanged: false });
  } finally { done(P); }
  const Q = mk({ hold: false });
  try {
    assert.deepEqual(S.noteHoldRangeReading(Q, row(Q), mgmt), { rangeChanged: false });
    assert.equal(S.getTrackedPosition(Q).bin_range.min, -588);
  } finally { done(Q); }
  const R = mk();
  S.recordClose(R, "test");
  assert.deepEqual(S.noteHoldRangeReading(R, row(R), mgmt), { rangeChanged: false });
});

test("a row that is not management-ready still syncs the range", () => {
  const P = mk();
  try {
    assert.deepEqual(S.noteHoldRangeReading(P, row(P, { pnl_management_ready: false, pnl_quality: "extreme_divergence", pnl_pct: 315 }), mgmt), { rangeChanged: true });
    assert.equal(S.getTrackedPosition(P).bin_range.min, -480);
  } finally { done(P); }
});

test("hold observer: the range-change tick feeds no tracker and no limit check; a throw skips nothing else", () => {
  for (const source of ["poller", "management"]) {
    const calls = [];
    const logs = [];
    let rangeAnswer = { rangeChanged: true };
    const rec = (name, ret) => (...a) => { calls.push(name); return typeof ret === "function" ? ret(...a) : ret; };
    const deps = {
      registerExitSignal: rec("registerExitSignal"), forgetValuationReference: rec("forgetValuationReference"),
      noteHoldRangeReading: rec("noteHoldRangeReading", () => rangeAnswer),
      noteHoldCapitalReading: rec("noteHoldCapitalReading", { capitalChanged: false, settled: false, pending: false }),
      noteHoldPeakReading: rec("noteHoldPeakReading"), noteHoldPathReading: rec("noteHoldPathReading"), recordTick: rec("recordTick"),
      checkHoldThinLimit: rec("checkHoldThinLimit", null),
      evaluateHoldGiveBack: rec("evaluateHoldGiveBack", { alert: false, reset: false }), noteHoldGiveBackAlert: rec("noteHoldGiveBackAlert"),
      evaluateHoldDownside: rec("evaluateHoldDownside", { would_close: false }), noteHoldDownsideShadow: rec("noteHoldDownsideShadow", false),
      getTrackedPosition: rec("getTrackedPosition", null), holdDownsideAlertText: rec("holdDownsideAlertText", ""),
      sendHTML: rec("sendHTML", Promise.resolve()), log: (c, m) => logs.push(`${c} ${m}`), tagPair: (x) => x, escapeHTML: (x) => x, fmtPct: (x) => String(x),
    };
    const tracked = { position: "POS_X", pool_name: "JIMMY-SOL", hold_mode: true, amount_sol: 0.5 };
    assert.equal(HO.observeHeldPosition(row("POS_X"), tracked, { source, deps, cfg: mgmt, confirmTicks: 2 }), null);
    const expected = ["registerExitSignal", "forgetValuationReference", "noteHoldRangeReading", "noteHoldCapitalReading", ...(source === "poller" ? ["recordTick"] : [])];
    assert.deepEqual(calls, expected, `${source}: range-change tick`);

    // the next reading feeds everything again, range sync first
    calls.length = 0;
    rangeAnswer = { rangeChanged: false };
    HO.observeHeldPosition(row("POS_X"), tracked, { source, deps, cfg: mgmt, confirmTicks: 2 });
    assert.ok(calls.includes("noteHoldPeakReading") && calls.includes("noteHoldPathReading") && calls.includes("checkHoldThinLimit"), `${source}: feeds again`);
    assert.ok(calls.indexOf("noteHoldRangeReading") < calls.indexOf("noteHoldCapitalReading"), `${source}: range sync first`);

    // a throw in the range sync does not stop the capital sync or the rest
    calls.length = 0;
    deps.noteHoldRangeReading = () => { throw new Error("boom"); };
    HO.observeHeldPosition(row("POS_X"), tracked, { source, deps, cfg: mgmt, confirmTicks: 2 });
    assert.ok(calls.includes("noteHoldCapitalReading") && calls.includes("noteHoldPeakReading") && calls.includes("checkHoldThinLimit"), `${source}: survives a throw`);
    assert.ok(logs.some((l) => l.includes("[REBALANCE_EVENT] JIMMY-SOL: range sync on HOLD failed: boom")));
  }
});

test("non-held regression: the evaluator still records a re-range, re-bases the peak and logs as before", () => {
  const P = mk({ hold: false });
  try {
    const pos0 = S.getTrackedPosition(P);
    pos0.peak_pnl_pct = 4; pos0.trailing_active = false;
    lines.length = 0;
    S.updatePnlAndCheckExits(P, row(P, { pnl_pct: 1.25, effective_pnl_pct: 1.25 }), mgmt);
    const pos = S.getTrackedPosition(P);
    assert.equal(pos.rebalance_count, 1);
    assert.deepEqual({ min: pos.bin_range.min, max: pos.bin_range.max }, { min: -480, max: -411 });
    assert.equal(pos.peak_pnl_pct, 1.25, "peak re-based to the current reading");
    assert.ok(lines.some((l) => l.includes(`External rebalance detected for ${P}: -588..-519 → -480..-411 (peak PnL reset to 1.25%)`)));
    assert.ok(!lines.some((l) => l.includes("position on HOLD")));
  } finally { done(P); }
});

test.after(() => { console.error = origErr; });
