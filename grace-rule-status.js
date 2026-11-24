// grace-rule-status.js — what the profit-grace log lines say is still running (2026-11-24).
//
// TEXT ONLY. The [ADOPT_GRACE] / [STRADDLE_GRACE] lines and [GRACE_RELEASE] used to name the
// downside rules that keep running inside a profit grace as fixed text ("crash/rug fast
// paths, TVL exit and thin-pool hold limit still active") whatever their modes were — the
// thin-pool hold limit is `off` in production and the calm-pair crash rule can be shadow.
// These helpers read each rule's mode through the same parser the rule itself uses, so the
// line says what the rule will actually do. No rule reads anything from this module.
//
// Leaf-ish: imports only the rules' own config parsers (each a leaf over rule-mode.js).

import { modeFor } from "./rule-mode.js";
import { tvlFloorExitConfig } from "./tvl-floor-exit.js";
import { holdThinLimitConfig } from "./hold-thin-limit.js";
import { rugPersistConfig } from "./rug-latch.js";
import { firstEntryProbationConfig } from "./first-entry-probation.js";

const STATUS = (mode) => (mode === "enforce" ? "active" : mode === "off" ? "off" : "log_only");

/**
 * Downside rules that keep running inside a profit grace, each with the status its own mode
 * gives it: "active" (closes), "log_only" (logs a would-close), "off".
 *   crash fast path      — crashFastPathEnabled (truthy, as index.js reads it; false logs [shadow] lines)
 *   in-range rug         — inRangeRugEnabled (truthy; false logs [RUG_SHADOW]); "latch" when rugPersistMode=enforce
 *   calm-pair crash rule — crashRegimeMode (off | shadow | enforce)
 *   TVL exit             — tvlFloorExitMode
 *   thin-pool hold limit — holdThinPoolLimitMode (held positions only)
 */
export function graceDownsideRuleStatuses(mgmt = {}, { rugPaused = false } = {}) {
  const rugLatched = rugPersistConfig(mgmt).mode === "enforce";
  // rugPaused (grace-rug-pause.js): this position's grace holds back the two in-range rug rules.
  const rugStatus = mgmt?.inRangeRugEnabled ? "active" : "log_only";
  const calmStatus = STATUS(modeFor("crashRegimeMode", mgmt?.crashRegimeMode));
  return [
    { rule: "crash fast path", status: mgmt?.crashFastPathEnabled ? "active" : "log_only" },
    { rule: rugLatched ? "in-range rug latch" : "in-range rug fast path", status: rugPaused && rugStatus === "active" ? "paused" : rugStatus },
    { rule: rugPaused && calmStatus === "active" ? "calm-pair crash rule in range" : "calm-pair crash rule", status: rugPaused && calmStatus === "active" ? "paused" : calmStatus },
    { rule: "TVL exit", status: STATUS(tvlFloorExitConfig(mgmt).mode) },
    { rule: "thin-pool hold limit", status: STATUS(holdThinLimitConfig(mgmt).mode) },
  ];
}

/** The stop-class rules a grace pauses (profitGraceStopLossMode=paused), as configured. */
export function graceStopClassRules(mgmt = {}) {
  const probation = firstEntryProbationConfig(mgmt).mode;
  return [
    { rule: "stop loss", status: "active" },
    ...(mgmt?.youngStopEnabled ? [{ rule: "young-token stop", status: "active" }] : []),
    ...(probation !== "off" ? [{ rule: "first-entry probation", status: STATUS(probation) }] : []),
  ];
}

const joinAnd = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "still active: a, b; log only: c; off: d" (empty groups left out). */
export function formatRuleStatuses(list) {
  const by = (s) => list.filter((x) => x.status === s).map((x) => x.rule);
  const parts = [];
  if (by("paused").length) parts.push(`paused in this grace: ${by("paused").join(", ")}`);
  if (by("active").length) parts.push(`still active: ${by("active").join(", ")}`);
  if (by("log_only").length) parts.push(`log only: ${by("log_only").join(", ")}`);
  if (by("off").length) parts.push(`off: ${by("off").join(", ")}`);
  return parts.join("; ");
}

/** Tail of the [ADOPT_GRACE] / [STRADDLE_GRACE] line. */
export function graceDownsideClause(mgmt = {}, { stopPaused = true, rugPaused = false } = {}) {
  const stops = graceStopClassRules(mgmt);
  const downside = graceDownsideRuleStatuses(mgmt, { rugPaused });
  if (stopPaused) {
    return `${joinAnd(stops.map((s) => s.rule))} paused too; ${formatRuleStatuses(downside)}`;
  }
  return `downside rules ${formatRuleStatuses([...stops, ...downside])}`;
}

/** Middle of the [GRACE_RELEASE] line: "profit-taking rules[ and the …] active from the next valuation". */
export function graceReleaseClause(mgmt = {}, { stopPaused = true, rugPaused = false } = {}) {
  const rug = rugPaused ? " and the in-range rug rules" : "";
  if (!stopPaused) return `profit-taking rules${rug} active from the next valuation`;
  const stops = graceStopClassRules(mgmt).map((s) => (s.status === "log_only" ? `${s.rule} (log only)` : s.rule));
  return `profit-taking rules and the ${stops.join(" / ")}${rug} active from the next valuation`;
}
