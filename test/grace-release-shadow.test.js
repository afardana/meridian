process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Early grace release — log-only shadow ===");

const G = await import("../grace-release-shadow.js");
const { graceEarlyReleaseMode, graceWindow, graceReleaseShadowStep, lastCompletedCandles, candleMovesPct, runGraceReleaseShadow } = G;

const MIN = 60_000;
const T0 = Date.parse("2026-10-11T03:00:00Z"); // on a 5-minute boundary
const iso = (ms) => new Date(ms).toISOString();
const mgmt = { adoptedProfitGraceMinutes: 60, harvestStraddleGraceMinutes: 60 };

// ── Mode: off | shadow, no enforce ────────────────────────────────────────────────────
assert.equal(graceEarlyReleaseMode({}), "shadow");
assert.equal(graceEarlyReleaseMode({ graceEarlyReleaseMode: "off" }), "off");
assert.equal(graceEarlyReleaseMode({ graceEarlyReleaseMode: "enforce" }), "shadow"); // not built
const { config } = await import("../config.js");
assert.equal(config.management.graceEarlyReleaseMode, "shadow");

// ── Which grace, and since when ───────────────────────────────────────────────────────
const adopted = { adopted: true, adopted_at: iso(T0) };
assert.equal(graceWindow(adopted, mgmt, T0 + 25 * MIN).kind, "adoption");
assert.equal(graceWindow(adopted, mgmt, T0 + 25 * MIN).elapsed_min, 25);
assert.equal(graceWindow(adopted, mgmt, T0 + 60 * MIN), null);                      // over
assert.equal(graceWindow({ ...adopted, profit_grace_released_at: iso(T0) }, mgmt, T0 + 25 * MIN), null); // released by the operator
assert.equal(graceWindow({ adopted: false, adopted_at: iso(T0) }, mgmt, T0 + 5 * MIN), null); // bot deploy
assert.equal(graceWindow(adopted, { adoptedProfitGraceMinutes: 0 }, T0 + 5 * MIN), null);
const straddled = { straddled_at: iso(T0), profit_grace_until: iso(T0 + 60 * MIN) };
assert.deepEqual([graceWindow(straddled, mgmt, T0 + 31 * MIN).kind, graceWindow(straddled, mgmt, T0 + 31 * MIN).elapsed_min], ["straddle", 31]);
assert.equal(graceWindow({ profit_grace_until: iso(T0 + 60 * MIN) }, mgmt, T0 + 12 * MIN).elapsed_min, 12); // no straddled_at: until − grace
assert.equal(graceWindow({ profit_grace_until: null }, mgmt, T0), null);
// an adopted position straddled late in its adoption window: the longer (straddle) window counts
assert.equal(graceWindow({ ...adopted, straddled_at: iso(T0 + 50 * MIN), profit_grace_until: iso(T0 + 110 * MIN) }, mgmt, T0 + 55 * MIN).kind, "straddle");

// ── Schedule: each 10-minute mark once ────────────────────────────────────────────────
const step = (pos, min, m = mgmt) => graceReleaseShadowStep(pos, m, T0 + min * MIN);
assert.deepEqual([step(adopted, 3).due, step(adopted, 9.9).due], [false, false]);
const s10 = step(adopted, 10.5);
assert.deepEqual([s10.due, s10.mark, s10.check.start, s10.check.mark], [true, 1, iso(T0), 1]);
const after10 = { ...adopted, grace_release_shadow_check: s10.check };
assert.deepEqual([step(after10, 12).due, step(after10, 19.9).due], [false, false]); // 3-min cycles inside the same mark
assert.deepEqual([step(after10, 21).due, step(after10, 21).mark], [true, 2]);
assert.deepEqual([step(after10, 47).due, step(after10, 47).mark], [true, 4]);        // skipped marks are not replayed
assert.equal(step(after10, 61).due, false);                                          // grace over
// a NEW window (a later straddle) starts its own marks
assert.equal(step({ ...straddled, grace_release_shadow_check: { start: iso(T0 - 90 * MIN), mark: 5 } }, 11).due, true);
// never: mode off, held, closed, no grace, already logged
assert.equal(step(adopted, 30, { ...mgmt, graceEarlyReleaseMode: "off" }).due, false);
assert.equal(step({ ...adopted, hold_mode: true }, 30).reason, "held");
assert.equal(step({ ...adopted, closed: true }, 30).due, false);
assert.equal(step({ adopted: false }, 30).reason, "no grace");
assert.equal(step({ ...adopted, grace_release_shadow: { at: "x" } }, 30).reason, "already logged");

// ── Candles: the last 3 COMPLETED ones ────────────────────────────────────────────────
const candle = (startMs, open, close) => ({ timestamp: startMs / 1000, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 1 });
const now = T0 + 22 * MIN; // buckets: …00 05 10 15 are complete, 20 is in progress
const up = [candle(T0, 1, 1.01), candle(T0 + 5 * MIN, 1.01, 1.03), candle(T0 + 10 * MIN, 1.03, 1.04), candle(T0 + 15 * MIN, 1.04, 1.045), candle(T0 + 20 * MIN, 1.045, 0.9)];
const last = lastCompletedCandles(up, now);
assert.deepEqual(last.map((c) => c.timestamp), [T0 + 5 * MIN, T0 + 10 * MIN, T0 + 15 * MIN].map((t) => t / 1000)); // the falling in-progress bucket is left out
assert.deepEqual(candleMovesPct(last), [1.98, 0.97, 0.48]);
assert.equal(lastCompletedCandles(up.slice(3), now), null);                          // fewer than 3 complete
assert.equal(lastCompletedCandles([], now), null);
assert.equal(lastCompletedCandles(null, now), null);
assert.equal(lastCompletedCandles([up[0], up[2], up[3]], now), null);                // a missing bucket is not "three in a row"

// ── The runner: logs and stores once, releases nothing ────────────────────────────────
const S = await import("../state.js");
await S.ensureStateInitialized();
let seq = 0;
const mk = (tag, extra = {}) => {
  const a = `TEST_GRACE_SHADOW_${tag}_${Date.now()}_${seq++}`;
  S.trackPosition({ position: a, pool: "POOL_GS_" + tag, pool_name: tag + "-SOL", amount_sol: 1, strategy: "manual", bin_range: [0, 100], active_bin: 50, adopted: true, ...extra });
  return a;
};
const pos = (a) => S.getTrackedPosition(a);
const GRACE_FIELDS = ["adopted_at", "profit_grace_until", "profit_grace_released_at", "profit_grace_active", "peak_pnl_pct", "trailing_active", "hold_mode", "hold_resume_rebase", "pending_exit_action"];
const graceSnap = (a) => JSON.stringify(GRACE_FIELDS.map((k) => pos(a)[k] ?? null));
const mgmtLive = { ...mgmt, trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, stopLossPct: -15 };
const harness = (a, candlesFor) => {
  const calls = [], logs = [];
  const run = (min, row = {}) => runGraceReleaseShadow({
    p: { position: a, pool: pos(a).pool, pair: pos(a).pool_name, pnl_pct: 4.321, pnl_management_ready: true, ...row },
    tracked: pos(a), mgmt: mgmtLive, nowMs: new Date(pos(a).adopted_at).getTime() + min * MIN,
    fetchCandles: async (pool, opts) => { calls.push({ pool, opts, min }); return candlesFor(new Date(pos(a).adopted_at).getTime() + min * MIN); },
    noteCheck: S.noteGraceReleaseCheck, noteShadow: S.noteGraceReleaseShadow, log: (tag, msg) => logs.push(msg),
  });
  return { calls, logs, run };
};
// candles relative to "now": three completed rising (or not) buckets + one in progress
const series = (moves) => (nowMs) => {
  const b = Math.floor(nowMs / (5 * MIN)) * 5 * MIN;
  let px = 1;
  const out = moves.map((m, i) => { const c = candle(b - (moves.length - i) * 5 * MIN, px, px * (1 + m / 100)); px = c.close; return c; });
  return [...out, candle(b, px, px * 0.5)];
};

{
  const a = mk("UP");
  const before = graceSnap(a);
  const remainingBefore = S.profitGraceRemainingMin(pos(a), mgmtLive);
  const h = harness(a, series([1, 0.5, 2]));
  assert.equal(await h.run(4), null);                 // before the first mark: no fetch
  assert.equal(h.calls.length, 0);
  // an untrusted valuation waits for the next cycle and does not use up the mark
  assert.equal(await h.run(10.2, { pnl_pct_suspicious: true }), null);
  assert.equal(await h.run(10.4, { pnl_management_ready: false }), null);
  assert.equal(h.calls.length, 0);
  assert.equal(pos(a).grace_release_shadow_check ?? null, null);
  const rec = await h.run(11);
  assert.deepEqual(h.calls[0].opts, { timeframe: "5m", limit: 5 });
  assert.deepEqual(rec.candles, [1, 0.5, 2]);
  assert.deepEqual([rec.elapsed_min, rec.pnl_pct, rec.grace], [11, 4.32, "adoption"]);
  assert.deepEqual(pos(a).grace_release_shadow, rec);
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0], "[GRACE_RELEASE_SHADOW] would-release UP-SOL: 11 min into the grace, last 3 5m candles +1.00% +0.50% +2.00%, pnl 4.32% (graceEarlyReleaseMode=shadow)");
  // once per position: later marks neither fetch nor log
  for (const min of [14, 21, 33, 59]) assert.equal(await h.run(min), null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.logs.length, 1);
  // NOTHING was released: every grace / exit-facing field is as before, the grace still runs,
  // and the profit rules stay suppressed.
  assert.equal(graceSnap(a), before);
  assert.ok(Math.abs(S.profitGraceRemainingMin(pos(a), mgmtLive) - remainingBefore) < 0.1);
  assert.equal(S.isProfitExitSuppressed(pos(a), "TRAILING_TP", mgmtLive), true);
  S.confirmPeak(a, 6, 1);
  assert.equal(S.updatePnlAndCheckExits(a, { pnl_pct: 3, effective_pnl_pct: 3, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100 }, mgmtLive), null, "3 pp under the peak inside the grace: still no trailing exit");
  S.recordClose(a, "test");
}

{
  // not all three up: one fetch per 10-minute mark, never more, nothing stored
  const a = mk("MIXED");
  const h = harness(a, series([1, -0.2, 2]));
  for (const min of [10.5, 13.5, 16.5, 19.5, 22.5, 25.5, 28.5, 31.5]) assert.equal(await h.run(min), null);
  assert.deepEqual(h.calls.map((c) => Math.floor(c.min / 10)), [1, 2, 3]);
  assert.equal(pos(a).grace_release_shadow ?? null, null);
  assert.equal(pos(a).grace_release_shadow_check.mark, 3);
  assert.equal(h.logs.length, 0);
  // a flat candle is not "positive"; an empty / failed feed is silent
  const flat = harness(a, series([1, 0, 2]));
  assert.equal(await flat.run(41), null);
  const dead = harness(a, () => []);
  assert.equal(await dead.run(51), null);
  const boom = harness(a, () => { throw new Error("network"); });
  S.noteGraceReleaseCheck(a, { start: pos(a).adopted_at, mark: 0, at: "x" });
  assert.equal(await boom.run(52), null);
  assert.equal(boom.logs.length + dead.logs.length + flat.logs.length, 0);
  // held: never evaluated
  S.setPositionHold(a, true);
  S.noteGraceReleaseCheck(a, { start: pos(a).adopted_at, mark: 0, at: "x" });
  const held = harness(a, series([1, 1, 1]));
  assert.equal(await held.run(55), null);
  assert.equal(held.calls.length, 0);
  S.recordClose(a, "test");
  assert.equal(S.noteGraceReleaseShadow(a, { at: "x" }), false); // closed
}

// ── Wiring ────────────────────────────────────────────────────────────────────────────
{
  const mod = fs.readFileSync(new URL("../grace-release-shadow.js", import.meta.url), "utf8");
  assert.doesNotMatch(mod, /^import /m);                                             // leaf: cannot reach a grace writer
  assert.doesNotMatch(mod, /releasePositionProfitGrace|profit_grace_released_at\s*=|profit_grace_until\s*=/);
  const st = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
  const writers = st.slice(st.indexOf("export function noteGraceReleaseCheck"), st.indexOf(" * Operator ends a position's profit grace early"));
  assert.doesNotMatch(writers, /profit_grace_|peak_pnl_pct|trailing_active|hold_mode\s*=/);
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.equal((idx.match(/runGraceReleaseShadow\(/g) || []).length, 1);
  // management cycle only, in the non-held / trusted-valuation branch
  assert.match(idx, /if \(!operatorHold && !valuationUnsafe\) \{[\s\S]{0,900}void runGraceReleaseShadow\(\{/);
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal((dlmm.match(/grace_release_shadow: (tracked|snapshot)\.grace_release_shadow \?\? null,/g) || []).length, 3);
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exe, /graceEarlyReleaseMode: \["management", "graceEarlyReleaseMode"\]/);
  const cfgSrc = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfgSrc, /fresh\.graceEarlyReleaseMode/);
}

console.log("OK — grace release shadow");
process.exit(0);
