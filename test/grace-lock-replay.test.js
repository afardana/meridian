import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmPeakStep, simulateLock, filterReadings, deltaSol, checksFor, summarize, maxGapMs,
  graceWindowsFor, latencyExit, holdIntervals, lockCostShares, withReconfirm, PRIMARY,
} from "../scripts/replay/grace_lock_replay.js";

// readings from a pnl list: 5 s apart, bin = index so every reading is distinct unless noted
const R = (pnls, { t0 = 1_000_000, bins = null } = {}) =>
  filterReadings(pnls.map((pnl, i) => ({ t: t0 + i * 5000, a: bins ? bins[i] : i, pnl }))).kept;

test("confirmPeakStep: two consecutive readings above the peak confirm the lower one", () => {
  const st = { peak: 1, pending: null, count: 0 };
  confirmPeakStep(st, 5);
  assert.equal(st.peak, 1);
  confirmPeakStep(st, 4);
  assert.equal(st.peak, 4, "the lower of the two");
  confirmPeakStep(st, 9);
  confirmPeakStep(st, 3.5); // ≤ peak → pending dropped
  assert.equal(st.peak, 4);
  assert.equal(st.pending, null);
  confirmPeakStep(st, 9);
  assert.equal(st.peak, 4, "a single reading never confirms");
});

test("lock arms only once the confirmed peak reaches A", () => {
  // peak confirmed at 9.9 (< 10): a 6 pp drop never fires
  const below = simulateLock(R([0, 9.9, 9.9, 3, 2, 1]), PRIMARY);
  assert.equal(below.fired, false);
  assert.equal(below.armed, false);
  // an unconfirmed single spike to 20 does not arm either
  const spike = simulateLock(R([0, 20, 2, 2.5, 1]), PRIMARY);
  assert.equal(spike.fired, false);
});

test("lock fires on the second consecutive distinct reading at or under peak − D; exit = that reading", () => {
  const r = simulateLock(R([0, 12, 11, 8, 6, 5.5, 4]), PRIMARY); // peak 11 → threshold 6
  assert.equal(r.fired, true);
  assert.equal(r.peak_at_fire, 11);
  assert.equal(r.exit_pnl, 5.5, "6 is the first breach, 5.5 the second");
});

test("a distinct reading above the threshold resets the breach streak; repeats are ignored", () => {
  const reset = simulateLock(R([0, 12, 11, 6, 7, 5, 8]), PRIMARY);
  assert.equal(reset.fired, false, "6 then 7 (reset) then 5 then 8 (reset)");
  // a repeated reading (same pnl AND bin) is not a second breach
  const rep = simulateLock(R([0, 12, 11, 6, 6, 6], { bins: [0, 1, 2, 3, 3, 3] }), PRIMARY);
  assert.equal(rep.fired, false);
  // with the 30 s reconfirm sensitivity an unchanged reading counts again after 30 s
  const ticks = [0, 12, 11, 6].map((pnl, i) => ({ t: i * 5000, a: i, pnl }));
  ticks.push({ t: 15000 + 31000, a: 3, pnl: 6 });
  const kept = filterReadings(ticks).kept;
  assert.equal(simulateLock(kept, PRIMARY).fired, false);
  assert.equal(simulateLock(withReconfirm(kept), PRIMARY).fired, true);
});

test("keep-half fires at peak ÷ 2", () => {
  const v = { id: "half", A: 10, D: null, mode: "half" };
  const r = simulateLock(R([0, 12, 11, 6, 5.5, 5, 5.4]), v); // peak 11 → threshold 5.5
  assert.equal(r.fired, true);
  assert.equal(r.exit_pnl, 5);
});

test("the starting reading is the starting peak (an initial reading ≥ A arms at once)", () => {
  const r = simulateLock(R([12, 11, 6, 6.5, 6.9]), PRIMARY); // peak 12 → threshold 7
  assert.equal(r.fired, true);
  assert.equal(r.exit_pnl, 6.5);
  const none = simulateLock(R([12, 11, 6, 6.5, 6.9]), PRIMARY, { initialPeak: "none" });
  assert.equal(none.fired, false, "without a starting peak 12/11 confirm 11 → threshold 6: only one breach");
});

test("reading filters: missing-price rows and > 15 pp jumps vs the last kept reading are dropped", () => {
  const { kept, droppedMissing, droppedJump } = filterReadings([
    { t: 0, a: 1, pnl: 1 }, { t: 5, a: 1, pnl: -100 }, { t: 10, a: 2, pnl: 419 }, { t: 15, a: 2, pnl: 418.6 },
    { t: 20, a: 3, pnl: 1.5 }, { t: 25, a: 3, pnl: null }, { t: 30, a: 4, pnl: 16.6 },
  ]);
  assert.deepEqual(kept.map((k) => k.pnl), [1, 1.5]);
  assert.equal(droppedMissing, 2);
  assert.equal(droppedJump, 3, "419, 418.6 (vs kept 1), and 16.6 (15.1 from 1.5)");
  const raw = filterReadings([{ t: 0, a: 1, pnl: 1 }, { t: 10, a: 2, pnl: 419 }, { t: 15, a: 2, pnl: 418.6 }], { jumpRef: "raw" });
  assert.deepEqual(raw.kept.map((k) => k.pnl), [1, 418.6], "vs the previous RAW reading the second spike row passes");
});

test("Δ arithmetic", () => {
  // (8 − 2)/100 × 0.5 − 0.002 + 0.001
  assert.ok(Math.abs(deltaSol({ exitPnl: 8, recPnl: 2, amountSol: 0.5, lockCostSol: 0.002, ownCostSol: 0.001 }) - 0.029) < 1e-12);
  assert.ok(Math.abs(deltaSol({ exitPnl: 5, recPnl: 15, amountSol: 1, lockCostSol: 0, ownCostSol: 0 }) + 0.1) < 1e-12);
});

test("lock exit cost: median share per owner over trailing closes that carry exit_slippage_sol", () => {
  const recs = [
    { exit_family: "trailing_tp", adopted: true, amount_sol: 1, exit_slippage_sol: 0.004 },
    { exit_family: "trailing_tp", adopted: true, amount_sol: 2, exit_slippage_sol: 0.002 },
    { exit_family: "trailing_tp", adopted: true, amount_sol: 1 },
    { exit_family: "stop_loss", adopted: false, amount_sol: 1, exit_slippage_sol: 0.05 },
    { exit_family: "trailing_tp", adopted: false, amount_sol: 1, exit_slippage_sol: 0.003 },
  ];
  const c = lockCostShares(recs);
  assert.equal(c.operator.share, 0.0025);
  assert.equal(c.operator.n, 2);
  assert.equal(c.operator.share_zero_filled, 0.001);
  assert.equal(c.bot.share, 0.003);
});

test("gap rule includes the grace boundaries", () => {
  const ticks = [{ t: 100 }, { t: 105 }, { t: 400 }];
  assert.equal(maxGapMs(ticks, 0, 500).gap, 295);
  assert.equal(maxGapMs(ticks, 0, 1000).gap, 600, "last row → grace end");
  assert.equal(maxGapMs([], 0, 10).n, 0);
});

test("latency exit: first kept reading ≥ 30 s after the fire, else the last before the close", () => {
  const kept = [{ t: 0, pnl: 1 }, { t: 20_000, pnl: 2 }, { t: 31_000, pnl: 3 }, { t: 60_000, pnl: 4 }];
  assert.deepEqual(latencyExit(kept, 0, 100_000), { pnl: 3, t: 31_000, fallback: false });
  assert.deepEqual(latencyExit(kept, 0, 25_000), { pnl: 2, t: 20_000, fallback: true });
});

test("grace windows: adoption from the row cut by a release; straddles from events + row; next straddle cuts", () => {
  const H = 3600_000;
  const w = {
    adopted_at: 0, straddled_at: 3 * H, profit_grace_until: 4 * H, profit_grace_released_at: null,
    events: [{ kind: "adopt", t: 0 }, { kind: "grace_release", t: 0.5 * H }, { kind: "straddle", t: 2 * H }, { kind: "straddle", t: 3 * H + 1000 }],
  };
  const g = graceWindowsFor({ adopted: true, straddle_count: 2 }, w, 10 * H);
  assert.equal(g.length, 3);
  assert.deepEqual([g[0].kind, g[0].start, g[0].end, g[0].ended_by, g[0].source], ["adoption", 0, 0.5 * H, "release", "row"]);
  assert.deepEqual([g[1].kind, g[1].start, g[1].end, g[1].source], ["straddle", 2 * H, 3 * H, "events"]);
  assert.deepEqual([g[2].kind, g[2].start, g[2].end, g[2].source], ["straddle", 3 * H, 4 * H, "row"]);
  // the record's grace_shadow wins for its grace
  const rec = { adopted: true, straddle_count: 0, grace_shadow: { kind: "adoption", started_at: new Date(10_000).toISOString(), ended_at: new Date(10_000 + 20 * 60_000).toISOString(), ended_by: "timer", planned_min: 60 } };
  const g2 = graceWindowsFor(rec, { adopted_at: 0, events: [] }, 10 * H);
  assert.deepEqual([g2[0].source, g2[0].start, g2[0].end], ["record", 10_000, 10_000 + 20 * 60_000]);
  // adopted with no row and no events: the first 60 min of the tick path
  const g3 = graceWindowsFor({ adopted: true }, null, 10 * H, [{ t: 777 }]);
  assert.deepEqual([g3[0].source, g3[0].start, g3[0].end], ["tick_fallback", 777, 777 + H]);
  // close cuts the window
  const g4 = graceWindowsFor({ adopted: true }, { adopted_at: 0, events: [] }, 0.25 * H);
  assert.equal(g4[0].end, 0.25 * H);
});

test("hold intervals from events", () => {
  const iv = holdIntervals({ events: [{ kind: "hold", t: 10 }, { kind: "resume", t: 20 }, { kind: "hold", t: 30 }] }, 100);
  assert.deepEqual(iv, [{ from: 10, to: 20 }, { from: 30, to: 100 }]);
});

test("verdict: insufficient below 15 fires; met when all checks pass; not_met otherwise", () => {
  const mk = (deltas, kind = "straddle") => deltas.map((d, i) => ({ delta: d, delta_cost2: d - 0.0001, delta_latency: d, t_close: i, kind }));
  assert.equal(checksFor(summarize(mk(Array(14).fill(0.01)))).verdict, "insufficient");
  const good = checksFor(summarize(mk(Array(15).fill(0.01))));
  assert.equal(good.verdict, "met");
  assert.deepEqual(good.proposed_kinds, ["straddle"]);
  // one large truncation: check 5 fails
  const bad = checksFor(summarize(mk([...Array(14).fill(0.01), -0.08])));
  assert.equal(bad.checks.find((c) => c.id === 5).pass, false);
  assert.equal(bad.verdict, "not_met");
  // better ≥ 1.5 × worse with ties
  const s = summarize(mk([0.01, 0.01, 0.01, -0.001, -0.001, 0.0004]));
  assert.deepEqual([s.better, s.worse, s.tie], [3, 2, 1]);
  assert.equal(checksFor(s).checks.find((c) => c.id === 4).pass, true);
  // halves: first half negative fails check 6
  const h = checksFor(summarize(mk([...Array(8).fill(-0.001), ...Array(8).fill(0.05)])));
  assert.equal(h.checks.find((c) => c.id === 6).pass, false);
});
