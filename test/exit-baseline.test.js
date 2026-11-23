process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 2026-11-24: post-close probes for closes the operator makes in the Meteora UI. Those are
// recorded by reconcileExternallyClosedPosition, whose record had no exit_mcap, so the probe
// marked every one `unprobeable`. The reconcile now reads the same pool row the bot's own close
// reads, once, fire-and-forget, and stamps the baseline's source and lag (exit-baseline.js).

if (!process.env.MERIDIAN_DATA_DIR) process.env.MERIDIAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "exit-baseline-"));
const DIR = process.env.MERIDIAN_DATA_DIR;
const EB = await import("../exit-baseline.js");

const row = { pool_address: "POOL_X", token_x: { market_cap: "1234567.5" }, tvl: "45000", volume: "800" };

test("exitMarketFromPoolRow: the close path's parse; no mcap → no baseline", () => {
  assert.deepEqual(EB.exitMarketFromPoolRow(row), { exit_mcap: 1234567.5, exit_tvl: 45000, exit_volume: 800 });
  assert.deepEqual(EB.exitMarketFromPoolRow({ token_x: { market_cap: 5 }, active_tvl: 9 }), { exit_mcap: 5, exit_tvl: 9, exit_volume: null });
  assert.equal(EB.exitMarketFromPoolRow({ token_x: { market_cap: 0 }, tvl: 1 }), null);
  assert.equal(EB.exitMarketFromPoolRow(null), null);
});

test("applyExitBaseline: fills a record without a baseline, stamps source + lag, never overwrites", () => {
  const closed = Date.parse("2026-11-23T10:00:00Z");
  const rec = { position: "A", recorded_at: new Date(closed).toISOString(), exit_mcap: null, pnl_pct: 1.2 };
  assert.equal(EB.applyExitBaseline(rec, EB.exitMarketFromPoolRow(row), { nowMs: closed + 185_000 }), true);
  assert.equal(rec.exit_mcap, 1234567.5);
  assert.equal(rec.exit_tvl, 45000);
  assert.equal(rec.exit_volume, 800);
  assert.equal(rec.exit_baseline_source, "reconcile");
  assert.equal(rec.exit_baseline_lag_sec, 185);
  assert.equal(rec.exit_baseline_at, new Date(closed + 185_000).toISOString());
  assert.equal(rec.pnl_pct, 1.2, "nothing else touched");
  // a record that already has a baseline, or whose probes are settled, is left alone
  const has = { recorded_at: rec.recorded_at, exit_mcap: 9 };
  assert.equal(EB.applyExitBaseline(has, { exit_mcap: 1 }), false); assert.equal(has.exit_mcap, 9);
  const done = { recorded_at: rec.recorded_at, exit_mcap: null, post_close: { complete: true, exit_quality: { verdict: "unprobeable" } } };
  assert.equal(EB.applyExitBaseline(done, { exit_mcap: 1 }), false);
  assert.equal(done.exit_mcap, null, "records already stored as unprobeable stay as they are");
  assert.equal(EB.applyExitBaseline({ exit_mcap: null }, null), false);
});

test("pending marker: set before the record, cleared by the read, expires after 2 min", () => {
  const t = 1_000_000;
  EB.markExitBaselinePending("P", t);
  assert.equal(EB.isExitBaselinePending("P", t + 60_000), true);
  assert.equal(EB.isExitBaselinePending("P", t + 121_000), false, "a hung read cannot hold the probe off forever");
  EB.markExitBaselinePending("Q", t);
  EB.clearExitBaselinePending("Q");
  assert.equal(EB.isExitBaselinePending("Q", t), false);
});

// Through lessons.js + tools/dlmm.js with a fake fetch (no network).
const closedAt = new Date(Date.now() - 200_000).toISOString();
const extRec = (position) => ({
  position, pool: "POOL_X", pool_name: "EXT-SOL", strategy: "manual", adopted: true, amount_sol: 1,
  pnl_pct: 3.1, pnl_sol: 0.031, close_reason: "External close detected during discovery reconciliation",
  pnl_source: "external_reconcile", external_close: true, recorded_at: closedAt,
  minutes_held: 40, minutes_in_range: 40, range_efficiency: 100,
});
fs.writeFileSync(path.join(DIR, "lessons.json"), JSON.stringify({ lessons: [], performance: [extRec("EXT_OK"), extRec("EXT_FAIL"), extRec("EXT_EMPTY")] }, null, 2));
const L = await import("../lessons.js");
const D = await import("../tools/dlmm.js");
const byPos = (p) => L.getAllPerformance().find((r) => r.position === p);

test("reconcile capture: one read, the record becomes probeable", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ data: [row] }) }; };
  EB.markExitBaselinePending("EXT_OK");
  assert.equal(await D._captureReconcileExitBaselineForTest("EXT_OK", "POOL_X", { fetchImpl }), true);
  assert.equal(calls.length, 1, "exactly one request");
  assert.match(calls[0], /^https:\/\/pool-discovery-api\.datapi\.meteora\.ag\/pools\?page_size=1&filter_by=pool_address%3DPOOL_X&timeframe=/);
  const r = byPos("EXT_OK");
  assert.equal(r.exit_mcap, 1234567.5);
  assert.equal(r.exit_baseline_source, "reconcile");
  assert.ok(r.exit_baseline_lag_sec >= 199 && r.exit_baseline_lag_sec < 260, String(r.exit_baseline_lag_sec));
  assert.equal(EB.isExitBaselinePending("EXT_OK"), false);
  // the probe now records a slot against it instead of marking it unprobeable
  assert.equal(L.recordPostCloseProbe("EXT_OK", 30, { mcap: 1234567.5 * 1.1, minutes: [30, 60, 180] }), true);
  assert.equal(byPos("EXT_OK").post_close.m30.pct, 10);
  assert.equal(byPos("EXT_OK").post_close.exit_mcap, 1234567.5);
});

test("reconcile capture: a failed or empty read leaves the record exactly as it was", async () => {
  const before = JSON.stringify(byPos("EXT_FAIL"));
  EB.markExitBaselinePending("EXT_FAIL");
  assert.equal(await D._captureReconcileExitBaselineForTest("EXT_FAIL", "POOL_X", { fetchImpl: async () => { throw new Error("ECONNRESET"); } }), false);
  assert.equal(JSON.stringify(byPos("EXT_FAIL")), before);
  assert.equal(EB.isExitBaselinePending("EXT_FAIL"), false, "the probe may mark it unprobeable as before");
  const before2 = JSON.stringify(byPos("EXT_EMPTY"));
  assert.equal(await D._captureReconcileExitBaselineForTest("EXT_EMPTY", "POOL_X", { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) }), false);
  assert.equal(await D._captureReconcileExitBaselineForTest("EXT_EMPTY", "POOL_X", { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }), false);
  assert.equal(await D._captureReconcileExitBaselineForTest("EXT_EMPTY", "POOL_X", { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ ...row, pool_address: "OTHER" }] }) }) }), false, "a row for another pool is not used");
  assert.equal(JSON.stringify(byPos("EXT_EMPTY")), before2);
  L.markPostCloseUnprobeable("EXT_FAIL");
  assert.equal(byPos("EXT_FAIL").post_close.exit_quality.verdict, "unprobeable");
});

test("wiring: pending is marked before the record is written; the probe skips a pending record without a request", () => {
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const fn = dlmm.slice(dlmm.indexOf("export async function reconcileExternallyClosedPosition"));
  const iMark = fn.indexOf("markExitBaselinePending(position_address)");
  const iRec = fn.indexOf("await recordPerformance(externalReconcilePerfRecord(");
  const iCap = fn.indexOf("void captureReconcileExitBaseline(position_address, tracked.pool)");
  assert.ok(iMark > 0 && iRec > iMark && iCap > iRec, "mark → record → fire-and-forget capture");
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const probe = idx.slice(idx.indexOf("async function runPostCloseProbes"), idx.indexOf("async function runPostCloseProbes") + 2500);
  assert.match(probe, /if \(perf\.exit_mcap == null\) \{\s+\/\/[^\n]*\n[^\n]*\n\s+if \(isExitBaselinePending\(perf\.position\)\) continue;\s+markPostCloseUnprobeable\(perf\.position\);/);
});
