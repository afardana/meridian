/**
 * Regression coverage for manual/multi-asset position valuation and adoption
 * arming. Run: node test/test-multi-asset-position.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { calculateAssetAwareValue } from "../tools/pnl.js";
import { recordPositionValuationState, updatePnlAndCheckExits } from "../state.js";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const statePath = path.join(repoRoot, "state.json");
const originalState = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null;
const position = "TEST_SOL_USDC_ASSET_AWARE_POSITION";
const solMint = config.tokens.SOL;
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

try {
  const prices = {
    [solMint]: 106.83423734860877,
    [usdcMint]: 1,
  };
  const meteora = {
    allTimeDeposits: {
      total: {
        usd: 106.83423734860877,
        sol: 1.0000885007855804,
      },
    },
    // Open-position history has not withdrawn the current liquidity yet. The
    // closed incident's withdrawal totals are intentionally not mixed into
    // this active-tick fixture.
    allTimeWithdrawals: { total: { usd: 0, sol: 0 } },
    allTimeFees: { total: { usd: 0, sol: 0 } },
    pnlSolPctChange: -0.005995941306047841,
    pnlPctChange: 0.19298064319116556,
  };

  const value = calculateAssetAwareValue({
    tokenXMint: solMint,
    tokenYMint: usdcMint,
    decX: 9,
    decY: 6,
    xRaw: "888538779",
    yRaw: "11921193",
    feeXRaw: "0",
    feeYRaw: "0",
  }, prices, prices[solMint], meteora, true);

  assert.equal(value.quality, "valid");
  assert.ok(value.priceY === 1, "token Y must use its own price");
  assert.ok(value.pnlPctDiff < 1, `SOL/USDC divergence should be small, got ${value.pnlPctDiff}`);
  assert.ok(Math.abs(value.pnlSol) < 0.1, `SOL PnL must not treat USDC as SOL, got ${value.pnlSol}`);
  assert.ok(value.pnlSol < 0.01, `SOL PnL should remain near flat, got ${value.pnlSol}`);

  const extreme = calculateAssetAwareValue({
    tokenXMint: solMint,
    tokenYMint: usdcMint,
    decX: 9,
    decY: 6,
    xRaw: "888538779",
    yRaw: "11921193",
    feeXRaw: "0",
    feeYRaw: "0",
  }, prices, prices[solMint], { ...meteora, pnlSolPctChange: 1000 }, true);
  assert.equal(extreme.quality, "extreme_divergence");
  assert.equal(extreme.pnlPctSuspicious, true);

  const missingPrice = calculateAssetAwareValue({
    tokenXMint: solMint,
    tokenYMint: usdcMint,
    decX: 9,
    decY: 6,
    xRaw: "888538779",
    yRaw: "11921193",
    feeXRaw: "0",
    feeYRaw: "0",
  }, { [solMint]: prices[solMint] }, prices[solMint], meteora, true);
  assert.equal(missingPrice.quality, "missing_price");

  fs.writeFileSync(statePath, JSON.stringify({
    positions: {
      [position]: {
        position,
        pool: "TEST_POOL",
        pool_name: "SOL-SOL",
        adopted: true,
        closed: false,
        hold_mode: false,
        notes: [],
      },
    },
    recentEvents: [],
  }, null, 2));

  const profile = {
    token_x_mint: solMint,
    token_y_mint: usdcMint,
    token_x_symbol: "SOL",
    token_y_symbol: "USDC",
    token_x_decimals: 9,
    token_y_decimals: 6,
    source: "test",
  };
  const first = recordPositionValuationState(position, {
    quality: "valid",
    asset_profile: profile,
    pair_name: "SOL-USDC",
  });
  assert.equal(first.management_armed, false, "adopted position must wait for confirmation ticks");
  assert.equal(first.valid_ticks, 1);
  assert.equal(first.pair_name, "SOL-USDC", "provisional SOL-SOL identity must be repaired");

  const blocked = updatePnlAndCheckExits(position, {
    pnl_pct: 1181.3,
    pnl_pct_suspicious: false,
    pnl_management_ready: false,
    in_range: true,
    fee_per_tvl_24h: 100,
  }, config.management);
  assert.equal(blocked, null, "unarmed adopted position must not exit on a sample");

  const second = recordPositionValuationState(position, {
    quality: "valid",
    asset_profile: profile,
    pair_name: "SOL-USDC",
  });
  assert.equal(second.management_armed, true, "adopted position should arm after valid ticks");
  assert.equal(second.valid_ticks, 2);

  console.log("Multi-asset valuation and adoption safety tests passed.");
} finally {
  if (originalState == null) {
    try { fs.unlinkSync(statePath); } catch (_) {}
  } else {
    fs.writeFileSync(statePath, originalState);
  }
}
