#!/usr/bin/env node
/**
 * safety_rebaseline.js — re-baseline the intel-score admission threshold for the
 * arrival of a REAL Safety sub-score.
 *
 * BACKGROUND
 *   The intel-score Safety dimension (scoreSafety in intel-score.js) has been pinned
 *   at its neutral 50 for ALL of Meteora-path history — its inputs (mint/freeze
 *   renouncement, holder concentration, bundler/bot pct, dev hold) were never fetched,
 *   so every recorded signal_snapshot.intel_safety === 50. The admission floor
 *   minIntelScore / rankMinIntelScore = 52 was calibrated by scripts/rank_admission_backtest.js
 *   in that Safety≡50 world. Turning on real Safety values shifts the intel_total
 *   distribution, so the floor must move with it or admission silently loosens/tightens.
 *
 *   This script reconstructs a DEFENSIBLE deploy-time Safety per closed position from
 *   CURRENT public Jupiter audit data, rebases each record's intel_total with it, and
 *   re-runs the knee analysis to recommend a new minIntelScore — with a three-assumption
 *   sensitivity band and an explicit honesty model for what current data can and cannot
 *   tell us about deploy-time state.
 *
 * HONESTY MODEL (per the reconstruction)
 *   - Mint/freeze authority renouncement is ONE-WAY (irreversible):
 *       * currently-NOT-renounced  ⇒ it was NOT renounced at deploy either  (CERTAIN)
 *       * currently-renounced      ⇒ deploy-time was renounced OR not-yet    (UPPER BOUND —
 *                                    crediting it may overstate deploy-time safety)
 *   - Holder concentration / bundler / bot pct DRIFT over time, and for rugged/dead
 *     tokens their current values are meaningless. Used only for ALIVE tokens, flagged
 *     low-confidence.
 *   - dev_team_hold pct is not exposed by the public Jupiter endpoint ⇒ always neutral.
 *
 * THREE RECONSTRUCTION ASSUMPTIONS (sensitivity band)
 *   R1 renouncement-only          : credit/penalize mint+freeze from current flags
 *                                   (upper-bound credit); concentration left neutral.
 *   R2 +alive concentration       : R1 plus current top10/bot/bundler folded in for
 *                                   tokens classified ALIVE (best estimate).
 *   R3 worst-case (certain-only)  : apply ONLY the certain penalties (confirmed
 *                                   not-renounced ⇒ 0); do NOT credit renounced
 *                                   upper-bounds, concentration neutral. Pessimistic bound.
 *
 * Safety is computed through the REAL scoreSafety code (via computeIntelScore().safety) —
 * we build a candidate carrying only the Safety-relevant fields and read the sub-score.
 * Rebased total:  intel_total_rebased = recorded_intel_total − W_SAFETY×50 + W_SAFETY×Safety_recon
 * (W_SAFETY verified = 0.30 both from config.js defaults and by reconciling the recorded
 * sub-scores against the recorded intel_total — see WEIGHT verification printout.)
 *
 * Outcome labelling is a verbatim port of lessons.js classifyOutcome (as in the backtest).
 *
 * READ-ONLY. Network: ~60 sequential Jupiter GETs (~200ms spacing), cached to scratchpad
 * so re-runs don't refetch. No repo imports beyond intel-score.js.
 *
 * Usage:  node scripts/safety_rebaseline.js [path-to-perf-dump.json]
 *         (run from the repo root so intel-score.js → config.js resolves user-config.json)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeIntelScore } from "../intel-score.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DUMP =
  "/private/tmp/claude-501/-Users-Angga-Repos-meridian/03f6f1dd-490c-47e6-91c8-a608813826a5/scratchpad/perf-dump.json";
const DUMP_PATH = process.argv[2] || DEFAULT_DUMP;
const CACHE_PATH =
  "/private/tmp/claude-501/-Users-Angga-Repos-meridian/03f6f1dd-490c-47e6-91c8-a608813826a5/scratchpad/safety-audit-cache.json";

const W_SAFETY = 0.30; // verified below
const NEUTRAL_SAFETY = 50; // scoreSafety() on an empty candidate
const DATAPI = "https://datapi.jup.ag/v1";

const RECS = JSON.parse(fs.readFileSync(DUMP_PATH, "utf8"));

// ─── stats helpers (ported from rank_admission_backtest.js) ──────────────────
const isFiniteNum = (x) => typeof x === "number" && Number.isFinite(x);
const pct = (x) => (x == null ? "  -- " : (x * 100).toFixed(1).padStart(5));
const f2 = (x) => (x == null || !Number.isFinite(x) ? "  --" : x.toFixed(2));

function wilson(k, n, z = 1.96) {
  if (n === 0) return [null, null];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

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
  let nu = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    nu += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : nu / den;
}
function rhoSig(rho, n) {
  if (rho == null || n < 2) return "";
  return Math.abs(rho) > 1.96 / Math.sqrt(n - 1) ? "*" : " ";
}

// ─── GROUND TRUTH — verbatim port of lessons.js classifyOutcome ──────────────
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
function successRate(recs) {
  let s = 0, f = 0;
  for (const r of recs) {
    const c = r.cls || classifyOutcome(r);
    if (c === "success") s++; else if (c === "failure") f++;
  }
  const dec = s + f;
  return { s, f, dec, rate: dec > 0 ? s / dec : null };
}

// ─── WEIGHT verification (belt & suspenders) ─────────────────────────────────
function verifyWeights() {
  const W = { safety: 0.30, yield: 0.35, momentum: 0.20, trust: 0.15 };
  let maxErr = 0, n = 0;
  for (const r of RECS) {
    const s = r.signal_snapshot;
    if (!s || !isFiniteNum(s.intel_total)) continue;
    const recon = W.safety * s.intel_safety + W.yield * s.intel_yield +
                  W.momentum * s.intel_momentum + W.trust * s.intel_trust;
    maxErr = Math.max(maxErr, Math.abs(recon - s.intel_total));
    n++;
  }
  return { maxErr, n };
}

// ─── Jupiter fetch + cache ───────────────────────────────────────────────────
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); } catch { return {}; }
}
function saveCache(c) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAudit(mint) {
  try {
    const res = await fetch(`${DATAPI}/assets/search?query=${mint}`);
    if (!res.ok) return { ok: false, status: res.status, mint };
    const data = await res.json();
    const arr = Array.isArray(data) ? data : [data];
    const t = arr.find((x) => x && x.id === mint) || arr[0];
    if (!t || !t.id) return { ok: false, status: "not_found", mint };
    return {
      ok: true,
      mint,
      id: t.id,
      symbol: t.symbol,
      mcap: t.mcap ?? null,
      liquidity: t.liquidity ?? null,
      holderCount: t.holderCount ?? null,
      price: t.usdPrice ?? null,
      organicScore: t.organicScore ?? null,
      audit: t.audit ? {
        mintAuthorityDisabled: t.audit.mintAuthorityDisabled ?? null,
        freezeAuthorityDisabled: t.audit.freezeAuthorityDisabled ?? null,
        topHoldersPercentage: t.audit.topHoldersPercentage ?? null,
        botHoldersPercentage: t.audit.botHoldersPercentage ?? null,
        bundlerHoldingPct: t.audit.bundlerStats?.holdingPct ?? null,
      } : null,
    };
  } catch (e) {
    return { ok: false, status: `error:${e.message}`, mint };
  }
}

async function fetchAll(mints) {
  const cache = loadCache();
  let fetched = 0;
  for (const mint of mints) {
    if (cache[mint]) continue;
    cache[mint] = await fetchAudit(mint);
    fetched++;
    if (fetched % 10 === 0) { saveCache(cache); process.stderr.write(`  fetched ${fetched}...\n`); }
    await sleep(220);
  }
  saveCache(cache);
  return { cache, fetched };
}

// ─── alive/dead classification ───────────────────────────────────────────────
// DEAD/DELISTED: fetch failed or token gone. RUGGED/DYING: alive-ish but liquidity or
// holders collapsed → current concentration unreliable. ALIVE: liquidity healthy.
function classifyLife(a) {
  if (!a || !a.ok) return "dead";
  const liq = a.liquidity;
  const hold = a.holderCount;
  if (liq == null || liq < 1000) return "rugged";
  if (hold != null && hold < 50) return "rugged";
  return "alive";
}

// ─── Safety reconstruction under an assumption ───────────────────────────────
// Returns the scoreSafety sub-score via the REAL intel-score code, and a confidence tag.
function reconstructSafety(a, life, mode) {
  // mode: "R1" | "R2" | "R3"
  // Build a candidate carrying only Safety-relevant fields; omit ⇒ neutral component.
  const cand = { audit: {} };
  let conf; // "cert-only" | "renounce-upper" | "renounce+conc" | "none"

  const au = a && a.ok ? a.audit : null;
  const mintDis = au ? au.mintAuthorityDisabled : null;
  const frzDis = au ? au.freezeAuthorityDisabled : null;

  if (mode === "R3") {
    // worst-case / certain-only: penalize confirmed not-renounced; do NOT credit
    // renounced upper-bounds; concentration neutral.
    if (mintDis === false) cand.audit.mint_disabled = false; // certain penalty
    // mintDis === true (renounced now) ⇒ upper bound only ⇒ leave neutral (omit)
    if (frzDis === false) cand.audit.freeze_disabled = false;
    conf = (mintDis === false || frzDis === false) ? "cert-only" : "none";
  } else {
    // R1 & R2: apply renouncement in both directions (credit is an upper bound).
    if (mintDis != null) cand.audit.mint_disabled = !!mintDis;
    if (frzDis != null) cand.audit.freeze_disabled = !!frzDis;
    conf = (mintDis != null || frzDis != null) ? "renounce-upper" : "none";

    if (mode === "R2" && life === "alive" && au) {
      // fold in current concentration for ALIVE tokens only (low-confidence proxy)
      if (isFiniteNum(au.topHoldersPercentage)) cand.audit.top_holders_pct = au.topHoldersPercentage;
      if (isFiniteNum(au.botHoldersPercentage)) cand.audit.bot_holders_pct = au.botHoldersPercentage;
      if (isFiniteNum(au.bundlerHoldingPct)) cand.gmgn_bundler_pct = au.bundlerHoldingPct;
      if (au.topHoldersPercentage != null || au.botHoldersPercentage != null || au.bundlerHoldingPct != null)
        conf = "renounce+conc";
    }
  }
  const safety = computeIntelScore(cand).safety;
  return { safety, conf };
}

// ─── feature extraction per record (mirrors backtest.feat) ───────────────────
function feat(r) {
  const s = r.signal_snapshot || {};
  return {
    base_mint: r.base_mint || s.base_mint || null,
    intel_total: isFiniteNum(s.intel_total) ? s.intel_total : null,
    pnl_pct: isFiniteNum(r.pnl_pct) ? r.pnl_pct : null,
    cls: classifyOutcome(r),
    recorded_at: r.recorded_at,
  };
}

function percentiles(vals, ps = [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const s = [...vals].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
  return ps.map(q);
}
function mean(vals) { return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; }

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  console.log("=".repeat(80));
  console.log("SAFETY RE-BASELINE  —  re-calibrating minIntelScore for real Safety enrichment");
  console.log("=".repeat(80));

  const wv = verifyWeights();
  console.log(`\nWEIGHT verification: recorded sub-scores reconstruct intel_total within ` +
    `max abs err ${wv.maxErr.toFixed(4)} over ${wv.n} records using W={s:0.30,y:0.35,m:0.20,t:0.15}.`);
  console.log(`  ⇒ W_SAFETY = ${W_SAFETY} confirmed (also config.js default). Neutral Safety = ${NEUTRAL_SAFETY}.`);
  const badSafety = RECS.filter((r) => r.signal_snapshot && isFiniteNum(r.signal_snapshot.intel_total) &&
    r.signal_snapshot.intel_safety !== 50).length;
  console.log(`  recorded intel_safety !== 50 count: ${badSafety}  (expect 0 — Safety was pinned neutral)`);

  // unique mints across ALL records (fetch coverage), then intel-scored subset for analysis
  const allMints = [...new Set(RECS.map((r) => r.base_mint).filter(Boolean))];
  console.log(`\nrecords: ${RECS.length}   intel-scored: ${RECS.filter((r) => r.signal_snapshot && isFiniteNum(r.signal_snapshot.intel_total)).length}   unique base_mints: ${allMints.length}`);

  console.log(`\nfetching current Jupiter audit for ${allMints.length} mints (cached; ~220ms spacing)...`);
  const { cache, fetched } = await fetchAll(allMints);
  console.log(`  network fetches this run: ${fetched}  (rest served from cache)`);

  // fetch coverage + life classification
  const life = {}; // mint -> "alive"|"rugged"|"dead"
  let okN = 0, deadN = 0, errN = 0;
  const errStatuses = {};
  for (const m of allMints) {
    const a = cache[m];
    const l = classifyLife(a);
    life[m] = l;
    if (a && a.ok) okN++;
    else { deadN++; if (a) errStatuses[a.status] = (errStatuses[a.status] || 0) + 1; else errN++; }
  }
  const lifeCounts = { alive: 0, rugged: 0, dead: 0 };
  for (const m of allMints) lifeCounts[life[m]]++;
  console.log("\n" + "─".repeat(80));
  console.log("FETCH COVERAGE");
  console.log("─".repeat(80));
  console.log(`  fetched ok: ${okN}   not-found/error: ${deadN}   (thrown errors: ${errN})`);
  console.log(`  fetch-fail statuses: ${JSON.stringify(errStatuses)}`);
  console.log(`  life classification (of ${allMints.length} mints):  alive=${lifeCounts.alive}  rugged/dying=${lifeCounts.rugged}  dead/delisted=${lifeCounts.dead}`);

  // ── per-record rebased intel under each assumption ──
  const MODES = ["R1", "R2", "R3"];
  const MODE_LABEL = {
    R1: "renouncement-only",
    R2: "+alive concentration",
    R3: "worst-case (certain-only)",
  };

  const rows = [];
  const confCount = { R1: {}, R2: {}, R3: {} };
  for (const r of RECS) {
    const fr = feat(r);
    if (fr.intel_total == null || !fr.base_mint) continue; // need baseline to rebase
    const a = cache[fr.base_mint];
    const l = life[fr.base_mint] || "dead";
    const rebased = {};
    const safetyVals = {};
    for (const mode of MODES) {
      const { safety, conf } = reconstructSafety(a, l, mode);
      rebased[mode] = fr.intel_total - W_SAFETY * NEUTRAL_SAFETY + W_SAFETY * safety;
      safetyVals[mode] = safety;
      confCount[mode][conf] = (confCount[mode][conf] || 0) + 1;
    }
    rows.push({ ...fr, life: l, rebased, safety: safetyVals });
  }
  const N = rows.length;
  console.log(`\nrebasable records (intel-scored w/ mint): ${N}`);

  console.log("\n" + "─".repeat(80));
  console.log("RECONSTRUCTION CONFIDENCE BREAKDOWN  (per assumption, count of records)");
  console.log("─".repeat(80));
  for (const mode of MODES) {
    const c = confCount[mode];
    console.log(`  ${mode} ${MODE_LABEL[mode].padEnd(26)} ${JSON.stringify(c)}`);
  }
  console.log("  legend: renounce-upper=mint/freeze credited (upper bound); renounce+conc=+current concentration;");
  console.log("          cert-only=only confirmed-not-renounced penalties applied; none=no audit ⇒ Safety stays 50.");

  // ── (a) distribution shift ──
  console.log("\n" + "=".repeat(80));
  console.log("(a) DISTRIBUTION SHIFT — intel_total percentiles: recorded (Safety≡50) vs rebased");
  console.log("=".repeat(80));
  const oldVals = rows.map((r) => r.intel_total);
  const [op10, op25, op50, op75, op90] = percentiles(oldVals);
  console.log("  series                         p10    p25    p50    p75    p90    mean");
  console.log(`  recorded (Safety=50)         ${[op10, op25, op50, op75, op90].map((v) => f2(v).padStart(6)).join(" ")}  ${f2(mean(oldVals))}`);
  for (const mode of MODES) {
    const v = rows.map((r) => r.rebased[mode]);
    const [p10, p25, p50, p75, p90] = percentiles(v);
    console.log(`  rebased ${mode} ${MODE_LABEL[mode].padEnd(22)} ${[p10, p25, p50, p75, p90].map((x) => f2(x).padStart(6)).join(" ")}  ${f2(mean(v))}`);
  }
  for (const mode of MODES) {
    const v = rows.map((r) => r.rebased[mode]);
    console.log(`  Δmedian ${mode}: ${(percentiles(v)[2] - op50 >= 0 ? "+" : "")}${f2(percentiles(v)[2] - op50)}   Δmean: ${(mean(v) - mean(oldVals) >= 0 ? "+" : "")}${f2(mean(v) - mean(oldVals))}   Δsafety-median: ${(mean(rows.map(r=>r.safety[mode])) - 50 >= 0 ? "+" : "")}${f2(mean(rows.map(r=>r.safety[mode])) - 50)} (mean)`);
  }

  // ── reference: old-52 on recorded intel ──
  function cutStats(vals, cut, clsList) {
    // admit vals>=cut; return admit-n, admit-frac, blocked succ/fail, admitted succ-rate
    const admitted = [], blocked = [];
    for (let i = 0; i < vals.length; i++) (vals[i] >= cut ? admitted : blocked).push(rows[i]);
    const totSucc = rows.filter((r) => r.cls === "success").length;
    const totFail = rows.filter((r) => r.cls === "failure").length;
    const blkSucc = blocked.filter((r) => r.cls === "success").length;
    const blkFail = blocked.filter((r) => r.cls === "failure").length;
    const sr = successRate(admitted);
    return {
      cut, admitN: admitted.length, admitFrac: admitted.length / vals.length,
      failBlockedFrac: totFail ? blkFail / totFail : null,
      winnerKeptFrac: totSucc ? (totSucc - blkSucc) / totSucc : null,
      admittedSuccRate: sr.rate, s: sr.s, f: sr.f, dec: sr.dec,
    };
  }

  const OLD_CUT = 52;
  const oldRef = cutStats(oldVals, OLD_CUT);
  console.log("\n" + "=".repeat(80));
  console.log(`REFERENCE — old floor intel_total>=${OLD_CUT} on RECORDED (Safety≡50) scores`);
  console.log("=".repeat(80));
  const [olo, ohi] = wilson(oldRef.s, oldRef.dec);
  console.log(`  admit-n=${oldRef.admitN} (${(oldRef.admitFrac * 100).toFixed(1)}%)   failure-blocked=${pct(oldRef.failBlockedFrac)}%   winner-kept=${pct(oldRef.winnerKeptFrac)}%   admitted succ-rate=${pct(oldRef.admittedSuccRate)}% (${oldRef.s}/${oldRef.dec}) [${pct(olo)},${pct(ohi)}]`);
  console.log("  ⇒ equivalence anchors for the rebased floor: match ADMISSION-FRAC (don't loosen/tighten volume)");
  console.log("    and/or FAILURE-BLOCKED (preserve the safety function).");

  // ── (b)+(c) knee sweep 45..65 on rebased, per assumption ──
  console.log("\n" + "=".repeat(80));
  console.log("(b)/(c) KNEE SWEEP on REBASED intel  — cutoffs 45..65, per assumption");
  console.log("=".repeat(80));
  const recommend = {};
  for (const mode of MODES) {
    const vals = rows.map((r) => r.rebased[mode]);
    console.log(`\n  ── ${mode} ${MODE_LABEL[mode]} ──`);
    console.log("   cutoff  admit-n  admit%  fail-blocked  winner-kept  admit-succ%  [Wilson95]");
    let bestFracCut = null, bestFracDiff = Infinity;   // matches old admission-frac
    let bestFailCut = null, bestFailDiff = Infinity;   // matches old failure-blocked
    for (let cut = 45; cut <= 65; cut += 1) {
      const st = cutStats(vals, cut);
      const [lo, hi] = wilson(st.s, st.dec);
      const mark =
        (cut === OLD_CUT ? " <old" : "") ;
      console.log(
        `   ${String(cut).padStart(4)}    ${String(st.admitN).padStart(5)}   ${(st.admitFrac * 100).toFixed(0).padStart(4)}%   ` +
        `${pct(st.failBlockedFrac)}%      ${pct(st.winnerKeptFrac)}%     ${pct(st.admittedSuccRate)}% (${st.s}/${st.dec})  [${pct(lo)},${pct(hi)}]${mark}`
      );
      const fracDiff = Math.abs(st.admitFrac - oldRef.admitFrac);
      if (fracDiff < bestFracDiff) { bestFracDiff = fracDiff; bestFracCut = cut; }
      if (oldRef.failBlockedFrac != null && st.failBlockedFrac != null) {
        const fd = Math.abs(st.failBlockedFrac - oldRef.failBlockedFrac);
        if (fd < bestFailDiff) { bestFailDiff = fd; bestFailCut = cut; }
      }
    }
    recommend[mode] = { fracCut: bestFracCut, failCut: bestFailCut };
    console.log(`   → admission-frac-preserving cutoff ≈ ${bestFracCut}   |   failure-blocked-preserving cutoff ≈ ${bestFailCut}`);
  }

  console.log("\n" + "=".repeat(80));
  console.log("RECOMMENDED NEW minIntelScore — sensitivity across assumptions");
  console.log("=".repeat(80));
  console.log("  assumption                    admission-frac match   failure-blocked match");
  for (const mode of MODES) {
    console.log(`  ${mode} ${MODE_LABEL[mode].padEnd(26)}   ${String(recommend[mode].fracCut).padStart(6)}                 ${String(recommend[mode].failCut).padStart(6)}`);
  }
  const fracCuts = MODES.map((m) => recommend[m].fracCut);
  console.log(`\n  admission-preserving range across assumptions: ${Math.min(...fracCuts)}..${Math.max(...fracCuts)}  (old=${OLD_CUT})`);

  // ── (d) does reconstructed Safety discriminate outcomes among admitted pools? ──
  console.log("\n" + "=".repeat(80));
  console.log("(d) DOES RECONSTRUCTED SAFETY CARRY OUTCOME SIGNAL?  (Safety quartiles → succ-rate)");
  console.log("=".repeat(80));
  console.log("  (Using R2 best-estimate Safety. If flat ⇒ Safety is a rug-FILTER, not an outcome-RANKER among admitted pools.)");
  const safeVals = rows.map((r) => r.safety.R2);
  const sSorted = [...safeVals].sort((a, b) => a - b);
  const sq = (p) => sSorted[Math.min(sSorted.length - 1, Math.floor(p * sSorted.length))];
  const [q1, q2, q3] = [sq(0.25), sq(0.5), sq(0.75)];
  const bOf = (v) => (v <= q1 ? 0 : v <= q2 ? 1 : v <= q3 ? 2 : 3);
  const buckets = [[], [], [], []];
  rows.forEach((r) => buckets[bOf(r.safety.R2)].push(r));
  console.log(`  Safety(R2) quartile cuts: ${f2(q1)} / ${f2(q2)} / ${f2(q3)}   (note: heavy ties collapse buckets)`);
  console.log("  bucket        n   succ  fail  neut  succ-rate  [Wilson95]      mean_pnl%");
  const bl = ["Q1(low) ", "Q2      ", "Q3      ", "Q4(high)"];
  buckets.forEach((b, i) => {
    const sr = successRate(b);
    const [lo, hi] = wilson(sr.s, sr.dec);
    const mp = mean(b.map((r) => r.pnl_pct || 0));
    console.log(`  ${bl[i]}  ${String(b.length).padStart(3)}  ${String(sr.s).padStart(4)}  ${String(sr.f).padStart(4)}  ${String(b.length - sr.dec).padStart(4)}  ${pct(sr.rate)}%    [${pct(lo)},${pct(hi)}]   ${f2(mp)}`);
  });
  const dec = rows.filter((r) => r.cls !== "neutral");
  const rhoBin = spearman(dec.map((r) => r.safety.R2), dec.map((r) => (r.cls === "success" ? 1 : 0)));
  const rhoPnl = spearman(rows.map((r) => r.safety.R2), rows.map((r) => r.pnl_pct || 0));
  console.log(`  Spearman Safety(R2) vs success(binary,n=${dec.length}) = ${f2(rhoBin)}${rhoSig(rhoBin, dec.length)}   vs pnl_pct(n=${rows.length}) = ${f2(rhoPnl)}${rhoSig(rhoPnl, rows.length)}`);

  console.log("\n" + "=".repeat(80));
  console.log("CAVEATS");
  console.log("=".repeat(80));
  console.log("  • SURVIVORSHIP: history holds only deploys that passed the then-live gates; below-floor");
  console.log("    counterfactuals are unanswerable. Range-restriction on Safety inputs too.");
  console.log("  • CURRENT-vs-DEPLOY DRIFT: renouncement credit is an UPPER BOUND (one-way); concentration/");
  console.log("    bundler/bot are current snapshots, only used for ALIVE tokens (low confidence).");
  console.log("  • DEAD/RUGGED tokens can't be re-audited ⇒ their Safety stays neutral (50) under R1/R3 and");
  console.log("    renouncement-only under R2 — so the true deploy-time Safety of the worst outcomes is the");
  console.log("    least reconstructable exactly where it would matter most (conservative bias in the shift).");
  console.log(`  • n is small (${N} rebasable, ${dec.length} decisive); treat the recommended cutoff as a band, not a point.`);
  console.log("  • dev_team_hold pct is never available from the public endpoint ⇒ permanently neutral component.");
  console.log("\nDONE.");
})();
