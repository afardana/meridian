process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "assert";

console.log("=== Testing Toxic Inventory Conversion & Surge Decay Guards ===");

const {
  evaluateToxicConversion,
  evaluateSurgeDecay,
  updatePnlAndCheckExits,
  trackPosition,
  ensureStateInitialized,
} = await import("../state.js");

await ensureStateInitialized();

// 1. evaluateToxicConversion unit tests
{
  const now = Date.now();
  const recentDeploy = new Date(now - 10 * 60 * 1000).toISOString(); // 10 minutes ago
  const oldDeploy = new Date(now - 30 * 60 * 1000).toISOString(); // 30 minutes ago

  // Case A: 90% converted to Token X in 10m with 0.2% fee yield -> SHOULD FIRE
  {
    const pos = { deployed_at: recentDeploy };
    const positionData = {
      liq_x_usd: 90,
      liq_y_usd: 10,
      fee_yield_pct: 0.2,
      age_minutes: 10,
    };
    const res = evaluateToxicConversion(pos, positionData, {
      thresholdPct: 85,
      maxAgeMinutes: 20,
      maxFeeYieldPct: 1.5,
    });
    assert.strictEqual(res.wouldFire, true, "Should fire when 90% converted to X in 10m with 0.2% yield");
    assert.strictEqual(res.tokenXRatioPct, 90);
    assert.ok(res.reason.includes("Toxic conversion"), "Reason should mention Toxic conversion");
  }

  // Case B: 90% converted to Token X in 10m but fee yield is 2.5% (healthy trading) -> SHOULD NOT FIRE
  {
    const pos = { deployed_at: recentDeploy };
    const positionData = {
      liq_x_usd: 90,
      liq_y_usd: 10,
      fee_yield_pct: 2.5,
      age_minutes: 10,
    };
    const res = evaluateToxicConversion(pos, positionData, {
      thresholdPct: 85,
      maxAgeMinutes: 20,
      maxFeeYieldPct: 1.5,
    });
    assert.strictEqual(res.wouldFire, false, "Should not fire when fee yield is high (2.5% >= 1.5%)");
  }

  // Case C: 90% converted to Token X but position is 30m old -> SHOULD NOT FIRE (handled by OOR/SL)
  {
    const pos = { deployed_at: oldDeploy };
    const positionData = {
      liq_x_usd: 90,
      liq_y_usd: 10,
      fee_yield_pct: 0.2,
      age_minutes: 30,
    };
    const res = evaluateToxicConversion(pos, positionData, {
      thresholdPct: 85,
      maxAgeMinutes: 20,
      maxFeeYieldPct: 1.5,
    });
    assert.strictEqual(res.wouldFire, false, "Should not fire when age > maxAgeMinutes (30m > 20m)");
  }

  // Case D: Only 60% converted to Token X -> SHOULD NOT FIRE
  {
    const pos = { deployed_at: recentDeploy };
    const positionData = {
      liq_x_usd: 60,
      liq_y_usd: 40,
      fee_yield_pct: 0.2,
      age_minutes: 10,
    };
    const res = evaluateToxicConversion(pos, positionData, {
      thresholdPct: 85,
      maxAgeMinutes: 20,
      maxFeeYieldPct: 1.5,
    });
    assert.strictEqual(res.wouldFire, false, "Should not fire when ratio < threshold (60% < 85%)");
  }

  // Case E: Zero liquidity / empty -> SHOULD NOT FIRE
  {
    const pos = { deployed_at: recentDeploy };
    const positionData = {
      liq_x_usd: 0,
      liq_y_usd: 0,
      fee_yield_pct: 0,
      age_minutes: 5,
    };
    const res = evaluateToxicConversion(pos, positionData, {});
    assert.strictEqual(res.wouldFire, false, "Should fail safe with 0 liquidity");
  }

  // Case F: Inverted pair (Token X is SOL, Token Y is risky token) -> SHOULD FIRE
  {
    const pos = {
      deployed_at: recentDeploy,
      base_mint: "MINT_Y_RISKY",
    };
    const positionData = {
      token_x_mint: "So11111111111111111111111111111111111111112",
      token_y_mint: "MINT_Y_RISKY",
      liq_x_usd: 10,
      liq_y_usd: 90, // 90% in risky Token Y
      fee_yield_pct: 0.2,
      age_minutes: 10,
    };
    const res = evaluateToxicConversion(pos, positionData, {
      thresholdPct: 85,
      maxAgeMinutes: 20,
      maxFeeYieldPct: 1.5,
    });
    assert.strictEqual(res.wouldFire, true, "Inverted pair: should fire when 90% converted to Token Y");
    assert.strictEqual(res.baseRatioPct, 90);
    assert.ok(res.reason.includes("Token Y"), "Reason should specify Token Y");
  }

  // Case G: Deliberately deployed with high initial base inventory (80% >= 70%) -> SHOULD NOT FIRE
  {
    const pos = {
      deployed_at: recentDeploy,
      initial_base_ratio_pct: 80,
    };
    const positionData = {
      liq_x_usd: 90,
      liq_y_usd: 10,
      fee_yield_pct: 0.2,
      age_minutes: 10,
    };
    const res = evaluateToxicConversion(pos, positionData, {
      thresholdPct: 85,
      maxAgeMinutes: 20,
      maxFeeYieldPct: 1.5,
    });
    assert.strictEqual(res.wouldFire, false, "Should not fire if initial entry base inventory was >= 70%");
    assert.ok(res.reason.includes("Deliberate high initial base inventory"));
  }

  console.log("✅ evaluateToxicConversion unit tests passed");
}

// 2. evaluateSurgeDecay unit tests
{
  const now = Date.now();
  const matureDeploy = new Date(now - 25 * 60 * 1000).toISOString(); // 25 minutes ago
  const veryYoungDeploy = new Date(now - 5 * 60 * 1000).toISOString(); // 5 minutes ago

  // Case A: Dynamic fee dropped from 4.0% to 1.0% (75% drop >= 50%) at age 25m, PnL +2.0% -> SHOULD FIRE
  {
    const pos = {
      deployed_at: matureDeploy,
      peak_dynamic_fee_pct: 4.0,
      peak_fee_per_tvl_24h: 3.0,
    };
    const positionData = {
      pnl_pct: 2.0,
      dynamic_fee_pct: 1.0,
      fee_per_tvl_24h: 3.0,
      age_minutes: 25,
    };
    const res = evaluateSurgeDecay(pos, positionData, {
      surgeDecayThresholdPct: 50,
      surgeDecayMinAgeMinutes: 15,
    });
    assert.strictEqual(res.wouldFire, true, "Should fire when dynamic fee collapses >=50%");
    assert.strictEqual(res.type, "dynamic_fee");
    assert.strictEqual(res.dropPct, 75);
    assert.ok(res.reason.includes("Dynamic fee collapsed"), "Reason should describe dynamic fee collapse");
  }

  // Case B: Fee/TVL 24h dropped from 15% to 5% (66.7% drop >= 50%) at age 25m, PnL +1.5% -> SHOULD FIRE
  {
    const pos = {
      deployed_at: matureDeploy,
      peak_dynamic_fee_pct: 0.1, // low dynamic fee
      peak_fee_per_tvl_24h: 15.0,
    };
    const positionData = {
      pnl_pct: 1.5,
      dynamic_fee_pct: 0.1,
      fee_per_tvl_24h: 5.0,
      age_minutes: 25,
    };
    const res = evaluateSurgeDecay(pos, positionData, {
      surgeDecayThresholdPct: 50,
      surgeDecayMinAgeMinutes: 15,
    });
    assert.strictEqual(res.wouldFire, true, "Should fire when fee/TVL collapses >=50%");
    assert.strictEqual(res.type, "fee_tvl");
    assert.ok(res.reason.includes("Fee/TVL yield collapsed"), "Reason should describe fee/TVL collapse");
  }

  // Case C: Position is negative PnL (-3%) -> SHOULD NOT FIRE (surge decay is for rotating winners, not taking losses)
  {
    const pos = {
      deployed_at: matureDeploy,
      peak_dynamic_fee_pct: 4.0,
    };
    const positionData = {
      pnl_pct: -3.0,
      dynamic_fee_pct: 1.0,
      age_minutes: 25,
    };
    const res = evaluateSurgeDecay(pos, positionData, {
      surgeDecayThresholdPct: 50,
      surgeDecayMinAgeMinutes: 15,
    });
    assert.strictEqual(res.wouldFire, false, "Should not fire surge decay when PnL < 0");
  }

  // Case D: Position is younger than min age (5m < 15m) -> SHOULD NOT FIRE
  {
    const pos = {
      deployed_at: veryYoungDeploy,
      peak_dynamic_fee_pct: 4.0,
    };
    const positionData = {
      pnl_pct: 1.0,
      dynamic_fee_pct: 1.0,
      age_minutes: 5,
    };
    const res = evaluateSurgeDecay(pos, positionData, {
      surgeDecayThresholdPct: 50,
      surgeDecayMinAgeMinutes: 15,
    });
    assert.strictEqual(res.wouldFire, false, "Should not fire when age < minAge");
  }

  console.log("✅ evaluateSurgeDecay unit tests passed");
}

// 3. Integration with updatePnlAndCheckExits
{
  const testPosAddr = "TEST_TOXIC_POS_" + Date.now();
  const deployedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago

  trackPosition({
    position: testPosAddr,
    pool: "POOL_TOXIC_TEST",
    pool_name: "DUMP-SOL",
    amount_sol: 1.0,
    deployed_at: deployedAt,
  });

  const positionData = {
    pnl_pct: -8.0,
    pnl_management_ready: true,
    liq_x_usd: 95,
    liq_y_usd: 5, // 95% Token X
    fee_yield_pct: 0.1, // only 0.1% yield
    age_minutes: 5,
    in_range: true,
  };

  const mgmtConfig = {
    stopLossPct: -50,
    toxicConversionEnabled: true,
    toxicConversionThresholdPct: 85,
    toxicConversionMaxAgeMinutes: 20,
    toxicConversionMaxFeeYieldPct: 1.5,
  };

  const exit = updatePnlAndCheckExits(testPosAddr, positionData, mgmtConfig);
  assert.ok(exit, "updatePnlAndCheckExits should return an exit");
  assert.strictEqual(exit.action, "TOXIC_CONVERSION", "Action should be TOXIC_CONVERSION");
  assert.strictEqual(exit.rule, "toxic_conversion", "Rule should be toxic_conversion");

  console.log("✅ updatePnlAndCheckExits TOXIC_CONVERSION integration passed");
}

console.log("🎉 ALL TOXIC CONVERSION & SURGE DECAY TESTS PASSED!");
