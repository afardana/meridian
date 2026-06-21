/**
 * Pool Simulator — pre-deploy what-if for a candidate pool + proposed range/deposit.
 *
 * Generalizes the two committed engines:
 *   • fee-efficiency.js — fee yield vs IL risk
 *   • pnl-curve.js      — position value across a price range (CL closed form)
 * …from "an open position" to "a hypothetical deposit", so the agent (or a user)
 * can ask "if I put N USD into this pool over this range, what do APR / IL / fees /
 * risk look like?" before committing gas.
 *
 * ─── Model & assumptions (all ballpark; every intermediate is returned) ───
 *
 * Inputs are pool window metrics (from getPoolDetail) + a proposed range
 * (downside/upside %) + deposit size. The window is the screening timeframe.
 *
 * 1. FEES. The pool earns `fee_active_tvl_ratio`% on its active TVL per window.
 *    A new deposit dilutes that pot, so the in-range fee rate our capital sees is
 *      apr_in_range = annualize(fee_active_tvl_ratio%) × active_tvl/(active_tvl + deposit)
 *    Annualization scales the window rate by (minutes_per_year / window_minutes).
 *
 * 2. TIME IN RANGE. A position only earns while price is inside its bins. We
 *    proxy the probability of staying in range over a HOLDING HORIZON (default 24h,
 *    not a single metric window — positions are held for hours) with a normal-tail
 *    heuristic. Window volatility is scaled to the horizon by √(horizon/window)
 *    before keying off the nearer range edge (see `inRangeFactor`). Tighter range →
 *    higher in-range APR but lower time in range; the effective APR folds both:
 *    apr_effective = apr_in_range × inRangeFactor.
 *
 * 3. IL. Taken from the CL geometry (pnl-curve): value at an adverse move of one
 *    window-volatility vs simply holding, expressed as a negative %.
 *
 * 4. RISK-ADJUSTED SCORE. Sharpe-esque: apr_effective (as a fraction) divided by
 *    the annualized volatility, i.e. expected fee return per unit of price risk.
 *
 * These rely on constants/averages and a single-window horizon — intentionally
 * crude but, per the original framing, "better than nothing". Not for settlement.
 */

import { simulatePnlCurve } from "./pnl-curve.js";

const MINUTES_PER_YEAR = 365 * 24 * 60;
const TIMEFRAME_MINUTES = {
  "5m": 5, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "12h": 720, "24h": 1440,
};

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Heuristic probability that price stays within [−downside, +upside] over one
 * window, given the window volatility. We treat volatility as a rough 1-window
 * stdev of percentage price moves and use the symmetric normal-tail
 * approximation, conservatively keyed off the *nearer* range edge.
 *
 * @param {number} downsidePct - magnitude of downside coverage (positive %)
 * @param {number} upsidePct   - magnitude of upside coverage (positive %)
 * @param {number} horizonVol  - volatility scaled to the holding horizon (% units)
 * @returns {number} 0..1
 */
function inRangeFactor(downsidePct, upsidePct, horizonVol) {
  if (!(horizonVol > 0)) return 0.5; // unknown vol → neutral
  // For a single-sided range, the absent edge is effectively infinite, so the
  // nearer (binding) edge is the non-zero one.
  const edges = [Math.abs(downsidePct), Math.abs(upsidePct)].filter((e) => e > 0);
  const nearEdge = edges.length ? Math.min(...edges) : 0;
  const volatility = horizonVol;
  // z = how many window-stdevs the nearer edge sits from spot.
  const z = nearEdge / volatility;
  // erf-free logistic approximation of P(|move| < edge): saturates ~1 by z≈3.
  return clamp(1 - Math.exp(-0.5 * z * z * 1.1), 0.02, 0.99);
}

/**
 * Simulate a hypothetical deployment.
 *
 * @param {object} params
 * @param {number} params.deposit_usd        - deposit size in USD
 * @param {number} params.active_tvl         - pool active TVL (USD)
 * @param {number} params.fee_active_tvl_ratio - pool fee/active-TVL for the window (percent, e.g. 0.29)
 * @param {number} params.volatility         - window volatility (percent move units)
 * @param {string} [params.timeframe="5m"]   - window the metrics describe
 * @param {number} [params.downside_pct]     - proposed downside coverage (negative or positive magnitude)
 * @param {number} [params.upside_pct=0]     - proposed upside coverage
 * @param {number} [params.bin_step]         - bin step (bps) for the IL geometry; optional
 * @returns {object}
 */
export function simulatePool({
  deposit_usd,
  active_tvl,
  fee_active_tvl_ratio,
  volatility,
  timeframe = "5m",
  downside_pct,
  upside_pct = 0,
  bin_step = null,
  horizon_minutes = 1440,
} = {}) {
  const deposit = numeric(deposit_usd);
  const activeTvl = numeric(active_tvl);
  const feeRatio = numeric(fee_active_tvl_ratio);
  const vol = numeric(volatility);
  const down = Math.abs(numeric(downside_pct) ?? 0);
  const up = Math.abs(numeric(upside_pct) ?? 0);

  if (deposit == null || deposit <= 0) return { error: "deposit_usd must be positive" };
  if (activeTvl == null || activeTvl < 0) return { error: "active_tvl invalid" };
  if (feeRatio == null) return { error: "fee_active_tvl_ratio invalid" };
  if (down <= 0 && up <= 0) return { error: "provide a downside_pct and/or upside_pct range" };

  const windowMin = TIMEFRAME_MINUTES[timeframe] ?? 5;
  const annualFactor = MINUTES_PER_YEAR / windowMin;

  // ── 1. Fees / APR ──────────────────────────────────────────────
  const dilution = activeTvl > 0 ? activeTvl / (activeTvl + deposit) : 1;
  const aprInRangePct = feeRatio * annualFactor * dilution; // already percent units
  // Scale window volatility to the holding horizon for the in-range probability.
  const horizonMin = numeric(horizon_minutes) ?? 1440;
  const horizonVol = vol != null && vol > 0 ? vol * Math.sqrt(Math.max(1, horizonMin) / windowMin) : null;
  const irf = inRangeFactor(down, up, horizonVol);
  const aprEffectivePct = aprInRangePct * irf;
  const estFeesPerWindowUsd = (feeRatio / 100) * deposit * dilution * irf;
  const estFeesAnnualUsd = estFeesPerWindowUsd * annualFactor;

  // ── 2. IL at a one-window adverse move ─────────────────────────
  // Use the CL curve when we have geometry; else fall back to the classic
  // sqrt-price IL formula for a divergence of `vol`%.
  let ilPct = null;
  let ilBasis = null;
  // A typical adverse move over the holding horizon, capped at the lower range
  // edge (beyond it the position is fully converted, so IL stops accruing).
  const adverseVol = horizonVol ?? vol;
  const adverseMove = adverseVol != null && adverseVol > 0
    ? Math.min(adverseVol, down || adverseVol)
    : (down || 0);
  if (bin_step != null && (down > 0 || up > 0)) {
    // Map the proposed % range to bins via the bin step, centered on active.
    const s = Number(bin_step) / 10_000;
    if (s > 0) {
      const binsBelow = down > 0 ? Math.max(1, Math.round(Math.log(1 - down / 100) / Math.log(1 + s) * -1)) : 0;
      const binsAbove = up > 0 ? Math.max(1, Math.round(Math.log(1 + up / 100) / Math.log(1 + s))) : 0;
      const sim = simulatePnlCurve({
        lower_bin: -binsBelow,
        upper_bin: binsAbove || 0,
        active_bin: 0,
        bin_step: Number(bin_step),
        current_value_usd: deposit,
        initial_value_usd: deposit,
        fees_usd: 0,
        points: 41,
      });
      if (!sim.error) {
        // Find the curve point closest to a −adverseMove% move; compare LP vs quote-hold.
        const target = -adverseMove;
        let best = null;
        for (const pt of sim.curve) {
          const d = Math.abs(pt.price_move_pct - target);
          if (best == null || d < best.d) best = { d, pt };
        }
        if (best) {
          const lp = best.pt.lp_value_usd;
          const hold = best.pt.quote_hold_usd; // value if fully held as quote
          if (hold > 0) {
            ilPct = Math.round(((lp - hold) / hold) * 10000) / 100;
            ilBasis = `LP vs quote-hold at ${best.pt.price_move_pct}% move`;
          }
        }
      }
    }
  }
  if (ilPct == null && adverseMove > 0) {
    // Classic IL for a price ratio k = (1 - adverseMove%): 2√k/(1+k) − 1.
    const k = Math.max(0.0001, 1 - adverseMove / 100);
    ilPct = Math.round(((2 * Math.sqrt(k) / (1 + k)) - 1) * 10000) / 100;
    ilBasis = `classic IL at −${adverseMove}% divergence`;
  }

  // ── 3. Risk-adjusted score (Sharpe-esque) ──────────────────────
  const annualVolPct = vol != null && vol > 0 ? vol * Math.sqrt(annualFactor) : null;
  const riskAdjusted = annualVolPct != null && annualVolPct > 0
    ? Math.round((aprEffectivePct / annualVolPct) * 1000) / 1000
    : null;

  return {
    inputs: {
      deposit_usd: deposit,
      active_tvl: activeTvl,
      fee_active_tvl_ratio: feeRatio,
      volatility: vol,
      timeframe,
      downside_pct: down ? -down : 0,
      upside_pct: up,
      bin_step,
      horizon_minutes: horizonMin,
    },
    estimates: {
      apr_in_range_pct: Math.round(aprInRangePct * 10) / 10,
      in_range_factor: Math.round(irf * 1000) / 1000,
      horizon_volatility_pct: horizonVol != null ? Math.round(horizonVol * 10) / 10 : null,
      apr_effective_pct: Math.round(aprEffectivePct * 10) / 10,
      est_fees_per_window_usd: Math.round(estFeesPerWindowUsd * 10000) / 10000,
      est_fees_annual_usd: Math.round(estFeesAnnualUsd * 100) / 100,
      dilution_factor: Math.round(dilution * 1000) / 1000,
      il_pct: ilPct,
      il_basis: ilBasis,
      annualized_volatility_pct: annualVolPct != null ? Math.round(annualVolPct * 10) / 10 : null,
      risk_adjusted_score: riskAdjusted,
    },
    note: "Ballpark estimate: single-window horizon, normal-tail in-range heuristic, uniform CL liquidity. For intuition, not settlement.",
  };
}
