// fee-edge.js — fees versus the volatility-implied loss, as an entry tag (shadow).
//
// pool-simulator's fee_edge_ratio (effective fee APR ÷ the annualised loss a move through the
// representative range implies) was only shown to the screener as advice. Backtest 2026-10-04,
// 305 bot closes since 08-22 with a reading: edge < 5 → 111 deploys, 14 % at ≤ −10 %, −1.03 SOL;
// edge ≥ 5 → 194, 7 %, +0.85 SOL, and the split holds inside each fee/TVL half, for full-size
// and scout/probe, before and after 09-26 (since 09-26: 14 % vs 7 % disasters, but only
// +0.09 SOL on the skipped side). Rank correlation with pnl is ≈ 0 (0.04): it separates
// disasters, it does not rank winners. Every deploy is tagged so the split can be graded live.
import { simulatePool, representativeDownsidePct } from "./pool-simulator.js";

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Same inputs as the backtest: $100 deposit, 35–69 bin representative range, SOL-below. */
export function computeFeeEdge({ tvl, fee_active_tvl_ratio, volatility, bin_step } = {}, timeframe = "1h") {
  const pool = { tvl: num(tvl), fee_active_tvl_ratio: num(fee_active_tvl_ratio), volatility: num(volatility), bin_step: num(bin_step) };
  if (pool.tvl == null || pool.fee_active_tvl_ratio == null) return null;
  const down = representativeDownsidePct(pool, { minBinsBelow: 35, maxBinsBelow: 69 });
  if (down == null) return null;
  const sim = simulatePool({
    deposit_usd: 100, active_tvl: pool.tvl, fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
    volatility: pool.volatility, timeframe, downside_pct: down, upside_pct: 0, bin_step: pool.bin_step,
  });
  const edge = sim?.error ? null : num(sim?.estimates?.fee_edge_ratio);
  return edge;
}

/** feeEdgeGateMode: off | shadow (enforce is not built). */
export function evaluateFeeEdgeGate(edge, screening = {}) {
  const mode = String(screening.feeEdgeGateMode ?? "shadow");
  const min = num(screening.feeEdgeGateMin) ?? 5;
  const e = num(edge);
  return { edge: e, min, mode, wouldSkip: mode !== "off" && e != null ? e < min : null };
}
