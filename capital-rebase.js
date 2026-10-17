/**
 * Capital change re-bases every %-of-capital reference on a position (2026-10-17).
 *
 * The external-capital reconciler (state.js updatePnlAndCheckExits) moves `amount_sol` when the
 * operator tops up or partly withdraws an open position. Every exit rule reads PnL as a percent of
 * that capital, and so do the references they compare against — the confirmed peak, the pending
 * peak streak, the trailing arm, the held high, mfe / mae, the TWAP / round-trip tick ring and the
 * exit-signal streak. Left on the old basis, the first reading on the new capital looks like a
 * drop that never happened: FTR-SOL BG8Q1s9B 2026-10-17 23:14 WIB — the operator added ◎0.349 to a
 * ◎0.3079 position, the peak was re-anchored to 5.51 % (the same ◎0.017 of profit over ◎0.3079),
 * the next valuation read 2.58 % (◎0.017 over ◎0.6569), and trailing TP closed it at once as a
 * 2.93 pp "drop" with overshoot.
 *
 * A SOL amount of profit is unchanged by a top-up, so a percent of the old capital becomes
 * pct × C_old / C_new on the new one. On top of the rescale the position is marked
 * `capital_rebase_pending`: the reading of the tick the change lands on may still be on the old
 * basis (tools/pnl.js pnlPctBasisSol measures a re-ranged position on the TRACKED amount_sol,
 * which moves only in this tick), so no PnL rule acts on it, and the first trusted valuation
 * after it re-bases the peak to the lower of the rescaled peak and that reading — the same move
 * as `hold_resume_rebase`, and trailing cannot fire before it.
 *
 * Pure: mutates only the position object it is given; persistence and logging are the caller's.
 */

const round = (v, dp) => {
  const m = 10 ** dp;
  return Math.round(Number(v) * m) / m;
};
const finite = (v) => v != null && Number.isFinite(Number(v));

/**
 * Move a position's %-references from capital `fromSol` to `toSol` and mark the re-base pending.
 *   peak_pnl_pct, hold_peak_pnl_pct, mfe_pnl_pct, mae_pnl_pct  → × fromSol / toSol
 *   trailing_active                                             → kept only if the rescaled peak
 *                                                                 still reaches triggerPct
 *   pending peak streak, held-high streak                       → cleared (a streak that spans the
 *                                                                 change mixes two bases)
 *   pnl_tick_history (TWAP guard / round-trip frozen test)       → cleared, see below
 *   exit-signal streak, stop / young-stop timers, TWAP deferrals → cleared
 * The tick ring is cleared, not rescaled: the round-trip harvest's frozen-pnl proof ("conversion
 * completed") is about the position's CONTENTS, which the operator just changed — the added SOL
 * can sit in bins that still convert — so it has to be proven again on new readings; the TWAP
 * guard (shadow by default) loses ~5 readings of warm-up. A second change before the re-base
 * settles keeps the first change's `from_sol` and `peak_before`, so the log shows the whole move.
 * Unknown / non-positive capital on either side: nothing is rescaled, the re-base still runs on
 * the next reading (peak = that reading).
 * Returns the pending marker.
 */
export function rescaleCapitalReferences(pos, { fromSol, toSol, triggerPct = null, at = new Date().toISOString() } = {}) {
  const from = Number(fromSol);
  const to = Number(toSol);
  const factor = from > 0 && to > 0 ? from / to : null;
  const prev = pos.capital_rebase_pending && typeof pos.capital_rebase_pending === "object" ? pos.capital_rebase_pending : null;
  const peakBefore = finite(pos.peak_pnl_pct) ? Number(pos.peak_pnl_pct) : null;

  const scale = (v, dp) => (factor != null && finite(v) ? round(Number(v) * factor, dp) : v);
  pos.peak_pnl_pct = factor != null && finite(pos.peak_pnl_pct) ? round(Number(pos.peak_pnl_pct) * factor, 4) : pos.peak_pnl_pct;
  if (pos.hold_peak_pnl_pct != null) pos.hold_peak_pnl_pct = scale(pos.hold_peak_pnl_pct, 4);
  if (pos.mfe_pnl_pct != null) pos.mfe_pnl_pct = scale(pos.mfe_pnl_pct, 2);
  if (pos.mae_pnl_pct != null) pos.mae_pnl_pct = scale(pos.mae_pnl_pct, 2);

  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_confirm_count = 0;
  pos.pending_peak_started_at = null;
  if (pos.hold_peak_pending != null) pos.hold_peak_pending = null;

  const trigger = Number(triggerPct);
  if (pos.trailing_active && (!Number.isFinite(trigger) || !(Number(pos.peak_pnl_pct ?? 0) >= trigger))) {
    pos.trailing_active = false;
  }

  pos.pnl_tick_history = [];
  pos.twap_guard_deferrals = 0;
  pos.pending_exit_action = null;
  pos.pending_exit_count = 0;
  pos.pending_exit_started_at = null;
  pos.pending_exit_context = null;
  pos.stop_loss_violated_since = null;
  pos.young_stop_violated_since = null;

  const marker = {
    at,
    from_sol: prev && finite(prev.from_sol) ? Number(prev.from_sol) : (finite(fromSol) ? Number(fromSol) : null),
    to_sol: finite(toSol) ? Number(toSol) : null,
    peak_before: prev ? (finite(prev.peak_before) ? Number(prev.peak_before) : null) : peakBefore,
    peak_rescaled: finite(pos.peak_pnl_pct) ? Number(pos.peak_pnl_pct) : null,
  };
  marker.delta_sol = finite(marker.from_sol) && finite(marker.to_sol) ? round(marker.to_sol - marker.from_sol, 4) : null;
  pos.capital_rebase_pending = marker;
  return marker;
}

/**
 * Settle a pending capital re-base on a trusted reading taken on the new capital: the peak becomes
 * the lower of the rescaled peak and the reading (a reading above it is a new high that the
 * normal peak confirmation raises later), the pending peak streak is dropped and the marker
 * cleared. Trailing is left as rescaleCapitalReferences set it; the caller's activation check
 * re-arms it from the settled peak. Returns { ...marker, peak_after, reading } or null when nothing
 * was pending or the reading is not a finite number.
 */
export function settleCapitalRebase(pos, readingPct) {
  const marker = pos?.capital_rebase_pending;
  if (!marker) return null;
  if (!finite(readingPct)) return null;
  const reading = Number(readingPct);
  const rescaled = finite(marker.peak_rescaled) ? Number(marker.peak_rescaled) : null;
  pos.peak_pnl_pct = rescaled != null ? Math.min(rescaled, reading) : reading;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_confirm_count = 0;
  pos.pending_peak_started_at = null;
  pos.capital_rebase_pending = null;
  pos.last_capital_rebase = {
    at: new Date().toISOString(),
    from_sol: marker.from_sol ?? null,
    to_sol: marker.to_sol ?? null,
    delta_sol: marker.delta_sol ?? null,
    peak_before: marker.peak_before ?? null,
    peak_after: pos.peak_pnl_pct,
  };
  return { ...marker, peak_after: pos.peak_pnl_pct, reading };
}

const pct = (v) => (finite(v) ? `${Number(v).toFixed(2)} %` : "n/a");
const sol = (v) => (finite(v) ? `◎${Number(v).toFixed(4)}` : "◎?");

/**
 * `[CAPITAL_REBASE] FTR-SOL: capital ◎0.3079 → ◎0.6569 (+◎0.3490) — peak 5.51 % → 2.58 % on the
 * new capital, trailing reference re-based; exit signals cleared`
 */
export function capitalRebaseLine(pair, settled) {
  const d = Number(settled?.delta_sol);
  const delta = Number.isFinite(d) ? `${d >= 0 ? "+" : "−"}◎${Math.abs(d).toFixed(4)}` : "?";
  return `[CAPITAL_REBASE] ${pair}: capital ${sol(settled?.from_sol)} → ${sol(settled?.to_sol)} (${delta}) — peak ${pct(settled?.peak_before)} → ${pct(settled?.peak_after)} on the new capital, trailing reference re-based; exit signals cleared`;
}
