import fs from "fs";
import path from "path";
import { makeDocStore } from "./db/doc-store.js";
import { usePg, query } from "./db/pool.js";
import { repoPath, dataPath } from "./repo-root.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getPerformanceSummary, getExitQualitySummary } from "./lessons.js";
import { formatDeployTimingBriefing } from "./deploy-timing.js";
import { getBaselineState } from "./state.js";
import { getSolPriceUsd } from "./sol-price.js";
import { getLatestLedgerTruth } from "./ledger-truth.js";
import { holdThinLimitConfig, holdThinYoungTokenHours } from "./hold-thin-limit.js";
import { reportNetCostFields } from "./net-cost.js";

/**
 * Dashboard report publisher — the single source of truth for the web
 * dashboard's live view. The management cycle computes everything the Telegram
 * bubble shows (positions, actions, dual-currency totals); this module
 * persists that same data (plus the slow-moving learning summaries) to a
 * kv_store doc so the dashboard can RENDER instead of RE-DERIVING — the
 * re-derivation is what caused its unit drift (SOL-valued `*_usd` fields
 * rendered as "$", regex-parsed exit PnL, estimated rent, etc.).
 */

const _store = makeDocStore("dashboard-report", dataPath("dashboard-report.json"), () => ({}));

let _lastScreeningFunnel = null;
try {
  const existing = _store.get();
  if (existing?.screening_funnel) _lastScreeningFunnel = existing.screening_funnel;
} catch (_) {}

export function setLastScreeningFunnel(funnel) {
  if (funnel) _lastScreeningFunnel = funnel;
}

export function getLastScreeningFunnel() {
  return _lastScreeningFunnel;
}

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
 * Cost-basis fields beside the thin-limit fields (hold-thin-limit.js avgCostBasisCardFields, carried by
 * the scan row): the figure the hold limit reads now and the recorded basis. Display only.
 */
export function reportAvgCostBasisFields(p) {
  const n = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return { hold_thin_limit_pnl_pct: n(p?.hold_thin_limit_pnl_pct), avg_cost_basis_sol: n(p?.avg_cost_basis_sol) };
}

/**
 * Thin-pool hold limit fields of one report position (the card's "keep holding" switch,
 * POST /command/set-thin-limit-exempt). The scan row carries them (tools/pnl.js buildPosition
 * → hold-thin-limit.js); a row without them still gets the configured limit and mode.
 */
export function reportThinLimitFields(p, mgmt = config.management) {
  const cfg = holdThinLimitConfig(mgmt);
  return {
    thin_pool: p?.thin_pool === true,
    entry_tvl_usd: p?.entry_tvl_usd ?? null,
    hold_thin_limit_exempt: p?.hold_thin_limit_exempt === true,
    hold_thin_limit_pct: p?.hold_thin_limit_pct ?? cfg.limitPct,
    hold_thin_limit_mode: p?.hold_thin_limit_mode ?? cfg.mode,
  };
}

/**
 * Young-token exemption fields of one report position (2026-11-28): the scan row's
 * (tools/pnl.js youngTokenCardFields); safe defaults for a row without them.
 */
export function reportYoungTokenFields(p, mgmt = config.management) {
  const age = p?.base_token_age_h_at_entry;
  return {
    hold_thin_limit_young: p?.hold_thin_limit_young === true,
    base_token_age_h_at_entry: typeof age === "number" && Number.isFinite(age) ? age : null,
    hold_thin_limit_young_hours: p?.hold_thin_limit_young_hours ?? holdThinYoungTokenHours(mgmt),
  };
}

/**
 * `hands_off_until` of one report position: the scan row's (tools/pnl.js handsOffCardFields —
 * ISO only while the operator's hands-off is in force, hands-off.js); null for a row without it.
 */
export function reportHandsOffUntil(p) {
  if (p && Object.prototype.hasOwnProperty.call(p, "hands_off_until")) return p.hands_off_until ?? null;
  return null;
}

const SKIM_THRESHOLD_NUMBERS = ["total_deposited_sol", "operator_withdrawn_sol", "skimmed_sol", "net_capital_sol", "untracked_swap_inflow_sol", "adjusted_capital_sol", "target_sol", "floor_sol"];
/**
 * dashboard-report `skim_threshold` (contract, do not rename): { state, reason, at,
 * total_deposited_sol, operator_withdrawn_sol, skimmed_sol, net_capital_sol,
 * untracked_swap_inflow_sol, adjusted_capital_sol, target_sol, floor_sol } — whitelisted
 * from tools/transfer.js skimThresholdReportField; null when nothing was passed.
 */
export function reportSkimThreshold(t) {
  if (!t || typeof t !== "object") return null;
  const out = { state: t.state === "ok" ? "ok" : "unavailable", reason: typeof t.reason === "string" ? t.reason : null, at: typeof t.at === "string" ? t.at : null };
  for (const k of SKIM_THRESHOLD_NUMBERS) out[k] = out.state === "ok" && Number.isFinite(t[k]) ? Math.round(t[k] * 1e6) / 1e6 : null;
  return out;
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
export function publishDashboardReport({ positions = [], actions = null, nextScreenSec = null, aum = null, screeningFunnel = null, skimDestination = null, skimThreshold = null } = {}) {
  try {
    if (screeningFunnel) _lastScreeningFunnel = screeningFunnel;
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
        collected_fees_usd: p.collected_fees_usd ?? null,
        collected_fees_true_usd: p.collected_fees_true_usd ?? null,
        fee_per_tvl_24h: p.fee_per_tvl_24h ?? null,
        instruction: p.instruction ?? null,
        strategy: p.strategy ?? null,
        management_profile: p.management_profile ?? null,
        pnl_quality: p.pnl_quality ?? null,
        pnl_quality_reason: p.pnl_quality_reason ?? null,
        pnl_management_ready: p.pnl_management_ready ?? null,
        pnl_pct_reported: p.pnl_pct_reported ?? null, // Meteora's own figure, for the card while ours is unverified
        action: act ? { action: act.action, rule: act.rule ?? null, reason: act.reason ?? null } : null,
        health_alerts: (Array.isArray(p.health?.alerts) ? p.health.alerts : []).map((a) => ({
          code: a.code,
          severity: a.severity || "warn",
          message: a.message,
        })),
        pvp: p.pvp ?? null,
        // Per-bin liquidity histogram (see tools/pnl.js buildPosition) for the
        // dashboard's Meteora-style bar chart. Rides THIS per-cycle doc (fully
        // overwritten every publish) rather than pool-memory's 48-snapshot
        // trend ring, which would multiply the per-bin payload across history
        // the dashboard never reads bins from.
        bins: Array.isArray(p.bins) && p.bins.length ? p.bins : null,
        // Exit-stack state + PnL tick ring (tools/pnl.js buildPosition) for the
        // dashboard's card sparkline and protection chip.
        pnl_ticks: Array.isArray(p.pnl_ticks) && p.pnl_ticks.length ? p.pnl_ticks : null,
        peak_pnl_pct: p.peak_pnl_pct ?? null,
        hold_peak_pnl_pct: p.hold_peak_pnl_pct ?? null, // held positions: the high since the hold began
        ...reportThinLimitFields(p), // thin_pool, entry_tvl_usd, hold_thin_limit_exempt / _pct / _mode
        ...reportYoungTokenFields(p), // hold_thin_limit_young, base_token_age_h_at_entry, hold_thin_limit_young_hours
        hands_off_until: reportHandsOffUntil(p), // ISO while the operator's hands-off is in force, else null
        flow_guard: p.flow_guard ?? null, // operator-armed flow guard summary (flow-guard.js flowGuardSummary), else null
        ...reportAvgCostBasisFields(p), // hold_thin_limit_pnl_pct, avg_cost_basis_sol
        // Display-only cost estimates (net-cost.js): two_sided, entry_cost_*, exit_cost_est_*,
        // net_cost_est_pct, net_cost_partial, pnl_net_est_pct (% of capital, SOL basis).
        ...reportNetCostFields(p),
        trailing_active: p.trailing_active ?? null,
        stop_pct: p.stop_pct ?? null,
        trailing_floor_pct: p.trailing_floor_pct ?? null,
        // Card fields (symbols, per-token breakdown, bin-range prices) so the
        // dashboard can render a complete position card BEFORE the first
        // pool-memory snapshot exists — a fresh deploy otherwise shows raw bin
        // ids as its "price range" and zero token lines until the next
        // management cycle. All true-USD (poller prices are Jupiter USD).
        token_x_symbol: p.token_x_symbol ?? null,
        token_y_symbol: p.token_y_symbol ?? null,
        bin_step: p.bin_step ?? null,
        liq_x_amount: p.liq_x_amount ?? null,
        liq_x_usd: p.liq_x_usd ?? null,
        liq_y_amount: p.liq_y_amount ?? null,
        liq_y_usd: p.liq_y_usd ?? null,
        fee_x_amount: p.fee_x_amount ?? null,
        fee_x_usd: p.fee_x_usd ?? null,
        fee_y_amount: p.fee_y_amount ?? null,
        fee_y_usd: p.fee_y_usd ?? null,
        price_lower: p.price_lower ?? null,
        price_upper: p.price_upper ?? null,
        price_active: p.price_active ?? null,
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
      // Plan #15: wallet-truth reconciliation (book vs ledger vs Δunrealized, 24h/7d).
      ledger_truth: (() => { try { return getLatestLedgerTruth(); } catch { return null; } })(),
      held_tokens: heldTokens,
      timing_line: timingLine,
      crash_shadow_count_48h: countCrashShadow(),
      crash_fast_path_enabled: !!config.management.crashFastPathEnabled,
      screening_funnel: _lastScreeningFunnel || null,
      // Profit-skimmer destination, masked (index.js skimDestinationReportField) — a second channel for a change.
      skim_destination: skimDestination && typeof skimDestination === "object"
        ? { masked: skimDestination.masked ?? null, source: skimDestination.source ?? null, hold_until: skimDestination.hold_until ?? null, verified: skimDestination.verified ?? null, changed_at: skimDestination.changed_at ?? null, state: skimDestination.state ?? null }
        : null,
      // Capital side of the skim decision (tools/transfer.js skimThresholdReportField) — the
      // dashboard's "Risk" figure IS the skim floor's capital; rendered, never re-derived.
      skim_threshold: reportSkimThreshold(skimThreshold),
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
