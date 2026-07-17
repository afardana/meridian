#!/usr/bin/env node
/**
 * scripts/replay/replay.js — Counterfactual EXIT-rule engine (OFFLINE, read-only).
 *
 * Consumes scripts/replay/dataset.json (built by extract.js) and, for each position
 * with a usable recorded path, simulates alternative exit rules over that path to
 * estimate the PnL delta versus what actually happened.
 *
 *   Δ = pnl_at_counterfactual_exit − actual_pnl_pct
 *   (positive Δ = the alternative rule would have done better)
 *
 * Rules supported (semantics MIRROR the live implementations — see the citations
 * on each simulate* function; read state.js updatePnlAndCheckExits + index.js
 * detectPriceCrash before changing any of them):
 *
 *   - trailing TP   : trailingTriggerPct / trailingDropPct variants
 *   - OOR-below wait : outOfRangeWaitMinutesBelow variants
 *   - stop loss      : stopLossPct variants
 *   - crash fast-path: crashBinsPerMin variants (DENSE series only; low-confidence)
 *   - ratchet        : breakeven-ratchet — once peak >= armPct the effective stop
 *                      tightens from the live stopLossPct (-15) to ratchetStopPct.
 *                      Answers the operator question "prevent the peak→SL round-trip
 *                      without truncating winners." (armPct, ratchetStopPct) grid.
 *   - timebox        : RULE A — time-boxed underwater exit. Close a NON-winner sitting
 *                      at pnl <= U for age >= M minutes (never-armed-ratchet guarded)
 *                      instead of waiting for the -15 stop / ~6 h low-yield bleed.
 *                      (U, M) grid. Own honesty columns (incremental-over-15, winner-kills).
 *   - lowyield       : RULE B — tighten the live fee-death rule's min-age (fee/TVL<1%
 *                      at age >= minAge). Variants = the min-age knob (live 180).
 *
 * EPISTEMIC HONESTY — the whole point of this tool. At ~3–10 min snapshot cadence
 * you CANNOT precisely replay a 15-second crash detector or the exact instant a
 * trailing-TP fires. So every per-position rule evaluation is bucketed into a
 * confidence tier and the tiers are reported SEPARATELY:
 *
 *   high : the rule's decision boundary is unambiguous at this cadence — the
 *          counterfactual exit lands on a recorded snapshot and the trigger
 *          condition is a level test (OOR-below duration, stop-loss level,
 *          peak-drop) that the snapshot series resolves without sub-cadence timing.
 *   low  : sub-cadence timing materially affects the outcome (crash velocity over
 *          seconds; a trailing trigger that fires and reverses between two far-apart
 *          snapshots). Reported, but flagged and NEVER mixed into the high-conf mean.
 *
 * Fees after a counterfactual (earlier) exit are approximated as PRO-RATA of the
 * position's recorded total fees, by the fraction of hold time elapsed at the
 * counterfactual exit. This is an approximation (fees are front-loaded when in-range),
 * documented in the caveats block.
 *
 * Usage:
 *   node scripts/replay/replay.js                     # all rule families, summary table
 *   node scripts/replay/replay.js --in dataset.json   # (--dataset is an accepted alias)
 *   node scripts/replay/replay.js --rule oor          # oor | trailing | stop | crash | ratchet | combo
 *   node scripts/replay/replay.js --verbose           # per-position detail rows
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IN = path.join(__dirname, "dataset.json");

// ── LIVE exit config (production user-config.json as of 2026-07-08) ──────────
// The ratchet + re-gridded-trailing families evaluate AGAINST this baseline so
// the counterfactual and the "actual" both live under the SAME live stop-loss.
// (The prior trailing grid was implicitly baselined at SL=-50; SL was tightened
// to -15 on ~2026-07-06, which changes the value of early locking on both sides.)
const LIVE = {
  trailingTakeProfit: true,
  trailingTriggerPct: 3,
  trailingDropPct: 1,
  stopLossPct: -15,
  takeProfitPct: 35,
};

// Live config the EARLIER-EXIT overlay families (timebox / lowyield) reference. Kept
// OUT of the LIVE object above so the ratchet/combo header dumps stay byte-identical.
//   profitRatchetArmPct — the winner machinery the timebox rule must not touch.
//   lowYield{ThreshPct,MinAge} — the live fee-death rule (fee/TVL < 1% at age >= 180);
//     rule B tightens the min-age. Threshold 1% per recent prod close reasons.
const LIVE_EXIT = {
  profitRatchetArmPct: 2,
  lowYieldThreshPct: 1,
  minAgeBeforeYieldCheck: 180,
};

// The earlier-exit families (timebox / lowyield) below are OVERLAYS on the live exit
// machine — they add a faster exit for the loser/deadweight population WITHOUT touching
// winner exits. Two honesty anchors used throughout:
//   RATCHET_ARM_GUARD — a position whose peak ever reached this is a candidate winner
//     already owned by the trailing/ratchet machinery; the timebox rule refuses to fire
//     on it ("never armed the profit ratchet"). Uses the series peak AND the recorded
//     poller peak (mfe_pnl_pct) so a peak that happened between snapshots still protects.
//   DEEP_STOP_PCT — the live -15 stop already catches fast rugs. Much of a raw Δ on a
//     deep-loss close is really the -15 tightening that is ALREADY LIVE (many old closes
//     stopped at -19/-20/-33 under a looser stop). To isolate an overlay's INCREMENTAL
//     value we also report Δ vs a -15-floored baseline (deepStopFloorPnl), which cancels
//     that stale-era credit — mirroring the ratchet family's stale-era note in README.md.
const RATCHET_ARM_GUARD = LIVE_EXIT.profitRatchetArmPct;
const DEEP_STOP_PCT = LIVE.stopLossPct;
const HI_GAP_MIN = 12; // inter-snapshot gap at the firing tick above which the exit mark is unresolvable

// Variant grids (mirror the config knobs). Kept small + legible.
const VARIANTS = {
  oor: { key: "outOfRangeWaitMinutesBelow", values: [15, 30, 45, 63, 90], live_default: 180 },
  trailing: {
    // (triggerPct, dropPct) pairs. Re-gridded 2026-07-08 against the SL=-15 baseline.
    // Live is trigger=3, drop=1.
    key: "trailing",
    values: [
      { trigger: 2, drop: 0.75 },
      { trigger: 2, drop: 1.0 },
      { trigger: 2, drop: 1.5 },
      { trigger: 2.5, drop: 0.75 },
      { trigger: 2.5, drop: 1.0 },
      { trigger: 2.5, drop: 1.5 },
      { trigger: 3, drop: 0.75 },
      { trigger: 3, drop: 1.0 }, // ← LIVE
      { trigger: 3, drop: 1.5 },
      { trigger: 4, drop: 0.75 },
      { trigger: 4, drop: 1.0 },
      { trigger: 4, drop: 1.5 },
    ],
    live_default: { trigger: 3, drop: 1.0 },
  },
  stop: { key: "stopLossPct", values: [-15, -25, -35, -50, -70], live_default: -15 },
  crash: { key: "crashBinsPerMin", values: [8, 12, 20], live_default: 12 },
  // Breakeven-ratchet: once confirmed peak >= armPct, the effective stop tightens
  // from LIVE.stopLossPct (-15) to ratchetStopPct. Trailing TP (LIVE 3/1) stays
  // active as baseline context, so an armed position exits at whichever fires
  // first: the ratchet stop, the trailing drop, the (unchanged) take-profit, or
  // the deep stop for un-armed positions.
  ratchet: {
    key: "ratchet(armPct,ratchetStopPct)",
    values: [
      { arm: 1.5, stop: 0 },
      { arm: 1.5, stop: -1 },
      { arm: 1.5, stop: -2 },
      { arm: 1.5, stop: -3 },
      { arm: 2, stop: 0 },
      { arm: 2, stop: -1 },
      { arm: 2, stop: -2 },
      { arm: 2, stop: -3 },
      { arm: 2.5, stop: 0 },
      { arm: 2.5, stop: -1 },
      { arm: 2.5, stop: -2 },
      { arm: 2.5, stop: -3 },
    ],
    live_default: null, // no ratchet in production yet
  },
  // Rule A — time-boxed underwater exit (proposed, not live). Close a NON-winner that
  // has sat underwater instead of waiting for the -15 stop or the ~6 h low-yield/OOR
  // bleed. Grid: U (pnl ceiling) x M (min age, minutes). Winner-protected by
  // RATCHET_ARM_GUARD. See simulateTimeboxUnderwater.
  timebox: {
    key: "timebox(pnl<=U, age>=M min, never-armed)",
    values: (() => {
      const g = [];
      for (const U of [-2, -3, -5, -8]) for (const M of [60, 120, 180, 240]) g.push({ U, M });
      return g;
    })(),
    live_default: null,
  },
  // Rule B — low-yield min-age tightening. The live fee-death rule (fee/TVL < 1%) only
  // arms at age >= 180 m; this tests firing it earlier. Variants = the min-age knob.
  // See simulateLowYield.
  lowyield: {
    key: "minAgeBeforeYieldCheck (fee/TVL<" + LIVE_EXIT.lowYieldThreshPct + "%)",
    values: [90, 120, 150, 180],
    live_default: LIVE_EXIT.minAgeBeforeYieldCheck,
  },
};

const DENSE_GAP_MIN = 5; // median gap at/below this ⇒ crash rule is (weakly) evaluable

function parseArgs(argv) {
  const args = { in: DEFAULT_IN, rule: "all", verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verbose") args.verbose = true;
    else if (a === "--rule") args.rule = argv[++i];
    else if (a.startsWith("--rule=")) args.rule = a.slice("--rule=".length);
    else if (a === "--in" || a === "--dataset") args.in = path.resolve(argv[++i]);
    else if (a.startsWith("--in=")) args.in = path.resolve(a.slice("--in=".length));
    else if (a.startsWith("--dataset=")) args.in = path.resolve(a.slice("--dataset=".length));
  }
  return args;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function tsMin(series) {
  // Minutes-since-deploy for each snapshot, using age_minutes if present else ts delta.
  const t0 = series.length ? Date.parse(series[0].ts) : NaN;
  return series.map((s) => {
    if (s.age_minutes != null) return s.age_minutes;
    const t = Date.parse(s.ts);
    return Number.isFinite(t) && Number.isFinite(t0) ? (t - t0) / 60000 : null;
  });
}

/**
 * Pro-rata recorded fees at a counterfactual exit that happens at `elapsedMin`
 * of a `heldMin`-minute hold. Fees are added on top of the snapshot's liquidity
 * PnL. Because our pnl_pct on the perf record is (final+fees−initial)/initial and
 * the snapshot pnl_pct is the live mark (which already includes accrued fees in
 * total_value), we DON'T double count: the counterfactual pnl we use IS the
 * snapshot's own pnl_pct at the exit tick (mark-to-market, fees-inclusive live).
 * The pro-rata fee model is only a fallback for when we must estimate beyond a
 * snapshot; here we exit ON a snapshot, so we use its mark directly.
 */
function feePctFraction(position, elapsedMin) {
  const held = position.minutes_held;
  if (!held || held <= 0) return 1;
  return Math.max(0, Math.min(1, elapsedMin / held));
}

// ── OOR-below wait replay ────────────────────────────────────────────────
// Mirrors state.js updatePnlAndCheckExits OOR-below branch (state.js:787-806):
// the live check is `minutesOOR >= limitBelow` where minutesOOR is the
// SIDE-AGNOSTIC time since out_of_range_since, gated by the CURRENT tick being
// below range (active_bin < lower_bin). So per firing snapshot we need:
//   (a) side: is the price below range at this snapshot?
//   (b) duration: how long has the position been OOR?
//
// Era tolerance (bin fields exist only on snapshots after 2026-06-16 — commit
// 486a832; in_range + minutes_out_of_range exist since 2026-03-20 — 621c687):
//   side (a): active_bin < lower_bin when bins present (exact live semantics,
//             HIGH conf). When bins are missing, fall back to in_range===false
//             + the position's close_reason being an OOR-below family close
//             (side inferred, LOW conf — an OOR-above interlude mid-hold would
//             be misattributed).
//   duration (b): prefer the snapshot's own minutes_out_of_range — that IS the
//             live timer's value, recorded live. Fallback: reconstruct the OOR
//             streak from consecutive OOR snapshots' elapsed time.
function isOorBelowFamily(reason) {
  // Mirrors pool-memory.js isOorBelowCloseReason.
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("below") || text === "oor" || (text.includes("oor") && !text.includes("above"));
}

function simulateOorBelow(position, limitMin) {
  const s = position.snapshots;
  const mins = tsMin(s);
  const belowFamilyClose = isOorBelowFamily(position.close_reason);
  let oorStreakStart = null; // minutes-since-deploy when the current OOR streak began (fallback duration)

  for (let i = 0; i < s.length; i++) {
    const snap = s[i];
    const hasBins = snap.active_bin != null && snap.lower_bin != null;

    // (a) side
    let isBelow, sideConfidence;
    if (hasBins) {
      isBelow = snap.active_bin < snap.lower_bin;
      sideConfidence = "high";
    } else if (snap.in_range === false && belowFamilyClose) {
      isBelow = true; // side inferred from the close-reason family
      sideConfidence = "low";
    } else {
      isBelow = false;
    }

    // OOR streak bookkeeping (side-agnostic, like the live out_of_range_since)
    const isOor = hasBins
      ? (snap.active_bin < snap.lower_bin || (snap.upper_bin != null && snap.active_bin > snap.upper_bin))
      : snap.in_range === false;
    if (!isOor) { oorStreakStart = null; continue; }
    if (oorStreakStart == null) oorStreakStart = mins[i];
    if (!isBelow) continue;

    // (b) duration — live-recorded value preferred, streak reconstruction fallback
    const durMin = snap.minutes_out_of_range != null
      ? snap.minutes_out_of_range
      : (mins[i] != null && oorStreakStart != null ? mins[i] - oorStreakStart : null);

    if (durMin != null && durMin >= limitMin) {
      return {
        fired: true,
        exit_idx: i,
        exit_min: mins[i],
        exit_pnl_pct: snap.pnl_pct,
        oor_minutes: durMin,
        // A duration test is resolved AT the snapshot cadence, so the only
        // confidence risk is the side inference on bins-less eras.
        confidence: sideConfidence,
      };
    }
  }
  return { fired: false };
}

// ── Stop-loss replay ─────────────────────────────────────────────────────
// Mirrors state.js stop-loss branch: currentPnlPct <= stopLossPct (confirmed 15s).
// At snapshot cadence the 15s confirmation is sub-cadence noise — a snapshot that
// is already <= threshold represents a state that persisted at least until the
// snapshot, so we treat a single breaching snapshot as a confirmed close. HIGH
// confidence (level test), but we mark LOW if the very first breaching snapshot's
// pnl is a lone dip that recovers by the next snapshot (whipsaw risk).
function simulateStopLoss(position, threshold) {
  const s = position.snapshots;
  const mins = tsMin(s);
  for (let i = 0; i < s.length; i++) {
    if (s[i].pnl_pct != null && s[i].pnl_pct <= threshold) {
      const recovers = i + 1 < s.length && s[i + 1].pnl_pct != null && s[i + 1].pnl_pct > threshold;
      return {
        fired: true,
        exit_idx: i,
        exit_min: mins[i],
        exit_pnl_pct: s[i].pnl_pct,
        confidence: recovers ? "low" : "high",
      };
    }
  }
  return { fired: false };
}

// ── Trailing-TP replay ───────────────────────────────────────────────────
// Mirrors state.js: once confirmed peak >= trigger, trailing arms; close when
// (peak − current) >= drop. We walk the snapshot marks, track running peak, and
// fire when armed and the drop from peak is met. Confidence is LOW when the fire
// happens on a large inter-snapshot gap (the real peak/trough between snapshots
// is unobserved, so the exact trailing exit price is uncertain).
function simulateTrailing(position, trigger, drop) {
  const s = position.snapshots;
  const mins = tsMin(s);
  let peak = -Infinity;
  let armed = false;
  for (let i = 0; i < s.length; i++) {
    const cur = s[i].pnl_pct;
    if (cur == null) continue;
    if (cur > peak) peak = cur;
    if (!armed && peak >= trigger) armed = true;
    if (armed && peak - cur >= drop) {
      // Gap to the previous snapshot: if it's large, the trailing exit could have
      // triggered anywhere in between at an unknown price ⇒ low confidence.
      const gap = i > 0 && mins[i] != null && mins[i - 1] != null ? mins[i] - mins[i - 1] : null;
      const conf = gap != null && gap > 12 ? "low" : "high";
      return {
        fired: true,
        exit_idx: i,
        exit_min: mins[i],
        exit_pnl_pct: cur,
        peak,
        confidence: conf,
      };
    }
  }
  return { fired: false };
}

// ── Crash fast-path replay ───────────────────────────────────────────────
// Mirrors index.js detectPriceCrash: OOR-below AND >= crashMinBinDistance below
// AND downward velocity >= crashBinsPerMin over the trailing window. At the live
// 3s poll cadence this is a seconds-scale detector; at our 3–10 min snapshot
// cadence we can ONLY approximate velocity as (bins dropped between two adjacent
// snapshots)/(gap minutes). This is ALWAYS low-confidence and only attempted on
// dense series. It is a directional sanity check, not a faithful replay.
function simulateCrash(position, binsPerMin, minBinDistance = 8) {
  if (position.median_snapshot_gap_min == null || position.median_snapshot_gap_min > DENSE_GAP_MIN) {
    return { fired: false, not_evaluable: true };
  }
  const s = position.snapshots;
  const mins = tsMin(s);
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1];
    const b = s[i];
    if (a.active_bin == null || b.active_bin == null || b.lower_bin == null) continue;
    const isBelow = b.active_bin < b.lower_bin;
    if (!isBelow) continue;
    const distBelow = b.lower_bin - b.active_bin;
    if (distBelow < minBinDistance) continue;
    const gapMin = mins[i] != null && mins[i - 1] != null ? mins[i] - mins[i - 1] : null;
    if (!gapMin || gapMin <= 0) continue;
    const binsDropped = a.active_bin - b.active_bin; // positive = price fell
    if (binsDropped <= 0) continue;
    const vel = binsDropped / gapMin;
    if (vel >= binsPerMin) {
      return {
        fired: true,
        exit_idx: i,
        exit_min: mins[i],
        exit_pnl_pct: b.pnl_pct,
        approx_bins_per_min: Math.round(vel * 10) / 10,
        confidence: "low", // ALWAYS — cadence far coarser than the real detector
      };
    }
  }
  return { fired: false };
}

// ── Composite live-rule-set replay (trailing + stop + take-profit + optional ratchet)
// ─────────────────────────────────────────────────────────────────────────
// This is the faithful "what the live exit machine would do" simulator, used by
// BOTH the `ratchet` family and the re-gridded `trailing` family so every
// counterfactual is evaluated under the SAME live baseline (SL=-15, TP=35) — not
// trailing-in-isolation. It walks the recorded marks once and fires on the FIRST
// rule that trips, exactly like state.js updatePnlAndCheckExits (order: stop-loss,
// then trailing, then take-profit — stop is checked before trailing in the live
// code). Mirrors:
//   - stop loss   : currentPnl <= effStop  (effStop = ratcheted once armed, else deep)
//   - trailing TP : arm once peak >= trigger; fire when peak-current >= drop
//   - take profit : currentPnl >= takeProfitPct
//
// RATCHET SEMANTICS: the operator's "breakeven ratchet" — once the confirmed peak
// crosses armPct, the effective stop tightens from stopLossPct (-15) to
// ratchetStopPct. So an armed position that gives everything back exits at
// ~ratchetStopPct instead of round-tripping to -15. Un-armed positions keep the
// deep stop (a fast rug still exits at -15, unchanged).
//
// CONFIDENCE (mirrors the trailing/oor discipline): a composite fire is HIGH-conf
// only when the DECIDING boundary crossing is resolvable at the recorded cadence:
//   - the inter-snapshot gap at the firing tick is tight (<=12m), AND
//   - for a ratchet-stop fire, the arm crossing that enabled it also happened on a
//     tight gap (so we know the position truly armed before the drop — the
//     intra-gap-peak blindness seen on ok-SOL, where the poller MFE +2.94 exceeded
//     the series max +2.23, means an arm threshold sitting BETWEEN the series max
//     and the recorded poller peak is NOT resolvable ⇒ demote to low).
// Everything else is low and kept out of the hi* columns.
function simulateComposite(position, opts) {
  const {
    trigger = LIVE.trailingTriggerPct,
    drop = LIVE.trailingDropPct,
    stopLossPct = LIVE.stopLossPct,
    takeProfitPct = LIVE.takeProfitPct,
    trailing = LIVE.trailingTakeProfit,
    armPct = null, // ratchet arm (null ⇒ no ratchet)
    ratchetStopPct = null, // ratchet effective stop once armed
  } = opts || {};

  const s = position.snapshots;
  const mins = tsMin(s);
  // The recorded poller peak (45s resolution) is a tighter upper bound on the true
  // peak than the snapshot-series max; use it to detect arm-crossing ambiguity.
  const recordedPeak = position.path_features?.mfe_pnl_pct ?? null;

  const seriesMax = Math.max(...s.map((x) => (x.pnl_pct == null ? -Infinity : x.pnl_pct)));
  // Live-truth arming that the SERIES cannot see: the recorded poller peak reached
  // armPct but the coarser snapshot series never did (ok-SOL: series +2.23 vs
  // poller +2.94). The ratchet WOULD have armed live, so we honor it — but flag
  // the whole eval low-confidence because the arming tick (and thus the exact
  // ratchet-stop crossing timing) is sub-cadence.
  const armImpliedBySubCadencePeak =
    armPct != null && recordedPeak != null && seriesMax < armPct && recordedPeak >= armPct;

  let peak = -Infinity;
  let seriesArmedTrailing = false; // peak >= trigger (trailing)
  let ratchetArmed = false; // peak >= armPct (ratchet)
  let ratchetArmTight = true; // was the arm crossing resolvable at cadence?

  for (let i = 0; i < s.length; i++) {
    const cur = s[i].pnl_pct;
    if (cur == null) continue;
    const gap = i > 0 && mins[i] != null && mins[i - 1] != null ? mins[i] - mins[i - 1] : 0;

    // Update peak + arm states (arming happens AT the snapshot that first exceeds).
    const prevPeak = peak;
    if (cur > peak) peak = cur;
    if (trailing && !seriesArmedTrailing && peak >= trigger) seriesArmedTrailing = true;
    if (armPct != null && !ratchetArmed && peak >= armPct) {
      ratchetArmed = true;
      // Arm-crossing confidence: a wide gap into the arming snapshot means the true
      // arm-crossing instant is unknown ⇒ demote.
      if (gap > 12) ratchetArmTight = false;
    }
    // Live-truth arm implied by a sub-cadence poller peak the series never showed:
    // arm as soon as we pass its index-0 (i.e. treat the position as armed for the
    // whole path) and flag low-confidence. This lets the ratchet-stop fire on the
    // later drawdown ticks (which ARE visible) while being honest that we can't
    // pin the arm instant.
    if (armImpliedBySubCadencePeak && !ratchetArmed) {
      ratchetArmed = true;
      ratchetArmTight = false;
    }

    const effStop = ratchetArmed && ratchetStopPct != null ? ratchetStopPct : stopLossPct;

    // (1) stop loss (deep or ratcheted) — checked first, like state.js.
    if (effStop != null && cur <= effStop) {
      const armTightOk = !(ratchetArmed && ratchetStopPct != null) || ratchetArmTight;
      const conf = gap <= 12 && armTightOk ? "high" : "low";
      return {
        fired: true, exit_idx: i, exit_min: mins[i], exit_pnl_pct: cur,
        rule: ratchetArmed && ratchetStopPct != null && cur <= ratchetStopPct && ratchetStopPct >= stopLossPct
          ? "ratchet_stop" : "stop", peak, confidence: conf,
      };
    }
    // (2) trailing TP.
    if (trailing && seriesArmedTrailing && peak - cur >= drop) {
      const conf = gap <= 12 ? "high" : "low";
      return {
        fired: true, exit_idx: i, exit_min: mins[i], exit_pnl_pct: cur,
        rule: "trailing", peak, confidence: conf,
      };
    }
    // (3) take profit.
    if (takeProfitPct != null && cur >= takeProfitPct) {
      const conf = gap <= 12 ? "high" : "low";
      return {
        fired: true, exit_idx: i, exit_min: mins[i], exit_pnl_pct: cur,
        rule: "take_profit", peak, confidence: conf,
      };
    }
    void prevPeak;
  }

  return { fired: false };
}

// ── Shared helpers for the earlier-exit overlay families (timebox / lowyield) ──
//
// deepStopFloorPnl: the PnL at which the LIVE -15 stop (or an earlier-recorded deep
// breach) would have exited this position — first snapshot mark <= -15, else the
// recorded actual. Δ vs this baseline cancels the stale-era loose-stop credit (many
// old closes stopped at -19/-20/-33), isolating an overlay's INCREMENTAL value over
// what the live -15 stop already delivers. (See the DEEP_STOP_PCT note above.)
function deepStopFloorPnl(position) {
  for (const s of position.snapshots) {
    if (s.pnl_pct != null && s.pnl_pct <= DEEP_STOP_PCT) return s.pnl_pct;
  }
  return position.actual_pnl_pct;
}

// pathRecoveredMax: highest PnL the RECORDED path reaches at/after `fromIdx` (later
// snapshot marks + the final realized actual). Used to flag winner-kills — an overlay
// that exits a position which then recovered to > +1 %.
function pathRecoveredMax(position, fromIdx, exitPnl) {
  let m = exitPnl != null ? exitPnl : -Infinity;
  const s = position.snapshots;
  for (let j = fromIdx + 1; j < s.length; j++) {
    if (s[j].pnl_pct != null && s[j].pnl_pct > m) m = s[j].pnl_pct;
  }
  if (position.actual_pnl_pct != null && position.actual_pnl_pct > m) m = position.actual_pnl_pct;
  return m;
}

// pathHitDeepStop: did this position (path or realized actual) ever reach the -15 stop?
// If so, the live deep stop already owns most of its downside — the overlay's credit on
// it overlaps the stop, so we partition it OUT of the "bleeder" (true-incremental) set.
function pathHitDeepStop(position) {
  for (const s of position.snapshots) if (s.pnl_pct != null && s.pnl_pct <= DEEP_STOP_PCT) return true;
  return position.actual_pnl_pct != null && position.actual_pnl_pct <= DEEP_STOP_PCT;
}

// ── Rule A: time-boxed underwater exit replay ─────────────────────────────
// PROPOSED rule (not in live code). Fire the FIRST snapshot where the position is
// underwater (pnl <= U) AND old enough (age >= M) AND has NEVER armed the profit
// ratchet (running peak, incl. the recorded poller peak, < RATCHET_ARM_GUARD) — so
// winner exits (trailing 3/1 + ratchet arm=2) stay untouched. This mirrors the task's
// second operationalization ("is <= U% AND age >= M and never armed the ratchet"),
// which is the replayable one: the alternative "underwater for M CONSECUTIVE minutes"
// form fires on n<=6 positions here because the snapshot ring retains only the last
// ~48 ticks (~4 h) per position, so a continuous M-minute underwater streak is rarely
// observable — that form is reported as anecdotal in the study, not gridded.
//
// COVERAGE SKEW (age-based form): because the ring keeps only the tail, a long-held
// position's FIRST retained snapshot is often already older than M (first-snap age
// median 26 m, p75 132 m across this dataset). The age>=M test can then only fire at
// that first retained tick — LATER than the true age-M crossing. So this replay is a
// CONSERVATIVE (late) proxy: the live rule could fire earlier (more save on real
// bleeders, but also earlier winner-kills). Positions where the first retained age
// already exceeds M are flagged coverage_partial.
//
// CONFIDENCE: a duration+level test the series resolves — HIGH when the firing tick is
// not a lone dip (the next snapshot does NOT pop back above U) AND the inter-snapshot
// gap into it is tight (<= HI_GAP_MIN). Otherwise LOW (whipsaw / unresolvable mark).
function simulateTimeboxUnderwater(position, U, M) {
  const s = position.snapshots;
  const mins = tsMin(s);
  const recordedPeak = position.path_features?.mfe_pnl_pct ?? null;
  const firstAge = mins.find((m) => m != null);
  let peak = -Infinity;
  for (let i = 0; i < s.length; i++) {
    const cur = s[i].pnl_pct;
    if (cur == null) continue;
    if (cur > peak) peak = cur;
    const age = mins[i];
    if (age == null || age < M || cur > U) continue;
    // Winner-protection: refuse to fire on anything the ratchet/trailing machinery owns.
    // Series peak covers arms we can see; recordedPeak (poller MFE) covers an arm that
    // happened between snapshots. (This still LEAKS when the peak predates the retained
    // window and no mfe was recorded — those leaks surface as winner-kills, reported.)
    if (peak >= RATCHET_ARM_GUARD || (recordedPeak != null && recordedPeak >= RATCHET_ARM_GUARD)) {
      return { fired: false, skipped_armed: true };
    }
    const recovers = i + 1 < s.length && s[i + 1].pnl_pct != null && s[i + 1].pnl_pct > U;
    const gap = i > 0 && mins[i] != null && mins[i - 1] != null ? mins[i] - mins[i - 1] : 0;
    const confidence = !recovers && gap <= HI_GAP_MIN ? "high" : "low";
    const recMax = pathRecoveredMax(position, i, cur);
    return {
      fired: true,
      exit_idx: i,
      exit_min: age,
      exit_pnl_pct: cur,
      confidence,
      winner_kill: recMax > 1,
      recovered_max: recMax,
      hit_deep_stop: pathHitDeepStop(position),
      coverage_partial: firstAge != null && firstAge > M + 5,
    };
  }
  return { fired: false };
}

// ── Rule B: low-yield min-age tightening replay ───────────────────────────
// Mirrors state.js low-yield branch: fee_per_tvl_24h < minFeePerTvl24h (LIVE 1 %) AND
// age >= minAgeBeforeYieldCheck. The live rule fires on a single reading (no confirm),
// so we fire the FIRST snapshot meeting both; the variant is the min-age knob. The
// fee/TVL series IS recorded per snapshot, so this family is genuinely replayable.
// CONFIDENCE mirrors the level-test discipline (HIGH unless the fee reading is a lone
// dip that recovers next snapshot, or the firing gap is wide).
function simulateLowYield(position, minAgeMin, threshPct = LIVE_EXIT.lowYieldThreshPct) {
  const s = position.snapshots;
  const mins = tsMin(s);
  for (let i = 0; i < s.length; i++) {
    const fee = s[i].fee_per_tvl_24h;
    const age = mins[i];
    if (fee == null || fee >= threshPct || age == null || age < minAgeMin) continue;
    const recovers =
      i + 1 < s.length && s[i + 1].fee_per_tvl_24h != null && s[i + 1].fee_per_tvl_24h >= threshPct;
    const gap = i > 0 && mins[i] != null && mins[i - 1] != null ? mins[i] - mins[i - 1] : 0;
    const confidence = !recovers && gap <= HI_GAP_MIN ? "high" : "low";
    const recMax = pathRecoveredMax(position, i, s[i].pnl_pct);
    return {
      fired: true,
      exit_idx: i,
      exit_min: age,
      exit_pnl_pct: s[i].pnl_pct,
      confidence,
      winner_kill: recMax > 1,
      recovered_max: recMax,
      hit_deep_stop: pathHitDeepStop(position),
    };
  }
  return { fired: false };
}

// ── Delta computation ────────────────────────────────────────────────────
// The counterfactual PnL is the snapshot mark at the exit tick (fees-inclusive).
// Delta vs actual realized PnL. We report deltas in pnl_pct points.
function evalVariant(position, sim) {
  if (!sim.fired) return null;
  const actual = position.actual_pnl_pct;
  if (actual == null || sim.exit_pnl_pct == null) return null;
  const delta = sim.exit_pnl_pct - actual;
  return {
    position: position.position,
    pool_name: position.pool_name,
    actual_pnl_pct: actual,
    cf_exit_pnl_pct: sim.exit_pnl_pct,
    delta_pct: Math.round(delta * 100) / 100,
    exit_min: sim.exit_min != null ? Math.round(sim.exit_min) : null,
    confidence: sim.confidence,
    rule: sim.rule ?? null,
    close_reason: position.close_reason,
  };
}

// Did this position ACTUALLY close as a stop-loss? (reason text or a deep loss.)
function actualWasStopLoss(ev) {
  const r = String(ev.close_reason || "").toLowerCase();
  if (r.includes("stop loss") || r.includes("stop-loss")) return true;
  return ev.actual_pnl_pct != null && ev.actual_pnl_pct <= LIVE.stopLossPct;
}

function stats(evals) {
  const highs = evals.filter((e) => e.confidence === "high");
  const deltas = evals.map((e) => e.delta_pct);
  const hDeltas = highs.map((e) => e.delta_pct);
  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
  const median = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  const winRate = (arr) => (arr.length ? arr.filter((x) => x > 0).length / arr.length : null);

  // High-conf win/loss/tie counts vs actual (|Δ|<=0.05 counts as a tie/no-change).
  const TIE = 0.05;
  const hiWin = highs.filter((e) => e.delta_pct > TIE).length;
  const hiLoss = highs.filter((e) => e.delta_pct < -TIE).length;
  const hiTie = highs.filter((e) => Math.abs(e.delta_pct) <= TIE).length;

  // SL-closes-prevented: positions that ACTUALLY stopped out but the variant exits
  // ABOVE the deep stop (cf_exit > LIVE.stopLossPct). High-confidence subset.
  const slPreventedHi = highs.filter(
    (e) => actualWasStopLoss(e) && e.cf_exit_pnl_pct != null && e.cf_exit_pnl_pct > LIVE.stopLossPct
  );

  // Worst truncation: the biggest winner (actual >= +3%) the variant would cut
  // short (most-negative Δ among high-conf evals on genuine winners).
  const winnerCuts = highs.filter((e) => e.actual_pnl_pct >= 3 && e.delta_pct < -TIE);
  let worstTrunc = null;
  for (const e of winnerCuts) {
    if (worstTrunc == null || e.delta_pct < worstTrunc.delta_pct) worstTrunc = e;
  }

  return {
    n: evals.length,
    n_high: highs.length,
    mean_delta: mean(deltas),
    median_delta: median(deltas),
    win_rate: winRate(deltas),
    high_mean_delta: mean(hDeltas),
    high_median_delta: median(hDeltas),
    high_win_rate: winRate(hDeltas),
    hi_win: hiWin,
    hi_loss: hiLoss,
    hi_tie: hiTie,
    sl_prevented_hi: slPreventedHi.length,
    sl_prevented_names: slPreventedHi.map((e) => `${e.pool_name}(${e.cf_exit_pnl_pct.toFixed(1)})`),
    worst_trunc: worstTrunc
      ? { pool: worstTrunc.pool_name, delta: worstTrunc.delta_pct, actual: worstTrunc.actual_pnl_pct, cf: worstTrunc.cf_exit_pnl_pct }
      : null,
  };
}

// ── Earlier-exit overlay families (timebox / lowyield): eval + stats + print ──
// These carry different honesty columns from the rich families above (closes
// affected, pts saved/lost split, winner-kills, incremental-over-live-15-stop), so
// they use their OWN eval/stats/print path and never touch stats()/printFamily().
function evalExitVariant(position, sim) {
  if (!sim.fired) return null;
  const actual = position.actual_pnl_pct;
  if (actual == null || sim.exit_pnl_pct == null) return null;
  const delta = sim.exit_pnl_pct - actual;
  const incr = sim.exit_pnl_pct - deepStopFloorPnl(position); // vs live -15 stop baseline
  return {
    position: position.position,
    pool_name: position.pool_name,
    actual_pnl_pct: actual,
    cf_exit_pnl_pct: sim.exit_pnl_pct,
    delta_pct: Math.round(delta * 100) / 100,
    incr_delta_pct: Math.round(incr * 100) / 100,
    exit_min: sim.exit_min != null ? Math.round(sim.exit_min) : null,
    hold_saved_min:
      position.minutes_held != null && sim.exit_min != null
        ? Math.round(position.minutes_held - sim.exit_min)
        : null,
    confidence: sim.confidence,
    winner_kill: !!sim.winner_kill,
    recovered_max: sim.recovered_max ?? null,
    hit_deep_stop: !!sim.hit_deep_stop,
    coverage_partial: !!sim.coverage_partial,
    close_reason: position.close_reason,
  };
}

function exitStats(evals) {
  const TIE = 0.05;
  const hi = evals.filter((e) => e.confidence === "high");
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : null);

  const hiSaved = hi.filter((e) => e.delta_pct > TIE);
  const hiLost = hi.filter((e) => e.delta_pct < -TIE);
  // Incremental (vs live -15 stop) — the stale-era-clean number. Bleeders = positions
  // the -15 stop NEVER caught, i.e. the overlay's genuinely-unique population.
  const hiBleed = hi.filter((e) => !e.hit_deep_stop);
  const hiWK = hi.filter((e) => e.winner_kill);
  const holdSaved = hi.map((e) => e.hold_saved_min).filter((v) => v != null);

  return {
    n: evals.length,
    n_high: hi.length,
    hi_mean_delta: mean(hi.map((e) => e.delta_pct)),
    hi_total_delta: sum(hi.map((e) => e.delta_pct)),
    hi_mean_incr: mean(hi.map((e) => e.incr_delta_pct)),
    hi_saved_n: hiSaved.length,
    hi_saved_avg: mean(hiSaved.map((e) => e.delta_pct)),
    hi_lost_n: hiLost.length,
    hi_lost_avg: mean(hiLost.map((e) => e.delta_pct)),
    hi_wk: hiWK.length,
    tot_wk: evals.filter((e) => e.winner_kill).length,
    hi_bleed_n: hiBleed.length,
    hi_bleed_sum_incr: sum(hiBleed.map((e) => e.incr_delta_pct)),
    hi_cov_partial: hi.filter((e) => e.coverage_partial).length,
    hi_mean_hold_saved: holdSaved.length ? Math.round(mean(holdSaved)) : null,
  };
}

function runExitFamily(family, positions, verbose) {
  const spec = VARIANTS[family];
  const rows = [];
  const perPositionDetail = [];
  for (const variant of spec.values) {
    const evals = [];
    for (const pos of positions) {
      if (pos.n_snapshots < 2) continue;
      const sim =
        family === "timebox"
          ? simulateTimeboxUnderwater(pos, variant.U, variant.M)
          : simulateLowYield(pos, variant);
      const ev = evalExitVariant(pos, sim);
      if (ev) {
        ev.variant = exitVariantLabel(family, variant);
        evals.push(ev);
      }
    }
    rows.push({ variant: exitVariantLabel(family, variant), is_live: isLiveVariant(family, variant), ...exitStats(evals) });
    if (verbose) perPositionDetail.push(...evals.map((e) => ({ ...e, _variant: exitVariantLabel(family, variant) })));
  }
  return { spec, rows, perPositionDetail };
}

function exitVariantLabel(family, v) {
  if (family === "timebox") return `U${v.U}/M${v.M}`;
  return `minAge=${v}`;
}

function printExitFamily(family, result) {
  const line = "─".repeat(112);
  console.log("");
  console.log(line);
  console.log(`RULE FAMILY: ${family}   (key: ${result.spec.key}, live default: ${JSON.stringify(result.spec.live_default)})`);
  console.log(line);
  console.log(
    "variant".padEnd(12) +
      "n".padStart(4) +
      "nHi".padStart(5) +
      "hiMeanΔ".padStart(9) +
      "hiΔ°incr".padStart(10) +
      "saved(n/avg)".padStart(15) +
      "lost(n/avg)".padStart(15) +
      "WK hi/tot".padStart(11) +
      "bleedIncrΣ".padStart(12) +
      "covPart".padStart(9) +
      "holdSaved".padStart(11)
  );
  for (const r of result.rows) {
    const liveTag = r.is_live ? " ←LIVE" : "";
    console.log(
      (r.variant + liveTag).padEnd(12) +
        String(r.n).padStart(4) +
        String(r.n_high).padStart(5) +
        fmt(r.hi_mean_delta).padStart(9) +
        fmt(r.hi_mean_incr).padStart(10) +
        `${r.hi_saved_n}/${fmt(r.hi_saved_avg, 1)}`.padStart(15) +
        `${r.hi_lost_n}/${fmt(r.hi_lost_avg, 1)}`.padStart(15) +
        `${r.hi_wk}/${r.tot_wk}`.padStart(11) +
        `${r.hi_bleed_n}:${fmt(r.hi_bleed_sum_incr, 1)}`.padStart(12) +
        String(r.hi_cov_partial).padStart(9) +
        (r.hi_mean_hold_saved == null ? "—" : `${r.hi_mean_hold_saved}m`).padStart(11)
    );
  }
  console.log("Δ = cf_pnl − actual (positive ⇒ overlay beats reality). hiΔ°incr = Δ vs the LIVE -15 stop baseline (cancels stale-era loose-stop credit — the honest number).");
  console.log("saved/lost = high-conf closes with Δ>+0.05 / Δ<-0.05 (n and avg pts). WK = winner-kills (exited a position that recovered to >+1%), hi/total.");
  console.log("bleedIncrΣ = n:Σincr over high-conf closes the live -15 stop NEVER caught (the overlay's TRUE incremental population). covPart = hi closes whose first retained snap was already older than M (coverage-limited).");
  if (result.perPositionDetail.length) {
    console.log("");
    console.log("  per-position detail (--verbose):");
    console.log(
      "  " +
        "variant".padEnd(11) +
        "pool".padEnd(16) +
        "actual".padStart(8) +
        "cfExit".padStart(9) +
        "Δpct".padStart(8) +
        "Δ°incr".padStart(9) +
        "min".padStart(6) +
        "hold-".padStart(7) +
        "conf".padStart(6) +
        "  flags".padEnd(12) +
        "reason"
    );
    for (const d of result.perPositionDetail) {
      const flags = [d.winner_kill ? "WK" : "", d.hit_deep_stop ? "deep15" : "", d.coverage_partial ? "cov" : ""].filter(Boolean).join(",");
      console.log(
        "  " +
          String(d._variant ?? d.variant).padEnd(11) +
          String(d.pool_name ?? d.position ?? "—").slice(0, 14).padEnd(16) +
          fmt(d.actual_pnl_pct).padStart(8) +
          fmt(d.cf_exit_pnl_pct).padStart(9) +
          fmt(d.delta_pct).padStart(8) +
          fmt(d.incr_delta_pct).padStart(9) +
          String(d.exit_min ?? "—").padStart(6) +
          String(d.hold_saved_min ?? "—").padStart(7) +
          String(d.confidence ?? "—").padStart(6) +
          "  " +
          String(flags || "—").padEnd(12) +
          String(d.close_reason ?? "").slice(0, 28)
      );
    }
  }
}

function fmt(v, d = 2) {
  if (v == null) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(d);
}
function fmtPct(v) {
  if (v == null) return "—";
  return (v * 100).toFixed(0) + "%";
}

function runFamily(family, positions, verbose) {
  const spec = VARIANTS[family];
  const rows = [];
  const perPositionDetail = [];

  for (const variant of spec.values) {
    const evals = [];
    for (const pos of positions) {
      if (pos.n_snapshots < 2) continue;
      let sim;
      if (family === "oor") sim = simulateOorBelow(pos, variant);
      else if (family === "stop") sim = simulateStopLoss(pos, variant);
      else if (family === "trailing")
        // Re-gridded 2026-07-08 through the COMPOSITE live rule set so the SL=-15
        // baseline is active (the old isolated simulateTrailing implicitly had no
        // stop). Compare against the same live default marked below.
        sim = simulateComposite(pos, { trigger: variant.trigger, drop: variant.drop });
      else if (family === "crash") sim = simulateCrash(pos, variant);
      else if (family === "ratchet")
        sim = simulateComposite(pos, { armPct: variant.arm, ratchetStopPct: variant.stop });
      const ev = evalVariant(pos, sim);
      if (ev) {
        ev.variant = variantLabel(family, variant);
        evals.push(ev);
      }
    }
    const st = stats(evals);
    rows.push({ variant: variantLabel(family, variant), is_live: isLiveVariant(family, variant), ...st });
    if (verbose) perPositionDetail.push(...evals.map((e) => ({ ...e, _variant: variantLabel(family, variant) })));
  }

  return { spec, rows, perPositionDetail };
}

function variantLabel(family, v) {
  if (family === "trailing") return `trig=${v.trigger} drop=${v.drop}`;
  if (family === "ratchet") return `arm=${v.arm} stop=${v.stop}`;
  return `${VARIANTS[family].key}=${v}`;
}
function isLiveVariant(family, v) {
  const d = VARIANTS[family].live_default;
  if (d == null) return false;
  if (family === "trailing") return v.trigger === d.trigger && v.drop === d.drop;
  return v === d;
}

// Composed best-ratchet × a chosen trailing (trigger/drop). One row.
function runCombo(positions, combos, verbose) {
  const spec = { key: "combo(ratchet+trailing)", live_default: LIVE };
  const rows = [];
  const perPositionDetail = [];
  for (const c of combos) {
    const evals = [];
    for (const pos of positions) {
      if (pos.n_snapshots < 2) continue;
      const sim = simulateComposite(pos, {
        trigger: c.trigger, drop: c.drop, armPct: c.arm, ratchetStopPct: c.stop,
      });
      const ev = evalVariant(pos, sim);
      if (ev) { ev.variant = c.label; evals.push(ev); }
    }
    const st = stats(evals);
    rows.push({ variant: c.label, is_live: false, ...st });
    if (verbose) perPositionDetail.push(...evals.map((e) => ({ ...e, _variant: c.label })));
  }
  return { spec, rows, perPositionDetail };
}

function printFamily(family, result) {
  const line = "─".repeat(92);
  console.log("");
  console.log(line);
  console.log(`RULE FAMILY: ${family}   (key: ${result.spec.key}, live default: ${JSON.stringify(result.spec.live_default)})`);
  console.log(line);
  const richFamily = family === "ratchet" || family === "trailing" || family === "combo";
  console.log(
    "variant".padEnd(24) +
      "n".padStart(4) +
      "nHi".padStart(5) +
      "hiMeanΔ".padStart(9) +
      "hiMedΔ".padStart(8) +
      "hiWin%".padStart(8) +
      (richFamily ? "  W/L/T".padEnd(11) + "SLprev".padStart(7) + "  worstTrunc" : "  (raw meanΔ/win%: " )
  );
  for (const r of result.rows) {
    const liveTag = r.is_live ? " ← LIVE" : "";
    let extra;
    if (richFamily) {
      const wlt = `${r.hi_win}/${r.hi_loss}/${r.hi_tie}`;
      const wt = r.worst_trunc
        ? `${r.worst_trunc.pool}:${fmt(r.worst_trunc.delta)}(${fmt(r.worst_trunc.actual)}→${fmt(r.worst_trunc.cf)})`
        : "none";
      extra = "  " + wlt.padEnd(9) + String(r.sl_prevented_hi).padStart(7) + "  " + wt;
    } else {
      extra = "  " + fmt(r.mean_delta) + "/" + fmtPct(r.win_rate) + ")";
    }
    console.log(
      (r.variant + liveTag).padEnd(24) +
        String(r.n).padStart(4) +
        String(r.n_high).padStart(5) +
        fmt(r.high_mean_delta).padStart(9) +
        fmt(r.high_median_delta).padStart(8) +
        fmtPct(r.high_win_rate).padStart(8) +
        extra
    );
  }
  console.log("Δ = counterfactual_pnl_pct − actual_pnl_pct  (positive ⇒ the variant beats reality)");
  console.log("hi* columns = HIGH-confidence subset only. W/L/T = high-conf win/loss/tie vs actual (tie=|Δ|<=0.05).");
  if (richFamily)
    console.log("SLprev = high-conf positions that ACTUALLY stopped out but this variant exits above -15. worstTrunc = biggest winner (actual>=+3%) it cuts.");

  if (result.perPositionDetail.length) {
    console.log("");
    console.log("  per-position detail (--verbose):");
    console.log(
      "  " +
        "variant".padEnd(18) +
        "pool".padEnd(16) +
        "actual".padStart(8) +
        "cfExit".padStart(9) +
        "Δpct".padStart(8) +
        "min".padStart(6) +
        "conf".padStart(6) +
        "rule".padStart(14) +
        "  reason"
    );
    for (const d of result.perPositionDetail) {
      console.log(
        "  " +
          String(d._variant ?? d.variant).padEnd(18) +
          String(d.pool_name ?? d.position ?? "—").slice(0, 14).padEnd(16) +
          fmt(d.actual_pnl_pct).padStart(8) +
          fmt(d.cf_exit_pnl_pct).padStart(9) +
          fmt(d.delta_pct).padStart(8) +
          String(d.exit_min ?? "—").padStart(6) +
          String(d.confidence ?? "—").padStart(6) +
          String(d.rule ?? "—").padStart(14) +
          "  " +
          String(d.close_reason ?? "").slice(0, 30)
      );
    }
  }
}

function printCaveats(dataset) {
  const line = "═".repeat(92);
  console.log("");
  console.log(line);
  console.log("CAVEATS — read before trusting any number above");
  console.log(line);
  console.log(
    [
      "1. SNAPSHOT CADENCE. Path series are recorded every mgmt cycle (~3–10 min). A rule whose",
      "   decision boundary depends on sub-cadence timing (the 15s crash detector; the exact",
      "   instant a trailing-TP fires between two far-apart snapshots) CANNOT be replayed faithfully.",
      "   Such evaluations are bucketed as LOW confidence and kept OUT of the hi* columns. Trust the",
      "   hi* columns; treat the raw columns as a directional upper bound on sample size.",
      "",
      "2. CRASH RULE is intrinsically low-confidence here. The live detector runs on a 3s poll and",
      "   measures velocity over ~90s. We approximate velocity from adjacent snapshots minutes apart,",
      "   only on dense series (median gap <= " + DENSE_GAP_MIN + "m). Every crash eval is flagged low.",
      "",
      "3. FEES AFTER A COUNTERFACTUAL EXIT are handled by using the snapshot's own mark-to-market",
      "   pnl_pct at the exit tick (which already reflects fees accrued up to that tick). Where a",
      "   pro-rata fee estimate is needed it assumes fees accrue linearly with hold time — optimistic,",
      "   since fees are front-loaded while in-range. Deltas are therefore mildly biased.",
      "",
      "4. SURVIVORSHIP. Only positions we ACTUALLY HELD are replayable. This says nothing about",
      "   pools we screened and rejected (pool-selection counterfactuals) — that needs the",
      "   rejected-candidates store to accrue forward-looking price data first.",
      "",
      "5. MARK QUALITY. Counterfactual exit PnL is the recorded snapshot mark, not a fills-simulated",
      "   exit. Illiquid exits realize worse than the mark (see exit_swap slippage in CLAUDE.md).",
      "   Real-world deltas on downside exits are therefore modestly overstated.",
      "",
      "6. SNAPSHOT FIELD ERAS. active/lower/upper_bin exist only on snapshots after 2026-06-16.",
      "   For older snapshots the oor rule infers the below-side from in_range=false + an OOR-below",
      "   close_reason (LOW confidence); the crash rule is not evaluable at all on those positions.",
    ].join("\n")
  );
  console.log(line);
  const c = dataset.counts || {};
  console.log(
    `dataset: n=${c.n ?? "?"} positions, ${c.withSeries ?? "?"} with series, ` +
      `${c.dense ?? "?"} dense, ${c.withPath ?? "?"} with path features, ` +
      `${c.withPostClose ?? "?"} with post-close probes.`
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.in)) {
    console.error(`Dataset not found: ${args.in}`);
    console.error("Run: node scripts/replay/extract.js  (or --in <path>)");
    process.exit(1);
  }

  let dataset;
  try {
    dataset = JSON.parse(fs.readFileSync(args.in, "utf8"));
  } catch (e) {
    console.error(`Failed to parse ${args.in}: ${e.message}`);
    process.exit(1);
  }

  const positions = dataset.positions || [];
  const evaluable = positions.filter((p) => p.n_snapshots >= 2);

  console.log(`Loaded ${positions.length} positions (${evaluable.length} with a usable snapshot series).`);
  if (evaluable.length === 0) {
    console.log("");
    console.log("No positions have a >=2-snapshot path series — nothing to replay.");
    console.log("This is expected on a dev machine with empty stores. Run extract.js on the VM");
    console.log("against the pg-backed history, then re-run this.");
    printCaveats(dataset);
    process.exit(0);
  }

  const families = args.rule === "all"
    ? ["oor", "trailing", "stop", "crash", "ratchet", "combo", "timebox", "lowyield"]
    : [args.rule];
  for (const fam of families) {
    if (fam === "timebox" || fam === "lowyield") {
      // Rule A / Rule B — earlier-exit overlays for the loser/deadweight population.
      // Own eval/stats/print path (different honesty columns; winner exits untouched).
      printExitFamily(fam, runExitFamily(fam, evaluable, args.verbose));
      continue;
    }
    if (fam === "combo") {
      // Composed best-ratchet × best/live-trailing. The specific combos are chosen
      // to bracket the recommendation: live-trailing × a few promising ratchets,
      // plus the standalone live baseline for reference.
      const combos = [
        { label: "live 3/1 (no ratchet)", trigger: 3, drop: 1.0, arm: null, stop: null },
        { label: "3/1 + arm2 stop-1", trigger: 3, drop: 1.0, arm: 2, stop: -1 },
        { label: "3/1 + arm2 stop-2", trigger: 3, drop: 1.0, arm: 2, stop: -2 },
        { label: "3/1 + arm1.5 stop-1", trigger: 3, drop: 1.0, arm: 1.5, stop: -1 },
        { label: "3/1 + arm2.5 stop-2", trigger: 3, drop: 1.0, arm: 2.5, stop: -2 },
        { label: "2.5/1 + arm2 stop-2", trigger: 2.5, drop: 1.0, arm: 2, stop: -2 },
      ];
      const result = runCombo(evaluable, combos, args.verbose);
      printFamily("combo", result);
      continue;
    }
    if (!VARIANTS[fam]) {
      console.error(`Unknown rule family: ${fam} (valid: oor, trailing, stop, crash, ratchet, combo, timebox, lowyield, all)`);
      process.exit(1);
    }
    const result = runFamily(fam, evaluable, args.verbose);
    printFamily(fam, result);
  }

  printCaveats(dataset);
}

main();
