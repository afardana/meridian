import assert from "node:assert/strict";
import { getRawPoolScreeningRejectReason, condensePool } from "../tools/screening.js";
import { scoreMomentum, scoreYield, computeIntelScore } from "../intel-score.js";
import { config } from "../config.js";

console.log("=== Testing Tx Velocity, Volume/TVL Screening & Intel Scoring ===");

// ── 1. getRawPoolScreeningRejectReason tests ──
{
  const basePool = {
    pool_address: "pool_valid_123",
    pool_type: "dlmm",
    token_x: {
      symbol: "TEST",
      address: "mint_x_123",
      market_cap: 500000,
      organic_score: 80,
    },
    token_y: {
      symbol: "SOL",
      address: "So11111111111111111111111111111111111111112",
      organic_score: 100,
    },
    dlmm_params: { bin_step: 25 },
    tvl: 25000,
    volume: 5000,
    fee_active_tvl_ratio: 0.005,
    volatility: 0.02,
    base_token_holders: 500,
    total_lps: 15,
    swap_count: 50, // 10 tx/min in 5m timeframe
    fee_pct: 0.25,
    dynamic_fee_pct: 0.15,
  };

  const screeningConfig = {
    ...config.screening,
    minMcap: 10000,
    maxMcap: 100000000,
    minHolders: 50,
    minLps: 2,
    minVolume: 1000,
    minTvl: 10000,
    minBinStep: 10,
    maxBinStep: 100,
    minFeeActiveTvlRatio: 0.001,
    minOrganic: 50,
    minVolumeTvlRatio: 0.05,
    minTxPerMin: 5.0,
    timeframe: "5m",
  };

  // Valid pool should pass screening
  const reasonPass = getRawPoolScreeningRejectReason(basePool, screeningConfig);
  assert.equal(reasonPass, null, `Expected pool to pass screening, got: ${reasonPass}`);

  // Test minVolumeTvlRatio rejection
  const lowVolPool = {
    ...basePool,
    volume: 1000,
    tvl: 40000, // 1000 / 40000 = 0.025 < 0.05
  };
  const reasonLowVol = getRawPoolScreeningRejectReason(lowVolPool, screeningConfig);
  assert.ok(
    reasonLowVol && reasonLowVol.includes("volume/TVL ratio"),
    `Expected volume/TVL rejection, got: ${reasonLowVol}`
  );

  // Test minTxPerMin rejection via swap_count
  const lowTxPool = {
    ...basePool,
    swap_count: 10, // 10 / 5m = 2.0 < 5.0
  };
  const reasonLowTx = getRawPoolScreeningRejectReason(lowTxPool, screeningConfig);
  assert.ok(
    reasonLowTx && reasonLowTx.includes("tx/min"),
    `Expected tx/min rejection, got: ${reasonLowTx}`
  );

  // Test explicit tx_per_min passing
  const explicitHighTxPool = {
    ...lowTxPool,
    tx_per_min: 12.5,
  };
  const reasonExplicitTx = getRawPoolScreeningRejectReason(explicitHighTxPool, screeningConfig);
  assert.equal(reasonExplicitTx, null, `Expected explicit tx_per_min to pass, got: ${reasonExplicitTx}`);

  console.log("✅ getRawPoolScreeningRejectReason unit tests passed");
}

// ── 2. condensePool output fields tests ──
{
  const rawPool = {
    pool_address: "pool_condense_test",
    name: "ALPHA-SOL",
    pool_type: "dlmm",
    token_x: {
      symbol: "ALPHA",
      address: "mint_alpha",
      market_cap: 300000,
      organic_score: 75,
      warnings: [],
    },
    token_y: {
      symbol: "SOL",
      address: "So11111111111111111111111111111111111111112",
    },
    dlmm_params: { bin_step: 20 },
    fee_pct: 0.3,
    dynamic_fee_pct: 0.125,
    tvl: 20000,
    active_tvl: 18000,
    fee: 100,
    volume: 2500, // vol/tvl = 2500/20000 = 0.125
    fee_active_tvl_ratio: 0.0055,
    volatility: 0.015,
    swap_count: 40, // 40 / 5 = 8 tx/min
  };

  const condensed = condensePool(rawPool);
  assert.equal(condensed.pool, "pool_condense_test");
  assert.equal(condensed.dynamic_fee_pct, 0.125);
  assert.equal(condensed.tx_per_min, 8);
  assert.equal(condensed.volume_tvl_ratio, 0.125);

  console.log("✅ condensePool output fields verified");
}

// ── 3. scoreMomentum with tx_per_min tests ──
{
  const candidateLowVelocity = {
    price_change_pct: 5.0,
    unique_traders: 30,
    tx_per_min: 1.0,
    stats_1h: { buy_vol: 1000, sell_vol: 500 },
    indicator_confirmation: true,
  };

  const candidateHighVelocity = {
    price_change_pct: 5.0,
    unique_traders: 30,
    tx_per_min: 15.0, // max velocity score
    stats_1h: { buy_vol: 1000, sell_vol: 500 },
    indicator_confirmation: true,
  };

  const scoreLow = scoreMomentum(candidateLowVelocity);
  const scoreHigh = scoreMomentum(candidateHighVelocity);

  assert.ok(
    scoreHigh.breakdown.unique_traders > scoreLow.breakdown.unique_traders,
    `High velocity score (${scoreHigh.breakdown.unique_traders}) should exceed low velocity score (${scoreLow.breakdown.unique_traders})`
  );
  assert.ok(
    scoreHigh.score > scoreLow.score,
    `High velocity momentum score (${scoreHigh.score}) should exceed low velocity score (${scoreLow.score})`
  );

  console.log("✅ scoreMomentum velocity weighting passed");
}

// ── 4. scoreYield with dynamic_fee_pct surge bonus tests ──
{
  const candidateNoSurge = {
    fee_active_tvl_ratio: 0.005,
    volume_window: 5000,
    tvl: 25000,
    dynamic_fee_pct: 0,
  };

  const candidateWithSurge = {
    fee_active_tvl_ratio: 0.005,
    volume_window: 5000,
    tvl: 25000,
    dynamic_fee_pct: 0.4, // high dynamic fee surge
  };

  const yieldNoSurge = scoreYield(candidateNoSurge);
  const yieldWithSurge = scoreYield(candidateWithSurge);

  assert.equal(yieldNoSurge.breakdown.dynamic_fee_bonus, 0);
  assert.ok(
    yieldWithSurge.breakdown.dynamic_fee_bonus > 0,
    `Expected dynamic_fee_bonus, got: ${yieldWithSurge.breakdown.dynamic_fee_bonus}`
  );
  assert.ok(
    yieldWithSurge.score > yieldNoSurge.score,
    `Surge yield score (${yieldWithSurge.score}) should exceed non-surge (${yieldNoSurge.score})`
  );

  // Test end-to-end computeIntelScore
  const intelResult = computeIntelScore(candidateWithSurge);
  assert.ok(intelResult.total > 0, "computeIntelScore returned total > 0");
  assert.ok(intelResult.breakdown.yield.dynamic_fee_bonus > 0, "Intel yield breakdown contains dynamic_fee_bonus");

  console.log("✅ scoreYield dynamic fee surge bonus passed");
}

console.log("🎉 ALL TX VELOCITY & SCREENING TESTS PASSED!");
