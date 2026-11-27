// scripts/experiments/fresh_lane_sim.js — the registered simulator (fresh-top-lane) on synthetic
// paths: bin model sanity, flat price with fees, dump through the stop, pump then dump into the
// trailing, time box, TVL exit, a gap through the stop, halved fees, and the pass rule.
import { test } from "node:test";
import assert from "node:assert/strict";

const S = await import("../scripts/experiments/fresh_lane_sim.js");
const T0 = Date.parse("2026-11-27T12:00:00Z");
const STEP = 45_000;

function trade({ id = "paper-x-1", at = T0, buyT = 0.49, sellRatio = 0.02, lane = "paper" } = {}) {
  return {
    id, pool: "Pool", pair: "TEST-SOL", lane, entered_at: new Date(at).toISOString(),
    entry: { active_bin: 0, bin_step: 100, rank: 1, quotes: { buy: buyT == null ? null : { tokens_value_sol: buyT }, sell_entry: sellRatio == null ? null : { at: new Date(at).toISOString(), ratio: sellRatio } } },
  };
}
/**
 * ticks from a list of active bins (one per 45 s from T0) with a steady pool fee flow of
 * `fee` USD per 5 min, reported the way the API does at timeframe=5m: the fee so far in the
 * current clock-aligned 5-minute bucket (fee_bucket_start = that bucket).
 */
const B5 = 300_000;
function path(bins, { id = "paper-x-1", at = T0, fee = 50, atvl = 20_000, tvl = 50_000, sol = 100, tvlAt = null } = {}) {
  return bins.map((b, k) => {
    const t = at + k * STEP;
    const bucket = Math.floor(t / B5) * B5;
    return { trade_id: id, at: new Date(t).toISOString(), seen: true, active_bin: b, tvl: tvlAt && tvlAt[k] != null ? tvlAt[k] : tvl, active_tvl: atvl, fee_usd: fee * (t - bucket) / B5, fee_window_min: 5, fee_bucket_start: new Date(bucket).toISOString(), sol_price_usd: sol };
  });
}
/** the pool fee the reconstruction should see over these ticks (bucket tails after the last reading are lost) */
function expectedPoolFee(ticks) {
  let sum = 0;
  for (let k = 1; k < ticks.length; k++) {
    const a = ticks[k - 1], b = ticks[k];
    sum += a.fee_bucket_start === b.fee_bucket_start ? b.fee_usd - a.fee_usd : b.fee_usd;
  }
  return sum;
}
const flat = (n) => Array(n).fill(0);

test("bin model: entry values, a full move above / below the range", () => {
  const P = S.buildLadder("P", { binStep: 100, tokenValueSol: 0.49 });
  assert.ok(Math.abs(S.valueAt(P, 0) - 0.99) < 1e-12, "◎0.5 SOL + tokens worth 0.49");
  assert.ok(Math.abs(S.tokenValueAt(P, 0) - 0.49 + 0.49 / 69 / 2 * 0) < 0.01);
  const above = S.valueAt(P, 40); // all sold on the way up: more SOL than at entry
  assert.ok(above > 0.99 && S.tokenValueAt(P, 40) === 0);
  const below = S.valueAt(P, -40);
  assert.ok(below < 0.99 * 0.8, `a 40-bin dump costs > 20 % (${below})`);
  const Sl = S.buildLadder("S", { binStep: 100 });
  assert.ok(Math.abs(S.valueAt(Sl, 0) - 1) < 1e-12);
  assert.equal(S.valueAt(Sl, 10), S.valueAt(Sl, 1), "above a SOL ladder nothing changes");
  assert.equal(S.activeLiquidity(Sl, 1), 0, "out of range earns nothing");
});

test("flat price with fees: the time box closes at 120 min, net = fees − entry cost − exit cost − gas", () => {
  const ticks = path(flat(200));
  const r = S.simulateTrade(trade(), ticks);
  assert.equal(r.exit_rule, "time_box");
  assert.equal(r.minutes, 120);
  // share = (0.99/69) / (0.99/69 + 20000/100/69); pool fee rebuilt from the 5-min bucket readings
  const ours = (0.5 / 69 + 0.49 / 69), pool = 200 / 69;
  const poolFee = expectedPoolFee(ticks.slice(0, 161));
  // at a 45-s cadence each bucket loses the fees after its last reading (≈ 22.5 s of 300 s on average)
  assert.ok(poolFee > 0.85 * 50 * 24 && poolFee < 50 * 24, `≈ 24 buckets × 50, minus the bucket tails (${poolFee})`);
  const fees = poolFee * (ours / (ours + pool)) / 100;
  assert.ok(Math.abs(r.fees_sol - fees) < 1e-6, `${r.fees_sol} vs ${fees}`);
  assert.ok(Math.abs(r.entry_cost_sol - 0.01) < 1e-9);
  const tok = S.tokenValueAt(S.buildLadder("P", { binStep: 100, tokenValueSol: 0.49 }), 0);
  assert.ok(Math.abs(r.exit_cost_sol - tok * 0.02) < 1e-6);
  assert.ok(Math.abs(r.net_sol - (0.99 + fees - tok * 0.02 - S.GAS_SOL - 1)) < 1e-6);
  const half = S.simulateTrade(trade(), ticks, { feeFactor: 0.5 });
  assert.ok(Math.abs(half.fees_sol - fees / 2) < 1e-6, "halved-fee stress is exactly half");
  const box60 = S.simulateTrade(trade(), ticks, { exits: S.SECONDARY_EXITS[0] });
  assert.equal(box60.minutes, 60);
});

test("fee reconstruction: rises inside a bucket, the first reading of a new bucket, a skipped bucket from the 1h fee", () => {
  const at = (s) => new Date(Date.parse("2026-11-27T16:10:00Z") + s * 1000).toISOString();
  const bk = (m) => new Date(Date.parse("2026-11-27T16:10:00Z") + m * 60_000).toISOString();
  // ANT-SOL 23:10:47 → 23:14:08 WIB: 0.41 → 7.99 → 12.0 → 15.97 → 19.9 inside one bucket
  const one = [0.41, 7.99, 12.0, 15.97, 19.9].map((f, i) => ({ at: at(47 + i * 50), fee_usd: f, fee_bucket_start: bk(5) }));
  const r1 = S.reconstructFees(one);
  assert.deepEqual(r1.inc.map((x) => +x.toFixed(2)), [0, 7.58, 4.01, 3.97, 3.93]);
  assert.ok(Math.abs(r1.inc.reduce((a, b) => a + b, 0) - (19.9 - 0.41)) < 1e-9, "Σ = last − first (the first reading is the baseline)");
  assert.equal(r1.fee_gap, false);
  // across a boundary: the reading falls → the new bucket's first reading counts whole
  const two = [...one, { at: at(330), fee_usd: 1.2, fee_bucket_start: bk(10) }, { at: at(375), fee_usd: 3.0, fee_bucket_start: bk(10) }];
  assert.deepEqual(S.reconstructFees(two).inc.slice(5).map((x) => +x.toFixed(2)), [1.2, 1.8]);
  // the answer still showed the old bucket after the clock boundary (lagged bucket unchanged, reading rose) → continuation
  const lag = [{ at: at(0), fee_usd: 48.09, fee_bucket_start: bk(5) }, { at: at(15), fee_usd: 77.81, fee_bucket_start: bk(5) }, { at: at(45), fee_usd: 13.16, fee_bucket_start: bk(10) }];
  assert.deepEqual(S.reconstructFees(lag).inc.map((x) => +x.toFixed(2)), [0, 29.72, 13.16]);
  // a gap that skips two whole buckets: + 2 × (1h fee ÷ 12), flagged
  const gap = [{ at: at(0), fee_usd: 5, fee_bucket_start: bk(0), fee_1h_usd: 120 }, { at: at(900), fee_usd: 2, fee_bucket_start: bk(15) }];
  const rg = S.reconstructFees(gap);
  assert.deepEqual([rg.inc[1], rg.missed_buckets, rg.fee_gap, rg.fee_gap_no_1h], [2 + 20, 2, true, false]);
  const noHour = S.reconstructFees(gap.map((k) => ({ ...k, fee_1h_usd: null })));
  assert.deepEqual([noHour.inc[1], noHour.fee_gap, noHour.fee_gap_no_1h], [2, true, true]);
  // a bucket move ≥ 2 without a fall is still a new bucket
  const jump = [{ at: at(0), fee_usd: 5, fee_bucket_start: bk(0) }, { at: at(610), fee_usd: 9, fee_bucket_start: bk(10) }];
  assert.equal(S.reconstructFees(jump).inc[1], 9 + 0, "no 1h figure → the skipped bucket adds nothing");
  // missing readings are skipped, not zeroed
  const holes = [{ at: at(0), fee_usd: 1, fee_bucket_start: bk(0) }, { at: at(45), fee_usd: null, fee_bucket_start: null }, { at: at(90), fee_usd: 3, fee_bucket_start: bk(0) }];
  assert.deepEqual(S.reconstructFees(holes).inc, [0, 0, 2]);
});

test("monotone dump through the stop: the first reading at or under −10 % fills", () => {
  const bins = Array.from({ length: 40 }, (_, k) => -k);
  const r = S.simulateTrade(trade(), path(bins, { fee: 0 }));
  assert.equal(r.exit_rule, "stop");
  assert.ok(r.gross_pct <= -10 && r.gross_pct > -12, `filled near the stop (${r.gross_pct})`);
  const s15 = S.simulateTrade(trade(), path(bins, { fee: 0 }), { exits: S.SECONDARY_EXITS[1] });
  assert.ok(s15.gross_pct <= -15 && s15.minutes > r.minutes);
});

test("a gap through the stop fills at the first captured reading past it", () => {
  const r = S.simulateTrade(trade(), path([0, -2, -4, -40, -41], { fee: 0 }));
  assert.equal(r.exit_rule, "stop");
  assert.equal(r.minutes, 2.3);
  const v = S.valueAt(S.buildLadder("P", { binStep: 100, tokenValueSol: 0.49 }), -40);
  assert.ok(Math.abs(r.gross_pct - (v - 1) * 100) < 1e-6, "no interpolation to −10 %");
  assert.ok(r.gross_pct < -20);
});

test("pump then dump: trailing 3 / 1.5 fires at the first reading 1.5 pp under the running peak", () => {
  const up = Array.from({ length: 15 }, (_, k) => k);        // peak at bin 14
  const down = Array.from({ length: 20 }, (_, k) => 14 - k);
  const r = S.simulateTrade(trade(), path([...up, ...down], { fee: 0 }));
  assert.equal(r.exit_rule, "trailing");
  assert.ok(r.peak_pct >= 3);
  assert.ok(r.gross_pct <= r.peak_pct - 1.5 && r.gross_pct > r.peak_pct - 3);
});

test("pool TVL under $10K exits before the stop is checked", () => {
  const tvlAt = [50_000, 40_000, 9_000];
  const r = S.simulateTrade(trade(), path([0, -1, -2, -3], { fee: 0, tvlAt }));
  assert.equal(r.exit_rule, "tvl");
  assert.equal(r.minutes, 1.5);
});

test("F2: an entry without a buy quote is INCLUDED at base fee + 1.0 pp; data_end, unseen ticks, shape S", () => {
  const miss = trade({ buyT: null, sellRatio: null });
  miss.entry.recorded = { fee_pct: 3 };
  const r = S.simulateTrade(miss, path(flat(5)));
  assert.equal(r.excluded, null);
  assert.equal(r.entry_quote_missing, true);
  assert.ok(Math.abs(r.entry_cost_sol - 0.5 * 0.04) < 1e-12, "(3 % + 1 pp) of ◎0.5");
  assert.equal(r.exit_ratio_source, "entry_cost");
  assert.ok(Math.abs(r.exit_ratio - 0.04) < 1e-12);
  const unknownFee = S.simulateTrade(trade({ buyT: null, sellRatio: 0.06 }), path(flat(5)));
  assert.ok(Math.abs(unknownFee.entry_cost_sol - 0.5 * 0.04) < 1e-12, "base fee unknown → 3 %");
  assert.equal(unknownFee.exit_ratio_source, "sell_quote");
  // a single reading still grades (the entry snapshot is the first reading)
  const lone = S.simulateTrade(trade(), path([0]));
  assert.equal(lone.excluded, null);
  assert.equal(lone.exit_rule, "data_end");
  assert.equal(S.simulateTrade({ ...trade(), entry: { ...trade().entry, active_bin: null } }, path(flat(5))).excluded, "missing_geometry");
  const short = S.simulateTrade(trade(), path(flat(10)));
  assert.equal(short.exit_rule, "data_end");
  const unseen = path(flat(10)).map((k, i) => (i > 3 ? { ...k, seen: false, active_bin: null } : k));
  assert.equal(S.simulateTrade(trade(), unseen).minutes, 2.3, "unseen ticks are not readings");
  const sOk = S.simulateTrade(trade(), path(flat(200)), { shape: "S" });
  assert.equal(sOk.entry_cost_sol, 0);
  assert.equal(sOk.exit_rule, "time_box");
});

test("F3: the exit cost uses the latest sell quote at or before the exit, never a later one", () => {
  const qs = [{ t: 0, ratio: 0.1 }, { t: 100, ratio: 0.2 }, { t: 200, ratio: 0.3 }];
  assert.equal(S.latestRatioAtOrBefore(qs, 150), 0.2);
  assert.equal(S.latestRatioAtOrBefore(qs, 100), 0.2);
  assert.equal(S.latestRatioAtOrBefore(qs, 99), 0.1);
  assert.equal(S.latestRatioAtOrBefore(qs, -1), null);
  // a dump through the stop at ≈ 4 min; a 0.4 sell quote taken AFTER the exit must not be used
  const ticks = path(Array.from({ length: 40 }, (_, k) => -k), { fee: 0 });
  ticks[30].sell_quote = { at: ticks[30].at, ratio: 0.4 };
  const r = S.simulateTrade(trade({ sellRatio: 0.02 }), ticks);
  assert.ok(Date.parse(r.exit_at) < Date.parse(ticks[30].at));
  assert.equal(r.exit_ratio, 0.02, "the entry quote, not the later 0.4");
  ticks[2].sell_quote = { at: ticks[2].at, ratio: 0.07 };
  assert.equal(S.simulateTrade(trade({ sellRatio: 0.02 }), ticks).exit_ratio, 0.07);
});

test("the pass rule: met, drop on a check, insufficient, and drop at the time arm", () => {
  const DAY = 86_400_000;
  const row = (i, net, days) => ({ id: `t${i}`, entered_at: new Date(T0 + days * DAY).toISOString(), net_sol: net, net_pct: net * 100, excluded: null });
  const good = Array.from({ length: 40 }, (_, i) => row(i, 0.01, i * 0.4));
  const g = S.gradePassRule(good, good, { now: T0 + 20 * DAY });
  assert.equal(g.verdict, "met");
  assert.equal(g.action, "build_enforce");
  assert.ok(g.checks.every((c) => c.pass));
  // 5 disasters of 40 (12.5 %) → drop
  const bad = good.map((r, i) => (i < 5 ? { ...r, net_sol: -0.12, net_pct: -12 } : { ...r, net_sol: 0.05, net_pct: 5 }));
  assert.equal(S.gradePassRule(bad, bad, { now: T0 + 20 * DAY }).verdict, "drop");
  // fees halved flips the sum → drop
  const neg = good.map((r) => ({ ...r, net_sol: -0.001, net_pct: -0.1 }));
  const gh = S.gradePassRule(good, neg, { now: T0 + 20 * DAY });
  assert.equal(gh.verdict, "drop");
  assert.equal(gh.checks[4].pass, false);
  // the two best carry the sum
  const carried = good.map((r, i) => (i < 2 ? { ...r, net_sol: 1, net_pct: 100 } : { ...r, net_sol: -0.01, net_pct: -1 }));
  assert.equal(S.gradePassRule(carried, carried, { now: T0 + 20 * DAY }).checks[1].pass, false);
  // too few / too short
  assert.equal(S.gradePassRule(good.slice(0, 10), good.slice(0, 10), { now: T0 + 20 * DAY }).verdict, "insufficient");
  const quick = Array.from({ length: 40 }, (_, i) => row(i, 0.01, i * 0.1));
  assert.equal(S.gradePassRule(quick, quick, { now: T0 + 5 * DAY }).verdict, "insufficient", "40 entries in 4 days: wait for 14 days");
  assert.equal(S.gradePassRule(good.slice(0, 10), good.slice(0, 10), { now: Date.parse("2027-01-27T00:00:00Z") }).verdict, "drop", "60 days from 2026-11-27 without 40");
  assert.equal(S.gradePassRule([], [], {}).time_arm, "2027-01-26", "60 days from the first capture day (WIB)");
});

test("runSim: paper and operator lanes, every shape × variant × fee factor; open paper entries are never graded", () => {
  const tr = [{ ...trade(), status: "ended" }, { ...trade({ id: "operator-x-1", lane: "operator" }), status: "ended" }, { ...trade({ id: "paper-open" }), status: "open" }];
  const ticks = [...path(flat(200)), ...path(flat(200), { id: "operator-x-1" })];
  const rep = S.runSim(tr, [...ticks, ...path(flat(20), { id: "paper-open" })], { now: T0 + DAY });
  assert.equal(rep.results.paper["P:primary:1"].length, 2, "simulated, but only the ended one is graded");
  assert.equal(rep.results.operator["S:box60:0.5"].length, 1);
  assert.equal(rep.grade.n, 1, "operator entries are not counted by the pass rule, open ones are not graded");
  assert.equal(rep.grade.open_not_graded, 1);
  assert.match(S.formatReport(rep), /Pass rule \(paper, shape P, primary\): verdict insufficient/);
});
const DAY = 86_400_000;
