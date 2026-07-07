#!/usr/bin/env node
/**
 * rank_admission_backtest.js — empirical test of "rank" vs "gate" screener admission
 * against real closed-position outcomes. READ-ONLY analysis, no side effects.
 *
 * Usage: node scripts/rank_admission_backtest.js [path-to-perf-dump.json]
 *
 * Ground-truth label replicates lessons.js classifyOutcome() exactly (see below).
 * pnl_usd / fees_earned_usd are SOL-denominated (solMode) — treated as relative only.
 * We only ever use pnl_pct, fee-yield ratios, and outcome class for labels.
 */

import fs from "fs";

const DEFAULT_DUMP =
  "/private/tmp/claude-501/-Users-Angga-Repos-meridian/03f6f1dd-490c-47e6-91c8-a608813826a5/scratchpad/perf-dump.json";
const path = process.argv[2] || DEFAULT_DUMP;
const RECS = JSON.parse(fs.readFileSync(path, "utf8"));

// ---------------------------------------------------------------------------
// GROUND TRUTH — verbatim port of lessons.js classifyOutcome (lines 869-889)
// ---------------------------------------------------------------------------
const isFiniteNum = (x) => typeof x === "number" && Number.isFinite(x);

function classifyOutcome(perf) {
  const pnl = isFiniteNum(perf?.pnl_pct) ? perf.pnl_pct : null;
  if (pnl == null) return "neutral";
  const feeYield = perf.initial_value_usd > 0
    ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100
    : 0;
  const reason = String(perf.close_reason || "").toLowerCase();
  const isFeeDeath = reason.includes("yield");
  const isStopLoss = reason.includes("stop loss");
  const isOorCollapse = (reason.includes("oor") || reason.includes("out of range") || reason.includes("below")) && pnl < 0;
  const rangeEff = isFiniteNum(perf.range_efficiency) ? perf.range_efficiency : 100;
  if (isStopLoss || pnl <= -5 || (isFeeDeath && feeYield < 1) || isOorCollapse || (rangeEff < 30 && pnl < 0)) {
    return "failure";
  }
  if (!isFeeDeath && (pnl >= 2 || feeYield >= 2)) return "success";
  return "neutral";
}

// success-rate over decisive (success+failure), matches lessons.successRate.
// Accepts either raw perf records OR mapped feat objects that carry a precomputed `cls`.
function classOf(r) {
  return (r && typeof r.cls === "string") ? r.cls : classifyOutcome(r);
}
function successRate(recs) {
  let s = 0, f = 0;
  for (const r of recs) {
    const c = classOf(r);
    if (c === "success") s++; else if (c === "failure") f++;
  }
  const dec = s + f;
  return { s, f, dec, rate: dec > 0 ? s / dec : null };
}

// ---------------------------------------------------------------------------
// stats helpers
// ---------------------------------------------------------------------------
function wilson(k, n, z = 1.96) {
  if (n === 0) return [null, null];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
const pct = (x) => (x == null ? "  -- " : (x * 100).toFixed(1).padStart(5));
const f2 = (x) => (x == null || !Number.isFinite(x) ? "  --" : x.toFixed(2));

// Spearman rank correlation between two arrays (missing pairs dropped by caller)
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 4) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}
// approx 2-sided significance flag for spearman rho (|rho| > z/sqrt(n-1))
function rhoSig(rho, n) {
  if (rho == null) return "";
  const crit = 1.96 / Math.sqrt(n - 1);
  return Math.abs(rho) > crit ? "*" : " ";
}

// ---------------------------------------------------------------------------
// feature extraction — read deploy-time entry features off each record
// ---------------------------------------------------------------------------
function feat(r) {
  const s = r.signal_snapshot || {};
  return {
    intel_total: isFiniteNum(s.intel_total) ? s.intel_total : null,
    organic_score: isFiniteNum(r.organic_score) ? r.organic_score : null,
    fee_tvl_ratio: isFiniteNum(r.fee_tvl_ratio) ? r.fee_tvl_ratio : null,
    entry_tvl: isFiniteNum(r.entry_tvl) ? r.entry_tvl : null,
    entry_mcap: isFiniteNum(r.entry_mcap) ? r.entry_mcap : null,
    entry_volume: isFiniteNum(r.entry_volume) ? r.entry_volume : null,
    entry_holders: isFiniteNum(r.entry_holders) ? r.entry_holders : null,
    volatility: isFiniteNum(r.volatility) ? r.volatility : null,
    pnl_pct: isFiniteNum(r.pnl_pct) ? r.pnl_pct : null,
    cls: classifyOutcome(r),
    recorded_at: r.recorded_at,
  };
}
const ALL = RECS.map(feat);
const N = ALL.length;

console.log("=".repeat(78));
console.log("RANK vs GATE ADMISSION BACKTEST  —  Meridian closed-position history");
console.log("=".repeat(78));
console.log(`records loaded: ${N}   (intel-scored: ${ALL.filter((r) => r.intel_total != null).length})`);

// overall label distribution — should reconcile with getPerformanceSummary
{
  const g = { success: 0, failure: 0, neutral: 0 };
  for (const r of ALL) g[r.cls]++;
  const sr = successRate(ALL);
  const recent40 = successRate(ALL.slice(-40));
  console.log(
    `\nlabel distribution (all ${N}):  success=${g.success}  failure=${g.failure}  neutral=${g.neutral}`
  );
  console.log(
    `official success-rate  = ${pct(sr.rate)}%  (success/${sr.dec} decisive)   [system all-time reference ~34%]`
  );
  console.log(
    `recent-40 success-rate = ${pct(recent40.rate)}%  (success/${recent40.dec} decisive)  [system reference ~59%]`
  );
  const feeDeaths = RECS.filter((r) => String(r.close_reason || "").toLowerCase().includes("yield")).length;
  console.log(`fee-death rate = ${(feeDeaths / N * 100).toFixed(1)}%  (${feeDeaths}/${N})`);
}

// binary success outcome for correlation: 1 if success, 0 if failure; drop neutrals
function binOutcome(r) {
  return r.cls === "success" ? 1 : r.cls === "failure" ? 0 : null;
}

// ---------------------------------------------------------------------------
// ANALYSIS 1 — feature discrimination (quartiles + spearman)
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("ANALYSIS 1 — FEATURE DISCRIMINATION");
console.log("=".repeat(78));

const FEATURES = [
  ["intel_total", "intel_total"],
  ["organic_score", "organic_score"],
  ["fee_tvl_ratio", "fee_tvl_ratio"],
  ["entry_tvl", "entry_tvl"],
  ["entry_mcap", "entry_mcap"],
  ["entry_volume", "entry_volume"],
  ["entry_holders", "entry_holders"],
  ["volatility", "volatility"],
];

function quartileBuckets(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return [q(0.25), q(0.5), q(0.75)];
}

for (const [key, label] of FEATURES) {
  const present = ALL.filter((r) => r[key] != null);
  const vals = present.map((r) => r[key]);
  if (vals.length < 8) {
    console.log(`\n${label}: only ${vals.length} records with value — SKIPPED`);
    continue;
  }
  const [q1, q2, q3] = quartileBuckets(vals);
  const bucketOf = (v) => (v <= q1 ? 0 : v <= q2 ? 1 : v <= q3 ? 2 : 3);
  const buckets = [[], [], [], []];
  for (const r of present) buckets[bucketOf(r[key])].push(r);

  console.log(`\n${label}  (n=${present.length};  quartile cuts: ${f2(q1)} / ${f2(q2)} / ${f2(q3)})`);
  console.log("  bucket           range                 n   succ  fail  neut  succ-rate  [Wilson95]      mean_pnl%");
  const labels = ["Q1 (low) ", "Q2       ", "Q3       ", "Q4 (high)"];
  buckets.forEach((b, i) => {
    const sr = successRate(b);
    const [lo, hi] = wilson(sr.s, sr.dec);
    const vlist = b.map((r) => r[key]);
    const rng = vlist.length ? `${f2(Math.min(...vlist))}..${f2(Math.max(...vlist))}` : "--";
    const meanPnl = b.length ? b.reduce((a, r) => a + (r.pnl_pct || 0), 0) / b.length : 0;
    const flag = b.length < 10 ? " ⚠n<10" : "";
    console.log(
      `  ${labels[i]}  ${rng.padEnd(20)}  ${String(b.length).padStart(3)}  ` +
      `${String(sr.s).padStart(4)}  ${String(sr.f).padStart(4)}  ${String(b.length - sr.dec).padStart(4)}  ` +
      `${pct(sr.rate)}%    [${pct(lo)},${pct(hi)}]   ${meanPnl >= 0 ? " " : ""}${meanPnl.toFixed(2)}${flag}`
    );
  });

  // Spearman: feature vs binary success (decisive only) and vs pnl_pct (all present)
  const dec = present.filter((r) => binOutcome(r) != null);
  const rhoBin = spearman(dec.map((r) => r[key]), dec.map((r) => binOutcome(r)));
  const rhoPnl = spearman(present.map((r) => r[key]), present.map((r) => r.pnl_pct || 0));
  console.log(
    `  Spearman rho:  vs success(binary,n=${dec.length}) = ${f2(rhoBin)}${rhoSig(rhoBin, dec.length)}` +
    `   vs pnl_pct(n=${present.length}) = ${f2(rhoPnl)}${rhoSig(rhoPnl, present.length)}   (* = |rho|>1.96/sqrt(n-1))`
  );
}

// ---------------------------------------------------------------------------
// ANALYSIS 2 — gate counterfactual: did strict floors earn their keep?
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("ANALYSIS 2 — GATE COUNTERFACTUAL (threshold sets applied to entry features)");
console.log("=".repeat(78));
console.log("holders>=500 & volume>=1000 in all three sets. fee_tvl_ratio in raw API units (no conversion).");

const GATES = {
  "strict/yesterday": { org: 81, ftr: 0.49, tvlMin: 50000, tvlMax: 250000, mcapMin: 500000, mcapMax: 10000000 },
  "relaxed/today":    { org: 74, ftr: 0.30, tvlMin: 30000, tvlMax: 250000, mcapMin: 300000, mcapMax: 10000000 },
  "loose/defaults":   { org: 60, ftr: 0.05, tvlMin: 10000, tvlMax: 150000, mcapMin: 150000, mcapMax: 10000000 },
};

function passesGate(r, g) {
  // records missing a needed field can't be evaluated → excluded from that gate's admit set
  if (r.organic_score == null || r.fee_tvl_ratio == null || r.entry_tvl == null ||
      r.entry_mcap == null || r.entry_holders == null || r.entry_volume == null) return null;
  return (
    r.organic_score >= g.org &&
    r.fee_tvl_ratio >= g.ftr &&
    r.entry_tvl >= g.tvlMin && r.entry_tvl <= g.tvlMax &&
    r.entry_mcap >= g.mcapMin && r.entry_mcap <= g.mcapMax &&
    r.entry_holders >= 500 &&
    r.entry_volume >= 1000
  );
}

const allSucc = ALL.filter((r) => r.cls === "success");
const allFail = ALL.filter((r) => r.cls === "failure");
console.log(`\nbaseline pool: ${allSucc.length} successes, ${allFail.length} failures (of ${N})`);
console.log("\nset               admitted  admit%  succ-blocked  fail-blocked   admitted succ-rate  [Wilson95]");
for (const [name, g] of Object.entries(GATES)) {
  const evald = ALL.map((r) => ({ r, pass: passesGate(r, g) })).filter((x) => x.pass != null);
  const admitted = evald.filter((x) => x.pass).map((x) => x.r);
  const blockedSucc = allSucc.filter((r) => passesGate(r, g) === false).length;
  const blockedFail = allFail.filter((r) => passesGate(r, g) === false).length;
  const sr = successRate(admitted);
  const [lo, hi] = wilson(sr.s, sr.dec);
  console.log(
    `${name.padEnd(17)} ${String(admitted.length).padStart(6)}   ${(admitted.length / evald.length * 100).toFixed(0).padStart(4)}%  ` +
    `${(blockedSucc / allSucc.length * 100).toFixed(0).padStart(6)}% (${blockedSucc}/${allSucc.length})  ` +
    `${(blockedFail / allFail.length * 100).toFixed(0).padStart(5)}% (${blockedFail}/${allFail.length})  ` +
    `${pct(sr.rate)}% (${sr.s}/${sr.dec})   [${pct(lo)},${pct(hi)}]`
  );
}
console.log("\nread: a good gate blocks a HIGHER fraction of failures than of successes, and lifts admitted succ-rate.");

// ---------------------------------------------------------------------------
// ANALYSIS 3 — rank counterfactual at matched admission rates (intel-scored 137)
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("ANALYSIS 3 — RANK vs GATE at MATCHED admission fractions (intel-scored subset)");
console.log("=".repeat(78));

const INTEL = ALL.filter((r) => r.intel_total != null);
console.log(`intel-scored records: ${INTEL.length}`);

function subsetStats(subset) {
  const sr = successRate(subset);
  const meanPnl = subset.length ? subset.reduce((a, r) => a + (r.pnl_pct || 0), 0) / subset.length : 0;
  return { sr, meanPnl };
}

// admit top-X% by a scoring key (higher=better)
function topByScore(recs, scoreFn, frac) {
  const sorted = [...recs].sort((a, b) => scoreFn(b) - scoreFn(a));
  const k = Math.max(1, Math.round(recs.length * frac));
  return sorted.slice(0, k);
}

// "admit by metric floors" ranked proxy: score = composite of the gate metrics,
// admit the same count. We use a z-score sum of organic + fee_tvl_ratio + (in-band tvl/mcap)
// as a stand-in "metric quality" ranking so admission counts match exactly.
function zscorer(recs, keys) {
  const stats = {};
  for (const k of keys) {
    const vals = recs.map((r) => r[k]).filter(isFiniteNum);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) || 1;
    stats[k] = { m, sd };
  }
  return (r) => keys.reduce((acc, k) => acc + (isFiniteNum(r[k]) ? (r[k] - stats[k].m) / stats[k].sd : 0), 0);
}

const metricScore = zscorer(INTEL, ["organic_score", "fee_tvl_ratio"]);
const intelScore = (r) => r.intel_total;
const compositeIO = (() => {
  const z = zscorer(INTEL, ["intel_total", "organic_score"]);
  return z;
})();
const compositeIF = (() => {
  const z = zscorer(INTEL, ["intel_total", "fee_tvl_ratio"]);
  return z;
})();

console.log("\n[3a] admit TOP-X% by ranking rule — success-rate & mean pnl% among admitted:");
console.log("  frac   rule                     admit-n  succ-rate  [Wilson95]       mean_pnl%");
for (const frac of [0.25, 0.5, 0.75]) {
  const rules = [
    ["intel_total", intelScore],
    ["metric(org+ftr z)", metricScore],
    ["intel+organic (z)", compositeIO],
    ["intel+fee_tvl (z)", compositeIF],
  ];
  for (const [rname, fn] of rules) {
    const sub = topByScore(INTEL, fn, frac);
    const { sr, meanPnl } = subsetStats(sub);
    const [lo, hi] = wilson(sr.s, sr.dec);
    console.log(
      `  ${(frac * 100).toFixed(0).padStart(3)}%   ${rname.padEnd(22)} ${String(sub.length).padStart(6)}   ` +
      `${pct(sr.rate)}% (${sr.s}/${sr.dec})  [${pct(lo)},${pct(hi)}]   ${meanPnl.toFixed(2)}`
    );
  }
  console.log("");
}

console.log("[3b] intel_total ABSOLUTE cutoffs (admit intel_total >= cut):");
console.log("  cutoff  admit-n  admit%  succ-rate  [Wilson95]       mean_pnl%   (blocked succ/fail of intel subset)");
const intelSucc = INTEL.filter((r) => r.cls === "success").length;
const intelFail = INTEL.filter((r) => r.cls === "failure").length;
for (const cut of [35, 45, 52, 60]) {
  const sub = INTEL.filter((r) => r.intel_total >= cut);
  const { sr, meanPnl } = subsetStats(sub);
  const [lo, hi] = wilson(sr.s, sr.dec);
  const blkSucc = INTEL.filter((r) => r.cls === "success" && r.intel_total < cut).length;
  const blkFail = INTEL.filter((r) => r.cls === "failure" && r.intel_total < cut).length;
  console.log(
    `  ${String(cut).padStart(4)}    ${String(sub.length).padStart(5)}   ${(sub.length / INTEL.length * 100).toFixed(0).padStart(4)}%  ` +
    `${pct(sr.rate)}% (${sr.s}/${sr.dec})  [${pct(lo)},${pct(hi)}]   ${meanPnl.toFixed(2)}      ` +
    `blk ${blkSucc}/${intelSucc}s ${blkFail}/${intelFail}f`
  );
}

// ---------------------------------------------------------------------------
// ANALYSIS 4 — era analysis + confounds
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("ANALYSIS 4 — ERA ANALYSIS (rolling 30-close success-rate + feature drift)");
console.log("=".repeat(78));

const ordered = [...ALL].sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
console.log("\nrolling window (step 20, width 30 closes):");
console.log("  window(idx)   date-start    succ-rate  [Wilson95]    med_organic  med_ftr  med_intel");
for (let start = 0; start + 30 <= ordered.length; start += 20) {
  const w = ordered.slice(start, start + 30);
  const sr = successRate(w);
  const [lo, hi] = wilson(sr.s, sr.dec);
  const med = (key) => {
    const v = w.map((r) => r[key]).filter(isFiniteNum).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  console.log(
    `  [${String(start).padStart(3)}-${String(start + 30).padStart(3)}]    ${w[0].recorded_at.slice(0, 10)}    ` +
    `${pct(sr.rate)}% (${sr.s}/${sr.dec})  [${pct(lo)},${pct(hi)}]   ` +
    `${f2(med("organic_score")).padStart(6)}    ${f2(med("fee_tvl_ratio")).padStart(5)}   ${med("intel_total") ?? "  --"}`
  );
}
// last window tail if not aligned
if ((ordered.length - 30) % 20 !== 0) {
  const w = ordered.slice(-30);
  const sr = successRate(w);
  const [lo, hi] = wilson(sr.s, sr.dec);
  console.log(`  [tail-30 ]    ${w[0].recorded_at.slice(0, 10)}    ${pct(sr.rate)}% (${sr.s}/${sr.dec})  [${pct(lo)},${pct(hi)}]`);
}

// marginal band vs comfortable band under strict gate (within admitted pools)
console.log("\nMARGINAL-BAND test (organic_score, within-history): pools near a floor vs comfortably above:");
for (const [floorName, floor, band] of [["organic>=74", 74, 6], ["organic>=81", 81, 6]]) {
  const marginal = ALL.filter((r) => r.organic_score != null && r.organic_score >= floor && r.organic_score < floor + band);
  const comfort = ALL.filter((r) => r.organic_score != null && r.organic_score >= floor + band);
  const sm = successRate(marginal), sc = successRate(comfort);
  console.log(
    `  ${floorName}:  marginal[${floor}-${floor + band}) n=${marginal.length} succ=${pct(sm.rate)}% (${sm.s}/${sm.dec})   ` +
    `comfortable[>=${floor + band}] n=${comfort.length} succ=${pct(sc.rate)}% (${sc.s}/${sc.dec})`
  );
}

console.log("\nSURVIVORSHIP CAVEAT: this history contains ONLY deploys that passed the then-current gates.");
console.log("Range-restriction means 'would a below-floor pool have succeeded?' is UNANSWERABLE here.");
console.log("What IS answerable: within admitted pools, do floors/scores predict outcome, and does the");
console.log("marginal band (near-floor) underperform the comfortable band.");

// ---------------------------------------------------------------------------
// ANALYSIS 5 — bottom line data support (printed as numbers; verdict in prose)
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("ANALYSIS 5 — SUPPORTING NUMBERS FOR VERDICT");
console.log("=".repeat(78));

// base-rate of intel subset for reference
const intelBase = successRate(INTEL);
console.log(`intel-subset base success-rate: ${pct(intelBase.rate)}% (${intelBase.s}/${intelBase.dec})  n=${INTEL.length}`);

// how thin does the qualified tail get at each intel cutoff (admit counts)
console.log("\nqualified-tail thickness by intel cutoff (of 137 intel-scored):");
for (const cut of [35, 45, 52, 60]) {
  const n = INTEL.filter((r) => r.intel_total >= cut).length;
  console.log(`  intel>=${cut}: ${n} pools admitted  (${(n / INTEL.length * 100).toFixed(0)}% of scored history)`);
}
console.log("\n(interpret rankAdmitCount against per-cycle candidate volume, not total history)");
console.log("\nDONE.");
