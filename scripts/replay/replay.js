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
 *   node scripts/replay/replay.js --in dataset.json
 *   node scripts/replay/replay.js --rule oor          # oor | trailing | stop | crash
 *   node scripts/replay/replay.js --verbose           # per-position detail rows
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IN = path.join(__dirname, "dataset.json");

// Variant grids (mirror the config knobs). Kept small + legible.
const VARIANTS = {
  oor: { key: "outOfRangeWaitMinutesBelow", values: [15, 30, 45, 63, 90], live_default: 180 },
  trailing: {
    // (triggerPct, dropPct) pairs — live defaults trigger=3, drop=1.5
    key: "trailing",
    values: [
      { trigger: 3, drop: 1.0 },
      { trigger: 3, drop: 1.5 },
      { trigger: 3, drop: 2.5 },
      { trigger: 5, drop: 2.0 },
      { trigger: 8, drop: 3.0 },
    ],
    live_default: { trigger: 3, drop: 1.5 },
  },
  stop: { key: "stopLossPct", values: [-15, -25, -35, -50, -70], live_default: -50 },
  crash: { key: "crashBinsPerMin", values: [8, 12, 20], live_default: 12 },
};

const DENSE_GAP_MIN = 5; // median gap at/below this ⇒ crash rule is (weakly) evaluable

function parseArgs(argv) {
  const args = { in: DEFAULT_IN, rule: "all", verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verbose") args.verbose = true;
    else if (a === "--rule") args.rule = argv[++i];
    else if (a.startsWith("--rule=")) args.rule = a.slice("--rule=".length);
    else if (a === "--in") args.in = path.resolve(argv[++i]);
    else if (a.startsWith("--in=")) args.in = path.resolve(a.slice("--in=".length));
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
// Mirrors state.js updatePnlAndCheckExits OOR-below branch: a position OOR-below
// for >= limit minutes closes. We find the first snapshot that is OOR-below and
// has been so for >= limit minutes, and use that snapshot's mark as the exit PnL.
//
// OOR-below detection at a snapshot: active_bin < lower_bin (matches live isBelowRange).
// Duration: consecutive OOR-below snapshots' elapsed time since OOR-below began.
function simulateOorBelow(position, limitMin) {
  const s = position.snapshots;
  const mins = tsMin(s);
  let oorStart = null; // minutes-since-deploy when the current OOR-below streak began
  for (let i = 0; i < s.length; i++) {
    const snap = s[i];
    const isBelow =
      snap.active_bin != null &&
      snap.lower_bin != null &&
      snap.active_bin < snap.lower_bin;
    if (!isBelow) {
      oorStart = null;
      continue;
    }
    if (oorStart == null) oorStart = mins[i];
    const durMin = mins[i] != null && oorStart != null ? mins[i] - oorStart : null;
    if (durMin != null && durMin >= limitMin) {
      return {
        fired: true,
        exit_idx: i,
        exit_min: mins[i],
        exit_pnl_pct: snap.pnl_pct,
        // Confidence: HIGH if the *previous* snapshot was NOT yet past the limit
        // (so the boundary is bracketed by two snapshots) AND the gap is coarse
        // enough that sub-minute timing doesn't matter (it never does for an
        // OOR *duration* test — the resolution is the snapshot cadence itself).
        confidence: "high",
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
    close_reason: position.close_reason,
  };
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
  return {
    n: evals.length,
    n_high: highs.length,
    mean_delta: mean(deltas),
    median_delta: median(deltas),
    win_rate: winRate(deltas),
    high_mean_delta: mean(hDeltas),
    high_median_delta: median(hDeltas),
    high_win_rate: winRate(hDeltas),
  };
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
      else if (family === "trailing") sim = simulateTrailing(pos, variant.trigger, variant.drop);
      else if (family === "crash") sim = simulateCrash(pos, variant);
      const ev = evalVariant(pos, sim);
      if (ev) {
        ev.variant = family === "trailing" ? `t${variant.trigger}/d${variant.drop}` : String(variant);
        evals.push(ev);
      }
    }
    const st = stats(evals);
    rows.push({
      variant: family === "trailing" ? `trig=${variant.trigger} drop=${variant.drop}` : `${spec.key}=${variant}`,
      ...st,
    });
    if (verbose) perPositionDetail.push(...evals);
  }

  return { spec, rows, perPositionDetail };
}

function printFamily(family, result) {
  const line = "─".repeat(92);
  console.log("");
  console.log(line);
  console.log(`RULE FAMILY: ${family}   (key: ${result.spec.key}, live default: ${JSON.stringify(result.spec.live_default)})`);
  console.log(line);
  console.log(
    "variant".padEnd(26) +
      "n".padStart(4) +
      "nHi".padStart(5) +
      "meanΔ".padStart(9) +
      "medΔ".padStart(8) +
      "win%".padStart(7) +
      " │ " +
      "hiMeanΔ".padStart(9) +
      "hiMedΔ".padStart(9) +
      "hiWin%".padStart(8)
  );
  for (const r of result.rows) {
    console.log(
      r.variant.padEnd(26) +
        String(r.n).padStart(4) +
        String(r.n_high).padStart(5) +
        fmt(r.mean_delta).padStart(9) +
        fmt(r.median_delta).padStart(8) +
        fmtPct(r.win_rate).padStart(7) +
        " │ " +
        fmt(r.high_mean_delta).padStart(9) +
        fmt(r.high_median_delta).padStart(9) +
        fmtPct(r.high_win_rate).padStart(8)
    );
  }
  console.log("Δ = counterfactual_pnl_pct − actual_pnl_pct  (positive ⇒ the variant beats reality)");
  console.log("hi* columns = HIGH-confidence subset only (sub-cadence timing does not distort these).");

  if (result.perPositionDetail.length) {
    console.log("");
    console.log("  per-position detail (--verbose):");
    console.log(
      "  " +
        "variant".padEnd(14) +
        "pool".padEnd(18) +
        "actual".padStart(8) +
        "cfExit".padStart(9) +
        "Δpct".padStart(8) +
        "min".padStart(6) +
        "conf".padStart(6) +
        "  reason"
    );
    for (const d of result.perPositionDetail) {
      console.log(
        "  " +
          String(d.variant).padEnd(14) +
          String(d.pool_name ?? d.position ?? "—").slice(0, 16).padEnd(18) +
          fmt(d.actual_pnl_pct).padStart(8) +
          fmt(d.cf_exit_pnl_pct).padStart(9) +
          fmt(d.delta_pct).padStart(8) +
          String(d.exit_min ?? "—").padStart(6) +
          String(d.confidence ?? "—").padStart(6) +
          "  " +
          String(d.close_reason ?? "").slice(0, 32)
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

  const families = args.rule === "all" ? ["oor", "trailing", "stop", "crash"] : [args.rule];
  for (const fam of families) {
    if (!VARIANTS[fam]) {
      console.error(`Unknown rule family: ${fam} (valid: oor, trailing, stop, crash, all)`);
      process.exit(1);
    }
    const result = runFamily(fam, evaluable, args.verbose);
    printFamily(fam, result);
  }

  printCaveats(dataset);
}

main();
