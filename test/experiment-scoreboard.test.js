import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  wibDate, wibDateTime, buildScoreboard, buildRows, backstopCounts, objective,
  loadStatusFiles, loadPerformance, renderMarkdown,
} from "../scripts/experiments/scoreboard.js";

const DAY = 86400000;
const NOW = Date.parse("2026-11-25T12:00:00Z");
const file = (date, n, extra = {}) => ({
  date, at: Date.parse(`${date}T01:00:00Z`),
  data: { experiments: [{ id: "max-hold", mode: "shadow", verdict: "insufficient", sample: { n_tagged: n }, metrics: { row_at_cap: { n } } }], ...extra },
});
const sched = (over = {}) => ({ experiments: { "max-hold": { by: "grader", recheck_days: 1, need: { target: 30 }, time_arm: "2026-12-19", report_by: null, ...over } } });
const rows = (files, s = sched(), dec = {}, records = [], now = NOW, replayRuns = {}) =>
  buildRows({ schedule: s, decisions: dec, files, records, now, replayRuns });

test("WIB formatting is independent of the host zone", () => {
  assert.equal(wibDate(Date.parse("2026-11-24T18:30:00Z")), "2026-11-25");
  assert.equal(wibDate(Date.parse("2026-11-24T16:59:00Z")), "2026-11-24");
  assert.equal(wibDateTime(Date.parse("2026-11-24T18:30:00Z")), "2026-11-25 01:30 WIB");
});

test("progress, 7-day delta and ETA", () => {
  const files = [file("2026-11-10", 10), file("2026-11-17", 14), file("2026-11-24", 20)];
  const [r] = rows(files, sched(), {}, [], Date.parse("2026-11-24T12:00:00Z"));
  assert.equal(r.n, 20);
  assert.equal(r.delta7, 6); // vs 11-17
  // 10 over 14 d = 0.714/d; 10 more -> 14 d after now
  assert.equal(r.eta, "2026-12-08");
  assert.match(r.pace, /5\/wk -> 2026-12-08/);
  assert.match(r.next, /2026-12-08 \(ETA\)/);
  assert.equal(r.status, "on track");
});

test("rows carry numeric per_week and the flags array", () => {
  const files = [file("2026-11-10", 10), file("2026-11-17", 14), file("2026-11-24", 20)];
  const [r] = rows(files, sched(), {}, [], Date.parse("2026-11-24T12:00:00Z"));
  assert.equal(r.per_week, 5);
  assert.deepEqual(r.flags, []);
  const [flat] = rows([file("2026-11-25", 19)]);
  assert.equal(flat.per_week, null);
  const [due] = rows([file("2026-11-20", 31)], sched({ time_arm: "2026-11-25" }));
  assert.deepEqual(due.flags.map((f) => f.split(" ")[0]), ["DUE", "DUE", "STALE"]);
  assert.equal(due.status, due.flags.join("; "));
  assert.equal(due.per_week, null); // reached
  // an extractor override counts an id the default table does not know
  const rg = { experiments: { "reading-guard": { by: "grader", recheck_days: 1, need: { target: 12 } } } };
  const f = (d, n) => ({ date: d, at: Date.parse(`${d}T01:00:00Z`), data: { experiments: [{ id: "reading-guard", sample: { n_tagged: n } }] } });
  assert.equal(rows([f("2026-11-25", 3)], rg)[0].n, null);
  const [x] = buildRows({ schedule: rg, decisions: {}, files: [f("2026-11-18", 0), f("2026-11-25", 4)], records: [], now: NOW, replayRuns: {}, extractors: { "reading-guard": (e) => e?.sample?.n_tagged ?? null } });
  assert.equal(x.n, 4);
  assert.equal(x.delta7, 4);
  assert.equal(x.per_week, 4);
});

test("short history is labelled; no progress yields no ETA", () => {
  const files = [file("2026-11-23", 19), file("2026-11-24", 19), file("2026-11-25", 19)];
  const [r] = rows(files);
  assert.equal(r.delta7, 0);
  assert.match(r.baseLabel, /history/);
  assert.equal(r.pace, "no progress");
  assert.match(r.next, /2026-12-19 \(time arm\)/);
  assert.equal(r.status, "waiting");
});

test("DUE on count and on date", () => {
  assert.match(rows([file("2026-11-25", 31)])[0].status, /DUE \(count\)/);
  assert.equal(rows([file("2026-11-25", 31)])[0].pace, "reached");
  const late = rows([file("2026-11-25", 5)], sched({ time_arm: "2026-11-25" }))[0];
  assert.match(late.status, /DUE \(time arm\)/);
  // date compares in WIB: 18:30Z on 11-24 is already 11-25 in WIB
  const edge = rows([file("2026-11-24", 5)], sched({ time_arm: "2026-11-25" }), {}, [], Date.parse("2026-11-24T18:30:00Z"))[0];
  assert.match(edge.status, /DUE \(time arm\)/);
});

test("STALE: old status file, and replay experiments without a run", () => {
  const old = rows([file("2026-11-20", 5)])[0];
  assert.match(old.status, /STALE/);
  const s = { experiments: { tr: { by: "replay", recheck_days: 14, need: { target: 30 }, report_by: "2026-12-09" } } };
  assert.match(rows([], s)[0].status, /STALE \(never run\)/);
  const ok = rows([], s, {}, [], NOW, { tr: "2026-11-20T00:00:00Z" })[0];
  assert.doesNotMatch(ok.status, /STALE/);
  assert.equal(ok.progress, undefined);
  assert.equal(ok.n, null);
});

test("decisions are excluded from the open table", () => {
  const r = rows([file("2026-11-25", 5)], sched(), { "max-hold": { decision: "dropped", at: "2026-11-25" } });
  assert.equal(r.length, 0);
  const sb = buildScoreboard({ files: [file("2026-11-25", 5)], schedule: sched(), decisions: { x: { decision: "dropped", at: "2026-11-23" } }, records: [], now: NOW, replayRuns: {} });
  assert.deepEqual(sb.finished, [{ id: "x", decision: "dropped", at: "2026-11-23" }]);
});

test("grace-backstop-stop counts from the records", () => {
  const rec = (d, w) => ({ recorded_at: d, grace_stop_paused: w === null ? undefined : { worst_pnl_pct: w } });
  const records = [rec("2026-10-20T00:00:00Z", -25), rec("2026-10-21T00:00:00Z", -5), rec("2026-10-10T00:00:00Z", -30), rec("2026-11-01T00:00:00Z", null)];
  assert.deepEqual(backstopCounts(records), { n: 2, fires: 1 });
  const s = { experiments: { "grace-backstop-stop": { by: "records", recheck_days: 7, need: { target: 12 }, report_by: "2027-01-31" } } };
  const [r] = rows([], s, {}, records);
  assert.equal(r.n, 2);
  assert.equal(r.fires, 1);
});

test("objective split bot / operator / trailing", () => {
  const mk = (days, over) => ({ recorded_at: new Date(NOW - days * DAY).toISOString(), pnl_sol_net: 0.1, pnl_pct: 1, ...over });
  const recs = [
    mk(1, {}), mk(2, { exit_family: "trailing_tp", pnl_sol_net: -0.05, pnl_pct: -12 }),
    mk(3, { adopted: true, pnl_sol_net: undefined, pnl_sol: 0.2 }), mk(4, { rebalance_leg: true }),
    mk(20, { exit_family: "trailing_tp" }), mk(40, {}),
  ];
  const o = objective(recs, NOW);
  assert.equal(o.d7.bot.closes, 2);
  assert.equal(o.d7.bot.net_sol, 0.05);
  assert.equal(o.d7.bot.win_rate, 0.5);
  assert.equal(o.d7.bot.disaster_share, 0.5);
  assert.equal(o.d7.bot_trailing.closes, 1);
  assert.equal(o.d7.operator.closes, 1);
  assert.equal(o.d7.operator.net_sol, 0.2);
  assert.equal(o.d30.bot.closes, 3);
  assert.equal(o.newest_bot_close, NOW - DAY);
});

test("due this week lists upcoming time arms; missing files do not throw", () => {
  const sb = buildScoreboard({ files: [file("2026-11-25", 5)], schedule: sched({ time_arm: "2026-11-30" }), decisions: {}, records: [], now: NOW, replayRuns: {} });
  assert.ok(sb.due_this_week.some((d) => d.id === "max-hold" && /time arm 2026-11-30/.test(d.why)));
  const md = renderMarkdown(sb);
  assert.match(md, /## Open experiments/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-"));
  assert.deepEqual(loadStatusFiles(path.join(tmp, "nope")), []);
  assert.deepEqual(loadPerformance(path.join(tmp, "nope.json")), []);
  fs.writeFileSync(path.join(tmp, "performance.json"), JSON.stringify({ records: [{ pnl_pct: 1 }] }));
  assert.equal(loadPerformance(path.join(tmp, "performance.json")).length, 1);
  const empty = buildScoreboard({ files: [], schedule: {}, decisions: {}, records: [], now: NOW, replayRuns: {} });
  assert.ok(renderMarkdown(empty).includes("none"));
});
