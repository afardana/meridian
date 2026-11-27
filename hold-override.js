/**
 * The one way an automatic close gets through the HOLD guards (2026-10-11).
 *
 * Three rules close a held position: the TVL exit (tvl-floor-exit.js), the thin-pool hold
 * limit (hold-thin-limit.js) and the operator-armed flow guard (flow-guard.js, 2026-11-27).
 * All use this single authorisation, checked identically at the
 * three guards (index.js executeManagementActions, tools/executor.js close_position,
 * tools/dlmm.js closePositionUnchecked). A close passes only when ALL hold:
 *   - the caller asked for it by rule name (`hold_override: "tvl_floor" | "hold_limit" | "flow_guard"`);
 *   - that rule is in enforce mode right now;
 *   - the position carries that rule's confirmation stamp (written by the rule itself, in
 *     process, after its own proof completed), and the stamp is at most HOLD_OVERRIDE_TTL_MS old.
 * So the argument alone — e.g. set by a model in tool args — opens nothing, a stale stamp
 * opens nothing, a stamp of one rule does not serve the other, and `hold_mode` is never toggled.
 * A position the operator marked hands-off (hands-off.js, 2026-11-27) opens for neither the TVL
 * exit nor the thin-pool limit while that is in force, whatever stamp it carries. The flow
 * guard is the exception (`overridesHandsOff`): it exists only because the operator armed it on
 * that one position, so it is the operator's explicit instruction; its stamp is valid only while
 * the guard is still armed (`flow_guard.armed_at`), so disarming closes the door at once.
 */
import { tvlFloorExitConfig, TVL_FLOOR_CONFIRM_TTL_MS, TVL_FLOOR_HOLD_OVERRIDE } from "./tvl-floor-exit.js";
import { holdThinLimitConfig, HOLD_LIMIT_HOLD_OVERRIDE } from "./hold-thin-limit.js";
import { handsOffActive } from "./hands-off.js";
import { FLOW_GUARD_HOLD_OVERRIDE, flowGuardMode } from "./flow-guard.js";

/** How long a confirmation lets a close through the HOLD guards (one value for every rule). */
export const HOLD_OVERRIDE_TTL_MS = TVL_FLOOR_CONFIRM_TTL_MS;

/** rule name → where its stamp lives on the tracked position, and whether it is enforcing. */
export const HOLD_OVERRIDE_RULES = Object.freeze({
  [TVL_FLOOR_HOLD_OVERRIDE]: Object.freeze({
    label: "TVL exit",
    stampOf: (tracked) => tracked?.tvl_floor_exit?.confirmed_at ?? null,
    enforcing: (mgmt) => tvlFloorExitConfig(mgmt).mode === "enforce",
  }),
  [HOLD_LIMIT_HOLD_OVERRIDE]: Object.freeze({
    label: "thin-pool hold limit",
    stampOf: (tracked) => tracked?.hold_thin_limit?.streak?.confirmed_at ?? null,
    enforcing: (mgmt) => holdThinLimitConfig(mgmt).mode === "enforce",
  }),
  [FLOW_GUARD_HOLD_OVERRIDE]: Object.freeze({
    label: "flow guard",
    // The stamp counts only while the guard is armed (disarm clears it anyway).
    stampOf: (tracked) => (tracked?.flow_guard?.armed_at ? tracked?.flow_guard?.confirmed_at ?? null : null),
    // Arming the position is the enforcement; the global kill switch flowGuardMode=off refuses it.
    enforcing: (mgmt) => flowGuardMode(mgmt) === "armed",
    overridesHandsOff: true,
  }),
});

/**
 * @param {object|null} tracked    the tracked position
 * @param {object} mgmt            config.management
 * @param {*} requested            the `hold_override` value the caller passed
 * @returns {boolean}
 */
export function holdOverrideActive(tracked, mgmt, requested, nowMs = Date.now()) {
  if (typeof requested !== "string" || !Object.prototype.hasOwnProperty.call(HOLD_OVERRIDE_RULES, requested)) return false;
  const rule = HOLD_OVERRIDE_RULES[requested];
  // Operator hands-off: no rule overrides this hold, except the operator's own flow guard.
  if (handsOffActive(tracked, nowMs) && rule.overridesHandsOff !== true) return false;
  if (!rule.enforcing(mgmt)) return false;
  const stamp = rule.stampOf(tracked);
  const at = stamp ? new Date(stamp).getTime() : NaN;
  return Number.isFinite(at) && nowMs >= at && nowMs - at <= HOLD_OVERRIDE_TTL_MS;
}

/** For the guard's log line: which rule opened it, and when it was confirmed. */
export function describeHoldOverride(tracked, requested) {
  const rule = typeof requested === "string" && Object.prototype.hasOwnProperty.call(HOLD_OVERRIDE_RULES, requested) ? HOLD_OVERRIDE_RULES[requested] : null;
  return rule ? `${rule.label} confirmed ${rule.stampOf(tracked)}` : "no rule";
}
