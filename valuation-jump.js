// valuation-jump.js — is the step between two valuations physically plausible?
//
// Returns the suspect direction ("up" | "down") or null.
//   up    — a rise > capPp in one valuation (fake peaks), OR a rise ≥ riseOnFallPp while the
//           active bin FELL ≥ riseOnFallBins. A SOL-quoted ladder loses value as price falls
//           through it; fees cannot outrun that (crossing 3 bins converts ~4 % of the capital,
//           so even a 10 % fee adds < 0.5 pp). Seen twice on 2026-10-04 during fast dumps —
//           SPLICE-SOL 4.32 → 8.30 with the bin −443 → −459, knightcat-SOL 0.28 → 4.91 with
//           −377 → −395: the reading stayed high for 10–15 s, was confirmed as the peak, and
//           trailing TP then fired on the real value (knightcat closed at −5.39 %). The size
//           of the error (≈ bins fallen × the base share) says the position's new token
//           amounts were valued at the price from before the drop.
//   down  — a drop > capPp while the active bin did not fall (an indexer catching up).
export function classifyPnlJump({ lastPnl, lastBin, pnl, bin, capPp = 15, riseOnFallPp = 2, riseOnFallBins = 3 } = {}) {
  const a = Number(lastPnl), b = Number(pnl);
  if (lastPnl == null || pnl == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const jump = b - a;
  const binsOk = lastBin != null && bin != null && Number.isFinite(Number(lastBin)) && Number.isFinite(Number(bin));
  const fell = binsOk ? Number(lastBin) - Number(bin) : 0; // > 0 = price moved down
  const cap = Number(capPp);
  if (cap > 0 && jump > cap) return "up";
  if (Number(riseOnFallPp) > 0 && jump >= Number(riseOnFallPp) && fell >= Number(riseOnFallBins)) return "up";
  if (cap > 0 && jump < -cap && binsOk && fell <= 0) return "down";
  return null;
}

// An unchanged valuation is normally NOT a confirming observation (one refresh seen on
// several 5 s ticks). But a reading that has stood for longer than the refresh cycle has
// been re-read from chain and came back the same — on a quiet pool the pool-price
// valuation is identical for minutes, and without this a breach could never be confirmed
// (HIGGS-SOL 2026-10-05: +0.74 % under a +0.96 % trailing threshold for 80 s at an
// unchanged bin, not closed; the dump that followed settled −4.20 %).
// Returns true when a repeated reading may count as a fresh one. reconfirmMs ≤ 0 = never.
export function repeatCountsAsFresh({ lastFreshAt, now, reconfirmMs = 30_000 } = {}) {
  const ms = Number(reconfirmMs);
  if (!(ms > 0)) return false;
  const a = Number(lastFreshAt), b = Number(now);
  return Number.isFinite(a) && Number.isFinite(b) && b - a >= ms;
}
