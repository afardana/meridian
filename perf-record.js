/**
 * Perf-record assembly for the three close sites in tools/dlmm.js (2026-11-05).
 *
 * Leaf module: imports only state.js / rug-latch.js / first-entry-probation.js
 * (no RPC, no SDK), so the record shape can be tested without a chain.
 *
 * ONE builder, buildPerfRecord(), assembles every field the three records share from the
 * tracked row (or the rebalance leg's snapshot of it) and the close figures; the three
 * per-site adapters only map their local variables onto it and add what is theirs:
 *
 *   rebalanceLegPerfRecord      — recordRebalanceLegPerformance (pnl_source rebalance_leg)
 *   externalReconcilePerfRecord — reconcileExternallyClosedPosition (external_reconcile)
 *   closePositionPerfRecord     — closePosition (closed_api | cache_fallback | none)
 *
 * Each returns the object the site passes to lessons.recordPerformance(). A field added to a
 * perf record goes into buildPerfRecord once and reaches all three sites.
 *
 * Drift fixed when the three hand-copied literals were merged (test/perf-record-builder.test.js):
 *   (a) minutes_in_range is clamped to [0, minutes_held] for every site (the main close did
 *       not clamp; it never went negative there because its minutesOOR is already capped at
 *       minutesHeld, so no stored value changes for real inputs);
 *   (b) amount_sol falls back to the close's deposit_sol_true when the tracked row has none
 *       (the main close had no fallback and wrote undefined);
 *   (c) recorded_at: the rebalance leg and the external reconcile pass the closed API's
 *       timestamp; the main close passes none and lessons.recordPerformance stamps the record
 *       time (`perf.recorded_at || new Date().toISOString()`) — not stamped twice;
 *   (d) total_gas_sol = Number(prior gas) + Number(this close's gas) at every site (the main
 *       close and the external reconcile added / passed the raw stored value; identical for
 *       numeric inputs).
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

/** Bins in the recorded range (inclusive), null when either edge is unknown. */
export function rangeWidthBins(binRange) {
  return Number.isFinite(Number(binRange?.max)) && Number.isFinite(Number(binRange?.min))
    ? Number(binRange.max) - Number(binRange.min) + 1
    : null;
}

/** Minutes in range = held − out of range, clamped to [0, held]; NaN when held is unknown. */
export function minutesInRange(minutesHeld, minutesOor) {
  return Math.max(0, Math.min(minutesHeld, minutesHeld - minutesOor));
}

/** Gas already booked on the position (total, else the deploy's), as a number. */
function priorGasSol(tracked) {
  return Number(tracked.total_gas_sol ?? tracked.gas_cost_sol ?? 0) || 0;
}

/**
 * The perf record for one close.
 *   source   pnl_source for closeScoringStamp
 *   tracked  the tracked position row (or the rebalance leg's snapshot of it)
 *   close    position, pool, pool_name, [base_mint], the realized figures (pnl_sol,
 *            pnl_usd_true, fees_sol_true, fees_usd_true, deposit_sol_true, deposit_usd_true,
 *            fees_earned_usd, final_value_usd, initial_value_usd), adoption_lifetime,
 *            adoption_rebase_skipped, minutes_held, minutes_oor, close_reason,
 *            [signal_snapshot], gas_sol, [recorded_at]
 *   extra    site-only fields, spread last
 * `base_mint` / `signal_snapshot` given in `close` (even as null) win over the tracked row's.
 */
export function buildPerfRecord({ source, tracked, close, extra = {} }) {
  return {
    position: close.position,
    pool: close.pool,
    pool_name: close.pool_name,
    base_mint: "base_mint" in close ? close.base_mint : (tracked.base_mint || tracked.asset_profile?.token_x_mint || null),
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
    amount_sol: tracked.amount_sol ?? close.deposit_sol_true,
    pnl_sol: close.pnl_sol,
    pnl_usd_true: close.pnl_usd_true,
    fees_sol_true: close.fees_sol_true,
    fees_usd_true: close.fees_usd_true,
    deposit_sol_true: close.deposit_sol_true,
    deposit_usd_true: close.deposit_usd_true,
    scout: tracked.scout || undefined,
    // Plan #12 cohort/backtest fields: manual (adopted) + probe cohorts stay
    // separable; width + entry price-change make the range-width and
    // "don't chase" rules backtestable from perf records alone.
    probe: tracked.probe || undefined,
    low_conviction: tracked.low_conviction || undefined,
    adopted: tracked.adopted || undefined,
    range_width_bins: rangeWidthBins(tracked.bin_range),
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
    adoption_lifetime: close.adoption_lifetime,
    ...closeScoringStamp(source, tracked, { rebaseSkipped: close.adoption_rebase_skipped }),
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
    max_hold_shadow: tracked.max_hold_shadow ?? null, // max-hold.js: first would-fire at the cap (shadow), or the enforced close's
    // Lifetime TWAP wick-guard deferrals (shadow or enforced). Makes the guard's
    // real cost measurable per close instead of inferable only from log grepping.
    twap_guard_deferrals_total: tracked.twap_guard_deferrals_total ?? null,
    fees_earned_usd: close.fees_earned_usd,
    final_value_usd: close.final_value_usd,
    initial_value_usd: close.initial_value_usd,
    minutes_in_range: minutesInRange(close.minutes_held, close.minutes_oor),
    minutes_held: close.minutes_held,
    close_reason: close.close_reason,
    signal_snapshot: "signal_snapshot" in close ? close.signal_snapshot : (tracked.signal_snapshot ?? null),
    entry_mcap: tracked.entry_mcap ?? null,
    entry_tvl: tracked.entry_tvl ?? null,
    entry_volume: tracked.entry_volume ?? null,
    entry_holders: tracked.entry_holders ?? null,
    gas_cost_sol: close.gas_sol,
    total_gas_sol: priorGasSol(tracked) + (Number(close.gas_sol) || 0),
    // (c) the main close leaves the timestamp to lessons.recordPerformance
    ...(close.recorded_at !== undefined ? { recorded_at: close.recorded_at } : {}),
    ...extra,
  };
}

/** Realized figures of a settled Meteora closed record (fetchClosedPositionPnl, after any rebase). */
function recoveredFigures(recovered) {
  return {
    pnl_sol: recovered.pnl_sol,
    pnl_usd_true: recovered.pnl_usd_true,
    fees_sol_true: recovered.fees_sol_true,
    fees_usd_true: recovered.fees_usd_true,
    deposit_sol_true: recovered.initial_sol_true,
    deposit_usd_true: recovered.initial_usd_true,
    fees_earned_usd: recovered.fees_value,
    final_value_usd: recovered.final_value,
    initial_value_usd: recovered.initial_value,
  };
}

/** Plan #15: the old account of a rebalance (close_reason "rebalance: <reason>", rebalance_leg). */
export function rebalanceLegPerfRecord({ snapshot, recovered, position_address, pool_address, new_position_address, reason, gas_sol, adoptionLifetime, adoptionRebaseSkipped, minutesHeld, minutesOOR, closedAt }) {
  return buildPerfRecord({
    source: "rebalance_leg",
    tracked: snapshot,
    close: {
      position: position_address,
      pool: pool_address,
      pool_name: snapshot.pool_name || pool_address.slice(0, 8),
      ...recoveredFigures(recovered),
      adoption_lifetime: adoptionLifetime,
      adoption_rebase_skipped: adoptionRebaseSkipped,
      minutes_held: minutesHeld,
      minutes_oor: minutesOOR,
      close_reason: `rebalance: ${reason}`,
      gas_sol,
      recorded_at: closedAt,
    },
    extra: { rebalance_leg: true, rebalanced_into: new_position_address },
  });
}

/** A close made outside the bot, recovered from Meteora's closed API (no transaction of ours). */
export function externalReconcilePerfRecord({ tracked, recovered, position_address, reason, adoptionLifetime, adoptionRebaseSkipped, minutesHeld, minutesOOR, closedAt }) {
  return buildPerfRecord({
    source: "external_reconcile",
    tracked,
    close: {
      position: position_address,
      pool: tracked.pool,
      pool_name: tracked.pool_name || tracked.pool, // full address, not the 8-char prefix the other sites use
      ...recoveredFigures(recovered),
      adoption_lifetime: adoptionLifetime,
      adoption_rebase_skipped: adoptionRebaseSkipped,
      minutes_held: minutesHeld,
      minutes_oor: minutesOOR,
      close_reason: reason,
      gas_sol: 0,
      recorded_at: closedAt,
    },
    extra: {
      strategy: tracked.strategy || "manual",
      external_close: true,
      external_close_source: "meteora_closed_api_reconciliation",
    },
  });
}

/** The bot's own close (closePosition). Zero realized fees / deposits are stored as null here. */
export function closePositionPerfRecord({ tracked, position_address, poolAddress, poolMeta, closeBaseMint, pnlSol, pnlTrueUsd, feesSolTrue, feesUsdTrue, depSolTrue, depUsdTrue, adoptionLifetime, realizedPnlSource, adoptionRebaseSkipped, feesUsd, finalValueUsd, initialUsd, minutesHeld, minutesOOR, reason, signalSnapshot, close_gas_sol, exitMarket }) {
  return buildPerfRecord({
    source: realizedPnlSource,
    tracked,
    close: {
      position: position_address,
      pool: poolAddress,
      pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
      base_mint: closeBaseMint,
      pnl_sol: pnlSol,
      pnl_usd_true: pnlTrueUsd,
      fees_sol_true: feesSolTrue || null,
      fees_usd_true: feesUsdTrue || null,
      deposit_sol_true: depSolTrue || null,
      deposit_usd_true: depUsdTrue || null,
      fees_earned_usd: feesUsd,
      final_value_usd: finalValueUsd,
      initial_value_usd: initialUsd,
      adoption_lifetime: adoptionLifetime,
      adoption_rebase_skipped: adoptionRebaseSkipped,
      minutes_held: minutesHeld,
      minutes_oor: minutesOOR,
      close_reason: reason || "agent decision",
      signal_snapshot: signalSnapshot,
      gas_sol: close_gas_sol,
    },
    extra: { ...exitMarket }, // exit_mcap / exit_tvl / exit_volume when the pool read succeeded
  });
}
