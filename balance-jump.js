// balance-jump.js — did the wallet total move by more than positions can explain between two samples?
//
// The baseline deposit scan ran only hourly (:50), so a deposit sat unexplained in the books for up to
// an hour (2026-10-03: +5.6 SOL landed 18:32, recorded 18:50). The balance sampler (every ~3 min) calls
// this on consecutive totals; a step triggers the scan right away. A false positive (a large PnL move)
// costs one incremental signature scan.

export function isBalanceJump(prevTotalSol, totalSol, { minSol = 0.1, minPct = 1 } = {}) {
  const prev = Number(prevTotalSol), cur = Number(totalSol);
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur < 0) return false;
  const delta = Math.abs(cur - prev);
  return delta >= Math.max(Number(minSol) || 0, (prev * (Number(minPct) || 0)) / 100);
}
