#!/usr/bin/env node
/**
 * scripts/replay/drop_guard_study.js — OFFLINE, read-only event study that decides the registered
 * hypothesis docs/experiments/unchanged-bin-drop-guard.md (a SOL-basis PnL drop of ≥ X pp and
 * < 15 pp between two consecutive distinct valuations while the active bin did not fall).
 *
 * Inputs (local files only — no .env, no DB, no network):
 *   --ticks    poller tick export (scripts/replay/drop_guard_export_ticks.sql), CSV or gzip CSV:
 *              position_address,t,active_bin,pnl_pct   (t in epoch ms; epoch s is accepted too)
 *   --records  JSON array of perf records (scripts/experiments/export.sh → performance.json)
 *   --context  JSON from scripts/replay/drop_guard_export_context.sql ({ positions, events })
 *
 *   node scripts/replay/drop_guard_study.js --ticks ticks.csv.gz \
 *     --records .experiments/status/performance.json --context context.json [--json out.json] \
 *     [--from 2026-10-05T00:00:00Z] [--to ISO]
 *
 * The rule is pre-registered; do not tune it here. Literal-reading choices are listed in
 * INTERPRETATION and printed with the report.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FROM = "2026-10-05T00:00:00Z";
export const CAP_PP = 15;                 // the live guard (pnlJumpSuspectPp) covers ≥ 15
export const MIN_PNL = -99.9;             // rows with pnl ≤ −99.9 are dropped
export const EXCLUSION_WINDOW_MS = 120_000;
export const OUTCOME_WINDOW_MS = 120_000;
export const REVERT_TOL_PP = 1;
export const CLOSE_WINDOW_MS = 90_000;
export const NEAR_MISS_MAX_MS = 300_000;
export const HOLD_MS = 60_000;
export const STOP_FURTHER_PP = 3;
export const CHECK1_MIN_N = 20;
export const CHECK2_MIN_SHARE = 0.8;
export const CHECK4_MIN_SOL = -0.05;
export const CHECK5_MAX = 1;
export const NON_MECHANICAL_FAMILIES = Object.freeze(["manual", "external", "rebalance_leg"]);
// post-stop-cooldown.js POST_STOP_FAMILIES — the codebase's named stop-class set
export const STOP_CLASS_FAMILIES = Object.freeze(["stop_loss", "rug", "crash", "probation_stop", "young_stop"]);
export const EXCLUSION_EVENT_KINDS = Object.freeze(["straddle", "rebalance_external", "capital_change_external"]);

export const PRIMARY = { id: "X3", X: 3, primary: true };
export const VARIANTS = [PRIMARY, { id: "X2", X: 2 }, { id: "X5", X: 5 }];

export const INTERPRETATION = [
  "Event = two consecutive rows of the cleaned series (poller rows, pnl ≤ −99.9 dropped, then consecutive identical (bin, pnl) rows merged) with pnl1 − pnl2 ≥ X and < 15 (rounded to 1e-6 pp) and bin2 ≥ bin1. No limit on the time between the two readings (the gap is reported).",
  "Exclusion: the event interval [t1, t2] lies within 120 s of a timestamp from position_events (straddle, rebalance_external, capital_change_external), positions.data (last_capital_rebase.at, straddled_at, rebalance_events[].at, last_rebalanced_at) or the perf record (rebalance_events[].at).",
  "Outcome is read on readings after the second reading with t ≤ t2 + 120 s: reverted = |pnl − pnl1| ≤ 1 at bin ≥ bin1; fell = bin < bin1 first; otherwise persisted (including a series that ends — position closed — before 120 s).",
  "Held = t2 inside a hold interval built from position_events hold → resume (or → close / end); a position still held at export with hold_set_at and no hold event is held from hold_set_at.",
  "Close on an event: the position's perf record, family not manual / external / rebalance_leg (llm and every other family count as mechanical), recorded_at in (t2, t2 + 90 s], and no reverting reading between t2 and recorded_at. The last-tick anchor (last tick − t2 ≤ 90 s) is reported beside it, outside the rule.",
  "Check 3 counts closes on events whose OUTCOME is reverted (outcome from ticks only). A close normally ends the tick series, so such an event can be reverted only if ticks continue after recorded_at.",
  "Check 4: non-held persisted + fell events with a known capital (record amount_sol, else positions.data.amount_sol); pnl60 = last row at or before t2 + 60 s; Σ (pnl60 − pnl2) / 100 × capital ≥ −◎0.05.",
  "Check 5: persisted + fell events followed by a stop-class close (stop_loss, rug, crash, probation_stop, young_stop) recorded in (t2, t2 + 60 s] whose booked pnl_pct ≤ pnl2 − 3; at most 1 passes. The minimum reading in that minute is reported beside it.",
  "Verdict: check 1 fails → insufficient; else met only if checks 2–5 all pass; else not_met.",
];

// ─── ticks ─────────────────────────────────────────────────────────────────

export function parseTicksCsv(text) {
  const byPos = new Map();
  const stats = { rows: 0, bad_rows: 0, empty_pnl: 0 };
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, "");
    start = end + 1;
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 4) { stats.bad_rows++; continue; }
    let t = Number(parts[1]);
    const a = Number(parts[2]);
    if (!Number.isFinite(t) || parts[2] === "" || !Number.isInteger(a)) { stats.bad_rows++; continue; }
    if (t < 1e11) t *= 1000; // epoch seconds → ms
    const pnl = parts[3] === "" ? null : Number(parts[3]);
    if (pnl == null || !Number.isFinite(pnl)) { stats.empty_pnl++; continue; }
    stats.rows++;
    let arr = byPos.get(parts[0]);
    if (!arr) { arr = []; byPos.set(parts[0], arr); }
    arr.push({ t, a, pnl });
  }
  for (const arr of byPos.values()) arr.sort((x, y) => x.t - y.t);
  stats.positions = byPos.size;
  return { byPos, stats };
}

export function readTicksFile(p) {
  const buf = fs.readFileSync(p);
  const text = (p.endsWith(".gz") || (buf[0] === 0x1f && buf[1] === 0x8b)) ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return parseTicksCsv(text);
}

/** Drop pnl ≤ −99.9 rows, then merge consecutive identical (bin, pnl) rows. */
export function cleanSeries(rows, { fromMs = -Infinity, toMs = Infinity } = {}) {
  const out = [];
  let droppedFloor = 0, merged = 0;
  for (const r of rows) {
    if (r.t < fromMs || r.t > toMs) continue;
    if (!(r.pnl > MIN_PNL)) { droppedFloor++; continue; }
    const prev = out[out.length - 1];
    if (prev && prev.a === r.a && prev.pnl === r.pnl) { merged++; continue; }
    out.push(r);
  }
  return { series: out, droppedFloor, merged };
}

// ─── events ────────────────────────────────────────────────────────────────

const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** All drops of ≥ X and < cap pp between consecutive rows at a bin ≥ the previous one. */
export function detectEvents(series, X, cap = CAP_PP) {
  const ev = [];
  for (let k = 1; k < series.length; k++) {
    const p = series[k - 1], c = series[k];
    const drop = r6(p.pnl - c.pnl);
    if (drop >= X && drop < cap && c.a >= p.a) {
      ev.push({ i1: k - 1, i2: k, t1: p.t, t2: c.t, pnl1: p.pnl, pnl2: c.pnl, bin1: p.a, bin2: c.a, drop, gap_s: (c.t - p.t) / 1000 });
    }
  }
  return ev;
}

/** Outcome over readings after the second one with t ≤ t2 + window. */
export function classifyOutcome(series, ev, { windowMs = OUTCOME_WINDOW_MS, tol = REVERT_TOL_PP } = {}) {
  let lastSeenT = ev.t2;
  for (let j = ev.i2 + 1; j < series.length; j++) {
    const r = series[j];
    if (r.t > ev.t2 + windowMs) return { outcome: "persisted", series_ended: false };
    lastSeenT = r.t;
    if (r.a >= ev.bin1 && Math.abs(r6(r.pnl - ev.pnl1)) <= tol) return { outcome: "reverted", at: r.t, revert_s: (r.t - ev.t2) / 1000, reading: r };
    if (r.a < ev.bin1) return { outcome: "fell", at: r.t, fell_s: (r.t - ev.t2) / 1000, reading: r };
  }
  return { outcome: "persisted", series_ended: true, last_t: lastSeenT };
}

/** Index of the first reverting reading after i2 and before (or at) untilMs, else -1. */
export function firstRevertBefore(series, ev, untilMs, tol = REVERT_TOL_PP) {
  for (let j = ev.i2 + 1; j < series.length && series[j].t <= untilMs; j++) {
    const r = series[j];
    if (r.a >= ev.bin1 && Math.abs(r6(r.pnl - ev.pnl1)) <= tol) return j;
  }
  return -1;
}

/** Last reading at or before tMs (the series is deduplicated). */
export function readingAt(series, tMs) {
  let lo = 0, hi = series.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (series[m].t <= tMs) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? series[ans] : null;
}

export function minReadingIn(series, fromMs, toMs) {
  let m = null;
  for (const r of series) if (r.t > fromMs && r.t <= toMs) m = m == null ? r.pnl : Math.min(m, r.pnl);
  return m;
}

/** Does [t1, t2] lie within windowMs of any of the timestamps (ms)? Returns the nearest one or null. */
export function exclusionHit(ev, stamps, windowMs = EXCLUSION_WINDOW_MS) {
  let best = null;
  for (const s of stamps) {
    const d = s.t < ev.t1 ? ev.t1 - s.t : s.t > ev.t2 ? s.t - ev.t2 : 0;
    if (d <= windowMs && (best == null || d < best.d)) best = { ...s, d };
  }
  return best;
}

export function isHeldAt(intervals, tMs) {
  return intervals.some(([a, b]) => tMs >= a && tMs <= b);
}

/** Hold intervals from hold / resume events (sorted), open hold → endMs. */
export function holdIntervals(events, { endMs = Infinity, holdSetAt = null, holdMode = false } = {}) {
  const ev = events.filter((e) => e.kind === "hold" || e.kind === "resume").slice().sort((a, b) => a.t - b.t);
  const out = [];
  let open = null;
  for (const e of ev) {
    if (e.kind === "hold") { if (open == null) open = e.t; }
    else if (open != null) { out.push([open, e.t]); open = null; }
  }
  if (open != null) out.push([open, endMs]);
  const hs = holdSetAt != null ? Date.parse(holdSetAt) : NaN;
  if (holdMode === true && Number.isFinite(hs) && !out.some(([a, b]) => hs >= a - 5000 && hs <= b)) out.push([hs, endMs]);
  return out;
}

export function familyOf(rec) {
  if (!rec) return null;
  if (rec.rebalance_leg) return "rebalance_leg";
  return rec.exit_family || "other";
}

export function isMechanical(rec) {
  const f = familyOf(rec);
  return f != null && !NON_MECHANICAL_FAMILIES.includes(f);
}

/** Close attribution for one event. rec = the position's perf record (or null), lastTickT = last tick of the position. */
export function attributeClose(series, ev, rec, lastTickT) {
  const out = { close_on_event: false, close_after_s: null, near_miss: false, last_tick_close: false };
  if (!rec || !isMechanical(rec)) return out;
  const ct = Date.parse(rec.recorded_at);
  if (!Number.isFinite(ct)) return out;
  const dt = ct - ev.t2;
  out.close_after_s = dt / 1000;
  const noReturn = firstRevertBefore(series, ev, ct) < 0;
  if (dt > 0 && dt <= CLOSE_WINDOW_MS && noReturn) out.close_on_event = true;
  else if (dt > CLOSE_WINDOW_MS && dt <= NEAR_MISS_MAX_MS && noReturn) out.near_miss = true;
  if (lastTickT != null && lastTickT - ev.t2 >= 0 && lastTickT - ev.t2 <= CLOSE_WINDOW_MS && dt > 0 && noReturn) out.last_tick_close = true;
  return out;
}

// ─── checks + verdict ──────────────────────────────────────────────────────

export function evaluateChecks(events) {
  const kept = events.filter((e) => !e.excluded);
  const notFell = kept.filter((e) => e.outcome !== "fell");
  const reverted = kept.filter((e) => e.outcome === "reverted");
  const c1 = { id: 1, value: kept.length, pass: kept.length >= CHECK1_MIN_N, text: `n events ≥ ${CHECK1_MIN_N}` };
  const share = notFell.length ? reverted.length / notFell.length : null;
  const c2 = { id: 2, value: share, reverted: reverted.length, not_fell: notFell.length, pass: share != null && share >= CHECK2_MIN_SHARE, text: "reverted ≥ 80 % of not-fell" };
  const closesOnReverted = kept.filter((e) => !e.held && e.outcome === "reverted" && e.close_on_event);
  const c3 = { id: 3, value: closesOnReverted.length, pass: closesOnReverted.length >= 1, text: "≥ 1 mechanical close fired on a reverted event" };
  const costPool = kept.filter((e) => !e.held && (e.outcome === "persisted" || e.outcome === "fell"));
  let sum = 0, nCap = 0, nNoCap = 0;
  for (const e of costPool) {
    if (e.capital_sol > 0 && e.pnl60 != null) { sum += (e.pnl60 - e.pnl2) / 100 * e.capital_sol; nCap++; } else nNoCap++;
  }
  const c4 = { id: 4, value: sum, n: nCap, n_no_capital: nNoCap, pass: sum >= CHECK4_MIN_SOL, text: "Σ (pnl60 − pnl2)/100 × capital ≥ −◎0.05 (non-held persisted + fell)" };
  const stopDumps = kept.filter((e) => (e.outcome === "persisted" || e.outcome === "fell") && e.stop_close_60 && e.stop_close_60.further_pp <= -STOP_FURTHER_PP);
  const c5 = { id: 5, value: stopDumps.length, pass: stopDumps.length <= CHECK5_MAX, text: "≤ 1 persisted/fell event followed within 60 s by a stop-class close ≥ 3 pp further down" };
  const checks = [c1, c2, c3, c4, c5];
  const verdict = !c1.pass ? "insufficient" : checks.slice(1).every((c) => c.pass) ? "met" : "not_met";
  return { checks, verdict };
}

// ─── whole study ───────────────────────────────────────────────────────────

const ms = (x) => { const v = x == null ? NaN : Date.parse(x); return Number.isFinite(v) ? v : null; };

export function buildContext(records, context) {
  const recByPos = new Map();
  for (const r of records || []) if (r && r.position) {
    const prev = recByPos.get(r.position);
    if (!prev || String(r.recorded_at) > String(prev.recorded_at)) recByPos.set(r.position, r);
  }
  const posByAddr = new Map((context?.positions || []).map((p) => [p.position, p]));
  const evByPos = new Map();
  for (const e of context?.events || []) {
    const t = ms(e.at);
    if (t == null || !e.position) continue;
    if (!evByPos.has(e.position)) evByPos.set(e.position, []);
    evByPos.get(e.position).push({ ...e, t });
  }
  return { recByPos, posByAddr, evByPos };
}

export function exclusionStamps(addr, ctx) {
  const st = [];
  for (const e of ctx.evByPos.get(addr) || []) if (EXCLUSION_EVENT_KINDS.includes(e.kind)) st.push({ t: e.t, src: `event:${e.kind}` });
  const p = ctx.posByAddr.get(addr);
  const push = (v, src) => { const t = ms(v); if (t != null) st.push({ t, src }); };
  if (p) {
    push(p.last_capital_rebase?.at, "last_capital_rebase");
    push(p.straddled_at, "straddled_at");
    for (const x of p.rebalance_event_times || []) push(x, "rebalance_events");
    push(p.last_rebalanced_at, "last_rebalanced_at");
  }
  const r = ctx.recByPos.get(addr);
  if (r) {
    for (const x of Array.isArray(r.rebalance_events) ? r.rebalance_events : []) push(x?.at, "record.rebalance_events");
    push(r.last_capital_rebase?.at, "record.last_capital_rebase");
  }
  return st;
}

export function runStudy(byPos, records, context, { from = DEFAULT_FROM, to = null, variants = VARIANTS } = {}) {
  const fromMs = Date.parse(from), toMs = to ? Date.parse(to) : Infinity;
  const ctx = buildContext(records, context);
  const coverage = { positions: 0, rows: 0, dropped_floor_rows: 0, merged_rows: 0, bot: 0, operator: 0, owner_unknown: 0, ever_held_in_window: 0, with_record: 0, without_record: 0, first_t: null, last_t: null };
  const prepared = [];
  for (const [addr, rows] of byPos) {
    const { series, droppedFloor, merged } = cleanSeries(rows, { fromMs, toMs });
    coverage.dropped_floor_rows += droppedFloor; coverage.merged_rows += merged;
    if (!series.length) continue;
    const rec = ctx.recByPos.get(addr) || null;
    const pos = ctx.posByAddr.get(addr) || null;
    const adopted = rec ? !!rec.adopted : pos ? !!pos.adopted : null;
    const endMs = (rec && ms(rec.recorded_at)) ?? (pos && ms(pos.closed_at)) ?? Infinity;
    const holds = holdIntervals(ctx.evByPos.get(addr) || [], { endMs, holdSetAt: pos?.hold_set_at, holdMode: pos?.hold_mode === true });
    const capital = Number(rec?.amount_sol ?? pos?.amount_sol);
    coverage.positions++; coverage.rows += series.length;
    if (adopted === true) coverage.operator++; else if (adopted === false) coverage.bot++; else coverage.owner_unknown++;
    if (holds.some(([a, b]) => b >= series[0].t && a <= series[series.length - 1].t)) coverage.ever_held_in_window++;
    if (rec) coverage.with_record++; else coverage.without_record++;
    coverage.first_t = coverage.first_t == null ? series[0].t : Math.min(coverage.first_t, series[0].t);
    coverage.last_t = coverage.last_t == null ? series[series.length - 1].t : Math.max(coverage.last_t, series[series.length - 1].t);
    prepared.push({ addr, series, rec, pos, adopted, holds, capital: Number.isFinite(capital) ? capital : null, stamps: exclusionStamps(addr, ctx), events: ctx.evByPos.get(addr) || [] });
  }

  const out = { coverage, variants: {} };
  for (const v of variants) {
    const all = [];
    for (const P of prepared) {
      const lastT = P.series[P.series.length - 1].t;
      const adoptT = P.events.find((e) => e.kind === "adopt")?.t ?? ms(P.pos?.adopted_at);
      const firstT = P.series[0].t;
      for (const e of detectEvents(P.series, v.X)) {
        const hit = exclusionHit(e, P.stamps);
        const oc = classifyOutcome(P.series, e);
        const r60 = readingAt(P.series, e.t2 + HOLD_MS);
        const ac = attributeClose(P.series, e, P.rec, lastT);
        const fam = familyOf(P.rec);
        const ct = P.rec ? ms(P.rec.recorded_at) : null;
        let stop60 = null;
        if (P.rec && STOP_CLASS_FAMILIES.includes(fam) && ct != null && ct > e.t2 && ct - e.t2 <= HOLD_MS) {
          stop60 = { family: fam, booked_pnl_pct: P.rec.pnl_pct, further_pp: r6(Number(P.rec.pnl_pct) - e.pnl2), min_reading_in_minute: minReadingIn(P.series, e.t2, e.t2 + HOLD_MS) };
        }
        // nearest prior/next context events (for clustering), none of them part of the rule
        const prior = (kinds) => { let b = null; for (const x of P.events) if (kinds.includes(x.kind) && x.t <= e.t2 && (b == null || x.t > b.t)) b = x; return b ? (e.t2 - b.t) / 1000 : null; };
        all.push({
          position: P.addr, pair: P.rec?.pool_name || P.pos?.pair || null, owner: P.adopted === true ? "operator" : P.adopted === false ? "bot" : "unknown",
          held: isHeldAt(P.holds, e.t2), capital_sol: P.capital,
          ...e, i1: undefined, i2: undefined,
          excluded: !!hit, exclusion: hit ? { src: hit.src, d_s: hit.d / 1000 } : null,
          outcome: oc.outcome, revert_s: oc.revert_s ?? null, fell_s: oc.fell_s ?? null, series_ended: !!oc.series_ended,
          after: oc.reading ? { t: oc.reading.t, a: oc.reading.a, pnl: oc.reading.pnl } : null,
          pnl60: r60 ? r60.pnl : null, bin60: r60 ? r60.a : null,
          family: fam, close_reason: P.rec ? String(P.rec.close_reason || "").slice(0, 160) : null, booked_pnl_pct: P.rec?.pnl_pct ?? null, recorded_at: P.rec?.recorded_at ?? null,
          ...ac, stop_close_60: stop60,
          age_s: (e.t2 - firstT) / 1000, since_adopt_s: adoptT != null ? (e.t2 - adoptT) / 1000 : null,
          since_rebalance_s: prior(["rebalance_external"]), since_straddle_s: prior(["straddle"]), since_capital_s: prior(["capital_change_external"]),
          last_tick_gap_s: (lastT - e.t2) / 1000,
          context_before: P.series.slice(Math.max(0, e.i1 - 2), e.i1 + 1).map((r) => [r.t, r.a, r.pnl]),
          context_after: P.series.slice(e.i2, e.i2 + 6).map((r) => [r.t, r.a, r.pnl]),
        });
      }
    }
    const ev = all.map((x) => { const { i1, i2, ...rest } = x; return rest; });
    out.variants[v.id] = { variant: v, events: ev, ...evaluateChecks(ev), summary: summarize(ev) };
  }
  out.primary = PRIMARY.id;
  out.verdict = out.variants[PRIMARY.id].verdict;
  return out;
}

export function quantile(xs, q) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

function count(xs, key) { const m = {}; for (const x of xs) { const k = key(x); m[k] = (m[k] || 0) + 1; } return m; }

export function summarize(ev) {
  const kept = ev.filter((e) => !e.excluded);
  const q = (xs) => ({ n: xs.filter(Number.isFinite).length, min: quantile(xs, 0), p25: quantile(xs, 0.25), median: quantile(xs, 0.5), p75: quantile(xs, 0.75), p90: quantile(xs, 0.9), max: quantile(xs, 1) });
  return {
    raw: ev.length, excluded: ev.length - kept.length, kept: kept.length,
    exclusion_sources: count(ev.filter((e) => e.excluded), (e) => e.exclusion.src),
    outcome_raw: count(ev, (e) => e.outcome), outcome: count(kept, (e) => e.outcome),
    by_owner_held: count(kept, (e) => `${e.owner}/${e.held ? "held" : "not_held"}/${e.outcome}`),
    drop_pp: q(kept.map((e) => e.drop)), gap_s: q(kept.map((e) => e.gap_s)),
    revert_s: q(kept.filter((e) => e.outcome === "reverted").map((e) => e.revert_s)),
    reverted_within_60s: kept.filter((e) => e.outcome === "reverted" && e.revert_s <= 60).length,
    persisted_series_ended: kept.filter((e) => e.outcome === "persisted" && e.series_ended).length,
    by_pair: count(kept, (e) => e.pair), positions: new Set(kept.map((e) => e.position)).size,
  };
}

// ─── report ────────────────────────────────────────────────────────────────

export function wib(tMs) { return tMs == null ? "-" : new Date(tMs + 7 * 3600e3).toISOString().replace("T", " ").slice(0, 19) + " WIB"; }
const f2 = (x) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(2));

export function formatReport(rep) {
  const L = [];
  const c = rep.coverage;
  L.push(`Drop-guard event study (docs/experiments/unchanged-bin-drop-guard.md)`);
  L.push(`coverage: ${c.positions} positions, ${c.rows} distinct valuations, ${wib(c.first_t)} … ${wib(c.last_t)}; bot ${c.bot} / operator ${c.operator} / unknown ${c.owner_unknown}; held at some point ${c.ever_held_in_window}; with perf record ${c.with_record}, without ${c.without_record}; rows dropped at ≤ −99.9: ${c.dropped_floor_rows}`);
  for (const [id, V] of Object.entries(rep.variants)) {
    const S = V.summary;
    L.push(``);
    L.push(`── ${id} (X = ${V.variant.X} pp)${V.variant.primary ? " PRIMARY" : ""}: raw ${S.raw}, excluded ${S.excluded}, kept ${S.kept} (${S.positions} positions)`);
    L.push(`  exclusions by source: ${JSON.stringify(S.exclusion_sources)}`);
    L.push(`  outcome raw: ${JSON.stringify(S.outcome_raw)}  kept: ${JSON.stringify(S.outcome)}  (persisted because the series ended: ${S.persisted_series_ended})`);
    L.push(`  by owner/held: ${JSON.stringify(S.by_owner_held)}`);
    L.push(`  drop pp: ${JSON.stringify(S.drop_pp)}`);
    L.push(`  gap s:   ${JSON.stringify(S.gap_s)}`);
    L.push(`  revert s: ${JSON.stringify(S.revert_s)}; reverted within 60 s: ${S.reverted_within_60s}`);
    for (const k of V.checks) L.push(`  check ${k.id} ${k.pass ? "PASS" : "FAIL"}: ${k.text} — ${typeof k.value === "number" ? (k.id === 2 ? (k.value * 100).toFixed(1) + " %" : k.id === 4 ? "◎" + k.value.toFixed(4) : k.value) : k.value}${k.id === 2 ? ` (${k.reverted}/${k.not_fell})` : ""}${k.id === 4 ? ` over ${k.n} events (${k.n_no_capital} without capital)` : ""}`);
    L.push(`  verdict: ${V.verdict}`);
    const kept = V.events.filter((e) => !e.excluded);
    const closes = kept.filter((e) => e.close_on_event || e.near_miss || e.last_tick_close);
    if (closes.length) {
      L.push(`  closes on / near events (rule: close_on_event; the rest outside the rule):`);
      for (const e of closes) L.push(`    ${e.close_on_event ? "ON  " : e.near_miss ? "NEAR" : "TICK"} ${e.pair} ${e.position.slice(0, 8)} ${e.held ? "held " : ""}${wib(e.t2)} ${f2(e.pnl1)}→${f2(e.pnl2)} bin ${e.bin1}→${e.bin2} outcome ${e.outcome}; ${e.family} +${e.close_after_s}s booked ${f2(e.booked_pnl_pct)} — ${e.close_reason}`);
    }
  }
  L.push(``);
  L.push(`verdict (primary ${rep.primary}): ${rep.verdict}`);
  L.push(``);
  L.push(`interpretation choices:`);
  for (const s of INTERPRETATION) L.push(`  - ${s}`);
  return L.join("\n") + "\n";
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const ticksPath = opt("--ticks", null), recordsPath = opt("--records", null), contextPath = opt("--context", null);
  if (!ticksPath || !recordsPath || !contextPath) {
    console.error("usage: node scripts/replay/drop_guard_study.js --ticks <ticks.csv[.gz]> --records <performance.json> --context <context.json> [--json out.json] [--from ISO] [--to ISO]");
    process.exit(2);
  }
  const records = JSON.parse(fs.readFileSync(recordsPath, "utf8"));
  if (!Array.isArray(records)) throw new Error("--records must be a JSON array");
  const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
  const { byPos, stats } = readTicksFile(ticksPath);
  const rep = runStudy(byPos, records, context, { from: opt("--from", DEFAULT_FROM), to: opt("--to", null) });
  rep.inputs = { ticks: path.resolve(ticksPath), records: path.resolve(recordsPath), context: path.resolve(contextPath), tick_stats: stats, context_exported_at: context.exported_at ?? null };
  process.stdout.write(formatReport(rep) + `\n(tick file: ${stats.rows} rows, ${stats.positions} positions, ${stats.empty_pnl} without pnl, ${stats.bad_rows} unreadable)\n`);
  const jsonOut = opt("--json", null);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rep, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
