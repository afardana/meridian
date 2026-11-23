import test from "node:test";
import assert from "node:assert/strict";
import {
  initLadder, cloneLadder, ladderValue, tokenCount, flipAt, priceOf, accrueCrossing,
  simulateVariant, simulatePassive, trailingFireIndex, classifyRecord, mulberry32, PRIMARY,
  SOL_MINT, EXCLUSION_REASONS, parseTicksCsv, verdictFor, summarizeVariant,
} from "../scripts/replay/bidask_flip_replay.js";

const walk = (from, to, t0 = 0) => {
  const out = [];
  const step = to >= from ? 1 : -1;
  for (let a = from; ; a += step) { out.push(a); if (a === to) break; }
  return out;
};
const ticksOf = (bins, t0 = 1000) => bins.map((a, k) => ({ t: t0 + k * 5, a, pnl: null }));

test("flip conserves Σ X over S and leaves V unchanged at the flip bin", () => {
  for (const strategy of ["spot", "bid_ask"]) {
    const L = initLadder({ lo: -100, hi: -32, binStep: 100, C: 1, strategy });
    const a = -55;
    const sumS = (Lx) => { let t = 0; for (let i = a + 1; i <= Lx.hi; i++) t += Lx.X[i - Lx.lo]; return t; };
    const before = sumS(L), vBefore = ladderValue(L, a), totalBefore = tokenCount(L);
    assert.equal(flipAt(L, a, "bidask"), true);
    assert.ok(Math.abs(sumS(L) - before) < 1e-9 * before);
    assert.ok(Math.abs(tokenCount(L) - totalBefore) < 1e-9 * totalBefore);
    assert.ok(Math.abs(ladderValue(L, a) - vBefore) < 1e-12);
  }
  const L = initLadder({ lo: 0, hi: 10, binStep: 100, C: 1, strategy: "spot" });
  assert.equal(flipAt(L, 10, "bidask"), false, "no bins above the top bin → no flip");
});

test("dominance: after a bidask flip V(X_f, a) ≥ V(X_p, a) for every a", () => {
  const rnd = mulberry32(7);
  for (let trial = 0; trial < 12; trial++) {
    const n = 20 + Math.floor(rnd() * 50);
    const hi = -Math.floor(rnd() * 500);
    const lo = hi - n + 1;
    const binStep = [20, 50, 80, 100, 125][Math.floor(rnd() * 5)];
    const strategy = rnd() < 0.5 ? "spot" : "bid_ask";
    const C = 0.1 + rnd() * 3;
    const P = initLadder({ lo, hi, binStep, C, strategy });
    const F = cloneLadder(P);
    const aFlip = lo - 3 + Math.floor(rnd() * (n + 2));
    flipAt(F, aFlip, "bidask");
    for (let a = lo - 20; a <= hi + 5; a++) {
      assert.ok(ladderValue(F, a) >= ladderValue(P, a) - 1e-12, `trial ${trial} a ${a}`);
    }
  }
});

test("toy 1: spot 69 bins, hi → hi−30 → hi, primary variant", () => {
  const hi = 0, lo = -68;
  const geom = { lo, hi, binStep: 100, C: 1, strategy: "spot" };
  const bins = [...walk(hi, hi - 30), ...walk(hi - 29, hi)];
  const res = simulateVariant(geom, ticksOf(bins), PRIMARY, { F: 0, r: 0, pnlRec: 0 });
  assert.equal(res.flips, 2);
  const P = simulatePassive(geom, ticksOf(bins));
  assert.ok(Math.abs(ladderValue(P.L, hi) - 1) < 1e-12, "passive back at the top bin → Δ 0");
  assert.ok(res.d_capital > 0.015 && res.d_capital < 0.03, `Δcapital ${res.d_capital}`);
});

test("toy 2: bid_ask 69 bins, straight down to lo−1, bottom/bidask — recovery bounce", () => {
  const hi = 0, lo = -68;
  const geom = { lo, hi, binStep: 100, C: 1, strategy: "bid_ask" };
  const bins = walk(hi, lo - 1);
  const variant = { id: "bottom", N: null, readd: "bidask", mode: "bottom" };
  // run the flip path by hand through the same functions as simulateVariant
  const res = simulateVariant(geom, ticksOf(bins), variant, { F: 0, r: 0, pnlRec: 0 });
  assert.equal(res.flips, 1);
  assert.deepEqual(res.flip_events.map((e) => e.bin), [lo - 1]);
  const P = initLadder(geom);
  const Fl = initLadder(geom);
  flipAt(Fl, lo - 1, "bidask");
  let firstA = null;
  for (let a = lo - 1; a <= hi + 1; a++) if (firstA == null && ladderValue(Fl, a) >= 1) firstA = a;
  assert.ok(firstA != null);
  const bounce = priceOf(Fl, firstA) / priceOf(Fl, lo - 1) - 1;
  assert.ok(bounce >= 0.2 && bounce <= 0.32, `bounce ${bounce}`);
  for (let a = lo - 1; a < hi; a++) assert.ok(ladderValue(P, a) < 1, `passive at ${a}`);
  assert.ok(ladderValue(P, hi) >= 1 - 1e-12);
});

test("fee attribution: passive modelled fees equal F; crossing only never-reshaped bins → Δfee 0", () => {
  const hi = 0, lo = -68;
  const geom = { lo, hi, binStep: 100, C: 1, strategy: "spot" };
  // down to hi−15 (flip), then oscillate between hi−16 and hi−20 (bins never reshaped)
  const bins = [...walk(hi, hi - 20), ...walk(hi - 19, hi - 16), ...walk(hi - 17, hi - 20)];
  const F = 0.02;
  const res = simulateVariant(geom, ticksOf(bins), PRIMARY, { F, r: 0, pnlRec: 0 });
  assert.equal(res.flips, 1);
  assert.ok(Math.abs(res.c * res.W_p - F) < 1e-15);
  assert.equal(res.W_f_reshaped, 0);
  assert.ok(Math.abs(res.d_fee) < 1e-12, `Δfee ${res.d_fee}`);
  // going back up over the reshaped bins does change the fee weight
  const bins2 = [...walk(hi, hi - 20), ...walk(hi - 19, hi - 5)];
  const res2 = simulateVariant(geom, ticksOf(bins2), PRIMARY, { F, r: 0, pnlRec: 0 });
  assert.ok(res2.W_f_reshaped > 0);
  assert.ok(Math.abs(res2.d_fee) > 1e-9);
  // the accrual of the tick that triggers the flip uses the pre-flip X
  const L = initLadder(geom);
  const acc = accrueCrossing(L, hi - 14, hi - 15);
  assert.ok(Math.abs(acc.w - 1 / 69) < 1e-12);
});

test("trailing helper fires at the right tick", () => {
  assert.equal(trailingFireIndex([0, 1, 2.5, 2.2, null, 1.0, 0.5]), 5);
  assert.equal(trailingFireIndex([0, 1.9, 0.3, -2]), null, "never armed");
  assert.equal(trailingFireIndex([3, 1.6, 1.5]), 2, "fires at exactly peak − 1.5");
  assert.equal(trailingFireIndex([null, null]), null);
});

test("population filter: one record per exclusion reason", () => {
  const pos = "P1";
  const close = "2026-10-10T12:00:00Z";
  const tClose = Date.parse(close) / 1000;
  const base = {
    position: pos, pool_name: "X-SOL", recorded_at: close, minutes_held: 60, amount_sol: 0.5,
    bin_range: { min: -68, max: 0 }, bin_step: 100, strategy: "spot", pnl_pct: 1,
    straddle_count: 0, rebalance_count: 0, was_held: false,
    asset_profile: { token_y_mint: SOL_MINT },
  };
  const goodTicks = [{ t: tClose - 3600, a: 0, pnl: 0 }, { t: tClose, a: -3, pnl: 0.1 }];
  const ticksBy = new Map([[pos, goodTicks], ["LATE", [{ t: tClose - 3600 + 16 * 60, a: 0, pnl: 0 }, { t: tClose, a: 0, pnl: 0 }]], ["ONE", [{ t: tClose, a: 0, pnl: 0 }]]]);
  const cases = {
    adopted: { adopted: true },
    rebalance_leg: { rebalance_leg: true },
    no_close_time: { recorded_at: null },
    before_from: { recorded_at: "2026-09-01T00:00:00Z" },
    at_or_after_to: { recorded_at: "2026-11-14T00:00:00Z" },
    straddled: { straddle_count: 1 },
    re_ranged: { rebalance_count: 2 },
    was_held: { was_held: true },
    strategy_not_spot_or_bid_ask: { strategy: "curve" },
    missing_geometry: { bin_step: null },
    non_sol_quote: { asset_profile: { token_y_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } },
    no_minutes_held: { minutes_held: null },
    fewer_than_2_ticks_in_window: { position: "ONE" },
    first_tick_late: { position: "LATE" },
  };
  assert.deepEqual(Object.keys(cases).sort(), [...EXCLUSION_REASONS].sort());
  for (const [reason, patch] of Object.entries(cases)) {
    const c = classifyRecord({ ...base, ...patch }, ticksBy);
    assert.equal(c.reason, reason, reason);
  }
  const ok = classifyRecord(base, ticksBy);
  assert.equal(ok.reason, null);
  assert.equal(ok.ticks.length, 2);
  assert.equal(classifyRecord({ ...base, asset_profile: undefined }, ticksBy).reason, null, "quote mint absent → not excluded");
});

test("csv parse + verdict wiring", () => {
  const { byPos, stats } = parseTicksCsv("position_address,t,active_bin,pnl_pct\nA,10,-5,\nA,5,-4,0.5\n");
  assert.equal(stats.header_skipped, 1);
  assert.equal(stats.empty_pnl, 1);
  assert.deepEqual(byPos.get("A").map((x) => x.t), [5, 10]);
  const s = summarizeVariant([{ flips: 1, t_close: 1, delta: 0.01, d_capital: 0, d_fee: 0, gas: 0, exit_extra: 0, delta_robust: 0.01, delta_int: 0.01, early_close: false }]);
  assert.equal(verdictFor(s, { valid: true }).verdict, "insufficient");
  assert.equal(verdictFor(s, { valid: false }).verdict, "invalid_model");
});
