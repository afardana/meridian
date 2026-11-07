// rule-mode.js — one parser for the rule "mode" keys (off | shadow | enforce and friends).
//
// Leaf module (no imports). Every mode key used to be parsed at its own call site, with its own
// coercion and its own answer for a missing or unknown value. Those answers DIFFER BY DESIGN
// and are kept exactly as they were (2026-11-05 refactor; no rule changes behaviour):
//   - rugPersistMode: missing / unknown → enforce (the latch has no shadow stage);
//   - tvlFloorExitMode / holdThinPoolLimitMode: ABSENT → enforce (operator asked for them live),
//     a present but unknown value → shadow (a typo must never enforce);
//   - rugFilterMode: missing → off, but an unknown string acted like log_only (it is neither
//     "off" nor "enforce" where it is read), so unknown → log_only;
//   - profitGraceStopLossMode: anything but "active" → paused;
//   - most of the others: missing / unknown → shadow.
// Case handling is kept per key too: most keys are case-sensitive ("ENFORCE" does NOT enforce),
// five are lower-cased before the comparison (harvestStraddleMode,
// harvestStraddleTrendCeilingMode, intelYieldWindowMode, rugFilterMode, criFilterMode). No key
// is trimmed by its parser (hiveMindPullMode's input is trimmed by hivemind.js sanitizeText
// first); the default normalisation ("trim-lower") is only for new keys.
//
// test/rule-mode.test.js pins every key's allowed set, fallback, unknown value and case rule.

/**
 * ruleMode(raw, { allowed, fallback, unknown, normalize, missing })
 *   allowed:   the valid modes (a valid value is returned as normalised)
 *   fallback:  returned for a missing value
 *   unknown:   returned for a present value outside `allowed` (default: fallback)
 *   normalize: "trim-lower" (default) | "lower" (String().toLowerCase(), no trim) |
 *              "string" (String(), case-sensitive) | "strict" (no coercion at all)
 *   missing:   "empty" (default: null / undefined / "" after normalising) | "nullish" (null /
 *              undefined only — "" is an unknown value) | "falsy" (any falsy value)
 */
export function ruleMode(raw, { allowed, fallback, unknown = fallback, normalize = "trim-lower", missing = "empty" } = {}) {
  if (!Array.isArray(allowed) || allowed.length === 0) throw new TypeError("ruleMode: allowed must be a non-empty array");
  if (missing === "falsy" ? !raw : raw == null) return fallback;
  let v;
  switch (normalize) {
    case "strict": v = raw; break;
    case "string": v = String(raw); break;
    case "lower": v = String(raw).toLowerCase(); break;
    case "trim-lower": v = String(raw).trim().toLowerCase(); break;
    default: throw new TypeError(`ruleMode: unknown normalize "${normalize}"`);
  }
  if (missing === "empty" && v === "") return fallback;
  return allowed.includes(v) ? v : unknown;
}

const OSE = Object.freeze(["off", "shadow", "enforce"]);
const OS = Object.freeze(["off", "shadow"]);
const spec = (s) => Object.freeze(s);

// Per key: the parse each call site used before 2026-11-05, written as a ruleMode spec.
// (The code DEFAULT a key gets in config.js when user-config.json lacks it is a separate thing
// and is noted where it differs from the parser's fallback.)
export const RULE_MODE_SPECS = Object.freeze({
  // state.js profitGraceStopLossMode(); config.js load. Was: === "active" ? "active" : "paused".
  profitGraceStopLossMode: spec({ allowed: Object.freeze(["paused", "active"]), fallback: "paused", normalize: "strict" }),
  // grace-release-shadow.js graceEarlyReleaseMode() + config.js load. Was: === "off" ? "off" : "shadow"
  // (enforce is not built, so it reads as shadow).
  graceEarlyReleaseMode: spec({ allowed: OS, fallback: "shadow", normalize: "strict" }),
  // close-audit-group.js normalizeGroupMode(v, fallback) + config.js load: unknown → shadow. The
  // cycle runner (index.js, runGroupAuditCycle) reads an unknown value as off (fallback "off").
  closeAuditGroupMode: spec({ allowed: OSE, fallback: "shadow", normalize: "strict" }),
  // intel-score.js resolveYieldWindowMode(). Was: String(x ?? "legacy").toLowerCase() === "log".
  // (config.js default when the key is absent: "log".)
  intelYieldWindowMode: spec({ allowed: Object.freeze(["legacy", "log"]), fallback: "legacy", normalize: "lower", missing: "nullish" }),
  // hivemind.js getHiveMindPullMode(): the raw value is sanitizeText()-ed first (trims, strips
  // <>` and collapses whitespace); then === "manual" ? "manual" : "auto".
  hiveMindPullMode: spec({ allowed: Object.freeze(["auto", "manual"]), fallback: "auto", normalize: "strict" }),
  // rug-latch.js rugPersistConfig(). Absent / unknown → enforce (there is no shadow stage).
  rugPersistMode: spec({ allowed: Object.freeze(["off", "enforce"]), fallback: "enforce", normalize: "strict" }),
  // first-entry-probation.js firstEntryProbationConfig(). Unknown → shadow.
  firstEntryProbationMode: spec({ allowed: OSE, fallback: "shadow", normalize: "strict" }),
  // max-hold.js maxHoldConfig(). Unknown → shadow (a typo must never enforce).
  maxHoldMode: spec({ allowed: OSE, fallback: "shadow", normalize: "strict" }),
  maxHoldEvolveMode: spec({ allowed: OSE, fallback: "shadow", normalize: "strict" }),
  // tvl-floor-exit.js tvlFloorExitConfig() + config.js load. Absent (null / undefined) → enforce;
  // any other value outside the set ("" included) → shadow.
  tvlFloorExitMode: spec({ allowed: OSE, fallback: "enforce", unknown: "shadow", normalize: "strict", missing: "nullish" }),
  // hold-thin-limit.js holdThinLimitConfig(). Same rule as the TVL exit.
  holdThinPoolLimitMode: spec({ allowed: OSE, fallback: "enforce", unknown: "shadow", normalize: "strict", missing: "nullish" }),
  // tools/screening.js + tools/executor.js. Was: String(x ?? "shadow"), then !== "off" / === "enforce".
  pumpGateMode: spec({ allowed: OSE, fallback: "shadow", normalize: "string", missing: "nullish" }),
  reentryGateMode: spec({ allowed: OSE, fallback: "shadow", normalize: "string", missing: "nullish" }),
  // fee-edge.js evaluateFeeEdgeGate() + tools/executor.js (String(x ?? "shadow"), enforce not
  // built → shadow); config.js load is strict ["off","shadow"].includes(x) ? x : "shadow".
  feeEdgeGateMode: spec({ allowed: OS, fallback: "shadow", normalize: "string", missing: "nullish" }),
  // index.js socket crash twin: String(x ?? "shadow") === "off".
  crashSocketMode: spec({ allowed: OS, fallback: "shadow", normalize: "string", missing: "nullish" }),
  // index.js calm-regime rule: String(x ?? "shadow"), then !== "off" / === "enforce".
  crashRegimeMode: spec({ allowed: OSE, fallback: "shadow", normalize: "string", missing: "nullish" }),
  crashRegimeBelowMode: spec({ allowed: OSE, fallback: "shadow", normalize: "string", missing: "nullish" }),
  // harvest-straddle.js: String(x ?? "shadow").toLowerCase() — case-insensitive ("ENFORCE" enforces).
  harvestStraddleMode: spec({ allowed: OSE, fallback: "shadow", normalize: "lower", missing: "nullish" }),
  harvestStraddleTrendCeilingMode: spec({ allowed: OSE, fallback: "shadow", normalize: "lower", missing: "nullish" }),
  // state.js evaluateHoldDownside() / evaluateAdoptionPnlShadow(): String(x ?? "shadow") === "off"
  // (enforce not built); config.js load is strict ["off","shadow"].includes(x) ? x : "shadow".
  holdDownsideMode: spec({ allowed: OS, fallback: "shadow", normalize: "string", missing: "nullish" }),
  adoptionPnlShadowMode: spec({ allowed: OS, fallback: "shadow", normalize: "string", missing: "nullish" }),
  // rug-signals.js getRugFilterConfig(): String(x || "off").toLowerCase(), read as !== "off" /
  // === "enforce" — so a falsy value is off and an unknown string behaves as log_only.
  // (config.js default when the key is absent: "log_only".)
  rugFilterMode: spec({ allowed: Object.freeze(["off", "log_only", "enforce"]), fallback: "off", unknown: "log_only", normalize: "lower", missing: "falsy" }),
  // rug-signals.js: String(x || "log_only").toLowerCase(), read the same way.
  criFilterMode: spec({ allowed: Object.freeze(["off", "log_only", "enforce"]), fallback: "log_only", normalize: "lower", missing: "falsy" }),
});

/** ruleMode with the key's spec; `overrides` replaces spec fields for one call site. */
export function modeFor(key, raw, overrides = undefined) {
  const s = RULE_MODE_SPECS[key];
  if (!s) throw new Error(`modeFor: unknown mode key ${key}`);
  return ruleMode(raw, overrides ? { ...s, ...overrides } : s);
}
