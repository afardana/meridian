/**
 * PnL Curve Simulator.
 *
 * Given an open DLMM position, computes position value (and PnL) across a sweep
 * of hypothetical prices spanning its range — "what would my PnL be if price
 * moves to X?". Also emits a quote-hold reference line (value if we'd kept 100%
 * quote / SOL) so the LP curve can be compared against simply holding.
 *
 * Model — concentrated-liquidity closed form, decimal-free.
 * A DLMM spot position over [P_lower, P_upper] approximates a Uniswap-V3-style
 * position with constant liquidity L. Working in *relative* price r = P / P0
 * (P0 = current price) removes the need for token decimals or an absolute price
 * feed: bin prices are pure ratios of the bin step. With
 *
 *   s = bin_step / 10_000
 *   P_lower_rel = (1 + s) ^ (lower_bin - active_bin)
 *   P_upper_rel = (1 + s) ^ (upper_bin - active_bin)
 *   a = sqrt(P_lower_rel),  b = sqrt(P_upper_rel)
 *
 * value(r) / L =
 *   r ∈ (−∞, P_lower_rel] : (1/a − 1/b) · r          (all base token)
 *   r ∈ [P_upper_rel, ∞)  : (b − a)                  (all quote token)
 *   in range              : 2·sqrt(r) − r/b − a
 *
 * L is solved from the current value at r = 1. Fees are price-invariant, so the
 * unclaimed + collected fee total is added as a flat offset to every point.
 *
 * This is an approximation: real DLMM liquidity need not be perfectly uniform
 * across bins, and the active-bin composition is idealized. It is intended for
 * intuition ("how does my downside look across the range"), not settlement.
 */

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} params
 * @param {number} params.lower_bin
 * @param {number} params.upper_bin
 * @param {number} params.active_bin
 * @param {number} params.bin_step          - bin step in basis points (e.g. 100 = 1%)
 * @param {number} params.current_value_usd - current position liquidity value (excl. fees)
 * @param {number} [params.initial_value_usd] - deposit value, for PnL baseline
 * @param {number} [params.fees_usd]         - unclaimed + collected fees (flat offset)
 * @param {number} [params.points=21]        - number of price samples (odd → includes r=1)
 * @param {number} [params.range_pad=0.15]   - fraction beyond the bin range to sweep
 * @returns {object} simulation result with a `curve` array and summary fields
 */
export function simulatePnlCurve({
  lower_bin,
  upper_bin,
  active_bin,
  bin_step,
  current_value_usd,
  initial_value_usd = null,
  fees_usd = 0,
  points = 21,
  range_pad = 0.15,
} = {}) {
  const lower = numeric(lower_bin);
  const upper = numeric(upper_bin);
  const active = numeric(active_bin);
  const step = numeric(bin_step);
  const curVal = numeric(current_value_usd);

  if (lower == null || upper == null || active == null || step == null || step <= 0) {
    return { error: "missing/invalid bins or bin_step" };
  }
  if (curVal == null || curVal <= 0) {
    return { error: "missing/invalid current_value_usd" };
  }
  if (upper <= lower) {
    return { error: "upper_bin must exceed lower_bin" };
  }

  const s = step / 10_000;
  const pLowerRel = Math.pow(1 + s, lower - active);
  const pUpperRel = Math.pow(1 + s, upper - active);
  const a = Math.sqrt(pLowerRel);
  const b = Math.sqrt(pUpperRel);
  const fees = numeric(fees_usd) ?? 0;

  // value(r)/L for the three regimes.
  const valuePerL = (r) => {
    if (r <= pLowerRel) return (1 / a - 1 / b) * r;
    if (r >= pUpperRel) return b - a;
    return 2 * Math.sqrt(r) - r / b - a;
  };

  // Solve L so that LP liquidity value at r=1 equals current_value_usd.
  // (r=1 may sit outside [pLowerRel,pUpperRel] when the position is OOR.)
  const refPerL = valuePerL(1);
  if (!(refPerL > 0)) return { error: "degenerate position geometry" };
  const L = curVal / refPerL;

  // Quote-hold reference: holding the all-quote amount the position would have at
  // the top of its range (b - a) · L — i.e. fully converted to quote. Flat in r.
  const quoteHoldValue = (b - a) * L;

  const baseline = numeric(initial_value_usd);
  const n = Math.max(5, Math.floor(points));
  const rLo = pLowerRel * (1 - range_pad);
  const rHi = pUpperRel * (1 + range_pad);

  const curve = [];
  for (let i = 0; i < n; i++) {
    const r = rLo + ((rHi - rLo) * i) / (n - 1);
    const lpLiquidity = valuePerL(r) * L;
    const lpValue = lpLiquidity + fees;
    const priceMovePct = (r - 1) * 100;
    const point = {
      price_move_pct: Math.round(priceMovePct * 100) / 100,
      price_rel: Math.round(r * 10000) / 10000,
      lp_value_usd: Math.round(lpValue * 10000) / 10000,
      quote_hold_usd: Math.round((quoteHoldValue + fees) * 10000) / 10000,
      in_range: r >= pLowerRel && r <= pUpperRel,
    };
    if (baseline != null && baseline > 0) {
      point.lp_pnl_pct = Math.round(((lpValue - baseline) / baseline) * 10000) / 100;
    }
    curve.push(point);
  }

  return {
    range: {
      price_lower_rel: Math.round(pLowerRel * 10000) / 10000,
      price_upper_rel: Math.round(pUpperRel * 10000) / 10000,
      downside_pct: Math.round((pLowerRel - 1) * 10000) / 100,
      upside_pct: Math.round((pUpperRel - 1) * 10000) / 100,
    },
    current: {
      value_usd: curVal,
      fees_usd: fees,
      initial_value_usd: baseline,
      lp_pnl_pct: baseline != null && baseline > 0
        ? Math.round(((curVal + fees - baseline) / baseline) * 10000) / 100
        : null,
    },
    quote_hold_usd: Math.round((quoteHoldValue + fees) * 10000) / 10000,
    curve,
    note: "Approximation: assumes uniform CL liquidity across the range; for intuition, not settlement.",
  };
}
