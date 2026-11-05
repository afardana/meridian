/**
 * Perf-record assembly for the three close sites of tools/dlmm.js (perf-record.js).
 *
 * Characterization: test/fixtures/perf-record-sites.json holds, per case, the site's local
 * variables at its recordPerformance call (`args`) and the exact object the site passed on
 * 876fc16 (`expected`) — proven equal to the original inline literals when the fixture was
 * generated. Sentinels: "__undefined__" = key present with value undefined, "__NaN__" = NaN.
 * Since the buildPerfRecord refactor the records must still equal `expected`, except for the
 * drift fixes listed in DRIFT below (asserted one by one).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PR = await import("../perf-record.js");
const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/perf-record-sites.json", import.meta.url), "utf8"));

const enc = (v) => {
  if (v === undefined) return "__undefined__";
  if (typeof v === "number" && Number.isNaN(v)) return "__NaN__";
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
};
const dec = (v) => {
  if (v === "__NaN__") return NaN;
  if (v === "__undefined__") return undefined;
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
  return v;
};
const SITE = {
  close: PR.closePositionPerfRecord,
  rebalance_leg: PR.rebalanceLegPerfRecord,
  external_reconcile: PR.externalReconcilePerfRecord,
};
const build = (c) => SITE[c.site](dec(c.args));

test("fixtures cover every scoring source and the record shapes that matter", () => {
  const names = FIX.cases.map((c) => c.name);
  const sources = new Set(FIX.cases.map((c) => c.expected.pnl_source));
  for (const s of ["closed_api", "cache_fallback", "rebalance_leg", "external_reconcile"]) assert.ok(sources.has(s), s);
  assert.ok(FIX.cases.some((c) => c.expected.adoption_lifetime && c.expected.adoption_lifetime !== "__undefined__"), "adoption basis applied");
  assert.ok(FIX.cases.some((c) => c.expected.adoption_rebase_skipped === "fresh_deposit_only"), "rebase skipped");
  assert.ok(FIX.cases.some((c) => c.expected.straddle_count > 0), "straddled");
  assert.ok(FIX.cases.some((c) => c.expected.hold_peak_pnl_pct != null), "closed while held");
  assert.ok(names.includes("main_never_filled_ladder"));
  assert.equal(new Set(names).size, names.length, "unique case names");
});

// Drift fixed by the single builder (2026-11-05). Every other case and field must equal the
// characterization exactly — same key set, same values.
//   (a) minutes_in_range clamped to [0, minutes_held] at every site (the main close did not clamp)
//   (b) amount_sol falls back to deposit_sol_true at the main close too (it wrote undefined)
const DRIFT = {
  main_oor_input_above_held: { minutes_in_range: [-6, 0] },
  main_missing_amount_and_deployed_at: { amount_sol: ["__undefined__", 0.5] },
};

test("refactor: each site's record equals the characterization, apart from the listed drift fixes", () => {
  for (const c of FIX.cases) {
    const want = { ...c.expected };
    for (const [k, [before, after]] of Object.entries(DRIFT[c.name] || {})) {
      assert.deepStrictEqual(c.expected[k], before, `${c.name}.${k}: characterized value`);
      want[k] = after;
    }
    assert.deepStrictEqual(enc(build(c)), want, c.name);
  }
});

test("(a) minutes_in_range is clamped to [0, minutes_held]; an unknown held time stays NaN", () => {
  assert.equal(PR.minutesInRange(135, 12), 123);
  assert.equal(PR.minutesInRange(20, 26), 0);
  assert.equal(PR.minutesInRange(30, 0), 30);
  assert.equal(PR.minutesInRange(30, -5), 30, "never above the held time");
  assert.ok(Number.isNaN(PR.minutesInRange(NaN, NaN)), "main close without deployed_at: unchanged (NaN → null in jsonb)");
  const byName = Object.fromEntries(FIX.cases.map((c) => [c.name, c]));
  const ext = byName.external_reconcile_adopted_oor_over_held; // 512 OOR minutes over 300 held
  assert.equal(build(ext).minutes_in_range, 0);
  for (const c of FIX.cases) {
    const r = build(c);
    if (Number.isFinite(r.minutes_held)) assert.ok(r.minutes_in_range >= 0 && r.minutes_in_range <= Math.max(0, r.minutes_held), c.name);
  }
});

test("(b) amount_sol: the tracked capital, else the close's deposit — the same rule at all three sites", () => {
  for (const c of FIX.cases) {
    const r = build(c);
    const tracked = c.args.tracked || c.args.snapshot;
    assert.equal(r.amount_sol, tracked.amount_sol ?? r.deposit_sol_true, c.name);
  }
});

test("(c) recorded_at: the closed API's time at the leg / reconcile, none at the main close (lessons.js stamps it)", () => {
  for (const c of FIX.cases) {
    const r = build(c);
    if (c.site === "close") assert.equal("recorded_at" in r, false, c.name);
    else assert.equal(r.recorded_at, c.args.closedAt, c.name);
  }
});

test("(d) total_gas_sol is a number at every site, even from a stored string", () => {
  const byName = Object.fromEntries(FIX.cases.map((c) => [c.name, c]));
  const withGas = (c, total) => {
    const args = dec(c.args);
    const key = args.tracked ? "tracked" : "snapshot";
    return SITE[c.site]({ ...args, [key]: { ...args[key], total_gas_sol: total } });
  };
  const near = (a, b) => Math.abs(a - b) < 1e-12;
  const m = withGas(byName.main_closed_api_bot_ladder, "0.0002");
  assert.ok(typeof m.total_gas_sol === "number" && near(m.total_gas_sol, 0.0002 + 0.000105), String(m.total_gas_sol));
  const e = withGas(byName.external_reconcile_plain, "0.0002");
  assert.ok(typeof e.total_gas_sol === "number" && near(e.total_gas_sol, 0.0002));
  const l = withGas(byName.rebalance_leg_plain, "0.0002");
  assert.ok(typeof l.total_gas_sol === "number" && near(l.total_gas_sol, 0.0002 + 0.00012));
});

test("one builder: the three sites share every field except their own", () => {
  const SITE_ONLY = {
    close: ["exit_mcap", "exit_tvl", "exit_volume"],
    rebalance_leg: ["rebalance_leg", "rebalanced_into", "recorded_at"],
    external_reconcile: ["external_close", "external_close_source", "recorded_at"],
  };
  const shared = {};
  for (const c of FIX.cases) {
    const keys = Object.keys(build(c)).filter((k) => !SITE_ONLY[c.site].includes(k) && k !== "adoption_rebase_skipped").sort();
    (shared[c.site] ||= keys);
    assert.deepEqual(keys, shared[c.site], c.name);
  }
  assert.deepEqual(shared.rebalance_leg, shared.close);
  assert.deepEqual(shared.external_reconcile, shared.close);
  const src = fs.readFileSync(new URL("../perf-record.js", import.meta.url), "utf8");
  assert.equal((src.match(/return buildPerfRecord\(\{/g) || []).length, 3, "every site goes through buildPerfRecord");
  assert.doesNotMatch(fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8"), /await recordPerformance\(\{/, "no inline record literal left in tools/dlmm.js");
});

test("site-specific fields stay with their site", () => {
  const byName = Object.fromEntries(FIX.cases.map((c) => [c.name, c]));
  const ext = build(byName.external_reconcile_plain);
  assert.equal(ext.strategy, "manual", "external reconcile defaults the strategy");
  assert.equal(ext.pool_name, byName.external_reconcile_plain.args.tracked.pool, "external reconcile falls back to the full pool address");
  assert.equal(ext.gas_cost_sol, 0);
  const leg = build(byName.rebalance_leg_adopted_skipped_no_name);
  assert.equal(leg.strategy, undefined, "the leg keeps a missing strategy missing");
  assert.equal(leg.pool_name, byName.rebalance_leg_adopted_skipped_no_name.args.pool_address.slice(0, 8));
  assert.equal(leg.close_reason, "rebalance: straddle");
  const nf = build(byName.main_never_filled_ladder);
  assert.deepEqual([nf.fees_sol_true, nf.fees_usd_true], [null, null], "the main close stores zero fees as null (as before)");
  assert.equal(build(byName.external_reconcile_plain).fees_sol_true, 0, "the reconcile stores the API's zero (as before)");
});

test("lessons.recordPerformance stamps recorded_at only when the site did not (no double stamp)", async () => {
  const { recordPerformance, getAllPerformance } = await import("../lessons.js");
  const byName = Object.fromEntries(FIX.cases.map((c) => [c.name, c]));
  const t0 = Date.now();
  const main = build(byName.main_closed_api_bot_ladder);
  assert.equal("recorded_at" in main, false, "the main close leaves the timestamp to lessons.js");
  await recordPerformance(main);
  const leg = build(byName.rebalance_leg_plain);
  await recordPerformance(leg);
  const ext = build(byName.external_reconcile_plain);
  await recordPerformance(ext);
  const stored = (p) => getAllPerformance().find((r) => r.position === p);
  const m = stored(main.position);
  assert.ok(m, "main record stored");
  const ms = Date.parse(m.recorded_at);
  assert.ok(ms >= t0 - 1000 && ms <= Date.now() + 1000, "main: stamped at record time");
  assert.equal(stored(leg.position).recorded_at, byName.rebalance_leg_plain.args.closedAt, "rebalance leg: the closed API's timestamp");
  assert.equal(stored(ext.position).recorded_at, byName.external_reconcile_plain.args.closedAt, "external reconcile: the closed API's timestamp");
});
