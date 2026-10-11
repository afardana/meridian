process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Thin-pool hold limit (overrides HOLD) + thin-pool alerts ===");

const L = await import("../hold-thin-limit.js");
const {
  holdThinLimitConfig, thinPoolEntry, holdThinLimitReading, advanceHoldThinLimit, crossingIsPlausible,
  maxExplainedDropPp, buildHoldThinLimitExit, shouldWarnThinPoolAdoption,
  HOLD_THIN_LIMIT_MAX_GAP_MS, HOLD_THIN_LIMIT_RECONFIRM_MS,
} = L;
const { holdOverrideActive, HOLD_OVERRIDE_TTL_MS, HOLD_OVERRIDE_RULES } = await import("../hold-override.js");
const { config } = await import("../config.js");

const SEC = 1000;
const T0 = Date.parse("2026-10-10T14:03:00Z");
const cfg = holdThinLimitConfig({});

// ── Config: defaults, typo-safe mode, the bar is not tied to minTvl ───────────────────
assert.deepEqual(cfg, { mode: "enforce", limitPct: -25, tvlUsd: 100000, confirmSec: 60 });
assert.equal(holdThinLimitConfig({ holdThinPoolLimitMode: "shadow" }).mode, "shadow");
assert.equal(holdThinLimitConfig({ holdThinPoolLimitMode: "off" }).mode, "off");
assert.equal(holdThinLimitConfig({ holdThinPoolLimitMode: "enforced" }).mode, "shadow"); // a typo never enforces
assert.equal(holdThinLimitConfig({ holdThinPoolLimitPct: 0 }).limitPct, -25);            // a limit must be a loss
assert.equal(holdThinLimitConfig({ holdThinPoolLimitPct: 25 }).limitPct, -25);
assert.equal(holdThinLimitConfig({ holdThinPoolLimitPct: "-30" }).limitPct, -30);
assert.equal(holdThinLimitConfig({ holdThinPoolTvlUsd: -1 }).tvlUsd, 100000);
assert.equal(holdThinLimitConfig({ holdThinPoolLimitConfirmSec: 1 }).confirmSec, 60);    // too short reads as the default
assert.equal(holdThinLimitConfig({ holdThinPoolLimitConfirmSec: 120 }).confirmSec, 120);
assert.equal(holdThinLimitConfig({ minTvl: 50000 }).tvlUsd, 100000);
assert.equal(config.management.holdThinPoolLimitMode, "enforce");
assert.equal(config.management.holdThinPoolLimitPct, -25);
assert.equal(config.management.holdThinPoolTvlUsd, 100000);
assert.equal(config.management.holdThinPoolLimitConfirmSec, 60);
assert.equal(config.management.adoptThinPoolWarnEnabled, true);
assert.equal(config.management.holdDownsideAlertEnabled, true);
assert.equal(config.management.holdDownsideMode, "shadow"); // the -15 % hold-downside logic stays shadow

// ── Thin / not thin / unknown ─────────────────────────────────────────────────────────
assert.deepEqual(thinPoolEntry({ entry_tvl: 42622.68 }, cfg), { thin: true, entry_tvl_usd: 42622.68 });
assert.equal(thinPoolEntry({ entry_tvl: 99999.99 }, cfg).thin, true);
assert.equal(thinPoolEntry({ entry_tvl: 100000 }, cfg).thin, false);
assert.equal(thinPoolEntry({ entry_tvl: 336184 }, cfg).thin, false);
for (const bad of [null, undefined, 0, -5, NaN, Infinity, "42000", "", {}, true]) {
  assert.deepEqual(thinPoolEntry({ entry_tvl: bad }, cfg), { thin: false, entry_tvl_usd: null }, `entry_tvl ${String(bad)}`);
}
assert.equal(thinPoolEntry(null, cfg).thin, false);
assert.equal(thinPoolEntry({ entry_tvl: 150000 }, holdThinLimitConfig({ holdThinPoolTvlUsd: 200000 })).thin, true);

// ── Reading quality ───────────────────────────────────────────────────────────────────
const row = (pnl, bin, extra = {}) => ({ pnl_pct: pnl, active_bin: bin, pnl_basis: "sol", pnl_management_ready: true, total_value_usd: 1, ...extra });
const rd = (pnl, bin, extra) => holdThinLimitReading(row(pnl, bin, extra), {});
assert.deepEqual(rd(-26.1, -612), { ok: true, pnl_pct: -26.1, bin: -612, key: "-26.1|-612|1" });
assert.equal(rd(-26.1, -612, { pnl_management_ready: false }).ok, false);
assert.equal(rd(-26.1, -612, { pnl_pct_suspicious: true }).ok, false);
assert.equal(rd(-26.1, -612, { flow_pending: true }).ok, false);
assert.equal(holdThinLimitReading(row(-26.1, -612), { pending_flow: { net_sol_expected: 1 } }).ok, false); // straddle / re-range in progress
assert.equal(rd(-26.1, -612, { pnl_basis: "usd" }).ok, false);
for (const bad of [null, undefined, NaN, "-26", Infinity]) assert.equal(rd(bad, -612).ok, false);
assert.equal(holdThinLimitReading(null).ok, false);
assert.equal(holdThinLimitReading({ pnl_pct: -30, active_bin: 5 }, {}).ok, true); // basis / readiness absent = not declared otherwise

// ── Confirmation: 2 distinct valuations AND >= 60 s, every reading in between at/under ──
const step = (st, pnl, bin, t, extra) => advanceHoldThinLimit(st, rd(pnl, bin, extra), cfg, { binStep: 100, nowMs: T0 + t * SEC });
{
  // FACTORY-SOL 10-10 (bin step 100): the real valuations around the fire.
  let r = step(null, -19.59, -604, 32); assert.equal(r.event, "above"); assert.equal(r.state.ref.pnl_pct, -19.59);
  r = step(r.state, -24.48, -611, 47); assert.equal(r.event, "above");
  r = step(r.state, -25.15, -612, 52); assert.deepEqual([r.event, r.ready, r.state.streak.count], ["started", false, 1]);
  for (let t = 57; t <= 77; t += 5) { r = step(r.state, -25.15, -612, t); assert.deepEqual([r.event, r.ready], ["repeat", false]); } // one valuation seen 6×
  r = step(r.state, -24.48, -611, 82); assert.deepEqual([r.event, r.state.streak], ["reset", null]);  // 25 s touch → nothing
  r = step(r.state, -23.12, -609, 157);
  r = step(r.state, -25.15, -612, 207); assert.equal(r.event, "started");
  r = step(r.state, -25.81, -613, 212); assert.deepEqual([r.event, r.ready, r.state.streak.count], ["counted", false, 2]); // 2 valuations, only 5 s
  for (let t = 217; t <= 262; t += 5) { r = step(r.state, -25.81, -613, t); assert.equal(r.ready, false, `t=${t}`); }
  r = step(r.state, -29.66, -619, 267);                                                                // 60 s after the streak began
  assert.deepEqual([r.event, r.ready, Math.round(r.held_sec)], ["counted", true, 60]);
  assert.equal(r.state.streak.worst_pnl_pct, -29.66);
}
{
  // A single -30 % blip never fires, however long the poller keeps seeing other things after it.
  let r = step(null, -12, 100, 0);
  r = step(r.state, -14, 98, 5);
  r = step(r.state, -30, 82, 10); assert.equal(r.event, "started");       // 16 bins down explains it
  r = step(r.state, -14, 98, 15); assert.equal(r.event, "reset");
  for (let t = 20; t < 600; t += 5) { r = step(r.state, -14, 98, t); assert.equal(r.ready, false); assert.equal(r.state.streak, null); }
}
{
  // darwin-style touch: at/under the limit for 40 s on two valuations, then back above → no fire; a later streak starts from zero.
  let r = step(null, -24.6, 50, 0);
  r = step(r.state, -25.4, 49, 5);
  r = step(r.state, -25.2, 49, 20); assert.deepEqual([r.event, r.state.streak.count, r.ready], ["counted", 2, false]);
  r = step(r.state, -25.2, 49, 40); assert.equal(r.ready, false);
  r = step(r.state, -24.9, 50, 45); assert.equal(r.event, "reset");
  r = step(r.state, -25.3, 49, 50); assert.deepEqual([r.event, r.state.streak.count], ["started", 1]);
  r = step(r.state, -25.3, 49, 105); assert.equal(r.ready, false);        // 55 s
  r = step(r.state, -25.3, 49, 110); assert.equal(r.ready, true);         // 60 s, second count came from the 30 s re-read
}
{
  // One valuation only: never ready before the unchanged reading has been re-read (>= 30 s), and never before 60 s.
  let r = step(null, -20, 10, 0);
  r = step(r.state, -26, 3, 5);
  for (let t = 10; t < 35; t += 5) { r = step(r.state, -26, 3, t); assert.deepEqual([r.event, r.state.streak.count], ["repeat", 1]); }
  r = step(r.state, -26, 3, 5 + HOLD_THIN_LIMIT_RECONFIRM_MS / SEC); assert.deepEqual([r.event, r.state.streak.count, r.ready], ["counted", 2, false]);
  r = step(r.state, -26, 3, 64); assert.equal(r.ready, false);
  r = step(r.state, -26, 3, 65); assert.equal(r.ready, true);
}
{
  // Unusable readings neither count nor reset, and can never complete a streak — even one that is otherwise complete.
  let r = step(null, -20, 10, 0);
  r = step(r.state, -26, 3, 5);
  const before = r.state;
  for (const extra of [{ pnl_management_ready: false }, { pnl_pct_suspicious: true }, { flow_pending: true }, { pnl_basis: "usd" }]) {
    const x = step(before, -90, 3, 20, extra); assert.deepEqual([x.event, x.ready, x.changed], ["ignored", false, false]); assert.equal(x.state, before);
    const up = step(before, 5, 3, 20, extra); assert.equal(up.state, before);          // an unusable reading above does not reset either
  }
  r = step(before, -27, 2, 30);                                                       // count 2
  let x = step(r.state, -60, 2, 300, { pnl_pct_suspicious: true }); assert.equal(x.ready, false);
  x = advanceHoldThinLimit(r.state, { ok: false }, cfg, { nowMs: T0 + 90 * SEC }); assert.equal(x.ready, false);
  x = advanceHoldThinLimit(r.state, null, cfg, { nowMs: T0 + 90 * SEC }); assert.equal(x.ready, false);
  x = step(r.state, -27, 2, 70); assert.equal(x.ready, true);                         // the usable one does
}
{
  // A pause longer than the max gap starts over (poller blocked, restart): the two readings must be seen close together.
  let r = step(null, -20, 10, 0);
  r = step(r.state, -26, 3, 5);
  r = step(r.state, -28, 1, 5 + HOLD_THIN_LIMIT_MAX_GAP_MS / SEC + 1);
  assert.deepEqual([r.event, r.state.streak.count, r.ready], ["restarted", 1, false]);
  r = step(r.state, -29, 0, 5 + HOLD_THIN_LIMIT_MAX_GAP_MS / SEC + 70); assert.equal(r.ready, true);
  // …while a pause inside it (one management cycle) keeps the streak
  let q = step(null, -20, 10, 0); q = step(q.state, -26, 3, 5); q = step(q.state, -28, 1, 150);
  assert.deepEqual([q.event, q.ready], ["counted", true]);
}
{
  // Exactly at the limit counts ("at or under"); a hair above does not.
  let r = step(null, -24.99, 10, 0); assert.equal(r.event, "above");
  r = step(r.state, -25, 10, 5); assert.equal(r.event, "started");
}

// ── A drop the price did not make is left out (unindexed withdrawal / re-range) ────────
{
  assert.equal(maxExplainedDropPp(0, 0, 100), 0);
  assert.ok(Math.abs(maxExplainedDropPp(0, 10, 100) - 9.47) < 0.01);        // 10 bins of 1 % on a position worth its capital
  assert.equal(crossingIsPlausible(null, { pnl_pct: -40, bin: 1 }, 100).ok, true);            // no reference: nothing to compare
  assert.equal(crossingIsPlausible({ pnl_pct: -22, bin: 5 }, { pnl_pct: -26, bin: 5 }, 100).ok, true); // inside the slack
  assert.equal(crossingIsPlausible({ pnl_pct: 1.6, bin: 376 }, { pnl_pct: -49.2, bin: 384 }, 100).ok, false); // tOpenAI-SOL 09-29
  assert.equal(crossingIsPlausible({ pnl_pct: -5, bin: 100 }, { pnl_pct: -45, bin: 99 }, 100).ok, false);   // one bin cannot cost 40 pp
  assert.equal(crossingIsPlausible({ pnl_pct: -10, bin: 100 }, { pnl_pct: -40, bin: 60 }, 100).ok, true);    // a real crash moves the bin
  assert.equal(crossingIsPlausible({ pnl_pct: -5, bin: null }, { pnl_pct: -45, bin: 99 }, 100).ok, false);  // cannot be checked → not counted
  assert.equal(crossingIsPlausible({ pnl_pct: -5, bin: 100 }, { pnl_pct: -45, bin: 60 }, null).ok, false);

  let r = step(null, 1.6, 376, 0);
  const ref = r.state;
  for (let t = 5; t <= 3600; t += 15) {                                    // an hour of the phantom reading: never accepted by persistence
    r = step(r.state, -49.2, 384, t);
    assert.deepEqual([r.event, r.ready], ["implausible", false], `t=${t}`);
    assert.equal(r.state.streak ?? null, null);
  }
  assert.deepEqual(r.state.ref, ref.ref);
  r = step(r.state, 1.4, 384, 3605); assert.equal(r.event, "above");       // the indexer caught up
  // the price then really collapses: explained by the bin move → counts
  r = step(r.state, -30, 340, 3610); assert.equal(r.event, "started");
  r = step(r.state, -33, 336, 3675); assert.equal(r.ready, true);
}

// ── Exit object, family, reason wording ───────────────────────────────────────────────
const { finalizeExit, URGENT_EXIT_ACTIONS, EXIT_FAMILY_BY_ACTION } = await import("../state.js");
const { exitFamilyFromReason, classifyOutcome } = await import("../lessons.js");
{
  const exit = finalizeExit(buildHoldThinLimitExit({ pnlPct: -26.1, heldSec: 65, entryTvlUsd: 42622.68, cfg }));
  assert.deepEqual([exit.action, exit.rule, exit.family, exit.urgent, exit.confirm_ticks, exit.hold_override], ["HOLD_THIN_LIMIT", "hold_limit", "hold_limit", true, 1, "hold_limit"]);
  assert.equal(exit.reason, "Thin-pool hold limit: PnL -26.1% at or under -25% for 65s on a held position (pool TVL at entry $42,623, under $100,000) — hard exit (overrides HOLD)");
  assert.equal(exitFamilyFromReason(exit.reason), "hold_limit");
  assert.equal(exitFamilyFromReason(`Rule hold_limit: ${exit.reason}`), "hold_limit");
  // legacy substring scans read "oor" / "below" as an out-of-range close
  assert.doesNotMatch(exit.reason, /oor|below|floor/i);
  assert.ok(URGENT_EXIT_ACTIONS.has("HOLD_THIN_LIMIT"));
  assert.equal(EXIT_FAMILY_BY_ACTION.HOLD_THIN_LIMIT, "hold_limit");
  assert.equal(classifyOutcome({ pnl_pct: -26, exit_family: "hold_limit", initial_value_usd: 1, fees_earned_usd: 0 }), "failure");
  assert.equal(classifyOutcome({ pnl_pct: -26, close_reason: exit.reason, initial_value_usd: 1, fees_earned_usd: 0.5 }), "failure");
  // the TVL exit keeps its own family
  assert.equal(exitFamilyFromReason("TVL exit: pool TVL $8,591 under the $10,000 minimum for 3 readings in 5m (on-chain reserves $9,300) — hard exit (overrides HOLD)"), "tvl_floor");
}

// ── State on the position + the shared HOLD-override authorisation ────────────────────
const S = await import("../state.js");
await S.ensureStateInitialized();
let seq = 0;
const mk = (tag, { hold = true, entry_tvl = 42622.68, adopted = false } = {}) => {
  const addr = `TEST_HOLD_THIN_${tag}_${Date.now()}_${seq++}`;
  S.trackPosition({ position: addr, pool: "POOL_HT_" + tag, pool_name: tag + "-SOL", amount_sol: 1.48, strategy: "spot", entry_tvl, bin_step: 100, adopted });
  if (hold) S.setPositionHold(addr, true);
  return addr;
};
const pos = (a) => S.getTrackedPosition(a);
const feed = (a, pnl, bin, t, m, extra) => S.noteHoldThinLimitReading(a, holdThinLimitReading(row(pnl, bin, extra), pos(a)), m, { nowMs: T0 + t * SEC });
const run = (a, m) => { feed(a, -20, 10, 0, m); feed(a, -26, 3, 5, m); return feed(a, -27, 2, 70, m); };

for (const mode of ["enforce", "shadow"]) {
  const m = { holdThinPoolLimitMode: mode };
  const a = mk("M" + mode);
  assert.equal(pos(a).entry_tvl, 42622.68);
  let r = feed(a, -20, 10, 0, m); assert.deepEqual([r.thin, r.event, r.ready], [true, "above", false]);
  r = feed(a, -26, 3, 5, m); assert.equal(r.event, "started");
  assert.equal(pos(a).hold_thin_limit.streak.count, 1);                        // on the position → survives a restart
  assert.equal(feed(a, -90, 3, 20, m, { pnl_management_ready: false }).event, "ignored");
  r = feed(a, -27, 2, 70, m); assert.equal(r.ready, true);
  // a complete streak alone opens nothing: the rule must stamp it
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), false);
  assert.equal(S.noteHoldThinLimitMark(a, { alerted_at: "x" }, { confirm: true }), true);
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), mode === "enforce");
  // …and only for the rule that confirmed, only when asked by name, only while fresh, only in enforce
  assert.equal(holdOverrideActive(pos(a), m, "tvl_floor"), false);
  for (const bare of [undefined, null, true, 1, "", "yes", "hold", "HOLD_LIMIT", "constructor", "__proto__", "toString", {}, ["hold_limit"]]) {
    assert.equal(holdOverrideActive(pos(a), m, bare), false, `requested=${String(bare)}`);
  }
  assert.equal(holdOverrideActive(pos(a), { holdThinPoolLimitMode: "off" }, "hold_limit"), false);
  assert.equal(holdOverrideActive(pos(a), { holdThinPoolLimitMode: "shadow" }, "hold_limit"), false);
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit", Date.now() + HOLD_OVERRIDE_TTL_MS + 1000), false);
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit", Date.now() - 60_000), false);          // a stamp from the future
  // the next reading drops the stamp (re-issued only on a reading that is ready), the latch stays
  feed(a, -27.5, 2, 75, m);
  assert.equal(pos(a).hold_thin_limit.streak.confirmed_at, null);
  assert.equal(pos(a).hold_thin_limit.streak.alerted_at, "x");                  // one alert per streak
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), false);
  // back above the limit: streak, stamp and latch gone
  S.noteHoldThinLimitMark(a, {}, { confirm: true });
  assert.equal(feed(a, -24, 5, 80, m).event, "reset");
  assert.equal(pos(a).hold_thin_limit.streak, null);
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), false);
  assert.equal(S.noteHoldThinLimitMark(a, {}, { confirm: true }), false);        // nothing to confirm without a streak
  // mode off clears; hold release clears; close clears
  run(a, m);
  assert.equal(feed(a, -40, 1, 90, { holdThinPoolLimitMode: "off" }).event, "off");
  assert.equal(pos(a).hold_thin_limit, null);
  run(a, m); S.noteHoldThinLimitMark(a, {}, { confirm: true });
  S.setPositionHold(a, true, "second reason");                                  // a repeated hold keeps the state
  assert.equal(pos(a).hold_thin_limit.streak.count >= 2, true);
  S.setPositionHold(a, false);
  assert.equal(pos(a).hold_thin_limit, null);
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), false);
  assert.equal(feed(a, -60, 1, 200, m).event, "not_applicable");                // not held → the rule does not run at all
  assert.equal(pos(a).hold_thin_limit ?? null, null);
  S.setPositionHold(a, true);
  run(a, m); S.noteHoldThinLimitMark(a, {}, { confirm: true });
  S.recordClose(a, "test cleanup");
  assert.equal(pos(a).hold_thin_limit, null);
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), false);
  assert.equal(feed(a, -60, 1, 300, m), null);
}
{
  // Not thin, and unknown entry TVL: never a streak, whatever the PnL (fail closed).
  const m = { holdThinPoolLimitMode: "enforce" };
  for (const tvl of [336184, 100000, null]) {
    const a = mk("T" + String(tvl), { entry_tvl: tvl });
    const r = run(a, m);
    assert.deepEqual([r.thin, r.event, r.ready, pos(a).hold_thin_limit ?? null], [false, "not_applicable", false, null]);
    assert.equal(S.noteHoldThinLimitMark(a, {}, { confirm: true }), false);
    assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), false);
    S.recordClose(a, "test cleanup");
  }
  // Not held: nothing, and the evaluator's own HOLD skip is untouched.
  const n = mk("NOHOLD", { hold: false });
  assert.equal(run(n, m).event, "not_applicable");
  S.recordClose(n, "test cleanup");
  const h = mk("EVAL");
  assert.equal(S.updatePnlAndCheckExits(h, { pnl_pct: -60, in_range: false, active_bin: -500, lower_bin: -400, upper_bin: -331 }, { stopLossPct: -15 }), null);
  S.recordClose(h, "test cleanup");
}
{
  // One authorisation for both rules: a TVL-exit stamp serves the TVL exit only, and vice versa.
  assert.deepEqual(Object.keys(HOLD_OVERRIDE_RULES).sort(), ["hold_limit", "tvl_floor"]);
  const now = Date.now();
  const stampTvl = { hold_mode: true, tvl_floor_exit: { count: 3, confirmed_at: new Date(now).toISOString() } };
  const stampLim = { hold_mode: true, hold_thin_limit: { streak: { count: 2, confirmed_at: new Date(now).toISOString() } } };
  assert.equal(holdOverrideActive(stampTvl, {}, "tvl_floor", now), true);
  assert.equal(holdOverrideActive(stampTvl, {}, "hold_limit", now), false);
  assert.equal(holdOverrideActive(stampLim, {}, "hold_limit", now), true);
  assert.equal(holdOverrideActive(stampLim, {}, "tvl_floor", now), false);
  assert.equal(holdOverrideActive(stampLim, { holdThinPoolLimitMode: "shadow" }, "hold_limit", now), false);
  assert.equal(holdOverrideActive(stampTvl, { tvlFloorExitMode: "shadow" }, "tvl_floor", now), false);
  assert.equal(holdOverrideActive({ hold_mode: true }, {}, "hold_limit", now), false);
  assert.equal(holdOverrideActive(null, {}, "hold_limit", now), false);
}

// ── Alert A: thin-pool adoption warning — once, when entry TVL is known ───────────────
{
  const m = {};
  // async enrich: adopted with entry TVL still unknown → nothing; the enricher writes it → one warning
  const a = mk("ADOPT", { hold: false, entry_tvl: null, adopted: true });
  assert.equal(pos(a).adopted, true);
  assert.equal(S.noteThinPoolAdoptWarned(a, m), false);
  assert.equal(pos(a).thin_pool_adopt_warned_at ?? null, null);
  assert.deepEqual(S.attachEntryMetrics(a, { entry_tvl: 42622.68 }), ["entry_tvl"]);
  assert.equal(S.noteThinPoolAdoptWarned(a, m), true);
  assert.equal(S.noteThinPoolAdoptWarned(a, m), false);                          // latched on the position
  assert.ok(pos(a).thin_pool_adopt_warned_at);
  S.recordClose(a, "test cleanup");
  // not thin / switched off / bot deploy / recovered bot deploy / closed → never
  const big = mk("ADOPTBIG", { hold: false, entry_tvl: 336184, adopted: true });
  assert.equal(S.noteThinPoolAdoptWarned(big, m), false); S.recordClose(big, "test cleanup");
  const off = mk("ADOPTOFF", { hold: false, adopted: true });
  assert.equal(S.noteThinPoolAdoptWarned(off, { adoptThinPoolWarnEnabled: false }), false);
  assert.equal(S.noteThinPoolAdoptWarned(off, m), true); S.recordClose(off, "test cleanup");
  const bot = mk("BOT", { hold: false });
  assert.equal(S.noteThinPoolAdoptWarned(bot, m), false); S.recordClose(bot, "test cleanup");
  assert.equal(shouldWarnThinPoolAdoption({ adopted: true, entry_tvl: 5000, strategy_source: "bot_recovery" }, m), false);
  assert.equal(shouldWarnThinPoolAdoption({ adopted: true, entry_tvl: 5000, strategy_source: "bot_deploy_recovered" }, m), false);
  assert.equal(shouldWarnThinPoolAdoption({ adopted: true, entry_tvl: 5000, strategy_source: "manual_adoption" }, m), true);
  assert.equal(shouldWarnThinPoolAdoption({ adopted: true, entry_tvl: 5000, closed: true }, m), false);
  assert.equal(shouldWarnThinPoolAdoption({ adopted: true, entry_tvl: null }, m), false);
  assert.equal(S.noteThinPoolAdoptWarned("NOPE_" + Date.now(), m), false);
}

// ── Alert B latch: once per hold (the shadow's own record) ─────────────────────────────
{
  const dcfg = { stopLossPct: -15, holdDownsideMode: "shadow" };
  const a = mk("ALERTB");
  const fire = (pnl) => S.noteHoldDownsideShadow(a, S.evaluateHoldDownside(pos(a), pnl, dcfg), pnl);
  assert.equal(fire(-8), false);
  assert.equal(fire(-15.4), true);        // the log line and Alert B go out here
  assert.equal(fire(-22), false);
  assert.equal(fire(-15.1), false);
  S.setPositionHold(a, false); S.setPositionHold(a, true);
  assert.equal(fire(-16), true);          // a new hold alerts again
  S.recordClose(a, "test cleanup");
}

// ── Telegram texts ────────────────────────────────────────────────────────────────────
const I = await import("../index.js");
const { sanitizeTelegramHTML } = await import("../telegram.js");
{
  const fireText = I.holdThinLimitAlertText({ pair: "FACTORY-SOL", pnlPct: -26.1, heldSec: 65, valuations: 3, entryTvlUsd: 42622.68, cfg });
  assert.equal(fireText,
    "🚨 <b>Thin-pool hold limit — HOLD overridden</b>\nFACTORY-SOL: PnL -26.10% has been at or under the -25% limit for 65s (3 valuations). Pool TVL at entry $42,623, under the $100,000 thin-pool bar.\n" +
    "This position was On Hold. A held position in a thin pool is closed at this level; closing now and selling the remainder to SOL.\n<i>Switch: holdThinPoolLimitMode (enforce | shadow | off).</i>");
  const a = I.thinPoolAdoptionAlertText({ pair: "FACTORY-SOL", amountSol: 1.4802, entryTvlUsd: 42622.68, mgmt: {} });
  assert.equal(a,
    "⚠️ <b>Thin pool — adopted position</b>\nFACTORY-SOL (◎1.480): pool TVL at entry $42,623 — under the bot's own $100,000 entry bar.\n" +
    "If you put it on hold: the thin-pool limit closes it at -25% PnL, and the TVL exit closes it once pool TVL is under $10,000.\n<i>Switches: holdThinPoolLimitMode, adoptThinPoolWarnEnabled.</i>");
  const aShadow = I.thinPoolAdoptionAlertText({ pair: "X-SOL", amountSol: null, entryTvlUsd: 5000, mgmt: { holdThinPoolLimitMode: "shadow", tvlFloorExitMode: "off" } });
  assert.match(aShadow, /^⚠️ <b>Thin pool — adopted position<\/b>\nX-SOL: pool TVL at entry \$5,000/);
  assert.match(aShadow, /the thin-pool limit \(-25%\) is NOT closing anything \(holdThinPoolLimitMode=shadow\), and the TVL exit is NOT closing anything \(tvlFloorExitMode=off\)\./);
  const v = { rule: "stop_loss", threshold_pct: -15, pnl_pct: -15.4 };
  const bThin = I.holdDownsideAlertText({ pair: "FACTORY-SOL", verdict: v, heldMin: 42, tracked: { entry_tvl: 42622.68 }, mgmt: {} });
  assert.equal(bThin,
    "🧊 <b>Held position at the stop level</b>\nFACTORY-SOL: PnL -15.40% reached the stop loss level (-15%), 42 min into the hold. Held — nothing closed.\n" +
    "Thin pool (TVL at entry $42,623): the thin-pool limit closes it at -25%.\n<i>/unset hands it back to the rules. Switch: holdDownsideAlertEnabled.</i>");
  const bBig = I.holdDownsideAlertText({ pair: "CRAWL-SOL", verdict: { rule: "young_stop", threshold_pct: -10, pnl_pct: -10.5 }, heldMin: null, tracked: { entry_tvl: 336184 }, mgmt: {} });
  assert.equal(bBig, "🧊 <b>Held position at the stop level</b>\nCRAWL-SOL: PnL -10.50% reached the young-token stop level (-10%). Held — nothing closed.\n<i>/unset hands it back to the rules. Switch: holdDownsideAlertEnabled.</i>");
  assert.doesNotMatch(I.holdDownsideAlertText({ pair: "F-SOL", verdict: v, heldMin: 1, tracked: { entry_tvl: 42622 }, mgmt: { holdThinPoolLimitMode: "shadow" } }), /thin-pool limit/);
  assert.doesNotMatch(I.holdDownsideAlertText({ pair: "F-SOL", verdict: v, heldMin: 1, tracked: { entry_tvl: null }, mgmt: {} }), /thin-pool limit/);
  // every text survives the HTML sanitiser unchanged (no raw < > & outside tags), pair names are escaped
  for (const t of [fireText, a, aShadow, bThin, bBig]) assert.equal(sanitizeTelegramHTML(t), t);
  assert.match(I.thinPoolAdoptionAlertText({ pair: "A<B>-SOL", amountSol: 1, entryTvlUsd: 5000, mgmt: {} }), /A&lt;B&gt;-SOL/);
}

// ── Wiring ────────────────────────────────────────────────────────────────────────────
const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
const cfgSrc = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
// runs in the 5 s poller's hold branch (first caller) and the management cycle's hold block (second), nowhere else
assert.equal((idx.match(/checkHoldThinLimit\(/g) || []).length, 3);
assert.match(idx, /if \(operatorHold\) \{\s*registerExitSignal\(p\.position, null, confirmTicks\);[\s\S]{0,900}const holdLimitExit = checkHoldThinLimit\(p\);[\s\S]{0,1200}break; \/\/ one action per tick\s*\}\s*continue;\s*\}/);
assert.match(idx, /log\("state", "Automatic exits suppressed for " \+ p\.pair \+ ": operator HOLD is active"\);[\s\S]{0,200}const holdLimitExit = checkHoldThinLimit\(p\);/);
// synchronous, no network call in the check
assert.match(idx, /\nfunction checkHoldThinLimit\(p\) \{/);
{
  const body = idx.slice(idx.indexOf("\nfunction checkHoldThinLimit(p) {"), idx.indexOf("/** Telegram text when the thin-pool hold limit closes"));
  assert.doesNotMatch(body, /await |fetch\(|getPoolDetail|getMyPositions/);
  // only a ready reading of this tick, only in enforce, and only after the stamp was written
  assert.match(body, /if \(!res\.ready \|\| !s \|\| \(res\.event !== "counted" && res\.event !== "repeat"\)\) return null;/);
  assert.match(body, /if \(cfg\.mode !== "enforce"\) \{[\s\S]{0,500}\[HOLD_THIN_LIMIT_SHADOW\] would-close[\s\S]{0,200}return null;\s*\}/);
  assert.match(body, /if \(!noteHoldThinLimitMark\(p\.position, [^\n]*\{ confirm: true \}\)\) return null;/);
  assert.match(body, /catch \(e\) \{[\s\S]{0,200}return null;/);
}
// all three HOLD guards take the one shared authorisation; no rule-specific bypass is left
for (const src of [idx, exe, dlmm]) assert.doesNotMatch(src, /tvlFloorOverrideActive/);
assert.match(idx, /const holdOverride = act\.action === "CLOSE" && holdOverrideActive\(heldNow, config\.management, act\.hold_override\);/);
assert.match(idx, /heldNow\?\.hold_mode === true && act\.action !== "CLAIM" && act\.action !== "STAY" && !holdOverride\)/);
assert.match(exe, /tracked\?\.hold_mode === true && !holdOverrideActive\(tracked, config\.management, args\?\.hold_override\)/);
assert.match(dlmm, /tracked\?\.hold_mode === true && _operator_override !== true && !holdOverrideActive\(tracked, config\.management, hold_override\)/);
// rebalance / claim / every other guard on a held position is unchanged
assert.match(exe, /if \(tracked\?\.hold_mode === true\) \{\s*const reason = "Position is On Hold; automatic and LLM rebalances are disabled/);
// Alert A hangs on the enricher (where entry_tvl becomes known), Alert B on the shadow's latch
assert.match(idx, /const written = attachEntryMetrics\(positionAddress, \{[\s\S]{0,700}\}\);\s*\/\/ Alert A[^\n]*\n\s*try \{ warnThinPoolAdoption\(positionAddress\); \} catch/);
assert.match(idx, /if \(noteHoldDownsideShadow\(p\.position, hv, p\.pnl_pct\)\) \{[\s\S]{0,900}if \(config\.management\.holdDownsideAlertEnabled !== false\) \{\s*sendHTML\(holdDownsideAlertText\(/);
// switches
for (const k of ["holdThinPoolLimitMode", "holdThinPoolLimitPct", "holdThinPoolTvlUsd", "holdThinPoolLimitConfirmSec", "adoptThinPoolWarnEnabled", "holdDownsideAlertEnabled"]) {
  assert.match(exe, new RegExp(`${k}: \\["management", "${k}"\\]`), `update_config ${k}`);
  assert.match(cfgSrc, new RegExp(`${k}:`), `config default ${k}`);
  assert.match(cfgSrc, new RegExp(`fresh\\.${k}`), `config reload ${k}`);
}
assert.match(idx, /hold_limit: "Thin-pool hold limit"/);

console.log("OK — thin-pool hold limit");
process.exit(0);
