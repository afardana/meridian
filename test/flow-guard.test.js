process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Flow guard (operator-armed per-position flow stop) ===");

const F = await import("../flow-guard.js");
const C = await import("../flow-guard-cycle.js");
const { holdOverrideActive, HOLD_OVERRIDE_TTL_MS } = await import("../hold-override.js");
const { exitFamilyFromReason } = await import("../exit-family.js");
const { classifyOutcome } = await import("../lessons.js");
const PR = await import("../perf-record.js");
const S = await import("../state.js");
const { EXIT_FAMILY_BY_ACTION, URGENT_EXIT_ACTIONS } = S;
const { recordFlowReading, flushFlowReadings, FLOW_READINGS_FILE, flowReadingRow } = await import("../db/flow-reading-store.js");
const { dataPath } = await import("../repo-root.js");
const { config: CONFIG } = await import("../config.js");
const config = () => CONFIG;
await S.ensureStateInitialized();

const SEC = 1000, MIN = 60_000;
const WINSTON = "7Y2CVbnqZRvR5RUvEJ9RQ73fZEfv7ybNcysytAepump";
const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/flow-guard-winston.json", import.meta.url), "utf8"));
const D = F.FLOW_GUARD_DEFAULT_PARAMS;
const T0 = Date.parse("2026-11-27T16:00:00Z");
const atIso = (ms) => new Date(ms).toISOString();

/** A Jupiter asset payload (real WINSTON read, figures overridable). */
function payload(i = 0, over = {}) {
  const t = JSON.parse(JSON.stringify(FIX[i]));
  for (const [k, v] of Object.entries(over)) {
    if (k === "stats5m" || k === "stats1h") t[k] = { ...t[k], ...v };
    else t[k] = v;
  }
  return [t];
}
const reading = (ms, over = {}, i = 0) => F.readFlowAsset(payload(i, over), WINSTON, ms);
// Sustained sell pressure with the price down (5m 2.5×, 1h 1.6×, 1h −20 %).
const DUMP = { stats5m: { buyVolume: 4000, sellVolume: 10000, priceChange: -9 }, stats1h: { buyVolume: 100000, sellVolume: 160000, priceChange: -20 } };
const chainAt = (bin) => ({ ok: true, active_bin: bin, bin_step: 100 });

// ── Params, body ────────────────────────────────────────────────────────────────────────────
{
  assert.deepEqual(F.parseFlowGuardParams(undefined), { ok: true, params: { ...D } });
  assert.deepEqual(D, { sell_buy_5m: 2, sell_buy_1h: 1.3, price_drop_1h_pct: 15, liquidity_drop_pct: 50, holders_drop_pct: 5, confirm_readings: 3, confirm_minutes: 6, use_gmgn: false });
  assert.equal(F.parseFlowGuardParams({ sell_buy_5m: 3 }).params.sell_buy_5m, 3);
  assert.equal(F.parseFlowGuardParams({ sell_buy_5m: 3 }).params.confirm_readings, 3, "missing keys take the default");
  for (const bad of [{ sell_buy_5m: 1.1 }, { sell_buy_5m: 11 }, { sell_buy_1h: 0.9 }, { price_drop_1h_pct: 4 }, { price_drop_1h_pct: 91 },
    { liquidity_drop_pct: 19 }, { liquidity_drop_pct: 96 }, { holders_drop_pct: 1 }, { holders_drop_pct: 51 }, { confirm_readings: 1 },
    { confirm_readings: 11 }, { confirm_readings: 2.5 }, { confirm_minutes: 2 }, { confirm_minutes: 61 }, { sell_buy_5m: "2" },
    { sell_buy_5m: NaN }, { use_gmgn: "true" }, { nope: 1 }, [], "x"]) {
    assert.equal(F.parseFlowGuardParams(bad).ok, false, JSON.stringify(bad));
  }
  for (const ok of [{ sell_buy_5m: 1.2 }, { sell_buy_5m: 10 }, { confirm_readings: 2 }, { confirm_minutes: 3 }, { use_gmgn: true }]) assert.equal(F.parseFlowGuardParams(ok).ok, true);
  const pos = "8R28PAPjv6Z5fYh7m9sFTRpos11111111111111111";
  assert.deepEqual(F.parseFlowGuardBody({ position: pos, arm: true }), { ok: true, position: pos, arm: true, params: { ...D } });
  assert.equal(F.parseFlowGuardBody({ position: pos, arm: true, params: { confirm_readings: 4 } }).params.confirm_readings, 4);
  assert.deepEqual(F.parseFlowGuardBody({ position: pos, arm: false }), { ok: true, position: pos, arm: false, params: null });
  assert.equal(F.parseFlowGuardBody({ position: pos, arm: false, params: {} }).ok, false);
  assert.equal(F.parseFlowGuardBody({ position: pos, arm: "yes" }).ok, false);
  assert.equal(F.parseFlowGuardBody({ position: pos }).ok, false);
  assert.equal(F.parseFlowGuardBody({ position: "not base58!", arm: true }).ok, false);
  assert.equal(F.parseFlowGuardBody({ position: pos, arm: true, extra: 1 }).ok, false);
  assert.equal(F.parseFlowGuardBody({ position: pos, arm: true, params: { confirm_minutes: 1 } }).ok, false);
  assert.equal(F.parseFlowGuardBody(null).ok, false);
  // refusals
  assert.equal(F.flowGuardRefusal(null).status, 404);
  assert.equal(F.flowGuardRefusal({ closed: true, base_mint: WINSTON }).status, 404);
  assert.equal(F.flowGuardRefusal({ base_mint: F.WSOL_MINT }).status, 409);
  assert.equal(F.flowGuardRefusal({ base_mint: null }).status, 409);
  assert.equal(F.flowGuardRefusal({ base_mint: null }, { disarming: true }), null);
  assert.equal(F.flowGuardRefusal({ base_mint: WINSTON }), null);
  assert.equal(F.flowGuardShadowMode({}), "shadow");
  assert.equal(F.flowGuardShadowMode({ flowGuardShadowMode: "off" }), "off");
  assert.equal(F.flowGuardShadowMode({ flowGuardShadowMode: "enforce" }), "shadow", "no enforce exists");
}

// ── The reading (real WINSTON payload) ──────────────────────────────────────────────────────
{
  const r = reading(T0);
  assert.equal(r.ok, true);
  assert.equal(r.liquidity_usd, FIX[0].liquidity);
  assert.equal(r.holders, 1794);
  assert.equal(r.s5m.buy, FIX[0].stats5m.buyVolume);
  assert.equal(r.s1h.price_change, FIX[0].stats1h.priceChange);
  assert.equal(r.s5m.num_buys, 206);
  assert.equal(F.readFlowAsset(payload(0, { id: "So11111111111111111111111111111111111111112" }), WINSTON, T0).ok, false, "only the exact mint");
  assert.equal(F.readFlowAsset([], WINSTON, T0).ok, false);
  assert.equal(F.readFlowAsset(null, WINSTON, T0).ok, false);
  const strs = F.readFlowAsset(payload(0, { liquidity: "22733", holderCount: null }), WINSTON, T0);
  assert.equal(strs.liquidity_usd, null, "strings are not coerced");
  assert.equal(strs.holders, null);
  // The real reads at the time of writing: no condition (5m 1.31× / 1h 1.01×, 1h −4.6 %; then a rise)
  const g = F.newFlowGuard(D, {}, T0);
  for (const i of [0, 1]) {
    const ev = F.evaluateFlowReading(F.readFlowAsset(payload(i), WINSTON, T0), g, D, { nowMs: T0 });
    assert.equal(ev.usable, true);
    assert.deepEqual(ev.qualified, [], `WINSTON read ${i} does not qualify under the defaults`);
  }
}

// ── Each condition ──────────────────────────────────────────────────────────────────────────
{
  const g = { peak: { liquidity_usd: 20000, holders: 1800, meteora_holders: null, active_bin: null } };
  const ev = (over, opts = {}) => F.evaluateFlowReading(reading(T0, over), g, opts.params || D, { nowMs: T0, ...opts });
  assert.deepEqual(ev(DUMP).qualified, ["sell_pressure"]);
  assert.deepEqual(ev({ ...DUMP, stats1h: { ...DUMP.stats1h, priceChange: -14.9 } }).qualified, [], "price drop under the bar");
  assert.deepEqual(ev({ ...DUMP, stats5m: { buyVolume: 6000, sellVolume: 10000 } }).qualified, [], "5m ratio under 2");
  assert.deepEqual(ev({ ...DUMP, stats1h: { buyVolume: 130000, sellVolume: 160000, priceChange: -20 } }).qualified, [], "1h ratio under 1.3");
  // dust floors: 5m < $200 in total, 1h < $1,000 → sell pressure is not evaluated
  const dust5 = ev({ ...DUMP, stats5m: { buyVolume: 50, sellVolume: 140, priceChange: -9 } });
  assert.equal(dust5.evaluable.includes("sell_pressure"), false);
  const dust1 = ev({ ...DUMP, stats1h: { buyVolume: 300, sellVolume: 600, priceChange: -20 } });
  assert.equal(dust1.evaluable.includes("sell_pressure"), false);
  // sells only (buy 0) above the floor → infinite ratio, qualifies
  assert.deepEqual(ev({ ...DUMP, stats5m: { buyVolume: 0, sellVolume: 500, priceChange: -9 } }).qualified, ["sell_pressure"]);
  // liquidity pull: ≤ 50 % of the peak
  assert.deepEqual(ev({ liquidity: 10000 }).qualified, ["liquidity_pull"]);
  assert.deepEqual(ev({ liquidity: 10001 }).qualified, []);
  // holder exodus: ≤ 95 % of the peak
  assert.deepEqual(ev({ holderCount: 1710 }).qualified, ["holder_exodus"]);
  assert.deepEqual(ev({ holderCount: 1711 }).qualified, []);
  // no peak yet → liquidity / holders not evaluable
  const noPeak = F.evaluateFlowReading(reading(T0, { liquidity: 1 }), { peak: {} }, D, { nowMs: T0 });
  assert.equal(noPeak.evaluable.includes("liquidity_pull"), false);
  // a stale reading is not usable
  assert.equal(F.evaluateFlowReading(reading(T0 - 5 * MIN), g, D, { nowMs: T0 }).usable, false);
  // nothing evaluable → not usable
  const nothing = F.evaluateFlowReading(reading(T0, { liquidity: null, holderCount: null, stats5m: { buyVolume: 1, sellVolume: 1 } }), g, D, { nowMs: T0 });
  assert.equal(nothing.usable, false);
  // GMGN: only with use_gmgn, fresh, newer than the previous usable reading
  const gm = { smart_exiting: 3, smart_accumulating: 1, at: atIso(T0 - MIN) };
  assert.equal(ev({}, { gmgn: gm }).qualified.includes("smart_money_exodus"), false, "use_gmgn false → inert");
  const P = { ...D, use_gmgn: true };
  assert.deepEqual(ev({}, { gmgn: gm, params: P }).qualified, ["smart_money_exodus"]);
  assert.equal(ev({}, { gmgn: { ...gm, at: atIso(T0 - 16 * MIN) }, params: P }).evaluable.includes("smart_money_exodus"), false, "older than 15 min");
  assert.equal(F.evaluateFlowReading(reading(T0), { ...g, last_read_at: atIso(T0 - 30 * SEC) }, P, { nowMs: T0, gmgn: gm }).evaluable.includes("smart_money_exodus"), false, "one observation counts once");
  assert.deepEqual(ev({}, { gmgn: { smart_exiting: 1, smart_accumulating: 2, at: atIso(T0) }, params: P }).qualified, []);
}

// ── Streak, peaks, cross-check (pure) ───────────────────────────────────────────────────────
function run(seq, { params = D, ref = { active_bin: -400 } } = {}) {
  let g = F.newFlowGuard(params, ref, T0);
  const out = [];
  for (const [tMin, over, extra = {}] of seq) {
    const ms = T0 + tMin * MIN;
    const r = over === null ? { ok: false, reason: "fetch failed", at: atIso(ms) } : reading(ms, over);
    const res = F.advanceFlowGuard(g, { reading: r, chain: chainAt(-420), meteora_holders: 1800, pool_tvl_usd: 7600, ...extra }, ms);
    g = res.guard;
    out.push(res);
  }
  return out;
}
{
  // calm → nothing
  const calm = run([[3, {}], [6, {}], [9, {}], [12, {}]]);
  assert.deepEqual(calm.map((r) => r.event), ["calm", "calm", "calm", "calm"]);
  assert.equal(calm.some((r) => r.fire), false);
  // three sell-pressure readings over 6 min with the pool price down ≥ 7.5 % → fire on the third
  const dump = run([[0, DUMP], [3, DUMP], [6, DUMP]]);
  assert.deepEqual(dump.map((r) => r.event), ["started", "counted", "counted"]);
  assert.deepEqual(dump.map((r) => r.fire), [false, false, true]);
  assert.ok(dump[2].guard.streak.confirmed_at, "the firing reading writes the stamp");
  assert.deepEqual(dump[2].cross.confirmed, ["sell_pressure"]);
  // confirm_minutes not yet reached → no fire (3 readings over 4 min)
  const quick = run([[0, DUMP], [2, DUMP], [4, DUMP]]);
  assert.equal(quick[2].ready, false);
  assert.equal(quick.some((r) => r.fire), false);
  // unusable readings neither count nor reset
  const gaps = run([[0, DUMP], [3, null], [4, DUMP], [5, null], [7, DUMP]]);
  assert.deepEqual(gaps.map((r) => r.event), ["started", "ignored", "counted", "ignored", "counted"]);
  assert.equal(gaps[4].fire, true);
  // a usable non-qualifying reading resets
  const reset = run([[0, DUMP], [3, DUMP], [6, {}], [9, DUMP]]);
  assert.deepEqual(reset.map((r) => r.event), ["started", "counted", "reset", "started"]);
  assert.equal(reset.some((r) => r.fire), false);
  // > 15 min between usable readings restarts
  const gap = run([[0, DUMP], [3, DUMP], [19, DUMP]]);
  assert.equal(gap[2].event, "restarted");
  assert.equal(gap[2].guard.streak.count, 1);
  // readings < 60 s apart are one reading
  const dup = run([[0, DUMP], [0.5, DUMP]]);
  assert.equal(dup[1].event, "merged");
  // on-chain cross-check missing → no fire this cycle; the streak is kept and fires once it is back
  const noChain = run([[0, DUMP], [3, DUMP], [6, DUMP, { chain: { ok: false, reason: "rpc down" } }], [9, DUMP]]);
  assert.equal(noChain[2].ready, true);
  assert.equal(noChain[2].fire, false);
  assert.equal(noChain[2].cross.details.sell_pressure.verdict, "unavailable");
  assert.equal(noChain[2].guard.streak.confirmed_at, null);
  assert.equal(noChain[3].fire, true);
  // the pool price did not fall enough (bin −400 → −404 ≈ −3.9 % < 7.5 %) → disagree, no fire
  const flat = run([[0, DUMP], [3, DUMP], [6, DUMP, { chain: chainAt(-404) }]]);
  assert.equal(flat[2].cross.details.sell_pressure.verdict, "disagree");
  assert.equal(flat[2].fire, false);
  // mixed conditions: liquidity, then holders, then sell pressure → fires
  const mixed = run([[0, { liquidity: 30000 }], [3, { liquidity: 30000 }], [6, { liquidity: 9000 }], [9, { liquidity: 30000, holderCount: 1600 }, { meteora_holders: 1600 }], [12, DUMP]],
    { ref: { active_bin: -400, liquidity_usd: 30000, holders: 1800, meteora_holders: 1800 } });
  assert.deepEqual(mixed.map((r) => r.event), ["calm", "calm", "started", "counted", "counted"]);
  assert.deepEqual(mixed[2].qualified, ["liquidity_pull"]);
  assert.deepEqual(mixed[3].qualified, ["holder_exodus"]);
  assert.equal(mixed[4].fire, true);
  assert.deepEqual(mixed[4].guard.streak.readings.map((x) => x.conditions), [["liquidity_pull"], ["holder_exodus"], ["sell_pressure"]]);
  // the next reading drops the stamp
  const after = F.advanceFlowGuard(mixed[4].guard, { reading: reading(T0 + 15 * MIN), chain: chainAt(-420) }, T0 + 15 * MIN);
  assert.equal(after.guard.streak, null);
  const after2 = F.advanceFlowGuard(mixed[4].guard, { reading: { ok: false, reason: "x", at: atIso(T0 + 15 * MIN) } }, T0 + 15 * MIN);
  assert.equal(after2.guard.streak.confirmed_at, null, "even an unusable reading drops the stamp");
  // a single spiked liquidity reading does not define the peak (pair-minimum)
  const spike = run([[0, { liquidity: 20000 }], [3, { liquidity: 200000 }], [6, { liquidity: 20000 }], [9, { liquidity: 20000 }], [12, { liquidity: 20000 }]],
    { ref: { active_bin: -400, liquidity_usd: 20000 } });
  assert.equal(spike[4].guard.peak.liquidity_usd, 20000);
  assert.equal(spike.some((r) => r.qualified.includes("liquidity_pull")), false);
  // holders: Meteora disagrees → no fire; Meteora missing → no fire (fail-closed)
  const hold = (mh) => run([[0, {}], [3, {}], [6, { holderCount: 1600 }, { meteora_holders: mh }], [9, { holderCount: 1600 }, { meteora_holders: mh }], [12, { holderCount: 1600 }, { meteora_holders: mh }]],
    { ref: { active_bin: -400, holders: 1800, meteora_holders: 1800 } });
  assert.equal(hold(1800)[4].fire, false);
  assert.equal(hold(1800)[4].cross.details.holder_exodus.verdict, "disagree");
  assert.equal(hold(null)[4].fire, false);
  assert.equal(hold(null)[4].cross.details.holder_exodus.verdict, "unavailable");
  assert.equal(hold(1650)[4].fire, true);
  // liquidity under this pool's own TVL is refuted (Jupiter missed venues)
  const liq = (tvl) => run([[0, { liquidity: 30000 }], [3, { liquidity: 30000 }], [6, { liquidity: 9000 }, { pool_tvl_usd: tvl }], [9, { liquidity: 9000 }, { pool_tvl_usd: tvl }], [12, { liquidity: 9000 }, { pool_tvl_usd: tvl }]],
    { ref: { active_bin: -400, liquidity_usd: 30000 } });
  assert.equal(liq(12000)[4].fire, false);
  assert.equal(liq(5000)[4].fire, true);
  // invalid stored params → off, nothing
  assert.equal(F.advanceFlowGuard({ ...F.newFlowGuard(D, {}, T0), params: { sell_buy_5m: 0 } }, { reading: reading(T0, DUMP) }, T0).event, "off");
}

// ── Reason, exit, family ────────────────────────────────────────────────────────────────────
{
  const dump = run([[0, DUMP], [3, DUMP], [6, DUMP]])[2];
  const exit = F.buildFlowGuardExit({ conditions: dump.qualified, figures: dump.figures, params: D, cross: dump.cross.details, readings: 3, spanMin: 6 });
  assert.deepEqual([exit.action, exit.rule, exit.family, exit.urgent, exit.hold_override], ["FLOW_GUARD", "flow_guard", "flow_guard", true, "flow_guard"]);
  assert.match(exit.reason, /^Flow guard: sell\/buy 2\.50× in 5m \(≥ 2\) and 1\.60× in 1h \(≥ 1\.3\), price 1h −?-?20\.0% \(≤ −15%\), pool price -18\.\d% from its high on 3 readings over 6m — operator-armed stop$/);
  for (const c of F.FLOW_CONDITIONS) {
    const r = F.flowGuardReason({ conditions: [c], figures: { liquidity_usd: 9000, liquidity_peak_usd: 30000, holders: 1600, holders_peak: 1800, sell_buy_5m: Infinity, sell_buy_1h: 2, price_change_1h_pct: -30, smart_exiting: 3, smart_accumulating: 0 }, params: D, cross: { holder_exodus: { meteora_holders: 1600, meteora_peak: 1800 } }, readings: 3, spanMin: 6 }).toLowerCase();
    for (const bad of ["oor", "below", "floor", "above"]) assert.equal(r.includes(bad), false, `${c}: "${bad}" in ${r}`);
    assert.equal(exitFamilyFromReason(r), "flow_guard");
  }
  assert.equal(exitFamilyFromReason(exit.reason), "flow_guard");
  assert.equal(EXIT_FAMILY_BY_ACTION.FLOW_GUARD, "flow_guard");
  assert.equal(URGENT_EXIT_ACTIONS.has("FLOW_GUARD"), true);
  assert.equal(classifyOutcome({ pnl_pct: -3, exit_family: "flow_guard", initial_value_usd: 1, fees_earned_usd: 0 }), "failure");
  assert.equal(classifyOutcome({ pnl_pct: 6, exit_family: "flow_guard", initial_value_usd: 1, fees_earned_usd: 0.1 }), "neutral");
}

// ── Position state: arm / disarm / close; HOLD-override matrix ──────────────────────────────
let seq = 0;
const mk = (tag, { hold = false, base_mint = WINSTON } = {}) => {
  const addr = `FG${tag}${Date.now()}${seq++}`.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "x").padEnd(40, "x").slice(0, 44);
  S.trackPosition({ position: addr, pool: "POOL_FG_" + tag, pool_name: "WINSTON-SOL", base_mint, amount_sol: 1.0, strategy: "spot", entry_tvl: 30000, bin_step: 100 });
  if (hold) S.setPositionHold(addr, true);
  return addr;
};
const pos = (a) => S.getTrackedPosition(a);
const feedState = (a, tMin, over, extra = {}) => S.noteFlowGuardReading(a, { reading: reading(T0 + tMin * MIN, over), chain: chainAt(-420), meteora_holders: 1800, pool_tvl_usd: 7600, ...extra }, T0 + tMin * MIN);
const fireOn = (a) => { feedState(a, 0, DUMP); feedState(a, 3, DUMP); return feedState(a, 6, DUMP); };
{
  const a = mk("ARM");
  assert.equal(S.setFlowGuard("NOPE" + Date.now(), { params: D }).status, 404);
  assert.equal(S.setFlowGuard(mk("SOL", { base_mint: F.WSOL_MINT }), { params: D }).status, 409);
  const r = S.setFlowGuard(a, { params: D, ref: { active_bin: -400, liquidity_usd: 22000 } }, T0);
  assert.equal(r.ok, true);
  assert.equal(pos(a).flow_guard.armed_at, atIso(T0));
  assert.deepEqual(pos(a).flow_guard.params, D);
  assert.equal(pos(a).flow_guard.ref.active_bin, -400);
  // an unarmed position: the reading is not taken
  assert.equal(S.noteFlowGuardReading(mk("UNARMED"), { reading: reading(T0, DUMP) }, T0), null);
  // disarm clears it, stamp included
  const f = fireOn(a);
  assert.equal(f.fire, true);
  assert.ok(pos(a).flow_guard.streak.confirmed_at);
  const stampTime = T0 + 6 * MIN + SEC;
  assert.equal(holdOverrideActive(pos(a), {}, "flow_guard", stampTime), true);
  S.setFlowGuard(a, null);
  assert.equal(pos(a).flow_guard, null);
  assert.equal(holdOverrideActive(pos(a), {}, "flow_guard", stampTime), false, "disarm closes the door");
  // close clears it and keeps a summary for the perf record
  const c = mk("CLOSE");
  S.setFlowGuard(c, { params: { ...D, confirm_readings: 3 }, ref: { active_bin: -400 } }, T0);
  fireOn(c);
  S.recordClose(c, "Flow guard: test close");
  assert.equal(pos(c).flow_guard, null);
  assert.ok(pos(c).flow_guard_at_close.fire, "fire details kept");
  assert.equal(holdOverrideActive({ ...pos(c), hold_mode: true }, {}, "flow_guard", stampTime), false);
  const rec = PR.buildPerfRecord({ source: "closed_api", tracked: pos(c), close: { pnl_sol: -0.1, minutes_held: 10, minutes_oor: 0, close_reason: "Flow guard: x" } });
  assert.deepEqual(rec.flow_guard.params, D);
  assert.equal(rec.flow_guard.fire.readings, 3);
  assert.equal(rec.flow_guard.fired_at, atIso(T0 + 6 * MIN));
  assert.equal(rec.flow_guard_shadow, null);
}
{
  // The matrix: rule × hands-off × stamp. Positions are held.
  const until = (ms) => new Date(ms + 3 * 3600_000).toISOString();
  const now = T0 + 6 * MIN + 30 * SEC;
  const m = { tvlFloorExitMode: "enforce", holdThinPoolLimitMode: "enforce" };
  const base = (stamps, handsOff) => ({
    hold_mode: true,
    hands_off_until: handsOff ? until(now) : null,
    tvl_floor_exit: stamps.tvl ? { confirmed_at: atIso(now - MIN) } : null,
    hold_thin_limit: stamps.lim ? { streak: { confirmed_at: atIso(now - MIN) } } : null,
    flow_guard: stamps.flow ? { armed_at: atIso(T0), streak: { confirmed_at: atIso(now - MIN) } } : stamps.flowDisarmed ? { armed_at: null, streak: { confirmed_at: atIso(now - MIN) } } : null,
  });
  for (const handsOff of [false, true]) {
    const all = base({ tvl: true, lim: true, flow: true }, handsOff);
    assert.equal(holdOverrideActive(all, m, "tvl_floor", now), !handsOff, `tvl_floor handsOff=${handsOff}`);
    assert.equal(holdOverrideActive(all, m, "hold_limit", now), !handsOff, `hold_limit handsOff=${handsOff}`);
    assert.equal(holdOverrideActive(all, m, "flow_guard", now), true, `flow_guard handsOff=${handsOff}`);
    // one rule's stamp does not serve another
    assert.equal(holdOverrideActive(base({ flow: true }, handsOff), m, "tvl_floor", now), false);
    assert.equal(holdOverrideActive(base({ flow: true }, handsOff), m, "hold_limit", now), false);
    assert.equal(holdOverrideActive(base({ tvl: true, lim: true }, handsOff), m, "flow_guard", now), false);
    // the argument alone opens nothing
    assert.equal(holdOverrideActive(base({}, handsOff), m, "flow_guard", now), false);
    // a stamp left on a disarmed guard opens nothing
    assert.equal(holdOverrideActive(base({ flowDisarmed: true }, handsOff), m, "flow_guard", now), false);
    // stamp older than 10 min, or from the future, opens nothing
    assert.equal(holdOverrideActive(base({ flow: true }, handsOff), m, "flow_guard", now - MIN + HOLD_OVERRIDE_TTL_MS + SEC), false);
    assert.equal(holdOverrideActive(base({ flow: true }, handsOff), m, "flow_guard", now - 2 * MIN), false);
    // the flow guard does not depend on the other rules' modes
    assert.equal(holdOverrideActive(base({ flow: true }, handsOff), { tvlFloorExitMode: "off", holdThinPoolLimitMode: "off" }, "flow_guard", now), true);
    for (const bare of [undefined, null, "", "FLOW_GUARD", "flow guard", 1]) assert.equal(holdOverrideActive(all, m, bare, now), false);
  }
  // real state: a held, hands-off position fires; TVL / thin-limit stamps stay refused
  const h = mk("HELD", { hold: true });
  S.setPositionHandsOff(h, new Date(Date.now() + 3 * 3600_000).toISOString());
  S.setFlowGuard(h, { params: D, ref: { active_bin: -400 } });
  const nowMs = Date.now();
  // feed with real-time stamps so the TTL check uses the wall clock
  const feedNow = (dMin, over) => S.noteFlowGuardReading(h, { reading: reading(nowMs + dMin * MIN, over), chain: chainAt(-420), meteora_holders: 1800 }, nowMs + dMin * MIN);
  feedNow(-6, DUMP); feedNow(-3, DUMP);
  assert.equal(feedNow(0, DUMP).fire, true);
  assert.equal(holdOverrideActive(pos(h), config().management, "flow_guard"), true);
  assert.equal(holdOverrideActive({ ...pos(h), tvl_floor_exit: { confirmed_at: new Date().toISOString() } }, config().management, "tvl_floor"), false);
  // the close passes both close guards (executor + dlmm) only with the override name
  const { executeTool } = await import("../tools/executor.js");
  const blocked = await executeTool("close_position", { position_address: h, reason: "test" });
  assert.equal(blocked.blocked, true, "no override name → HOLD blocks");
  const wrong = await executeTool("close_position", { position_address: h, reason: "test", hold_override: "tvl_floor" });
  assert.equal(wrong.blocked, true, "another rule's name → blocked");
  const passed = await executeTool("close_position", { position_address: h, reason: "Flow guard: test", hold_override: "flow_guard" });
  assert.notEqual(passed?.blocked, true, `flow guard passes the HOLD guards (${JSON.stringify(passed)})`);
}

// ── The cycle with fake deps (replay of a constructed sequence from the real payload) ───────
function fakeDeps(nowMs, extra = {}) {
  const sent = [], logs = [], recorded = [];
  return {
    sent, logs, recorded,
    deps: {
      nowMs, mgmt: { flowGuardShadowMode: "shadow" }, getTrackedPosition: S.getTrackedPosition,
      noteFlowGuardReading: S.noteFlowGuardReading, noteFlowGuardMark: S.noteFlowGuardMark, noteFlowGuardShadowReading: S.noteFlowGuardShadowReading,
      recordFlowReading: (r) => recorded.push(r), gmgnFor: () => null, handsOffActive: () => false,
      log: (cat, msg) => logs.push(msg), sendHTML: (h) => sent.push(h), tagPair: (x) => x, escapeHTML: (x) => String(x), ownerOf: (p) => p, fmtPct: (v) => `${v}%`,
      ...extra,
    },
  };
}
async function cycle(addrs, tMin, over, { fetchThrows = false, chainBin = -420 } = {}) {
  const nowMs = T0 + tMin * MIN;
  const fd = fakeDeps(nowMs, {
    fetchAsset: async (mint) => { if (fetchThrows) throw new Error("boom"); return F.readFlowAsset(payload(0, over), mint, nowMs); },
    readActiveBin: async () => chainAt(chainBin),
  });
  const rows = addrs.map((a) => ({ position: a, pool: "POOL", pair: "WINSTON-SOL", base_mint: WINSTON, pnl_pct: -12, pnl_management_ready: true, active_bin: chainBin, bin_step: 100, flow_pool_holders: 1800, tvl_floor_reading: { ok: true, tvl_usd: 7600 } }));
  const inputs = await C.prefetchFlowGuardInputs(rows, fd.deps);
  const exits = rows.map((p) => { C.runFlowGuardShadow(p, inputs, fd.deps); return C.checkFlowGuard(p, inputs, fd.deps); });
  return { ...fd, exits, inputs };
}
{
  C.resetFlowGuardLogMemory();
  const armed = mk("CYC");
  const unarmed = mk("CYCSHADOW");
  S.setFlowGuard(armed, { params: D, ref: { active_bin: -400 } }, T0 - MIN);
  // calm: real payload → no fire, no alert
  const c0 = await cycle([armed, unarmed], 0, {}, { chainBin: -400 }); // the shadow's bin high comes from the scan rows (pair-minimum)
  assert.deepEqual(c0.exits, [null, null]);
  assert.equal(c0.sent.length, 0);
  assert.equal(c0.recorded.length, 2, "one stored reading per position per cycle (armed + shadow)");
  assert.deepEqual(c0.recorded.map((r) => r.kind).sort(), ["armed", "shadow"]);
  // sustained sell pressure with the price down: start alert on reading 1, fire on reading 3 at ≥ 6 min
  const c1 = await cycle([armed, unarmed], 3, DUMP, { chainBin: -400 });
  assert.equal(c1.exits[0], null);
  assert.equal(c1.sent.length, 1);
  assert.match(c1.sent[0], /Flow guard counting<\/b> — WINSTON-SOL: sell\/buy 2\.50× in 5m .* reading 1\/3/);
  const c2 = await cycle([armed, unarmed], 6, DUMP);
  assert.equal(c2.exits[0], null);
  assert.equal(c2.sent.length, 0, "the start alert is rate-limited (one streak)");
  const c3 = await cycle([armed, unarmed], 9, DUMP);
  assert.equal(c3.exits[0]?.action, "FLOW_GUARD");
  assert.equal(c3.exits[1], null, "an unarmed position never closes");
  assert.equal(c3.sent.length, 1);
  assert.match(c3.sent[0], /Flow guard — closing/);
  assert.ok(pos(unarmed).flow_guard_shadow?.first_would_fire_at, "the shadow recorded a would-fire");
  assert.equal(pos(unarmed).flow_guard_shadow.condition, "sell_pressure");
  assert.equal(pos(unarmed).flow_guard_shadow.pnl_pct_at_fire, -12);
  assert.ok(c3.logs.some((l) => l.startsWith("[FLOW_GUARD_SHADOW] would-close WINSTON-SOL")));
  // a failed fetch closes nothing and never throws
  const a2 = mk("CYCFAIL");
  S.setFlowGuard(a2, { params: D, ref: { active_bin: -400 } }, T0);
  const f1 = await cycle([a2], 3, DUMP, { fetchThrows: true });
  assert.deepEqual(f1.exits, [null]);
  assert.equal(f1.recorded.length, 0);
  // a throwing state function is isolated
  const broken = fakeDeps(T0, { noteFlowGuardReading: () => { throw new Error("db down"); } });
  assert.equal(C.checkFlowGuard({ position: armed, pair: "X" }, { assets: new Map(), chain: new Map() }, broken.deps), null);
  // shadow budget: > 8 distinct mints → shadow skipped, armed still read
  const many = Array.from({ length: 9 }, (_, i) => ({ position: `M${i}`, base_mint: `${"1".repeat(30)}${"ABCDEFGHJ"[i]}${"z".repeat(5)}` }));
  const reads = [];
  const bud = fakeDeps(T0, {
    getTrackedPosition: (a) => ({ base_mint: many.find((x) => x.position === a)?.base_mint, flow_guard: a === "M0" ? { armed_at: atIso(T0) } : null }),
    fetchAsset: async (m) => { reads.push(m); return { ok: false, reason: "x", at: atIso(T0) }; }, readActiveBin: async () => ({ ok: false }),
  });
  const bi = await C.prefetchFlowGuardInputs(many, bud.deps);
  assert.equal(bi.shadowSkipped, true);
  assert.deepEqual(reads, [many[0].base_mint]);
  // shadow off → nothing read for unarmed positions
  const off = fakeDeps(T0, { mgmt: { flowGuardShadowMode: "off" }, fetchAsset: async () => { throw new Error("must not read"); }, readActiveBin: async () => ({ ok: false }) });
  const oi = await C.prefetchFlowGuardInputs([{ position: unarmed, base_mint: WINSTON }], off.deps);
  assert.equal(oi.assets.size, 0);
}

// ── The flow-reading store (json backend → JSONL) ───────────────────────────────────────────
{
  const file = dataPath(FLOW_READINGS_FILE);
  try { fs.unlinkSync(file); } catch { /* none yet */ }
  const r = reading(T0, DUMP);
  recordFlowReading({ position: "P1", pool: "POOL", kind: "armed", reading: r, conditions: ["sell_pressure"] });
  recordFlowReading({ position: "P1", pool: "POOL", kind: "armed", reading: { ok: false } }); // unusable: not stored
  await flushFlowReadings();
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].conditions, ["sell_pressure"]);
  assert.equal(lines[0].mint, WINSTON);
  assert.deepEqual(Object.keys(lines[0].data).sort(), ["buy_1h", "buy_5m", "holders", "jupiter_updated_at", "liquidity_usd", "num_buys_1h", "num_buys_5m", "num_sells_1h", "num_sells_5m", "num_traders_1h", "num_traders_5m", "price_change_1h", "price_change_5m", "price_usd", "sell_1h", "sell_5m"].sort());
  assert.equal(lines[0].data.sell_5m, 10000);
  assert.equal(flowReadingRow({ position: "P", kind: "shadow", reading: reading(T0) }).data.num_buys_5m, 206);
  assert.doesNotThrow(() => recordFlowReading(null));
}

// ── Display ─────────────────────────────────────────────────────────────────────────────────
{
  assert.equal(F.flowGuardRowSuffix({}), "");
  assert.equal(F.flowGuardRowSuffix({ flow_guard: { armed_at: atIso(T0), params: D } }), " · 🛡 flow guard armed");
  assert.equal(F.flowGuardRowSuffix({ flow_guard: { armed_at: atIso(T0), params: D, streak: { count: 2 } } }), " · 🛡 flow guard armed (counting 2/3)");
  assert.equal(F.flowGuardRowSuffix({ flow_guard: { armed_at: atIso(T0), params: D, streak_count: 1 } }), " · 🛡 flow guard armed (counting 1/3)");
  assert.deepEqual(F.flowGuardCardFields({}), { flow_guard: null });
  const s = F.flowGuardSummary(run([[0, DUMP], [3, DUMP]])[1].guard);
  assert.equal(s.armed, true);
  assert.equal(s.streak_count, 2);
  assert.deepEqual(s.streak_conditions, ["sell_pressure"]);
  assert.equal(s.last.sell_buy_5m, 2.5);
}

// ── Experiment grader (docs/experiments/flow-guard.md) ──────────────────────────────────────
{
  const { gradeExperiment, actionFor } = await import("../scripts/experiments/lib.js");
  const { experimentById } = await import("../scripts/experiments/definitions.js");
  const def = experimentById("flow-guard");
  assert.equal(def.population, "bot_and_operator");
  assert.equal(def.enforceBuilt, false);
  const now = Date.parse("2026-12-20T00:00:00Z");
  // final pnl −20 % vs −5 % at the would-fire on ◎1: Δ = −0.20 − (−0.05) = −0.15
  const rec = (i, atFire, finalPct, { adopted = false } = {}) => ({
    position: `P${i}`, pool_name: `T${i}-SOL`, recorded_at: new Date(Date.parse("2026-12-01T00:00:00Z") + i * 3600_000).toISOString(),
    adopted: adopted || undefined, amount_sol: 1, pnl_pct: finalPct, pnl_sol_net: finalPct / 100,
    flow_guard_shadow: { first_would_fire_at: "2026-12-01T00:00:00Z", condition: "sell_pressure", pnl_pct_at_fire: atFire, amount_sol_at_fire: 1, count: 1 },
  });
  const worse = Array.from({ length: 15 }, (_, i) => rec(i, -5, -20, { adopted: i % 2 === 0 }));
  const g1 = gradeExperiment(def, worse, { now, cfg: {} });
  assert.equal(g1.verdict, "met", g1.reason);
  assert.equal(actionFor(g1), "build_enforce", "met → a proposal, never promote");
  assert.equal(g1.sample.n_tagged, 15);
  // one big saver carries (b); without it the rest recovered → (c) fails
  const carried = [rec(0, -5, -95), ...Array.from({ length: 14 }, (_, i) => rec(i + 1, -5, i < 10 ? -6 : 10))];
  const g2 = gradeExperiment(def, carried, { now, cfg: {} });
  assert.equal(g2.checks[0].pass, true);
  assert.equal(g2.checks[1].pass, true);
  assert.equal(g2.checks[2].pass, false);
  assert.equal(g2.verdict, "not_met");
  // recovered after the would-fire → (a) and (b) fail
  const recovered = Array.from({ length: 15 }, (_, i) => rec(i, -5, 4));
  assert.equal(gradeExperiment(def, recovered, { now, cfg: {} }).verdict, "not_met");
  // too few → insufficient; after 90 days → closed insufficient
  assert.equal(gradeExperiment(def, worse.slice(0, 5), { now, cfg: {} }).verdict, "insufficient");
  const late = gradeExperiment(def, worse.slice(0, 5), { now: Date.parse("2027-02-26T00:00:00Z"), cfg: {} });
  assert.equal(late.verdict, "insufficient");
  assert.match(late.reason, /closed insufficient/);
  // a would-fire without a trusted pnl at the fire is not gradeable
  const noPnl = gradeExperiment(def, [...worse.slice(0, 14), { ...rec(99, null, -20), flow_guard_shadow: { first_would_fire_at: "x", pnl_pct_at_fire: null } }], { now, cfg: {} });
  assert.equal(noPnl.verdict, "insufficient");
  assert.equal(noPnl.metrics.would_fires_without_figures, 1);
}

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────
{
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  const defs = fs.readFileSync(new URL("../tools/definitions.js", import.meta.url), "utf8");
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8");
  assert.match(idx, /url === "\/command\/set-flow-guard"/);
  assert.match(idx, /const flowGuardExit = flowInputs \? checkFlowGuard\(p, flowInputs, flowGuardDeps\(\)\) : null;/);
  // the management action guard lets a flow-guard close through hands-off (and only via holdOverride)
  assert.match(idx, /handsOffActive\(heldNow\) && act\.action !== "STAY" && act\.action !== "CLAIM" && !holdOverride/);
  // not an LLM tool, not an update_config key for arming
  assert.doesNotMatch(defs, /flow_guard|flowGuard|set-flow-guard/);
  assert.doesNotMatch(agent, /flow_guard|set_flow_guard/);
  assert.doesNotMatch(exe, /setFlowGuard|set-flow-guard/);
  assert.match(exe, /flowGuardShadowMode: \["management", "flowGuardShadowMode"\]/); // only the log-only shadow key
}

console.log("OK — flow guard");
process.exit(0);
