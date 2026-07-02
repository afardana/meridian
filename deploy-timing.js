/**
 * deploy-timing.js — Hour-of-day deploy-timing analytics (ADVISORY, Phase 1).
 *
 * Mines our OWN closed-position history for a time-of-day edge: are some UTC
 * blocks systematically better/worse to deploy in? Pure analytics — no writes,
 * no behavior change. Phase 1 surfaces an advisory line into the screener goal,
 * a /timing command, and a briefing line. A future Phase 2 may gate deploy size
 * on this (see docs/plans/01-deploy-timing.md).
 *
 * Source of truth: getAllPerformance() from lessons.js. Each closed record stores
 * the CLOSE time (recorded_at) + minutes_held, so the deploy time is derived as
 * recorded_at - minutes_held. Outcome uses classifyOutcome() verbatim, so "success"
 * is the same fee-death-aware objective the evolution engine uses (NOT pnl-sign).
 *
 * UTC throughout: Solana memecoin flow is global; US/Asia sessions matter more
 * than the VM's local clock.
 */

import { getAllPerformance, classifyOutcome } from "./lessons.js";
import { config } from "./config.js";

// Advisory turns on only once we have at least this many decisive (success+failure)
// closes — below it, per-block stats are pure noise.
const MIN_DECISIVE_FOR_ADVISORY = 40;

/** Wilson score lower bound (~95%) for a binomial proportion — penalizes small N. */
function wilsonLower(successes, n) {
  if (n <= 0) return 0;
  const z = 1.96;
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
}

/** Derive the UTC deploy timestamp (ms) for a perf record, or null if underivable. */
function deployTimeMs(rec) {
  const closeMs = Date.parse(rec?.recorded_at);
  const heldMin = Number(rec?.minutes_held);
  if (!Number.isFinite(closeMs) || !Number.isFinite(heldMin) || heldMin < 0) return null;
  return closeMs - heldMin * 60_000;
}

function isOorReason(reason) {
  const r = String(reason || "").toLowerCase();
  return r.includes("oor") || r.includes("out of range") || r.includes("below range") || r.includes("above range");
}

function blockLabel(hourStart, hourEnd) {
  const end = hourEnd % 24 || 24;
  return `${String(hourStart).padStart(2, "0")}-${String(end).padStart(2, "0")} UTC`;
}

/**
 * Analyze deploy timing over the last `window` closed positions.
 * @param {object} [opts]
 * @param {number} [opts.window=120]      how many recent closes to consider
 * @param {number} [opts.minBucketN=8]    decisive closes a block needs before it's "confident"
 * @param {number} [opts.bucketHours=4]   block width in hours (24 must divide evenly)
 * @param {object[]} [opts.records]       override source records (testing/Phase 2); defaults to getAllPerformance()
 */
export function analyzeDeployTiming({ window = 120, minBucketN = 8, bucketHours = 4, records = null } = {}) {
  const recent = (records || getAllPerformance()).slice(-window);
  const numBuckets = Math.max(1, Math.round(24 / bucketHours));

  const buckets = Array.from({ length: numBuckets }, (_, i) => ({
    hourStart: i * bucketHours,
    hourEnd: (i + 1) * bucketHours,
    label: blockLabel(i * bucketHours, (i + 1) * bucketHours),
    successes: 0, failures: 0, neutrals: 0,
    pnlSum: 0, pnlN: 0, oor: 0,
  }));

  let totalSucc = 0, totalFail = 0, skipped = 0;
  for (const rec of recent) {
    const t = deployTimeMs(rec);
    if (t == null) { skipped++; continue; }
    const hour = new Date(t).getUTCHours();
    const b = buckets[Math.floor(hour / bucketHours)];
    const outcome = classifyOutcome(rec);
    if (outcome === "success") { b.successes++; totalSucc++; }
    else if (outcome === "failure") { b.failures++; totalFail++; }
    else b.neutrals++;
    if (Number.isFinite(rec.pnl_pct)) { b.pnlSum += rec.pnl_pct; b.pnlN++; }
    if (isOorReason(rec.close_reason)) b.oor++;
  }

  const totalDecisive = totalSucc + totalFail;
  const baselineSuccessRate = totalDecisive > 0 ? totalSucc / totalDecisive : null;

  const out = buckets.map((b) => {
    const decisive = b.successes + b.failures;
    const total = decisive + b.neutrals;
    return {
      label: b.label,
      hourStart: b.hourStart,
      hourEnd: b.hourEnd,
      n: decisive,            // decisive closes drive the success rate
      total,                  // all closes incl. neutral (for OOR rate)
      successRate: decisive > 0 ? b.successes / decisive : null,
      wilsonLow: wilsonLower(b.successes, decisive),
      avgPnlPct: b.pnlN > 0 ? b.pnlSum / b.pnlN : null,
      oorRate: total > 0 ? b.oor / total : null,
      lowConfidence: decisive < minBucketN,
    };
  });

  const confident = out.filter((b) => !b.lowConfidence && b.successRate != null);
  const bestBucket = confident.length ? confident.reduce((a, b) => (b.wilsonLow > a.wilsonLow ? b : a)) : null;
  const worstBucket = confident.length ? confident.reduce((a, b) => (b.successRate < a.successRate ? b : a)) : null;

  const nowHour = new Date().getUTCHours();
  const currentBucket = out[Math.floor(nowHour / bucketHours)];

  return {
    enoughData: totalDecisive >= MIN_DECISIVE_FOR_ADVISORY,
    totalDecisive,
    skipped,
    baselineSuccessRate,
    bucketHours,
    minBucketN,
    buckets: out,
    currentBucket,
    bestBucket,
    worstBucket,
  };
}

const pct = (x) => (x == null ? "?" : `${Math.round(x * 100)}%`);

/**
 * One-line advisory for the screener goal. Returns null until there's enough data,
 * so the line never appears with misleading early stats.
 */
export function formatDeployTimingAdvisory(opts = {}) {
  const a = analyzeDeployTiming(opts);
  if (!a.enoughData) return null;
  const c = a.currentBucket;
  if (!c || c.successRate == null || c.lowConfidence) {
    return `DEPLOY TIMING (advisory): current ${c?.label || "block"} has only ${c?.n ?? 0} prior closes — no reliable read; treat as normal.`;
  }
  const delta = a.baselineSuccessRate != null ? c.successRate - a.baselineSuccessRate : 0;
  const verdict = delta >= 0.07 ? "above average — historically strong block"
    : delta <= -0.07 ? "below average — deploy only on strong conviction"
    : "near average";
  const oorStr = c.oorRate != null ? `, OOR ${pct(c.oorRate)}` : "";
  return `DEPLOY TIMING (advisory): current ${c.label} historically ${pct(c.successRate)} success over ${c.n} closes (baseline ${pct(a.baselineSuccessRate)}${oorStr}) — ${verdict}.`;
}

/** Compact one-liner for the daily briefing. Null until there's enough data. */
export function formatDeployTimingBriefing(opts = {}) {
  const a = analyzeDeployTiming(opts);
  if (!a.enoughData || !a.bestBucket || !a.worstBucket) return null;
  return `⏰ Best ${a.bestBucket.label} (${pct(a.bestBucket.successRate)}) · Worst ${a.worstBucket.label} (${pct(a.worstBucket.successRate)}) · Baseline ${pct(a.baselineSuccessRate)}`;
}

/**
 * Deploy-timing gate for the autonomous screener (plan #1 Phase 2). Returns whether the
 * CURRENT UTC block is "weak" (below the success floor with enough samples) and what to do.
 * Governed by config.timing; disabled → always a no-op. Manual deploys don't call this.
 * @returns {{ gated, action: "size_down"|"skip"|null, sizeMultiplier, reason, bucket }}
 */
/** Pure gate decision for a given current bucket + timing config (unit-testable). */
export function decideTimingGate(bucket, t = {}) {
  const noGate = { gated: false, action: null, sizeMultiplier: 1, reason: null, bucket: bucket || null };
  if (!t.gateEnabled) return noGate;
  if (!bucket || bucket.successRate == null || bucket.lowConfidence) return noGate; // block too thin to judge
  const floor = t.deadHourSuccessFloor ?? 0.20;
  if (bucket.successRate >= floor) return noGate;         // block is fine
  const reason = `current ${bucket.label} success ${pct(bucket.successRate)} < floor ${pct(floor)} over ${bucket.n} closes`;
  if (t.deadHourAction === "skip") return { gated: true, action: "skip", sizeMultiplier: 0, reason, bucket };
  return { gated: true, action: "size_down", sizeMultiplier: t.sizeDownPct ?? 0.5, reason, bucket };
}

export function getDeployTimingGate() {
  const t = config.timing || {};
  if (!t.gateEnabled) return { gated: false, action: null, sizeMultiplier: 1, reason: null, bucket: null };
  const a = analyzeDeployTiming({ minBucketN: t.minBucketN ?? 8 });
  if (!a.enoughData) return { gated: false, action: null, sizeMultiplier: 1, reason: null, bucket: a.currentBucket };
  return decideTimingGate(a.currentBucket, t);
}

/** Full bucket table for /timing (plain monospace-friendly text). */
export function formatDeployTimingReport(opts = {}) {
  const a = analyzeDeployTiming(opts);
  const lines = [];
  lines.push(`Deploy timing — ${a.totalDecisive} decisive closes, ${a.bucketHours}h UTC blocks${a.skipped ? ` (${a.skipped} skipped: no hold time)` : ""}`);
  if (!a.enoughData) {
    lines.push(`Advisory OFF — need ${MIN_DECISIVE_FOR_ADVISORY} decisive closes, have ${a.totalDecisive}.`);
  }
  if (a.baselineSuccessRate != null) lines.push(`Baseline success-rate: ${pct(a.baselineSuccessRate)}`);
  lines.push("");
  lines.push("block        n  succ  wilson  avgPnL   OOR");
  for (const b of a.buckets) {
    const sr = (b.successRate != null ? pct(b.successRate) : "—").padStart(4);
    const wl = pct(b.wilsonLow).padStart(6);
    const pnl = (b.avgPnlPct != null ? `${b.avgPnlPct >= 0 ? "+" : ""}${b.avgPnlPct.toFixed(1)}%` : "—").padStart(6);
    const oor = (b.oorRate != null ? pct(b.oorRate) : "—").padStart(4);
    const flag = b.lowConfidence ? " (low n)" : "";
    const marker = a.currentBucket && b.label === a.currentBucket.label ? " ←now" : "";
    lines.push(`${b.label}  ${String(b.n).padStart(3)}  ${sr}  ${wl}  ${pnl}  ${oor}${flag}${marker}`);
  }
  if (a.bestBucket) lines.push("", `Best:  ${a.bestBucket.label} — ${pct(a.bestBucket.successRate)} over ${a.bestBucket.n} closes`);
  if (a.worstBucket) lines.push(`Worst: ${a.worstBucket.label} — ${pct(a.worstBucket.successRate)} over ${a.worstBucket.n} closes`);
  return lines.join("\n");
}
