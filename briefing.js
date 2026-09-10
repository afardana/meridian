import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { getPerformanceSummary, getPerformanceHistory, getAllPerformance, listLessons, getExitQualitySummary } from "./lessons.js";
import { formatDeployTimingBriefing } from "./deploy-timing.js";
import { getTrackedPositions, getBaselineState } from "./state.js";
import { getBalanceHistory } from "./balance-history.js";
import { getMyPositions } from "./tools/dlmm.js";
import { fmtDuration } from "./telegram.js";
import { config } from "./config.js";
import { getSolPriceUsd } from "./sol-price.js";
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
  let pnl24TrueUsd = null, fees24TrueUsd = null;
  let allTimeSolEra = null, allTimeEarlyUsd = null;
  try {
    const allRecs = getAllPerformance() || [];
    const rec24 = allRecs.filter((r) => r.recorded_at && new Date(r.recorded_at) > last24h);
    if (rec24.some((r) => r.pnl_usd_true != null)) {
      pnl24Sol = rec24.reduce((s, r) => s + (Number(r.pnl_sol) || 0), 0);
      const px = getSolPriceUsd();
      pnl24TrueUsd = Number.isFinite(px) && px > 0
        ? pnl24Sol * px
        : rec24.reduce((s, r) => s + (Number(r.pnl_usd_true) || 0), 0);
      fees24TrueUsd = rec24.reduce((s, r) => s + (Number(r.fees_usd_true) || 0), 0);
    }
    const solEra = allRecs.filter((r) => Number.isFinite(Number(r.pnl_sol)));
    const earlyEra = allRecs.filter((r) => !Number.isFinite(Number(r.pnl_sol)));
    if (solEra.length) allTimeSolEra = solEra.reduce((s, r) => s + Number(r.pnl_sol), 0);
    if (earlyEra.length) allTimeEarlyUsd = earlyEra.reduce((s, r) => s + (Number(r.pnl_usd) || 0), 0);
  } catch (e) {
    log("briefing_warn", `true-USD/era totals unavailable: ${e.message}`);
  }

  // 3. Lessons Learned (created_at is date-granular from listLessons — fine for a daily briefing)
  const lessonsLast24h = (listLessons({ limit: 200 }).lessons || [])
    .filter(l => l.created_at && new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 4a-bis. AUM headline: latest sampled total + 24h change + ROI vs deposits.
  let aumLine = null;
  let latestAum = null;
  let aumChg24h = null;
  let aumRoi = null;
  let baselineDeposited = null;
  let baselineWithdrawn = null;
  try {
    const hist = await getBalanceHistory({ limit: 300 }); // ≈25h at 5-min cadence, oldest→newest
    const latest = hist[hist.length - 1];
    latestAum = latest;
    if (latest?.totalSol > 0) {
      const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
      const dayAgo = hist.find((h) => new Date(h.ts).getTime() >= dayAgoMs);
      aumChg24h = dayAgo?.totalSol > 0 ? (latest.totalSol / dayAgo.totalSol - 1) * 100 : null;
      const baseline = getBaselineState();
      baselineDeposited = baseline?.total_deposited || 0;
      baselineWithdrawn = baseline?.total_withdrawn || 0;
      aumRoi = baselineDeposited > 0 ? ((latest.totalSol + baselineWithdrawn) / baselineDeposited - 1) * 100 : null;
      aumLine = `💼 AUM: ◎${latest.totalSol.toFixed(4)} ($${(latest.totalUsd ?? 0).toFixed(2)})` +
        (aumChg24h != null ? ` · 24h ${aumChg24h >= 0 ? "+" : ""}${aumChg24h.toFixed(2)}%` : "") +
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
  const ranked = [...perfLast24h].sort((a, b) => (b.pnl_usd ?? 0) - (a.pnl_usd ?? 0));
  const fmtPerf = (p) => `${escapeHTML(p.pool_name || "?")} ${(p.pnl_usd ?? 0) >= 0 ? "+" : ""}${fmtPerfMoney(p.pnl_usd)} (${(p.pnl_pct ?? 0) >= 0 ? "+" : ""}${(p.pnl_pct ?? 0).toFixed(1)}%)`;

  // 5. Format Message
  const winRateNum = perfLast24h.length > 0
    ? Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)
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
    return `   • ${escapeHTML(p.pool_name || "?")} · ${valStr}${pnlStr} · ${ageMin != null ? fmtDuration(ageMin) : "?"}${oor}`;
  });

  const lines = [
    "☀️ <b>Morning Briefing</b> — Last 24h",
    "",
    ...(aumLine ? [aumLine] : []),
    `<b>Activity:</b> 📥 ${openedLast24h.length} opened · 📤 ${closedLast24h.length} closed`,
    "",
    `<b>Performance (24h)</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}${fmtPerfMoney(totalPnLUsd, { trueUsd: pnl24TrueUsd })} · 💎 Fees: ${fmtPerfMoney(totalFeesUsd, { trueUsd: fees24TrueUsd })} · 📈 Win: ${winRate24h}`,
    ranked.length >= 1 ? `🏆 Best: ${fmtPerf(ranked[0])}` : null,
    ranked.length >= 2 ? `💔 Worst: ${fmtPerf(ranked[ranked.length - 1])}` : null,
    "",
    `<b>Portfolio (now)</b>`,
    liveValUsd != null
      ? `💼 Value: $${liveValUsd.toFixed(2)} · 💵 Unclaimed: $${(liveFeeUsd ?? 0).toFixed(2)} · 📂 Open: ${openPositions.length}`
      : `📂 Open Positions: ${openPositions.length}`,
    ...openLines,
    perfSummary
      ? (allTimeSolEra != null
          ? `📊 All-time: ${allTimeSolEra >= 0 ? "+" : ""}◎${allTimeSolEra.toFixed(3)}${allTimeEarlyUsd ? ` · early era ${allTimeEarlyUsd >= 0 ? "+" : "-"}$${Math.abs(allTimeEarlyUsd).toFixed(2)}` : ""} (${perfSummary.win_rate_pct}% win, ${perfSummary.total_positions_closed} closed)`
          : `📊 All-time: ${fmtPerfMoney(perfSummary.total_pnl_usd)} (${perfSummary.win_rate_pct}% win, ${perfSummary.total_positions_closed} closed)`)
      : null,
    ...(exitLine ? [exitLine] : []),
    ...(timingBriefing ? ["", `<b>Deploy Timing</b>`, timingBriefing] : []),
    "",
    `<b>Lessons (24h)</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${escapeHTML(l.rule)}`).join("\n")
      : "• No new lessons recorded overnight.",
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
      net_pnl_usd: totalPnLUsd != null ? Math.round(totalPnLUsd * 100) / 100 : 0,
      net_pnl_sol: pnl24Sol != null ? Math.round(pnl24Sol * 10000) / 10000 : null,
      net_pnl_true_usd: pnl24TrueUsd != null ? Math.round(pnl24TrueUsd * 100) / 100 : null,
      fees_usd: totalFeesUsd != null ? Math.round(totalFeesUsd * 100) / 100 : 0,
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
