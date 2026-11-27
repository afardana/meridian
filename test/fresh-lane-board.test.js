// fresh-top-lane on the experiments board: the record counter's lane source (lib.js), the
// scoreboard row (scoreboard.js buildRows laneTrades) and the publisher (publish.js buildBoard),
// with the real schedule.json row.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lib = await import("../scripts/experiments/lib.js");
const SB = await import("../scripts/experiments/scoreboard.js");
const { buildBoard } = await import("../scripts/experiments/publish.js");
const schedule = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/experiments/schedule.json"), "utf8"));
const NOW = Date.parse("2026-12-10T03:00:00Z");
const DAY = 86_400_000;

const ended = (t) => ({ lane: "paper", status: "ended", entered_at: new Date(t).toISOString(), ended_at: new Date(t + 6 * 3_600_000).toISOString() });
const lanes = [
  ...Array.from({ length: 5 }, (_, i) => ended(Date.parse("2026-11-28T00:00:00Z") + i * DAY)),
  ended(NOW - DAY),
  { lane: "paper", status: "open", entered_at: new Date(NOW - 3_600_000).toISOString(), ended_at: null },
  { lane: "operator", status: "ended", entered_at: new Date(NOW - DAY).toISOString(), ended_at: new Date(NOW - DAY + 6 * 3_600_000).toISOString() },
];

test("count spec: source lane_paper_trades counts the lane rows by entered_at; perf-record specs unchanged", () => {
  const spec = { source: "lane_paper_trades", lane: "paper", status: "ended" };
  assert.equal(lib.countSpecError(spec), null);
  assert.equal(lib.countRecords(spec, lanes, NOW), 6, "ended entries only (the open one is not counted)");
  assert.equal(lib.countRecords({ source: "lane_paper_trades", lane: "paper" }, lanes, NOW), 7, "without status: every row");
  assert.equal(lib.countRecords(spec, lanes, NOW - 7 * DAY), 5);
  assert.equal(lib.countRecords({ ...spec, lane: "operator" }, lanes, NOW), 1);
  assert.equal(lib.firstCountedAt(spec, lanes), Date.parse("2026-11-28T06:00:00Z"), "by ended_at");
  assert.match(lib.countSpecError({ ...spec, status: "x" }), /count\.status/);
  assert.match(lib.countSpecError({ source: "lane_paper_trades", lane: "x" }), /count\.lane/);
  assert.match(lib.countSpecError({ source: "lane_paper_trades", lane: "paper", population: "bot" }), /unknown count key population/);
  assert.match(lib.countSpecError({ source: "nope", population: "bot" }), /count\.source/);
  assert.equal(lib.countSpecError({ population: "bot", exit_family: "trailing_tp" }), null);
  assert.equal(lib.countRecords({ population: "bot" }, [{ recorded_at: "2026-11-01T00:00:00Z" }, { recorded_at: "2026-11-01T00:00:00Z", adopted: true }]), 1);
});

test("the scoreboard row counts paper entries; without the lane rows it says why", () => {
  const rows = SB.buildRows({ schedule, decisions: {}, files: [], records: [], now: NOW, replayRuns: {}, laneTrades: lanes });
  const r = rows.find((x) => x.id === "fresh-top-lane");
  assert.ok(r, "schedule.json has the fresh-top-lane row");
  assert.deepEqual([r.by, r.n, r.target, r.delta7, r.time_arm], ["replay", 6, 40, 1, "2027-01-26"]);
  const none = SB.buildRows({ schedule, decisions: {}, files: [], records: [], now: NOW, replayRuns: {} }).find((x) => x.id === "fresh-top-lane");
  assert.equal(none.n, null);
  assert.equal(none.count_error, "lane_paper_trades not loaded");
});

test("the board shows it as an open replay experiment, registered, with n = paper entries", () => {
  const docFile = path.join(ROOT, "docs/experiments/fresh-top-lane.md");
  const doc = fs.existsSync(docFile) ? fs.readFileSync(docFile, "utf8")
    : "---\nid: fresh-top-lane\nstatus: registered\nmode: shadow\nregistered_at: 2026-11-27\nenforce_built: false\n---\n# Fresh lane\n## Claim\nx\n## Pass rule\n1. a\n2. b\n## Grading log\n### 2026-11-27 — **registered** (registration)\n";
  const board = buildBoard({ records: [], modes: { freshLaneMode: "shadow" }, modesSource: "export", schedule, decisions: {}, docs: { "fresh-top-lane": doc }, readme: "", now: NOW, laneTrades: lanes });
  const e = board.experiments.find((x) => x.id === "fresh-top-lane");
  assert.ok(e);
  assert.equal(e.kind, "replay");
  assert.equal(e.verdict, "registered");
  assert.equal(e.progress.n, 6);
  assert.equal(e.progress.need, 40);
  assert.equal(e.waiting_on_operator, false);
  assert.ok(e.config.some((c) => c.key === "freshLaneMode" && c.value === "shadow"));
  assert.ok(!board.warnings.some((w) => /fresh-top-lane: need\.count/.test(w)), board.warnings.join(" | "));
  const noLanes = buildBoard({ records: [], modes: {}, modesSource: "export", schedule, decisions: {}, docs: { "fresh-top-lane": doc }, readme: "", now: NOW });
  assert.equal(noLanes.experiments.find((x) => x.id === "fresh-top-lane").progress.n, null);
});
