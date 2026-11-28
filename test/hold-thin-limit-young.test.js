/**
 * Young-token exemption of the thin-pool hold limit (2026-11-28, operator: "Please exempt the
 * thin pool hold limit for all positions that pertains to young tokens.").
 * A held thin-pool position whose base token was under holdThinPoolYoungTokenHours (72) old AT
 * ENTRY is never closed by the limit: the proof runs, log-only. Unknown age → the rule applies.
 */
process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
delete process.env.TELEGRAM_BOT_TOKEN; // nothing is ever sent from a test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const L = await import("../hold-thin-limit.js");
const { holdOverrideActive } = await import("../hold-override.js");
const S = await import("../state.js");
const { config } = await import("../config.js");
await S.ensureStateInitialized();

const SEC = 1000, H = 3_600_000;
const T0 = Date.parse("2026-11-28T03:00:00Z");
const ENF = { holdThinPoolLimitMode: "enforce" };
const ENF0 = { ...ENF, holdThinPoolYoungTokenHours: 0 };
const SET = [];
let seq = 0;
const iso = (ms) => new Date(ms).toISOString();

/** A held thin-pool position. `createdAgoH` = token creation hours before the entry; null = unknown. */
const mk = (tag, { createdAgoH = 10, adopted = false, deployedAgoH = 0, hold = true, extra = {} } = {}) => {
  const addr = `TEST_THIN_YOUNG_${tag}_${Date.now()}_${seq++}`;
  const deployedMs = Date.now() - deployedAgoH * H;
  const entryMs = adopted ? Date.now() : deployedMs;
  S.trackPosition({
    position: addr, pool: "POOL_TY_" + tag, pool_name: tag + "-SOL", amount_sol: 1.48, strategy: "spot",
    entry_tvl: 42622.68, bin_step: 100, deployed_at: iso(deployedMs), adopted,
    base_token_created_at: createdAgoH == null ? null : iso(entryMs - createdAgoH * H),
    base_token_created_source: createdAgoH == null ? null : "test",
    ...extra,
  });
  if (hold) S.setPositionHold(addr, true);
  SET.push(addr);
  return addr;
};
const pos = (a) => S.getTrackedPosition(a);
const row = (pnl, bin, extra = {}) => ({ pnl_pct: pnl, active_bin: bin, pnl_basis: "sol", pnl_management_ready: true, total_value_usd: 100 + pnl, ...extra });
const feed = (a, pnl, bin, t, mgmt = ENF, extra = {}) => S.noteHoldThinLimitReading(a, L.holdThinLimitReading(row(pnl, bin, extra), pos(a), mgmt), mgmt, { nowMs: T0 + t * SEC });
// The exemption test's qualifying sequence: above, a plausible crossing, then held under for 70 s.
const sequence = (a, mgmt = ENF) => [feed(a, -20, 10, 0, mgmt), feed(a, -26, 3, 5, mgmt), feed(a, -27, 2, 40, mgmt), feed(a, -28, 1, 75, mgmt), feed(a, -30, 0, 110, mgmt)];
const strip = (r) => ({ event: r.event, ready: r.ready, count: r.count, held: Math.round(r.held_sec) });

test("config: absent → 72, 0 = off, finite 0…720; a present but invalid value → 0 (exemption OFF)", () => {
  assert.equal(config.management.holdThinPoolYoungTokenHours, 72);
  assert.equal(L.holdThinYoungTokenHours({}), 72);
  assert.equal(L.holdThinYoungTokenHours({ holdThinPoolYoungTokenHours: 0 }), 0);
  assert.equal(L.holdThinYoungTokenHours({ holdThinPoolYoungTokenHours: 720 }), 720);
  assert.equal(L.holdThinYoungTokenHours({ holdThinPoolYoungTokenHours: "48" }), 48);
  assert.equal(L.holdThinYoungTokenHours({ holdThinPoolYoungTokenHours: undefined }), 72, "absent");
  for (const bad of [-1, 721, 1000, NaN, Infinity, "", "x", "abc", true, [], {}, null]) {
    assert.equal(L.holdThinYoungTokenHours({ holdThinPoolYoungTokenHours: bad }), 0, String(bad));
    assert.equal(L.isValidYoungTokenHours(bad), false, String(bad));
  }
  // an invalid key never makes a position young
  const p = { deployed_at: iso(T0), base_token_created_at: iso(T0 - H) };
  assert.equal(L.youngTokenStatus(p, {}).young, true);
  for (const bad of ["abc", -1, 1000]) assert.equal(L.youngTokenStatus(p, { holdThinPoolYoungTokenHours: bad }).young, false, String(bad));
  // the existing config object of the limit is unchanged (its tests deepEqual it)
  assert.deepEqual(L.holdThinLimitConfig({}), { mode: "enforce", limitPct: -25, tvlUsd: 100000, confirmSec: 60 });
  const cfgSrc = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfgSrc, /holdThinPoolYoungTokenHours: holdThinYoungTokenHours\(u\),/);
  assert.match(cfgSrc, /if \(overrides == null \|\| fresh\.holdThinPoolYoungTokenHours !== undefined\) config\.management\.holdThinPoolYoungTokenHours = holdThinYoungTokenHours\(fresh\);/);
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exe, /holdThinPoolYoungTokenHours: \["management", "holdThinPoolYoungTokenHours"\]/);
});

test("update_config accepts 0…720 (numeric strings normalised) and rejects the rest", async () => {
  const { executeTool } = await import("../tools/executor.js");
  const before = config.management.holdThinPoolYoungTokenHours;
  try {
    assert.equal((await executeTool("update_config", { changes: { holdThinPoolYoungTokenHours: 48 }, reason: "test" })).success, true);
    assert.equal(config.management.holdThinPoolYoungTokenHours, 48);
    assert.equal((await executeTool("update_config", { changes: { holdThinPoolYoungTokenHours: "0" }, reason: "test" })).success, true);
    assert.equal(config.management.holdThinPoolYoungTokenHours, 0);
    for (const bad of [-1, 721, "abc", true, null]) {
      await executeTool("update_config", { changes: { holdThinPoolYoungTokenHours: bad }, reason: "test" });
      assert.equal(config.management.holdThinPoolYoungTokenHours, 0, `rejected ${String(bad)}`);
    }
  } finally { config.management.holdThinPoolYoungTokenHours = before; }
});

test("youngTokenStatus: age AT ENTRY (adopted_at for adopted, else deployed_at); doubt → not young", () => {
  const now = Date.parse("2026-11-28T00:00:00Z");
  const base = { deployed_at: iso(now) };
  const st = (p, m = {}) => L.youngTokenStatus(p, m);
  assert.deepEqual(st({ ...base, base_token_created_at: iso(now - 10 * H) }), { young: true, known: true, token_age_h_at_entry: 10, threshold_h: 72, reason: "young" });
  assert.equal(st({ ...base, base_token_created_at: iso(now - 72 * H) }).young, false, "exactly at the threshold → not young");
  assert.equal(st({ ...base, base_token_created_at: iso(now - 72 * H + 1) }).young, true);
  assert.equal(st({ ...base, base_token_created_at: iso(now - 72 * H + 1000) }).token_age_h_at_entry, 71.9, "shown floored, never at the threshold");
  assert.equal(st({ ...base, base_token_created_at: iso(now - 10 * H) }, { holdThinPoolYoungTokenHours: 0 }).young, false, "0 = off");
  // adopted: entry = adopted_at, not the backdated deployed_at
  const adopted = { adopted: true, deployed_at: iso(now - 60 * H), adopted_at: iso(now), base_token_created_at: iso(now - 100 * H) };
  assert.equal(st(adopted).token_age_h_at_entry, 100);
  assert.equal(st(adopted).young, false);
  assert.equal(st({ ...adopted, adopted: false }).token_age_h_at_entry, 40, "a bot row with the same dates: deployed_at");
  assert.equal(st({ ...adopted, adopted: false }).young, true);
  // unknown / invalid
  for (const bad of [null, undefined, "", "garbage", iso(Date.UTC(2019, 0, 1)), 1795785104000]) {
    const r = st({ ...base, base_token_created_at: bad });
    assert.equal(r.young, false, String(bad)); assert.equal(r.known, false, String(bad));
  }
  assert.equal(st({ adopted: true, adopted_at: null, base_token_created_at: iso(now - H) }).known, false, "adopted without adopted_at");
  assert.equal(st({ deployed_at: null, base_token_created_at: iso(now - H) }).known, false, "no entry time");
  assert.equal(st({ ...base, base_token_created_at: iso(now + 2 * H) }).known, false, "created after the entry");
  // ≤ 5 min after the entry: clock skew → age 0, young; later: bad data → not young
  assert.deepEqual(st({ ...base, base_token_created_at: iso(now + 4 * 60_000) }), { young: true, known: true, token_age_h_at_entry: 0, threshold_h: 72, reason: "young" });
  assert.equal(st({ ...base, base_token_created_at: iso(now + 5 * 60_000) }).young, true, "exactly 5 min");
  for (const mins of [6, 30, 59]) {
    const r = st({ ...base, base_token_created_at: iso(now + mins * 60_000) });
    assert.deepEqual([r.young, r.known, r.reason], [false, false, "token creation time after the entry"], `${mins} min after`);
  }
  assert.equal(st(null).young, false);
});

test("pool-row validation: ms only, after 2020, not in the future, this pool / this base mint", () => {
  const now = Date.parse("2026-11-28T00:00:00Z");
  const winston = JSON.parse(fs.readFileSync(new URL("./fixtures/fresh-lane-winston.json", import.meta.url), "utf8"));
  const findRow = (o) => (o && typeof o === "object" ? (o.token_x?.created_at != null && o.pool_address ? o : Object.values(o).map(findRow).find(Boolean)) : null);
  const real = findRow(winston);
  assert.ok(real, "fixture row");
  assert.equal(L.tokenCreatedFromPoolRow(real, { pool: real.pool_address, nowMs: now }), iso(real.token_x.created_at));
  const r = (created, extra = {}) => ({ pool_address: "P1", token_x: { address: "MINT", created_at: created }, ...extra });
  assert.equal(L.tokenCreatedFromPoolRow(r(now - H), { pool: "P1", baseMint: "MINT", nowMs: now }), iso(now - H));
  assert.equal(L.tokenCreatedFromPoolRow(r(now + 30 * 60_000), { pool: "P1", nowMs: now }), iso(now + 30 * 60_000), "≤ 1 h ahead: clock skew");
  for (const bad of [Math.floor((now - H) / 1000), now + 2 * H, 0, -1, String(now - H), null, NaN, Infinity]) {
    assert.equal(L.tokenCreatedFromPoolRow(r(bad), { pool: "P1", nowMs: now }), null, `created_at ${String(bad)}`);
  }
  assert.equal(L.tokenCreatedFromPoolRow(r(now - H), { pool: "OTHER", nowMs: now }), null, "other pool");
  assert.equal(L.tokenCreatedFromPoolRow(r(now - H), { pool: "P1", baseMint: "OTHER_MINT", nowMs: now }), null, "other base mint");
  assert.equal(L.tokenCreatedFromPoolRow(null), null);
});

test("young + proof complete → no stamp, no exit, record written; same sequence with key 0 fires as before", () => {
  const y = mk("YOUNG", { createdAgoH: 10 });
  const r = sequence(y);
  const o = mk("OFF", { createdAgoH: 10 });
  const r0 = sequence(o, ENF0);
  const u = mk("UNKNOWN", { createdAgoH: null });
  const ru = sequence(u);
  // The machine advances identically in all three.
  assert.deepEqual(r.map(strip), r0.map(strip));
  assert.deepEqual(r.map(strip), ru.map(strip));
  assert.deepEqual(r.map((x) => x.event), ["above", "started", "counted", "counted", "counted"]);
  assert.equal(r[3].ready, true);
  // Young: flagged log-only, the proof is recorded once per streak, the stamp is refused.
  assert.ok(r.slice(1).every((x) => x.young_active === true));
  assert.deepEqual(r.map((x) => x.young_would_fire === true), [false, false, false, true, false]);
  assert.deepEqual(r.map((x) => x.young_would_fire_first === true), [false, false, false, true, false]);
  assert.deepEqual(r.map((x) => x.young_first_applied === true), [true, false, false, false, false]);
  const rec = pos(y).hold_thin_limit_young;
  assert.equal(rec.token_age_h_at_entry, 10);
  assert.equal(rec.threshold_h, 72);
  assert.equal(rec.first_would_fire_at, iso(T0 + 75 * SEC));
  assert.equal(rec.pnl_pct_at_would_fire, -28);
  assert.equal(rec.worst_pnl_pct, -30, "keeps following after the would-fire");
  assert.equal(rec.would_fire_count, 1);
  assert.equal(holdOverrideActive(pos(y), ENF, "hold_limit"), false);
  // Key 0 and unknown age: no young record, stamp works, override opens — today's behaviour.
  for (const [a, rr, m] of [[o, r0, ENF0], [u, ru, ENF]]) {
    assert.ok(rr.every((x) => x.young_active === false));
    assert.equal(pos(a).hold_thin_limit_young ?? null, null);
    assert.equal(S.noteHoldThinLimitMark(a, {}, { confirm: true }), true);
    assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), true);
  }
  assert.ok(ru.every((x) => x.age_unknown === true), "unknown age reported on every reading (index.js decides when to log)");
  assert.ok(r0.every((x) => x.age_unknown === undefined), "key 0: nothing about age");
  assert.equal(pos(y).token_age_hours_at_deploy, null, "the young-token stop's field is not written");
});

test("a second streak counts again; only the first would-fire sets the record's figures", () => {
  const y = mk("TWICE", { createdAgoH: 30 });
  sequence(y);
  feed(y, -20, 10, 120);                 // back above: reset
  feed(y, -26, 3, 125); feed(y, -27, 2, 160);
  const last = feed(y, -31, 0, 200);
  assert.equal(last.ready, true);
  assert.equal(last.young_would_fire, true);
  assert.equal(last.young_would_fire_first, false);
  const rec = pos(y).hold_thin_limit_young;
  assert.equal(rec.would_fire_count, 2);
  assert.equal(rec.pnl_pct_at_would_fire, -28);
  assert.equal(rec.worst_pnl_pct, -31);
});

test("stale stamp + young → dropped on the next reading and holdOverrideActive refuses it anyway", () => {
  // Unknown age at first: fires and is stamped as today …
  const a = mk("STALE", { createdAgoH: null });
  sequence(a);
  assert.equal(S.noteHoldThinLimitMark(a, {}, { confirm: true }), true);
  assert.equal(holdOverrideActive(pos(a), ENF, "hold_limit"), true);
  // … then the cycle backfills a young creation time: the stamp no longer opens the guard.
  pos(a).base_token_created_at = iso(Date.parse(pos(a).deployed_at) - 5 * H);
  assert.equal(holdOverrideActive(pos(a), ENF, "hold_limit"), false, "belt and braces");
  feed(a, -31, -1, 115);
  assert.equal(pos(a).hold_thin_limit.streak.confirmed_at, null, "stamp dropped");
  // Other rules untouched by the young check.
  assert.equal(holdOverrideActive({ ...pos(a), tvl_floor_exit: { confirmed_at: new Date().toISOString() } }, { tvlFloorExitMode: "enforce" }, "tvl_floor"), true);
});

test("operator exemption and hands-off behave exactly as before for a young position", () => {
  const ex = mk("EX", { createdAgoH: 10 });
  S.setHoldThinLimitExempt(ex, true);
  const r = sequence(ex);
  assert.deepEqual(r.map((x) => x.event), ["exempt", "exempt", "exempt", "exempt", "exempt"]);
  assert.ok(r.every((x) => !x.young_active));
  assert.equal(pos(ex).hold_thin_limit_young ?? null, null);

  const ho = mk("HO", { createdAgoH: 10 });
  assert.equal(S.setPositionHandsOff(ho, new Date(Date.now() + 2 * H).toISOString()).ok !== false, true);
  const rh = [feed(ho, -20, 10, 0, ENF), feed(ho, -26, 3, 5, ENF)];
  for (const x of rh) assert.equal(x.event, "hands_off");
  assert.equal(pos(ho).hold_thin_limit_young ?? null, null);
});

test("global mode shadow / off: nothing changes for a young position", () => {
  const sh = mk("SHADOW", { createdAgoH: 10 });
  const r = sequence(sh, { holdThinPoolLimitMode: "shadow" });
  assert.equal(r[3].ready, true);
  assert.ok(r.every((x) => !x.young_active));
  assert.equal(pos(sh).hold_thin_limit_young ?? null, null);
  const off = mk("MODEOFF", { createdAgoH: 10 });
  assert.ok(sequence(off, { holdThinPoolLimitMode: "off" }).every((x) => x.event === "off"));
});

test("dual machine (cost basis after a partial withdrawal): both machines advance; young → no stamp", () => {
  const extraRow = (pnl) => ({ pnl_sol_rule: (pnl / 100) * 1.48 });
  const run = (a, mgmt) => [[-20, 10, 0], [-26, 3, 5], [-27, 2, 40], [-28, 1, 75]].map(([p, b, t]) => feed(a, p, b, t, mgmt, extraRow(p)));
  const y = mk("DUALY", { createdAgoH: 10, extra: {} });
  pos(y).avg_cost_basis = { basis_sol: 1.48, changes: 1, at: iso(T0) };
  const o = mk("DUAL0", { createdAgoH: 10 });
  pos(o).avg_cost_basis = { basis_sol: 1.48, changes: 1, at: iso(T0) };
  const ry = run(y, ENF), r0 = run(o, ENF0);
  assert.ok(ry.every((x) => x.dual === true));
  assert.deepEqual(ry.map(strip), r0.map(strip));
  assert.ok(pos(y).hold_thin_limit.adj?.streak, "cost-basis machine advanced");
  assert.equal(ry[3].ready, true);
  assert.equal(ry[3].young_would_fire, true);
  assert.equal(holdOverrideActive(pos(y), ENF, "hold_limit"), false);
  assert.equal(S.noteHoldThinLimitMark(o, {}, { confirm: true }), true);
  assert.equal(holdOverrideActive(pos(o), ENF0, "hold_limit"), true);
});

test("index.js checkHoldThinLimit: young → null, one [HOLD_THIN_LIMIT_YOUNG] line; key 0 → the exit", async (t) => {
  const I = await import("../index.js");
  const lines = [];
  const orig = console.error;
  const before = { ...config.management };
  const p = (a, pnl, bin) => ({ position: a, pair: pos(a).pool_name, bin_step: 100, ...row(pnl, bin) });
  // The whole sequence through the real function, on a mocked clock (it reads Date.now()).
  const run = (a) => {
    const out = [];
    t.mock.timers.setTime(Date.parse("2026-11-28T09:00:00Z"));
    for (const [pnl, bin, dt] of [[-20, 10, 0], [-26, 3, 5], [-27, 2, 35], [-28, 1, 35], [-30, 0, 35]]) {
      t.mock.timers.tick(dt * SEC);
      out.push(I.checkHoldThinLimit(p(a, pnl, bin)));
    }
    return out;
  };
  try {
    const y = mk("IDXY", { createdAgoH: 43 });
    const o = mk("IDX0", { createdAgoH: 43 });
    const u = mk("IDXU", { createdAgoH: null });
    t.mock.timers.enable({ apis: ["Date"] });
    console.error = (...a) => { lines.push(a.join(" ")); };
    config.management.holdThinPoolLimitMode = "enforce";

    config.management.holdThinPoolYoungTokenHours = 72;
    assert.deepEqual(run(y), [null, null, null, null, null]);
    assert.equal(pos(y).hold_thin_limit.streak.confirmed_at ?? null, null);
    assert.equal(pos(y).hold_thin_limit_young.would_fire_count, 1);
    const yl = lines.filter((l) => l.includes("IDXY-SOL"));
    assert.equal(yl.filter((l) => l.includes("[HOLD_THIN_LIMIT_YOUNG] would-close")).length, 1);
    assert.ok(yl.some((l) => /\[HOLD_THIN_LIMIT_YOUNG\] would-close IDXY-SOL: PnL -28\.00% at or under -25% for 70s — not closing: token was 43\.0 h old at entry \(< 72 h, holdThinPoolYoungTokenHours\)/.test(l)), yl.join("\n"));
    assert.equal(yl.filter((l) => /young token \(43\.0 h old at entry, under 72 h\) — the -25% limit is log-only for this position/.test(l)).length, 1);
    assert.ok(yl.some((l) => /valuation 1, needs 2 and 60s — log-only for this position \(young token, 43\.0 h old at entry\)/.test(l)));
    assert.equal(yl.some((l) => /closing a HELD position/.test(l)), false);

    config.management.holdThinPoolYoungTokenHours = 0;
    const r0 = run(o);
    assert.deepEqual(r0.map((x) => x?.action ?? null), [null, null, null, "HOLD_THIN_LIMIT", "HOLD_THIN_LIMIT"]);
    assert.ok(pos(o).hold_thin_limit.streak.confirmed_at);
    assert.equal(lines.some((l) => l.includes("IDX0-SOL") && /log-only|YOUNG|young/.test(l)), false, "key 0: today's log lines");

    config.management.holdThinPoolYoungTokenHours = 72;
    I._noteMgmtPoolRowSeenForTest(u); // a management cycle has passed it (backfill had its chance)
    assert.equal(run(u)[3]?.action, "HOLD_THIN_LIMIT", "unknown age → fires as before");
    assert.equal(lines.filter((l) => l.includes("IDXU-SOL: token creation time unknown — the young-token exemption cannot apply")).length, 1);
  } finally {
    console.error = orig;
    t.mock.timers.reset();
    Object.assign(config.management, before);
  }
});

test("capture: trackPosition, bot-deploy derivation, adopted rows never derived, cycle backfill writes once", () => {
  // Executor-injected ISO kept as is.
  const a = mk("CAP", { createdAgoH: 5, hold: false });
  assert.equal(pos(a).base_token_created_source, "test");
  // Bot deploy with only the screening's floored age: deployed_at − (age + 1) h.
  const b = `TEST_THIN_YOUNG_DERIVE_${Date.now()}_${seq++}`; SET.push(b);
  const dep = Date.now();
  S.trackPosition({ position: b, pool: "POOL_TY_D", pool_name: "D-SOL", amount_sol: 1, strategy: "spot", deployed_at: iso(dep), token_age_hours: 20 });
  assert.equal(pos(b).base_token_created_source, "derived_token_age_hours");
  assert.equal(Date.parse(pos(b).base_token_created_at), dep - 21 * H);
  assert.equal(pos(b).token_age_hours_at_deploy, 20, "unchanged");
  // Adopted row: nothing derived, nothing passed; the young stop's field stays absent.
  const c = `TEST_THIN_YOUNG_ADOPT_${Date.now()}_${seq++}`; SET.push(c);
  S.trackPosition({ position: c, pool: "POOL_TY_A", pool_name: "A-SOL", amount_sol: 1, strategy: "manual", adopted: true, base_mint: "MINT_A" });
  assert.equal(pos(c).base_token_created_at, null);
  const now = Date.now();
  const rowA = (created, extra = {}) => ({ pool_address: "POOL_TY_A", token_x: { address: "MINT_A", created_at: created }, ...extra });
  for (const bad of [Math.floor((now - H) / 1000), now + 2 * H, 0, String(now - H), null]) {
    assert.equal(S.attachBaseTokenCreatedAt(c, rowA(bad), "meteora_cycle"), false, `garbage ${String(bad)}`);
  }
  assert.equal(S.attachBaseTokenCreatedAt(c, { ...rowA(now - H), pool_address: "POOL_OTHER" }, "meteora_cycle"), false, "other pool");
  assert.equal(S.attachBaseTokenCreatedAt(c, rowA(now - H, { token_x: { address: "OTHER", created_at: now - H } }), "meteora_cycle"), false, "other mint");
  assert.equal(pos(c).base_token_created_at, null);
  assert.equal(S.attachBaseTokenCreatedAt(c, rowA(now - 3 * H), "meteora_cycle"), true);
  assert.equal(pos(c).base_token_created_at, iso(now - 3 * H));
  assert.equal(pos(c).base_token_created_source, "meteora_cycle");
  assert.equal(S.attachBaseTokenCreatedAt(c, rowA(now - 9 * H), "meteora_cycle"), false, "written once");
  assert.equal(pos(c).base_token_created_at, iso(now - 3 * H));
  assert.equal(pos(c).token_age_hours_at_deploy, null, "the young-token stop stays off for adopted rows");
  assert.equal(L.youngTokenStatus(pos(c), {}).young, true);

  // Wiring: executor writes the field into entryMarketData; the enricher and the cycle backfill call the writer.
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exe, /const baseTokenCreatedAt = tokenCreatedFromPoolRow\(detail, \{ pool: args\.pool_address \}\);/);
  assert.match(exe, /base_token_created_at: baseTokenCreatedAt,\s*base_token_created_source: baseTokenCreatedAt \? "meteora_deploy" : null,/);
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /attachBaseTokenCreatedAt\(positionAddress, detail, "meteora_adoption"\)/);
  assert.match(idx, /tvlFloorReading = readPoolTvlUsd\(detail, p\.pool\);[\s\S]{0,600}attachBaseTokenCreatedAt\(p\.position, detail, "meteora_cycle"\)/);
  const dl = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.match(dl, /token_age_hours: signalSnapshot\?\.token_age_hours \?\? null,\s*base_token_created_at,\s*base_token_created_source,/);
});

test("card fields, report doc, perf record", async () => {
  const y = mk("CARD", { createdAgoH: 12.25, hold: false });
  assert.deepEqual(L.youngTokenCardFields(pos(y), {}), { hold_thin_limit_young: true, base_token_age_h_at_entry: 12.2, hold_thin_limit_young_hours: 72 });
  assert.deepEqual(L.youngTokenCardFields({}, { holdThinPoolYoungTokenHours: 0 }), { hold_thin_limit_young: false, base_token_age_h_at_entry: null, hold_thin_limit_young_hours: 0 });
  // "in effect" = young AND enforce AND key > 0 (held or not)
  assert.deepEqual(L.youngTokenCardFields(pos(y), { holdThinPoolLimitMode: "shadow" }), { hold_thin_limit_young: false, base_token_age_h_at_entry: 12.2, hold_thin_limit_young_hours: 72 });
  assert.deepEqual(L.youngTokenCardFields(pos(y), { holdThinPoolLimitMode: "off" }).hold_thin_limit_young, false);
  assert.deepEqual(L.youngTokenCardFields(pos(y), { holdThinPoolYoungTokenHours: 0 }), { hold_thin_limit_young: false, base_token_age_h_at_entry: 12.2, hold_thin_limit_young_hours: 0 });
  assert.deepEqual(L.youngTokenCardFields(pos(y), { holdThinPoolYoungTokenHours: "abc" }), { hold_thin_limit_young: false, base_token_age_h_at_entry: 12.2, hold_thin_limit_young_hours: 0 });
  assert.equal(pos(y).hold_mode, false, "not held: still reported as in effect");
  assert.equal(L.youngTokenExemptionInEffect(pos(y), {}), true);
  assert.equal(L.youngTokenExemptionInEffect(pos(y), { holdThinPoolLimitMode: "shadow" }), false);
  // scan row and report doc identical
  for (const m of [{}, { holdThinPoolLimitMode: "shadow" }, { holdThinPoolYoungTokenHours: 0 }]) {
    const { reportYoungTokenFields: rf } = await import("../report.js");
    assert.deepEqual(rf(L.youngTokenCardFields(pos(y), m), m), L.youngTokenCardFields(pos(y), m));
  }
  // existing card fields untouched (no new keys there)
  assert.deepEqual(Object.keys(L.holdThinLimitCardFields({}, {})), ["thin_pool", "entry_tvl_usd", "hold_thin_limit_exempt", "hold_thin_limit_pct", "hold_thin_limit_mode"]);
  const { reportYoungTokenFields } = await import("../report.js");
  assert.deepEqual(reportYoungTokenFields(L.youngTokenCardFields(pos(y), {}), {}), { hold_thin_limit_young: true, base_token_age_h_at_entry: 12.2, hold_thin_limit_young_hours: 72 });
  assert.deepEqual(reportYoungTokenFields({}, {}), { hold_thin_limit_young: false, base_token_age_h_at_entry: null, hold_thin_limit_young_hours: 72 });
  const pnl = fs.readFileSync(new URL("../tools/pnl.js", import.meta.url), "utf8");
  assert.match(pnl, /\.\.\.youngTokenCardFields\(tracked, config\.management\),/);
  const rep = fs.readFileSync(new URL("../report.js", import.meta.url), "utf8");
  assert.match(rep, /\.\.\.reportThinLimitFields\(p\),[^\n]*\n\s*\.\.\.reportYoungTokenFields\(p\),/);

  const PR = await import("../perf-record.js");
  const z = mk("PERF", { createdAgoH: 10 });
  sequence(z);
  const rec = PR.buildPerfRecord({ source: "closed_api", tracked: pos(z), close: { close_reason: "test" }, extra: {} });
  assert.equal(rec.hold_thin_limit_young.would_fire_count, 1);
  assert.equal(rec.hold_thin_limit_young.pnl_pct_at_would_fire, -28);
  assert.equal(rec.base_token_created_at, pos(z).base_token_created_at);
});

test("operator texts: young named when known, today's text otherwise", async () => {
  const I = await import("../index.js");
  const now = Date.now();
  const youngPos = { adopted: true, adopted_at: iso(now), base_token_created_at: iso(now - 5 * H), entry_tvl: 42622.68 };
  const yStatus = L.youngTokenStatus(youngPos, {});
  const a = I.thinPoolAdoptionAlertText({ pair: "F-SOL", amountSol: 1, entryTvlUsd: 42622.68, mgmt: {}, young: yStatus });
  assert.match(a, /the -25% thin-pool hold limit does NOT apply to this position \(young token, 5\.0 h old at entry, holdThinPoolYoungTokenHours 72\); the TVL exit still does\./);
  assert.match(a, /holdThinPoolYoungTokenHours/);
  const plain = I.thinPoolAdoptionAlertText({ pair: "F-SOL", amountSol: 1, entryTvlUsd: 42622.68, mgmt: {} });
  assert.equal(I.thinPoolAdoptionAlertText({ pair: "F-SOL", amountSol: 1, entryTvlUsd: 42622.68, mgmt: {}, young: L.youngTokenStatus({}, {}) }), plain, "unknown age: today's text");
  assert.match(plain, /the thin-pool limit closes it at -25% PnL/);
  const v = { rule: "stop_loss", pnl_pct: -15.2, threshold_pct: -15 };
  const b = I.holdDownsideAlertText({ pair: "F-SOL", verdict: v, heldMin: 3, tracked: { ...youngPos, hold_thin_limit_exempt: false }, mgmt: {} });
  assert.match(b, /the -25% thin-pool hold limit does NOT apply to this position \(young token, 5\.0 h old at entry, holdThinPoolYoungTokenHours 72\) — it will not be closed there; the TVL exit still applies\./);
  const bOld = I.holdDownsideAlertText({ pair: "F-SOL", verdict: v, heldMin: 3, tracked: { entry_tvl: 42622.68 }, mgmt: {} });
  assert.match(bOld, /the thin-pool limit closes it at -25%/);
});

test("invalid stored key: restart (fresh process) and hot reload give the same value; one warning naming it", async () => {
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const path = await import("node:path");
  const restart = (cfgObj) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "young-cfg-"));
    fs.writeFileSync(path.join(dir, "user-config.json"), JSON.stringify(cfgObj));
    const code = `const { config, reloadScreeningThresholds } = await import(${JSON.stringify(new URL("../config.js", import.meta.url).href)});
      const atLoad = config.management.holdThinPoolYoungTokenHours;
      reloadScreeningThresholds();
      console.log(JSON.stringify({ atLoad, afterReload: config.management.holdThinPoolYoungTokenHours }));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, MERIDIAN_DATA_DIR: dir, PERSIST_BACKEND: "json", DRY_RUN: "true" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = out.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  };
  for (const [cfgObj, want] of [[{}, 72], [{ holdThinPoolYoungTokenHours: 48 }, 48], [{ holdThinPoolYoungTokenHours: 0 }, 0],
    [{ holdThinPoolYoungTokenHours: "abc" }, 0], [{ holdThinPoolYoungTokenHours: -1 }, 0], [{ holdThinPoolYoungTokenHours: 1000 }, 0], [{ holdThinPoolYoungTokenHours: null }, 0]]) {
    assert.deepEqual(restart(cfgObj), { atLoad: want, afterReload: want }, JSON.stringify(cfgObj));
  }
  // One warning per process per bad value (load + reload + repeated reads → one line).
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(" ")); };
  try {
    for (let i = 0; i < 5; i++) L.holdThinYoungTokenHours({ holdThinPoolYoungTokenHours: "zzz-bad" });
  } finally { console.error = orig; }
  const warns = lines.filter((l) => l.includes('holdThinPoolYoungTokenHours "zzz-bad" is invalid') && l.includes("young-token exemption OFF (0)"));
  assert.equal(warns.length, 1, lines.join("\n"));
  // In-process hot reload agrees with the reader: a partial override without the key leaves it alone.
  const { reloadScreeningThresholds } = await import("../config.js");
  const before = config.management.holdThinPoolYoungTokenHours;
  try {
    reloadScreeningThresholds({ holdThinPoolYoungTokenHours: "abc" });
    assert.equal(config.management.holdThinPoolYoungTokenHours, 0);
    reloadScreeningThresholds({ holdThinPoolYoungTokenHours: 24 });
    assert.equal(config.management.holdThinPoolYoungTokenHours, 24);
    reloadScreeningThresholds({ minHolders: 500 });
    assert.equal(config.management.holdThinPoolYoungTokenHours, 24);
  } finally { config.management.holdThinPoolYoungTokenHours = before; }
});

test("young → not young mid-streak: the state is dropped and a full fresh proof is needed", () => {
  const y = mk("ENDS", { createdAgoH: 10 });
  const r = sequence(y).slice(0, 4);
  assert.equal(r[3].ready, true);
  assert.equal(r[3].young_would_fire, true);
  assert.equal(pos(y).hold_thin_limit.young, true, "built while young");
  // Key set to 0: the very next reading must NOT be ready.
  const e1 = feed(y, -29, 0, 80, ENF0);
  assert.equal(e1.young_ended, true);
  assert.equal(e1.young_ended_reason, "holdThinPoolYoungTokenHours 0");
  assert.deepEqual([e1.event, e1.ready, e1.count], ["started", false, 1]);
  assert.equal(pos(y).hold_thin_limit.young, undefined);
  assert.equal(pos(y).hold_thin_limit_young.in_effect, false, "record kept as history");
  assert.equal(pos(y).hold_thin_limit_young.would_fire_count, 1);
  const e2 = feed(y, -29.5, -1, 110, ENF0);
  assert.deepEqual([e2.event, e2.ready, e2.count, !!e2.young_ended], ["counted", false, 2, false], "2 valuations but 30 s");
  const e3 = feed(y, -30, -2, 140, ENF0);
  assert.deepEqual([e3.ready, Math.round(e3.held_sec)], [true, 60], "fresh 60 s proof");
  assert.equal(S.noteHoldThinLimitMark(y, {}, { confirm: true }), true);
  assert.equal(holdOverrideActive(pos(y), ENF0, "hold_limit"), true);

  // Threshold lowered under the position's age (43 h, key 24): same.
  const z = mk("LOWER", { createdAgoH: 43 });
  sequence(z).slice(0, 4);
  const z1 = feed(z, -29, 0, 80, { ...ENF, holdThinPoolYoungTokenHours: 24 });
  assert.equal(z1.young_ended, true);
  assert.equal(z1.young_ended_reason, "token 43.0 h old at entry, not under 24 h");
  assert.equal(z1.ready, false);
  // Back to young: the exemption applies again and its line is due again.
  const z2 = feed(z, -29, 0, 85, ENF);
  assert.equal(z2.young_active, true);
  assert.equal(z2.young_first_applied, true);
  assert.equal(pos(z).hold_thin_limit_young.in_effect, true);
  assert.equal(feed(z, -29, 0, 90, ENF).young_first_applied, false);
  // A reading still young never reports an end.
  assert.equal(z2.young_ended, undefined);
});

test("index.js: end-of-young line; 'creation time unknown' only after a management pass, once per process; later young line still logged", async (t) => {
  const I = await import("../index.js");
  const lines = [];
  const orig = console.error;
  const before = { ...config.management };
  const p = (a, pnl, bin) => ({ position: a, pair: pos(a).pool_name, bin_step: 100, ...row(pnl, bin) });
  try {
    const y = mk("IDXEND", { createdAgoH: 10 });
    const u = mk("IDXLATE", { createdAgoH: null });
    t.mock.timers.enable({ apis: ["Date"] });
    t.mock.timers.setTime(Date.parse("2026-11-28T10:00:00Z"));
    console.error = (...a) => { lines.push(a.join(" ")); };
    config.management.holdThinPoolLimitMode = "enforce";
    config.management.holdThinPoolYoungTokenHours = 72;
    const step = (a, pnl, bin, dt) => { t.mock.timers.tick(dt * SEC); return I.checkHoldThinLimit(p(a, pnl, bin)); };
    for (const [pnl, bin, dt] of [[-20, 10, 0], [-26, 3, 5], [-27, 2, 35], [-28, 1, 35]]) assert.equal(step(y, pnl, bin, dt), null);
    config.management.holdThinPoolYoungTokenHours = 0;
    assert.equal(step(y, -29, 0, 5), null, "not closed on the next reading");
    assert.equal(lines.filter((l) => l.includes("IDXEND-SOL: no longer treated as a young token (holdThinPoolYoungTokenHours 0) — the -25% limit applies from a fresh 60 s proof")).length, 1);
    assert.equal(step(y, -29.5, -1, 30), null);
    assert.equal(step(y, -30, -2, 30)?.action, "HOLD_THIN_LIMIT", "after the fresh 60 s proof");
    assert.equal(lines.filter((l) => l.includes("no longer treated as a young token") && l.includes("IDXEND")).length, 1, "logged once");

    config.management.holdThinPoolYoungTokenHours = 72;
    const unknownLine = (l) => l.includes("IDXLATE-SOL: token creation time unknown — the young-token exemption cannot apply");
    step(u, -20, 10, 5); step(u, -21, 9, 5);
    assert.equal(lines.filter(unknownLine).length, 0, "not before a management cycle passed the position");
    I._noteMgmtPoolRowSeenForTest(u);
    step(u, -21, 9, 5); step(u, -22, 8, 5); step(u, -22, 8, 5);
    assert.equal(lines.filter(unknownLine).length, 1, "once per position per process");
    assert.equal(pos(u).hold_thin_limit_age_unknown_logged_at, undefined, "no stored latch");
    // The creation time arrives (cycle backfill) and makes it young: the normal line still appears.
    S.attachBaseTokenCreatedAt(u, { pool_address: pos(u).pool, token_x: { created_at: Date.parse(pos(u).deployed_at) - 6 * H } }, "meteora_cycle", Date.now() + 10 * H);
    step(u, -22, 8, 5);
    assert.equal(lines.filter((l) => /IDXLATE-SOL: young token \(6\.0 h old at entry, under 72 h\) — the -25% limit is log-only for this position/.test(l)).length, 1);
  } finally {
    console.error = orig;
    t.mock.timers.reset();
    Object.assign(config.management, before);
  }
});

test("cleanup", () => { for (const P of SET) { try { S.recordClose(P, "cleanup"); } catch { /* ignore */ } } });
