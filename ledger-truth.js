/**
 * ledger-truth.js — wallet-truth reconciliation of the performance ledger (plan #15).
 *
 * The lessons perf ledger is what the learning engine, briefings and dashboard grade
 * the bot on. Aug 22 → Sep 24 2026 it claimed +8.5 SOL realized while the wallet, net
 * of the operator's own deposits/withdrawals, lost 2.5 SOL. This module makes that
 * disagreement a first-class, continuously measured number instead of a forensic
 * finding:
 *
 *   book      = ΔAUM(SOL) − deposits + withdrawals + orders placed − orders withdrawn
 *   ledger    = Σ pnl_sol_net of perf records closed in window (falls back to pnl_sol − gas)
 *   Δunreal   = unrealized(open positions at end) − unrealized(open at start)
 *   drift     = book − ledger − Δunreal      → 0 when the ledger tells the truth
 *
 * The operator's Meteora limit orders sit outside AUM (balance_history.totalSol
 * excludes their escrow), so a placement is booked like a transfer out at its deposit
 * value and a withdrawal like a transfer in (limit-orders.js). Their own realized P&L
 * is reported beside the reconciliation (`limit_orders_realized`), not inside it.
 *
 * Unrealized at a point in time is reconstructed from price_ticks (pnl_pct × amount_sol
 * of every position open at that instant). Everything here is READ-ONLY analytics —
 * pg only (json backend returns null), never on the money path, never throws into a
 * caller. Stored as the `ledger-truth` kv doc (latest + 60-entry history).
 */
import { usePg, query } from "./db/pool.js";
import { makeDocStore } from "./db/doc-store.js";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { getBaselineState, getTrackedPositions } from "./state.js";
import { getAllPerformance } from "./lessons.js";
import { getLimitOrderFlows, orderFlowsBetween } from "./limit-orders.js";

const _store = makeDocStore("ledger-truth", repoPath("ledger-truth.json"), () => ({ latest: null, history: [] }));
const HISTORY_CAP = 60;
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

/** Pure identity — exported for tests and the audit script. */
export function reconcile({ aumStart, aumEnd, deposits = 0, withdrawals = 0, ordersOut = 0, ordersIn = 0, ledgerNet = 0, unrealStart = 0, unrealEnd = 0 }) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const book = n(aumEnd) - n(aumStart) - n(deposits) + n(withdrawals) + n(ordersOut) - n(ordersIn);
  const dUnreal = n(unrealEnd) - n(unrealStart);
  const drift = book - n(ledgerNet) - dUnreal;
  return {
    aum_start: r4(n(aumStart)), aum_end: r4(n(aumEnd)),
    deposits: r4(n(deposits)), withdrawals: r4(n(withdrawals)),
    limit_orders_out: r4(n(ordersOut)), limit_orders_in: r4(n(ordersIn)),
    book: r4(book), ledger_net: r4(n(ledgerNet)),
    unrealized_start: r4(n(unrealStart)), unrealized_end: r4(n(unrealEnd)), unrealized_delta: r4(dUnreal),
    drift: r4(drift),
    // The ledger's share of what the wallet actually saw, when the wallet moved at all.
    ledger_fidelity_pct: Math.abs(book - dUnreal) > 0.05 ? r4((n(ledgerNet) / (book - dUnreal)) * 100) : null,
  };
}

/** Median totalSol of the balance samples within ±windowMin of `at` (robust to the 3-min mid-rebalance dips). */
async function aumAt(at, windowMin = 15) {
  const { rows } = await query(
    `select (snapshot->>'totalSol')::numeric as sol from balance_history
      where created_at between $1::timestamptz - ($2 || ' minutes')::interval and $1::timestamptz + ($2 || ' minutes')::interval
        and snapshot->>'totalSol' is not null order by sol`,
    [at.toISOString(), String(windowMin)],
  );
  if (!rows.length) {
    const near = await query(
      `select (snapshot->>'totalSol')::numeric as sol from balance_history where created_at <= $1::timestamptz order by created_at desc limit 1`,
      [at.toISOString()],
    );
    return near.rows.length ? Number(near.rows[0].sol) : null;
  }
  return Number(rows[Math.floor(rows.length / 2)].sol);
}

/** Σ pnl_pct(latest tick ≤ at, within 30 min) × amount_sol over positions open at `at`. */
async function unrealizedAt(at) {
  const { rows } = await query(
    `select p.position_address, (p.data->>'amount_sol')::numeric as amount_sol,
            (select t.pnl_pct from price_ticks t where t.position_address = p.position_address and t.pnl_pct is not null
               and t.ts <= $1::timestamptz and t.ts >= $1::timestamptz - interval '30 minutes' order by t.ts desc limit 1) as pnl_pct
       from positions p
      where p.deployed_at <= $1::timestamptz and (p.closed = false or p.closed_at is null or p.closed_at > $1::timestamptz)`,
    [at.toISOString()],
  );
  let sum = 0, priced = 0, unpriced = 0;
  for (const r of rows) {
    const amt = Number(r.amount_sol), pct = Number(r.pnl_pct);
    if (Number.isFinite(amt) && amt > 0 && Number.isFinite(pct)) { sum += (pct / 100) * amt; priced++; } else unpriced++;
  }
  return { sol: sum, open: rows.length, priced, unpriced };
}

export function flowsBetween(start, end) {
  const b = getBaselineState() || {};
  const inWin = (t) => { const ms = new Date(t || 0).getTime(); return ms > start.getTime() && ms <= end.getTime(); };
  const deposits = (b.deposits || []).filter((d) => inWin(d.timestamp)).reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const withdrawals = (b.withdrawals || []).filter((d) => inWin(d.timestamp)).reduce((s, d) => s + (Number(d.amount) || 0), 0);
  return { deposits, withdrawals };
}

async function walletAddress() {
  const { rows } = await query(`select value #>> '{}' as w from state_meta where key = 'walletAddress'`);
  return rows[0]?.w || null;
}

/** Limit-order transfers in the window; `available:false` when the feed failed. */
async function orderFlows(start, end) {
  try {
    const orders = await getLimitOrderFlows(await walletAddress());
    return { available: true, ...orderFlowsBetween(orders, start.getTime(), end.getTime()) };
  } catch (e) {
    log("ledger_truth_warn", `limit-order flows unavailable (${e.message}) — reconciling without them`);
    return { available: false, out_sol: 0, in_sol: 0, realized_sol: 0, placed: 0, closed: 0 };
  }
}

// Adopted accounts are rebased to the managed span from this date on (plan #15).
const REBASE_ERA_START_MS = Date.parse("2026-09-25T00:00:00Z");

/**
 * Was this adopted record scored on the account's whole lifetime although a rebase was
 * needed? Pure. A record without `adoption_lifetime` is only a problem when the account
 * carried pnl from before the adoption: a fresh adoption has no basis (Meteora had not
 * indexed the account), so its lifetime IS the managed span.
 *   stamped (pnl_source, 2026-10-07 →): |adoption_pre_pnl_sol| > max(◎0.01, 1 % of amount_sol)
 *            and no `adoption_rebase_skipped` — both skip reasons mean the record is already
 *            on the right basis ("cache_not_lifetime": valued on amount_sol;
 *            "fresh_deposit_only": the basis is the initial deposit, nothing to remove)
 *   unstamped: closed before the rebase existed (2026-09-25) → counted as before;
 *              later → fresh adoptions, not counted.
 */
export function isAdoptedLifetimeScored(r) {
  if (!r || !r.adopted || r.adoption_lifetime) return false;
  if (r.pnl_source == null) {
    const ms = new Date(r.recorded_at || NaN).getTime();
    return Number.isFinite(ms) && ms < REBASE_ERA_START_MS;
  }
  if (r.adoption_rebase_skipped) return false;
  if (r.adoption_pre_pnl_sol == null) return false;
  const pre = Number(r.adoption_pre_pnl_sol);
  if (!Number.isFinite(pre)) return false;
  const capital = Number(r.amount_sol);
  return Math.abs(pre) > Math.max(0.01, 0.01 * (Number.isFinite(capital) && capital > 0 ? capital : 0));
}

/**
 * Pure: ledger sum + counters over perf records already filtered to the window.
 * Group audit (close-audit-group.js): a record settled by its group carries the allocated
 * figure in pnl_sol_net, so it is in `net` like any other; `group_settled` / `group_settled_sol`
 * say how many records and how much SOL that moved (share_sol = allocated − modelled).
 * `group_shadow*` is the same for verdicts computed in shadow mode — NOT in `net`.
 */
export function summarizeLedger(recs) {
  let net = 0, n = 0, lifetimeOnly = 0, groupN = 0, groupSol = 0, shadowN = 0, shadowSol = 0;
  for (const r of recs || []) {
    const v = Number.isFinite(Number(r.pnl_sol_net)) ? Number(r.pnl_sol_net)
      : Number.isFinite(Number(r.pnl_sol)) ? Number(r.pnl_sol) - (Number(r.total_gas_sol) || 0)
      : null;
    if (v == null) continue;
    net += v; n++;
    if (isAdoptedLifetimeScored(r)) lifetimeOnly++;
    const g = r.chain_audit?.group;
    const share = Number(g?.share_sol);
    if (r.pnl_sol_net_source === "wallet_group" && Number.isFinite(Number(r.pnl_sol_net_modelled))) {
      groupN++; groupSol += Number(r.pnl_sol_net) - Number(r.pnl_sol_net_modelled);
    } else if (g?.status === "group_ok" && g.applied !== true && g.share_sol != null && Number.isFinite(share) && !(g.settled_individually || []).includes(r.position)) {
      // what enforce would do to this record's ledger value: modelled + share, from where it is now
      // (a record can still hold an older wallet figure its re-audit no longer stands behind)
      const modelled = Number.isFinite(Number(r.pnl_sol_net_modelled)) ? Number(r.pnl_sol_net_modelled) : v;
      shadowN++; shadowSol += modelled + share - v;
    }
  }
  return { net, closes: n, adopted_lifetime_scored: lifetimeOnly, group_settled: groupN, group_settled_sol: groupSol, group_shadow: shadowN, group_shadow_sol: shadowSol };
}

/**
 * Wallet swaps of a token that is not the base token of ANY position (open or closed) — a hand
 * trade, a swept airdrop: wallet P&L that no record can carry (2026-10-04 14:36Z: −1.7586 /
 * +1.6871 SOL = −◎0.072 of drift). Pure. `swaps` come from the baseline deposit scan, which
 * already reads every new wallet transaction (tools/wallet.js `classifyTokenSwap`), so this
 * costs no chain read. Reported BESIDE the reconciliation, not inside it: a purchase whose
 * tokens are still held is not a loss (AUM values them) — `unbalanced` counts the mints whose
 * token flows do not net to zero inside the window, where the SOL figure is not a result yet.
 */
export function untrackedSwapsBetween(swaps, positionMints, startMs, endMs) {
  const known = positionMints instanceof Set ? positionMints : new Set(positionMints || []);
  const byMint = new Map();
  let sol = 0, count = 0;
  for (const s of swaps || []) {
    const t = new Date(s?.timestamp || NaN).getTime();
    if (!Number.isFinite(t) || t <= startMs || t > endMs || !s.mint || known.has(s.mint)) continue;
    const v = Number(s.sol);
    if (!Number.isFinite(v)) continue;
    sol += v; count++;
    byMint.set(s.mint, (byMint.get(s.mint) || 0) + (Number(s.tokens) || 0));
  }
  let unbalanced = 0;
  for (const tok of byMint.values()) if (Math.abs(tok) > 1e-6) unbalanced++;
  return { sol, count, mints: byMint.size, unbalanced };
}

function untrackedSwaps(start, end) {
  const swaps = (getBaselineState() || {}).token_swaps;
  if (!Array.isArray(swaps)) return null; // the scan has not recorded any yet
  const mints = new Set();
  for (const p of getTrackedPositions(false)) if (p?.base_mint) mints.add(p.base_mint);
  for (const r of getAllPerformance() || []) if (r?.base_mint) mints.add(r.base_mint);
  return untrackedSwapsBetween(swaps, mints, start.getTime(), end.getTime());
}

function ledgerBetween(start, end) {
  const recs = (getAllPerformance() || []).filter((r) => {
    const ms = new Date(r.recorded_at || 0).getTime();
    return ms > start.getTime() && ms <= end.getTime();
  });
  return summarizeLedger(recs);
}

/**
 * Reconcile the window ending now. Returns null when not on pg or on any failure.
 */
export async function computeLedgerTruth({ hours = 24, end = new Date() } = {}) {
  if (!usePg()) return null;
  try {
    const start = new Date(end.getTime() - hours * 3600 * 1000);
    const [aumStart, aumEnd, uStart, uEnd, orders] = await Promise.all([aumAt(start), aumAt(end), unrealizedAt(start), unrealizedAt(end), orderFlows(start, end)]);
    if (aumStart == null || aumEnd == null) return null;
    const flows = flowsBetween(start, end);
    const ledger = ledgerBetween(start, end);
    let untracked = null;
    try { untracked = untrackedSwaps(start, end); } catch { /* line item only */ }
    const rec = reconcile({
      aumStart, aumEnd, deposits: flows.deposits, withdrawals: flows.withdrawals,
      ordersOut: orders.out_sol, ordersIn: orders.in_sol,
      ledgerNet: ledger.net, unrealStart: uStart.sol, unrealEnd: uEnd.sol,
    });
    return {
      hours, start: start.toISOString(), end: end.toISOString(),
      ...rec,
      limit_orders: orders.available ? "ok" : "unavailable",
      limit_orders_placed: orders.placed, limit_orders_closed: orders.closed,
      limit_orders_realized: r4(orders.realized_sol),
      closes: ledger.closes,
      adopted_lifetime_scored: ledger.adopted_lifetime_scored,
      group_settled: ledger.group_settled, group_settled_sol: r4(ledger.group_settled_sol),
      group_shadow: ledger.group_shadow, group_shadow_sol: r4(ledger.group_shadow_sol),
      untracked_token_swaps_sol: untracked ? r4(untracked.sol) : null,
      untracked_token_swaps: untracked ? untracked.count : null,
      untracked_token_swaps_unbalanced: untracked ? untracked.unbalanced : null,
      open_start: uStart.open, open_end: uEnd.open, unpriced_open_end: uEnd.unpriced,
    };
  } catch (e) {
    log("ledger_truth_warn", `computeLedgerTruth(${hours}h) failed: ${e.message}`);
    return null;
  }
}

/** Cron entry: 24h + 7d windows, logged + stored. Never throws. */
export async function runLedgerTruth() {
  const [d1, d7] = await Promise.all([computeLedgerTruth({ hours: 24 }), computeLedgerTruth({ hours: 24 * 7 })]);
  if (!d1 && !d7) return null;
  const fmt = (x) => (x == null ? "n/a" : `book ${sign(x.book)} | ledger ${sign(x.ledger_net)} | Δunreal ${sign(x.unrealized_delta)} | drift ${sign(x.drift)} (${x.closes} closes, ${x.adopted_lifetime_scored} adopted lifetime-scored${groupNote(x)}${untrackedNote(x)})`);
  log("ledger_truth", `[LEDGER_TRUTH] 24h: ${fmt(d1)} || 7d: ${fmt(d7)}`);
  const doc = _store.get() || { latest: null, history: [] };
  const entry = { at: new Date().toISOString(), d1, d7 };
  doc.latest = entry;
  doc.history = [...(doc.history || []), entry].slice(-HISTORY_CAP);
  _store.set(doc);
  return entry;
}

export function getLatestLedgerTruth() {
  return (_store.get() || {}).latest || null;
}

const sign = (v) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}◎${Number(v).toFixed(3)}`);

/** ", 4 settled by group ◎-0.097" / ", group shadow: 4 would move ◎-0.097" — empty when none. */
export function groupNote(x) {
  const parts = [];
  if (x?.group_settled > 0) parts.push(`, ${x.group_settled} settled by group ${sign(x.group_settled_sol)}`);
  if (x?.group_shadow > 0) parts.push(`, group shadow: ${x.group_shadow} would move ${sign(x.group_shadow_sol)}`);
  return parts.join("");
}

export function untrackedNote(x) {
  if (!(x?.untracked_token_swaps > 0)) return "";
  return `, untracked token swaps ${sign(x.untracked_token_swaps_sol)}${x.untracked_token_swaps_unbalanced ? ` (${x.untracked_token_swaps_unbalanced} token(s) still held)` : ""}`;
}

/** One-line briefing/report summary. */
export function formatLedgerTruthLine(entry = getLatestLedgerTruth()) {
  const d = entry?.d7 || entry?.d1;
  if (!d) return null;
  const label = d.hours >= 168 ? "7d" : `${d.hours}h`;
  const fid = d.ledger_fidelity_pct != null ? ` · ledger fidelity ${d.ledger_fidelity_pct.toFixed(0)}%` : "";
  return `🧾 Wallet truth (${label}): book ${sign(d.book)} vs ledger ${sign(d.ledger_net)} · drift ${sign(d.drift)}${fid}`;
}
