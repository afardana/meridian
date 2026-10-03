// balance-jump.js — did the wallet total move by more than positions can explain between two samples?
//
// The baseline deposit scan ran only hourly (:50), so a deposit sat unexplained in the books for up to
// an hour (2026-10-03: +5.6 SOL landed 18:32, recorded 18:50). The balance sampler (every ~3 min) calls
// this on consecutive totals; a step triggers the scan right away. A false positive (a large PnL move)
// costs one incremental signature scan.

// A deposit/withdrawal moves the IDLE wallet SOL and the total together. A position's PnL swing
// moves the total only (2026-10-03: a held 2 SOL position swinging ±0.3 SOL fired the first,
// total-only version on every sample), and a deploy/close moves idle against deployed, leaving
// the total flat. So both must step, in the same direction.
export function isBalanceJump(prev, cur, { minSol = 0.1, minPct = 1 } = {}) {
  const n = (v) => (v == null || !Number.isFinite(Number(v)) ? NaN : Number(v));
  const pT = n(prev?.totalSol), cT = n(cur?.totalSol), pI = n(prev?.idleSol), cI = n(cur?.idleSol);
  if (![pT, cT, pI, cI].every(Number.isFinite) || pT <= 0 || cT < 0) return false;
  const threshold = Math.max(Number(minSol) || 0, (pT * (Number(minPct) || 0)) / 100);
  const dTotal = cT - pT, dIdle = cI - pI;
  return Math.abs(dTotal) >= threshold && Math.abs(dIdle) >= threshold && Math.sign(dTotal) === Math.sign(dIdle);
}
