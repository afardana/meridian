// grace-rug-pause.js — in-range rug detection is paused inside a profit grace (2026-11-24).
//
// Operator, after JIMMY-SOL 31ir6RAo (manual, ◎0.309): the in-range rug latch closed it at
// −16.26 % twenty minutes into its 60-minute adoption grace (30 bins / 130 s, no 3-bin recovery
// in 35 s); three minutes later the pool price was ~20 bins higher. "Please disable the rug
// detection within the grace." It extends the 2026-10-17 instruction ("the grace is supposed to
// let everything happen within the timeframe"), which already pauses the stop loss there.
//
// While a profit grace is active (the window state.profitGraceRemainingMin measures: the
// adoption window or a straddle's `profit_grace_until`, not released) the two IN-RANGE rug rules
// do not close the position:
//   - the in-range rug latch (rug-latch.js; also the immediate close with rugPersistMode=off),
//   - the in-range half of the calm-pair crash rule (crash-regime.js, exit family `rug`).
// Unchanged: the crash fast path below the range, the calm rule's below-range half (its own
// mode), the TVL exit, the thin-pool hold limit, OOR / low-yield rules. Nothing special at the
// grace end: the next reading runs the detectors normally (the latch then needs its 30 s).
//
// profitGraceRugMode: "active"   — the rug rules run inside a grace (behaviour before this date)
//                     "operator" — paused on positions the operator opened (default)
//                     "all"      — paused on every position in a grace (bot straddle graces too)
// An unknown value reads as "operator".
//
// Leaf module: imports only rule-mode.js and owner-tag.js (both leaves). Pure.

import { modeFor } from "./rule-mode.js";
import { ownerTag } from "./owner-tag.js";

export const PROFIT_GRACE_RUG_MODES = Object.freeze(["active", "operator", "all"]);

export function profitGraceRugMode(mgmt = {}) {
  return modeFor("profitGraceRugMode", mgmt?.profitGraceRugMode);
}

/** Does the pause cover this position, given the minutes its profit grace has left? */
export function graceRugPauseApplies(pos, mgmt = {}, graceRemainingMin = 0) {
  if (!pos || pos.closed) return false;
  const mode = profitGraceRugMode(mgmt);
  if (mode === "active") return false;
  if (!(Number(graceRemainingMin) > 0)) return false;
  return mode === "all" || ownerTag(pos).owner === "manual";
}

/**
 * Record of the rug hits a grace held back (`grace_rug_paused` on the position → perf record):
 * first hit kept, worst pnl and the hit count follow later ones.
 * @returns {{ rec: object, first: boolean, changed: boolean }}
 */
export function advanceGraceRugPaused(rec, { rule, pnl, bin, reason, remainingMin, mode } = {}, nowMs = Date.now()) {
  const v = Number(pnl);
  const p = Number.isFinite(v) ? v : null;
  if (!rec) {
    return {
      first: true,
      changed: true,
      rec: {
        first_at: new Date(nowMs).toISOString(),
        rule: rule || "rug_latch",
        pnl_pct: p,
        bin: Number.isFinite(Number(bin)) ? Number(bin) : null,
        worst_pnl_pct: p,
        hits: 1,
        last_at: new Date(nowMs).toISOString(),
        grace_remaining_min: Math.ceil(Number(remainingMin) || 0),
        mode: mode || null,
        reason: reason ? String(reason).slice(0, 240) : null,
      },
    };
  }
  const next = { ...rec, hits: (Number(rec.hits) || 1) + 1, last_at: new Date(nowMs).toISOString() };
  if (p != null && !(Number(rec.worst_pnl_pct) <= p)) next.worst_pnl_pct = p;
  return { first: false, changed: true, rec: next };
}

/** The one log line per position, on the first held-back hit. */
export function graceRugPausedLine(pair, rec, mode) {
  const what = rec?.rule === "calm_regime" ? "calm-pair crash rule (in range)" : "in-range rug";
  const pnl = rec?.pnl_pct != null ? `${Number(rec.pnl_pct).toFixed(2)}%` : "?";
  return `[GRACE_RUG_PAUSED] ${pair}: ${what} not applied at pnl ${pnl}${rec?.bin != null ? `, bin ${rec.bin}` : ""} — profit grace, ${rec?.grace_remaining_min ?? "?"} min left (profitGraceRugMode=${mode})${rec?.reason ? ` — ${rec.reason}` : ""}`;
}
