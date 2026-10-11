process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== TVL-floor exit (overrides HOLD) ===");

const F = await import("../tvl-floor-exit.js");
const {
  RUG_FLOOR_TVL_USD, tvlFloorExitConfig, readPoolTvlUsd, advanceTvlFloorStreak, onChainTvlUsd,
  crossCheckTvlFloor, buildTvlFloorExit, TVL_FLOOR_CONFIRM_TTL_MS,
} = F;

// The HOLD-guard authorisation is shared with the thin-pool hold limit (hold-override.js).
const { holdOverrideActive } = await import("../hold-override.js");

const MIN = 60_000;
const T0 = Date.parse("2026-10-10T15:03:00Z");
const cfg = tvlFloorExitConfig({});

// ── Config: defaults, one floor constant, typo-safe mode ──────────────────────────────
assert.deepEqual(cfg, { mode: "enforce", floorUsd: 10000, minReadings: 3, minMinutes: 5 });
const { RUG_FLOOR_TVL } = await import("../tools/screening.js");
assert.equal(RUG_FLOOR_TVL, RUG_FLOOR_TVL_USD);                       // screening floor and exit floor cannot drift
assert.equal(tvlFloorExitConfig({ tvlFloorExitMode: "shadow" }).mode, "shadow");
assert.equal(tvlFloorExitConfig({ tvlFloorExitMode: "off" }).mode, "off");
assert.equal(tvlFloorExitConfig({ tvlFloorExitMode: "of" }).mode, "shadow");   // a typo never enforces
assert.equal(tvlFloorExitConfig({ tvlFloorExitUsd: 0 }).floorUsd, 10000);
assert.equal(tvlFloorExitConfig({ tvlFloorExitUsd: "8000" }).floorUsd, 8000);
assert.equal(tvlFloorExitConfig({ tvlFloorExitMinReadings: 1 }).minReadings, 3); // one reading can never be enough
const { config } = await import("../config.js");
assert.equal(config.management.tvlFloorExitMode, "enforce");
assert.equal(config.management.tvlFloorExitUsd, RUG_FLOOR_TVL_USD);

// ── Reading: only the raw `tvl` of a row for THIS pool ────────────────────────────────
assert.deepEqual(readPoolTvlUsd({ pool_address: "P", tvl: 8412.5, active_tvl: 3 }, "P"), { ok: true, tvl_usd: 8412.5 });
assert.deepEqual(readPoolTvlUsd({ pool_address: "P", tvl: 0 }, "P"), { ok: true, tvl_usd: 0 });   // a literal 0 is a reading
for (const bad of [null, undefined, "x", {}, { pool_address: "P" }, { pool_address: "P", tvl: null }, { pool_address: "P", tvl: "8412" },
  { pool_address: "P", tvl: NaN }, { pool_address: "P", tvl: Infinity }, { pool_address: "P", tvl: -1 },
  { pool_address: "P", active_tvl: 50 },             // never falls back to active_tvl
  { pool_address: "OTHER", tvl: 50 }]) {             // a row for another pool
  assert.equal(readPoolTvlUsd(bad, "P").ok, false, JSON.stringify(bad));
}

// ── Streak ────────────────────────────────────────────────────────────────────────────
const below = (v) => ({ ok: true, tvl_usd: v });
const failed = { ok: false, reason: "fetch failed: 502" };
let r = advanceTvlFloorStreak(null, below(9969), cfg, T0);
assert.deepEqual([r.event, r.streak.count, r.ready], ["started", 1, false]);
r = advanceTvlFloorStreak(r.streak, below(9050), cfg, T0 + 3 * MIN);
assert.deepEqual([r.event, r.streak.count, r.ready], ["counted", 2, false]);
// third reading, but only 4.5 min after the first: count is there, the span is not
let early = advanceTvlFloorStreak(r.streak, below(8800), cfg, T0 + 4.5 * MIN);
assert.deepEqual([early.event, early.streak.count, early.ready], ["counted", 3, false]);
// third reading 5m13 after the first (the FACTORY-SOL sequence 22:03:00 / 22:06:00 / 22:08:13 WIB)
let done = advanceTvlFloorStreak(r.streak, below(8591), cfg, T0 + 5 * MIN + 13_000);
assert.deepEqual([done.event, done.streak.count, done.ready], ["counted", 3, true]);
assert.equal(done.streak.last_tvl_usd, 8591);
assert.equal(done.streak.first_tvl_usd, 9969);

// a failed / zero-looking-missing / NaN reading neither counts nor resets, and never completes a streak
for (const bad of [failed, null, undefined, {}, { ok: true, tvl_usd: NaN }, { ok: true, tvl_usd: null }, { ok: true, tvl_usd: "5" }, { ok: true, tvl_usd: -3 }, { ok: false, tvl_usd: 5 }]) {
  const x = advanceTvlFloorStreak(r.streak, bad, cfg, T0 + 30 * MIN);
  assert.deepEqual([x.event, x.ready, x.streak], ["ignored", false, r.streak]);
  const y = advanceTvlFloorStreak(done.streak, bad, cfg, T0 + 9 * MIN);   // even on a streak that is already complete
  assert.equal(y.ready, false);
  assert.equal(advanceTvlFloorStreak(null, bad, cfg, T0).streak, null);
}
// a feed that only ever fails never fires
{
  let s = null;
  for (let i = 0; i < 50; i++) { const x = advanceTvlFloorStreak(s, i % 2 ? failed : { ok: true, tvl_usd: NaN }, cfg, T0 + i * 3 * MIN); s = x.streak; assert.equal(x.ready, false); }
  assert.equal(s, null);
}
// a reading at/above the floor resets
assert.deepEqual((({ event, streak }) => [event, streak])(advanceTvlFloorStreak(r.streak, below(10000), cfg, T0 + 6 * MIN)), ["reset", null]);
assert.equal(advanceTvlFloorStreak(done.streak, below(42000), cfg, T0 + 9 * MIN).streak, null);
// two readings seconds apart are one reading
{
  const m = advanceTvlFloorStreak(r.streak, below(7000), cfg, T0 + 3 * MIN + 20_000);
  assert.deepEqual([m.event, m.streak.count, m.streak.last_tvl_usd, m.ready], ["merged", 2, 7000, false]);
}
// a long gap (restart, feed outage) starts over; so does a clock that went backwards
assert.deepEqual((({ event, streak }) => [event, streak.count])(advanceTvlFloorStreak(r.streak, below(5000), cfg, T0 + 3 * MIN + 31 * MIN)), ["restarted", 1]);
assert.equal(advanceTvlFloorStreak(r.streak, below(5000), cfg, T0 - MIN).event, "restarted");
// a literal 0 counts as below — the on-chain check decides whether it is real
assert.equal(advanceTvlFloorStreak(r.streak, below(0), cfg, T0 + 6 * MIN).ready, true);
// N and M are configurable
{
  const c2 = tvlFloorExitConfig({ tvlFloorExitMinReadings: 2, tvlFloorExitMinMinutes: 3 });
  assert.equal(advanceTvlFloorStreak(advanceTvlFloorStreak(null, below(1), c2, T0).streak, below(1), c2, T0 + 3 * MIN).ready, true);
}

// ── On-chain figure + cross-check ─────────────────────────────────────────────────────
// FACTORY-SOL 2026-10-11: reserves 17,603,168.89 FACTORY + 1.5691 SOL, active-bin price 5.684e-7 SOL, SOL $110.14 → Meteora tvl $1,274.94
{
  const activeId = Math.round(Math.log(5.68392435221e-7 / 1e-3) / Math.log(1.01)); // decX 6, decY 9 → 10^(6-9)
  const v = onChainTvlUsd({ xUi: 17603168.887, yUi: 1.569135891, activeId, binStep: 100, decX: 6, decY: 9, solUsd: 110.1428804588584 });
  assert.ok(Math.abs(v - 1274.94) / 1274.94 < 0.01, `on-chain ${v}`);
}
for (const bad of [{}, { xUi: 1, yUi: 1, activeId: 0, binStep: 100, decX: 6, decY: 9, solUsd: 0 }, { xUi: 1, yUi: 1, activeId: 0, binStep: 100, decX: 6, decY: 9 },
  { xUi: NaN, yUi: 1, activeId: 0, binStep: 100, decX: 6, decY: 9, solUsd: 100 }, { xUi: 1, yUi: 1, activeId: 0, binStep: 0, decX: 6, decY: 9, solUsd: 100 },
  { xUi: "1", yUi: 1, activeId: 0, binStep: 100, decX: 6, decY: 9, solUsd: 100 }]) {
  assert.equal(onChainTvlUsd(bad), null);
}
assert.deepEqual(crossCheckTvlFloor({ ok: true, tvl_usd: 9300 }, cfg), { verdict: "confirmed", chain_tvl_usd: 9300 });
assert.equal(crossCheckTvlFloor({ ok: true, tvl_usd: 0 }, cfg).verdict, "confirmed");            // a drained pool, confirmed by the chain
assert.equal(crossCheckTvlFloor({ ok: true, tvl_usd: 10000 }, cfg).verdict, "disagree");
assert.equal(crossCheckTvlFloor({ ok: true, tvl_usd: 42000 }, cfg).verdict, "disagree");        // API said 0 by mistake → chain refuses
for (const bad of [null, undefined, {}, { ok: false, reason: "rpc" }, { ok: true }, { ok: true, tvl_usd: NaN }, { ok: true, tvl_usd: -1 }, { ok: true, tvl_usd: "5" }]) {
  assert.equal(crossCheckTvlFloor(bad, cfg).verdict, "unavailable");
}

// ── Exit object: family, urgency, hold override, reason wording ───────────────────────
const { exitFamilyFromReason, classifyOutcome } = await import("../lessons.js");
const { finalizeExit, URGENT_EXIT_ACTIONS, EXIT_FAMILY_BY_ACTION } = await import("../state.js");
for (const held of [true, false]) {
  const exit = finalizeExit(buildTvlFloorExit({ streak: done.streak, chainTvlUsd: 9300, cfg, held }));
  assert.deepEqual([exit.action, exit.rule, exit.family, exit.urgent, exit.hold_override], ["TVL_FLOOR", "tvl_floor", "tvl_floor", true, held ? "tvl_floor" : null]);
  assert.equal(exitFamilyFromReason(exit.reason), "tvl_floor");
  assert.match(exit.reason, /^TVL exit: pool TVL \$8,591 under the \$10,000 minimum for 3 readings in 5m \(on-chain reserves \$9,300\) — hard exit/);
  assert.equal(/overrides HOLD/.test(exit.reason), held);
  // legacy substring scans (pool-memory / lessons / hivemind) must not read it as an OOR or fee-death close
  assert.equal(/oor|below|above|out of range|yield|volume|stop loss|[<>&]/i.test(exit.reason), false, exit.reason);
}
assert.ok(URGENT_EXIT_ACTIONS.has("TVL_FLOOR"));
assert.equal(EXIT_FAMILY_BY_ACTION.TVL_FLOOR, "tvl_floor");
assert.equal(classifyOutcome({ pnl_pct: -3, exit_family: "tvl_floor", initial_value_usd: 1, fees_earned_usd: 0 }), "failure");
assert.equal(classifyOutcome({ pnl_pct: 6, exit_family: "tvl_floor", initial_value_usd: 1, fees_earned_usd: 0.1 }), "neutral"); // never a PREFER lesson

// ── State on the position: held and non-held alike, persistence, cleared on close ─────
const S = await import("../state.js");
await S.ensureStateInitialized();
const mk = (tag, hold) => {
  const addr = `TEST_TVL_FLOOR_${tag}_${Date.now()}`;
  S.trackPosition({ position: addr, pool: "POOL_TF_" + tag, pool_name: tag + "-SOL", amount_sol: 1.48, strategy: "spot" });
  if (hold) S.setPositionHold(addr, true);
  return addr;
};
for (const hold of [true, false]) {
  for (const mode of ["enforce", "shadow"]) {
    const addr = mk(`${hold ? "H" : "N"}${mode}`, hold);
    const m = { tvlFloorExitMode: mode };
    const pos = () => S.getTrackedPosition(addr);
    assert.equal(S.noteTvlFloorReading(addr, below(9969), m, T0).ready, false);
    assert.equal(S.noteTvlFloorReading(addr, failed, m, T0 + 1.5 * MIN).event, "ignored");
    assert.equal(pos().tvl_floor_exit.count, 1);                                   // the streak is on the position → survives a restart
    assert.equal(S.noteTvlFloorReading(addr, below(9050), m, T0 + 3 * MIN).ready, false);
    const fin = S.noteTvlFloorReading(addr, below(8591), m, T0 + 5 * MIN + 13_000);
    assert.equal(fin.ready, true, `${hold ? "held" : "free"} ${mode}`);
    assert.equal(pos().hold_mode === true, hold);                                  // the hold flag itself is not touched
    // nothing passes the HOLD guards until the chain confirmed it, and only in enforce
    assert.equal(holdOverrideActive(pos(), m, "tvl_floor"), false);
    S.noteTvlFloorCrossCheck(addr, "unavailable");
    assert.equal(holdOverrideActive(pos(), m, "tvl_floor"), false);
    S.noteTvlFloorCrossCheck(addr, "confirmed", 9300, { alerted_at: new Date().toISOString() });
    assert.equal(pos().tvl_floor_exit.chain_tvl_usd, 9300);
    assert.equal(holdOverrideActive(pos(), m, "tvl_floor"), mode === "enforce");
    assert.equal(holdOverrideActive(pos(), m, undefined), false);              // the stamp without the request
    assert.equal(holdOverrideActive(pos(), m, true), false);
    assert.equal(holdOverrideActive(pos(), { tvlFloorExitMode: "off" }, "tvl_floor"), false);
    assert.equal(holdOverrideActive(pos(), m, "tvl_floor", Date.now() + TVL_FLOOR_CONFIRM_TTL_MS + 1000), false); // stale stamp
    // the next reading needs its own confirmation
    S.noteTvlFloorReading(addr, below(8000), m, T0 + 8 * MIN);
    assert.equal(pos().tvl_floor_exit.confirmed_at, null);
    assert.equal(pos().tvl_floor_exit.alerted_at != null, true);                   // one alert per streak
    assert.equal(holdOverrideActive(pos(), m, "tvl_floor"), false);
    // recovery clears everything
    assert.equal(S.noteTvlFloorReading(addr, below(15000), m, T0 + 11 * MIN).event, "reset");
    assert.equal(pos().tvl_floor_exit, null);
    // disagreement clears the streak; mode off clears it too
    S.noteTvlFloorReading(addr, below(1), m, T0 + 14 * MIN);
    S.noteTvlFloorCrossCheck(addr, "disagree");
    assert.equal(pos().tvl_floor_exit, null);
    S.noteTvlFloorReading(addr, below(1), m, T0 + 17 * MIN);
    assert.equal(S.noteTvlFloorReading(addr, below(1), { tvlFloorExitMode: "off" }, T0 + 20 * MIN).ready, false);
    assert.equal(pos().tvl_floor_exit, null);
    // cleared on close; a closed position takes no readings
    S.noteTvlFloorReading(addr, below(1), m, T0 + 23 * MIN);
    S.noteTvlFloorCrossCheck(addr, "confirmed", 1);
    S.recordClose(addr, "test cleanup");
    assert.equal(pos().tvl_floor_exit, null);
    assert.equal(holdOverrideActive(pos(), m, "tvl_floor"), false);
    assert.equal(S.noteTvlFloorReading(addr, below(1), m, T0 + 26 * MIN), null);
  }
}
// HOLD still suppresses every evaluator exit — nothing else changed
{
  const addr = mk("EVAL", true);
  assert.equal(S.updatePnlAndCheckExits(addr, { pnl_pct: -60, in_range: false, active_bin: -500, lower_bin: -400, upper_bin: -331 }, { stopLossPct: -15 }), null);
  S.recordClose(addr, "test cleanup");
}

// ── Wiring ────────────────────────────────────────────────────────────────────────────
const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
// evaluated in the management cycle before the hold skip, for every position
assert.match(idx, /const tvlFloorExit = await checkTvlFloorExit\(p, tvlFloorCfg, operatorHold\);[\s\S]{0,260}continue;\s*\}\s*if \(operatorHold\) \{/);
// the reading is the raw field of a successful fetch, and a thrown fetch is a failed reading
assert.match(idx, /tvlFloorReading = readPoolTvlUsd\(detail, p\.pool\);/);
assert.match(idx, /tvlFloorReading = \{ ok: false, reason: `fetch failed:/);
// the on-chain check runs only on a streak completed by this cycle's reading; shadow and failures return null
assert.match(idx, /if \(!res\.ready \|\| \(res\.event !== "counted" && res\.event !== "merged"\)\) return null;\s*const chain = await getPoolOnChainTvlUsd\(p\.pool\);/);
assert.match(idx, /\[TVL_FLOOR_EXIT_SHADOW\] would-close/);
assert.match(idx, /if \(cfg\.mode !== "enforce"\) \{[\s\S]{0,700}return null;\s*\}\s*const firstAlert/);
// all three HOLD guards take the same narrow override
assert.match(idx, /const holdOverride = act\.action === "CLOSE" && holdOverrideActive\(heldNow, config\.management, act\.hold_override\);/);
assert.match(exe, /tracked\?\.hold_mode === true && !holdOverrideActive\(tracked, config\.management, args\?\.hold_override\)/);
assert.match(dlmm, /tracked\?\.hold_mode === true && _operator_override !== true && !holdOverrideActive\(tracked, config\.management, hold_override\)/);
// the poller makes no pool-detail call for it
assert.equal((idx.match(/checkTvlFloorExit\(/g) || []).length, 2); // definition + the one management-cycle call
assert.match(exe, /tvlFloorExitMode: \["management", "tvlFloorExitMode"\]/);
assert.match(exe, /tvlFloorExitUsd: \["management", "tvlFloorExitUsd"\]/);
assert.match(idx, /tvl_floor: "TVL floor"/);

console.log("✅ TVL-floor exit verified");
