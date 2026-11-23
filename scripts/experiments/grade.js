#!/usr/bin/env node
/**
 * Shadow grader — grades the registered shadow-rule experiments (docs/experiments/) against an
 * EXPORT of the closed-position perf records. Read-only: never touches the live DB, the network
 * or any repo file.
 *
 *   node scripts/experiments/grade.js --input <performance.json> [--config <modes.json>]
 *        [--json] [--now <ISO>] [--only <id>] [--promoted <id>=<ISO> ...]
 *
 *   --input     JSON array of perf records (lessons getAllPerformance export)
 *   --config    flat JSON of config keys from prod user-config.json; the effective mode of an
 *               experiment is that value, else the code default (definitions.js)
 *   --json      print the full report object only
 *   --now       grade as of this instant (default: the current time)
 *   --only      one experiment id
 *   --promoted  run the revert check for a promoted rule (repeatable)
 *   --decisions JSON of recorded decisions { <id>: { decision, at, note } } — an experiment listed
 *               there is finished: its action is "none". Default: decisions.json beside this file.
 *
 * Exit code 0 always, except 2 when an input file is unreadable or not the expected JSON.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EXPERIMENTS, UNGRADED } from "./definitions.js";
import { gradeAll, formatHuman } from "./lib.js";

function parseArgs(argv) {
  const a = { input: null, config: null, json: false, now: null, only: null, promoted: {}, decisions: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null) fail(`${k} needs a value`);
      return v;
    };
    if (k === "--input") a.input = val();
    else if (k === "--config") a.config = val();
    else if (k === "--json") a.json = true;
    else if (k === "--now") a.now = val();
    else if (k === "--only") a.only = val();
    else if (k === "--decisions") a.decisions = val();
    else if (k === "--promoted") {
      const v = val();
      const eq = v.indexOf("=");
      if (eq <= 0) fail(`--promoted expects <id>=<ISO>, got ${v}`);
      a.promoted[v.slice(0, eq)] = v.slice(eq + 1);
    } else if (k === "--help" || k === "-h") {
      console.log("usage: node scripts/experiments/grade.js --input <performance.json> [--config <modes.json>] [--json] [--now <ISO>] [--only <id>] [--promoted <id>=<ISO>]");
      process.exit(0);
    } else fail(`unknown argument ${k}`);
  }
  if (!a.input) fail("--input is required");
  return a;
}

function fail(msg) {
  console.error(`grade.js: ${msg}`);
  process.exit(2);
}

function readJson(path, what) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    fail(`cannot read ${what} ${path}: ${e.message}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const records = readJson(args.input, "input");
if (!Array.isArray(records)) fail(`input ${args.input} is not a JSON array`);
const cfg = args.config ? readJson(args.config, "config") : {};
if (cfg == null || typeof cfg !== "object" || Array.isArray(cfg)) fail(`config ${args.config} is not a flat JSON object`);
const now = args.now ? Date.parse(args.now) : Date.now();
if (!Number.isFinite(now)) fail(`unreadable --now ${args.now}`);
if (args.only && !EXPERIMENTS.some((d) => d.id === args.only)) fail(`unknown experiment ${args.only} (known: ${EXPERIMENTS.map((d) => d.id).join(", ")})`);

const defaultDecisions = path.join(path.dirname(fileURLToPath(import.meta.url)), "decisions.json");
const decisionsPath = args.decisions || (fs.existsSync(defaultDecisions) ? defaultDecisions : null);
const decisions = decisionsPath ? readJson(decisionsPath, "decisions") : {};
if (decisions == null || typeof decisions !== "object" || Array.isArray(decisions)) fail(`decisions ${decisionsPath} is not a JSON object`);

const report = gradeAll(EXPERIMENTS, records, { cfg, now, only: args.only, promoted: args.promoted, ungraded: UNGRADED, decisions });
console.log(args.json ? JSON.stringify(report, null, 2) : formatHuman(report));
