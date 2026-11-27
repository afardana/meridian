// fresh-lane-paper.js — the fresh top-performer lane's paper capture (plan 16, Phase 1).
//
// CAPTURE ONLY. This module never sends a transaction, never calls an LLM, never changes a live
// rule, size, admission or exit, and nothing on the trading paths reads what it writes. Every
// external call is injected (tests pass fakes; index.js passes the real ones) and every failure is
// caught here: a throwing fetch, a 429, a DB error or a bug in this file is logged (once per cause
// per 10 min) and the poll simply ends. The caller's timer never sees an exception.
//
// Per poll (own timer, freshLanePollSec, default 45 s; independent of the position cap, the
// screening / management busy-guards and the LLM; the discovery reads always run, only the QUOTES
// are skipped while a close / exit swap / deploy / straddle may be in flight — deps.quotesPaused):
//   1. ONE discovery request: Meteora's "Top Performers · DLMM · 2h" list with the UI's floors.
//   2. Ranks 1–5 that pass the cheap row checks and the one-entry-per-episode rule get the token
//      safety reads (cached; ≤ SAFETY_READS_PER_POLL new reads per poll): the mint account
//      (jsonParsed, read-only RPC pool) and Jupiter's asset search (token fees + audit, via
//      getTokenInfo — the same figure the main screening gate reads). A pool passing the whole
//      definition opens a paper entry (lane "paper") and logs [FRESH_LANE_SHADOW] would-enter.
//   3. Operator positions the bot adopted in the lane's class (noteOperatorAdoption, called after
//      the adoption enricher — no network call on the adoption path) are opened as lane
//      "operator" entries with the same snapshot and safety reads.
//   4. ONE batched request (5-minute timeframe) for every open entry → one tick per entry (raw
//      bucket fee + its bucket start from the response's Date header); once per 5-min bucket a
//      second batch at timeframe=1h (fee_1h_usd, the fallback for a skipped bucket).
//   5. Read-only Jupiter quotes (skip_taker): a ◎0.5 buy at entry (tried on the entry poll and the
//      next 2 polls on which a quote may run, ≤ 5 min), then a sell of that base amount — of
//      ◎0.5 / price worth when no buy quote came (entry_quote "missing") — at entry and every
//      15 min per open entry; ≤ QUOTES_PER_MIN overall; a 429 pauses quotes 60 s, never retried in
//      a loop.
// Nothing is captured until the restore of recent entries from the store succeeded (retried every
// 10 min), so an open entry in the store is never duplicated; a trade whose insert failed is
// forgotten (no tick is written for it).
import {
  LANE_ID, SOL_MINT, LANE_DEFINITION, laneListUrl, laneTrackUrl, laneRowChecks, laneSafetyChecks,
  laneQualifies, laneSnapshot, tickFromRow, unseenTick, episodeAllows, wouldEnterLine,
  parseRateHeaders, parseMintSafety, freshLaneConfig, TRACK_BATCH_MAX, LANE_REENTRY_GAP_HOURS,
  serverTimeOf, feeBucketStart,
} from "./fresh-lane.js";
import fs from "node:fs";

export const SAFETY_READS_PER_POLL = 2;
export const SAFETY_TTL_OK_MS = 6 * 3_600_000;
export const SAFETY_TTL_FAIL_MS = 10 * 60_000;
export const QUOTES_PER_MIN = 4;
export const QUOTE_BACKOFF_429_MS = 60_000;
export const SELL_QUOTE_EVERY_MS = 15 * 60_000;
export const ENTRY_QUOTE_MAX_DELAY_MS = 5 * 60_000;
export const ENTRY_QUOTE_MAX_ATTEMPTS = 3;
export const BUY_QUOTE_LAMPORTS = 500_000_000; // ◎0.5 = shape P's base side on ◎1 unit capital
export const API_429_BACKOFF_MS = 10 * 60_000;
export const API_LOW_REMAINING = 5;
export const ERROR_LOG_MS = 10 * 60_000;
export const SUMMARY_EVERY_MS = 60 * 60_000;
export const OPERATOR_RANK_FRESH_MS = 10 * 60_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const QUOTE_TIMEOUT_MS = 10_000;
export const RESTORE_RETRY_MS = 10 * 60_000;
export const VANISH_UNSEEN_POLLS = 20; // ≈ 15 min missing from the batch answer → ended "vanished"
export const OPERATOR_NOTE_MAX_AGE_MS = 6 * 3_600_000;
const H = 3_600_000;

const num = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const msOf = (t) => (typeof t === "number" ? t : Date.parse(t));
const errMsg = (e) => String(e?.message || e).split("\n")[0].slice(0, 200);

function withTimeout(promise, ms, what) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); if (typeof timer.unref === "function") timer.unref(); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * deps: { getConfig() → config.screening, fetchImpl, discoveryBase, getTokenInfo({query}),
 *   readMintAccount(mint) → jsonParsed getAccountInfo value, getQuote({input_mint, output_mint,
 *   amount_raw, skip_taker}), isBlacklisted(mint), isDevBlocked(dev), store (db/lane-paper-store.js),
 *   log(category, message), quotesPaused() → bool, pendingFile (path for the operator notes, or
 *   null), now() → ms }
 */
export function createFreshLane(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const logRaw = typeof deps.log === "function" ? deps.log : () => {};
  const log = (msg) => { try { logRaw("fresh_lane", msg); } catch { /* never throw */ } };
  const store = deps.store;

  const trades = new Map();        // id → open trade (both lanes)
  const paperByPool = new Map();   // pool → [{ entered_at, track_hours }]
  const operatorByPosition = new Set();
  const pendingOperator = new Map(); // position → { pool, row, owner, at, rank, rankFresh }
  const safetyCache = new Map();   // mint → { at, ttl, value }
  const listRank = new Map();      // pool → { rank, at }
  const errAt = new Map();
  let quoteTimes = [];
  let quoteBackoffUntil = 0;
  let apiBackoffUntil = 0;
  let restored = false;
  let lastRestoreAt = -Infinity;
  let hourBucketRead = null;       // bucket start (ms) of the last timeframe=1h batch
  let busy = false;
  let lastSummaryAt = now();
  const stats = freshStats();
  function freshStats() { return { polls: 0, restoreWait: 0, quotesPaused: 0, backoff: 0, rows: 0, rowPass: 0, qualifying: 0, entries: 0, operator: 0, quotes: 0, quote429: 0, ticks: 0, missingQuote: 0, errors: 0 }; }

  function noteError(cause, e) {
    stats.errors++;
    const t = now();
    if (errAt.has(cause) && t - errAt.get(cause) < ERROR_LOG_MS) return;
    errAt.set(cause, t);
    log(`[FRESH_LANE] ${cause} failed: ${errMsg(e)} (further ${cause} errors muted 10 min)`);
  }

  async function fetchJson(url, what) {
    const f = deps.fetchImpl || fetch;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
    if (timer && typeof timer.unref === "function") timer.unref();
    try {
      const res = await f(url, ctrl ? { signal: ctrl.signal } : undefined);
      const t = now();
      const rate = parseRateHeaders(res?.headers, t);
      if (res?.status === 429) {
        apiBackoffUntil = t + API_429_BACKOFF_MS;
        throw new Error(`${what}: 429 rate limited — lane paused 10 min`);
      }
      if (rate.remaining != null && rate.remaining <= API_LOW_REMAINING) {
        apiBackoffUntil = Math.max(apiBackoffUntil, Math.min(t + API_429_BACKOFF_MS, rate.resetMs ?? t + 10_000));
      }
      if (!res?.ok) throw new Error(`${what}: HTTP ${res?.status}`);
      return { body: await res.json(), serverMs: serverTimeOf(res?.headers) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── operator notes survive a restart (small JSON file; optional) ──────────────────────────
  function savePending() {
    if (!deps.pendingFile) return;
    try { fs.writeFileSync(deps.pendingFile, JSON.stringify(Object.fromEntries(pendingOperator))); } catch (e) { noteError("operator note save", e); }
  }
  function loadPending(t) {
    if (!deps.pendingFile) return;
    let o = null;
    try { o = JSON.parse(fs.readFileSync(deps.pendingFile, "utf8")); } catch { return; }
    for (const [position, p] of Object.entries(o || {})) {
      if (!p?.row || !Number.isFinite(p.at) || t - p.at > OPERATOR_NOTE_MAX_AGE_MS) continue;
      if (!operatorByPosition.has(position)) pendingOperator.set(position, p);
    }
    savePending();
  }

  /** Restore recent entries from the store; true once it succeeded (retried every 10 min). */
  async function ensureRestored(t) {
    if (restored) return true;
    if (t - lastRestoreAt < RESTORE_RETRY_MS) return false;
    lastRestoreAt = t;
    let rows = [];
    if (typeof store?.loadRecent === "function") {
      try { rows = await store.loadRecent(t - (24 + LANE_REENTRY_GAP_HOURS) * H); } catch (e) { rows = null; noteError("restore", e); }
    }
    if (!Array.isArray(rows)) { log("[FRESH_LANE] restore of recent lane entries failed — nothing is captured until it succeeds (retry in 10 min)"); return false; }
    for (const r of rows) {
      const entered = msOf(r.entered_at);
      if (!Number.isFinite(entered) || !r.id || !r.pool) continue;
      const trade = {
        id: r.id, pool: r.pool, base_mint: r.base_mint, pair: r.pair, lane: r.lane, position: r.position ?? null,
        entered_at: entered, track_hours: num(r.track_hours) ?? 6, entry: r.entry || {}, status: r.status || "open",
        buyDone: true, // a restart never takes a late entry quote
        sellAttempted: !!r.entry?.quotes?.sell_entry || !!r.entry?.quotes?.buy || r.entry?.entry_quote === "missing",
        nextSellAt: t, unseen: 0,
      };
      if (!trade.entry.quotes) trade.entry.quotes = { buy: null, sell_entry: null };
      if (trade.lane === "paper") { const l = paperByPool.get(trade.pool) || []; l.push({ entered_at: entered, track_hours: trade.track_hours }); paperByPool.set(trade.pool, l); }
      if (trade.lane === "operator" && trade.position) operatorByPosition.add(trade.position);
      if (trade.status === "open") trades.set(trade.id, trade);
    }
    restored = true;
    loadPending(t);
    if (rows.length || pendingOperator.size) log(`[FRESH_LANE] restored ${rows.length} recent lane entr${rows.length === 1 ? "y" : "ies"} (${trades.size} open), ${pendingOperator.size} operator note(s) pending`);
    return true;
  }

  // ── safety reads (cached) ──────────────────────────────────────────────────────────────────
  async function safetyFor(mint, budget) {
    const t = now();
    const c = safetyCache.get(mint);
    if (c && t - c.at < c.ttl) return c.value;
    if (budget.left <= 0) return undefined; // next poll
    budget.left--;
    let mintValue = null, mintErr = null;
    try { mintValue = await withTimeout(Promise.resolve(deps.readMintAccount(mint)), FETCH_TIMEOUT_MS, "mint read"); } catch (e) { mintErr = e; }
    let info = null, infoErr = null;
    try { info = await withTimeout(Promise.resolve(deps.getTokenInfo({ query: mint })), FETCH_TIMEOUT_MS, "token info"); } catch (e) { infoErr = e; }
    if (mintErr) noteError("mint read", mintErr);
    if (infoErr) noteError("token info", infoErr);
    const match = (info?.results || []).find((r) => r?.mint === mint) || null;
    const value = {
      at: new Date(t).toISOString(),
      mint: mintErr ? { read: false } : parseMintSafety(mintValue),
      fees_sol: num(match?.global_fees_sol),
      jupiter_audit: match?.audit ? {
        mint_disabled: match.audit.mint_disabled ?? null,
        freeze_disabled: match.audit.freeze_disabled ?? null,
        top_holders_pct: num(match.audit.top_holders_pct),
        bot_holders_pct: num(match.audit.bot_holders_pct),
        bundler_pct: num(match.audit.bundler_pct),
        dev_migrations: num(match.audit.dev_migrations),
        dev_mints: num(match.audit.dev_mints),
        dev_balance_pct: num(match.audit.dev_balance_pct),
        insider_pct: num(match.audit.insider_pct),
        sniper_pct: num(match.audit.sniper_pct),
      } : null,
      jupiter_holders: num(match?.holders),
      jupiter_mcap: num(match?.mcap),
    };
    if (mintErr || infoErr) return null; // not cached: read again on a later poll
    const ok = laneSafetyChecks(value).length === 0;
    safetyCache.set(mint, { at: t, ttl: ok ? SAFETY_TTL_OK_MS : SAFETY_TTL_FAIL_MS, value });
    if (safetyCache.size > 500) for (const [k, v] of safetyCache) if (t - v.at > v.ttl) safetyCache.delete(k);
    return value;
  }

  function openTrade(lane, row, safety, rank, t, extra = {}) {
    const cfg = freshLaneConfig(deps.getConfig?.() || {});
    const pool = row.pool_address;
    const id = `${lane}-${pool.slice(0, 8)}-${t}`;
    const entry = { ...laneSnapshot(row, safety, { now: t, rank }), lane, ...extra, entry_quote: null, quotes: { buy: null, sell_entry: null } };
    const trade = {
      id, pool, base_mint: row.token_x?.address ?? null, pair: entry.pair, lane, position: extra.position ?? null,
      entered_at: t, track_hours: cfg.trackHours, entry, status: "open",
      buyAttempts: 0, buyDone: false, sellAttempted: false, nextSellAt: t + SELL_QUOTE_EVERY_MS, unseen: 0,
    };
    trades.set(id, trade);
    store?.insertTrade?.({ id, pool, base_mint: trade.base_mint, pair: trade.pair, lane, position: trade.position, entered_at: new Date(t).toISOString(), track_hours: trade.track_hours, entry, status: "open", ended_at: null });
    return trade;
  }
  /** Forget a trade whose insert failed (its pool may open a new entry later; nothing was stored). */
  function forget(trade) {
    trades.delete(trade.id);
    if (trade.lane === "paper") {
      const l = (paperByPool.get(trade.pool) || []).filter((x) => x.entered_at !== trade.entered_at);
      if (l.length) paperByPool.set(trade.pool, l); else paperByPool.delete(trade.pool);
    }
    if (trade.lane === "operator" && trade.position) operatorByPosition.delete(trade.position);
    noteError("trade insert", new Error(`${trade.pair} (${trade.id}) was not stored — entry dropped, no ticks written for it`));
  }
  function endTrade(trade, t, reason) {
    trade.status = "ended";
    trade.entry.ended_reason = reason;
    store?.updateTrade?.(trade.id, { status: "ended", ended_at: new Date(t).toISOString(), entry: trade.entry });
    trades.delete(trade.id);
  }

  // ── step 2: candidates on the list ─────────────────────────────────────────────────────────
  async function scanList(rows, cfg, t, budget) {
    for (let i = 0; i < rows.length && i < LANE_DEFINITION.maxRank; i++) {
      const row = rows[i];
      const rank = i + 1;
      if (!row?.pool_address) continue;
      stats.rows++;
      if (!episodeAllows(paperByPool.get(row.pool_address), t, cfg.trackHours).ok) continue;
      const rowReasons = laneRowChecks(row, { now: t, rank, isBlacklisted: deps.isBlacklisted, isDevBlocked: deps.isDevBlocked });
      if (rowReasons.length) continue;
      stats.rowPass++;
      const safety = await safetyFor(row.token_x.address, budget);
      if (safety === undefined) continue; // safety-read budget used up this poll
      const q = laneQualifies(row, safety, { now: t, rank, isBlacklisted: deps.isBlacklisted, isDevBlocked: deps.isDevBlocked });
      if (!q.ok) continue;
      stats.qualifying++;
      const trade = openTrade("paper", row, safety, rank, t);
      const l = paperByPool.get(row.pool_address) || [];
      l.push({ entered_at: t, track_hours: trade.track_hours });
      paperByPool.set(row.pool_address, l);
      stats.entries++;
      log(wouldEnterLine(trade.entry, cfg.mode));
    }
  }

  // ── step 3: operator entries ───────────────────────────────────────────────────────────────
  async function processOperators(t, budget) {
    let changed = false;
    for (const [position, p] of [...pendingOperator.entries()]) {
      if (operatorByPosition.has(position)) { pendingOperator.delete(position); changed = true; continue; }
      const mint = p.row?.token_x?.address;
      const safety = mint ? await safetyFor(mint, budget) : null;
      if (safety === undefined) continue; // budget: next poll
      pendingOperator.delete(position); changed = true;
      const fullReasons = [...laneRowChecks(p.row, { now: p.at, rank: p.rank, isBlacklisted: deps.isBlacklisted, isDevBlocked: deps.isDevBlocked }), ...laneSafetyChecks(safety)];
      const trade = openTrade("operator", p.row, safety, p.rank, p.at, {
        position, owner: p.owner ?? "manual", rank_fresh: p.rankFresh,
        qualifies_full: fullReasons.length === 0, full_reasons: fullReasons,
      });
      operatorByPosition.add(position);
      stats.operator++;
      log(`[FRESH_LANE_SHADOW] operator entry captured ${trade.pair} (${position.slice(0, 8)}): rank ${p.rank == null ? "off the 2h list" : `#${p.rank}`}, token age ${trade.entry.token_age_min ?? "?"}m, full lane definition ${fullReasons.length ? `not met (${fullReasons.join("; ")})` : "met"} (freshLaneMode=shadow)`);
    }
    if (changed) savePending();
  }

  // ── step 4 + 5: tracking and quotes ────────────────────────────────────────────────────────
  function quoteBudgetLeft(t) {
    quoteTimes = quoteTimes.filter((x) => t - x < 60_000);
    return t < quoteBackoffUntil ? 0 : QUOTES_PER_MIN - quoteTimes.length;
  }
  async function takeQuote(args, t) {
    quoteTimes.push(t);
    stats.quotes++;
    try {
      return await withTimeout(Promise.resolve(deps.getQuote({ ...args, skip_taker: true })), QUOTE_TIMEOUT_MS, "quote");
    } catch (e) {
      if (/\b429\b/.test(errMsg(e))) { stats.quote429++; quoteBackoffUntil = now() + QUOTE_BACKOFF_429_MS; }
      else noteError("quote", e);
      return null;
    }
  }
  /** Raw base amount the sell quotes use: the buy quote's tokens, else ◎0.5 worth at the price. */
  function baseRaw(trade, tick) {
    const q = trade.entry.quotes;
    if (num(q.buy?.out_raw) > 0) return num(q.buy.out_raw);
    if (num(q.base_raw) > 0) return num(q.base_raw);
    const decX = num(trade.entry.dec_x), price = num(tick?.price);
    if (decX == null || price == null || price <= 0) return null;
    const raw = Math.floor((BUY_QUOTE_LAMPORTS / 1e9 / price) * Math.pow(10, decX));
    if (raw > 0) { q.base_raw = raw; q.base_raw_source = "price"; }
    return raw > 0 ? raw : null;
  }
  async function entryQuotes(trade, tick, t) {
    const q = trade.entry.quotes;
    const decX = num(trade.entry.dec_x);
    if (!trade.buyDone) {
      // the entry poll and the next 2 polls on which a quote may run; never later than 5 min
      if (t - trade.entered_at > ENTRY_QUOTE_MAX_DELAY_MS || trade.buyAttempts >= ENTRY_QUOTE_MAX_ATTEMPTS) {
        trade.buyDone = true;
      } else if (quoteBudgetLeft(t) > 0) {
        trade.buyAttempts++;
        const r = await takeQuote({ input_mint: SOL_MINT, output_mint: trade.base_mint, amount_raw: BUY_QUOTE_LAMPORTS }, t);
        const out = num(r?.out_amount);
        if (out != null && out > 0 && decX != null && num(tick.price) != null) {
          const tokensValueSol = (out / Math.pow(10, decX)) * tick.price;
          q.buy = { at: new Date(t).toISOString(), in_lamports: BUY_QUOTE_LAMPORTS, out_raw: out, price: tick.price, active_bin: tick.active_bin, tokens_value_sol: tokensValueSol, entry_cost_sol: BUY_QUOTE_LAMPORTS / 1e9 - tokensValueSol, price_impact_pct: num(r?.price_impact_pct) };
          trade.entry.entry_quote = "buy";
          trade.buyDone = true;
          store?.updateTrade?.(trade.id, { entry: trade.entry });
        } else if (trade.buyAttempts >= ENTRY_QUOTE_MAX_ATTEMPTS) trade.buyDone = true;
      }
      if (trade.buyDone && !q.buy) {
        trade.entry.entry_quote = "missing";
        stats.missingQuote++;
        store?.updateTrade?.(trade.id, { entry: trade.entry });
      }
    }
    if (trade.buyDone && !q.sell_entry && !trade.sellAttempted && quoteBudgetLeft(t) > 0) {
      trade.sellAttempted = true;
      const s = await sellQuote(trade, tick, t);
      if (s) { q.sell_entry = s; store?.updateTrade?.(trade.id, { entry: trade.entry }); }
    }
  }
  async function sellQuote(trade, tick, t) {
    const decX = num(trade.entry.dec_x);
    const raw = baseRaw(trade, tick);
    if (raw == null || decX == null) return null;
    const r = await takeQuote({ input_mint: trade.base_mint, output_mint: SOL_MINT, amount_raw: raw }, t);
    const out = num(r?.out_amount);
    if (out == null) return null;
    const refSol = num(tick.price) != null ? (raw / Math.pow(10, decX)) * tick.price : null;
    return { at: new Date(t).toISOString(), in_raw: raw, out_lamports: out, price: num(tick.price), ratio: refSol && refSol > 0 ? 1 - out / 1e9 / refSol : null, price_impact_pct: num(r?.price_impact_pct) };
  }

  async function track(cfg, t, rows) {
    for (const trade of [...trades.values()]) {
      if (store?.isFailed?.(trade.id)) { forget(trade); continue; }
      if (trade.status !== "open") { trades.delete(trade.id); continue; }
      if (t >= trade.entered_at + trade.track_hours * H) endTrade(trade, t, "window");
    }
    const open = [...trades.values()];
    if (!open.length) return;
    const ranks = new Map();
    (rows || []).forEach((r, i) => { if (r?.pool_address && !ranks.has(r.pool_address)) ranks.set(r.pool_address, i + 1); });
    const pools = [...new Set(open.map((x) => x.pool))];
    const byAddr = new Map();
    let serverMs = null;
    for (let i = 0; i < pools.length; i += TRACK_BATCH_MAX) {
      const chunk = pools.slice(i, i + TRACK_BATCH_MAX);
      try {
        const r = await fetchJson(laneTrackUrl(deps.discoveryBase, chunk), "tracking fetch");
        if (serverMs == null) serverMs = r.serverMs;
        for (const x of Array.isArray(r.body?.data) ? r.body.data : []) if (x?.pool_address) byAddr.set(x.pool_address, x);
      } catch (e) { noteError("tracking fetch", e); return; }
    }
    // once per 5-min bucket: the pools' 1h fee (fallback for a bucket the ticks skip entirely)
    const fee1h = new Map();
    const bucket = feeBucketStart(serverMs ?? t);
    if (bucket !== hourBucketRead) {
      try {
        for (let i = 0; i < pools.length; i += TRACK_BATCH_MAX) {
          const r = await fetchJson(laneTrackUrl(deps.discoveryBase, pools.slice(i, i + TRACK_BATCH_MAX), "1h"), "1h fee fetch");
          for (const x of Array.isArray(r.body?.data) ? r.body.data : []) if (x?.pool_address) fee1h.set(x.pool_address, num(x.fee));
        }
        hourBucketRead = bucket;
      } catch (e) { noteError("1h fee fetch", e); }
    }
    const sorted = open.sort((a, b) => a.entered_at - b.entered_at);
    const ticks = new Map();
    for (const trade of sorted) {
      const row = byAddr.get(trade.pool);
      if (row) trade.unseen = 0; else trade.unseen = (trade.unseen || 0) + 1;
      ticks.set(trade.id, row
        ? { trade_id: trade.id, ...tickFromRow(row, { at: t, rank: rows ? ranks.get(trade.pool) ?? null : null, serverMs, fee1h: fee1h.get(trade.pool) ?? null }), sell_quote: null }
        : { trade_id: trade.id, ...unseenTick(t), sell_quote: null });
    }
    // quotes: skipped entirely while a close / exit swap / deploy / straddle may be in flight
    let quotesPaused = false;
    try { quotesPaused = !!deps.quotesPaused?.(); } catch { quotesPaused = true; }
    if (quotesPaused) stats.quotesPaused++;
    else {
      for (const trade of sorted) {
        const tick = ticks.get(trade.id);
        if (tick.seen) { try { await entryQuotes(trade, tick, t); } catch (e) { noteError("entry quote", e); } }
      }
      for (const trade of sorted) {
        const tick = ticks.get(trade.id);
        if (!tick.seen || t < trade.nextSellAt || !trade.buyDone || quoteBudgetLeft(t) <= 0) continue;
        trade.nextSellAt = t + SELL_QUOTE_EVERY_MS;
        try { tick.sell_quote = await sellQuote(trade, tick, t); } catch (e) { noteError("sell quote", e); }
      }
    }
    for (const trade of sorted) {
      if (store?.isFailed?.(trade.id)) { forget(trade); continue; }
      store?.insertTick?.(ticks.get(trade.id)); stats.ticks++;
      if (trade.unseen >= VANISH_UNSEEN_POLLS) endTrade(trade, t, "vanished");
    }
  }

  function maybeSummary(t, cfg) {
    if (t - lastSummaryAt < SUMMARY_EVERY_MS) return;
    lastSummaryAt = t;
    const open = [...trades.values()];
    log(`[FRESH_LANE_SHADOW] hourly: ${stats.polls} polls (${stats.backoff} in backoff, ${stats.restoreWait} waiting for the restore, quotes paused on ${stats.quotesPaused}), ${stats.rows} top-5 rows checked, ${stats.rowPass} passed the row checks, ${stats.qualifying} qualifying, ${stats.entries} paper / ${stats.operator} operator entries, open ${open.filter((x) => x.lane === "paper").length} paper / ${open.filter((x) => x.lane === "operator").length} operator, ${stats.ticks} ticks, ${stats.quotes} quotes (${stats.quote429} rate-limited, ${stats.missingQuote} entries without a buy quote), ${stats.errors} errors (freshLaneMode=${cfg.mode})`);
    Object.assign(stats, freshStats());
  }

  /** One poll. Never throws. */
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const cfg = freshLaneConfig(deps.getConfig?.() || {});
      if (cfg.mode === "off") return;
      const t = now();
      maybeSummary(t, cfg);
      if (!(await ensureRestored(t))) { stats.restoreWait++; return; }
      if (t < apiBackoffUntil) { stats.backoff++; return; }
      stats.polls++;
      const budget = { left: SAFETY_READS_PER_POLL };
      let rows = null;
      try {
        const r = await fetchJson(laneListUrl(deps.discoveryBase), "list fetch");
        rows = Array.isArray(r.body?.data) ? r.body.data : [];
        const seenPools = new Set();
        rows.forEach((x, i) => { if (x?.pool_address && !seenPools.has(x.pool_address)) { seenPools.add(x.pool_address); listRank.set(x.pool_address, { rank: i + 1, at: t }); } });
        if (listRank.size > 1000) for (const [k, v] of listRank) if (t - v.at > H) listRank.delete(k);
      } catch (e) { noteError("list fetch", e); }
      if (rows) { try { await scanList(rows, cfg, t, budget); } catch (e) { noteError("list scan", e); } }
      try { await processOperators(t, budget); } catch (e) { noteError("operator capture", e); }
      if (t < apiBackoffUntil) return; // the list answer asked us to slow down
      try { await track(cfg, t, rows); } catch (e) { noteError("tracking", e); }
    } catch (e) {
      noteError("poll", e);
    } finally {
      busy = false;
    }
  }

  /**
   * An operator position the bot just adopted (fire-and-forget from the adoption enricher, with
   * the enricher's own discovery row — no network call here). Captured when the pool passes the
   * lane's row checks other than the rank (the rank and the safety reads are recorded and the
   * full definition is stamped as qualifies_full). The note is kept in deps.pendingFile until the
   * next poll processes it, so a restart in between does not lose it. Synchronous; never throws.
   */
  function noteOperatorAdoption(arg) {
    try {
      const { position, pool, row, owner } = arg || {};
      if (freshLaneConfig(deps.getConfig?.() || {}).mode === "off") return false;
      if (!position || !row || owner !== "manual") return false;
      if (operatorByPosition.has(position) || pendingOperator.has(position)) return false;
      if (pool && row.pool_address && row.pool_address !== pool) return false;
      const t = now();
      const lr = listRank.get(row.pool_address);
      const rankFresh = !!lr && t - lr.at <= OPERATOR_RANK_FRESH_MS;
      const rank = rankFresh ? lr.rank : null;
      const reasons = laneRowChecks(row, { now: t, ignoreRank: true, isBlacklisted: deps.isBlacklisted, isDevBlocked: deps.isDevBlocked });
      if (reasons.length) return false;
      pendingOperator.set(position, { pool: row.pool_address, row, owner, at: t, rank, rankFresh });
      savePending();
      return true;
    } catch (e) {
      noteError("operator note", e);
      return false;
    }
  }

  return {
    tick,
    noteOperatorAdoption,
    _state: () => ({ trades, paperByPool, pendingOperator, safetyCache, apiBackoffUntil, quoteBackoffUntil, restored, stats: { ...stats } }),
  };
}

/** Own timer (setTimeout chain, so a slow poll never overlaps the next). Returns { stop }. */
export function startFreshLaneTimer(lane, getPollSec) {
  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    let sec = 45;
    try { sec = Math.max(30, Number(getPollSec()) || 45); } catch { sec = 45; }
    timer = setTimeout(run, sec * 1000);
    if (typeof timer.unref === "function") timer.unref();
  };
  const run = () => { Promise.resolve().then(() => lane.tick()).catch(() => {}).finally(schedule); };
  schedule();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
}

export { LANE_ID };
