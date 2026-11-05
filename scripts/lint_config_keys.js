#!/usr/bin/env node
// Config-key consistency lint (2026-11-05).
//
// Config keys live in four hand-maintained lists that drift apart:
//   1. the defaults in config.js            (`export const config = { section: { key: … } }`)
//   2. the reload list in config.js         (`reloadScreeningThresholds`: `fresh.<key>` / `for (const k of [...])`)
//   3. the update_config allow-list         (tools/executor.js `CONFIG_MAP`: key → [section, field, …])
//   4. the setup wizard                     (setup.js `{ key: "…", …, type: … }`)
//
// Checks
//   FAIL  unread          a defaults key no code reads (production or tooling)
//   FAIL  map_no_default  an update_config key whose [section, field] has no default
//   FAIL  reload_unknown  a reload-list key that is neither a defaults key, a section nor a
//                         user-config input config.js reads (u.<name>)
//   WARN  tooling_only    a defaults key read only by scripts/ or test/
//   WARN  setup_unknown   a setup.js key config.js never reads from user-config / gmgn-config
//   WARN  example_unknown a user-config.example.json key config.js never reads
//   WARN  persist_unread  update_config persists a key to user-config.json that config.js never
//                         reads at startup (the change would not survive a restart)
//   INFO  not_tunable     a defaults key update_config cannot set (often intentional)
//
// "Read" is deliberately permissive so the lint has no false positives: a key counts as read
// when its bare identifier appears in any *.js/*.mjs/*.cjs file outside its own definition
// sites (its defaults property, the reload function, its CONFIG_MAP entry, setup.js) — in code
// or in a string literal (`config.x.key`, `cfg.key`, `["key"]`, "key", destructuring, prompt
// text …). Only whole-line `//` comments and `/* … */` blocks are ignored. Missing a dead key
// is acceptable; reporting a live key as dead is not.
//
// Static only: parses the sources, imports nothing, needs no .env, no DB, no network.
// Usage: node scripts/lint_config_keys.js [--json] [--verbose]   (exit 1 on any FAIL)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const verbose = args.has("--verbose");

const IDENT = "[A-Za-z_$][\\w$]*";
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const identRe = (name) => new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`);

// ── 1. defaults (config.js) ─────────────────────────────────────────────────
const configSrc = read("config.js");
const configLines = configSrc.split("\n");
const cfgStart = configLines.findIndex((l) => l.startsWith("export const config = {"));
if (cfgStart < 0) throw new Error("config.js: `export const config = {` not found");
const defaults = {};          // section → key → default expression (first line)
const keySpans = [];          // { section, key, from, to } (0-based line indexes, inclusive)
let cfgEnd = -1;
{
  let section = null;
  let current = null;
  for (let i = cfgStart + 1; i < configLines.length; i++) {
    const line = configLines[i];
    if (line === "};") { cfgEnd = i; break; }
    let m = line.match(new RegExp(`^  (${IDENT})\\s*:`));
    if (m) {
      if (current) current.to = i - 1;
      current = null;
      section = m[1];
      defaults[section] = {};
      continue;
    }
    m = line.match(new RegExp(`^    (${IDENT})\\s*:\\s*(.*)$`));
    if (m && section) {
      if (current) current.to = i - 1;
      defaults[section][m[1]] = m[2].replace(/\s*\/\/.*$/, "").replace(/,\s*$/, "").trim();
      current = { section, key: m[1], from: i, to: i };
      keySpans.push(current);
      continue;
    }
    if (/^  [}\]]/.test(line) && current) { current.to = i - 1; current = null; }
  }
  if (current) current.to = cfgEnd - 1;
}
if (cfgEnd < 0) throw new Error("config.js: end of the config object not found");

// User-config input names config.js reads at startup: u.<x>, gmgnUserConfig.<x>, and anything a
// helper called with the whole `u` reads (permissive: every `.name` in that helper's module).
const inputNames = new Set();
for (const m of configSrc.matchAll(new RegExp(`\\bu\\.(${IDENT})`, "g"))) inputNames.add(m[1]);
for (const m of configSrc.matchAll(new RegExp(`\\bu\\[\\s*["'](${IDENT})["']\\s*\\]`, "g"))) inputNames.add(m[1]);
const gmgnInputNames = new Set();
for (const m of configSrc.matchAll(new RegExp(`\\bgmgnUserConfig\\.(${IDENT})`, "g"))) gmgnInputNames.add(m[1]);
{
  const helpers = new Set([...configSrc.matchAll(new RegExp(`(${IDENT})\\(u\\)`, "g"))].map((m) => m[1]));
  for (const m of configSrc.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"(\.\/[^"]+)"/gm)) {
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop());
    if (!names.some((n) => helpers.has(n))) continue;
    const modSrc = read(path.normalize(m[2]));
    for (const mm of modSrc.matchAll(new RegExp(`\\.(${IDENT})`, "g"))) inputNames.add(mm[1]);
  }
}

// ── 2. reload list (config.js reloadScreeningThresholds) ────────────────────
const reloadStart = configLines.findIndex((l) => /^export function reloadScreeningThresholds\b/.test(l));
if (reloadStart < 0) throw new Error("config.js: reloadScreeningThresholds not found");
let reloadEnd = configLines.length - 1;
for (let i = reloadStart + 1; i < configLines.length; i++) if (configLines[i] === "}") { reloadEnd = i; break; }
const reloadBody = configLines.slice(reloadStart, reloadEnd + 1).join("\n");
const reloadKeys = new Set();
for (const m of reloadBody.matchAll(new RegExp(`\\bfresh\\.(${IDENT})`, "g"))) reloadKeys.add(m[1]);
for (const m of reloadBody.matchAll(/for\s*\(\s*const\s+\w+\s+of\s+\[([^\]]*)\]\s*\)/g)) {
  for (const s of m[1].matchAll(/["']([\w$]+)["']/g)) reloadKeys.add(s[1]);
}

// ── 3. update_config allow-list (tools/executor.js CONFIG_MAP) ──────────────
const execRel = "tools/executor.js";
const execLines = read(execRel).split("\n");
const mapStart = execLines.findIndex((l) => /^\s*const CONFIG_MAP = \{\s*$/.test(l));
if (mapStart < 0) throw new Error(`${execRel}: const CONFIG_MAP = { not found`);
const mapIndent = execLines[mapStart].match(/^\s*/)[0];
let mapEnd = -1;
for (let i = mapStart + 1; i < execLines.length; i++) if (execLines[i] === `${mapIndent}};`) { mapEnd = i; break; }
if (mapEnd < 0) throw new Error(`${execRel}: end of CONFIG_MAP not found`);
const updateMap = {};         // key → { section, field, persistPath, line }
for (let i = mapStart + 1; i < mapEnd; i++) {
  const m = execLines[i].match(new RegExp(`^\\s*["']?(${IDENT})["']?\\s*:\\s*\\[\\s*"(${IDENT})"\\s*,\\s*"(${IDENT})"\\s*(?:,\\s*(.*?))?\\]\\s*,?\\s*(?://.*)?$`));
  if (!m) continue;
  let persistPath = null;
  if (m[4] && m[4].trim().startsWith("[")) persistPath = [...m[4].matchAll(/"([\w$]+)"/g)].map((x) => x[1]);
  updateMap[m[1]] = { section: m[2], field: m[3], persistPath, line: i + 1 };
}

// ── 4. setup.js fields ──────────────────────────────────────────────────────
const setupKeys = {};         // key → "user" | "gmgn"
for (const m of read("setup.js").matchAll(/\{\s*key:\s*"([\w$]+)"([^\n]*)/g)) {
  if (!/\btype:\s*"/.test(m[2])) continue; // choice options carry no type
  setupKeys[m[1]] = /configFile:\s*"gmgn"/.test(m[2]) ? "gmgn" : "user";
}
let exampleKeys = [];
try { exampleKeys = Object.keys(JSON.parse(read("user-config.example.json"))).filter((k) => !k.startsWith("_")); } catch { /* optional */ }

// ── reads across the codebase ───────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", ".agents", "docs"]);
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name), out);
    } else if (/\.(js|mjs|cjs)$/.test(ent.name)) {
      out.push(path.relative(ROOT, path.join(dir, ent.name)));
    }
  }
  return out;
}
// Whole-line `//` comments and `/* … */` blocks are blanked (line numbers kept).
function codeLines(src) {
  const lines = src.split("\n");
  let inBlock = false;
  return lines.map((line) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      return "";
    }
    if (t.startsWith("//")) return "";
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      return "";
    }
    return line;
  });
}
const files = walk(ROOT).filter((f) => f !== SELF && f !== "setup.js").sort();
const sources = files.map((rel) => ({
  rel,
  tooling: /^(scripts|test)\//.test(rel),
  lines: codeLines(read(rel)),
}));

const allKeys = [];
for (const [section, keys] of Object.entries(defaults)) for (const key of Object.keys(keys)) allKeys.push({ section, key });
const spanOf = new Map(keySpans.map((s) => [`${s.section}.${s.key}`, s]));
const mapLineByKey = new Map(Object.entries(updateMap).map(([k, v]) => [k, v.line - 1]));

function readsOf(section, key) {
  const re = identRe(key);
  const span = spanOf.get(`${section}.${key}`);
  const prod = [];
  const tooling = [];
  for (const src of sources) {
    src.lines.forEach((line, i) => {
      if (!line || !re.test(line)) return;
      if (src.rel === "config.js") {
        if (span && i >= span.from && i <= span.to) return;          // its own default
        if (i >= reloadStart && i <= reloadEnd) return;              // the reload list
      }
      if (src.rel === execRel && i > mapStart && i < mapEnd && new RegExp(`^\\s*["']?${escapeRe(key)}["']?\\s*:`).test(line)) return; // its CONFIG_MAP entry
      (src.tooling ? tooling : prod).push(`${src.rel}:${i + 1}`);
    });
  }
  return { prod, tooling };
}

// ── checks ──────────────────────────────────────────────────────────────────
const findings = [];
const add = (level, check, key, detail) => findings.push({ level, check, key, detail });

const readCounts = {};
for (const { section, key } of allKeys) {
  const { prod, tooling } = readsOf(section, key);
  readCounts[`${section}.${key}`] = { prod: prod.length, tooling: tooling.length };
  if (prod.length === 0 && tooling.length === 0) {
    add("FAIL", "unread", `${section}.${key}`, `default ${defaults[section][key]} — no read anywhere outside its definition sites`);
  } else if (prod.length === 0) {
    add("WARN", "tooling_only", `${section}.${key}`, `read only by tooling: ${tooling.slice(0, 4).join(", ")}${tooling.length > 4 ? " …" : ""}`);
  }
}

const sectionNames = new Set(Object.keys(defaults));
const defaultKeyNames = new Set(allKeys.map((k) => k.key));
for (const [key, { section, field, persistPath, line }] of Object.entries(updateMap)) {
  if (!defaults[section] || !(field in defaults[section])) {
    add("FAIL", "map_no_default", key, `${execRel}:${line} maps to config.${section}.${field}, which has no default`);
    continue;
  }
  if (section === "gmgn") continue; // persisted to gmgn-config.json
  const persisted = persistPath ? persistPath[0] : key;
  if (!inputNames.has(persisted)) {
    add("WARN", "persist_unread", key, `persisted to user-config.json as "${persisted}", which config.js never reads at startup`);
  }
}

for (const key of reloadKeys) {
  if (defaultKeyNames.has(key) || sectionNames.has(key) || inputNames.has(key)) continue;
  add("FAIL", "reload_unknown", key, "reloadScreeningThresholds reads it, but it is not a defaults key, a section or a user-config input");
}

const tunable = new Set(Object.values(updateMap).map((v) => `${v.section}.${v.field}`));
for (const { section, key } of allKeys) {
  if (!tunable.has(`${section}.${key}`)) add("INFO", "not_tunable", `${section}.${key}`, "no update_config entry");
}

for (const [key, file] of Object.entries(setupKeys)) {
  const known = file === "gmgn" ? (gmgnInputNames.has(key) || key in (defaults.gmgn || {})) : inputNames.has(key);
  if (!known) add("WARN", "setup_unknown", key, `setup.js asks for it (${file === "gmgn" ? "gmgn-config.json" : "user-config.json"}), config.js never reads it`);
}
for (const key of exampleKeys) {
  if (!inputNames.has(key)) add("WARN", "example_unknown", key, "user-config.example.json carries it, config.js never reads it");
}

// ── output ──────────────────────────────────────────────────────────────────
const count = (level) => findings.filter((f) => f.level === level).length;
const summary = {
  defaults_keys: allKeys.length,
  sections: Object.keys(defaults).length,
  reload_keys: reloadKeys.size,
  update_config_keys: Object.keys(updateMap).length,
  setup_keys: Object.keys(setupKeys).length,
  example_keys: exampleKeys.length,
  files_scanned: sources.length,
  fail: count("FAIL"),
  warn: count("WARN"),
  info: count("INFO"),
};

if (asJson) {
  console.log(JSON.stringify({ summary, findings, ...(verbose ? { reads: readCounts } : {}) }, null, 2));
} else {
  const order = { FAIL: 0, WARN: 1, INFO: 2 };
  const shown = findings
    .filter((f) => verbose || f.level !== "INFO")
    .sort((a, b) => order[a.level] - order[b.level] || a.check.localeCompare(b.check) || a.key.localeCompare(b.key));
  for (const f of shown) console.log(`${f.level.padEnd(4)} ${f.check.padEnd(15)} ${f.key} — ${f.detail}`);
  if (!verbose && summary.info) console.log(`INFO not_tunable: ${summary.info} defaults keys have no update_config entry (--verbose lists them)`);
  console.log(
    `config-key lint: ${summary.defaults_keys} defaults keys in ${summary.sections} sections, ` +
    `${summary.reload_keys} reload, ${summary.update_config_keys} update_config, ${summary.setup_keys} setup.js; ` +
    `${summary.files_scanned} files scanned — ${summary.fail} FAIL, ${summary.warn} WARN, ${summary.info} INFO`,
  );
}
process.exit(summary.fail > 0 ? 1 : 0);
