process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
const { trackPosition, updatePnlAndCheckExits, closeTrackedPosition, ensureStateInitialized, getTrackedPosition, EXIT_FAMILY_BY_ACTION, URGENT_EXIT_ACTIONS } = await import("../state.js");
const MH = await import("../max-hold.js");
const { exitFamilyFromReason, classifyOutcome, runMaxHoldEvolution, recordMaxHoldCf, getMaxHoldEvolveState } = await import("../lessons.js");
const { buildPerfRecord } = await import("../perf-record.js");
await ensureStateInitialized();

// max-hold.js (2026-11-07): a maximum position duration, shadow by default, with a per-close
// counterfactual (max_hold_cf) and a strictly gated evolver. Nothing here may close a position
// or change a live decision unless maxHoldMode=enforce.

const NOW = Date.parse("2026-11-07T12:00:00Z");
const minsAgo = (m, now = Date.now()) => new Date(now - m * 60_000).toISOString();
const reading = (over = {}) => ({ pnl_pct: 0.84, active_bin: 50, upper_bin: 100, graceRemainingMin: 0, pendingFlow: false, ...over });
const pos = (over = {}) => ({ deployed_at: minsAgo(362, NOW), bin_range: { min: 0, max: 100 }, ...over });

function captureLogs(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(" ")); };
  try { fn(); } finally { console.error = orig; }
  return lines;
}

test("config: modes parse strictly (unknown → shadow), minutes snap to the grid", () => {
  assert.deepEqual(MH.maxHoldConfig({}), { mode: "shadow", minutes: 360, evolveMode: "shadow", appliesToAdopted: false });
  assert.equal(MH.maxHoldConfig({ maxHoldMode: "ENFORCE" }).mode, "shadow", "case-sensitive: a typo never enforces");
  assert.equal(MH.maxHoldConfig({ maxHoldMode: "enforce" }).mode, "enforce");
  assert.equal(MH.maxHoldConfig({ maxHoldEvolveMode: "off" }).evolveMode, "off");
  assert.equal(MH.maxHoldConfig({ maxHoldAppliesToAdopted: "true" }).appliesToAdopted, false, "only a real true");
  assert.deepEqual([100, 240, 300, 301, 420, 600, 1000, 1100, 5000, "x", null].map(MH.nearestGridMinutes), [240, 240, 240, 360, 360, 480, 720, 1440, 1440, 360, 360]);
});

test("evaluateMaxHold: age from deployed_at, fires at the cap, every exclusion returns null", () => {
  const cfg = { maxHoldMode: "shadow", maxHoldMinutes: 360 };
  const d = MH.evaluateMaxHold(pos(), NOW, cfg, reading());
  assert.equal(d.action, "MAX_HOLD"); assert.equal(d.rule, "max_hold"); assert.equal(d.family, "max_hold"); assert.equal(d.urgent, false);
  assert.equal(d.enforce, false, "shadow never enforces");
  assert.equal(Math.round(d.minutesHeld), 362); assert.equal(d.capMin, 360);
  assert.equal(d.reason, "Max hold: 362 min held ≥ 360 min cap at pnl +0.84% (maxHoldMode=shadow)");
  assert.equal(MH.evaluateMaxHold(pos({ deployed_at: minsAgo(359, NOW) }), NOW, cfg, reading()), null, "under the cap");
  // adopted_at is never the age reference
  assert.equal(MH.evaluateMaxHold(pos({ deployed_at: minsAgo(30, NOW), adopted_at: minsAgo(400, NOW) }), NOW, cfg, reading()), null);
  const none = (p, r, c = cfg) => assert.equal(MH.evaluateMaxHold(p, NOW, c, r), null);
  none(pos(), reading(), { maxHoldMode: "off" });
  none(pos({ hold_mode: true }), reading());
  none(pos(), reading({ pnl_management_ready: false }));
  none(pos(), reading({ pnl_pct_suspicious: true }));
  none(pos(), reading({ pnl_pct: null }));
  none(pos(), reading({ graceRemainingMin: 12 }));
  none(pos({ profit_grace_until: minsAgo(-20, NOW) }), reading({ graceRemainingMin: undefined }));
  none(pos(), reading({ active_bin: 101 }), cfg); // above the range: all SOL
  none(pos(), reading({ pendingFlow: true }));
  none(pos({ capital_rebase_pending: { from_sol: 1 } }), reading());
  none(pos({ deployed_at: null }), reading());
  // In range and under the range still fire; an unknown bin is not "above".
  assert.ok(MH.evaluateMaxHold(pos(), NOW, cfg, reading({ active_bin: -5 })));
  assert.ok(MH.evaluateMaxHold(pos(), NOW, cfg, reading({ active_bin: null })));
  // The reason avoids the substrings legacy close-reason scans read as other families.
  assert.doesNotMatch(d.reason.toLowerCase(), /oor|below|floor|above|yield|trailing|stop loss/);
  assert.equal(exitFamilyFromReason(d.reason), "max_hold");
  // Operator positions: log only even in enforce, unless maxHoldAppliesToAdopted.
  const enf = { maxHoldMode: "enforce", maxHoldMinutes: 360 };
  const a = MH.evaluateMaxHold(pos({ adopted: true }), NOW, enf, reading());
  assert.deepEqual([a.enforce, a.logOnly], [false, true]);
  assert.equal(MH.evaluateMaxHold(pos({ adopted: true }), NOW, { ...enf, maxHoldAppliesToAdopted: true }, reading()).enforce, true);
  assert.equal(MH.evaluateMaxHold(pos(), NOW, enf, reading()).enforce, true);
});

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5, stopLossPct: -15, twapGuardEnabled: false, adoptedProfitGraceMinutes: 60 };
const data = (pnl, over = {}) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100, pnl_quality: "valid", ...over });
function track(P, { ageMin = 362, adopted = false } = {}) {
  trackPosition({ position: P, pool: "POOL_MH", pool_name: "LONG-SOL", strategy: "spot", amount_sol: 0.45, initial_value_usd: 0.45, bin_range: { min: 0, max: 100 }, active_bin: 100, adopted });
  const p = getTrackedPosition(P);
  p.deployed_at = minsAgo(ageMin);
  if (adopted) p.adopted_at = minsAgo(ageMin);
  return p;
}
const done = (P) => { try { closeTrackedPosition(P, "test"); } catch {} };

test("evaluator, shadow (default): logs once, records max_hold_shadow, never returns an exit", () => {
  const P = `MH_SHADOW_${Date.now()}`;
  try {
    track(P);
    let lines = captureLogs(() => assert.equal(updatePnlAndCheckExits(P, data(0.84), mgmt), null, "shadow never closes"));
    const hit = lines.filter((l) => l.includes("[MAX_HOLD_SHADOW]"));
    assert.equal(hit.length, 1);
    assert.match(hit[0], /\[MAX_HOLD_SHADOW\] would-close LONG-SOL: 362 min ≥ 360 cap at pnl \+0\.84% \(maxHoldMode=shadow\)/);
    const rec = getTrackedPosition(P).max_hold_shadow;
    assert.deepEqual({ ...rec, would_fire_at: typeof rec.would_fire_at }, { would_fire_at: "string", pnl_pct: 0.84, minutes_held: 362, cap_min: 360, mode: "shadow" });
    lines = captureLogs(() => assert.equal(updatePnlAndCheckExits(P, data(-3.1), mgmt), null));
    assert.ok(!lines.some((l) => l.includes("[MAX_HOLD_SHADOW]")), "once per position");
    assert.equal(getTrackedPosition(P).max_hold_shadow.pnl_pct, 0.84, "first would-fire kept");
    // Perf record: one field, through buildPerfRecord.
    const r = buildPerfRecord({ source: "closed_api", tracked: getTrackedPosition(P), close: { position: P, pool: "POOL_MH", pool_name: "LONG-SOL", minutes_held: 400, minutes_oor: 0 } });
    assert.equal(r.max_hold_shadow.cap_min, 360);
    assert.equal(buildPerfRecord({ source: "closed_api", tracked: {}, close: { position: "x", minutes_held: 1, minutes_oor: 0 } }).max_hold_shadow, null);
    // The other rules keep running in shadow.
    assert.equal(updatePnlAndCheckExits(P, data(-15.5), mgmt)?.action, "STOP_LOSS");
  } finally { done(P); }
});

test("evaluator: shadow changes no exit and no live field compared with off", () => {
  const A = `MH_OFF_${Date.now()}`, B = `MH_SHD_${Date.now()}`;
  try {
    track(A); track(B);
    getTrackedPosition(B).deployed_at = getTrackedPosition(A).deployed_at;
    const seq = [0.5, 0.84, 2.6, 2.9, 3.4, 3.3, 1.2, 0.4, -2, -6, -16];
    for (const v of seq) {
      const ea = updatePnlAndCheckExits(A, data(v), { ...mgmt, maxHoldMode: "off" });
      const eb = updatePnlAndCheckExits(B, data(v), { ...mgmt, maxHoldMode: "shadow" });
      assert.deepEqual(eb, ea, `exit at ${v}`);
    }
    const a = getTrackedPosition(A), b = getTrackedPosition(B);
    assert.equal(a.max_hold_shadow, undefined);
    assert.ok(b.max_hold_shadow);
    const ignore = new Set(["position", "max_hold_shadow", "notes"]);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const differ = [...keys].filter((k) => !ignore.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    assert.deepEqual(differ.filter((k) => !/(_at|_since)$/.test(k)), [], `live fields differ: ${differ.join(", ")}`);
  } finally { done(A); done(B); }
});

test("evaluator, enforce: the exit object; operator positions and HOLD are not closed", () => {
  const P = `MH_ENF_${Date.now()}`;
  const enforce = { ...mgmt, maxHoldMode: "enforce" };
  try {
    track(P, { ageMin: 300 });
    assert.equal(updatePnlAndCheckExits(P, data(0.84), enforce), null, "under the cap");
    getTrackedPosition(P).deployed_at = minsAgo(362);
    const lines = captureLogs(() => {
      const exit = updatePnlAndCheckExits(P, data(0.84), enforce);
      assert.deepEqual([exit?.action, exit?.rule, exit?.family, exit?.urgent, exit?.confirm_ticks], ["MAX_HOLD", "max_hold", "max_hold", false, null],
        "not urgent; confirm_ticks null = the poller's distinct-valuation streak");
      assert.equal(exit.reason, "Max hold: 362 min held ≥ 360 min cap at pnl +0.84% (maxHoldMode=enforce)");
    });
    assert.ok(lines.some((l) => l.includes("[MAX_HOLD] LONG-SOL: 362 min ≥ 360 cap at pnl +0.84% — closing (maxHoldMode=enforce)")));
    assert.equal(getTrackedPosition(P).max_hold_shadow.mode, "enforce");
    assert.equal(EXIT_FAMILY_BY_ACTION.MAX_HOLD, "max_hold");
    assert.ok(!URGENT_EXIT_ACTIONS.has("MAX_HOLD"));
    // Above the range (all SOL): no max-hold exit.
    assert.equal(updatePnlAndCheckExits(P, data(0.84, { active_bin: 104, in_range: false }), enforce), null);
    // HOLD: the evaluator does not run.
    getTrackedPosition(P).hold_mode = true;
    assert.equal(updatePnlAndCheckExits(P, data(0.84), enforce), null);
    getTrackedPosition(P).hold_mode = false;
    // A straddle's profit grace.
    getTrackedPosition(P).profit_grace_until = minsAgo(-30);
    assert.equal(updatePnlAndCheckExits(P, data(0.84), enforce), null);
    getTrackedPosition(P).profit_grace_until = null;
    // Suspect reading.
    assert.equal(updatePnlAndCheckExits(P, data(0.84, { pnl_pct_suspicious: true }), enforce), null);
    // Outcome is graded by pnl like any close.
    assert.equal(classifyOutcome({ pnl_pct: 0.84, exit_family: "max_hold", initial_value_usd: 1, fees_earned_usd: 0 }), "neutral");
    assert.equal(classifyOutcome({ pnl_pct: 3, exit_family: "max_hold", initial_value_usd: 1, fees_earned_usd: 0 }), "success");
    assert.equal(classifyOutcome({ pnl_pct: -6, exit_family: "max_hold", initial_value_usd: 1, fees_earned_usd: 0 }), "failure");
  } finally { done(P); }
  const O = `MH_ADOPT_${Date.now()}`;
  try {
    track(O, { adopted: true, ageMin: 400 });
    const lines = captureLogs(() => assert.equal(updatePnlAndCheckExits(O, data(0.84), enforce), null, "operator position: log only"));
    assert.ok(lines.some((l) => /\[MAX_HOLD_SHADOW\] would-close LONG-SOL: 400 min .* operator position — log only/.test(l)));
    assert.equal(getTrackedPosition(O).max_hold_shadow.log_only, "adopted");
  } finally { done(O); }
});

test("source: max hold sits after LOW_YIELD and before SURGE_DECAY in the single evaluator; wiring present", () => {
  const src = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
  const ly = src.indexOf('action: "LOW_YIELD"'), mh = src.indexOf("evaluateMaxHold(pos,"), sd = src.indexOf('action: "SURGE_DECAY"');
  assert.ok(ly > 0 && mh > ly && sd > mh, `order LOW_YIELD ${ly} < max hold ${mh} < SURGE_DECAY ${sd}`);
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /max_hold: "Max hold"/);
  assert.match(idx, /runMaxHoldCfCapture\(\)\.catch\(/, "detached from the cycle (not awaited)");
  assert.match(idx, /text === "\/maxhold"/);
  const ls = fs.readFileSync(new URL("../lessons.js", import.meta.url), "utf8");
  assert.match(ls, /await runMaxHoldEvolution\(data\.performance, config\)/);
});

// ── counterfactual capture ────────────────────────────────────────────────────────────────────
const CLOSE = Date.parse("2026-11-06T12:00:00Z");
function cfRecord(over = {}) {
  return { position: "CF1", pool_name: "CF-SOL", recorded_at: new Date(CLOSE).toISOString(), minutes_held: 500, pnl_pct: 2, amount_sol: 1, bin_range: { min: 0, max: 68 }, ...over };
}
function ticksFor(rec, fn, { every = 1, skip = () => false } = {}) {
  const start = Date.parse(rec.recorded_at) - rec.minutes_held * 60_000;
  const out = [];
  for (let m = 0; m <= rec.minutes_held; m += every) {
    if (skip(m)) continue;
    const [p, b] = fn(m);
    out.push({ ts: new Date(start + m * 60_000), pnl_pct: p, active_bin: b });
  }
  return out.reverse(); // any order
}

test("computeMaxHoldCf: median of the first 3 readings, state, exit cost, affected", () => {
  const rec = cfRecord();
  const ticks = ticksFor(rec, (m) => [m / 100, m >= 470 ? 70 : m >= 400 ? -5 : 34], { skip: (m) => m > 350 && m < 380 });
  const cf = MH.computeMaxHoldCf(rec, ticks, { now: NOW });
  assert.equal(cf.version, 1); assert.equal(cf.source, "price_ticks"); assert.equal(cf.ticks, ticks.length);
  const g = cf.grid;
  assert.deepEqual(Object.keys(g), ["240", "360", "480", "720", "1440"]);
  // T=240: readings 2.40 / 2.41 / 2.42 → 2.41, bin 34 in [0, 68]: base fraction 34/69, ratio 0.3 %
  const bf = (68 - 34) / 69;
  const cost = bf * 1 * 1.0241 * 0.003 + 0.00002;
  assert.equal(g["240"].pnl_at, 2.41); assert.equal(g["240"].state_at, "in"); assert.equal(g["240"].affected, true);
  assert.equal(g["240"].delta_sol, Math.round(((2.41 - 2) / 100 - cost) * 1e6) / 1e6);
  // T=360: first reading at 380, 20 min late → no reading
  assert.deepEqual(g["360"], { pnl_at: null, state_at: null, delta_sol: null, affected: false });
  // T=480: above the range — no exit cost, not affected (the rule never fires there)
  assert.equal(g["480"].state_at, "above"); assert.equal(g["480"].affected, false);
  assert.equal(g["480"].delta_sol, Math.round(((4.81 - 2) / 100) * 1e6) / 1e6);
  // T=720 / 1440: closed before
  assert.equal(g["720"].affected, false); assert.equal(g["720"].pnl_at, null);
  // Under the range: base fraction 1; the record's own slippage ratio and realized exit cost
  const rec2 = cfRecord({ exit_swap: { slippage_usd: 1, market_usd: 10 }, exit_slippage_sol: 0.02 });
  const cf2 = MH.computeMaxHoldCf(rec2, ticksFor(rec2, (m) => [-1, -5]), { now: NOW });
  const c2 = 1 * (1 - 0.01) * 0.1 + 0.00002;
  assert.equal(cf2.grid["240"].state_at, "under");
  assert.equal(cf2.grid["240"].delta_sol, Math.round(((-1 - 2) / 100 - c2 + 0.02) * 1e6) / 1e6);
  // No ticks / glitches only
  assert.equal(MH.computeMaxHoldCf(rec, [], { now: NOW }).unavailable, "no_ticks");
  assert.equal(MH.computeMaxHoldCf(rec, [{ ts: new Date(CLOSE - 60_000), pnl_pct: 250, active_bin: 1 }], { now: NOW }).unavailable, "no_ticks");
  // Range unknown: state null, base fraction 0.5, still affected
  const cf3 = MH.computeMaxHoldCf(cfRecord({ bin_range: null }), ticksFor(rec, (m) => [1, 10]), { now: NOW });
  assert.equal(cf3.grid["240"].state_at, null); assert.equal(cf3.grid["240"].affected, true);
});

test("capture queue: bot, never held, not a leg, 10 min … 14 d old, without max_hold_cf; newest first, ≤ 2", () => {
  const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
  const base = { minutes_held: 300, pnl_pct: 1, amount_sol: 0.45 };
  const recs = [
    { position: "OLD", recorded_at: at(15 * 1440), ...base },
    { position: "OK1", recorded_at: at(600), ...base },
    { position: "ADOPT", recorded_at: at(500), adopted: true, ...base },
    { position: "HELD", recorded_at: at(400), was_held: true, ...base },
    { position: "LEG", recorded_at: at(300), rebalance_leg: true, close_reason: "rebalance: x", ...base },
    { position: "DONE", recorded_at: at(200), max_hold_cf: { version: 1 }, ...base },
    { position: "OK2", recorded_at: at(100), ...base },
    { position: "OK3", recorded_at: at(50), ...base },
    { position: "YOUNG", recorded_at: at(5), ...base },
  ];
  assert.deepEqual(MH.maxHoldCfQueue(recs, { now: NOW }).map((r) => r.position), ["OK3", "OK2"]);
  assert.deepEqual(MH.maxHoldCfQueue(recs, { now: NOW, limit: 5 }).map((r) => r.position), ["OK3", "OK2", "OK1"]);
  const w = MH.maxHoldCfTickWindow({ recorded_at: new Date(CLOSE).toISOString(), minutes_held: 60 });
  assert.equal(w.from.getTime(), CLOSE - 62 * 60_000); assert.equal(w.to.getTime(), CLOSE + 60_000);
});

// ── evolver ───────────────────────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
/** n records, oldest first, each with a cf grid whose deltas come from fn(i, T) (null = not affected). */
function window(n, fn, { endMs = NOW - DAY, spacingMs = 3 * 3600_000 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const grid = {};
    for (const T of MH.MAX_HOLD_GRID) {
      const d = fn(i, T);
      grid[String(T)] = d == null ? { pnl_at: null, state_at: null, delta_sol: null, affected: false } : { pnl_at: 1, state_at: "in", delta_sol: d, affected: true };
    }
    return { position: `EV${i}`, recorded_at: new Date(endMs - (n - 1 - i) * spacingMs).toISOString(), max_hold_cf: { version: 1, grid } };
  });
}
// 480 is the clear winner (+0.005…+0.015 each), the others lose.
const good480 = (i, T) => (T === 480 ? (i % 2 ? 0.015 : 0.005) : T === 1440 ? null : -0.004);

test("gates: each one, on a crafted row", () => {
  const ok = { n: 24, sum: 0.2, sum_wo_largest: 0.15, d: 0.5, better: 15, worse: 8, half1: 0.1, half2: 0.1, worst: -0.05 };
  assert.equal(MH.maxHoldGateFailure(ok), null);
  assert.match(MH.maxHoldGateFailure({ ...ok, n: 19 }), /n=19 affected < 20/);
  assert.match(MH.maxHoldGateFailure({ ...ok, sum: 0 }), /≤ 0/);
  assert.match(MH.maxHoldGateFailure({ ...ok, d: 0.34 }), /d=0.34 < 0.35/);
  assert.match(MH.maxHoldGateFailure({ ...ok, sum_wo_largest: -0.01 }), /without the largest/);
  assert.match(MH.maxHoldGateFailure({ ...ok, better: 8, worse: 8 }), /better 8 ≤ worse 8/);
  assert.match(MH.maxHoldGateFailure({ ...ok, half1: -0.01 }), /halves −\/\+/);
  assert.match(MH.maxHoldGateFailure({ ...ok, worst: -0.11 }), /worst truncation/);
});

test("evolveMaxHold: steps one grid step toward the best T only when every gate holds", () => {
  const recs = window(40, good480);
  const v = MH.evolveMaxHold(recs, { currentMinutes: 240, now: NOW });
  assert.equal(v.action, "step"); assert.equal(v.candidate, 480);
  assert.deepEqual([v.from, v.to], [240, 360], "one grid step, not a jump to the candidate");
  assert.equal(v.row.n, 40);
  assert.match(MH.maxHoldEvolveLine(v, "shadow"), /^\[MAX_HOLD_EVOLVE_SHADOW\] would-step maxHoldMinutes 240 → 360 \(n=40, Σ◎\+0\.40, d=1\.9\d, 40\/0, halves \+\/\+\)$/);
  // Down the grid too
  assert.deepEqual(MH.evolveMaxHold(recs, { currentMinutes: 1440, now: NOW }).to, 720);
  // Already at the best T
  assert.equal(MH.evolveMaxHold(recs, { currentMinutes: 480, now: NOW }).action, "none");
  // Too few affected closes
  const few = MH.evolveMaxHold(window(15, good480), { currentMinutes: 360, now: NOW });
  assert.equal(few.action, "none"); assert.match(few.reason, /n=15 affected < 20/);
  // One half negative
  const halves = MH.evolveMaxHold(window(40, (i, T) => (T === 480 ? (i < 20 ? -0.002 : 0.03) : null)), { currentMinutes: 360, now: NOW });
  assert.equal(halves.action, "none"); assert.match(halves.reason, /halves|better|d=/);
  // Carried by one close
  const one = MH.evolveMaxHold(window(40, (i, T) => (T === 480 ? (i === 7 ? 1 : -0.001) : null)), { currentMinutes: 360, now: NOW });
  assert.equal(one.action, "none");
  // Nothing positive anywhere: never steps (and never touches the mode)
  assert.equal(MH.evolveMaxHold(window(40, () => -0.01), { currentMinutes: 360, now: NOW }).action, "none");
  // The window is the last 60
  assert.equal(MH.summarizeMaxHoldCf(window(80, good480)).n_records, 60);
});

test("evolveMaxHold: at most one step per 7 days; a pending step blocks until its revert check", () => {
  const recs = window(40, good480);
  const recent = MH.evolveMaxHold(recs, { currentMinutes: 360, now: NOW, state: { last_step_at: new Date(NOW - 3 * DAY).toISOString() } });
  assert.equal(recent.action, "none"); assert.match(recent.reason, /last step 3\.0 d ago/);
  assert.equal(MH.evolveMaxHold(recs, { currentMinutes: 360, now: NOW, state: { last_step_at: new Date(NOW - 8 * DAY).toISOString() } }).action, "step");
  const stepAt = new Date(NOW - 12 * 3600_000).toISOString(); // after every record of `recs`
  const state = { last_step_at: stepAt, step: { at: stepAt, from: 360, to: 480, metric_before: 0.4, status: "pending" } };
  const after = (n, d) => window(n, (i, T) => (T === 480 ? d : null), { endMs: NOW - 60_000, spacingMs: 60_000 });
  const wait = MH.evolveMaxHold([...recs, ...after(12, -0.01)], { currentMinutes: 480, now: NOW, state });
  assert.equal(wait.action, "none"); assert.match(wait.reason, /12\/20 affected closes/);
  const rev = MH.evolveMaxHold([...recs, ...after(25, -0.01)], { currentMinutes: 480, now: NOW, state });
  assert.deepEqual([rev.action, rev.from, rev.to], ["revert", 480, 360]);
  assert.equal(rev.check_sum, -0.2, "only the first 20 affected closes after the step");
  const conf = MH.evolveMaxHold([...recs, ...after(20, 0.001)], { currentMinutes: 480, now: NOW, state });
  assert.equal(conf.action, "confirm");
});

test("runMaxHoldEvolution: shadow changes nothing; enforce steps, records, then reverts", async () => {
  const recs = window(40, good480);
  const writes = [];
  const sent = [];
  const opts = { now: NOW, writeConfig: (k, v) => writes.push([k, v]), notify: async (t) => sent.push(t) };
  const config = { management: { maxHoldMode: "shadow", maxHoldMinutes: 240, maxHoldEvolveMode: "shadow" } };
  const before = JSON.stringify(getMaxHoldEvolveState());
  const lines = [];
  const orig = console.error; console.error = (...a) => lines.push(a.join(" "));
  let v;
  try { v = await runMaxHoldEvolution(recs, config, opts); } finally { console.error = orig; }
  assert.equal(v.action, "step");
  assert.ok(lines.some((l) => l.includes("[MAX_HOLD_EVOLVE_SHADOW] would-step maxHoldMinutes 240 → 360")));
  assert.equal(config.management.maxHoldMinutes, 240, "shadow: live config untouched");
  assert.equal(config.management.maxHoldMode, "shadow");
  assert.deepEqual(writes, []); assert.deepEqual(sent, []);
  assert.equal(JSON.stringify(getMaxHoldEvolveState()), before, "shadow: no state written");
  assert.equal(await runMaxHoldEvolution(recs, { management: { maxHoldEvolveMode: "off" } }, opts), null);

  const cfgE = { management: { maxHoldMode: "shadow", maxHoldMinutes: 240, maxHoldEvolveMode: "enforce" } };
  const s1 = await runMaxHoldEvolution(recs, cfgE, opts);
  assert.equal(s1.action, "step");
  assert.deepEqual(writes, [["maxHoldMinutes", 360]]);
  assert.equal(cfgE.management.maxHoldMinutes, 360);
  assert.equal(cfgE.management.maxHoldMode, "shadow", "the evolver never changes the mode");
  assert.equal(sent.length, 1); assert.match(sent[0], /maxHoldMinutes 240 → 360/);
  const st = getMaxHoldEvolveState();
  assert.equal(st.step.status, "pending"); assert.equal(st.step.to, 360); assert.equal(st.last_step_at, new Date(NOW).toISOString());
  // Next evaluation: the step awaits its check — nothing moves.
  const s2 = await runMaxHoldEvolution(recs, cfgE, { ...opts, now: NOW + 8 * DAY });
  assert.equal(s2.action, "none");
  assert.equal(writes.length, 1);
  // 20 affected closes at 360 after the step with Σ < 0 → revert to 240.
  const losers = window(20, (i, T) => (T === 360 ? -0.01 : null), { endMs: NOW + 2 * DAY, spacingMs: 60_000 });
  const s3 = await runMaxHoldEvolution([...recs, ...losers], cfgE, { ...opts, now: NOW + 9 * DAY });
  assert.deepEqual([s3.action, s3.from, s3.to], ["revert", 360, 240]);
  assert.deepEqual(writes[1], ["maxHoldMinutes", 240]);
  assert.equal(cfgE.management.maxHoldMinutes, 240);
  assert.equal(getMaxHoldEvolveState().step.status, "reverted");
});

test("recordMaxHoldCf: amends the record once (idempotent)", async () => {
  const { recordPerformance, getAllPerformance } = await import("../lessons.js");
  const P = `MH_REC_${Date.now()}`;
  await recordPerformance({ position: P, pool: "POOL_MH_REC", pool_name: "REC-SOL", amount_sol: 0.45, initial_value_usd: 0.45, final_value_usd: 0.455, fees_earned_usd: 0, minutes_in_range: 400, minutes_held: 400, close_reason: "Trailing TP", pnl_sol: 0.005 });
  assert.equal(recordMaxHoldCf("NO_SUCH_POSITION", { version: 1 }), false);
  assert.equal(recordMaxHoldCf(P, { version: 1, unavailable: "no_ticks" }), true);
  assert.equal(recordMaxHoldCf(P, { version: 1, grid: {} }), false, "a stored cf is never overwritten");
  const rec = getAllPerformance().find((r) => r.position === P);
  assert.equal(rec.max_hold_cf.unavailable, "no_ticks");
  assert.equal(MH.maxHoldCfQueue([rec], { now: Date.now() + 3600_000 }).length, 0, "no longer queued");
});
