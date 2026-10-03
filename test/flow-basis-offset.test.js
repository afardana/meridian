process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { resolvePendingFlow } = await import("../tools/pnl.js");
const { applyFlowBasisOffset } = await import("../tools/dlmm.js");
const { trackPosition, recordPendingFlow, settlePendingFlow, getTrackedPosition, closeTrackedPosition, ensureStateInitialized } = await import("../state.js");
await ensureStateInitialized();

// swordcat-SOL 2026-10-04: we expected a net deposit of ◎1.445 after the straddle; Meteora
// booked the base at the (higher) price when the deposit landed and settled at ◎1.541.
const raw = { net_sol_expected: 1.445, net_usd_expected: 172.72, at: new Date().toISOString() };

test("a live flow the indexer disagrees with stays pending and is valued on our net", () => {
  const r = resolvePendingFlow(raw, raw, { netIndexedSol: 0.74, netIndexedUsd: 88 });
  assert.equal(r.pending, true); assert.equal(r.settle, null);
  assert.ok(Math.abs(r.applySol - (0.74 - 1.445)) < 1e-9);
});

test("an expired flow keeps our basis: the settled difference is applied and kept, not switched to Meteora's", () => {
  const r = resolvePendingFlow(raw, null, { netIndexedSol: 1.541, netIndexedUsd: 184.2 });
  assert.equal(r.pending, false);
  assert.equal(r.settle.keep, true);
  assert.ok(Math.abs(r.settle.residualSol - 0.096) < 1e-9);
  assert.ok(Math.abs(r.applySol - 0.096) < 1e-9, "the same valuation already uses our basis — no one-tick step");
  assert.ok(Math.abs(r.settle.residualUsd - (184.2 - 172.72)) < 1e-9);
});

test("the indexer agreeing within tolerance settles too, with its small residual kept", () => {
  const r = resolvePendingFlow(raw, raw, { netIndexedSol: 1.46, netIndexedUsd: 174 });
  assert.equal(r.pending, false); assert.equal(r.settle.keep, true);
  assert.ok(Math.abs(r.applySol - 0.015) < 1e-9);
});

test("a difference too large to be a basis difference is left to the external-capital check", () => {
  const r = resolvePendingFlow(raw, null, { netIndexedSol: 2.445, netIndexedUsd: 292 });
  assert.equal(r.settle.keep, false); assert.equal(r.applySol, 0);
  assert.deepEqual(resolvePendingFlow(null, null, { netIndexedSol: 1 }), { pending: false, settle: null, applySol: 0, applyUsd: 0 });
});

test("settling keeps the offset on the position and never touches the capital", () => {
  const P = `FLOW_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_F", pool_name: "swordcat-SOL", strategy: "spot", amount_sol: 1.49, initial_value_usd: 1.49, bin_range: [-434, -377], active_bin: -377 });
  try {
    recordPendingFlow(P, { net_sol_expected: 1.445, net_usd_expected: 172.72, reason: "straddle deposit" });
    assert.equal(settlePendingFlow(P, { keep: true, residualSol: 0.096, residualUsd: 11.48, why: "expired" }), true);
    let pos = getTrackedPosition(P);
    assert.equal(pos.pending_flow, null);
    assert.equal(pos.flow_basis_offset_sol, 0.096);
    assert.equal(pos.flow_basis_offset_usd, 11.48);
    assert.equal(pos.expected_net_deposit_sol, 1.445);
    assert.equal(pos.amount_sol, 1.49);
    // A second straddle's difference accumulates; a too-large one is not kept.
    recordPendingFlow(P, { net_sol_expected: 1.40, reason: "straddle deposit" });
    settlePendingFlow(P, { keep: true, residualSol: -0.01, residualUsd: -1.2, why: "indexer caught up" });
    assert.equal(getTrackedPosition(P).flow_basis_offset_sol, 0.086);
    recordPendingFlow(P, { net_sol_expected: 1.40, reason: "straddle deposit" });
    settlePendingFlow(P, { keep: false, residualSol: 1.0, why: "expired" });
    pos = getTrackedPosition(P);
    assert.equal(pos.flow_basis_offset_sol, 0.086); assert.equal(pos.pending_flow, null);
    assert.equal(settlePendingFlow(P, { keep: true, residualSol: 0.5 }), false, "nothing pending → no-op");
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
});

test("a closed record carries the offset in pnl, on the same capital", () => {
  const rec = { pnl_sol: 0.114, pnl_usd_true: 13.6, pnl_pct_sol: 7.65, pnl_pct_usd: 7.6, initial_sol_true: 1.49, initial_usd_true: 178, final_sol_true: 1.42, final_usd_true: 170, fees_sol_true: 0.18, fees_usd_true: 21.9 };
  const out = applyFlowBasisOffset(rec, { flow_basis_offset_sol: 0.096, flow_basis_offset_usd: 11.48 }, true);
  assert.ok(Math.abs(out.pnl_sol - 0.21) < 1e-9);
  assert.ok(Math.abs(out.pnl_pct_sol - (7.65 + (0.096 / 1.49) * 100)) < 1e-9);
  assert.equal(out.initial_sol_true, 1.49);
  assert.equal(out.pnl_value, out.pnl_sol); assert.equal(out.pnl_pct, out.pnl_pct_sol);
  assert.equal(applyFlowBasisOffset(rec, { }, true), rec);
  assert.equal(applyFlowBasisOffset(rec, { flow_basis_offset_sol: 0 }, true), rec);
});
