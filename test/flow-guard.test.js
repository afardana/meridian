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
/** Calm counted readings every 3 min from `from` to `to` (minutes), building peaks and the ring. */
const calm = (from, to, over = {}, extra = {}) => { const out = []; for (let t = from; t <= to; t += 3) out.push([t, over, extra]); return out; };
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
  assert.equal(run([[3, { updatedAt: null }]])[0].event, "stale", "no updatedAt");
  const m = run([[3, DUMP], [3.5, DUMP]]);
  assert.equal(m[1].event, "merged", "snapshots < 60 s apart are one reading");
  // reviewer's staleSnapshot: an identical old snapshot re-fetched three times never counts
  const stuck = { ...reading(T0 + 9 * MIN, { liquidity: 45000 }), updated_at: "2026-11-27T11:00:00Z" };
  const ss = run([[3, {}], [6, {}], ...[9, 12, 15].map((t) => [t, null, { reading: { ...stuck, at: atIso(T0 + t * MIN) } }])]);
  assert.deepEqual(ss.slice(2).map((x) => x.event), ["stale", "stale", "stale"]);
  assert.equal(ss.some((x) => x.fire), false);
  // peaks (item 6b): none until three counted readings; a new one needs three in a row ≥ it (the lowest taken)
  const pk = run([[3, { liquidity: 30000 }], [6, { liquidity: 30000 }], [9, { liquidity: 30000 }], [12, { liquidity: 200000 }], [15, { liquidity: 200000 }], [18, { liquidity: 30000 }], [21, { liquidity: 30000 }]]);
  assert.equal(pk[1].guard.peak.liquidity_mkt_usd, null, "two counted readings: no peak, liquidity / holders cannot qualify");
  assert.equal(pk[2].guard.peak.liquidity_mkt_usd, 30000);
  assert.equal(pk[2].guard.peak.liquidity_raw_usd, 30000);
  assert.equal(pk[6].guard.peak.liquidity_mkt_usd, 30000, "two consecutive 200k spikes never became the peak");
  assert.equal(pk.some((x) => x.qualified.includes("liquidity_pull")), false);
  // reviewer's cachedSpike: the arming read (spiked 200k) is served again by the cache to the
  // first cycle → same snapshot → stale; later distinct readings (100k) are the peak; no fire.
  const spike = F.readFlowAsset(payload(0, { liquidity: 200000 }, T0), WINSTON, T0);
  const cs = run([[0.5, null, { reading: { ...spike, at: atIso(T0 + 30 * SEC) } }], ...calm(3, 12, { liquidity: 100000 })],
    { ref: { active_bin: 0, liquidity_usd: 200000, holders: 1000, updated_at: spike.updated_at } });
  assert.equal(cs[0].event, "stale", "the arming snapshot cannot serve as a cycle reading");
  assert.equal(cs[cs.length - 1].guard.peak.liquidity_mkt_usd, 100000);
  assert.equal(cs.some((x) => x.qualified.includes("liquidity_pull") || x.fire), false);
}

// ── Item 1: one condition per streak (reviewer's `mixed` no longer fires) ───────────────────
{
  const mixed = run([...calm(0, 6, { liquidity: 100000, holderCount: 1000 }, { bin: -400 }),
    [9, { liquidity: 100000, holderCount: 940 }, { bin: -420 }], [12, { liquidity: 100000, holderCount: 940 }, { bin: -420 }],
    [15, { liquidity: 49000, holderCount: 1000 }, { bin: -420 }], [18, { liquidity: 49000, holderCount: 1000 }, { bin: -420 }]]);
  assert.equal(mixed.some((x) => x.fire), false);
  assert.deepEqual(mixed[5].reset, ["holder_exodus"], "a reading that does not meet X resets X only");
  assert.equal(mixed[5].guard.streaks.liquidity_pull.count, 1);
  assert.equal(mixed[6].guard.streaks.liquidity_pull.count, 2);
  // the same condition three times does fire (liquidity, corroborated by the ring price −18 %)
  const liq3 = run([...calm(0, 12, { liquidity: 100000 }), [15, { liquidity: 49000 }, { bin: -420 }], [18, { liquidity: 49000 }, { bin: -420 }], [21, { liquidity: 49000 }, { bin: -420 }]]);
  assert.deepEqual(liq3.slice(-3).map((x) => x.fire), [false, false, true]);
  assert.equal(liq3[liq3.length - 1].fired_condition, "liquidity_pull");
  assert.equal(liq3[liq3.length - 1].cross.liquidity_pull.by, "ring_price");
  assert.ok(liq3[liq3.length - 1].guard.confirmed_at, "the firing reading writes the stamp");
  assert.equal(F.advanceFlowGuard(liq3[liq3.length - 1].guard, { reading: { ok: false, reason: "x", at: atIso(T0 + 24 * MIN) } }, T0 + 24 * MIN).guard.confirmed_at, null, "the next reading drops the stamp");
  // an unusable reading inside a streak neither counts nor resets; > 15 min restarts
  const gaps = run([[0, DUMP], [3, null], [4, DUMP], [21, DUMP]]);
  assert.deepEqual(gaps.map((x) => x.event), ["counted", "ignored", "counted", "counted"]);
  assert.equal(gaps[2].guard.streaks.sell_pressure.count, 2);
  assert.equal(gaps[3].guard.streaks.sell_pressure.count, 1, "gap > 15 min: restarted");
  const quick = run([[20, DUMP, { bin: -420 }], [22, DUMP, { bin: -420 }], [24, DUMP, { bin: -420 }]]);
  assert.deepEqual(quick[2].ready, [], "confirm_minutes not reached");
}

// ── Items 3–6: corroboration and the on-chain ring ──────────────────────────────────────────
{
  const e = (min, bin) => ({ at: atIso(T0 + min * MIN), bin });
  // ring base (item 4): continuous entries; 45–75 min window (median), else the oldest of 15–45 min
  assert.equal(F.ringPriceChangePct([e(0, -400), e(10, -405)], 100, T0 + 10 * MIN), null, "under 15 min: unavailable");
  const r20 = [e(0, -400), e(10, -410), e(17, -420), e(20, -420)];
  assert.ok(Math.abs(F.ringPriceChangePct(r20, 100, T0 + 20 * MIN) - (Math.pow(1.01, -20) - 1) * 100) < 1e-9, "the 15–45 min fallback uses the oldest");
  assert.equal(F.ringPriceChangePct([e(0, -400), e(15, -420), e(17, -420), e(20, -420)], 100, T0 + 20 * MIN), null, "a gap over 10 min breaks the history");
  const cont = Array.from({ length: 30 }, (_, i) => e(i * 3, i < 5 ? -300 : -400));
  assert.equal(F.ringPriceChangePct(cont, 100, T0 + 87 * MIN), 0, "the base is 45–75 min old, not the oldest high");
  assert.equal(F.ringPriceChangePct(r20, 100, T0 + 25 * MIN), null, "newest entry older than 2 min: unavailable");
  // restart gap: an hour of history, then a 30-min hole → unavailable until 15 min of continuous ring exist again
  const holed = [...Array.from({ length: 20 }, (_, i) => e(i * 3, -300)), e(90, -400), e(93, -400), e(96, -400)];
  assert.equal(F.ringPriceChangePct(holed, 100, T0 + 96 * MIN), null);
  assert.equal(F.ringPriceChangePct([...holed, e(99, -400), e(102, -400), e(105, -400)], 100, T0 + 105 * MIN), 0, "back after 15 min of continuous ring");
  // item 6a: one bad newest bin cannot corroborate — both of the last two entries must show the drop
  const oneBad = [...Array.from({ length: 8 }, (_, i) => e(i * 3, -400)), e(24, -417)];
  assert.equal(F.ringPriceChangePct(oneBad, 100, T0 + 24 * MIN), 0);
  // one wick in the base window does not become the reference (median)
  const wick = Array.from({ length: 25 }, (_, i) => e(i * 3, i === 4 ? -385 : -400));
  assert.equal(F.ringPriceChangePct(wick, 100, T0 + 72 * MIN), 0);
  assert.equal(F.pushRing(Array.from({ length: 30 }, (_, i) => ({ at: atIso(T0 + i * MIN), bin: i })), chainAt(99, T0 + 31 * MIN), T0).length, 30, "≤ 30 entries");

  // sell pressure: ring ≥ 15 min (continuous) and down ≥ 10 % on the last two entries
  const early = run([[3, DUMP, { bin: -420 }], [6, DUMP, { bin: -420 }], [9, DUMP, { bin: -420 }]]);
  assert.deepEqual(early[2].ready, ["sell_pressure"]);
  assert.equal(early[2].cross.sell_pressure.verdict, "unavailable", "ring under 15 min → fails closed");
  const ok = run([...calm(3, 12), [15, DUMP, { bin: -420 }], [18, DUMP, { bin: -420 }], [21, DUMP, { bin: -420 }]]);
  assert.equal(ok[ok.length - 1].fire, true);
  assert.equal(ok[ok.length - 1].fired_condition, "sell_pressure");
  // chain read failed this cycle → unavailable, no fire; streak kept and fires next cycle
  const noChain = run([...calm(3, 12), [15, DUMP, { bin: -420 }], [18, DUMP, { bin: -420 }], [21, DUMP, { chain: { ok: false, reason: "timeout" } }], [24, DUMP, { bin: -420 }]]);
  assert.equal(noChain[noChain.length - 2].fire, false);
  assert.equal(noChain[noChain.length - 2].cross.sell_pressure.verdict, "unavailable");
  assert.equal(noChain[noChain.length - 1].fire, true);
  // reviewer's flat pool under an old high
  const SELL = { stats5m: { buyVolume: 1000, sellVolume: 3000, priceChange: -3 }, stats1h: { buyVolume: 10000, sellVolume: 20000, priceChange: -16 } };
  const flat = run(calm(3, 90, {}, { bin: -9 }).map(([t, o, x]) => [t, t >= 81 ? SELL : o, x]), { ref: { active_bin: 0 } });
  assert.equal(flat.some((x) => x.fire), false);
  assert.equal(flat[flat.length - 1].cross.sell_pressure.ring_change_pct, 0);

  // liquidity (item 1 of round 3): raw ≤ 70 % of the raw peak AND adjusted ≤ 50 %; pool-TVL corroboration raw ≤ 85 % AND adjusted ≤ 70 %
  const L = (liq, tvl, { own = 0, base = 20000 } = {}) => run([...calm(0, 12, { liquidity: 100000 }, { tvl: base, own: { usd: own, trusted: true } }),
    ...[15, 18, 21].map((t) => [t, { liquidity: liq }, { tvl, own: { usd: own, trusted: true } }])]);
  assert.equal(L(40000, 20000).at(-1).fire, false, "no corroboration (pool TVL steady, price flat)");
  assert.deepEqual(L(40000, 20000).at(-1).ready, ["liquidity_pull"]);
  const lt = L(40000, 13000).at(-1);
  assert.equal(lt.fire, true);
  assert.equal(lt.cross.liquidity_pull.by, "pool_tvl");
  assert.equal(L(40000, 17500).at(-1).fire, false, "pool TVL raw 87.5 % of its peak: not corroborated");
  assert.equal(L(72000, 13000).at(-1).qualified.includes("liquidity_pull"), false, "raw all-venue liquidity above 70 % of its raw peak");
  // reviewer's twoSpikes+ringDrop: two spiked reads, then normal liquidity and an ordinary −15 % hour — no fire
  const ts = run([[3, { liquidity: 200000 }], [6, { liquidity: 200000 }], ...calm(9, 24, { liquidity: 100000 }).map(([t, o]) => [t, o, { bin: t >= 15 ? -417 : -400 }])]);
  assert.equal(ts.some((x) => x.fire), false);

  // holder exodus (item 5): corroborated only by the ring price ≥ 10 % down
  const H = (sb, bin = -400) => run([...calm(0, 12, { holderCount: 1000 }), ...[15, 18, 21].map((t) => [t, { holderCount: 940, stats1h: sb }, { bin }])]);
  const calm1h = { buyVolume: 10000, sellVolume: 10000, priceChange: 0 };
  assert.equal(H(calm1h).at(-1).fire, false);
  assert.deepEqual(H(calm1h).at(-1).ready, ["holder_exodus"]);
  assert.equal(H({ buyVolume: 10000, sellVolume: 13500, priceChange: 0 }).at(-1).fire, false, "1h sell/buy 1.35 is no longer corroboration");
  assert.equal(H(calm1h, -411).at(-1).fire, true, "ring −10.4 % on both last entries");
  // reviewer's holders+sellbuy1.35 with a one-off wick high in the base window
  const hw = run(calm(3, 72).map(([t]) => [t, { holderCount: t >= 66 ? 940 : 1000, stats1h: { buyVolume: 10000, sellVolume: 13500, priceChange: 0 } }, { bin: t === 12 ? -385 : -400 }]));
  assert.equal(hw.some((x) => x.fire), false);
}

// ── Round 3 item 2: snapshots ahead, clock skew, blindness ──────────────────────────────────
{
  // reviewer's futureUpdatedAt: one snapshot dated far ahead is refused and NOT kept; readings count again
  const fut = run([[3, { updatedAt: "2099-01-01T00:00:00Z" }], ...calm(6, 15), [18, DUMP, { bin: -420 }], [21, DUMP, { bin: -420 }], [24, DUMP, { bin: -420 }]]);
  assert.equal(fut[0].event, "stale");
  assert.match(fut[0].reason, /ahead/);
  assert.equal(fut[0].guard.last_counted_updated_at, null);
  assert.equal(fut[1].event, "counted", "the guard does not go dead");
  assert.equal(fut.at(-1).fire, true);
  // a snapshot 50 s ahead (within 60 s) counts
  assert.equal(run([[3, { updatedAt: atIso(T0 + 3 * MIN + 50 * SEC) }]])[0].event, "counted");
  // reviewer's clockSkew+6m: the local clock is 6 min ahead of Jupiter's; the answer's Date header saves it
  const skew = (t, over) => { const ms = T0 + t * MIN; const r = F.readFlowAsset(payload(0, { ...over, updatedAt: atIso(ms - 6 * MIN - 5 * SEC) }, ms), WINSTON, ms, { serverDateMs: ms - 6 * MIN }); return [t, null, { reading: r, bin: t >= 18 ? -420 : -400 }]; };
  const sk = run([...[3, 6, 9, 12, 15].map((t) => skew(t, {})), skew(18, DUMP), skew(21, DUMP), skew(24, DUMP)]);
  assert.deepEqual([...new Set(sk.map((x) => x.event))], ["counted"]);
  assert.equal(sk.at(-1).fire, true);
  const noHdr = (t) => { const ms = T0 + t * MIN; return [t, null, { reading: F.readFlowAsset(payload(0, { updatedAt: atIso(ms - 6 * MIN) }, ms), WINSTON, ms) }]; };
  assert.equal(run([noHdr(3)])[0].event, "stale", "without a Date header the local clock is the reference");
  // blindness: no counted reading for 30 min
  const bl = run([[3, {}], [6, null], [20, null], [33, null], [36, {}]]);
  assert.equal(bl[2].guard.blind_since, null);
  assert.equal(bl[3].guard.blind_since, atIso(T0 + 3 * MIN));
  assert.equal(bl[4].guard.blind_since, null, "a counted reading clears it");
  assert.equal(F.flowGuardSummary(bl[3].guard).blind_since, atIso(T0 + 3 * MIN));
}

// ── Item 7 + round 3 item 1: own liquidity; a top-up / withdrawal is not a market move ───────
{
  // Withdrawal: the position held $50k of $100k all-venue liquidity and is withdrawn; Jupiter
  // halves, the market figure stays $50k → nothing qualifies.
  const wd = run([...calm(0, 6, { liquidity: 100000 }, { own: { usd: 50000, trusted: true } }),
    ...calm(9, 18, { liquidity: 50000 }, { own: { usd: 0, trusted: true }, bin: -420 })]);
  assert.equal(wd[3].figures.liquidity_mkt_usd, null, "the reading where the own value jumped is not used");
  assert.equal(wd.some((x) => x.qualified.includes("liquidity_pull") || x.fire), false);
  // reviewer's ownTopupLag15m: own $500 → $10,500 while Jupiter / Meteora lag 15 min → no fire
  const tu = run(calm(3, 30).map(([t]) => [t, { liquidity: t >= 24 ? 30000 : 20000 }, { own: { usd: t >= 9 ? 10500 : 500, trusted: true }, tvl: t >= 24 ? 25000 : 15000 }]));
  assert.equal(tu.some((x) => x.fire), false);
  assert.equal(tu.some((x) => x.qualified.includes("liquidity_pull")), false);
  const susp = tu.find((x) => x.suspended_now);
  assert.ok(susp, "the top-up suspends the liquidity condition");
  assert.equal(susp.guard.liquidity_suspended_until, atIso(T0 + 9 * MIN + 30 * MIN));
  // during the suspension the liquidity condition is not evaluated even when both figures drop
  const s2 = run([...calm(0, 6, { liquidity: 100000 }, { own: { usd: 1000, trusted: true } }), [9, { liquidity: 100000 }, { own: { usd: 1300, trusted: true } }],
    ...calm(12, 30, { liquidity: 30000 }, { own: { usd: 1300, trusted: true }, bin: -420 })]);
  assert.equal(s2[3].suspended_now, true);
  assert.equal(s2.filter((x) => x.counted && Date.parse(x.guard.last_counted_at) < T0 + 39 * MIN).some((x) => x.evaluable.includes("liquidity_pull")), false);
  assert.equal(run([[0, {}, { own: { usd: 1000, trusted: false } }]])[0].figures.liquidity_mkt_usd, null, "untrusted own value");
  assert.deepEqual(C.ownValueOf({ total_value_true_usd: 1200 }, {}), { usd: 1200, trusted: true });
  assert.equal(C.ownValueOf({ total_value_true_usd: 1200, pnl_quality: "extreme_divergence" }, {}).trusted, false);
  assert.equal(C.ownValueOf({ total_value_true_usd: 1200 }, { pending_flow: { x: 1 } }).trusted, false);
  assert.equal(C.ownValueOf({ total_value_true_usd: 1200 }, { capital_rebase_pending: { x: 1 } }).trusted, false);
  assert.equal(C.ownValueOf({}, {}).trusted, false);
}

// ── Collapse scenarios through the final logic (collapse starts at 60 min; cycles 1, 4, …) ──
const collapse = (kind) => {
  const steps = [];
  for (let m = 1; m <= 100; m += 3) {
    const dt = m - 60;
    let bin = 0, liq = 100000, tvl = 20000, h = 1000;
    const over = {};
    if (kind === "dump" && dt >= 0) {
      const pc = -Math.min(40, 4 * dt);
      bin = Math.round(Math.log(1 + pc / 100) / Math.log(1.01));
      over.stats5m = { buyVolume: 1000, sellVolume: 6000, priceChange: pc / 2 };
      over.stats1h = { buyVolume: 10000 + 500 * dt, sellVolume: 10000 + 3000 * dt, priceChange: pc };
    }
    if (kind === "pull" && dt >= 0) { liq = 40000; tvl = 8000; }
    if (kind === "pull_elsewhere" && dt >= 0) liq = 40000;
    if (kind === "holders" && dt >= 0) { h = 920; bin = -13; } // −8 % holders, price −12 %
    steps.push([m, { ...over, liquidity: liq, holderCount: h }, { bin, tvl, own: { usd: 500, trusted: true } }]);
  }
  const res = run(steps, { ref: { active_bin: 0, at: atIso(T0) } });
  const i = res.findIndex((x) => x.fire);
  return i < 0 ? null : steps[i][0];
};
{
  assert.equal(collapse("dump"), 70, "−40 % in 10 min with heavy sells: fires 10 min after the start");
  assert.equal(collapse("pull"), 67, "LPs pull 60 % incl. this pool: 7 min");
  assert.equal(collapse("pull_elsewhere"), null, "LPs leaving another venue with this pool flat: no fire");
  assert.equal(collapse("holders"), 67, "holders −8 % with price −12 %: 7 min");
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
  const ok = run([[3, {}], [6, {}], [9, {}], [12, {}], [15, DUMP, { bin: -420 }], [18, DUMP, { bin: -420 }], [21, DUMP, { bin: -420 }]])[6];
  const exit = F.buildFlowGuardExit({ condition: ok.fired_condition, figures: ok.figures, params: D, peak: ok.guard.peak, corroboration: ok.cross.sell_pressure, readings: 3, spanMin: 6 });
  assert.deepEqual([exit.action, exit.rule, exit.family, exit.urgent, exit.hold_override], ["FLOW_GUARD", "flow_guard", "flow_guard", true, "flow_guard"]);
  assert.match(exit.reason, /^Flow guard: sell\/buy 2\.50× in 5m \(≥ 2\) and 1\.60× in 1h \(≥ 1\.3\), price 1h -20\.0% \(≤ −15%\), pool price -18\.\d% on chain over the last hour on 3 readings over 6m — operator-armed stop$/);
  for (const c of F.FLOW_CONDITIONS) {
    for (const corr of [null, { by: "pool_tvl", pool_tvl_mkt_usd: 1, pool_tvl_peak_usd: 2 }, { by: "ring_price", ring_change_pct: -20 }]) {
      const r = F.flowGuardReason({ condition: c, figures: { liquidity_mkt_usd: 9000, liquidity_raw_usd: 9500, holders: 1600, sell_buy_5m: Infinity, sell_buy_1h: 2, price_change_1h_pct: -30 }, params: D, peak: { liquidity_mkt_usd: 30000, liquidity_raw_usd: 30500, holders: 1800 }, corroboration: corr, readings: 3, spanMin: 6 }).toLowerCase();
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
  for (const back of [27, 24, 21, 18, 15, 12, 9]) {
    const ms = endMs - back * MIN;
    S.noteFlowGuardReading(a, { reading: reading(ms, {}), chain: chainAt(-400, ms), own: OWN0 }, ms);
  }
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

// ── Round 3 item 3: the kill switch is operator-only (endpoint { mode }, persisted file-first) ──
{
  assert.deepEqual(F.parseFlowGuardModeBody({ mode: "off" }), { ok: true, mode: "off" });
  assert.deepEqual(F.parseFlowGuardModeBody({ mode: "armed" }), { ok: true, mode: "armed" });
  for (const bad of [{ mode: "ON" }, { mode: "off", position: "x" }, {}, null, { mode: true }]) assert.equal(F.parseFlowGuardModeBody(bad).ok, false, JSON.stringify(bad));
  const { applyFlowGuardMode } = await import("../flow-guard-config.js");
  const file = dataPath("fg-test-user-config.json");
  fs.writeFileSync(file, JSON.stringify({ keep: 1 }));
  assert.equal(applyFlowGuardMode("off", { userConfigPath: file }).persisted, true);
  assert.equal(CONFIG.management.flowGuardMode, "off");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { keep: 1, flowGuardMode: "off" });
  assert.equal(applyFlowGuardMode("armed", { userConfigPath: file }).persisted, true);
  assert.equal(CONFIG.management.flowGuardMode, "armed");
  // write failure: "armed" is not applied; "off" applies in memory and latches against reloads
  const bad = dataPath("no-such-dir", "user-config.json");
  const r1 = applyFlowGuardMode("armed", { userConfigPath: bad });
  assert.deepEqual([r1.persisted, r1.inMemory], [false, false]);
  const r2 = applyFlowGuardMode("off", { userConfigPath: bad });
  assert.deepEqual([r2.persisted, r2.inMemory], [false, true]);
  assert.equal(CONFIG.management.flowGuardMode, "off");
  assert.equal(F.flowGuardOffLatched(), true);
  assert.equal(applyFlowGuardMode("armed", { userConfigPath: file }).persisted, true);
  assert.equal(F.flowGuardOffLatched(), false, "a successful write clears the latch");
  const cfgSrc = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfgSrc, /fresh\.flowGuardMode !== undefined && !\(flowGuardOffLatched\(\) && fresh\.flowGuardMode !== "off"\)/, "a reload of a stale file cannot re-arm while latched");
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /parseFlowGuardModeBody\(body\)/);
  assert.match(idx, /facts: FLOW_GUARD_ARMING_FACTS/);
  assert.equal(F.FLOW_GUARD_ARMING_FACTS.length, 5);
  assert.ok(F.FLOW_GUARD_ARMING_FACTS.some((f) => /first 15 minutes/.test(f)) && F.FLOW_GUARD_ARMING_FACTS.some((f) => /blind/.test(f)));
}

// ── Round 3 item 2c: blind alert once, at most hourly, recovery once (cycle module) ─────────
{
  C.resetFlowGuardLogMemory();
  const b = mk("BLIND");
  const T = Date.now() - 120 * MIN;
  S.setFlowGuard(b, { params: D, ref: { active_bin: -400, bin_step: 100, at: atIso(T) } }, T);
  const sent = [];
  const at = (m, rd) => {
    const ms = T + m * MIN;
    const fd = fakeDeps(ms, { sendHTML: (h) => sent.push(h) });
    return C.checkFlowGuard(rowOf(b, -400), { assets: new Map([[WINSTON, rd(ms)]]), chain: new Map([[b, chainAt(-400, ms)]]) }, fd.deps);
  };
  const dead = (ms) => ({ ok: false, reason: "Jupiter datapi HTTP 503", at: atIso(ms) });
  const good = (ms) => reading(ms, {});
  at(3, good);
  for (const m of [6, 15, 30, 33]) at(m, dead);
  assert.equal(sent.filter((h) => /Flow guard blind/.test(h)).length, 1, "one blind alert at 30 min");
  assert.match(sent.find((h) => /Flow guard blind/.test(h)), /no usable reading for 30 min \(Jupiter datapi HTTP 503\)/);
  for (const m of [36, 60, 92, 95]) at(m, dead); // 33 → 95: one repeat after ≥ 60 min
  assert.equal(sent.filter((h) => /Flow guard blind/.test(h)).length, 2, "repeated at most hourly");
  at(98, good);
  assert.equal(sent.filter((h) => /reading again/.test(h)).length, 1);
  at(101, good);
  assert.equal(sent.filter((h) => /reading again/.test(h)).length, 1, "recovery once");
  assert.equal(F.flowGuardSummary(pos(b).flow_guard).blind_since, null);
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
  assert.doesNotMatch(exe, /flowGuardMode/, "the kill switch is operator-only: not an update_config key");
  assert.doesNotMatch(defs, /flowGuardMode/);
}

console.log("OK — flow guard");
process.exit(0);
