// Short-retention position liquidity telemetry for dashboard movement views.
// This is deliberately separate from price_ticks: it records mark-to-market
// value and per-leg USD contributions, not price/bin replay data.
import { query, usePg } from "./pool.js";

const FLUSH_MS = 15_000;
const BUFFER_LIMIT = 200;
const RETENTION_MS = 72 * 60 * 60 * 1000;

let _buffer = [];
let _flushTimer = null;
let _writeChain = Promise.resolve();
let _lastRetentionAt = 0;

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function recordLiquidityTicks(positions = [], capturedAt = new Date()) {
  try {
    if (!usePg() || !Array.isArray(positions)) return;
    for (const position of positions) {
      const liquidityUsd = finiteOrNull(position?.total_value_true_usd);
      if (!position?.position || liquidityUsd == null || liquidityUsd < 0) continue;
      const solPrice = finiteOrNull(position?.sol_price_usd);
      _buffer.push({
        position_address: String(position.position),
        pool_address: position.pool ? String(position.pool) : null,
        pair: position.pair ? String(position.pair) : null,
        captured_at: capturedAt,
        liquidity_usd: liquidityUsd,
        liquidity_sol: solPrice > 0 ? liquidityUsd / solPrice : null,
        liq_x_usd: finiteOrNull(position.liq_x_usd),
        liq_y_usd: finiteOrNull(position.liq_y_usd),
        valuation_quality: position.pnl_quality ? String(position.pnl_quality) : null,
        value_valid: position.pnl_quality !== "missing_price" && position.pnl_quality !== "missing_asset_metadata",
      });
    }
    if (!_buffer.length) return;
    ensureTimer();
    if (_buffer.length >= BUFFER_LIMIT) drain();
  } catch {
    // Dashboard telemetry must never touch the trading loop.
  }
}

function ensureTimer() {
  if (_flushTimer || !usePg()) return;
  _flushTimer = setInterval(drain, FLUSH_MS);
  _flushTimer.unref?.();
}

function drain() {
  if (!_buffer.length) return _writeChain;
  const batch = _buffer;
  _buffer = [];
  _writeChain = _writeChain
    .then(() => flushBatch(batch))
    .then(() => maybePrune())
    .catch((error) => console.error("[db] position liquidity tick flush failed (dropped batch):", error.message));
  return _writeChain;
}

async function flushBatch(batch) {
  const tuples = [];
  const params = [];
  for (let i = 0; i < batch.length; i++) {
    const row = batch[i];
    const base = i * 10;
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`);
    params.push(
      row.position_address,
      row.pool_address,
      row.pair,
      row.captured_at,
      row.liquidity_usd,
      row.liquidity_sol,
      row.liq_x_usd,
      row.liq_y_usd,
      row.valuation_quality,
      row.value_valid,
    );
  }
  await query(
    "INSERT INTO position_liquidity_ticks (position_address, pool_address, pair, captured_at, liquidity_usd, liquidity_sol, liq_x_usd, liq_y_usd, valuation_quality, value_valid) VALUES " + tuples.join(", "),
    params,
  );
}

async function maybePrune() {
  const now = Date.now();
  if (now - _lastRetentionAt < 60 * 60 * 1000) return;
  _lastRetentionAt = now;
  await query("DELETE FROM position_liquidity_ticks WHERE captured_at < now() - interval '72 hours'");
}

export async function flushLiquidityTicks() {
  try {
    drain();
    await _writeChain;
  } catch {
    // Best effort during shutdown.
  } finally {
    if (_flushTimer) clearInterval(_flushTimer);
    _flushTimer = null;
  }
}
