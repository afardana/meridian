#!/usr/bin/env node
/**
 * scripts/replay/grace_lock_replay.js — OFFLINE, read-only replay that decides the registered
 * hypothesis docs/experiments/grace-profit-lock.md (a wide trailing lock inside the profit grace,
 * armed once the confirmed in-grace peak reaches +A %, firing D pp under that peak).
 *
 * Inputs (local files only — no .env, no DB, no network):
 *   --records  JSON array of perf records (scripts/experiments/export.sh → performance.json)
 *   --ticks    RAW poller ticks (scripts/replay/grace_lock_export_ticks.sql), CSV or gzip CSV:
 *              position_address,t_ms,active_bin,pnl_pct
 *   --windows  grace-window inputs per position (built once with --build-windows from the two
 *              VM exports scripts/replay/grace_lock_export_rows.sql + _events.sql)
 *
 *   node scripts/replay/grace_lock_replay.js --build-windows --rows rows.csv --events events.csv --out windows.json
 *   node scripts/replay/grace_lock_replay.js --records performance.json --ticks ticks.csv.gz \
 *     --windows windows.json [--json out.json] [--from 2026-09-26T00:00:00Z] [--to ISO]
 *
 * The rule is pre-registered; nothing here is tuned. Interpretation choices are listed in
 * INTERPRETATION below and printed with every report.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FROM = "2026-09-26T00:00:00Z";
export const ADOPTION_GRACE_MIN = 60; // adoptedProfitGraceMinutes (prod default since 2026-09-25)
export const STRADDLE_GRACE_MIN = 60; // harvestStraddleGraceMinutes
export const MISSING_PRICE_PNL = -99.9; // a reading ≤ this is a missing-price row
export const JUMP_PP = 15; // pnlJumpSuspectPp — a reading this far from the previous kept one is dropped
export const MAX_GAP_MS = 3 * 60_000;
export const LATENCY_MS = 30_000;
export const TIE_SOL = 0.0005;
export const BOOT_RESAMPLES = 2000;
export const BOOT_SEED = 20261124;
export const SANITY_PP = 2;
export const SHADOW_MATCH_MS = 3 * 60_000; // grace_shadow.started_at ↔ adoption / straddle time

export const PRIMARY = { id: "A10_D5", A: 10, D: 5, mode: "drop", primary: true };
export const VARIANTS = [
  PRIMARY,
  { id: "A8_D5", A: 8, D: 5, mode: "drop" },
  { id: "A15_D5", A: 15, D: 5, mode: "drop" },
  { id: "A10_D3", A: 10, D: 3, mode: "drop" },
  { id: "A10_D7", A: 10, D: 7, mode: "drop" },
  { id: "A10_keep_half", A: 10, D: null, mode: "half" },
];

export const INTERPRETATION = [
  "Population window: perf record recorded_at ≥ 2026-09-26T00:00Z (UTC) up to the newest record in the export; rebalance legs dropped.",
  "A record has a profit grace when it is adopted (adoption grace) or straddle_count > 0 (one straddle grace per straddle).",
  "Owner: adopted → operator, else bot.",
  "Close time = the position row's closed_at, else recorded_at.",
  "Adoption grace = adopted_at → +60 min; straddle grace = straddle time → +60 min (row profit_grace_until for the last straddle when present). Every grace is cut at an operator release (grace_release event / profit_grace_released_at) inside it, at the next straddle, and at the close.",
  "Grace-window precedence: record grace_shadow (started_at / ended_at, matched to the adoption or a straddle within 3 min) > position row (adopted_at, straddled_at, profit_grace_until, profit_grace_released_at) > position_events (earlier straddles, releases) > adopted only: first 60 min of the tick path.",
  "HOLD: hold → resume/close intervals from position_events (row hold_set_at when no event); a grace overlapping any hold interval is excluded.",
  "Gap rule on RAW poller rows (any pnl, incl. missing-price rows), including grace start → first row and last row → grace end; > 3 min excludes the grace.",
  "Reading filters run over the WHOLE tick path of the position (so the first in-grace reading has a reference): pnl empty or ≤ −99.9 dropped; then |pnl − previous KEPT reading| > 15 pp dropped (no time-out).",
  "Distinct reading = (pnl_pct, active_bin) differs from the previous kept reading; repeats are ignored (neither confirm nor reset). No 30 s reconfirm (reported separately as a sensitivity).",
  "In-grace peak starts at the first kept in-grace reading (grace_shadow's reset) and counts as the confirmed peak from that reading; a new peak = two consecutive distinct readings above it, the lower of the two (state.confirmPeak; a distinct reading ≤ the peak drops a pending one).",
  "Armed while the confirmed peak ≥ A (an initial reading ≥ A arms at once). Fire = second consecutive distinct armed reading ≤ peak − D (keep-half: ≤ peak ÷ 2); a distinct reading above the threshold resets the streak. The threshold uses the confirmed peak at that reading.",
  "The lock exists only inside the grace: both breach readings must fall in [grace start, grace end] and before the close. After the grace the recorded path stands.",
  "Exit cost: record's realized exit-swap cost = exit_slippage_sol (SOL; 0 when absent). Lock exit cost = amount_sol × median(exit_slippage_sol / amount_sol) over trailing_tp records of the same owner in the whole export that carry exit_slippage_sol.",
  "Latency check: exit PnL = first KEPT reading at least 30 s after the fire (any reading, not necessarily distinct, inside or after the grace); when none exists before the close, the last kept reading before the close.",
  "Halves: fires sorted by close time, first floor(n/2) vs the rest. Check 3 drops the single largest (most positive) Δ. Check 5 with no negative Δ uses 0 for the worst truncation.",
  "Check 9 is evaluated per grace kind; the verdict is met only if checks 1–8 pass and at least one kind passes 9 (that kind is the one proposed).",
];

export const EXCLUSION_REASONS = ["no_window", "grace_after_close", "held_in_grace", "no_ticks", "tick_gap_over_3min", "no_in_grace_reading"];

// ─── io ────────────────────────────────────────────────────────────────────

export function parseCsv(txt) {
  const out = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) {
      if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); out.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f !== "" || row.length) { row.push(f); out.push(row); }
  return out;
}

const readMaybeGz = (p) => {
  const buf = fs.readFileSync(p);
  return (p.endsWith(".gz") ? zlib.gunzipSync(buf) : buf).toString("utf8");
};

/** Tick CSV → Map(position → [{t, a, pnl}] sorted by t). pnl null when empty. */
export function parseTicksCsv(txt) {
  const byPos = new Map();
  let rows = 0, bad = 0;
  let start = 0;
  while (start < txt.length) {
    let end = txt.indexOf("\n", start);
    if (end < 0) end = txt.length;
    const line = txt.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 4) { bad++; continue; }
    const t = Number(parts[1]), a = parts[2] === "" ? null : Number(parts[2]);
    const pnl = parts[3] === "" ? null : Number(parts[3]);
    if (!Number.isFinite(t)) { bad++; continue; }
    rows++;
    let arr = byPos.get(parts[0]);
    if (!arr) byPos.set(parts[0], (arr = []));
    arr.push({ t, a: Number.isFinite(a) ? a : null, pnl: Number.isFinite(pnl) ? pnl : null });
  }
  for (const arr of byPos.values()) arr.sort((x, y) => x.t - y.t);
  return { byPos, stats: { rows, bad, positions: byPos.size } };
}

const toMs = (v) => {
  if (v == null || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** rows.csv + events.csv (VM exports) → { [position]: window inputs }. */
export function buildWindowInputs(rowsCsv, eventsCsv) {
  const out = {};
  for (const r of parseCsv(rowsCsv)) {
    if (r.length < 3 || !r[0]) continue;
    let d = {};
    try { d = JSON.parse(r[2]); } catch { d = {}; }
    out[r[0]] = {
      closed_ms: Number(r[1]) || toMs(d.closed_at),
      adopted: d.adopted === true,
      adopted_at: toMs(d.adopted_at),
      straddled_at: toMs(d.straddled_at),
      straddle_count: Number(d.straddle_count) || 0,
      profit_grace_until: toMs(d.profit_grace_until),
      profit_grace_released_at: toMs(d.profit_grace_released_at),
      hold_mode: d.hold_mode === true,
      hold_set_at: toMs(d.hold_set_at),
      events: [],
    };
  }
  for (const e of parseCsv(eventsCsv)) {
    if (e.length < 3 || !e[0]) continue;
    const kind = e[1];
    if (!["adopt", "straddle", "hold", "resume", "grace_release", "close"].includes(kind)) continue;
    const x = (out[e[0]] ||= { closed_ms: null, adopted: false, adopted_at: null, straddled_at: null, straddle_count: 0, profit_grace_until: null, profit_grace_released_at: null, hold_mode: false, hold_set_at: null, events: [] });
    x.events.push({ kind, t: Number(e[2]) });
  }
  for (const x of Object.values(out)) x.events.sort((a, b) => a.t - b.t);
  return out;
}

// ─── grace windows ─────────────────────────────────────────────────────────

/** Hold intervals [{from, to}] from events (+ row fallback). */
export function holdIntervals(w, closeMs) {
  const iv = [];
  let open = null;
  for (const e of w?.events || []) {
    if (e.kind === "hold") { if (open == null) open = e.t; }
    else if ((e.kind === "resume" || e.kind === "close") && open != null) { iv.push({ from: open, to: e.t }); open = null; }
  }
  if (open != null) iv.push({ from: open, to: closeMs ?? Infinity });
  // no hold event at all but the row carries a hold stamp: held from then to the close
  if (!iv.length && w?.hold_set_at != null) iv.push({ from: w.hold_set_at, to: closeMs ?? Infinity });
  return iv;
}

/**
 * The graces of one record, in time order: [{kind, start, end, source, planned_end, ended_by}].
 * `ticks` only serves the adoption fallback (first 60 min of the tick path).
 */
export function graceWindowsFor(rec, w, closeMs, ticks = []) {
  const out = [];
  const events = w?.events || [];
  const releases = events.filter((e) => e.kind === "grace_release").map((e) => e.t);
  if (w?.profit_grace_released_at != null && !releases.some((t) => Math.abs(t - w.profit_grace_released_at) < 60_000)) releases.push(w.profit_grace_released_at);
  releases.sort((a, b) => a - b);

  // straddle starts: events, with the row's straddled_at replacing the last one
  let straddles = events.filter((e) => e.kind === "straddle").map((e) => ({ t: e.t, source: "events" }));
  if (w?.straddled_at != null) {
    if (straddles.length) {
      const last = straddles[straddles.length - 1];
      if (Math.abs(last.t - w.straddled_at) < 10 * 60_000) straddles[straddles.length - 1] = { t: w.straddled_at, source: "row" };
      else straddles.push({ t: w.straddled_at, source: "row" });
    } else straddles.push({ t: w.straddled_at, source: "row" });
  }
  straddles.sort((a, b) => a.t - b.t);
  const wantStraddles = Number(rec.straddle_count) || 0;

  const gs = rec.grace_shadow && rec.grace_shadow.started_at ? rec.grace_shadow : null;
  const gsStart = gs ? toMs(gs.started_at) : null;

  const cut = (g) => {
    const rel = releases.find((t) => t > g.start && t < g.end);
    if (rel != null) { g.end = rel; g.ended_by = "release"; }
    if (closeMs != null && closeMs < g.end) { g.end = closeMs; g.ended_by = "close"; }
    return g;
  };

  if (rec.adopted) {
    let start = w?.adopted_at ?? events.find((e) => e.kind === "adopt")?.t ?? null;
    let source = w?.adopted_at != null ? "row" : start != null ? "events" : null;
    let g = null;
    if (gs && gs.kind === "adoption" && gsStart != null && (start == null || Math.abs(gsStart - start) <= SHADOW_MATCH_MS)) {
      const end = gs.ended_by ? toMs(gs.ended_at) : gsStart + (Number(gs.planned_min) || ADOPTION_GRACE_MIN) * 60_000;
      g = { kind: "adoption", start: gsStart, end, planned_end: gsStart + (Number(gs.planned_min) || ADOPTION_GRACE_MIN) * 60_000, ended_by: gs.ended_by || (gs.open_at_close ? "close" : null), source: "record" };
    } else if (start != null) {
      g = { kind: "adoption", start, end: start + ADOPTION_GRACE_MIN * 60_000, planned_end: start + ADOPTION_GRACE_MIN * 60_000, ended_by: "timer", source };
    } else if (ticks.length) {
      g = { kind: "adoption", start: ticks[0].t, end: ticks[0].t + ADOPTION_GRACE_MIN * 60_000, planned_end: ticks[0].t + ADOPTION_GRACE_MIN * 60_000, ended_by: "timer", source: "tick_fallback" };
    }
    if (g) {
      const firstStr = straddles.find((s) => s.t > g.start);
      if (firstStr && firstStr.t < g.end) { g.end = firstStr.t; g.ended_by = "straddle"; }
      if (g.source !== "record") cut(g);
      else if (closeMs != null && closeMs < g.end) { g.end = closeMs; g.ended_by = "close"; }
      out.push(g);
    } else out.push({ kind: "adoption", start: null, end: null, source: null, missing: true });
  }

  if (wantStraddles > 0) {
    for (let i = 0; i < straddles.length; i++) {
      const s = straddles[i];
      let g;
      if (gs && gs.kind === "straddle" && gsStart != null && Math.abs(gsStart - s.t) <= SHADOW_MATCH_MS) {
        const planned = gsStart + (Number(gs.planned_min) || STRADDLE_GRACE_MIN) * 60_000;
        g = { kind: "straddle", start: gsStart, end: gs.ended_by ? toMs(gs.ended_at) : planned, planned_end: planned, ended_by: gs.ended_by || (gs.open_at_close ? "close" : null), source: "record" };
        if (closeMs != null && closeMs < g.end) { g.end = closeMs; g.ended_by = "close"; }
      } else {
        const isLast = i === straddles.length - 1;
        const planned = isLast && w?.profit_grace_until != null && w.profit_grace_until > s.t ? w.profit_grace_until : s.t + STRADDLE_GRACE_MIN * 60_000;
        g = { kind: "straddle", start: s.t, end: planned, planned_end: planned, ended_by: "timer", source: s.source };
        cut(g);
      }
      const next = straddles[i + 1];
      if (next && next.t < g.end) { g.end = next.t; g.ended_by = "straddle"; }
      out.push(g);
    }
    for (let k = straddles.length; k < wantStraddles; k++) out.push({ kind: "straddle", start: null, end: null, source: null, missing: true });
  }
  return out.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
}

// ─── readings ──────────────────────────────────────────────────────────────

/**
 * Whole-path reading filter. Returns kept readings [{t, a, pnl, distinct}] where `distinct`
 * marks a (pnl, bin) change vs the previous kept reading, plus drop counters.
 */
export function filterReadings(ticks, { jumpPp = JUMP_PP, missing = MISSING_PRICE_PNL, jumpRef = "kept", distinctKey = "pnl_bin" } = {}) {
  const kept = [];
  let droppedMissing = 0, droppedJump = 0, prev = null, prevRaw = null;
  for (const r of ticks) {
    if (r.pnl == null || !Number.isFinite(r.pnl) || r.pnl <= missing) { droppedMissing++; continue; }
    const ref = jumpRef === "raw" ? prevRaw : prev;
    prevRaw = r;
    if (ref && Math.abs(r.pnl - ref.pnl) > jumpPp) { droppedJump++; continue; }
    const distinct = !prev || prev.pnl !== r.pnl || (distinctKey === "pnl_bin" && prev.a !== r.a);
    const k = { t: r.t, a: r.a, pnl: r.pnl, distinct };
    kept.push(k);
    prev = k;
  }
  return { kept, droppedMissing, droppedJump };
}

/** Largest gap (ms) between raw rows inside [start, end], boundaries included. */
export function maxGapMs(ticks, start, end) {
  let last = start, gap = 0, n = 0;
  for (const r of ticks) {
    if (r.t < start) continue;
    if (r.t > end) break;
    gap = Math.max(gap, r.t - last);
    last = r.t;
    n++;
  }
  gap = Math.max(gap, end - last);
  return { gap, n };
}

/** Mark readings distinct again after `reconfirmMs` unchanged (sensitivity only). */
export function withReconfirm(kept, reconfirmMs = 30_000) {
  let lastFresh = null;
  return kept.map((r) => {
    let distinct = r.distinct;
    if (distinct) lastFresh = r.t;
    else if (lastFresh != null && r.t - lastFresh >= reconfirmMs) { distinct = true; lastFresh = r.t; }
    return { ...r, distinct };
  });
}

// ─── the lock ──────────────────────────────────────────────────────────────

/** One confirmPeak step on a distinct reading. Mutates and returns st {peak, pending, count}. */
export function confirmPeakStep(st, pnl, confirmTicks = 2) {
  if (pnl <= st.peak) { st.pending = null; st.count = 0; return st; }
  if (st.pending != null) { st.count += 1; st.pending = Math.min(st.pending, pnl); }
  else { st.pending = pnl; st.count = 1; }
  if (st.count >= confirmTicks) { st.peak = Math.max(st.peak, st.pending); st.pending = null; st.count = 0; }
  return st;
}

export function lockThreshold(peak, v) {
  return v.mode === "half" ? peak / 2 : peak - v.D;
}

/**
 * Run the lock over the in-grace readings (kept, time-ordered, already restricted to the grace
 * and to before the close). Returns { fired, fire_t, exit_pnl, peak_at_fire, max_confirmed_peak,
 * armed, first_pnl }.
 */
export function simulateLock(readings, v, { initialPeak = "first" } = {}) {
  if (!readings.length) return { fired: false, max_confirmed_peak: null, armed: false, first_pnl: null };
  // "first": the first in-grace reading is the starting peak (grace_shadow's reset).
  // "none" (sensitivity): no starting peak — the first peak needs two distinct readings too.
  const none = initialPeak === "none";
  const st = { peak: none ? -Infinity : readings[0].pnl, pending: null, count: 0 };
  let maxPeak = st.peak, armed = st.peak >= v.A, streak = 0;
  for (let i = none ? 0 : 1; i < readings.length; i++) {
    const r = readings[i];
    if (!r.distinct) continue;
    confirmPeakStep(st, r.pnl);
    if (st.peak > maxPeak) maxPeak = st.peak;
    if (st.peak >= v.A) armed = true;
    if (armed && Number.isFinite(st.peak) && r.pnl <= lockThreshold(st.peak, v)) {
      streak++;
      if (streak >= 2) return { fired: true, fire_t: r.t, exit_pnl: r.pnl, peak_at_fire: st.peak, threshold: lockThreshold(st.peak, v), max_confirmed_peak: maxPeak, armed, first_pnl: readings[0].pnl };
    } else streak = 0;
  }
  return { fired: false, max_confirmed_peak: maxPeak, armed, first_pnl: readings[0].pnl };
}

/** Peak trajectory to the end of the grace, ignoring any fire (for the ≥ 10 % census). */
export function maxConfirmedPeak(readings) {
  if (!readings.length) return null;
  const st = { peak: readings[0].pnl, pending: null, count: 0 };
  let m = st.peak;
  for (let i = 1; i < readings.length; i++) if (readings[i].distinct) { confirmPeakStep(st, readings[i].pnl); m = Math.max(m, st.peak); }
  return m;
}

/** Latency exit: first kept reading ≥ fire_t + 30 s before the close, else the last before it. */
export function latencyExit(kept, fireT, closeMs, latencyMs = LATENCY_MS) {
  let last = null;
  for (const r of kept) {
    if (closeMs != null && r.t > closeMs) break;
    if (r.t >= fireT + latencyMs) return { pnl: r.pnl, t: r.t, fallback: false };
    last = r;
  }
  return last ? { pnl: last.pnl, t: last.t, fallback: true } : null;
}

/** Δ◎ of one fire. */
export function deltaSol({ exitPnl, recPnl, amountSol, lockCostSol, ownCostSol }) {
  return ((exitPnl - recPnl) / 100) * amountSol - lockCostSol + ownCostSol;
}

// ─── costs ─────────────────────────────────────────────────────────────────

export const ownerOf = (rec) => (rec.adopted ? "operator" : "bot");
export const ownExitCost = (rec) => (Number.isFinite(Number(rec.exit_slippage_sol)) && rec.exit_slippage_sol != null ? Number(rec.exit_slippage_sol) : 0);

export function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median realized exit-swap cost as a share of capital, trailing_tp closes, per owner. */
export function lockCostShares(records) {
  const pick = (owner, zeroFill) => records
    .filter((r) => r.exit_family === "trailing_tp" && ownerOf(r) === owner && Number(r.amount_sol) > 0 && !r.rebalance_leg)
    .filter((r) => zeroFill || r.exit_slippage_sol != null)
    .map((r) => (r.exit_slippage_sol != null ? Number(r.exit_slippage_sol) : 0) / Number(r.amount_sol));
  const res = {};
  for (const o of ["operator", "bot"]) {
    const xs = pick(o, false), ys = pick(o, true);
    res[o] = { share: median(xs), n: xs.length, share_zero_filled: median(ys), n_zero_filled: ys.length };
  }
  return res;
}

// ─── stats + verdict ───────────────────────────────────────────────────────

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapSumCI(xs, resamples = BOOT_RESAMPLES, seed = BOOT_SEED) {
  if (!xs.length) return { lo: null, hi: null };
  const rnd = mulberry32(seed);
  const sums = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rnd() * xs.length)];
    sums[b] = s;
  }
  const sorted = Array.from(sums).sort((a, b) => a - b);
  return { lo: sorted[Math.floor(0.05 * resamples)], hi: sorted[Math.floor(0.95 * resamples)] };
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** fires: [{delta, delta_cost2, delta_latency, t_close, kind}] */
export function summarize(fires) {
  const f = [...fires].sort((a, b) => a.t_close - b.t_close);
  const d = f.map((x) => x.delta);
  const n = d.length;
  const largestIdx = n ? d.indexOf(Math.max(...d)) : -1;
  const h = Math.floor(n / 2);
  const better = d.filter((x) => x > TIE_SOL).length;
  const worse = d.filter((x) => x < -TIE_SOL).length;
  const minD = n ? Math.min(...d) : null;
  const byKind = {};
  for (const x of f) { const k = (byKind[x.kind] ||= { n: 0, sum: 0 }); k.n++; k.sum += x.delta; }
  return {
    n, sum: sum(d),
    sum_without_largest: sum(d.filter((_, i) => i !== largestIdx)),
    largest: largestIdx >= 0 ? d[largestIdx] : null,
    worst: minD,
    better, worse, tie: n - better - worse,
    half1_n: h, half1_sum: sum(d.slice(0, h)), half2_n: n - h, half2_sum: sum(d.slice(h)),
    sum_cost2: sum(f.map((x) => x.delta_cost2)),
    sum_latency: sum(f.map((x) => x.delta_latency)),
    by_kind: byKind,
    boot90: bootstrapSumCI(d),
  };
}

export function checksFor(s) {
  const worstSize = s.worst != null && s.worst < 0 ? -s.worst : 0;
  const kinds = Object.entries(s.by_kind).map(([k, v]) => ({ kind: k, n: v.n, sum: v.sum, pass: v.sum >= 0 }));
  const checks = [
    { id: 1, name: "n >= 15 fires", pass: s.n >= 15, value: s.n },
    { id: 2, name: "sum delta > 0", pass: s.sum > 0, value: s.sum },
    { id: 3, name: "sum delta > 0 without the largest delta", pass: s.sum_without_largest > 0, value: s.sum_without_largest },
    { id: 4, name: "better >= 1.5 x worse (|d| <= 0.0005 tie)", pass: s.better >= 1.5 * s.worse, value: `${s.better} / ${s.worse} / ${s.tie}` },
    { id: 5, name: "worst truncation <= 1/2 sum delta", pass: worstSize <= 0.5 * s.sum, value: `${-worstSize} vs ${0.5 * s.sum}` },
    { id: 6, name: "both halves by close time sum delta > 0", pass: s.half1_sum > 0 && s.half2_sum > 0, value: `${s.half1_sum} / ${s.half2_sum}` },
    { id: 7, name: "sum delta > 0 with the lock exit cost doubled", pass: s.sum_cost2 > 0, value: s.sum_cost2 },
    { id: 8, name: "sum delta > 0 with the exit 30 s later", pass: s.sum_latency > 0, value: s.sum_latency },
    { id: 9, name: "per grace kind sum delta >= 0 (a kind is proposed only if it passes)", pass: kinds.some((k) => k.pass), value: kinds.map((k) => `${k.kind} n${k.n} ${k.sum.toFixed(4)} ${k.pass ? "ok" : "no"}`).join("; ") || "none", kinds },
  ];
  let verdict;
  if (!checks[0].pass) verdict = "insufficient";
  else verdict = checks.slice(1).every((c) => c.pass) ? "met" : "not_met";
  return { verdict, checks, proposed_kinds: verdict === "met" ? kinds.filter((k) => k.pass).map((k) => k.kind) : [] };
}

// ─── replay ────────────────────────────────────────────────────────────────

/** Build the per-grace units (variant independent). */
export function preparePopulation(records, ticksByPos, windows, { from = DEFAULT_FROM, to = null, filterOpts = {} } = {}) {
  const fromMs = Date.parse(from), toMs_ = to ? Date.parse(to) : Infinity;
  const funnel = { records_in_file: records.length, considered: 0, rebalance_legs: 0, with_grace: 0, by_kind_owner: {} };
  const units = []; // per record: { rec, owner, closeMs, graces: [...] }
  const exclusions = {}; // per grace
  const sourceCounts = {};
  const notes = { dropped_missing: 0, dropped_jump: 0, positions_with_jump_drops: 0, max_jump_drops_one_position: 0, jump_examples: [], missing_windows: [] };
  const exclude = (kind, owner, reason) => {
    const k = `${kind}/${owner}`;
    (exclusions[k] ||= Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])))[reason]++;
  };
  for (const rec of records) {
    const t = Date.parse(rec.recorded_at);
    if (!(t >= fromMs && t < toMs_)) continue;
    if (rec.rebalance_leg) { funnel.rebalance_legs++; continue; }
    funnel.considered++;
    if (!(rec.adopted || Number(rec.straddle_count) > 0)) continue;
    funnel.with_grace++;
    const owner = ownerOf(rec);
    const w = windows[rec.position] || null;
    const closeMs = w?.closed_ms ?? t;
    const ticks = ticksByPos.get(rec.position) || [];
    const graces = graceWindowsFor(rec, w, closeMs, ticks);
    const { kept, droppedMissing, droppedJump } = filterReadings(ticks, filterOpts);
    notes.dropped_missing += droppedMissing; notes.dropped_jump += droppedJump;
    if (droppedJump) {
      notes.positions_with_jump_drops++;
      notes.max_jump_drops_one_position = Math.max(notes.max_jump_drops_one_position, droppedJump);
      notes.jump_examples.push({ pool_name: rec.pool_name, position: rec.position.slice(0, 8), dropped: droppedJump });
    }
    const u = { rec, owner, closeMs, ticks, kept, graces: [] };
    for (const g of graces) {
      const ko = `${g.kind}/${owner}`;
      (funnel.by_kind_owner[ko] ||= { graces: 0, usable: 0 }).graces++;
      sourceCounts[`${g.kind}:${g.source ?? "none"}`] = (sourceCounts[`${g.kind}:${g.source ?? "none"}`] || 0) + 1;
      const gu = { ...g, usable: false, reason: null, readings: [] };
      u.graces.push(gu);
      if (g.missing || g.start == null) { gu.reason = "no_window"; exclude(g.kind, owner, "no_window"); notes.missing_windows.push({ pool_name: rec.pool_name, position: rec.position.slice(0, 8), kind: g.kind }); continue; }
      if (!(g.end > g.start)) { gu.reason = "grace_after_close"; exclude(g.kind, owner, "grace_after_close"); continue; }
      const holds = holdIntervals(w, closeMs);
      if (holds.some((h) => h.from < g.end && h.to > g.start)) { gu.reason = "held_in_grace"; exclude(g.kind, owner, "held_in_grace"); continue; }
      const gap = maxGapMs(ticks, g.start, g.end);
      if (gap.n === 0) { gu.reason = "no_ticks"; exclude(g.kind, owner, "no_ticks"); continue; }
      gu.max_gap_ms = gap.gap;
      if (gap.gap > MAX_GAP_MS) { gu.reason = "tick_gap_over_3min"; exclude(g.kind, owner, "tick_gap_over_3min"); continue; }
      gu.readings = kept.filter((r) => r.t >= g.start && r.t <= g.end && r.t <= closeMs);
      if (!gu.readings.length) { gu.reason = "no_in_grace_reading"; exclude(g.kind, owner, "no_in_grace_reading"); continue; }
      gu.usable = true;
      funnel.by_kind_owner[ko].usable++;
    }
    units.push(u);
  }
  notes.jump_examples.sort((a, b) => b.dropped - a.dropped);
  notes.jump_examples = notes.jump_examples.slice(0, 12);
  return { units, funnel, exclusions, sourceCounts, notes };
}

/** Run one variant over the prepared units. */
export function runVariant(units, v, costs, { reconfirm = false, filter = null, initialPeak = "first" } = {}) {
  const fires = [];
  for (const u of units) {
    if (filter && !filter(u)) continue;
    for (const g of u.graces) {
      if (!g.usable) continue;
      const rd = reconfirm ? withReconfirm(g.readings) : g.readings;
      const res = simulateLock(rd, v, { initialPeak });
      if (!res.fired) continue;
      const amount = Number(u.rec.amount_sol);
      const share = costs[u.owner]?.share ?? 0;
      const lockCost = amount * share;
      const own = ownExitCost(u.rec);
      const recPnl = Number(u.rec.pnl_pct);
      const lat = latencyExit(u.kept, res.fire_t, u.closeMs) || { pnl: res.exit_pnl, fallback: true };
      const lastBefore = [...u.kept].reverse().find((r) => r.t <= u.closeMs) || null;
      fires.push({
        position: u.rec.position, pool_name: u.rec.pool_name, owner: u.owner, kind: g.kind, grace_source: g.source,
        recorded_at: u.rec.recorded_at, t_close: u.closeMs, close_reason: u.rec.close_reason, exit_family: u.rec.exit_family,
        straddle_count: Number(u.rec.straddle_count) || 0,
        amount_sol: amount, pnl_pct: recPnl, fire_t: res.fire_t, exit_pnl: res.exit_pnl, peak_at_fire: res.peak_at_fire, threshold: res.threshold,
        lock_cost: lockCost, own_cost: own,
        delta: deltaSol({ exitPnl: res.exit_pnl, recPnl, amountSol: amount, lockCostSol: lockCost, ownCostSol: own }),
        delta_cost2: deltaSol({ exitPnl: res.exit_pnl, recPnl, amountSol: amount, lockCostSol: 2 * lockCost, ownCostSol: own }),
        latency_pnl: lat.pnl, latency_fallback: lat.fallback,
        delta_latency: deltaSol({ exitPnl: lat.pnl, recPnl, amountSol: amount, lockCostSol: lockCost, ownCostSol: own }),
        last_reading_before_close: lastBefore ? lastBefore.pnl : null,
        sanity_diff: lastBefore ? lastBefore.pnl - recPnl : null,
      });
      break; // a position contributes graces only until the lock fires
    }
  }
  const summary = summarize(fires);
  return { variant: v, fires, summary, ...checksFor(summary) };
}

export function runReplay(records, ticksByPos, windows, opts = {}) {
  const prep = preparePopulation(records, ticksByPos, windows, opts);
  const costs = lockCostShares(records);
  const variants = VARIANTS.map((v) => runVariant(prep.units, v, costs));
  const primary = variants.find((x) => x.variant.primary);
  const subsets = [
    ["kind=adoption", (f) => f.kind === "adoption"],
    ["kind=straddle", (f) => f.kind === "straddle"],
    ["owner=operator", (f) => f.owner === "operator"],
    ["owner=bot", (f) => f.owner === "bot"],
  ].map(([id, pred]) => {
    const fires = primary.fires.filter(pred);
    const s = summarize(fires);
    return { variant: { id: `A10_D5 ${id}` }, fires, summary: s, ...checksFor(s) };
  });
  const reconfirm = runVariant(prep.units, { ...PRIMARY, id: "A10_D5 reconfirm_30s", primary: false }, costs, { reconfirm: true });
  const costZero = runVariant(prep.units, { ...PRIMARY, id: "A10_D5 cost_zero_filled", primary: false },
    { operator: { share: costs.operator.share_zero_filled }, bot: { share: costs.bot.share_zero_filled } });
  // interpretation sensitivities (primary parameters; none of them decides)
  const sens = [];
  sens.push(runVariant(prep.units, { ...PRIMARY, id: "sens: no starting peak", primary: false }, costs, { initialPeak: "none" }));
  for (const [id, o] of [["sens: distinct = pnl only", { distinctKey: "pnl" }], ["sens: 15 pp vs previous RAW reading", { jumpRef: "raw" }]]) {
    const prep2 = preparePopulation(records, ticksByPos, windows, { ...opts, filterOpts: o });
    sens.push(runVariant(prep2.units, { ...PRIMARY, id, primary: false }, costs));
  }
  // sanity: fired positions whose last reading disagrees with the record by > 2 pp
  const flagged = primary.fires.filter((f) => f.sanity_diff == null || Math.abs(f.sanity_diff) > SANITY_PP);
  const flaggedSet = new Set(flagged.map((f) => f.position));
  const clean = primary.fires.filter((f) => !flaggedSet.has(f.position));
  const sanity = {
    n: primary.fires.length,
    median_abs_diff: median(primary.fires.map((f) => f.sanity_diff).filter((x) => x != null).map(Math.abs)),
    flagged: flagged.map((f) => ({ pool_name: f.pool_name, position: f.position.slice(0, 8), recorded_at: f.recorded_at, straddle_count: f.straddle_count, last_reading: f.last_reading_before_close, pnl_pct: f.pnl_pct, diff: f.sanity_diff })),
    without_flagged: (() => { const s = summarize(clean); return { summary: s, ...checksFor(s) }; })(),
  };
  // census of graces with a confirmed in-grace peak ≥ 10 % (primary lock result beside it)
  const firedBy = new Map(primary.fires.map((f) => [f.position, f]));
  const census = [];
  let usableGraces = 0;
  for (const u of prep.units) for (const g of u.graces) {
    if (!g.usable) continue;
    usableGraces++;
    const mp = maxConfirmedPeak(g.readings);
    if (mp != null && mp >= 10) {
      const f = firedBy.get(u.rec.position);
      const firedHere = f && f.fire_t >= g.start && f.fire_t <= g.end;
      census.push({ pool_name: u.rec.pool_name, position: u.rec.position.slice(0, 8), kind: g.kind, owner: u.owner, start: new Date(g.start).toISOString(), max_confirmed_peak: mp, first_reading: g.readings[0].pnl,
        fired: !!firedHere, fire_at: firedHere ? new Date(f.fire_t).toISOString() : null, exit_pnl: firedHere ? f.exit_pnl : null, pnl_pct: Number(u.rec.pnl_pct), delta: firedHere ? f.delta : null, close_reason: u.rec.close_reason });
    }
  }
  const startHigh = { ge8: 0, ge10: 0 };
  for (const u of prep.units) for (const g of u.graces) if (g.usable) { if (g.readings[0].pnl >= 8) startHigh.ge8++; if (g.readings[0].pnl >= 10) startHigh.ge10++; }
  return {
    generated_at: new Date().toISOString(),
    window: { from: opts.from || DEFAULT_FROM, to: opts.to || null, newest_record: records.map((r) => r.recorded_at).sort().slice(-1)[0] },
    interpretation: INTERPRETATION,
    funnel: prep.funnel, exclusions: prep.exclusions, grace_sources: prep.sourceCounts, notes: prep.notes,
    usable_graces: usableGraces, graces_starting_high: startHigh,
    costs, census, variants, subsets, reconfirm, cost_zero_filled: costZero, sensitivities: sens, sanity,
    primary,
  };
}

// ─── report ────────────────────────────────────────────────────────────────

const f4 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(4));
const f2 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(2));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const wib = (ms) => (ms == null ? "-" : new Date(ms + 7 * 3600_000).toISOString().slice(5, 16).replace("T", " ") + " WIB");

export function formatReport(rep) {
  const L = [];
  L.push("GRACE PROFIT LOCK REPLAY (docs/experiments/grace-profit-lock.md) — offline, read-only");
  L.push(`window: recorded_at ≥ ${rep.window.from}${rep.window.to ? ` < ${rep.window.to}` : ""}; newest record ${rep.window.newest_record}`);
  L.push("");
  L.push("FUNNEL");
  const F = rep.funnel;
  L.push(`  records in file ${F.records_in_file}; in window ${F.considered} (+${F.rebalance_legs} rebalance legs dropped); with a grace ${F.with_grace}`);
  for (const [k, v] of Object.entries(F.by_kind_owner)) L.push(`  ${pad(k, 20)} graces ${lpad(v.graces, 4)}  usable ${lpad(v.usable, 4)}`);
  L.push("  excluded graces (first failing reason):");
  for (const [k, v] of Object.entries(rep.exclusions)) L.push(`    ${pad(k, 20)} ${Object.entries(v).filter(([, n]) => n).map(([r, n]) => `${r} ${n}`).join(", ")}`);
  L.push(`  grace-window sources: ${Object.entries(rep.grace_sources).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  L.push(`  usable graces ${rep.usable_graces}; first in-grace reading ≥ 8 %: ${rep.graces_starting_high.ge8}, ≥ 10 %: ${rep.graces_starting_high.ge10}`);
  const N = rep.notes;
  L.push(`  readings dropped over the population paths: missing price ${N.dropped_missing}, > 15 pp jump ${N.dropped_jump} (${N.positions_with_jump_drops} positions, max ${N.max_jump_drops_one_position} on one)`);
  if (N.jump_examples.length) L.push(`    most jump drops: ${N.jump_examples.map((x) => `${x.pool_name} ${x.position} ${x.dropped}`).join("; ")}`);
  L.push("");
  L.push("LOCK EXIT COST (median exit_slippage_sol / amount_sol, trailing_tp, whole export)");
  for (const [o, c] of Object.entries(rep.costs)) L.push(`  ${pad(o, 9)} ${(c.share * 100).toFixed(3)} % (n ${c.n}); zero-filled ${(c.share_zero_filled * 100).toFixed(3)} % (n ${c.n_zero_filled})`);
  L.push("");
  L.push(`GRACES WITH A CONFIRMED IN-GRACE PEAK ≥ 10 %: ${rep.census.length}`);
  for (const c of rep.census) L.push(`  ${pad(c.pool_name, 16)} ${c.position} ${pad(c.kind, 9)} ${pad(c.owner, 8)} start ${c.start.slice(5, 16)}Z first ${lpad(f2(c.first_reading), 6)} peak ${lpad(f2(c.max_confirmed_peak), 7)}  ${c.fired ? `FIRED ${c.fire_at.slice(5, 19)}Z exit ${f2(c.exit_pnl)}` : "no fire"}  rec ${f2(c.pnl_pct)}  Δ ${c.delta == null ? "-" : f4(c.delta)}`);
  L.push("");
  const varLine = (r) => {
    const s = r.summary;
    return `  ${pad(r.variant.id, 28)} n ${lpad(s.n, 3)}  ΣΔ ${lpad(f4(s.sum), 8)}  w/o max ${lpad(f4(s.sum_without_largest), 8)}  b/w/t ${s.better}/${s.worse}/${s.tie}  worst ${lpad(f4(s.worst), 8)}  halves ${f4(s.half1_sum)} / ${f4(s.half2_sum)}  cost×2 ${f4(s.sum_cost2)}  +30s ${f4(s.sum_latency)}  CI90 [${f4(s.boot90.lo)}, ${f4(s.boot90.hi)}]  → ${r.verdict}`;
  };
  L.push("VARIANTS");
  for (const r of rep.variants) L.push(varLine(r));
  for (const r of rep.subsets) L.push(varLine(r));
  L.push(varLine(rep.reconfirm));
  L.push(varLine(rep.cost_zero_filled));
  for (const r of rep.sensitivities) L.push(varLine(r));
  L.push("");
  const P = rep.primary;
  L.push("PRIMARY A10_D5 — fires");
  for (const f of [...P.fires].sort((a, b) => a.t_close - b.t_close)) L.push(`  ${pad(f.pool_name, 16)} ${f.position.slice(0, 8)} ${pad(f.kind, 9)} ${pad(f.owner, 8)} fire ${wib(f.fire_t)} peak ${lpad(f2(f.peak_at_fire), 6)} exit ${lpad(f2(f.exit_pnl), 6)} (+30s ${lpad(f2(f.latency_pnl), 6)}) rec ${lpad(f2(f.pnl_pct), 6)} cap ◎${f.amount_sol.toFixed(3)} lockcost ${f4(-f.lock_cost)} own ${f4(f.own_cost)}  Δ ${f4(f.delta)}  last-tick ${f2(f.last_reading_before_close)}`);
  L.push("");
  const S = rep.sanity;
  L.push(`SANITY (fired): median |last reading before close − recorded pnl_pct| = ${f2(S.median_abs_diff)} pp; flagged > 2 pp: ${S.flagged.length}`);
  for (const x of S.flagged) L.push(`  ${pad(x.pool_name, 16)} ${x.position} ${x.recorded_at.slice(0, 10)} straddles ${x.straddle_count} last ${f2(x.last_reading)} rec ${f2(x.pnl_pct)} diff ${f2(x.diff)}`);
  L.push(varLine({ variant: { id: "A10_D5 without flagged" }, ...S.without_flagged }));
  L.push("");
  L.push(`VERDICT (primary A10_D5): ${P.verdict}${P.proposed_kinds.length ? ` — proposed kinds: ${P.proposed_kinds.join(", ")}` : ""}`);
  for (const c of P.checks) {
    const v = typeof c.value === "number" ? (Number.isInteger(c.value) ? String(c.value) : f4(c.value)) : String(c.value);
    L.push(`  check ${c.id}: ${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${v})`);
  }
  L.push("");
  L.push("INTERPRETATION CHOICES");
  for (const s of rep.interpretation) L.push(`  - ${s}`);
  return L.join("\n") + "\n";
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  if (args.includes("--build-windows")) {
    const rowsP = opt("--rows"), evP = opt("--events"), outP = opt("--out");
    if (!rowsP || !evP || !outP) { console.error("usage: --build-windows --rows rows.csv --events events.csv --out windows.json"); process.exit(2); }
    const w = buildWindowInputs(readMaybeGz(rowsP), readMaybeGz(evP));
    fs.writeFileSync(outP, JSON.stringify(w));
    console.log(`windows: ${Object.keys(w).length} positions → ${outP}`);
    return;
  }
  const recordsPath = opt("--records"), ticksPath = opt("--ticks"), windowsPath = opt("--windows");
  if (!recordsPath || !ticksPath || !windowsPath) {
    console.error("usage: node scripts/replay/grace_lock_replay.js --records <performance.json> --ticks <ticks.csv[.gz]> --windows <windows.json> [--json out.json] [--from ISO] [--to ISO]");
    process.exit(2);
  }
  const records = JSON.parse(fs.readFileSync(recordsPath, "utf8"));
  if (!Array.isArray(records)) throw new Error("--records must be a JSON array");
  const { byPos, stats } = parseTicksCsv(readMaybeGz(ticksPath));
  const windows = JSON.parse(fs.readFileSync(windowsPath, "utf8"));
  const rep = runReplay(records, byPos, windows, { from: opt("--from", DEFAULT_FROM), to: opt("--to", null) });
  rep.inputs = { records: path.resolve(recordsPath), ticks: path.resolve(ticksPath), windows: path.resolve(windowsPath), tick_stats: stats };
  process.stdout.write(formatReport(rep) + `\n(tick file: ${stats.rows} rows, ${stats.positions} positions, ${stats.bad} unreadable)\n`);
  const jsonOut = opt("--json", null);
  if (jsonOut) {
    const slim = { ...rep, variants: rep.variants.map((v) => ({ ...v })), };
    fs.writeFileSync(jsonOut, JSON.stringify(slim, null, 1));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
