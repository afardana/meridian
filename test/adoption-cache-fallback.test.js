process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { buildAdoptionBasis, applyAdoptionBasis, adoptionPrePnlSol } = await import("../state.js");
const { cacheFallbackRecordFields, rebaseCloseToAdoption, cacheValuationIsLifetime, adoptionBasisIsFreshDeposit, closeScoringStamp } = await import("../tools/dlmm.js");
const { isAdoptedLifetimeScored, summarizeLedger } = await import("../ledger-truth.js");

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≈ ${b}`);

// An old operator account adopted late. Before adoption: 15 SOL deposited, 13 withdrawn,
// 3 fees claimed ⇒ cash-flow pnl +1; it still held inventory baselined at 2.0 SOL.
// A live valuation at adoption reads 2.0 + 13 + 3 − 15 = +3.0 SOL: the pre-adoption pnl.
const BASIS = buildAdoptionBasis({
  lifetime_deposits_sol: 15, lifetime_withdrawals_sol: 13, lifetime_fees_sol: 3,
  lifetime_deposits_usd: 1500, lifetime_withdrawals_usd: 1300, lifetime_fees_usd: 300,
}, "2026-10-01T00:00:00.000Z");
const TRACKED = { adopted: true, amount_sol: 2.0, initial_value_usd: 200, adoption_basis: BASIS };

// Pre-close cache (solMode: *_usd cache fields carry SOL). Balances 2.1, withdrawals 13,
// claimed 3.3, unclaimed 0.1, deposits 15 ⇒ lifetime pnl 2.1 + 13 + 3.4 − 15 = +3.5 SOL.
const CACHED = {
  pnl_sol: 3.5, pnl_true_usd: 350, pnl_pct: 23.33,
  collected_fees_usd: 3.3, unclaimed_fees_usd: 0.1,
  lifetime_deposits_sol: 15, lifetime_deposits_usd: 1500,
};

// What closePosition's cache-fallback branch holds before the rebase.
function fallbackValues(tracked, cached) {
  const fb = cacheFallbackRecordFields({
    solMode: true, cachedPos: cached, pnlSol: cached.pnl_sol, pnlTrueUsd: cached.pnl_true_usd,
    feesUsdTrue: 340, initialUsdTrue: tracked.initial_value_usd, capitalSol: tracked.amount_sol,
  });
  return { pnlSol: cached.pnl_sol, pnlTrueUsd: cached.pnl_true_usd, pnlPct: cached.pnl_pct, ...fb };
}

test("identity: the pre-adoption pnl is the adopted inventory + the pre-adoption cash flow", () => {
  assert.equal(BASIS.pnl_sol, 1);
  assert.equal(adoptionPrePnlSol(TRACKED), 3);
  // …and it is exactly what applyAdoptionBasis takes out of a lifetime figure.
  const adj = applyAdoptionBasis(TRACKED, { pnl_sol: 3.5, deposit_sol_true: 15, deposit_usd_true: 1500 });
  assert.equal(adj.pre_pnl_sol, 3);
  close(3.5 - adj.pnl_sol, adoptionPrePnlSol(TRACKED));
  assert.equal(adoptionPrePnlSol({ amount_sol: 2 }), null, "no basis");
  assert.equal(adoptionPrePnlSol({ amount_sol: 2, adoption_basis: null }), null);
});

test("cache fallback with a basis: the record covers the managed span", () => {
  const v = fallbackValues(TRACKED, CACHED);
  // Un-rebased, the fallback would book the lifetime +3.5 SOL on the 2.0 SOL capital (+175 %).
  assert.equal(v.pnlUsd, 3.5);
  assert.equal(v.initialUsd, 2);
  assert.ok(cacheValuationIsLifetime(CACHED));

  const rb = rebaseCloseToAdoption(TRACKED, v, {
    solMode: true, solPriceUsd: 100,
    lifetimeDepositsSol: CACHED.lifetime_deposits_sol, lifetimeDepositsUsd: CACHED.lifetime_deposits_usd,
  });
  // 3.5 lifetime − 3.0 pre-adoption = +0.5 SOL on the 2.0 SOL taken over = 25 %.
  close(rb.pnlSol, 0.5);
  close(rb.pnlPct, 25);
  // USD: 350 − 100 basis pnl − 2.0 SOL × (1500/15 $/SOL) = 50.
  close(rb.pnlTrueUsd, 50, 0.01);
  // Fees of the span: 3.4 − 3.0 = 0.4 SOL, 340 − 300 = 40 USD.
  close(rb.feesSolTrue, 0.4);
  close(rb.feesUsdTrue, 40, 0.01);
  // No top-up: capital stays the adopted 2.0 SOL / $200.
  close(rb.depSolTrue, 2);
  close(rb.depUsdTrue, 200, 0.01);
  // Legacy solMode fields carry SOL and agree with recordPerformance's own arithmetic.
  close(rb.pnlUsd, 0.5);
  close(rb.feesUsd, 0.4);
  close(rb.initialUsd, 2);
  close(rb.finalValueUsd, 2.1);
  close(((rb.finalValueUsd + rb.feesUsd - rb.initialUsd) / rb.initialUsd) * 100, 25);
  // Audit trail like the other paths.
  assert.equal(rb.adoptionLifetime.pnl_sol, 3.5);
  assert.equal(rb.adoptionLifetime.basis_pnl_sol, 1);
  assert.equal(rb.adoptionLifetime.basis_at, "2026-10-01T00:00:00.000Z");
});

test("cache fallback, re-ranged after adoption: re-deposits are not top-ups", () => {
  // One Meteora-UI rebalance re-deposited the whole position: lifetime deposits 15 → 17.1,
  // withdrawals 13 → 15.1. Same lifetime pnl (+3.5), same capital.
  const tracked = { ...TRACKED, rebalance_count: 1 };
  const cached = { ...CACHED, lifetime_deposits_sol: 17.1, lifetime_deposits_usd: 1710 };
  const rb = rebaseCloseToAdoption(tracked, fallbackValues(tracked, cached), {
    solMode: true, solPriceUsd: 100, lifetimeDepositsSol: 17.1, lifetimeDepositsUsd: 1710,
  });
  close(rb.pnlSol, 0.5);
  close(rb.depSolTrue, 2);
  close(rb.pnlPct, 25);
});

test("no basis: nothing changes", () => {
  const fresh = { adopted: true, amount_sol: 2.0, initial_value_usd: 200, adoption_basis: null };
  const v = fallbackValues(fresh, CACHED);
  const before = JSON.stringify(v);
  assert.equal(rebaseCloseToAdoption(fresh, v, { solMode: true, solPriceUsd: 100, lifetimeDepositsSol: 15 }), null);
  assert.equal(rebaseCloseToAdoption({ amount_sol: 0.4 }, v, { solMode: true }), null, "bot deploy");
  assert.equal(JSON.stringify(v), before, "inputs untouched");
});

test("a cache valued on the tracked capital (no Meteora deposits) is not rebased", () => {
  assert.equal(cacheValuationIsLifetime({ pnl_sol: 0.1, lifetime_deposits_sol: 0 }), false);
  assert.equal(cacheValuationIsLifetime({ pnl_sol: 0.1 }), false);
  assert.equal(cacheValuationIsLifetime(null), false);
});

test("a basis that is only the initial deposit is a fresh account (cache fallback: no rebase)", () => {
  const mk = (d, w, f) => buildAdoptionBasis({ lifetime_deposits_sol: d, lifetime_withdrawals_sol: w, lifetime_fees_sol: f });
  assert.equal(adoptionBasisIsFreshDeposit(mk(1, 0, 0)), true, "darwin-SOL: 1 / 0 / 0");
  assert.equal(adoptionBasisIsFreshDeposit(mk(1.99, 1.0, 0)), false, "withdrew before adoption");
  assert.equal(adoptionBasisIsFreshDeposit(mk(1, 0, 0.02)), false, "fees only");
  assert.equal(adoptionBasisIsFreshDeposit(mk(1, 0.0000004, 0)), true, "below the epsilon");
  assert.equal(adoptionBasisIsFreshDeposit(BASIS), false, "the old account above is rebased");
  assert.equal(adoptionBasisIsFreshDeposit(null), false, "no basis is not a fresh-deposit basis");
  assert.equal(adoptionBasisIsFreshDeposit({}), false);
  // closePosition checks it on the cache-fallback source only, before the rebase.
  const src = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.match(src, /else if \(fromCache && adoptionBasisIsFreshDeposit\(tracked\.adoption_basis\)\) \{\s+adoptionRebaseSkipped = "fresh_deposit_only";/);
});

test("closed-API close through the shared helper equals applyAdoptionBasis", () => {
  // Meteora's closed record: deposits 15.5 (0.5 top-up), fees 3.4, pnl 3.3.
  const v = { pnlSol: 3.3, pnlTrueUsd: 330, pnlUsd: 3.3, pnlPct: 21.29, feesUsd: 3.4, initialUsd: 15.5, finalValueUsd: 15.4, depSolTrue: 15.5, depUsdTrue: 1550, feesSolTrue: 3.4, feesUsdTrue: 340 };
  const rb = rebaseCloseToAdoption(TRACKED, v, { solMode: true, solPriceUsd: 100 });
  const adj = applyAdoptionBasis(TRACKED, { pnl_sol: 3.3, pnl_usd_true: 330, fees_sol_true: 3.4, fees_usd_true: 340, deposit_sol_true: 15.5, deposit_usd_true: 1550 });
  assert.equal(rb.pnlSol, adj.pnl_sol);
  assert.equal(rb.pnlSol, 0.3);
  assert.equal(rb.pnlPct, 12);
  assert.equal(rb.depSolTrue, 2.5);
  close(rb.depUsdTrue, 250, 0.01);
  close(rb.finalValueUsd, 2.5 + 0.3 - 0.4);
});

test("every close is stamped with how it was scored", () => {
  assert.deepEqual(closeScoringStamp("closed_api", TRACKED), { pnl_source: "closed_api", adoption_pre_pnl_sol: 3 });
  assert.deepEqual(closeScoringStamp("cache_fallback", { amount_sol: 0.4 }), { pnl_source: "cache_fallback", adoption_pre_pnl_sol: null });
  assert.deepEqual(closeScoringStamp("external_reconcile", { adopted: true, amount_sol: 1, adoption_basis: null }), { pnl_source: "external_reconcile", adoption_pre_pnl_sol: null });
  assert.deepEqual(closeScoringStamp("rebalance_leg", TRACKED), { pnl_source: "rebalance_leg", adoption_pre_pnl_sol: 3 });
  assert.deepEqual(closeScoringStamp("cache_fallback", TRACKED, { rebaseSkipped: "cache_not_lifetime" }),
    { pnl_source: "cache_fallback", adoption_pre_pnl_sol: 3, adoption_rebase_skipped: "cache_not_lifetime" });
  assert.equal(closeScoringStamp(undefined, null).pnl_source, "none");

  // All three record sites spread the stamp; recordPerformance keeps unknown fields (`...perf`).
  const src = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.ok(src.includes("...closeScoringStamp(realizedPnlSource, tracked"), "main close (closed_api | cache_fallback)");
  assert.ok(src.includes('...closeScoringStamp("external_reconcile", tracked)'), "external reconciliation");
  assert.ok(src.includes('...closeScoringStamp("rebalance_leg", snapshot)'), "rebalance leg");
  assert.equal((src.match(/await recordPerformance\(\{/g) || []).length, 3, "a new record site must be stamped too");
  const lessons = fs.readFileSync(new URL("../lessons.js", import.meta.url), "utf8");
  assert.match(lessons, /const entry = \{\s*\.\.\.perf,/);
});

test("counter: only adopted records that needed a rebase and did not get one", () => {
  const after = "2026-10-05T12:00:00.000Z";
  // Fresh adoption, unstamped, after the rebase era began: verified correctly scored.
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 1, recorded_at: after }), false);
  // Unstamped, closed before 2026-09-25: the old test.
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 1, recorded_at: "2026-09-24T23:59:59.000Z" }), true);
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 1, recorded_at: "2026-09-25T00:00:00.000Z" }), false);
  // Stamped, fresh adoption (no basis).
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 1, recorded_at: after, pnl_source: "cache_fallback", adoption_pre_pnl_sol: null }), false);
  // Stamped, a basis existed and was large, no rebase on record → counted.
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 2, recorded_at: after, pnl_source: "cache_fallback", adoption_pre_pnl_sol: 3 }), true);
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 2, recorded_at: after, pnl_source: "closed_api", adoption_pre_pnl_sol: -0.5 }), true);
  // Small one: below max(◎0.01, 1 % of 2 SOL = ◎0.02).
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 2, recorded_at: after, pnl_source: "cache_fallback", adoption_pre_pnl_sol: 0.015 }), false);
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 0.4, recorded_at: after, pnl_source: "cache_fallback", adoption_pre_pnl_sol: 0.009 }), false);
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 0.4, recorded_at: after, pnl_source: "cache_fallback", adoption_pre_pnl_sol: 0.011 }), true);
  // A skipped rebase is already on the right basis, whatever the pre-adoption figure says.
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 0.9791, recorded_at: after, pnl_source: "cache_fallback", adoption_pre_pnl_sol: -0.0209, adoption_rebase_skipped: "fresh_deposit_only" }), false);
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 2, recorded_at: after, pnl_source: "cache_fallback", adoption_pre_pnl_sol: 3, adoption_rebase_skipped: "cache_not_lifetime" }), false);
  // Rebased, or not adopted at all.
  assert.equal(isAdoptedLifetimeScored({ adopted: true, amount_sol: 2, recorded_at: after, pnl_source: "cache_fallback", adoption_pre_pnl_sol: 3, adoption_lifetime: { pnl_sol: 3.5 } }), false);
  assert.equal(isAdoptedLifetimeScored({ amount_sol: 2, recorded_at: "2026-09-01T00:00:00.000Z" }), false);

  const s = summarizeLedger([
    { adopted: true, amount_sol: 1, recorded_at: after, pnl_sol_net: 0.1 },
    { adopted: true, amount_sol: 2, recorded_at: after, pnl_sol_net: 3.4, pnl_source: "cache_fallback", adoption_pre_pnl_sol: 3 },
    { amount_sol: 0.4, recorded_at: after, pnl_sol: 0.05, total_gas_sol: 0.01 },
    { adopted: true, amount_sol: 1, recorded_at: after },
  ]);
  assert.equal(s.closes, 3);
  assert.equal(s.adopted_lifetime_scored, 1);
  close(s.net, 0.1 + 3.4 + 0.04);
});
