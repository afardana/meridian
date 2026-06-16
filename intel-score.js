/**
 * Multi-Factor Intel Scoring Engine
 *
 * Computes a composite quality score for DLMM pool candidates across
 * four orthogonal dimensions: Safety, Yield, Momentum, and Trust.
 *
 * Each dimension produces a 0-100 sub-score. The final INTEL_SCORE is
 * a weighted average using configurable dimension weights:
 *
 *   INTEL_SCORE = w_safety × SAFETY + w_yield × YIELD
 *                + w_momentum × MOMENTUM + w_trust × TRUST
 *
 * Missing data fields (common when screening source differs or recon
 * hasn't enriched yet) fall back to neutral midpoint values rather
 * than zero, avoiding penalization for absent information.
 */

import { config } from "./config.js";
import { log } from "./logger.js";

// ─── Constants ───────────────────────────────────────────────────

/** @type {{ safety: number, yield: number, momentum: number, trust: number }} */
const DEFAULT_WEIGHTS = { safety: 0.30, yield: 0.35, momentum: 0.20, trust: 0.15 };

const GRADE_THRESHOLDS = [
  { min: 80, grade: "A" },
  { min: 65, grade: "B" },
  { min: 50, grade: "C" },
  { min: 35, grade: "D" },
];

// ─── Utility Helpers ─────────────────────────────────────────────

/**
 * Clamp a value between min and max.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Linear interpolation: maps `v` from [inLo, inHi] to [outLo, outHi], clamped.
 * @param {number} v
 * @param {number} inLo
 * @param {number} inHi
 * @param {number} outLo
 * @param {number} outHi
 * @returns {number}
 */
function lerp(v, inLo, inHi, outLo, outHi) {
  const t = clamp((v - inLo) / (inHi - inLo || 1), 0, 1);
  return outLo + t * (outHi - outLo);
}

/**
 * Safe numeric access with fallback. Handles undefined, null, NaN.
 * @param {*} val
 * @param {number} fallback
 * @returns {number}
 */
function num(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Get the configured intel dimension weights, normalized to sum to 1.0.
 * @returns {{ safety: number, yield: number, momentum: number, trust: number }}
 */
function getWeights() {
  const raw = config.screening?.intelWeights ?? DEFAULT_WEIGHTS;
  const w = {
    safety:   num(raw.safety, DEFAULT_WEIGHTS.safety),
    yield:    num(raw.yield, DEFAULT_WEIGHTS.yield),
    momentum: num(raw.momentum, DEFAULT_WEIGHTS.momentum),
    trust:    num(raw.trust, DEFAULT_WEIGHTS.trust),
  };
  const sum = w.safety + w.yield + w.momentum + w.trust;
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  // Normalize so weights sum to 1.0
  w.safety   /= sum;
  w.yield    /= sum;
  w.momentum /= sum;
  w.trust    /= sum;
  return w;
}

/**
 * Assign a letter grade from a total score.
 * @param {number} total
 * @returns {string}
 */
function toGrade(total) {
  for (const { min, grade } of GRADE_THRESHOLDS) {
    if (total >= min) return grade;
  }
  return "F";
}

// ─── Dimension: SAFETY (0-100) ───────────────────────────────────

/**
 * Evaluate the on-chain safety profile of a candidate.
 *
 * Components:
 *   - mint_disabled (renounced mint authority): 0 or 25
 *   - freeze_disabled (renounced freeze):      0 or 15
 *   - top10_holder_concentration:              0-20 (inverse)
 *   - bundler_pct:                             0-15 (inverse)
 *   - bot_holder_pct:                          0-10 (inverse)
 *   - dev_team_hold_pct:                       0-15 (inverse)
 *
 * @param {object} c - Candidate object
 * @returns {{ score: number, breakdown: object }}
 */
function scoreSafety(c) {
  const breakdown = {};

  // ── mint_disabled: +25 if true ──
  // Sources: audit.mint_disabled (recon), or infer from GMGN filters (renounced)
  const mintDisabled = c.audit?.mint_disabled;
  if (mintDisabled != null) {
    breakdown.mint_disabled = mintDisabled ? 25 : 0;
  } else {
    // Neutral midpoint when unknown
    breakdown.mint_disabled = 12.5;
  }

  // ── freeze_disabled: +15 if true ──
  const freezeDisabled = c.audit?.freeze_disabled;
  if (freezeDisabled != null) {
    breakdown.freeze_disabled = freezeDisabled ? 15 : 0;
  } else {
    breakdown.freeze_disabled = 7.5;
  }

  // ── top10 holder concentration: 0-20 inverse ──
  // <= 20% → 20pts, >= 60% → 0pts
  const top10 = num(c.gmgn_top10_holder_pct ?? c.audit?.top_holders_pct, null);
  if (top10 !== null) {
    breakdown.top10_concentration = lerp(top10, 60, 20, 0, 20);
  } else {
    breakdown.top10_concentration = 10; // midpoint
  }

  // ── bundler_pct: 0-15 inverse ──
  // 0% → 15pts, >= 50% → 0pts
  const bundler = num(c.gmgn_bundler_pct, null);
  if (bundler !== null) {
    breakdown.bundler_pct = lerp(bundler, 50, 0, 0, 15);
  } else {
    breakdown.bundler_pct = 7.5;
  }

  // ── bot_holder_pct: 0-10 inverse ──
  // 0% → 10pts, >= 50% → 0pts
  const botPct = num(c.gmgn_bot_degen_pct ?? c.audit?.bot_holders_pct, null);
  if (botPct !== null) {
    breakdown.bot_holder_pct = lerp(botPct, 50, 0, 0, 10);
  } else {
    breakdown.bot_holder_pct = 5;
  }

  // ── dev_team_hold_pct: 0-15 ──
  // <= 1% → 15pts, >= 5% → 0pts
  const devHold = num(c.gmgn_dev_team_hold_pct, null);
  if (devHold !== null) {
    breakdown.dev_team_hold = lerp(devHold, 5, 1, 0, 15);
  } else {
    breakdown.dev_team_hold = 7.5;
  }

  const score = clamp(
    breakdown.mint_disabled +
    breakdown.freeze_disabled +
    breakdown.top10_concentration +
    breakdown.bundler_pct +
    breakdown.bot_holder_pct +
    breakdown.dev_team_hold,
    0, 100,
  );

  return { score: Math.round(score * 10) / 10, breakdown };
}

// ─── Dimension: YIELD (0-100) ────────────────────────────────────

/**
 * Evaluate the fee-earning potential of a candidate.
 *
 * Components:
 *   - fee_tvl_ratio:   0-40 (fee revenue relative to active TVL)
 *   - volume_tvl:      0-25 (volume turnover vs TVL)
 *   - active_tvl_pct:  0-15 (liquidity concentration in active range)
 *   - fee_trend:       0-20 (fee momentum direction)
 *
 * @param {object} c - Candidate object
 * @returns {{ score: number, breakdown: object }}
 */
function scoreYield(c) {
  const breakdown = {};

  // ── fee_tvl_ratio: 0-40 ──
  // Normalized: min(ratio / 2.0, 1.0) × 40
  const feeRatio = num(c.fee_active_tvl_ratio, null);
  if (feeRatio !== null) {
    breakdown.fee_tvl_ratio = clamp(feeRatio / 2.0, 0, 1) * 40;
  } else {
    breakdown.fee_tvl_ratio = 20; // midpoint
  }

  // ── volume_tvl: 0-25 ──
  // min((volume / tvl) / 5.0, 1.0) × 25
  const volume = num(c.volume_window, 0);
  const tvl = num(c.tvl, 0);
  if (tvl > 0 && volume > 0) {
    breakdown.volume_tvl = clamp((volume / tvl) / 5.0, 0, 1) * 25;
  } else {
    breakdown.volume_tvl = 12.5;
  }

  // ── active_tvl_pct: 0-15 ──
  // min((active_tvl / tvl) / 0.5, 1.0) × 15
  const activeTvl = num(c.active_tvl, 0);
  if (tvl > 0 && activeTvl > 0) {
    breakdown.active_tvl_pct = clamp((activeTvl / tvl) / 0.5, 0, 1) * 15;
  } else {
    breakdown.active_tvl_pct = 7.5;
  }

  // ── fee_trend: 0-20 ──
  // clamp((fee_change_pct + 50) / 100, 0, 1) × 20
  const feeChange = num(c.fee_change_pct, null);
  if (feeChange !== null) {
    breakdown.fee_trend = clamp((feeChange + 50) / 100, 0, 1) * 20;
  } else {
    breakdown.fee_trend = 10;
  }

  const score = clamp(
    breakdown.fee_tvl_ratio +
    breakdown.volume_tvl +
    breakdown.active_tvl_pct +
    breakdown.fee_trend,
    0, 100,
  );

  return { score: Math.round(score * 10) / 10, breakdown };
}

// ─── Dimension: MOMENTUM (0-100) ─────────────────────────────────

/**
 * Score price momentum using a bell-curve piecewise function.
 * Moderate positive price action is ideal; extreme moves are risky.
 *
 * Mapping: -50% → 0, 0% → 12, +20% → 25, +100% → 15
 *
 * @param {number} pct - Price change percentage
 * @returns {number} Score 0-25
 */
function priceTrendScore(pct) {
  if (pct <= -50) return 0;
  if (pct <= 0)   return lerp(pct, -50, 0, 0, 12);
  if (pct <= 20)  return lerp(pct, 0, 20, 12, 25);
  if (pct <= 100) return lerp(pct, 20, 100, 25, 15);
  // > 100%: too hot, diminishing score
  return Math.max(5, lerp(pct, 100, 300, 15, 5));
}

/**
 * Evaluate the trading momentum signals of a candidate.
 *
 * Components:
 *   - price_trend:              0-25 (bell curve, moderate positive best)
 *   - unique_traders:           0-25 (breadth of participation)
 *   - buy_sell_ratio:           0-25 (buying pressure from 1h stats)
 *   - indicator_confirmation:   0-25 (technical indicator alignment)
 *
 * @param {object} c - Candidate object
 * @returns {{ score: number, breakdown: object }}
 */
function scoreMomentum(c) {
  const breakdown = {};

  // ── price_trend: 0-25 ──
  const priceChange = num(c.price_change_pct, null);
  if (priceChange !== null) {
    breakdown.price_trend = priceTrendScore(priceChange);
  } else {
    breakdown.price_trend = 12.5;
  }

  // ── unique_traders: 0-25 ──
  // min(unique_traders / 200, 1.0) × 25
  const traders = num(c.unique_traders, null);
  if (traders !== null) {
    breakdown.unique_traders = clamp(traders / 200, 0, 1) * 25;
  } else {
    breakdown.unique_traders = 12.5;
  }

  // ── buy_sell_ratio: 0-25 ──
  // From stats_1h: buy_vol / (buy_vol + sell_vol)
  // Ratio > 0.5 = buying pressure. min((ratio - 0.3) / 0.4, 1.0) × 25
  const buyVol = num(c.stats_1h?.buy_vol, 0);
  const sellVol = num(c.stats_1h?.sell_vol, 0);
  const totalVol = buyVol + sellVol;
  if (totalVol > 0) {
    const ratio = buyVol / totalVol;
    breakdown.buy_sell_ratio = clamp((ratio - 0.3) / 0.4, 0, 1) * 25;
  } else {
    breakdown.buy_sell_ratio = 12.5; // neutral when no 1h data
  }

  // ── indicator_confirmation: 0-25 ──
  const ic = c.indicator_confirmation;
  if (ic != null) {
    if (typeof ic === "object") {
      // Object with bullish/bearish signals
      breakdown.indicator_confirmation = ic.bullish ? 25 : (ic.bearish ? 0 : 12.5);
    } else if (typeof ic === "boolean") {
      breakdown.indicator_confirmation = ic ? 25 : 0;
    } else if (typeof ic === "string") {
      const lower = ic.toLowerCase();
      breakdown.indicator_confirmation = lower.includes("bull") || lower.includes("confirm") ? 25
        : lower.includes("bear") || lower.includes("reject") ? 0
        : 12.5;
    } else {
      breakdown.indicator_confirmation = 12.5;
    }
  } else {
    breakdown.indicator_confirmation = 12.5; // neutral when absent
  }

  const score = clamp(
    breakdown.price_trend +
    breakdown.unique_traders +
    breakdown.buy_sell_ratio +
    breakdown.indicator_confirmation,
    0, 100,
  );

  return { score: Math.round(score * 10) / 10, breakdown };
}

// ─── Dimension: TRUST (0-100) ────────────────────────────────────

/**
 * Score token age maturity using a piecewise linear ramp.
 * 0h → 0, 2h → 3, 12h → 8, 48h+ → 15.
 *
 * @param {number} hours
 * @returns {number} Score 0-15
 */
function ageMaturScore(hours) {
  if (hours <= 0)  return 0;
  if (hours <= 2)  return lerp(hours, 0, 2, 0, 3);
  if (hours <= 12) return lerp(hours, 2, 12, 3, 8);
  if (hours <= 48) return lerp(hours, 12, 48, 8, 15);
  return 15;
}

/**
 * Evaluate the social proof and trustworthiness of a candidate.
 *
 * Components:
 *   - organic_score:          0-30 (trading organicity)
 *   - smart_wallet_presence:  0-25 (smart money conviction)
 *   - kol_presence:           0-15 (KOL endorsement)
 *   - pool_maturity:          0-15 (token age stability)
 *   - narrative_quality:      fixed 7.5 (unavailable at scoring time)
 *
 * Note: Narrative data is fetched during recon (after scoring), so we
 * always assign a neutral 7.5/15. This caps the maximum attainable
 * Trust score at ~92.5 without post-recon re-scoring.
 *
 * @param {object} c - Candidate object
 * @returns {{ score: number, breakdown: object }}
 */
function scoreTrust(c) {
  const breakdown = {};

  // ── organic_score: 0-25 ──
  // min(organic / 100, 1.0) × 25
  const organic = num(c.organic_score, null);
  if (organic !== null) {
    breakdown.organic_score = clamp(organic / 100, 0, 1) * 25;
  } else {
    breakdown.organic_score = 12.5; // midpoint
  }

  // ── smart_wallet_presence: 0-20 ──
  // min(smart_wallets / 3, 1.0) × 20
  const smartWallets = num(c.gmgn_smart_wallets, null);
  if (smartWallets !== null) {
    breakdown.smart_wallet_presence = clamp(smartWallets / 3, 0, 1) * 20;
  } else {
    breakdown.smart_wallet_presence = 10;
  }

  // ── kol_presence: 0-15 ──
  // min(kol_wallets / 2, 1.0) × 10 + (preferred_matches > 0 ? 5 : 0)
  const kolWallets = num(c.gmgn_kol_wallets, null);
  const prefMatches = num(c.gmgn_preferred_kol_matches, 0);
  if (kolWallets !== null) {
    breakdown.kol_presence = clamp(kolWallets / 2, 0, 1) * 10 + (prefMatches > 0 ? 5 : 0);
  } else {
    breakdown.kol_presence = 7.5;
  }

  // ── pool_maturity: 0-10 ──
  const ageHours = num(c.token_age_hours, null);
  if (ageHours !== null) {
    breakdown.pool_maturity = ageMaturScore(ageHours) * (10 / 15); // scale from 0-15 range to 0-10
  } else {
    breakdown.pool_maturity = 5;
  }

  // ── dev_reputation: 0-20 ──
  // Sourced from computeDevScore() in dev-scoring.js, set as candidate._devScore
  const devScore = num(c._devScore?.total ?? c._devScore, null);
  if (devScore !== null) {
    breakdown.dev_reputation = clamp(devScore / 100, 0, 1) * 20;
  } else {
    breakdown.dev_reputation = 10; // neutral midpoint
  }

  // ── narrative_quality: fixed 5/10 ──
  // Narrative is not available at scoring time (fetched during recon).
  breakdown.narrative_quality = 5;

  const score = clamp(
    breakdown.organic_score +
    breakdown.smart_wallet_presence +
    breakdown.kol_presence +
    breakdown.pool_maturity +
    breakdown.dev_reputation +
    breakdown.narrative_quality,
    0, 100,
  );

  return { score: Math.round(score * 10) / 10, breakdown };
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Compute the composite multi-factor Intel Score for a pool candidate.
 *
 * The score aggregates four dimensions (Safety, Yield, Momentum, Trust)
 * using configurable weights from `config.screening.intelWeights`.
 *
 * Missing candidate fields are handled gracefully with neutral midpoint
 * fallbacks so that absent data does not penalize the candidate.
 *
 * @param {object} candidate - Condensed pool candidate from screening
 * @returns {{
 *   total: number,
 *   safety: number,
 *   yield: number,
 *   momentum: number,
 *   trust: number,
 *   breakdown: {
 *     safety: object,
 *     yield: object,
 *     momentum: object,
 *     trust: object,
 *   },
 *   grade: string,
 * }}
 */
export function computeIntelScore(candidate) {
  if (!candidate) {
    log("intel_score_warn", "computeIntelScore called with null/undefined candidate");
    return {
      total: 0, safety: 0, yield: 0, momentum: 0, trust: 0,
      breakdown: { safety: {}, yield: {}, momentum: {}, trust: {} },
      grade: "F",
    };
  }

  const w = getWeights();

  const safety   = scoreSafety(candidate);
  const yld      = scoreYield(candidate);
  const momentum = scoreMomentum(candidate);
  const trust    = scoreTrust(candidate);

  const total = Math.round(
    (w.safety * safety.score +
     w.yield * yld.score +
     w.momentum * momentum.score +
     w.trust * trust.score) * 10,
  ) / 10;

  const grade = toGrade(total);

  return {
    total,
    safety:   safety.score,
    yield:    yld.score,
    momentum: momentum.score,
    trust:    trust.score,
    breakdown: {
      safety:   safety.breakdown,
      yield:    yld.breakdown,
      momentum: momentum.breakdown,
      trust:    trust.breakdown,
    },
    grade,
  };
}

/**
 * Format an Intel Score result into a compact one-line string
 * suitable for LLM prompt injection.
 *
 * @example
 * formatIntelScore(score) → "[INTEL: 72/100 B | Safety:85 Yield:68 Momentum:55 Trust:78]"
 *
 * @param {{ total: number, safety: number, yield: number, momentum: number, trust: number, grade: string }} intelScore
 * @returns {string}
 */
export function formatIntelScore(intelScore) {
  if (!intelScore) return "[INTEL: N/A]";
  const { total, safety, yield: yld, momentum, trust, grade } = intelScore;
  return `[INTEL: ${Math.round(total)}/100 ${grade} | Safety:${Math.round(safety)} Yield:${Math.round(yld)} Momentum:${Math.round(momentum)} Trust:${Math.round(trust)}]`;
}
