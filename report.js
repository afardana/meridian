import fs from "fs";
import path from "path";
import { makeDocStore } from "./db/doc-store.js";
import { usePg, query } from "./db/pool.js";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getPerformanceSummary, getExitQualitySummary } from "./lessons.js";
import { formatDeployTimingBriefing } from "./deploy-timing.js";
import { getBaselineState } from "./state.js";
import { getSolPriceUsd } from "./sol-price.js";

/**
 * Dashboard report publisher — the single source of truth for the web
 * dashboard's live view. The management cycle computes everything the Telegram
 * bubble shows (positions, actions, dual-currency totals); this module
 * persists that same data (plus the slow-moving learning summaries) to a
 * kv_store doc so the dashboard can RENDER instead of RE-DERIVING — the
 * re-derivation is what caused its unit drift (SOL-valued `*_usd` fields
 * rendered as "$", regex-parsed exit PnL, estimated rent, etc.).
 */

const _store = makeDocStore("dashboard-report", repoPath("dashboard-report.json"), () => ({}));

/**
 * Fire a Postgres NOTIFY so the (separately-deployed) web dashboard can hold a
 * LISTEN connection and push Server-Sent Events to browsers. Fully fail-open:
 * no-ops unless the pg backend is active, and never throws into its caller —
 * any error is logged once and swallowed. Fire-and-forget (do NOT await into a
 * money-path caller). Payloads must stay < 7900 bytes; callers guard length.
 *
 * @param {string} channel  NOTIFY channel name (must be a valid identifier)
 * @param {string} payload  plain-text payload (ISO ts or JSON string)
 */
export async function pgNotify(channel, payload) {
  try {
    if (!usePg()) return;
    await query("SELECT pg_notify($1, $2)", [channel, payload]);
  } catch (e) {
    try { log("report_warn", `pg_notify(${channel}) failed (non-fatal): ${e.message}`); } catch { /* never throw */ }
  }
}

// Count crash_shadow would-fire lines in today's + yesterday's logs (plan #04
// calibration signal). Best-effort file scan; returns null when logs are absent.
function countCrashShadow() {
  try {
    const dir = repoPath("logs");
    if (!fs.existsSync(dir)) return null;
    const days = [0, 1].map((back) => {
      const d = new Date(Date.now() - back * 24 * 60 * 60 * 1000);
      return `agent-${d.toISOString().split("T")[0]}.log`;
    });
    let count = 0;
    for (const f of days) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, "utf8");
      count += (content.match(/crash_shadow/g) || []).length;
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Publish the per-cycle report. Called at the end of every management cycle
 * (including the zero-positions path). MUST never throw into the cycle —
 * callers wrap it, and it also self-guards.
 *
 * `positions` entries come straight from the cycle's positionData
 * (getMyPositions output + health/pvp enrichment); `actions` is the
 * actionMap. Money fields keep the bot's convention: `*_usd` carries SOL
 * under solMode, `*_true_usd` is always real USD.
 *
 * `aum` (optional) is the `aum` object from a `getWalletBalances()` call, used
 * only for the `held_tokens` block. index.js threads in `_lastSampledAum` — the
 * piggyback recordBalanceHistory sample's AUM — which is at most one management
 * cycle stale, because the report is published BEFORE that sample runs (it must
 * not wait on a Helius call). Null until the first sample lands after a restart,
 * in which case the block is omitted. This function must NEVER fetch the AUM
 * itself, to stay a cheap, non-fatal, no-network publish step.
 */
export function publishDashboardReport({ positions = [], actions = null, nextScreenSec = null, aum = null } = {}) {
  try {
    const solPrice = getSolPriceUsd();

    const posOut = positions.map((p) => {
      const act = actions?.get?.(p.position) || null;
      return {
        pair: p.pair ?? null,
        pool: p.pool ?? null,
        position: p.position ?? null,
        in_range: p.in_range ?? null,
        minutes_out_of_range: p.minutes_out_of_range ?? null,
        age_minutes: p.age_minutes ?? null,
        lower_bin: p.lower_bin ?? null,
        upper_bin: p.upper_bin ?? null,
        active_bin: p.active_bin ?? null,
        pnl_pct: p.pnl_pct ?? null,
        pnl_pct_usd: p.pnl_pct_usd ?? null,
        pnl_pct_derived: p.pnl_pct_derived ?? null,
        pnl_usd: p.pnl_usd ?? null,               // SOL under solMode
        pnl_true_usd: p.pnl_true_usd ?? null,      // always USD
        total_value_usd: p.total_value_usd ?? null,
        total_value_true_usd: p.total_value_true_usd ?? null,
        unclaimed_fees_usd: p.unclaimed_fees_usd ?? null,
        unclaimed_fees_true_usd: p.unclaimed_fees_true_usd ?? null,
        fee_per_tvl_24h: p.fee_per_tvl_24h ?? null,
        instruction: p.instruction ?? null,
        action: act ? { action: act.action, rule: act.rule ?? null, reason: act.reason ?? null } : null,
        health_alerts: p.health?.alerts?.map((a) => a.code) ?? [],
        pvp: p.pvp ?? null,
      };
    });

    const totals = {
      value_sol: posOut.reduce((s, p) => s + (config.management.solMode ? (p.total_value_usd ?? 0) : 0), 0),
      value_true_usd: posOut.reduce((s, p) => s + (p.total_value_true_usd ?? 0), 0),
      unclaimed_sol: posOut.reduce((s, p) => s + (config.management.solMode ? (p.unclaimed_fees_usd ?? 0) : 0), 0),
      unclaimed_true_usd: posOut.reduce((s, p) => s + (p.unclaimed_fees_true_usd ?? 0), 0),
    };

    // Slow-moving learning summaries — cheap getters over cached stores.
    let perfSummary = null;
    try { perfSummary = getPerformanceSummary(); } catch { /* advisory */ }
    let exitQuality = null;
    try { exitQuality = getExitQualitySummary({ limit: 30 }); } catch { /* advisory */ }
    let timingLine = null;
    try { timingLine = formatDeployTimingBriefing(); } catch { /* advisory */ }

    const baseline = getBaselineState();

    // Held-token AUM component (base tokens left over from the exit-swap
    // guard / dust sweeper — see tools/wallet.js getWalletBalances). Only
    // populated when a caller supplies `aum`; never fetched here.
    let heldTokens = null;
    try {
      if (aum && Array.isArray(aum.held_tokens)) {
        heldTokens = {
          total_sol: aum.tokens_sol ?? 0,
          total_usd: aum.tokens_usd ?? 0,
          items: aum.held_tokens.map((t) => ({
            symbol: t.symbol ?? null,
            mint: t.mint ?? null,
            balance: t.balance ?? null,
            usd: t.usd ?? null,
          })),
        };
      }
    } catch { /* advisory — omit gracefully */ }

    const ts = new Date().toISOString();
    _store.set({
      ts,
      sol_mode: !!config.management.solMode,
      sol_price_usd: solPrice || null,
      next_screen_sec: nextScreenSec,
      positions: posOut,
      totals,
      baseline: {
        total_deposited: baseline.total_deposited ?? 0,
        deposit_count: baseline.deposits?.length ?? 0,
        last_deposit_at: baseline.deposits?.length ? baseline.deposits[baseline.deposits.length - 1].timestamp : null,
        total_withdrawn: baseline.total_withdrawn ?? 0,
        withdrawal_count: baseline.withdrawals?.length ?? 0,
      },
      performance: perfSummary ? {
        total_pnl_sol: config.management.solMode ? (perfSummary.total_pnl_usd ?? null) : null,
        total_pnl_usd: config.management.solMode
          ? (solPrice > 0 && perfSummary.total_pnl_usd != null ? perfSummary.total_pnl_usd * solPrice : null)
          : (perfSummary.total_pnl_usd ?? null),
        closed: perfSummary.total_positions_closed ?? null,
        win_rate_pct_legacy: perfSummary.win_rate_pct ?? null,
        outcome_breakdown: perfSummary.outcome_breakdown ?? null,
        fee_efficiency_validation: perfSummary.fee_efficiency_validation ?? null,
        organic_momentum_validation: perfSummary.organic_momentum_validation ?? null,
      } : null,
      exit_quality: exitQuality,
      held_tokens: heldTokens,
      timing_line: timingLine,
      crash_shadow_count_48h: countCrashShadow(),
      crash_fast_path_enabled: !!config.management.crashFastPathEnabled,
    });

    // Announce the publish for the dashboard's pg LISTEN → SSE bridge. `_store.set`
    // is a synchronous cache write + async write-through; wait for the doc-store's
    // per-write promise (flush) to settle so LISTENers never read a stale doc, then
    // fire-and-forget the NOTIFY. Fully fail-open (pgNotify self-guards); the .catch
    // here only covers a rejected flush chain so it can't surface as an unhandled
    // rejection.
    Promise.resolve(_store.flush?.())
      .then(() => pgNotify("meridian_report", ts))
      .catch(() => { /* flush errors are already logged by the doc store */ });
  } catch (e) {
    log("report_warn", `Dashboard report publish failed (non-fatal): ${e.message}`);
  }
}
