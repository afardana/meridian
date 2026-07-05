import { log } from "./logger.js";
import { getPerformanceSummary, getPerformanceHistory, listLessons, getExitQualitySummary } from "./lessons.js";
import { formatDeployTimingBriefing } from "./deploy-timing.js";
import { getTrackedPositions, getBaselineState } from "./state.js";
import { getBalanceHistory } from "./balance-history.js";
import { getMyPositions } from "./tools/dlmm.js";
import { fmtDuration } from "./telegram.js";
import { config } from "./config.js";
import { getSolPriceUsd } from "./sol-price.js";

/**
 * Performance-record money fields (pnl_usd, fees_earned_usd, total_pnl_usd)
 * carry SOL when management.solMode is on — render them honestly as "◎X ($Y)"
 * instead of the old mislabeled "$<SOL amount>". Portfolio *_true_usd fields
 * are real USD and stay "$".
 */
function fmtPerfMoney(v, { dec = 4 } = {}) {
  const n = Number(v) || 0;
  if (!config.management.solMode) return `$${n.toFixed(2)}`;
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

export async function generateBriefing() {
  // Read through the persistence layer (state.js / lessons.js), NOT the raw JSON
  // files — those are stale cold copies under PERSIST_BACKEND=pg.
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = getTrackedPositions(false);
  const openedLast24h = allPositions.filter(p => p.deployed_at && new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && p.closed_at && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (last-24h window, already filtered + totalled)
  const perf24h = getPerformanceHistory({ hours: 24, limit: 500 });
  const perfLast24h = perf24h.positions || [];
  const totalPnLUsd = perf24h.total_pnl_usd ?? perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Lessons Learned (created_at is date-granular from listLessons — fine for a daily briefing)
  const lessonsLast24h = (listLessons({ limit: 200 }).lessons || [])
    .filter(l => l.created_at && new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 4a-bis. AUM headline: latest sampled total + 24h change + ROI vs deposits.
  // Sourced from balance_history (sampled every ~3-5 min) — no extra RPC call.
  let aumLine = null;
  try {
    const hist = await getBalanceHistory({ limit: 300 }); // ≈25h at 5-min cadence, oldest→newest
    const latest = hist[hist.length - 1];
    if (latest?.totalSol > 0) {
      const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
      const dayAgo = hist.find((h) => new Date(h.ts).getTime() >= dayAgoMs);
      const chg24h = dayAgo?.totalSol > 0 ? (latest.totalSol / dayAgo.totalSol - 1) * 100 : null;
      const deposited = getBaselineState()?.total_deposited || 0;
      const roi = deposited > 0 ? (latest.totalSol / deposited - 1) * 100 : null;
      aumLine = `💼 AUM: ◎${latest.totalSol.toFixed(4)} ($${(latest.totalUsd ?? 0).toFixed(2)})` +
        (chg24h != null ? ` · 24h ${chg24h >= 0 ? "+" : ""}${chg24h.toFixed(2)}%` : "") +
        (roi != null ? ` · ROI ${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%` : "");
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
  const winRate24h = perfLast24h.length > 0
    ? `${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
    : "N/A";

  // Deploy-timing profile (advisory) — null until there's enough history.
  const timingBriefing = formatDeployTimingBriefing();

  // Exit-quality one-liner (plan #05) — surface the worst-offending close-reason
  // family, or the best validation, once probes have accumulated. Percentages
  // only, so no SOL/USD unit concern.
  let exitLine = null;
  try {
    const { total_probed, families } = getExitQualitySummary({ limit: 30 });
    const offender = families.find((f) => f.selling_bottoms);
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
    // total_value_true_usd is real USD; total_value_usd carries SOL under solMode
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
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}${fmtPerfMoney(totalPnLUsd)} · 💎 Fees: ${fmtPerfMoney(totalFeesUsd)} · 📈 Win: ${winRate24h}`,
    ranked.length >= 1 ? `🏆 Best: ${fmtPerf(ranked[0])}` : null,
    ranked.length >= 2 ? `💔 Worst: ${fmtPerf(ranked[ranked.length - 1])}` : null,
    "",
    `<b>Portfolio (now)</b>`,
    liveValUsd != null
      ? `💼 Value: $${liveValUsd.toFixed(2)} · 💵 Unclaimed: $${(liveFeeUsd ?? 0).toFixed(2)} · 📂 Open: ${openPositions.length}`
      : `📂 Open Positions: ${openPositions.length}`,
    ...openLines,
    perfSummary
      ? `📊 All-time: ${fmtPerfMoney(perfSummary.total_pnl_usd)} (${perfSummary.win_rate_pct}% win, ${perfSummary.total_positions_closed} closed)`
      : null,
    ...(exitLine ? [exitLine] : []),
    ...(timingBriefing ? ["", `<b>Deploy Timing</b>`, timingBriefing] : []),
    "",
    `<b>Lessons (24h)</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${escapeHTML(l.rule)}`).join("\n")
      : "• No new lessons recorded overnight.",
  ].filter(line => line !== null);

  return lines.join("\n");
}
