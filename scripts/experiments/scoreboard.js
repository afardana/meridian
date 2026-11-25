#!/usr/bin/env node
// Experiment scoreboard: re-evaluation schedule vs the daily grader output and the perf-record export.
// Read-only. Usage: node scripts/experiments/scoreboard.js [--status-dir D] [--schedule F] [--decisions F]
//   [--performance F] [--now ISO] [--out F] [--json]
// All dates are shown as WIB (Asia/Jakarta, UTC+7), computed explicitly in UTC ms (never the host zone).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAY = 86400000;
const WIB_MS = 7 * 3600000;
const BACKSTOP_SINCE = "2026-10-17";

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, "0");
export function wibDate(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + WIB_MS).toISOString().slice(0, 10);
}
export function wibDateTime(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + WIB_MS);
  return `${d.toISOString().slice(0, 10)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} WIB`;
}
export function dateKeyToMs(key) { // "YYYY-MM-DD" as a WIB calendar day -> UTC ms of its WIB midnight
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ""));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - WIB_MS : NaN;
}
export function daysBetweenDates(a, b) { // calendar days a -> b (WIB date keys)
  return Math.round((dateKeyToMs(b) - dateKeyToMs(a)) / DAY);
}
const toMs = (t) => { const v = typeof t === "number" ? t : Date.parse(t); return Number.isFinite(v) ? v : NaN; };

// ---------- loading ----------
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
export function loadStatusFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names.filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    const data = readJson(path.join(dir, n));
    if (!data || typeof data !== "object") continue;
    const at = toMs(data.generated_at);
    out.push({ date: n.slice(0, 10), at: Number.isFinite(at) ? at : dateKeyToMs(n.slice(0, 10)), data });
  }
  return out.sort((a, b) => a.at - b.at);
}
export function loadPerformance(file) {
  const d = readJson(file);
  if (Array.isArray(d)) return d;
  if (d && typeof d === "object") for (const v of Object.values(d)) if (Array.isArray(v)) return v;
  return [];
}

// ---------- counts ----------
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const entryOf = (file, id) => (file?.data?.experiments || []).find((e) => e && e.id === id) || null;

// per-id extractor of the experiment's "n" from a grader entry
export const EXTRACTORS = {
  "max-hold": (e) => num(e?.metrics?.row_at_cap?.n) ?? num(e?.sample?.n_tagged),
  "trail-straddle-trigger": (e) => num(e?.metrics?.straddled_trailing_closes) ?? num(e?.sample?.n_tagged),
  "grace-profit-lock": (e) => num(e?.metrics?.fires?.n) ?? num(e?.sample?.n_tagged),
};

export function backstopCounts(records, asOfMs = Infinity) {
  const since = dateKeyToMs(BACKSTOP_SINCE);
  let n = 0, fires = 0;
  for (const r of records || []) {
    const t = toMs(r?.recorded_at);
    if (!r?.grace_stop_paused || !Number.isFinite(t) || t < since || t > asOfMs) continue;
    n++;
    const w = num(r.grace_stop_paused.worst_pnl_pct);
    if (w !== null && w <= -20) fires++;
  }
  return { n, fires };
}

function countAt(id, file, records, asOfMs, extractors = EXTRACTORS) {
  if (id === "grace-backstop-stop") return backstopCounts(records, asOfMs).n;
  const fn = extractors[id];
  return fn ? fn(entryOf(file, id)) : null;
}

// ---------- rows ----------
// `extractors` (optional) replaces EXTRACTORS, e.g. to give the publisher a count for reading-guard.
// Each row also carries numeric `per_week` (null unless progressing) and the `flags` array that
// `status` joins.
export function buildRows({ schedule, decisions, files, records, now, replayRuns, extractors = EXTRACTORS }) {
  const sched = schedule?.experiments || {};
  const done = decisions || {};
  const newest = files[files.length - 1] || null;
  const today = wibDate(now);
  const rows = [];
  for (const [id, s] of Object.entries(sched)) {
    if (Object.prototype.hasOwnProperty.call(done, id)) continue;
    const entry = newest ? entryOf(newest, id) : null;
    const target = num(s?.need?.target);
    const isBackstop = id === "grace-backstop-stop";
    const hasExtractor = isBackstop || !!extractors[id];

    let n = null, fires = null;
    if (hasExtractor) {
      if (isBackstop) { const c = backstopCounts(records); n = c.n; fires = c.fires; }
      else n = newest ? countAt(id, newest, records, Infinity, extractors) : null;
    }

    // history baseline for the 7 d delta and the pace
    let delta7 = null, baseLabel = null, paceSpanDays = null, paceDelta = null;
    if (n !== null) {
      if (isBackstop) {
        const base = backstopCounts(records, now - 7 * DAY).n;
        delta7 = n - base; baseLabel = "7 d";
        const spanDays = Math.max(0, (now - dateKeyToMs(BACKSTOP_SINCE)) / DAY);
        paceSpanDays = spanDays; paceDelta = n;
      } else {
        const withCount = files.map((f) => ({ f, c: countAt(id, f, records, Infinity, extractors) })).filter((x) => x.c !== null);
        if (withCount.length) {
          const last = withCount[withCount.length - 1];
          const old = withCount.filter((x) => last.f.at - x.f.at >= 7 * DAY);
          const base = old.length ? old[old.length - 1] : withCount[0];
          const ageDays = (last.f.at - base.f.at) / DAY;
          if (base !== last) {
            delta7 = last.c - base.c;
            baseLabel = old.length ? "7 d" : `${Math.round(ageDays * 10) / 10} d of history`;
            const first = withCount[0];
            paceSpanDays = (last.f.at - first.f.at) / DAY; paceDelta = last.c - first.c; // pace over the whole history
          } else { delta7 = 0; baseLabel = "no history"; }
        }
      }
    }

    // pace / ETA
    let pace = "n/a", etaMs = null, perWeekNum = null;
    if (n !== null && target !== null) {
      if (n >= target) pace = "reached";
      else if (paceDelta !== null && paceSpanDays >= 1 && paceDelta > 0) {
        const perWeek = (paceDelta / paceSpanDays) * 7;
        perWeekNum = Math.round(perWeek * 10) / 10;
        etaMs = now + ((target - n) / (paceDelta / paceSpanDays)) * DAY;
        pace = `${Math.round(perWeek * 10) / 10}/wk -> ${wibDate(etaMs)}`;
      } else pace = "no progress";
    }

    // next decision
    const cands = [];
    if (etaMs !== null) cands.push({ date: wibDate(etaMs), label: "ETA" });
    if (s.time_arm) cands.push({ date: s.time_arm, label: "time arm" });
    if (s.report_by) cands.push({ date: s.report_by, label: "report by" });
    cands.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const next = cands[0] || null;

    // status
    const flags = [];
    const countMet = n !== null && target !== null && n >= target && (!isBackstop || fires >= 6);
    if (countMet) flags.push("DUE (count)");
    if (s.time_arm && today >= s.time_arm) flags.push("DUE (time arm)");
    if (s.report_by && today >= s.report_by) flags.push("DUE (report by)");

    let lastEvidenceMs = null, lastLabel = null;
    const gradedHere = entry && (s.by === "grader" || s.by === "report");
    if (gradedHere) { lastEvidenceMs = newest.at; lastLabel = "status file"; }
    else {
      const run = replayRuns && replayRuns[id] ? toMs(replayRuns[id]) : NaN;
      if (Number.isFinite(run)) { lastEvidenceMs = run; lastLabel = "last run"; }
    }
    const recheck = num(s.recheck_days);
    if (recheck !== null) {
      if (lastEvidenceMs === null) flags.push(gradedHere || s.by === "grader" ? "STALE (no grader entry)" : "STALE (never run)");
      else {
        const age = (now - lastEvidenceMs) / DAY;
        if (age > recheck) flags.push(`STALE (${lastLabel} ${Math.floor(age)} d old > ${recheck} d)`);
      }
    }
    let status = flags.join("; ");
    if (!status) status = etaMs !== null && (!next || next.label === "ETA" || next.date >= wibDate(etaMs)) ? "on track" : "waiting";

    rows.push({
      id, by: s.by || "—", mode: entry?.mode_value !== undefined && typeof entry.mode_value !== "boolean" && entry.mode === "shadow" ? String(entry.mode) : (entry?.mode ?? "—"),
      verdict: entry?.verdict ?? "—",
      n, fires, target, metric: s?.need?.metric ?? null, delta7, baseLabel, pace, per_week: perWeekNum, eta: etaMs !== null ? wibDate(etaMs) : null,
      time_arm: s.time_arm || null, report_by: s.report_by || null,
      next: next ? `${next.date} (${next.label})` : "—",
      next_date: next ? next.date : null,
      status, flags: [...flags], due: flags.some((f) => f.startsWith("DUE")), stale: flags.some((f) => f.startsWith("STALE")),
      on_met: s.on_met || null,
    });
  }
  return rows;
}

export function progressText(r) {
  if (r.n === null) return "n/a";
  const t = r.target !== null ? ` / ${r.target}` : "";
  if (r.id === "grace-backstop-stop") return `${r.n}${t}, fires ${r.fires} / 6`;
  return `${r.n}${t}`;
}
export function deltaText(r) {
  if (r.delta7 === null) return "n/a";
  const s = r.delta7 > 0 ? `+${r.delta7}` : String(r.delta7);
  return r.baseLabel && r.baseLabel !== "7 d" ? `${s} (${r.baseLabel})` : s;
}

// ---------- objective ----------
function stats(list) {
  const nets = list.map((r) => num(r.pnl_sol_net) ?? num(r.pnl_sol) ?? 0);
  const n = list.length;
  const sum = nets.reduce((a, b) => a + b, 0);
  const wins = nets.filter((x) => x > 0).length;
  const dis = list.filter((r) => { const p = num(r.pnl_pct); return p !== null && p <= -10; }).length;
  return { closes: n, net_sol: Math.round(sum * 1e6) / 1e6, win_rate: n ? wins / n : null, disaster_share: n ? dis / n : null };
}
export function objective(records, now) {
  const out = {};
  const isBot = (r) => !r.adopted && !r.rebalance_leg;
  const isOp = (r) => !!r.adopted;
  const trail = (r) => r.exit_family === "trailing_tp";
  for (const days of [7, 30]) {
    const from = now - days * DAY;
    const win = records.filter((r) => { const t = toMs(r?.recorded_at); return Number.isFinite(t) && t >= from && t <= now; });
    out[`d${days}`] = {
      bot: stats(win.filter(isBot)),
      bot_trailing: stats(win.filter(isBot).filter(trail)),
      operator: stats(win.filter(isOp)),
    };
  }
  const newestOf = (list) => { let m = NaN; for (const r of list) { const t = toMs(r?.recorded_at); if (Number.isFinite(t) && !(t <= m)) m = t; } return Number.isFinite(m) ? m : null; };
  out.newest_bot_close = newestOf(records.filter(isBot));
  out.newest_record = newestOf(records);
  return out;
}

// ---------- assembly ----------
export function buildScoreboard({ files, schedule, decisions, records, now, replayRuns }) {
  const rows = buildRows({ schedule, decisions, files, records, now, replayRuns });
  const today = wibDate(now);
  const weekEnd = wibDate(now + 7 * DAY);
  const dueWeek = [];
  for (const r of rows) {
    const why = [];
    if (r.due) why.push(r.status);
    else if (r.stale) why.push(r.status);
    for (const [k, label] of [["time_arm", "time arm"], ["report_by", "report by"]]) {
      if (r[k] && r[k] > today && r[k] <= weekEnd) why.push(`${label} ${r[k]}`);
    }
    if (why.length) dueWeek.push({ id: r.id, why: why.join("; ") });
  }
  const finished = Object.entries(decisions || {}).map(([id, d]) => ({ id, decision: d?.decision ?? "—", at: d?.at ?? "—" }));
  const newest = files[files.length - 1] || null;
  return {
    generated_at: wibDateTime(now),
    newest_status: newest ? `${newest.date} (generated ${wibDateTime(newest.at)})` : null,
    status_files: files.length,
    records: records.length,
    rows, finished, objective: objective(records, now), due_this_week: dueWeek,
  };
}

const pct = (x) => (x === null ? "—" : `${Math.round(x * 1000) / 10} %`);
const sol = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(4)}`;
export function renderMarkdown(sb) {
  const L = [];
  L.push("# Experiment scoreboard", "");
  L.push(`Generated ${sb.generated_at} | newest status file: ${sb.newest_status || "none"} | status files: ${sb.status_files} | records in the export: ${sb.records}`, "");
  L.push("## Open experiments", "");
  L.push("| id | by | mode | verdict | progress | last 7 d | pace / ETA | next decision | status |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of sb.rows) L.push(`| ${r.id} | ${r.by} | ${r.mode} | ${r.verdict} | ${progressText(r)} | ${deltaText(r)} | ${r.pace} | ${r.next} | ${r.status} |`);
  if (!sb.rows.length) L.push("| (none) | | | | | | | | |");
  L.push("", "## Finished", "");
  if (!sb.finished.length) L.push("none");
  for (const f of sb.finished) L.push(`- ${f.id}: ${f.decision} (${f.at})`);
  L.push("", "## Objective (closes by recorded_at, net = pnl_sol_net)", "");
  L.push("| window | group | closes | net SOL | win rate | share <= -10 % |", "|---|---|---|---|---|---|");
  for (const w of ["d7", "d30"]) for (const [g, label] of [["bot", "bot"], ["bot_trailing", "bot trailing-TP"], ["operator", "operator"]]) {
    const s = sb.objective[w][g];
    L.push(`| ${w === "d7" ? "7 d" : "30 d"} | ${label} | ${s.closes} | ${sol(s.net_sol)} | ${pct(s.win_rate)} | ${pct(s.disaster_share)} |`);
  }
  L.push("", `Newest bot close: ${sb.objective.newest_bot_close ? wibDateTime(sb.objective.newest_bot_close) : "none"} | newest record: ${sb.objective.newest_record ? wibDateTime(sb.objective.newest_record) : "none"}`);
  L.push("", "## Due this week", "");
  if (!sb.due_this_week.length) L.push("nothing");
  for (const d of sb.due_this_week) L.push(`- ${d.id}: ${d.why}`);
  L.push("");
  return L.join("\n");
}

// ---------- CLI ----------
function parseArgs(argv) {
  const a = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--json") a.json = true;
    else if (k.startsWith("--")) a[k.slice(2)] = argv[++i];
  }
  return a;
}
function main() {
  const a = parseArgs(process.argv.slice(2));
  const statusDir = a["status-dir"] || ".experiments/status";
  const now = a.now ? toMs(a.now) : Date.now();
  if (!Number.isFinite(now)) { console.error("bad --now"); process.exit(2); }
  const files = loadStatusFiles(statusDir);
  const schedule = readJson(a.schedule || "scripts/experiments/schedule.json") || { experiments: {} };
  const decisions = readJson(a.decisions || "scripts/experiments/decisions.json") || {};
  const records = loadPerformance(a.performance || path.join(statusDir, "performance.json"));
  const replayRuns = readJson(path.join(statusDir, "replay-runs.json")) || {};
  const sb = buildScoreboard({ files, schedule, decisions, records, now, replayRuns });
  const md = renderMarkdown(sb);
  const outFile = a.out || ".experiments/SCOREBOARD.md";
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, md); } catch (e) { console.error(`could not write ${outFile}: ${e.message}`); }
  process.stdout.write(a.json ? JSON.stringify(sb, null, 2) + "\n" : md);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
