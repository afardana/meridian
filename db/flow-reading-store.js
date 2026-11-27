// db/flow-reading-store.js — the flow guard's market-flow readings (DATA CAPTURE ONLY, 2026-11-27).
//
// Every usable Jupiter reading the flow guard takes (an armed position, or the log-only shadow
// on the others) is kept here so the guard's thresholds can be replayed later — no historical
// buy/sell flow data exists anywhere else. At most one row per position per management cycle
// (the caller writes once per position per cycle). Nothing reads it for live decisions.
//
//   • pg backend: INSERT into `flow_readings` (migration 009_flow_readings.sql), chained on one
//     promise so the writes are ordered; never awaited by the caller.
//   • the table not existing yet (migration not run), or any other insert error → the row goes
//     to the JSONL fallback below instead, so nothing is lost before `npm run db:migrate`.
//   • json backend: JSONL `flow-readings.jsonl` under dataPath() (append-only).
// recordFlowReading() is SYNCHRONOUS and NEVER throws.

import fs from "fs";
import { usePg, query } from "./pool.js";
import { dataPath } from "../repo-root.js";

export const FLOW_READINGS_FILE = "flow-readings.jsonl";

let _writeChain = Promise.resolve();
let _warnedAt = 0;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The compact row for one reading. `reading` is flow-guard.js readFlowAsset's output.
 * Volumes / price in USD; price changes in %.
 */
export function flowReadingRow({ position, pool = null, kind, reading, conditions = [], nowMs = Date.now() }) {
  const w = (s) => s || {};
  const s5 = w(reading?.s5m), s1 = w(reading?.s1h);
  return {
    position_address: position,
    pool_address: pool ?? null,
    mint: reading?.mint ?? null,
    ts: reading?.at ?? new Date(nowMs).toISOString(),
    kind,
    conditions: Array.isArray(conditions) ? conditions.filter((c) => typeof c === "string") : [],
    data: {
      buy_5m: num(s5.buy), sell_5m: num(s5.sell), buy_1h: num(s1.buy), sell_1h: num(s1.sell),
      price_change_5m: num(s5.price_change), price_change_1h: num(s1.price_change),
      liquidity_usd: num(reading?.liquidity_usd), holders: num(reading?.holders), price_usd: num(reading?.price_usd),
      num_buys_5m: num(s5.num_buys), num_sells_5m: num(s5.num_sells), num_traders_5m: num(s5.num_traders),
      num_buys_1h: num(s1.num_buys), num_sells_1h: num(s1.num_sells), num_traders_1h: num(s1.num_traders),
      jupiter_updated_at: reading?.updated_at ?? null,
    },
  };
}

function appendJsonl(row) {
  try {
    fs.appendFileSync(dataPath(FLOW_READINGS_FILE), JSON.stringify(row) + "\n");
  } catch (e) {
    warn(`flow_readings JSONL append failed: ${e.message}`);
  }
}

function warn(msg) {
  if (Date.now() - _warnedAt < 10 * 60_000) return;
  _warnedAt = Date.now();
  console.error(`[db] ${msg}`);
}

/** Record one reading. Synchronous, never throws, never awaited on a money path. */
export function recordFlowReading(args) {
  try {
    if (!args?.position || !args?.reading?.ok || !args?.kind) return;
    const row = flowReadingRow(args);
    if (!row.mint) return;
    if (!usePg()) { appendJsonl(row); return; }
    _writeChain = _writeChain
      .then(() => query(
        "INSERT INTO flow_readings (position_address, pool_address, mint, ts, kind, conditions, data) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [row.position_address, row.pool_address, row.mint, row.ts, row.kind, row.conditions, JSON.stringify(row.data)],
      ))
      .catch((err) => {
        warn(`flow_readings insert failed (${err.code === "42P01" ? "table missing — run npm run db:migrate" : err.message}); kept in ${FLOW_READINGS_FILE}`);
        appendJsonl(row);
      });
  } catch {
    /* data capture only — never throw */
  }
}

/** Drain pending writes (graceful shutdown / tests). */
export function flushFlowReadings() {
  return _writeChain.catch(() => {});
}
