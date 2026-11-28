process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// Distress gate on the TVL exit (tvl-floor-distress.js, 2026-11-28, operator: "make the thin TVL
// exit depend on other factors too, so the latest one, the WLFI, would not have happened").
// The TVL proof may close only when the pool also shows distress — PnL ≤ −10 % (no usable PnL:
// price since entry ≤ −30 %) OR 1h volume ≥ 2× pool TVL with the price ≥ 5 % under entry — on
// N readings over M minutes of its own. The gate can only REMOVE closes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const D = await import("../tvl-floor-distress.js");
const {
  tvlFloorDistressConfig, isValidTvlDistressValue, readPoolVolumeUsd, priceChangeSinceEntryPct, hourlyTurnover,
  distressPnlFromReading, distressRefBin, evaluateTvlFloorDistress, advanceTvlFloorDistress, tvlFloorDistressGate,
  distressEvidenceText, distressHeldBackText, distressHeldBackAlertText, TVL_DISTRESS_DEFAULTS,
} = D;
const F = await import("../tvl-floor-exit.js");
const { tvlFloorExitConfig, advanceTvlFloorStreak, crossCheckTvlFloor, buildTvlFloorExit } = F;
const { holdOverrideActive } = await import("../hold-override.js");
const { holdThinLimitReading } = await import("../hold-thin-limit.js");
const { sanitizeTelegramHTML } = await import("../telegram.js");

const MIN = 60_000;
const TVL_CFG = tvlFloorExitConfig({});
const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/tvl-floor-distress-cases.json", import.meta.url), "utf8"));

// ── Config ─────────────────────────────────────────────────────────────────────────────
test("config: defaults, mode parse, invalid values fall back to the default with one warning", () => {
  assert.deepEqual(tvlFloorDistressConfig({}), { mode: "enforce", lossPct: -10, priceDropPct: -30, dumpTurnover: 2, dumpPricePct: -5 });
  for (const m of ["off", "shadow", "enforce"]) assert.equal(tvlFloorDistressConfig({ tvlFloorExitDistressMode: m }).mode, m);
  for (const m of ["bogus", "ENFORCE", "", " off", 0, true]) assert.equal(tvlFloorDistressConfig({ tvlFloorExitDistressMode: m }).mode, "enforce", String(m));
  const warns = [];
  const w = (msg) => warns.push(msg);
  const bad = { tvlFloorExitLossPct: 5, tvlFloorExitPriceDropPct: "x", tvlFloorExitDumpTurnover: 0, tvlFloorExitDumpPricePct: 3 };
  assert.deepEqual(tvlFloorDistressConfig(bad, { warn: w }), { mode: "enforce", ...TVL_DISTRESS_DEFAULTS });
  assert.equal(warns.length, 4);
  tvlFloorDistressConfig(bad, { warn: w }); // same values again: no second warning
  assert.equal(warns.length, 4);
  assert.match(warns[0], /\[TVL_FLOOR_EXIT\] tvlFloorExitLossPct 5 is invalid .* using the default -10/);
  // valid values (numeric strings too) and the bounds (review 2026-11-28: floors that keep each
  // setting on the side of a real loss / dump): loss −95 … −1, price drop −99 … −5, turnover
  // 0.25 … 100, dump price −99 … −1
  assert.deepEqual(tvlFloorDistressConfig({ tvlFloorExitLossPct: "-12", tvlFloorExitPriceDropPct: -99, tvlFloorExitDumpTurnover: 100, tvlFloorExitDumpPricePct: -1 }),
    { mode: "enforce", lossPct: -12, priceDropPct: -99, dumpTurnover: 100, dumpPricePct: -1 });
  assert.deepEqual(tvlFloorDistressConfig({ tvlFloorExitLossPct: -1, tvlFloorExitPriceDropPct: -5, tvlFloorExitDumpTurnover: 0.25, tvlFloorExitDumpPricePct: -99 }),
    { mode: "enforce", lossPct: -1, priceDropPct: -5, dumpTurnover: 0.25, dumpPricePct: -99 });
  for (const [k, v, ok] of [
    ["tvlFloorExitLossPct", -95, true], ["tvlFloorExitLossPct", -1, true], ["tvlFloorExitLossPct", -96, false], ["tvlFloorExitLossPct", -0.5, false], ["tvlFloorExitLossPct", 0, false], ["tvlFloorExitLossPct", null, false],
    ["tvlFloorExitPriceDropPct", -5, true], ["tvlFloorExitPriceDropPct", -99, true], ["tvlFloorExitPriceDropPct", -4.9, false], ["tvlFloorExitPriceDropPct", -100, false],
    ["tvlFloorExitDumpTurnover", 0.25, true], ["tvlFloorExitDumpTurnover", 0.24, false], ["tvlFloorExitDumpTurnover", 101, false], ["tvlFloorExitDumpTurnover", NaN, false],
    ["tvlFloorExitDumpPricePct", -1, true], ["tvlFloorExitDumpPricePct", -0.9, false], ["tvlFloorExitDumpPricePct", 0, false], ["tvlFloorExitDumpPricePct", -100, false],
    ["tvlFloorExitDistressMode", "shadow", true], ["tvlFloorExitDistressMode", "bogus", false]]) {
    assert.equal(isValidTvlDistressValue(k, v), ok, `${k}=${v}`);
  }
  // out of range at load → the default, one warning
  const w2 = [];
  assert.equal(tvlFloorDistressConfig({ tvlFloorExitDumpTurnover: 0.1 }, { warn: (m) => w2.push(m) }).dumpTurnover, 2);
  assert.equal(tvlFloorDistressConfig({ tvlFloorExitDumpPricePct: 0 }, { warn: (m) => w2.push(m) }).dumpPricePct, -5);
  assert.equal(w2.length, 2);
});

test("config.js: load defaults, hot reload with the same reader, update_config validation", async () => {
  const { config, reloadScreeningThresholds } = await import("../config.js");
  assert.equal(config.management.tvlFloorExitDistressMode, "enforce");
  assert.equal(config.management.tvlFloorExitLossPct, -10);
  assert.equal(config.management.tvlFloorExitPriceDropPct, -30);
  assert.equal(config.management.tvlFloorExitDumpTurnover, 2);
  assert.equal(config.management.tvlFloorExitDumpPricePct, -5);
  const saved = { ...config.management };
  reloadScreeningThresholds({ tvlFloorExitDistressMode: "shadow", tvlFloorExitLossPct: 7 });
  assert.equal(config.management.tvlFloorExitDistressMode, "shadow");
  assert.equal(config.management.tvlFloorExitLossPct, -10); // invalid → default (not the stored 7)
  reloadScreeningThresholds({ tvlFloorExitDistressMode: "nonsense" });
  assert.equal(config.management.tvlFloorExitDistressMode, "enforce");
  Object.assign(config.management, saved);
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  for (const k of ["tvlFloorExitDistressMode", "tvlFloorExitLossPct", "tvlFloorExitPriceDropPct", "tvlFloorExitDumpTurnover", "tvlFloorExitDumpPricePct"]) {
    assert.match(exe, new RegExp(`${k}: \\["management", "${k}"\\]`));
  }
});

// ── Legs ───────────────────────────────────────────────────────────────────────────────
test("price since entry, hourly turnover, volume reading", () => {
  assert.ok(Math.abs(priceChangeSinceEntryPct(-602, -557, 100) - ((1.01 ** -45 - 1) * 100)) < 1e-9);
  assert.equal(priceChangeSinceEntryPct(-557, -557, 100), 0);
  for (const bad of [[null, 1, 100], [1, null, 100], [1, 1, 0], [1, 1, null], [NaN, 1, 100], ["1", 1, 100]]) assert.equal(priceChangeSinceEntryPct(...bad), null);
  assert.equal(hourlyTurnover(46376, 8218, 60).toFixed(3), (46376 / 8218).toFixed(3));
  assert.equal(hourlyTurnover(1000, 1000, 5), 12);      // 5-minute window → ×12
  assert.equal(hourlyTurnover(1000, 1000, 1440), 1000 / 1000 / 24);
  for (const bad of [[null, 1, 60], [1, 0, 60], [1, 1, null], [-1, 1, 60], [1, -5, 60]]) assert.equal(hourlyTurnover(...bad), null);
  assert.equal(readPoolVolumeUsd({ pool_address: "P", volume: 6406.2 }, "P"), 6406.2);
  assert.equal(readPoolVolumeUsd({ pool_address: "P", volume: 0 }, "P"), 0);
  for (const bad of [null, {}, { pool_address: "Q", volume: 5 }, { pool_address: "P", volume: "5" }, { pool_address: "P", volume: NaN }, { pool_address: "P", volume: -1 }]) {
    assert.equal(readPoolVolumeUsd(bad, "P"), null);
  }
});

test("legs and verdicts: loss, price fallback, dump, unknown", () => {
  const base = { activeBin: -564, entryBin: -557, binStep: 100, volumeUsd: 6406, tvlUsd: 8936, timeframeMinutes: 60 };
  // WLFI DUGfTjPR 10:12 UTC: +1.78 %, turnover 0.72, price −6.7 % → calm
  let v = evaluateTvlFloorDistress({ ...base, pnlPct: 1.78 });
  assert.deepEqual([v.verdict, v.loss, v.dump, v.legs], ["calm", false, false, []]);
  // loss leg
  v = evaluateTvlFloorDistress({ ...base, pnlPct: -10 });
  assert.deepEqual([v.verdict, v.legs], ["distress", ["loss"]]);
  assert.equal(evaluateTvlFloorDistress({ ...base, pnlPct: -9.99 }).verdict, "calm");
  // no usable PnL: the price decides the loss leg
  v = evaluateTvlFloorDistress({ ...base, pnlPct: null, activeBin: -600 });
  assert.equal(v.loss_by_price, true);
  assert.deepEqual([v.verdict, v.legs], ["distress", ["loss"]]); // −34.9 % ≤ −30 %
  v = evaluateTvlFloorDistress({ ...base, pnlPct: null }); // −6.7 %: loss false by price, dump false
  assert.deepEqual([v.verdict, v.loss, v.loss_by_price], ["calm", false, true]);
  // no PnL and no price → loss unknown; dump unknown too → unknown
  v = evaluateTvlFloorDistress({ ...base, pnlPct: null, activeBin: null });
  assert.deepEqual([v.verdict, v.loss, v.dump], ["unknown", null, null]);
  // dump leg: PVE 00:39 — turnover 5.64, price −36 % (also the price fallback, but PnL −5.7 is usable)
  v = evaluateTvlFloorDistress({ pnlPct: -5.73, activeBin: -602, entryBin: -557, binStep: 100, volumeUsd: 46376, tvlUsd: 8218, timeframeMinutes: 60 });
  assert.deepEqual([v.verdict, v.legs, v.loss], ["distress", ["dump"], false]);
  // heavy volume but the price near entry: not a dump
  assert.equal(evaluateTvlFloorDistress({ ...base, pnlPct: 6.06, activeBin: -559, volumeUsd: 36787, tvlUsd: 9247 }).verdict, "calm"); // JIMMY 9wTNkyoB
  // missing volume: dump unknown; with the loss leg false → unknown (neither counts nor resets)
  assert.equal(evaluateTvlFloorDistress({ ...base, pnlPct: 1, volumeUsd: null }).verdict, "unknown");
  // missing volume but a loss: distress
  assert.equal(evaluateTvlFloorDistress({ ...base, pnlPct: -20, volumeUsd: null }).verdict, "distress");
  // timeframe scaling: a 5-minute window of 1,200 on $10k is 1.44×/h
  assert.equal(evaluateTvlFloorDistress({ ...base, pnlPct: 0, activeBin: -570, volumeUsd: 1200, tvlUsd: 10000, timeframeMinutes: 5 }).dump, false);
  assert.equal(evaluateTvlFloorDistress({ ...base, pnlPct: 0, activeBin: -570, volumeUsd: 1700, tvlUsd: 10000, timeframeMinutes: 5 }).dump, true);
  // thresholds are configurable
  assert.equal(evaluateTvlFloorDistress({ ...base, pnlPct: -8 }, { lossPct: -8 }).verdict, "distress");
  // a pool positively known not to be SOL-quoted: the price is unknown, only the PnL leg can fire
  v = evaluateTvlFloorDistress({ ...base, pnlPct: 1, activeBin: -700, volumeUsd: 90000, priceUnavailable: "pool is not SOL-quoted" });
  assert.deepEqual([v.verdict, v.price_pct, v.loss, v.dump], ["unknown", null, false, null]);
  assert.ok(v.unknown.some((u) => /price since entry \(pool is not SOL-quoted\)/.test(u)), v.unknown.join());
  assert.equal(evaluateTvlFloorDistress({ ...base, pnlPct: null, activeBin: -700, priceUnavailable: "pool is not SOL-quoted" }).verdict, "unknown"); // no price fallback
  assert.equal(evaluateTvlFloorDistress({ ...base, pnlPct: -12, priceUnavailable: "pool is not SOL-quoted" }).verdict, "distress");
  // unknown inputs are named
  v = evaluateTvlFloorDistress({ ...base, pnlPct: null, pnlReason: "valuation not management-ready", activeBin: null, volumeUsd: null });
  assert.deepEqual(v.unknown, ["PnL (valuation not management-ready)", "price since entry (no active bin)", "1h volume (not in the pool row)"]);
  // first-seen reference: the price is "since the first reading under the minimum"
  v = evaluateTvlFloorDistress({ ...base, pnlPct: 1, refSource: "first_seen" });
  assert.equal(v.price_ref, "first_seen");
});

test("PnL usability and the reference bin", () => {
  const row = { pnl_pct: -12.3, active_bin: -560 };
  assert.equal(distressPnlFromReading(holdThinLimitReading(row, {}, {}), {}).pnl_pct, -12.3);
  for (const bad of [{ ...row, pnl_management_ready: false }, { ...row, pnl_pct_suspicious: true }, { ...row, flow_pending: true }, { ...row, pnl_basis: "usd" }, { ...row, pnl_pct: NaN }]) {
    assert.equal(distressPnlFromReading(holdThinLimitReading(bad, {}, {}), {}).pnl_pct, null, JSON.stringify(bad));
  }
  assert.equal(distressPnlFromReading(holdThinLimitReading(row, { pending_flow: {} }, {}), { pending_flow: {} }).pnl_pct, null);
  assert.equal(distressPnlFromReading(holdThinLimitReading(row, {}, {}), { capital_rebase_pending: { from_sol: 1 } }).pnl_pct, null);
  assert.equal(distressPnlFromReading(null).pnl_pct, null);
  // after a partial withdrawal the loss leg reads the thin-pool hold limit's figure:
  // max(plain, cost-basis) — JIMMY-SOL CV7AUcQh 2026-11-25: ◎2.0408 of ◎3.0276 withdrawn, loss ≈ ◎0.2694
  // unchanged → plain −27.30 %, on the cost of what is left (◎0.7875) ≈ −8.9 % → loss leg false
  {
    const tracked = { amount_sol: 0.9868, avg_cost_basis: { basis_sol: 0.7875, changes: 1, at: "2026-11-25T15:17:38Z" } };
    const jimmy = { pnl_pct: -27.3, pnl_sol_rule: -0.2694, active_bin: -380 };
    for (const held of [true, false]) {
      const t = { ...tracked, hold_mode: held };
      const r = distressPnlFromReading(holdThinLimitReading(jimmy, t, {}), t);
      assert.equal(r.raw_pnl_pct, -27.3);
      assert.ok(Math.abs(r.pnl_pct - -8.9) < 0.1, `cost-basis figure ${r.pnl_pct}`);
      assert.equal(r.adjusted, true);
      const v = evaluateTvlFloorDistress({ pnlPct: r.pnl_pct, rawPnlPct: r.raw_pnl_pct, activeBin: -380, entryBin: -380, binStep: 100, volumeUsd: 100, tvlUsd: 9000, timeframeMinutes: 60 });
      assert.deepEqual([v.loss, v.verdict], [false, "calm"]);
    }
    // the key off, or no SOL figure on the row → the plain percent (today's behaviour)
    assert.equal(distressPnlFromReading(holdThinLimitReading(jimmy, tracked, { holdThinPoolAvgCostBasis: false }), tracked).pnl_pct, -27.3);
    assert.equal(distressPnlFromReading(holdThinLimitReading({ pnl_pct: -27.3 }, tracked, {}), tracked).pnl_pct, -27.3);
    // never lower than the plain percent
    assert.equal(distressPnlFromReading({ ok: true, raw_pnl_pct: -5, pnl_pct: -9 }, {}).pnl_pct, -5);
  }
  // reference bin: entry → stored first_seen → this reading (to be stored)
  assert.deepEqual(distressRefBin({ active_bin_at_deploy: -557 }, -600), { bin: -557, source: "entry", store: false });
  assert.deepEqual(distressRefBin({ active_bin_at_deploy: null, tvl_floor_distress: { ref_bin: -580 } }, -600), { bin: -580, source: "first_seen", store: false });
  assert.deepEqual(distressRefBin({}, -600), { bin: -600, source: "first_seen", store: true });
  assert.deepEqual(distressRefBin({}, null), { bin: null, source: null, store: false });
});

// ── Streak + gate ──────────────────────────────────────────────────────────────────────
const V = (verdict, extra = {}) => ({ verdict, legs: verdict === "distress" ? ["loss"] : [], pnl_pct: -12, ...extra });
test("distress streak: counts, merges < 60 s, calm resets, unknown keeps, a new TVL streak starts over", () => {
  const T0 = Date.parse("2026-11-28T10:00:00Z");
  let s = advanceTvlFloorDistress(null, V("distress"), "started", T0);
  assert.equal(s.count, 1);
  s = advanceTvlFloorDistress(s, V("distress"), "merged", T0 + 30_000);   // 30 s later: one reading
  assert.equal(s.count, 1);
  s = advanceTvlFloorDistress(s, V("unknown"), "counted", T0 + 3 * MIN);  // unknown: neither counts nor resets
  assert.deepEqual([s.count, s.last.verdict], [1, "unknown"]);
  assert.equal(tvlFloorDistressGate(s, TVL_CFG, T0 + 3 * MIN).ok, false);
  s = advanceTvlFloorDistress(s, V("distress"), "counted", T0 + 4 * MIN);
  s = advanceTvlFloorDistress(s, V("distress"), "counted", T0 + 5 * MIN);
  assert.equal(s.count, 3);
  let g = tvlFloorDistressGate(s, TVL_CFG, T0 + 5 * MIN);
  assert.deepEqual([g.ok, g.count, g.span_min], [true, 3, 5]);
  // the gate needs the CURRENT reading to be distress (a stale state does not count)
  assert.equal(tvlFloorDistressGate(s, TVL_CFG, T0 + 8 * MIN).ok, false);
  // its own N over M: 3 readings in 4 minutes is not enough
  let q = advanceTvlFloorDistress(null, V("distress"), "started", T0);
  q = advanceTvlFloorDistress(q, V("distress"), "counted", T0 + 2 * MIN);
  q = advanceTvlFloorDistress(q, V("distress"), "counted", T0 + 4 * MIN);
  assert.equal(tvlFloorDistressGate(q, TVL_CFG, T0 + 4 * MIN).ok, false);
  // a calm reading resets
  s = advanceTvlFloorDistress(s, V("calm"), "counted", T0 + 8 * MIN);
  assert.equal(s.count, 0);
  assert.equal(tvlFloorDistressGate(s, TVL_CFG, T0 + 8 * MIN).ok, false);
  // a restarted TVL streak drops the distress streak
  s = advanceTvlFloorDistress({ count: 5, first_at: new Date(T0).toISOString(), last_at: new Date(T0 + 6 * MIN).toISOString() }, V("distress"), "restarted", T0 + 60 * MIN);
  assert.equal(s.count, 1);
  // ignored / reset events do not touch it
  const keep = { count: 2, first_at: "x", last_at: "y" };
  assert.equal(advanceTvlFloorDistress(keep, V("distress"), "ignored", T0), keep);
  // a corrupt stored streak is no streak: one distress reading can never satisfy the gate
  const iso = (ms) => new Date(ms).toISOString();
  const bads = [
    { count: 1e9, first_at: iso(T0 - 60 * MIN), last_at: iso(T0 - 3 * MIN) },          // larger than the TVL streak
    { count: 2.5, first_at: iso(T0 - 60 * MIN), last_at: iso(T0 - 3 * MIN) },
    { count: -4, first_at: iso(T0 - 60 * MIN), last_at: iso(T0 - 3 * MIN) },
    { count: Infinity, first_at: iso(T0 - 60 * MIN), last_at: iso(T0 - 3 * MIN) },
    { count: "5", first_at: iso(T0 - 60 * MIN), last_at: iso(T0 - 3 * MIN) },
    { count: 5, first_at: "garbage", last_at: iso(T0 - 3 * MIN) },
    { count: 5, last_at: iso(T0 - 3 * MIN) },
    { count: 5, first_at: iso(T0 - 3 * MIN), last_at: iso(T0 - 60 * MIN) },             // out of order
    "nonsense", 42, [],
  ];
  for (const bad of bads) {
    const n = advanceTvlFloorDistress(bad, V("distress"), "counted", T0, 5);
    assert.equal(n.count, 1, JSON.stringify(bad));
    assert.equal(tvlFloorDistressGate(n, TVL_CFG, T0, 5).ok, false, JSON.stringify(bad));
    // and the gate itself refuses a corrupt state that claims the current reading
    if (bad && typeof bad === "object" && !Array.isArray(bad)) {
      assert.equal(tvlFloorDistressGate({ ...bad, last: { at: iso(T0), verdict: "distress", legs: ["loss"] } }, TVL_CFG, T0, 5).ok, false, JSON.stringify(bad));
    }
  }
  // a valid streak bounded by the TVL count passes
  assert.equal(tvlFloorDistressGate({ count: 3, first_at: iso(T0 - 6 * MIN), last_at: iso(T0), last: { at: iso(T0), verdict: "distress", legs: ["dump"] } }, TVL_CFG, T0, 3).ok, true);
  assert.equal(tvlFloorDistressGate({ count: 3, first_at: iso(T0 - 6 * MIN), last_at: iso(T0), last: { at: iso(T0), verdict: "distress", legs: [] } }, TVL_CFG, T0, 3).ok, false); // a distress verdict must name a leg
  // a gap > 30 min between distress readings starts over
  s = advanceTvlFloorDistress({ count: 2, first_at: new Date(T0).toISOString(), last_at: new Date(T0 + 3 * MIN).toISOString() }, V("distress"), "counted", T0 + 40 * MIN);
  assert.equal(s.count, 1);
});

test("texts: evidence, held-back line, Telegram alert, close reason wording", () => {
  const cur = { verdict: "distress", legs: ["dump"], pnl_pct: -5.73, price_pct: -36.13, turnover: 5.64 };
  assert.equal(distressEvidenceText(cur), "with heavy selling (1h turnover 5.6× pool TVL, price 36% under entry)");
  assert.equal(distressEvidenceText({ ...cur, legs: ["loss"], pnl_pct: -12.3 }), "with the position at -12.3% (limit -10%)");
  assert.equal(distressEvidenceText({ ...cur, legs: ["dump", "loss"], pnl_pct: -12.3 }), "with heavy selling (1h turnover 5.6× pool TVL, price 36% under entry) and the position at -12.3% (limit -10%)");
  // no entry bin: "since the first reading under the minimum", never "entry"
  assert.equal(distressEvidenceText({ ...cur, price_ref: "first_seen" }), "with heavy selling (1h turnover 5.6× pool TVL, price 36% down since the first reading under the minimum)");
  assert.equal(distressEvidenceText({ legs: ["loss"], loss_by_price: true, pnl_pct: null, price_pct: -40.2 }), "with the price 40% under entry (limit 30%, no usable PnL)");
  const calm = { ok: false, count: 0, span_min: 0, current_is_distress: false, current: { verdict: "calm", pnl_pct: 1.78, price_pct: -6.7, turnover: 0.72 } };
  assert.equal(distressHeldBackText(calm), "no sign of a dying pool — PnL +1.78% (closes at ≤ -10%), 1h volume 0.7× pool TVL with the price 7% under entry (closes at ≥ 2× with the price ≥ 5% under entry)");
  const partial = { ok: false, count: 1, span_min: 0, current_is_distress: true, current: { verdict: "distress", pnl_pct: 2.27, price_pct: -10.4, turnover: 4.19 } };
  assert.match(distressHeldBackText(partial), /^distress on 1\/3 readings over 0m of 5m so far — PnL \+2\.27%/);
  const unk = { ...calm, current: { verdict: "unknown", pnl_pct: 1, price_pct: null, turnover: null, unknown: ["price since entry (pool is not SOL-quoted)", "1h volume (not in the pool row)"] } };
  assert.match(distressHeldBackText(unk), /^no sign of a dying pool could be confirmed — unknown: price since entry \(pool is not SOL-quoted\), 1h volume \(not in the pool row\) — PnL \+1\.00% .* 1h volume unknown with the price change since entry unknown/);
  const unkHtml = distressHeldBackAlertText({ pairHtml: "X-SOL", poolTvlUsd: 9000, chainTvlUsd: 9100, floorUsd: 10000, gate: unk });
  assert.match(unkHtml, /Not closing: no loss at or under -10% could be confirmed — could not read price since entry \(pool is not SOL-quoted\), 1h volume \(not in the pool row\)\./);
  assert.doesNotMatch(unkHtml, /no heavy selling/);
  assert.equal(sanitizeTelegramHTML(unkHtml), unkHtml);
  // the trigger text names the price fallback
  assert.match(D.distressTriggerText(), /at or under -10% \(or, with no usable PnL, the price at least 30% under entry\) or the pool shows heavy selling/);
  // the held-back line names both figures when the cost basis lifted the PnL
  assert.match(distressHeldBackText({ ...calm, current: { ...calm.current, pnl_pct: -8.9, raw_pnl_pct: -27.3 } }), /PnL -8\.90% on the cost basis \(-27\.30% on net capital\) \(closes at ≤ -10%\)/);
  const html = distressHeldBackAlertText({ pairHtml: "🧑 WLFI-SOL", poolTvlUsd: 8936, chainTvlUsd: 9322, floorUsd: 10000, gate: calm });
  assert.equal(sanitizeTelegramHTML(html), html);
  assert.match(html, /^ℹ️ <b>Pool under the TVL minimum — not closing<\/b>\n🧑 WLFI-SOL: pool TVL \$8,936 \(on-chain \$9,322\) is under the \$10,000 minimum; PnL \+1\.78%\.\nNot closing: no loss at or under -10% and no heavy selling/);
  assert.match(html, /tvlFloorExitDistressMode=off restores the old rule/);
  // close reason: prefix unchanged, evidence after the on-chain figure, no legacy scan keywords
  const streak = { count: 3, first_at: "2026-11-26T00:33:01Z", last_at: "2026-11-26T00:39:01Z", last_tvl_usd: 8218 };
  const evs = [];
  for (const legs of [["dump"], ["loss"], ["loss", "dump"], ["dump", "loss"]]) {
    for (const byPrice of [false, true]) for (const ref of ["entry", "first_seen"]) for (const price of [-40, -5, 0, 12]) {
      evs.push(distressEvidenceText({ legs, loss_by_price: byPrice, pnl_pct: byPrice ? null : -12.3, raw_pnl_pct: -30, price_pct: price, price_ref: ref, turnover: 3 }));
    }
  }
  for (const ev of evs) {
    for (const held of [true, false]) {
      const r = buildTvlFloorExit({ streak, chainTvlUsd: 8100, cfg: TVL_CFG, held, evidence: ev }).reason;
      assert.match(r, /^TVL exit: pool TVL \$8,218 under the \$10,000 minimum for 3 readings in 6m \(on-chain reserves \$8,100\), with /);
      assert.match(r, held ? / — hard exit \(overrides HOLD\)$/ : / — hard exit$/);
      assert.equal(/oor|below|above|floor|volume|out of range|yield|stop loss|[<>&]/i.test(r), false, r);
    }
  }
  assert.equal(buildTvlFloorExit({ streak, chainTvlUsd: 8100, cfg: TVL_CFG, held: true, evidence: distressEvidenceText(cur) }).reason,
    "TVL exit: pool TVL $8,218 under the $10,000 minimum for 3 readings in 6m (on-chain reserves $8,100), with heavy selling (1h turnover 5.6× pool TVL, price 36% under entry) — hard exit (overrides HOLD)");
});

// ── Fixture: the study's cases through the pure rule ──────────────────────────────────
function replay(c, { stopAtFire = true } = {}) {
  let tvl = null, dist = null;
  const out = [];
  for (const r of c.readings) {
    const t = Date.parse(r.at);
    const res = advanceTvlFloorStreak(tvl, { ok: true, tvl_usd: r.tvl_usd }, TVL_CFG, t);
    tvl = res.streak;
    if (!tvl) { dist = null; out.push({ at: r.at, event: res.event, ready: false, fire: false }); continue; }
    const v = evaluateTvlFloorDistress({ pnlPct: r.pnl_pct, activeBin: r.active_bin, entryBin: c.entry_bin, binStep: c.bin_step, volumeUsd: r.volume_usd, tvlUsd: r.tvl_usd, timeframeMinutes: 60 });
    dist = advanceTvlFloorDistress(res.event === "started" || res.event === "restarted" ? null : dist, v, res.event, t, tvl.count);
    const live = res.ready && (res.event === "counted" || res.event === "merged");
    const gate = tvlFloorDistressGate(dist, TVL_CFG, t, tvl.count);
    out.push({ at: r.at, event: res.event, ready: live, verdict: v.verdict, legs: v.legs, gate: gate.ok, fire: live && gate.ok, pnl: r.pnl_pct, price: v.price_pct, turnover: v.turnover, tvl: r.tvl_usd });
    if (stopAtFire && live && gate.ok) break;
  }
  return out;
}
const TABLE = [];
test("fixture: the 10 false closes do not fire; PVE, WINSTON and the 7 historical collapses do", () => {
  const FALSE = ["5QdSx6Kb", "BnWXrhnY", "3vEXhx99", "9wTNkyoB", "CN7nrAvn", "DUGfTjPR", "UzWyKKJ2", "Czjm1Xz4", "3htham3c", "HehYo3tG"];
  const HIST = ["9Zy1FnJ9", "2j7NdhFh", "2rZ62tQj", "49vHKAKV", "6o46rs4r", "4fz7zmt7", "5SfEQz44"];
  const byId = Object.fromEntries(FIX.cases.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), [...FALSE, ...HIST, "4sXgrxZt", "4C4jzy4R"].sort());
  for (const id of FALSE) {
    const c = byId[id];
    const steps = replay(c, { stopAtFire: false });
    const ready = steps.find((x) => x.at === c.ready_at);
    assert.ok(ready, `${id}: ready reading present`);
    assert.equal(steps.some((x) => x.fire), false, `${id} ${c.pair}: must not fire`);
    // TVL alone: the ready moment of the live rule is reproduced (the old rule closed there)
    assert.equal(steps.some((x) => x.ready), true, `${id}: the TVL proof stands in the replay`);
    TABLE.push({ id, pair: c.pair, kind: c.kind, at: ready.at, verdict: ready.verdict, pnl: ready.pnl, price: ready.price, turnover: ready.turnover, fire: null });
  }
  // PVE: fires at the live ready moment
  {
    const c = byId["4sXgrxZt"];
    const steps = replay(c);
    const f = steps.find((x) => x.fire);
    assert.ok(f, "PVE fires");
    assert.equal(f.at, c.ready_at);
    assert.deepEqual(f.legs, ["dump"]);
    TABLE.push({ id: "4sXgrxZt", pair: c.pair, kind: c.kind, at: c.ready_at, verdict: f.verdict, pnl: f.pnl, price: f.price, turnover: f.turnover, fire: f.at });
  }
  // WINSTON: first TVL proof 15:51 UTC held back (one calm reading at 15:48 reset the distress
  // streak), fires two readings later at 15:57; the second ready moment (17:18) is held back too
  // and fires at 17:27 — reported, the position would have been closed at 15:57.
  {
    const c = byId["4C4jzy4R"];
    const steps = replay(c, { stopAtFire: false });
    const first = steps.find((x) => x.fire);
    assert.ok(first, "WINSTON fires");
    assert.ok(Date.parse(first.at) - Date.parse(c.ready_at) <= 10 * MIN, `WINSTON fires within the next readings (${first.at})`);
    const r1 = steps.find((x) => x.at === c.ready_at);
    assert.equal(r1.ready, true);
    TABLE.push({ id: "4C4jzy4R", pair: c.pair, kind: c.kind, at: c.ready_at, verdict: r1.verdict, pnl: r1.pnl, price: r1.price, turnover: r1.turnover, fire: first.at });
    const r2 = steps.find((x) => x.at.startsWith("2026-11-27T17:18"));
    assert.equal(r2.ready, true);
    assert.equal(r2.fire, false);
    const second = steps.find((x) => x.fire && Date.parse(x.at) > Date.parse(r2.at));
    assert.ok(second, "WINSTON second streak fires later");
    TABLE.push({ id: "4C4jzy4R#2", pair: c.pair, kind: c.kind, at: r2.at, verdict: r2.verdict, pnl: r2.pnl, price: r2.price, turnover: r2.turnover, fire: second.at });
  }
  for (const id of HIST) {
    const c = byId[id];
    const steps = replay(c);
    const f = steps.find((x) => x.fire);
    assert.ok(f, `${id} ${c.pair}: the collapse fires`);
    const r = steps.find((x) => x.at === c.ready_at) || f;
    TABLE.push({ id, pair: c.pair, kind: c.kind, at: c.ready_at, verdict: r.verdict, pnl: r.pnl, price: r.price, turnover: r.turnover, fire: f.at });
  }
  if (process.env.TVL_DISTRESS_TABLE) console.log(JSON.stringify(TABLE, null, 0).replace(/},{/g, "},\n{"));
});

// ── End to end through checkTvlFloorExit (state, injected chain reader, simulated clock) ──
const S = await import("../state.js");
await S.ensureStateInitialized();
const I = await import("../index.js");
const { config } = await import("../config.js");
let seq = 0;
const mk = (tag, { hold = false, activeBin = -557, binStep = 100 } = {}) => {
  const addr = `TEST_TVL_DISTRESS_${tag}_${Date.now()}_${seq++}`;
  S.trackPosition({ position: addr, pool: "POOL_TD_" + tag, pool_name: tag + "-SOL", amount_sol: 1.2, strategy: "spot", active_bin: activeBin, bin_step: binStep });
  if (hold) S.setPositionHold(addr, true);
  return addr;
};
const pos = (a) => S.getTrackedPosition(a);
const row = (a, { tvl, vol, pnl, bin }) => ({ position: a, pool: pos(a).pool, pair: pos(a).pool_name, pnl_pct: pnl, active_bin: bin, bin_step: 100, tvl_floor_reading: { ok: true, tvl_usd: tvl }, tvl_floor_volume_usd: vol });
const chainLow = async () => ({ ok: true, tvl_usd: 8100 });
function withMgmt(patch, fn) {
  const saved = {}, savedTf = config.screening.timeframe;
  for (const k of Object.keys(patch)) saved[k] = config.management[k];
  Object.assign(config.management, patch);
  config.screening.timeframe = "1h";
  return Promise.resolve().then(fn).finally(() => { Object.assign(config.management, saved); config.screening.timeframe = savedTf; });
}
const QUIET = { tvl: 8936, vol: 6406, pnl: 1.78, bin: -564 };           // WLFI-like: calm
const DUMP = { tvl: 8218, vol: 46376, pnl: -5.73, bin: -602 };          // PVE-like: dump leg

test("e2e: held back → no exit, no stamp, log/record once; the stale stamp is refused", () => withMgmt({ tvlFloorExitMode: "enforce", tvlFloorExitDistressMode: "enforce" }, async () => {
  const cfg = tvlFloorExitConfig(config.management);
  const a = mk("HELDBACK", { hold: true });
  const t0 = Date.now() - 20 * MIN;
  for (const k of [0, 3, 6]) assert.equal(await I.checkTvlFloorExit(row(a, QUIET), cfg, true, { chainTvl: chainLow, nowMs: t0 + k * MIN }), null);
  let p = pos(a);
  assert.equal(p.tvl_floor_exit.count, 3);
  assert.equal(p.tvl_floor_exit.confirmed_at ?? null, null);
  assert.equal(p.tvl_floor_exit.distress.held_back, true);
  assert.ok(p.tvl_floor_exit.distress_held_back_logged_at);
  const latch = p.tvl_floor_exit.distress_held_back_logged_at;
  assert.equal(p.tvl_floor_distress.held_back_count, 1);
  assert.equal(p.tvl_floor_distress.pnl_pct_at_first, 1.78);
  assert.equal(p.tvl_floor_distress.pool_tvl_at_first, 8936);
  assert.ok(Math.abs(p.tvl_floor_distress.price_pct_at_first - -6.73) < 0.01);
  assert.ok(p.tvl_floor_distress.alerted_at);
  // a 4th held-back reading: same streak, no second count / log / alert; worst PnL follows
  assert.equal(await I.checkTvlFloorExit(row(a, { ...QUIET, pnl: -3 }), cfg, true, { chainTvl: chainLow, nowMs: t0 + 9 * MIN }), null);
  p = pos(a);
  assert.equal(p.tvl_floor_distress.held_back_count, 1);
  assert.equal(p.tvl_floor_exit.distress_held_back_logged_at, latch);
  assert.equal(p.tvl_floor_distress.worst_pnl_pct, -3);
  // a stale stamp written by anyone cannot open the HOLD guards for a held-back streak
  p.tvl_floor_exit.confirmed_at = new Date().toISOString();
  assert.equal(holdOverrideActive(p, config.management, "tvl_floor"), false);
  const { executeTool } = await import("../tools/executor.js");
  assert.equal((await executeTool("close_position", { position_address: a, reason: "test", hold_override: "tvl_floor" })).blocked, true);
  p.tvl_floor_exit.confirmed_at = null;
  // TVL back above the minimum: streak + distress state gone, the record stays
  await I.checkTvlFloorExit(row(a, { ...QUIET, tvl: 12000 }), cfg, true, { chainTvl: chainLow, nowMs: t0 + 12 * MIN });
  assert.equal(pos(a).tvl_floor_exit, null);
  assert.equal(pos(a).tvl_floor_distress.held_back_count, 1);
  // a new streak that is held back again counts a second hold-back, but no second alert
  const firstAlert = pos(a).tvl_floor_distress.alerted_at;
  for (const k of [15, 18, 21]) await I.checkTvlFloorExit(row(a, QUIET), cfg, true, { chainTvl: chainLow, nowMs: t0 + k * MIN });
  assert.equal(pos(a).tvl_floor_distress.held_back_count, 2);
  assert.equal(pos(a).tvl_floor_distress.alerted_at, firstAlert);
  // the record goes to the perf record and survives the close
  S.recordClose(a, "test cleanup");
  assert.equal(pos(a).tvl_floor_exit, null);
  const { buildPerfRecord } = await import("../perf-record.js");
  assert.equal(typeof buildPerfRecord, "function");
  assert.equal(pos(a).tvl_floor_distress.held_back_count, 2);
}));

test("e2e: distress on 3 readings over ≥ 5 min closes with the extended reason; calm resets; unknown neither", () => withMgmt({ tvlFloorExitMode: "enforce", tvlFloorExitDistressMode: "enforce" }, async () => {
  const cfg = tvlFloorExitConfig(config.management);
  const a = mk("FIRES", { hold: true });
  const t0 = Date.now() - 30 * MIN;
  const run = (r, k) => I.checkTvlFloorExit(row(a, r), cfg, true, { chainTvl: chainLow, nowMs: t0 + k * MIN });
  assert.equal(await run(DUMP, 0), null);
  assert.equal(await run(DUMP, 3), null);
  assert.equal(await run(QUIET, 6), null);           // calm: resets the distress streak (TVL proof stands — held back)
  assert.equal(pos(a).tvl_floor_exit.distress.count, 0);
  assert.equal(await run(DUMP, 9), null);            // 1
  assert.equal(await run({ ...DUMP, vol: null, pnl: 2 }, 12), null);  // unknown: neither
  assert.equal(pos(a).tvl_floor_exit.distress.count, 1);
  assert.equal(await run(DUMP, 15), null);           // 2 (span 6m, count 2)
  const ex = await run(DUMP, 18);                    // 3 over 9m → fires
  assert.equal(ex?.action, "TVL_FLOOR");
  assert.equal(ex.hold_override, "tvl_floor");
  assert.match(ex.reason, /^TVL exit: pool TVL \$8,218 under the \$10,000 minimum for 7 readings in 18m \(on-chain reserves \$8,100\), with heavy selling \(1h turnover 5\.6× pool TVL, price 36% under entry\) — hard exit \(overrides HOLD\)$/);
  assert.ok(pos(a).tvl_floor_exit.confirmed_at);
  assert.notEqual(pos(a).tvl_floor_exit.distress.held_back, true);  // the held-back mark is per reading; a fire clears it
  assert.equal(holdOverrideActive(pos(a), config.management, "tvl_floor"), true);
  assert.deepEqual(pos(a).tvl_floor_distress.fired_legs, ["dump"]);
  assert.equal(pos(a).tvl_floor_distress.fired_pnl_pct, -5.73);
  assert.equal(pos(a).tvl_floor_distress.would_hold_back, false);
  S.recordClose(a, "test cleanup");
}));

test("e2e: loss leg; no entry bin → first-seen reference; hands-off still wins", () => withMgmt({ tvlFloorExitMode: "enforce", tvlFloorExitDistressMode: "enforce" }, async () => {
  const cfg = tvlFloorExitConfig(config.management);
  // no entry bin on the row: the first evaluation's bin becomes the reference
  const a = mk("NOBIN", { activeBin: null });
  const t0 = Date.now() - 20 * MIN;
  const LOSS = { tvl: 7000, vol: 100, pnl: -12.3, bin: -600 };
  assert.equal(await I.checkTvlFloorExit(row(a, LOSS), cfg, false, { chainTvl: chainLow, nowMs: t0 }), null);
  assert.equal(pos(a).tvl_floor_distress.ref_bin, -600);
  assert.equal(pos(a).tvl_floor_distress.ref_bin_source, "first_seen");
  assert.equal(pos(a).tvl_floor_exit.distress.last.price_pct, 0);
  await I.checkTvlFloorExit(row(a, { ...LOSS, bin: -610 }), cfg, false, { chainTvl: chainLow, nowMs: t0 + 3 * MIN });
  assert.equal(pos(a).tvl_floor_distress.ref_bin, -600); // kept
  const ex = await I.checkTvlFloorExit(row(a, LOSS), cfg, false, { chainTvl: chainLow, nowMs: t0 + 6 * MIN });
  assert.equal(ex?.action, "TVL_FLOOR");
  assert.equal(ex.hold_override, null);
  assert.match(ex.reason, /\), with the position at -12\.3% \(limit -10%\) — hard exit$/);
  S.recordClose(a, "test cleanup");
  // hands-off + a satisfied gate: not closing, no stamp, no held-back record
  const b = mk("HANDSOFF", { hold: true });
  S.setPositionHandsOff(b, new Date(Date.now() + 3 * 3600_000).toISOString());
  for (const k of [0, 3, 6]) assert.equal(await I.checkTvlFloorExit(row(b, LOSS), cfg, true, { chainTvl: chainLow, nowMs: t0 + k * MIN }), null);
  assert.equal(pos(b).tvl_floor_exit.confirmed_at ?? null, null);
  assert.ok(pos(b).tvl_floor_exit.hands_off_logged_at);
  assert.equal(pos(b).tvl_floor_distress?.first_held_back_at ?? null, null);
  assert.equal(holdOverrideActive(pos(b), config.management, "tvl_floor"), false);
  S.recordClose(b, "test cleanup");
}));

test("e2e: distress off = the old rule; distress shadow closes on TVL alone and records would_hold_back; master shadow", async () => {
  await withMgmt({ tvlFloorExitMode: "enforce", tvlFloorExitDistressMode: "off" }, async () => {
    const cfg = tvlFloorExitConfig(config.management);
    const a = mk("OFF", { hold: true });
    const t0 = Date.now() - 20 * MIN;
    assert.equal(await I.checkTvlFloorExit(row(a, QUIET), cfg, true, { chainTvl: chainLow, nowMs: t0 }), null);
    assert.equal(await I.checkTvlFloorExit(row(a, QUIET), cfg, true, { chainTvl: chainLow, nowMs: t0 + 3 * MIN }), null);
    const ex = await I.checkTvlFloorExit(row(a, QUIET), cfg, true, { chainTvl: chainLow, nowMs: t0 + 6 * MIN });
    assert.equal(ex.reason, "TVL exit: pool TVL $8,936 under the $10,000 minimum for 3 readings in 6m (on-chain reserves $8,100) — hard exit (overrides HOLD)");
    assert.equal(pos(a).tvl_floor_exit.distress, undefined);         // nothing tracked while off
    assert.equal(pos(a).tvl_floor_distress ?? null, null);
    S.recordClose(a, "test cleanup");
  });
  await withMgmt({ tvlFloorExitMode: "enforce", tvlFloorExitDistressMode: "shadow" }, async () => {
    const cfg = tvlFloorExitConfig(config.management);
    const a = mk("DSHADOW", { hold: true });
    const t0 = Date.now() - 20 * MIN;
    await I.checkTvlFloorExit(row(a, QUIET), cfg, true, { chainTvl: chainLow, nowMs: t0 });
    await I.checkTvlFloorExit(row(a, QUIET), cfg, true, { chainTvl: chainLow, nowMs: t0 + 3 * MIN });
    const ex = await I.checkTvlFloorExit(row(a, QUIET), cfg, true, { chainTvl: chainLow, nowMs: t0 + 6 * MIN });
    assert.equal(ex?.action, "TVL_FLOOR");
    assert.doesNotMatch(ex.reason, /with /);                           // TVL alone: the old reason
    assert.equal(pos(a).tvl_floor_distress.would_hold_back, true);
    assert.deepEqual(pos(a).tvl_floor_distress.fired_legs, []);
    assert.equal(holdOverrideActive(pos(a), config.management, "tvl_floor"), true);
    S.recordClose(a, "test cleanup");
  });
  await withMgmt({ tvlFloorExitMode: "shadow", tvlFloorExitDistressMode: "enforce" }, async () => {
    const cfg = tvlFloorExitConfig(config.management);
    const a = mk("MSHADOW", { hold: true });
    const t0 = Date.now() - 20 * MIN;
    for (const k of [0, 3, 6]) assert.equal(await I.checkTvlFloorExit(row(a, QUIET), cfg, true, { chainTvl: chainLow, nowMs: t0 + k * MIN }), null);
    assert.ok(pos(a).tvl_floor_exit.distress_held_back_logged_at);  // held-back line, not the would-close line
    assert.equal(pos(a).tvl_floor_exit.shadow_logged_at ?? null, null);
    assert.equal(pos(a).tvl_floor_distress?.first_held_back_at ?? null, null); // capture only for the live rule
    for (const k of [9, 12, 15]) await I.checkTvlFloorExit(row(a, DUMP), cfg, true, { chainTvl: chainLow, nowMs: t0 + k * MIN });
    assert.ok(pos(a).tvl_floor_exit.shadow_logged_at);               // the full rule would close now
    assert.equal(pos(a).tvl_floor_exit.confirmed_at ?? null, null);
    S.recordClose(a, "test cleanup");
  });
});

test("e2e: the on-chain read is capped — slow → unavailable (no stamp, streak kept); a late rejection is handled", async () => {
  const late = [];
  const onUnhandled = (e) => late.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const dmode of ["off", "shadow", "enforce"]) {
      await withMgmt({ tvlFloorExitMode: "enforce", tvlFloorExitDistressMode: dmode }, async () => {
        const cfg = tvlFloorExitConfig(config.management);
        const a = mk(`SLOW_${dmode}`, { hold: true });
        const t0 = Date.now() - 20 * MIN;
        const slow = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, tvl_usd: 8100 }), 200));
        const slowReject = () => new Promise((_, reject) => setTimeout(() => reject(new Error("late boom")), 120));
        for (const [k, reader] of [[0, slow], [3, slow], [6, slow], [9, slowReject], [12, async () => { throw new Error("sync-ish boom"); }]]) {
          const ex = await I.checkTvlFloorExit(row(a, DUMP), cfg, true, { chainTvl: reader, nowMs: t0 + k * MIN, chainTimeoutMs: 50 });
          assert.equal(ex, null, `${dmode} k=${k}`);
          assert.equal(pos(a).tvl_floor_exit?.confirmed_at ?? null, null);
        }
        assert.equal(pos(a).tvl_floor_exit.count, 5); // the streak is kept (unavailable neither counts against it nor clears it)
        // a fast reader closes on the next reading, as before
        const ex = await I.checkTvlFloorExit(row(a, DUMP), cfg, true, { chainTvl: chainLow, nowMs: t0 + 15 * MIN, chainTimeoutMs: 50 });
        assert.equal(ex?.action, "TVL_FLOOR");
        S.recordClose(a, "test cleanup");
      });
    }
    await new Promise((r) => setTimeout(r, 400)); // let the slow reads settle / reject
    assert.deepEqual(late, [], "no unhandled rejection from the losing read");
    assert.deepEqual(await I.readChainTvlCapped(() => new Promise((r) => setTimeout(() => r({ ok: true, tvl_usd: 1 }), 100)), "P", 20), { ok: false, reason: "slow: > 0 s" });
    assert.deepEqual(await I.readChainTvlCapped(async () => ({ ok: true, tvl_usd: 5 }), "P", 1000), { ok: true, tvl_usd: 5 });
    assert.equal((await I.readChainTvlCapped(() => { throw new Error("x"); }, "P", 1000)).ok, false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("e2e: cost basis after a partial withdrawal holds the loss leg back (JIMMY CV7AUcQh numbers); a non-SOL-quoted pool has no price", () => withMgmt({ tvlFloorExitMode: "enforce", tvlFloorExitDistressMode: "enforce" }, async () => {
  const cfg = tvlFloorExitConfig(config.management);
  const a = mk("COSTBASIS", { hold: false, activeBin: -380 });
  pos(a).amount_sol = 0.9868;
  pos(a).avg_cost_basis = { basis_sol: 0.7875, changes: 1, at: "2026-11-25T15:17:38Z" };
  const t0 = Date.now() - 20 * MIN;
  const J = { tvl: 9000, vol: 500, pnl: -27.3, bin: -380 };
  for (const k of [0, 3, 6]) {
    const r = { ...row(a, J), pnl_sol_rule: -0.2694 };
    assert.equal(await I.checkTvlFloorExit(r, cfg, false, { chainTvl: chainLow, nowMs: t0 + k * MIN }), null);
  }
  const rec = pos(a).tvl_floor_distress;
  assert.ok(Math.abs(rec.pnl_pct_at_first - -8.9) < 0.1, `leg figure ${rec.pnl_pct_at_first}`);
  assert.equal(rec.raw_pnl_pct_at_first, -27.3);
  assert.equal(pos(a).tvl_floor_exit.distress.last.verdict, "calm");
  // old rule for comparison: plain −27.3 % would have read as a loss
  S.recordClose(a, "test cleanup");
  // non-SOL-quoted (token Y is USDC): the price is unknown even with a −45 % bin move; PnL +1 % → unknown, never a dump
  const b = mk("NONSOL", { activeBin: -500 });
  pos(b).asset_profile = { token_x_mint: "BaseMint1111111111111111111111111111111111", token_y_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
  for (const k of [0, 3, 6]) assert.equal(await I.checkTvlFloorExit(row(b, { tvl: 7000, vol: 90000, pnl: 1, bin: -560 }), cfg, false, { chainTvl: chainLow, nowMs: t0 + k * MIN }), null);
  const last = pos(b).tvl_floor_exit.distress.last;
  assert.deepEqual([last.verdict, last.price_pct, last.dump], ["unknown", null, null]);
  assert.ok(last.unknown.some((u) => /not SOL-quoted/.test(u)));
  S.recordClose(b, "test cleanup");
}));

test("alert text: the 🚨 TVL floor exit message keeps its $ signs and, without evidence, equals the HEAD text", () => {
  const streak = { count: 3, last_tvl_usd: 8218.4, first_at: "2026-11-26T00:33:01Z", last_at: "2026-11-26T00:39:01Z" };
  for (const held of [true, false]) {
    const got = I.tvlFloorExitAlertText({ pairHtml: "🧑 PVE-SOL", held, streak, spanMin: 6.0, chainTvlUsd: 8100.2, floorUsd: 10000, pnlPct: -5.734 });
    // the pre-2026-11-28 template (index.js at 36f7bdf), evaluated on the same inputs
    const head = `🚨 <b>TVL floor exit${held ? " — HOLD overridden" : ""}</b>\n🧑 PVE-SOL: pool TVL $${Math.round(8218.4).toLocaleString("en-US")} is below the $${(10000).toLocaleString("en-US")} floor ` +
      `(3 readings over 6m; on-chain reserves $${Math.round(8100.2).toLocaleString("en-US")}). PnL -5.73%.\n` +
      (held
        ? "This position was On Hold. The TVL floor is the one rule that closes a held position; closing now and selling the remainder to SOL."
        : "Closing now and selling the remainder to SOL.") +
      "\n<i>Switch off with tvlFloorExitMode=off (or shadow).</i>";
    assert.equal(got, head);
    assert.match(got, /pool TVL \$8,218 is below the \$10,000 floor \(3 readings over 6m; on-chain reserves \$8,100\)/);
    const withEv = I.tvlFloorExitAlertText({ pairHtml: "🧑 PVE-SOL", held, streak, spanMin: 6, chainTvlUsd: 8100, floorUsd: 10000, pnlPct: -5.73, evidence: "with heavy selling (1h turnover 5.6× pool TVL, price 36% under entry)" });
    assert.match(withEv, /\$8,218 is below the \$10,000 floor .* reserves \$8,100\)\. PnL -5\.73%\.\nPool distress: heavy selling \(1h turnover 5\.6× pool TVL, price 36% under entry\)\.\n/);
    assert.equal(sanitizeTelegramHTML(withEv), withEv);
  }
  // the held-back log line keeps its $ signs too
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /under the minimum \(pool TVL \$\$\{Math\.round\(s\.last_tvl_usd\)\.toLocaleString\("en-US"\)\}, on-chain \$\$\{Math\.round\(check\.chain_tvl_usd\)/);
});

test("e2e: a throw in the distress input closes nothing", () => withMgmt({ tvlFloorExitMode: "enforce", tvlFloorExitDistressMode: "enforce" }, async () => {
  const cfg = tvlFloorExitConfig(config.management);
  const a = mk("THROW", { hold: true });
  const t0 = Date.now() - 20 * MIN;
  const evil = (k) => {
    const r = row(a, DUMP);
    Object.defineProperty(r, "active_bin", { get() { throw new Error("boom"); } });
    return I.checkTvlFloorExit(r, cfg, true, { chainTvl: chainLow, nowMs: t0 + k * MIN });
  };
  for (const k of [0, 3, 6, 9]) assert.equal(await evil(k), null);
  assert.equal(pos(a).tvl_floor_exit?.confirmed_at ?? null, null);
  S.recordClose(a, "test cleanup");
}));

// ── Property: the gate can only remove closes ─────────────────────────────────────────
// `oldDecision` is a RE-IMPLEMENTATION of the HEAD (pre-2026-11-28, 36f7bdf) decision of
// index.js checkTvlFloorExit, written from that code — not the HEAD code itself: the TVL streak
// (advanceTvlFloorStreak, unchanged module), a fresh below-minimum reading completing the proof,
// the on-chain verdict (unavailable → nothing, disagree → streak cleared), hands-off, enforce. (The
// independent review ran a true HEAD differential — 7,100 steps, 0 violations; this test keeps
// the property pinned in the suite.)
function oldDecision(state, { reading, chain, handsOff, mode }, nowMs) {
  const cfg = tvlFloorExitConfig({ tvlFloorExitMode: mode });
  if (cfg.mode === "off") return { state: null, fire: false };
  const res = advanceTvlFloorStreak(state, reading, cfg, nowMs);
  let s = res.event === "ignored" && res.streak === state ? state : res.streak;
  if (!res.ready || (res.event !== "counted" && res.event !== "merged")) return { state: s, fire: false };
  const check = crossCheckTvlFloor(chain, cfg);
  if (check.verdict === "unavailable") return { state: s, fire: false };
  if (check.verdict === "disagree") return { state: null, fire: false };
  if (handsOff) return { state: s, fire: false };
  return { state: s, fire: cfg.mode === "enforce" };
}
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

test("property: new fires ⊆ old fires under mode flips, HOLD / hands-off toggles and corrupt state; equal with the gate off", async () => {
  const { handsOffActive } = await import("../hands-off.js");
  const MASTER = ["enforce", "enforce", "enforce", "shadow", "off", "ENFORCE", "bogus", undefined, null];
  const DIST = ["enforce", "shadow", "off", "off", "OFF", "nonsense", undefined, null, 7];
  let oldFires = 0, newFires = 0, removed = 0, steps = 0, offSteps = 0;
  for (let run = 0; run < 60; run++) {
    const r = rng(9_000 + run);
    await withMgmt({ tvlFloorExitMode: "enforce", tvlFloorExitDistressMode: "enforce" }, async () => {
      const a = mk(`PROP${run}`, { hold: r() < 0.5, activeBin: r() < 0.8 ? -550 : null });
      let oldState = null;
      let t = Date.now() - 6 * 3600_000;
      let mode = "enforce", dmode = pick(r, ["enforce", "shadow", "off"]);
      for (let i = 0; i < 30; i++) {
        t += Math.round((r() < 0.1 ? 0.5 : 1 + r() * (r() < 0.05 ? 40 : 4)) * MIN);
        // mid-run flips of both mode keys (garbage included), as a hot reload would leave them
        if (r() < 0.12) mode = pick(r, MASTER);
        if (r() < 0.12) dmode = pick(r, DIST);
        config.management.tvlFloorExitMode = mode;
        config.management.tvlFloorExitDistressMode = dmode;
        const cfg = tvlFloorExitConfig(config.management);
        // HOLD and hands-off toggles
        if (r() < 0.08) S.setPositionHold(a, !(pos(a).hold_mode === true));
        if (pos(a).hold_mode === true && r() < 0.1) S.setPositionHandsOff(a, new Date(Date.now() + 3600_000).toISOString());
        else if (pos(a).hands_off_until && r() < 0.3) S.setPositionHandsOff(a, null);
        // legacy / corrupt stored state, shared by both sides (the TVL streak is the same object)
        const c = r();
        if (c < 0.04 && pos(a).tvl_floor_exit) {
          const legacy = { count: Math.max(1, Math.floor(r() * 4)), first_at: new Date(t - 8 * MIN).toISOString(), last_at: new Date(t - 2 * MIN).toISOString(), first_tvl_usd: 9000, last_tvl_usd: 9000, max_tvl_usd: 9000 };
          pos(a).tvl_floor_exit = { ...legacy };                // a streak written before the gate existed (no distress)
          oldState = { ...legacy };
        } else if (c < 0.10 && pos(a).tvl_floor_exit) {
          pos(a).tvl_floor_exit.distress = pick(r, [
            { count: 1e9, first_at: new Date(t - 60 * MIN).toISOString(), last_at: new Date(t - 2 * MIN).toISOString(), last: { at: new Date(t).toISOString(), verdict: "distress", legs: ["loss"] } },
            { count: -3, first_at: "x", last_at: "y" }, { count: NaN }, { count: 2.5, first_at: null }, "garbage", 0, [],
            { count: 50, first_at: new Date(t - 90 * MIN).toISOString(), last_at: new Date(t - MIN).toISOString(), held_back: false },
          ]);
        }
        const reading = r() < 0.08 ? { ok: false, reason: "fetch failed" } : { ok: true, tvl_usd: r() < 0.15 ? 10000 + r() * 5000 : r() * 10000 };
        const chainKind = r();
        const chain = chainKind < 0.1 ? { ok: false, reason: "rpc" } : { ok: true, tvl_usd: chainKind < 0.2 ? 12000 : 8000 };
        const handsOff = handsOffActive(pos(a));
        const p = {
          position: a, pool: pos(a).pool, pair: pos(a).pool_name, bin_step: 100,
          pnl_pct: r() < 0.15 ? NaN : -30 + r() * 45, active_bin: r() < 0.1 ? null : -550 - Math.round(r() * 60) + 10,
          pnl_management_ready: r() < 0.1 ? false : undefined,
          tvl_floor_reading: reading, tvl_floor_volume_usd: r() < 0.15 ? null : r() * 60000,
        };
        const o = oldDecision(oldState, { reading, chain, handsOff, mode }, t);
        oldState = o.state;
        const ex = await I.checkTvlFloorExit(p, cfg, pos(a).hold_mode === true, { chainTvl: async () => chain, nowMs: t });
        const fired = !!ex;
        steps++;
        if (o.fire) oldFires++;
        if (fired) newFires++;
        if (o.fire && !fired) removed++;
        assert.ok(!fired || o.fire, `run ${run} step ${i}: the new code fired where the old one did not`);
        if (tvlFloorDistressConfig(config.management).mode === "off") {
          offSteps++;
          assert.equal(fired, o.fire, `run ${run} step ${i}: distress off must equal the old rule`);
          if (fired) assert.doesNotMatch(ex.reason, /, with /); // the old reason
        }
        if (fired) assert.ok(pos(a).tvl_floor_exit.confirmed_at);
        // a close the gate held back leaves no usable HOLD-override stamp
        if (o.fire && !fired) assert.equal(holdOverrideActive(pos(a), config.management, "tvl_floor"), false, `run ${run} step ${i}: held back but the stamp opens`);
        // the TVL streak itself is unchanged by the gate
        assert.equal(pos(a).tvl_floor_exit?.count ?? null, oldState?.count ?? null, `run ${run} step ${i}: TVL streak count`);
      }
      S.recordClose(a, "test cleanup");
    });
  }
  console.log(`property: ${steps} steps, ${oldFires} old fires, ${newFires} new fires, ${removed} removed by the gate, ${offSteps} steps with the gate off`);
  assert.ok(oldFires > 10, `the sequences exercise the rule (${oldFires} old fires in ${steps} steps)`);
  assert.ok(removed > 0, "the gate removed some closes");
  assert.ok(newFires > 0, "the gate let some closes through");
  assert.ok(offSteps > 50, "the gate-off branch is exercised");
});

// ── Wiring ─────────────────────────────────────────────────────────────────────────────
test("wiring: same row, the relative shadow's ready moment, hands-off before the gate", () => {
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /tvlFloorVolumeUsd = tvlFloorReading\.ok \? readPoolVolumeUsd\(detail, p\.pool\) : null;/);
  assert.match(idx, /tvl_floor_reading: tvlFloorReading, tvl_floor_volume_usd: tvlFloorVolumeUsd,/);
  // the relative-TVL experiment's "old ready" moment stays the TVL-only proof: before hands-off and the gate
  assert.match(idx, /noteTvlFloorReadyForShadow\(p\);[^\n]*\n[\s\S]{0,300}if \(handsOffActive\(handsOffPos\)\) \{[\s\S]{0,900}return null;\s*\}\s*\/\/ Distress gate: the TVL proof stands/);
  const dist = fs.readFileSync(new URL("../tvl-floor-distress.js", import.meta.url), "utf8");
  assert.deepEqual([...dist.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]), ["./rule-mode.js"]); // leaf
  assert.doesNotMatch(dist, /fetch\(|await /);
});
