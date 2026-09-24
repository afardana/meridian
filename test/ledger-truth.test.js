import { test } from "node:test";
import assert from "node:assert/strict";
process.env.PERSIST_BACKEND = "json";
const { reconcile } = await import("../ledger-truth.js");
const { buildAdoptionBasis, applyAdoptionBasis } = await import("../state.js");

test("reconcile: a truthful ledger has zero drift", () => {
  // wallet 10 → 9.5, operator withdrew 1, deposited 0.2; open book unrealized −0.1 → +0.1
  // ⇒ book = 9.5 − 10 − 0.2 + 1 = +0.3; Δunreal = +0.2 ⇒ realized truth = +0.1
  const r = reconcile({ aumStart: 10, aumEnd: 9.5, deposits: 0.2, withdrawals: 1, ledgerNet: 0.1, unrealStart: -0.1, unrealEnd: 0.1 });
  assert.equal(r.book, 0.3);
  assert.equal(r.unrealized_delta, 0.2);
  assert.equal(r.drift, 0);
  assert.equal(r.ledger_fidelity_pct, 100);
});

test("reconcile: an overstated ledger shows negative drift", () => {
  const r = reconcile({ aumStart: 11.865, aumEnd: 2.209, deposits: 1.752, withdrawals: 8.91, ledgerNet: 8.52, unrealStart: 0, unrealEnd: -3.35 });
  assert.ok(Math.abs(r.book - (-2.498)) < 1e-6);
  assert.ok(r.drift < -7, `drift ${r.drift}`); // ledger +8.52 vs realized truth ≈ +0.85
});

test("adoption basis: lifetime figures are rebased to the managed span", () => {
  // Account had 15 SOL deposited, 12 withdrawn, 3 fees claimed before adoption ⇒ +0 pnl
  // pre-adoption... make it +1: 15 dep, 13 wd, 3 fees ⇒ lifetime pnl at adoption = +1.
  const scan = { lifetime_deposits_sol: 15, lifetime_withdrawals_sol: 13, lifetime_fees_sol: 3, lifetime_deposits_usd: 1500, lifetime_withdrawals_usd: 1300, lifetime_fees_usd: 300 };
  const basis = buildAdoptionBasis(scan, "2026-09-01T00:00:00.000Z");
  assert.equal(basis.pnl_sol, 1);
  assert.equal(basis.pnl_usd, 100);
  // At close Meteora reports lifetime: deposits 15.5 (a 0.5 top-up after adoption),
  // fees 3.4, pnl 1.3 ⇒ since-adoption pnl = 0.3, fees 0.4, capital = value at
  // adoption (2.0) + 0.5 top-up = 2.5 ⇒ 12%.
  const adj = applyAdoptionBasis({ adoption_basis: basis, amount_sol: 2.0 }, {
    pnl_sol: 1.3, pnl_usd_true: 130, fees_sol_true: 3.4, fees_usd_true: 340, deposit_sol_true: 15.5,
  });
  assert.equal(adj.pnl_sol, 0.3);
  assert.equal(adj.pnl_usd_true, 30);
  assert.equal(adj.fees_sol_true, 0.4);
  assert.equal(adj.deposit_sol_true, 2.5);
  assert.equal(adj.pnl_pct, 12);
  assert.equal(adj.lifetime.pnl_sol, 1.3);
  assert.equal(adj.lifetime.basis_pnl_sol, 1);
});

test("adoption basis: no indexer figures ⇒ no basis, close keeps lifetime", () => {
  assert.equal(buildAdoptionBasis({ lifetime_deposits_sol: 0 }), null);
  assert.equal(applyAdoptionBasis({ adoption_basis: null }, { pnl_sol: 1 }), null);
});
