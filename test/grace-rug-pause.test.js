process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
const { trackPosition, closeTrackedPosition, ensureStateInitialized, getTrackedPosition, releasePositionProfitGrace, isRugPausedByGrace, noteGraceRugPaused, noteRugLatchReading } = await import("../state.js");
const { profitGraceRugMode, graceRugPauseApplies, advanceGraceRugPaused, graceRugPausedLine, PROFIT_GRACE_RUG_MODES } = await import("../grace-rug-pause.js");
const { graceDownsideClause, graceReleaseClause } = await import("../grace-rule-status.js");
const { buildPerfRecord } = await import("../perf-record.js");
await ensureStateInitialized();

// 2026-11-24 (operator, after JIMMY-SOL 31ir6RAo was closed by the in-range rug latch at −16.26 %
// twenty minutes into its adoption grace and the price bounced ~20 bins three minutes later):
// "Please disable the rug detection within the grace." profitGraceRugMode: operator (default) |
// all | active.

const mgmt = { adoptedProfitGraceMinutes: 60, inRangeRugEnabled: true, rugPersistMode: "enforce", rugPersistSec: 30, rugPersistRecoveryBins: 3, rugMaxPnlPct: -3, rugWindowSec: 300, crashFastPathEnabled: true, crashRegimeMode: "enforce", tvlFloorExitMode: "enforce", holdThinPoolLimitMode: "off" };
const done = (P) => { try { closeTrackedPosition(P, "test"); } catch {} };
function captureLogs(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(" ")); };
  try { fn(); } finally { console.error = orig; }
  return lines;
}
function adoptedPos(P, name = "JIMMY-SOL") {
  trackPosition({ position: P, pool: `POOL_${P}`, pool_name: name, strategy: "manual", amount_sol: 0.3, initial_value_usd: 0.3, bin_range: { min: -605, max: -536 }, active_bin: -570, adopted: true });
  return getTrackedPosition(P); // adopted_at = now → 60 min of grace
}
function botStraddled(P, graceMin = 40) {
  trackPosition({ position: P, pool: `POOL_${P}`, pool_name: "SAPLING-SOL", strategy: "spot", amount_sol: 0.4, initial_value_usd: 0.4, bin_range: { min: 0, max: 100 }, active_bin: 50 });
  const pos = getTrackedPosition(P);
  pos.profit_grace_until = new Date(Date.now() + graceMin * 60_000).toISOString();
  return pos;
}

test("mode parse: default and unknown values read as operator", () => {
  assert.deepEqual([...PROFIT_GRACE_RUG_MODES], ["active", "operator", "all"]);
  assert.equal(profitGraceRugMode({}), "operator");
  assert.equal(profitGraceRugMode({ profitGraceRugMode: "bogus" }), "operator");
  assert.equal(profitGraceRugMode({ profitGraceRugMode: "all" }), "all");
  assert.equal(profitGraceRugMode({ profitGraceRugMode: "active" }), "active");
});

test("who is covered: operator positions in a grace by default; bot graces only with all; nobody with active", () => {
  const op = { adopted: true }, recovered = { adopted: true, strategy_source: "bot_recovery" }, bot = {};
  assert.equal(graceRugPauseApplies(op, {}, 40), true);
  assert.equal(graceRugPauseApplies(op, {}, 0), false, "no grace left → the rug rules run");
  assert.equal(graceRugPauseApplies(recovered, {}, 40), false, "a recovered bot deploy is the bot's");
  assert.equal(graceRugPauseApplies(bot, {}, 40), false);
  assert.equal(graceRugPauseApplies(bot, { profitGraceRugMode: "all" }, 40), true);
  assert.equal(graceRugPauseApplies(op, { profitGraceRugMode: "active" }, 40), false);
  assert.equal(graceRugPauseApplies({ adopted: true, closed: true }, {}, 40), false);
});

test("state: an adopted position in its grace is paused; release and the grace end un-pause it", () => {
  const P = `GRP_A_${Date.now()}`;
  try {
    const pos = adoptedPos(P);
    assert.equal(isRugPausedByGrace(P, mgmt), true);
    assert.equal(isRugPausedByGrace(pos, { ...mgmt, profitGraceRugMode: "active" }), false);
    pos.adopted_at = new Date(Date.now() - 61 * 60_000).toISOString(); // grace over
    assert.equal(isRugPausedByGrace(P, mgmt), false);
    pos.adopted_at = new Date().toISOString();
    assert.equal(isRugPausedByGrace(P, mgmt), true);
    const lines = captureLogs(() => releasePositionProfitGrace(P, mgmt));
    assert.ok(lines.some((l) => l.includes("[GRACE_RELEASE]") && l.includes("and the in-range rug rules active from the next valuation")), lines.join("\n"));
    assert.equal(isRugPausedByGrace(P, mgmt), false, "released by the operator → rug rules live again");
  } finally { done(P); }
});

test("state: a bot straddle grace is not paused by default, and is with profitGraceRugMode=all", () => {
  const P = `GRP_B_${Date.now()}`;
  try {
    botStraddled(P);
    assert.equal(isRugPausedByGrace(P, mgmt), false);
    assert.equal(isRugPausedByGrace(P, { ...mgmt, profitGraceRugMode: "all" }), true);
  } finally { done(P); }
});

test("a held-back hit drops an armed latch, is recorded once with the worst pnl, and logs once", () => {
  const P = `GRP_C_${Date.now()}`;
  try {
    adoptedPos(P);
    // arm a latch the way the poller does (as if the pause were off)
    const hit = { reason: "in-range rug 30 bins/130s from the window high -570 (13.8 b/min ≥ 12, pnl -12.73% ≤ -3%)" };
    const r = noteRugLatchReading(P, { bin: -600, pnl: -12.73, fresh: true, suspect: false, hit }, mgmt);
    assert.equal(r.action, "arm");
    assert.ok(getTrackedPosition(P).rug_latch);

    let lines = captureLogs(() => assert.deepEqual(noteGraceRugPaused(P, { rule: "rug_latch", pnl: -12.73, bin: -600, reason: hit.reason }, mgmt), { first: true }));
    const logged = lines.filter((l) => l.includes("[GRACE_RUG_PAUSED]"));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /\[GRACE_RUG_PAUSED\] JIMMY-SOL: in-range rug not applied at pnl -12\.73%, bin -600 — profit grace, 60 min left \(profitGraceRugMode=operator\) — in-range rug 30 bins\/130s/);
    let pos = getTrackedPosition(P);
    assert.equal(pos.rug_latch, null, "the armed latch must not fire later inside the grace");
    assert.equal(pos.rug_latch_last_low, null);
    assert.equal(pos.grace_rug_paused.rule, "rug_latch");
    assert.equal(pos.grace_rug_paused.pnl_pct, -12.73);
    assert.equal(pos.grace_rug_paused.hits, 1);

    lines = captureLogs(() => assert.deepEqual(noteGraceRugPaused(P, { rule: "rug_latch", pnl: -17.08, bin: -606, reason: hit.reason }, mgmt), { first: false }));
    assert.equal(lines.filter((l) => l.includes("[GRACE_RUG_PAUSED]")).length, 0, "one line per position");
    noteGraceRugPaused(P, { rule: "calm_regime", pnl: -9, bin: -590 }, mgmt);
    pos = getTrackedPosition(P);
    assert.equal(pos.grace_rug_paused.hits, 3);
    assert.equal(pos.grace_rug_paused.worst_pnl_pct, -17.08);
    assert.equal(pos.grace_rug_paused.pnl_pct, -12.73, "the first hit is kept");
    assert.equal(pos.grace_rug_paused.rule, "rug_latch");
  } finally { done(P); }
  assert.equal(noteGraceRugPaused("NOPE_UNTRACKED", { pnl: -5 }, mgmt), null);
});

test("pure record + line: calm-regime wording, missing pnl tolerated", () => {
  const a = advanceGraceRugPaused(null, { rule: "calm_regime", pnl: -6.1, bin: 12, remainingMin: 12.2, mode: "all", reason: "calm pair: 9 bins" }, Date.parse("2026-11-24T00:30:00Z"));
  assert.equal(a.first, true);
  assert.equal(a.rec.first_at, "2026-11-24T00:30:00.000Z");
  assert.equal(a.rec.grace_remaining_min, 13);
  assert.match(graceRugPausedLine("X-SOL", a.rec, "all"), /^\[GRACE_RUG_PAUSED\] X-SOL: calm-pair crash rule \(in range\) not applied at pnl -6\.10%, bin 12 — profit grace, 13 min left \(profitGraceRugMode=all\) — calm pair: 9 bins$/);
  const b = advanceGraceRugPaused(a.rec, { pnl: NaN });
  assert.equal(b.rec.hits, 2);
  assert.equal(b.rec.worst_pnl_pct, -6.1);
});

test("grace log text: the paused rug rules are named as paused, the rest keep their status", () => {
  const paused = graceDownsideClause(mgmt, { stopPaused: true, rugPaused: true });
  assert.match(paused, /paused in this grace: in-range rug latch, calm-pair crash rule in range; still active: crash fast path, TVL exit; off: thin-pool hold limit$/);
  const notPaused = graceDownsideClause(mgmt, { stopPaused: true, rugPaused: false });
  assert.match(notPaused, /still active: crash fast path, in-range rug latch, calm-pair crash rule, TVL exit; off: thin-pool hold limit$/);
  // a rule that is not closing anything anyway keeps its own status
  assert.match(graceDownsideClause({ ...mgmt, crashRegimeMode: "shadow" }, { rugPaused: true }), /paused in this grace: in-range rug latch; still active: crash fast path, TVL exit; log only: calm-pair crash rule;/);
  assert.equal(graceReleaseClause(mgmt, { stopPaused: false, rugPaused: true }), "profit-taking rules and the in-range rug rules active from the next valuation");
  assert.equal(graceReleaseClause(mgmt, { stopPaused: false }), "profit-taking rules active from the next valuation");
});

test("perf record carries grace_rug_paused (null when nothing was held back)", () => {
  const base = { source: "closed_api", tracked: { position: "P1", pool: "POOL", pool_name: "A-SOL", amount_sol: 0.3, deployed_at: new Date(Date.now() - 3600_000).toISOString() }, close: { pnl_sol: -0.01, pnl_pct: -3 }, extra: {} };
  let rec;
  try { rec = buildPerfRecord(base); } catch { rec = null; }
  if (rec) {
    assert.equal(rec.grace_rug_paused, null);
    const withIt = buildPerfRecord({ ...base, tracked: { ...base.tracked, grace_rug_paused: { rule: "rug_latch", pnl_pct: -12.73, hits: 4 } } });
    assert.equal(withIt.grace_rug_paused.hits, 4);
  }
  assert.match(fs.readFileSync(new URL("../perf-record.js", import.meta.url), "utf8"), /grace_rug_paused: tracked\.grace_rug_paused \?\? null/);
});

test("poller wiring: both in-range rug paths ask the grace; crash-below and the TVL exit do not", () => {
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  // the latch branch: paused comes first, a hit is noted instead of armed
  const rugBlock = src.slice(src.indexOf("const rug = detectInRangeRug(p.position, p, config.management);"), src.indexOf("// Pair-adaptive calm regime"));
  assert.match(rugBlock, /const rugPaused = config\.management\.inRangeRugEnabled && isRugPausedByGrace\(p\.position, config\.management\);/);
  assert.ok(rugBlock.indexOf("if (rugPaused) {") < rugBlock.indexOf("noteRugLatchReading("), "the pause is decided before the latch is fed");
  assert.match(rugBlock, /noteGraceRugPaused\(p\.position, \{ rule: "rug_latch"/);
  assert.match(rugBlock, /if \(rug && !rugPaused\) _crashFired\.add\(p\.position\);/);
  // the calm rule: only its in-range half
  const calm = src.slice(src.indexOf("// Pair-adaptive calm regime"), src.indexOf("// ── Event-Driven Smart Money Exodus Watcher"));
  assert.match(calm, /actMode === "enforce" && r\.where !== "below" && isRugPausedByGrace\(p\.position, config\.management\)/);
  assert.match(calm, /noteGraceRugPaused\(p\.position, \{ rule: "calm_regime"/);
  // crash-below is decided before either and never asks
  const crash = src.slice(src.indexOf("const crash = detectPriceCrash(p.position, p, config.management);"), src.indexOf("const rug = detectInRangeRug("));
  assert.doesNotMatch(crash, /isRugPausedByGrace/);
  const tvl = fs.readFileSync(new URL("../tvl-floor-exit.js", import.meta.url), "utf8");
  assert.doesNotMatch(tvl, /RugPaused|profitGraceRugMode/);
});
