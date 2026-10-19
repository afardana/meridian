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
  } else if (pnl <= s.sim_peak_pct) {
    s.sim_pending_pct = null; s.sim_pending_count = 0;
  } else {
    s.sim_pending_pct = s.sim_pending_pct != null ? Math.min(s.sim_pending_pct, pnl) : pnl;
    s.sim_pending_count = (Number(s.sim_pending_count) || 0) + 1;
    if (s.sim_pending_count >= ticks) {
      s.sim_peak_pct = round2(Math.max(s.sim_peak_pct, s.sim_pending_pct));
      s.sim_pending_pct = null; s.sim_pending_count = 0;
    }
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
