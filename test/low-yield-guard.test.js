process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const { trackPosition, updatePnlAndCheckExits, closeTrackedPosition, ensureStateInitialized, getTrackedPosition, setPositionHold, recordClaim } = await import("../state.js");
const { parseFeePerTvl24h } = await import("../fee-per-tvl.js");
const G = await import("../low-yield-guard.js");
const { lowYieldMinutes, isValidLowYieldMinutes, advanceLowYieldStreak, claimQuietMinutesAgo, LOW_YIELD_STREAK_GAP_MS, ownFeeRate, solPerBaseFromRow, verifyLowYield, advanceOwnFeeSamples } = G;
const { config } = await import("../config.js");
const { exitFamilyFromReason } = await import("../exit-family.js");
const PR = await import("../perf-record.js");
await ensureStateInitialized();

// Low-yield guard (2026-11-27): a missing feePerTvl24h is null, not 0; no low-yield exit within
// lowYieldClaimQuietMinutes of a fee claim; a low reading must stand lowYieldPersistMinutes on
// ≥ 2 distinct Meteora fetches AND the position's own on-chain fee accrual over
// ≥ lowYieldVerifyMinutes must be under the minimum too. Fail closed.

const SEC = 1000, MIN = 60_000;
const SOL = "So11111111111111111111111111111111111111112";
const BASE = "BaseMint1111111111111111111111111111111111";
const mgmt = {
  trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5,
  stopLossPct: -15, takeProfitPct: 35, twapGuardEnabled: false, roundTripHarvestEnabled: false,
  outOfRangeWaitMinutesAbove: 720, outOfRangeWaitMinutesBelow: 60,
  minFeePerTvl24h: 1, minAgeBeforeYieldCheck: 120, poolHealthMinSnapshots: 3, adoptGraceMinutes: 30,
  lowYieldClaimQuietMinutes: 30, lowYieldPersistMinutes: 10, lowYieldVerifyMinutes: 30,
};
const old = { ...mgmt, lowYieldClaimQuietMinutes: 0, lowYieldPersistMinutes: 0, lowYieldVerifyMinutes: 0 };
// Meteora's cache TTL is 300 s: a reading taken at t carries the stamp of the 5-min bucket.
const bucket = (t) => Math.floor(t / (5 * MIN)) * 5 * MIN;
// A full RPC-valuation row for a SOL-quoted pool. Defaults: dead fees (0 / 0), 1 SOL value.
const row = (fee, nowMs, over = {}) => ({
  pnl_pct: 0.5, effective_pnl_pct: 0.5, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100,
  fee_per_tvl_24h: fee, fee_per_tvl_24h_fetched_at: bucket(nowMs),
  age_minutes: 200, fresh_snapshots: 10, pnl_quality: "valid",
  token_x_mint: BASE, token_y_mint: SOL, token_x_decimals: 6, token_y_decimals: 9, bin_step: 100,
  total_value_sol: 1, fee_x_amount_raw: 0, fee_y_amount_raw: 0, fee_x_amount: 0, fee_y_amount: 0,
  ...over,
});
// The old row shape (no fetch stamp, no fee amounts, no SOL value): what the dlmm.js producers give.
const bareRow = (fee, over = {}) => ({ pnl_pct: 0.5, effective_pnl_pct: 0.5, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100, fee_per_tvl_24h: fee, age_minutes: 200, fresh_snapshots: 10, pnl_quality: "valid", ...over });

function captureLogs(fn) {
  const lines = [];
  const orig = console.error, origLog = console.log;
  console.error = (...a) => { lines.push(a.join(" ")); };
  console.log = (...a) => { lines.push(a.join(" ")); };
  try { fn(); } finally { console.error = orig; console.log = origLog; }
  return lines;
}
function withPos(fn, { adopted = false, name = "SNOW-SOL" } = {}) {
  const P = `LY_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  trackPosition({ position: P, pool: `POOL_${P}`, pool_name: name, strategy: "spot", amount_sol: 1, initial_value_usd: 1, bin_range: [0, 100], active_bin: 50, adopted });
  try { return fn(P, getTrackedPosition(P)); } finally { try { closeTrackedPosition(P, "test"); } catch {} }
}
/** Pre-seed an own-fee history (flat fees) so a test can focus on the other guards. */
const seedFlat = (P, t0, minutes = 60, fx = 0, fy = 0) => {
  getTrackedPosition(P).own_fee_samples = [{ at: new Date(t0 - minutes * MIN).toISOString(), fx, fy }];
};
const ev = (P, fee, nowMs, cfg = mgmt, over = {}) => updatePnlAndCheckExits(P, row(fee, nowMs, over), cfg, { nowMs });
const evBare = (P, fee, nowMs, cfg, over = {}) => updatePnlAndCheckExits(P, bareRow(fee, over), cfg, { nowMs });

// ── parse helper + producer sites ────────────────────────────────────────────
test("parseFeePerTvl24h: missing / non-numeric → null; a real 0 stays 0; rounds to 2 decimals", () => {
  for (const raw of [undefined, null, "", "   ", "abc", NaN, Infinity, -Infinity, {}, [], true, "24.468abc"]) {
    assert.equal(parseFeePerTvl24h(raw), null, `raw=${String(raw)}`);
  }
  assert.equal(parseFeePerTvl24h(0), 0);
  assert.equal(parseFeePerTvl24h("0"), 0);
  assert.equal(parseFeePerTvl24h("0.00"), 0);
  assert.equal(parseFeePerTvl24h("24.468"), 24.47);
  assert.equal(parseFeePerTvl24h(24.468), 24.47);
  assert.equal(parseFeePerTvl24h(" 22.5 "), 22.5);
  assert.ok(Object.is(parseFeePerTvl24h(-0.001), 0), "no negative zero");
  assert.equal(parseFeePerTvl24h({}.feePerTvl24h), null);
});

test("producers: the three parse through the helper; the RPC row carries the fetch stamp, raw fee amounts and a SOL value", () => {
  const pnl = fs.readFileSync(new URL("../tools/pnl.js", import.meta.url), "utf8");
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.match(pnl, /import \{ parseFeePerTvl24h \} from "\.\.\/fee-per-tvl\.js"/);
  assert.match(dlmm, /import \{ parseFeePerTvl24h \} from "\.\.\/fee-per-tvl\.js"/);
  assert.match(pnl, /fee_per_tvl_24h:\s+meteora \? parseFeePerTvl24h\(meteora\.feePerTvl24h\) : null/);
  assert.match(dlmm, /fee_per_tvl_24h:\s+parseFeePerTvl24h\(p\.feePerTvl24h\)/);
  assert.match(dlmm, /fee_per_tvl_24h:\s+binData \? parseFeePerTvl24h\(binData\.feePerTvl24h\) : null/);
  for (const src of [pnl, dlmm]) {
    assert.doesNotMatch(src, /feePerTvl24h \|\| 0/);
    assert.doesNotMatch(src, /safeNum\([a-zA-Z.]*feePerTvl24h\)/);
  }
  const lines = [...pnl.split("\n"), ...dlmm.split("\n")].filter((l) => /fee_per_tvl_24h:/.test(l) && /feePerTvl24h/.test(l));
  assert.equal(lines.length, 3);
  for (const l of lines) assert.match(l, /parseFeePerTvl24h\(/);
  // fetch stamp = the cache entry's `at` for the object the row was built from; only the RPC row has it
  assert.match(pnl, /_meteoraCache\.set\(pool, \{ at, byPosition: data, sigByPosition \}\);\n\s+for \(const obj of Object\.values\(data \|\| \{\}\)\) if \(obj && typeof obj === "object"\) _meteoraFetchedAt\.set\(obj, at\);/);
  assert.match(pnl, /fee_per_tvl_24h_fetched_at: meteora \? meteoraFetchedAt\(meteora\) : null/);
  assert.match(pnl, /total_value_sol:\s+round\(balancesSol, 9\)/);
  assert.match(pnl, /fee_x_amount_raw: Number\.isFinite\(feeXHuman\) \? feeXHuman : null/);
  assert.match(pnl, /fee_y_amount_raw: Number\.isFinite\(feeYHuman\) \? feeYHuman : null/);
  assert.doesNotMatch(dlmm, /fee_per_tvl_24h_fetched_at/, "the dlmm.js rows carry no stamp → they cannot verify");
});

test("a null reading is skipped by the rule (the old producers turned a missing field into 0 and closed)", () => withPos((P) => {
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) assert.equal(evBare(P, parseFeePerTvl24h(undefined), t0 + i * 30 * SEC, old), null);
  assert.equal(getTrackedPosition(P).low_yield_streak ?? null, null);
}));

// ── config ───────────────────────────────────────────────────────────────────
test("config keys: defaults, strict validation, update_config map", () => {
  assert.equal(lowYieldMinutes(undefined, 30), 30);
  assert.equal(lowYieldMinutes(null, 10), 10);
  assert.equal(lowYieldMinutes(0, 10), 0);
  assert.equal(lowYieldMinutes("15", 10), 15);
  assert.equal(lowYieldMinutes(241, 10), 10);
  assert.equal(lowYieldMinutes("  ", 10), 10);
  assert.equal(lowYieldMinutes([5], 10), 10);
  for (const v of [0, 1, 10, 240, "30", " 30 ", 2.5]) assert.equal(isValidLowYieldMinutes(v), true, JSON.stringify(v));
  for (const v of [-1, 240.5, 1000, "abc", "", "   ", null, undefined, NaN, Infinity, true, false, [], [5], {}]) assert.equal(isValidLowYieldMinutes(v), false, JSON.stringify(v));
  for (const k of ["lowYieldClaimQuietMinutes", "lowYieldPersistMinutes", "lowYieldVerifyMinutes"]) assert.ok(isValidLowYieldMinutes(config.management[k]), k);
  assert.deepEqual(G.lowYieldGuardConfig({}), { quietMin: 30, persistMin: 10, verifyMin: 30 });
  const cfgSrc = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfgSrc, /lowYieldVerifyMinutes:\s+lowYieldMinutes\(u\.lowYieldVerifyMinutes, LOW_YIELD_VERIFY_DEFAULT_MIN\)/);
  const ex = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  for (const k of ["lowYieldClaimQuietMinutes", "lowYieldPersistMinutes", "lowYieldVerifyMinutes"]) assert.match(ex, new RegExp(`${k}: \\["management", "${k}"\\]`));
  assert.match(ex, /isValidLowYieldMinutes\(val\)/);
});

// ── the Snowball case, end to end ────────────────────────────────────────────
test("Snowball: fees accruing 140 min, claim, Meteora 0.00 for 60 min while still accruing → never an exit; unverified state records the own rate", () => withPos((P) => {
  const value = 1;              // SOL
  const ratePct = 22.5;         // %/24h, Snowball's pre-claim reading
  const solPerBase = solPerBaseFromRow(row(0, 0)).solPerBase;
  const perMinSol = (value * ratePct / 100) / 1440;
  const fyPerMin = perMinSol / 2, fxPerMin = (perMinSol / 2) / solPerBase;
  const tClaim = Date.now();
  const t0 = tClaim - 140 * MIN;
  const amounts = (since, t) => ({ fee_y_amount_raw: fyPerMin * (t - since) / MIN, fee_x_amount_raw: fxPerMin * (t - since) / MIN });
  for (let t = t0; t < tClaim; t += 30 * SEC) {
    assert.equal(ev(P, t - t0 < 70 * MIN ? 20.07 : 22.5, t, mgmt, amounts(t0, t)), null);
  }
  recordClaim(P, { sol: 0.02 });
  const c = Date.parse(getTrackedPosition(P).last_claim_at);
  assert.equal(getTrackedPosition(P).own_fee_samples, null, "claim resets the own-fee ring");
  let lines = [];
  lines = captureLogs(() => {
    for (let t = c + 7 * SEC; t <= c + 60 * MIN; t += 30 * SEC) {
      assert.equal(ev(P, 0.0, t, mgmt, amounts(c, t)), null, `+${Math.round((t - c) / 1000)}s`);
    }
  });
  assert.equal(lines.filter((l) => l.includes("after a fee claim")).length, 1, "quiet logged once");
  const un = lines.filter((l) => l.includes("[LOW_YIELD_UNVERIFIED]"));
  assert.equal(un.length, 1, "unverified logged once per streak per cause");
  assert.match(un[0], new RegExp(`\\[LOW_YIELD_UNVERIFIED\\] SNOW-SOL ${P.slice(0, 8)}: Meteora fee/TVL 0\\.00% < 1% for 10 min, but the position's own fees over the last \\d+ min equal 22\\.\\d\\d%/24h — not closing`));
  const u = getTrackedPosition(P).low_yield_unverified;
  assert.equal(u.cause, "own_rate");
  assert.equal(u.meteora_pct, 0);
  assert.ok(Math.abs(u.own_pct - ratePct) < 0.2, `own rate ${u.own_pct} ≈ ${ratePct}`);
  assert.ok(u.window_min >= 30);
  assert.ok(u.count > 1);
  assert.ok(getTrackedPosition(P).low_yield_streak, "the streak is kept");
  // the record carries it
  const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/perf-record-sites.json", import.meta.url), "utf8"));
  const c0 = FIX.cases.find((x) => x.site === "close");
  const args = JSON.parse(JSON.stringify(c0.args));
  (args.tracked || args.snapshot).low_yield_unverified = u;
  assert.deepEqual(PR.closePositionPerfRecord(args).low_yield_unverified, u);
}));

test("the old rule (all keys 0, old row shape) closes Snowball 7 s after the claim", () => {
  withPos((Q) => {
    const t0 = Date.now() - 20 * SEC;
    evBare(Q, 20.07, t0, old); evBare(Q, 22.5, t0 + 7 * SEC, old);
    recordClaim(Q, { sol: 0.01 });
    const c = Date.parse(getTrackedPosition(Q).last_claim_at);
    assert.equal(evBare(Q, 0.0, c + 7 * SEC, old)?.action, "LOW_YIELD");
  });
});

// ── dead ladder ──────────────────────────────────────────────────────────────
test("dead ladder: flat fees ≥ 30 min + 0.3 % on ≥ 2 fetches over ≥ 10 min → exit with the verified reason", () => withPos((P) => {
  const t0 = bucket(Date.now()) + 60 * SEC; // 1 min into a fetch bucket
  seedFlat(P, t0, 35, 12.5, 0.004);       // flat, non-zero amounts
  let exit = null;
  for (let s = 0; s < 600; s += 30) {
    exit = ev(P, 0.3, t0 + s * SEC, mgmt, { fee_x_amount_raw: 12.5, fee_y_amount_raw: 0.004, age_minutes: 130 });
    assert.equal(exit, null, `+${s}s`);
  }
  exit = ev(P, 0.31, t0 + 600 * SEC, mgmt, { fee_x_amount_raw: 12.5, fee_y_amount_raw: 0.004, age_minutes: 131 });
  assert.equal(exit?.action, "LOW_YIELD");
  assert.equal(exit.reason, "Low yield: fee/TVL 0.31% < min 1% (age: 131m) — verified: own fees 0.00%/24h over 45m, 3 Meteora fetches over 10m");
  assert.equal(exit.family, "low_yield");
  assert.equal(exit.urgent, false);
  assert.equal(exit.confirm_ticks, null);
  // legacy scanners: the proof adds no "oor" / "below" / "floor" / "volume" / "out of range"
  const suffix = exit.reason.slice(exit.reason.indexOf(" — verified:"));
  for (const bad of ["oor", "below", "floor", "volume", "out of range"]) assert.ok(!suffix.toLowerCase().includes(bad), bad);
  assert.equal(exitFamilyFromReason(exit.reason), "low_yield");
  assert.ok(exit.reason.toLowerCase().startsWith("low yield"), "lessons.js / organic-momentum.js match \"low yield\"");
  assert.ok(!exit.reason.toLowerCase().includes("oor"), "lessons.js negativeEvidence would read 'oor' as out of range");
  // pool-memory.js sets its low-yield cooldown on the exit family (since 2026-11-27; the old exact
  // `close_reason === "low yield"` never matched). The verified reason must still map to low_yield
  // (asserted above); test/low-yield-cooldown.test.js covers the cooldown itself.
  const pm = fs.readFileSync(new URL("../pool-memory.js", import.meta.url), "utf8");
  assert.match(pm, /exitFamily === "low_yield"/);
  assert.doesNotMatch(pm, /close_reason === "low yield"/);
  // index.js's close-efficiency lowyield-cost line keys on the action, not the reason
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /exit\.action === "LOW_YIELD"/);
}));

test("dead ladder with ONE Meteora fetch stamp for 20 min → no exit until a second fetch", () => withPos((P) => {
  const t0 = Date.now();
  seedFlat(P, t0, 60);
  const lines = captureLogs(() => {
    for (let s = 0; s <= 20 * 60; s += 30) assert.equal(ev(P, 0.3, t0 + s * SEC, mgmt, { fee_per_tvl_24h_fetched_at: 1234 }), null, `+${s}s`);
  });
  const un = lines.filter((l) => l.includes("[LOW_YIELD_UNVERIFIED]"));
  assert.equal(un.length, 1);
  assert.match(un[0], /cannot verify \(one Meteora fetch only\) — not closing$/);
  assert.equal(getTrackedPosition(P).low_yield_unverified.cause, "one Meteora fetch only");
  const e = ev(P, 0.3, t0 + 20 * MIN + 30 * SEC, mgmt, { fee_per_tvl_24h_fetched_at: 5678 });
  assert.equal(e?.action, "LOW_YIELD");
  assert.match(e.reason, /— verified: own fees 0\.00%\/24h over \d+m, 2 Meteora fetches over 0m$/);
}));

test("dead ladder with own-fee history < 30 min → no exit until 30 min", () => withPos((P) => {
  const t0 = Date.now();
  const lines = captureLogs(() => {
    for (let s = 0; s < 30 * 60; s += 30) assert.equal(ev(P, 0.3, t0 + s * SEC), null, `+${s}s`);
  });
  assert.ok(lines.some((l) => /\[LOW_YIELD_UNVERIFIED\] .*cannot verify \(own-fee history 10 min < 30\) — not closing/.test(l)), lines.filter((l) => l.includes("UNVERIFIED")).join("\n"));
  assert.equal(ev(P, 0.3, t0 + 30 * MIN)?.action, "LOW_YIELD");
}));

// ── price-move immunity ──────────────────────────────────────────────────────
test("price-move immunity: flat or slightly rising fee amounts while the bin falls 30 bins → never a negative own rate", () => {
  const t0 = Date.parse("2026-11-27T10:00:00Z");
  let ring = null;
  for (let m = 0; m <= 60; m += 1) {
    const r = row(0, t0 + m * MIN, { active_bin: 50 - Math.round(m / 2), fee_x_amount_raw: 100 + m * 0.001, fee_y_amount_raw: 0.01 });
    ring = advanceOwnFeeSamples(ring, { fx: r.fee_x_amount_raw, fy: r.fee_y_amount_raw, nowMs: t0 + m * MIN }).ring;
    const { ownPct } = ownFeeRate({ ring, fx: r.fee_x_amount_raw, fy: r.fee_y_amount_raw, solPerBase: solPerBaseFromRow(r).solPerBase, valueSol: 1, nowMs: t0 + m * MIN });
    if (ownPct != null) assert.ok(ownPct >= 0, `m=${m} own ${ownPct}`);
  }
  assert.equal(ring.length, 13, "one sample per 5 min");
});

test("an earning position (own rate ≥ min) is not closed whatever Meteora says, even while the price falls", () => withPos((P) => {
  const t0 = Date.now();
  // own rate ≈ 5 %/24h at the CURRENT price from the y side alone (price cannot affect fy)
  const fyPerMin = (1 * 0.05) / 1440;
  const lines = captureLogs(() => {
    for (let s = 0; s <= 90 * 60; s += 30) {
      const t = t0 + s * SEC;
      assert.equal(ev(P, 0.0, t, mgmt, { active_bin: 50 - Math.floor(s / 180), fee_y_amount_raw: fyPerMin * s / 60, fee_x_amount_raw: 3 }), null, `+${s}s`);
    }
  });
  const u = getTrackedPosition(P).low_yield_unverified;
  assert.equal(u.cause, "own_rate");
  assert.ok(u.own_pct >= 4.9, String(u.own_pct));
  assert.ok(lines.some((l) => l.includes("[LOW_YIELD_UNVERIFIED]") && l.includes("own fees over the last")));
}));

// ── claims the bot did not record ───────────────────────────────────────────
test("operator-UI claim (amounts drop to ~0, no recordClaim), Meteora 0.00 for 20 min → no exit; quiet period from the drop", () => withPos((P) => {
  const t0 = Date.now() - 60 * MIN;
  for (let m = 0; m < 60; m += 1) ev(P, 15, t0 + m * MIN, mgmt, { fee_x_amount_raw: 50 + m, fee_y_amount_raw: 0.001 * m });
  assert.ok(getTrackedPosition(P).own_fee_samples.length >= 12);
  const tDrop = t0 + 60 * MIN;
  let lines = captureLogs(() => {
    for (let s = 0; s <= 20 * 60; s += 30) assert.equal(ev(P, 0.0, tDrop + s * SEC, mgmt, { fee_x_amount_raw: 0.0001 * s, fee_y_amount_raw: 0 }), null, `+${s}s`);
  });
  const pos = getTrackedPosition(P);
  assert.equal(pos.own_fee_reset_at, new Date(tDrop).toISOString());
  assert.ok(lines.some((l) => l.includes("dropped (claim or re-range)")));
  assert.ok(lines.some((l) => l.includes("after a fee claim — waiting 30 min")), "the drop starts the quiet period");
  assert.equal(pos.low_yield_streak ?? null, null);
  assert.equal(pos.own_fee_samples[0].at, new Date(tDrop).toISOString(), "ring restarted at the drop");
  // a dead position after the drop: closes only once quiet (30) + persistence (10) have passed
  for (let m = 21; m < 40; m += 1) assert.equal(ev(P, 0.0, tDrop + m * MIN, mgmt, { fee_x_amount_raw: 0.12, fee_y_amount_raw: 0 }), null, `+${m}m`);
  assert.equal(ev(P, 0.0, tDrop + 40 * MIN, mgmt, { fee_x_amount_raw: 0.12, fee_y_amount_raw: 0 })?.action, "LOW_YIELD");
}));

// ── cannot verify → no exit ─────────────────────────────────────────────────
for (const [label, over, cause, posOver] of [
  ["non-SOL-quoted pool", { token_y_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, "not SOL-quoted"],
  ["SOL as token X", { token_x_mint: SOL, token_y_mint: BASE }, "not SOL-quoted"],
  ["missing bin step", { bin_step: null }, "no pool price"],
  ["missing active bin", { active_bin: null, in_range: true }, "no pool price"],
  ["missing value and capital", { total_value_sol: null }, "no position value", { amount_sol: null }],
  ["zero value and capital", { total_value_sol: 0 }, "no position value", { amount_sol: 0 }],
  ["no fee amounts", { fee_x_amount_raw: undefined, fee_x_amount: undefined }, "no fee amounts"],
]) {
  test(`cannot verify (${label}) → no exit, cause recorded`, () => withPos((P) => {
    const t0 = Date.now();
    seedFlat(P, t0, 60);
    if (posOver) Object.assign(getTrackedPosition(P), posOver);
    for (let s = 0; s <= 30 * 60; s += 60) assert.equal(ev(P, 0.3, t0 + s * SEC, mgmt, over), null, `+${s}s`);
    assert.equal(getTrackedPosition(P).low_yield_unverified?.cause, cause);
  }));
}

// ── the denominator cannot be inflated ──────────────────────────────────────
test("denominator = min(total_value_sol, amount_sol): a value read ×100 cannot make a 24 %/day earner verify", () => {
  withPos((P) => {
    const t0 = Date.now();
    const fyPerMin = (1 * 0.24) / 1440; // 24 %/day on the 1 SOL capital
    for (let s = 0; s <= 60 * 60; s += 30) {
      assert.equal(ev(P, 0.0, t0 + s * SEC, mgmt, { total_value_sol: 100, fee_y_amount_raw: fyPerMin * s / 60, fee_x_amount_raw: 0 }), null, `+${s}s`);
    }
    const u = getTrackedPosition(P).low_yield_unverified;
    assert.equal(u.cause, "own_rate");
    assert.ok(Math.abs(u.own_pct - 24) < 0.1, String(u.own_pct));
  });
  withPos((P) => {
    const t0 = Date.now();
    seedFlat(P, t0, 60);
    for (let s = 0; s < 600; s += 30) assert.equal(ev(P, 0.3, t0 + s * SEC, mgmt, { total_value_sol: 100 }), null);
    assert.equal(ev(P, 0.3, t0 + 600 * SEC, mgmt, { total_value_sol: 100 })?.action, "LOW_YIELD", "a dead ladder still closes");
  });
  assert.equal(G.ownFeeDenominatorSol(100, 1), 1);
  assert.equal(G.ownFeeDenominatorSol(0.5, 1), 0.5);
  assert.equal(G.ownFeeDenominatorSol(null, 1), 1);
  assert.equal(G.ownFeeDenominatorSol(2, null), 2);
  assert.equal(G.ownFeeDenominatorSol(0, 0), null);
  assert.equal(G.ownFeeDenominatorSol(undefined, "abc"), null);
});

// ── only a usable reading can verify ─────────────────────────────────────────
for (const [label, rowOver, posSet] of [
  ["pnl_pct_suspicious", { pnl_pct_suspicious: true }, null],
  ["flow_pending on the row", { flow_pending: true }, null],
  ["pending_flow on the position", {}, () => ({ pending_flow: { at: new Date().toISOString(), net_sol_expected: 1, kind: "test" } })],
  // a trusted reading settles a pending capital re-base before step 10, so it only survives
  // to step 10 on a reading the re-base cannot settle on (here: no PnL figure)
  ["capital_rebase_pending", { pnl_pct: undefined, effective_pnl_pct: undefined }, () => ({ capital_rebase_pending: { from_sol: 1, to_sol: 1.5, delta_sol: 0.5, peak_before: 0, peak_rescaled: 0 } })],
]) {
  test(`valuation not ready (${label}) → cannot verify, no exit, streak kept; closes once the reading is usable`, () => withPos((P) => {
    const t0 = Date.now();
    seedFlat(P, t0, 60);
    if (posSet) Object.assign(getTrackedPosition(P), posSet());
    const lines = captureLogs(() => {
      for (let s = 0; s <= 15 * 60; s += 30) assert.equal(ev(P, 0.3, t0 + s * SEC, mgmt, rowOver), null, `+${s}s`);
    });
    assert.equal(getTrackedPosition(P).low_yield_unverified?.cause, "valuation not ready");
    assert.ok(lines.some((l) => l.includes("cannot verify (valuation not ready) — not closing")));
    assert.ok(getTrackedPosition(P).low_yield_streak, "streak kept");
    if (posSet) for (const k of Object.keys(posSet())) getTrackedPosition(P)[k] = null;
    assert.equal(ev(P, 0.3, t0 + 15 * MIN + 30 * SEC)?.action, "LOW_YIELD");
  }));
}

test("pnl_management_ready === false: the evaluator returns before step 10 (no streak, no sample)", () => withPos((P) => {
  const t0 = Date.now();
  for (let s = 0; s <= 20 * 60; s += 60) assert.equal(ev(P, 0.3, t0 + s * SEC, mgmt, { pnl_management_ready: false }), null);
  assert.equal(getTrackedPosition(P).low_yield_streak ?? null, null);
  assert.equal(getTrackedPosition(P).own_fee_samples ?? null, null);
}));

test("rows without fee_per_tvl_24h_fetched_at (the dlmm.js producers) → no exit", () => withPos((P) => {
  const t0 = Date.now();
  seedFlat(P, t0, 60);
  for (let s = 0; s <= 40 * 60; s += 60) assert.equal(ev(P, 0.3, t0 + s * SEC, mgmt, { fee_per_tvl_24h_fetched_at: undefined }), null);
  assert.equal(getTrackedPosition(P).low_yield_unverified.cause, "one Meteora fetch only");
  assert.equal(getTrackedPosition(P).low_yield_streak.fetches, 0);
  // the bare old row shape cannot verify either
  withPos((Q) => {
    for (let s = 0; s <= 40 * 60; s += 60) assert.equal(evBare(Q, 0.3, t0 + s * SEC, mgmt), null);
    assert.equal(getTrackedPosition(Q).low_yield_unverified.cause, "no fee amounts");
  });
}));

// ── old behaviour with every key at 0 ───────────────────────────────────────
test("all three keys 0 reproduce the old rule exactly: first qualifying evaluation, right after a claim, old row shape", () => withPos((P) => {
  const t0 = Date.now();
  assert.equal(evBare(P, 0.3, t0, old, { age_minutes: 119 }), null, "age gate unchanged");
  recordClaim(P, { sol: 0.01 });
  const e = evBare(P, 0.3, Date.parse(getTrackedPosition(P).last_claim_at) + 1 * SEC, old, { age_minutes: 120 });
  assert.equal(e?.action, "LOW_YIELD");
  assert.equal(e.reason, "Low yield: fee/TVL 0.30% < min 1% (age: 120m)", "no proof appended");
  withPos((Q) => {
    recordClaim(Q, { sol: 0.01 });
    assert.equal(ev(Q, 0.3, Date.parse(getTrackedPosition(Q).last_claim_at) + 1 * SEC, mgmt, { age_minutes: 120 }), null, "the defaults wait");
  });
}));

test("verify off, persist on: the fetch requirement still applies; persist off, verify on: own fees decide", () => {
  withPos((P) => {
    const cfg = { ...mgmt, lowYieldVerifyMinutes: 0, lowYieldClaimQuietMinutes: 0 };
    const t0 = Date.now();
    for (let s = 0; s <= 15 * 60; s += 60) assert.equal(ev(P, 0.3, t0 + s * SEC, cfg, { fee_per_tvl_24h_fetched_at: 1 }), null);
    const e = ev(P, 0.3, t0 + 16 * MIN, cfg, { fee_per_tvl_24h_fetched_at: 2 });
    assert.equal(e?.action, "LOW_YIELD");
    assert.match(e.reason, /\(age: 200m\) — verified: 2 Meteora fetches over 0m$/);
  });
  withPos((P) => {
    const cfg = { ...mgmt, lowYieldPersistMinutes: 0, lowYieldClaimQuietMinutes: 0 };
    const t0 = Date.now();
    seedFlat(P, t0, 31);
    const e = ev(P, 0.3, t0, cfg, { fee_per_tvl_24h_fetched_at: undefined });
    assert.equal(e?.action, "LOW_YIELD", "persist 0 = no fetch-count requirement");
    assert.match(e.reason, /— verified: own fees 0\.00%\/24h over 31m$/);
  });
});

// ── streak rules (with verification satisfied) ──────────────────────────────
test("a null reading mid-streak neither fires nor resets", () => withPos((P) => {
  const t0 = Date.now();
  seedFlat(P, t0);
  ev(P, 0.3, t0);
  for (let s = 30; s <= 9 * 60; s += 30) assert.equal(ev(P, null, t0 + s * SEC), null);
  const st = getTrackedPosition(P).low_yield_streak;
  assert.equal(st.since, new Date(t0).toISOString());
  assert.equal(st.readings, 1, "a null reading does not count");
  assert.equal(ev(P, null, t0 + 10 * MIN), null, "a null reading never fires");
  assert.equal(ev(P, 0.4, t0 + 10 * MIN + 5 * SEC)?.action, "LOW_YIELD");
}));

test("a reading at or above the minimum resets the streak", () => withPos((P) => {
  const t0 = Date.now();
  seedFlat(P, t0);
  ev(P, 0.3, t0);
  ev(P, 0.3, t0 + 5 * MIN);
  assert.equal(ev(P, 1.0, t0 + 6 * MIN), null);
  assert.equal(getTrackedPosition(P).low_yield_streak, null);
  assert.equal(ev(P, 0.3, t0 + 7 * MIN), null);
  assert.equal(ev(P, 0.3, t0 + 16 * MIN), null, "9 min since the new start");
  assert.equal(ev(P, 0.3, t0 + 17 * MIN)?.action, "LOW_YIELD");
}));

test("a gap of more than 15 min restarts the streak", () => withPos((P) => {
  const t0 = Date.now();
  seedFlat(P, t0);
  ev(P, 0.3, t0);
  ev(P, 0.3, t0 + 2 * MIN);
  const restart = t0 + 2 * MIN + LOW_YIELD_STREAK_GAP_MS + SEC;
  const lines = captureLogs(() => assert.equal(ev(P, 0.3, restart), null, "restarted, not fired"));
  assert.ok(lines.some((l) => l.includes("Low-yield reading for")), "restart logs the start again");
  assert.equal(getTrackedPosition(P).low_yield_streak.since, new Date(restart).toISOString());
  assert.equal(ev(P, 0.3, restart + 9 * MIN), null);
  assert.equal(ev(P, 0.3, restart + 10 * MIN)?.action, "LOW_YIELD");
  withPos((Q) => {
    ev(Q, 0.3, t0);
    ev(Q, 0.3, t0 + LOW_YIELD_STREAK_GAP_MS);
    assert.equal(getTrackedPosition(Q).low_yield_streak.since, new Date(t0).toISOString(), "exactly 15 min continues");
  });
}));

test("setting HOLD clears the streak and the own-fee ring", () => withPos((P) => {
  const t0 = Date.now();
  seedFlat(P, t0);
  ev(P, 0.3, t0);
  ev(P, 0.3, t0 + 8 * MIN);
  setPositionHold(P, true, "test");
  assert.equal(getTrackedPosition(P).low_yield_streak, null);
  assert.equal(getTrackedPosition(P).own_fee_samples, null);
  assert.equal(ev(P, 0.3, t0 + 11 * MIN), null, "held");
  setPositionHold(P, false);
  for (let m = 12; m < 42; m += 1) assert.equal(ev(P, 0.3, t0 + m * MIN), null, `+${m}m: own-fee history rebuilds from the release`);
  assert.equal(ev(P, 0.3, t0 + 42 * MIN)?.action, "LOW_YIELD");
}));

test("a claim mid-streak clears it, resets the ring and starts the quiet period", () => withPos((P) => {
  const t0 = Date.now() - 8 * MIN;
  seedFlat(P, t0);
  ev(P, 0.3, t0);
  ev(P, 0.3, t0 + 7 * MIN);
  recordClaim(P, { sol: 0.001 });
  assert.equal(getTrackedPosition(P).low_yield_streak, null);
  const c = Date.parse(getTrackedPosition(P).last_claim_at);
  for (let m = 0; m < 40; m += 1) assert.equal(ev(P, 0.3, c + m * MIN + SEC), null, `+${m} min after the claim`);
  assert.equal(getTrackedPosition(P).low_yield_streak.since, new Date(c + 30 * MIN + SEC).toISOString(), "streak starts when the quiet period ends");
  assert.equal(ev(P, 0.3, c + 40 * MIN + SEC)?.action, "LOW_YIELD");
}));

// ── existing suppressions unchanged ──────────────────────────────────────────
test("adoption grace still suppresses the rule (and its log), no streak", () => withPos((P) => {
  const t0 = Date.now();
  const lines = captureLogs(() => {
    for (let m = 0; m <= 20; m += 1) assert.equal(ev(P, 0.3, t0 + m * MIN), null);
  });
  assert.ok(lines.some((l) => l.includes(`Low-yield exit suppressed for ${P.slice(0, 8)} (0.30% < 1%): adoption grace (`)));
  assert.equal(getTrackedPosition(P).low_yield_streak ?? null, null);
  assert.equal(evBare(P, 0.3, t0 + 21 * MIN, old), null);
  getTrackedPosition(P).adopted_at = new Date(Date.now() - 31 * MIN).toISOString();
  assert.equal(evBare(P, 0.3, t0 + 22 * MIN, old)?.action, "LOW_YIELD");
}, { adopted: true }));

test("thin history still suppresses the rule, no streak", () => withPos((P) => {
  const t0 = Date.now();
  const lines = captureLogs(() => {
    for (let m = 0; m <= 20; m += 1) assert.equal(ev(P, 0.3, t0 + m * MIN, mgmt, { fresh_snapshots: 2 }), null);
  });
  assert.ok(lines.some((l) => l.includes("thin history (2/3 snapshots)")));
  assert.equal(getTrackedPosition(P).low_yield_streak ?? null, null);
  assert.equal(evBare(P, 0.3, t0 + 21 * MIN, old, { fresh_snapshots: 2 }), null);
  assert.equal(evBare(P, 0.3, t0 + 22 * MIN, old, { fresh_snapshots: 3 })?.action, "LOW_YIELD");
}));

// ── nothing else changes ─────────────────────────────────────────────────────
test("another exit (stop loss) is unaffected by the new fields", () => {
  const run = (cfg, fee, mk) => withPos((P) => {
    const t0 = Date.now();
    return [
      mk(P, fee, t0, cfg),
      mk(P, fee, t0 + 2 * MIN, cfg, { pnl_pct: -5, effective_pnl_pct: -5 }),
      mk(P, fee, t0 + 4 * MIN, cfg, { pnl_pct: -16, effective_pnl_pct: -16 }),
    ];
  });
  const a = run(mgmt, 0.3, ev);     // a low-yield streak and own-fee sampling running underneath
  const b = run(old, 5, evBare);    // no low yield, guards off, old row shape
  assert.deepEqual(a.slice(0, 2), [null, null]);
  assert.equal(a[2]?.action, "STOP_LOSS");
  assert.deepEqual(a, b);
});

// ── strict restriction (seeded random sequences vs the pre-change rule) ─────
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// The pre-change rule (reading < min, age gate, adoption grace, thin history → fire).
function referenceFires(r, cfg, pos, wallNowMs) {
  const fee = r.fee_per_tvl_24h;
  if (fee == null || cfg.minFeePerTvl24h == null || !(fee < cfg.minFeePerTvl24h)) return false;
  if (!(r.age_minutes == null || r.age_minutes >= (cfg.minAgeBeforeYieldCheck ?? 60))) return false;
  const graceMin = cfg.adoptGraceMinutes ?? 30;
  const inGrace = !!pos.adopted && pos.adopted_at != null && graceMin > 0 && (wallNowMs - new Date(pos.adopted_at).getTime()) < graceMin * 60_000;
  const thin = r.fresh_snapshots != null && r.fresh_snapshots < (cfg.poolHealthMinSnapshots ?? 3);
  return !inGrace && !thin;
}

test("strict restriction: over seeded random sequences the new rule never returns LOW_YIELD where the old one would not", () => {
  const rnd = mulberry32(20261127);
  let newFires = 0, refFires = 0, steps = 0;
  for (let run = 0; run < 50; run++) {
    const cfgChoices = [mgmt, old, { ...mgmt, lowYieldVerifyMinutes: 0 }, { ...mgmt, lowYieldPersistMinutes: 0 }, { ...mgmt, lowYieldClaimQuietMinutes: 0 }, { ...mgmt, lowYieldPersistMinutes: 2, lowYieldVerifyMinutes: 5, lowYieldClaimQuietMinutes: 3 }];
    const cfg = cfgChoices[Math.floor(rnd() * cfgChoices.length)];
    withPos((P) => {
      let t = Date.now() - 6 * 60 * MIN;
      let fx = rnd() * 10, fy = rnd() * 0.01;
      let stamp = 1;
      for (let i = 0; i < 120; i++) {
        t += Math.floor(rnd() * 8 * MIN) + 5 * SEC;
        if (rnd() < 0.03) t += 20 * MIN; // gap
        if (rnd() < 0.15) stamp += 1;
        const dice = rnd();
        if (dice < 0.04) { recordClaim(P, { sol: 0.001 }); fx = 0; fy = 0; continue; }
        if (dice < 0.07) { fx *= 0.1; fy *= 0.1; } // a claim the bot did not see
        if (dice > 0.97) { setPositionHold(P, true, "rnd"); setPositionHold(P, false); }
        if (rnd() < 0.5) { fx += rnd() * 0.01; fy += rnd() * 0.00001; }
        const feeRoll = rnd();
        const fee = feeRoll < 0.1 ? null : feeRoll < 0.6 ? Math.round(rnd() * 100) / 100 : feeRoll < 0.75 ? 0 : rnd() * 30;
        const over = {
          age_minutes: Math.floor(rnd() * 400),
          fresh_snapshots: rnd() < 0.1 ? 1 : 10,
          fee_x_amount_raw: rnd() < 0.05 ? undefined : fx,
          fee_x_amount: rnd() < 0.05 ? undefined : fx,
          fee_y_amount_raw: fy,
          fee_per_tvl_24h_fetched_at: rnd() < 0.1 ? undefined : stamp,
          active_bin: 50 - Math.floor(rnd() * 60),
          bin_step: rnd() < 0.05 ? null : 100,
          total_value_sol: rnd() < 0.05 ? 0 : 0.2 + rnd(),
          token_y_mint: rnd() < 0.05 ? BASE : SOL,
        };
        const r = row(fee, t, over);
        const ref = referenceFires(r, cfg, getTrackedPosition(P), Date.now());
        const e = updatePnlAndCheckExits(P, r, cfg, { nowMs: t });
        steps++;
        if (ref) refFires++;
        if (e?.action === "LOW_YIELD") {
          newFires++;
          assert.ok(ref, `run ${run} step ${i}: LOW_YIELD where the old rule would not fire`);
        }
      }
    }, { adopted: rnd() < 0.2 });
  }
  assert.ok(steps > 3000 && refFires > 100 && newFires > 5, `coverage: steps ${steps}, reference fires ${refFires}, new fires ${newFires}`);
});

// ── pure helpers ─────────────────────────────────────────────────────────────
test("pure helpers: streak, quiet period, own-fee ring and rate, verification order", () => {
  const t = Date.parse("2026-11-27T12:00:00Z");
  let r = advanceLowYieldStreak(null, { reading: 0.5, nowMs: t, persistMin: 10, fetchedAt: 100 });
  assert.deepEqual({ ...r.streak, unverified_causes: undefined }, { since: "2026-11-27T12:00:00.000Z", last_at: "2026-11-27T12:00:00.000Z", readings: 1, min_value: 0.5, fetches: 1, first_fetch_at: 100, last_fetch_at: 100, unverified_causes: undefined });
  assert.equal(r.started, true); assert.equal(r.persisted, false);
  r = advanceLowYieldStreak(r.streak, { reading: 0.2, nowMs: t + 5 * MIN, persistMin: 10, fetchedAt: 100 });
  assert.equal(r.streak.fetches, 1, "same stamp = same fetch");
  r = advanceLowYieldStreak(r.streak, { reading: 0.2, nowMs: t + 10 * MIN, persistMin: 10, fetchedAt: 400 });
  assert.equal(r.persisted, true); assert.equal(r.streak.readings, 3); assert.equal(r.streak.min_value, 0.2); assert.equal(r.streak.fetches, 2);
  assert.equal(advanceLowYieldStreak(null, { reading: 0, nowMs: t, persistMin: 0 }).persisted, true);
  assert.equal(claimQuietMinutesAgo(null, 30, t), null);
  assert.equal(claimQuietMinutesAgo(["2026-11-27T11:45:00Z", null], 30, t), 15);
  assert.equal(claimQuietMinutesAgo(["2026-11-27T11:00:00Z", "2026-11-27T11:50:00Z"], 30, t), 10, "the later stamp");
  assert.equal(claimQuietMinutesAgo("2026-11-27T11:30:00Z", 30, t), null);
  assert.equal(claimQuietMinutesAgo("2026-11-27T11:59:00Z", 0, t), null);
  assert.equal(claimQuietMinutesAgo("garbage", 30, t), null);
  // ring
  let ring = advanceOwnFeeSamples(null, { fx: 1, fy: 1, nowMs: t }).ring;
  assert.equal(advanceOwnFeeSamples(ring, { fx: 1.1, fy: 1, nowMs: t + 4 * MIN }).changed, false, "≤ 1 per 5 min");
  ring = advanceOwnFeeSamples(ring, { fx: 1.1, fy: 1, nowMs: t + 5 * MIN }).ring;
  assert.equal(ring.length, 2);
  const dec = advanceOwnFeeSamples(ring, { fx: 1.1, fy: 0.5, nowMs: t + 6 * MIN });
  assert.equal(dec.decreased, true); assert.equal(dec.ring.length, 1);
  let big = null;
  for (let i = 0; i < 40; i++) big = advanceOwnFeeSamples(big, { fx: i, fy: i, nowMs: t + i * 5 * MIN }).ring;
  assert.equal(big.length, 30, "capped");
  // rate: 0.01 SOL over 60 min on 1 SOL = 24 %/24h
  const rate = ownFeeRate({ ring: [{ at: new Date(t).toISOString(), fx: 0, fy: 0 }], fx: 0, fy: 0.01, solPerBase: 1, valueSol: 1, nowMs: t + 60 * MIN });
  assert.ok(Math.abs(rate.ownPct - 24) < 1e-9); assert.equal(rate.windowMin, 60);
  // verification: own-rate before the fetch count; fetch count only when persist > 0
  const base = row(0.3, t);
  const flatRing = [{ at: new Date(t - 40 * MIN).toISOString(), fx: 0, fy: 0 }];
  assert.equal(verifyLowYield({ streak: { fetches: 1 }, row: base, ring: flatRing, minPct: 1, persistMin: 10, verifyMin: 30, nowMs: t }).causeKey, "one_fetch");
  assert.equal(verifyLowYield({ streak: { fetches: 1 }, row: base, ring: flatRing, minPct: 1, persistMin: 0, verifyMin: 30, nowMs: t }).verified, true);
  assert.equal(verifyLowYield({ streak: { fetches: 0 }, row: {}, ring: null, minPct: 1, persistMin: 0, verifyMin: 0, nowMs: t }).verified, true, "all off");
  assert.equal(G.lowYieldProofSuffix({ ownPct: null, fetches: 0 }, { persistMin: 0, verifyMin: 0 }), "");
});
