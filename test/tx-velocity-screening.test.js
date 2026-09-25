import assert from "node:assert/strict";
import { condensePool, getMinTxPerMinForTimeframe } from "../tools/screening.js";
import { scoreMomentum, scoreYield, computeIntelScore } from "../intel-score.js";
import { config } from "../config.js";

console.log("=== Testing Tx Velocity, Volume/TVL Screening & Intel Scoring ===");

// ── 1. condensePool output fields tests ──
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

  const prevTf = config.screening.timeframe;
  config.screening.timeframe = "5m";
  try {
    const condensed = condensePool(rawPool);
    assert.equal(condensed.pool, "pool_condense_test");
    assert.equal(condensed.dynamic_fee_pct, 0.125);
    assert.equal(condensed.tx_per_min, 8);
    assert.equal(condensed.volume_tvl_ratio, 0.125);

    const explicitPool = { ...rawPool, tx_per_min: 14.2 };
    assert.equal(condensePool(explicitPool).tx_per_min, 14.2);
  } finally {
    config.screening.timeframe = prevTf;
  }

  console.log("✅ condensePool output fields verified");
}

// ── 2. scoreMomentum with tx_per_min tests ──
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

// ── 3. scoreYield with dynamic_fee_pct surge bonus tests ──
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
  console.log("✅ scoreYield dynamic fee surge bonus passed");
}

// ── 4. getMinTxPerMinForTimeframe timeframe scaling tests ──
{
  assert.equal(getMinTxPerMinForTimeframe("5m", 5.0), 5.0);
  assert.equal(getMinTxPerMinForTimeframe("1h", 5.0), 2.0);
  assert.equal(getMinTxPerMinForTimeframe("24h", 5.0), 0.8);
  assert.equal(getMinTxPerMinForTimeframe("1h", 1.0), 1.0); // respects lower base
  assert.equal(getMinTxPerMinForTimeframe("1h", null), 0);
  assert.equal(getMinTxPerMinForTimeframe("1h", 0), 0);

  console.log("✅ getMinTxPerMinForTimeframe timeframe scaling tests passed");
}

console.log("🎉 ALL TX VELOCITY & SCREENING TESTS PASSED!");
