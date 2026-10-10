import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { getPerformanceSummary, getPerformanceHistory, getAllPerformance, listLessons, getExitQualitySummary, isWinningRecord } from "./lessons.js";
import { formatDeployTimingBriefing } from "./deploy-timing.js";
import { getTrackedPositions, getBaselineState, holdGiveBackReferencePct } from "./state.js";
import { getBalanceHistory } from "./balance-history.js";
import { getMyPositions } from "./tools/dlmm.js";
import { fmtDuration } from "./telegram.js";
import { config } from "./config.js";
import { getSolPriceUsd } from "./sol-price.js";
import { formatLedgerTruthLine, flowsBetween } from "./ledger-truth.js";
import { usePg, query } from "./db/pool.js";

/**
 * Performance-record money fields (pnl_usd, fees_earned_usd, total_pnl_usd)
 * carry SOL when management.solMode is on — render them honestly as "◎X ($Y)"
 * instead of the old mislabeled "$<SOL amount>". Portfolio *_true_usd fields
 * are real USD and stay "$".
 */
function fmtPerfMoney(v, { dec = 4, trueUsd = null } = {}) {
  const n = Number(v) || 0;
  if (!config.management.solMode) return `$${n.toFixed(2)}`;
  // Prefer the dual-written real-USD figure over a spot-price conversion of the
  // SOL amount — spot-converting values realized hours apart misstates them.
  if (Number.isFinite(trueUsd)) return `◎${n.toFixed(dec)} ($${trueUsd.toFixed(2)})`;
  const price = getSolPriceUsd();
  const usd = price > 0 ? ` ($${(n * price).toFixed(2)})` : "";
  return `◎${n.toFixed(dec)}${usd}`;
}

// A record's result in the unit the briefing displays: SOL when the record has it.
function perfPnl(p) {
  if (config.management.solMode && p?.pnl_sol != null && Number.isFinite(Number(p.pnl_sol))) return Number(p.pnl_sol);
  return Number(p?.pnl_usd) || 0;
}

/** Sum a set of perf records in their explicit units (pnl_sol, *_true), never the legacy *_usd fields. */
export function sumPerfTotals(records) {
  const n = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : 0);
  let pnlSol = 0, pnlUsd = 0, feesSol = 0, feesUsd = 0;
  for (const r of records || []) {
    pnlSol += n(r.pnl_sol);
    pnlUsd += n(r.pnl_usd_true);
    feesUsd += n(r.fees_usd_true);
    feesSol += n(r.fees_sol_true);
  }
  return { pnlSol, pnlUsd, feesSol, feesUsd };
}

// The newest few lessons, each cut at a word boundary with an ellipsis, plus a count of the rest.
const BRIEFING_MAX_LESSONS = 5;
const BRIEFING_LESSON_CHARS = 170;
export function lessonLines(lessons) {
  const list = Array.isArray(lessons) ? lessons : [];
  if (list.length === 0) return ["• No new lessons recorded overnight."];
  const shown = list.slice(-BRIEFING_MAX_LESSONS);
  const cut = (t) => {
    const text = String(t || "");
    if (text.length <= BRIEFING_LESSON_CHARS) return text;
    const head = text.slice(0, BRIEFING_LESSON_CHARS);
    return `${head.slice(0, Math.max(head.lastIndexOf(" "), BRIEFING_LESSON_CHARS - 30))}…`;
  };
  const out = shown.map((l) => `• ${escapeHTML(cut(l.rule))}`);
  if (list.length > shown.length) out.unshift(`${list.length} new — latest ${shown.length}:`);
  return out;
}

/** 24h AUM change in %, with deposits/withdrawals inside the window taken out. */
export function aumChangePct(startSol, endSol, { deposits = 0, withdrawals = 0 } = {}) {
  const a = Number(startSol), b = Number(endSol);
  if (!(a > 0) || !Number.isFinite(b)) return null;
  return ((b - (Number(deposits) || 0) + (Number(withdrawals) || 0)) / a - 1) * 100;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/<=/g, "≤")
    .replace(/>=/g, "≥")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function generateBriefingData() {
  // Read through the persistence layer (state.js / lessons.js), NOT the raw JSON
  // files — those are stale cold copies under PERSIST_BACKEND=pg.
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dateStr = now.toISOString().slice(0, 10);

  // 1. Positions Activity
  const allPositions = getTrackedPositions(false);
  const openedLast24h = allPositions.filter(p => p.deployed_at && new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && p.closed_at && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (last-24h window, already filtered + totalled)
  const perf24h = getPerformanceHistory({ hours: 24, limit: 500 });
  const perfLast24h = perf24h.positions || [];
  const totalPnLUsd = perf24h.total_pnl_usd ?? perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 2b. Real-USD 24h totals + era-honest all-time, from the full records
  let pnl24Sol = null;
  let pnl24TrueUsd = null, fees24TrueUsd = null, fees24Sol = null;
  let allTimeSolEra = null, allTimeEarlyUsd = null;
  try {
    const allRecs = getAllPerformance() || [];
    const rec24 = allRecs.filter((r) => r.recorded_at && new Date(r.recorded_at) > last24h);
    if (rec24.some((r) => r.pnl_usd_true != null)) {
      // Each record's own SOL and real-USD figures, summed — not the legacy pnl_usd (rounded
      // to 2 decimals, and it has carried dollars on some records) and not SOL × today's price.
      const t = sumPerfTotals(rec24);
      pnl24Sol = t.pnlSol; pnl24TrueUsd = t.pnlUsd;
      fees24Sol = t.feesSol; fees24TrueUsd = t.feesUsd;
    }
    const solEra = allRecs.filter((r) => Number.isFinite(Number(r.pnl_sol)));
    const earlyEra = allRecs.filter((r) => !Number.isFinite(Number(r.pnl_sol)));
    if (solEra.length) allTimeSolEra = solEra.reduce((s, r) => s + Number(r.pnl_sol), 0);
    if (earlyEra.length) allTimeEarlyUsd = earlyEra.reduce((s, r) => s + (Number(r.pnl_usd) || 0), 0);
  } catch (e) {
    log("briefing_warn", `true-USD/era totals unavailable: ${e.message}`);
  }

  // 3. Lessons Learned (created_at is date-granular from listLessons — fine for a daily briefing)
  // Full timestamps and full text: the date-only, 120-character listing dropped every
  // lesson written before 00:00 UTC and cut the rule mid-sentence ("PnL +").
  const lessonsLast24h = (listLessons({ limit: 200, full: true }).lessons || [])
    .filter(l => l.created_at && new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 4a-bis. AUM headline: latest sampled total + 24h change + ROI vs deposits.
  let aumLine = null;
  let latestAum = null;
  let aumChg24h = null;
  let aumFlow24h = 0;
  let aumRoi = null;
  let baselineDeposited = null;
  let baselineWithdrawn = null;
  try {
    // The sampler runs every ~3 min (2.5-min minimum gap → ≤ 576 samples a day); 300 rows
    // only reached ~15h back, so the "24h" change was really a 15h one.
    const hist = await getBalanceHistory({ limit: 700 }); // oldest→newest
    const latest = hist[hist.length - 1];
    latestAum = latest;
    if (latest?.totalSol > 0) {
      const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
      const dayAgo = hist.find((h) => new Date(h.ts).getTime() >= dayAgoMs);
      // Net of deposits/withdrawals in the window: a +5.6 SOL deposit read as "+218.64%".
      const flows = dayAgo ? flowsBetween(new Date(dayAgo.ts), new Date(latest.ts ?? Date.now())) : { deposits: 0, withdrawals: 0 };
      aumFlow24h = (flows.deposits || 0) - (flows.withdrawals || 0);
      aumChg24h = aumChangePct(dayAgo?.totalSol, latest.totalSol, flows);
      const baseline = getBaselineState();
      baselineDeposited = baseline?.total_deposited || 0;
      baselineWithdrawn = baseline?.total_withdrawn || 0;
      aumRoi = baselineDeposited > 0 ? ((latest.totalSol + baselineWithdrawn) / baselineDeposited - 1) * 100 : null;
      aumLine = `💼 AUM: ◎${latest.totalSol.toFixed(4)} ($${(latest.totalUsd ?? 0).toFixed(2)})` +
        (aumChg24h != null ? ` · 24h ${aumChg24h >= 0 ? "+" : ""}${aumChg24h.toFixed(2)}%${Math.abs(aumFlow24h) >= 0.001 ? ` (net of ◎${Math.abs(aumFlow24h).toFixed(2)} ${aumFlow24h > 0 ? "deposited" : "withdrawn"})` : ""}` : "") +
        (aumRoi != null ? ` · ROI ${aumRoi >= 0 ? "+" : ""}${aumRoi.toFixed(1)}%` : "");
    }
  } catch (e) {
    log("briefing_warn", `AUM headline unavailable: ${e.message}`);
  }

  // 4b. Live portfolio value (best-effort — never let an RPC hiccup break the briefing)
  let liveByPos = null, liveValUsd = null, liveFeeUsd = null;
  try {
    const live = await getMyPositions({ force: false, silent: true });
    const lp = live?.positions || [];
    liveByPos = new Map(lp.map(p => [p.position, p]));
    liveValUsd = lp.reduce((s, p) => s + (p.total_value_true_usd ?? p.total_value_usd ?? 0), 0);
    liveFeeUsd = lp.reduce((s, p) => s + (p.unclaimed_fees_true_usd ?? p.unclaimed_fees_usd ?? 0), 0);
  } catch (e) {
    log("briefing_warn", `Live portfolio value unavailable: ${e.message}`);
  }

  // 4c. Best / worst 24h performer
  const ranked = [...perfLast24h].sort((a, b) => perfPnl(b) - perfPnl(a));
  const fmtPerf = (p) => `${escapeHTML(p.pool_name || "?")} ${perfPnl(p) >= 0 ? "+" : ""}${fmtPerfMoney(perfPnl(p), { trueUsd: Number.isFinite(Number(p.pnl_usd_true)) && p.pnl_usd_true != null ? Number(p.pnl_usd_true) : null })} (${(p.pnl_pct ?? 0) >= 0 ? "+" : ""}${(p.pnl_pct ?? 0).toFixed(1)}%)`;

  // 5. Format Message
  const winRateNum = perfLast24h.length > 0
    ? Math.round((perfLast24h.filter(isWinningRecord).length / perfLast24h.length) * 100)
    : null;
  const winRate24h = winRateNum != null ? `${winRateNum}%` : "N/A";

  // Deploy-timing profile (advisory) — null until there's enough history.
  const timingBriefing = formatDeployTimingBriefing();

  // Exit-quality one-liner
  let exitLine = null;
  let exitStats = null;
  try {
    const eq = getExitQualitySummary({ limit: 30 });
    const { total_probed, families } = eq;
    const offender = families.find((f) => f.selling_bottoms);
    exitStats = {
      total_probed,
      offender: offender ? { family: offender.family, early: offender.early, n: offender.n, avg_missed_pct: offender.avg_missed_pct } : null,
      top_family: families[0] ? { family: families[0].family, n: families[0].n, good: families[0].good, early: families[0].early, avg_saved_pct: families[0].avg_saved_pct } : null
    };
    if (offender) {
      exitLine = `🚪 Exits: ⚠ ${offender.family} selling bottoms — ${offender.early}/${offender.n} bounced after close (avg missed +${offender.avg_missed_pct ?? "?"}%). Consider raising its wait.`;
    } else if (total_probed >= 6) {
      const top = families[0];
      exitLine = `🚪 Exits: ${total_probed} probed · ${top.family} n=${top.n} (good ${top.good}/early ${top.early})${top.avg_saved_pct != null ? ` · avg saved +${top.avg_saved_pct}%` : ""}`;
    }
  } catch { /* advisory only */ }

  const openLines = openPositions.map(p => {
    const lv = liveByPos?.get(p.position);
    const ageMin = p.deployed_at ? Math.floor((Date.now() - new Date(p.deployed_at).getTime()) / 60000) : null;
    const valStr = lv
      ? (lv.total_value_true_usd != null
          ? `$${lv.total_value_true_usd.toFixed(2)}`
          : config.management.solMode
            ? `◎${(lv.total_value_usd ?? 0).toFixed(3)}`
            : `$${(lv.total_value_usd ?? 0).toFixed(2)}`)
      : `◎${(p.amount_sol ?? 0).toFixed(3)}`;
    const pnlStr = lv?.pnl_pct != null ? ` · ${lv.pnl_pct >= 0 ? "+" : ""}${lv.pnl_pct.toFixed(1)}%` : "";
    const oor = lv && lv.in_range === false ? " · 🔴 OOR" : "";
    // Hold cohort (audit 01 §4.3): show what a held position has given back from its peak.
    let heldStr = "";
    if (p.hold_mode === true) {
      const peak = holdGiveBackReferencePct(p); // the held high, not the frozen exit peak
      const gb = lv?.pnl_pct != null && Number.isFinite(peak) ? peak - lv.pnl_pct : null;
      heldStr = gb != null && gb >= 5
        ? ` · 🧊 held (peak ${peak >= 0 ? "+" : ""}${peak.toFixed(1)}% → −${gb.toFixed(1)} pp)`
        : " · 🧊 held";
    }
    return `   • ${escapeHTML(p.pool_name || "?")} · ${valStr}${pnlStr} · ${ageMin != null ? fmtDuration(ageMin) : "?"}${oor}${heldStr}`;
  });
  let heldLine = null;
  try {
    const held = openPositions.filter((p) => p.hold_mode === true);
    if (held.length > 0) {
      let giveBackSol = 0, n = 0;
      for (const p of held) {
        const lv = liveByPos?.get(p.position);
        const peak = holdGiveBackReferencePct(p);
        const amt = Number(p.amount_sol) || 0;
        if (lv?.pnl_pct != null && Number.isFinite(peak) && amt > 0 && peak - lv.pnl_pct > 0) { giveBackSol += (peak - lv.pnl_pct) / 100 * amt; n++; }
      }
      heldLine = `🧊 Held: ${held.length} position${held.length === 1 ? "" : "s"}${n > 0 ? ` · ≈◎${giveBackSol.toFixed(3)} given back from peak (unrealised, ${n} below peak)` : ""} — hold mode, no rule fires`;
    }
  } catch { /* advisory */ }

  // Plan #15: wallet-truth vs ledger, so the briefing can never again present a
  // ledger figure the wallet does not corroborate without saying so.
  let ledgerTruthLine = null;
  try { ledgerTruthLine = formatLedgerTruthLine(); } catch { /* advisory */ }

  // solMode headline figures come from the explicit SOL sums when the records carry them.
  const netPnl24 = config.management.solMode && pnl24Sol != null ? pnl24Sol : totalPnLUsd;
  const fees24 = config.management.solMode && fees24Sol != null ? fees24Sol : totalFeesUsd;

  const lines = [
    "☀️ <b>Morning Briefing</b> — Last 24h",
    "",
    ...(aumLine ? [aumLine] : []),
    `<b>Activity:</b> 📥 ${openedLast24h.length} opened · 📤 ${closedLast24h.length} closed`,
    "",
    `<b>Performance (24h)</b>`,
    `💰 Net PnL: ${netPnl24 >= 0 ? "+" : ""}${fmtPerfMoney(netPnl24, { trueUsd: pnl24TrueUsd })} · 💎 Fees: ${fmtPerfMoney(fees24, { trueUsd: fees24TrueUsd })} · 📈 Win: ${winRate24h}`,
    ranked.length >= 1 ? `🏆 Best: ${fmtPerf(ranked[0])}` : null,
    ranked.length >= 2 ? `💔 Worst: ${fmtPerf(ranked[ranked.length - 1])}` : null,
    "",
    `<b>Portfolio (now)</b>`,
    liveValUsd != null
      ? `💼 Value: $${liveValUsd.toFixed(2)} · 💵 Unclaimed: $${(liveFeeUsd ?? 0).toFixed(2)} · 📂 Open: ${openPositions.length}`
      : `📂 Open Positions: ${openPositions.length}`,
    ...openLines,
    ...(heldLine ? [heldLine] : []),
    perfSummary
      ? (allTimeSolEra != null
          ? `📊 All-time (closed-position ledger): ${allTimeSolEra >= 0 ? "+" : ""}◎${allTimeSolEra.toFixed(3)}${allTimeEarlyUsd ? ` · early era ${allTimeEarlyUsd >= 0 ? "+" : "-"}$${Math.abs(allTimeEarlyUsd).toFixed(2)}` : ""} (${perfSummary.win_rate_pct}% win, ${perfSummary.total_positions_closed} closed)`
          : `📊 All-time: ${fmtPerfMoney(perfSummary.total_pnl_usd)} (${perfSummary.win_rate_pct}% win, ${perfSummary.total_positions_closed} closed)`)
      : null,
    ...(exitLine ? [exitLine] : []),
    ...(ledgerTruthLine ? [ledgerTruthLine] : []),
    ...(timingBriefing ? ["", `<b>Deploy Timing</b>`, timingBriefing] : []),
    "",
    `<b>Lessons (24h)</b>`,
    ...lessonLines(lessonsLast24h),
  ].filter(line => line !== null);

  const rawText = lines.join("\n");

  const structuredData = {
    timestamp: now.toISOString(),
    date: dateStr,
    time_wib: "08:00 WIB",
    aum: {
      total_sol: latestAum?.totalSol != null ? Number(latestAum.totalSol.toFixed(4)) : null,
      total_usd: latestAum?.totalUsd != null ? Number(latestAum.totalUsd.toFixed(2)) : null,
      change_24h_pct: aumChg24h != null ? Math.round(aumChg24h * 100) / 100 : null,
      roi_pct: aumRoi != null ? Math.round(aumRoi * 10) / 10 : null,
      deposited_sol: baselineDeposited,
      withdrawn_sol: baselineWithdrawn,
      headline: aumLine
    },
    activity: {
      opened_count: openedLast24h.length,
      closed_count: closedLast24h.length,
      opened: openedLast24h.map(p => ({
        position: p.position,
        pool_name: p.pool_name,
        pool: p.pool,
        amount_sol: p.amount_sol,
        deployed_at: p.deployed_at,
        strategy: p.strategy
      })),
      closed: closedLast24h.map(p => ({
        position: p.position,
        pool_name: p.pool_name,
        pool: p.pool,
        pnl_usd: p.pnl_usd,
        pnl_pct: p.pnl_pct,
        close_reason: p.close_reason,
        closed_at: p.closed_at
      }))
    },
    performance_24h: {
      net_pnl_usd: netPnl24 != null ? Math.round(netPnl24 * 10000) / 10000 : 0,
      net_pnl_sol: pnl24Sol != null ? Math.round(pnl24Sol * 10000) / 10000 : null,
      net_pnl_true_usd: pnl24TrueUsd != null ? Math.round(pnl24TrueUsd * 100) / 100 : null,
      fees_usd: fees24 != null ? Math.round(fees24 * 10000) / 10000 : 0,
      fees_true_usd: fees24TrueUsd != null ? Math.round(fees24TrueUsd * 100) / 100 : null,
      win_rate_pct: winRateNum,
      win_rate_str: winRate24h,
      total_trades: perfLast24h.length,
      best_performer: ranked.length >= 1 ? {
        pool_name: ranked[0].pool_name,
        pnl_usd: ranked[0].pnl_usd,
        pnl_pct: ranked[0].pnl_pct,
        strategy: ranked[0].strategy,
        minutes_held: ranked[0].minutes_held
      } : null,
      worst_performer: ranked.length >= 2 ? {
        pool_name: ranked[ranked.length - 1].pool_name,
        pnl_usd: ranked[ranked.length - 1].pnl_usd,
        pnl_pct: ranked[ranked.length - 1].pnl_pct,
        close_reason: ranked[ranked.length - 1].close_reason,
        minutes_held: ranked[ranked.length - 1].minutes_held
      } : null
    },
    portfolio_now: {
      total_value_usd: liveValUsd != null ? Math.round(liveValUsd * 100) / 100 : null,
      unclaimed_fees_usd: liveFeeUsd != null ? Math.round(liveFeeUsd * 100) / 100 : null,
      open_positions_count: openPositions.length,
      positions: openPositions.map(p => {
        const lv = liveByPos?.get(p.position);
        const ageMin = p.deployed_at ? Math.floor((Date.now() - new Date(p.deployed_at).getTime()) / 60000) : null;
        return {
          position: p.position,
          pool_name: p.pool_name,
          pool: p.pool,
          amount_sol: p.amount_sol,
          value_usd: lv?.total_value_true_usd ?? lv?.total_value_usd ?? null,
          pnl_pct: lv?.pnl_pct ?? null,
          age_minutes: ageMin,
          in_range: lv ? lv.in_range !== false : true,
          strategy: p.strategy
        };
      })
    },
    all_time: {
      sol_era_pnl: allTimeSolEra != null ? Math.round(allTimeSolEra * 1000) / 1000 : null,
      early_usd_pnl: allTimeEarlyUsd != null ? Math.round(allTimeEarlyUsd * 100) / 100 : null,
      total_pnl_usd: perfSummary?.total_pnl_usd ?? null,
      win_rate_pct: perfSummary?.win_rate_pct ?? null,
      total_closed: perfSummary?.total_positions_closed ?? null
    },
    exit_quality: {
      summary_text: exitLine,
      details: exitStats
    },
    deploy_timing: {
      summary_text: timingBriefing
    },
    lessons_24h: lessonsLast24h.map(l => ({
      id: l.id,
      rule: l.rule,
      tags: l.tags || [],
      outcome: l.outcome,
      confidence: l.confidence
    })),
    raw_text: rawText
  };

  return structuredData;
}

export async function generateBriefing() {
  const data = await generateBriefingData();
  return data.raw_text;
}

export async function saveDailyBriefing(data) {
  if (!data || !data.date) return;
  const keyDate = `daily_briefing:${data.date}`;
  const keyLatest = "daily_briefing:latest";
  const keyIndex = "daily_briefings_index";

  if (usePg()) {
    try {
      const snap = JSON.stringify(data);
      await query(
        "INSERT INTO kv_store (key, doc, updated_at) VALUES ($1, $2::jsonb, now()) " +
        "ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
        [keyDate, snap]
      );
      await query(
        "INSERT INTO kv_store (key, doc, updated_at) VALUES ($1, $2::jsonb, now()) " +
        "ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
        [keyLatest, snap]
      );
      const { rows } = await query("SELECT doc FROM kv_store WHERE key = $1", [keyIndex]);
      let index = Array.isArray(rows[0]?.doc) ? rows[0].doc : [];
      if (!index.includes(data.date)) {
        index.unshift(data.date);
        index = Array.from(new Set(index)).sort().reverse();
        await query(
          "INSERT INTO kv_store (key, doc, updated_at) VALUES ($1, $2::jsonb, now()) " +
          "ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
          [keyIndex, JSON.stringify(index)]
        );
      }
      log("briefing", `Saved daily briefing snapshot for ${data.date} (Postgres)`);
      return;
    } catch (err) {
      log("briefing_warn", `Failed to save daily briefing to Postgres: ${err.message}`);
    }
  }

  // File fallback
  try {
    const dir = path.resolve("./daily-briefings");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${data.date}.json`), JSON.stringify(data, null, 2));
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(data, null, 2));
    const idxFile = path.join(dir, "index.json");
    let idx = [];
    if (fs.existsSync(idxFile)) {
      try { idx = JSON.parse(fs.readFileSync(idxFile, "utf8")); } catch (_) {}
    }
    if (!idx.includes(data.date)) {
      idx.unshift(data.date);
      idx = Array.from(new Set(idx)).sort().reverse();
      fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));
    }
    log("briefing", `Saved daily briefing snapshot for ${data.date} (File)`);
  } catch (err) {
    log("briefing_warn", `Failed to save daily briefing to disk: ${err.message}`);
  }
}

export async function getDailyBriefing(date = null) {
  const targetKey = date ? `daily_briefing:${date}` : "daily_briefing:latest";
  if (usePg()) {
    try {
      const { rows } = await query("SELECT doc FROM kv_store WHERE key = $1", [targetKey]);
      if (rows[0]?.doc) return rows[0].doc;
    } catch (_) {}
  }
  // File fallback
  try {
    const dir = path.resolve("./daily-briefings");
    const file = path.join(dir, date ? `${date}.json` : "latest.json");
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (_) {}
  return null;
}
