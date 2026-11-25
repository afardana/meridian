/**
 * Plausibility guard on held readings (hold-observer.js, 2026-11-25).
 *
 * JIMMY-SOL CYCbgJBm (held): the operator added ◎0.68 to a ◎1.34 position; until Meteora indexed
 * it the PnL counted the deposit as profit. Nine ticks of one valuation read 58.93 % (divergence
 * 49.33 pp, under the 50 pp flag limit) and became the held high; the capital re-base then scaled
 * it to 39.06 % and the give-back alert fired falsely. A +48 pp move on a 6-bin rise is not price.
 */
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import test from "node:test";
import assert from "node:assert/strict";

const HO = await import("../hold-observer.js");
const { advanceHeldReadingRef: adv, HELD_READING_PERSIST_MS, HELD_REF_STALE_MS } = HO;

const MIN = 60_000;
const T0 = 1_000_000_000_000;

function makeDeps(capital = () => ({ capitalChanged: false })) {
  const calls = [];
  const rec = (name, fn) => (...a) => { calls.push([name, ...a]); return fn ? fn(...a) : undefined; };
  const deps = {
    registerExitSignal: rec("registerExitSignal"),
    forgetValuationReference: rec("forgetValuationReference"),
    noteHoldCapitalReading: rec("noteHoldCapitalReading", capital),
    noteHoldPeakReading: rec("noteHoldPeakReading", () => ({ changed: true })),
    noteHoldPathReading: rec("noteHoldPathReading", () => true),
    recordTick: rec("recordTick"),
    checkHoldThinLimit: rec("checkHoldThinLimit", () => null),
    log: rec("log"),
  };
  return { deps, calls };
}
const row = (pnl, bin, over = {}) => ({ position: "POS_J", pool: "POOL_J", pair: "JIMMY-SOL", pnl_pct: pnl, active_bin: bin, bin_step: 100, pnl_management_ready: true, pnl_pct_suspicious: false, ...over });
const obs = (p, deps) => HO.observeHeldPosition(p, { position: "POS_J", amount_sol: 1.34 }, { source: "poller", deps, confirmTicks: 2 });
const peakFed = (calls, v) => calls.filter((c) => c[0] === "noteHoldPeakReading" && c[2] === v).length;
const pathFed = (calls, v) => calls.filter((c) => c[0] === "noteHoldPathReading" && c[2].pnl_pct === v).length;

function withClock(fn) {
  const real = Date.now;
  let now = T0;
  Date.now = () => now;
  try { return fn((ms) => { now = ms; }); } finally { Date.now = real; }
}

for (const step of [100, 80]) {
  test(`JIMMY replay (bin step ${step}): the unindexed-deposit reading never reaches the trackers`, () => {
    HO._resetHeldReadingRefs();
    withClock((setNow) => {
      let capChanged = false;
      const { deps, calls } = makeDeps(() => ({ capitalChanged: capChanged }));
      const feed = (t, p) => { setNow(T0 + t * 1000); obs({ ...p, bin_step: step }, deps); };
      feed(0, row(9.98, -396));
      feed(15, row(10.50, -391));
      feed(30, row(-85.14, -391, { pnl_management_ready: false }));
      feed(45, row(63.96, -391, { pnl_management_ready: false }));
      assert.equal(peakFed(calls, 10.5), 1);
      for (let i = 0; i < 9; i++) feed(120 + i * 5, row(58.93, -385)); // 40 s of one valuation
      assert.equal(peakFed(calls, 58.93), 0, "held high not fed");
      assert.equal(pathFed(calls, 58.93), 0, "path extremes not fed");
      const logs = calls.filter((c) => c[0] === "log" && String(c[2]).includes("[HOLD_READING]"));
      assert.equal(logs.length, 1, "one log line per episode");
      assert.match(logs[0][2], /JIMMY-SOL: PnL 10\.50% → 58\.93% while the price moved 6 bins up/);
      // the capital is booked: no tracker call, ref dropped
      capChanged = true;
      const before = calls.filter((c) => c[0] === "noteHoldPeakReading").length;
      feed(200, row(11.37, -385));
      assert.equal(calls.filter((c) => c[0] === "noteHoldPeakReading").length, before);
      capChanged = false;
      feed(205, row(11.37, -385));
      assert.equal(peakFed(calls, 11.37), 1, "fed normally once the re-base is done");
      assert.equal(pathFed(calls, 11.37), 1);
    });
  });
}

test("pure: a real rally is accepted, in one step and step by step", () => {
  let r = adv({ pnl_pct: 10, bin: -400, at: T0, seen_at: T0, unexplained_since: null }, { pnl_pct: 22, bin: -388 }, 100, T0 + 5000);
  assert.equal(r.plausible, true);
  let ref = { pnl_pct: 10, bin: -400, at: T0, seen_at: T0, unexplained_since: null };
  for (let i = 1; i <= 12; i++) {
    r = adv(ref, { pnl_pct: 10 + i, bin: -400 + i }, 100, T0 + i * 5000);
    assert.equal(r.plausible, true, `step ${i}`);
    ref = r.ref;
  }
});

test("pure: a real dump is accepted; an unexplained drop is rejected", () => {
  const ref = { pnl_pct: 20, bin: -380, at: T0, seen_at: T0, unexplained_since: null };
  assert.equal(adv(ref, { pnl_pct: -5, bin: -400 }, 100, T0 + 5000).plausible, true); // 20 bins down explains ~ 120*0.18
  const bad = adv(ref, { pnl_pct: -10, bin: -378 }, 100, T0 + 5000); // bin rose
  assert.equal(bad.plausible, false);
  assert.ok(bad.ref.unexplained_since != null);
  assert.equal(bad.ref.pnl_pct, 20, "ref kept");
});

test("pure: small moves, unknown bin / bin step", () => {
  const ref = { pnl_pct: 3, bin: -380, at: T0, seen_at: T0, unexplained_since: null };
  assert.equal(adv(ref, { pnl_pct: 7.5, bin: -380 }, 100, T0 + 1000).plausible, true);
  assert.equal(adv(ref, { pnl_pct: 20, bin: null }, 100, T0 + 1000).plausible, false);
  assert.equal(adv(ref, { pnl_pct: 20, bin: -370 }, null, T0 + 1000).plausible, false);
  assert.equal(adv(null, { pnl_pct: 20, bin: null }, null, T0).plausible, true, "no ref: accepted");
});

test("pure: persistence accepts a standing reading; a stale ref is replaced", () => {
  const ref = { pnl_pct: 10, bin: -391, at: T0, seen_at: T0, unexplained_since: null };
  let r = adv(ref, { pnl_pct: 58.9, bin: -385 }, 100, T0 + 1 * MIN);
  assert.equal(r.plausible, false);
  r = adv(r.ref, { pnl_pct: 58.9, bin: -385 }, 100, T0 + 9 * MIN);
  assert.equal(r.plausible, false);
  r = adv(r.ref, { pnl_pct: 58.9, bin: -385 }, 100, T0 + 1 * MIN + HELD_READING_PERSIST_MS);
  assert.equal(r.plausible, true);
  assert.equal(r.accepted_by_persistence, true);
  assert.equal(r.ref.pnl_pct, 58.9);
  const stale = adv(ref, { pnl_pct: 58.9, bin: -385 }, 100, T0 + HELD_REF_STALE_MS + 1);
  assert.equal(stale.plausible, true);
  assert.equal(stale.accepted_by_persistence, false);
});

test("the guard throwing does not stop the trackers", () => {
  HO._resetHeldReadingRefs();
  const { deps, calls } = makeDeps();
  const p = row(5, -390);
  Object.defineProperty(p, "bin_step", { get() { throw new Error("boom"); } });
  obs(p, deps);
  assert.equal(peakFed(calls, 5), 1);
  assert.equal(pathFed(calls, 5), 1);
});
