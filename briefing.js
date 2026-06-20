import { log } from "./logger.js";
import { getPerformanceSummary, getPerformanceHistory, listLessons } from "./lessons.js";
import { getTrackedPositions } from "./state.js";

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

  // 5. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${escapeHTML(l.rule)}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "────────────────"
  ];

  return lines.join("\n");
}
