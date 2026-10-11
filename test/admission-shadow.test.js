process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { feeRate24hEq, admitByFeeRate, condensePool, quoteTokenRejectReason } = await import("../tools/screening.js");

const S = { timeframe: "1h", minTvl: 100_000, minBinStep: 80, maxBinStep: 125, minVolumeTvlRatio: 0.05, minTxPerMin: 2, scoutTierEnabled: true, rankAdmitCount: 5 };
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const pool = (over) => ({ name: "X-SOL", pool: `P${Math.random().toString(36).slice(2, 8)}`, quote: { symbol: "SOL", mint: SOL }, tvl: 150_000, holders: 900, mcap: 800_000, bin_step: 100, fee_active_tvl_ratio: 0.2, volume_tvl_ratio: 0.5, tx_per_min: 10, price_change_pct: 3, ...over });

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

test("the live rank path admits through admitByFeeRate and the old admission code is gone", () => {
  const src = fs.readFileSync(new URL("../tools/screening.js", import.meta.url), "utf8");
  assert.match(src, /const ranked = admitByFeeRate\(safe, \{ screening: s, limit: Math\.min\(admitCount, limit \|\| admitCount\) \}\);/);
  assert.match(src, /gates: survivors,/);
  for (const gone of ["computeAdmissionScore", "prescoreRankCandidates", "enrichSafetyInputs", "getGmgnDevInfo", "hasCleanPoolHistory", "rankMinIntelScore", "rankSteadyMinIntel", "scoutMinIntel", "getSteadyLaneHint", "TVL_EXEMPT", "isRebalanceTrendIncreasing"]) {
    assert.ok(!src.includes(gone + "("), `${gone} must no longer be called in screening.js`);
  }
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  for (const gone of ["hasCleanPoolHistory(", "getSteadyLaneHint(", "[TVL_EXEMPT]", "steadyLaneVelocityWaiver"]) assert.ok(!exec.includes(gone), `${gone} must be gone from the executor`);
});

// ── SOL-quote rule (2026-10-11): CLAUDIA-USDC reached deploy_position with "0.4 Y" = USDC ──
test("SOL-quote rule: only pools whose token Y is wrapped SOL are admitted", () => {
  const r = admitByFeeRate([
    pool({ name: "CLAUDIA-USDC", top_performer: true, fee_active_tvl_ratio: 5, base: { symbol: "CLAUDIA", mint: "2j5S" }, quote: { symbol: "USDC", mint: USDC } }),
    pool({ name: "SOL-USDC", base: { symbol: "SOL", mint: SOL }, quote: { symbol: "USDC", mint: USDC } }),
    pool({ name: "SOL-MEME", base: { symbol: "SOL", mint: SOL }, quote: { symbol: "MEME", mint: "MemeMint" } }),
    pool({ name: "NOQUOTE", quote: undefined }),
    pool({ name: "NOMINT", quote: { symbol: "SOL" } }),
    pool({ name: "OK-SOL", base: { symbol: "OK", mint: "OkMint" } }),
  ], { screening: S });
  assert.deepEqual(r.admitted.map((a) => a.name), ["OK-SOL"]);
  const why = (n) => r.rejected.find((x) => x.name === n).reason;
  assert.equal(why("CLAUDIA-USDC"), "quote token is not SOL (USDC)");
  assert.equal(why("SOL-USDC"), "quote token is not SOL (USDC; SOL is the base token)");
  assert.equal(why("SOL-MEME"), "quote token is not SOL (MEME; SOL is the base token)");
  assert.match(why("NOQUOTE"), /quote token mint unknown/);
  assert.match(why("NOMINT"), /quote token mint unknown/); // a "SOL" symbol alone proves nothing
});

test("SOL-quote rule reads the discovery row's own mints, condensed or raw", () => {
  const raw = (x, y) => ({ pool_address: "P", name: `${x.symbol}-${y.symbol}`, token_x: x, token_y: y });
  const claudia = raw({ symbol: "CLAUDIA", address: "2j5S" }, { symbol: "USDC", address: USDC });
  assert.equal(quoteTokenRejectReason(claudia), "quote token is not SOL (USDC)");            // executor (raw row)
  assert.equal(quoteTokenRejectReason(condensePool(claudia)), "quote token is not SOL (USDC)"); // admission / opportunity poll
  const ok = raw({ symbol: "X", address: "XMint" }, { symbol: "SOL", address: SOL });
  assert.equal(quoteTokenRejectReason(ok), null);
  assert.equal(quoteTokenRejectReason(condensePool(ok)), null);
  assert.match(quoteTokenRejectReason(raw({ symbol: "X", address: "XMint" }, { symbol: "SOL" })), /unknown/);
  assert.match(quoteTokenRejectReason(null), /unknown/);
  // No symbol: the reason still names the mint.
  assert.equal(quoteTokenRejectReason({ quote: { mint: USDC } }), "quote token is not SOL (EPjF…)");
});

test("SOL-quote rule is wired into every layer", () => {
  const scr = fs.readFileSync(new URL("../tools/screening.js", import.meta.url), "utf8");
  // Safety gates: first check, pushed into the funnel's rejects.
  assert.match(scr, /return pools\.filter\(\(p\) => \{\n\s+\/\/[^\n]*\n\s+const quoteReject = quoteTokenRejectReason\(p\);\n\s+if \(quoteReject\) \{\n\s+pushFilteredReason\(filteredOut, p, quoteReject\);/);
  // Opportunity poll: a non-SOL-quoted candidate cannot trigger a screening cycle.
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /const candidates = \(top\?\.candidates \|\| \[\]\)\.filter\(\(c\) => !quoteTokenRejectReason\(c\)\)/);
  // Executor: checked on the fresh pool row before any other threshold, for deploys and rebalances.
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  const fn = exec.slice(exec.indexOf("async function validateDeployPoolThresholds"));
  assert.ok(fn.indexOf("quoteTokenRejectReason(detail)") > 0 && fn.indexOf("quoteTokenRejectReason(detail)") < fn.indexOf("poolDetailTvl(detail)"));
  // Deployer and the close-and-reopen straddle: last-line checks on the on-chain mint.
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const dep = dlmm.slice(dlmm.indexOf("export async function deployPosition("), dlmm.indexOf("const activeBin = await pool.getActiveBin();", dlmm.indexOf("export async function deployPosition(")));
  assert.match(dep, /if \(quoteMint !== config\.tokens\.SOL\) \{/);
  assert.match(dlmm, /if \(straddle && pool\.lbPair\.tokenYMint\.toString\(\) !== config\.tokens\.SOL\)/);
});
