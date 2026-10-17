process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const S = await import("../state.js");
const { rescaleCapitalReferences, settleCapitalRebase, capitalRebaseLine } = await import("../capital-rebase.js");
await S.ensureStateInitialized();

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5, stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 0 };
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;

// FTR-SOL BG8Q1s9BoYFKkgEavuPk9W9BKzFrzSFFF9GqV29qFEuK, 2026-10-17 23:13–23:14 WIB.
const ftr = (pnl, over = {}) => ({
  pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: -674, lower_bin: -729, upper_bin: -660,
  pnl_quality: "valid", pnl_basis: "sol", net_deposit_sol: 0.3079, ...over,
});
const track = (P, amount, range = [-729, -660], active = -674) =>
  S.trackPosition({ position: P, pool: "POOL_FTR", pool_name: "FTR-SOL", strategy: "spot", amount_sol: amount, initial_value_usd: amount * 190, bin_range: range, active_bin: active });

test("BG8Q replay: a top-up in the same tick as a one-bin range change does not fire trailing TP", () => {
  const P = `CAPREB_${Date.now()}`;
  track(P, 0.3079);
  try {
    // 23:13 — trusted 5.72 % on ◎0.3079, trailing armed (trigger 2)
    S.confirmPeak(P, 5.72, 1);
    assert.equal(S.updatePnlAndCheckExits(P, ftr(5.72), mgmt), null);
    assert.equal(S.getTrackedPosition(P).trailing_active, true);
    // 23:13:23–23:14:43 — extreme_divergence, not management-ready
    for (const v of [119.21, 119.21, 60.4]) {
      assert.equal(S.updatePnlAndCheckExits(P, ftr(v, { pnl_management_ready: false, pnl_quality: "unsafe", net_deposit_sol: 0.6569 }), mgmt), null);
    }
    assert.equal(S.getTrackedPosition(P).amount_sol, 0.3079, "an unsafe valuation reconciles nothing");
    // 23:14:48 — range −729..−660 → −730..−660, Meteora's net ◎0.6569, reading still 5.51 % (old capital)
    S.confirmPeak(P, 5.51, 1);
    assert.equal(S.updatePnlAndCheckExits(P, ftr(5.51, { lower_bin: -730, active_bin: -677, net_deposit_sol: 0.6569 }), mgmt), null);
    let pos = S.getTrackedPosition(P);
    assert.equal(pos.amount_sol, 0.6569);
    assert.equal(pos.rebalance_count, 1, "the range change is still recorded");
    assert.ok(pos.capital_rebase_pending, "re-base pending");
    assert.ok(near(pos.peak_pnl_pct, 5.72 * 0.3079 / 0.6569), `peak rescaled to the new capital, not reset to the old-basis 5.51 (got ${pos.peak_pnl_pct})`);
    assert.deepEqual(pos.pnl_tick_history, []);
    assert.equal(S.confirmPeak(P, 5.51, 1), false, "no peak confirmation while the re-base is pending");
    // 23:14:53 — first valuation on ◎0.6569: 2.58 %. Must NOT close.
    const exit = S.updatePnlAndCheckExits(P, ftr(2.58, { lower_bin: -730, active_bin: -677, net_deposit_sol: 0.6569 }), mgmt);
    assert.equal(exit, null, "no trailing exit on the basis change");
    pos = S.getTrackedPosition(P);
    assert.equal(pos.capital_rebase_pending, null);
    assert.ok(near(pos.peak_pnl_pct, 2.58), `peak re-based to ≈ 2.58 (got ${pos.peak_pnl_pct})`);
    assert.equal(pos.last_capital_rebase.from_sol, 0.3079);
    assert.equal(pos.last_capital_rebase.to_sol, 0.6569);
    // a quiet next tick at the same level: still nothing
    assert.equal(S.updatePnlAndCheckExits(P, ftr(2.55, { lower_bin: -730, active_bin: -677, net_deposit_sol: 0.6569 }), mgmt), null);
  } finally { try { S.closeTrackedPosition(P, "test"); } catch {} }
});

test("a top-up that takes the rescaled peak under the trigger disarms trailing", () => {
  const P = `CAPREB2_${Date.now()}`;
  track(P, 0.3);
  try {
    S.confirmPeak(P, 3.0, 1);
    S.updatePnlAndCheckExits(P, ftr(3.0, { net_deposit_sol: 0.3 }), mgmt);
    assert.equal(S.getTrackedPosition(P).trailing_active, true);
    S.updatePnlAndCheckExits(P, ftr(3.0, { net_deposit_sol: 0.9 }), mgmt);
    const pos = S.getTrackedPosition(P);
    assert.ok(near(pos.peak_pnl_pct, 1.0));
    assert.equal(pos.trailing_active, false, "1.0 % is under the 2 % trigger");
    assert.equal(S.updatePnlAndCheckExits(P, ftr(0.98, { net_deposit_sol: 0.9 }), mgmt), null);
    assert.equal(S.getTrackedPosition(P).trailing_active, false, "does not re-arm under the trigger");
  } finally { try { S.closeTrackedPosition(P, "test"); } catch {} }
});

test("after the re-base a real later drop still fires trailing TP from the re-based peak", () => {
  const P = `CAPREB3_${Date.now()}`;
  track(P, 0.3079);
  try {
    S.confirmPeak(P, 5.72, 1);
    S.updatePnlAndCheckExits(P, ftr(5.72), mgmt);
    S.updatePnlAndCheckExits(P, ftr(5.51, { net_deposit_sol: 0.6569 }), mgmt);
    assert.equal(S.updatePnlAndCheckExits(P, ftr(2.58, { net_deposit_sol: 0.6569 }), mgmt), null);
    assert.equal(S.getTrackedPosition(P).trailing_active, true, "2.58 % still clears the 2 % trigger");
    // the price runs: new high 3.6 % confirmed, then a real 1.6 pp drop
    assert.equal(S.confirmPeak(P, 3.6, 1), true);
    assert.equal(S.updatePnlAndCheckExits(P, ftr(3.6, { net_deposit_sol: 0.6569 }), mgmt), null);
    const exit = S.updatePnlAndCheckExits(P, ftr(2.0, { net_deposit_sol: 0.6569 }), mgmt);
    assert.equal(exit?.action, "TRAILING_TP");
  } finally { try { S.closeTrackedPosition(P, "test"); } catch {} }
});

test("a partial withdrawal raises the peak in % and re-bases it the same way", () => {
  const P = `CAPREB4_${Date.now()}`;
  track(P, 1.0);
  try {
    S.confirmPeak(P, 3.0, 1);
    S.updatePnlAndCheckExits(P, ftr(3.0, { net_deposit_sol: 1.0 }), mgmt);
    // operator withdraws ◎0.5; this tick still reads 2.9 % on ◎1.0
    S.updatePnlAndCheckExits(P, ftr(2.9, { net_deposit_sol: 0.5 }), mgmt);
    let pos = S.getTrackedPosition(P);
    assert.equal(pos.amount_sol, 0.5);
    assert.ok(near(pos.peak_pnl_pct, 6.0), `peak 3 % of ◎1 = 6 % of ◎0.5 (got ${pos.peak_pnl_pct})`);
    assert.equal(pos.capital_rebase_pending.delta_sol, -0.5);
    assert.equal(pos.trailing_active, true);
    // first reading on ◎0.5: 5.8 % (◎0.029) — peak re-based to the lower, no exit
    assert.equal(S.updatePnlAndCheckExits(P, ftr(5.8, { net_deposit_sol: 0.5 }), mgmt), null);
    pos = S.getTrackedPosition(P);
    assert.ok(near(pos.peak_pnl_pct, 5.8));
    assert.equal(pos.capital_rebase_pending, null);
    // a real drop from there fires
    assert.equal(S.updatePnlAndCheckExits(P, ftr(4.2, { net_deposit_sol: 0.5 }), mgmt)?.action, "TRAILING_TP");
  } finally { try { S.closeTrackedPosition(P, "test"); } catch {} }
});

test("the reconciler still skips while our own flow is pending", () => {
  const P = `CAPREB5_${Date.now()}`;
  track(P, 0.4);
  try {
    S.confirmPeak(P, 3.0, 1);
    S.updatePnlAndCheckExits(P, ftr(3.0, { net_deposit_sol: 0.4 }), mgmt);
    S.recordPendingFlow(P, { net_sol_expected: 0.2, reason: "straddle withdraw" });
    S.updatePnlAndCheckExits(P, ftr(3.0, { net_deposit_sol: 0.8 }), mgmt);
    const pos = S.getTrackedPosition(P);
    assert.equal(pos.amount_sol, 0.4, "no capital change while a flow is pending");
    assert.equal(pos.capital_rebase_pending ?? null, null);
    assert.equal(pos.peak_pnl_pct, 3.0, "references untouched");
  } finally { try { S.closeTrackedPosition(P, "test"); } catch {} }
});

test("a suspect reading after the change does not settle the re-base", () => {
  const P = `CAPREB6_${Date.now()}`;
  track(P, 0.3079);
  try {
    S.confirmPeak(P, 5.72, 1);
    S.updatePnlAndCheckExits(P, ftr(5.72), mgmt);
    S.updatePnlAndCheckExits(P, ftr(5.51, { net_deposit_sol: 0.6569 }), mgmt);
    assert.equal(S.updatePnlAndCheckExits(P, ftr(0.4, { net_deposit_sol: 0.6569, pnl_pct_suspicious: true }), mgmt), null);
    assert.ok(S.getTrackedPosition(P).capital_rebase_pending, "still pending");
    assert.equal(S.updatePnlAndCheckExits(P, ftr(2.6, { net_deposit_sol: 0.6569 }), mgmt), null);
    const pos = S.getTrackedPosition(P);
    assert.equal(pos.capital_rebase_pending, null);
    assert.ok(near(pos.peak_pnl_pct, 2.6), "min(rescaled 2.68, reading 2.6)");
  } finally { try { S.closeTrackedPosition(P, "test"); } catch {} }
});

test("a held position's top-up is reconciled after release; hold resume and capital re-base never fire trailing", () => {
  const P = `CAPREB7_${Date.now()}`;
  track(P, 0.3079);
  try {
    S.confirmPeak(P, 5.72, 1);
    S.updatePnlAndCheckExits(P, ftr(5.72), mgmt);
    S.setPositionHold(P, true, "operator");
    // the operator tops up while held: the evaluator does not run on HOLD
    assert.equal(S.updatePnlAndCheckExits(P, ftr(5.51, { net_deposit_sol: 0.6569 }), mgmt), null);
    assert.equal(S.getTrackedPosition(P).amount_sol, 0.3079);
    S.setPositionHold(P, false);
    // first tick after the release: capital change lands, reading still on the old capital
    assert.equal(S.updatePnlAndCheckExits(P, ftr(5.51, { net_deposit_sol: 0.6569 }), mgmt), null);
    let pos = S.getTrackedPosition(P);
    assert.equal(pos.amount_sol, 0.6569);
    assert.equal(pos.hold_resume_rebase, true, "hold resume waits for a reading on the new capital");
    assert.ok(pos.capital_rebase_pending);
    assert.equal(pos.trailing_active, false);
    // first reading on the new capital: both re-bases settle on it
    assert.equal(S.updatePnlAndCheckExits(P, ftr(2.58, { net_deposit_sol: 0.6569 }), mgmt), null);
    pos = S.getTrackedPosition(P);
    assert.equal(pos.hold_resume_rebase, false);
    assert.equal(pos.capital_rebase_pending, null);
    assert.ok(near(pos.peak_pnl_pct, 2.58));
    assert.equal(S.updatePnlAndCheckExits(P, ftr(2.5, { net_deposit_sol: 0.6569 }), mgmt), null);
  } finally { try { S.closeTrackedPosition(P, "test"); } catch {} }
});

test("rescaleCapitalReferences: every %-reference moves, streaks are cleared, a second change keeps the origin", () => {
  const pos = {
    peak_pnl_pct: 5.72, pending_peak_pnl_pct: 6.1, pending_peak_confirm_count: 1, pending_peak_started_at: "x",
    hold_peak_pnl_pct: 8, hold_peak_pending: { pct: 9 }, mfe_pnl_pct: 6.0, mae_pnl_pct: -2.0, trailing_active: true,
    pnl_tick_history: [5.5, 5.6, 5.72], twap_guard_deferrals: 1,
    pending_exit_action: "TRAILING_TP", pending_exit_count: 1, pending_exit_started_at: "t", pending_exit_context: { a: 1 },
    stop_loss_violated_since: "s", young_stop_violated_since: "y",
  };
  rescaleCapitalReferences(pos, { fromSol: 0.3079, toSol: 0.6569, triggerPct: 2 });
  const f = 0.3079 / 0.6569;
  assert.ok(near(pos.peak_pnl_pct, 5.72 * f, 1e-3));
  assert.ok(near(pos.hold_peak_pnl_pct, 8 * f, 1e-3));
  assert.ok(near(pos.mfe_pnl_pct, 6 * f));
  assert.ok(near(pos.mae_pnl_pct, -2 * f));
  assert.equal(pos.trailing_active, true);
  for (const k of ["pending_peak_pnl_pct", "pending_peak_started_at", "hold_peak_pending", "pending_exit_action", "pending_exit_started_at", "pending_exit_context", "stop_loss_violated_since", "young_stop_violated_since"]) {
    assert.equal(pos[k], null, k);
  }
  assert.equal(pos.pending_exit_count, 0);
  assert.equal(pos.twap_guard_deferrals, 0);
  assert.deepEqual(pos.pnl_tick_history, []);
  assert.equal(pos.capital_rebase_pending.peak_before, 5.72);
  // a second change before the re-base settles: origin and first peak kept
  rescaleCapitalReferences(pos, { fromSol: 0.6569, toSol: 1.0, triggerPct: 2 });
  assert.equal(pos.capital_rebase_pending.from_sol, 0.3079);
  assert.equal(pos.capital_rebase_pending.to_sol, 1.0);
  assert.equal(pos.capital_rebase_pending.peak_before, 5.72);
  assert.ok(near(pos.peak_pnl_pct, 5.72 * 0.3079, 1e-3));
  assert.equal(pos.trailing_active, false, "1.76 % < 2 %");
  // unknown capital: nothing rescaled, the re-base takes the reading
  const p2 = { peak_pnl_pct: 4 };
  rescaleCapitalReferences(p2, { fromSol: 0, toSol: 1, triggerPct: 2 });
  assert.equal(p2.peak_pnl_pct, 4);
  assert.equal(settleCapitalRebase(p2, null), null, "a non-finite reading settles nothing");
  settleCapitalRebase(p2, 3.1);
  assert.equal(p2.peak_pnl_pct, 3.1);
});

test("[CAPITAL_REBASE] log line", () => {
  assert.equal(
    capitalRebaseLine("FTR-SOL", { from_sol: 0.3079, to_sol: 0.6569, delta_sol: 0.349, peak_before: 5.51, peak_after: 2.58 }),
    "[CAPITAL_REBASE] FTR-SOL: capital ◎0.3079 → ◎0.6569 (+◎0.3490) — peak 5.51 % → 2.58 % on the new capital, trailing reference re-based; exit signals cleared",
  );
  assert.match(capitalRebaseLine("X-SOL", { from_sol: 1, to_sol: 0.5, delta_sol: -0.5, peak_before: 3, peak_after: 5.8 }), /\(−◎0\.5000\) — peak 3\.00 % → 5\.80 %/);
});
