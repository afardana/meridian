// rug-latch.js — the in-range rug detector waits for the drop to hold ("variant E", 2026-10-17).
//
// The in-range rug detector (index.js detectInRangeRug; inRangeRugEnabled, rugBinsPerMin 12,
// rugMinBinsDropped 10, rugMaxPnlPct −3, rugWindowSec 300, rugMinSpanSec 60) closed at the
// bottom of the move: FTR-SOL 2026-10-16 08:23 WIB, 1.24 SOL, 35 bins in 115 s, closed at
// −8.92 %; the pool's next socket ticks were −459 → −455 within 5 s and the position would
// have been +0.9 % two hours later. Replayed over 15 rug / calm-regime closes + 13 controls
// (session scratchpad rugreplay/, replay.mjs + main.mjs): plain 30 / 60 s persistence did
// not help the rug detector (+◎0.015, 2 better / 1 worse — CTO-SOL −9.3 pp, it slid into the
// −15 % stop), a LATCH did (+◎0.12, 1 better / 0 worse): FTR saved, CTO / PAID still closed
// ~30 s later at the same PnL. The calm-regime rule (crash-regime.js) is not latched.
//
// Semantics (rugPersistMode "enforce", the default):
//   • a detector hit does not close; it ARMS a latch on the position:
//       rug_latch = { armed_at, low_bin, fire_pnl_pct, valuations: 1, reason }
//   • while latched, every non-suspect reading moves `low_bin` down; when the active bin is
//     ≥ rugPersistRecoveryBins (3) above the low the latch is CANCELLED and its low kept as
//     `rug_latch_last_low` — the detector may then re-arm only at a NEW low (strictly below);
//   • the latch FIRES on a fresh valuation once ≥ rugPersistSec (30) have passed since
//     arming, PnL is still ≤ rugMaxPnlPct and ≥ 2 distinct valuations were seen since
//     arming (the arming one counts) — the latch IS the confirmation (the caller closes
//     with confirm_ticks 1);
//   • a latch older than rugWindowSec (300) without a fire is dropped (EXPIRE; its low is
//     kept like a cancel's).
// rugPersistMode "off" = the pre-2026-10-17 behaviour: a hit fires at once (the caller keeps
// the crashConfirmTicks confirmation). There is no shadow mode.
//
// Leaf module (no imports): pure decisions, shared by state.js (latch on the position),
// index.js (PnL poller) and tools/dlmm.js (perf-record summary).

export const RUG_PERSIST_MODES = ["off", "enforce"];
export const RUG_PERSIST_DEFAULT_SEC = 30;
export const RUG_PERSIST_MIN_SEC = 5;
export const RUG_PERSIST_DEFAULT_RECOVERY_BINS = 3;
export const RUG_PERSIST_MIN_VALUATIONS = 2;

const num = (v) => (v == null || v === "" ? NaN : Number(v));

/** Resolved latch settings. Absent / unknown mode = enforce (the default; there is no shadow). */
export function rugPersistConfig(mgmt = {}) {
  const mode = RUG_PERSIST_MODES.includes(mgmt?.rugPersistMode) ? mgmt.rugPersistMode : "enforce";
  const sec = num(mgmt?.rugPersistSec);
  const rec = Math.round(num(mgmt?.rugPersistRecoveryBins));
  const maxPnl = num(mgmt?.rugMaxPnlPct);
  const win = num(mgmt?.rugWindowSec);
  return {
    mode,
    persistSec: Number.isFinite(sec) ? Math.max(RUG_PERSIST_MIN_SEC, sec) : RUG_PERSIST_DEFAULT_SEC,
    recoveryBins: Number.isFinite(rec) ? Math.max(1, rec) : RUG_PERSIST_DEFAULT_RECOVERY_BINS,
    maxPnlPct: Number.isFinite(maxPnl) ? maxPnl : -3,
    windowSec: Number.isFinite(win) && win > 0 ? win : 300,
  };
}

/**
 * The detector's gate math on a trail it does not own (index.js keeps `_rugTrail` and the
 * window trim, rugWindowSec 300): in range, pnl ≤ rugMaxPnlPct, and — measured from the
 * trail's HIGHEST bin within the window (its most recent occurrence) to the current bin —
 * ≥ rugMinBinsDropped fallen, ≥ rugMinSpanSec since that high, ≥ rugBinsPerMin.
 *
 * Velocity is high-to-current since 2026-10-18 (it was first-to-last over the whole trail):
 * a flat stretch before a sudden drop diluted it. mucron-SOL EiEXT3Rk (operator, ◎2.33,
 * in its profit grace with the stop paused) sat flat at −491…−498 for four minutes, then fell
 * 52 bins in 45 s (≈ 69 b/min) to −20 % — and first-to-last over the 300 s trail read 44 bins
 * / 300 s = 8.8 b/min at 21:11:18 and 59 / 305 s = 11.6 b/min at 21:11:23, both under 12, so
 * nothing armed. From the window high (−498 at 21:10:38) the same ticks hit at 21:11:38
 * (51 bins / 60 s). The calm-regime rule (crash-regime.js) already measured peak-to-current;
 * the minimum span still applies, counted from the high, so a fast drop is judged once
 * rugMinSpanSec has passed since its top.
 * Returns { rug: true, reason, binsDropped, spanSec, binsPerMin, highBin } or null.
 */
export function inRangeRugHit(trail, { activeBin, lowerBin, pnlPct }, cfg = {}) {
  if (!Number.isFinite(activeBin) || !Number.isFinite(lowerBin)) return null;
  if (activeBin < lowerBin) return null;                              // GATE 1: in-range only (below = crash detector's turf)
  if (!Number.isFinite(pnlPct) || pnlPct > Number(cfg.rugMaxPnlPct ?? -3)) return null; // GATE 2: already losing
  if (!Array.isArray(trail) || trail.length < 2) return null;
  const last = trail[trail.length - 1];
  let high = null;                                                    // the window high, most recent occurrence
  for (let i = trail.length - 1; i >= 0; i--) {
    const b = Number(trail[i]?.bin);
    if (Number.isFinite(b) && (high == null || b > high.bin)) high = { t: trail[i].t, bin: b };
  }
  if (!high) return null;
  const spanSec = (last.t - high.t) / 1000;
  if (spanSec < Number(cfg.rugMinSpanSec ?? 60)) return null;         // GATE 3a: min time base, from the high
  const binsDropped = high.bin - last.bin;
  if (binsDropped < Number(cfg.rugMinBinsDropped ?? 10)) return null; // GATE 3b: min depth below the high
  const binsPerMin = binsDropped / (spanSec / 60);
  if (binsPerMin < Number(cfg.rugBinsPerMin ?? 12)) return null;      // GATE 3c: velocity high-to-current
  return {
    rug: true,
    binsDropped,
    spanSec,
    binsPerMin,
    highBin: high.bin,
    reason: `in-range rug ${binsDropped} bins/${spanSec.toFixed(0)}s from the window high ${high.bin} ` +
            `(${binsPerMin.toFixed(1)} b/min ≥ ${cfg.rugBinsPerMin ?? 12}, pnl ${pnlPct.toFixed(2)}% ≤ ${cfg.rugMaxPnlPct ?? -3}%)`,
  };
}

/**
 * One reading through the latch. Pure.
 *   state   { latch: {armed_at, low_bin, fire_pnl_pct, valuations, reason} | null, last_low: number | null }
 *   reading { bin, pnl, fresh, suspect, hit: detector verdict ({ reason }) | null }
 * Returns { action, state, changed, recovered?, blocked? } with action
 *   'arm' | 'hold' | 'cancel' | 'fire' | 'expire' | 'none'.
 * A suspect reading or one without a bin changes nothing (expiry still applies); a stale
 * (not fresh) reading can cancel and move the low but never counts or fires. On 'fire' the
 * latch stays in the returned state, so a close that fails fires again on the next fresh
 * valuation; the close clears it.
 */
export function evaluateRugLatch(state, reading, cfg, nowMs = Date.now()) {
  const c = cfg?.persistSec != null ? cfg : rugPersistConfig(cfg);
  const prev = { latch: state?.latch ?? null, last_low: Number.isFinite(num(state?.last_low)) ? num(state.last_low) : null };
  const bin = num(reading?.bin);
  const pnl = num(reading?.pnl);
  const hit = reading?.hit || null;

  if (c.mode === "off") {
    const cleared = prev.latch != null || prev.last_low != null;
    return { action: hit ? "fire" : "none", immediate: !!hit, state: { latch: null, last_low: null }, changed: cleared };
  }

  const latch = prev.latch;
  if (latch) {
    const armedMs = Date.parse(latch.armed_at);
    if (!Number.isFinite(armedMs) || nowMs - armedMs > c.windowSec * 1000) {
      const low = Number.isFinite(num(latch.low_bin)) ? num(latch.low_bin) : null;
      return { action: "expire", state: { latch: null, last_low: lowerOf(prev.last_low, low) }, changed: true };
    }
  }
  if (reading?.suspect === true || !Number.isFinite(bin)) return { action: "none", state: prev, changed: false };

  if (!latch) {
    if (!hit) return { action: "none", state: prev, changed: false };
    if (prev.last_low != null && !(bin < prev.last_low)) {
      return { action: "none", blocked: true, state: prev, changed: false };
    }
    const armed = {
      armed_at: new Date(nowMs).toISOString(),
      low_bin: bin,
      fire_pnl_pct: Number.isFinite(pnl) ? pnl : null,
      valuations: 1,
      reason: hit.reason ?? null,
    };
    return { action: "arm", state: { latch: armed, last_low: prev.last_low }, changed: true };
  }

  const low = Math.min(num(latch.low_bin), bin);
  const recovered = bin - low;
  if (recovered >= c.recoveryBins) {
    return { action: "cancel", recovered, state: { latch: null, last_low: lowerOf(prev.last_low, low) }, changed: true };
  }
  const fresh = reading?.fresh === true;
  const next = { ...latch, low_bin: low, valuations: Number(latch.valuations ?? 1) + (fresh ? 1 : 0) };
  const changed = next.low_bin !== latch.low_bin || next.valuations !== latch.valuations;
  const elapsedMs = nowMs - Date.parse(latch.armed_at);
  if (fresh
      && elapsedMs >= c.persistSec * 1000
      && Number.isFinite(pnl) && pnl <= c.maxPnlPct
      && next.valuations >= RUG_PERSIST_MIN_VALUATIONS) {
    return { action: "fire", elapsedSec: elapsedMs / 1000, state: { latch: next, last_low: prev.last_low }, changed };
  }
  return { action: "hold", state: { latch: next, last_low: prev.last_low }, changed };
}

function lowerOf(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}

/** Running per-position summary (`rug_latch_summary`) after one latch action. Pure. */
export function advanceRugLatchSummary(summary, action, latch, nowMs = Date.now()) {
  const s = summary && typeof summary === "object" ? { ...summary } : null;
  if (!["arm", "cancel", "expire", "fire"].includes(action)) return s;
  const out = s ?? { armed_at: null, fire_pnl_pct: null, armed_count: 0, cancelled_count: 0, expired_count: 0, fired_at: null };
  if (action === "arm") {
    out.armed_at = latch?.armed_at ?? new Date(nowMs).toISOString();
    out.fire_pnl_pct = latch?.fire_pnl_pct ?? null; // PnL when the detector hit (at arm)
    out.armed_count = Number(out.armed_count ?? 0) + 1;
  } else if (action === "cancel") {
    out.cancelled_count = Number(out.cancelled_count ?? 0) + 1;
  } else if (action === "expire") {
    out.expired_count = Number(out.expired_count ?? 0) + 1;
  } else if (action === "fire") {
    out.fired_at = new Date(nowMs).toISOString();
  }
  return out;
}

/** Perf-record field (three sites, tools/dlmm.js): the latch summary, null when it never armed. */
export function rugLatchRecordFields(pos) {
  const s = pos?.rug_latch_summary;
  if (!s || typeof s !== "object") return { rug_latch: null };
  return {
    rug_latch: {
      armed_at: s.armed_at ?? null,
      fire_pnl_pct: s.fire_pnl_pct ?? null,
      armed_count: Number(s.armed_count ?? 0),
      cancelled_count: Number(s.cancelled_count ?? 0),
      expired_count: Number(s.expired_count ?? 0),
      fired_at: s.fired_at ?? null,
    },
  };
}

/** Close reason for a latched fire — keeps the "in-range rug" prefix (exit family `rug`). */
export function rugLatchReason(latch, { elapsedSec, pnl, bin, recoveryBins = RUG_PERSIST_DEFAULT_RECOVERY_BINS } = {}) {
  const sec = Number.isFinite(elapsedSec) ? Math.round(elapsedSec) : null;
  const armPnl = Number.isFinite(num(latch?.fire_pnl_pct)) ? `${num(latch.fire_pnl_pct).toFixed(2)}%` : "n/a";
  const detail = String(latch?.reason || "in-range rug").replace(/^in-range rug\s*/i, "");
  return `In-range rug (latched ${sec ?? "?"}s): ${detail}; armed at pnl ${armPnl}, now ${Number.isFinite(pnl) ? `${pnl.toFixed(2)}%` : "n/a"}` +
    ` at bin ${Number.isFinite(bin) ? bin : "?"} (low ${latch?.low_bin ?? "?"}), ${latch?.valuations ?? "?"} valuations, no ${recoveryBins}-bin recovery`;
}
