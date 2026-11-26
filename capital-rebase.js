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
    count: (pos.last_capital_rebase ? Number(pos.last_capital_rebase.count) || 1 : 0) + 1,
    at: new Date().toISOString(),
    from_sol: marker.from_sol ?? null,
    to_sol: marker.to_sol ?? null,
    delta_sol: marker.delta_sol ?? null,
    peak_before: marker.peak_before ?? null,
    peak_after: pos.peak_pnl_pct,
  };
  return { ...marker, peak_after: pos.peak_pnl_pct, reading };
}

/** A basis below this is treated as absent (rounding residue, never a real position). */
export const AVG_COST_BASIS_MIN_SOL = 1e-6;
/**
 * A reading resolves a pending basis as "clean" only when our PnL and Meteora's reported one agree
 * within this FRACTION of the larger capital (before / after the change), measured in SOL: the
 * row's `pnl_pct_diff` is in pp of the capital the row's percent is on, so
 *   |pnl_pct_diff| / 100 × pctBase ≤ AVG_COST_BASIS_MAX_DIFF_FRAC × max(from_sol, to_sol).
 * A fixed pp bound tightened by from / to exactly in the target case (a position reduced to a
 * third: JIMMY CV7AUcQh logged a 6.37 pp discrepancy on ◎0.99 of a former ◎3.03). A second flow
 * that is on chain but not yet indexed shows up as such a gap.
 */
export const AVG_COST_BASIS_MAX_DIFF_FRAC = 0.03;
/**
 * After this long since the last change the clean requirement is waived: the first reading that
 * passes every other condition resolves the basis (`resolved_by: "timeout"`). Nothing is dropped.
 */
export const AVG_COST_BASIS_PENDING_MAX_MS = 10 * 60_000;

const basisOk = (b) => !!b && typeof b === "object" && typeof b.basis_sol === "number" && Number.isFinite(b.basis_sol) && b.basis_sol >= AVG_COST_BASIS_MIN_SOL;

/**
 * Average-cost basis of what is still in a position after operator capital changes
 * (2026-11-26). `amount_sol` follows Meteora's NET deposit, so a partial withdrawal leaves the
 * SOL loss unchanged and shrinks the capital: the percent jumps with no price move (JIMMY-SOL
 * CV7AUcQh 2026-11-25 22:12 WIB, −8.9 % → −27.3 % at an unchanged bin).
 * Unitised: a flow moves the basis in proportion to the position's equity, so a flow never moves
 * the cost-basis figure — only price does:
 *   B = B_prev × (to + L) / (from + L)          (any net change, B_prev = the existing basis,
 *                                                else `from`)
 * from / to = the capital before the first change of the pending window and the tracked capital
 * when it resolves, L = the SOL PnL of the resolving reading (same basis as pnl_pct). Equity
 * before = from + L, after = to + L. A withdraw-then-re-deposit round trip therefore leaves B
 * where it was (JIMMY: ◎3.0276 → ◎0.9868 → ◎2.8465 at L −0.2694 → B ≈ ◎2.8288).
 * Without an existing basis only a net WITHDRAWAL writes one (a top-up: basis == capital).
 * No net change (to == from): nothing changes.
 * Pure. Returns { action: "write" | "drop" | "none", basis?, reason?, kind? }:
 *   write — the new `avg_cost_basis` object (changes + 1); kind withdrawal | topup
 *   drop  — a basis exists but this change cannot be computed: the stale basis must go
 *   none  — nothing to record (plain top-up, no net change, or no basis and not computable)
 */
export function nextAvgCostBasis(prev, { fromSol, toSol, pnlSol, at = new Date().toISOString(), changes = 1 } = {}) {
  const hasPrev = basisOk(prev);
  const from = Number(fromSol);
  const to = Number(toSol);
  const L = Number(pnlSol);
  const fail = (reason) => (hasPrev ? { action: "drop", reason } : { action: "none", reason });
  if (fromSol == null || toSol == null || !Number.isFinite(from) || !Number.isFinite(to) || !(from > 0) || !(to > 0)) {
    return fail("capital before / after the change is not a positive number");
  }
  if (to === from) return { action: "none", reason: "no net capital change" };
  if (!hasPrev && to > from) return { action: "none", reason: "top-up with no earlier withdrawal (basis is the capital)" };
  if (pnlSol == null || typeof pnlSol === "boolean" || !Number.isFinite(L)) return fail("the resolving reading has no SOL PnL");
  if (!(to + L > 0) || !(from + L > 0)) return fail("position equity before or after the change is not positive");
  const bPrev = hasPrev ? prev.basis_sol : from;
  const basis = bPrev * (to + L) / (from + L);
  if (!Number.isFinite(basis) || !(basis >= AVG_COST_BASIS_MIN_SOL)) return fail("computed basis is not a positive number");
  return {
    action: "write",
    kind: to < from ? "withdrawal" : "topup",
    basis: {
      basis_sol: round(basis, 6),
      at,
      from_sol: from,
      to_sol: to,
      settle_pnl_sol: round(L, 6),
      changes: (hasPrev ? Number(prev.changes) || 1 : 0) + 1,
      flows: Number(changes) > 0 ? Number(changes) : 1,
    },
  };
}

/**
 * The pre-flow SOL PnL (last clean reading, else the stored basis's own L) has NO age cap
 * (2026-11-26, round 5): it is only one candidate in the larger-B choice, so an older value can
 * only enlarge the basis — a stale value brings the figure back toward the plain percent (the old
 * rule's behaviour) rather than under-protecting. The 6-min cap of round 4 dropped JIMMY-type
 * slow bookings to L_now only (the reviewer's 8-min-lag case stored ◎0.65 for a true ◎0.78).
 */

/**
 * Pending marker written at an external capital change (state.js reconcileExternalCapital):
 * keeps the first change's `from_sol` / `first_at` / `pnl_sol_before`, moves `last_change_at`,
 * counts the changes. `pnlSolBefore` / `pnlSolBeforeAt` — the SOL PnL of the last clean reading
 * before the flow — are stored only when this call CREATES the marker.
 * Pure: mutates `pos` only.
 */
export function markAvgCostBasisPending(pos, { fromSol, at = new Date().toISOString(), pnlSolBefore = null, pnlSolBeforeAt = null, pnlSolChange = null } = {}) {
  const prev = pos.avg_cost_basis_pending && typeof pos.avg_cost_basis_pending === "object" ? pos.avg_cost_basis_pending : null;
  const okNum = (v) => v != null && typeof v !== "boolean" && finite(v);
  const before = prev
    ? { pnl_sol_before: prev.pnl_sol_before ?? null, pnl_sol_before_at: prev.pnl_sol_before_at ?? null }
    : (okNum(pnlSolBefore)
      ? { pnl_sol_before: Number(pnlSolBefore), pnl_sol_before_at: pnlSolBeforeAt ?? null }
      : { pnl_sol_before: null, pnl_sol_before_at: null });
  // The SOL PnL on the tick the change was BOOKED. For several changes in one window the FIRST
  // change's value is kept: the window is priced from `from_sol` (the capital before the first
  // change), and the first booking tick is the earliest post-flow reading of that window — a later
  // change's tick can already carry the next flow's unindexed fake, and the max over candidates
  // gains nothing from a second, later value of the same kind.
  const change = prev
    ? { pnl_sol_change: prev.pnl_sol_change ?? null }
    : { pnl_sol_change: okNum(pnlSolChange) ? Number(pnlSolChange) : null };
  pos.avg_cost_basis_pending = {
    from_sol: prev && finite(prev.from_sol) ? Number(prev.from_sol) : (finite(fromSol) ? Number(fromSol) : null),
    first_at: prev?.first_at ?? at,
    last_change_at: at,
    changes: (prev ? Number(prev.changes) || 1 : 0) + 1,
    ...before,
    ...change,
  };
  return pos.avg_cost_basis_pending;
}

/**
 * Does this capital change need a pending marker? Only when something can be written at the
 * resolution: a net withdrawal, any change on a position that already carries a basis, or any
 * change while a marker is open. A plain top-up with neither writes nothing, so it must not
 * pause the limit. Pure.
 */
export function avgCostBasisNeedsPending(pos, deltaSol) {
  if (pos?.avg_cost_basis_pending) return true;
  if (basisOk(pos?.avg_cost_basis)) return true;
  return Number(deltaSol) < 0;
}

const num = (v) => (v != null && typeof v !== "boolean" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * The capital the row's percent is on. Exact when the row carries its deposits (tools/pnl.js
 * `deposit_sol`, else `lifetime_deposits_sol`): mirror of pnlPctBasisSol — a re-ranged position
 * (straddle / rebalance / in-place re-range count > 0) with deposits above its capital is measured
 * on `amount_sol`, everything else on the deposits. Fallback: pnl_sol_rule / pnl_pct × 100, else
 * the tracked capital.
 */
export function rowPctBaseSol(row, amountSol, tracked = null) {
  const dep = num(row?.deposit_sol) ?? num(row?.lifetime_deposits_sol);
  const cap = num(amountSol);
  if (dep != null && dep > 0) {
    const reRanged = Number(tracked?.straddle_count) > 0 || Number(tracked?.rebalance_count) > 0 || Number(tracked?.in_place_rerange_count) > 0;
    return reRanged && cap != null && cap > 0 && dep > cap ? cap : dep;
  }
  const L = num(row?.pnl_sol_rule), pct = num(row?.pnl_pct);
  if (L != null && pct != null && Math.abs(pct) >= 0.05) {
    const b = Math.abs((L / pct) * 100);
    if (Number.isFinite(b) && b > 0) return b;
  }
  return num(amountSol);
}

/**
 * Everything but the diff: may this reading resolve a basis at all? Pure. { ok, reason? }.
 * Management-ready, not suspicious, SOL basis, no capital re-base still pending, no bot flow
 * pending, a finite `pnl_sol_rule` and a finite `net_deposit_sol` (the RPC valuation path — the
 * Meteora fallback row has no on-chain balances to compare against).
 */
export function avgCostBasisReadingUsable(pos, row, { suspect = false, flowPending = false } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!row || row.pnl_management_ready === false) return no("valuation not management-ready");
  if (suspect || row.pnl_pct_suspicious === true) return no("valuation suspect");
  if (row.pnl_basis != null && row.pnl_basis !== "sol") return no("not SOL basis");
  if (pos?.capital_rebase_pending) return no("capital re-base still pending");
  if (flowPending || row.flow_pending === true) return no("bot flow pending");
  if (num(row.pnl_sol_rule) == null) return no("no SOL PnL on the row");
  if (num(row.net_deposit_sol) == null) return no("no on-chain valuation (net deposit unknown)");
  return { ok: true };
}

/**
 * Is this reading clean enough to compute a basis from? Pure. { clean, reason?, diff, diff_sol, bound_sol }.
 * Usable (avgCostBasisReadingUsable) AND a finite `pnl_pct_diff` whose SOL size is within
 * AVG_COST_BASIS_MAX_DIFF_FRAC of the larger capital (marker from_sol vs the tracked capital;
 * with no marker both are the tracked capital). A null diff is not clean.
 */
export function avgCostBasisReadingClean(pos, row, { suspect = false, flowPending = false } = {}) {
  const diff = num(row?.pnl_pct_diff);
  const u = avgCostBasisReadingUsable(pos, row, { suspect, flowPending });
  const amount = num(pos?.amount_sol);
  const fromSol = num(pos?.avg_cost_basis_pending?.from_sol) ?? amount;
  const capMax = Math.max(fromSol ?? 0, amount ?? 0);
  const boundSol = capMax > 0 ? AVG_COST_BASIS_MAX_DIFF_FRAC * capMax : null;
  const base = rowPctBaseSol(row, amount, pos);
  const diffSol = diff != null && base != null ? (Math.abs(diff) / 100) * base : null;
  const no = (reason) => ({ clean: false, reason, diff, diff_sol: diffSol, bound_sol: boundSol });
  if (!u.ok) return no(u.reason);
  if (diff == null) return no("no reported PnL to compare against");
  if (diffSol == null || boundSol == null) return no("capital unknown");
  if (!(diffSol <= boundSol)) return no(`our PnL and Meteora's differ by ${diff.toFixed(2)} pp (◎${diffSol.toFixed(4)} > ◎${boundSol.toFixed(4)}, ${AVG_COST_BASIS_MAX_DIFF_FRAC * 100} % of ◎${capMax.toFixed(4)})`);
  return { clean: true, diff, diff_sol: diffSol, bound_sol: boundSol };
}

/**
 * May this reading resolve the pending basis? Pure; `nowMs` is the caller's clock.
 *   { verdict: "clean", diff, … }    — clean reading: resolve now
 *   { verdict: "timeout", diff, … }  — ≥ AVG_COST_BASIS_PENDING_MAX_MS since the last change and the
 *                                      reading passes every condition but the diff: resolve now
 *   { verdict: "wait", reason, … }   — not this reading
 *   { verdict: "none" }              — no marker
 */
export function avgCostBasisPendingVerdict(pos, row, { nowMs = Date.now(), suspect = false, flowPending = false } = {}) {
  const pend = pos?.avg_cost_basis_pending;
  if (!pend) return { verdict: "none" };
  const c = avgCostBasisReadingClean(pos, row, { suspect, flowPending });
  if (c.clean) return { verdict: "clean", ...c };
  const last = Date.parse(pend.last_change_at);
  const timedOut = !Number.isFinite(last) || nowMs - last >= AVG_COST_BASIS_PENDING_MAX_MS;
  if (timedOut && avgCostBasisReadingUsable(pos, row, { suspect, flowPending }).ok) return { verdict: "timeout", ...c };
  return { verdict: "wait", ...c };
}

/**
 * Resolve a pending basis with the conservative L (index-lag bound, 2026-11-26). Meteora books a
 * flow when it indexes it, not when it lands, so L at the resolution can include price moves of
 * the remainder that happened BEFORE the flow (JIMMY-SOL: the re-deposit landed ≈ 22:13, was
 * booked 22:17:38 after the bin rose 3, L −0.2694 → −0.2032; with L_now the whole gain is credited
 * to the ◎0.72 remainder and B = ◎2.6564, the limit reading −0.5 % instead of ≈ −6.6 %). The true
 * flow time lies between the last clean pre-flow reading and the resolving one, so B is computed
 * with both L_before and L_now and the LARGER B is kept (a larger B gives a lower cost-basis
 * figure — the side closer to the plain percent). With no usable L_before: L_now only.
 * Pure. Same return shape as nextAvgCostBasis; a written basis carries l_source "now" | "before",
 * pnl_sol_now, pnl_sol_before.
 */
export function nextAvgCostBasisBounded(prev, { fromSol, toSol, pnlSolNow, pnlSolBefore = null, pnlSolChange = null, at, changes = 1 } = {}) {
  const now = nextAvgCostBasis(prev, { fromSol, toSol, pnlSol: pnlSolNow, at, changes });
  if (now.action !== "write") return now;
  const lb = num(pnlSolBefore), lc = num(pnlSolChange);
  let best = { r: now, source: "now" };
  for (const [l, source] of [[lb, "before"], [lc, "change"]]) {
    if (l == null) continue;
    const r = nextAvgCostBasis(prev, { fromSol, toSol, pnlSol: l, at, changes });
    if (r.action === "write" && r.basis.basis_sol > best.r.basis.basis_sol) best = { r, source };
  }
  return {
    ...best.r,
    basis: {
      ...best.r.basis, l_source: best.source,
      pnl_sol_now: round(Number(pnlSolNow), 6),
      pnl_sol_before: lb != null ? round(lb, 6) : null,
      pnl_sol_change: lc != null ? round(lc, 6) : null,
    },
  };
}

/**
 * The basis the limit's cost-basis machine reads for one row. Pure; never stored.
 *   no marker  → the stored basis, if any
 *   marker open → a PROVISIONAL basis on the fly: nextAvgCostBasisBounded(stored basis,
 *     { from: marker.from_sol, to: tracked amount_sol, L_now: this row's pnl_sol_rule,
 *       L_before: marker.pnl_sol_before }) — the larger-B rule as at resolution. With no L_before
 *     it is B(L_now), i.e. the figure equals the PnL on the pre-change basis: continuous across
 *     the flow.
 * Returns { applies, ok, basis_sol, provisional, reason? }: applies = a basis is (or would be) in
 * force — false for no basis, or a net top-up with no stored basis; ok:false when it applies but
 * cannot be computed for this row (no SOL PnL, equity guards).
 */
export function effectiveAvgCostBasis(tracked, pnlSolNow) {
  const stored = basisOk(tracked?.avg_cost_basis) ? tracked.avg_cost_basis : null;
  const pend = tracked?.avg_cost_basis_pending;
  if (!pend) return stored ? { applies: true, ok: true, basis_sol: stored.basis_sol, provisional: false } : { applies: false, ok: true, basis_sol: null, provisional: false };
  const from = num(pend.from_sol), to = num(tracked?.amount_sol);
  const applies = !!stored || (from != null && to != null && to < from);
  if (!applies) return { applies: false, ok: true, basis_sol: null, provisional: false };
  if (num(pnlSolNow) == null) return { applies: true, ok: false, basis_sol: stored?.basis_sol ?? null, provisional: true, reason: "no SOL PnL on the row for the provisional basis" };
  const r = nextAvgCostBasisBounded(stored, { fromSol: from, toSol: to, pnlSolNow: Number(pnlSolNow), pnlSolBefore: pend.pnl_sol_before ?? null, pnlSolChange: pend.pnl_sol_change ?? null });
  if (r.action === "write") return { applies: true, ok: true, basis_sol: r.basis.basis_sol, provisional: true, l_source: r.basis.l_source };
  if (r.action === "none" && stored) return { applies: true, ok: true, basis_sol: stored.basis_sol, provisional: true };
  // No stored basis and a net withdrawal (applies): "none" here means the guards failed.
  return { applies: true, ok: false, basis_sol: null, provisional: true, reason: `provisional basis: ${r.reason}` };
}

/**
 * PnL percent on the average-cost basis: (capital + SOL PnL − B) / B × 100. null when any input
 * is missing or non-positive. Pure.
 */
export function avgCostBasisPnlPct(basisSol, amountSol, pnlSol) {
  const B = Number(basisSol), C = Number(amountSol), L = Number(pnlSol);
  if (basisSol == null || amountSol == null || pnlSol == null) return null;
  if (!(B > 0) || !(C > 0) || !Number.isFinite(L)) return null;
  const v = ((C + L - B) / B) * 100;
  return Number.isFinite(v) ? v : null;
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
