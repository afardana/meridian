/**
 * Straddle trailing shadow — LOG ONLY (2026-10-19). On straddled positions (`straddle_count > 0`)
 * a trailing TRIGGER of 3 % (drop unchanged) replayed +◎0.07, 3 better / 0 worse on n = 23 —
 * too thin to enforce. This module keeps, beside the live trailing TP, what a trigger of
 * `trailStraddleShadowTrigger` would have done: it is armed by the SAME confirmed peak the live
 * rule reads (`peak_pnl_pct` — no second peak tracker) under the same arming conditions, and
 * when the LIVE trailing TP closes a straddled position it records whether the shadow trigger
 * would have held (`would_hold`: confirmed peak under the shadow trigger) or fired at the same
 * threshold (`same`: the drop is the same, so both fire together).
 *
 * Nothing here closes, defers or arms anything live: it writes `trail_straddle_shadow` only.
 * Leaf module (no imports).
 */

export const DEFAULT_TRAIL_STRADDLE_SHADOW_TRIGGER = 3;

/** The shadow trigger in percent; 0 (or anything not > 0) = off. */
export function trailStraddleShadowTrigger(mgmt = {}) {
  const raw = mgmt?.trailStraddleShadowTrigger;
  const v = raw == null || raw === "" ? DEFAULT_TRAIL_STRADDLE_SHADOW_TRIGGER : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

const isStraddled = (pos) => Number(pos?.straddle_count) > 0;
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const fmt = (v) => `${Number(v).toFixed(2)}%`;
const fmtTrigger = (v) => `${Number(v)}%`;

/**
 * Advance the shadow arm state on one evaluation (called after the live arming block, so a
 * grace-end / hold-resume / rebalance re-base of the peak has already happened). Pure: mutates
 * `pos.trail_straddle_shadow` only. `eligible` = the live arming conditions other than the
 * live `trailing_active` flag (no range-harvest profile, no profit grace, trailing enabled, no
 * pending hold-resume or capital re-base).
 * Returns { changed, event: "armed" | "disarmed" | null }.
 */
export function advanceTrailStraddleShadow(pos, { eligible, mgmt = {}, nowMs = Date.now() } = {}) {
  const trigger = trailStraddleShadowTrigger(mgmt);
  if (!pos || !(trigger > 0) || !isStraddled(pos)) return { changed: false, event: null };
  const peak = Number(pos.peak_pnl_pct);
  const prev = pos.trail_straddle_shadow;
  const s = prev && typeof prev === "object" ? { ...prev } : { trigger, armed: false, armed_at: null, peak_pct: null };
  let event = null;
  if (!eligible) {
    // A new straddle / grace resets the live trailing (trailing_active false): the shadow follows.
    if (s.armed && pos.trailing_active !== true) { s.armed = false; s.armed_at = null; event = "disarmed"; }
  } else if (Number.isFinite(peak)) {
    if (!s.armed && peak >= trigger) { s.armed = true; s.armed_at = new Date(nowMs).toISOString(); event = "armed"; }
    else if (s.armed && peak < trigger) { s.armed = false; s.armed_at = null; event = "disarmed"; } // peak re-based below
  }
  s.trigger = trigger;
  if (Number.isFinite(peak)) s.peak_pct = round2(peak);
  const changed = !prev || event != null || prev.trigger !== s.trigger || prev.peak_pct !== s.peak_pct;
  if (changed) pos.trail_straddle_shadow = s;
  return { changed, event };
}

/**
 * The live trailing TP is closing a position. On a straddled one, stamp the verdict and return
 * the log line; null when not straddled or the shadow is off. Pure: mutates the shadow only.
 */
export function noteTrailStraddleShadowFire(pos, { pnlPct, mgmt = {}, nowMs = Date.now(), pair = null } = {}) {
  const trigger = trailStraddleShadowTrigger(mgmt);
  if (!pos || !(trigger > 0) || !isStraddled(pos)) return null;
  const peak = Number(pos.peak_pnl_pct);
  const s = { trigger, armed: false, armed_at: null, peak_pct: null, ...(pos.trail_straddle_shadow || {}) };
  // Armed is what the evaluator kept; a confirmed peak at/above the trigger with no evaluation
  // since (e.g. the peak was raised on this very tick) counts as armed too.
  const armed = s.armed === true || (Number.isFinite(peak) && peak >= trigger);
  const fire = Number(pnlPct);
  Object.assign(s, {
    trigger,
    verdict: armed ? "same" : "would_hold",
    live_peak_pct: Number.isFinite(peak) ? round2(peak) : null,
    live_fire_pct: Number.isFinite(fire) ? round2(fire) : null,
    live_trigger_pct: Number.isFinite(Number(mgmt.trailingTriggerPct)) ? Number(mgmt.trailingTriggerPct) : null,
    fired_at: new Date(nowMs).toISOString(),
  });
  if (armed && !s.armed) { s.armed = true; s.armed_at = s.fired_at; }
  pos.trail_straddle_shadow = s;
  const name = pair || pos.pool_name || pos.position || "?";
  const peakTxt = Number.isFinite(peak) ? fmt(peak) : "n/a";
  const fireTxt = Number.isFinite(fire) ? fmt(fire) : "n/a";
  const line = armed
    ? `[TRAIL_STRADDLE_SHADOW] same ${name}: confirmed peak ${peakTxt} ≥ ${fmtTrigger(trigger)} trigger — live trailing closed at ${fireTxt}, the shadow fires at the same threshold (trailStraddleShadowTrigger=${trigger})`
    : `[TRAIL_STRADDLE_SHADOW] would-hold ${name}: confirmed peak ${peakTxt} < ${fmtTrigger(trigger)} trigger — live trailing closed at ${fireTxt} (trailStraddleShadowTrigger=${trigger})`;
  return { verdict: s.verdict, line, shadow: s };
}
