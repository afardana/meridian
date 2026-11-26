/**
 * Held positions: the give-back alert takes only usable readings (Fix A), and the held-reading
 * guard is seeded at the hold start from the last trusted non-held valuation (Fix C). 2026-11-26.
 *
 * A — BASKET-SOL / Pompom-SOL 2026-11-25 23:02:39 WIB: the first valuation after a bot restart had
 *     no SOL price (`missing_price`, not management-ready) and read −94.89 % / −96.23 %; the held
 *     high, the path extremes and the thin-pool limit ignored it, but the give-back alert sent
 *     "peak 0.23 % → now −94.89 % (≈◎1.43 unrealised)" and "−103 pp, ◎3.57".
 * C — JIMMY-SOL CV7AUcQh 2026-11-25 20:55 WIB: an un-indexed top-up read 0.85 % → 50.85 % at an
 *     unchanged bin (suspect on the non-held path), HOLD 16 s later; the guard had no reference on
 *     the first held reading and took ≈ 50.5 % as the held high (later rescaled 33.45 → 35.58 %,
 *     four false give-back alerts, record hold_peak 35.58 / mfe 35.96 for a real ≈ +1.5 %).
 * Real state functions (json backend); index.js's peekTrustedValuation is stubbed with the
 * reference assessValuation keeps (pnl + bin of the last trusted reading).
 */
process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";

const S = await import("../state.js");
const HO = await import("../hold-observer.js");
const { tagPair } = await import("../owner-tag.js");
const { escapeHTML, fmtPct } = await import("../telegram.js");
await S.ensureStateInitialized();

const MG = { holdGiveBackAlertPp: 10, holdDownsideMode: "off", holdDownsideAlertEnabled: false, stopLossPct: -15, trailingTriggerPct: 2, holdThinPoolLimitMode: "off" };

function makeDeps({ trusted = null, capital = null } = {}) {
  const sent = [], logs = [];
  const deps = {
    registerExitSignal: S.registerExitSignal ?? (() => {}),
    forgetValuationReference: () => {},
    peekTrustedValuation: () => trusted,
    noteHoldPeakReading: S.noteHoldPeakReading,
    noteHoldPathReading: S.noteHoldPathReading,
    noteHoldRangeReading: (a, r) => S.noteHoldRangeReading(a, r, MG),
    noteHoldCapitalReading: capital ?? ((a, r) => S.noteHoldCapitalReading(a, r, MG)),
    recordTick: () => {},
    checkHoldThinLimit: () => null,
    evaluateHoldGiveBack: S.evaluateHoldGiveBack,
    noteHoldGiveBackAlert: S.noteHoldGiveBackAlert,
    evaluateHoldDownside: S.evaluateHoldDownside,
    noteHoldDownsideShadow: S.noteHoldDownsideShadow,
    getTrackedPosition: S.getTrackedPosition,
    holdDownsideAlertText: () => "B",
    sendHTML: (t) => { sent.push(t); return Promise.resolve(); },
    log: (k, m) => { logs.push([k, m]); },
    tagPair, escapeHTML, fmtPct,
  };
  return { deps, sent, logs };
}

let n = 0;
function mk({ amount = 2.0, peak = 0.23, hold = true, pair = "BASKET-SOL" } = {}) {
  const P = `HOLDGB_${Date.now()}_${++n}`;
  S.trackPosition({ position: P, pool: `POOL_${P}`, pool_name: pair, strategy: "spot", amount_sol: amount, initial_value_usd: amount * 140, bin_range: { min: -150, max: -81 }, active_bin: -100, bin_step: 100, adopted: true });
  S.getTrackedPosition(P).peak_pnl_pct = peak;
  if (hold) S.setPositionHold(P, true);
  return P;
}
const row = (P, pnl, over = {}) => ({
  position: P, pool: `POOL_${P}`, pair: S.getTrackedPosition(P)?.pool_name, pnl_pct: pnl, active_bin: -100, lower_bin: -150, upper_bin: -81,
  pnl_quality: "valid", pnl_basis: "sol", pnl_management_ready: true, pnl_pct_suspicious: false, net_deposit_sol: 2.0, ...over,
});
const obs = (P, r, deps) => HO.observeHeldPosition(r, S.getTrackedPosition(P), { source: "management", cfg: MG, deps });
const gbLogs = (logs) => logs.filter(([k]) => k === "hold_giveback");
const done = (P) => { try { S.recordClose(P, "test"); } catch { /* cleanup */ } };

test("A: unusable readings (not ready / suspicious / non-SOL basis / unexplained / re-base pending) — no alert, no log, latch untouched", () => {
  HO._resetHeldReadingRefs();
  const P = mk();
  try {
    const { deps, sent, logs } = makeDeps();
    // usable reading at the held high (the guard's reference: 0.23 % at bin -100, bin step 100)
    obs(P, row(P, 0.23), deps);
    S.getTrackedPosition(P).hold_giveback_alert_pp = 10; // a latch from an earlier step
    // drop < half a step would RESET the latch on a usable reading — the unusable ones must not
    for (const r of [
      row(P, -94.89, { pnl_management_ready: false, pnl_quality: "missing_price", pnl_quality_reason: "missing_price" }),
      row(P, -96.23, { pnl_pct_suspicious: true }),
      row(P, -95, { pnl_basis: "usd" }),
      row(P, Number.NaN),
    ]) obs(P, r, deps);
    assert.equal(sent.length, 0);
    assert.equal(gbLogs(logs).length, 0);
    assert.equal(S.getTrackedPosition(P).hold_giveback_alert_pp, 10, "latch unchanged");

    // re-base pending (the capital sync stubbed so it stays pending): nothing either
    S.getTrackedPosition(P).capital_rebase_pending = { at: new Date().toISOString(), from_sol: 2, to_sol: 3, peak_before: 0.23, peak_rescaled: 0.15 };
    const pend = makeDeps({ capital: () => ({ capitalChanged: false, settled: false, pending: true }) });
    obs(P, row(P, -20), pend.deps);
    assert.equal(pend.sent.length, 0);
    assert.equal(gbLogs(pend.logs).length, 0);
    assert.equal(S.getTrackedPosition(P).hold_giveback_alert_pp, 10);
    S.getTrackedPosition(P).capital_rebase_pending = null;

    // the next usable reading behaves exactly as evaluateHoldGiveBack says (here: reset at drop < 5)
    const expect = S.evaluateHoldGiveBack(S.getTrackedPosition(P), 0.2, MG);
    assert.equal(expect.reset, true);
    obs(P, row(P, 0.2), deps);
    assert.equal(S.getTrackedPosition(P).hold_giveback_alert_pp, 0, "reset on the usable reading");
    // and a usable −10 % (the price fell 12 bins, so the guard — bin step 100 from the row — takes it)
    // alerts once, same text as before
    obs(P, row(P, -10, { active_bin: -112 }), deps);
    assert.equal(sent.length, 1);
    assert.match(gbLogs(logs)[0][1], /^\[HOLD_GIVEBACK\] BASKET-SOL: peak 0\.23% → now -10\.00% \(−10\.2 pp, ≈◎0\.205 unrealised\)/);
  } finally { done(P); }
});

test("A: a reading the held-reading guard finds unexplained by the price move does not alert", () => {
  HO._resetHeldReadingRefs();
  const P = mk({ pair: "Pompom-SOL" });
  try {
    const { deps, sent, logs } = makeDeps();
    obs(P, row(P, 0.23, { bin_step: 100 }), deps);            // reference at bin -100
    obs(P, row(P, -96.23, { bin_step: 100, active_bin: -99 }), deps); // −96 pp while the bin ROSE: not price
    assert.equal(sent.length, 0);
    assert.equal(gbLogs(logs).length, 0);
    assert.ok(logs.some(([, m]) => String(m).startsWith("[HOLD_READING] Pompom-SOL")), "the guard's own line");
    assert.equal(S.getTrackedPosition(P).hold_giveback_alert_pp, 0);
  } finally { done(P); }
});

/** JIMMY-SOL CV7AUcQh: trusted 0.85 % at bin b → (suspect 50.85 % at b on the non-held path) → HOLD → … */
function jimmy({ seed }) {
  HO._resetHeldReadingRefs();
  const P = mk({ amount: 2.0, peak: 0.85, hold: false, pair: "JIMMY-SOL" });
  const b = -112;
  // the non-held path: trusted 0.85 % at b, then a suspect 50.85 % at b — assessValuation keeps 0.85 / b
  const trusted = seed ? { pnl: 0.85, bin: b, at: Date.now() - 16_000 } : null;
  S.setPositionHold(P, true);
  const { deps, sent, logs } = makeDeps({ trusted });
  const R = (pnl, over = {}) => row(P, pnl, { active_bin: b, bin_step: 100, ...over });
  obs(P, R(50.9), deps);
  obs(P, R(50.5), deps);
  obs(P, R(50.5), deps);
  const beforeCapital = { ...S.getTrackedPosition(P) };
  obs(P, R(1.2, { net_deposit_sol: 3.03 }), deps); // capital tick: ◎2.0 → ◎3.03
  obs(P, R(1.2, { net_deposit_sol: 3.03 }), deps); // settle
  obs(P, R(1.3, { net_deposit_sol: 3.03 }), deps);
  obs(P, R(1.25, { net_deposit_sol: 3.03 }), deps);
  return { P, sent, logs, beforeCapital, pos: S.getTrackedPosition(P) };
}

test("C: JIMMY replay — seeded from the trusted valuation, the fake 50 % never becomes the held high", () => {
  const { P, sent, logs, beforeCapital, pos } = jimmy({ seed: true });
  try {
    assert.ok(beforeCapital.hold_peak_pnl_pct <= 1.5, `held high before the capital tick ${beforeCapital.hold_peak_pnl_pct}`);
    assert.ok(beforeCapital.mfe_pnl_pct == null || beforeCapital.mfe_pnl_pct <= 1.5, `mfe ${beforeCapital.mfe_pnl_pct}`);
    assert.equal(pos.amount_sol, 3.03, "capital booked");
    assert.ok(pos.hold_peak_pnl_pct <= 1.5, `held high ${pos.hold_peak_pnl_pct}`);
    assert.ok(pos.mfe_pnl_pct <= 1.5, `mfe ${pos.mfe_pnl_pct}`);
    assert.equal(sent.length, 0, "no give-back alert");
    assert.equal(gbLogs(logs).length, 0);
    assert.equal(logs.filter(([, m]) => String(m).startsWith("[HOLD_READING] JIMMY-SOL: PnL 0.85% → 50.90%")).length, 1);
  } finally { done(P); }
});

test("C control: no trusted valuation reference (restart / hold at deploy) — behaves as before", () => {
  const { P, sent, pos, beforeCapital } = jimmy({ seed: false });
  try {
    assert.ok(beforeCapital.hold_peak_pnl_pct > 50, `the first held reading starts the reference (held high ${beforeCapital.hold_peak_pnl_pct})`);
    assert.ok(pos.hold_peak_pnl_pct > 30, "rescaled fake held high, as before");
    assert.equal(sent.length, 1, "the false give-back alert of before");
  } finally { done(P); }
});

test("C: the seed is used only when fresh (≤ 10 min) and newer than the guard's own reference", () => {
  HO._resetHeldReadingRefs();
  const P = mk({ hold: true });
  try {
    const old = makeDeps({ trusted: { pnl: 0.85, bin: -100, at: Date.now() - 11 * 60_000 } });
    obs(P, row(P, 0.4, { bin_step: 100 }), old.deps);
    assert.equal(HO._heldReadingRefOf(P).seeded_from_valuation, undefined, "a stale valuation is not used");
    assert.equal(HO._heldReadingRefOf(P).pnl_pct, 0.4);
    const older = makeDeps({ trusted: { pnl: 9, bin: -100, at: Date.now() - 5 * 60_000 } });
    obs(P, row(P, 0.5, { bin_step: 100 }), older.deps);
    assert.equal(HO._heldReadingRefOf(P).pnl_pct, 0.5, "an existing newer guard reference wins");
  } finally { done(P); }
});
