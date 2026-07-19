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
import { config } from "./config.js";
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

const META_KEYS = ["baseline", "cumulative_gas_sol", "_lastBriefingDate", "recentEvents", "lastUpdated", "_circuitBreaker", "_screeningStarvation"];

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
    _screeningStarvation: meta._screeningStarvation ?? undefined,
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

export async function ensureStateInitialized() {
  if (!_cache) {
    await initState();
  }
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
      _screeningStarvation: state._screeningStarvation ?? null,
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
  token_age_hours = null,
  lazy = false,
  gas_cost_sol = 0,
  // ── Adoption overrides (see adoptOrphanPosition) ──────────────────────────
  // A normal deploy leaves these at their defaults; adopting an orphaned
  // on-chain position uses them to backdate deploy time, seed a note, flag the
  // row as adopted, populate the promoted base_mint column, and log the right
  // event kind — all while reusing this single record shape.
  base_mint = null,
  deployed_at = null,
  initial_note = null,
  adopted = false,
  event_action = "deploy",
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    base_mint: base_mint || signal_snapshot?.base_mint || null,
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
    // Base-token age (hours) at deploy — captured for the age-conditional "young
    // stop" (see updatePnlAndCheckExits). Falls back to the staged signal_snapshot
    // value when not passed explicitly. null = unknown age → treated as NOT young.
    token_age_hours_at_deploy: token_age_hours ?? signal_snapshot?.token_age_hours ?? null,
    signal_snapshot: signal_snapshot || null,
    deployed_at: deployed_at || new Date().toISOString(),
    adopted: !!adopted,
    // Real wall-clock time we started managing this row. For an adopted orphan
    // this is NOW (distinct from the backdated `deployed_at`), and it anchors the
    // post-adoption exit grace (see updatePnlAndCheckExits / adoptGraceMinutes).
    adopted_at: adopted ? new Date().toISOString() : null,
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    // Our own claim ledger, in unambiguous units (see recordClaim). The poller
    // floors Meteora's lagging allTimeFees with these so a claim can't collapse
    // live pnl_pct.
    total_fees_claimed_sol: 0,
    total_fees_claimed_true_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: initial_note ? [initial_note] : [],
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
    // OOR-below flip tactic (plan #07): how many times this position was flipped
    // in place (withdraw + re-add token-side) instead of closed, and when last.
    flip_count: 0,
    flipped_at: null,
    // TWAP wick guard: rolling pnl_pct tick history + consecutive-deferral counter
    // (bounded by twapGuardMaxDeferrals). See applyTwapWickGuard in this file.
    pnl_tick_history: [],
    twap_guard_deferrals: 0,
    // Breakeven profit ratchet (plan-adjacent, default OFF/shadow). Sticky arming:
    // once the confirmed peak crosses profitRatchetArmPct the position stays armed
    // even if peak fields are later recomputed. See updatePnlAndCheckExits.
    ratchet_armed: false,
    ratchet_armed_at: null,
    ratchet_armed_peak_pct: null,
    ratchet_shadow_last_log_at: null,
    // Age-conditional "young stop" (default OFF/shadow): confirm-tick timer (mirrors
    // stop_loss_violated_since) + rate-limited shadow-log timestamp. See
    // updatePnlAndCheckExits / evaluateYoungStop.
    young_stop_violated_since: null,
    young_stop_shadow_last_log_at: null,
  };
  pushEvent(state, { action: event_action, position, pool_name: pool_name || pool });
  save(state);
  log("state", `${adopted ? "Adopted" : "Tracked new"} position: ${position} in pool ${pool}`);
}

/**
 * Adopt an orphaned on-chain position into local state.
 *
 * An "orphan" is a position that exists on-chain but has no open row in state —
 * e.g. a deploy whose transaction bundle reported failure (failed simulation on
 * one instruction) yet actually landed the liquidity, so trackPosition() was
 * never called. reconcileStateWithChain() detects these; this function heals
 * them so the management cycle (and the dashboard) treat them as real positions.
 *
 * Mirrors the phantom auto-heal (reconcile section 1), in the opposite
 * direction. Reuses trackPosition's record shape so an adopted row is
 * field-identical to a normally-deployed one, minus the entry-signal context we
 * never captured (volatility/fee_tvl/mcap/etc. stay null — advisory only, they
 * degrade gracefully everywhere they're read).
 *
 * @param {object} p       one entry from getMyPositions().positions (on-chain truth)
 * @param {object} [opts]
 * @param {string} [opts.reason]  short cause string for the adoption note/log
 * @param {object} [opts.extra]   optional richer context to merge (e.g. from a
 *                                failed deploy that still knows amount_sol/strategy)
 * @returns {boolean} true if a row was created or an existing closed row reopened
 */
export function adoptOrphanPosition(p, { reason = "reconciliation", extra = {} } = {}) {
  if (!p || !p.position) return false;
  const state = load();
  const existing = state.positions[p.position];
  const note = `Auto-adopted during ${reason} (orphaned on-chain position, untracked in state)`;

  // Case A: a row exists but was wrongly marked closed → resurrect it in place,
  // preserving its history rather than clobbering the record.
  if (existing) {
    if (!existing.closed) return false; // already tracked & open — nothing to do
    existing.closed = false;
    existing.closed_at = null;
    existing.adopted = true;
    existing.adopted_at = new Date().toISOString(); // anchor the post-adoption exit grace
    existing.notes = Array.isArray(existing.notes) ? existing.notes : [];
    existing.notes.push(note);
    pushEvent(state, { action: "adopt", position: p.position, pool_name: existing.pool_name || existing.pool });
    save(state);
    log("state", `Adopted (reopened) orphan position ${p.position} in pool ${existing.pool}`);
    return true;
  }

  // Case B: no row at all → build a fresh tracked record from on-chain truth.
  // Backdate deployed_at from the on-chain age so OOR timers / age display are
  // honest instead of resetting the clock at adoption time.
  const ageMin = Number.isFinite(p.age_minutes) ? p.age_minutes : 0;
  const deployedAt = new Date(Date.now() - ageMin * 60 * 1000).toISOString();
  const pairName = extra.pool_name
    || (typeof p.pair === "string" ? p.pair.replace(/\//g, "-") : null);

  trackPosition({
    position: p.position,
    pool: p.pool,
    pool_name: pairName,
    base_mint: p.base_mint ?? extra.base_mint ?? null,
    strategy: extra.strategy || "spot",
    bin_range: {
      min: p.lower_bin ?? extra.min_bin ?? null,
      max: p.upper_bin ?? extra.max_bin ?? null,
      bins_below: extra.bins_below ?? null,
      bins_above: extra.bins_above ?? null,
    },
    amount_sol: extra.amount_sol ?? null,
    amount_x: extra.amount_x ?? 0,
    active_bin: p.active_bin ?? extra.active_bin ?? null,
    bin_step: p.bin_step ?? extra.bin_step ?? null,
    volatility: extra.volatility ?? null,
    fee_tvl_ratio: extra.fee_tvl_ratio ?? null,
    organic_score: extra.organic_score ?? null,
    // Prefer the position's live real-USD value; fall back to any deploy estimate.
    initial_value_usd: p.total_value_true_usd ?? extra.initial_value_usd ?? null,
    signal_snapshot: extra.signal_snapshot ?? null,
    entry_mcap: extra.entry_mcap ?? null,
    entry_tvl: extra.entry_tvl ?? null,
    entry_volume: extra.entry_volume ?? null,
    entry_holders: extra.entry_holders ?? null,
    gas_cost_sol: extra.gas_cost_sol ?? 0,
    deployed_at: deployedAt,
    initial_note: note,
    adopted: true,
    event_action: "adopt",
  });
  return true;
}

/**
 * Attach LLM decision-quality verdicts to a freshly-deployed position (post-hoc).
 *
 * Mirrors the fee_efficiency / organic_momentum snapshot pattern: capture the
 * SCREENER's stated confidence + the adversarial bear-debate verdict onto the
 * position record so the validation loop can later correlate "did low confidence
 * or a bear flag predict a bad outcome?". Called from agent.js after a successful
 * deploy_position (we can't thread these through dlmm.js's trackPosition without
 * editing that file). Merges into the tracked position; no-op if not found.
 *
 * @param {string} positionAddress
 * @param {{deploy_confidence?: number|null, deploy_thesis?: string|null, bear_debate?: object|null}} verdicts
 */
export function attachDeployVerdicts(positionAddress, verdicts = {}) {
  if (!positionAddress) return false;
  const state = load();
  const pos = state.positions[positionAddress];
  if (!pos) {
    log("state", `attachDeployVerdicts: position ${positionAddress} not tracked — skipping`);
    return false;
  }
  if (verdicts.deploy_confidence !== undefined) {
    const c = verdicts.deploy_confidence;
    pos.deploy_confidence = (typeof c === "number" && Number.isFinite(c)) ? c : null;
  }
  if (verdicts.deploy_thesis !== undefined) {
    pos.deploy_thesis = sanitizeStoredText(verdicts.deploy_thesis, 240);
  }
  if (verdicts.bear_debate !== undefined) {
    const b = verdicts.bear_debate;
    pos.bear_debate = b && typeof b === "object"
      ? {
          verdict: typeof b.verdict === "string" ? b.verdict : null,
          confidence: (typeof b.confidence === "number" && Number.isFinite(b.confidence)) ? b.confidence : null,
          reason: sanitizeStoredText(b.reason, 300),
          action: typeof b.action === "string" ? b.action : null,   // log_only | enforce
          enforced: !!b.enforced,
          at: new Date().toISOString(),
        }
      : null;
  }
  save(state);
  log("state", `Attached deploy verdicts to ${positionAddress} (confidence=${pos.deploy_confidence ?? "n/a"}, bear=${pos.bear_debate?.verdict ?? "n/a"})`);
  return true;
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
 * Accumulate into the claim ledger. `sol`/`usd` are the claim-time value of the
 * same fees, so they stay comparable with Meteora's allTimeFees.total.sol/.usd.
 * `total_fees_claimed_usd` keeps its legacy solMode unit (SOL under solMode —
 * see the unit landmine in CLAUDE.md); the _sol/_true_usd pair never does.
 */
function addToClaimLedger(pos, sol, usd) {
  const solNum = Number.isFinite(Number(sol)) ? Number(sol) : 0;
  const usdNum = Number.isFinite(Number(usd)) ? Number(usd) : 0;
  pos.total_fees_claimed_sol = (pos.total_fees_claimed_sol || 0) + solNum;
  pos.total_fees_claimed_true_usd = (pos.total_fees_claimed_true_usd || 0) + usdNum;
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0)
    + (config.management.solMode ? solNum : usdNum);
  return solNum;
}

/**
 * Record a fee claim event.
 *
 * The amount matters beyond bookkeeping: tools/pnl.js floors Meteora's lagging
 * allTimeFees with this ledger, because claimable fees are read on-chain (zero
 * the instant a claim lands) while the indexer catches up minutes later. Without
 * a recorded amount the claimed fee belongs to neither term and live pnl_pct
 * drops by the fee %, firing phantom trailing-TP / stop-loss exits.
 */
export function recordClaim(position_address, { sol = 0, usd = 0 } = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  const solNum = addToClaimLedger(pos, sol, usd);
  pos.notes.push(`Claimed ~◎${solNum.toFixed(6)} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Reverse fees that were claimed and immediately re-deposited into the SAME
 * position (compoundFees). Those tokens are back in the position's on-chain
 * balance, so leaving them in the claim ledger would count them twice until the
 * indexer reflects both the claim and the matching deposit.
 */
export function recordClaimReinvested(position_address, { sol = 0, usd = 0 } = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  const solNum = addToClaimLedger(pos, -sol, -usd);
  pos.notes.push(`Re-deposited ~◎${(-solNum).toFixed(6)} of claimed fees at ${new Date().toISOString()}`);
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

// ─── TWAP wick guard (Charm maxTwapDeviation pattern, plan-adjacent) ──────
//
// Before a non-crash MECHANICAL close fires (stop loss / trailing TP / OOR /
// low yield — the deterministic rules in updatePnlAndCheckExits below), compare
// the current tick's pnl_pct against a short TWAP (simple mean) of our own
// recent recorded pnl_pct ticks. If the current reading deviates wildly from
// that recent average, the trigger may be a single noisy/manipulated tick
// (a "wick") rather than a real move — defer the close one tick instead of
// acting on it.
//
// Honesty note: we guard on POSITION-VALUE deviation (pnl_pct, the series the
// 3s PnL poller actually records via updatePnlAndCheckExits), not raw on-chain
// spot price. pnl_pct is derived from position value (active-bin composition +
// token price), so a wick in the underlying price shows up here as a wick in
// pnl_pct too — but this is a value-deviation guard, not a literal price-TWAP
// guard, and should be described as such.
//
// Composition with existing confirm machinery: this guard runs BEFORE the
// existing per-signal confirmation gates (confirmPeak / registerExitSignal in
// this same poller tick, both driven from index.js). It does not replace them
// — it can only ADD one extra tick of latency to a mechanical exit signal by
// suppressing this tick's result (returning null), so index.js sees "no exit
// this tick" and the existing N-consecutive-tick confirmation logic simply
// takes one tick longer to accumulate. It never fires on its own and never
// closes anything itself.
//
// Bounded deferral: at most `twapGuardMaxDeferrals` (default 2) consecutive
// deferrals per position — tracked in twap_guard_deferrals on the position
// object, alongside the pending_* fields. Once the cap is hit the close is
// let through regardless of deviation, so the guard can never indefinitely
// block a real exit.

const DEFAULT_TWAP_GUARD_TICKS = 5;
const DEFAULT_TWAP_GUARD_DEVIATION_PCT = 8;
const DEFAULT_TWAP_GUARD_MAX_DEFERRALS = 2;
const MAX_PNL_TICK_HISTORY = 20; // generous cap vs. any reasonable twapGuardTicks

/**
 * Append a pnl_pct reading to the position's rolling tick history (in place).
 * Bounded ring buffer — cheap, no persistence-format change beyond one new
 * array field on the position object (mirrors mfe/mae style bookkeeping).
 * Pure mutation helper; caller is responsible for save().
 */
function pushPnlTick(pos, pnlPct) {
  if (pnlPct == null || !Number.isFinite(pnlPct)) return false;
  if (!Array.isArray(pos.pnl_tick_history)) pos.pnl_tick_history = [];
  pos.pnl_tick_history.push(pnlPct);
  if (pos.pnl_tick_history.length > MAX_PNL_TICK_HISTORY) {
    pos.pnl_tick_history = pos.pnl_tick_history.slice(-MAX_PNL_TICK_HISTORY);
  }
  return true;
}

/**
 * Pure decision function: given a recent pnl_pct tick series (oldest→newest,
 * NOT including the current tick) and the current tick's pnl_pct, decide
 * whether a proposed mechanical close should be deferred as a suspected wick.
 *
 * @param {number[]} tickHistory - recent pnl_pct readings, oldest→newest
 * @param {number} currentPnlPct
 * @param {number} deferralsSoFar - consecutive deferrals already applied to this position
 * @param {object} opts - { ticks, deviationPct, maxDeferrals }
 * @returns {{ defer: boolean, capped: boolean, twap: number|null, deviation: number|null }}
 */
export function evaluateTwapWickGuard(tickHistory, currentPnlPct, deferralsSoFar, opts = {}) {
  const ticks = Math.max(1, Number(opts.ticks ?? DEFAULT_TWAP_GUARD_TICKS));
  const deviationPct = Number(opts.deviationPct ?? DEFAULT_TWAP_GUARD_DEVIATION_PCT);
  const maxDeferrals = Math.max(0, Number(opts.maxDeferrals ?? DEFAULT_TWAP_GUARD_MAX_DEFERRALS));

  if (currentPnlPct == null || !Number.isFinite(currentPnlPct)) {
    return { defer: false, capped: false, twap: null, deviation: null };
  }

  const history = Array.isArray(tickHistory) ? tickHistory.filter((v) => Number.isFinite(v)) : [];
  const window = history.slice(-ticks);
  // Not enough history yet to form a meaningful TWAP — nothing to compare against.
  if (window.length === 0) {
    return { defer: false, capped: false, twap: null, deviation: null };
  }

  const twap = window.reduce((sum, v) => sum + v, 0) / window.length;
  const deviation = Math.abs(currentPnlPct - twap);

  if (deviation <= deviationPct) {
    return { defer: false, capped: false, twap, deviation };
  }

  // Deviation exceeds threshold — a wick is suspected. But deferral is bounded:
  // once the cap is reached, force the close through regardless.
  if (deferralsSoFar >= maxDeferrals) {
    return { defer: false, capped: true, twap, deviation };
  }

  return { defer: true, capped: false, twap, deviation };
}

/**
 * Stateful wrapper around evaluateTwapWickGuard for a tracked position: reads
 * the position's pnl_tick_history/twap_guard_deferrals and returns the same
 * decision shape as evaluateTwapWickGuard ({ defer, capped, twap, deviation }).
 * Read-only — the caller (gateExit, in updatePnlAndCheckExits) owns mutating
 * twap_guard_deferrals and calling save().
 *
 * NEVER call this for a crash-tagged exit — crash fast-path exits are decided
 * entirely in index.js's own detectPriceCrash()/registerExitSignal path and
 * structurally never flow through this function's caller, so that exclusion
 * is enforced by composition, not by a runtime check here. See module comment.
 */
function applyTwapWickGuard(pos, currentPnlPct, mgmtConfig) {
  const ticks = mgmtConfig.twapGuardTicks ?? DEFAULT_TWAP_GUARD_TICKS;
  const deviationPct = mgmtConfig.twapGuardDeviationPct ?? DEFAULT_TWAP_GUARD_DEVIATION_PCT;
  const maxDeferrals = mgmtConfig.twapGuardMaxDeferrals ?? DEFAULT_TWAP_GUARD_MAX_DEFERRALS;

  // History excludes the current tick (already pushed by the caller before this
  // runs would double-count it) — pushPnlTick is called separately in the main
  // per-tick bookkeeping block, ahead of exit evaluation, so read the array as-is
  // and exclude the just-pushed current value from the comparison window.
  const fullHistory = Array.isArray(pos.pnl_tick_history) ? pos.pnl_tick_history : [];
  const priorHistory = fullHistory.slice(0, -1); // drop the just-pushed current tick

  const deferralsSoFar = pos.twap_guard_deferrals ?? 0;
  const decision = evaluateTwapWickGuard(priorHistory, currentPnlPct, deferralsSoFar, {
    ticks, deviationPct, maxDeferrals,
  });

  return decision;
}

// ─── Breakeven profit ratchet (empirical: 2026-07-08 replay, 101 paths) ────
//
// Once a position's CONFIRMED peak (pos.peak_pnl_pct — the same field trailing TP
// reads, maintained by confirmPeak, NOT a single noisy tick) reaches
// profitRatchetArmPct, the effective stop tightens from stopLossPct (−15) to
// profitRatchetStopPct (−2). This converts a would-be profit round-trip into a
// small controlled exit. In the tested history arm=2 fired ~1–2×/100 closes for
// ~+15pt each with zero winner-whipsaws; arm=1.5 whipsawed a +12% winner (do not
// default below 2).
//
// Arming is STICKY: persisted on the position (ratchet_armed/ratchet_armed_at) so
// it survives restarts and later peak recomputation. Firing routes through the same
// gateExit TWAP wick-guard wrapper as stop-loss (a single wild tick is deferrable),
// and fires BEFORE the plain stop-loss check since it is strictly tighter once armed.
// It NEVER touches the crash fast-path (separate code path in index.js).
const DEFAULT_RATCHET_ARM_PCT = 2;
const DEFAULT_RATCHET_STOP_PCT = -2;
const RATCHET_SHADOW_LOG_INTERVAL_MS = 10 * 60 * 1000; // rate-limit would-fire spam to 1/10min per position

/**
 * Pure decision function for the breakeven profit ratchet. Given the confirmed
 * peak, the current pnl, and the armed flag, return whether the ratchet is (now)
 * armed and whether it would fire this tick.
 *
 * @param {number} confirmedPeakPct - pos.peak_pnl_pct (confirmed peak)
 * @param {number} currentPnlPct
 * @param {boolean} alreadyArmed - sticky armed flag from the position
 * @param {object} opts - { armPct, stopPct }
 * @returns {{ armed: boolean, newlyArmed: boolean, wouldFire: boolean }}
 */
export function evaluateProfitRatchet(confirmedPeakPct, currentPnlPct, alreadyArmed, opts = {}) {
  const armPct = Number(opts.armPct ?? DEFAULT_RATCHET_ARM_PCT);
  const stopPct = Number(opts.stopPct ?? DEFAULT_RATCHET_STOP_PCT);

  const peak = Number.isFinite(confirmedPeakPct) ? confirmedPeakPct : null;
  const armed = !!alreadyArmed || (peak != null && peak >= armPct);
  const newlyArmed = armed && !alreadyArmed;

  let wouldFire = false;
  if (armed && Number.isFinite(currentPnlPct) && currentPnlPct <= stopPct) {
    wouldFire = true;
  }
  return { armed, newlyArmed, wouldFire };
}

// ─── Age-conditional stop-loss ("young stop") (empirical: 2026-07-19, 137 paths) ──
//
// A tighter stop that applies ONLY to positions whose base token was younger than
// youngStopMaxAgeHours (default 12) at deploy. In-sample, young tokens had a ~19%
// disaster rate (vs 7.8% older); a −10% young-only stop had ZERO winner-kills (no
// young winner ever dipped ≤−10) and cut disasters ~3–7pt earlier than the global
// −15 stop. −5 was REJECTED (two best winners dipped −5.8/−6.1 mid-hold → whipsaw).
//
// Unknown age (null) → NOT young → never tightens (fail open). Positions with the
// profit ratchet already ARMED are excluded (the ratchet's −2 stop is tighter and
// owns those). Firing routes through the same confirm-tick + gateExit TWAP wick
// guard as the plain stop, and NEVER touches the crash fast-path (separate path).
const DEFAULT_YOUNG_STOP_PCT = -10;
const DEFAULT_YOUNG_STOP_MAX_AGE_HOURS = 12;
const YOUNG_STOP_SHADOW_LOG_INTERVAL_MS = 60 * 60 * 1000; // rate-limit shadow would-close to 1/hr per position

/**
 * Pure decision function for the age-conditional young stop. Independent of the
 * enable flag (the caller branches enabled vs shadow), so it answers only "is this
 * a young position, and would the young stop fire this tick?".
 *
 * @param {number|null} tokenAgeHoursAtDeploy - pos.token_age_hours_at_deploy (null → not young)
 * @param {number} currentPnlPct
 * @param {boolean} ratchetArmed - pos.ratchet_armed (armed positions are excluded)
 * @param {object} opts - { stopPct, maxAgeHours }
 * @returns {{ isYoung: boolean, wouldFire: boolean }}
 */
export function evaluateYoungStop(tokenAgeHoursAtDeploy, currentPnlPct, ratchetArmed, opts = {}) {
  const stopPct = Number(opts.stopPct ?? DEFAULT_YOUNG_STOP_PCT);
  const maxAgeHours = Number(opts.maxAgeHours ?? DEFAULT_YOUNG_STOP_MAX_AGE_HOURS);

  // Guard null/undefined BEFORE Number() — Number(null) is 0, which would wrongly
  // read as a 0h-old (very young) token. Unknown age must fail open (NOT young).
  const age = tokenAgeHoursAtDeploy == null ? NaN : Number(tokenAgeHoursAtDeploy);
  const isYoung = Number.isFinite(age) && age < maxAgeHours;

  let wouldFire = false;
  if (isYoung && !ratchetArmed && Number.isFinite(currentPnlPct) && currentPnlPct <= stopPct) {
    wouldFire = true;
  }
  return { isYoung, wouldFire };
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

  // ── Path extremes (MFE/MAE + bin excursions) for post-close analytics ──
  // Raw per-tick extremes — unlike peak_pnl_pct these are unconfirmed, which is
  // fine for analytics (a 1-tick wick IS the max adverse excursion). Consumed by
  // recordPerformance at close so lessons can distinguish a steady earner from a
  // position that survived a crash. Rounded/int to limit write churn.
  if (!pnl_pct_suspicious && currentPnlPct != null && Number.isFinite(currentPnlPct)) {
    const r = Math.round(currentPnlPct * 100) / 100;
    if (pos.mfe_pnl_pct == null || r > pos.mfe_pnl_pct) { pos.mfe_pnl_pct = r; changed = true; }
    if (pos.mae_pnl_pct == null || r < pos.mae_pnl_pct) { pos.mae_pnl_pct = r; changed = true; }
    // TWAP wick-guard tick history (shadow-mode default; see applyTwapWickGuard).
    // Recorded unconditionally (cheap, bounded) so the guard has a warm window
    // as soon as it's enabled — no cold-start gap.
    if (pushPnlTick(pos, r)) changed = true;
  }
  if (active_bin != null && lower_bin != null && Number(active_bin) < Number(lower_bin)) {
    const d = Number(lower_bin) - Number(active_bin);
    if (Number.isFinite(d) && d > (pos.max_bins_below ?? 0)) { pos.max_bins_below = d; changed = true; }
  }
  if (active_bin != null && upper_bin != null && Number(active_bin) > Number(upper_bin)) {
    const d = Number(active_bin) - Number(upper_bin);
    if (Number.isFinite(d) && d > (pos.max_bins_above ?? 0)) { pos.max_bins_above = d; changed = true; }
  }

  if (changed) save(state);

  if (pos.lazy) return null; // Lazy LP mode: bypass all exits

  // Gate a proposed mechanical exit through the TWAP wick guard (shadow-mode
  // default). Returns the exit unchanged, or null if deferred this tick. NEVER
  // called for crash exits — those are decided entirely in index.js's own
  // detectPriceCrash()/registerExitSignal path and never construct an `exit`
  // object via this function, so the exclusion holds by construction.
  const gateExit = (exitResult) => {
    if (!exitResult) return exitResult;
    const decision = applyTwapWickGuard(pos, currentPnlPct, mgmtConfig);
    const enabled = !!mgmtConfig.twapGuardEnabled;

    if (!decision.defer && !decision.capped) {
      // No wick suspected this tick — clear any stale deferral streak and pass through.
      if ((pos.twap_guard_deferrals ?? 0) !== 0) {
        pos.twap_guard_deferrals = 0;
        save(state);
      }
      return exitResult;
    }

    if (decision.capped) {
      log(
        "twap_guard_shadow",
        `[TWAP_GUARD_SHADOW] deferral cap reached for ${position_address} — forcing ${exitResult.action} through ` +
          `(twap=${decision.twap?.toFixed(2)}%, current=${currentPnlPct?.toFixed(2)}%, deviation=${decision.deviation?.toFixed(2)}pp)`
      );
      pos.twap_guard_deferrals = 0;
      save(state);
      return exitResult; // cap reached — let the close proceed regardless
    }

    // decision.defer — wick suspected and under the cap.
    pos.twap_guard_deferrals = (pos.twap_guard_deferrals ?? 0) + 1;
    save(state);
    log(
      "twap_guard_shadow",
      `[TWAP_GUARD_SHADOW] would-defer ${exitResult.action} for ${position_address}: ` +
        `current ${currentPnlPct?.toFixed(2)}% vs ${decision.twap?.toFixed(2)}% TWAP(${mgmtConfig.twapGuardTicks ?? DEFAULT_TWAP_GUARD_TICKS}t) ` +
        `deviates ${decision.deviation?.toFixed(2)}pp >= ${mgmtConfig.twapGuardDeviationPct ?? DEFAULT_TWAP_GUARD_DEVIATION_PCT}pp ` +
        `(deferral ${pos.twap_guard_deferrals}/${mgmtConfig.twapGuardMaxDeferrals ?? DEFAULT_TWAP_GUARD_MAX_DEFERRALS}) ` +
        `— reason: ${exitResult.reason} (twapGuardEnabled=${enabled})`
    );

    if (!enabled) return exitResult; // shadow mode: log only, change nothing
    return null; // real mode: defer this tick
  };

  // ── Breakeven profit ratchet (fires BEFORE stop-loss — strictly tighter once armed) ──
  // Arms off the CONFIRMED peak (pos.peak_pnl_pct, same field trailing TP reads),
  // stays armed stickily across restarts, and — when armed and pnl has fallen back to
  // profitRatchetStopPct — returns a `profit_ratchet` exit routed through gateExit
  // (TWAP wick-guard). NEVER interacts with the crash fast-path (separate code path).
  if (!pnl_pct_suspicious && currentPnlPct != null && Number.isFinite(currentPnlPct)) {
    const armPct = mgmtConfig.profitRatchetArmPct ?? DEFAULT_RATCHET_ARM_PCT;
    const stopPct = mgmtConfig.profitRatchetStopPct ?? DEFAULT_RATCHET_STOP_PCT;
    const ratchetEnabled = !!mgmtConfig.profitRatchetEnabled;
    const decision = evaluateProfitRatchet(
      pos.peak_pnl_pct ?? 0,
      currentPnlPct,
      pos.ratchet_armed,
      { armPct, stopPct }
    );

    // Sticky arming — persist + log a one-time armed line (both modes; armings are rare/useful).
    if (decision.newlyArmed) {
      pos.ratchet_armed = true;
      pos.ratchet_armed_at = new Date().toISOString();
      pos.ratchet_armed_peak_pct = pos.peak_pnl_pct ?? 0;
      save(state);
      log(
        "ratchet_shadow",
        `[RATCHET_SHADOW] armed ${pos.pool_name || position_address} at peak +${(pos.peak_pnl_pct ?? 0).toFixed(2)}%`
      );
    }

    if (decision.wouldFire) {
      const reason =
        `Profit ratchet: peaked +${(pos.ratchet_armed_peak_pct ?? pos.peak_pnl_pct ?? 0).toFixed(2)}% >= ${armPct}%, ` +
        `now ${currentPnlPct.toFixed(2)}% <= ${stopPct}% (stop tightened from ${mgmtConfig.stopLossPct}%)`;

      if (ratchetEnabled) {
        const exit = gateExit({ action: "PROFIT_RATCHET", reason, rule: "profit_ratchet" });
        if (exit) return exit;
      } else {
        // Shadow mode: log a would-close line, rate-limited to 1/10min per position.
        const lastLog = pos.ratchet_shadow_last_log_at ? new Date(pos.ratchet_shadow_last_log_at).getTime() : 0;
        if (Date.now() - lastLog >= RATCHET_SHADOW_LOG_INTERVAL_MS) {
          pos.ratchet_shadow_last_log_at = new Date().toISOString();
          save(state);
          log(
            "ratchet_shadow",
            `[RATCHET_SHADOW] would-close ${pos.pool_name || position_address}: ` +
              `peak +${(pos.ratchet_armed_peak_pct ?? pos.peak_pnl_pct ?? 0).toFixed(2)}% armed@${armPct}%, ` +
              `pnl ${currentPnlPct.toFixed(2)}% <= ${stopPct}% (live rules: holding)`
          );
        }
      }
    }
  }

  // ── Young-token stop (age-conditional, fires BEFORE plain stop-loss) ──────
  // Tighter stop for positions whose base token was young at deploy. Uses the SAME
  // confirm-tick timer + gateExit TWAP wrapper as the plain stop, its own
  // young_stop_violated_since field so it can't collide with the −50 stop. Excludes
  // ratchet-armed positions (handled above). Unknown age → not young → never fires.
  // NEVER touches the crash fast-path (separate code path in index.js).
  if (!pnl_pct_suspicious && currentPnlPct != null && Number.isFinite(currentPnlPct)) {
    const youngStopPct = mgmtConfig.youngStopPct ?? DEFAULT_YOUNG_STOP_PCT;
    const youngStopMaxAgeHours = mgmtConfig.youngStopMaxAgeHours ?? DEFAULT_YOUNG_STOP_MAX_AGE_HOURS;
    const youngStopEnabled = !!mgmtConfig.youngStopEnabled;
    const ageAtDeploy = pos.token_age_hours_at_deploy;
    const decision = evaluateYoungStop(ageAtDeploy, currentPnlPct, pos.ratchet_armed, {
      stopPct: youngStopPct,
      maxAgeHours: youngStopMaxAgeHours,
    });

    if (decision.wouldFire) {
      if (!pos.young_stop_violated_since) {
        // First violating tick — start the confirmation timer (mirrors stop-loss).
        pos.young_stop_violated_since = new Date().toISOString();
        save(state);
        log(
          "state",
          `Position ${position_address} young-token stop threshold violated (${currentPnlPct.toFixed(2)}% <= ${youngStopPct}%, token ${ageAtDeploy}h old at deploy). Waiting for confirmation.`
        );
      } else {
        const violatedDurationMs = Date.now() - new Date(pos.young_stop_violated_since).getTime();
        const minConfirmationMs = 15000; // 15 seconds — same as plain stop-loss
        if (violatedDurationMs >= minConfirmationMs) {
          const reason =
            `Young-token stop: PnL ${currentPnlPct.toFixed(2)}% <= ${youngStopPct}% ` +
            `(token ${ageAtDeploy}h old at deploy, confirmed over ${Math.round(violatedDurationMs / 1000)}s)`;
          if (youngStopEnabled) {
            const exit = gateExit({ action: "YOUNG_STOP", reason, rule: "young_stop" });
            if (exit) return exit;
          } else {
            // Shadow mode: log a would-close line, rate-limited to 1/hr per position.
            const lastLog = pos.young_stop_shadow_last_log_at ? new Date(pos.young_stop_shadow_last_log_at).getTime() : 0;
            if (Date.now() - lastLog >= YOUNG_STOP_SHADOW_LOG_INTERVAL_MS) {
              pos.young_stop_shadow_last_log_at = new Date().toISOString();
              save(state);
              log(
                "young_sl_shadow",
                `[YOUNG_SL_SHADOW] would-close ${pos.pool_name || position_address}: ` +
                  `pnl ${currentPnlPct.toFixed(2)}% <= ${youngStopPct}% (token ${ageAtDeploy}h old at deploy, ` +
                  `< ${youngStopMaxAgeHours}h) (live rules: holding)`
              );
            }
          }
        }
      }
    } else if (pos.young_stop_violated_since) {
      // Recovered above the young stop (or no longer eligible) — clear the timer.
      pos.young_stop_violated_since = null;
      save(state);
    }
  }

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
        const exit = gateExit({
          action: "STOP_LOSS",
          reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}% (confirmed over ${Math.round(violatedDurationMs / 1000)}s)`,
        });
        if (exit) return exit;
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
      const exit = gateExit({
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      });
      if (exit) return exit;
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
        const exit = gateExit({
          action: "OUT_OF_RANGE",
          reason: `Out of range below for ${minutesOOR}m (limit: ${limitBelow}m)`,
        });
        if (exit) return exit;
      }
    }
    // OOR-above is NOT handled here — it's handled by getDeterministicCloseRule
    // in index.js where the price stabilization check (isPriceStable) can gate it.
    // This prevents the "hard exit" path from bypassing the stabilization guard.
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes, fresh_snapshots } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;

  // Guard A (adoption grace): an orphan we just adopted has real on-chain age but
  // ZERO tracked fee history, so the on-chain `age_minutes` gate above is already
  // satisfied while its fee/TVL still reads 0 from missing data — that combination
  // insta-closed CRED-SOL on cycle #1 (2026-07-18). Suppress the low-yield exit for
  // adoptGraceMinutes measured from `adopted_at` (real adoption time, not the
  // backdated deploy time) so it can accumulate live data first.
  const graceMin = mgmtConfig.adoptGraceMinutes ?? 30;
  const inAdoptGrace =
    !!pos.adopted && pos.adopted_at != null && graceMin > 0 &&
    (Date.now() - new Date(pos.adopted_at).getTime()) < graceMin * 60_000;

  // Guard B (history floor): a fee/TVL of ~0 with too few of THIS position's own
  // snapshots is "missing data," not measured decay — never fire low-yield on it.
  // Applies to every position (a fresh normal deploy is covered by the age gate;
  // this additionally covers adopted rows and any thin-history case). Only enforced
  // when the caller supplies a count; unset (null) leaves legacy behavior intact.
  const minSnaps = mgmtConfig.poolHealthMinSnapshots ?? 3;
  const insufficientHistory = fresh_snapshots != null && fresh_snapshots < minSnaps;

  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    if (inAdoptGrace || insufficientHistory) {
      log(
        "state",
        `Low-yield exit suppressed for ${position_address.slice(0, 8)} (${fee_per_tvl_24h.toFixed(2)}% < ${mgmtConfig.minFeePerTvl24h}%): ` +
          (inAdoptGrace
            ? `adoption grace (${Math.floor((Date.now() - new Date(pos.adopted_at).getTime()) / 60000)}m/${graceMin}m)`
            : `thin history (${fresh_snapshots}/${minSnaps} snapshots)`),
      );
    } else {
      const exit = gateExit({
        action: "LOW_YIELD",
        reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
      });
      if (exit) return exit;
    }
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
 * Screening starvation tracker — consecutive empty screening cycles (zero
 * candidates reaching the LLM) + when the cycle-based relaxer last stepped.
 * Persisted as a state_meta singleton (mirrors the circuit-breaker pattern) so
 * the counter survives restarts and the cooldown is honored across processes.
 */
export function getScreeningStarvation() {
  const state = load();
  return state._screeningStarvation || {
    emptyCycles: 0,
    lastRelaxedAt: null,
  };
}

export function saveScreeningStarvation(next) {
  const state = load();
  state._screeningStarvation = next;
  save(state);
}

/**
 * Run on-chain state reconciliation.
 * - Auto-closes phantom positions (open in state, missing on-chain)
 * - Alerts on orphaned positions (active on-chain, untracked/closed in state)
 * - Alerts on PnL discrepancies > 5.0%
 */
export async function reconcileStateWithChain() {
  await ensureStateInitialized();
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

  // 2. Detect + auto-adopt Orphaned Positions (active on-chain but untracked or
  //    wrongly-closed in state). Mirrors section 1's phantom auto-heal in the
  //    opposite direction: instead of only alerting and leaving the position
  //    unmanaged (and invisible to the dashboard, which renders tracked state),
  //    we reconstruct a tracked row from on-chain truth so the management cycle
  //    picks it up. Same 5-minute grace as section 1 so we never race a deploy
  //    that is mid-flight (trackPosition lands within seconds of the tx).
  for (const p of onChainPositions) {
    const posId = p.position;
    const pos = state.positions[posId];
    if (pos && !pos.closed) continue; // already tracked & open

    // Grace window: a brand-new on-chain position may simply be a deploy whose
    // trackPosition write hasn't landed yet — don't adopt (and double-count) it.
    if (Number.isFinite(p.age_minutes) && p.age_minutes < 5) {
      log("state", `Reconciliation: skipping fresh untracked position ${posId} (${p.pair}, age ${p.age_minutes}m) — within deploy grace window`);
      continue;
    }

    log("state_error", `Reconciliation: Orphaned position found on-chain: ${posId} (${p.pair}) — auto-adopting`);
    recordError("state_corruption", `Orphaned position found on-chain: ${posId} (${p.pair})`);

    let adopted = false;
    try {
      adopted = adoptOrphanPosition(p, { reason: "reconciliation" });
      if (adopted) changed = true;
    } catch (e) {
      log("state_error", `Failed to auto-adopt orphan ${posId}: ${e.message}`);
    }

    await sendTelegramMessage(
      adopted
        ? `🩹 <b>Drift Healed: Orphaned Position Adopted</b>\nPosition <code>${posId}</code> (${p.pair}) was active on-chain but untracked in local state — most likely a deploy that reported failure yet landed. It has been auto-adopted and is now managed normally.`
        : `🚨 <b>Drift Alert: Orphaned Position</b>\nPosition <code>${posId}</code> (${p.pair}) is active on-chain, but is NOT tracked as open in local state and could not be auto-adopted.\n<b>Action Required:</b> Re-import or manage this position manually.`
    ).catch(e => log("telegram_error", `Failed to send orphaned alert: ${e.message}`));
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

