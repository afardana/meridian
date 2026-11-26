/**
 * Grace counterfactual — LOG ONLY (2026-10-19). A profit grace (an adopted position's adoption
 * window, or the `profit_grace_until` an in-place straddle sets) pauses trailing TP /
 * take-profit / harvest for a fixed time, and nothing recorded what that costs or earns per
 * position. PIERRE-SOL 72jUBSia 2026-10-19: straddled 15:44 WIB at +1.46 %, peaked 10.68 % at
 * 15:47 inside the grace, the operator released the grace at 16:01 at 3.85 %, trailing then
 * fired at 2.25 %.
 *
 * While a grace is active this module runs, beside the live rules, the trailing TP (and the
 * fixed take-profit) as if there were NO grace: its own confirmed peak, reset at the grace
 * start to the first trusted reading, with the live semantics — a new peak needs `confirmTicks`
 * distinct readings above it and takes the streak's lowest (state.confirmPeak); trailing arms
 * at `trailingTriggerPct` and fires at peak − `trailingDropPct` (floor `trailingMinPnlPct`),
 * at once on an overshoot ≥ `trailingOvershootPct`, else on the `confirmTicks`-th consecutive
 * distinct breach (the poller's registerExitSignal). The harvest is not simulated. The first
 * would-fire is kept; the in-grace peak (raw high of the trusted readings) is tracked to the end.
 * At the grace end (timer, [GRACE_END]) or the operator's release ([GRACE_RELEASE]) one
 * `[GRACE_SHADOW]` line is logged and the record is closed.
 *
 * Nothing here changes a grace or an exit: it writes `grace_shadow` only. The trailing math is
 * injected (state.evaluateTrailingTakeProfit) so there is one copy of it.
 */
import { graceWindow } from "./grace-release-shadow.js";
import { fmtWib } from "./wib-time.js";

/** graceShadowEnabled (default true) — false stops new readings; an open record stays as is. */
export function graceShadowEnabled(mgmt = {}) {
  return mgmt?.graceShadowEnabled !== false;
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;

/**
 * One step of state.confirmPeak's rule on a copy of its counters, for the shadows that keep a
 * peak of their own (this module, grace-lock-shadow.js). A reading at or under the peak drops a
 * pending one; a reading above it extends the streak, whose value is the streak's LOWEST
 * reading; after `ticks` readings the peak becomes max(peak, that value). Pure.
 * Returns { peak, pending, count, raised }.
 */
export function confirmPeakStep({ peak, pending = null, count = 0 } = {}, pnl, ticks = 2) {
  const n = Math.max(1, Number(ticks) || 1);
  if (!(pnl > peak)) return { peak, pending: null, count: 0, raised: false };
  const nextPending = pending != null ? Math.min(pending, pnl) : pnl;
  const nextCount = (Number(count) || 0) + 1;
  if (nextCount >= n) return { peak: Math.max(peak, nextPending), pending: null, count: 0, raised: true };
  return { peak, pending: nextPending, count: nextCount, raised: false };
}
const iso = (ms) => new Date(ms).toISOString();
const signed = (v) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`;
const at = (v) => fmtWib(v, "time_s") || "?";

function freshShadow(window, reading, nowMs) {
  const plannedEnd = window.start_ms + (window.elapsed_min + window.remaining_min) * 60_000;
  return {
    kind: window.kind,
    started_at: iso(window.start_ms),
    planned_min: Math.round((plannedEnd - window.start_ms) / 60_000),
    peak_pct: null, peak_at: null,
    last_pct: null, last_at: null, readings: 0,
    sim_peak_pct: null, sim_pending_pct: null, sim_pending_count: 0,
    sim_signal: null, sim_signal_count: 0, sim_first_breach_pct: null, sim_first_breach_at: null,
    no_grace_fire_pct: null, no_grace_fire_at: null, no_grace_rule: null,
    no_grace_peak_pct: null, no_grace_threshold_pct: null,
    ended_by: null, ended_at: null, end_pct: null, elapsed_min: null,
    created_at: iso(nowMs),
  };
}

/**
 * Feed one trusted reading (the stream state.confirmPeak sees: poller → fresh and not suspect,
 * management cycle → not suspect, confirmTicks 1). Pure: mutates `pos.grace_shadow` only.
 * Returns { changed, event: "started" | "restarted" | "fired" | null }.
 */
export function advanceGraceShadow(pos, { pnlPct, confirmTicks = 2, nowMs = Date.now(), mgmt = {}, evaluateTrailing } = {}) {
  if (!pos || pos.closed || pos.hold_mode === true || !graceShadowEnabled(mgmt)) return { changed: false, event: null };
  const pnl = Number(pnlPct);
  if (!Number.isFinite(pnl)) return { changed: false, event: null };
  const window = graceWindow(pos, mgmt, nowMs);
  if (!window) return { changed: false, event: null };
  const startedAt = iso(window.start_ms);
  let s = pos.grace_shadow;
  let event = null;
  if (!s || s.kind !== window.kind || s.started_at !== startedAt) {
    event = s ? "restarted" : "started"; // a new straddle (or adoption → straddle) starts a new grace
    s = freshShadow(window, pnl, nowMs);
  } else if (s.ended_by) {
    return { changed: false, event: null };
  } else {
    s = { ...s };
  }
  const now = iso(nowMs);
  const ticks = Math.max(1, Number(confirmTicks) || 1);
  s.last_pct = round2(pnl); s.last_at = now; s.readings = (Number(s.readings) || 0) + 1;
  if (s.peak_pct == null || pnl > s.peak_pct) { s.peak_pct = round2(pnl); s.peak_at = now; }

  // Confirmed peak without the grace: reset at the grace start, then state.confirmPeak's rule.
  if (s.sim_peak_pct == null) {
    s.sim_peak_pct = round2(pnl);
  } else {
    const c = confirmPeakStep({ peak: s.sim_peak_pct, pending: s.sim_pending_pct, count: s.sim_pending_count }, pnl, ticks);
    s.sim_pending_pct = c.pending; s.sim_pending_count = c.count;
    if (c.raised) s.sim_peak_pct = round2(c.peak);
  }

  // The first moment the trailing TP (or the fixed take-profit) would have fired with no grace.
  if (!s.no_grace_rule) {
    const trigger = Number(mgmt.trailingTriggerPct ?? 3);
    const drop = Number(mgmt.trailingDropPct ?? 1.5);
    let signal = null, threshold = null, immediate = false;
    if (mgmt.trailingTakeProfit && typeof evaluateTrailing === "function" && s.sim_peak_pct >= trigger) {
      const t = evaluateTrailing(s.sim_peak_pct, pnl, { dropPct: drop, minPnlPct: mgmt.trailingMinPnlPct, overshootPct: mgmt.trailingOvershootPct });
      if (t) { signal = "trailing_tp"; threshold = Number(t.threshold_pnl_pct); immediate = !!t.bypass_confirmation; }
    }
    const tp = mgmt.takeProfitPct != null && mgmt.takeProfitPct !== "" ? Number(mgmt.takeProfitPct) : NaN;
    if (!signal && Number.isFinite(tp) && pnl >= tp) { signal = "take_profit"; threshold = tp; }
    if (!signal) {
      s.sim_signal = null; s.sim_signal_count = 0; s.sim_first_breach_pct = null; s.sim_first_breach_at = null;
    } else {
      if (s.sim_signal === signal) s.sim_signal_count = (Number(s.sim_signal_count) || 0) + 1;
      else { s.sim_signal = signal; s.sim_signal_count = 1; s.sim_first_breach_pct = round2(pnl); s.sim_first_breach_at = now; }
      if (immediate || s.sim_signal_count >= ticks) {
        s.no_grace_rule = signal;
        s.no_grace_fire_pct = round2(pnl);
        s.no_grace_fire_at = now;
        s.no_grace_peak_pct = s.sim_peak_pct;
        s.no_grace_threshold_pct = Number.isFinite(threshold) ? round2(threshold) : null;
        event = event || "fired";
      }
    }
  }
  pos.grace_shadow = s;
  return { changed: true, event };
}

/** A no-grace fire stamped at most this long before a capital change is voided (pre-index window). */
export const GRACE_SHADOW_CAPITAL_VOID_MS = 10 * 60_000;
const solTxt = (v) => (v != null && Number.isFinite(Number(v)) ? `◎${Number(v).toFixed(4)}` : "◎?");

/**
 * Capital change (2026-11-26; same reasoning as grace-lock-shadow.resetGraceLockShadowForCapital):
 * the reconciler re-based the position's %-references, and readings of an unindexed top-up may
 * have built this simulation's peaks on the old capital.
 *   - A no-grace fire stamped ≤ 10 min before the change → `voided_fire` { fired_at, fire_pnl_pct,
 *     fire_peak_pct, fire_threshold_pct, rule, reason: "capital_rebase", voided_at, from_sol,
 *     to_sol }; the `no_grace_*` fields are cleared and the simulation continues from the reset.
 *     An older fire stands and nothing else moves.
 *   - An open record (not ended) is RESET: the confirmed no-grace peak, its pending streak, the
 *     signal / breach streak and the raw in-grace high (also built on the old capital) — re-seeded
 *     from the first reading fed after the re-base settled (state.noteGraceShadowReading feeds
 *     nothing while `capital_rebase_pending` is set). Kept: kind, started_at, planned_min, readings,
 *     last reading. `capital_resets` / `last_capital_reset_at` record it.
 * Known limit: a top-up under the reconciler's threshold (< ◎0.02 or < 5 %) triggers no re-base,
 * so a fake bump under ~5 pp can still enter the peaks.
 * graceShadowEnabled false → nothing. Pure: mutates `pos.grace_shadow` only. Returns { changed, voided, line }.
 */
export function resetGraceShadowForCapital(pos, { nowMs = Date.now(), fromSol = null, toSol = null, mgmt = {}, pair = null } = {}) {
  const out = { changed: false, voided: false, line: null };
  if (!pos || !graceShadowEnabled(mgmt)) return out;
  const s0 = pos.grace_shadow;
  if (!s0 || typeof s0 !== "object" || s0.ended_by) return out;
  const s = { ...s0 };
  if (s.no_grace_rule) {
    const firedMs = Date.parse(s.no_grace_fire_at);
    const age = nowMs - firedMs;
    if (!(Number.isFinite(firedMs) && age <= GRACE_SHADOW_CAPITAL_VOID_MS && age >= -60_000)) return out; // an older fire stands
    s.voided_fire = {
      fired_at: s.no_grace_fire_at, fire_pnl_pct: s.no_grace_fire_pct, fire_peak_pct: s.no_grace_peak_pct,
      fire_threshold_pct: s.no_grace_threshold_pct, rule: s.no_grace_rule, reason: "capital_rebase", voided_at: iso(nowMs),
      from_sol: fromSol != null && Number.isFinite(Number(fromSol)) ? Number(fromSol) : null,
      to_sol: toSol != null && Number.isFinite(Number(toSol)) ? Number(toSol) : null,
    };
    s.no_grace_rule = null; s.no_grace_fire_pct = null; s.no_grace_fire_at = null; s.no_grace_peak_pct = null; s.no_grace_threshold_pct = null;
    out.voided = true;
    out.line = `[GRACE_SHADOW] ${pair || pos.pool_name || pos.position || "?"}: no-grace fire voided — capital changed ${solTxt(fromSol)} → ${solTxt(toSol)} within 10 min of it (peak was on the old capital)`;
  }
  s.peak_pct = null; s.peak_at = null;
  s.sim_peak_pct = null; s.sim_pending_pct = null; s.sim_pending_count = 0;
  s.sim_signal = null; s.sim_signal_count = 0; s.sim_first_breach_pct = null; s.sim_first_breach_at = null;
  s.capital_resets = (Number(s.capital_resets) || 0) + 1;
  s.last_capital_reset_at = iso(nowMs);
  pos.grace_shadow = s;
  out.changed = true;
  return out;
}

/**
 * Close the record at the grace end. `endedBy` "timer" | "release"; `endPct` = the reading at
 * the end when the caller has a trusted one (else the last trusted reading). Pure; returns the
 * `[GRACE_SHADOW]` line, or null when there is no open record.
 */
export function finishGraceShadow(pos, { endedBy, endPct = null, nowMs = Date.now(), mgmt = {}, pair = null } = {}) {
  const s = pos?.grace_shadow;
  if (!s || s.ended_by) return null;
  const end = endPct != null && Number.isFinite(Number(endPct)) ? round2(endPct) : s.last_pct;
  const startMs = new Date(s.started_at).getTime();
  const elapsed = Number.isFinite(startMs) ? Math.max(0, (nowMs - startMs) / 60_000) : null;
  pos.grace_shadow = {
    ...s,
    ended_by: endedBy === "release" ? "release" : "timer",
    ended_at: iso(nowMs),
    end_pct: end,
    elapsed_min: elapsed != null ? Math.round(elapsed * 10) / 10 : null,
  };
  return graceShadowLine(pos.grace_shadow, pair || pos.pool_name || pos.position || "?", mgmt);
}

/** The one `[GRACE_SHADOW]` line for a closed record. */
export function graceShadowLine(s, pair, mgmt = {}) {
  const how = s.ended_by === "release"
    ? `released by the operator after ${Math.round(Number(s.elapsed_min) || 0)} min`
    : "ran to the end";
  const peak = s.peak_pct != null ? `in-grace peak ${Number(s.peak_pct).toFixed(2)}% at ${at(s.peak_at)}` : "no trusted reading in the grace";
  const end = s.end_pct != null ? `, reading at the end ${Number(s.end_pct).toFixed(2)}%` : "";
  const ruleName = s.no_grace_rule === "take_profit" ? "take-profit" : "trailing";
  const counterfactual = s.no_grace_rule
    ? `without the grace ${ruleName} would have closed at ${signed(s.no_grace_fire_pct)} at ${at(s.no_grace_fire_at)}` +
      (s.no_grace_rule === "trailing_tp"
        ? ` (confirmed peak ${Number(s.no_grace_peak_pct).toFixed(2)}% − ${Number(mgmt.trailingDropPct ?? 1.5)} pp, threshold ${Number(s.no_grace_threshold_pct).toFixed(2)}%)`
        : ` (target ${Number(s.no_grace_threshold_pct).toFixed(2)}%)`)
    : `without the grace trailing would not have fired during the grace (confirmed peak ${s.sim_peak_pct != null ? `${Number(s.sim_peak_pct).toFixed(2)}%` : "n/a"})`;
  return `[GRACE_SHADOW] ${pair}: ${s.kind} grace ${s.planned_min} min (${how}) — ${peak}${end}; ${counterfactual}`;
}

/** Perf-record copy (three record sites). A grace still open at the close is marked so. */
export function graceShadowRecordField(pos) {
  const s = pos?.grace_shadow;
  if (!s || typeof s !== "object") return null;
  return s.ended_by ? { ...s } : { ...s, open_at_close: true };
}
