import test from "node:test";
import assert from "node:assert/strict";
import {
  computeClusterRiskIndex,
  evaluateClusterRisk,
  formatClusterRisk,
  isExcludedHolder,
  KNOWN_EXCLUDED_ADDRESSES,
} from "../rug-signals.js";
import { scoreSafety, scoreTrust } from "../intel-score.js";
import { computeDevScoreFromTokenInfo } from "../dev-scoring.js";

test("CRI - isExcludedHolder identifies vaults, AMMs, and CEX tags", () => {
  // Known excluded address (e.g. Meteora vault authority)
  const knownAddr = [...KNOWN_EXCLUDED_ADDRESSES][0];
  assert.equal(isExcludedHolder({ address: knownAddr }), true);

  // Address matching name tag
  assert.equal(isExcludedHolder({ address: "random123", name: "Binance Cold Storage" }), true);
  assert.equal(isExcludedHolder({ address: "random456", label: "Raydium AMM Pool" }), true);
  assert.equal(isExcludedHolder({ address: "random789", tag: "Pump.fun Fee Vault" }), true);

  // Regular user holder
  assert.equal(isExcludedHolder({ address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" }), false);
});

test("CRI - computeClusterRiskIndex with HHI and vault exclusion", () => {
  const knownVault = [...KNOWN_EXCLUDED_ADDRESSES][0];
  const holders = [
    { address: knownVault, pct: 40.0 }, // Vault with 40% - MUST be excluded
    { address: "user1", pct: 15.0 },
    { address: "user2", pct: 12.0 },
    { address: "user3", pct: 10.0 },
    { address: "user4", pct: 8.0 },
  ];

  const signals = {
    bundler_pct: 20.0,
    fresh_wallet_pct: 10.0,
  };

  const result = computeClusterRiskIndex(signals, { holders });
  assert.ok(result.cri !== null);
  assert.ok(result.concentration !== null);
  // HHI of 15, 12, 10, 8 => sumSquares = 225 + 144 + 100 + 64 = 533 => sqrt(533) ≈ 23.08
  assert.ok(result.concentration < 30.0, `Expected concentration < 30, got ${result.concentration}`);
  assert.equal(result.bundler_pct, 20.0);
  assert.equal(result.fresh_wallet_pct, 10.0);
  assert.ok(["low", "medium"].includes(result.risk_level));
});

test("CRI - computeClusterRiskIndex fallback to scalar top10", () => {
  const signals = {
    top10_pct: 65.0,
    bundler_pct: 30.0,
    fresh_wallet_pct: 25.0,
  };

  const result = computeClusterRiskIndex(signals);
  assert.equal(result.concentration, 65.0);
  assert.equal(result.bundler_pct, 30.0);
  assert.equal(result.fresh_wallet_pct, 25.0);
  // Weighted: 65*0.4 + 30*0.35 + 25*0.25 = 26 + 10.5 + 6.25 = 42.75 => 42.8
  assert.equal(result.cri, 42.8);
  assert.equal(result.risk_level, "medium");
});

test("CRI - computeClusterRiskIndex fail-open on missing fields", () => {
  const result = computeClusterRiskIndex({});
  assert.equal(result.cri, null);
  assert.equal(result.risk_level, "unknown");

  // Partial: only bundler_pct present
  const partial = computeClusterRiskIndex({ bundler_pct: 50.0 });
  assert.equal(partial.cri, 50.0);
  assert.equal(partial.risk_level, "high");
});

test("CRI - evaluateClusterRisk and formatting", () => {
  const criHigh = { cri: 80.0, risk_level: "critical" };
  const criLow = { cri: 15.0, risk_level: "low" };

  // log_only mode
  const evalLog = evaluateClusterRisk(criHigh, { criFilterMode: "log_only", criRejectThreshold: 75.0 });
  assert.equal(evalLog.would_reject, true);
  assert.equal(evalLog.reject, false);

  // enforce mode
  const evalEnforce = evaluateClusterRisk(criHigh, { criFilterMode: "enforce", criRejectThreshold: 75.0 });
  assert.equal(evalEnforce.would_reject, true);
  assert.equal(evalEnforce.reject, true);

  // Low risk under threshold
  const evalPass = evaluateClusterRisk(criLow, { criFilterMode: "enforce", criRejectThreshold: 75.0 });
  assert.equal(evalPass.would_reject, false);
  assert.equal(evalPass.reject, false);

  // Formatting
  assert.match(formatClusterRisk(criHigh), /🔴 CRI: 80.0% \(critical\)/);
  assert.match(formatClusterRisk(criLow), /🟢 CRI: 15.0% \(low\)/);
  assert.equal(formatClusterRisk({ cri: null }), "CRI: ?");
});

test("Intel Score - Safety continuous penalty from CRI", () => {
  const baseCandidate = {
    freeze_disabled: true,
    mint_disabled: true,
    top_holders_pct: 20,
    bot_holders_pct: 5,
    dev_balance_pct: 0,
    bundler_pct: 5,
  };

  const cleanScore = scoreSafety(baseCandidate).score;
  const penalizedScore = scoreSafety({
    ...baseCandidate,
    cri: { cri: 85.0, risk_level: "critical" },
  }).score;

  assert.ok(penalizedScore < cleanScore, `Expected penalized ${penalizedScore} < clean ${cleanScore}`);
  assert.ok(penalizedScore > 0, "Continuous penalty should not reduce safety to zero");
});

test("Intel Score - Directional Smart Money Flow in scoreTrust", () => {
  const baseCandidate = {
    gmgn_smart_wallets: 3,
    gmgn_kol_wallets: 1,
    token_age_hours: 24,
    organic_score: 80,
  };

  const accCandidate = {
    ...baseCandidate,
    gmgn_smart_accumulating: 3,
    gmgn_smart_exiting: 0,
  };

  const exitCandidate = {
    ...baseCandidate,
    gmgn_smart_accumulating: 0,
    gmgn_smart_exiting: 3,
  };

  const accTrust = scoreTrust(accCandidate).score;
  const exitTrust = scoreTrust(exitCandidate).score;

  assert.ok(accTrust > exitTrust, `Accumulating trust ${accTrust} should exceed exiting trust ${exitTrust}`);
});

test("Dev Scoring - Serial deployer penalty and conviction holding bonus", () => {
  // Serial deployer: 10 open tokens, 0 graduated
  const serialDev = {
    creator_open_count: 10,
    graduated_count: 0,
    creator_token_status: "holding",
    creator_hold_percentage: 10,
  };
  const serialScore = computeDevScoreFromTokenInfo(serialDev);
  assert.equal(serialScore.components.launch_history, 0);

  // Focused dev holding >=50% conviction
  const convictionDev = {
    creator_open_count: 2,
    graduated_count: 1,
    creator_token_status: "holding",
    creator_hold_percentage: 60,
    ath_token_info: { ath_mc: 2_000_000 },
  };
  const convictionScore = computeDevScoreFromTokenInfo(convictionDev);
  assert.equal(convictionScore.components.launch_history, 25);
  assert.equal(convictionScore.components.alignment, 20); // conviction bonus
  assert.equal(convictionScore.components.ath_record, 30);
});
