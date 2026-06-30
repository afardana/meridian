/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { recordError } from "./error-telemetry.js";
import { usePg, query, withTransaction } from "./db/pool.js";

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

const STATE_BACKUP_FILE = repoPath("state.json.bak");
const STATE_TMP_FILE = repoPath("state.json.tmp");

function parseStateFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function emptyState() {
  return { positions: {}, recentEvents: [], lastUpdated: null };
}

// ─── Persistence engine ────────────────────────────────────────
//
// Two backends, selected by PERSIST_BACKEND (db/pool.js usePg()):
//   • json — the legacy atomic file (default; behaviour unchanged)
//   • pg   — a single-row jsonb document in Postgres (state_doc)
//
// Both are fronted by an in-process cache so the 25 exported accessors stay
// SYNCHRONOUS (callers don't change). Mutations update the cache synchronously
// then enqueue an ordered async persist; the ordering serialises writes so
// concurrent async mutations can't clobber each other. The single live PM2
// `meridian` process is the sole writer (auxiliary writers are stopped /
// read-only), so the cache is authoritative within the process.

let _cache = null;
let _writeChain = Promise.resolve();

/** Read the full state from the JSON file, recovering from backup on corruption. */
function loadFromFile() {
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    return parseStateFile(STATE_FILE);
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    recordError("state_corruption", `Failed to read state.json: ${err.message}`);
    if (fs.existsSync(STATE_BACKUP_FILE)) {
      try {
        const recovered = parseStateFile(STATE_BACKUP_FILE);
        log("state_error", "Recovered state from state.json.bak after corruption");
        recordError("state_recovered", "Recovered position state from backup");
        return recovered;
      } catch (bakErr) {
        recordError("state_corruption", `Backup also unreadable: ${bakErr.message}`);
      }
    }
    // Preserve the corrupt file for forensics and HALT rather than silently
    // returning empty positions — an empty load would make the agent forget
    // every live on-chain position and stop managing real capital.
    try {
      fs.renameSync(STATE_FILE, repoPath(`state.json.corrupt-${Date.now()}`));
    } catch { /* ignore */ }
    throw new Error(
      "state.json is corrupt and no usable backup exists — refusing to start with empty positions. " +
        "Inspect the saved state.json.corrupt-* file and restore manually."
    );
  }
}

/** Atomic file write: temp file + rename, with a rolling .bak. */
function persistToFile(state) {
  const json = JSON.stringify(state, null, 2);
  fs.writeFileSync(STATE_TMP_FILE, json);
  if (fs.existsSync(STATE_FILE)) {
    try { fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE); } catch { /* ignore */ }
  }
  fs.renameSync(STATE_TMP_FILE, STATE_FILE);
}

// ─── Normalized pg projection ──────────────────────────────────
//
// Under pg, state is stored as real rows:
//   • positions       — one row per position; full object in `data` jsonb plus
//                        promoted columns for querying. `data` is authoritative
//                        (lossless), columns are denormalized for queries/Phase 5.
//   • position_events  — append-only audit log of deploy/close/rebalance events.
//   • state_meta       — singletons: baseline, cumulative_gas_sol,
//                        _lastBriefingDate, recentEvents, lastUpdated.
// The legacy single-row state_doc is retained untouched as a rollback snapshot.

const _lastPersisted = new Map(); // position_address -> JSON string (change detection)
let _pendingEvents = [];          // events queued by pushEvent for position_events

const META_KEYS = ["baseline", "cumulative_gas_sol", "_lastBriefingDate", "recentEvents", "lastUpdated", "_circuitBreaker"];

export function positionColumns(obj) {
  return {
    pool_address: obj.pool ?? null,
    base_mint: obj.base_mint ?? obj.signal_snapshot?.base_mint ?? null,
    pair: obj.pool_name ?? null,
    lower_bin: obj.bin_range?.min ?? null,
    upper_bin: obj.bin_range?.max ?? null,
    strategy: obj.strategy ?? null,
    deployed_at: obj.deployed_at ?? null,
    out_of_range_at: obj.out_of_range_since ?? null,
    gas_sol: obj.total_gas_sol ?? obj.gas_cost_sol ?? null,
    note: obj.instruction ?? null,
    closed: !!obj.closed,
    closed_at: obj.closed_at ?? null,
  };
}

async function hydrateFromPg() {
  const posRes = await query("SELECT data FROM positions");
  if (posRes.rows.length === 0) {
    // One-time fallback: positions table empty but the pre-normalization
    // state_doc may still hold data. Hydrate from it so nothing is lost; the
    // next save() projects it into the normalized tables.
    const docRes = await query("SELECT doc FROM state_doc WHERE id = 1");
    const doc = docRes.rows[0]?.doc;
    if (doc && doc.positions && Object.keys(doc.positions).length) {
      log("state", "Normalized tables empty — hydrating cache from legacy state_doc (one-time)");
      return { ...emptyState(), ...doc };
    }
  }
  const positions = {};
  for (const row of posRes.rows) {
    const obj = row.data;
    if (obj && obj.position) positions[obj.position] = obj;
  }
  const metaRes = await query("SELECT key, value FROM state_meta WHERE key = ANY($1)", [META_KEYS]);
  const meta = {};
  for (const row of metaRes.rows) meta[row.key] = row.value;
  return {
    positions,
    recentEvents: Array.isArray(meta.recentEvents) ? meta.recentEvents : [],
    baseline: meta.baseline ?? undefined,
    cumulative_gas_sol: meta.cumulative_gas_sol ?? undefined,
    _lastBriefingDate: meta._lastBriefingDate ?? undefined,
    lastUpdated: meta.lastUpdated ?? null,
    _circuitBreaker: meta._circuitBreaker ?? undefined,
  };
}

/**
 * Initialise the in-process cache. MUST be awaited once at process startup
 * before any state accessor is used when the pg backend is active (Postgres
 * can't be read synchronously). For the json backend this is optional — load()
 * lazily reads the file — but calling it everywhere keeps startup uniform.
 */
export async function initState() {
  if (usePg()) {
    _cache = await hydrateFromPg();
    _lastPersisted.clear();
    for (const [addr, obj] of Object.entries(_cache.positions)) {
      _lastPersisted.set(addr, JSON.stringify(obj));
    }
    _pendingEvents = [];
  } else {
    _cache = loadFromFile();
  }
  return _cache;
}

/** Synchronous accessor used by every exported function. Returns the live cache. */
function load() {
  if (_cache) return _cache;
  if (usePg()) {
    throw new Error(
      "state cache not initialised — call `await initState()` at startup before using state (pg backend)."
    );
  }
  // json backend can populate the cache lazily without async.
  _cache = loadFromFile();
  return _cache;
}

/** Enqueue an ordered persist of the current cache. Never overlaps a prior write. */
function save(state) {
  state.lastUpdated = new Date().toISOString();
  _cache = state;
  if (usePg()) {
    // Diff positions synchronously so the enqueued write captures this instant.
    const upserts = [];
    const seen = new Set();
    for (const [addr, obj] of Object.entries(state.positions)) {
      seen.add(addr);
      const j = JSON.stringify(obj);
      if (_lastPersisted.get(addr) !== j) {
        upserts.push({ addr, obj, j, cols: positionColumns(obj) });
      }
    }
    const removed = [...(_lastPersisted.keys())].filter((a) => !seen.has(a));
    const events = _pendingEvents;
    _pendingEvents = [];
    const meta = {
      baseline: state.baseline ?? null,
      cumulative_gas_sol: state.cumulative_gas_sol ?? null,
      _lastBriefingDate: state._lastBriefingDate ?? null,
      recentEvents: state.recentEvents ?? [],
      lastUpdated: state.lastUpdated,
      _circuitBreaker: state._circuitBreaker ?? null,
    };
    // Optimistically advance change-tracking; on failure, roll back so the next
    // mutation retries the affected rows.
    for (const u of upserts) _lastPersisted.set(u.addr, u.j);
    for (const a of removed) _lastPersisted.delete(a);

    _writeChain = _writeChain
      .then(() => persistNormalized({ upserts, removed, events, meta }))
      .catch((err) => {
        for (const u of upserts) _lastPersisted.delete(u.addr); // force retry next time
        log("state_error", `Failed to persist state to Postgres: ${err.message}`);
        recordError("state_corruption", `Failed to persist state to Postgres: ${err.message}`);
      });
  } else {
    // json backend stays fully synchronous (identical to legacy behaviour).
    try {
      persistToFile(state);
    } catch (err) {
      log("state_error", `Failed to write state.json: ${err.message}`);
      recordError("state_corruption", `Failed to write state.json: ${err.message}`);
    }
  }
}

async function persistNormalized({ upserts, removed, events, meta }) {
  await withTransaction(async (client) => {
    for (const u of upserts) {
      const c = u.cols;
      await client.query(
        `INSERT INTO positions
           (position_address, pool_address, base_mint, pair, lower_bin, upper_bin,
            strategy, deployed_at, out_of_range_at, gas_sol, note, closed, closed_at, data, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb, now())
         ON CONFLICT (position_address) DO UPDATE SET
           pool_address=EXCLUDED.pool_address, base_mint=EXCLUDED.base_mint, pair=EXCLUDED.pair,
           lower_bin=EXCLUDED.lower_bin, upper_bin=EXCLUDED.upper_bin, strategy=EXCLUDED.strategy,
           deployed_at=EXCLUDED.deployed_at, out_of_range_at=EXCLUDED.out_of_range_at,
           gas_sol=EXCLUDED.gas_sol, note=EXCLUDED.note, closed=EXCLUDED.closed,
           closed_at=EXCLUDED.closed_at, data=EXCLUDED.data, updated_at=now()`,
        [u.addr, c.pool_address, c.base_mint, c.pair, c.lower_bin, c.upper_bin, c.strategy,
         c.deployed_at, c.out_of_range_at, c.gas_sol, c.note, c.closed, c.closed_at, u.j]
      );
    }
    for (const addr of removed) {
      await client.query("DELETE FROM positions WHERE position_address = $1", [addr]);
    }
    for (const ev of events) {
      const { ts, action, position, ...payload } = ev;
      await client.query(
        "INSERT INTO position_events (position_address, kind, payload, created_at) VALUES ($1,$2,$3::jsonb,$4)",
        [position ?? null, action ?? "event", JSON.stringify(payload), ts ?? new Date().toISOString()]
      );
    }
    for (const key of META_KEYS) {
      await client.query(
        "INSERT INTO state_meta (key, value, updated_at) VALUES ($1,$2::jsonb,now()) " +
          "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
        [key, JSON.stringify(meta[key] ?? null)]
      );
    }
  });
}

/**
 * Persist the agent's wallet address as a state_meta singleton so read-only
 * consumers (e.g. the dashboard) can resolve it from the DB instead of a stale
 * file. pg-only and write-once-ish (static value); no-op under the json backend.
 */
export async function persistWalletAddress(address) {
  if (!usePg() || !address) return;
  try {
    await query(
      "INSERT INTO state_meta (key, value, updated_at) VALUES ('walletAddress', $1::jsonb, now()) " +
        "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
      [JSON.stringify(address)]
    );
  } catch (err) {
    log("state_warn", `Failed to persist wallet address to state_meta: ${err.message}`);
  }
}

/** Await all pending async persists. Call before process exit. */
export async function flushState() {
  await _writeChain;
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
  fee_efficiency = null,
  organic_momentum = null,
  lazy = false,
  gas_cost_sol = 0,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    fee_efficiency: fee_efficiency || null,
    organic_momentum: organic_momentum || null,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    lazy: !!lazy,
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
    trailing_active: false,
    gas_cost_sol: gas_cost_sol || 0,
    total_gas_sol: gas_cost_sol || 0,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Add gas cost to an existing position (e.g. from claims or swaps during its lifetime).
 */
export function addGasToPosition(positionAddress, gasSol) {
  const state = load();
  const pos = state.positions[positionAddress];
  if (pos) {
    pos.total_gas_sol = (pos.total_gas_sol ?? 0) + gasSol;
  }
  state.cumulative_gas_sol = (state.cumulative_gas_sol ?? 0) + gasSol;
  save(state);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * Toggle or set the lazy flag on a tracked position.
 */
export function setPositionLazy(position_address, lazyValue) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return null;
  pos.lazy = !!lazyValue;
  save(state);
  log("state", `Position ${position_address} lazy mode set to ${pos.lazy}`);
  return pos.lazy;
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  const stamped = { ts: new Date().toISOString(), ...event };
  state.recentEvents.push(stamped);
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
  // Queue for the append-only position_events audit table (pg backend only;
  // ignored by the json backend, which keeps everything in recentEvents).
  _pendingEvents.push(stamped);
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position, new_position) {
  const state = load();
  const old = state.positions[old_position];
  if (old) {
    old.closed = true;
    old.closed_at = new Date().toISOString();
    old.notes.push(`Rebalanced into ${new_position} at ${old.closed_at}`);
  }
  const newPos = state.positions[new_position];
  if (newPos) {
    newPos.rebalance_count = (old?.rebalance_count || 0) + 1;
    newPos.notes.push(`Rebalanced from ${old_position}`);
  }
  save(state);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls where the
 * candidate stays above the current peak. With the 3s RPC poller this confirms a real
 * high in ~3-6s and prevents a single noisy tick from inflating the peak (which would
 * otherwise arm a false trailing-drop). Replaces the old 15s setTimeout recheck.
 * Returns true when the peak was raised this call.
 */
export function confirmPeak(position_address, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  // No new high — drop any pending peak candidate.
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  // Same-or-higher candidate as the pending one → another confirming tick.
  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    // New / lower-than-pending candidate → start a fresh confirmation streak.
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = new Date().toISOString();
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Consecutive-tick confirmation for an exit signal. The fast poller calls this every
 * tick with the exit action string detected this poll (or null when no exit). An exit
 * only fires after `confirmTicks` consecutive polls report the SAME action — so a single
 * noisy tick can't close a position. Streak resets whenever the signal clears or changes.
 * Returns { fire, action, count }.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = new Date().toISOString();
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
  }
  save(state);
  if (fire) log("state", `Position ${position_address} exit signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h, active_bin, lower_bin, upper_bin } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  let changed = false;

  // Update bin range if changed on-chain (aligns with actual deployed positions)
  if (!pos.bin_range) {
    pos.bin_range = {};
  }
  if (lower_bin != null && pos.bin_range.min !== lower_bin) {
    pos.bin_range.min = lower_bin;
    changed = true;
    log("state", `Position ${position_address} lower bin range synchronized to ${lower_bin}`);
  }
  if (upper_bin != null && pos.bin_range.max !== upper_bin) {
    pos.bin_range.max = upper_bin;
    changed = true;
    log("state", `Position ${position_address} upper bin range synchronized to ${upper_bin}`);
  }

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  if (pos.lazy) return null; // Lazy LP mode: bypass all exits

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    if (!pos.stop_loss_violated_since) {
      pos.stop_loss_violated_since = new Date().toISOString();
      save(state);
      log("state", `Position ${position_address} stop-loss threshold violated (${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%). Waiting for confirmation.`);
    } else {
      const violatedDurationMs = Date.now() - new Date(pos.stop_loss_violated_since).getTime();
      const minConfirmationMs = 15000; // 15 seconds
      if (violatedDurationMs >= minConfirmationMs) {
        return {
          action: "STOP_LOSS",
          reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}% (confirmed over ${Math.round(violatedDurationMs / 1000)}s)`,
        };
      }
    }
  } else if (pos.stop_loss_violated_since) {
    pos.stop_loss_violated_since = null;
    save(state);
    log("state", `Position ${position_address} stop-loss violation cleared (recovered to ${currentPnlPct.toFixed(2)}%)`);
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    const activeBin = active_bin != null ? Number(active_bin) : null;
    const lowerBin = lower_bin != null ? Number(lower_bin) : null;
    const upperBin = upper_bin != null ? Number(upper_bin) : null;

    let isBelowRange = false;
    if (activeBin != null && lowerBin != null && activeBin < lowerBin) {
      isBelowRange = true;
    }

    if (isBelowRange) {
      const limitBelow = mgmtConfig.outOfRangeWaitMinutesBelow ?? mgmtConfig.outOfRangeWaitMinutes ?? 180;
      if (limitBelow > 0 && minutesOOR >= limitBelow) {
        return {
          action: "OUT_OF_RANGE",
          reason: `Out of range below for ${minutesOOR}m (limit: ${limitBelow}m)`,
        };
      }
    }
    // OOR-above is NOT handled here — it's handled by getDeterministicCloseRule
    // in index.js where the price stabilization check (isPriceStable) can gate it.
    // This prevents the "hard exit" path from bypassing the stabilization guard.
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}

export function updateClosedPositionPnL(position_address, exit_pnl_pct, exit_pnl_usd, fees_earned_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.exit_pnl_pct = Number(exit_pnl_pct);
  pos.exit_pnl_usd = Number(exit_pnl_usd);
  if (fees_earned_usd !== undefined && fees_earned_usd !== null && !isNaN(fees_earned_usd)) {
    pos.total_fees_claimed_usd = Number(fees_earned_usd);
  }
  save(state);
  log("state", `Position ${position_address} updated PnL: pct=${exit_pnl_pct}%, usd=$${exit_pnl_usd}, fees=$${fees_earned_usd}`);
}

export function getBaselineState() {
  const state = load();
  return state.baseline || { total_deposited: 0, last_signature: null, deposits: [] };
}

export function saveBaselineState(baseline) {
  const state = load();
  state.baseline = baseline;
  save(state);
}

export function getCircuitBreakerState() {
  const state = load();
  return state._circuitBreaker || {
    tripped: false,
    trippedAt: null,
    reason: null,
    resumesAt: null,
    lastSolPrice: null,
  };
}

export function saveCircuitBreakerState(cbState) {
  const state = load();
  state._circuitBreaker = cbState;
  save(state);
}

/**
 * Run on-chain state reconciliation.
 * - Auto-closes phantom positions (open in state, missing on-chain)
 * - Alerts on orphaned positions (active on-chain, untracked/closed in state)
 * - Alerts on PnL discrepancies > 5.0%
 */
export async function reconcileStateWithChain() {
  log("state", "Starting on-chain state reconciliation check");
  const { getMyPositions } = await import("./tools/dlmm.js");
  const { sendMessage: sendTelegramMessage } = await import("./telegram.js");

  const liveResult = await getMyPositions({ force: true, silent: true }).catch(() => null);
  if (!liveResult) {
    log("state_error", "Failed to fetch live positions for reconciliation");
    recordError("state_corruption", "Failed to fetch live positions for reconciliation");
    return;
  }

  const state = load();
  const onChainPositions = liveResult.positions || [];
  const onChainSet = new Set(onChainPositions.map(p => p.position));
  let changed = false;
  const now = Date.now();

  // 1. Detect Phantom Positions (open in state.json but missing on-chain)
  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || onChainSet.has(posId)) continue;

    // Grace period check (5 minutes) to avoid race conditions during deploy
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (now - deployedAt < 5 * 60 * 1000) {
      continue;
    }

    // Auto-heal local state
    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push("Auto-closed during state reconciliation (not found on-chain)");
    changed = true;
    log("state", `Reconciliation: Auto-closed phantom position ${posId}`);

    await sendTelegramMessage(
      `⚠️ <b>Drift Warning: Phantom Position</b>\nPosition <code>${posId}</code> (${pos.pool_name || pos.pool}) was tracked as open in local state, but not found on-chain. Local state has been auto-healed and marked as closed.`
    ).catch(e => log("telegram_error", `Failed to send phantom alert: ${e.message}`));
  }

  // 2. Detect Orphaned Positions (active on-chain but untracked/closed in state)
  for (const p of onChainPositions) {
    const posId = p.position;
    const pos = state.positions[posId];
    if (!pos || pos.closed) {
      log("state_error", `Reconciliation: Orphaned position found on-chain: ${posId} (${p.pair})`);
      recordError("state_corruption", `Orphaned position found on-chain: ${posId} (${p.pair})`);

      await sendTelegramMessage(
        `🚨 <b>Drift Alert: Orphaned Position</b>\nPosition <code>${posId}</code> (${p.pair}) is active on-chain, but is NOT tracked as open in local state.\n<b>Action Required:</b> Re-import or manage this position manually.`
      ).catch(e => log("telegram_error", `Failed to send orphaned alert: ${e.message}`));
    }
  }

  // 3. Detect PnL Discrepancy > 5.0%
  for (const p of onChainPositions) {
    if (p.pnl_pct_diff != null && p.pnl_pct_diff > 5.0) {
      log("state_error", `Reconciliation: PnL discrepancy for ${p.position} (${p.pair}): diff=${p.pnl_pct_diff}%`);

      await sendTelegramMessage(
        `⚠️ <b>Drift Warning: PnL Discrepancy</b>\nPosition <code>${p.position.slice(0, 8)}...</code> (${p.pair}) has a PnL discrepancy.\nOn-chain derived: ${p.pnl_pct}%\nMeteora reported: ${(p.pnl_pct - p.pnl_pct_diff).toFixed(2)}%\nDifference: ${p.pnl_pct_diff}%.`
      ).catch(e => log("telegram_error", `Failed to send PnL discrepancy alert: ${e.message}`));
    }
  }

  if (changed) {
    save(state);
  }
  log("state", "State reconciliation check complete");
}

