/**
 * Hands-off on a HELD position (2026-11-27, operator: "make sure the current hold is respected.
 * No other rules shall apply to it tonight.").
 *
 * HOLD already stops the exit evaluator, but two rules override it — the TVL exit
 * (tvl-floor-exit.js) and the thin-pool hold limit (hold-thin-limit.js) — and the management
 * cycle still auto-claims a held position's fees (and the after-claim auto-swap sells the
 * claimed base tokens). `hands_off_until` on the position switches all of that off for ONE
 * held position until a time the operator chose (at most 7 days ahead), so the global rules
 * can stay in enforce for every other position.
 *
 * While active (hold_mode === true AND now < hands_off_until):
 *   - the TVL exit still keeps its streak (log lines stay truthful) but never confirms, never
 *     alerts and never returns an exit (index.js checkTvlFloorExit);
 *   - the thin-pool hold limit treats the position as exempt (state.noteHoldThinLimitReading);
 *   - holdOverrideActive (hold-override.js) is false for EVERY rule, so no automatic close can
 *     pass the three HOLD guards, even with a stale stamp;
 *   - the management cycle decides STAY instead of CLAIM, its action guard lets nothing but
 *     STAY through, and executeTool refuses claim_fees unless operatorOverride.
 * The operator's own /close, /closeall, /manage close button and the dashboard close endpoint
 * (operatorOverride) keep working. Record-only trackers keep running.
 *
 * Leaf module (imports only wib-time.js, itself a leaf), so state.js, index.js and
 * hold-override.js can all import it without a cycle. Operator-only: no LLM tool, no
 * update_config key.
 */

import { fmtWib, wibDayKey } from "./wib-time.js";

/** Furthest ahead a hands-off may be set. */
export const HANDS_OFF_MAX_MS = 7 * 24 * 3_600_000;
export const HANDS_OFF_MAX_HOURS = HANDS_OFF_MAX_MS / 3_600_000;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function parseUntilMs(v) {
  if (typeof v !== "string" || !v.trim()) return NaN;
  return Date.parse(v);
}

/**
 * Is hands-off in force on this position right now? Requires the position to be on HOLD: a
 * stamp left on a released position has no effect. An expired stamp is simply inactive.
 */
export function handsOffActive(pos, nowMs = Date.now()) {
  if (!pos || pos.closed || pos.hold_mode !== true) return false;
  const until = parseUntilMs(pos.hands_off_until);
  return Number.isFinite(until) && nowMs < until;
}

/** The active `hands_off_until` (ISO) or null. */
export function handsOffUntil(pos, nowMs = Date.now()) {
  return handsOffActive(pos, nowMs) ? new Date(parseUntilMs(pos.hands_off_until)).toISOString() : null;
}

/** "28 Nov 07:00 WIB" for log / Telegram lines. */
export function handsOffUntilLabel(untilIso) {
  return fmtWib(untilIso, "datetime") || String(untilIso);
}

/**
 * Validate a target time. null → clear. Returns { ok:true, untilMs|null } or
 * { ok:false, status:400, error }.
 */
export function validateHandsOffUntil(untilMs, nowMs = Date.now()) {
  if (untilMs === null) return { ok: true, untilMs: null };
  if (typeof untilMs !== "number" || !Number.isFinite(untilMs)) return { ok: false, status: 400, error: "`until` is not a valid time" };
  if (untilMs <= nowMs) return { ok: false, status: 400, error: "`until` must be in the future" };
  if (untilMs - nowMs > HANDS_OFF_MAX_MS) return { ok: false, status: 400, error: `\`until\` may be at most ${HANDS_OFF_MAX_HOURS / 24} days ahead` };
  return { ok: true, untilMs };
}

/**
 * May hands-off be set / cleared on this tracked position? null = yes; else { status, error }.
 * Setting needs an open position on HOLD; clearing needs an open position only.
 */
export function handsOffRefusal(tracked, { clearing = false } = {}) {
  if (!tracked || tracked.closed) return { status: 404, error: "Position is not open in the bot" };
  if (!clearing && tracked.hold_mode !== true) return { status: 409, error: "Position is not on hold — hands-off only applies to a held position" };
  return null;
}

/**
 * POST /command/set-hands-off body → { ok, position, untilMs | null } or { ok:false, error } (400).
 * Exactly one of `until` (ISO string, or null = clear) and `hours` (number; 0 = clear).
 * Range (future, ≤ 7 days) is checked here too.
 */
export function parseHandsOffBody(body, nowMs = Date.now()) {
  const position = typeof body?.position === "string" ? body.position.trim() : "";
  if (!BASE58_RE.test(position)) return { ok: false, error: "Missing or malformed `position` (base58 address expected)" };
  const hasUntil = body != null && Object.prototype.hasOwnProperty.call(body, "until") && body.until !== undefined;
  const hasHours = body != null && Object.prototype.hasOwnProperty.call(body, "hours") && body.hours !== undefined;
  if (hasUntil === hasHours) return { ok: false, error: "Give exactly one of `until` (ISO time or null) and `hours` (number, 0 = clear)" };
  let untilMs;
  if (hasUntil) {
    if (body.until === null) untilMs = null;
    else {
      untilMs = parseUntilMs(body.until);
      if (!Number.isFinite(untilMs)) return { ok: false, error: "`until` must be an ISO time string or null" };
    }
  } else {
    const h = body.hours;
    if (typeof h !== "number" || !Number.isFinite(h) || h < 0) return { ok: false, error: "`hours` must be a number ≥ 0" };
    untilMs = h === 0 ? null : nowMs + h * 3_600_000;
  }
  const v = validateHandsOffUntil(untilMs, nowMs);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, position, untilMs: v.untilMs };
}

/**
 * The management cycle's action for a HELD position: CLAIM when its unclaimed fees reach the
 * threshold, else STAY — and always STAY while hands-off is in force (no claim transaction, no
 * after-claim sale of the fee tokens).
 */
export function heldPositionAction(tracked, unclaimedFees, thresholdSol, nowMs = Date.now()) {
  if (handsOffActive(tracked, nowMs)) return { action: "STAY", hold_mode: true, hands_off: true };
  return (unclaimedFees ?? 0) >= thresholdSol ? { action: "CLAIM", hold_mode: true } : { action: "STAY", hold_mode: true };
}

/** Card / report field: `hands_off_until` (ISO) only while active, else null. Display only. */
export function handsOffCardFields(tracked, nowMs = Date.now()) {
  return { hands_off_until: handsOffUntil(tracked, nowMs) };
}

/** Short Telegram suffix for a held row: " · hands-off until 07:00 WIB", or "". */
export function handsOffRowSuffix(pos, nowMs = Date.now()) {
  const until = handsOffUntil(pos, nowMs);
  if (!until) return "";
  // Same WIB day as now → time only; otherwise date + time.
  const sameDay = wibDayKey(until) === wibDayKey(nowMs);
  return ` · hands-off until ${sameDay ? fmtWib(until, "time") : fmtWib(until, "datetime")}`;
}
