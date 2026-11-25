#!/usr/bin/env node
/**
 * Experiments-board publisher — builds the `experiments-board` kv_store document the dashboard's
 * Experiments section renders (contract: meridian-dashboard docs/plans/experiments-board-contract.md,
 * schema_version 1) and writes that ONE row. Runs hourly on the VM as the PM2 cron app
 * `meridian-experiments-publisher`.
 *
 *   node scripts/experiments/publish.js [--dry-run] [--out <file>]
 *        [--input <performance.json> --config <modes.json> [--previous <board.json>]] [--now <ISO>]
 *
 * Default (VM): reads the perf records with one read-only query (kv_store 'lessons'), the rule keys
 * of prod user-config.json (dataPath), the previous board row (for the per-day history ring), grades
 * with lib.js gradeAll, builds the doc and upserts kv_store 'experiments-board'. Nothing else is
 * read or written: no agent store is imported (lessons.js / state.js / config.js are never loaded),
 * and `experiments-board` is not a registered doc store, so this script is its only writer.
 *   --dry-run   build and print the summary; never writes the DB
 *   --out F     also write the doc to F (never writes the DB)
 *   --input F   perf records from a file (an export); with --config / --previous no DB is opened.
 *               Needs --dry-run or --out: a board built from a file is never written to the DB.
 *   --now ISO   build as of this instant
 * PERSIST_BACKEND other than pg (and no --input) → exit 0, nothing read or written.
 * Exit 0 on success, 1 on failure with a one-line reason. Never prints secrets or connection strings.
 *
 * buildBoard() is pure (no fs / network / DB): every input is passed in.
 */
import "../../envcrypt.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, dataPath } from "../../repo-root.js";
import { EXPERIMENTS, UNGRADED } from "./definitions.js";
import { gradeAll } from "./lib.js";
import * as SB from "./scoreboard.js";

export const BOARD_KEY = "experiments-board";
export const SCHEMA_VERSION = 1;
export const MAX_DOC_BYTES = 512 * 1024;
export const HISTORY_MAX = 30;
export const TABLE_CAPS = Object.freeze({ tables: 6, rows: 40, cols: 12 });
export const FROZEN_AFTER_DAYS = 3;
export const PUBLISHER = Object.freeze({ interval_min: 60, stale_after_min: 150 });
const DAY = 86400000;

// Same filter as export.sh: what the grader may see of prod user-config.json.
export const EXPORT_ALLOW = Object.freeze([
  "trailStraddleShadowTrigger", "graceLockShadowArmPct", "graceLockShadowDropPct", "maxHoldMinutes",
  "firstEntryProbationPct", "firstEntryProbationMin", "pumpGateMax24hPct", "feeEdgeGateMin",
  "reentryGateMinWinPct", "reentryGateMinGapMin", "reentryGateMaxGapMin", "postStopCooldownHours",
  "deployAmountSol", "maxPositions",
]);
// A camelCase word of a key that marks a secret / endpoint: such a key is never copied, whatever names it.
const SECRET_WORDS = new Set(["key", "keys", "secret", "token", "private", "password", "passphrase", "mnemonic", "wallet", "rpc", "url", "seed", "auth"]);
const KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;
export const looksSecret = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_]+/).some((w) => SECRET_WORDS.has(w));
const SECRET_RE = { test: looksSecret };
export const isExportable = (k) => typeof k === "string" && KEY_RE.test(k) && !SECRET_RE.test(k) && (k.endsWith("Mode") || k.endsWith("Enabled") || EXPORT_ALLOW.includes(k));
export function graderConfig(modes) {
  const out = {};
  for (const [k, v] of Object.entries(modes || {})) if (isExportable(k) && (v === null || ["string", "number", "boolean"].includes(typeof v))) out[k] = v;
  return out;
}

// ---------- markdown → plain ----------
export function plain(s) {
  if (s == null) return "";
  return String(s)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_\s][^_]*)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\*\*/g, "")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
const plainOrNull = (s) => { const p = plain(s); return p || null; };

export function parseDoc(src) {
  if (typeof src !== "string") throw new Error("not a text file");
  const text = src.replace(/\r\n/g, "\n");
  const fm = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    body = text.slice(m[0].length);
  }
  const h1 = (/^# (.+)$/m.exec(body) || [])[1] || null;
  const sections = {};
  let cur = null;
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    const h = !fence && /^## (.+)$/.exec(line);
    if (h) { cur = h[1].trim(); sections[cur] = []; continue; }
    if (cur) sections[cur].push(line);
  }
  return { fm, title: h1 ? plain(h1) : null, sections, hasFrontMatter: !!m };
}
const section = (doc, prefix) => {
  const k = Object.keys(doc.sections).find((x) => x.toLowerCase().startsWith(prefix.toLowerCase()));
  return k ? doc.sections[k] : null;
};
function paragraphs(lines) {
  const out = [];
  let buf = [];
  for (const l of lines || []) {
    if (!l.trim()) { if (buf.length) out.push(plain(buf.join(" "))); buf = []; continue; }
    buf.push(l);
  }
  if (buf.length) out.push(plain(buf.join(" ")));
  return out.filter(Boolean);
}
// "1. foo\n   bar" → [{ n: 1, text: "foo bar" }, …]
function numberedItems(lines) {
  const items = [];
  let cur = null;
  for (const l of lines || []) {
    const m = /^(\d+)\.\s+(.*)$/.exec(l);
    if (m) { if (cur) items.push(cur); cur = { n: +m[1], text: m[2] }; continue; }
    if (cur && /^\s{2,}\S/.test(l)) { cur.text += " " + l.trim(); continue; }
    if (cur) { items.push(cur); cur = null; }
  }
  if (cur) items.push(cur);
  return items.map((x) => ({ n: x.n, text: plain(x.text) }));
}
// [first numbered line, last line of the numbered block] of a section, or null
function numberedBlock(lines) {
  const first = lines.findIndex((l) => /^\d+\.\s/.test(l));
  if (first < 0) return null;
  let last = first;
  for (let i = first + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\d+\.\s/.test(l) || (/^\s{2,}\S/.test(l) && last === i - 1)) last = i;
    else if (!l.trim()) { const next = lines.slice(i + 1).find((x) => x.trim()); if (!next || !/^\d+\.\s/.test(next)) break; }
    else break;
  }
  return [first, last];
}

// ---------- markdown tables ----------
const isTableLine = (l) => /^\s*\|/.test(l);
function splitRow(l) {
  let t = l.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => plain(c));
}
const isSeparatorRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, "")));

/** Raw table lines → { header, rows } with ragged rows padded, capped at TABLE_CAPS (warn on a cut). */
export function normalizeTable(lines, warn = () => {}, where = "table") {
  const parsed = lines.map(splitRow).filter((c) => !isSeparatorRow(c));
  if (!parsed.length) return null;
  const [header, ...rows] = parsed;
  let width = Math.max(header.length, ...rows.map((r) => r.length));
  if (width > TABLE_CAPS.cols) { warn(`${where}: ${width} columns, kept ${TABLE_CAPS.cols}`); width = TABLE_CAPS.cols; }
  const fit = (r) => { const out = r.slice(0, width); while (out.length < width) out.push(""); return out; };
  let body = rows.map(fit);
  if (body.length > TABLE_CAPS.rows) { warn(`${where}: ${body.length} rows, kept ${TABLE_CAPS.rows}`); body = body.slice(0, TABLE_CAPS.rows); }
  return { header: fit(header), rows: body };
}

// ---------- grading log ----------
const KNOWN_VERDICTS = ["insufficient", "not_met", "met", "drop", "report_only", "already_enforced", "registered", "met_with_deviation"];
export function gradingLog(doc, warn = () => {}, docPath = "doc") {
  const lines = section(doc, "Grading log") || [];
  const entries = [];
  let cur = null;
  let idx = 0;
  for (const l of lines) {
    const h = /^### (.+)$/.exec(l);
    if (h) {
      if (cur) entries.push(cur);
      const head = h[1];
      const date = (/(\d{4}-\d{2}-\d{2})/.exec(head) || [])[1] || null;
      const time = (/\d{4}-\d{2}-\d{2} (\d{2}:\d{2}) WIB/.exec(head) || [])[1] || null;
      let verdict = null;
      const vm = /—\s*(\*\*)?\s*([a-z_]+)\s*(\*\*)?/.exec(head);
      if (vm && (KNOWN_VERDICTS.includes(vm[2]) || (vm[1] && vm[3] && vm[2].includes("_")))) verdict = vm[2];
      cur = { date, time_wib: time, heading: plain(head), verdict, raw: [], idx: idx++ };
      continue;
    }
    if (cur) cur.raw.push(l);
  }
  if (cur) entries.push(cur);
  for (const e of entries) {
    const out = [];
    const tableBlocks = [];
    let buf = null;
    let tbl = null;
    for (const l of e.raw) {
      if (/^\s*```/.test(l)) continue;
      if (isTableLine(l)) {
        if (buf != null) { out.push(buf); buf = null; }
        if (!tbl) { tbl = []; tableBlocks.push(tbl); }
        tbl.push(l);
        continue;
      }
      tbl = null;
      if (!l.trim()) { if (buf != null) out.push(buf); buf = null; continue; }
      const item = /^\s*(-|\*|\d+\.)\s+(.*)$/.exec(l);
      if (item) { if (buf != null) out.push(buf); buf = /^\d/.test(item[1]) ? `${item[1]} ${item[2]}` : item[2]; continue; }
      buf = buf == null ? l : buf + " " + l.trim();
    }
    if (buf != null) out.push(buf);
    e.lines = out.map(plain).filter(Boolean);
    const where = `${docPath} grading log ${e.date || e.heading.slice(0, 30)}`;
    if (tableBlocks.length > TABLE_CAPS.tables) warn(`${where}: ${tableBlocks.length} tables, kept ${TABLE_CAPS.tables}`);
    e.tables = tableBlocks.slice(0, TABLE_CAPS.tables).map((b, i) => normalizeTable(b, warn, `${where} table ${i + 1}`)).filter(Boolean);
    delete e.raw;
  }
  entries.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.time_wib || "").localeCompare(a.time_wib || "") || b.idx - a.idx);
  return entries.map(({ idx, ...rest }) => rest);
}

function mdTable(lines) {
  const rows = (lines || []).filter(isTableLine).map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
  return rows.filter((r) => !isSeparatorRow(r)).slice(1);
}

// ---------- history ring ----------
/** Previous per-day points (WIB day keys) + today's n: same-day replaced, oldest first, ≤ HISTORY_MAX. */
export function nextHistory(prev, today, n) {
  const ok = (p) => p && typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && typeof p.n === "number" && Number.isFinite(p.n);
  const byDate = new Map();
  for (const p of Array.isArray(prev) ? prev : []) if (ok(p) && p.date < today) byDate.set(p.date, { date: p.date, n: p.n });
  if (typeof n === "number" && Number.isFinite(n)) byDate.set(today, { date: today, n });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-HISTORY_MAX);
}

// ---------- domain maps the grader does not supply ----------
const CHECK_UNITS = {
  disaster_ratio_gate: ["ratio", "sol"],
  first_entry_probation: ["pct", "share"],
  max_hold: ["sol", "sol", "text", "sol", "sol_pair"],
  trail_straddle: ["share", "pp"],
  grace_lock: ["sol", "sol", "text", "sol", "sol_pair", "sol"],
  reading_guard: ["share", "count", "count"],
};
const KIND = { grader: "shadow", records: "records", replay: "replay", report: "report" };
const ON_MET_KINDS = ["auto_promote", "proposal", "operator_decision", "none"];
const RANK = { due: 0, waiting_operator: 10, stale: 20, soon: 30, on_track: 40, waiting: 50, report: 90 };
// the scoreboard's count for reading-guard (it has none of its own: episodes = sample.n_tagged)
const BOARD_EXTRACTORS = { ...SB.EXTRACTORS, "reading-guard": (e) => { const v = e?.sample?.n_tagged; return typeof v === "number" && Number.isFinite(v) ? v : null; } };

const r6 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v ?? null);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const modeEnum = (s) => {
  const t = String(s || "").toLowerCase();
  if (t.startsWith("enforce")) return "enforce";
  if (t.startsWith("shadow")) return "shadow";
  if (t.startsWith("off")) return "off";
  return "none";
};
function stateOf(pass, sampleN) {
  if (sampleN === 0) return "not_yet";
  return pass === true ? "pass" : pass === false ? "fail" : "not_computable";
}
function splitPair(v) {
  const m = /^(-?[\d.]+)\s*\/\s*(-?[\d.]+)$/.exec(String(v));
  return m ? [r6(+m[1]), r6(+m[2])] : null;
}
function checkRow(c, i, unit, sampleN, robust) {
  let value = c.value, value2 = null, u = unit || "text";
  if (u === "sol_pair") { const p = splitPair(c.value); if (p) { [value, value2] = p; u = "sol"; } else u = "text"; }
  if (u !== "text" && value != null && typeof value !== "number") u = "text"; // e.g. ratio "inf"
  if (u === "text") value = value == null ? null : String(value);
  const rc = robust?.checks?.[i];
  let robustValue = rc ? rc.value : null, robustValue2 = null;
  if (unit === "sol_pair" && rc) { const p = splitPair(rc.value); if (p) [robustValue, robustValue2] = p; }
  if (u === "text" && robustValue != null) robustValue = String(robustValue);
  return {
    n: i + 2, kind: "check", label: plain(c.name), need: c.need == null ? null : plain(c.need),
    state: stateOf(c.pass, sampleN),
    value: r6(value), value2: r6(value2), unit: u,
    detail: c.detail ? plain(c.detail) : null,
    robust_state: rc ? stateOf(rc.pass, sampleN) : null,
    robust_value: r6(robustValue), robust_value2: r6(robustValue2),
  };
}
function keyMetrics(e) {
  const m = e.metrics || {};
  const K = [];
  const add = (label, value, unit, extra = {}) => K.push({ label, value: r6(value), unit, ci90: null, note: null, ...extra });
  const ci = (c) => (c && Number.isFinite(c.lo) ? { lo: r6(c.lo), hi: r6(c.hi) } : null);
  switch (e.id) {
    case "max-hold":
      add(`Σ Δ◎ at the ${m.cap_min}-min cap`, m.row_at_cap?.sum ?? null, "sol", { ci90: ci(m.ci90_sum_delta_sol) });
      add("Better / worse closes", m.row_at_cap ? `${m.row_at_cap.better} / ${m.row_at_cap.worse}` : null, "text");
      add("Effect size d", m.row_at_cap?.d ?? null, "number");
      add("Records with a counterfactual", m.records_with_cf ?? null, "count");
      add("Live would-fires (max_hold_shadow)", m.max_hold_shadow_would_fires ?? null, "count");
      add("Last bot close in the sample", m.last_bot_close ?? null, "datetime");
      break;
    case "trail-straddle-trigger":
      add("Straddled trailing closes", m.straddled_trailing_closes ?? null, "count");
      add("Would hold / same", `${m.would_hold ?? 0} / ${m.same ?? 0}`, "text");
      add("Net of the would-hold cases", m.would_hold_net_sol ?? null, "sol", { ci90: ci(m.ci90_tagged_net_sol) });
      add("Net of the same cases", m.same_net_sol ?? null, "sol");
      add("Tail risk taken on (Σ fire − stop)", m.tail_risk_sol ?? null, "sol", { note: m.tail_risk_pp != null ? `${m.tail_risk_pp} pp` : null });
      break;
    case "grace-profit-lock":
      add("Forward fires", m.fires?.n ?? null, "count");
      add("Σ Δ◎ over the fires", m.fires?.sum_delta_sol ?? null, "sol", { ci90: ci(m.ci90_sum_delta_sol) });
      add("Armed, not fired", m.armed_not_fired ?? null, "count");
      add("Graces without a fire", m.graces_without_fire ?? null, "count");
      add("Interrupted by HOLD", m.interrupted_by_hold ?? null, "count");
      break;
    case "reading-guard":
      add("Episodes", m.episodes ?? null, "count");
      add("Positions with an episode", m.positions ?? null, "count");
      add("Ended reverted / capital re-base", `${m.by_end?.reverted ?? 0} / ${m.by_end?.capital_rebase ?? 0}`, "text");
      add("Not already suspect, with an effect", m.trusted_effect ?? null, "count");
      break;
    case "grace-shadow":
      for (const [k, v] of Object.entries(m.by_kind || {}).slice(0, 3)) {
        add(`${k}: Σ (pnl − no-grace fire)`, v.sum_pnl_minus_fire_sol, "sol", { note: `${v.sum_pnl_minus_fire_pp} pp over ${v.with_fire} with a fire (${v.n} records)` });
        add(`${k}: final above the fire`, v.share_final_above_fire, "share");
      }
      break;
    case "grace-early-release":
      add("Would-release records", m.n ?? null, "count", { note: `bot ${m.bot ?? 0}, operator ${m.adopted ?? 0}` });
      add("Σ (final − at would-release)", m.sum_final_minus_would_release_sol ?? null, "sol", { note: m.sum_final_minus_would_release_pp != null ? `${m.sum_final_minus_would_release_pp} pp` : null });
      add("Final above / below", `${m.final_above_would_release ?? 0} / ${m.final_below_would_release ?? 0}`, "text");
      break;
    case "straddle-trend-ceiling":
      add("Flagged (ceiling would skip)", m.ceiling_would_skip?.n ?? null, "count");
      add("Flagged and straddled anyway: net", m.ceiling_would_skip_straddled?.net_sol ?? null, "sol", { note: `${m.ceiling_would_skip_straddled?.n ?? 0} positions, ${m.ceiling_would_skip_straddled?.disasters ?? 0} at ≤ −10 %` });
      add("Not flagged, straddled: net", m.no_ceiling_skip_straddled?.net_sol ?? null, "sol", { note: `${m.no_ceiling_skip_straddled?.n ?? 0} positions, ${m.no_ceiling_skip_straddled?.disasters ?? 0} at ≤ −10 %` });
      break;
    case "hold-downside":
      add("Records carrying the capture", m.n_carrying ?? null, "count", { note: m.note ? plain(m.note) : null });
      break;
  }
  return K.slice(0, 6);
}
function largestOf(e) {
  const m = e.metrics || {};
  const r = m.largest_delta || m.largest_tagged || null;
  if (!r) return null;
  return { label: m.largest_delta ? "largest Δ◎" : "largest |net|", pool_name: r.pool_name ?? null, position: r.position ?? null, recorded_at: r.recorded_at ?? null, net_sol: r6(r.net_sol ?? null), pnl_pct: r.pnl_pct ?? null, delta_sol: r6(r.delta_sol ?? null) };
}
function firstSentence(s) {
  const p = plain(s);
  const m = /^(.+?[.;])(\s|$)/.exec(p);
  return m ? m[1] : p;
}

/** Rule / mode / threshold keys an experiment names: the definition's key, the doc's config_key, schedule config_keys. */
function namedKeys(def, doc, sched) {
  const keys = [];
  const push = (k) => { if (typeof k === "string" && KEY_RE.test(k) && !SECRET_RE.test(k) && !keys.includes(k)) keys.push(k); };
  if (def) push(def.configKey);
  const fk = doc?.fm?.config_key;
  if (!def && fk && fk !== "null") for (const k of fk.split("(")[0].split(/[/,]/).map((x) => x.trim())) push(k);
  for (const k of Array.isArray(sched?.config_keys) ? sched.config_keys : []) push(k);
  return keys;
}
function configRows(keys, def, modes, modesSource) {
  return keys.map((key) => {
    const has = modes && Object.prototype.hasOwnProperty.call(modes, key) && modes[key] !== undefined;
    const v = has ? modes[key] : undefined;
    if (has && (v === null || ["string", "number", "boolean"].includes(typeof v))) return { key, value: v, source: "prod_config" };
    if (has) return { key, value: null, source: "prod_config" }; // not a scalar: never copied
    if (modesSource === "export" && !isExportable(key)) return { key, value: null, source: "not_exported" };
    return { key, value: def && def.configKey === key ? def.codeDefault ?? null : null, source: "code_default" };
  });
}

// ---------- the document ----------
/**
 * @param records     perf records (array)
 * @param modes       flat config object (prod user-config.json, or the export's modes.json)
 * @param modesSource "user_config" | "export" (decides not_exported vs code_default)
 * @param schedule    schedule.json, decisions decisions.json, docs { id: text }, readme text
 * @param previousDoc the stored board (history ring) or null
 */
export function buildBoard({ records, modes = {}, modesSource = "user_config", schedule, decisions, docs = {}, readme = "", previousDoc = null, now = Date.now(), botCommit = null }) {
  const warnings = [];
  const warn = (s) => { const p = plain(s); if (p && !warnings.includes(p)) warnings.push(p); };
  const recs = Array.isArray(records) ? records : [];
  if (!Array.isArray(records)) warn("perf records are not an array: graded on 0 records");
  const sched = schedule && typeof schedule === "object" && schedule.experiments && typeof schedule.experiments === "object" ? schedule : (warn("schedule.json has no experiments object"), { experiments: {} });
  const dec = decisions && typeof decisions === "object" && !Array.isArray(decisions) ? decisions : (warn("decisions.json is not an object"), {});
  const today = SB.wibDate(now);
  const weekEnd = SB.wibDate(now + 7 * DAY);
  const generatedAt = iso(now);

  // grade
  const cfg = graderConfig(modes);
  let report;
  try {
    report = gradeAll(EXPERIMENTS, recs, { cfg, now, ungraded: UNGRADED, decisions: dec });
  } catch (e) {
    warn(`grader failed: ${e.message}`);
    report = { generated_at: generatedAt, input_records: recs.length, experiments: [], action_list: [], revert_checks: [], ungraded: [] };
  }

  // docs
  const parsed = {};
  for (const [id, text] of Object.entries(docs || {})) {
    try {
      parsed[id] = parseDoc(text);
      if (!parsed[id].hasFrontMatter) warn(`docs/experiments/${id}.md has no front matter`);
    } catch (e) {
      warn(`docs/experiments/${id}.md could not be parsed: ${e.message}`);
    }
  }
  let readmeDoc = null;
  try { readmeDoc = parseDoc(readme || ""); } catch (e) { warn(`docs/experiments/README.md could not be parsed: ${e.message}`); }
  const logs = {};
  const logOf = (id) => {
    if (!parsed[id]) return [];
    if (!logs[id]) {
      try { logs[id] = gradingLog(parsed[id], warn, `docs/experiments/${id}.md`); } catch (e) { warn(`docs/experiments/${id}.md grading log could not be parsed: ${e.message}`); logs[id] = []; }
    }
    return logs[id];
  };

  // history ring: previous doc → synthetic day files for the scoreboard, today's grader run last
  let prevExps = [];
  if (previousDoc != null) {
    if (typeof previousDoc === "object" && Array.isArray(previousDoc.experiments)) {
      if (previousDoc.schema_version !== SCHEMA_VERSION) warn(`previous board has schema_version ${previousDoc.schema_version}: history read best-effort`);
      prevExps = previousDoc.experiments.filter((x) => x && typeof x.id === "string");
    } else warn("previous board is malformed: history restarts");
  }
  const prevHistory = (id) => prevExps.find((x) => x.id === id)?.progress?.history || [];
  const byDay = new Map();
  for (const x of prevExps) {
    for (const p of nextHistory(x.progress?.history, today, null)) {
      if (!byDay.has(p.date)) byDay.set(p.date, []);
      byDay.get(p.date).push({ id: x.id, sample: { n_tagged: p.n } });
    }
  }
  const files = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, experiments]) => ({ date, at: SB.dateKeyToMs(date), data: { experiments } }));
  files.push({ date: today, at: now, data: report });
  const rows = SB.buildRows({ schedule: sched, decisions: dec, files, records: recs, now, replayRuns: {}, extractors: BOARD_EXTRACTORS });

  const experiments = [];
  for (const row of rows) {
    const id = row.id;
    const s = sched.experiments[id] || {};
    const doc = parsed[id] || null;
    if (!doc) warn(docs && Object.prototype.hasOwnProperty.call(docs, id) ? `schedule.json row ${id}: its doc could not be parsed` : `schedule.json row ${id} has no docs/experiments/${id}.md`);
    const e = report.experiments.find((x) => x.id === id) || null;
    const act = report.action_list.find((x) => x.id === id) || null;
    const def = EXPERIMENTS.find((d) => d.id === id) || null;
    const kind = KIND[s.by] || "report";
    if (!KIND[s.by]) warn(`schedule.json row ${id}: unknown 'by' ${s.by}`);
    if (kind === "shadow" && !e) warn(`schedule.json row ${id} is graded by the grader but has no definition`);
    const log = logOf(id);
    const latest = log[0] || null;

    // progress
    const n = row.n, need = row.target;
    const extra = [];
    if (id === "reading-guard" && e) extra.push({ label: "positions", n: e.sample?.n_positions ?? null, need: def?.minPositions ?? null });
    if (id === "grace-backstop-stop") extra.push({ label: "fires at B = 20", n: row.fires, need: 6 });
    const paceState = row.pace === "reached" ? "reached" : row.per_week != null ? "progress" : row.pace === "no progress" ? "no_progress" : "n/a";
    const history = nextHistory(prevHistory(id), today, n);

    // checks
    let checks = [], checksSource = null, provisional = false, robust = null;
    if (e && e.checks?.length) {
      checksSource = "grader";
      const units = CHECK_UNITS[def?.grader] || [];
      const sampleN = e.sample?.n_tagged ?? null;
      checks = [{
        n: 1, kind: "threshold", label: plain(`Sample: ${e.threshold?.need ?? ""}`), need: e.threshold?.need ?? null,
        state: e.threshold?.reached ? "pass" : "not_yet", value: sampleN, value2: null, unit: "count",
        detail: e.threshold?.missing ? plain(`needs ${e.threshold.missing}`) : null, robust_state: null, robust_value: null, robust_value2: null,
      }, ...e.checks.map((c, i) => checkRow(c, i, units[i], sampleN, e.robust))];
      provisional = !e.threshold?.reached;
      if (e.robust) robust = {
        removed: e.robust.removed ? { pool_name: e.robust.removed.pool_name ?? null, recorded_at: e.robust.removed.recorded_at ?? null, value: r6(e.robust.removed.delta_sol ?? e.robust.removed.net_sol ?? null), unit: "sol" } : null,
        removed_by: plain(e.robust.removed_by || "largest |net| record"), all_pass: e.robust.all_pass ?? null, note: e.robust.note ? plain(e.robust.note) : null,
      };
    } else if (doc) {
      const items = numberedItems(section(doc, "Pass rule"));
      if (items.length) {
        checksSource = "doc";
        provisional = true;
        checks = items.map((it, i) => ({ n: it.n, kind: i === 0 ? "threshold" : "check", label: it.text, need: null, state: "not_yet", value: null, value2: null, unit: "text", detail: null, robust_state: null, robust_value: null, robust_value2: null }));
        if (kind === "records" && checks[0] && n != null) { checks[0].value = n; checks[0].unit = "count"; checks[0].detail = row.fires != null ? `${n} records, ${row.fires} fires` : `${n} records`; }
      }
    }

    const claim = doc ? paragraphs(section(doc, "Claim"))[0] || null : null;
    const ruleLines = doc ? section(doc, "Pass rule") || [] : [];
    const block = numberedBlock(ruleLines);
    const ruleHead = block ? paragraphs(ruleLines.slice(0, block[0])) : paragraphs(ruleLines);
    const ruleTail = block ? paragraphs(ruleLines.slice(block[1] + 1)) : [];
    const revertParas = doc ? paragraphs(section(doc, "Revert rule")) : [];

    // flags: records are recounted every run (never stale); replay staleness from the grading log
    let flags = (row.flags || []).map((f) => ({ kind: f.startsWith("DUE") ? "due" : "stale", text: f }));
    if (kind === "records" || kind === "replay") flags = flags.filter((f) => f.kind !== "stale");
    if (kind === "replay" && s.recheck_days != null) {
      const last = latest?.date || null;
      if (!last) flags.push({ kind: "stale", text: "STALE (never run)" });
      else {
        const age = SB.daysBetweenDates(last, today);
        if (age > s.recheck_days) flags.push({ kind: "stale", text: `STALE (last run ${age} d old > ${s.recheck_days} d)` });
      }
    }
    const due = flags.some((f) => f.kind === "due");
    const stale = flags.some((f) => f.kind === "stale");
    const opQ = typeof s.operator_question === "string" && s.operator_question.trim() ? plain(s.operator_question) : null;
    const waitingOp = !!opQ || (!!act && ["escalate", "build_enforce"].includes(act.action));
    const soon = !!row.next_date && row.next_date <= weekEnd;
    const onTrack = row.eta != null && row.next_date === row.eta;
    const status = due ? "due" : waitingOp ? "waiting_operator" : stale ? "stale" : kind === "report" ? "report" : onTrack ? "on_track" : "waiting";
    const reasons = [];
    if (due) reasons.push(...flags.filter((f) => f.kind === "due").map((f) => f.text));
    if (waitingOp) reasons.push(opQ || `action ${act.action}`);
    if (stale) reasons.push(...flags.filter((f) => f.kind === "stale").map((f) => f.text));
    if (soon) reasons.push(`next decision ${row.next_date}`);
    let rank = RANK[status];
    if ((status === "on_track" || status === "waiting") && soon) rank = RANK.soon;

    // verdict
    let verdict = null, verdictSource = null, verdictReason = null;
    if (e) { verdict = e.verdict; verdictSource = "grader"; verdictReason = plainOrNull(e.reason); }
    else {
      const fmStatus = doc?.fm?.status ? doc.fm.status.split(/[\s(:,]/)[0].trim() : "";
      if (fmStatus) { verdict = fmStatus; verdictSource = "doc_status"; }
      else if (latest?.verdict) { verdict = latest.verdict; verdictSource = "grading_log"; }
      else verdictSource = "doc_status";
      verdictReason = latest ? latest.heading.replace(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2} WIB)?\s*[—-]?\s*/, "") || null : null;
    }

    const lastEvidence = e && (kind === "shadow" || kind === "report") ? { at: generatedAt, date: null, label: "grader run" }
      : kind === "records" ? { at: generatedAt, date: null, label: "records recount" }
      : latest ? { at: null, date: latest.date, label: "grading log" } : null;

    const nextKind = row.next === "—" ? null : (/\((ETA|time arm|report by)\)$/.exec(row.next) || [])[1];
    const onMetKind = ON_MET_KINDS.includes(s.on_met_kind) ? s.on_met_kind : null;
    if (!onMetKind) warn(`schedule.json row ${id} has no valid on_met_kind`);
    const fmMode = doc?.fm?.mode || "";
    experiments.push({
      id,
      title: doc?.title || e?.title || id,
      doc_path: `docs/experiments/${id}.md`,
      kind,
      rule_kind: def?.kind ?? null,
      mode: e ? e.mode : modeEnum(fmMode),
      mode_note: e && typeof e.mode_value === "number" ? `trigger ${e.mode_value} %` : (!e && modeEnum(fmMode) === "none" ? plainOrNull(fmMode.replace(/^none\s*/, "").replace(/^\(|\)$/g, "")) : null),
      config: configRows(namedKeys(def, doc, s), def, modes, modesSource),
      enforce_built: def ? def.enforceBuilt : doc?.fm?.enforce_built ? doc.fm.enforce_built.startsWith("true") : null,
      registered_at: def?.registeredAt ?? (/^\d{4}-\d{2}-\d{2}$/.test(doc?.fm?.registered_at || "") ? doc.fm.registered_at : null),
      shadow_since: def?.shadowSince ?? null,
      verdict,
      verdict_reason: verdictReason,
      verdict_source: verdictSource,
      action: act ? act.action : null,
      progress: { n, need, metric: row.metric, extra, delta_7d: row.delta7, delta_basis: row.baseLabel, pace_state: paceState, per_week: paceState === "progress" ? row.per_week : null, eta: row.eta, history },
      schedule: { by: s.by ?? null, recheck_days: s.recheck_days ?? null, time_arm: s.time_arm ?? null, report_by: s.report_by ?? null, how: s.how ? plain(s.how) : null },
      next_decision: row.next_date ? { date: row.next_date, kind: nextKind === "ETA" ? "eta" : nextKind === "time arm" ? "time_arm" : "report_by" } : null,
      status,
      flags,
      waiting_on_operator: waitingOp,
      operator_question: opQ,
      attention: { rank, reasons: reasons.map(plain) },
      last_evidence: lastEvidence,
      detail: {
        claim,
        pass_rule: {
          text: e?.rule ? plain(e.rule) : (block ? null : ruleHead.join(" ") || null),
          source: e?.ruleSource ? plain(e.ruleSource) : (block ? ruleHead.join(" ") || null : null),
          outcome: e ? null : ruleTail.join(" ") || null,
          checks_source: checksSource,
          provisional,
          checks,
          robust,
          drop_rule: def?.dropRule ? plain(def.dropRule) : null,
        },
        key_metrics: e ? keyMetrics(e) : [],
        largest_record: e ? largestOf(e) : null,
        latest_result: !e && latest ? { date: latest.date, time_wib: latest.time_wib, verdict: latest.verdict, text: latest.lines.slice(0, 2).join(" ") || latest.heading, source: "grading_log", heading: latest.heading, lines: latest.lines, tables: latest.tables } : null,
        on_met: { kind: onMetKind, text: s.on_met ? plain(s.on_met) : null },
        revert_rule: revertParas.join(" ") || null,
        grading_log: log.slice(0, 10),
        revert_check: (report.revert_checks || []).find((r) => r.id === id) || null,
      },
    });
  }
  experiments.sort((a, b) => a.attention.rank - b.attention.rank || (a.next_decision?.date || "9").localeCompare(b.next_decision?.date || "9") || a.id.localeCompare(b.id));

  // enforced (graded descriptively, already on), not finished
  const enforced = report.experiments.filter((e) => e.verdict === "already_enforced" && !dec[e.id]).map((e) => {
    const def = EXPERIMENTS.find((d) => d.id === e.id) || null;
    return {
      id: e.id, title: parsed[e.id]?.title || e.title, doc_path: `docs/experiments/${e.id}.md`,
      config: configRows(namedKeys(def, parsed[e.id], null), def, modes, modesSource),
      summary: plain(logOf(e.id)[0]?.lines[0] || e.reason),
    };
  });

  const finished = Object.entries(dec).map(([id, d]) => ({
    id, title: parsed[id]?.title || id, doc_path: `docs/experiments/${id}.md`,
    decision: d?.decision ?? null, at: d?.at ?? null,
    summary: d?.summary ? plain(d.summary) : firstSentence(d?.note),
    note: plainOrNull(d?.note), source: "decisions",
  }));
  // a doc that is closed per its status but in neither decisions.json nor the schedule
  for (const [id, doc] of Object.entries(parsed)) {
    if (dec[id] || sched.experiments[id] || enforced.some((x) => x.id === id)) continue;
    if (report.experiments.some((x) => x.id === id)) continue; // graded but not scheduled: not finished
    const st = String(doc.fm.status || "").toLowerCase();
    if (!/closed|not_met|drop/.test(st)) { warn(`docs/experiments/${id}.md (status ${doc.fm.status || "none"}) is in neither schedule.json nor decisions.json`); continue; }
    const latest = logOf(id)[0];
    finished.push({ id, title: doc.title || id, doc_path: `docs/experiments/${id}.md`, decision: "closed", at: latest?.date || doc.fm.registered_at || null, summary: plain(doc.fm.status), note: latest ? latest.lines.join(" ") || null : null, source: "doc_status" });
  }
  finished.sort((a, b) => (b.at || "").localeCompare(a.at || "") || a.id.localeCompare(b.id));

  const rejected = readmeDoc ? mdTable(section(readmeDoc, "Rejected")).map(([idea = "", date = "", evidence = ""]) => {
    const ref = (/\]\(([\w-]+)\.md\)/.exec(evidence + idea) || [])[1] || null;
    return { idea: plain(idea), date: plain(date), evidence: plain(evidence), ref_id: ref };
  }) : [];
  const ungraded = readmeDoc ? mdTable(section(readmeDoc, "Ungraded")).map(([rule = "", key = "", need = ""]) => ({ rule: plain(rule), key: plain(key), capture_needed: plain(need) })) : [];
  if (readmeDoc && !section(readmeDoc, "Rejected")) warn("README.md has no 'Rejected' section");
  if (readmeDoc && !section(readmeDoc, "Ungraded")) warn("README.md has no 'Ungraded' section");

  const ob = SB.objective(recs, now);
  const groupOut = (w) => [["bot", "Bot"], ["bot_trailing", "Bot trailing TP"], ["operator", "Operator"]].map(([k, label]) => ({ key: k, label, ...ob[w][k], net_sol: r6(ob[w][k].net_sol) }));
  const newestBot = ob.newest_bot_close;
  const frozen = newestBot == null || now - newestBot > FROZEN_AFTER_DAYS * DAY;

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    publisher: { interval_min: PUBLISHER.interval_min, stale_after_min: PUBLISHER.stale_after_min, bot_commit: botCommit || null },
    grader: { ran_at: report.generated_at, input_records: report.input_records, records_newest_at: iso(ob.newest_record) },
    summary: {
      open: experiments.length,
      due: experiments.filter((x) => x.status === "due").length,
      waiting_on_operator: experiments.filter((x) => x.waiting_on_operator).length,
      stale: experiments.filter((x) => x.flags.some((f) => f.kind === "stale")).length,
      finished: finished.length,
      next_decision: (() => { const x = experiments.filter((e) => e.next_decision).sort((a, b) => a.next_decision.date.localeCompare(b.next_decision.date) || a.id.localeCompare(b.id))[0]; return x ? { id: x.id, ...x.next_decision } : null; })(),
    },
    objective: {
      windows: [{ key: "d7", days: 7, groups: groupOut("d7") }, { key: "d30", days: 30, groups: groupOut("d30") }],
      newest_bot_close_at: iso(newestBot),
      newest_record_at: iso(ob.newest_record),
      sample_frozen: frozen,
      frozen_note: frozen ? (newestBot == null ? "no bot close in the records" : `no bot close since ${SB.wibDateTime(newestBot)}`) : null,
    },
    experiments,
    enforced,
    finished,
    rejected,
    ungraded,
    warnings,
  };
}

export const docBytes = (doc) => Buffer.byteLength(JSON.stringify(doc), "utf8");
export function summaryLine(doc, bytes, where) {
  const s = doc.summary;
  return `[EXPERIMENTS_BOARD] open ${s.open} · due ${s.due} · waiting ${s.waiting_on_operator} · stale ${s.stale} · finished ${s.finished} · ${doc.warnings.length} warnings · ${bytes} bytes — ${where}`;
}

// ---------- CLI ----------
const HERE = path.dirname(fileURLToPath(import.meta.url));
function readJsonFile(file, what) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new Error(`cannot read ${what} ${file}: ${e.code || e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${what} ${file} is not JSON: ${e.message}`); }
}
function loadRepoInputs() {
  const schedule = readJsonFile(path.join(HERE, "schedule.json"), "schedule");
  const decisions = readJsonFile(path.join(HERE, "decisions.json"), "decisions");
  const dir = path.join(REPO_ROOT, "docs", "experiments");
  const docs = {};
  let readme = "";
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* no docs: warnings from buildBoard */ }
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    let text = null;
    try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    if (f === "README.md") readme = text; else docs[f.slice(0, -3)] = text;
  }
  return { schedule, decisions, docs, readme };
}
function gitCommit() {
  try { return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString().trim() || null; } catch { return null; }
}
function parseArgs(argv) {
  const a = { dryRun: false, out: null, input: null, config: null, previous: null, now: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = argv[++i]; if (v == null) throw new Error(`${k} needs a value`); return v; };
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--out") a.out = val();
    else if (k === "--input") a.input = val();
    else if (k === "--config") a.config = val();
    else if (k === "--previous") a.previous = val();
    else if (k === "--now") a.now = val();
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if ((a.config || a.previous) && !a.input) throw new Error("--config / --previous need --input");
  if (a.input && !a.dryRun && !a.out) throw new Error("--input needs --dry-run or --out (a board built from a file is never written to the DB)");
  return a;
}
const asRecords = (d) => { if (Array.isArray(d)) return d; if (d && typeof d === "object") for (const v of Object.values(d)) if (Array.isArray(v)) return v; return null; };

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) { console.log("usage: node scripts/experiments/publish.js [--dry-run] [--out <file>] [--input <performance.json> --config <modes.json> [--previous <board.json>]] [--now <ISO>]"); return 0; }
  const now = a.now ? Date.parse(a.now) : Date.now();
  if (!Number.isFinite(now)) throw new Error(`unreadable --now ${a.now}`);
  const inputs = loadRepoInputs();
  const botCommit = gitCommit();
  const finish = (doc) => {
    const bytes = docBytes(doc);
    if (bytes > MAX_DOC_BYTES) throw new Error(`board is ${bytes} bytes, over the ${MAX_DOC_BYTES}-byte limit — not written`);
    if (a.out) { fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true }); fs.writeFileSync(a.out, JSON.stringify(doc, null, 2) + "\n"); }
    return bytes;
  };

  if (a.input) {
    const records = asRecords(readJsonFile(a.input, "input"));
    if (!records) throw new Error(`input ${a.input} holds no record array`);
    const modes = a.config ? readJsonFile(a.config, "config") : {};
    if (!modes || typeof modes !== "object" || Array.isArray(modes)) throw new Error(`config ${a.config} is not a flat JSON object`);
    const previousDoc = a.previous ? readJsonFile(a.previous, "previous board") : null;
    const doc = buildBoard({ records, modes, modesSource: "export", ...inputs, previousDoc, now, botCommit });
    const bytes = finish(doc);
    console.log(summaryLine(doc, bytes, a.out ? `written to ${a.out} (no DB)` : "dry run, nothing written (no DB)"));
    return 0;
  }

  const { usePg, query, closePool } = await import("../../db/pool.js");
  if (!usePg()) { console.log("[EXPERIMENTS_BOARD] PERSIST_BACKEND is not pg — nothing read or written"); return 0; }
  try {
    const recRes = await query("select doc->'performance' as performance from kv_store where key = 'lessons'");
    const records = asRecords(recRes.rows[0]?.performance ?? null);
    if (!records) throw new Error("kv_store 'lessons' has no performance array");
    const prevRes = await query("select doc from kv_store where key = $1", [BOARD_KEY]);
    const previousDoc = prevRes.rows[0]?.doc ?? null;
    let modes = {};
    const extraWarnings = [];
    try {
      const cfg = JSON.parse(fs.readFileSync(dataPath("user-config.json"), "utf8"));
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) modes = cfg; else extraWarnings.push("user-config.json is not an object: config values shown as code defaults");
    } catch (e) {
      extraWarnings.push(`user-config.json unreadable (${e.code || "parse error"}): config values shown as code defaults`);
    }
    const doc = buildBoard({ records, modes, modesSource: "user_config", ...inputs, previousDoc, now, botCommit });
    doc.warnings.push(...extraWarnings);
    const bytes = finish(doc);
    if (!a.dryRun && !a.out) {
      await query(
        "INSERT INTO kv_store (key, doc, updated_at) VALUES ($1, $2::jsonb, now()) " +
          "ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
        [BOARD_KEY, JSON.stringify(doc)],
      );
      console.log(summaryLine(doc, bytes, `written to kv_store '${BOARD_KEY}'`));
    } else {
      console.log(summaryLine(doc, bytes, a.out ? `written to ${a.out}, DB not written` : "dry run, DB not written"));
    }
    return 0;
  } finally {
    await closePool().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`[EXPERIMENTS_BOARD] failed: ${String(e?.message || e).split("\n")[0]}`);
    process.exitCode = 1;
  });
}
