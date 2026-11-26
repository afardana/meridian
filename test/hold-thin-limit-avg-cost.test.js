/**
 * Thin-pool hold limit on the average-cost basis of what is left after a partial withdrawal
 * (2026-11-26, operator go-ahead; four review rounds the same day).
 *
 * JIMMY-SOL CV7AUcQh 2026-11-25 22:12 WIB (held, re-ranged, thin pool): the operator withdrew
 * ◎2.0408 of ◎3.0276 at an unchanged bin. The SOL loss stayed ≈ ◎0.2694, the capital shrank to
 * ◎0.9868, so the percent jumped −8.9 % → −27.3 % with no price move; the capital-change tick
 * dropped the limit's reference and the next reading started a streak with nothing to compare
 * against. It survived only because every reading from 22:13:08 was unusable (the re-deposit,
 * reconciled ◎0.9868 → ◎2.8465 at 22:17:38, was not yet indexed).
 *
 * Design under test:
 *   - unitised basis B = B_prev × (to + L) / (from + L) for any net change once a basis exists;
 *     a top-up without a basis writes nothing and opens no marker;
 *   - index-lag bound: B with L_now and with the pre-flow L (≤ 6 min old), the larger kept;
 *   - while a change is pending the cost-basis machine reads a PROVISIONAL basis (no blackout);
 *     resolution stores it on a clean reading (diff in SOL ≤ 3 % of the larger capital) or, after
 *     10 min, on the first usable one (resolved_by "timeout") — nothing is dropped on a timeout;
 *   - two state machines when a basis applies (plain exactly as before + cost-basis), ready only
 *     when both are; a row without pnl_sol_rule feeds the plain machine, the cost-basis one skips it.
 * Every clock is passed in (`nowMs`) — no global Date mock.
 */
process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CR = await import("../capital-rebase.js");
const L = await import("../hold-thin-limit.js");
const PR = await import("../perf-record.js");
const S = await import("../state.js");
await S.ensureStateInitialized();

const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/hold-thin-avg-cost-jimmy.json", import.meta.url), "utf8"));
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;
const SEC = 1000, MIN = 60 * SEC;
const BASE = { holdThinPoolLimitMode: "enforce", holdThinPoolLimitPct: -25, holdThinPoolTvlUsd: 100000, holdGiveBackAlertPp: 10, trailingTriggerPct: 2, adoptedProfitGraceMinutes: 0 };
const KEY_OFF = { ...BASE, holdThinPoolAvgCostBasis: false };
const CFG = L.holdThinLimitConfig(BASE);
/** mulberry32: a 32-bit PRNG that does not degenerate (the earlier LCG overflowed 2^53). */
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ── Pure helper: unitised basis + index-lag bound ─────────────────────────────────────
test("withdrawal: identity from 1 → 0.4 at L −0.089 (B ≈ 0.34138, figure −8.9 %)", () => {
  const r = CR.nextAvgCostBasis(null, { fromSol: 1, toSol: 0.4, pnlSol: -0.089, at: "T" });
  assert.equal(r.action, "write");
  assert.ok(near(r.basis.basis_sol, 0.34138, 1e-5));
  assert.ok(near(CR.avgCostBasisPnlPct(r.basis.basis_sol, 0.4, -0.089), -8.9, 0.001));
});

test("repro A: a withdraw / re-deposit round trip leaves the figure where it was", () => {
  const Lj = -0.2694;
  const b1 = CR.nextAvgCostBasis(null, { fromSol: 3.0276, toSol: 0.9868, pnlSol: Lj }).basis;
  const b2 = CR.nextAvgCostBasis(b1, { fromSol: 0.9868, toSol: 2.8465, pnlSol: Lj });
  assert.equal(b2.kind, "topup");
  assert.ok(near(b2.basis.basis_sol, 2.8288, 1e-4));
  assert.ok(near(CR.avgCostBasisPnlPct(b2.basis.basis_sol, 2.8465, Lj), (Lj / 3.0276) * 100, 0.01));
  const once = CR.nextAvgCostBasis(null, { fromSol: 3.0276, toSol: 2.8465, pnlSol: Lj, changes: 2 });
  assert.ok(near(once.basis.basis_sol, b2.basis.basis_sol, 1e-5), "the same two changes in one window");
  assert.equal(CR.nextAvgCostBasis(null, { fromSol: 0.9868, toSol: 2.8465, pnlSol: Lj }).action, "none", "net top-up, no basis: nothing");
});

test("guards: skip without a basis, DROP an existing one; tiny basis is no basis", () => {
  const prev = { basis_sol: 0.5, changes: 1, at: "x" };
  for (const bad of [
    { fromSol: 1, toSol: 0.4, pnlSol: null }, { fromSol: 1, toSol: 0.4, pnlSol: NaN }, { fromSol: 1, toSol: 0.4, pnlSol: -0.4 },
    { fromSol: 1, toSol: 0.4, pnlSol: -1.2 }, { fromSol: null, toSol: 0.4, pnlSol: -0.1 }, { fromSol: 1, toSol: 0, pnlSol: -0.1 },
  ]) {
    assert.equal(CR.nextAvgCostBasis(null, bad).action, "none", JSON.stringify(bad));
    assert.equal(CR.nextAvgCostBasis(prev, bad).action, "drop", JSON.stringify(bad));
  }
  assert.equal(CR.nextAvgCostBasis(prev, { fromSol: 0.4, toSol: 0.9, pnlSol: null }).action, "drop", "a top-up on a basis needs L");
  assert.equal(L.avgCostBasisOf({ avg_cost_basis: { basis_sol: 1e-9 } }), null);
  assert.equal(L.holdThinLimitPnl({ pnl_pct: -30, pnl_sol_rule: -0.1 }, { amount_sol: 1, avg_cost_basis: { basis_sol: 1e-12 } }, BASE).pnl_pct, -30);
});

test("property: the bounded basis is the largest of the three candidates; action follows L_now", () => {
  const rnd = mulberry32(99);
  let three = 0;
  const seen = { now: 0, before: 0, change: 0 };
  for (let i = 0; i < 1200; i++) {
    const prev = rnd() < 0.5 ? null : { basis_sol: 0.1 + rnd() * 3, changes: 1 };
    const from = 0.2 + rnd() * 3, to = 0.2 + rnd() * 3;
    const draw = () => (rnd() < 0.2 ? null : (rnd() - 0.6) * Math.min(from, to));
    const lNow = (rnd() - 0.6) * Math.min(from, to), lBefore = draw(), lChange = draw();
    const r = CR.nextAvgCostBasisBounded(prev, { fromSol: from, toSol: to, pnlSolNow: lNow, pnlSolBefore: lBefore, pnlSolChange: lChange });
    const a = CR.nextAvgCostBasis(prev, { fromSol: from, toSol: to, pnlSol: lNow });
    assert.equal(r.action, a.action);
    if (r.action !== "write") continue;
    const cand = [[a, "now"]];
    for (const [l, src] of [[lBefore, "before"], [lChange, "change"]]) {
      if (l == null) continue;
      const c = CR.nextAvgCostBasis(prev, { fromSol: from, toSol: to, pnlSol: l });
      if (c.action === "write") cand.push([c, src]);
    }
    if (cand.length === 3) three++;
    const max = Math.max(...cand.map(([c]) => c.basis.basis_sol));
    assert.equal(r.basis.basis_sol, max, "the larger B, i.e. never more lenient than any candidate");
    assert.ok(r.basis.basis_sol >= Math.min(...cand.map(([c]) => c.basis.basis_sol)));
    assert.equal(cand.find(([, src]) => src === r.basis.l_source)[0].basis.basis_sol, max);
    seen[r.basis.l_source]++;
    assert.deepEqual([r.basis.pnl_sol_before, r.basis.pnl_sol_change], [lBefore == null ? null : Math.round(lBefore * 1e6) / 1e6, lChange == null ? null : Math.round(lChange * 1e6) / 1e6]);
  }
  assert.ok(three > 150 && seen.now > 0 && seen.before > 0 && seen.change > 0, JSON.stringify({ three, seen }));
});

test("marker: pre-flow L only at creation; needs-pending rule", () => {
  const q = {};
  CR.markAvgCostBasisPending(q, { fromSol: 1, at: "2026-11-26T00:00:00.000Z", pnlSolBefore: -0.1, pnlSolBeforeAt: "a", pnlSolChange: -0.15 });
  CR.markAvgCostBasisPending(q, { fromSol: 0.5, at: "2026-11-26T00:01:00.000Z", pnlSolBefore: -0.3, pnlSolBeforeAt: "b", pnlSolChange: -0.4 });
  assert.deepEqual(q.avg_cost_basis_pending, { from_sol: 1, first_at: "2026-11-26T00:00:00.000Z", last_change_at: "2026-11-26T00:01:00.000Z", changes: 2, pnl_sol_before: -0.1, pnl_sol_before_at: "a", pnl_sol_change: -0.15 }, "the FIRST change's values are kept");
  assert.equal(CR.avgCostBasisNeedsPending({}, 0.5), false);
  assert.equal(CR.avgCostBasisNeedsPending({}, -0.5), true);
  assert.equal(CR.avgCostBasisNeedsPending({ avg_cost_basis: { basis_sol: 1 } }, 0.5), true);
  assert.equal(CR.avgCostBasisNeedsPending({ avg_cost_basis_pending: { from_sol: 1 } }, 0.5), true);
  assert.equal(CR.AVG_COST_BASIS_PNL_BEFORE_MAX_AGE_MS, undefined, "no age cap any more");
});

test("clean bound in SOL vs the larger capital; timeout waives only the diff", () => {
  const now = Date.parse("2026-11-26T00:02:00Z");
  const mkPos = (from, to) => ({ amount_sol: to, avg_cost_basis_pending: { from_sol: from, first_at: "2026-11-26T00:00:00.000Z", last_change_at: "2026-11-26T00:01:00.000Z", changes: 1 } });
  const row = (to, pct, diff, over = {}) => ({ pnl_pct: pct, pnl_sol_rule: (pct / 100) * to, net_deposit_sol: to, pnl_pct_diff: diff, pnl_basis: "sol", pnl_management_ready: true, ...over });
  const V = (pos, r, t = now) => CR.avgCostBasisPendingVerdict(pos, r, { nowMs: t });
  // reduced to a third: 6 pp of ◎1 = ◎0.06 ≤ 3 % of ◎3 = ◎0.09 → clean
  assert.equal(V(mkPos(3, 1), row(1, -20, 6)).verdict, "clean");
  // a tiny withdrawal: 6 pp of ◎0.9 = ◎0.054 > 3 % of ◎1 = ◎0.03 → not clean
  assert.equal(V(mkPos(1, 0.9), row(0.9, -20, 6)).verdict, "wait");
  assert.equal(V(mkPos(3, 1), row(1, -20, null)).verdict, "wait", "a null diff is not clean");
  assert.equal(V(mkPos(3, 1), row(1, -20, 10)).verdict, "wait");
  // pctBase: exact from the row's deposits (mirror of pnlPctBasisSol), else derived
  assert.equal(CR.rowPctBaseSol({ deposit_sol: 3, pnl_pct: -2, pnl_sol_rule: -0.06 }, 1, { rebalance_count: 1 }), 1, "re-ranged, deposits above capital: the capital");
  assert.equal(CR.rowPctBaseSol({ deposit_sol: 3, pnl_pct: -2, pnl_sol_rule: -0.06 }, 1, { rebalance_count: 0 }), 3, "not re-ranged: the deposits");
  assert.equal(CR.rowPctBaseSol({ lifetime_deposits_sol: 2.5 }, 1, {}), 2.5);
  assert.equal(CR.rowPctBaseSol({ pnl_pct: -2, pnl_sol_rule: -0.06 }, 1), 3, "fallback: derived from the row");
  assert.equal(CR.rowPctBaseSol({ pnl_pct: 0, pnl_sol_rule: 0 }, 1.5), 1.5);
  // after 10 min the first USABLE reading resolves, whatever its diff
  const late = Date.parse("2026-11-26T00:11:00Z");
  assert.equal(V(mkPos(3, 1), row(1, -20, 10), late).verdict, "timeout");
  assert.equal(V(mkPos(3, 1), row(1, -20, null), late).verdict, "timeout");
  assert.equal(V(mkPos(3, 1), row(1, -20, 10, { pnl_management_ready: false }), late).verdict, "wait");
  assert.equal(V(mkPos(3, 1), row(1, -20, 10, { pnl_sol_rule: null }), late).verdict, "wait");
  assert.equal(V(mkPos(3, 1), row(1, -20, 10, { net_deposit_sol: undefined }), late).verdict, "wait");
  assert.equal(V({ ...mkPos(3, 1), capital_rebase_pending: { at: "x" } }, row(1, -20, 0.1), late).verdict, "wait");
  assert.equal(CR.avgCostBasisPendingVerdict({}, row(1, -20, 0.1), { nowMs: now }).verdict, "none");
});

test("provisional basis: with no L_before the figure equals the PnL on the pre-change capital (continuous)", () => {
  const tracked = { amount_sol: 1.0, avg_cost_basis_pending: { from_sol: 3.0, changes: 1, last_change_at: "x" } };
  const e = CR.effectiveAvgCostBasis(tracked, -0.3);
  assert.deepEqual([e.applies, e.ok, e.provisional], [true, true, true]);
  assert.ok(near(CR.avgCostBasisPnlPct(e.basis_sol, 1.0, -0.3), -10, 1e-3), "−0.3 on the former ◎3 = −10 %");
  // net top-up without a stored basis: no basis applies (plain only)
  assert.equal(CR.effectiveAvgCostBasis({ amount_sol: 2, avg_cost_basis_pending: { from_sol: 1 } }, -0.1).applies, false);
  // no SOL PnL / failing guards: applies but not computable
  assert.equal(CR.effectiveAvgCostBasis(tracked, null).ok, false);
  assert.equal(CR.effectiveAvgCostBasis(tracked, -1.2).ok, false);
});

// ── The limit's figure and the two machines (pure) ───────────────────────────────────
test("property: the figure is never below the plain percent; key false (or \"false\") = plain", () => {
  const rnd = mulberry32(20261126);
  let adjustedSeen = 0;
  for (let i = 0; i < 600; i++) {
    const amount = 0.05 + rnd() * 5, basis = 0.05 + rnd() * 5, pnlSol = (rnd() - 0.7) * amount;
    const pnl = Math.round((rnd() * 200 - 120) * 100) / 100;
    const tracked = { amount_sol: amount, avg_cost_basis: { basis_sol: basis, changes: 1 }, ...(rnd() < 0.3 ? { avg_cost_basis_pending: { from_sol: amount * (0.5 + rnd() * 2), changes: 1 } } : {}) };
    const row = { pnl_pct: pnl, pnl_sol_rule: pnlSol, active_bin: 1, pnl_basis: "sol", pnl_management_ready: true };
    const on = L.holdThinLimitReading(row, tracked, {});
    assert.ok(on.ok && on.pnl_pct >= pnl && on.raw_pnl_pct === pnl && on.dual === true, `case ${i}`);
    if (on.adjusted) adjustedSeen++;
    for (const off of [false, "false"]) {
      const r = L.holdThinLimitReading(row, tracked, { holdThinPoolAvgCostBasis: off });
      assert.deepEqual([r.pnl_pct, r.dual, r.key], [pnl, false, on.key]);
    }
  }
  assert.ok(adjustedSeen > 50);
});

test("a pending change no longer blocks the reading; a row without pnl_sol_rule feeds only the plain machine", () => {
  const tracked = { amount_sol: 0.9868, avg_cost_basis_pending: { from_sol: 3.0276, changes: 1, last_change_at: "x" } };
  const r = L.holdThinLimitReading({ pnl_pct: -27.3, pnl_sol_rule: -0.2694, active_bin: -380, pnl_basis: "sol" }, tracked, BASE);
  assert.deepEqual([r.ok, r.dual, r.adj_ok, r.provisional], [true, true, true, true]);
  assert.ok(near(r.pnl_pct, -8.9, 0.02));
  const n = L.holdThinLimitReading({ pnl_pct: -27.3, active_bin: -380, pnl_basis: "sol" }, tracked, BASE);
  assert.deepEqual([n.ok, n.dual, n.adj_ok, n.pnl_pct], [true, true, false, -27.3]);
  const d = L.advanceHoldThinLimitDual(null, n, CFG, { binStep: 100, nowMs: 1 });
  assert.equal(d.plain.event, "started", "the plain machine is fed as before");
  assert.equal(d.adj.event, "ignored", "the cost-basis machine skips the row");
  assert.equal(d.ready, false);
});

test("repro c2: an unexplained plain drop that stays above the limit on the cost basis never closes", () => {
  const tracked = { amount_sol: 1.0, avg_cost_basis: { basis_sol: 0.875, changes: 1 } };
  const rows = [-10, -30, -34.375, -34.5, -34.6].map((p) => ({ pnl_pct: p, pnl_sol_rule: p / 100, active_bin: 0, pnl_basis: "sol", pnl_management_ready: true, total_value_usd: p }));
  let dual = null, adjOnly = null, t = 0, adjOnlyReady = false;
  for (const r of rows) {
    t += 30 * SEC;
    const rd = L.holdThinLimitReading(r, tracked, BASE);
    const d = L.advanceHoldThinLimitDual(dual, rd, CFG, { binStep: 100, nowMs: t });
    const a = L.advanceHoldThinLimit(adjOnly, rd, CFG, { binStep: 100, nowMs: t });
    dual = d.state; adjOnly = a.state;
    assert.equal(d.ready, false);
    if (a.ready) adjOnlyReady = true;
  }
  assert.equal(adjOnlyReady, true, "the cost-basis machine alone would have closed it");
});

// ── End to end through state.js (hold branch order: capital sync → limit), clock passed in ─
let seq = 0;
const SET = [];
const mk = ({ amount = FIX.position.amount_sol_before, rebalance_count = 1, entry_tvl = FIX.position.entry_tvl, hold = true } = {}) => {
  const P = `AVGCOST_${Date.now()}_${++seq}`;
  S.trackPosition({ position: P, pool: "POOL_AVGCOST", pool_name: "JIMMY-SOL", strategy: "spot", amount_sol: amount, initial_value_usd: amount * 66.8, bin_range: { ...FIX.position.bin_range }, active_bin: -380, bin_step: 100, entry_tvl, adopted: true, rebalance_count });
  if (hold) S.setPositionHold(P, true);
  SET.push(P);
  return P;
};
const row = (P, t, diff) => ({
  position: P, pool: "POOL_AVGCOST", pair: "JIMMY-SOL",
  pnl_pct: t.pnl_pct, effective_pnl_pct: t.pnl_pct, active_bin: t.active_bin, in_range: true,
  lower_bin: FIX.position.bin_range.min, upper_bin: FIX.position.bin_range.max,
  pnl_basis: "sol", pnl_management_ready: t.ready, pnl_pct_suspicious: !t.ready,
  pnl_quality: t.ready ? "valid" : "extreme_divergence",
  net_deposit_sol: t.net_deposit_sol, pnl_sol_rule: t.pnl_sol_rule, total_value_usd: t.pnl_pct,
  pnl_pct_diff: t.ready ? (diff !== undefined ? diff : (t.pnl_pct_diff_assumed ?? 0.5)) : 99,
});
/** One held reading: what hold-observer.js + index.js checkHoldThinLimit do, minus I/O. */
const feedRow = (P, p, nowMs, mgmt) => {
  const cap = S.noteHoldCapitalReading(P, p, mgmt, { nowMs });
  if (cap.capitalChanged) return { capitalChanged: true };
  const reading = L.holdThinLimitReading(p, S.getTrackedPosition(P), mgmt);
  const res = S.noteHoldThinLimitReading(P, reading, mgmt, { binStep: 100, nowMs });
  const exit = res?.ready && (res.event === "counted" || res.event === "repeat")
    ? L.buildHoldThinLimitExit({ pnlPct: reading.pnl_pct, heldSec: res.held_sec, entryTvlUsd: res.entry_tvl_usd, cfg: L.holdThinLimitConfig(mgmt), rawPnlPct: reading.raw_pnl_pct, adjusted: reading.adjusted === true })
    : null;
  return { ...res, reading, exit, capitalChanged: false };
};
const feed = (P, t, nowMs, mgmt, diff) => feedRow(P, row(P, t, diff), nowMs, mgmt);
/** Generic simulated stream: st(L, net, { cap, diff, bin, dt, ready }) */
const sim = (P, t0, mgmt = BASE) => {
  let t = t0;
  const st = (Lsol, net, { cap = null, diff = 0.4, bin = -380, dt = 15 * SEC, ready = true, noSol = false } = {}) => {
    t += dt;
    const c = cap ?? S.getTrackedPosition(P).amount_sol;
    const pct = Math.round((Lsol / c) * 10000) / 100;
    return feed(P, { active_bin: bin, pnl_pct: pct, ready, net_deposit_sol: net, pnl_sol_rule: noSol ? undefined : Lsol }, t, mgmt, diff);
  };
  st.now = () => t;
  return st;
};
const T0 = Date.parse("2026-11-25T15:11:13Z");
const tMs = (hhmmss) => {
  const [h, m, s] = hhmmss.split(":").map(Number);
  return T0 + ((h - 22) * 3600 + (m - 11) * 60 + (s - 13.586)) * SEC;
};
const replay = (P, mgmt, { until = "99", diff } = {}) => {
  const out = [];
  for (const t of FIX.ticks) {
    if (t.t > until) break;
    out.push({ t: t.t, ...feed(P, t, tMs(t.t), mgmt, diff) });
  }
  return out;
};

test("JIMMY replay, key false (old behaviour): a streak starts on the −27.3 % reading with no reference", () => {
  const P = mk();
  const ev = replay(P, KEY_OFF, { until: "22:13:05" });
  assert.equal(ev.find((e) => e.capitalChanged).t, "22:12:43.620");
  assert.equal(ev.find((e) => e.t === "22:12:48.571").event, "started");
  assert.equal(S.getTrackedPosition(P).hold_thin_limit.adj, undefined, "one machine");
  assert.ok(near(S.getTrackedPosition(P).avg_cost_basis?.basis_sol, 0.78748, 1e-4), "the basis is recorded either way");
});

test("JIMMY replay, key on, unresolved (over-bound diff): the provisional figure is −8.9 % on the very first settled reading", () => {
  const P = mk();
  const ev = replay(P, BASE, { until: "22:13:05", diff: 10 });
  const settle = ev.find((e) => e.t === "22:12:48.571");
  assert.ok(S.getTrackedPosition(P).avg_cost_basis_pending, "not resolved: 10 pp of ◎0.99 > 3 % of ◎3.03");
  assert.equal(S.getTrackedPosition(P).avg_cost_basis ?? null, null);
  assert.deepEqual([settle.reading.dual, settle.reading.provisional, settle.reading.adjusted], [true, true, true]);
  assert.ok(near(settle.reading.pnl_pct, -8.9, 0.02), `provisional figure ${settle.reading.pnl_pct}`);
  assert.equal(settle.event, "above", "no streak on the cost basis");
  assert.equal(settle.plain.event, "started", "the plain machine does what the old code did");
  for (const e of ev) assert.equal(e.ready === true, false);
});

test("JIMMY replay, key on, clean, through the re-deposit: never ready; final B ≈ ◎2.8288 (L_before)", () => {
  const P = mk();
  const ev = replay(P, BASE);
  for (const e of ev) assert.equal(e.ready === true, false, `${e.t}: never ready`);
  const pos = S.getTrackedPosition(P);
  assert.equal(pos.amount_sol, 2.8465);
  assert.equal(pos.avg_cost_basis_pending, null);
  assert.ok(near(pos.avg_cost_basis.basis_sol, 2.8288, 1e-4), `B ${pos.avg_cost_basis.basis_sol}`);
  assert.deepEqual([pos.avg_cost_basis.l_source, pos.avg_cost_basis.resolved_by, pos.avg_cost_basis.pnl_sol_before, pos.avg_cost_basis.pnl_sol_now], ["before", "clean", -0.269396, -0.20324]);
  const after = ev.find((e) => e.t === "22:17:43.742");
  assert.ok(near(after.reading.pnl_pct, -6.56, 0.05), `figure ≈ −6.6 % at L −0.2032 (got ${after.reading.pnl_pct})`);
});

test("port of crash2: steady 7 pp diff, crash 60 s after a withdrawal → ready ≈ 60–70 s after the cost-basis figure crosses −25 %", () => {
  const P = mk({ amount: 3.0, entry_tvl: 50000 });
  const st = sim(P, Date.parse("2026-11-26T07:00:00Z"));
  let Ls = -0.3, bin = -380, crossAt = null, readyAt = null, plainReadyFirst = null;
  for (let k = 0; k < 5; k++) st(Ls, 3.0, { dt: 5 * SEC, diff: 0.3, bin });
  st(Ls, 1.5, { dt: 5 * SEC, cap: 3.0, diff: 7, bin }); // withdrawal ◎3 → ◎1.5 indexed
  const changeAt = st.now();
  for (let k = 1; k < 200 && readyAt == null; k++) {
    const since = k * 5;
    if (since > 60) { bin -= 1; Ls += (1.5 + Ls) * 0.9 * (Math.pow(1.01, -1) - 1); }
    const r = st(Ls, 1.5, { dt: 5 * SEC, diff: 7, bin });
    if (crossAt == null && r.reading?.adj_ok && r.reading.pnl_pct <= -25) crossAt = since;
    if (plainReadyFirst == null && r.plain?.ready) plainReadyFirst = since;
    if (r.ready) { readyAt = since; assert.equal(r.plain.ready, true); assert.equal(r.adj.ready, true); assert.ok(r.exit); }
  }
  assert.ok(S.getTrackedPosition(P).avg_cost_basis_pending, "still pending (7 pp of ◎1.5 = ◎0.105 > ◎0.09): the provisional basis carried it");
  assert.ok(crossAt != null && readyAt != null, `cross ${crossAt}, ready ${readyAt}`);
  assert.ok(readyAt - crossAt >= 55 && readyAt - crossAt <= 75, `ready ${readyAt - crossAt}s after the crossing`);
  assert.ok(plainReadyFirst <= readyAt, "not before the plain machine");
  assert.ok(st.now() - changeAt < 10 * MIN, "closed long before any timeout (round 3: +665 s, −73 % plain)");
});

test("timeout resolves instead of dropping; the figure does not jump across it", () => {
  const P = mk({ amount: 3.0, entry_tvl: 50000 });
  const st = sim(P, Date.parse("2026-11-26T08:00:00Z"));
  for (let k = 0; k < 3; k++) st(-0.3, 3.0, { diff: 0.3 });
  st(-0.3, 1.5, { cap: 3.0, diff: 7 });
  const figs = [];
  for (let k = 0; k < 50; k++) {
    const r = st(-0.3, 1.5, { diff: 7 });
    figs.push([S.getTrackedPosition(P).avg_cost_basis_pending ? "pending" : "stored", r.reading.pnl_pct]);
  }
  const pos = S.getTrackedPosition(P);
  assert.equal(pos.avg_cost_basis_pending, null);
  assert.equal(pos.avg_cost_basis.resolved_by, "timeout");
  assert.ok(near(pos.avg_cost_basis.basis_sol, 3.0 * 1.2 / 2.7, 1e-5));
  assert.ok(figs.some((f) => f[0] === "pending") && figs.some((f) => f[0] === "stored"));
  for (const f of figs) assert.ok(near(f[1], -10, 0.01), `figure ${f[1]} (${f[0]}) — no jump back to the plain −20 %`);
});

test("a basis is dropped only when the computation fails on the resolving reading", () => {
  const P = mk({ amount: 2.0, entry_tvl: 50000 });
  const st = sim(P, Date.parse("2026-11-26T08:30:00Z"));
  st(-0.2, 2.0); st(-0.2, 1.0, { cap: 2.0 }); st(-0.2, 1.0);
  assert.ok(S.getTrackedPosition(P).avg_cost_basis);
  st(-0.2, 0.5, { cap: 1.0, diff: 9 });      // second withdrawal
  st(-0.6, 0.5, { diff: 0.2 });               // equity after = 0.5 − 0.6 < 0 → guard fails at resolution
  assert.equal(S.getTrackedPosition(P).avg_cost_basis_pending, null);
  assert.equal(S.getTrackedPosition(P).avg_cost_basis, null);
});

test("repro B: two withdrawals, the reading taken before W2 is indexed is not clean", () => {
  const P = mk({ amount: 2.0, entry_tvl: 50000 });
  const st = sim(P, Date.parse("2026-11-26T03:00:00Z"));
  st(-0.3, 2.0, { diff: 0.3 });
  st(-0.3, 1.0, { cap: 2.0, diff: 0.3 });
  st(-0.75, 1.0, { diff: 45 });              // W2 on chain, not indexed: ◎0.45 > ◎0.06
  assert.equal(S.getTrackedPosition(P).avg_cost_basis ?? null, null);
  st(-0.3, 0.55, { cap: 1.0, diff: 0.3 });   // W2 indexed: joins the window
  st(-0.3, 0.55, { diff: 0.3 });
  const b = S.getTrackedPosition(P).avg_cost_basis;
  assert.ok(near(b.basis_sol, 2.0 * 0.25 / 1.7, 1e-5));
  assert.equal(b.flows, 2);
});

test("repro f: an unindexed second flow plus a small real dip does not close it", () => {
  const P = mk({ amount: 2.0, entry_tvl: 50000 });
  const st = sim(P, Date.parse("2026-11-26T04:00:00Z"));
  st(-0.3, 2.0); st(-0.3, 1.4, { cap: 2.0 }); st(-0.3, 1.4);
  let adjReady = false;
  for (const [Lsol, bin] of [[-0.4, -380], [-0.4, -380], [-0.43, -383], [-0.432, -383], [-0.433, -383], [-0.434, -384], [-0.435, -384], [-0.436, -384]]) {
    const r = st(Lsol, 1.4, { bin, diff: 0.5 });
    assert.equal(r.ready === true, false);
    if (r.adj?.ready) adjReady = true;
  }
  assert.equal(adjReady, true, "the cost-basis machine alone would have been ready");
});

test("a real price fall after a round trip closes it at ≈ −25.5 % plain, both machines ready", () => {
  const P = mk({ amount: 3.0276, entry_tvl: 50000 });
  const st = sim(P, Date.parse("2026-11-26T05:00:00Z"));
  const Lj = -0.2694;
  st(Lj, 3.0276); st(Lj, 0.9868, { cap: 3.0276 }); st(Lj, 0.9868); st(Lj, 2.8465, { cap: 0.9868 }); st(Lj, 2.8465);
  assert.ok(near(S.getTrackedPosition(P).avg_cost_basis.basis_sol, 2.8288, 1e-4));
  let first = null, bin = -380;
  for (let Lx = -0.30; Lx >= -0.80 && !first; Lx -= 0.01) {
    bin -= 1;
    let r = st(Lx, 2.8465, { bin });
    if (!r.ready) r = st(Lx - 0.0005, 2.8465, { bin });
    if (r.ready) first = r;
  }
  assert.ok(first);
  assert.ok(first.reading.raw_pnl_pct <= -25 && first.reading.raw_pnl_pct > -26.5, `plain ${first.reading.raw_pnl_pct}`);
  assert.deepEqual([first.plain.ready, first.adj.ready], [true, true]);
});

test("index-lag bound end to end: a price fall before booking picks L_before — an OLD pre-flow value is used too", () => {
  const P = mk({ amount: 2.0, entry_tvl: 50000 });
  const st = sim(P, Date.parse("2026-11-26T07:30:00Z"));
  st(-0.2, 2.0);
  st(-0.35, 1.0, { cap: 2.0, bin: -386 });
  st(-0.35, 1.0, { bin: -386 });
  const b = S.getTrackedPosition(P).avg_cost_basis;
  assert.ok(near(b.basis_sol, 2.0 * 0.8 / 1.8, 1e-5));
  assert.deepEqual([b.l_source, b.pnl_sol_change], ["before", -0.35]);

  const Q = mk({ amount: 2.0, entry_tvl: 50000 });
  const sq = sim(Q, Date.parse("2026-11-26T07:45:00Z"));
  sq(-0.2, 2.0);
  sq(-0.35, 2.0, { ready: false, dt: 12 * MIN });            // 12 min of unusable readings
  sq(-0.35, 1.0, { cap: 2.0, bin: -386 });
  assert.equal(S.getTrackedPosition(Q).avg_cost_basis_pending.pnl_sol_before, -0.2, "a 12-min-old value is used (no age cap)");
  sq(-0.35, 1.0, { bin: -386 });
  const bq = S.getTrackedPosition(Q).avg_cost_basis;
  assert.equal(bq.l_source, "before");
  assert.ok(bq.basis_sol > 2.0 * 0.65 / 1.65 + 0.05, `the larger basis (${bq.basis_sol} vs L_now's ${(2.0 * 0.65 / 1.65).toFixed(4)})`);
});

test("pre-flow reading persisted (≤ once per 60 s, only when it differs); a restart uses it; a stored basis is the last fallback at any age", () => {
  const P = mk({ amount: 2.0, entry_tvl: 50000 });
  const st = sim(P, Date.parse("2026-11-26T08:00:00Z"));
  st(-0.2, 2.0);
  const first = S.getTrackedPosition(P).last_clean_pnl;
  assert.equal(first.pnl_sol, -0.2);
  st(-0.21, 2.0); st(-0.22, 2.0);                              // 15 s / 30 s later: not persisted yet
  assert.deepEqual(S.getTrackedPosition(P).last_clean_pnl, first);
  st(-0.22, 2.0, { dt: 60 * SEC });                            // ≥ 60 s and different: persisted
  assert.equal(S.getTrackedPosition(P).last_clean_pnl.pnl_sol, -0.22);
  st(-0.22, 2.0, { dt: 60 * SEC });                            // same value: no write
  S._resetAvgCostBasisMemory();                                // restart
  st(-0.35, 1.0, { cap: 2.0, bin: -386 });
  assert.equal(S.getTrackedPosition(P).avg_cost_basis_pending.pnl_sol_before, -0.22, "the persisted reading");

  const Q = mk({ amount: 2.0, entry_tvl: 50000 });
  const sq = sim(Q, Date.parse("2026-11-26T08:20:00Z"));
  sq(-0.2, 2.0); sq(-0.2, 1.0, { cap: 2.0 }); sq(-0.2, 1.0);
  const pos = S.getTrackedPosition(Q);
  pos.last_clean_pnl = null;
  pos.avg_cost_basis.at = new Date(sq.now() - 3 * 3600 * SEC).toISOString(); // 3 h old
  S._resetAvgCostBasisMemory();
  sq(-0.3, 1.8, { cap: 1.0 });
  assert.equal(S.getTrackedPosition(Q).avg_cost_basis_pending.pnl_sol_before, -0.2, "the stored basis's own L, whatever its age");
  S.recordClose(Q, "test");
  assert.equal(S.getTrackedPosition(Q).last_clean_pnl, null, "cleared on close");
});

/**
 * Port of the reviewer's scenario harness (lenient.mjs): a flow LANDS at tick `land` and is booked
 * by Meteora `lag` ticks later; until then our reading shows the flow as PnL (a withdrawal as a
 * fake loss) and Meteora's figure lags the same, so diff = |fake| / C (+ offset). Truth: the
 * unitised basis moves at landing. Returns the stored basis, the true basis, and when the true
 * cost-basis loss (and the plain one) first reached −25 % vs when the rule became ready.
 */
const scenario = ({ C0 = 3.0276, L0 = -0.2694, flows, crash = () => 0, offset = 0.3, ticks = 320, restartAt = null, cleanBefore = true }) => {
  const P = mk({ amount: C0, entry_tvl: 50000 });
  S._resetAvgCostBasisMemory();
  let t = Date.parse("2026-11-26T11:00:00Z"), bin = -380, Lt = L0, D = C0, Didx = C0, fake = 0, Btrue = C0;
  let crossAt = null, readyAt = null, plainReadyFirst = null;
  for (let k = 0; k < ticks && readyAt == null; k++) {
    t += 5 * SEC;
    if (restartAt === k) S._resetAvgCostBasisMemory();
    const db = crash(k);
    if (db) { bin += db; Lt += (D + Lt) * 0.85 * (Math.pow(1.01, db) - 1); }
    for (const f of flows) {
      if (f.land === k) { const E = D + Lt; Btrue *= (E + f.dSol) / E; D += f.dSol; fake += -f.dSol; }
      if (f.land + f.lag === k) { Didx += f.dSol; fake -= -f.dSol; }
    }
    const C = S.getTrackedPosition(P).amount_sol;
    const Lread = Lt - fake;
    const pct = Math.round((Lread / C) * 10000) / 100;
    const diff = Math.abs(fake) / C * 100 + offset;
    const ready = diff <= 50;
    const p = {
      position: P, pool: "POOL_AVGCOST", pair: "LN-SOL", pnl_pct: pct, active_bin: bin, in_range: true, lower_bin: -600, upper_bin: -300,
      pnl_basis: "sol", pnl_management_ready: ready, pnl_pct_suspicious: !ready, pnl_quality: ready ? "valid" : "extreme_divergence",
      net_deposit_sol: Didx, pnl_sol_rule: Math.round(Lread * 1e6) / 1e6, total_value_usd: pct,
      pnl_pct_diff: !cleanBefore && k < flows[0].land + flows[0].lag ? null : Math.round(diff * 100) / 100,
    };
    const trueAdj = ((D + Lt - Btrue) / Btrue) * 100, truePlain = (Lt / D) * 100;
    const r = feedRow(P, p, t, BASE);
    if (crossAt == null && trueAdj <= -25 && truePlain <= -25) crossAt = k * 5;
    if (r.capitalChanged) continue;
    if (plainReadyFirst == null && r.plain?.ready) plainReadyFirst = k * 5;
    if (r.ready && (r.event === "counted" || r.event === "repeat")) readyAt = k * 5;
  }
  return { P, pos: S.getTrackedPosition(P), Btrue, crossAt, readyAt, plainReadyFirst };
};

test("repro (i): withdrawal booked 9 min after landing, price falling meanwhile, pre-flow reading 9 min old → B ≈ the true ◎0.78", () => {
  // lands k10, booked k118 (9 min); 0.1 bin / tick fall during the lag (≈ 11 bins, the true
  // cost-basis loss stays above −25 % until after the booking), flat for 2 min, then a crash
  const r = scenario({ flows: [{ land: 10, lag: 108, dSol: -2.0408 }], crash: (k) => (k >= 10 && k < 118 ? -0.1 : k >= 142 ? -1 : 0) });
  const b = r.pos.avg_cost_basis;
  assert.equal(b.l_source, "before", "the 9-min-old pre-flow L (round 4's 6-min cap gave L_now and ◎0.65)");
  assert.ok(near(b.basis_sol, r.Btrue, 0.01) && b.basis_sol >= r.Btrue - 1e-6, `stored ${b.basis_sol} vs true ${r.Btrue.toFixed(4)}`);
  assert.ok(r.crossAt != null && r.readyAt != null, JSON.stringify(r));
  assert.ok(r.crossAt > 118 * 5, `the true crossing (${r.crossAt}s) comes after the booking`);
  assert.ok(r.readyAt - r.crossAt >= 55 && r.readyAt - r.crossAt <= 80, `ready ${r.readyAt - r.crossAt}s after the true crossing (${JSON.stringify({ cross: r.crossAt, ready: r.readyAt, B: b.basis_sol, Btrue: r.Btrue })})`);
});

test("repro (ii): a restart between landing and booking uses the persisted pre-flow reading", () => {
  const r = scenario({ flows: [{ land: 10, lag: 60, dSol: -2.0408 }], crash: (k) => (k >= 10 && k < 70 ? -0.3 : 0), restartAt: 40, ticks: 90 });
  const pend = r.pos.avg_cost_basis_pending;
  const b = r.pos.avg_cost_basis;
  assert.ok(b || pend);
  const before = (b ?? pend).pnl_sol_before;
  assert.ok(near(before, -0.2694, 1e-4), `pre-flow L ${before} (memory was empty after the restart)`);
  if (b) assert.ok(b.basis_sol >= r.Btrue - 1e-6, `stored ${b.basis_sol} ≥ true ${r.Btrue.toFixed(4)}`);
});

test("repro (iii): timeout with no pre-flow reading and a crash during the pending window → the change-tick L bounds the basis", () => {
  // No clean reading before the flow (every pre-booking reading has no reported figure), a
  // systematic 12 pp gap afterwards (never clean → timeout), and a crash that starts right after
  // the booking. L_now at the timeout is the crashed one (a withdrawal: lower L → smaller, more
  // lenient B); the booking tick's L is pre-crash and wins. Remaining leniency: the change-tick L
  // already contains any fall between landing and booking (here 12 ticks at −0.3 bin), so B sits
  // slightly under the true one — the figure reads that much above the exact cost-basis loss.
  const r = scenario({ flows: [{ land: 10, lag: 12, dSol: -2.0408 }], crash: (k) => (k >= 10 && k < 22 ? -0.3 : k >= 23 ? -0.12 : 0), offset: 12, cleanBefore: false, ticks: 200 });
  const b = r.pos.avg_cost_basis;
  assert.ok(b, "resolved");
  assert.equal(b.resolved_by, "timeout");
  assert.equal(b.pnl_sol_before, null, "no pre-flow reading");
  assert.equal(b.l_source, "change");
  assert.ok(b.pnl_sol_change > b.pnl_sol_now, "the crash lowered L_now");
  const withNow = CR.nextAvgCostBasis(null, { fromSol: 3.0276, toSol: 0.9868, pnlSol: b.pnl_sol_now }).basis.basis_sol;
  assert.ok(b.basis_sol > withNow, `the change tick bounds it: ${b.basis_sol} > L_now's ${withNow}`);
  assert.ok(b.basis_sol <= r.Btrue && r.Btrue - b.basis_sol < 0.02, `residual leniency: stored ${b.basis_sol} vs true ${r.Btrue.toFixed(4)}`);
});

test("a plain top-up with no basis opens no marker: identical to the key being off", () => {
  const run = (mgmt) => {
    const P = mk({ amount: 1.0, entry_tvl: 50000 });
    const st = sim(P, Date.parse("2026-11-26T09:00:00Z"), mgmt);
    const out = [];
    for (const [Lsol, net, cap, bin] of [[-0.05, 1.0, null, -380], [-0.05, 1.5, 1.0, -380], [-0.4, 1.5, null, -400], [-0.41, 1.5, null, -401], [-0.42, 1.5, null, -402], [-0.43, 1.5, null, -403], [-0.44, 1.5, null, -404], [-0.45, 1.5, null, -405]]) {
      const r = st(Lsol, net, { cap, bin });
      out.push([r.capitalChanged, r.event, r.ready === true, r.reading?.ok, r.reading?.dual]);
      assert.equal(S.getTrackedPosition(P).avg_cost_basis_pending ?? null, null);
    }
    return out;
  };
  const on = run(BASE), off = run(KEY_OFF);
  assert.deepEqual(on, off);
  assert.ok(on.some((x) => x[2]));
});

test("old vs new, end to end with the clock passed in: never ready where the old plain rule is not", () => {
  const rnd = mulberry32(4242);
  let readyNew = 0, steps = 0, pendingSteps = 0, timeouts = 0, noSol = 0;
  for (let run = 0; run < 70; run++) {
    S._resetAvgCostBasisMemory();
    const C0 = 0.5 + rnd() * 3;
    const P = mk({ amount: C0, entry_tvl: 50000 });
    let t = Date.parse("2026-11-26T12:00:00Z") + run * 3600 * SEC, D = C0, Ls = (rnd() - 0.6) * 0.3 * C0, bin = -380, oldState = null;
    for (let k = 0; k < 110; k++) {
      t += 5 * SEC + (rnd() < 0.05 ? 4 * MIN : 0);
      const r = rnd();
      const db = r < 0.15 ? -Math.ceil(rnd() * 4) : r < 0.25 ? Math.ceil(rnd() * 3) : 0;
      if (db) { bin += db; Ls += (D + Ls) * 0.8 * (Math.pow(1.01, db) - 1); }
      const capBefore = S.getTrackedPosition(P).amount_sol;
      const fr = rnd();
      if (fr < 0.03 && D + Ls > 0.1) D = Math.max(0.05, D - (D + Ls) * (0.2 + rnd() * 0.6));
      else if (fr < 0.045) D += 0.2 + rnd() * 2;
      const missing = rnd() < 0.1;
      if (missing) noSol++;
      const ready = rnd() > 0.08;
      const p = {
        position: P, pool: "POOL_AVGCOST", pair: "FZ-SOL", pnl_pct: Math.round((Ls / capBefore) * 10000) / 100, active_bin: bin, in_range: true,
        lower_bin: -389, upper_bin: -321, pnl_basis: "sol", pnl_management_ready: ready, pnl_pct_suspicious: !ready, pnl_quality: ready ? "valid" : "extreme_divergence",
        net_deposit_sol: Math.round(D * 1e4) / 1e4, pnl_sol_rule: missing ? undefined : Ls, total_value_usd: Ls,
        pnl_pct_diff: rnd() < 0.15 ? null : Math.round(rnd() * 12 * 100) / 100,
      };
      const res = feedRow(P, p, t, BASE);
      const pos = S.getTrackedPosition(P);
      if (pos.avg_cost_basis_pending) pendingSteps++;
      if (pos.avg_cost_basis?.resolved_by === "timeout") timeouts++;
      // the old rule: the same capital sync, then one plain machine (current module with the key off)
      if (res.capitalChanged) { oldState = null; continue; }
      const o = L.advanceHoldThinLimit(oldState, L.holdThinLimitReading(p, pos, KEY_OFF), CFG, { binStep: 100, nowMs: t });
      oldState = o.state;
      steps++;
      if (res.ready && (res.event === "counted" || res.event === "repeat")) {
        readyNew++;
        assert.equal(o.ready && (o.event === "counted" || o.event === "repeat"), true, `run ${run} step ${k}: new ready, old not`);
      }
    }
    S.recordClose(P, "fuzz");
  }
  assert.ok(readyNew > 10 && pendingSteps > 100 && timeouts > 0 && noSol > 100, `ready ${readyNew}, pending ${pendingSteps}, timeouts ${timeouts}, no-SOL rows ${noSol} of ${steps}`);
});

test("Telegram note at the resolution — only for a net withdrawal, held, thin, enforce, not exempt, key on", async () => {
  const seen = [];
  S.setAvgCostBasisNotifier((info) => { seen.push(info); return Promise.reject(new Error("send failed")); });
  try {
    replay(mk(), BASE);
    assert.equal(seen.length, 1, "the withdrawal, not the re-deposit");
    assert.deepEqual([seen[0].from_sol, seen[0].to_sol, seen[0].flows, seen[0].plain_pnl_pct], [3.0276, 0.9868, 1, -27.3]);
    assert.ok(near(seen[0].limit_pnl_pct, -8.9, 0.02));
    seen.length = 0;
    replay(mk(), KEY_OFF);
    replay(mk(), { ...BASE, holdThinPoolLimitMode: "off" });
    replay(mk({ entry_tvl: 336184 }), BASE);
    const X = mk();
    S.setHoldThinLimitExempt(X, true);
    replay(X, BASE);
    assert.equal(seen.length, 0);
  } finally { S.setAvgCostBasisNotifier(null); }
  const I = await import("../index.js");
  assert.match(I.avgCostBasisAlertText({ pair: "J-SOL", from_sol: 3, to_sol: 1, flows: 1, basis_sol: 0.8, limit_pnl_pct: -9, plain_pnl_pct: -27, limit_pct: -25 }), /partial withdrawal[\s\S]*closes only when both figures/);
  assert.match(I.avgCostBasisAlertText({ pair: "X-SOL", from_sol: 2, to_sol: 0.55, flows: 2, basis_sol: 0.29, limit_pnl_pct: -15, plain_pnl_pct: -54, limit_pct: -25 }), /capital changes \(net withdrawal\)[\s\S]*over 2 changes/);
});

test("log lines: marker opened, clean resolution with diff and lag, timeout with the smallest diff", () => {
  const lines = [];
  const orig = console.error;
  console.error = (l) => { lines.push(String(l)); };
  try {
    const P = mk({ amount: 2.0, entry_tvl: 50000 });
    const st = sim(P, Date.parse("2026-11-26T10:00:00Z"));
    st(-0.2, 2.0, { diff: 0.4 }); st(-0.2, 1.0, { cap: 2.0, diff: 0.4 }); st(-0.2, 1.0, { diff: 7.5 }); st(-0.2, 1.0, { diff: null }); st(-0.2, 1.0, { diff: 1.25 });
    assert.ok(lines.some((l) => /capital ◎2\.0000 → ◎1\.0000 — cost basis pending until a clean reading .* provisional cost-basis figure -10\.00% vs -20\.00% on net capital/.test(l)), "marker-open line");
    assert.ok(lines.some((l) => /resolved 45s after the last change on a clean reading, diff 1\.25 pp = ◎0\.0125 ≤ ◎0\.0600 .*resolved_by=clean/.test(l)), "clean resolution line");
    st(-0.2, 0.6, { cap: 1.0, diff: 9 });
    st(-0.2, 0.6, { diff: 6.2 }); st(-0.2, 0.6, { diff: 5.5 }); st(-0.2, 0.6, { diff: null });
    st(-0.2, 0.6, { diff: 8, dt: 10 * MIN });
    const tl = lines.find((l) => l.includes("resolved by timeout"));
    assert.match(tl, /smallest diff seen 5\.50 pp = ◎0\.0330, bound ◎0\.0300; 1 reading without a reported figure; this reading diff 8\.00 pp/);
    assert.match(tl, /resolved_by=timeout/);
  } finally { console.error = orig; }
});

test("hold release / re-hold / exemption keep the basis; every close path clears it; a reopened row gets it back", () => {
  const P = mk();
  replay(P, BASE, { until: "22:13:05" });
  const before = { ...S.getTrackedPosition(P).avg_cost_basis };
  S.setPositionHold(P, false); S.setPositionHold(P, true);
  S.setHoldThinLimitExempt(P, true); S.setHoldThinLimitExempt(P, false);
  assert.deepEqual(S.getTrackedPosition(P).avg_cost_basis, before);
  S.recordClose(P, "test close");
  let pos = S.getTrackedPosition(P);
  assert.equal(pos.avg_cost_basis, null);
  assert.deepEqual(PR.avgCostBasisRecordField(pos), { basis_sol: before.basis_sol, changes: 1, at: before.at });
  S.adoptOrphanPosition({ position: P, pool: "POOL_AVGCOST", pair: "JIMMY-SOL", lower_bin: -389, upper_bin: -321, active_bin: -380, net_deposit_sol: 0.9868 }, { reason: "test" });
  pos = S.getTrackedPosition(P);
  assert.equal(pos.avg_cost_basis.basis_sol, before.basis_sol);
  assert.equal(pos.avg_cost_basis_at_close, null);
  const Q = mk();
  replay(Q, BASE, { until: "22:13:05" });
  assert.equal(S.markPositionClosedByReconciliation(Q, { minAgeMinutes: 0 }), true);
  assert.equal(S.getTrackedPosition(Q).avg_cost_basis, null);
  assert.ok(S.getTrackedPosition(Q).avg_cost_basis_at_close);
  const R = mk();
  replay(R, BASE, { until: "22:13:05" });
  S.getTrackedPosition(R).deployed_at = new Date(Date.now() - 3600_000).toISOString();
  S.syncOpenPositions([], { authoritative: true });
  assert.equal(S.getTrackedPosition(R).avg_cost_basis, null);
  assert.ok(S.getTrackedPosition(R).avg_cost_basis_at_close);
  const U = mk();
  replay(U, BASE, { until: "22:12:44" });
  assert.ok(S.getTrackedPosition(U).avg_cost_basis_pending);
  S.recordClose(U, "test");
  assert.equal(S.getTrackedPosition(U).avg_cost_basis_pending, null);
});

test("several changes inside one pending window resolve as one (from the first change's capital)", () => {
  const P = mk({ amount: 2.0, entry_tvl: 50000 });
  const st = sim(P, Date.parse("2026-11-26T06:00:00Z"));
  st(-0.2, 2.0, { diff: 0.2 }); st(-0.2, 1.5, { cap: 2.0, diff: 0.2 }); st(-0.2, 1.5, { diff: 8 }); st(-0.2, 1.0, { cap: 1.5, diff: 0.2 });
  assert.deepEqual([S.getTrackedPosition(P).avg_cost_basis_pending.changes, S.getTrackedPosition(P).avg_cost_basis_pending.from_sol], [2, 2.0]);
  st(-0.2, 1.0, { diff: 0.2 });
  const b = S.getTrackedPosition(P).avg_cost_basis;
  assert.ok(near(b.basis_sol, 2.0 * 0.8 / 1.8, 1e-5));
  assert.deepEqual([b.from_sol, b.to_sol, b.flows, b.changes], [2.0, 1.0, 2, 1]);
});

test("non-re-ranged position (percent on gross deposits): the figure equals the plain one throughout", () => {
  const P = mk({ amount: 1, rebalance_count: 0 });
  let t = Date.parse("2026-11-26T01:00:00Z");
  const tick = (pnlSol, bin, net) => ({ active_bin: bin, pnl_pct: Math.round(pnlSol * 10000) / 100, ready: true, net_deposit_sol: net, pnl_sol_rule: pnlSol });
  for (const s of [tick(-0.089, -380, 1), tick(-0.089, -380, 0.4), tick(-0.089, -380, 0.4), tick(-0.12, -384, 0.4), tick(-0.2, -392, 0.4), tick(-0.26, -400, 0.4)]) {
    t += 15 * SEC;
    const r = feed(P, s, t, BASE, 0.3);
    if (r.capitalChanged) continue;
    assert.equal(r.reading.pnl_pct, s.pnl_pct);
    assert.equal(r.reading.adjusted, false);
  }
  assert.ok(near(S.getTrackedPosition(P).avg_cost_basis.basis_sol, 0.34138, 1e-4));
});

test("evaluator (not held): resolved there too, never on the change tick", () => {
  const P = mk({ amount: 1, hold: false });
  const mgmt = { ...BASE, stopLossPct: -50, trailingTakeProfit: true, trailingDropPct: 1.5 };
  const base = { in_range: true, lower_bin: -389, upper_bin: -321, active_bin: -380, pnl_basis: "sol", pnl_management_ready: true, pnl_quality: "valid", pnl_pct_diff: 0.4 };
  const t0 = Date.parse("2026-11-26T02:00:00Z");
  S.updatePnlAndCheckExits(P, { ...base, pnl_pct: -8.9, effective_pnl_pct: -8.9, net_deposit_sol: 0.4, pnl_sol_rule: -0.089 }, mgmt, { nowMs: t0 });
  assert.ok(S.getTrackedPosition(P).avg_cost_basis_pending);
  S.updatePnlAndCheckExits(P, { ...base, pnl_pct: -22.25, effective_pnl_pct: -22.25, net_deposit_sol: 0.4, pnl_sol_rule: -0.089, pnl_pct_diff: 9 }, mgmt, { nowMs: t0 + 15 * SEC });
  assert.equal(S.getTrackedPosition(P).avg_cost_basis ?? null, null, "9 pp of ◎0.4 = ◎0.036 > ◎0.03");
  S.updatePnlAndCheckExits(P, { ...base, pnl_pct: -22.25, effective_pnl_pct: -22.25, net_deposit_sol: 0.4, pnl_sol_rule: -0.089 }, mgmt, { nowMs: t0 + 30 * SEC });
  assert.ok(near(S.getTrackedPosition(P).avg_cost_basis.basis_sol, 0.34138, 1e-4));
});

test("card field shows the provisional figure while pending", () => {
  const tracked = { hold_mode: true, entry_tvl: 50000, amount_sol: 1.0, avg_cost_basis_pending: { from_sol: 3.0, changes: 1 } };
  const c = L.avgCostBasisCardFields(tracked, { pnl_pct: -30, pnl_sol_rule: -0.3 }, BASE);
  assert.ok(near(c.hold_thin_limit_pnl_pct, -10, 0.01));
  assert.equal(c.avg_cost_basis_sol, null);
  assert.equal(L.avgCostBasisCardFields(tracked, { pnl_pct: -30 }, BASE).hold_thin_limit_pnl_pct, null, "no SOL figure: null");
});

// ── pnl_sol_rule on the scan paths, through the real valuation ───────────────────────
test("calculateAssetAwareValue: pnl_sol_rule = pnl_pct × the percent basis / 100", async () => {
  const { calculateAssetAwareValue, pnlPctBasisSol } = await import("../tools/pnl.js");
  const { config } = await import("../config.js");
  const SOL = config.tokens.SOL, X = "BASEMINT111111111111111111111111111111111111";
  const f = { tokenXMint: X, tokenYMint: SOL, decX: 6, decY: 9, xRaw: 300000 * 1e6, yRaw: 0.2 * 1e9, feeXRaw: 1e6, feeYRaw: 1e6, active: -380, binStep: 100, lower: -389, upper: -321 };
  const meteora = { allTimeDeposits: { total: { sol: 6.0, usd: 400 } }, allTimeWithdrawals: { total: { sol: 5.0132, usd: 335 } }, allTimeFees: { total: { sol: 0.01, usd: 0.7 } }, pnlSolPctChange: -1.0 };
  for (const tracked of [{ amount_sol: 0.9868, rebalance_count: 1 }, { amount_sol: 0.9868, rebalance_count: 0 }]) {
    const v = calculateAssetAwareValue(f, { [SOL]: 66.8 }, 66.8, meteora, true, tracked);
    const basis = pnlPctBasisSol(tracked, v.depositsSol);
    const rowPct = Math.round(v.ourPct * 100) / 100, rowSol = Math.round(v.pnlSol * 1e6) / 1e6;
    assert.ok(Math.abs((rowPct * basis) / 100 - rowSol) <= (0.005 * basis) / 100 + 1e-6);
    assert.equal(basis, tracked.rebalance_count ? 0.9868 : 6.0);
  }
  const src = fs.readFileSync(new URL("../tools/pnl.js", import.meta.url), "utf8");
  assert.match(src, /pnl_sol_rule:\s+round\(pnlSol, 6\),/);
  const dl = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.match(dl, /pnl_sol_rule:\s+ruleBaseSol > 0 && \(reportedPnlPct \?\? derivedPnlPct\) != null \? roundNum/);
  assert.match(dl, /pnl_sol_rule: p\.pnl_sol_rule \?\? null,/);
  assert.match(dl, /pnl_sol_rule:\s+!lpData && binData && pnlPctBasisSol\(tracked, depSolForPct\) > 0/);
});

test("update_config holdThinPoolAvgCostBasis=\"false\" ends up boolean false; config load reads \"false\" as false", async () => {
  const { config } = await import("../config.js");
  const { executeTool } = await import("../tools/executor.js");
  const before = config.management.holdThinPoolAvgCostBasis;
  try {
    assert.equal((await executeTool("update_config", { changes: { holdThinPoolAvgCostBasis: "false" }, reason: "test" })).success, true);
    assert.equal(config.management.holdThinPoolAvgCostBasis, false);
    assert.equal((await executeTool("update_config", { changes: { holdThinPoolAvgCostBasis: "true" }, reason: "test" })).success, true);
    assert.equal(config.management.holdThinPoolAvgCostBasis, true);
    await executeTool("update_config", { changes: { holdThinPoolAvgCostBasis: "nope" }, reason: "test" });
    assert.equal(config.management.holdThinPoolAvgCostBasis, true);
  } finally { config.management.holdThinPoolAvgCostBasis = before; }
  assert.equal(L.avgCostBasisEnabled({ holdThinPoolAvgCostBasis: "false" }), false);
});

test("close reason: canonical prefix; unadjusted wording unchanged", () => {
  const adj = L.buildHoldThinLimitExit({ pnlPct: -25.3, heldSec: 62, entryTvlUsd: 77300, cfg: CFG, rawPnlPct: -41.0, adjusted: true });
  assert.equal(adj.reason, "Thin-pool hold limit: PnL -25.3% on the cost basis of what is left after a partial withdrawal (-41.0% on net capital) at or under -25% for 62s on a held position (pool TVL at entry $77,300, under $100,000) — hard exit (overrides HOLD)");
  const plain = L.buildHoldThinLimitExit({ pnlPct: -26.1, heldSec: 65, entryTvlUsd: 77321, cfg: CFG });
  assert.equal(plain.reason, "Thin-pool hold limit: PnL -26.1% at or under -25% for 65s on a held position (pool TVL at entry $77,321, under $100,000) — hard exit (overrides HOLD)");
});

test("cleanup", () => { for (const P of SET) { try { S.recordClose(P, "cleanup"); } catch { /* ignore */ } } });
