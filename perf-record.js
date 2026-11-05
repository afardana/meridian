/**
 * Perf-record assembly for the three close sites in tools/dlmm.js (2026-11-05).
 *
 * Leaf module: imports only state.js / rug-latch.js / first-entry-probation.js
 * (no RPC, no SDK), so the record shape can be tested without a chain.
 *
 *   rebalanceLegPerfRecord      — recordRebalanceLegPerformance (pnl_source rebalance_leg)
 *   externalReconcilePerfRecord — reconcileExternallyClosedPosition (external_reconcile)
 *   closePositionPerfRecord     — closePosition (closed_api | cache_fallback | none)
 *
 * Each returns the object the site passes to lessons.recordPerformance().
 */
import { adoptionPrePnlSol, holdRecordFields, profitShadowRecordFields } from "./state.js";
import { rugLatchRecordFields } from "./rug-latch.js";
import { firstEntryRecordFields } from "./first-entry-probation.js";

/**
 * How a close was scored (2026-10-07) — spread into every perf record.
 *   pnl_source           closed_api | cache_fallback | external_reconcile | rebalance_leg (| none)
 *   adoption_pre_pnl_sol lifetime pnl the account carried at adoption (number) when an
 *                        adoption basis existed, else null
 */
export function closeScoringStamp(source, tracked, { rebaseSkipped = null } = {}) {
  const stamp = { pnl_source: source || "none", adoption_pre_pnl_sol: adoptionPrePnlSol(tracked) };
  if (rebaseSkipped) stamp.adoption_rebase_skipped = rebaseSkipped;
  return stamp;
}

export function rebalanceLegPerfRecord({ snapshot, recovered, position_address, pool_address, new_position_address, reason, gas_sol, adoptionLifetime, adoptionRebaseSkipped, rangeWidth, minutesHeld, minutesOOR, closedAt }) {
  return {
    position: position_address,
    pool: pool_address,
    pool_name: snapshot.pool_name || pool_address.slice(0, 8),
    base_mint: snapshot.base_mint || snapshot.asset_profile?.token_x_mint || null,
    asset_profile: snapshot.asset_profile ?? null,
    strategy: snapshot.strategy,
    management_profile: snapshot.management_profile || null,
    bin_range: snapshot.bin_range,
    bin_step: snapshot.bin_step || null,
    volatility: snapshot.volatility ?? null,
    fee_tvl_ratio: snapshot.fee_tvl_ratio || null,
    fee_efficiency: snapshot.fee_efficiency ?? null,
    organic_momentum: snapshot.organic_momentum ?? null,
    organic_score: snapshot.organic_score || null,
    amount_sol: snapshot.amount_sol ?? recovered.initial_sol_true,
    pnl_sol: recovered.pnl_sol,
    pnl_usd_true: recovered.pnl_usd_true,
    fees_sol_true: recovered.fees_sol_true,
    fees_usd_true: recovered.fees_usd_true,
    deposit_sol_true: recovered.initial_sol_true,
    deposit_usd_true: recovered.initial_usd_true,
    scout: snapshot.scout || undefined,
    probe: snapshot.probe || undefined,
    low_conviction: snapshot.low_conviction || undefined,
    adopted: snapshot.adopted || undefined,
    range_width_bins: rangeWidth,
    entry_price_change_pct: snapshot.entry_price_change_pct ?? null,
    entry_price_change_24h_pct: snapshot.entry_price_change_24h_pct ?? null,
    pump_gate_would_skip: snapshot.pump_gate_would_skip ?? null,
    entry_fee_edge: snapshot.entry_fee_edge ?? null,
    fee_edge_gate_would_skip: snapshot.fee_edge_gate_would_skip ?? null,
    // display-only entry cost of the base-token purchases (net-cost.js), kept for comparison with the close audit
    entry_cost_sol: snapshot.entry_cost_sol ?? null,
    entry_cost_source: snapshot.entry_cost_source ?? null,
    prev_close_pct: snapshot.prev_close_pct ?? null,
    prev_close_gap_min: snapshot.prev_close_gap_min ?? null,
    reentry_gate_would_skip: snapshot.reentry_gate_would_skip ?? null,
    entry_pool_age_h: snapshot.entry_pool_age_h ?? null,
    entry_runup_from_low_pct: snapshot.entry_runup_from_low_pct ?? null,
    entry_off_high_pct: snapshot.entry_off_high_pct ?? null,
    entry_vs_first_open_pct: snapshot.entry_vs_first_open_pct ?? null,
    lane: snapshot.lane ?? null,
    straddle_count: snapshot.straddle_count ?? 0,
    adoption_lifetime: adoptionLifetime,
    ...closeScoringStamp("rebalance_leg", snapshot, { rebaseSkipped: adoptionRebaseSkipped }),
    rebalance_leg: true,
    rebalanced_into: new_position_address,
    rebalance_count: snapshot.rebalance_count ?? 0,
    rebalance_events: Array.isArray(snapshot.rebalance_events) ? snapshot.rebalance_events : null,
    straddle_gate_events: Array.isArray(snapshot.straddle_gate_events) ? snapshot.straddle_gate_events : null,
    parent_position: snapshot.parent_position ?? null,
    mfe_pnl_pct: snapshot.mfe_pnl_pct ?? null,
    mae_pnl_pct: snapshot.mae_pnl_pct ?? null,
    max_bins_below: snapshot.max_bins_below ?? null,
    max_bins_above: snapshot.max_bins_above ?? null,
    peak_pnl_pct: snapshot.peak_pnl_pct ?? null,
    ...holdRecordFields(snapshot), // was_held, hold_peak_pnl_pct (held high when closed while held)
    ...rugLatchRecordFields(snapshot), // rug_latch: in-range rug latch summary (armed / cancelled), null if never armed
    ...firstEntryRecordFields(snapshot), // first_entry(_strict), organic_score_exact_75, first_entry_probation (would-fire)
    grace_release_shadow: snapshot.grace_release_shadow ?? null,
    ...profitShadowRecordFields(snapshot), // grace_shadow (no-grace counterfactual), trail_straddle_shadow (3 % trigger verdict) — log only
    grace_stop_paused: snapshot.grace_stop_paused ?? null, // a stop that a profit grace held back (profitGraceStopLossMode=paused)
    adoption_pnl_shadow: snapshot.adoption_pnl_shadow ?? null,
    twap_guard_deferrals_total: snapshot.twap_guard_deferrals_total ?? null,
    fees_earned_usd: recovered.fees_value,
    final_value_usd: recovered.final_value,
    initial_value_usd: recovered.initial_value,
    minutes_in_range: Math.max(0, minutesHeld - minutesOOR),
    minutes_held: minutesHeld,
    close_reason: `rebalance: ${reason}`,
    signal_snapshot: snapshot.signal_snapshot ?? null,
    entry_mcap: snapshot.entry_mcap ?? null,
    entry_tvl: snapshot.entry_tvl ?? null,
    entry_volume: snapshot.entry_volume ?? null,
    entry_holders: snapshot.entry_holders ?? null,
    gas_cost_sol: gas_sol,
    total_gas_sol: (Number(snapshot.total_gas_sol ?? snapshot.gas_cost_sol ?? 0) || 0) + (Number(gas_sol) || 0),
    recorded_at: closedAt,
  };
}

export function externalReconcilePerfRecord({ tracked, recovered, position_address, reason, adoptionLifetime, adoptionRebaseSkipped, rangeWidth, minutesHeld, minutesOOR, closedAt }) {
  return {
    position: position_address,
    pool: tracked.pool,
    pool_name: tracked.pool_name || tracked.pool,
    base_mint: tracked.base_mint || tracked.asset_profile?.token_x_mint || null,
    asset_profile: tracked.asset_profile ?? null,
    strategy: tracked.strategy || "manual",
    management_profile: tracked.management_profile || null,
    bin_range: tracked.bin_range,
    bin_step: tracked.bin_step || null,
    volatility: tracked.volatility ?? null,
    fee_tvl_ratio: tracked.fee_tvl_ratio || null,
    fee_efficiency: tracked.fee_efficiency ?? null,
    organic_momentum: tracked.organic_momentum ?? null,
    organic_score: tracked.organic_score || null,
    amount_sol: tracked.amount_sol ?? recovered.initial_sol_true,
    pnl_sol: recovered.pnl_sol,
    pnl_usd_true: recovered.pnl_usd_true,
    fees_sol_true: recovered.fees_sol_true,
    fees_usd_true: recovered.fees_usd_true,
    deposit_sol_true: recovered.initial_sol_true,
    deposit_usd_true: recovered.initial_usd_true,
    scout: tracked.scout || undefined,
    probe: tracked.probe || undefined,
    low_conviction: tracked.low_conviction || undefined,
    adopted: tracked.adopted || undefined,
    range_width_bins: rangeWidth,
    entry_price_change_pct: tracked.entry_price_change_pct ?? null,
    entry_price_change_24h_pct: tracked.entry_price_change_24h_pct ?? null,
    pump_gate_would_skip: tracked.pump_gate_would_skip ?? null,
    entry_fee_edge: tracked.entry_fee_edge ?? null,
    fee_edge_gate_would_skip: tracked.fee_edge_gate_would_skip ?? null,
    // display-only entry cost of the base-token purchases (net-cost.js), kept for comparison with the close audit
    entry_cost_sol: tracked.entry_cost_sol ?? null,
    entry_cost_source: tracked.entry_cost_source ?? null,
    prev_close_pct: tracked.prev_close_pct ?? null,
    prev_close_gap_min: tracked.prev_close_gap_min ?? null,
    reentry_gate_would_skip: tracked.reentry_gate_would_skip ?? null,
    entry_pool_age_h: tracked.entry_pool_age_h ?? null,
    entry_runup_from_low_pct: tracked.entry_runup_from_low_pct ?? null,
    entry_off_high_pct: tracked.entry_off_high_pct ?? null,
    entry_vs_first_open_pct: tracked.entry_vs_first_open_pct ?? null,
    lane: tracked.lane ?? null,
    straddle_count: tracked.straddle_count ?? 0,
    mfe_pnl_pct: tracked.mfe_pnl_pct ?? null,
    mae_pnl_pct: tracked.mae_pnl_pct ?? null,
    max_bins_below: tracked.max_bins_below ?? null,
    max_bins_above: tracked.max_bins_above ?? null,
    peak_pnl_pct: tracked.peak_pnl_pct ?? null,
    ...holdRecordFields(tracked), // was_held, hold_peak_pnl_pct (held high when closed while held)
    ...rugLatchRecordFields(tracked), // rug_latch: in-range rug latch summary (armed / cancelled), null if never armed
    ...firstEntryRecordFields(tracked), // first_entry(_strict), organic_score_exact_75, first_entry_probation (would-fire)
    grace_release_shadow: tracked.grace_release_shadow ?? null,
    ...profitShadowRecordFields(tracked), // grace_shadow (no-grace counterfactual), trail_straddle_shadow (3 % trigger verdict) — log only
    grace_stop_paused: tracked.grace_stop_paused ?? null, // a stop that a profit grace held back (profitGraceStopLossMode=paused)
    adoption_pnl_shadow: tracked.adoption_pnl_shadow ?? null,
    twap_guard_deferrals_total: tracked.twap_guard_deferrals_total ?? null,
    fees_earned_usd: recovered.fees_value,
    final_value_usd: recovered.final_value,
    initial_value_usd: recovered.initial_value,
    minutes_in_range: Math.max(0, minutesHeld - minutesOOR),
    minutes_held: minutesHeld,
    close_reason: reason,
    signal_snapshot: tracked.signal_snapshot ?? null,
    entry_mcap: tracked.entry_mcap ?? null,
    entry_tvl: tracked.entry_tvl ?? null,
    entry_volume: tracked.entry_volume ?? null,
    entry_holders: tracked.entry_holders ?? null,
    gas_cost_sol: 0,
    total_gas_sol: tracked.total_gas_sol ?? tracked.gas_cost_sol ?? 0,
    recorded_at: closedAt,
    external_close: true,
    external_close_source: "meteora_closed_api_reconciliation",
    adoption_lifetime: adoptionLifetime,
    ...closeScoringStamp("external_reconcile", tracked, { rebaseSkipped: adoptionRebaseSkipped }),
    rebalance_count: tracked.rebalance_count ?? 0,
    rebalance_events: Array.isArray(tracked.rebalance_events) ? tracked.rebalance_events : null,
    straddle_gate_events: Array.isArray(tracked.straddle_gate_events) ? tracked.straddle_gate_events : null,
    parent_position: tracked.parent_position ?? null,
  };
}

export function closePositionPerfRecord({ tracked, position_address, poolAddress, poolMeta, closeBaseMint, pnlSol, pnlTrueUsd, feesSolTrue, feesUsdTrue, depSolTrue, depUsdTrue, adoptionLifetime, realizedPnlSource, adoptionRebaseSkipped, feesUsd, finalValueUsd, initialUsd, minutesHeld, minutesOOR, reason, signalSnapshot, close_gas_sol, exitMarket }) {
  return {
    position: position_address,
    pool: poolAddress,
    pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
    base_mint: closeBaseMint,
    asset_profile: tracked.asset_profile ?? null,
    strategy: tracked.strategy,
    management_profile: tracked.management_profile || null,
    bin_range: tracked.bin_range,
    bin_step: tracked.bin_step || null,
    volatility: tracked.volatility ?? null,
    fee_tvl_ratio: tracked.fee_tvl_ratio || null,
    fee_efficiency: tracked.fee_efficiency ?? null,
    organic_momentum: tracked.organic_momentum ?? null,
    organic_score: tracked.organic_score || null,
    amount_sol: tracked.amount_sol,
    pnl_sol: pnlSol,
    pnl_usd_true: pnlTrueUsd,
    fees_sol_true: feesSolTrue || null,
    fees_usd_true: feesUsdTrue || null,
    deposit_sol_true: depSolTrue || null,
    deposit_usd_true: depUsdTrue || null,
    scout: tracked.scout || undefined,
    // Plan #12 cohort/backtest fields: manual (adopted) + probe cohorts stay
    // separable; width + entry price-change make the range-width and
    // "don't chase" rules backtestable from perf records alone.
    probe: tracked.probe || undefined,
    low_conviction: tracked.low_conviction || undefined,
    adopted: tracked.adopted || undefined,
    range_width_bins: (Number.isFinite(Number(tracked.bin_range?.max)) && Number.isFinite(Number(tracked.bin_range?.min)))
      ? Number(tracked.bin_range.max) - Number(tracked.bin_range.min) + 1 : null,
    entry_price_change_pct: tracked.entry_price_change_pct ?? null,
    entry_price_change_24h_pct: tracked.entry_price_change_24h_pct ?? null,
    pump_gate_would_skip: tracked.pump_gate_would_skip ?? null,
    entry_fee_edge: tracked.entry_fee_edge ?? null,
    fee_edge_gate_would_skip: tracked.fee_edge_gate_would_skip ?? null,
    // display-only entry cost of the base-token purchases (net-cost.js), kept for comparison with the close audit
    entry_cost_sol: tracked.entry_cost_sol ?? null,
    entry_cost_source: tracked.entry_cost_source ?? null,
    prev_close_pct: tracked.prev_close_pct ?? null,
    prev_close_gap_min: tracked.prev_close_gap_min ?? null,
    reentry_gate_would_skip: tracked.reentry_gate_would_skip ?? null,
    entry_pool_age_h: tracked.entry_pool_age_h ?? null,
    entry_runup_from_low_pct: tracked.entry_runup_from_low_pct ?? null,
    entry_off_high_pct: tracked.entry_off_high_pct ?? null,
    entry_vs_first_open_pct: tracked.entry_vs_first_open_pct ?? null,
    lane: tracked.lane ?? null,
    straddle_count: tracked.straddle_count ?? 0,
    adoption_lifetime: adoptionLifetime,
    ...closeScoringStamp(realizedPnlSource, tracked, { rebaseSkipped: adoptionRebaseSkipped }),
    rebalance_count: tracked.rebalance_count ?? 0,
    rebalance_events: Array.isArray(tracked.rebalance_events) ? tracked.rebalance_events : null,
    straddle_gate_events: Array.isArray(tracked.straddle_gate_events) ? tracked.straddle_gate_events : null,
    parent_position: tracked.parent_position ?? null,
    // Price-path features tracked per poller tick (state.js updatePnlAndCheckExits)
    mfe_pnl_pct: tracked.mfe_pnl_pct ?? null,
    mae_pnl_pct: tracked.mae_pnl_pct ?? null,
    max_bins_below: tracked.max_bins_below ?? null,
    max_bins_above: tracked.max_bins_above ?? null,
    peak_pnl_pct: tracked.peak_pnl_pct ?? null,
    ...holdRecordFields(tracked), // was_held, hold_peak_pnl_pct (held high when closed while held)
    ...rugLatchRecordFields(tracked), // rug_latch: in-range rug latch summary (armed / cancelled), null if never armed
    ...firstEntryRecordFields(tracked), // first_entry(_strict), organic_score_exact_75, first_entry_probation (would-fire)
    grace_release_shadow: tracked.grace_release_shadow ?? null,
    ...profitShadowRecordFields(tracked), // grace_shadow (no-grace counterfactual), trail_straddle_shadow (3 % trigger verdict) — log only
    grace_stop_paused: tracked.grace_stop_paused ?? null, // a stop that a profit grace held back (profitGraceStopLossMode=paused)
    adoption_pnl_shadow: tracked.adoption_pnl_shadow ?? null,
    // Lifetime TWAP wick-guard deferrals (shadow or enforced). Makes the guard's
    // real cost measurable per close instead of inferable only from log grepping.
    twap_guard_deferrals_total: tracked.twap_guard_deferrals_total ?? null,
    fees_earned_usd: feesUsd,
    final_value_usd: finalValueUsd,
    initial_value_usd: initialUsd,
    minutes_in_range: minutesHeld - minutesOOR,
    minutes_held: minutesHeld,
    close_reason: reason || "agent decision",
    signal_snapshot: signalSnapshot,
    entry_mcap: tracked.entry_mcap ?? null,
    entry_tvl: tracked.entry_tvl ?? null,
    entry_volume: tracked.entry_volume ?? null,
    entry_holders: tracked.entry_holders ?? null,
    gas_cost_sol: close_gas_sol,
    total_gas_sol: (tracked.total_gas_sol ?? tracked.gas_cost_sol ?? 0) + close_gas_sol,
    ...exitMarket,
  };
}
