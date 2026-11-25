import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildBoard, plain, parseDoc, gradingLog, nextHistory, normalizeTable, looksSecret, docBytes, isEntry,
  HISTORY_MAX, TABLE_CAPS, MAX_DOC_BYTES,
} from "../scripts/experiments/publish.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/experiments/publish.js");
const NOW = Date.parse("2026-11-25T08:30:00Z"); // 15:30 WIB
const DAY = 86400000;

const mkDoc = ({ status = "insufficient", mode = "shadow", configKey = "null", title = "A title", claim = "The claim **bold** with `code`.", rule = "1. ≥ 30 things.\n2. Σ Δ > 0.", log = "" } = {}) =>
  `---\nid: x\nconfig_key: ${configKey}\nstatus: ${status}\nmode: ${mode}\nregistered_at: 2026-11-01\nenforce_built: false\n---\n\n# ${title}\n\n## Claim\n${claim}\nsecond line.\n\n## Pass rule\nRegistered 2026-11-01.\n\n${rule}\n\nmet → proposal.\n\n## Revert rule\nNone.\n\n## Grading log\n\n${log}`;

const README = [
  "# Experiment registry", "", "## Rejected — do not re-test", "", "| idea | date | evidence |", "|---|---|---|",
  "| Peak-crash **exit** | 2026-09-25 | fires 4× ([flip](bidask-flip.md)) |", "", "## Ungraded — no capture", "",
  "| rule | key | what capture is needed |", "|---|---|---|", "| TWAP | `twapGuardEnabled` | a stamp |", "",
].join("\n");

const SCHEDULE = {
  experiments: {
    "max-hold": { by: "grader", recheck_days: 1, need: { metric: "affected closes", target: 30 }, time_arm: "2026-12-19", report_by: null, on_met: "promote", on_met_kind: "auto_promote", operator_question: "Hold max-hold, or let it promote?" },
    "reading-guard": { by: "grader", recheck_days: 1, need: { metric: "episodes", target: 12 }, time_arm: "2026-11-20", report_by: null, on_met: "proposal", on_met_kind: "proposal", operator_question: null },
    "trailing-threshold": { by: "replay", recheck_days: 14, need: { metric: "positions", target: 30 }, time_arm: null, report_by: "2026-12-31", on_met: "operator decision", on_met_kind: "operator_decision", operator_question: null },
    "grace-backstop-stop": { by: "records", recheck_days: 7, need: { metric: "records", target: 12 }, time_arm: null, report_by: "2027-01-31", on_met: "proposal", on_met_kind: "proposal", operator_question: null },
    "grace-shadow": { by: "report", recheck_days: 7, need: null, time_arm: null, report_by: null, on_met: "none", on_met_kind: "none", operator_question: null },
  },
};
const DECISIONS = {
  "pump-gate": { decision: "dropped", at: "2026-11-23", summary: "Dropped at **72** tagged.", note: "Long note. Second sentence." },
  "fee-edge": { decision: "closed_not_met", at: "2026-11-24", note: "First sentence here. Second one." },
};
const DOCS = {
  "max-hold": mkDoc({ configKey: "maxHoldMode", log: "### 2026-11-23 (export) — **insufficient**\n- one\n" }),
  "reading-guard": mkDoc({ configKey: "readingGuardMode" }),
  "trailing-threshold": mkDoc({ status: "met_with_deviation", mode: "none (replay only)", configKey: "trailingTriggerPct / trailingDropPct (existing keys)", log: "### 2026-11-01 — V9 passes\nReplay **ran**; see [doc](x.md).\n\n| v | Σ |\n|---|---|\n| V9 | +0.17 |\n" }),
  "grace-backstop-stop": mkDoc({ mode: "none (graded from records)", log: "### 2026-11-24 08:55 WIB (export) — **insufficient**\ntext\n" }),
  "grace-shadow": mkDoc({ status: "report_only", configKey: "graceShadowEnabled" }),
  "pump-gate": mkDoc({ status: "closed: dropped 2026-11-23", configKey: "pumpGateMode" }),
  "fee-edge": mkDoc({ status: "closed: not met", configKey: "feeEdgeGateMode" }),
};
const records = () => {
  const out = [];
  for (let i = 0; i < 6; i++) out.push({ recorded_at: new Date(Date.parse("2026-10-20T00:00:00Z") + i * 5 * DAY).toISOString(), pnl_sol_net: 0.01, pnl_pct: 1, grace_stop_paused: { worst_pnl_pct: i < 2 ? -22 : -16 } });
  out.push({ recorded_at: new Date(NOW - DAY).toISOString(), pnl_sol_net: -0.02, pnl_pct: -2 });
  return out;
};
const build = (over = {}) => buildBoard({ records: records(), modes: {}, modesSource: "user_config", schedule: SCHEDULE, decisions: DECISIONS, docs: DOCS, readme: README, previousDoc: null, now: NOW, botCommit: "abc1234", ...over });

const TOP_KEYS = ["schema_version", "generated_at", "publisher", "grader", "summary", "objective", "experiments", "enforced", "finished", "rejected", "ungraded", "warnings"];
const EXP_KEYS = ["id", "title", "doc_path", "kind", "rule_kind", "mode", "mode_note", "config", "enforce_built", "registered_at", "shadow_since", "verdict", "verdict_reason", "verdict_source", "action", "progress", "schedule", "next_decision", "status", "flags", "waiting_on_operator", "operator_question", "attention", "last_evidence", "detail"];
const sortK = (o) => Object.keys(o).sort();

test("top-level and per-experiment key sets follow the contract", () => {
  const d = build();
  assert.deepEqual(Object.keys(d), TOP_KEYS);
  assert.equal(d.schema_version, 1);
  assert.deepEqual(d.publisher, { interval_min: 60, stale_after_min: 150, bot_commit: "abc1234" });
  for (const e of d.experiments) {
    assert.deepEqual(Object.keys(e), EXP_KEYS);
    assert.deepEqual(sortK(e.progress), ["delta_7d", "delta_basis", "eta", "extra", "history", "metric", "n", "need", "pace_state", "per_week"].sort());
    assert.deepEqual(sortK(e.detail), ["claim", "grading_log", "key_metrics", "largest_record", "latest_result", "on_met", "pass_rule", "revert_check", "revert_rule"].sort());
    for (const g of e.detail.grading_log) assert.deepEqual(sortK(g), ["date", "heading", "lines", "tables", "time_wib", "verdict"]);
  }
  assert.ok(docBytes(d) < MAX_DOC_BYTES);
});

test("attention ordering, waiting on the operator, replay STALE, records recount", () => {
  const d = build();
  const by = Object.fromEntries(d.experiments.map((e) => [e.id, e]));
  const ranks = d.experiments.map((e) => e.attention.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(d.experiments[0].id, "reading-guard");
  assert.equal(by["reading-guard"].status, "due");
  assert.equal(by["reading-guard"].attention.rank, 0);
  assert.equal(by["max-hold"].status, "waiting_operator");
  assert.equal(by["max-hold"].waiting_on_operator, true);
  assert.equal(by["max-hold"].operator_question, "Hold max-hold, or let it promote?");
  assert.equal(by["max-hold"].attention.rank, 10);
  assert.equal(by["max-hold"].detail.on_met.kind, "auto_promote");
  // replay: stale from the newest grading-log date (2026-11-01, 24 d > 14 d), verdict from the doc status
  const tr = by["trailing-threshold"];
  assert.equal(tr.kind, "replay");
  assert.equal(tr.status, "stale");
  assert.equal(tr.attention.rank, 20);
  assert.deepEqual(tr.flags, [{ kind: "stale", text: "STALE (last run 24 d old > 14 d)" }]);
  assert.equal(tr.verdict, "met_with_deviation");
  assert.equal(tr.verdict_source, "doc_status");
  assert.equal(tr.mode, "none");
  assert.equal(tr.mode_note, "replay only");
  assert.deepEqual(tr.last_evidence, { at: null, date: "2026-11-01", label: "grading log" });
  assert.equal(tr.detail.latest_result.text, "Replay ran; see doc.");
  assert.deepEqual(tr.detail.latest_result.tables, [{ header: ["v", "Σ"], rows: [["V9", "+0.17"]] }]);
  assert.deepEqual(tr.config.map((c) => c.key), ["trailingTriggerPct", "trailingDropPct"]);
  // fresh grading log → not stale
  const fresh = build({ docs: { ...DOCS, "trailing-threshold": DOCS["trailing-threshold"].replace("### 2026-11-01", "### 2026-11-20") } });
  assert.deepEqual(fresh.experiments.find((e) => e.id === "trailing-threshold").flags, []);
  // records: recounted from the records on every run, never stale
  const bs = by["grace-backstop-stop"];
  assert.equal(bs.kind, "records");
  assert.equal(bs.progress.n, 6);
  assert.deepEqual(bs.progress.extra, [{ label: "fires at B = 20", n: 2, need: 6 }]);
  assert.ok(!bs.flags.some((f) => f.kind === "stale"));
  assert.equal(bs.last_evidence.label, "records recount");
  assert.equal(bs.detail.pass_rule.checks[0].value, 6);
  assert.equal(by["grace-shadow"].status, "report");
  assert.equal(by["grace-shadow"].attention.rank, 90);
  assert.equal(d.summary.waiting_on_operator, 1);
  assert.equal(d.summary.due, 1);
  assert.equal(d.summary.stale, 1);
  assert.equal(d.objective.sample_frozen, false);
  assert.equal(build({ records: records().slice(0, 6) }).objective.sample_frozen, true);
});

test("finished comes from decisions (summary, else the note's first sentence)", () => {
  const d = build();
  assert.deepEqual(d.finished.map((f) => [f.id, f.decision, f.at, f.source]), [["fee-edge", "closed_not_met", "2026-11-24", "decisions"], ["pump-gate", "dropped", "2026-11-23", "decisions"]]);
  assert.equal(d.finished[1].summary, "Dropped at **72** tagged."); // decisions.json text passes through untouched
  assert.equal(d.finished[0].summary, "First sentence here.");
  assert.equal(d.summary.finished, 2);
  assert.ok(!d.experiments.some((e) => e.id === "pump-gate"));
  assert.deepEqual(d.rejected, [{ idea: "Peak-crash exit", date: "2026-09-25", evidence: "fires 4× (flip)", ref_id: "bidask-flip" }]);
  assert.deepEqual(d.ungraded, [{ rule: "TWAP", key: "twapGuardEnabled", capture_needed: "a stamp" }]);
});

test("history ring: append, same-day replace, 30 cap", () => {
  assert.deepEqual(nextHistory([], "2026-11-25", 5), [{ date: "2026-11-25", n: 5 }]);
  assert.deepEqual(nextHistory([{ date: "2026-11-24", n: 3 }, { date: "2026-11-25", n: 4 }], "2026-11-25", 5), [{ date: "2026-11-24", n: 3 }, { date: "2026-11-25", n: 5 }]);
  assert.deepEqual(nextHistory([{ date: "2026-11-24", n: 3 }, { date: "2026-11-30", n: 9 }, { date: "bad", n: 1 }, { date: "2026-11-23", n: "x" }], "2026-11-25", null), [{ date: "2026-11-24", n: 3 }]);
  const long = Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), n: i }));
  const h = nextHistory(long, "2026-11-25", 99);
  assert.equal(h.length, HISTORY_MAX);
  assert.deepEqual(h[h.length - 1], { date: "2026-11-25", n: 99 });
  assert.ok(h.every((p, i) => i === 0 || p.date > h[i - 1].date));
  // through buildBoard: the previous doc's ring is carried, and it feeds the 7-day change / pace
  const first = build();
  assert.deepEqual(first.experiments.find((e) => e.id === "max-hold").progress.history, [{ date: "2026-11-25", n: 0 }]);
  const prev = structuredClone(first);
  prev.experiments.find((e) => e.id === "reading-guard").progress.history = [{ date: "2026-11-10", n: 0 }, { date: "2026-11-25", n: 7 }];
  const second = build({ previousDoc: prev, now: NOW + 3600000 });
  const rg = second.experiments.find((e) => e.id === "reading-guard");
  assert.deepEqual(rg.progress.history, [{ date: "2026-11-10", n: 0 }, { date: "2026-11-25", n: 0 }]);
  assert.equal(rg.progress.delta_7d, 0);
  assert.equal(rg.progress.delta_basis, "7 d");
  const third = build({ previousDoc: { schema_version: 1, experiments: "nope" } });
  assert.ok(third.warnings.some((w) => /previous board is malformed/.test(w)));
});

test("plain text: markdown emphasis, code, links and quotes are stripped", () => {
  assert.equal(plain("**bold** and *it* with `code` and [a link](x.md) ![img](y.png)\n> quoted\n  wrapped"), "bold and it with code and a link img quoted wrapped");
  assert.equal(plain("pnl_sol_net × 2 ◎0.17 索拉纳-SOL"), "pnl_sol_net × 2 ◎0.17 索拉纳-SOL");
  // a blockquote marker goes only before prose, never before a comparison
  assert.equal(plain("> quoted note"), "quoted note");
  assert.equal(plain("> 0 SOL in both halves"), "> 0 SOL in both halves");
  assert.equal(plain(">= 2× the rest\n< 1 % of capital\n>0"), ">= 2× the rest < 1 % of capital >0");
  const d = build();
  const fromDocs = d.experiments.map((e) => ({ claim: e.detail.claim, rule: e.detail.pass_rule, log: e.detail.grading_log, revert: e.detail.revert_rule, title: e.title }));
  assert.ok(!/\*\*|`/.test(JSON.stringify([fromDocs, d.rejected, d.ungraded])), "no markdown emphasis or backticks in doc-derived text");
  assert.equal(d.experiments.find((e) => e.id === "max-hold").detail.claim, "The claim bold with code. second line.");
  // through a doc: a quote line inside a paragraph loses its marker, a comparison line keeps it
  const doc = mkDoc({ claim: "First line\n> quoted note\n> 0 SOL in both halves" });
  const d2 = build({ docs: { ...DOCS, "max-hold": doc } });
  assert.equal(d2.experiments.find((e) => e.id === "max-hold").detail.claim, "First line quoted note > 0 SOL in both halves second line.");
});

test("grader / schedule / decisions strings pass through untouched (no markdown stripping)", () => {
  const sched = { experiments: { ...SCHEDULE.experiments, "reentry-gate": { by: "grader", recheck_days: 1, need: { metric: "tagged", target: 20 }, on_met: "promote *now*", on_met_kind: "auto_promote", operator_question: "> 0? Write `hold x`." } } };
  const d = build({ schedule: sched });
  const mh = d.experiments.find((e) => e.id === "max-hold").detail.pass_rule.checks;
  assert.equal(mh.find((c) => c.n === 2).need, "> 0");
  assert.equal(mh.find((c) => c.n === 3).need, "> 0");
  const rg = d.experiments.find((e) => e.id === "reentry-gate");
  const ratio = rg.detail.pass_rule.checks.find((c) => c.n === 2);
  assert.equal(ratio.label, "tagged ≤ −10 % rate ≥ 2× the rest's");
  assert.equal(ratio.need, "≥ 2 (and tagged rate > 0)");
  assert.equal(rg.operator_question, "> 0? Write `hold x`.");
  assert.equal(rg.detail.on_met.text, "promote *now*");
  assert.match(rg.detail.pass_rule.text, /≥ 2× the rest's/);
});

test("grading-log tables: ragged rows padded, caps enforced with warnings", () => {
  const warnings = [];
  const warn = (s) => warnings.push(s);
  const ragged = normalizeTable(["| a | b | c |", "|---|:--:|---|", "| 1 |", "| 1 | 2 | 3 | 4 |"], warn, "t");
  assert.deepEqual(ragged, { header: ["a", "b", "c", ""], rows: [["1", "", "", ""], ["1", "2", "3", "4"]] });
  const wide = "| " + Array.from({ length: 14 }, (_, i) => `h${i}`).join(" | ") + " |";
  const many = Array.from({ length: 45 }, (_, i) => `| r${i} |`);
  const tbl = (rows) => ["| x |", "|---|", ...rows].join("\n");
  const log = ["### 2026-11-24 — **insufficient**", "intro **line**", "", wide, "|---|", "| 1 |", "", tbl(many), "", ...Array.from({ length: 6 }, () => tbl(["| y |"]) + "\n\nafter\n")].join("\n");
  const doc = parseDoc(mkDoc({ log }));
  const [e] = gradingLog(doc, warn, "d.md");
  assert.equal(e.verdict, "insufficient");
  assert.equal(e.tables.length, TABLE_CAPS.tables);
  assert.equal(e.tables[0].header.length, TABLE_CAPS.cols);
  assert.equal(e.tables[1].rows.length, TABLE_CAPS.rows);
  assert.ok(e.lines.includes("intro line"));
  assert.ok(!e.lines.some((l) => l.includes("|")));
  assert.ok(warnings.some((w) => /14 columns, kept 12/.test(w)));
  assert.ok(warnings.some((w) => /45 rows, kept 40/.test(w)));
  assert.ok(warnings.some((w) => /8 tables, kept 6/.test(w)));
  // the warnings reach the board
  const d = build({ docs: { ...DOCS, "max-hold": mkDoc({ configKey: "maxHoldMode", log }) } });
  assert.ok(d.warnings.some((w) => /docs\/experiments\/max-hold\.md grading log 2026-11-24: 8 tables, kept 6/.test(w)));
});

test("broken inputs produce warnings, not throws", () => {
  const docs = { ...DOCS, "grace-shadow": 42 };
  delete docs["reading-guard"];
  const d = build({ docs, previousDoc: "garbage", schedule: { experiments: { ...SCHEDULE.experiments, "no-def": { by: "grader", recheck_days: 1, need: null, on_met_kind: "bogus" } } } });
  assert.ok(d.warnings.some((w) => /grace-shadow\.md could not be parsed/.test(w)));
  assert.ok(d.warnings.some((w) => /schedule\.json row reading-guard has no docs\/experiments\/reading-guard\.md/.test(w)));
  assert.ok(d.warnings.some((w) => /no-def is graded by the grader but has no definition/.test(w)));
  assert.ok(d.warnings.some((w) => /no-def has no valid on_met_kind/.test(w)));
  assert.ok(d.warnings.some((w) => /previous board is malformed/.test(w)));
  assert.equal(d.experiments.find((e) => e.id === "no-def").detail.on_met.kind, null);
  const empty = buildBoard({ records: null, schedule: null, decisions: null, now: NOW });
  assert.deepEqual(Object.keys(empty), TOP_KEYS);
  assert.ok(empty.warnings.length >= 2);
});

test("only rule / mode / threshold keys the experiments name are copied from user-config", () => {
  const modes = {
    maxHoldMode: "shadow", trailingDropPct: 1.5, graceShadowEnabled: false, maxHoldMinutes: 360,
    rpcUrl: "https://secret.example/?api-key=SECRETVALUE", walletKey: "SECRETWALLET", llmApiKey: "SECRETLLM",
    telegramBotToken: "SECRETTG", deployAmountSol: 0.45, someOtherKnob: 7, nested: { x: "SECRETNESTED" },
  };
  const d = build({ modes, schedule: { experiments: { ...SCHEDULE.experiments, "grace-shadow": { ...SCHEDULE.experiments["grace-shadow"], config_keys: ["rpcUrl", "walletKey", "deployAmountSol"] } } } });
  const json = JSON.stringify(d);
  for (const s of ["SECRET", "rpcUrl", "walletKey", "llmApiKey", "telegramBotToken", "someOtherKnob", "nested"]) assert.ok(!json.includes(s), `${s} leaked`);
  const keys = new Set(d.experiments.concat(d.enforced).flatMap((e) => e.config.map((c) => c.key)));
  assert.deepEqual([...keys].sort(), ["deployAmountSol", "graceShadowEnabled", "maxHoldMode", "readingGuardMode", "trailingDropPct", "trailingTriggerPct"]);
  const tr = d.experiments.find((e) => e.id === "trailing-threshold").config;
  assert.deepEqual(tr, [{ key: "trailingTriggerPct", value: null, source: "code_default" }, { key: "trailingDropPct", value: 1.5, source: "prod_config" }]);
  const exported = build({ modes: { maxHoldMode: "shadow" }, modesSource: "export" });
  assert.equal(exported.experiments.find((e) => e.id === "trailing-threshold").config[0].source, "not_exported");
  assert.equal(exported.experiments.find((e) => e.id === "reading-guard").config[0].source, "code_default");
  assert.ok(looksSecret("rpcUrl") && looksSecret("walletKey") && looksSecret("HIVE_MIND_API_KEY"));
  assert.ok(!looksSecret("trailingTriggerPct") && !looksSecret("maxHoldMode"));
});

// Optional inputs: the local export (absent on the VM and in CI) and the dashboard's fixture (opt-in).
const readable = (f) => { try { fs.accessSync(f, fs.constants.R_OK); return fs.statSync(f).isFile(); } catch { return false; } };
const PERF = path.join(ROOT, ".experiments/status/performance.json");
const MODES = path.join(ROOT, ".experiments/status/modes.json");
const HAS_EXPORT = readable(PERF) && readable(MODES);
const FIXTURE = process.env.EXPERIMENTS_BOARD_FIXTURE || null;
const HAS_FIXTURE = !!FIXTURE && readable(FIXTURE);
const readJ = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
function repoBoard() {
  const docs = {};
  let readme = "";
  for (const f of fs.readdirSync(path.join(ROOT, "docs/experiments"))) {
    if (!f.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(ROOT, "docs/experiments", f), "utf8");
    if (f === "README.md") readme = text; else docs[f.slice(0, -3)] = text;
  }
  const schedule = readJ(path.join(ROOT, "scripts/experiments/schedule.json"));
  const decisions = readJ(path.join(ROOT, "scripts/experiments/decisions.json"));
  const recs = HAS_EXPORT ? readJ(PERF) : records();
  const modes = HAS_EXPORT ? readJ(MODES) : {};
  return buildBoard({ records: recs, modes, modesSource: "export", schedule, decisions, docs, readme, now: NOW, botCommit: null });
}

// Key shapes (arrays collapsed to []) → for each path that is an object somewhere, the union of its keys.
function keyShapes(o, p = "", out = new Map()) {
  if (Array.isArray(o)) { for (const x of o) keyShapes(x, `${p}[]`, out); return out; }
  if (o && typeof o === "object") {
    if (!out.has(p)) out.set(p, new Set());
    for (const k of Object.keys(o)) { out.get(p).add(k); if (k !== "revert_check") keyShapes(o[k], `${p}.${k}`, out); }
  }
  return out;
}

test("dashboard fixture: the board has every key the fixture has (opt-in via EXPERIMENTS_BOARD_FIXTURE)", { skip: HAS_FIXTURE ? false : "EXPERIMENTS_BOARD_FIXTURE is not set to a readable file" }, () => {
  const ours = keyShapes(repoBoard()), theirs = keyShapes(readJ(FIXTURE));
  const missing = [];
  for (const [p, keys] of theirs) {
    const have = ours.get(p);
    if (!have) continue; // null / empty on our side (data-dependent): not a contract miss
    for (const k of keys) if (!have.has(k)) missing.push(`${p}.${k}`);
  }
  assert.deepEqual(missing, []);
});

test("real local export: builds and fits", { skip: HAS_EXPORT ? false : "no local export (.experiments/status)" }, () => {
  const d = repoBoard();
  assert.ok(docBytes(d) < MAX_DOC_BYTES);
  assert.ok(d.experiments.length > 0);
  for (const id of ["bidask-flip", "unchanged-bin-drop-guard"]) {
    assert.ok(d.finished.some((f) => f.id === id && f.source === "decisions"), `${id} finished`);
    assert.ok(!d.experiments.some((e) => e.id === id));
  }
  const tr = d.experiments.find((e) => e.id === "trailing-threshold");
  if (tr) assert.equal(tr.waiting_on_operator, true);
});

test("entry detection: direct run, PM2 (pm_exec_path), import", () => {
  assert.equal(isEntry(SCRIPT, SCRIPT, undefined), true);
  assert.equal(isEntry(SCRIPT, "/usr/lib/node_modules/pm2/lib/ProcessContainerFork.js", SCRIPT), true);
  assert.equal(isEntry(SCRIPT, path.join(ROOT, "test/experiment-publish.test.js"), undefined), false);
  assert.equal(isEntry(SCRIPT, "/x/ProcessContainerFork.js", path.join(ROOT, "index.js")), false);
  assert.equal(isEntry(SCRIPT, undefined, ""), false);
});

test("under a PM2-like wrapper the CLI runs, prints the summary and exits; a plain import does not run", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pub-pm2-"));
  fs.writeFileSync(path.join(tmp, "perf.json"), JSON.stringify(records()));
  fs.writeFileSync(path.join(tmp, "modes.json"), JSON.stringify({ maxHoldMode: "shadow" }));
  const url = JSON.stringify(pathToFileURL(SCRIPT).href);
  // Like PM2's ProcessContainerFork.js: argv[1] is the wrapper, the app's script is in pm_exec_path;
  // an IPC-like handle keeps the event loop alive, so only an explicit exit ends the process.
  const wrapper = path.join(tmp, "ProcessContainerFork.mjs");
  fs.writeFileSync(wrapper, `process.env.pm_exec_path = ${JSON.stringify(SCRIPT)};\nsetInterval(() => {}, 1000);\nawait import(${url});\n`);
  const args = ["--dry-run", "--input", path.join(tmp, "perf.json"), "--config", path.join(tmp, "modes.json"), "--now", "2026-11-25T08:30:00Z"];
  const env = { ...process.env, PERSIST_BACKEND: "pg", PGHOST: "203.0.113.1" };
  delete env.pm_exec_path;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [wrapper, ...args], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(r.error, undefined, "the wrapper did not exit (timed out)");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[EXPERIMENTS_BOARD\] open \d+ · .* — dry run, nothing written \(no DB\)/);
  assert.ok(Date.now() - t0 < 15000);
  // a failure exits 1 the same way (bad --now), still with the keep-alive handle
  const f = spawnSync(process.execPath, [wrapper, "--dry-run", "--now", "nonsense"], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(f.error, undefined, "the failing wrapper did not exit");
  assert.equal(f.status, 1);
  assert.match(f.stderr, /\[EXPERIMENTS_BOARD\] failed: unreadable --now nonsense/);
  // imported with neither argv[1] nor pm_exec_path pointing at it: main does not run
  const importer = path.join(tmp, "importer.mjs");
  fs.writeFileSync(importer, `const m = await import(${url});\nconsole.log("imported", typeof m.buildBoard);\n`);
  const i = spawnSync(process.execPath, [importer, ...args], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(i.status, 0, i.stderr);
  assert.equal(i.stdout.trim(), "imported function");
});

test("CLI --dry-run with --input / --config writes nothing and opens no DB", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pub-"));
  fs.writeFileSync(path.join(tmp, "perf.json"), JSON.stringify(records()));
  fs.writeFileSync(path.join(tmp, "modes.json"), JSON.stringify({ maxHoldMode: "shadow" }));
  const env = { ...process.env, PERSIST_BACKEND: "pg", PGHOST: "203.0.113.1", PGCONNECT_TIMEOUT: "1" };
  const r = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--input", path.join(tmp, "perf.json"), "--config", path.join(tmp, "modes.json"), "--now", "2026-11-25T08:30:00Z"], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\[EXPERIMENTS_BOARD\] open \d+ · due \d+ · waiting \d+ · stale \d+ · finished \d+ · \d+ warnings · \d+ bytes — dry run, nothing written \(no DB\)/);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ["modes.json", "perf.json"]);
  const out = path.join(tmp, "board.json");
  const w = spawnSync(process.execPath, [SCRIPT, "--input", path.join(tmp, "perf.json"), "--out", out], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(w.status, 0, w.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).schema_version, 1);
  // a board built from a file is never written to the DB
  const bad = spawnSync(process.execPath, [SCRIPT, "--input", path.join(tmp, "perf.json")], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /needs --dry-run or --out/);
  // not pg and no --input: nothing read or written
  const json = spawnSync(process.execPath, [SCRIPT, "--dry-run"], { env: { ...process.env, PERSIST_BACKEND: "json" }, encoding: "utf8", timeout: 60000 });
  assert.equal(json.status, 0, json.stderr);
  assert.match(json.stdout, /PERSIST_BACKEND is not pg/);
});
