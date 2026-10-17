process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
const { trackPosition, updatePnlAndCheckExits, closeTrackedPosition, ensureStateInitialized, getTrackedPosition, releasePositionProfitGrace, isStopPausedByGrace, profitGraceStopLossMode } = await import("../state.js");
await ensureStateInitialized();

// 2026-10-17 (operator): "when the first deploy is under grace, remove the stop loss feature from
// being active. The grace is supposed to let everything happen within the timeframe."
// profitGraceStopLossMode "paused" (default): inside a profit grace (adoption window or a
// straddle's profit_grace_until, not released) the stop loss, young-token stop and first-entry
// probation do not fire. "active" = the old behaviour.

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5, stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 60, youngStopEnabled: true, youngStopPct: -10, firstEntryProbationMode: "enforce" };
const active = { ...mgmt, profitGraceStopLossMode: "active" };
const data = (pnl, over = {}) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100, pnl_quality: "valid", ...over });
const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const done = (P) => { try { closeTrackedPosition(P, "test"); } catch {} };
function captureLogs(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(" ")); };
  try { fn(); } finally { console.error = orig; }
  return lines;
}
function adoptedPos(P, name = "MAN-SOL") {
  trackPosition({ position: P, pool: `POOL_${P}`, pool_name: name, strategy: "manual", amount_sol: 1, initial_value_usd: 1, bin_range: { min: 0, max: 100 }, active_bin: 90, adopted: true });
  return getTrackedPosition(P); // adopted_at = now → 60 min of grace
}
function straddledPos(P, { graceMin = 40, firstEntry = false } = {}) {
  trackPosition({ position: P, pool: `POOL_${P}`, pool_name: "SAPLING-SOL", strategy: "spot", amount_sol: 0.4, initial_value_usd: 0.4, bin_range: { min: 0, max: 100 }, active_bin: 90, first_entry: firstEntry });
  const pos = getTrackedPosition(P);
  pos.deployed_at = minsAgo(30);
  pos.profit_grace_until = new Date(Date.now() + graceMin * 60_000).toISOString();
  return pos;
}

test("adoption grace: the stop loss is held back, logged once, recorded; it fires once the grace ends", () => {
  const P = `GSP_A_${Date.now()}`;
  try {
    adoptedPos(P);
    assert.equal(isStopPausedByGrace(getTrackedPosition(P), mgmt), true);
    let lines = captureLogs(() => assert.equal(updatePnlAndCheckExits(P, data(-16.2), mgmt), null));
    const hit = lines.filter((l) => l.includes("[GRACE_STOP_PAUSED]"));
    assert.equal(hit.length, 1);
    assert.match(hit[0], /\[GRACE_STOP_PAUSED\] MAN-SOL: stop loss -16\.20% ≤ -15% not applied — profit grace, 60 min left \(profitGraceStopLossMode=paused\)/);
    lines = captureLogs(() => assert.equal(updatePnlAndCheckExits(P, data(-21), mgmt), null));
    assert.ok(!lines.some((l) => l.includes("[GRACE_STOP_PAUSED]")), "once per position");
    const rec = getTrackedPosition(P).grace_stop_paused;
    assert.equal(rec.rule, "stop_loss"); assert.equal(rec.pnl_pct, -16.2); assert.equal(rec.worst_pnl_pct, -21); assert.equal(typeof rec.first_at, "string");
    // Grace over → the next reading applies the stop normally.
    getTrackedPosition(P).adopted_at = minsAgo(61);
    assert.equal(updatePnlAndCheckExits(P, data(-16), mgmt)?.action, "STOP_LOSS");
  } finally { done(P); }
});

test("a manual release (profit_grace_released_at) ends the pause at once", () => {
  const P = `GSP_R_${Date.now()}`;
  try {
    adoptedPos(P);
    assert.equal(updatePnlAndCheckExits(P, data(-16), mgmt), null);
    const lines = captureLogs(() => assert.equal(releasePositionProfitGrace(P, mgmt).was_active, true));
    assert.ok(lines.some((l) => l.includes("[GRACE_RELEASE]") && l.includes("profit-taking rules and the stop loss / young stop / first-entry probation active from the next valuation")));
    assert.equal(isStopPausedByGrace(getTrackedPosition(P), mgmt), false);
    assert.equal(updatePnlAndCheckExits(P, data(-16), mgmt)?.action, "STOP_LOSS");
  } finally { done(P); }
});

test("straddle grace: stop loss, young stop and first-entry probation are all held back", () => {
  const P = `GSP_S_${Date.now()}`;
  try {
    const pos = straddledPos(P, { firstEntry: true });
    pos.token_age_hours_at_deploy = 2;
    pos.young_stop_violated_since = new Date(Date.now() - 20_000).toISOString();
    const lines = captureLogs(() => {
      assert.equal(updatePnlAndCheckExits(P, data(-10.4), mgmt), null, "young stop + probation held back");
      assert.equal(updatePnlAndCheckExits(P, data(-15.5), mgmt), null, "stop loss held back");
    });
    const hit = lines.filter((l) => l.includes("[GRACE_STOP_PAUSED]"));
    assert.equal(hit.length, 1, "once per position, at the first held-back rule");
    assert.match(hit[0], /SAPLING-SOL: young-token stop -10\.40% ≤ -10% not applied — profit grace, 40 min left/);
    assert.equal(getTrackedPosition(P).young_stop_violated_since, null, "no confirmation timer runs inside the grace");
    assert.equal(getTrackedPosition(P).grace_stop_paused.worst_pnl_pct, -15.5);
    // Grace over: young stop restarts its 15 s confirmation; probation fires first meanwhile.
    getTrackedPosition(P).profit_grace_until = minsAgo(1);
    assert.equal(updatePnlAndCheckExits(P, data(-10.4), mgmt)?.action, "FIRST_ENTRY_PROBATION");
  } finally { done(P); }
  const Q = `GSP_S2_${Date.now()}`;
  try {
    straddledPos(Q);
    assert.equal(updatePnlAndCheckExits(Q, data(-15.5), mgmt), null);
    getTrackedPosition(Q).profit_grace_until = minsAgo(1);
    assert.equal(updatePnlAndCheckExits(Q, data(-15.5), mgmt)?.action, "STOP_LOSS");
  } finally { done(Q); }
});

test("mode active restores the old behaviour: every stop fires inside the grace", () => {
  assert.equal(profitGraceStopLossMode({}), "paused");
  assert.equal(profitGraceStopLossMode({ profitGraceStopLossMode: "bogus" }), "paused");
  assert.equal(profitGraceStopLossMode({ profitGraceStopLossMode: "active" }), "active");
  const A = `GSP_M1_${Date.now()}`;
  try {
    adoptedPos(A);
    assert.equal(isStopPausedByGrace(getTrackedPosition(A), active), false);
    const lines = captureLogs(() => assert.equal(updatePnlAndCheckExits(A, data(-16), active)?.action, "STOP_LOSS"));
    assert.ok(!lines.some((l) => l.includes("[GRACE_STOP_PAUSED]")));
    assert.ok(lines.some((l) => l.includes("[ADOPT_GRACE]") && l.includes("downside rules (stop loss, crash/rug) still active")));
  } finally { done(A); }
  const S = `GSP_M2_${Date.now()}`;
  try {
    straddledPos(S, { firstEntry: true });
    assert.equal(updatePnlAndCheckExits(S, data(-9), active)?.action, "FIRST_ENTRY_PROBATION");
  } finally { done(S); }
  const Y = `GSP_M3_${Date.now()}`;
  try {
    const pos = straddledPos(Y);
    pos.token_age_hours_at_deploy = 2;
    pos.young_stop_violated_since = new Date(Date.now() - 20_000).toISOString();
    assert.equal(updatePnlAndCheckExits(Y, data(-11), active)?.action, "YOUNG_STOP");
  } finally { done(Y); }
});

test("the grace log names what is paused; bot positions without a grace are untouched", () => {
  const P = `GSP_L_${Date.now()}`;
  try {
    const lines = captureLogs(() => { adoptedPos(P); updatePnlAndCheckExits(P, data(0), mgmt); });
    assert.ok(lines.some((l) => l.includes("[ADOPT_GRACE]") && l.includes("stop loss, young-token stop and first-entry probation paused too; crash/rug fast paths, TVL exit and thin-pool hold limit still active")));
  } finally { done(P); }
  const B = `GSP_B_${Date.now()}`;
  try {
    trackPosition({ position: B, pool: "POOL_B", pool_name: "BOT-SOL", strategy: "spot", amount_sol: 0.4, bin_range: { min: 0, max: 100 }, active_bin: 90 });
    assert.equal(updatePnlAndCheckExits(B, data(-15.1), mgmt)?.action, "STOP_LOSS");
  } finally { done(B); }
});

test("crash / rug / calm-regime paths, TVL exit and thin-pool hold limit do not consult the pause", () => {
  // They are built outside the evaluator (index.js poller / management cycle, hold branches).
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(idx, /isStopPausedByGrace|profitGraceStopLossMode|grace_stop_paused/);
  for (const f of ["../rug-latch.js", "../crash-regime.js", "../tvl-floor-exit.js", "../hold-thin-limit.js"]) {
    assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), "utf8"), /profitGraceStopLossMode|isStopPausedByGrace/, f);
  }
  // Inside state.js the pause is read only by the evaluator's stop-class rules (and the logs).
  const st = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
  const uses = st.split("\n").filter((l) => /\bstopPaused\b/.test(l) && !l.trim().startsWith("//"));
  assert.ok(uses.length >= 4 && uses.length <= 6, `stopPaused read in ${uses.length} lines`);
  const dl = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal((dl.match(/grace_stop_paused: (tracked|snapshot)\.grace_stop_paused/g) || []).length, 3, "three perf-record sites");
});
