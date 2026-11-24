process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";

// 2026-11-24: the profit-grace log lines name each downside rule with the status its own mode
// gives it, instead of a fixed "crash/rug fast paths, TVL exit and thin-pool hold limit still
// active" (the thin-pool hold limit is off in production). Text only.
const G = await import("../grace-rule-status.js");

const PROD = {
  crashFastPathEnabled: true, inRangeRugEnabled: true, rugPersistMode: "enforce", crashRegimeMode: "enforce",
  tvlFloorExitMode: "enforce", holdThinPoolLimitMode: "off", youngStopEnabled: true, firstEntryProbationMode: "shadow",
};

test("statuses follow each rule's own parser", () => {
  const st = (m) => Object.fromEntries(G.graceDownsideRuleStatuses(m).map((x) => [x.rule, x.status]));
  assert.deepEqual(st(PROD), {
    "crash fast path": "active", "in-range rug latch": "active", "calm-pair crash rule": "active",
    "TVL exit": "active", "thin-pool hold limit": "off",
  });
  // absent keys: crash / rug flags falsy (log only), crashRegimeMode → shadow, TVL exit and hold limit absent → enforce
  assert.deepEqual(st({}), {
    "crash fast path": "log_only", "in-range rug latch": "log_only", "calm-pair crash rule": "log_only",
    "TVL exit": "active", "thin-pool hold limit": "active",
  });
  // a typo in a mode key reads as that parser's unknown value (shadow), never enforce
  const typo = st({ ...PROD, tvlFloorExitMode: "ENFORCE", holdThinPoolLimitMode: "bogus", crashRegimeMode: "off" });
  assert.equal(typo["TVL exit"], "log_only");
  assert.equal(typo["thin-pool hold limit"], "log_only");
  assert.equal(typo["calm-pair crash rule"], "off");
  assert.ok("in-range rug fast path" in st({ ...PROD, rugPersistMode: "off" }), "rugPersistMode=off names the immediate fast path");
});

test("[ADOPT_GRACE] / [STRADDLE_GRACE] tail per mode", () => {
  assert.equal(G.graceDownsideClause(PROD, { stopPaused: true }),
    "stop loss, young-token stop and first-entry probation paused too; still active: crash fast path, in-range rug latch, calm-pair crash rule, TVL exit; off: thin-pool hold limit");
  assert.equal(G.graceDownsideClause(PROD, { stopPaused: false }),
    "downside rules still active: stop loss, young-token stop, crash fast path, in-range rug latch, calm-pair crash rule, TVL exit; log only: first-entry probation; off: thin-pool hold limit");
  assert.equal(G.graceDownsideClause({ ...PROD, youngStopEnabled: false, firstEntryProbationMode: "off", tvlFloorExitMode: "shadow", crashRegimeMode: "shadow" }, { stopPaused: true }),
    "stop loss paused too; still active: crash fast path, in-range rug latch; log only: calm-pair crash rule, TVL exit; off: thin-pool hold limit");
  assert.equal(G.graceDownsideClause({ ...PROD, holdThinPoolLimitMode: "enforce" }, { stopPaused: true }),
    "stop loss, young-token stop and first-entry probation paused too; still active: crash fast path, in-range rug latch, calm-pair crash rule, TVL exit, thin-pool hold limit");
});

test("[GRACE_RELEASE] middle per mode", () => {
  assert.equal(G.graceReleaseClause(PROD, { stopPaused: true }), "profit-taking rules and the stop loss / young-token stop / first-entry probation (log only) active from the next valuation");
  assert.equal(G.graceReleaseClause({ ...PROD, firstEntryProbationMode: "enforce" }, { stopPaused: true }), "profit-taking rules and the stop loss / young-token stop / first-entry probation active from the next valuation");
  assert.equal(G.graceReleaseClause({ ...PROD, youngStopEnabled: false, firstEntryProbationMode: "off" }, { stopPaused: true }), "profit-taking rules and the stop loss active from the next valuation");
  assert.equal(G.graceReleaseClause(PROD, { stopPaused: false }), "profit-taking rules active from the next valuation");
});

// Through state.js: the log line carries the mode-aware text, and the exit decision is the
// same whatever the modes say (the text helpers are not read by any rule).
const { trackPosition, updatePnlAndCheckExits, closeTrackedPosition, ensureStateInitialized, getTrackedPosition, releasePositionProfitGrace } = await import("../state.js");
await ensureStateInitialized();
function captureLogs(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(" ")); };
  try { fn(); } finally { console.error = orig; }
  return lines;
}
const base = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 60 };
const data = (pnl) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100, pnl_quality: "valid" });

test("state.js logs the mode-aware clause; the evaluator's decisions do not depend on it", () => {
  const P = `GRS_${Date.now()}`;
  const Q = `GRS2_${Date.now()}`;
  try {
    trackPosition({ position: P, pool: `POOL_${P}`, pool_name: "MAN-SOL", strategy: "manual", amount_sol: 1, initial_value_usd: 1, bin_range: { min: 0, max: 100 }, active_bin: 90, adopted: true });
    const mgmt = { ...base, ...PROD };
    let decision;
    const lines = captureLogs(() => { decision = updatePnlAndCheckExits(P, data(-16), mgmt); });
    assert.ok(lines.some((l) => l.includes("[ADOPT_GRACE] MAN-SOL") && l.includes("paused too; paused in this grace: in-range rug latch, calm-pair crash rule in range; still active: crash fast path, TVL exit; off: thin-pool hold limit")), lines.join("\n"));
    assert.equal(decision, null, "stop paused inside the grace");
    const rel = captureLogs(() => releasePositionProfitGrace(P, mgmt));
    assert.ok(rel.some((l) => l.includes("[GRACE_RELEASE]") && l.includes("profit-taking rules and the stop loss / young-token stop / first-entry probation (log only) and the in-range rug rules active from the next valuation")), rel.join("\n"));
    assert.equal(updatePnlAndCheckExits(P, data(-16), mgmt)?.action, "STOP_LOSS");

    // same position shape, every rule mode flipped: identical decisions
    trackPosition({ position: Q, pool: `POOL_${Q}`, pool_name: "MAN2-SOL", strategy: "manual", amount_sol: 1, initial_value_usd: 1, bin_range: { min: 0, max: 100 }, active_bin: 90, adopted: true });
    const flipped = { ...base, crashFastPathEnabled: false, inRangeRugEnabled: false, crashRegimeMode: "off", tvlFloorExitMode: "off", holdThinPoolLimitMode: "enforce", youngStopEnabled: true, firstEntryProbationMode: "shadow" };
    assert.equal(updatePnlAndCheckExits(Q, data(-16), flipped), null);
    releasePositionProfitGrace(Q, flipped);
    assert.equal(updatePnlAndCheckExits(Q, data(-16), flipped)?.action, "STOP_LOSS");
    assert.equal(getTrackedPosition(Q).adopt_grace_logged, true);
  } finally {
    try { closeTrackedPosition(P, "test"); } catch {}
    try { closeTrackedPosition(Q, "test"); } catch {}
  }
});
