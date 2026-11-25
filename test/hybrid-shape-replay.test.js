import test from "node:test";
import assert from "node:assert/strict";
import { initLadder, ladderValue } from "../scripts/replay/bidask_flip_replay.js";
import {
  shapeFractions, mixFractions, ladderFromFractions, evaluatePosition, verdictFor, summarize,
} from "../scripts/replay/hybrid_shape_replay.js";
import { postCloseLogRatio, binAt } from "../scripts/replay/fill_markout_study.js";

const ticksOf = (bins, t0 = 1000) => bins.map((a, k) => ({ t: t0 + k * 5, a, pnl: null }));
const walk = (from, to) => { const o = []; const s = to >= from ? 1 : -1; for (let a = from; ; a += s) { o.push(a); if (a === to) break; } return o; };

test("shape fractions sum to 1 and point the right way (k = 0 is the bottom bin)", () => {
  for (const kind of ["spot", "bidask", "curve"]) {
    const f = shapeFractions(10, kind);
    assert.ok(Math.abs(f.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  }
  const b = shapeFractions(10, "bidask"), c = shapeFractions(10, "curve");
  assert.ok(b[0] > b[9], "bid-ask is bottom-heavy");
  assert.ok(c[9] > c[0], "curve is top-heavy");
  const m = mixFractions(10, { spot: 0.5, bidask: 0.5 });
  for (let k = 0; k < 10; k++) assert.ok(Math.abs(m[k] - (0.05 + 0.5 * b[k])) < 1e-12);
});

test("actual shapes reproduce the flip harness ladders bin for bin", () => {
  for (const [strategy, kind] of [["spot", "spot"], ["bid_ask", "bidask"]]) {
    const g = { lo: -100, hi: -32, binStep: 100, C: 1.3 };
    const A = initLadder({ ...g, strategy });
    const B = ladderFromFractions(g, shapeFractions(g.hi - g.lo + 1, kind));
    for (let k = 0; k < A.n; k++) assert.ok(Math.abs(A.X[k] - B.X[k]) < 1e-12 * A.X[k]);
    for (const a of [-20, -32, -50, -100, -120]) assert.ok(Math.abs(ladderValue(A, a) - ladderValue(B, a)) < 1e-12);
  }
});

test("control is exactly zero; a dip that comes back costs no capital; a dip that stays favours the bottom-heavy mix", () => {
  const g = { lo: -68, hi: 0, binStep: 100, C: 1 };
  const V = [{ id: "actual", mix: null }, { id: "h", mix: { spot: 0.5, bidask: 0.5 } }];
  const back = ticksOf([...walk(1, -10), ...walk(-9, 1)]);
  const e1 = evaluatePosition(g, "spot", back, { F: 0.01, r: 0.003, pnlRec: 1, variants: V });
  assert.equal(e1.rows.actual.delta, 0);
  assert.ok(Math.abs(e1.rows.h.d_capital) < 1e-12);
  assert.ok(e1.rows.h.d_fee < 0, "less liquidity in the crossed top bins earns less");
  const stay = ticksOf(walk(1, -10));
  const e2 = evaluatePosition(g, "spot", stay, { F: 0.01, r: 0.003, pnlRec: -5, variants: V });
  assert.ok(e2.rows.h.d_capital > 0, "fewer tokens bought near the top");
  assert.ok(e2.rows.h.d_exit < 0, "and fewer tokens to sell at the close");
});

test("verdict needs n >= 100 and every check", () => {
  const rows = Array.from({ length: 120 }, (_, k) => ({ t_close: k, delta: 0.001, d_capital: 0.001, d_fee: 0, d_exit: 0, delta_robust: 0.001, delta_time: 0.001, delta_exit_literal: 0.001, exit_family: k % 10 === 0 ? "stop_loss" : "trailing_tp", exit_sens: {} }));
  assert.equal(verdictFor(summarize(rows)).verdict, "met");
  assert.equal(verdictFor(summarize(rows.slice(0, 50))).verdict, "insufficient");
  rows[0].delta = -0.2;
  assert.equal(verdictFor(summarize(rows)).verdict, "not_met");
});

test("post-close mcap interpolation and step-function bin lookup", () => {
  const pc = { exit_mcap: 100, m30: { mcap: 110 }, m60: { mcap: 121 } };
  assert.equal(postCloseLogRatio(pc, 0), 0);
  assert.ok(Math.abs(postCloseLogRatio(pc, 30) - Math.log(1.1)) < 1e-12);
  assert.ok(Math.abs(postCloseLogRatio(pc, 45) - 1.5 * Math.log(1.1)) < 1e-12);
  assert.equal(postCloseLogRatio(pc, 90), null, "past the last probe");
  const t = ticksOf([5, 4, 3]);
  assert.equal(binAt(t, 1004), 5);
  assert.equal(binAt(t, 1005), 4);
  assert.equal(binAt(t, 99999), 3);
});
