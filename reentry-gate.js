// reentry-gate.js — post-win cooling gate (2026-10-02 re-assessment), SHADOW by default.
//
// Bot deploys since 2026-08-22 grouped by the previous close in the same pool:
//   re-entry 60–240 min after a WIN (≥ +1 %) there: 27 deploys, 7 disasters (26 %),
//     52 % wins, avg −4.9 % — in each of three sub-periods (14 / 3, 6 / 1, 7 / 3;
//     since 09-26: ASTEROID −27.7 %, swordcat −16.7 %, PARASITE −15.1 %);
//   everything else: 267 deploys, 21 disasters (7.9 %).
//   Re-entry < 15 min after a win is fine (+0.86 %, 77 % wins), as is re-entry after a
//   flat or losing close. The bucket was found after ~20 cuts of the same data and
//   matched by pair name, so it is a hypothesis: the gate logs `would-skip` and every
//   deploy records the previous close (pnl, gap) + the verdict, so the whole table can
//   be graded on live closes by pool address.
// Decision rule (pre-registered): after 20 tagged closes or three weeks, enforce only if
// the tagged group's ≤ −10 % rate is ≥ 2× the rest's AND its net is negative.
//
// reentryGateMode: off | shadow (default) | enforce.
// reentryGateMinWinPct 1, reentryGateMinGapMin 60, reentryGateMaxGapMin 240.

const LOOKBACK_MS = 12 * 3600_000;

/**
 * The most recent close in a pool's deploy history within the lookback, as
 * { pnlPct, gapMin, closeReason } — null when there is none. Rebalance legs are not
 * closes of the pool (the position continued), and records without a pnl are skipped.
 */
export function previousCloseFromDeploys(deploys, now = Date.now()) {
  if (!Array.isArray(deploys)) return null;
  let best = null;
  for (const d of deploys) {
    const closedAt = d?.closed_at ? new Date(d.closed_at).getTime() : NaN;
    if (!Number.isFinite(closedAt) || closedAt > now || now - closedAt > LOOKBACK_MS) continue;
    if (d.pnl_pct == null || !Number.isFinite(Number(d.pnl_pct))) continue;
    if (/^rebalance:/i.test(String(d.close_reason || ""))) continue;
    if (!best || closedAt > best.closedAt) best = { closedAt, pnlPct: Number(d.pnl_pct), closeReason: d.close_reason || null };
  }
  if (!best) return null;
  return { pnlPct: best.pnlPct, gapMin: Math.round((now - best.closedAt) / 60_000), closeReason: best.closeReason };
}

/** Gate verdict for one previous close. No previous close never skips. */
export function evaluateReentryGate(prev, cfg = {}) {
  const minWin = Number(cfg.reentryGateMinWinPct ?? 1);
  const minGap = Number(cfg.reentryGateMinGapMin ?? 60);
  const maxGap = Number(cfg.reentryGateMaxGapMin ?? 240);
  const known = prev != null && Number.isFinite(prev.pnlPct) && Number.isFinite(prev.gapMin);
  const wouldSkip = known && prev.pnlPct >= minWin && prev.gapMin >= minGap && prev.gapMin < maxGap;
  return {
    prevClosePct: known ? prev.pnlPct : null,
    prevCloseGapMin: known ? prev.gapMin : null,
    wouldSkip,
    reason: wouldSkip
      ? `previous close here +${prev.pnlPct.toFixed(1)}% ${prev.gapMin} min ago (re-entry ${minGap}–${maxGap} min after a win)`
      : null,
  };
}

/** Verdict for a pool from pool-memory. Fail-open: any error → no previous close. */
export async function getReentryVerdict(poolAddress, cfg = {}, { now = Date.now(), getDeploys = null } = {}) {
  let deploys = [];
  try {
    if (getDeploys) deploys = getDeploys(poolAddress);
    else {
      const { getPoolDeploys } = await import("./pool-memory.js");
      deploys = getPoolDeploys(poolAddress);
    }
  } catch {
    deploys = [];
  }
  return evaluateReentryGate(previousCloseFromDeploys(deploys, now), cfg);
}
