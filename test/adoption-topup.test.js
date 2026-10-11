process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 2026-10-11: a top-up (or partial withdrawal) after adoption must not be charged twice.
// The rebase is pnl = (lifetime − basis pnl) − C0 with C0 = the inventory taken over. C0 used
// to be read from the LIVE amount_sol, which the external-capital reconciler moves by the
// top-up T (or −X): booked = true − T (true + X). C0 is now frozen in the basis (capital_sol).
const { buildAdoptionBasis, applyAdoptionBasis, adoptionPrePnlSol } = await import("../state.js");
const { rebaseRecoveredToAdoption } = await import("../tools/dlmm.js");

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≈ ${b}`);

// Operator deposits D0 = 1; the first valuation (adoption) reads C0 = 0.98. Not a fresh-deposit
// case for the guard's purposes here: these tests exercise the rebase arithmetic itself.
const D0 = 1, C0 = 0.98;
const scan = { lifetime_deposits_sol: D0, lifetime_withdrawals_sol: 0, lifetime_fees_sol: 0 };
const NEW_BASIS = buildAdoptionBasis(scan, "2026-10-11T00:00:00.000Z", C0);
const OLD_BASIS = buildAdoptionBasis(scan, "2026-10-01T00:00:00.000Z");

test("the basis freezes the capital taken over", () => {
  assert.equal(NEW_BASIS.capital_sol, 0.98);
  assert.equal("capital_sol" in OLD_BASIS, false, "a basis built without it keeps the old shape");
  assert.equal(buildAdoptionBasis(scan, undefined, null).capital_sol, undefined);
  assert.equal(buildAdoptionBasis(scan, undefined, 0).capital_sol, undefined);
  // trackPosition's adopt path passes the row's amount_sol
  const src = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
  assert.match(src, /amount_sol: adoptedAmountSol,/);
  assert.match(src, /adoption_basis: buildAdoptionBasis\(p, undefined, adoptedAmountSol\),/);
  // the pre-adoption pnl (and so the record stamp) no longer moves with amount_sol
  assert.equal(adoptionPrePnlSol({ adoption_basis: NEW_BASIS, amount_sol: 0.98 }), -0.02);
  assert.equal(adoptionPrePnlSol({ adoption_basis: NEW_BASIS, amount_sol: 1.5 }), -0.02);
});

// Top-up T = 0.5 after adoption; at close 1.60 withdrawn + 0.02 fees.
//   true managed-span pnl = 1.60 + 0.02 − T − C0 = +0.14 on C0 + T = 1.48.
const T = 0.5;
const lifeTopUp = { pnl_sol: 1.6 + 0.02 - (D0 + T), fees_sol_true: 0.02, deposit_sol_true: D0 + T };
const TRUE_TOPUP = 0.14;

test("(a) top-up, reconciler did not fire: error 0", () => {
  const a = applyAdoptionBasis({ adoption_basis: NEW_BASIS, amount_sol: C0 }, lifeTopUp);
  close(a.pnl_sol, TRUE_TOPUP);
  close(a.deposit_sol_true, C0 + T);
  close(a.pnl_pct, (TRUE_TOPUP / (C0 + T)) * 100, 0.006);
});

test("(b) top-up, reconciler fired: booked == true, capital C0 + T", () => {
  // the reconciler (no own-flow reference) sets amount_sol to the on-chain net deposit D0 + T
  const a = applyAdoptionBasis({ adoption_basis: NEW_BASIS, amount_sol: D0 + T }, lifeTopUp);
  close(a.pnl_sol, TRUE_TOPUP);
  close(a.pre_pnl_sol, -0.02);
  close(a.deposit_sol_true, C0 + T);
  close(a.pnl_pct, 9.46, 0.006);
  // the defect, reproduced on an old-format basis: T charged twice
  const old = applyAdoptionBasis({ adoption_basis: OLD_BASIS, amount_sol: D0 + T }, lifeTopUp);
  close(old.pnl_sol, TRUE_TOPUP - (D0 + T - C0));
  // through the closed-API helper too (not a fresh-deposit basis: fees before adoption)
  const basis = buildAdoptionBasis({ ...scan, lifetime_fees_sol: 0.01 }, undefined, C0);
  const rec = { pnl_sol: lifeTopUp.pnl_sol + 0.01, fees_sol_true: 0.03, initial_sol_true: D0 + T, initial_usd_true: 150 };
  const r = rebaseRecoveredToAdoption({ adoption_basis: basis, amount_sol: D0 + T }, rec, { solMode: true, solPriceUsd: 100 });
  assert.equal(r.rebaseSkipped, null);
  close(rec.pnl_sol, TRUE_TOPUP);              // (L + 0.01) − (0.01 − 1) − 0.98
  close(rec.initial_sol_true, C0 + T);
});

// Partial withdrawal X = 0.4 after adoption; at close another 0.62 withdrawn + 0.02 fees.
//   true = 0.4 + 0.62 + 0.02 − C0 = +0.06.
const X = 0.4;
const lifeWithdraw = { pnl_sol: X + 0.62 + 0.02 - D0, fees_sol_true: 0.02, deposit_sol_true: D0 };

test("(c) partial withdrawal, reconciler fired: booked == true", () => {
  // the reconciler lowered amount_sol to the on-chain net deposit D0 − X
  const a = applyAdoptionBasis({ adoption_basis: NEW_BASIS, amount_sol: D0 - X }, lifeWithdraw);
  close(a.pnl_sol, 0.06);
  // percent on the current tracked capital
  close(a.deposit_sol_true, D0 - X);
  close(a.pnl_pct, 10, 0.006);
  // not fired: same pnl, capital C0
  const b = applyAdoptionBasis({ adoption_basis: NEW_BASIS, amount_sol: C0 }, lifeWithdraw);
  close(b.pnl_sol, 0.06);
  close(b.deposit_sol_true, C0);
  // the defect on an old-format basis: + (C0 − (D0 − X)) booked on top
  close(applyAdoptionBasis({ adoption_basis: OLD_BASIS, amount_sol: D0 - X }, lifeWithdraw).pnl_sol, 0.06 + (C0 - (D0 - X)));
});

test("re-ranged after adoption: re-deposits are not top-ups; a reconciled top-up still sets the capital", () => {
  const life = { pnl_sol: 0.12, fees_sol_true: 0.02, deposit_sol_true: 3.5 }; // deposits inflated by the re-range
  const a = applyAdoptionBasis({ adoption_basis: NEW_BASIS, amount_sol: C0, rebalance_count: 1 }, life);
  close(a.pnl_sol, 0.14);
  close(a.deposit_sol_true, C0);
  const b = applyAdoptionBasis({ adoption_basis: NEW_BASIS, amount_sol: C0 + T, rebalance_count: 1 }, life);
  close(b.pnl_sol, 0.14);
  close(b.deposit_sol_true, C0 + T);
});

test("old-format basis (no capital_sol) behaves as before", () => {
  // no top-up, amount_sol untouched: identical to the new format
  const life = { pnl_sol: 0.05, fees_sol_true: 0.02, deposit_sol_true: D0 };
  const o = applyAdoptionBasis({ adoption_basis: OLD_BASIS, amount_sol: C0 }, life);
  const n = applyAdoptionBasis({ adoption_basis: NEW_BASIS, amount_sol: C0 }, life);
  assert.deepEqual({ ...o, lifetime: null }, { ...n, lifetime: null });
  close(o.pnl_sol, 0.05 + 1 - 0.98);
  // previous arithmetic exactly: capitalAtAdoption = live amount_sol, capital = it + post-deposits
  const t = applyAdoptionBasis({ adoption_basis: OLD_BASIS, amount_sol: 1.5 }, lifeTopUp);
  close(t.pnl_sol, lifeTopUp.pnl_sol + 1 - 1.5);
  close(t.deposit_sol_true, 1.5 + T);
  assert.equal(adoptionPrePnlSol({ adoption_basis: OLD_BASIS, amount_sol: 1.5 }), 0.5);
  // no amount_sol at all: falls back to the basis net deposit, as before
  assert.equal(adoptionPrePnlSol({ adoption_basis: OLD_BASIS }), 0);
});
