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
await S.ensureStateInitialized();

const SEC = 1000, MIN = 60_000;
const WINSTON = "7Y2CVbnqZRvR5RUvEJ9RQ73fZEfv7ybNcysytAepump";
const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/flow-guard-winston.json", import.meta.url), "utf8"));
const SAMPLES = JSON.parse(fs.readFileSync(new URL("./fixtures/flow-guard-winston-samples.json", import.meta.url), "utf8"));
const D = F.FLOW_GUARD_DEFAULT_PARAMS;
const T0 = Date.parse("2026-11-27T16:00:00Z");
const atIso = (ms) => new Date(ms).toISOString();

/** A Jupiter asset payload (real WINSTON read, figures overridable). updatedAt = 2 s before the fetch unless given. */
function payload(i = 0, over = {}, ms = T0) {
  const t = JSON.parse(JSON.stringify(FIX[i]));
  t.updatedAt = atIso(ms - 2 * SEC);
  for (const [k, v] of Object.entries(over)) {
    if (k === "stats5m" || k === "stats1h") t[k] = { ...t[k], ...v };
    else t[k] = v;
  }
  return [t];
}
const reading = (ms, over = {}, i = 0) => F.readFlowAsset(payload(i, over, ms), WINSTON, ms);
// Sustained sell pressure with the price down (5m 2.5×, 1h 1.6×, 1h −20 %).
const DUMP = { stats5m: { buyVolume: 4000, sellVolume: 10000, priceChange: -9 }, stats1h: { buyVolume: 100000, sellVolume: 160000, priceChange: -20 } };
const chainAt = (bin, ms) => ({ ok: true, active_bin: bin, bin_step: 100, at: atIso(ms) });
const OWN0 = { usd: 0, trusted: true };

/**
 * Run a sequence of cycles through the pure guard. step = [minute, jupiterOver|null, extra]
 * extra: { bin (default −400), tvl, own, reading (full override) }.
 */
function run(seq, { params = D, ref = { active_bin: -400 } } = {}) {
  let g = F.newFlowGuard(params, { at: atIso(T0), ...ref }, T0);
  const out = [];
  for (const [tMin, over, extra = {}] of seq) {
    const ms = T0 + tMin * MIN;
    const r = extra.reading !== undefined ? extra.reading : over === null ? { ok: false, reason: "fetch failed", at: atIso(ms) } : reading(ms, over);
    const res = F.advanceFlowGuard(g, { reading: r, chain: extra.chain !== undefined ? extra.chain : chainAt(extra.bin ?? -400, ms), pool_tvl_usd: extra.tvl ?? null, own: extra.own ?? OWN0 }, ms);
    g = res.guard;
    out.push(res);
  }
  return out;
}

// ── Params, body (item 8: use_gmgn) ─────────────────────────────────────────────────────────
{
  assert.deepEqual(F.parseFlowGuardParams(undefined), { ok: true, params: { ...D } });
  assert.deepEqual(D, { sell_buy_5m: 2, sell_buy_1h: 1.3, price_drop_1h_pct: 15, liquidity_drop_pct: 50, holders_drop_pct: 5, confirm_readings: 3, confirm_minutes: 6 });
  assert.equal(F.parseFlowGuardParams({ sell_buy_5m: 3 }).params.confirm_readings, 3, "missing keys take the default");
  for (const bad of [{ sell_buy_5m: 1.1 }, { sell_buy_5m: 11 }, { sell_buy_1h: 0.9 }, { price_drop_1h_pct: 4 }, { price_drop_1h_pct: 91 },
    { liquidity_drop_pct: 19 }, { liquidity_drop_pct: 96 }, { holders_drop_pct: 1 }, { holders_drop_pct: 51 }, { confirm_readings: 1 },
    { confirm_readings: 11 }, { confirm_readings: 2.5 }, { confirm_minutes: 2 }, { confirm_minutes: 61 }, { sell_buy_5m: "2" },
    { sell_buy_5m: NaN }, { use_gmgn: true }, { use_gmgn: "true" }, { nope: 1 }, [], "x"]) {
    assert.equal(F.parseFlowGuardParams(bad).ok, false, JSON.stringify(bad));
  }
  assert.match(F.parseFlowGuardParams({ use_gmgn: true }).error, /use_gmgn/);
  assert.deepEqual(F.parseFlowGuardParams({ use_gmgn: false }).params, { ...D }, "use_gmgn false is tolerated and dropped");
  for (const ok of [{ sell_buy_5m: 1.2 }, { sell_buy_5m: 10 }, { confirm_readings: 2 }, { confirm_minutes: 3 }]) assert.equal(F.parseFlowGuardParams(ok).ok, true);
  const pos = "8R28PAPjv6Z5fYh7m9sFTRpos11111111111111111";
  assert.deepEqual(F.parseFlowGuardBody({ position: pos, arm: true }), { ok: true, position: pos, arm: true, params: { ...D } });
  assert.equal(F.parseFlowGuardBody({ position: pos, arm: true, params: { use_gmgn: true } }).ok, false, "use_gmgn: true → 400 at arming");
  assert.deepEqual(F.parseFlowGuardBody({ position: pos, arm: false }), { ok: true, position: pos, arm: false, params: null });
  assert.equal(F.parseFlowGuardBody({ position: pos, arm: false, params: {} }).ok, false);
  assert.equal(F.parseFlowGuardBody({ position: pos, arm: "yes" }).ok, false);
  assert.equal(F.parseFlowGuardBody({ position: "not base58!", arm: true }).ok, false);
  assert.equal(F.parseFlowGuardBody({ position: pos, arm: true, extra: 1 }).ok, false);
  assert.equal(F.flowGuardRefusal(null).status, 404);
  assert.equal(F.flowGuardRefusal({ base_mint: F.WSOL_MINT }).status, 409);
  assert.equal(F.flowGuardRefusal({ base_mint: null }, { disarming: true }), null);
  assert.equal(F.flowGuardShadowMode({}), "shadow");
  assert.equal(F.flowGuardShadowMode({ flowGuardShadowMode: "enforce" }), "shadow", "no enforce exists");
  // item 6: kill switch parse
  assert.equal(F.flowGuardMode({}), "armed");
  assert.equal(F.flowGuardMode({ flowGuardMode: "off" }), "off");
  assert.equal(F.flowGuardMode({ flowGuardMode: "ON" }), "off", "unknown → off (fail closed)");
  assert.equal(F.flowGuardMode({ flowGuardMode: "" }), "off");
}

// ── The reading (real payloads; `updatedAt` verified on the live endpoint) ──────────────────
{
  const r = F.readFlowAsset(FIX.map((x) => x).slice(0, 1), WINSTON, T0);
  assert.equal(r.ok, true);
  assert.equal(r.updated_at, FIX[0].updatedAt);
  assert.equal(r.liquidity_usd, FIX[0].liquidity);
  assert.equal(r.holders, 1794);
  assert.equal(r.s5m.num_buys, 206);
  assert.equal(F.readFlowAsset(payload(0, { id: F.WSOL_MINT }), WINSTON, T0).ok, false, "only the exact mint");
  assert.equal(F.readFlowAsset(payload(0, { liquidity: "22733" }), WINSTON, T0).liquidity_usd, null, "strings are not coerced");
  // The real reads at the time of writing do not qualify under the defaults (no peak yet either).
  const res = run([[0, {}], [3, {}, { reading: F.readFlowAsset(payload(1, {}, T0 + 3 * MIN), WINSTON, T0 + 3 * MIN) }]]);
  assert.deepEqual(res.map((x) => x.qualified), [[], []]);
}

// ── Item 2: distinct, fresh snapshots; confirmed peaks; the arming read is never a reading ───
{
  // the same snapshot fetched twice → stale (neither counts nor resets)
  const same = F.readFlowAsset(payload(0, DUMP, T0 + 6 * MIN), WINSTON, T0 + 6 * MIN);
  const again = { ...same, at: atIso(T0 + 9 * MIN) };
  const st = run([[3, DUMP], [6, null, { reading: same }], [9, null, { reading: again }], [12, DUMP]]);
  assert.deepEqual(st.map((x) => x.event), ["counted", "counted", "stale", "counted"]);
  assert.equal(st[2].guard.streaks.sell_pressure.count, 2, "stale: not counted, not reset");
  assert.equal(st[3].guard.streaks.sell_pressure.count, 3);
  // snapshot older than 5 min at fetch → stale
  const old = F.readFlowAsset(payload(0, DUMP, T0 + 3 * MIN), WINSTON, T0 + 9 * MIN);
  assert.equal(run([[9, null, { reading: old }]])[0].event, "stale");
  // no updatedAt → stale
  assert.equal(run([[3, { updatedAt: null }]])[0].event, "stale");
  // snapshots < 60 s apart → one reading
  const m = run([[3, DUMP], [3.5, DUMP]]);
  assert.equal(m[1].event, "merged");
  // reviewer's staleSnapshot: an identical old snapshot re-fetched three times never counts
  const stuck = { ...reading(T0 + 9 * MIN, { liquidity: 45000 }), updated_at: "2026-11-27T11:00:00Z" };
  const ss = run([[3, {}], [6, {}], ...[9, 12, 15].map((t) => [t, null, { reading: { ...stuck, at: atIso(T0 + t * MIN) } }])]);
  assert.deepEqual(ss.slice(2).map((x) => x.event), ["stale", "stale", "stale"]);
  assert.equal(ss.some((x) => x.fire), false);
  // peaks: none until two counted readings; first = the lower of the two; a single spike never a peak
  const pk = run([[3, { liquidity: 30000 }], [6, { liquidity: 200000 }], [9, { liquidity: 30000 }], [12, { liquidity: 30000 }], [15, { liquidity: 30000 }]]);
  assert.equal(pk[0].guard.peak.liquidity_mkt_usd, null, "one counted reading: no peak, conditions 2 / 3 cannot qualify");
  assert.equal(pk[1].guard.peak.liquidity_mkt_usd, 30000);
  assert.equal(pk[4].guard.peak.liquidity_mkt_usd, 30000, "the 200k spike never became the peak");
  assert.equal(pk.some((x) => x.qualified.includes("liquidity_pull")), false);
  // reviewer's cachedSpike: the arming read (spiked 200k) is served again by the cache to the
  // first cycle → same snapshot → stale; the next distinct readings (100k) are the peak; no fire.
  const spike = F.readFlowAsset(payload(0, { liquidity: 200000 }, T0), WINSTON, T0);
  const cs = run([[0.5, null, { reading: { ...spike, at: atIso(T0 + 30 * SEC) } }], [3, { liquidity: 100000 }], [6, { liquidity: 100000 }], [9, { liquidity: 100000 }]],
    { ref: { active_bin: 0, liquidity_usd: 200000, holders: 1000, updated_at: spike.updated_at } });
  assert.equal(cs[0].event, "stale", "the arming snapshot cannot serve as a cycle reading");
  assert.equal(cs[3].guard.peak.liquidity_mkt_usd, 100000);
  assert.equal(cs.some((x) => x.qualified.includes("liquidity_pull") || x.fire), false);
}

// ── Item 1: one condition per streak (reviewer's `mixed` no longer fires) ───────────────────
{
  // two holder dips, then ONE liquidity dip (all with ring price down 20 %) → no condition has 3
  const mixed = run([[0, { liquidity: 100000, holderCount: 1000 }, { bin: -400 }], [3, { liquidity: 100000, holderCount: 1000 }, { bin: -400 }],
    [9, { liquidity: 100000, holderCount: 940 }, { bin: -420 }], [12, { liquidity: 100000, holderCount: 940 }, { bin: -420 }],
    [15, { liquidity: 49000, holderCount: 1000 }, { bin: -420 }], [18, { liquidity: 49000, holderCount: 1000 }, { bin: -420 }]]);
  assert.equal(mixed.some((x) => x.fire), false);
  assert.deepEqual(mixed[4].reset, ["holder_exodus"], "a reading that does not meet X resets X only");
  assert.equal(mixed[4].guard.streaks.liquidity_pull.count, 1);
  assert.equal(mixed[5].guard.streaks.liquidity_pull.count, 2);
  // the same condition three times does fire (liquidity, corroborated by the ring price −18 %)
  const liq3 = run([[0, { liquidity: 100000 }], [3, { liquidity: 100000 }], [9, { liquidity: 49000 }, { bin: -420 }], [12, { liquidity: 49000 }, { bin: -420 }], [15, { liquidity: 49000 }, { bin: -420 }]]);
  assert.deepEqual(liq3.map((x) => x.fire), [false, false, false, false, true]);
  assert.equal(liq3[4].fired_condition, "liquidity_pull");
  assert.ok(liq3[4].guard.confirmed_at, "the firing reading writes the stamp");
  // the next reading drops the stamp
  assert.equal(F.advanceFlowGuard(liq3[4].guard, { reading: { ok: false, reason: "x", at: atIso(T0 + 18 * MIN) } }, T0 + 18 * MIN).guard.confirmed_at, null);
  // an unusable reading inside a streak neither counts nor resets; > 15 min restarts
  const gaps = run([[0, DUMP], [3, null], [4, DUMP], [21, DUMP]]);
  assert.deepEqual(gaps.map((x) => x.event), ["counted", "ignored", "counted", "counted"]);
  assert.equal(gaps[2].guard.streaks.sell_pressure.count, 2);
  assert.equal(gaps[3].guard.streaks.sell_pressure.count, 1, "gap > 15 min: restarted");
  // confirm_minutes not reached (3 readings over 4 min) → not ready
  const quick = run([[20, DUMP, { bin: -420 }], [22, DUMP, { bin: -420 }], [24, DUMP, { bin: -420 }]]);
  assert.deepEqual(quick[2].ready, []);
}

// ── Items 3 / 4: corroboration and the on-chain ring ────────────────────────────────────────
{
  // ring unit: under 15 min → null; 15–60 min → oldest; > 60 min → closest to 60 min ago
  const ring = [{ at: atIso(T0), bin: -400 }, { at: atIso(T0 + 10 * MIN), bin: -405 }];
  assert.equal(F.ringPriceChangePct(ring, 100, T0 + 10 * MIN), null, "10 min of ring: unavailable");
  const r2 = [...ring, { at: atIso(T0 + 20 * MIN), bin: -420 }];
  assert.ok(Math.abs(F.ringPriceChangePct(r2, 100, T0 + 20 * MIN) - (Math.pow(1.01, -20) - 1) * 100) < 1e-9);
  const long = Array.from({ length: 30 }, (_, i) => ({ at: atIso(T0 + i * 3 * MIN), bin: i < 5 ? -300 : -400 }));
  const lastMs = T0 + 29 * 3 * MIN;
  const exp = (Math.pow(1.01, 0) - 1) * 100; // the entry closest to 60 min before the newest is already −400
  assert.equal(F.ringPriceChangePct(long, 100, lastMs), exp);
  assert.equal(F.ringPriceChangePct(r2, 100, T0 + 25 * MIN), null, "newest entry older than 2 min: unavailable");
  assert.equal(F.pushRing(Array.from({ length: 30 }, (_, i) => ({ at: atIso(T0 + i * MIN), bin: i })), chainAt(99, T0 + 31 * MIN), T0).length, 30, "≤ 30 entries");

  // sell pressure: needs the ring ≥ 15 min and down ≥ 10 % (15 × 2/3)
  const early = run([[3, DUMP, { bin: -420 }], [6, DUMP, { bin: -420 }], [9, DUMP, { bin: -420 }]]);
  assert.deepEqual(early[2].ready, ["sell_pressure"]);
  assert.equal(early[2].cross.sell_pressure.verdict, "unavailable", "ring under 15 min → fails closed");
  assert.equal(early[2].fire, false);
  const ok = run([[15, DUMP, { bin: -420 }], [18, DUMP, { bin: -420 }], [21, DUMP, { bin: -420 }]]);
  assert.equal(ok[2].fire, true);
  assert.equal(ok[2].fired_condition, "sell_pressure");
  // chain read failed this cycle → unavailable, no fire; streak kept and fires next cycle
  const noChain = run([[15, DUMP, { bin: -420 }], [18, DUMP, { bin: -420 }], [21, DUMP, { chain: { ok: false, reason: "timeout" } }], [24, DUMP, { bin: -420 }]]);
  assert.equal(noChain[2].fire, false);
  assert.equal(noChain[2].cross.sell_pressure.verdict, "unavailable");
  assert.equal(noChain[3].fire, true);
  // reviewer's flat pool under an old high: armed at bin 0, the pool sits at −9 for over an hour
  // while Jupiter reports −16 % 1h with sell pressure → the ring says 0 % over the last hour → no fire
  const SELL = { stats5m: { buyVolume: 1000, sellVolume: 3000, priceChange: -3 }, stats1h: { buyVolume: 10000, sellVolume: 20000, priceChange: -16 } };
  const flatSteps = [];
  for (let t = 3; t <= 90; t += 3) flatSteps.push([t, t >= 81 ? SELL : {}, { bin: -9 }]);
  const flat = run(flatSteps, { ref: { active_bin: 0 } });
  assert.equal(flat.some((x) => x.fire), false);
  const lastFlat = flat[flat.length - 1];
  assert.deepEqual(lastFlat.ready, ["sell_pressure"]);
  assert.equal(lastFlat.cross.sell_pressure.ring_change_pct, 0);
  assert.equal(lastFlat.cross.sell_pressure.verdict, "disagree");

  // liquidity pull without corroboration (pool TVL steady, price flat) → no fire
  const liqFlat = run([[0, { liquidity: 100000 }, { tvl: 20000 }], [3, { liquidity: 100000 }, { tvl: 20000 }],
    [15, { liquidity: 40000 }, { tvl: 20000 }], [18, { liquidity: 40000 }, { tvl: 20000 }], [21, { liquidity: 40000 }, { tvl: 20000 }]]);
  assert.deepEqual(liqFlat[4].ready, ["liquidity_pull"]);
  assert.equal(liqFlat[4].fire, false);
  // … with this pool's TVL down to ≤ 70 % of its peak → fires
  const liqTvl = run([[0, { liquidity: 100000 }, { tvl: 20000 }], [3, { liquidity: 100000 }, { tvl: 20000 }],
    [15, { liquidity: 40000 }, { tvl: 13000 }], [18, { liquidity: 40000 }, { tvl: 13000 }], [21, { liquidity: 40000 }, { tvl: 13000 }]]);
  assert.equal(liqTvl[4].fire, true);
  assert.equal(liqTvl[4].cross.liquidity_pull.by, "pool_tvl");
  // holder exodus without corroboration → no fire; with 1h sell/buy ≥ 1.3 → fires; with the ring −10 % → fires
  const H = (sb, bin = -400) => run([[0, { holderCount: 1000 }], [3, { holderCount: 1000 }],
    [15, { holderCount: 940, stats1h: sb }, { bin }], [18, { holderCount: 940, stats1h: sb }, { bin }], [21, { holderCount: 940, stats1h: sb }, { bin }]]);
  const calm1h = { buyVolume: 10000, sellVolume: 10000, priceChange: 0 };
  assert.equal(H(calm1h)[4].fire, false);
  assert.deepEqual(H(calm1h)[4].ready, ["holder_exodus"]);
  assert.equal(H({ buyVolume: 10000, sellVolume: 13500, priceChange: 0 })[4].fire, true);
  assert.equal(H(calm1h, -411)[4].fire, true, "ring −10.4 %");
  assert.equal(H({ buyVolume: 100, sellVolume: 800, priceChange: 0 })[4].fire, false, "1h ratio under the dust floor is not corroboration");
}

// ── Item 7: own liquidity; an operator top-up / withdrawal is not a market move ─────────────
{
  // Withdrawal: the position held $50k of a $100k all-venue liquidity and the operator withdraws
  // it; Jupiter liquidity halves but market liquidity (minus own) stays $50k → nothing qualifies.
  const wd = run([[0, { liquidity: 100000 }, { own: { usd: 50000, trusted: true } }], [3, { liquidity: 100000 }, { own: { usd: 50000, trusted: true } }],
    [6, { liquidity: 50000 }, { own: { usd: 0, trusted: true }, bin: -420 }], [9, { liquidity: 50000 }, { own: { usd: 0, trusted: true }, bin: -420 }],
    [12, { liquidity: 50000 }, { own: { usd: 0, trusted: true }, bin: -420 }], [15, { liquidity: 50000 }, { own: { usd: 0, trusted: true }, bin: -420 }]]);
  assert.equal(wd[2].figures.liquidity_mkt_usd, null, "the reading where the own value jumped is not used for liquidity");
  assert.equal(wd.some((x) => x.qualified.includes("liquidity_pull") || x.fire), false);
  // Top-up: own value jumps first (Jupiter not caught up), then both: never a liquidity streak
  const tu = run([[0, { liquidity: 60000 }, { own: { usd: 10000, trusted: true } }], [3, { liquidity: 60000 }, { own: { usd: 10000, trusted: true } }],
    [6, { liquidity: 60000 }, { own: { usd: 40000, trusted: true } }], [9, { liquidity: 90000 }, { own: { usd: 40000, trusted: true } }],
    [12, { liquidity: 90000 }, { own: { usd: 40000, trusted: true } }]]);
  assert.equal(tu[2].figures.liquidity_mkt_usd, null);
  assert.equal(tu.some((x) => x.qualified.includes("liquidity_pull")), false);
  assert.equal(tu[4].guard.peak.liquidity_mkt_usd, 50000);
  // untrusted own value → liquidity figures not used at all
  assert.equal(run([[0, {}, { own: { usd: 1000, trusted: false } }]])[0].figures.liquidity_mkt_usd, null);
  // the cycle's own-value input: valid valuation, no pending flow
  assert.deepEqual(C.ownValueOf({ total_value_true_usd: 1200 }, {}), { usd: 1200, trusted: true });
  assert.equal(C.ownValueOf({ total_value_true_usd: 1200, pnl_quality: "extreme_divergence" }, {}).trusted, false);
  assert.equal(C.ownValueOf({ total_value_true_usd: 1200 }, { pending_flow: { x: 1 } }).trusted, false);
  assert.equal(C.ownValueOf({ total_value_true_usd: 1200 }, { capital_rebase_pending: { x: 1 } }).trusted, false);
  assert.equal(C.ownValueOf({}, {}).trusted, false);
}

// ── Replay: the reviewer's real WINSTON sample (−46 % liquidity on one fetch, price flat) ────
{
  let g = F.newFlowGuard(D, { at: atIso(SAMPLES.samples[0].t * 1000 - 60 * MIN), active_bin: -400 }, SAMPLES.samples[0].t * 1000 - 60 * MIN);
  const evs = [];
  for (const s of SAMPLES.samples) {
    const ms = Math.round(s.t * 1000);
    const t = { id: WINSTON, liquidity: s.liq, holderCount: s.holders, usdPrice: s.price, updatedAt: s.upd, stats5m: s.s5, stats1h: s.s1h };
    const res = F.advanceFlowGuard(g, { reading: F.readFlowAsset([t], WINSTON, ms), chain: chainAt(-400, ms), pool_tvl_usd: 7600, own: OWN0 }, ms);
    g = res.guard;
    evs.push(res);
    assert.equal(res.guard.streaks.liquidity_pull, null, `no liquidity streak at ${s.upd}`);
    assert.equal(res.fire, false);
  }
  const blip = SAMPLES.samples.findIndex((s) => s.liq < 20000);
  assert.ok(blip > 0);
  assert.ok(g.peak.liquidity_mkt_usd >= 30000, "the blip never lowered / defined the peak");
  assert.equal(evs[1].event, "stale", "the second fetch returned the same snapshot");
  // even with a 45 % threshold (the blip is at 54 % of the peak) one blip starts at most one
  // reading and the next distinct reading resets it — no fire.
  let g2 = F.newFlowGuard({ ...D, liquidity_drop_pct: 45 }, { at: atIso(SAMPLES.samples[0].t * 1000 - 60 * MIN), active_bin: -400 }, SAMPLES.samples[0].t * 1000 - 60 * MIN);
  let maxCount = 0;
  for (const s of SAMPLES.samples) {
    const ms = Math.round(s.t * 1000);
    const t = { id: WINSTON, liquidity: s.liq, holderCount: s.holders, usdPrice: s.price, updatedAt: s.upd, stats5m: s.s5, stats1h: s.s1h };
    const res = F.advanceFlowGuard(g2, { reading: F.readFlowAsset([t], WINSTON, ms), chain: chainAt(-400, ms), own: OWN0 }, ms);
    g2 = res.guard;
    maxCount = Math.max(maxCount, res.guard.streaks.liquidity_pull?.count ?? 0);
    assert.equal(res.fire, false);
  }
  assert.ok(maxCount <= 1);
}

// ── Reason, exit, family ────────────────────────────────────────────────────────────────────
{
  const ok = run([[15, DUMP, { bin: -420 }], [18, DUMP, { bin: -420 }], [21, DUMP, { bin: -420 }]])[2];
  const exit = F.buildFlowGuardExit({ condition: ok.fired_condition, figures: ok.figures, params: D, peak: ok.guard.peak, corroboration: ok.cross.sell_pressure, readings: 3, spanMin: 6 });
  assert.deepEqual([exit.action, exit.rule, exit.family, exit.urgent, exit.hold_override], ["FLOW_GUARD", "flow_guard", "flow_guard", true, "flow_guard"]);
  assert.match(exit.reason, /^Flow guard: sell\/buy 2\.50× in 5m \(≥ 2\) and 1\.60× in 1h \(≥ 1\.3\), price 1h -20\.0% \(≤ −15%\), pool price -18\.\d% on chain over the last hour on 3 readings over 6m — operator-armed stop$/);
  for (const c of F.FLOW_CONDITIONS) {
    for (const corr of [null, { by: "pool_tvl", pool_tvl_mkt_usd: 1, pool_tvl_peak_usd: 2 }, { by: "ring_price", ring_change_pct: -20 }, { by: "sell_buy_1h" }]) {
      const r = F.flowGuardReason({ condition: c, figures: { liquidity_mkt_usd: 9000, holders: 1600, sell_buy_5m: Infinity, sell_buy_1h: 2, price_change_1h_pct: -30 }, params: D, peak: { liquidity_mkt_usd: 30000, holders: 1800 }, corroboration: corr, readings: 3, spanMin: 6 }).toLowerCase();
      for (const bad of ["oor", "below", "floor", "above"]) assert.equal(r.includes(bad), false, `${c}: "${bad}" in ${r}`);
      assert.equal(exitFamilyFromReason(r), "flow_guard");
    }
  }
  assert.equal(EXIT_FAMILY_BY_ACTION.FLOW_GUARD, "flow_guard");
  assert.equal(URGENT_EXIT_ACTIONS.has("FLOW_GUARD"), true);
  assert.equal(classifyOutcome({ pnl_pct: -3, exit_family: "flow_guard", initial_value_usd: 1, fees_earned_usd: 0 }), "failure");
  assert.equal(classifyOutcome({ pnl_pct: 6, exit_family: "flow_guard", initial_value_usd: 1, fees_earned_usd: 0.1 }), "neutral");
}

// ── Position state: arm / re-arm / disarm / close; HOLD-override matrix (items 6, 10) ───────
let seq = 0;
const mk = (tag, { hold = false, base_mint = WINSTON } = {}) => {
  const addr = `FG${tag}${Date.now()}${seq++}`.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "x").padEnd(40, "x").slice(0, 44);
  S.trackPosition({ position: addr, pool: "POOL_FG_" + tag, pool_name: "WINSTON-SOL", base_mint, amount_sol: 1.0, strategy: "spot", entry_tvl: 30000, bin_step: 100 });
  if (hold) S.setPositionHold(addr, true);
  return addr;
};
const pos = (a) => S.getTrackedPosition(a);
/** Feed the stored guard: three sell-pressure readings ending at `endMs`, ring armed 21 min before. */
function fireOn(a, endMs) {
  const res = [];
  for (const back of [6, 3, 0]) {
    const ms = endMs - back * MIN;
    res.push(S.noteFlowGuardReading(a, { reading: reading(ms, DUMP), chain: chainAt(-420, ms), own: OWN0 }, ms));
  }
  return res[2];
}
{
  const a = mk("ARM");
  assert.equal(S.setFlowGuard("NOPE" + Date.now(), { params: D }).status, 404);
  assert.equal(S.setFlowGuard(mk("SOL", { base_mint: F.WSOL_MINT }), { params: D }).status, 409);
  const armAt = Date.now() - 30 * MIN;
  assert.equal(S.setFlowGuard(a, { params: D, ref: { active_bin: -400, bin_step: 100, at: atIso(armAt) } }, armAt).ok, true);
  assert.deepEqual(pos(a).flow_guard.params, D);
  assert.equal(pos(a).flow_guard.ring.length, 1, "the arming bin seeds the ring");
  assert.equal(S.noteFlowGuardReading(mk("UNARMED"), { reading: reading(T0, DUMP) }, T0), null);
  const f = fireOn(a, Date.now());
  assert.equal(f.fire, true);
  assert.equal(holdOverrideActive({ ...pos(a), hold_mode: true }, {}, "flow_guard"), true);
  // re-arming replaces params and resets peaks / streaks / ring
  S.setFlowGuard(a, { params: { ...D, confirm_readings: 4 }, ref: { active_bin: -420, bin_step: 100 } });
  assert.equal(pos(a).flow_guard.params.confirm_readings, 4);
  assert.equal(pos(a).flow_guard.streaks.sell_pressure, null);
  assert.equal(pos(a).flow_guard.counted, 0);
  assert.equal(pos(a).flow_guard.confirmed_at, null);
  // disarm clears it, stamp included
  fireOn(a, Date.now()); // re-armed with 4 readings: not fired
  S.setFlowGuard(a, null);
  assert.equal(pos(a).flow_guard, null);
  // close clears it and keeps a summary for the perf record
  const c = mk("CLOSE");
  S.setFlowGuard(c, { params: D, ref: { active_bin: -400, bin_step: 100, at: atIso(armAt) } }, armAt);
  fireOn(c, Date.now());
  S.recordClose(c, "Flow guard: test close");
  assert.equal(pos(c).flow_guard, null);
  assert.ok(pos(c).flow_guard_at_close.fire);
  assert.equal(holdOverrideActive({ ...pos(c), hold_mode: true }, {}, "flow_guard"), false);
  const rec = PR.buildPerfRecord({ source: "closed_api", tracked: pos(c), close: { pnl_sol: -0.1, minutes_held: 10, minutes_oor: 0, close_reason: "Flow guard: x" } });
  assert.deepEqual(rec.flow_guard.params, D);
  assert.equal(rec.flow_guard.fire.condition, "sell_pressure");
  assert.equal(rec.flow_guard.fire.readings, 3);
  assert.equal(rec.flow_guard_shadow, null);
}
{
  // The matrix: rule × hands-off × kill switch × stamp. Positions are held.
  const now = Date.now();
  const until = new Date(now + 3 * 3600_000).toISOString();
  const m = { tvlFloorExitMode: "enforce", holdThinPoolLimitMode: "enforce" };
  const base = (stamps, handsOff) => ({
    hold_mode: true,
    hands_off_until: handsOff ? until : null,
    tvl_floor_exit: stamps.tvl ? { confirmed_at: atIso(now - MIN) } : null,
    hold_thin_limit: stamps.lim ? { streak: { confirmed_at: atIso(now - MIN) } } : null,
    flow_guard: stamps.flow ? { armed_at: atIso(now - 60 * MIN), confirmed_at: atIso(now - MIN) } : stamps.flowDisarmed ? { armed_at: null, confirmed_at: atIso(now - MIN) } : null,
  });
  for (const handsOff of [false, true]) {
    const all = base({ tvl: true, lim: true, flow: true }, handsOff);
    assert.equal(holdOverrideActive(all, m, "tvl_floor", now), !handsOff, `tvl_floor handsOff=${handsOff}`);
    assert.equal(holdOverrideActive(all, m, "hold_limit", now), !handsOff, `hold_limit handsOff=${handsOff}`);
    assert.equal(holdOverrideActive(all, m, "flow_guard", now), true, `flow_guard handsOff=${handsOff}`);
    assert.equal(holdOverrideActive(all, { ...m, flowGuardMode: "off" }, "flow_guard", now), false, "kill switch off refuses flow_guard");
    assert.equal(holdOverrideActive(all, { ...m, flowGuardMode: "typo" }, "flow_guard", now), false, "unknown mode → off");
    assert.equal(holdOverrideActive(all, { ...m, flowGuardMode: "off" }, "tvl_floor", now), !handsOff, "the kill switch does not touch the other rules");
    assert.equal(holdOverrideActive(base({ flow: true }, handsOff), m, "tvl_floor", now), false);
    assert.equal(holdOverrideActive(base({ flow: true }, handsOff), m, "hold_limit", now), false);
    assert.equal(holdOverrideActive(base({ tvl: true, lim: true }, handsOff), m, "flow_guard", now), false);
    assert.equal(holdOverrideActive(base({}, handsOff), m, "flow_guard", now), false, "the argument alone opens nothing");
    assert.equal(holdOverrideActive(base({ flowDisarmed: true }, handsOff), m, "flow_guard", now), false);
    assert.equal(holdOverrideActive(base({ flow: true }, handsOff), m, "flow_guard", now - MIN + HOLD_OVERRIDE_TTL_MS + SEC), false, "stale stamp");
    assert.equal(holdOverrideActive(base({ flow: true }, handsOff), m, "flow_guard", now - 2 * MIN), false, "stamp from the future");
    assert.equal(holdOverrideActive(base({ flow: true }, handsOff), { tvlFloorExitMode: "off", holdThinPoolLimitMode: "off" }, "flow_guard", now), true);
    for (const bare of [undefined, null, "", "FLOW_GUARD", "flow guard", 1]) assert.equal(holdOverrideActive(all, m, bare, now), false);
  }
  // real state: a held, hands-off position fires; the close passes both close guards only with the name
  const h = mk("HELD", { hold: true });
  S.setPositionHandsOff(h, new Date(Date.now() + 3 * 3600_000).toISOString());
  const armAt = Date.now() - 30 * MIN;
  S.setFlowGuard(h, { params: D, ref: { active_bin: -400, bin_step: 100, at: atIso(armAt) } }, armAt);
  assert.equal(fireOn(h, Date.now()).fire, true);
  assert.equal(holdOverrideActive(pos(h), CONFIG.management, "flow_guard"), true);
  assert.equal(holdOverrideActive({ ...pos(h), tvl_floor_exit: { confirmed_at: new Date().toISOString() } }, CONFIG.management, "tvl_floor"), false);
  const { executeTool } = await import("../tools/executor.js");
  assert.equal((await executeTool("close_position", { position_address: h, reason: "test" })).blocked, true, "no override name → HOLD blocks");
  assert.equal((await executeTool("close_position", { position_address: h, reason: "test", hold_override: "tvl_floor" })).blocked, true);
  const passed = await executeTool("close_position", { position_address: h, reason: "Flow guard: test", hold_override: "flow_guard" });
  assert.notEqual(passed?.blocked, true, `flow guard passes the HOLD guards (${JSON.stringify(passed)})`);
}
{
  // item 10: a resurrected row carries no old guard / shadow
  const src = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
  assert.match(src, /existing\.flow_guard = null; existing\.flow_guard_shadow = null; existing\.flow_guard_shadow_state = null;/);
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /if \(!bin\?\.ok\) return commandJson\(res, 503,/, "arming fails with 503 without the on-chain reference");
  assert.match(idx, /getPoolActiveBinFresh\(tracked\.pool, \{ timeoutMs: 3_000 \}\)/);
  const dl = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const fn = dl.slice(dl.indexOf("export async function getPoolActiveBinFresh"), dl.indexOf("export async function getPoolActiveBinFresh") + 1400);
  assert.match(fn, /callRpc\(/, "through the RPC failover wrapper");
  assert.match(fn, /Promise\.race/, "bounded");
  assert.doesNotMatch(fn, /getActiveBin\(\)/);
}

// ── The cycle with fake deps (items 5, 6) ───────────────────────────────────────────────────
function fakeDeps(nowMs, extra = {}) {
  const sent = [], logs = [], recorded = [], requests = [];
  return {
    sent, logs, recorded, requests,
    deps: {
      nowMs, mgmt: { flowGuardShadowMode: "shadow" }, getTrackedPosition: S.getTrackedPosition,
      noteFlowGuardReading: S.noteFlowGuardReading, noteFlowGuardMark: S.noteFlowGuardMark, noteFlowGuardShadowReading: S.noteFlowGuardShadowReading,
      recordFlowReading: (r) => recorded.push(r), handsOffActive: () => false,
      fetchAsset: async (m) => { requests.push(["asset", m]); return { ok: false, reason: "x", at: atIso(nowMs) }; },
      readActiveBin: async (pl) => { requests.push(["bin", pl]); return { ok: false, reason: "x" }; },
      log: (cat, msg) => logs.push(msg), sendHTML: (h) => sent.push(h), tagPair: (x) => x, escapeHTML: (x) => String(x), ownerOf: (p) => p, fmtPct: (v) => `${v}%`,
      ...extra,
    },
  };
}
const rowOf = (a, bin, { own = 0 } = {}) => ({ position: a, pool: "POOL", pair: "WINSTON-SOL", base_mint: WINSTON, pnl_pct: -12, pnl_management_ready: true, active_bin: bin, bin_step: 100, total_value_true_usd: own, tvl_floor_reading: { ok: true, tvl_usd: 7600 } });
async function cycle(addrs, nowMs, over, { bin = -420, fetchThrows = false } = {}) {
  const fd = fakeDeps(nowMs, {
    fetchAsset: async (mint) => { fd.requests.push(["asset", mint]); if (fetchThrows) throw new Error("boom"); return F.readFlowAsset(payload(0, over, nowMs), mint, nowMs); },
    readActiveBin: async () => chainAt(bin, nowMs),
  });
  const rows = addrs.map((a) => rowOf(a, bin));
  const inputs = await C.prefetchArmedFlowGuardInputs(rows, fd.deps);
  const exits = rows.map((p) => C.checkFlowGuard(p, inputs, fd.deps));
  await C.runFlowGuardShadowDetached(rows, fd.deps);
  return { ...fd, exits, inputs };
}
{
  C.resetFlowGuardLogMemory();
  const armed = mk("CYC");
  const unarmed = mk("CYCSHADOW");
  const T = Date.now() - 40 * MIN;
  S.setFlowGuard(armed, { params: D, ref: { active_bin: -400, bin_step: 100, at: atIso(T) } }, T);
  // a calm cycle + a calm cycle (peaks, ring), then sustained sell pressure: alert on 1, fire on 3
  const c0 = await cycle([armed, unarmed], T + 9 * MIN, {}, { bin: -400 });
  assert.deepEqual(c0.exits, [null, null]);
  assert.equal(c0.sent.length, 0);
  assert.deepEqual(c0.recorded.map((r) => r.kind).sort(), ["armed", "shadow"], "one stored reading per position per cycle");
  for (const m of [12, 15, 21]) await cycle([armed, unarmed], T + m * MIN, {}, { bin: -400 }); // the shadow's ring is fed from the scan rows: ≥ 15 min needed
  const c1 = await cycle([armed, unarmed], T + 24 * MIN, DUMP);
  assert.equal(c1.exits[0], null);
  assert.equal(c1.sent.length, 1);
  assert.match(c1.sent[0], /Flow guard counting<\/b> — WINSTON-SOL: sell\/buy 2\.50× in 5m .* reading 1\/3/);
  const c2 = await cycle([armed, unarmed], T + 27 * MIN, DUMP);
  assert.equal(c2.sent.length, 0);
  const c3 = await cycle([armed, unarmed], T + 30 * MIN, DUMP);
  assert.equal(c3.exits[0]?.action, "FLOW_GUARD");
  assert.equal(c3.exits[1], null, "an unarmed position never closes");
  assert.match(c3.sent[0], /Flow guard — closing/);
  assert.ok(pos(unarmed).flow_guard_shadow?.first_would_fire_at, "the shadow recorded a would-fire");
  assert.equal(pos(unarmed).flow_guard_shadow.pnl_pct_at_fire, -12);
  assert.equal(pos(unarmed).flow_guard_shadow.amount_sol_at_fire, 1);
  // item 6: kill switch off → not evaluated, no request
  const off = fakeDeps(T + 33 * MIN, { mgmt: { flowGuardMode: "off", flowGuardShadowMode: "off" } });
  const oi = await C.prefetchArmedFlowGuardInputs([rowOf(armed, -420)], off.deps);
  assert.equal(off.requests.length, 0);
  assert.equal(C.checkFlowGuard(rowOf(armed, -420), oi, off.deps), null);
  assert.ok(off.logs.some((l) => /flowGuardMode=off — armed guard not evaluated/.test(l)));
  // item 5: nothing armed and shadow off → zero requests, immediate
  const none = fakeDeps(Date.now(), { mgmt: { flowGuardShadowMode: "off" } });
  const t0 = Date.now();
  await C.prefetchArmedFlowGuardInputs([rowOf(unarmed, -400)], none.deps);
  await C.runFlowGuardShadowDetached([rowOf(unarmed, -400)], none.deps);
  assert.equal(none.requests.length, 0);
  assert.ok(Date.now() - t0 < 50);
  // item 5: a read that never answers is cut at the bound → unusable
  const a2 = mk("CYCHANG");
  S.setFlowGuard(a2, { params: D, ref: { active_bin: -400, bin_step: 100 } });
  const hang = fakeDeps(Date.now(), { boundMs: 80, fetchAsset: () => new Promise(() => {}), readActiveBin: () => new Promise(() => {}) });
  const t1 = Date.now();
  const hi = await C.prefetchArmedFlowGuardInputs([rowOf(a2, -400)], hang.deps);
  assert.ok(Date.now() - t1 < 500, "bounded");
  assert.match(hi.assets.get(WINSTON).reason, /timed out/);
  assert.match(hi.chain.get(a2).reason, /timed out/);
  assert.equal(C.checkFlowGuard(rowOf(a2, -400), hi, hang.deps), null);
  // a failed fetch / a throwing state function closes nothing
  assert.deepEqual((await cycle([a2], Date.now(), DUMP, { fetchThrows: true })).exits, [null]);
  const broken = fakeDeps(Date.now(), { noteFlowGuardReading: () => { throw new Error("db down"); } });
  assert.equal(C.checkFlowGuard(rowOf(a2, -400), { assets: new Map(), chain: new Map() }, broken.deps), null);
  // shadow budget: > 8 distinct mints → skipped, nothing read
  const many = Array.from({ length: 9 }, (_, i) => ({ position: `M${i}`, base_mint: `${"1".repeat(30)}${"ABCDEFGHJ"[i]}${"z".repeat(5)}` }));
  const bud = fakeDeps(Date.now(), { getTrackedPosition: (ad) => ({ base_mint: many.find((x) => x.position === ad)?.base_mint }) });
  assert.equal((await C.runFlowGuardShadowDetached(many, bud.deps)).skipped, "budget");
  assert.equal(bud.requests.length, 0);
}

// ── Experiment grader (item 9: gross vs gross) ──────────────────────────────────────────────
{
  const { gradeExperiment, actionFor, flowGuardDelta } = await import("../scripts/experiments/lib.js");
  const { experimentById } = await import("../scripts/experiments/definitions.js");
  const def = experimentById("flow-guard");
  assert.equal(def.population, "bot_and_operator");
  assert.equal(def.enforceBuilt, false);
  const now = Date.parse("2026-12-20T00:00:00Z");
  const rec = (i, atFire, finalPct, { adopted = false, net = -1 } = {}) => ({
    position: `P${i}`, pool_name: `T${i}-SOL`, recorded_at: new Date(Date.parse("2026-12-01T00:00:00Z") + i * 3600_000).toISOString(),
    adopted: adopted || undefined, amount_sol: 1, pnl_pct: finalPct, pnl_sol_net: net,
    flow_guard_shadow: { first_would_fire_at: "2026-12-01T00:00:00Z", condition: "sell_pressure", pnl_pct_at_fire: atFire, amount_sol_at_fire: 1, count: 1 },
  });
  // gross vs gross: the net figure is ignored (a net loss on a gross gain must not look like a save)
  assert.equal(flowGuardDelta(rec(0, -5, -20, { net: 5 })), -0.15);
  assert.equal(flowGuardDelta(rec(0, -5, 4, { net: -1 })), 0.09);
  const worse = Array.from({ length: 15 }, (_, i) => rec(i, -5, -20, { adopted: i % 2 === 0 }));
  const g1 = gradeExperiment(def, worse, { now, cfg: {} });
  assert.equal(g1.verdict, "met", g1.reason);
  assert.equal(actionFor(g1), "build_enforce", "met → a proposal, never promote");
  const carried = [rec(0, -5, -95), ...Array.from({ length: 14 }, (_, i) => rec(i + 1, -5, i < 10 ? -6 : 10))];
  const g2 = gradeExperiment(def, carried, { now, cfg: {} });
  assert.deepEqual(g2.checks.map((c) => c.pass), [true, true, false]);
  assert.equal(g2.verdict, "not_met");
  assert.equal(gradeExperiment(def, Array.from({ length: 15 }, (_, i) => rec(i, -5, 4)), { now, cfg: {} }).verdict, "not_met");
  assert.equal(gradeExperiment(def, worse.slice(0, 5), { now, cfg: {} }).verdict, "insufficient");
  const late = gradeExperiment(def, worse.slice(0, 5), { now: Date.parse("2027-02-26T00:00:00Z"), cfg: {} });
  assert.match(late.reason, /closed insufficient/);
}

// ── The flow-reading store (json backend → JSONL) ───────────────────────────────────────────
{
  const file = dataPath(FLOW_READINGS_FILE);
  try { fs.unlinkSync(file); } catch { /* none yet */ }
  recordFlowReading({ position: "P1", pool: "POOL", kind: "armed", reading: reading(T0, DUMP), conditions: ["sell_pressure"] });
  recordFlowReading({ position: "P1", pool: "POOL", kind: "armed", reading: { ok: false } });
  await flushFlowReadings();
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].conditions, ["sell_pressure"]);
  assert.deepEqual(Object.keys(lines[0].data).sort(), ["buy_1h", "buy_5m", "holders", "jupiter_updated_at", "liquidity_usd", "num_buys_1h", "num_buys_5m", "num_sells_1h", "num_sells_5m", "num_traders_1h", "num_traders_5m", "price_change_1h", "price_change_5m", "price_usd", "sell_1h", "sell_5m"].sort());
  assert.equal(lines[0].data.sell_5m, 10000);
  assert.equal(flowReadingRow({ position: "P", kind: "shadow", reading: reading(T0) }).data.num_buys_5m, 206);
  assert.doesNotThrow(() => recordFlowReading(null));
}

// ── Display ─────────────────────────────────────────────────────────────────────────────────
{
  assert.equal(F.flowGuardRowSuffix({}), "");
  assert.equal(F.flowGuardRowSuffix({ flow_guard: { armed_at: atIso(T0), params: D } }), " · 🛡 flow guard armed");
  assert.equal(F.flowGuardRowSuffix({ flow_guard: { armed_at: atIso(T0), params: D, streaks: { sell_pressure: { count: 2 } } } }), " · 🛡 flow guard armed (counting 2/3)");
  assert.equal(F.flowGuardRowSuffix({ flow_guard: { armed_at: atIso(T0), params: D, streak_count: 1 } }), " · 🛡 flow guard armed (counting 1/3)");
  assert.deepEqual(F.flowGuardCardFields({}), { flow_guard: null });
  const s = F.flowGuardSummary(run([[0, DUMP], [3, DUMP]])[1].guard);
  assert.equal(s.streak_count, 2);
  assert.deepEqual(s.streaks, { sell_pressure: 2, liquidity_pull: 0, holder_exodus: 0 });
}

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────
{
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  const defs = fs.readFileSync(new URL("../tools/definitions.js", import.meta.url), "utf8");
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8");
  assert.match(idx, /url === "\/command\/set-flow-guard"/);
  assert.match(idx, /const flowGuardExit = flowInputs \? checkFlowGuard\(p, flowInputs, flowGuardDeps\(\)\) : null;/);
  assert.match(idx, /const flowInputs = await prefetchArmedFlowGuardInputs\(positionData, flowGuardDeps\(\)\)/);
  assert.match(idx, /void runFlowGuardShadowDetached\(positionData, flowGuardDeps\(\)\)/, "the shadow is never awaited");
  assert.doesNotMatch(idx, /await runFlowGuardShadowDetached/);
  assert.match(idx, /handsOffActive\(heldNow\) && act\.action !== "STAY" && act\.action !== "CLAIM" && !holdOverride/);
  assert.doesNotMatch(idx, /_smartExodusByMint|gmgnFor/, "no GMGN use");
  assert.doesNotMatch(defs, /flow_guard|flowGuard|set-flow-guard/);
  assert.doesNotMatch(agent, /flow_guard|set_flow_guard/);
  assert.doesNotMatch(exe, /setFlowGuard|set-flow-guard/);
  assert.match(exe, /flowGuardShadowMode: \["management", "flowGuardShadowMode"\]/);
  assert.match(exe, /flowGuardMode: \["management", "flowGuardMode"\]/);
}

console.log("OK — flow guard");
process.exit(0);
