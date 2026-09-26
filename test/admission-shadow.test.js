process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { feeRate24hEq, admitByFeeRate, condensePool } = await import("../tools/screening.js");

const S = { timeframe: "1h", minTvl: 100_000, minBinStep: 80, maxBinStep: 125, minVolumeTvlRatio: 0.05, minTxPerMin: 2, scoutTierEnabled: true, rankAdmitCount: 5 };
const pool = (over) => ({ name: "X-SOL", pool: `P${Math.random().toString(36).slice(2, 8)}`, tvl: 150_000, holders: 900, mcap: 800_000, bin_step: 100, fee_active_tvl_ratio: 0.2, volume_tvl_ratio: 0.5, tx_per_min: 10, price_change_pct: 3, ...over });

test("24h-equivalent fee rate: windowed × (1440/tf) vs own 24h figure, the larger wins", () => {
  assert.ok(Math.abs(feeRate24hEq({ fee_active_tvl_ratio: 0.1 }, 60) - 2.4) < 1e-9);
  assert.equal(feeRate24hEq({ fee_active_tvl_ratio: 0.05, fee_active_tvl_ratio_24h: 3.0 }, 60), 3.0);
  assert.equal(feeRate24hEq({ fee_active_tvl_ratio: 0.5, fee_active_tvl_ratio_24h: 3.0 }, 60), 12);
  assert.equal(feeRate24hEq({}, 60), null);
});

test("safety floors are hard gates; intel is not consulted", () => {
  const r = admitByFeeRate([
    pool({ name: "HOLD", holders: 120 }),
    pool({ name: "MCAP", mcap: 50_000 }),
    pool({ name: "STEP", bin_step: 20 }),
    pool({ name: "WARN", critical_warnings: true }),
    pool({ name: "OWN", single_ownership: true }),
    pool({ name: "OK", _intelScore: { total: 5 } }),
  ], { screening: S });
  assert.deepEqual(r.admitted.map((a) => a.name), ["OK"]);
  assert.deepEqual(r.rejected.map((x) => x.name).sort(), ["HOLD", "MCAP", "OWN", "STEP", "WARN"]);
});

test("rug floor and one pool per base token", () => {
  const r = admitByFeeRate([
    pool({ name: "TINY", tvl: 480, top_performer: true, fee_active_tvl_ratio: 900 }),
    pool({ name: "P1", base: { mint: "M" }, fee_active_tvl_ratio: 0.3 }),
    pool({ name: "P2", base: { mint: "M" }, fee_active_tvl_ratio: 0.1 }),
  ], { screening: S });
  assert.deepEqual(r.admitted.map((a) => a.name), ["P1"]);
  assert.match(r.rejected.find((x) => x.name === "TINY").reason, /rug floor/);
  assert.match(r.rejected.find((x) => x.name === "P2").reason, /same base token/);
});

test("dump rule: −20 % window move rejects unless Top Performer", () => {
  const r = admitByFeeRate([pool({ name: "DUMP", price_change_pct: -25 }), pool({ name: "DIP", price_change_pct: -19 }), pool({ name: "TOPDUMP", price_change_pct: -25, top_performer: true })], { screening: S });
  assert.deepEqual(r.admitted.map((a) => a.name).sort(), ["DIP", "TOPDUMP"]);
  assert.match(r.rejected.find((x) => x.name === "DUMP").reason, /window dump/);
});

test("sub-floor TVL becomes a scout (or a reject when the scout tier is off)", () => {
  const on = admitByFeeRate([pool({ name: "SUB", tvl: 60_000 })], { screening: S });
  assert.equal(on.admitted[0].scout, true);
  const off = admitByFeeRate([pool({ name: "SUB", tvl: 60_000 })], { screening: { ...S, scoutTierEnabled: false } });
  assert.equal(off.admitted.length, 0);
  assert.match(off.rejected[0].reason, /below minTvl/);
});

test("velocity gates apply to every pool — no steady-lane waiver", () => {
  const r = admitByFeeRate([pool({ name: "SLOW", steady_envelope: true, tx_per_min: 0.5 }), pool({ name: "THIN", steady_envelope: true, volume_tvl_ratio: 0.01 })], { screening: S });
  assert.equal(r.admitted.length, 0);
});

test("ranking: fee rate descending, full-size ahead of scouts, top-N cut", () => {
  const r = admitByFeeRate([
    pool({ name: "A", fee_active_tvl_ratio: 0.1 }),                       // 2.4 %/d
    pool({ name: "B", fee_active_tvl_ratio: 0.3 }),                       // 7.2 %/d
    pool({ name: "SC", tvl: 50_000, fee_active_tvl_ratio: 0.9 }),         // scout, 21.6 %/d
    pool({ name: "C", fee_active_tvl_ratio: 0.05, fee_active_tvl_ratio_24h: 4.0 }), // 4.0 %/d (own 24h)
    pool({ name: "D", fee_active_tvl_ratio: 0.2, _intelScore: { total: 99 } }), // 4.8 %/d
  ], { screening: { ...S, rankAdmitCount: 3 } });
  assert.deepEqual(r.admitted.map((a) => a.name), ["B", "D", "C"]);
  assert.match(r.rejected.find((x) => x.name === "A").reason, /ranked #4/);
  assert.match(r.rejected.find((x) => x.name === "SC").reason, /ranked #5/);
});

test("condensePool carries the raw safety flags (null when the feed omits them)", () => {
  const raw = { pool_address: "P", name: "R-SOL", token_x: { symbol: "R" }, token_y: { symbol: "SOL" }, base_token_has_critical_warnings: false, quote_token_has_critical_warnings: true };
  const c = condensePool(raw);
  assert.equal(c.critical_warnings, true);
  assert.equal(c.single_ownership, null);
});

test("the live rank path logs the shadow diff and changes nothing", () => {
  const src = fs.readFileSync(new URL("../tools/screening.js", import.meta.url), "utf8");
  assert.match(src, /admissionShadowEnabled !== false/);
  assert.match(src, /logAdmissionShadow\(admitted, shadow, filteredOut\)/);
  assert.match(src, /\[ADMISSION_SHADOW\] old=/);
  // the shadow runs after captureScreeningSnapshots and only reads `safe`
  assert.ok(src.indexOf("captureScreeningSnapshots(admitted, filteredOut)") < src.indexOf("admitByFeeRate(safe,"));
});
