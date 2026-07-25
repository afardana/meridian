// db/tick-store.js — temporary real-time price/bin tick ring (DATA CAPTURE ONLY).
//
// Persists the per-tick price/bin data the agent already computes but currently
// throws away: the fast PnL poller (pnl_pct + active_bin per open position, every
// ~3s) and the WebSocket bin-change handler (active_bin per subscribed pool). The
// rows are ground truth for the replay harness's snapshot-density modelling,
// crash/trailing-TP threshold calibration, and anomaly cross-checks.
//
// DATA-ONLY this phase: nothing reads price_ticks for live/money-path decisions.
// Ships ON under the pg backend; the kill switch is env TICK_STORE_DISABLED=1
// (there is no behavior/money-path impact either way, so it stays on by default).
// No-op entirely under the json backend.
//
// Design mirrors balance-history's normalized-table precedent (INSERT per sample
// + count/age retention) and doc-store's ordered write-through (a _writeChain
// promise so concurrent writes can't clobber each other):
//   • recordTick() is SYNCHRONOUS, NEVER throws, and only pushes onto an
//     in-process buffer — safe to call from the money-path poller/socket hot loop.
//   • A batched multi-row INSERT drains the buffer every FLUSH_MS, or immediately
//     once it reaches BUFFER_LIMIT rows, chained on _writeChain so the flushes are
//     ordered and can't overlap.
//   • Socket ticks are DEDUPED on unchanged active_bin (see recordTick): the
//     websocket fires on every lbPair account write (~2/s per pool), but 98.8% of
//     those rows repeated the previous active_bin — measured over 470,885 captured
//     socket rows on 2026-07-25, only 5,445 were real bin transitions (86× dupes).
//     A repeated bin carries no information a transition + its timestamp doesn't
//     (dwell time is recoverable from the next change), so dropping them is
//     lossless for analysis and is what makes a long retention window affordable.
//   • Retention: a RETENTION_HOURS DELETE runs at most once per hour, piggybacked
//     on a flush. Widened 72h → 30d together with the dedupe above: bin-level
//     history is the ground truth for exit-rule counterfactuals, and a 72h ring
//     capped those studies at ~25 closes / 3 disasters. Post-dedupe this costs
//     LESS disk than the old 72h ring did (222 MB/3d → ~1 MB/3d of transitions).
//   • flushTicks() drains everything for the graceful-shutdown path.

import { usePg, query } from "./pool.js";

const FLUSH_MS = 30_000;                    // time-based flush cadence
const BUFFER_LIMIT = 200;                   // size-based flush trigger
const RETENTION_INTERVAL_MS = 60 * 60_000;  // prune at most hourly
const RETENTION_HOURS = 720;                // 30d of bin-level history (dedupe makes this cheap)
const COLS = 7;                             // pool, position, ts, active_bin, pnl_pct, price, source
// Safety valve: if the DB is unreachable for a long stretch the buffer would grow
// unbounded. Cap it — these are discardable telemetry, so drop the oldest on overflow.
const MAX_BUFFER = 5_000;

let _buffer = [];
let _writeChain = Promise.resolve();
let _flushTimer = null;
let _lastRetentionAt = 0;
// Last active_bin recorded per pool, for socket dedupe. Bounded by the number of
// pools we hold positions in (a handful), and cleared with the module's lifetime.
const _lastSocketBin = new Map();

/** Capture is on under pg unless explicitly killed via env. */
function enabled() {
  return usePg() && process.env.TICK_STORE_DISABLED !== "1";
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null; // preserves 0 and negative bin ids
}

/**
 * Record one tick. SYNCHRONOUS and NEVER throws — a data-capture fault must never
 * touch the money path. No-op unless the pg backend is active and capture is on.
 *
 * @param {object} t
 * @param {string} t.pool_address        required
 * @param {string} [t.position_address]  null for socket ticks (pool-level events)
 * @param {number} [t.active_bin]         active bin id (may be negative/zero)
 * @param {number} [t.pnl_pct]            position PnL % (poller only)
 * @param {number} [t.price]              price (reserved; not yet emitted by callers)
 * @param {string} t.source              'poller' | 'socket'
 */
export function recordTick(t) {
  try {
    if (!enabled()) return;
    if (!t || !t.pool_address || !t.source) return;
    // Socket dedupe: drop a pool-level tick that repeats the last bin we recorded
    // for that pool. Only ever applied to bin-only socket rows — poller rows carry
    // pnl_pct (which changes while the bin holds steady) and are never deduped.
    if (t.source === "socket" && t.pnl_pct == null) {
      const bin = toNum(t.active_bin);
      if (bin == null) return; // a socket row with no bin carries nothing
      if (_lastSocketBin.get(t.pool_address) === bin) return;
      _lastSocketBin.set(t.pool_address, bin);
    }
    _buffer.push({
      pool_address: t.pool_address,
      position_address: t.position_address ?? null,
      ts: new Date(), // record-time, not flush-time — accurate for replay ordering
      active_bin: toNum(t.active_bin),
      pnl_pct: toNum(t.pnl_pct),
      price: toNum(t.price),
      source: t.source,
    });
    if (_buffer.length > MAX_BUFFER) _buffer.splice(0, _buffer.length - MAX_BUFFER);
    ensureTimer();
    if (_buffer.length >= BUFFER_LIMIT) drain();
  } catch {
    // swallow — never throw to the caller
  }
}

/** Lazily start the periodic flush timer on first tick. Unref'd so it can't hold the process open. */
function ensureTimer() {
  if (_flushTimer || !usePg()) return;
  _flushTimer = setInterval(drain, FLUSH_MS);
  if (typeof _flushTimer.unref === "function") _flushTimer.unref();
}

/** Move the buffered rows onto the ordered write chain. Returns the chain promise. */
function drain() {
  if (!_buffer.length) return _writeChain;
  const batch = _buffer;
  _buffer = [];
  _writeChain = _writeChain
    .then(() => flushBatch(batch))
    .then(() => maybePrune())
    // A failed flush drops that batch (discardable telemetry) rather than
    // re-queueing — re-queueing on a persistent outage would grow unbounded.
    .catch((err) => console.error("[db] price_ticks flush failed (dropped batch):", err.message));
  return _writeChain;
}

/** Batched, parameterized multi-row INSERT. ≤200 rows × 7 cols = ≤1400 params (< 65535 limit). */
async function flushBatch(batch) {
  const tuples = [];
  const params = [];
  for (let i = 0; i < batch.length; i++) {
    const t = batch[i];
    const b = i * COLS;
    tuples.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`);
    params.push(t.pool_address, t.position_address, t.ts, t.active_bin, t.pnl_pct, t.price, t.source);
  }
  await query(
    "INSERT INTO price_ticks (pool_address, position_address, ts, active_bin, pnl_pct, price, source) VALUES " +
      tuples.join(", "),
    params,
  );
}

/** Bounded ring — drop ticks older than RETENTION_HOURS, at most once per hour. */
async function maybePrune() {
  const now = Date.now();
  if (now - _lastRetentionAt < RETENTION_INTERVAL_MS) return;
  _lastRetentionAt = now;
  await query("DELETE FROM price_ticks WHERE ts < now() - make_interval(hours => $1::int)", [RETENTION_HOURS]);
}

/** Drain all buffered + pending writes and stop the timer. Wired into the shutdown drain. */
export async function flushTicks() {
  try {
    drain();
    await _writeChain;
  } catch {
    /* never throw from shutdown */
  } finally {
    if (_flushTimer) {
      clearInterval(_flushTimer);
      _flushTimer = null;
    }
  }
}

/**
 * Read helper for FUTURE consumers (nothing in the money path uses this yet).
 * Returns ticks for a pool within the last `minutes`, oldest→newest. pg only.
 */
export async function getRecentTicks(pool_address, minutes = 60) {
  if (!usePg() || !pool_address) return [];
  const { rows } = await query(
    "SELECT ts, position_address, active_bin, pnl_pct, price, source FROM price_ticks " +
      "WHERE pool_address = $1 AND ts >= now() - make_interval(mins => $2::int) ORDER BY ts ASC",
    [pool_address, Math.max(1, Math.floor(Number(minutes) || 60))],
  );
  return rows;
}
