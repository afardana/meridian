/**
 * ledger-truth.js — wallet-truth reconciliation of the performance ledger (plan #15).
 *
 * The lessons perf ledger is what the learning engine, briefings and dashboard grade
 * the bot on. Aug 22 → Sep 24 2026 it claimed +8.5 SOL realized while the wallet, net
 * of the operator's own deposits/withdrawals, lost 2.5 SOL. This module makes that
 * disagreement a first-class, continuously measured number instead of a forensic
 * finding:
 *
 *   book      = ΔAUM(SOL) − deposits + withdrawals         (balance_history + baseline)
 *   ledger    = Σ pnl_sol_net of perf records closed in window (falls back to pnl_sol − gas)
 *   Δunreal   = unrealized(open positions at end) − unrealized(open at start)
 *   drift     = book − ledger − Δunreal      → 0 when the ledger tells the truth
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
import { getBaselineState } from "./state.js";
import { getAllPerformance } from "./lessons.js";

const _store = makeDocStore("ledger-truth", repoPath("ledger-truth.json"), () => ({ latest: null, history: [] }));
const HISTORY_CAP = 60;
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

/** Pure identity — exported for tests and the audit script. */
export function reconcile({ aumStart, aumEnd, deposits = 0, withdrawals = 0, ledgerNet = 0, unrealStart = 0, unrealEnd = 0 }) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const book = n(aumEnd) - n(aumStart) - n(deposits) + n(withdrawals);
  const dUnreal = n(unrealEnd) - n(unrealStart);
  const drift = book - n(ledgerNet) - dUnreal;
  return {
    aum_start: r4(n(aumStart)), aum_end: r4(n(aumEnd)),
    deposits: r4(n(deposits)), withdrawals: r4(n(withdrawals)),
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

function flowsBetween(start, end) {
  const b = getBaselineState() || {};
  const inWin = (t) => { const ms = new Date(t || 0).getTime(); return ms > start.getTime() && ms <= end.getTime(); };
  const deposits = (b.deposits || []).filter((d) => inWin(d.timestamp)).reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const withdrawals = (b.withdrawals || []).filter((d) => inWin(d.timestamp)).reduce((s, d) => s + (Number(d.amount) || 0), 0);
  return { deposits, withdrawals };
}

function ledgerBetween(start, end) {
  const recs = (getAllPerformance() || []).filter((r) => {
    const ms = new Date(r.recorded_at || 0).getTime();
    return ms > start.getTime() && ms <= end.getTime();
  });
  let net = 0, n = 0, lifetimeOnly = 0;
  for (const r of recs) {
    const v = Number.isFinite(Number(r.pnl_sol_net)) ? Number(r.pnl_sol_net)
      : Number.isFinite(Number(r.pnl_sol)) ? Number(r.pnl_sol) - (Number(r.total_gas_sol) || 0)
      : null;
    if (v == null) continue;
    net += v; n++;
    if (r.adopted && !r.adoption_lifetime) lifetimeOnly++;
  }
  return { net, closes: n, adopted_lifetime_scored: lifetimeOnly };
}

/**
 * Reconcile the window ending now. Returns null when not on pg or on any failure.
 */
export async function computeLedgerTruth({ hours = 24, end = new Date() } = {}) {
  if (!usePg()) return null;
  try {
    const start = new Date(end.getTime() - hours * 3600 * 1000);
    const [aumStart, aumEnd, uStart, uEnd] = await Promise.all([aumAt(start), aumAt(end), unrealizedAt(start), unrealizedAt(end)]);
    if (aumStart == null || aumEnd == null) return null;
    const flows = flowsBetween(start, end);
    const ledger = ledgerBetween(start, end);
    const rec = reconcile({
      aumStart, aumEnd, deposits: flows.deposits, withdrawals: flows.withdrawals,
      ledgerNet: ledger.net, unrealStart: uStart.sol, unrealEnd: uEnd.sol,
    });
    return {
      hours, start: start.toISOString(), end: end.toISOString(),
      ...rec,
      closes: ledger.closes,
      adopted_lifetime_scored: ledger.adopted_lifetime_scored,
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
  const fmt = (x) => (x == null ? "n/a" : `book ${sign(x.book)} | ledger ${sign(x.ledger_net)} | Δunreal ${sign(x.unrealized_delta)} | drift ${sign(x.drift)} (${x.closes} closes, ${x.adopted_lifetime_scored} adopted lifetime-scored)`);
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

/** One-line briefing/report summary. */
export function formatLedgerTruthLine(entry = getLatestLedgerTruth()) {
  const d = entry?.d7 || entry?.d1;
  if (!d) return null;
  const label = d.hours >= 168 ? "7d" : `${d.hours}h`;
  const fid = d.ledger_fidelity_pct != null ? ` · ledger fidelity ${d.ledger_fidelity_pct.toFixed(0)}%` : "";
  return `🧾 Wallet truth (${label}): book ${sign(d.book)} vs ledger ${sign(d.ledger_net)} · drift ${sign(d.drift)}${fid}`;
}
