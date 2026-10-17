process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
const { trackPosition, updatePnlAndCheckExits, closeTrackedPosition, ensureStateInitialized, getTrackedPosition, setPositionHold, EXIT_FAMILY_BY_ACTION, URGENT_EXIT_ACTIONS } = await import("../state.js");
const { firstEntryFromPerformance, firstEntryProbationConfig, evaluateFirstEntryProbation, firstEntryRecordFields, organicScoreExact75 } = await import("../first-entry-probation.js");
const { exitFamilyFromReason, classifyOutcome } = await import("../lessons.js");
await ensureStateInitialized();

// first-entry-probation.js (2026-10-17): a pool's first entry closes at −8 % within 240 min of
// the deploy; shadow by default. Re-entries, adopted rows, held positions and positions in a
// profit grace are never touched.

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5, stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 60 };
const enforce = { ...mgmt, firstEntryProbationMode: "enforce" };
const data = (pnl, over = {}) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100, pnl_quality: "valid", ...over });
const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

function captureLogs(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(" ")); };
  try { fn(); } finally { console.error = orig; }
  return lines;
}
function track(P, { firstEntry = true, adopted = false, ageMin = 30, organic = 75 } = {}) {
  trackPosition({ position: P, pool: `POOL_${P}`, pool_name: "FIRST-SOL", strategy: "spot", amount_sol: 0.4, initial_value_usd: 0.4, bin_range: { min: 0, max: 100 }, active_bin: 100, organic_score: organic, first_entry: firstEntry, first_entry_strict: firstEntry, organic_score_exact_75: organicScoreExact75(organic), adopted });
  const pos = getTrackedPosition(P);
  pos.deployed_at = minsAgo(ageMin);
  if (adopted) pos.adopted_at = minsAgo(120); // past the adoption grace
  return pos;
}
const done = (P) => { try { closeTrackedPosition(P, "test"); } catch {} };

test("stamping: no bot close in 12 h = first entry; an operator close counts only for the strict flag", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const rec = (pool, minAgo, extra = {}) => ({ pool, recorded_at: new Date(now - minAgo * 60_000).toISOString(), pnl_pct: 1.2, close_reason: "Trailing TP", ...extra });
  const recs = [
    rec("A", 13 * 60),                                    // older than 12 h — not a previous close
    rec("B", 90),                                          // bot close 90 min ago → re-entry
    rec("C", 45, { adopted: true }),                       // operator close only → first entry (replay), not strict
    rec("D", 30, { rebalance_leg: true, close_reason: "rebalance: straddle" }), // a leg is not a close
    rec("E", 20, { pnl_pct: null }),                       // a close without a pnl still counts
    rec("F", -5),                                          // after the deploy — ignored
  ];
  const v = (pool) => firstEntryFromPerformance(recs, pool, now);
  assert.deepEqual(v("A"), { firstEntry: true, firstEntryStrict: true, prevBotCloseGapMin: null, prevAnyCloseGapMin: null });
  assert.equal(v("B").firstEntry, false); assert.equal(v("B").prevBotCloseGapMin, 90);
  assert.deepEqual([v("C").firstEntry, v("C").firstEntryStrict, v("C").prevAnyCloseGapMin], [true, false, 45]);
  assert.equal(v("D").firstEntry, true);
  assert.equal(v("E").firstEntry, false);
  assert.equal(v("F").firstEntry, true);
  assert.equal(v("never").firstEntry, true);
  assert.equal(firstEntryFromPerformance(null, "A").firstEntry, null);
  assert.equal(organicScoreExact75(75), true); assert.equal(organicScoreExact75(74.6), false); assert.equal(organicScoreExact75(null), null);
});

test("stamping: an adopted row is never a first entry; a rebalance child gets no stamp", () => {
  const P = `FEP_ADOPT_${Date.now()}`;
  try {
    const pos = track(P, { adopted: true });
    assert.equal(pos.first_entry, null, "operator deploy: first_entry dropped whatever was passed");
    assert.equal(pos.first_entry_strict, null);
    assert.equal(updatePnlAndCheckExits(P, data(-9), enforce), null, "no probation on an adopted row");
  } finally { done(P); }
  const C = `FEP_CHILD_${Date.now()}`;
  try {
    trackPosition({ position: C, pool: "POOL_C", pool_name: "CHILD-SOL", strategy: "spot", amount_sol: 0.4, bin_range: { min: 0, max: 100 }, active_bin: 100, rebalance_count: 1, parent_position: "PARENT" });
    assert.equal(getTrackedPosition(C).first_entry, null);
  } finally { done(C); }
  // Executor wiring: stamped on new deploys only (never on the rebalance re-check), always written.
  const ex = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(ex, /if \(!existingPosition\) \{\s*try \{\s*const \{ firstEntryFromPerformance, organicScoreExact75 \}/);
  assert.match(ex, /first_entry: null,\s*first_entry_strict: null,\s*organic_score_exact_75: null,/);
  const dl = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal((dl.match(/\.\.\.firstEntryRecordFields\((tracked|snapshot)\)/g) || []).length, 3, "three perf-record sites");
});

test("shadow (default): logs once, records on the position, closes nothing", () => {
  const P = `FEP_SHADOW_${Date.now()}`;
  try {
    track(P, { ageMin: 37 });
    let lines = captureLogs(() => assert.equal(updatePnlAndCheckExits(P, data(-7.9), mgmt), null));
    assert.ok(!lines.some((l) => l.includes("FIRST_ENTRY_PROBATION")), "above the line: nothing");
    lines = captureLogs(() => assert.equal(updatePnlAndCheckExits(P, data(-8.4), mgmt), null, "shadow never closes"));
    const hit = lines.filter((l) => l.includes("[FIRST_ENTRY_PROBATION_SHADOW]"));
    assert.equal(hit.length, 1);
    assert.match(hit[0], /\[FIRST_ENTRY_PROBATION_SHADOW\] would-close FIRST-SOL: pnl -8\.40% ≤ -8% at 37 min \(firstEntryProbationMode=shadow\)/);
    const rec = getTrackedPosition(P).first_entry_probation;
    assert.deepEqual({ ...rec, would_fire_at: typeof rec.would_fire_at }, { would_fire_at: "string", pnl_pct: -8.4, minutes_since_deploy: 37, organic_score: 75, mode: "shadow" });
    lines = captureLogs(() => updatePnlAndCheckExits(P, data(-9.5), mgmt));
    assert.ok(!lines.some((l) => l.includes("[FIRST_ENTRY_PROBATION_SHADOW]")), "once per position");
    assert.equal(getTrackedPosition(P).first_entry_probation.pnl_pct, -8.4, "first would-fire kept");
    // Perf-record fields.
    const f = firstEntryRecordFields(getTrackedPosition(P));
    assert.equal(f.first_entry, true); assert.equal(f.organic_score_exact_75, true); assert.equal(f.first_entry_probation.pnl_pct, -8.4);
    // The plain stop still runs in shadow.
    assert.equal(updatePnlAndCheckExits(P, data(-15.5), mgmt)?.action, "STOP_LOSS");
  } finally { done(P); }
});

test("enforce: fires only inside the window, with the stop-loss exit shape", () => {
  const P = `FEP_ENF_${Date.now()}`;
  try {
    track(P, { ageMin: 100 });
    assert.equal(updatePnlAndCheckExits(P, data(-7.99), enforce), null);
    const exit = updatePnlAndCheckExits(P, data(-8.2), enforce);
    assert.deepEqual([exit?.action, exit?.rule, exit?.family, exit?.urgent, exit?.confirm_ticks], ["FIRST_ENTRY_PROBATION", "probation_stop", "probation_stop", true, null],
      "urgent; confirm_ticks null = the poller's distinct-valuation streak, as the stop loss");
    assert.match(exit.reason, /^First-entry probation: PnL -8\.20% <= -8% at 100 min/);
    assert.equal(exitFamilyFromReason(exit.reason), "probation_stop");
    assert.doesNotMatch(exit.reason.toLowerCase(), /stop loss|below|oor/);
    assert.equal(classifyOutcome({ pnl_pct: -8.2, exit_family: "probation_stop", initial_value_usd: 1, fees_earned_usd: 0 }), "failure");
    assert.equal(EXIT_FAMILY_BY_ACTION.FIRST_ENTRY_PROBATION, "probation_stop");
    assert.ok(URGENT_EXIT_ACTIONS.has("FIRST_ENTRY_PROBATION"));
    assert.equal(getTrackedPosition(P).first_entry_probation.mode, "enforce");
    // Past the window: the probation is over, only the −15 % stop remains.
    getTrackedPosition(P).deployed_at = minsAgo(241);
    assert.equal(updatePnlAndCheckExits(P, data(-12), enforce), null);
    assert.equal(updatePnlAndCheckExits(P, data(-15.2), enforce)?.action, "STOP_LOSS");
    // Tunable window / threshold.
    getTrackedPosition(P).deployed_at = minsAgo(50);
    assert.equal(updatePnlAndCheckExits(P, data(-8.5), { ...enforce, firstEntryProbationMin: 45 }), null);
    assert.equal(updatePnlAndCheckExits(P, data(-8.5), { ...enforce, firstEntryProbationPct: -10 }), null);
  } finally { done(P); }
});

test("never on re-entries, held positions, suspect readings; off does nothing", () => {
  const R = `FEP_RE_${Date.now()}`;
  try {
    track(R, { firstEntry: false });
    assert.equal(updatePnlAndCheckExits(R, data(-12), enforce), null, "re-entry: CRAWL/HIGGS case");
    assert.equal(getTrackedPosition(R).first_entry_probation ?? null, null);
  } finally { done(R); }
  const H = `FEP_HOLD_${Date.now()}`;
  try {
    track(H);
    setPositionHold(H, true, "operator");
    assert.equal(updatePnlAndCheckExits(H, data(-12), enforce), null, "held: the evaluator does not run");
  } finally { done(H); }
  const S = `FEP_SUS_${Date.now()}`;
  try {
    track(S);
    assert.equal(updatePnlAndCheckExits(S, data(-12, { pnl_pct_suspicious: true }), enforce), null, "suspect reading");
    assert.equal(updatePnlAndCheckExits(S, data(-12, { pnl_management_ready: false }), enforce), null, "not management-ready");
    const lines = captureLogs(() => assert.equal(updatePnlAndCheckExits(S, data(-12), { ...mgmt, firstEntryProbationMode: "off" }), null));
    assert.ok(!lines.some((l) => l.includes("FIRST_ENTRY_PROBATION")));
    assert.equal(getTrackedPosition(S).first_entry_probation ?? null, null, "off records nothing");
  } finally { done(S); }
  assert.equal(evaluateFirstEntryProbation({ first_entry: true, deployed_at: minsAgo(5) }, -9, { firstEntryProbationMode: "off" }), null);
});

test("not inside a profit grace (straddle window), and fires once the grace is over", () => {
  const P = `FEP_GRACE_${Date.now()}`;
  try {
    const pos = track(P, { ageMin: 60 });
    pos.profit_grace_until = new Date(Date.now() + 30 * 60_000).toISOString();
    const lines = captureLogs(() => {
      assert.equal(updatePnlAndCheckExits(P, data(-9), enforce), null);
      assert.equal(updatePnlAndCheckExits(P, data(-9), mgmt), null);
    });
    assert.ok(lines.some((l) => l.includes("[GRACE_STOP_PAUSED] FIRST-SOL: first-entry probation -9.00% ≤ -8% not applied — profit grace, 30 min left (profitGraceStopLossMode=paused)")));
    assert.ok(!lines.some((l) => l.includes("[FIRST_ENTRY_PROBATION_SHADOW]")), "no shadow would-fire inside the grace");
    assert.equal(getTrackedPosition(P).first_entry_probation ?? null, null);
    getTrackedPosition(P).profit_grace_until = minsAgo(1);
    assert.equal(updatePnlAndCheckExits(P, data(-9), enforce)?.action, "FIRST_ENTRY_PROBATION");
  } finally { done(P); }
});

test("evaluator order: young stop → first-entry probation → stop loss", () => {
  const P = `FEP_ORD_${Date.now()}`;
  try {
    const pos = track(P);
    pos.token_age_hours_at_deploy = 2;
    pos.young_stop_violated_since = new Date(Date.now() - 20_000).toISOString();
    const both = { ...enforce, youngStopEnabled: true, youngStopPct: -10 };
    assert.equal(updatePnlAndCheckExits(P, data(-16), both)?.action, "YOUNG_STOP", "young stop first");
    getTrackedPosition(P).young_stop_violated_since = null;
    assert.equal(updatePnlAndCheckExits(P, data(-16), enforce)?.action, "FIRST_ENTRY_PROBATION", "probation before the stop loss");
  } finally { done(P); }
  const st = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
  const i1 = st.indexOf("// ── 1. Young-token stop"), i2 = st.indexOf("// ── 1b. First-entry probation"), i3 = st.indexOf("// ── 2. Stop loss");
  assert.ok(i1 > 0 && i1 < i2 && i2 < i3);
});

test("config: unknown mode reads as shadow; pct must be a loss; window floored at 10 min", () => {
  assert.deepEqual(firstEntryProbationConfig({}), { mode: "shadow", pct: -8, min: 240 });
  assert.deepEqual(firstEntryProbationConfig({ firstEntryProbationMode: "bogus", firstEntryProbationPct: 3, firstEntryProbationMin: 2 }), { mode: "shadow", pct: -8, min: 10 });
  assert.deepEqual(firstEntryProbationConfig({ firstEntryProbationMode: "enforce", firstEntryProbationPct: -6, firstEntryProbationMin: 120 }), { mode: "enforce", pct: -6, min: 120 });
});
