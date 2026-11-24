/**
 * Capital sync on a HELD position (2026-11-25).
 *
 * The external-capital reconciler lived only inside the exit evaluator, which returns early on
 * HOLD, so a top-up on a held position was never booked. JIMMY-SOL CYCbgJBm (operator, held,
 * re-ranged once, ◎0.3386, thin pool): ≈ ◎0.95 was added to its bins at 06:05 WIB. For four
 * minutes Meteora had not indexed the deposit (pnl read 315 %, flagged extreme_divergence, not
 * management-ready); once it had, the percent basis of a re-ranged position is the TRACKED
 * capital (tools/pnl.js pnlPctBasisSol), still ◎0.3386 — so the position read 20.17 % for a real
 * ≈ 5.3 %, and every percent, the thin-pool hold limit's −25 % included, was ≈ 3.8× too large.
 *
 * Now both hold branches (hold-observer.js) call state.noteHoldCapitalReading: the same
 * reconciler, the same rescale of every %-reference, settled on the next trusted reading.
 * The capital figures below are the JIMMY ones; the post-top-up net (◎1.2866) is an estimate
 * (total value ◎1.3544 less the ◎0.068 of profit).
 */
process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const S = await import("../state.js");
const HO = await import("../hold-observer.js");
const { holdThinLimitReading } = await import("../hold-thin-limit.js");
await S.ensureStateInitialized();

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, stopLossPct: -15, holdGiveBackAlertPp: 10, holdThinPoolLimitMode: "enforce", holdThinPoolLimitPct: -25, holdThinPoolTvlUsd: 100000, adoptedProfitGraceMinutes: 0 };
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;
const C0 = 0.3386, C1 = 1.2866, F = C0 / C1;

let n = 0;
const mk = ({ hold = true, amount = C0, entry_tvl = 93230.47 } = {}) => {
  const P = `HOLDCAP_${Date.now()}_${++n}`;
  S.trackPosition({ position: P, pool: "POOL_JIMMY", pool_name: "JIMMY-SOL", strategy: "spot", amount_sol: amount, initial_value_usd: amount * 70, bin_range: { min: -444, max: -375 }, active_bin: -396, bin_step: 100, entry_tvl, adopted: true });
  if (hold) S.setPositionHold(P, true);
  return P;
};
const row = (P, pnl, over = {}) => ({
  position: P, pool: "POOL_JIMMY", pair: "JIMMY-SOL", pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true,
  active_bin: -396, lower_bin: -444, upper_bin: -375, pnl_quality: "valid", pnl_basis: "sol",
  pnl_management_ready: true, pnl_pct_suspicious: false, net_deposit_sol: C0, ...over,
});
const done = (P) => { try { S.closeTrackedPosition(P, "test"); } catch { /* test cleanup */ } };

test("JIMMY replay: a top-up on a held position is booked and every %-reference moves to the new capital", () => {
  const P = mk();
  try {
    // before the top-up: 19.88 % on ◎0.3386; held high 21.22 %
    for (const v of [21.22, 21.22]) S.noteHoldPeakReading(P, v, Date.now() + (v ? 40_000 * n++ : 0));
    S.noteHoldPathReading(P, row(P, 21.22));
    assert.deepEqual(S.noteHoldCapitalReading(P, row(P, 19.88), mgmt), { capitalChanged: false, settled: false, pending: false });
    assert.equal(S.getTrackedPosition(P).amount_sol, C0);

    // 06:05–06:09: the deposit is on chain, not in Meteora's index — 315 %, not management-ready
    for (const v of [315, 314.56, 317.4]) {
      const r = S.noteHoldCapitalReading(P, row(P, v, { pnl_management_ready: false, pnl_quality: "extreme_divergence" }), mgmt);
      assert.equal(r.capitalChanged, false);
    }
    assert.equal(S.getTrackedPosition(P).amount_sol, C0, "an unverified valuation books nothing");

    // 06:09:12: indexed. The reading in hand is still on ◎0.3386 (20.17 %).
    const change = S.noteHoldCapitalReading(P, row(P, 20.17, { net_deposit_sol: C1, active_bin: -402 }), mgmt);
    assert.deepEqual(change, { capitalChanged: true, settled: false, pending: true });
    let pos = S.getTrackedPosition(P);
    assert.equal(pos.amount_sol, C1);
    assert.equal(pos.hold_mode, true, "HOLD is not touched");
    assert.ok(near(pos.hold_peak_pnl_pct, 21.22 * F), `held high on the new capital (got ${pos.hold_peak_pnl_pct})`);
    assert.ok(near(pos.mfe_pnl_pct, 21.22 * F), `mfe on the new capital (got ${pos.mfe_pnl_pct})`);
    assert.equal(pos.hold_thin_limit ?? null, null);
    assert.ok(pos.capital_rebase_pending);

    // next valuation, on ◎1.2866: 5.31 % → the re-base settles; nothing else changes the capital
    const settle = S.noteHoldCapitalReading(P, row(P, 5.31, { net_deposit_sol: C1, active_bin: -402 }), mgmt);
    assert.deepEqual(settle, { capitalChanged: false, settled: true, pending: false });
    pos = S.getTrackedPosition(P);
    assert.equal(pos.capital_rebase_pending, null);
    assert.equal(pos.last_capital_rebase.from_sol, C0);
    assert.equal(pos.last_capital_rebase.to_sol, C1);
    assert.equal(pos.amount_sol, C1);
    assert.deepEqual(S.noteHoldCapitalReading(P, row(P, 5.2, { net_deposit_sol: C1 }), mgmt), { capitalChanged: false, settled: false, pending: false });
  } finally { done(P); }
});

test("the thin-pool limit's streak and stamp from the old capital are dropped by the change", () => {
  const P = mk();
  try {
    const t0 = Date.now();
    // on the stale ◎0.3386 a real −6.6 % reads −25.1 %: a streak starts
    S.noteHoldThinLimitReading(P, holdThinLimitReading(row(P, -2)), mgmt, { binStep: 100, nowMs: t0 });
    S.noteHoldThinLimitReading(P, holdThinLimitReading(row(P, -25.1, { active_bin: -420 })), mgmt, { binStep: 100, nowMs: t0 + 5_000 });
    const before = S.getTrackedPosition(P).hold_thin_limit;
    assert.ok(before, "limit state exists on the old capital");
    S.noteHoldCapitalReading(P, row(P, -25.1, { net_deposit_sol: C1, active_bin: -420 }), mgmt);
    assert.equal(S.getTrackedPosition(P).hold_thin_limit ?? null, null, "reference, streak and stamp dropped");
    assert.equal(S.getTrackedPosition(P).amount_sol, C1);
  } finally { done(P); }
});

test("a partial withdrawal on a held position scales the references up; the give-back latch follows the capital", () => {
  const P = mk({ amount: 1.0 });
  try {
    S.noteHoldPeakReading(P, 4, Date.now());
    S.noteHoldPeakReading(P, 4, Date.now() + 40_000);
    S.noteHoldGiveBackAlert(P, 30);
    const r = S.noteHoldCapitalReading(P, row(P, -28, { net_deposit_sol: 0.6 }), mgmt);
    assert.equal(r.capitalChanged, true);
    const pos = S.getTrackedPosition(P);
    assert.equal(pos.amount_sol, 0.6);
    assert.ok(near(pos.hold_peak_pnl_pct, 4 / 0.6), `held high scaled up (got ${pos.hold_peak_pnl_pct})`);
    assert.equal(pos.hold_giveback_alert_pp, 50, "30 pp on ◎1.0 is 50 pp on ◎0.6");
  } finally { done(P); }

  const Q = mk();
  try {
    S.noteHoldGiveBackAlert(Q, 30);
    S.noteHoldCapitalReading(Q, row(Q, 5, { net_deposit_sol: C1 }), mgmt);
    assert.equal(S.getTrackedPosition(Q).hold_giveback_alert_pp, 0, "30 pp on ◎0.3386 is under one step on ◎1.2866");
  } finally { done(Q); }
});

test("nothing is booked when not held, on a suspect reading, under the thresholds or while a bot flow is pending", () => {
  const A = mk({ hold: false });
  try {
    assert.deepEqual(S.noteHoldCapitalReading(A, row(A, 20, { net_deposit_sol: C1 }), mgmt), { capitalChanged: false, settled: false, pending: false });
    assert.equal(S.getTrackedPosition(A).amount_sol, C0, "a position that is not held is the evaluator's");
  } finally { done(A); }

  const B = mk();
  try {
    assert.equal(S.noteHoldCapitalReading(B, row(B, 20, { net_deposit_sol: C1, pnl_pct_suspicious: true }), mgmt).capitalChanged, false);
    assert.equal(S.noteHoldCapitalReading(B, row(B, 20, { net_deposit_sol: C0 + 0.015 }), mgmt).capitalChanged, false, "under ◎0.02");
    assert.equal(S.noteHoldCapitalReading(B, row(B, 20, { net_deposit_sol: null }), mgmt).capitalChanged, false);
    assert.equal(S.noteHoldCapitalReading(B, row(B, 20, { net_deposit_sol: C1, pnl_basis: "usd" }), mgmt).capitalChanged, false);
    S.recordPendingFlow(B, { net_sol_expected: C0, reason: "test flow" });
    assert.equal(S.noteHoldCapitalReading(B, row(B, 20, { net_deposit_sol: C1 }), mgmt).capitalChanged, false, "a pending bot flow defers the check");
    assert.equal(S.getTrackedPosition(B).amount_sol, C0);
  } finally { done(B); }
});

test("released hold after a held top-up: the evaluator finds the capital already booked and fires nothing", () => {
  const P = mk();
  try {
    S.noteHoldCapitalReading(P, row(P, 20.17, { net_deposit_sol: C1 }), mgmt);
    S.noteHoldCapitalReading(P, row(P, 5.31, { net_deposit_sol: C1 }), mgmt);
    S.setPositionHold(P, false);
    assert.equal(S.updatePnlAndCheckExits(P, row(P, 5.31, { net_deposit_sol: C1 }), mgmt), null);
    const pos = S.getTrackedPosition(P);
    assert.equal(pos.amount_sol, C1);
    assert.equal(pos.capital_rebase_pending ?? null, null);
    assert.ok(near(pos.peak_pnl_pct, 5.31), `trailing reference re-based on the release (got ${pos.peak_pnl_pct})`);
  } finally { done(P); }
});

test("hold observer: on the tick the capital changes no PnL tracker and no limit check runs", () => {
  for (const source of ["poller", "management"]) {
    const calls = [];
    let answer = { capitalChanged: true, settled: false, pending: true };
    const rec = (name, ret) => (...a) => { calls.push(name); return typeof ret === "function" ? ret(...a) : ret; };
    const deps = {
      registerExitSignal: rec("registerExitSignal"), forgetValuationReference: rec("forgetValuationReference"),
      noteHoldCapitalReading: rec("noteHoldCapitalReading", () => answer),
      noteHoldPeakReading: rec("noteHoldPeakReading"), noteHoldPathReading: rec("noteHoldPathReading"), recordTick: rec("recordTick"),
      checkHoldThinLimit: rec("checkHoldThinLimit", null),
      evaluateHoldGiveBack: rec("evaluateHoldGiveBack", { alert: false, reset: false }), noteHoldGiveBackAlert: rec("noteHoldGiveBackAlert"),
      evaluateHoldDownside: rec("evaluateHoldDownside", { would_close: false }), noteHoldDownsideShadow: rec("noteHoldDownsideShadow", false),
      getTrackedPosition: rec("getTrackedPosition", null), holdDownsideAlertText: rec("holdDownsideAlertText", ""),
      sendHTML: rec("sendHTML", Promise.resolve()), log: () => {}, tagPair: (x) => x, escapeHTML: (x) => x, fmtPct: (x) => String(x),
    };
    const p = row("POS_X", 20.17, { net_deposit_sol: C1 });
    const tracked = { position: "POS_X", pool_name: "JIMMY-SOL", hold_mode: true, amount_sol: C0 };
    assert.equal(HO.observeHeldPosition(p, tracked, { source, deps, cfg: mgmt, confirmTicks: 2 }), null);
    const expected = ["registerExitSignal", "forgetValuationReference", "noteHoldCapitalReading", ...(source === "poller" ? ["recordTick"] : [])];
    assert.deepEqual(calls, expected, `${source}: change tick`);

    calls.length = 0;
    answer = { capitalChanged: false, settled: true, pending: false };
    HO.observeHeldPosition(row("POS_X", 5.31, { net_deposit_sol: C1 }), tracked, { source, deps, cfg: mgmt, confirmTicks: 2 });
    assert.ok(calls.includes("noteHoldPeakReading") && calls.includes("noteHoldPathReading") && calls.includes("checkHoldThinLimit"), `${source}: the next reading feeds everything again`);
    assert.ok(calls.indexOf("noteHoldCapitalReading") < calls.indexOf("noteHoldPeakReading"), `${source}: capital sync runs first`);

    // a throw in the capital sync skips nothing else
    calls.length = 0;
    deps.noteHoldCapitalReading = () => { throw new Error("boom"); };
    HO.observeHeldPosition(row("POS_X", 5.31), tracked, { source, deps, cfg: mgmt, confirmTicks: 2 });
    assert.ok(calls.includes("noteHoldPeakReading") && calls.includes("checkHoldThinLimit"), `${source}: survives a throw`);
  }
});
