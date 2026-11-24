import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanSeries, detectEvents, classifyOutcome, exclusionHit, attributeClose, evaluateChecks,
  holdIntervals, isHeldAt, readingAt, parseTicksCsv, runStudy, familyOf, isMechanical,
} from "../scripts/replay/drop_guard_study.js";

const T0 = Date.parse("2026-10-10T00:00:00Z");
// rows: [seconds after T0, bin, pnl]
const S = (rows) => rows.map(([s, a, pnl]) => ({ t: T0 + s * 1000, a, pnl }));

test("event at an unchanged or a higher bin, none when the bin fell", () => {
  const ev = detectEvents(S([[0, -100, 5], [15, -100, 1.5], [30, -99, -2], [45, -101, -6]]), 3);
  assert.equal(ev.length, 2);
  assert.deepEqual(ev.map((e) => [e.pnl1, e.pnl2, e.bin1, e.bin2]), [[5, 1.5, -100, -100], [1.5, -2, -100, -99]]);
  assert.equal(ev[0].drop, 3.5);
  assert.equal(ev[0].gap_s, 15);
  // the −2 → −6 drop came with the bin falling: not an event
  assert.equal(detectEvents(S([[0, -100, -2], [15, -101, -6]]), 3).length, 0);
});

test("X boundary is inclusive, 15 pp is excluded (the live guard owns ≥ 15)", () => {
  assert.equal(detectEvents(S([[0, 0, 3.01], [5, 0, 0.01]]), 3).length, 1, "3.00 after float noise still counts");
  assert.equal(detectEvents(S([[0, 0, 2.99], [5, 0, 0]]), 3).length, 0);
  assert.equal(detectEvents(S([[0, 0, 20], [5, 0, 5]]), 3).length, 0, "exactly 15 pp is the live guard's");
  assert.equal(detectEvents(S([[0, 0, 20], [5, 0, 5.01]]), 3).length, 1);
});

test("rows at ≤ −99.9 are dropped and identical neighbours merged", () => {
  const { series, droppedFloor, merged } = cleanSeries(S([[0, 5, 2], [5, 5, -100], [10, 5, 2], [15, 5, -99.9], [20, 6, -1.5]]));
  assert.equal(droppedFloor, 2);
  assert.equal(merged, 1);
  assert.deepEqual(series.map((r) => r.pnl), [2, -1.5]);
  assert.equal(detectEvents(series, 3).length, 1, "the rows around the dropped one become consecutive");
  assert.equal(cleanSeries(S([[0, 5, 2], [5, 5, -99.89]])).series.length, 2);
});

test("reverted vs fell vs persisted", () => {
  const base = [[0, -10, 4], [15, -10, 0]];
  const outcome = (after) => { const s = S([...base, ...after]); return classifyOutcome(s, detectEvents(s, 3)[0]); };
  const r = outcome([[30, -10, 0.2], [50, -10, 3.2]]);
  assert.equal(r.outcome, "reverted");
  assert.equal(r.revert_s, 35);
  assert.equal(outcome([[30, -9, 5]]).outcome, "reverted", "|pnl − pre| ≤ 1 at a higher bin");
  assert.equal(outcome([[30, -10, 5.5]]).outcome, "persisted", "more than 1 pp ABOVE the pre-drop reading is not 'within 1 pp' (literal)");
  assert.equal(outcome([[30, -11, 3.9]]).outcome, "fell", "a bin below the pre-drop bin first");
  assert.equal(outcome([[30, -11, 0], [40, -10, 4]]).outcome, "fell");
  assert.equal(outcome([[30, -10, 4], [40, -11, 0]]).outcome, "reverted", "return before the fall");
  assert.equal(outcome([[135.001, -10, 4]]).outcome, "persisted", "return more than 120 s after the second reading");
  assert.equal(outcome([[135.001, -10, 4]]).series_ended, false);
  assert.equal(outcome([[135, -10, 4]]).outcome, "reverted", "t2 + 120 s exactly");
  const end = outcome([[30, -10, 0.1]]);
  assert.equal(end.outcome, "persisted");
  assert.equal(end.series_ended, true);
});

test("exclusion window: 120 s around the event interval", () => {
  const ev = { t1: T0 + 100_000, t2: T0 + 110_000 };
  assert.equal(exclusionHit(ev, [{ t: T0 + 105_000, src: "a" }]).src, "a");
  assert.equal(exclusionHit(ev, [{ t: T0 + 230_000, src: "b" }]).src, "b");
  assert.equal(exclusionHit(ev, [{ t: T0 + 230_001, src: "b" }]), null);
  assert.equal(exclusionHit(ev, [{ t: T0 - 20_000, src: "c" }]).src, "c");
  assert.equal(exclusionHit(ev, [{ t: T0 - 20_001, src: "c" }]), null);
  assert.equal(exclusionHit(ev, [{ t: T0 - 20_000, src: "far" }, { t: T0 + 100_000, src: "near" }]).src, "near");
});

test("close attribution: mechanical, within 90 s, no return first", () => {
  const s = S([[0, -10, 4], [15, -10, 0], [25, -10, 0.1]]);
  const ev = detectEvents(s, 3)[0];
  const rec = (sec, extra = {}) => ({ recorded_at: new Date(T0 + sec * 1000).toISOString(), exit_family: "trailing_tp", ...extra });
  assert.equal(attributeClose(s, ev, rec(40), s[2].t).close_on_event, true);
  assert.equal(attributeClose(s, ev, rec(105), s[2].t).close_on_event, true, "t2 + 90 s exactly");
  const late = attributeClose(s, ev, rec(106), s[2].t);
  assert.equal(late.close_on_event, false);
  assert.equal(late.near_miss, true);
  assert.equal(attributeClose(s, ev, rec(400), s[2].t).near_miss, false);
  assert.equal(attributeClose(s, ev, rec(40, { exit_family: "manual" }), s[2].t).close_on_event, false);
  assert.equal(attributeClose(s, ev, rec(40, { exit_family: "external" }), s[2].t).close_on_event, false);
  assert.equal(attributeClose(s, ev, rec(40, { rebalance_leg: true }), s[2].t).close_on_event, false);
  assert.equal(attributeClose(s, ev, rec(10), s[2].t).close_on_event, false, "recorded before the second reading");
  const s2 = S([[0, -10, 4], [15, -10, 0], [25, -10, 3.5]]);
  assert.equal(attributeClose(s2, detectEvents(s2, 3)[0], rec(40), s2[2].t).close_on_event, false, "a return before the close");
  assert.equal(familyOf({ exit_family: "llm" }), "llm");
  assert.equal(isMechanical({ exit_family: "llm" }), true, "only manual / external / rebalance leg are excluded");
  assert.equal(isMechanical(null), false);
});

test("hold intervals and the last reading at or before a time", () => {
  const h = holdIntervals([{ kind: "hold", t: 100 }, { kind: "resume", t: 200 }, { kind: "hold", t: 300 }], { endMs: 400 });
  assert.deepEqual(h, [[100, 200], [300, 400]]);
  assert.equal(isHeldAt(h, 150), true);
  assert.equal(isHeldAt(h, 250), false);
  assert.deepEqual(holdIntervals([], { endMs: 900, holdSetAt: new Date(500).toISOString(), holdMode: true }), [[500, 900]]);
  const s = S([[0, 1, 1], [10, 1, 2], [70, 1, 3]]);
  assert.equal(readingAt(s, T0 + 60_000).pnl, 2);
  assert.equal(readingAt(s, T0 + 70_000).pnl, 3);
  assert.equal(readingAt(s, T0 - 1), null);
});

test("verdict logic over the five checks", () => {
  const mk = (n, o) => Array.from({ length: n }, () => ({ excluded: false, held: false, outcome: "reverted", pnl2: 0, pnl60: 0, capital_sol: 1, ...o }));
  const base = [...mk(19), mk(1, { close_on_event: true })[0]];
  let r = evaluateChecks(base);
  assert.equal(r.verdict, "met");
  assert.equal(evaluateChecks(base.slice(1)).verdict, "insufficient");
  assert.equal(evaluateChecks([...base.slice(1), mk(1, { excluded: true })[0]]).verdict, "insufficient", "excluded events do not count");
  r = evaluateChecks(mk(20));
  assert.equal(r.verdict, "not_met");
  assert.equal(r.checks[2].pass, false, "no close on a reverted event");
  assert.equal(evaluateChecks([...mk(19, { held: true, close_on_event: true }), mk(1)[0]]).checks[2].pass, false, "held positions do not count for check 3");
  // check 2: 16 reverted + 4 persisted = 80 % → pass; 5 persisted → fail; fell does not count against it
  assert.equal(evaluateChecks([...base.slice(0, 16), ...mk(4, { outcome: "persisted" })]).checks[1].pass, true);
  assert.equal(evaluateChecks([...base.slice(0, 15), ...mk(5, { outcome: "persisted" })]).checks[1].pass, false);
  assert.equal(evaluateChecks([...base, ...mk(10, { outcome: "fell" })]).checks[1].value, 1);
  // check 4: cost of waiting on non-held persisted / fell
  const cost = (pnl60, held = false) => evaluateChecks([...base, ...mk(1, { outcome: "persisted", pnl2: 0, pnl60, capital_sol: 2, held })]);
  assert.equal(cost(-2.5).checks[3].pass, true, "−2.5 pp × ◎2 = −◎0.05");
  assert.equal(cost(-2.6).checks[3].pass, false);
  assert.equal(cost(-2.6).verdict, "not_met");
  assert.equal(cost(-10, true).checks[3].pass, true, "held events are not in check 4");
  // check 5: at most one stop-class close ≥ 3 pp further down within 60 s
  const dump = { outcome: "fell", stop_close_60: { further_pp: -3 } };
  assert.equal(evaluateChecks([...base, ...mk(1, dump)]).checks[4].pass, true);
  assert.equal(evaluateChecks([...base, ...mk(2, dump)]).checks[4].pass, false);
  assert.equal(evaluateChecks([...base, ...mk(2, { outcome: "fell", stop_close_60: { further_pp: -2.9 } })]).checks[4].pass, true);
});

test("end to end on a small fixture", () => {
  const p = "Pos1111111111111111111111111111111111111111";
  const csv = [[0, -10, 4], [15, -10, 0.5], [30, -10, 0.6], [40, -10, 3.4], [600, -10, 4], [615, -10, 0.2]]
    .map(([s, a, pnl]) => `${p},${T0 + s * 1000},${a},${pnl}`).join("\n");
  const { byPos } = parseTicksCsv(csv);
  const records = [{ position: p, pool_name: "TEST-SOL", adopted: false, amount_sol: 1, exit_family: "trailing_tp", pnl_pct: 0.2, recorded_at: new Date(T0 + 640_000).toISOString() }];
  const rep = runStudy(byPos, records, { positions: [], events: [] }, { from: new Date(T0 - 1).toISOString() });
  const V = rep.variants.X3;
  assert.equal(V.events.length, 2);
  assert.deepEqual(V.events.map((e) => e.outcome), ["reverted", "persisted"]);
  assert.equal(V.events[1].close_on_event, true);
  assert.equal(V.events[0].close_on_event, false);
  assert.equal(V.checks[2].value, 0, "the close fired on the persisted event, not on the reverted one");
  assert.equal(rep.verdict, "insufficient");
  const rep2 = runStudy(byPos, records, { positions: [], events: [{ position: p, kind: "rebalance_external", at: new Date(T0 + 700_000).toISOString() }] }, { from: new Date(T0 - 1).toISOString() });
  assert.deepEqual(rep2.variants.X3.events.map((e) => e.excluded), [false, true]);
});
