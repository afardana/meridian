process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// tOpenAI-SOL 2026-09-29: an in-place straddle withdrew half the SOL from the same
// position account; Meteora's allTimeWithdrawals lagged, pnl read −49.20 % and the
// stop loss closed a position that was +1.6 % in SOL.
import { test } from "node:test";
import assert from "node:assert/strict";

const { config } = await import("../config.js");
const { calculateAssetAwareValue } = await import("../tools/pnl.js");
const {
  ensureStateInitialized, trackPosition, closeTrackedPosition, getTrackedPosition,
  updatePnlAndCheckExits, notePositionStraddleFailure, recordPendingFlow, pendingFlowFor,
} = await import("../state.js");
await ensureStateInitialized();

const SOL = config.tokens.SOL;
const MEME = "oPAiMEME111111111111111111111111111111111111";
const solUsd = 118;
const prices = { [SOL]: solUsd, [MEME]: 2500 };
// After stage A: all-SOL, 0.2032 SOL left in the account (0.4064 before, half withdrawn).
const onChain = { tokenXMint: MEME, tokenYMint: SOL, decX: 9, decY: 9, xRaw: "0", yRaw: "203200000", feeXRaw: "0", feeYRaw: "0" };
const lagging = {
  allTimeDeposits: { total: { sol: 0.4, usd: 0.4 * solUsd } },
  allTimeWithdrawals: { total: { sol: 0, usd: 0 } },
  allTimeFees: { total: { sol: 0, usd: 0 } },
  pnlSolPctChange: -49.2,
};
const pending = (at = new Date().toISOString()) => ({ pending_flow: { net_sol_expected: 0.4 - 0.2032, net_usd_expected: (0.4 - 0.2032) * solUsd, at, reason: "test" } });

test("without the ledger the lagging indexer reads the withdrawal as a −49 % loss", () => {
  const v = calculateAssetAwareValue(onChain, prices, solUsd, lagging, true, {});
  assert.ok(v.ourPct < -49 && v.ourPct > -50, `got ${v.ourPct}`);
});

test("a pending in-place flow values the position against the recorded net", () => {
  const v = calculateAssetAwareValue(onChain, prices, solUsd, lagging, true, pending());
  assert.equal(v.flowPending, true);
  assert.ok(Math.abs(v.ourPct - 1.6) < 0.05, `expected ≈ +1.6 %, got ${v.ourPct}`);
  assert.equal(v.quality, "valid", "stale reported pct must not flag extreme divergence");
});

test("once Meteora indexes the flow (gross or net) the ledger no longer applies", () => {
  const gross = { ...lagging, allTimeDeposits: { total: { sol: 0.6032, usd: 0.6032 * solUsd } }, allTimeWithdrawals: { total: { sol: 0.4064, usd: 0.4064 * solUsd } } };
  // Settles only once the flow is older than the minimum (a stale indexer can sit within tolerance).
  const v = calculateAssetAwareValue(onChain, prices, solUsd, gross, true, pending(new Date(Date.now() - 20 * 60_000).toISOString()));
  assert.equal(v.flowPending, false);
  assert.ok(v.ourPct > 0, `got ${v.ourPct}`);
  const young = calculateAssetAwareValue(onChain, prices, solUsd, gross, true, pending());
  assert.equal(young.flowPending, true);
  assert.ok(Math.abs(young.ourPct - v.ourPct) < 1e-6, "same valuation either way: our net");
});

test("a pending flow expires after an hour", () => {
  assert.ok(pendingFlowFor(pending()));
  assert.equal(pendingFlowFor(pending(new Date(Date.now() - 61 * 60_000).toISOString())), null);
});

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, stopLossPct: -15, twapGuardEnabled: false, roundTripHarvestEnabled: false, outOfRangeWaitMinutesAbove: 720, outOfRangeWaitMinutesBelow: 60, minFeePerTvl24h: 1, minAgeBeforeYieldCheck: 60, poolHealthMinSnapshots: 0 };
const data = (over) => ({ pnl_pct: 1.6, effective_pnl_pct: 1.6, in_range: true, active_bin: 380, lower_bin: 343, upper_bin: 413, fee_per_tvl_24h: 5, age_minutes: 60, pnl_quality: "valid", ...over });
function withPos(fn) {
  const P = `FLOW_${Math.random().toString(36).slice(2)}`;
  trackPosition({ position: P, pool: "POOL_F", pool_name: "FLOW-SOL", strategy: "spot", amount_sol: 0.4, initial_value_usd: 47, bin_range: { min: 300, max: 369 }, active_bin: 369 });
  try { return fn(P); } finally { try { closeTrackedPosition(P, "test"); } catch {} }
}

test("a failed straddle syncs its own re-range, so it is not booked as external", () => withPos((P) => {
  recordPendingFlow(P, { net_sol_expected: 0.1968, reason: "test" });
  notePositionStraddleFailure(P, "straddle failed at stage C", { bin_range: { min: 343, max: 413 } });
  assert.equal(updatePnlAndCheckExits(P, data(), mgmt), null);
  const pos = getTrackedPosition(P);
  assert.equal(pos.rebalance_count ?? 0, 0);
  assert.equal(pos.bin_range.min, 343);
}));

test("an external re-range never re-bases the peak on a suspect reading", () => withPos((P) => {
  updatePnlAndCheckExits(P, data({ lower_bin: 300, upper_bin: 369 }), mgmt);
  const before = getTrackedPosition(P).peak_pnl_pct;
  assert.equal(updatePnlAndCheckExits(P, data({ pnl_pct: -49.2, effective_pnl_pct: -49.2, pnl_pct_suspicious: true }), mgmt), null);
  assert.equal(getTrackedPosition(P).peak_pnl_pct, before);
}));
