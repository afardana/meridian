// rule-mode.js: one parser for the rule mode keys (2026-11-05 refactor).
// For every key: the allowed set, the fallback for a missing value, the answer for an unknown
// value and the case rule — and, over a grid of raw values, equality with the parse the call
// site used before the refactor (copied verbatim below as LEGACY). For the inline parses that
// used to keep an unknown string (e.g. "bogus") and compare it with "off" / "enforce", LEGACY
// returns the mode that string acted as.
process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import { ruleMode, modeFor, RULE_MODE_SPECS } from "../rule-mode.js";

// ── ruleMode itself ─────────────────────────────────────────────────────────────────────────
const A = ["off", "shadow", "enforce"];
assert.equal(ruleMode(" Enforce ", { allowed: A, fallback: "shadow" }), "enforce"); // default trim-lower
assert.equal(ruleMode("", { allowed: A, fallback: "shadow", unknown: "off" }), "shadow"); // "" is missing by default
assert.equal(ruleMode("   ", { allowed: A, fallback: "shadow", unknown: "off" }), "shadow");
assert.equal(ruleMode(null, { allowed: A, fallback: "x" }), "x");
assert.equal(ruleMode(undefined, { allowed: A, fallback: "x" }), "x");
assert.equal(ruleMode("bogus", { allowed: A, fallback: "shadow", unknown: "off" }), "off");
assert.equal(ruleMode("bogus", { allowed: A, fallback: "shadow" }), "shadow"); // unknown defaults to fallback
assert.equal(ruleMode("", { allowed: A, fallback: "enforce", unknown: "shadow", missing: "nullish" }), "shadow");
assert.equal(ruleMode(0, { allowed: A, fallback: "off", unknown: "x", missing: "falsy", normalize: "lower" }), "off");
assert.equal(ruleMode(["off"], { allowed: A, fallback: "s", normalize: "strict" }), "s"); // strict: no coercion
assert.equal(ruleMode(["off"], { allowed: A, fallback: "s", normalize: "string" }), "off"); // String(["off"])
assert.equal(ruleMode("OFF", { allowed: A, fallback: "s", normalize: "string" }), "s");
assert.equal(ruleMode("OFF", { allowed: A, fallback: "s", normalize: "lower" }), "off");
assert.equal(ruleMode(" off", { allowed: A, fallback: "s", normalize: "lower" }), "s"); // lower does not trim
assert.throws(() => ruleMode("off", { allowed: [], fallback: "s" }));
assert.throws(() => ruleMode("off", { allowed: A, fallback: "s", normalize: "nope" }));
assert.throws(() => modeFor("notAKey", "off"));
assert.equal(modeFor("closeAuditGroupMode", "bogus", { fallback: "off" }), "off");

// ── per key: allowed set, fallback (missing), unknown value, case rule ────────────────────────
const KEYS = {
  //                                allowed                              missing      unknown     case-insensitive
  profitGraceStopLossMode:         [["paused", "active"],                "paused",    "paused",   false],
  graceEarlyReleaseMode:           [["off", "shadow"],                   "shadow",    "shadow",   false],
  closeAuditGroupMode:             [["off", "shadow", "enforce"],        "shadow",    "shadow",   false],
  intelYieldWindowMode:            [["legacy", "log"],                   "legacy",    "legacy",   true],
  hiveMindPullMode:                [["auto", "manual"],                  "auto",      "auto",     false],
  rugPersistMode:                  [["off", "enforce"],                  "enforce",   "enforce",  false],
  firstEntryProbationMode:         [["off", "shadow", "enforce"],        "shadow",    "shadow",   false],
  maxHoldMode:                     [["off", "shadow", "enforce"],        "shadow",    "shadow",   false],
  maxHoldEvolveMode:               [["off", "shadow", "enforce"],        "shadow",    "shadow",   false],
  tvlFloorExitMode:                [["off", "shadow", "enforce"],        "enforce",   "shadow",   false],
  holdThinPoolLimitMode:           [["off", "shadow", "enforce"],        "enforce",   "shadow",   false],
  pumpGateMode:                    [["off", "shadow", "enforce"],        "shadow",    "shadow",   false],
  reentryGateMode:                 [["off", "shadow", "enforce"],        "shadow",    "shadow",   false],
  feeEdgeGateMode:                 [["off", "shadow"],                   "shadow",    "shadow",   false],
  crashSocketMode:                 [["off", "shadow"],                   "shadow",    "shadow",   false],
  crashRegimeMode:                 [["off", "shadow", "enforce"],        "shadow",    "shadow",   false],
  crashRegimeBelowMode:            [["off", "shadow", "enforce"],        "shadow",    "shadow",   false],
  harvestStraddleMode:             [["off", "shadow", "enforce"],        "shadow",    "shadow",   true],
  harvestStraddleTrendCeilingMode: [["off", "shadow", "enforce"],        "shadow",    "shadow",   true],
  holdDownsideMode:                [["off", "shadow"],                   "shadow",    "shadow",   false],
  adoptionPnlShadowMode:           [["off", "shadow"],                   "shadow",    "shadow",   false],
  rugFilterMode:                   [["off", "log_only", "enforce"],      "off",       "log_only", true],
  criFilterMode:                   [["off", "log_only", "enforce"],      "log_only",  "log_only", true],
};
assert.deepEqual(Object.keys(RULE_MODE_SPECS).sort(), Object.keys(KEYS).sort());
for (const [key, [allowed, missing, unknown, ci]] of Object.entries(KEYS)) {
  assert.deepEqual([...RULE_MODE_SPECS[key].allowed], allowed, `${key} allowed`);
  for (const v of allowed) assert.equal(modeFor(key, v), v, `${key} ${v}`);
  assert.equal(modeFor(key, null), missing, `${key} null`);
  assert.equal(modeFor(key, undefined), missing, `${key} undefined`);
  assert.equal(modeFor(key, "bogus"), unknown, `${key} unknown`);
  const upper = allowed[allowed.length - 1].toUpperCase();
  assert.equal(modeFor(key, upper), ci ? allowed[allowed.length - 1] : unknown, `${key} case (${upper})`);
  assert.equal(modeFor(key, ` ${allowed[0]}`), unknown, `${key} is not trimmed`);
}

// ── equality with the pre-refactor parses ─────────────────────────────────────────────────────
// Effective mode of an inline String(x ?? "shadow") parse read as !== "off" / === "enforce".
const effOSE = (m) => (m === "off" ? "off" : m === "enforce" ? "enforce" : "shadow");
const effOS = (m) => (m === "off" ? "off" : "shadow");
const effRug = (m) => (m === "off" ? "off" : m === "enforce" ? "enforce" : "log_only");
function sanitizeText(text, maxLen = 400) { // hivemind.js, verbatim
  if (text == null) return null;
  const cleaned = String(text).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").replace(/[<>`]/g, "").trim().slice(0, maxLen);
  return cleaned || null;
}
const LEGACY = {
  profitGraceStopLossMode: (x) => (x === "active" ? "active" : "paused"),
  graceEarlyReleaseMode: (x) => (x === "off" ? "off" : "shadow"),
  closeAuditGroupMode: (x) => (["off", "shadow", "enforce"].includes(x) ? x : "shadow"),
  intelYieldWindowMode: (x) => { const m = String(x ?? "legacy").toLowerCase(); return m === "log" ? "log" : "legacy"; },
  hiveMindPullMode: (x) => { const m = sanitizeText(x || "auto", 20) || "auto"; return m === "manual" ? "manual" : "auto"; },
  rugPersistMode: (x) => (["off", "enforce"].includes(x) ? x : "enforce"),
  firstEntryProbationMode: (x) => (["off", "shadow", "enforce"].includes(x) ? x : "shadow"),
  tvlFloorExitMode: (x) => (["off", "shadow", "enforce"].includes(x) ? x : (x == null ? "enforce" : "shadow")),
  holdThinPoolLimitMode: (x) => (["off", "shadow", "enforce"].includes(x) ? x : (x == null ? "enforce" : "shadow")),
  pumpGateMode: (x) => effOSE(String(x ?? "shadow")),
  reentryGateMode: (x) => effOSE(String(x ?? "shadow")),
  feeEdgeGateMode: (x) => effOS(String(x ?? "shadow")),
  crashSocketMode: (x) => effOS(String(x ?? "shadow")),
  crashRegimeMode: (x) => effOSE(String(x ?? "shadow")),
  crashRegimeBelowMode: (x) => effOSE(String(x ?? "shadow")),
  harvestStraddleMode: (x) => effOSE(String(x ?? "shadow").toLowerCase()),
  harvestStraddleTrendCeilingMode: (x) => effOSE(String(x ?? "shadow").toLowerCase()),
  holdDownsideMode: (x) => effOS(String(x ?? "shadow")),
  adoptionPnlShadowMode: (x) => effOS(String(x ?? "shadow")),
  rugFilterMode: (x) => effRug(String(x || "off").toLowerCase()),
  criFilterMode: (x) => effRug(String(x || "log_only").toLowerCase()),
};
const RAW = [
  null, undefined, "", " ", 0, 1, false, true, NaN, ["off"], {},
  "off", "shadow", "enforce", "paused", "active", "legacy", "log", "auto", "manual", "log_only",
  "OFF", "Shadow", "ENFORCE", "Active", "LOG", "Manual", "LOG_ONLY", " off", "enforce ", " manual ",
  "bogus", "on", "enforced", "of",
];
for (const [key, legacy] of Object.entries(LEGACY)) {
  // hivemind.js sanitizes before parsing; the other sites hand the raw value over.
  const parse = key === "hiveMindPullMode" ? (x) => modeFor(key, sanitizeText(x || "auto", 20)) : (x) => modeFor(key, x);
  for (const x of RAW) assert.equal(parse(x), legacy(x), `${key}(${String(x)})`);
}

// ── the exported parsers use it ───────────────────────────────────────────────────────────────
const { profitGraceStopLossMode } = await import("../state.js");
const { graceEarlyReleaseMode } = await import("../grace-release-shadow.js");
const { normalizeGroupMode } = await import("../close-audit-group.js");
const { resolveYieldWindowMode } = await import("../intel-score.js");
const { rugPersistConfig } = await import("../rug-latch.js");
const { firstEntryProbationConfig } = await import("../first-entry-probation.js");
const { tvlFloorExitConfig } = await import("../tvl-floor-exit.js");
const { holdThinLimitConfig } = await import("../hold-thin-limit.js");
const { getRugFilterConfig } = await import("../rug-signals.js");
const { evaluateFeeEdgeGate } = await import("../fee-edge.js");
const { evaluateTrendCeiling } = await import("../harvest-straddle.js");
for (const x of RAW) {
  assert.equal(profitGraceStopLossMode({ profitGraceStopLossMode: x }), LEGACY.profitGraceStopLossMode(x));
  assert.equal(graceEarlyReleaseMode({ graceEarlyReleaseMode: x }), LEGACY.graceEarlyReleaseMode(x));
  assert.equal(normalizeGroupMode(x), LEGACY.closeAuditGroupMode(x));
  assert.equal(normalizeGroupMode(x, "off"), ["off", "shadow", "enforce"].includes(x) ? x : "off");
  assert.equal(rugPersistConfig({ rugPersistMode: x }).mode, LEGACY.rugPersistMode(x));
  assert.equal(firstEntryProbationConfig({ firstEntryProbationMode: x }).mode, LEGACY.firstEntryProbationMode(x));
  assert.equal(tvlFloorExitConfig({ tvlFloorExitMode: x }).mode, LEGACY.tvlFloorExitMode(x));
  assert.equal(holdThinLimitConfig({ holdThinPoolLimitMode: x }).mode, LEGACY.holdThinPoolLimitMode(x));
  assert.equal(getRugFilterConfig({ rugFilterMode: x }).mode, LEGACY.rugFilterMode(x));
  assert.equal(getRugFilterConfig({ criFilterMode: x }).criFilterMode, LEGACY.criFilterMode(x));
  assert.equal(evaluateFeeEdgeGate(1, { feeEdgeGateMode: x }).wouldSkip, LEGACY.feeEdgeGateMode(x) === "off" ? null : true);
  assert.equal(evaluateTrendCeiling({ netGainPct: 20 }, { harvestStraddleTrendCeilingMode: x }).wouldSkip, LEGACY.harvestStraddleTrendCeilingMode(x) !== "off");
}
for (const x of RAW) {
  if (x == null) continue; // null / undefined fall through to config.screening (the ?? chain)
  assert.equal(resolveYieldWindowMode(x), LEGACY.intelYieldWindowMode(x));
}
console.log("rule-mode: ok");
