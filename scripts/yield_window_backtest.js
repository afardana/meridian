/**
 * yield_window_backtest.js — does a window-aware intel Yield (plan #12 Phase 2) change
 * outcome discrimination or only the admission gate? READ-ONLY analysis, no side effects.
 *
 * Usage: node scripts/yield_window_backtest.js <perf-dump.json> [--tf=60]
 *
 * The legacy scoreYield normalizers (fee_active_tvl_ratio ÷ 2.0 → 0-40 pts,
 * volume/tvl ÷ 5.0 → 0-25 pts) are 24h-window thresholds applied to fields windowed by
 * config.screening.timeframe (1h in prod). "log" mode (intel-score.js) maps the
 * 24h-equivalent rate on a log scale between 1%/day (0 pts) and 48%/day (40 pts), and
 * turnover between 0.2× and 120× TVL/day (0-25 pts).
 *
 * Perf records keep intel_yield/intel_total and the deploy-time fee_tvl_ratio,
 * entry_volume, entry_tvl — but NOT active_tvl / fee_change_pct. So the two re-windowed
 * components are recomputed and the other two are carried as a residual:
 *   residual   = intel_yield − legacyFee(fee_tvl_ratio) − legacyVol(volume/tvl)
 *   yield_log  = residual + logFee + logVol
 *   total_log  = intel_total + w_yield × (yield_log − intel_yield)   (weights linear)
 * Assumes every record's windowed fields are 1h (config backups show 1h since ≥07-12;
 * the pre-07-12 era is reported separately as a sensitivity split).
 *
 * Ground-truth label = lessons.js classifyOutcome (same port as rank_admission_backtest.js).
 */
import fs from "fs";

const args = process.argv.slice(2);
const dumpPath = args.find((a) => !a.startsWith("--"));
if (!dumpPath) { console.error("usage: node scripts/yield_window_backtest.js <perf-dump.json> [--tf=60]"); process.exit(1); }
const TF_MIN = Number((args.find((a) => a.startsWith("--tf=")) || "--tf=60").slice(5)) || 60;
const TO_DAY = 1440 / TF_MIN;
const W_YIELD = 0.35; // prod intelWeights (0.30/0.35/0.20/0.15, sum 1.0)
const OLD_BAR = 52;

const RECS = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const logScale = (x, floor, cap) => (x > 0 ? clamp(Math.log(x / floor) / Math.log(cap / floor), 0, 1) : 0);
const legacyFee = (fee) => (fee == null ? 20 : clamp(fee / 2.0, 0, 1) * 40);
const legacyVol = (vol, tvl) => (tvl > 0 && vol > 0 ? clamp((vol / tvl) / 5.0, 0, 1) * 25 : 12.5);
const logFee = (fee) => (fee == null ? 20 : logScale(fee * TO_DAY, 1.0, 48.0) * 40);
const logVol = (vol, tvl) => (tvl > 0 && vol > 0 ? logScale((vol / tvl) * TO_DAY, 0.2, 120.0) * 25 : 12.5);

// ── ground truth (verbatim port of lessons.classifyOutcome) ──
function classifyOutcome(perf) {
  const pnl = isNum(perf?.pnl_pct) ? perf.pnl_pct : null;
  if (pnl == null) return "neutral";
  const feeYield = perf.initial_value_usd > 0 ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100 : 0;
  const reason = String(perf.close_reason || "").toLowerCase();
  const isFeeDeath = reason.includes("yield");
  const isStopLoss = reason.includes("stop loss");
  const isOorCollapse = (reason.includes("oor") || reason.includes("out of range") || reason.includes("below")) && pnl < 0;
  const rangeEff = isNum(perf.range_efficiency) ? perf.range_efficiency : 100;
  if (isStopLoss || pnl <= -5 || (isOorCollapse && pnl <= -2)) return "failure";
  if (isFeeDeath && pnl < 1) return "failure";
  if (!isFeeDeath && (pnl >= 2 || feeYield >= 2)) return "success";
  if (rangeEff < 50 && pnl < 1) return "failure";
  return "neutral";
}

// ── stats ──
function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
function spearman(xs, ys) {
  const n = xs.length; if (n < 4) return null;
  const rank = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(n); let i = 0;
    while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; };
  const rx = rank(xs), ry = rank(ys); const mx = rx.reduce((a, b) => a + b) / n, my = ry.reduce((a, b) => a + b) / n;
  let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}
const pct = (x) => (x == null ? " --" : (x * 100).toFixed(1).padStart(5));
const f1 = (x) => (x == null ? "--" : x.toFixed(1));

// ── features ──
const ROWS = RECS.map((r) => {
  const s = r.signal_snapshot || {};
  const fee = isNum(r.fee_tvl_ratio) ? r.fee_tvl_ratio : null;
  const vol = isNum(r.entry_volume) ? r.entry_volume : (isNum(s.volume) ? s.volume : null);
  const tvl = isNum(r.entry_tvl) ? r.entry_tvl : null;
  const y0 = isNum(s.intel_yield) ? s.intel_yield : null;
  const t0 = isNum(s.intel_total) ? s.intel_total : null;
  if (y0 == null || t0 == null || fee == null) return null;
  const lf = legacyFee(fee), lv = legacyVol(vol, tvl);
  const residual = y0 - lf - lv;
  const y1 = clamp(residual + logFee(fee) + logVol(vol, tvl), 0, 100);
  const t1 = t0 + W_YIELD * (y1 - y0);
  const enrichedDelta = isNum(s.intel_total_enriched) ? s.intel_total_enriched - t0 : null;
  return {
    name: r.pool_name, at: r.recorded_at, cls: classifyOutcome(r), pnl: r.pnl_pct,
    fee, volTvl: tvl > 0 && vol != null ? vol / tvl : null, tvl,
    y0, y1, t0, t1, t1e: enrichedDelta != null ? t1 + enrichedDelta : null, t0e: isNum(s.intel_total_enriched) ? s.intel_total_enriched : null,
    era: String(r.recorded_at || "") >= "2026-07-12" ? "post0712" : "pre0712",
    manual: r.strategy === "manual" || r.adopted === true,
  };
}).filter(Boolean);

console.log(`records: ${RECS.length}  usable (intel_yield+intel_total+fee_tvl_ratio): ${ROWS.length}  tf=${TF_MIN}m  (toDay ×${TO_DAY})`);
const dist = (arr) => arr.reduce((g, r) => { g[r.cls]++; return g; }, { success: 0, failure: 0, neutral: 0 });
console.log("labels:", JSON.stringify(dist(ROWS)));

// ── 1) component shift ──
const med = (xs) => { const a = xs.filter(isNum).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
console.log(`\nmedian fee_tvl_ratio(window)=${f1(med(ROWS.map((r) => r.fee)))}  → 24h-equiv ${f1(med(ROWS.map((r) => r.fee * TO_DAY)))}%/day ;  median vol/tvl=${(med(ROWS.map((r) => r.volTvl)) ?? 0).toFixed(3)}`);
console.log(`median intel_yield legacy=${f1(med(ROWS.map((r) => r.y0)))}  log=${f1(med(ROWS.map((r) => r.y1)))}   | intel_total legacy=${f1(med(ROWS.map((r) => r.t0)))}  log=${f1(med(ROWS.map((r) => r.t1)))}`);
const sat = (xs, cap) => xs.filter((x) => x >= cap - 1e-9).length;
console.log(`fee component saturated (40 pts): legacy ${sat(ROWS.map((r) => legacyFee(r.fee)), 40)}/${ROWS.length}   log ${sat(ROWS.map((r) => logFee(r.fee)), 40)}/${ROWS.length}`);

// ── 2) discrimination (rank-preservation check) ──
const dec = ROWS.filter((r) => r.cls !== "neutral");
const bin = dec.map((r) => (r.cls === "success" ? 1 : 0));
console.log(`\nSpearman vs success (decisive n=${dec.length}):  yield legacy ${f1(spearman(dec.map((r) => r.y0), bin))}  log ${f1(spearman(dec.map((r) => r.y1), bin))}   | total legacy ${f1(spearman(dec.map((r) => r.t0), bin))}  log ${f1(spearman(dec.map((r) => r.t1), bin))}`);
console.log(`Spearman(total legacy, total log) = ${f1(spearman(ROWS.map((r) => r.t0), ROWS.map((r) => r.t1)))}  (1.0 = pure re-scaling, ordering unchanged)`);
function quartiles(key, label) {
  const a = [...ROWS].sort((p, q) => p[key] - q[key]); const n = a.length; const out = [];
  for (let q = 0; q < 4; q++) { const b = a.slice(Math.floor((q * n) / 4), Math.floor(((q + 1) * n) / 4)); const d = b.filter((r) => r.cls !== "neutral"); const s = d.filter((r) => r.cls === "success").length;
    const [lo, hi] = wilson(s, d.length); out.push(`Q${q + 1}[${f1(b[0]?.[key])}..${f1(b[b.length - 1]?.[key])}] succ ${pct(d.length ? s / d.length : null)}% [${pct(lo)},${pct(hi)}] mean_pnl ${f1(b.reduce((x, r) => x + (r.pnl || 0), 0) / b.length)}`); }
  console.log(`${label}:\n  ` + out.join("\n  "));
}
quartiles("t0", "\nintel_total LEGACY quartiles → success-rate");
quartiles("t1", "intel_total LOG quartiles → success-rate");

// ── 3) the gate: admission-preserving cutoff under log mode ──
function gateTable(key, label, bars) {
  const succ = ROWS.filter((r) => r.cls === "success").length, fail = ROWS.filter((r) => r.cls === "failure").length;
  console.log(`\n${label}  (pool: ${succ} successes / ${fail} failures / ${ROWS.length} total)`);
  console.log("  bar  admit-n admit%  fail-blocked winner-kept admitted-succ% [Wilson95]");
  for (const bar of bars) {
    const adm = ROWS.filter((r) => r[key] >= bar); const d = adm.filter((r) => r.cls !== "neutral"); const s = d.filter((r) => r.cls === "success").length;
    const fb = 1 - adm.filter((r) => r.cls === "failure").length / Math.max(1, fail); const wk = adm.filter((r) => r.cls === "success").length / Math.max(1, succ);
    const [lo, hi] = wilson(s, d.length);
    console.log(`  ${String(bar).padStart(3)}  ${String(adm.length).padStart(6)}  ${pct(adm.length / ROWS.length)}%   ${pct(fb)}%     ${pct(wk)}%      ${pct(d.length ? s / d.length : null)}% (${s}/${d.length}) [${pct(lo)},${pct(hi)}]`);
  }
}
const bars = Array.from({ length: 21 }, (_, i) => 45 + i);
gateTable("t0", "LEGACY total vs bar", [50, 52, 54, 56, 58]);
gateTable("t1", "LOG total vs bar", bars);
const admitLegacy = ROWS.filter((r) => r.t0 >= OLD_BAR).length / ROWS.length;
const fbLegacy = 1 - ROWS.filter((r) => r.t0 >= OLD_BAR && r.cls === "failure").length / Math.max(1, ROWS.filter((r) => r.cls === "failure").length);
let matchAdmit = null, matchFb = null;
for (const bar of bars) {
  const adm = ROWS.filter((r) => r.t1 >= bar);
  if (matchAdmit == null && adm.length / ROWS.length <= admitLegacy) matchAdmit = bar;
  const fb = 1 - adm.filter((r) => r.cls === "failure").length / Math.max(1, ROWS.filter((r) => r.cls === "failure").length);
  if (matchFb == null && fb >= fbLegacy) matchFb = bar;
}
console.log(`\n→ legacy@${OLD_BAR}: admit ${pct(admitLegacy)}%, failure-blocked ${pct(fbLegacy)}%.  LOG-mode bar preserving admission ≈ ${matchAdmit}, preserving failure-blocked ≈ ${matchFb}`);

// ── 4) enrichment on top (records that carry intel_total_enriched) ──
const E = ROWS.filter((r) => r.t1e != null);
if (E.length >= 20) {
  console.log(`\nWITH safety enrichment (n=${E.length} records carry intel_total_enriched): median legacy-enriched ${f1(med(E.map((r) => r.t0e)))}, log-enriched ${f1(med(E.map((r) => r.t1e)))}`);
  const fail = E.filter((r) => r.cls === "failure").length, succ = E.filter((r) => r.cls === "success").length;
  console.log("  bar  admit%  fail-blocked winner-kept admitted-succ%");
  for (const bar of [52, 55, 58, 60, 62, 65]) {
    const adm = E.filter((r) => r.t1e >= bar); const d = adm.filter((r) => r.cls !== "neutral"); const s = d.filter((r) => r.cls === "success").length;
    console.log(`  ${bar}   ${pct(adm.length / E.length)}%   ${pct(1 - adm.filter((r) => r.cls === "failure").length / Math.max(1, fail))}%     ${pct(adm.filter((r) => r.cls === "success").length / Math.max(1, succ))}%      ${pct(d.length ? s / d.length : null)}% (${s}/${d.length})`);
  }
}

// ── 5) era sensitivity ──
for (const era of ["pre0712", "post0712"]) {
  const sub = ROWS.filter((r) => r.era === era); const d = sub.filter((r) => r.cls !== "neutral"); const b = d.map((r) => (r.cls === "success" ? 1 : 0));
  console.log(`\nera ${era}: n=${sub.length} median fee ${f1(med(sub.map((r) => r.fee)))} | Spearman total→success legacy ${f1(spearman(d.map((r) => r.t0), b))} log ${f1(spearman(d.map((r) => r.t1), b))} | admit@52 legacy ${pct(sub.filter((r) => r.t0 >= 52).length / sub.length)}% log@52 ${pct(sub.filter((r) => r.t1 >= 52).length / sub.length)}%`);
}

console.log(`\nCAVEATS: every record is a deploy the burst-era gate admitted (median ${f1(med(ROWS.map((r) => r.fee * TO_DAY)))}%/day at entry) — the steady-pool regime (2–4%/day) is essentially absent from history, so this backtest can only show whether LOG mode preserves discrimination among bursts and where the gate moves; it cannot prove steady pools win. The only steady-regime evidence is the manual cohort (7 closes 08-21/22, avg +1.84%).`);
