// db/lane-paper-store.js — storage for the fresh top-performer lane's paper trades (plan 16,
// Phase 1; CAPTURE ONLY — nothing on the money path reads it).
//
//   pg backend:   tables lane_paper_trades / lane_paper_ticks (migration 008). Every write goes
//                 on an in-process queue that a timer drains in order on ONE chained promise,
//                 so a write never blocks the caller and never runs out of order. A failing
//                 write (tables not migrated yet, DB down) drops that batch and logs once per
//                 10 min per cause — the capture is discardable telemetry.
//   json backend: two append-only JSONL files under dataPath() (lane-paper-trades.jsonl: one
//                 line per insert or update, merged by id on load; lane-paper-ticks.jsonl), so
//                 the tests run without pg.
// No retention deletes (keep all history).
import fs from "node:fs";
import { usePg, query as pgQuery } from "./pool.js";
import { dataPath } from "../repo-root.js";

export const TRADES_FILE = "lane-paper-trades.jsonl";
export const TICKS_FILE = "lane-paper-ticks.jsonl";
const FLUSH_MS = 5_000;
const BATCH_LIMIT = 50;
// Bound on everything not yet written: the unsent queue PLUS the batches already handed to the
// write chain. Beyond it the oldest queued ticks are dropped (trades / updates are kept).
export const MAX_PENDING = 5_000;
// One hung query must not hold the chain forever: each write is abandoned after this long (the
// statement may still finish in PostgreSQL; the chain moves on).
export const WRITE_TIMEOUT_MS = 15_000;
const ERROR_LOG_MS = 10 * 60_000;

const TICK_COLS = ["trade_id", "at", "seen", "active_bin", "price", "tvl", "active_tvl", "fee_usd", "fee_window_min", "fee_bucket_start", "fee_time_source", "fee_1h_usd", "volume_usd", "market_cap", "holders", "rank", "sol_price_usd", "sell_quote"];

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`write timed out after ${ms} ms`), { code: "TIMEOUT" })), ms); if (typeof timer.unref === "function") timer.unref(); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

const fin = (v) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const intOrNull = (v) => { const n = fin(v); return n == null ? null : Math.round(n); };

export function createLanePaperStore({ backend = usePg() ? "pg" : "json", query: rawQuery = pgQuery, dir = null, log = () => {}, now = () => Date.now(), maxPending = MAX_PENDING, writeTimeoutMs = WRITE_TIMEOUT_MS } = {}) {
  const query = (q, p) => withTimeout(Promise.resolve().then(() => rawQuery(q, p)), writeTimeoutMs);
  // Trade ids whose insert failed (json append error, pg error / timeout): their ticks and updates
  // are dropped, and the runtime forgets the trade (isFailed) — no tick for a trade never persisted.
  const failedIds = new Set();
  const errAt = new Map();
  const noteError = (cause, e) => {
    const t = now();
    if (errAt.has(cause) && t - errAt.get(cause) < ERROR_LOG_MS) return;
    errAt.set(cause, t);
    const missing = e?.code === "42P01" ? " — tables absent, run npm run db:migrate (capture dropped until then)" : "";
    try { log("fresh_lane", `[FRESH_LANE] store ${cause} failed: ${String(e?.message || e).split("\n")[0]}${missing} (muted 10 min)`); } catch { /* never throw */ }
  };
  const file = (name) => (dir ? `${dir}/${name}` : dataPath(name));

  // ── json ──
  const appendLine = (name, obj) => {
    try { fs.appendFileSync(file(name), JSON.stringify(obj) + "\n"); return true; } catch (e) { noteError(`append ${name}`, e); return false; }
  };

  // ── pg queue ──
  let queue = [];
  let inChain = 0; // ops handed to the write chain and not finished
  let chain = Promise.resolve();
  let timer = null;
  const ensureTimer = () => {
    if (timer) return;
    timer = setInterval(() => { drain(); }, FLUSH_MS);
    if (typeof timer.unref === "function") timer.unref();
  };
  let dropped = 0;
  const push = (op) => {
    queue.push(op);
    let over = queue.length + inChain - maxPending;
    if (over > 0) {
      // drop the oldest queued ticks first; never a trade or an update
      const kept = [];
      for (const q of queue) { if (over > 0 && q.kind === "tick") { over--; dropped++; continue; } kept.push(q); }
      queue = kept;
      noteError("backlog", new Error(`${dropped} tick(s) dropped so far: ${queue.length + inChain} writes pending (cap ${maxPending})`));
    }
    ensureTimer();
    if (queue.length >= BATCH_LIMIT) drain();
  };
  async function runBatch(batch) {
    // consecutive ticks go out as one multi-row insert; trades / updates one by one, in order
    let ticks = [];
    const flushTicks = async () => {
      if (!ticks.length) return;
      const rows = ticks.filter((t) => !failedIds.has(t.trade_id)); ticks = [];
      if (!rows.length) return;
      const params = [];
      const values = rows.map((t, i) => {
        const base = i * TICK_COLS.length;
        params.push(t.trade_id, t.at, t.seen !== false, intOrNull(t.active_bin), fin(t.price), fin(t.tvl), fin(t.active_tvl), fin(t.fee_usd), fin(t.fee_window_min), t.fee_bucket_start ?? null, t.fee_time_source ?? null, fin(t.fee_1h_usd), fin(t.volume_usd), fin(t.market_cap), intOrNull(t.holders), intOrNull(t.rank), fin(t.sol_price_usd), t.sell_quote ? JSON.stringify(t.sell_quote) : null);
        return `(${TICK_COLS.map((_, j) => `$${base + j + 1}`).join(",")})`;
      });
      try { await query(`INSERT INTO lane_paper_ticks (${TICK_COLS.join(",")}) VALUES ${values.join(",")}`, params); } catch (e) { noteError("tick insert", e); }
    };
    for (const op of batch) {
      if (op.kind === "tick") { ticks.push(op.row); continue; }
      await flushTicks();
      try {
        if (op.kind === "trade") {
          const t = op.row;
          await query(
            "INSERT INTO lane_paper_trades (id, pool, base_mint, pair, lane, position, entered_at, track_hours, entry, status, ended_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) ON CONFLICT (id) DO NOTHING",
            [t.id, t.pool, t.base_mint ?? null, t.pair ?? null, t.lane, t.position ?? null, t.entered_at, t.track_hours, JSON.stringify(t.entry ?? {}), t.status || "open", t.ended_at ?? null],
          );
        } else if (op.kind === "update") {
          if (failedIds.has(op.id)) continue;
          const f = op.fields;
          await query(
            "UPDATE lane_paper_trades SET entry = COALESCE($2::jsonb, entry), status = COALESCE($3, status), ended_at = COALESCE($4, ended_at) WHERE id = $1",
            [op.id, f.entry ? JSON.stringify(f.entry) : null, f.status ?? null, f.ended_at ?? null],
          );
        }
      } catch (e) {
        if (op.kind === "trade") failedIds.add(op.row.id); // its ticks / updates are dropped from here on
        noteError(`${op.kind} write`, e);
      }
    }
    await flushTicks();
  }
  function drain() {
    if (!queue.length) return chain;
    const batch = queue; queue = [];
    inChain += batch.length;
    chain = chain.then(() => runBatch(batch)).catch((e) => noteError("flush", e)).finally(() => { inChain -= batch.length; });
    return chain;
  }

  const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { noteError("call", e); return undefined; } };

  return {
    backend,
    insertTrade: safe((t) => {
      if (!t?.id) return;
      if (backend === "pg") push({ kind: "trade", row: t });
      else if (!appendLine(TRADES_FILE, { ...t, _op: "insert" })) failedIds.add(t.id);
    }),
    updateTrade: safe((id, fields = {}) => {
      if (!id || failedIds.has(id)) return;
      if (backend === "pg") push({ kind: "update", id, fields });
      else appendLine(TRADES_FILE, { id, ...fields, _op: "update" });
    }),
    insertTick: safe((tick) => {
      if (!tick?.trade_id || failedIds.has(tick.trade_id)) return;
      if (backend === "pg") push({ kind: "tick", row: tick });
      else appendLine(TICKS_FILE, tick);
    }),
    /** True once the trade's insert is known to have failed (it must then be forgotten). */
    isFailed: (id) => failedIds.has(id),
    /**
     * Trades entered at or after sinceMs (both lanes), oldest first. Never throws: null when the
     * read failed (the caller retries later), [] when there is nothing.
     */
    async loadRecent(sinceMs) {
      try {
        if (backend === "pg") {
          const r = await query(
            "SELECT id, pool, base_mint, pair, lane, position, entered_at, track_hours, entry, status, ended_at FROM lane_paper_trades WHERE entered_at >= $1 ORDER BY entered_at",
            [new Date(sinceMs).toISOString()],
          );
          return (r.rows || []).map((x) => ({ ...x, entered_at: new Date(x.entered_at).toISOString(), ended_at: x.ended_at ? new Date(x.ended_at).toISOString() : null, track_hours: Number(x.track_hours) }));
        }
        return readJsonTrades(file(TRADES_FILE)).filter((t) => Date.parse(t.entered_at) >= sinceMs);
      } catch (e) { noteError("load", e); return null; }
    },
    /** Drain everything queued (shutdown / tests). Never rejects. */
    flush() { if (backend !== "pg") return Promise.resolve(); return drain().catch(() => {}); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    _queueLength: () => queue.length,
    _pending: () => queue.length + inChain,
  };
}

/** Merge the JSONL trade lines by id (insert then updates), oldest entry first. */
export function readJsonTrades(path) {
  let text = "";
  try { text = fs.readFileSync(path, "utf8"); } catch { return []; }
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o?.id) continue;
    const { _op, ...rest } = o;
    const prev = byId.get(o.id);
    if (_op === "update") { if (prev) byId.set(o.id, { ...prev, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null)) }); }
    else if (!prev) byId.set(o.id, rest);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.entered_at) - Date.parse(b.entered_at));
}
export function readJsonTicks(path) {
  let text = "";
  try { text = fs.readFileSync(path, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* skip */ } }
  return out;
}
