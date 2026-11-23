// exit-baseline.js — a post-close probe baseline for closes the bot only reconciles (2026-11-24).
//
// The post-close probe (index.js runPostCloseProbes, plan #05) compares the pool's mcap 30 /
// 60 / 180 min after a close with `exit_mcap` on the perf record. Only the bot's own close
// (tools/dlmm.js closePosition) fetches that: one pool-discovery read right before
// recordPerformance → exit_mcap / exit_tvl / exit_volume. A close made in the Meteora UI is
// recorded later by reconcileExternallyClosedPosition (pnl_source "external_reconcile"),
// whose record had no exit market at all, so the probe marked every such record
// `unprobeable` at once and the operator's own exits could never be graded.
//
// Now the reconcile reads the same pool row once, fire-and-forget, AFTER the record is
// written, and stamps the baseline with its source and lag (the reconcile runs up to a
// management cycle — or more, when the closed API was late — after the real close):
//   exit_baseline_source "reconcile", exit_baseline_at, exit_baseline_lag_sec.
// A failed read leaves the record exactly as before (the probe then marks it unprobeable).
// While the read is in flight the probe leaves the record alone (isExitBaselinePending), so
// the two cannot race. Data capture only — no rule reads any of this.
//
// Leaf module (no imports).

/** The close path's own parse of a pool-discovery row (tools/dlmm.js closePosition). */
export function exitMarketFromPoolRow(row) {
  if (!row || typeof row !== "object") return null;
  const m = {
    exit_mcap: parseFloat(row?.token_x?.market_cap) || null,
    exit_tvl: parseFloat(row?.tvl ?? row?.active_tvl) || null,
    exit_volume: parseFloat(row?.volume) || null,
  };
  return m.exit_mcap != null ? m : null; // without an mcap the probe has no baseline
}

/**
 * Apply a reconcile-time baseline to a perf record (mutates `rec`). Only a record that has
 * no exit_mcap and whose probes have not been settled is touched; existing exit fields are
 * never overwritten. Returns true when the record changed.
 */
export function applyExitBaseline(rec, market, { source = "reconcile", nowMs = Date.now() } = {}) {
  if (!rec || !market || market.exit_mcap == null) return false;
  if (rec.exit_mcap != null) return false;
  if (rec.post_close?.complete) return false; // already settled (e.g. marked unprobeable) — leave it
  rec.exit_mcap = market.exit_mcap;
  if (rec.exit_tvl == null && market.exit_tvl != null) rec.exit_tvl = market.exit_tvl;
  if (rec.exit_volume == null && market.exit_volume != null) rec.exit_volume = market.exit_volume;
  rec.exit_baseline_source = source;
  rec.exit_baseline_at = new Date(nowMs).toISOString();
  const closedMs = Date.parse(rec.recorded_at);
  rec.exit_baseline_lag_sec = Number.isFinite(closedMs) ? Math.max(0, Math.round((nowMs - closedMs) / 1000)) : null;
  if (rec.post_close && rec.post_close.exit_mcap == null) rec.post_close.exit_mcap = market.exit_mcap;
  return true;
}

// In-flight reads, so the probe does not mark a record unprobeable while its baseline is on
// the way. In memory: a restart drops them and the record is treated as before.
const PENDING_TTL_MS = 2 * 60_000;
const _pending = new Map(); // position → started ms

export function markExitBaselinePending(position, nowMs = Date.now()) {
  if (position) _pending.set(position, nowMs);
}
export function clearExitBaselinePending(position) {
  _pending.delete(position);
}
export function isExitBaselinePending(position, nowMs = Date.now()) {
  const t = _pending.get(position);
  if (t == null) return false;
  if (nowMs - t > PENDING_TTL_MS) { _pending.delete(position); return false; }
  return true;
}
