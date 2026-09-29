process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// Rule PnL is SOL-denominated regardless of the solMode display toggle: a drop in
// SOL/USD must never read as a position loss to the exit rules.
import { test } from "node:test";
import assert from "node:assert/strict";

const { config } = await import("../config.js");
const { calculateAssetAwareValue } = await import("../tools/pnl.js");
const { ensureStateInitialized, trackPosition, updatePnlAndCheckExits, closeTrackedPosition } = await import("../state.js");
await ensureStateInitialized();

const SOL = config.tokens.SOL;
const MEME = "MEMEmint1111111111111111111111111111111111";

// Deposited 1 SOL at $200. SOL is now $160; the position still holds exactly
// 1 SOL of value (0.5 SOL + 1000 MEME worth 0.5 SOL). In SOL it is flat; in USD
// it reads −20 % purely from SOL/USD.
const solUsd = 160;
const prices = { [SOL]: solUsd, [MEME]: 0.08 };
const position = {
  tokenXMint: MEME, tokenYMint: SOL, decX: 6, decY: 9,
  xRaw: "1000000000", yRaw: "500000000", feeXRaw: "0", feeYRaw: "0",
};
const meteora = {
  allTimeDeposits: { total: { usd: 200, sol: 1 } },
  allTimeWithdrawals: { total: { usd: 0, sol: 0 } },
  allTimeFees: { total: { usd: 0, sol: 0 } },
  pnlSolPctChange: 0,
  pnlPctChange: -20,
};

for (const solMode of [true, false]) {
  test(`SOL/USD decline is not a rule loss (solMode=${solMode})`, () => {
    const v = calculateAssetAwareValue(position, prices, solUsd, meteora, solMode);
    assert.equal(v.quality, "valid");
    assert.ok(Math.abs(v.ourPct) < 0.01, `rule pnl must be SOL-flat, got ${v.ourPct}`);
    assert.ok(Math.abs(v.effectivePnlPct) < 0.01, `effective pnl must be SOL-flat, got ${v.effectivePnlPct}`);
    assert.ok(Math.abs(v.pctUsd + 20) < 0.01, `USD view still shows the SOL/USD move, got ${v.pctUsd}`);
    assert.ok(Math.abs(v.ilPct) < 0.01, `IL decomposition is SOL-basis, got ${v.ilPct}`);
  });
}

test("deposit basis is required in SOL even when solMode is off", () => {
  const noSolBasis = { ...meteora, allTimeDeposits: { total: { usd: 200, sol: 0 } } };
  const v = calculateAssetAwareValue(position, prices, 0, noSolBasis, false);
  assert.notEqual(v.quality, "valid");
  assert.equal(v.pnlPctSuspicious, true);
});

const mgmt = {
  trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingMinPnlPct: null, trailingOvershootPct: 0.5,
  stopLossPct: -15, takeProfitPct: 35, twapGuardEnabled: false, roundTripHarvestEnabled: false,
  outOfRangeBinsToClose: 50, outOfRangeWaitMinutesAbove: 720, outOfRangeWaitMinutesBelow: 60,
  minFeePerTvl24h: 1, minAgeBeforeYieldCheck: 60, poolHealthMinSnapshots: 0,
};
const data = (over) => ({ pnl_pct: 0, effective_pnl_pct: 0, in_range: true, active_bin: 50, lower_bin: 0, upper_bin: 100, fee_per_tvl_24h: 5, age_minutes: 200, pnl_quality: "valid", ...over });
function withPos(fn) {
  const P = `SOLB_${Math.random().toString(36).slice(2)}`;
  trackPosition({ position: P, pool: "POOL_S", pool_name: "SOLB-SOL", strategy: "spot", amount_sol: 1, initial_value_usd: 200, bin_range: [0, 100], active_bin: 50 });
  try { return fn(P); } finally { try { closeTrackedPosition(P, "test"); } catch {} }
}

test("evaluator refuses a non-SOL pnl basis", () => withPos((P) => {
  assert.equal(updatePnlAndCheckExits(P, data({ pnl_basis: "usd", pnl_pct: -20, effective_pnl_pct: -20 }), mgmt), null);
}));

test("SOL-basis stop loss still fires", () => withPos((P) => {
  const e = updatePnlAndCheckExits(P, data({ pnl_basis: "sol", pnl_pct: -16, effective_pnl_pct: -16 }), mgmt);
  assert.equal(e?.action, "STOP_LOSS");
}));
