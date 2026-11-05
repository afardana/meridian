/**
 * Perf-record assembly for the three close sites of tools/dlmm.js (perf-record.js).
 *
 * Characterization: test/fixtures/perf-record-sites.json holds, per case, the site's local
 * variables at its recordPerformance call (`args`) and the exact object the site passed on
 * 876fc16 (`expected`) — proven equal to the original inline literals when the fixture was
 * generated. Sentinels: "__undefined__" = key present with value undefined, "__NaN__" = NaN.
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

test("characterization: each site's record equals the recorded one", () => {
  for (const c of FIX.cases) assert.deepStrictEqual(enc(build(c)), c.expected, c.name);
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
