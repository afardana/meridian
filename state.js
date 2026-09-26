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
const POSITION_STRATEGY_ALIASES = {
  spot: "spot",
  curve: "curve",
  manual: "manual",
  bidask: "bid_ask",
  "bid-ask": "bid_ask",
  bid_ask: "bid_ask",
};
export const RANGE_HARVEST_PROFILE = "range_harvest";
const PROFIT_EXIT_ACTIONS = new Set(["TAKE_PROFIT", "TRAILING_TP"]);

function normalizePositionStrategy(value) {
  if (value == null) return null;
  const key = String(value).trim().toLowerCase().replace(/\s+/g, "_");
  return POSITION_STRATEGY_ALIASES[key] || null;
}

function configuredManagementProfile(pool) {
  return Array.isArray(config.management?.rangeHarvestPools)
    && config.management.rangeHarvestPools.includes(String(pool || ""))
    ? RANGE_HARVEST_PROFILE
    : null;
}

export function isRangeHarvestProfitExitSuppressed(profile, action) {
  return profile === RANGE_HARVEST_PROFILE && PROFIT_EXIT_ACTIONS.has(String(action || "").toUpperCase());
}

// Operator-created (adopted) positions get a grace period after adoption during which
// no PROFIT-taking rule runs (trailing TP, absolute take-profit, round-trip harvest).
// Downside rules (stop loss, crash/rug, OOR-below, low-yield with its own grace) keep
// applying. Requested by the operator 2026-09-25 after trailing closed two manual
// GO-SOL positions at +1% within 6–11 minutes of adoption (audit 01 §8).
const GRACE_PROFIT_ACTIONS = new Set(["TAKE_PROFIT", "TRAILING_TP", "ROUND_TRIP_HARVEST"]);
export function adoptedProfitGraceRemainingMin(pos, mgmtConfig = {}) {
  const graceMin = Number(mgmtConfig.adoptedProfitGraceMinutes ?? 0);
  if (!(graceMin > 0) || !pos?.adopted || !pos?.adopted_at) return 0;
  const elapsedMin = (Date.now() - new Date(pos.adopted_at).getTime()) / 60_000;
  return Number.isFinite(elapsedMin) ? Math.max(0, graceMin - elapsedMin) : 0;
}
export function isProfitExitSuppressed(pos, action, mgmtConfig = {}) {
  const a = String(action || "").toUpperCase();
  if (isRangeHarvestProfitExitSuppressed(pos?.management_profile, a)) return true;
  if (!GRACE_PROFIT_ACTIONS.has(a)) return false;
  if (adoptedProfitGraceRemainingMin(pos, mgmtConfig) > 0) return true;
  // Explicit grace window (set by an in-place straddle so the fresh two-sided range
  // gets to earn before any profit-taking rule looks at it again).
  const until = pos?.profit_grace_until ? new Date(pos.profit_grace_until).getTime() : 0;
  return Number.isFinite(until) && until > Date.now();
}
export function profitGraceRemainingMin(pos, mgmtConfig = {}) {
  const adopted = adoptedProfitGraceRemainingMin(pos, mgmtConfig);
  const until = pos?.profit_grace_until ? new Date(pos.profit_grace_until).getTime() : 0;
  const explicit = Number.isFinite(until) ? Math.max(0, (until - Date.now()) / 60_000) : 0;
  return Math.max(adopted, explicit);
}

/**
 * Bookkeeping for an in-place straddle (same position account, new range, base bought).
 * Value basis (amount_sol) is unchanged — the SOL→base swap happened at market — so
 * pnl_pct keeps its meaning. Peak/trailing/harvest state is reset and a profit grace
 * (harvestStraddleGraceMinutes, default 60) is set so the new two-sided range runs.
 */
export function recordInPlaceStraddle(position_address, { bin_range, strategy, amount_x = 0, swapped_sol = 0, gas_sol = 0, reason = "harvest straddle" } = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return null;
  const graceMin = Number(config.management?.harvestStraddleGraceMinutes ?? 60);
  pos.bin_range = { ...(pos.bin_range || {}), ...(bin_range || {}) };
  if (strategy) pos.strategy = strategy;
  pos.amount_x = (Number(pos.amount_x) || 0) + (Number(amount_x) || 0);
  pos.straddle_count = (Number(pos.straddle_count) || 0) + 1;
  pos.straddled_at = new Date().toISOString();
  pos.lane = "straddle";
  pos.total_gas_sol = (Number(pos.total_gas_sol) || 0) + (Number(gas_sol) || 0);
  pos.out_of_range_since = null;
  pos.trailing_active = false;
  pos.pnl_tick_history = [];
  pos.pending_exit_action = null; pos.pending_exit_count = 0; pos.pending_exit_started_at = null; pos.pending_exit_context = null;
  pos.pending_peak_pnl_pct = null; pos.pending_peak_confirm_count = 0;
  if (graceMin > 0) pos.profit_grace_until = new Date(Date.now() + graceMin * 60_000).toISOString();
  pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
  pos.notes.push(`Straddled in place #${pos.straddle_count}: ${strategy || pos.strategy} ${pos.bin_range?.min}..${pos.bin_range?.max}, ◎${Number(swapped_sol).toFixed(4)} → ${amount_x} base (${reason})`);
  pushEvent(state, { action: "straddle", position: position_address, pool_name: pos.pool_name, strategy, bin_range: pos.bin_range, amount_x, swapped_sol, straddle_count: pos.straddle_count, reason });
  save(state);
  log("state", `Position ${position_address} straddled in place (#${pos.straddle_count}); profit-taking grace ${graceMin}m`);
  return pos;
}
export function notePositionStraddleFailure(position_address, note) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
  pos.notes.push(note);
  pos.pnl_tick_history = [];
  save(state);
  return true;
}

/**
 * Infer a clearly-shaped DLMM distribution from normalized per-bin values.
 * Conservative by design: sparse/single-sided or ambiguous shapes remain
 * `manual` rather than receiving an invented strategy label.
 */
export function inferPositionStrategyFromBins(bins) {
  if (!Array.isArray(bins) || bins.length < 9) return null;
  const values = bins
    .map((bin) => Number(bin?.v))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length !== bins.length) return null;
  const nonZero = values.filter((value) => value > 0.02).length;
  if (nonZero < Math.ceil(values.length * 0.7)) return null;

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!(mean > 0)) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv <= 0.14) return "spot";

  const band = Math.max(2, Math.floor(values.length * 0.2));
  const edgeValues = [...values.slice(0, band), ...values.slice(-band)];
  const centreStart = Math.floor((values.length - band * 2) / 2);
  const centreValues = values.slice(centreStart, centreStart + band * 2);
  const edgeMean = edgeValues.reduce((sum, value) => sum + value, 0) / edgeValues.length;
  const centreMean = centreValues.reduce((sum, value) => sum + value, 0) / centreValues.length;
  if (centreMean >= edgeMean * 1.35) return "curve";
  if (edgeMean >= centreMean * 1.35) return "bid_ask";
  return null;
}

function normalizeAssetProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const mint = (value) => {
    if (value == null) return null;
    const text = String(value).trim();
    return text || null;
  };
  const symbol = (value) => {
    if (value == null) return null;
    const text = String(value).trim();
    return text || null;
  };
  const decimals = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 18 ? n : null;
  };
  const tokenXM = mint(profile.token_x_mint ?? profile.tokenXMint);
  const tokenYM = mint(profile.token_y_mint ?? profile.tokenYMint);
  if (!tokenXM && !tokenYM) return null;
  return {
    token_x_mint: tokenXM,
    token_y_mint: tokenYM,
    token_x_symbol: symbol(profile.token_x_symbol ?? profile.tokenXSymbol),
    token_y_symbol: symbol(profile.token_y_symbol ?? profile.tokenYSymbol),
    token_x_decimals: decimals(profile.token_x_decimals ?? profile.tokenXDecimals),
    token_y_decimals: decimals(profile.token_y_decimals ?? profile.tokenYDecimals),
    source: symbol(profile.source) || "unknown",
    validated_at: profile.validated_at || profile.validatedAt || null,
  };
}

function pairNamesMatch(left, right) {
  return String(left || "").trim().replace(/\//g, "-").toUpperCase()
    === String(right || "").trim().replace(/\//g, "-").toUpperCase();
}

function comparableAssetProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const { source: _source, validated_at: _validatedAt, ...identity } = profile;
  return identity;
}

function recentDeploymentStrategy(state, position) {
  const events = Array.isArray(state.recentEvents) ? state.recentEvents : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.action !== "deploy" || event.position !== position) continue;
    const strategy = normalizePositionStrategy(event.strategy);
    if (strategy && strategy !== "manual") {
      return { strategy, at: event.ts || null, source: "bot_deploy_event" };
    }
  }
  return null;
}

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

const META_KEYS = ["baseline", "cumulative_gas_sol", "_lastBriefingDate", "recentEvents", "lastUpdated", "_circuitBreaker", "_screeningStarvation", "_deferredExitSwaps"];

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
    // ⚠️ A state_meta singleton must be listed in THREE places or it silently
    // round-trips to null: (1) META_KEYS, (2) this initState reconstruction —
    // an explicit whitelist, so an unlisted key is read into `meta` and then
    // dropped from the cache — and (3) the `meta` object built in save() (see
    // ~line 231), which is what persistNormalized actually writes. Missing (2)
    // or (3) writes null on the very next save. Verified the hard way on
    // _deferredExitSwaps (2026-07-27): a value seeded with the agent stopped
    // flushed OK and read back null after start, twice.
    _deferredExitSwaps: meta._deferredExitSwaps ?? undefined,
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
      _deferredExitSwaps: state._deferredExitSwaps ?? null,
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
  // Scout tier: sub-TVL-floor history-building position (executor-derived,
  // size clamped to scoutSizeSol). Flows to the perf record on close.
  scout = false,
  // Probe tier (plan #12): above-floor low-conviction position, size clamped to
  // probeSizeSol by the executor. Flows to the perf record on close.
  probe = false,
  // Plan #12: pool price change over the screening timeframe at entry (executor-
  // captured; adoption enricher fills it for manual positions). Backtest input
  // for the "don't chase" rule.
  entry_price_change_pct = null,
  // Plan #12 phase 3: admission lane ("steady" = width hint applied). Analytics only.
  lane = null,
  initial_base_ratio_pct = null,
  // Asset-aware position identity. Normal bot deployments populate this on the
  // first RPC valuation tick; adopted/manual positions receive it during adoption
  // and enrichment before automatic management is armed.
  asset_profile = null,
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
  strategy_source = null,
  management_profile = null,
  rebalance_count = 0,
  parent_position = null,
  cumulative_fees_claimed_sol = 0,
  cumulative_fees_claimed_true_usd = 0,
  total_fees_claimed_sol = 0,
  total_fees_claimed_true_usd = 0,
  // Plan #15: Meteora lifetime deposits/withdrawals/fees of the account at
  // adoption time. Close paths subtract it so an adopted operator account's
  // recorded PnL covers the bot-managed span only (see applyAdoptionBasis).
  adoption_basis = null,
}) {
  const state = load();
  const storedStrategy = normalizePositionStrategy(strategy) || strategy || null;
  const storedStrategySource = strategy_source || (adopted ? "manual_adoption" : "bot_deploy");
  state.positions[position] = {
    position,
    pool,
    pool_name,
    base_mint: base_mint || signal_snapshot?.base_mint || null,
    strategy: storedStrategy,
    // Keep provenance separate from the display strategy so an adopted bot
    // deployment cannot be confused with a position created in the wallet UI.
    strategy_source: storedStrategySource,
    management_profile: management_profile || configuredManagementProfile(pool),
    management_profile_source: management_profile
      ? "explicit"
      : (configuredManagementProfile(pool) ? "config_pool" : null),
    asset_profile: normalizeAssetProfile(asset_profile),
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
    entry_price_change_pct: Number.isFinite(Number(entry_price_change_pct)) && entry_price_change_pct != null
      ? Number(entry_price_change_pct) : null,
    initial_base_ratio_pct: Number.isFinite(Number(initial_base_ratio_pct)) ? Number(initial_base_ratio_pct) : null,
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
    total_fees_claimed_sol: Number(total_fees_claimed_sol) || 0,
    total_fees_claimed_true_usd: Number(total_fees_claimed_true_usd) || 0,
    rebalance_count: Number(rebalance_count) || 0,
    parent_position: parent_position || null,
    cumulative_fees_claimed_sol: Number(cumulative_fees_claimed_sol) || 0,
    cumulative_fees_claimed_true_usd: Number(cumulative_fees_claimed_true_usd) || 0,
    closed: false,
    closed_at: null,
    hold_mode: false,
    hold_set_at: null,
    hold_reason: null,
    notes: initial_note ? [initial_note] : [],
    lazy: !!lazy,
    scout: !!scout,
    probe: !!probe,
    adoption_basis: adoption_basis && typeof adoption_basis === "object" ? adoption_basis : null,
    lane: typeof lane === "string" && lane ? lane : null,
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
    pending_exit_context: null,
    trailing_active: false,
    gas_cost_sol: gas_cost_sol || 0,
    total_gas_sol: gas_cost_sol || 0,
    // TWAP wick guard: rolling pnl_pct tick history + consecutive-deferral counter
    // (bounded by twapGuardMaxDeferrals). See applyTwapWickGuard in this file.
    pnl_tick_history: [],
    twap_guard_deferrals: 0,
    // Lifetime deferral count. twap_guard_deferrals is a CONSECUTIVE streak that is
    // reset to 0 the moment a tick looks non-wicky (or the cap is hit), so it reads 0
    // at close time on essentially every position — which is why no closed-position
    // record has ever carried evidence of a deferral. This one only ever increments.
    twap_guard_deferrals_total: 0,
    // Round-trip harvest (default OFF/shadow): rate-limits the would-harvest log.
    roundtrip_shadow_last_log_at: null,
    // Age-conditional "young stop" (default OFF/shadow): confirm-tick timer (mirrors
    // stop_loss_violated_since) + rate-limited shadow-log timestamp. See
    // updatePnlAndCheckExits / evaluateYoungStop.
    young_stop_violated_since: null,
    young_stop_shadow_last_log_at: null,
    // Close-efficiency gate (default OFF/shadow): cached base-side swap-impact quote
    // (rate-limited by closeEffQuoteMinIntervalSec) + observability counters. See
    // evaluateCloseEfficiency (this file) / evaluateCloseEfficiencyGate (index.js).
    close_eff_cached_impact_pct: null,
    close_eff_last_quote_at: null,
    close_eff_defer_count: 0,
    close_eff_last_defer_at: null,
    close_eff_shadow_last_log_at: null,
    // Adopted positions remain observe-only until the valuation pipeline has
    // produced the configured number of consecutive valid samples. Normal bot
    // deployments retain the historical immediately-managed behavior.
    valuation_valid_ticks: 0,
    management_armed: !adopted,
    management_armed_at: adopted ? null : new Date().toISOString(),
  };
  pushEvent(state, {
    action: event_action,
    position,
    pool_name: pool_name || pool,
    strategy: storedStrategy,
    strategy_source: storedStrategySource,
  });
  save(state);
  log("state", `${adopted ? "Adopted" : "Tracked new"} position: ${position} in pool ${pool}`);
}

/**
 * Transition state when a position is rebalanced into a new position account.
 * Closes the old position, tracks the new position carrying forward fee earnings,
 * increments rebalance_count, and links parent_position.
 */
/**
 * Resolves the original root deposit basis (SOL and USD) for a position.
 * Legacy positions may still store root_initial_sol / root_initial_usd (the
 * writers were removed 2026-09-25 with the lineage take-profit; stored values
 * are honoured). Otherwise walks parent_position pointers up to the root
 * ancestor and uses its amount_sol / initial_value_usd. Reader only — used by
 * the manual rebalancePosition path to size the proceeds re-deposit.
 *
 * @param {object} pos - tracked position object
 * @returns {{ sol: number | null, usd: number | null, rootPosition: string | null }}
 */
export function resolveRootInitialBasis(pos) {
  if (!pos) return { sol: null, usd: null, rootPosition: null };

  const sol = Number(pos.root_initial_sol);
  const usd = Number(pos.root_initial_usd);
  if (Number.isFinite(sol) && sol > 0) {
    return {
      sol,
      usd: Number.isFinite(usd) && usd > 0 ? usd : null,
      rootPosition: pos.root_parent_position || pos.parent_position || pos.position,
    };
  }

  // Recursive walk up parent_position pointers
  const state = load();
  const visited = new Set();
  let curr = pos;
  let root = pos;

  while (curr?.parent_position && !visited.has(curr.parent_position)) {
    visited.add(curr.parent_position);
    const parent = state.positions?.[curr.parent_position];
    if (!parent) break;
    root = parent;
    curr = parent;
    const parentSol = Number(root.root_initial_sol);
    if (Number.isFinite(parentSol) && parentSol > 0) {
      return {
        sol: parentSol,
        usd: Number.isFinite(Number(root.root_initial_usd)) ? Number(root.root_initial_usd) : null,
        rootPosition: root.position,
      };
    }
  }

  const rootSol = Number(root.root_initial_sol ?? root.amount_sol);
  const rootUsd = Number(root.root_initial_usd ?? root.initial_value_usd);
  return {
    sol: Number.isFinite(rootSol) && rootSol > 0 ? rootSol : (Number.isFinite(Number(pos.amount_sol)) ? Number(pos.amount_sol) : null),
    usd: Number.isFinite(rootUsd) && rootUsd > 0 ? rootUsd : (Number.isFinite(Number(pos.initial_value_usd)) ? Number(pos.initial_value_usd) : null),
    rootPosition: root?.position || pos?.position || null,
  };
}

export function rebalancePositionState({
  old_position_address,
  new_position_address,
  new_strategy,
  new_bin_range,
  active_bin,
  amount_sol = null,
  amount_x = null,
  reason = "rebalance",
  exit_pnl_usd = null,
  exit_pnl_true_usd = null,
  exit_pnl_pct = null,
  exit_pnl_sol = null,
  final_value_usd = null,
  lane = null,
}) {
  const state = load();
  const oldPos = state.positions[old_position_address];
  const oldRebalanceCount = Number(oldPos?.rebalance_count ?? 0);
  const oldFeesSol = Number(oldPos?.total_fees_claimed_sol ?? 0);
  const oldFeesTrueUsd = Number(oldPos?.total_fees_claimed_true_usd ?? 0);
  const oldFeesUsd = Number(oldPos?.total_fees_claimed_usd ?? 0);

  if (oldPos) {
    oldPos.closed = true;
    oldPos.closed_at = new Date().toISOString();
    if (exit_pnl_usd != null && Number.isFinite(Number(exit_pnl_usd))) {
      oldPos.exit_pnl_usd = Number(exit_pnl_usd);
    }
    if (exit_pnl_true_usd != null && Number.isFinite(Number(exit_pnl_true_usd))) {
      oldPos.exit_pnl_true_usd = Number(exit_pnl_true_usd);
    }
    if (exit_pnl_pct != null && Number.isFinite(Number(exit_pnl_pct))) {
      oldPos.exit_pnl_pct = Number(exit_pnl_pct);
    }
    if (exit_pnl_sol != null && Number.isFinite(Number(exit_pnl_sol))) {
      oldPos.exit_pnl_sol = Number(exit_pnl_sol);
    }
    if (final_value_usd != null && Number.isFinite(Number(final_value_usd))) {
      oldPos.final_value_usd = Number(final_value_usd);
    }
    oldPos.notes = Array.isArray(oldPos.notes) ? oldPos.notes : [];
    oldPos.notes.push(`Closed by rebalance: moved into ${new_position_address} (${reason})`);
  }

  // Preserve chain of rebalances and cumulative fees without corrupting the new
  // position account's on-chain PnL calculation against its new deposit basis.
  // Note: addToClaimLedger and syncClaimedFeesFloor already increment
  // cumulative_fees_claimed_true_usd/sol alongside total_fees_claimed_true_usd/sol.
  // Therefore, Math.max ensures we carry over the full cumulative total without
  // double-counting oldPos's own claimed fees.
  const cumulativeFeesSol = Math.max(Number(oldPos?.cumulative_fees_claimed_sol) || 0, oldFeesSol);
  const cumulativeFeesTrueUsd = Math.max(Number(oldPos?.cumulative_fees_claimed_true_usd) || 0, oldFeesTrueUsd);
  const cumulativeFeesUsd = Math.max(Number(oldPos?.cumulative_fees_claimed_usd) || 0, oldFeesUsd);

  trackPosition({
    position: new_position_address,
    pool: oldPos?.pool,
    pool_name: oldPos?.pool_name,
    base_mint: oldPos?.base_mint,
    strategy: new_strategy,
    strategy_source: oldPos?.strategy_source || "rebalance",
    management_profile: oldPos?.management_profile,
    asset_profile: oldPos?.asset_profile,
    bin_range: new_bin_range,
    amount_sol: amount_sol != null ? amount_sol : oldPos?.amount_sol,
    amount_x: amount_x != null ? amount_x : 0,
    active_bin,
    bin_step: oldPos?.bin_step,
    volatility: oldPos?.volatility,
    fee_tvl_ratio: oldPos?.fee_tvl_ratio,
    organic_score: oldPos?.organic_score,
    initial_value_usd: oldPos?.initial_value_usd,
    rebalance_count: oldRebalanceCount + 1,
    parent_position: old_position_address,
    lane: lane ?? oldPos?.lane ?? null,
    cumulative_fees_claimed_sol: cumulativeFeesSol,
    cumulative_fees_claimed_true_usd: cumulativeFeesTrueUsd,
    total_fees_claimed_sol: 0,
    total_fees_claimed_true_usd: 0,
    initial_note: `Rebalanced from parent position ${old_position_address} (${reason})`,
  });

  if (state.positions[new_position_address]) {
    state.positions[new_position_address].total_fees_claimed_usd = 0;
    state.positions[new_position_address].cumulative_fees_claimed_usd = cumulativeFeesUsd;
  }

  save(state);
  log("state", `Rebalanced state: ${old_position_address} -> ${new_position_address} (rebalance #${oldRebalanceCount + 1})`);
  return state.positions[new_position_address];
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
// One-time boot normalization for rows adopted before the "manual" default
// (2026-08-21): fresh-adopted rows (Case B below) were recorded with the old
// strategy default "spot" regardless of the position's true on-chain shape.
// Predicate is deliberately tight: adopted AND strategy "spot" AND zero
// recorded gas, with no bot provenance or deploy event. Runs in-process
// (index.js boot) so it can't clobber-race the cache the way external DB edits
// do. Idempotent; returns the number of rows rewritten.
export function normalizeAdoptedStrategies() {
  const state = load();
  let changed = 0;
  for (const pos of Object.values(state.positions || {})) {
    const eventHint = recentDeploymentStrategy(state, pos.position);
    const source = String(pos.strategy_source || "").toLowerCase();
    const hasBotProvenance = source.startsWith("bot_") || !!eventHint;
    if (pos.adopted && pos.strategy === "spot" && !(pos.gas_cost_sol > 0) && !hasBotProvenance) {
      pos.strategy = "manual";
      pos.strategy_source = "manual_adoption";
      changed++;
      log("state", `Normalized adopted position ${pos.position} strategy spot → manual`);
    }
  }
  if (changed) save(state);
  return changed;
}

/**
 * Plan #15: snapshot the Meteora lifetime deposits/withdrawals/fees of an account
 * at adoption. Pure; null when the scan carries no indexer figures yet (fresh
 * account, indexer lag) — callers treat null as "no baseline".
 */
export function buildAdoptionBasis(p, at = new Date().toISOString()) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const deposits_sol = n(p?.lifetime_deposits_sol);
  if (!(deposits_sol > 0)) return null;
  const withdrawals_sol = n(p?.lifetime_withdrawals_sol);
  const fees_sol = n(p?.lifetime_fees_sol);
  const deposits_usd = n(p?.lifetime_deposits_usd);
  const withdrawals_usd = n(p?.lifetime_withdrawals_usd);
  const fees_usd = n(p?.lifetime_fees_usd);
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return {
    at,
    deposits_sol: r6(deposits_sol),
    withdrawals_sol: r6(withdrawals_sol),
    fees_sol: r6(fees_sol),
    deposits_usd: Math.round(deposits_usd * 100) / 100,
    withdrawals_usd: Math.round(withdrawals_usd * 100) / 100,
    fees_usd: Math.round(fees_usd * 100) / 100,
    // Lifetime PnL the account had ALREADY realized/accrued before we managed it.
    // Meteora's closed-position pnl = withdrawals + fees − deposits, so the same
    // identity at adoption gives the pre-management share.
    pnl_sol: r6(withdrawals_sol + fees_sol - deposits_sol),
    pnl_usd: Math.round((withdrawals_usd + fees_usd - deposits_usd) * 100) / 100,
  };
}

/**
 * Plan #15: rebase Meteora's lifetime close figures to the bot-managed span for an
 * adopted account. Pure. Returns null when there is no basis (caller keeps the
 * lifetime figures). `capitalAtAdoption` = the value the row was baselined at
 * (tracked.amount_sol); post-adoption top-ups (lifetime deposits − basis deposits)
 * are added to it so pnl_pct is against the capital actually at risk under us.
 */
export function applyAdoptionBasis(tracked, lifetime) {
  const b = tracked?.adoption_basis;
  if (!b || !(Number(b.deposits_sol) > 0)) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const postDeposits = Math.max(0, n(lifetime.deposit_sol_true) - n(b.deposits_sol));
  const capitalAtAdoption = n(tracked.amount_sol) > 0 ? n(tracked.amount_sol) : Math.max(0, n(b.deposits_sol) - n(b.withdrawals_sol));
  const capital = capitalAtAdoption + postDeposits;
  // (lifetime − basis) is the CASH FLOW of the managed span (withdrawals + fees −
  // deposits after adoption). The inventory we took over at adoption is paid for
  // by pre-adoption deposits but comes back to us as post-adoption withdrawals, so
  // it must be charged against the span or it is booked as pure profit — GO-SOL
  // 2026-09-25: a 0.999 SOL account closed at +1.15% was recorded as +101%.
  const spanCashFlowSol = n(lifetime.pnl_sol) - n(b.pnl_sol);
  const pnl_sol = r6(spanCashFlowSol - capitalAtAdoption);
  // USD: value the adopted inventory at the account's own average deposit price
  // when the indexer gives both units, else at the SOL price supplied by the caller.
  const usdPerSol = n(lifetime.deposit_sol_true) > 0 && n(lifetime.deposit_usd_true) > 0
    ? n(lifetime.deposit_usd_true) / n(lifetime.deposit_sol_true)
    : n(lifetime.sol_price_usd);
  const capitalAtAdoptionUsd = capitalAtAdoption * usdPerSol;
  const pnl_usd_true = Math.round((n(lifetime.pnl_usd_true) - n(b.pnl_usd) - capitalAtAdoptionUsd) * 100) / 100;
  const fees_sol_true = r6(Math.max(0, n(lifetime.fees_sol_true) - n(b.fees_sol)));
  const fees_usd_true = Math.round(Math.max(0, n(lifetime.fees_usd_true) - n(b.fees_usd)) * 100) / 100;
  const pnl_pct = capital > 0 ? Math.round((pnl_sol / capital) * 10000) / 100 : 0;
  return {
    pnl_sol,
    pnl_usd_true,
    pnl_pct,
    fees_sol_true,
    fees_usd_true,
    deposit_sol_true: r6(capital),
    // Keep the lifetime figures for audit — they are what Meteora reports.
    lifetime: {
      pnl_sol: r6(n(lifetime.pnl_sol)),
      pnl_usd_true: Math.round(n(lifetime.pnl_usd_true) * 100) / 100,
      fees_sol_true: r6(n(lifetime.fees_sol_true)),
      deposit_sol_true: r6(n(lifetime.deposit_sol_true)),
      basis_at: b.at,
      basis_pnl_sol: r6(n(b.pnl_sol)),
    },
  };
}

export function adoptOrphanPosition(p, { reason = "reconciliation", extra = {} } = {}) {
  if (!p || !p.position) return false;
  const state = load();
  const existing = state.positions[p.position];
  const eventHint = recentDeploymentStrategy(state, p.position);
  const explicitStrategy = normalizePositionStrategy(extra.strategy);
  const isBotRecovery = /post-failure deploy verification/i.test(String(reason))
    || String(extra.strategy_source || "").startsWith("bot_");
  // Explicit recovery context is authoritative. For poller/reconciliation
  // adoption, only an earlier deploy event is strong enough to classify the
  // row as bot-created; otherwise it remains manual.
  const recoveredStrategy = isBotRecovery
    ? explicitStrategy
    : (eventHint?.strategy || null);
  const strategySource = isBotRecovery
    ? "bot_recovery"
    : recoveredStrategy
      ? "bot_deploy_recovered"
      : "manual_adoption";
  const noteReason = recoveredStrategy
    ? String(reason).replace(/manual deploy/gi, "recovered bot deploy")
    : reason;
  const note = `Auto-adopted during ${noteReason} (orphaned on-chain position, untracked in state)`;

  // Case A: a row exists but was wrongly marked closed → resurrect it in place,
  // preserving its history rather than clobbering the record.
  if (existing) {
    if (!existing.closed) return false; // already tracked & open — nothing to do
    existing.closed = false;
    existing.closed_at = null;
    existing.adopted = true;
    existing.adopted_at = new Date().toISOString(); // anchor the post-adoption exit grace
    existing.valuation_valid_ticks = 0;
    existing.management_armed = false;
    existing.management_armed_at = null;
    const configuredProfile = configuredManagementProfile(existing.pool || p.pool);
    if (configuredProfile) {
      existing.management_profile = configuredProfile;
      existing.management_profile_source = "config_pool";
      existing.trailing_active = false;
    }
    const existingProfile = normalizeAssetProfile(p.asset_profile || {
      token_x_mint: p.token_x_mint,
      token_y_mint: p.token_y_mint,
      token_x_symbol: p.token_x_symbol,
      token_y_symbol: p.token_y_symbol,
      token_x_decimals: p.token_x_decimals,
      token_y_decimals: p.token_y_decimals,
      source: "onchain_adoption",
    });
    if (existingProfile) existing.asset_profile = existingProfile;
    if (existingProfile && !pairNamesMatch(existing.pool_name, `${existingProfile.token_x_symbol || existingProfile.token_x_mint?.slice(0, 4) || "?"}-${existingProfile.token_y_symbol || existingProfile.token_y_mint?.slice(0, 4) || "?"}`)) {
      const sx = existingProfile.token_x_symbol || existingProfile.token_x_mint?.slice(0, 4) || "?";
      const sy = existingProfile.token_y_symbol || existingProfile.token_y_mint?.slice(0, 4) || "?";
      existing.pool_name = `${sx}-${sy}`;
    }
    existing.notes = Array.isArray(existing.notes) ? existing.notes : [];
    existing.notes.push(note);
    if (recoveredStrategy && (existing.strategy === "manual" || existing.adopted)) {
      existing.strategy = recoveredStrategy;
      existing.strategy_source = strategySource;
    } else if (!existing.strategy_source) {
      existing.strategy_source = existing.adopted ? "manual_adoption" : "bot_deploy";
    }
    pushEvent(state, {
      action: "adopt",
      position: p.position,
      pool_name: existing.pool_name || existing.pool,
      strategy: existing.strategy,
      strategy_source: existing.strategy_source,
    });
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
    // "manual" remains the safe default for a genuinely external position.
    // A bot deployment recovered from the orphan path gets its original
    // strategy from explicit recovery context or the deploy event above.
    strategy: recoveredStrategy || "manual",
    strategy_source: strategySource,
    management_profile: extra.management_profile || null,
    asset_profile: p.asset_profile || {
      token_x_mint: p.token_x_mint,
      token_y_mint: p.token_y_mint,
      token_x_symbol: p.token_x_symbol,
      token_y_symbol: p.token_y_symbol,
      token_x_decimals: p.token_x_decimals,
      token_y_decimals: p.token_y_decimals,
      source: "onchain_adoption",
      validated_at: new Date().toISOString(),
    },
    bin_range: {
      min: p.lower_bin ?? extra.min_bin ?? null,
      max: p.upper_bin ?? extra.max_bin ?? null,
      bins_below: extra.bins_below ?? null,
      bins_above: extra.bins_above ?? null,
    },
    // Baseline the deployed amount from the first-scan value when the caller has
    // no deploy context (manual/operator positions): under solMode the scan's
    // total_value_usd carries SOL (the documented unit landmine — here it is
    // exactly the SOL-denominated value we want). Adoption happens seconds-to-
    // minutes after creation, so first-scan value ≈ true deployed amount. Keeps
    // /positions sizing display, dashboards, and per-position analytics honest.
    amount_sol: extra.amount_sol
      ?? (config.management?.solMode && Number.isFinite(Number(p.total_value_usd))
        ? Number(p.total_value_usd)
        : null),
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
    // Preserve the scout tag through post-failure adoption — without this a
    // clamped 0.12 SOL scout whose deploy tx "failed" but landed on-chain is
    // re-tracked untagged (FROGE-SOL 2026-08-05): its perf record loses the
    // cohort label AND it stops occupying the scout concurrency slot.
    scout: !!extra.scout,
    probe: !!extra.probe,
    // Plan #15: lifetime figures of this account at adoption (from the scan's raw
    // Meteora fields). null when the indexer has nothing yet → close paths then
    // score the whole lifetime as before (and say so in [ADOPTION_BASIS]).
    adoption_basis: buildAdoptionBasis(p),
    deployed_at: deployedAt,
    initial_note: note,
    adopted: true,
    event_action: "adopt",
  });
  // Plan #12: fill the entry-market snapshot the bot's own deploys get from the
  // executor (mcap/tvl/volume/holders/fee ratio/organic/volatility/price change).
  // Without it every adopted row carries nulls and the learning engine is blind
  // to the manual cohort. Fire-and-forget; the enricher is injected from
  // index.js (state.js must not import tools/screening.js).
  if (typeof _adoptionEnricher === "function") {
    try {
      Promise.resolve(_adoptionEnricher(p.position, p.pool, p)).catch((e) =>
        log("state", `adoption enricher failed for ${p.position}: ${e?.message || e}`));
    } catch (e) {
      log("state", `adoption enricher threw for ${p.position}: ${e?.message || e}`);
    }
  }
  // A restart can leave the in-memory recent-event ring without the deploy
  // event. Under PostgreSQL, retry the durable event lookup after the adopt
  // write has flushed and repair only a still-manual row with matching bot
  // evidence. Genuine wallet-created manual positions remain untouched.
  if (!recoveredStrategy && usePg()) {
    void hydrateAdoptedStrategyFromEvent(p.position);
  }
  return true;
}

/**
 * Keep pool-scoped management profiles aligned with user-config. This is run
 * after state hydration at startup and is idempotent. Config-owned profiles are
 * removed when their pool leaves the allowlist; explicitly assigned profiles
 * are never overwritten.
 */
export function syncConfiguredManagementProfiles() {
  const state = load();
  let changed = 0;
  for (const pos of Object.values(state.positions || {})) {
    if (!pos || pos.closed) continue;
    const desired = configuredManagementProfile(pos.pool);
    if (desired && pos.management_profile !== desired) {
      pos.management_profile = desired;
      pos.management_profile_source = "config_pool";
      // A profile applied to an already-running position must immediately
      // disarm profit exits that may have armed under the global policy.
      pos.trailing_active = false;
      pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
      pos.notes.push(`Management profile set to ${desired} from pool allowlist`);
      changed++;
      continue;
    }
    if (!desired && pos.management_profile_source === "config_pool" && pos.management_profile) {
      pos.management_profile = null;
      pos.management_profile_source = null;
      pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
      pos.notes.push("Pool-scoped management profile removed");
      changed++;
    }
  }
  if (changed) {
    save(state);
    log("state", `Synchronized ${changed} pool-scoped management profile(s)`);
  }
  return changed;
}

/**
 * Correct a genuinely external/adopted position's display strategy from its
 * actual on-chain liquidity shape. Bot-deployed positions retain their known
 * deployment provenance. Returns the resolved strategy or null when ambiguous.
 */
export function reconcileAdoptedPositionStrategy(positionAddress, bins) {
  const inferred = inferPositionStrategyFromBins(bins);
  if (!inferred) return null;
  const pos = getTrackedPosition(positionAddress);
  if (!pos?.adopted) return pos?.strategy || null;
  const source = String(pos.strategy_source || "");
  if (pos.strategy !== "manual" && source !== "manual_adoption" && source !== "onchain_shape") {
    return pos.strategy;
  }
  if (pos.strategy !== inferred || source !== "onchain_shape") {
    repairPositionStrategy(positionAddress, inferred, {
      source: "onchain_shape",
      reason: "inferred from normalized on-chain bin distribution",
    });
  }
  return inferred;
}

/**
 * Look up a durable deploy event for an address. Newer deploy events carry the
 * resolved strategy; legacy events return no hint and remain conservative.
 */
export async function getPositionDeploymentHint(positionAddress) {
  if (!positionAddress) return null;
  const state = load();
  const inline = recentDeploymentStrategy(state, positionAddress);
  if (inline) return inline;
  if (!usePg()) return null;
  try {
    const { rows } = await query(
      "SELECT payload, created_at FROM position_events WHERE position_address = $1 AND kind = 'deploy' AND payload->>'strategy' IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [positionAddress],
    );
    const strategy = normalizePositionStrategy(rows[0]?.payload?.strategy);
    return strategy && strategy !== "manual"
      ? { strategy, at: rows[0]?.created_at || null, source: "bot_deploy_event" }
      : null;
  } catch (error) {
    log("state_warn", `Deployment strategy lookup failed for ${positionAddress}: ${error.message}`);
    return null;
  }
}

/** Correct a persisted strategy only when the caller has independent evidence. */
export function repairPositionStrategy(positionAddress, strategy, { source = "bot_deploy_recovered", reason = "deployment provenance" } = {}) {
  const nextStrategy = normalizePositionStrategy(strategy);
  if (!positionAddress || !nextStrategy || nextStrategy === "manual") return false;
  const state = load();
  const pos = state.positions[positionAddress];
  if (!pos || (pos.strategy === nextStrategy && pos.strategy_source === source)) return false;
  const previousStrategy = pos.strategy || null;
  pos.strategy = nextStrategy;
  pos.strategy_source = source;
  pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
  pos.notes.push(`Strategy corrected ${previousStrategy || "unknown"} → ${nextStrategy}: ${reason}`);
  pushEvent(state, {
    action: "strategy_repair",
    position: positionAddress,
    pool_name: pos.pool_name || pos.pool,
    previous_strategy: previousStrategy,
    strategy: nextStrategy,
    strategy_source: source,
    reason,
  });
  save(state);
  log("state", `Corrected strategy for ${positionAddress}: ${previousStrategy || "unknown"} → ${nextStrategy} (${reason})`);
  return true;
}

async function hydrateAdoptedStrategyFromEvent(positionAddress) {
  try {
    await flushState();
    const hint = await getPositionDeploymentHint(positionAddress);
    if (!hint?.strategy) return false;
    const pos = getTrackedPosition(positionAddress);
    if (!pos || pos.strategy !== "manual") return false;
    return repairPositionStrategy(positionAddress, hint.strategy, {
      source: "bot_deploy_recovered",
      reason: "durable deploy event",
    });
  } catch (error) {
    log("state_warn", `Adopted strategy hydration failed for ${positionAddress}: ${error.message}`);
    return false;
  }
}

// ── Plan #12: adoption entry-metrics enricher (injected) ──────────────────────
let _adoptionEnricher = null;

/** index.js registers an async (positionAddress, poolAddress) → void enricher. */
export function setAdoptionEnricher(fn) {
  _adoptionEnricher = typeof fn === "function" ? fn : null;
}

/**
 * Fill entry-market fields on a tracked position that are still null. Used by the
 * adoption enricher; never overwrites a value the deploy path already captured.
 * Returns the list of fields written.
 */
export function attachEntryMetrics(positionAddress, metrics = {}) {
  if (!positionAddress) return [];
  const state = load();
  const pos = state.positions[positionAddress];
  if (!pos) return [];
  const numeric = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const written = [];
  const setIfNull = (field, value) => {
    const v = numeric(value);
    if (v == null) return;
    if (pos[field] == null) { pos[field] = v; written.push(field); }
  };
  setIfNull("entry_mcap", metrics.entry_mcap);
  setIfNull("entry_tvl", metrics.entry_tvl);
  setIfNull("entry_volume", metrics.entry_volume);
  setIfNull("entry_holders", metrics.entry_holders);
  setIfNull("fee_tvl_ratio", metrics.fee_tvl_ratio);
  setIfNull("initial_fee_tvl_24h", metrics.fee_tvl_ratio);
  setIfNull("organic_score", metrics.organic_score);
  setIfNull("volatility", metrics.volatility);
  setIfNull("entry_price_change_pct", metrics.entry_price_change_pct);
  if (!pos.base_mint && typeof metrics.base_mint === "string" && metrics.base_mint) {
    pos.base_mint = metrics.base_mint;
    written.push("base_mint");
  }
  if (written.length) save(state);
  return written;
}

/**
 * Persist authoritative two-leg asset identity discovered during adoption.
 * This is deliberately repairable: a provisional display pair such as SOL-SOL
 * must not survive once pool metadata identifies the actual quote asset.
 */
export function attachAssetProfile(positionAddress, profile, { pairName = null } = {}) {
  if (!positionAddress) return false;
  const normalized = normalizeAssetProfile(profile);
  if (!normalized) return false;
  const state = load();
  const pos = state.positions[positionAddress];
  if (!pos) return false;
  const sameIdentity = JSON.stringify(comparableAssetProfile(pos.asset_profile || null)) === JSON.stringify(comparableAssetProfile(normalized));
  let changed = !sameIdentity || pos.asset_profile?.source !== normalized.source;
  if (!sameIdentity || changed) {
    pos.asset_profile = {
      ...normalized,
      validated_at: sameIdentity ? (pos.asset_profile?.validated_at || normalized.validated_at) : normalized.validated_at,
    };
  }
  if (pos.adopted && pairName && !pairNamesMatch(pos.pool_name, pairName)) {
    if (pos.pool_name !== pairName) {
      pos.pool_name = pairName;
      changed = true;
    }
  }
  if (changed) save(state);
  return changed;
}

/**
 * Record the valuation quality of the latest on-chain sample and control when
 * an adopted position becomes eligible for automatic management.
 */
export function recordPositionValuationState(positionAddress, {
  quality = "invalid",
  asset_profile = null,
  pair_name = null,
} = {}) {
  if (!positionAddress) return { management_armed: false, valid_ticks: 0 };
  const state = load();
  const pos = state.positions[positionAddress];
  if (!pos || pos.closed) {
    return { management_armed: false, valid_ticks: 0 };
  }

  let changed = false;
  const normalized = normalizeAssetProfile(asset_profile);
  if (normalized) {
    const sameIdentity = JSON.stringify(comparableAssetProfile(pos.asset_profile || null)) === JSON.stringify(comparableAssetProfile(normalized));
    if (!sameIdentity) {
      pos.asset_profile = {
        ...normalized,
        validated_at: normalized.validated_at || new Date().toISOString(),
      };
      changed = true;
    }
  }
  if (pos.adopted && pair_name && !pairNamesMatch(pos.pool_name, pair_name)) {
    pos.pool_name = pair_name;
    changed = true;
  }

  if (pos.adopted === true) {
    const required = Math.max(1, Math.floor(Number(config.management?.postAdoptionValidTicks ?? 2)));
    const priorTicks = Math.max(0, Number(pos.valuation_valid_ticks ?? 0));
    const validTicks = quality === "valid" ? Math.min(required, priorTicks + 1) : 0;
    if (pos.valuation_valid_ticks !== validTicks) {
      pos.valuation_valid_ticks = validTicks;
      changed = true;
    }
    if (validTicks >= required && pos.management_armed !== true) {
      pos.management_armed = true;
      pos.management_armed_at = new Date().toISOString();
      changed = true;
      log("state", `Position ${positionAddress} automatic management armed after ${validTicks} valid valuation ticks`);
    } else if (validTicks < required && pos.management_armed !== true) {
      if (pos.management_armed !== false) {
        pos.management_armed = false;
        changed = true;
      }
      if (pos.management_armed_at != null) {
        pos.management_armed_at = null;
        changed = true;
      }
    }
  } else if (pos.management_armed !== true) {
    // Older bot-created rows predate this field; preserve their existing
    // immediately-managed semantics.
    pos.management_armed = true;
    pos.management_armed_at ||= new Date().toISOString();
    changed = true;
  }

  if (changed) save(state);
  return {
    management_armed: pos.management_armed !== false,
    valid_ticks: Number(pos.valuation_valid_ticks ?? 0),
    quality,
    asset_profile: pos.asset_profile || null,
    pair_name: pos.pool_name || null,
  };
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
  if (pos.cumulative_fees_claimed_sol != null) {
    pos.cumulative_fees_claimed_sol = (pos.cumulative_fees_claimed_sol || 0) + solNum;
    pos.cumulative_fees_claimed_true_usd = (pos.cumulative_fees_claimed_true_usd || 0) + usdNum;
    pos.cumulative_fees_claimed_usd = (pos.cumulative_fees_claimed_usd || 0)
      + (config.management.solMode ? solNum : usdNum);
  }
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
 * Synchronize position claimed fees with external indexer (Meteora allTimeFees).
 * If the indexer reports a higher claimed fee than our local ledger (e.g. from
 * pre-adoption claims or manual claims on Meteora UI), floor the local ledger up
 * to match the indexer. Never decrements the ledger (which protects against lagging indexer).
 */
export function syncClaimedFeesFloor(position_address, { sol = 0, usd = 0 } = {}) {
  const solNum = Number.isFinite(Number(sol)) ? Math.max(0, Number(sol)) : 0;
  const usdNum = Number.isFinite(Number(usd)) ? Math.max(0, Number(usd)) : 0;
  if (solNum <= 0 && usdNum <= 0) return false;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;

  const currentSol = Number(pos.total_fees_claimed_sol) || 0;
  const currentTrueUsd = Number(pos.total_fees_claimed_true_usd) || 0;

  // Only update if indexer reports higher than what we have recorded
  const deltaSol = Math.max(0, solNum - currentSol);
  const deltaUsd = Math.max(0, usdNum - currentTrueUsd);

  // Require a non-trivial delta to avoid floating point churn
  if (deltaSol <= 0.000001 && deltaUsd <= 0.01) return false;

  pos.total_fees_claimed_sol = Math.max(currentSol, solNum);
  pos.total_fees_claimed_true_usd = Math.max(currentTrueUsd, usdNum);
  pos.total_fees_claimed_usd = config.management.solMode
    ? pos.total_fees_claimed_sol
    : pos.total_fees_claimed_true_usd;

  if (pos.cumulative_fees_claimed_sol != null) {
    pos.cumulative_fees_claimed_sol = (pos.cumulative_fees_claimed_sol || 0) + deltaSol;
    pos.cumulative_fees_claimed_true_usd = (pos.cumulative_fees_claimed_true_usd || 0) + deltaUsd;
    pos.cumulative_fees_claimed_usd = config.management.solMode
      ? pos.cumulative_fees_claimed_sol
      : pos.cumulative_fees_claimed_true_usd;
  }

  save(state);
  log("state", `Position ${position_address.slice(0, 8)} claimed fees floored to indexer: sol=${pos.total_fees_claimed_sol.toFixed(6)}, usd=$${pos.total_fees_claimed_true_usd.toFixed(2)}`);
  return true;
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
  pos.close_reason = reason;
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
    old.close_reason = `rebalanced into ${new_position}`;
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
 * Enable or disable an explicit operator hold for a position.
 *
 * An operator hold is stronger than free-text instructions: it suppresses every
 * automatic close/flip path (TP, SL, trailing, OOR, crash/rug and health review)
 * while leaving fee claims available. It is persisted so a restart cannot lose
 * the operator's intent. Manual /close remains an explicit operator action.
 */
/**
 * Hold-cohort give-back (audit 01 §4.3, 2026-09-25). Pure decision: a hold_mode position that has
 * given back >= holdGiveBackAlertPp from its confirmed peak gets ONE alert per step (10, 20, 30 … pp);
 * the step latch resets once the give-back recovers below the first step, so a second round trip
 * alerts again. Visibility only — no exit rule reads this.
 * Returns { alert, reset, drop_pp, level_pp, peak, current }.
 */
export function evaluateHoldGiveBack(pos, currentPnlPct, mgmtConfig = {}) {
  const stepPp = Number(mgmtConfig.holdGiveBackAlertPp ?? 10);
  const peak = Number(pos?.peak_pnl_pct);
  const cur = Number(currentPnlPct);
  if (!pos || pos.hold_mode !== true || !(stepPp > 0) || !Number.isFinite(peak) || !Number.isFinite(cur)) {
    return { alert: false, reset: false };
  }
  const drop = peak - cur;
  const lastLevel = Number(pos.hold_giveback_alert_pp ?? 0);
  if (drop < stepPp) return { alert: false, reset: lastLevel > 0, drop_pp: drop, level_pp: 0, peak, current: cur };
  const level = Math.floor(drop / stepPp) * stepPp;
  if (level <= lastLevel) return { alert: false, reset: false, drop_pp: drop, level_pp: level, peak, current: cur };
  return { alert: true, reset: false, drop_pp: drop, level_pp: level, peak, current: cur };
}

export function noteHoldGiveBackAlert(position_address, levelPp) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.hold_giveback_alert_pp = Number(levelPp) || 0;
  pos.hold_giveback_alert_at = pos.hold_giveback_alert_pp > 0 ? new Date().toISOString() : null;
  save(state);
  return true;
}

export function setPositionHold(position_address, enabled = true, reason = null) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;

  const hold = !!enabled;
  pos.hold_mode = hold;
  pos.hold_set_at = hold ? new Date().toISOString() : null;
  pos.hold_reason = hold ? sanitizeStoredText(reason) : null;

  if (hold) {
    // A signal may have been staged by the 3s poller immediately before the
    // Telegram request arrived. Do not let that stale signal fire after hold.
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
    pos.pending_exit_context = null;
    pos.stop_loss_violated_since = null;
    pos.young_stop_violated_since = null;
    pos.twap_guard_deferrals = 0;
  }

  pushEvent(state, {
    action: hold ? "hold" : "resume",
    position: position_address,
    pool_name: pos.pool_name || pos.pool,
    reason: pos.hold_reason || (hold ? "operator hold" : "operator resumed"),
  });
  save(state);
  log(
    "state",
    "Position " + position_address + " operator hold " + (hold ? "enabled" : "cleared") +
      (pos.hold_reason ? ": " + pos.hold_reason : "")
  );
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
 * `metadata` is captured on the first tick of a signal streak and returned when
 * the signal fires, allowing the caller to report first-breach telemetry even if
 * the confirming tick has a materially different PnL.
 * Returns { fire, action, count, started_at, first_context }.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2, metadata = null, { fresh = true } = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  // A tick that repeats the previous valuation is not a confirming observation
  // (audit 01 §8): keep the pending streak as it is and never fire on it.
  if (signal && !fresh) {
    return {
      fire: false,
      action: pos.pending_exit_action === signal ? signal : null,
      count: pos.pending_exit_action === signal ? Number(pos.pending_exit_count ?? 0) : 0,
      first_context: pos.pending_exit_context || null,
      stale: true,
    };
  }

  if (!signal) {
    if (pos.pending_exit_action != null || pos.pending_exit_context != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      pos.pending_exit_started_at = null;
      pos.pending_exit_context = null;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  let startedAt;
  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
    startedAt = pos.pending_exit_started_at;
    if (!startedAt) {
      pos.pending_exit_started_at = new Date().toISOString();
      startedAt = pos.pending_exit_started_at;
    }
    if (pos.pending_exit_context == null && metadata && typeof metadata === "object") {
      pos.pending_exit_context = { ...metadata };
    }
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = new Date().toISOString();
    pos.pending_exit_context = metadata && typeof metadata === "object" ? { ...metadata } : null;
    startedAt = pos.pending_exit_started_at;
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  const firstContext = pos.pending_exit_context || null;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
    pos.pending_exit_context = null;
  }
  save(state);
  if (fire) log("state", `Position ${position_address} exit signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count, started_at: startedAt, first_context: firstContext };
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
      management_profile: p.management_profile || null,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
      hold_mode: p.hold_mode === true,
      hold_set_at: p.hold_set_at || null,
      hold_reason: p.hold_reason || null,
      management_armed: p.management_armed !== false,
      asset_profile: p.asset_profile || null,
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

// ─── Age-conditional stop-loss ("young stop") (empirical: 2026-07-19, 137 paths) ──
//
// A tighter stop that applies ONLY to positions whose base token was younger than
// youngStopMaxAgeHours (default 12) at deploy. In-sample, young tokens had a ~19%
// disaster rate (vs 7.8% older); a −10% young-only stop had ZERO winner-kills (no
// young winner ever dipped ≤−10) and cut disasters ~3–7pt earlier than the global
// −15 stop. −5 was REJECTED (two best winners dipped −5.8/−6.1 mid-hold → whipsaw).
//
// Unknown age (null) → NOT young → never tightens (fail open). Firing routes
// through the same confirm-tick + gateExit TWAP wick guard as the plain stop, and
// NEVER touches the crash fast-path (separate path).
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
 * @param {object} opts - { stopPct, maxAgeHours }
 * @returns {{ isYoung: boolean, wouldFire: boolean }}
 */
export function evaluateYoungStop(tokenAgeHoursAtDeploy, currentPnlPct, opts = {}) {
  const stopPct = Number(opts.stopPct ?? DEFAULT_YOUNG_STOP_PCT);
  const maxAgeHours = Number(opts.maxAgeHours ?? DEFAULT_YOUNG_STOP_MAX_AGE_HOURS);

  // Guard null/undefined BEFORE Number() — Number(null) is 0, which would wrongly
  // read as a 0h-old (very young) token. Unknown age must fail open (NOT young).
  const age = tokenAgeHoursAtDeploy == null ? NaN : Number(tokenAgeHoursAtDeploy);
  const isYoung = Number.isFinite(age) && age < maxAgeHours;

  let wouldFire = false;
  if (isYoung && Number.isFinite(currentPnlPct) && currentPnlPct <= stopPct) {
    wouldFire = true;
  }
  return { isYoung, wouldFire };
}

// ─── Toxic Inventory Conversion Guard ────────────────────────────────
export const DEFAULT_TOXIC_CONVERSION_THRESHOLD_PCT = 85;
export const DEFAULT_TOXIC_CONVERSION_MAX_AGE_MINUTES = 20;
export const DEFAULT_TOXIC_CONVERSION_MAX_FEE_YIELD_PCT = 1.5;

/**
 * Pure decision function for the Toxic Inventory Conversion Guard.
 * Triggers when a position rapidly converts into the base token (>= 85% Token X)
 * within a short deployment window (<= 20m) without sufficient fee yield (< 1.5%).
 *
 * @param {object} pos - state position object
 * @param {object} positionData - on-chain/pnl poller position data
 * @param {object} opts - { thresholdPct, maxAgeMinutes, maxFeeYieldPct }
 * @returns {{ wouldFire: boolean, tokenXRatioPct?: number, ageMin?: number, feeYieldPct?: number, reason?: string }}
 */
export function evaluateToxicConversion(pos, positionData, opts = {}) {
  const thresholdPct = Number(opts.thresholdPct ?? DEFAULT_TOXIC_CONVERSION_THRESHOLD_PCT);
  const maxAgeMinutes = Number(opts.maxAgeMinutes ?? DEFAULT_TOXIC_CONVERSION_MAX_AGE_MINUTES);
  const maxFeeYieldPct = Number(opts.maxFeeYieldPct ?? DEFAULT_TOXIC_CONVERSION_MAX_FEE_YIELD_PCT);

  const liqX = Number(positionData?.liq_x_usd || 0);
  const liqY = Number(positionData?.liq_y_usd || 0);
  const totalLiq = liqX + liqY;
  if (totalLiq <= 0) return { wouldFire: false };

  // Resolve base vs quote asset:
  // If base_mint matches token_y_mint, or token_x_mint is SOL, token Y is the risky base asset.
  const solMint = config.tokens?.SOL || "So11111111111111111111111111111111111111112";
  const isBaseY = (pos?.base_mint && positionData?.token_y_mint && pos.base_mint === positionData.token_y_mint) ||
    (positionData?.token_x_mint && positionData.token_x_mint === solMint && positionData?.token_y_mint !== solMint) ||
    (pos?.asset_profile?.token_x_mint === solMint && pos?.asset_profile?.token_y_mint !== solMint);

  const baseLiq = isBaseY ? liqY : liqX;
  const quoteLiq = isBaseY ? liqX : liqY;
  const baseRatioPct = (baseLiq / totalLiq) * 100;
  const tokenXRatioPct = baseRatioPct; // Backward compatibility with caller assertions

  const deployedAtMs = pos?.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
  const ageMin = deployedAtMs ? (Date.now() - deployedAtMs) / 60000 : Number(positionData?.age_minutes ?? 0);
  const feeYieldPct = Number(positionData?.fee_yield_pct ?? 0);

  // Skip if deliberately deployed with high initial base inventory (e.g. entry base inventory >= 70%)
  const initialBaseRatio = Number(pos?.initial_base_ratio_pct ?? opts.initialBaseRatioPct);
  if (Number.isFinite(initialBaseRatio) && initialBaseRatio >= 70) {
    return {
      wouldFire: false,
      tokenXRatioPct,
      baseRatioPct,
      ageMin,
      feeYieldPct,
      reason: `Deliberate high initial base inventory (${initialBaseRatio.toFixed(1)}% >= 70%)`,
    };
  }

  if (baseRatioPct >= thresholdPct && ageMin <= maxAgeMinutes && feeYieldPct < maxFeeYieldPct) {
    const baseLabel = isBaseY ? "Token Y" : "Token X";
    return {
      wouldFire: true,
      tokenXRatioPct,
      baseRatioPct,
      ageMin,
      feeYieldPct,
      reason: `Toxic conversion: Position is ${baseRatioPct.toFixed(1)}% converted to base token (${baseLabel}) within ${Math.round(ageMin)}m (threshold: >=${thresholdPct}% in <=${maxAgeMinutes}m) with low fee yield (${feeYieldPct.toFixed(2)}% < ${maxFeeYieldPct}%)`,
    };
  }

  return { wouldFire: false, tokenXRatioPct, baseRatioPct, ageMin, feeYieldPct };
}

// ─── Dynamic Fee Surge Decay & Rotation Engine ────────────────────────
export const DEFAULT_SURGE_DECAY_THRESHOLD_PCT = 50;
export const DEFAULT_SURGE_DECAY_MIN_AGE_MINUTES = 15;
export const SURGE_SHADOW_LOG_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Pure decision function for dynamic fee surge decay.
 * Detects when a position's dynamic fee or 24h fee/TVL has collapsed by >=50%
 * from its observed peak after at least 15m, while PnL is non-negative.
 *
 * @param {object} pos - state position object
 * @param {object} positionData - on-chain/pnl poller position data
 * @param {object} opts - { thresholdPct, minAgeMinutes }
 * @returns {{ wouldFire: boolean, type?: string, dropPct?: number, peak?: number, current?: number, reason?: string }}
 */
export function evaluateSurgeDecay(pos, positionData, opts = {}) {
  const thresholdPct = Number(opts.thresholdPct ?? DEFAULT_SURGE_DECAY_THRESHOLD_PCT);
  const minAgeMinutes = Number(opts.minAgeMinutes ?? DEFAULT_SURGE_DECAY_MIN_AGE_MINUTES);
  const currentPnlPct = Number(positionData?.pnl_pct ?? 0);

  const deployedAtMs = pos?.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
  const ageMin = deployedAtMs ? (Date.now() - deployedAtMs) / 60000 : Number(positionData?.age_minutes ?? 0);
  if (ageMin < minAgeMinutes || currentPnlPct < 0) {
    return { wouldFire: false, ageMin, currentPnlPct };
  }

  const dynamicFee = positionData?.dynamic_fee_pct != null ? Number(positionData.dynamic_fee_pct) : null;
  const feeTvl24h = positionData?.fee_per_tvl_24h != null ? Number(positionData.fee_per_tvl_24h) : null;
  const peakDynamic = pos?.peak_dynamic_fee_pct != null ? Number(pos.peak_dynamic_fee_pct) : null;
  const peakFeeTvl = pos?.peak_fee_per_tvl_24h != null ? Number(pos.peak_fee_per_tvl_24h) : null;

  if (peakDynamic != null && peakDynamic >= 0.5 && dynamicFee != null) {
    const dropPct = ((peakDynamic - dynamicFee) / peakDynamic) * 100;
    if (dropPct >= thresholdPct) {
      return {
        wouldFire: true,
        type: "dynamic_fee",
        dropPct,
        peak: peakDynamic,
        current: dynamicFee,
        reason: `Dynamic fee collapsed ${dropPct.toFixed(1)}% (peak ${peakDynamic}% → current ${dynamicFee}%) at age ${Math.round(ageMin)}m with PnL +${currentPnlPct.toFixed(2)}%`,
      };
    }
  }

  if (peakFeeTvl != null && peakFeeTvl >= 5.0 && feeTvl24h != null) {
    const dropPct = ((peakFeeTvl - feeTvl24h) / peakFeeTvl) * 100;
    if (dropPct >= thresholdPct) {
      return {
        wouldFire: true,
        type: "fee_tvl",
        dropPct,
        peak: peakFeeTvl,
        current: feeTvl24h,
        reason: `Fee/TVL yield collapsed ${dropPct.toFixed(1)}% (peak ${peakFeeTvl}% → current ${feeTvl24h}%) at age ${Math.round(ageMin)}m with PnL +${currentPnlPct.toFixed(2)}%`,
      };
    }
  }

  return { wouldFire: false, ageMin, currentPnlPct };
}

// ─── Close-efficiency gate (RSRLP closeMinReturnPct pattern) ───────────────
//
// Trailing-TP fires on GROSS pnl_pct, but closing a position costs gas (claim +
// close + swap) plus Jupiter price impact on the base-token remainder that must
// be swapped back to SOL. At our position sizes a "+2% win" can net a loss once
// those are subtracted. This pure function turns the pre-gathered cost inputs
// (a base-side swap-impact quote + a gas estimate, both fetched by the async
// orchestration in index.js) into a net-of-cost pnl and a defer decision.
//
// Applies ONLY to the TRAILING_TP exit rule — the caller enforces that. Costs
// are expressed as a percentage OF THE POSITION VALUE so they subtract directly
// from gross pnl_pct:
//   impactCostSol = baseValueSol * quotedImpactPct/100   (the base-side remainder
//                   loses ~impact% of its own SOL value on the swap)
//   impactCostPct = impactCostSol / positionValueSol * 100
//   gasCostPct    = gasSol       / positionValueSol * 100
//   netPnlPct     = grossPnlPct - (impactCostPct + gasCostPct)
// Defer when netPnlPct < minNetPnlPct.
//
// Fail-open by construction: a non-finite gross pnl or a non-positive position
// value returns { defer:false } (the caller also fails open on any quote error).
// A null quotedImpactPct (dust base side skipped the quote) contributes zero
// impact — still a valid low-cost case, distinct from a quote FAILURE, which the
// caller intercepts before ever reaching here.
export function evaluateCloseEfficiency({
  grossPnlPct,
  positionValueSol,
  baseValueSol,
  quotedImpactPct,
  gasSol,
  minNetPnlPct = 0.5,
} = {}) {
  const gross = Number(grossPnlPct);
  const posVal = Number(positionValueSol);
  const floor = Number(minNetPnlPct);
  if (!Number.isFinite(gross) || !Number.isFinite(posVal) || posVal <= 0) {
    return { defer: false, netPnlPct: null, costPct: null, impactCostPct: null, gasCostPct: null };
  }

  const baseVal = Number.isFinite(Number(baseValueSol)) ? Math.max(0, Number(baseValueSol)) : 0;
  const impactPct = Number.isFinite(Number(quotedImpactPct)) ? Math.max(0, Number(quotedImpactPct)) : 0;
  const gas = Number.isFinite(Number(gasSol)) ? Math.max(0, Number(gasSol)) : 0;

  const impactCostSol = baseVal * (impactPct / 100);
  const impactCostPct = (impactCostSol / posVal) * 100;
  const gasCostPct = (gas / posVal) * 100;
  const costPct = impactCostPct + gasCostPct;
  const netPnlPct = gross - costPct;
  const defer = Number.isFinite(floor) ? netPnlPct < floor : false;

  return { defer, netPnlPct, costPct, impactCostPct, gasCostPct };
}

/**
 * Estimate the base-token (token X) fraction of a single-sided position's value
 * from bin geometry — the portion that must be swapped to SOL on close. In a
 * Meteora DLMM, bins below the active price hold quote (token Y = SOL), bins above
 * hold base (token X); for a ~uniform (spot) distribution the base fraction is the
 * share of the range that sits above the active bin:
 *   below range (active < lower) → 1 (all base)   above range (active > upper) → 0
 * Approximate for curve/bidask shapes; used only as an advisory cost input (the
 * feature is shadow-first + fail-open), never for money math. Returns 0 when the
 * bins are missing/degenerate (fail-open: no base assumed → no impact cost).
 */
// ── Round-trip harvest ────────────────────────────────────────────────────────
const DEFAULT_ROUNDTRIP_MIN_PNL_PCT = 1.0;
const DEFAULT_ROUNDTRIP_FROZEN_TICKS = 6;      // ~4.5 min at the ~45s poller cadence
const DEFAULT_ROUNDTRIP_EPSILON_PCT = 0.05;    // pnl considered unchanged within this
const DEFAULT_ROUNDTRIP_MIN_BINS_ABOVE = 5;
const ROUNDTRIP_SHADOW_LOG_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Pure decision: has this position completed a full round trip and locked its gain?
 *
 * A single-sided SOL ladder sits in bins BELOW spot, so those bins hold SOL. When price
 * falls through the ladder that SOL converts to base token; when price rallies back out
 * the TOP, each bin sells its base token back into SOL. Once the active bin is clear of
 * the whole range the position is 100% SOL, which means three things at once: the gain
 * is already realized, there is NO further upside, and an exit pays no swap slippage
 * because there is nothing left to sell.
 *
 * Measured live on CATE-SOL (2026-07-27): pnl pinned at exactly 7.98% across 12
 * consecutive poller ticks while the active bin swung 16 -> 28 bins above the range —
 * a ~12% price move with zero pnl response.
 *
 * Nothing in the existing rule set harvests this:
 *   - trailing TP        needs pnl to DROP from peak; a frozen pnl never drops
 *   - RULE_3             needs outOfRangeBinsToClose (50) bins above
 *   - RULE_4 (OOR-above) needs a CONTINUOUS outOfRangeWaitMinutesAbove (720m), and the
 *                        clock resets on ANY wick back into range — observed resetting
 *                        every few minutes while price oscillated on the boundary
 * so the capital sits earning zero fees while still exposed to giving the gain back if
 * price falls back through the ladder.
 *
 * The frozen-pnl test is the load-bearing part. It PROVES the conversion completed
 * rather than inferring it from bin position alone, and that proof is what makes the
 * exit provably free rather than merely probably cheap.
 */
export function evaluateRoundTripHarvest(pos, currentPnlPct, mgmtConfig = {}, activeBin, upperBin) {
  const none = { harvest: false, reason: null, bins_above: null };
  if (!pos || pos.closed) return none;
  if (currentPnlPct == null || !Number.isFinite(currentPnlPct)) return none;

  const num = (v, d) => (Number.isFinite(v) ? Number(v) : d);
  const minPnl    = num(mgmtConfig.roundTripMinPnlPct, DEFAULT_ROUNDTRIP_MIN_PNL_PCT);
  const needTicks = num(mgmtConfig.roundTripFrozenTicks, DEFAULT_ROUNDTRIP_FROZEN_TICKS);
  const eps       = num(mgmtConfig.roundTripFrozenEpsilonPct, DEFAULT_ROUNDTRIP_EPSILON_PCT);
  const minAbove  = num(mgmtConfig.roundTripMinBinsAbove, DEFAULT_ROUNDTRIP_MIN_BINS_ABOVE);

  // Must be clear of the TOP of the range by a margin. A position oscillating on the
  // boundary is still crossing bins, so it is still converting and still earning fees.
  const a = activeBin != null ? Number(activeBin) : null;
  const hi = upperBin != null ? Number(upperBin) : null;
  if (a == null || hi == null || !Number.isFinite(a) || !Number.isFinite(hi)) return none;
  const binsAbove = a - hi;
  if (binsAbove < minAbove) return none;

  // Only ever harvests a WIN. A position frozen at a LOSS above range is a different
  // problem and must fall through to the stop-loss / OOR rules — never be called a
  // "harvest", which would launder a loss into a success in the outcome record.
  if (currentPnlPct < minPnl) return none;

  const hist = Array.isArray(pos.pnl_tick_history) ? pos.pnl_tick_history : [];
  if (hist.length < needTicks) return none;
  const frozen = hist
    .slice(-needTicks)
    .every((v) => Number.isFinite(v) && Math.abs(v - currentPnlPct) <= eps);
  if (!frozen) return none;

  return {
    harvest: true,
    bins_above: binsAbove,
    reason:
      `Round-trip complete: ${binsAbove} bins above range, pnl frozen at ` +
      `${currentPnlPct.toFixed(2)}% across ${needTicks} ticks (+/-${eps}pp) — position is ` +
      `all-SOL, no further upside, exit pays no slippage`,
  };
}

export function estimateBaseTokenFraction(activeBin, lowerBin, upperBin) {
  // Guard null/undefined BEFORE Number() — Number(null) is 0, which would read as a
  // valid (very low) bin and manufacture a bogus fraction. Missing → fail-open (0).
  if (activeBin == null || lowerBin == null || upperBin == null) return 0;
  const a = Number(activeBin), lo = Number(lowerBin), hi = Number(upperBin);
  if (![a, lo, hi].every(Number.isFinite) || hi <= lo) return 0;
  const frac = (hi - a) / (hi - lo);
  if (!Number.isFinite(frac)) return 0;
  return Math.min(1, Math.max(0, frac));
}

/**
 * Persist close-efficiency tracking fields on a position (cached quote +
 * observability counters). Restricted to the known close_eff_* keys so an
 * internal caller can't accidentally clobber unrelated state. No-op if the
 * position isn't tracked. Mirrors the twap field bookkeeping.
 */
const CLOSE_EFF_FIELDS = new Set([
  "close_eff_cached_impact_pct",
  "close_eff_last_quote_at",
  "close_eff_defer_count",
  "close_eff_last_defer_at",
  "close_eff_shadow_last_log_at",
]);
export function recordCloseEffTracking(position_address, patch = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (CLOSE_EFF_FIELDS.has(k) && pos[k] !== v) { pos[k] = v; changed = true; }
  }
  if (changed) save(state);
  return changed;
}

// Trailing TP is defined as a drop in percentage points from the confirmed peak.
// A separate absolute floor is optional, and overshoot is deliberately measured
// against the effective threshold so a large first breach can skip confirmation.
const DEFAULT_TRAILING_OVERSHOOT_PCT = 0.5;

/**
 * Pure trailing-take-profit decision. Returns null until the current PnL is at or
 * below the effective threshold. `minPnlPct` is an optional absolute profit floor;
 * `overshootPct` is the first-breach margin that bypasses consecutive confirmation.
 */
export function evaluateTrailingTakeProfit(peakPnlPct, currentPnlPct, opts = {}) {
  const peak = Number(peakPnlPct);
  const current = Number(currentPnlPct);
  const dropPct = Number(opts.dropPct);
  if (!Number.isFinite(peak) || !Number.isFinite(current) || !Number.isFinite(dropPct) || dropPct < 0) {
    return null;
  }

  const rawFloor = opts.minPnlPct;
  const floor = rawFloor == null || rawFloor === "" ? null : Number(rawFloor);
  const hasFloor = Number.isFinite(floor);
  const peakThreshold = peak - dropPct;
  const threshold = hasFloor ? Math.max(peakThreshold, floor) : peakThreshold;
  if (current > threshold) return null;

  const dropFromPeak = peak - current;
  const overshoot = Math.max(0, threshold - current);
  const configuredOvershoot = Number(opts.overshootPct ?? DEFAULT_TRAILING_OVERSHOOT_PCT);
  const overshootThreshold = Number.isFinite(configuredOvershoot) && configuredOvershoot > 0
    ? configuredOvershoot
    : 0;
  const bypassConfirmation = overshootThreshold > 0 && overshoot >= overshootThreshold;
  const thresholdSource = hasFloor && floor > peakThreshold
    ? "profit-floor"
    : hasFloor && floor === peakThreshold
      ? "drop-from-peak+profit-floor"
      : "drop-from-peak";
  const floorText = hasFloor ? `; floor ${floor.toFixed(2)}%` : "";
  const overshootText = overshootThreshold > 0
    ? `; overshot ${overshoot.toFixed(2)}pp >= ${overshootThreshold.toFixed(2)}pp${bypassConfirmation ? " (immediate)" : ""}`
    : "";

  return {
    action: "TRAILING_TP",
    reason:
      `Trailing TP: peak ${peak.toFixed(2)}% → current ${current.toFixed(2)}% ` +
      `(threshold ${threshold.toFixed(2)}% = peak − ${dropPct.toFixed(2)}pp${floorText}; ` +
      `dropped ${dropFromPeak.toFixed(2)}pp >= ${dropPct.toFixed(2)}pp${overshootText})`,
    needs_confirmation: !bypassConfirmation,
    bypass_confirmation: bypassConfirmation,
    peak_pnl_pct: peak,
    current_pnl_pct: current,
    threshold_pnl_pct: threshold,
    threshold_source: thresholdSource,
    drop_from_peak_pct: dropFromPeak,
    overshoot_pct: overshoot,
    overshoot_threshold_pct: overshootThreshold,
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
  const effectivePnlPct = positionData.effective_pnl_pct != null ? Number(positionData.effective_pnl_pct) : currentPnlPct;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;
  if (pos.hold_mode === true) return null;
  if (positionData.pnl_management_ready === false) return null;

  let changed = false;
  const rangeHarvest = pos.management_profile === RANGE_HARVEST_PROFILE;
  const profitGraceMin = profitGraceRemainingMin(pos, mgmtConfig);
  const profitGrace = profitGraceMin > 0;
  if (profitGrace && !pos.adopt_grace_logged) {
    pos.adopt_grace_logged = true;
    changed = true;
    log("state", `[ADOPT_GRACE] ${pos.pool_name || position_address}: operator position — profit-taking rules (trailing TP, take-profit, harvest) suppressed for ${Math.ceil(profitGraceMin)}m after adoption; downside rules still active`);
  }
  if (profitGrace && !pos.profit_grace_active) {
    pos.profit_grace_active = true;
    changed = true;
  }
  // Grace just ended: a peak confirmed WHILE profit rules were suppressed is not a valid
  // trailing reference — the position may already sit far below peak − drop, and arming
  // against the stale peak fires "trailing TP" at whatever the loss is (SWARM-SOL
  // 2026-09-26: peak +2.63 % at 00:36Z inside the grace, −5.40 % at grace end 01:17Z,
  // closed at −5.02 %). Re-base the reference to the current valuation so trailing only
  // ever measures a drop from a peak it was allowed to act on.
  if (!profitGrace && pos.profit_grace_active) {
    pos.profit_grace_active = false;
    const before = pos.peak_pnl_pct;
    if (Number.isFinite(Number(currentPnlPct)) && !pnl_pct_suspicious) {
      pos.peak_pnl_pct = Number(currentPnlPct);
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      pos.trailing_active = false;
    }
    changed = true;
    log("state", `[GRACE_END] ${pos.pool_name || position_address}: profit rules live again — trailing reference re-based from ${before != null ? Number(before).toFixed(2) : "n/a"}% to the current ${Number(currentPnlPct).toFixed(2)}% (a peak seen during the grace is not actionable)`);
  }

  // Update bin range if changed on-chain (aligns with actual deployed positions)
  if (!pos.bin_range) {
    pos.bin_range = {};
  }
  const previousMin = pos.bin_range.min;
  const previousMax = pos.bin_range.max;
  const externalRangeChange = previousMin != null
    && previousMax != null
    && lower_bin != null
    && upper_bin != null
    && Number.isFinite(Number(previousMin))
    && Number.isFinite(Number(previousMax))
    && Number.isFinite(Number(lower_bin))
    && Number.isFinite(Number(upper_bin))
    && (Number(previousMin) !== Number(lower_bin) || Number(previousMax) !== Number(upper_bin));
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
  if (externalRangeChange) {
    pos.rebalance_count = (pos.rebalance_count || 0) + 1;
    pos.last_rebalanced_at = new Date().toISOString();
    pos.peak_pnl_pct = Number(currentPnlPct) || 0;
    if (pos.trailing_active && (pos.peak_pnl_pct ?? 0) < mgmtConfig.trailingTriggerPct) {
      pos.trailing_active = false;
    }
    pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
    pos.notes.push(`External rebalance detected: bins ${previousMin}..${previousMax} → ${lower_bin}..${upper_bin}`);
    pushEvent(state, {
      action: "rebalance_external",
      position: position_address,
      pool_name: pos.pool_name || pos.pool,
      previous_min_bin: previousMin,
      previous_max_bin: previousMax,
      min_bin: lower_bin,
      max_bin: upper_bin,
    });
    changed = true;
    log("state", `External rebalance detected for ${position_address}: ${previousMin}..${previousMax} → ${lower_bin}..${upper_bin} (peak PnL reset to ${pos.peak_pnl_pct}%)`);
  }

  // Synchronize external capital additions / withdrawals if deposit basis changed on-chain
  const onChainNetSol = positionData.net_deposit_sol;
  const onChainNetUsd = positionData.net_deposit_usd;
  if (
    !pnl_pct_suspicious &&
    positionData.pnl_quality === "valid" &&
    onChainNetSol != null &&
    Number.isFinite(onChainNetSol) &&
    onChainNetSol > 0
  ) {
    const currentAmountSol = Number(pos.amount_sol || 0);
    const deltaSol = onChainNetSol - currentAmountSol;
    // Trigger reconciliation if net deposits changed by >= 0.02 SOL and >= 5%
    const significantChange = Math.abs(deltaSol) >= 0.02 &&
      (currentAmountSol <= 0 || Math.abs(deltaSol) / currentAmountSol >= 0.05);

    if (significantChange) {
      const previousAmountSol = pos.amount_sol;
      const previousAmountUsd = pos.initial_value_usd;
      pos.amount_sol = Math.round(onChainNetSol * 1e4) / 1e4;
      if (onChainNetUsd != null && onChainNetUsd > 0) {
        pos.initial_value_usd = Math.round(onChainNetUsd * 100) / 100;
      }

      // Re-anchor or reset peak PnL upon external capital addition to prevent phantom trailing exits
      if (deltaSol > 0) {
        pos.peak_pnl_pct = Number(currentPnlPct) || 0;
        if (pos.mfe_pnl_pct != null) {
          pos.mfe_pnl_pct = Math.max(Number(currentPnlPct) || 0, Math.round((pos.mfe_pnl_pct * (currentAmountSol / onChainNetSol)) * 100) / 100);
        }
        if (pos.trailing_active && (pos.peak_pnl_pct ?? 0) < mgmtConfig.trailingTriggerPct) {
          pos.trailing_active = false;
        }
      }

      pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
      pos.notes.push(
        `External capital change reconciled: ◎${previousAmountSol ?? 0} ($${previousAmountUsd ?? 0}) → ◎${pos.amount_sol} ($${pos.initial_value_usd}) (delta ${deltaSol > 0 ? "+" : ""}◎${deltaSol.toFixed(4)})`
      );
      pushEvent(state, {
        action: "capital_change_external",
        position: position_address,
        pool_name: pos.pool_name || pos.pool,
        previous_amount_sol: previousAmountSol,
        new_amount_sol: pos.amount_sol,
        delta_sol: deltaSol,
      });
      changed = true;
      log("state", `External capital change reconciled for ${position_address}: ◎${previousAmountSol} → ◎${pos.amount_sol} (delta ${deltaSol > 0 ? "+" : ""}${deltaSol.toFixed(4)} SOL)`);
    }
  }

  // Activate trailing TP once the confirmed peak reaches the static trigger.
  const trailingParams = {
    triggerPct: Number(mgmtConfig.trailingTriggerPct ?? 3),
    dropPct: Number(mgmtConfig.trailingDropPct ?? 1.5),
  };
  if (!rangeHarvest && !profitGrace && mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= trailingParams.triggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%, trigger: ${trailingParams.triggerPct}%)`);
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

  const curDynFee = positionData.dynamic_fee_pct != null ? Number(positionData.dynamic_fee_pct) : null;
  const curFeeTvl = positionData.fee_per_tvl_24h != null ? Number(positionData.fee_per_tvl_24h) : null;
  if (curDynFee != null && Number.isFinite(curDynFee) && curDynFee > (pos.peak_dynamic_fee_pct ?? 0)) {
    pos.peak_dynamic_fee_pct = curDynFee;
    changed = true;
  }
  if (curFeeTvl != null && Number.isFinite(curFeeTvl) && curFeeTvl > (pos.peak_fee_per_tvl_24h ?? 0)) {
    pos.peak_fee_per_tvl_24h = curFeeTvl;
    changed = true;
  }

  // Record initial base inventory ratio on fresh deployment (age <= 1 min)
  const isFreshDeploy = pos.deployed_at
    ? (Date.now() - new Date(pos.deployed_at).getTime()) <= 60_000
    : Number(positionData?.age_minutes ?? 0) <= 1;
  if (pos.initial_base_ratio_pct == null && isFreshDeploy) {
    const lx = Number(positionData?.liq_x_usd || 0);
    const ly = Number(positionData?.liq_y_usd || 0);
    const tot = lx + ly;
    if (tot > 0) {
      const solMint = config.tokens?.SOL || "So11111111111111111111111111111111111111112";
      const isBaseY = (pos?.base_mint && positionData?.token_y_mint && pos.base_mint === positionData.token_y_mint) ||
        (positionData?.token_x_mint && positionData.token_x_mint === solMint && positionData?.token_y_mint !== solMint) ||
        (pos?.asset_profile?.token_x_mint === solMint && pos?.asset_profile?.token_y_mint !== solMint);
      const baseLiq = isBaseY ? ly : lx;
      pos.initial_base_ratio_pct = Math.round((baseLiq / tot) * 1000) / 10;
      changed = true;
    }
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
    // Lifetime counter — survives the streak resets above so the closed-position
    // record can show the guard actually intervened. Counts shadow would-defers too,
    // so it measures exposure to the rule in BOTH modes.
    pos.twap_guard_deferrals_total = (pos.twap_guard_deferrals_total ?? 0) + 1;
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

  // ── Toxic Inventory Conversion Guard ─────────────────────────
  // Emergency exit if position converts >=85% into Token X within <=20m with low fee yield (<1.5%)
  if (!pnl_pct_suspicious) {
    const toxicDecision = evaluateToxicConversion(pos, positionData, {
      thresholdPct: mgmtConfig.toxicConversionThresholdPct,
      maxAgeMinutes: mgmtConfig.toxicConversionMaxAgeMinutes,
      maxFeeYieldPct: mgmtConfig.toxicConversionMaxFeeYieldPct,
    });
    if (toxicDecision.wouldFire) {
      if (mgmtConfig.toxicConversionEnabled !== false) {
        const exit = gateExit({ action: "TOXIC_CONVERSION", reason: toxicDecision.reason, rule: "toxic_conversion" });
        if (exit) return exit;
      }
    }
  }

  // ── Young-token stop (age-conditional, fires BEFORE plain stop-loss) ──────
  // Tighter stop for positions whose base token was young at deploy. Uses the SAME
  // confirm-tick timer + gateExit TWAP wrapper as the plain stop, its own
  // young_stop_violated_since field so it can't collide with the −50 stop.
  // Unknown age → not young → never fires.
  // NEVER touches the crash fast-path (separate code path in index.js).
  if (!pnl_pct_suspicious && currentPnlPct != null && Number.isFinite(currentPnlPct)) {
    const youngStopPct = mgmtConfig.youngStopPct ?? DEFAULT_YOUNG_STOP_PCT;
    const youngStopMaxAgeHours = mgmtConfig.youngStopMaxAgeHours ?? DEFAULT_YOUNG_STOP_MAX_AGE_HOURS;
    const youngStopEnabled = !!mgmtConfig.youngStopEnabled;
    const ageAtDeploy = pos.token_age_hours_at_deploy;
    const decision = evaluateYoungStop(ageAtDeploy, currentPnlPct, {
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
  if (!pnl_pct_suspicious && effectivePnlPct != null && mgmtConfig.stopLossPct != null && Number.isFinite(Number(mgmtConfig.stopLossPct)) && effectivePnlPct <= Number(mgmtConfig.stopLossPct)) {
    if (!pos.stop_loss_violated_since) {
      pos.stop_loss_violated_since = new Date().toISOString();
      save(state);
      log("state", `Position ${position_address} stop-loss threshold violated (effective PnL ${effectivePnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%). Waiting for confirmation.`);
    } else {
      const violatedDurationMs = Date.now() - new Date(pos.stop_loss_violated_since).getTime();
      const minConfirmationMs = 15000; // 15 seconds
      if (violatedDurationMs >= minConfirmationMs) {
        const exit = gateExit({
          action: "STOP_LOSS",
          reason: `Stop loss: Effective PnL ${effectivePnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}% (confirmed over ${Math.round(violatedDurationMs / 1000)}s)`,
        });
        if (exit) return exit;
      }
    }
  } else if (pos.stop_loss_violated_since) {
    pos.stop_loss_violated_since = null;
    save(state);
    log("state", `Position ${position_address} stop-loss violation cleared (recovered to effective PnL ${effectivePnlPct.toFixed(2)}%)`);
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!rangeHarvest && !profitGrace && !pnl_pct_suspicious && pos.trailing_active) {
    const trailing = evaluateTrailingTakeProfit(pos.peak_pnl_pct, currentPnlPct, {
      dropPct: trailingParams.dropPct,
      minPnlPct: mgmtConfig.trailingMinPnlPct,
      overshootPct: mgmtConfig.trailingOvershootPct,
    });
    if (trailing) {
      const exit = gateExit(trailing);
      if (exit) return exit;
    }
  }

  // ── Round-trip harvest (above-range, all-SOL, frozen pnl) ──────
  // Shadow-first: default OFF logs a would-harvest line and changes nothing. Placed
  // AFTER stop-loss/trailing (downside protection always wins) and BEFORE the
  // OOR block, whose above-range half deliberately does not run here.
  if (!pnl_pct_suspicious) {
    const rt = evaluateRoundTripHarvest(pos, currentPnlPct, mgmtConfig, active_bin, upper_bin);
    if (rt.harvest && profitGrace) {
      // Operator grace: the harvest is provably free, but the operator asked for no
      // profit-taking in the first minutes; it re-evaluates every tick after the grace.
    } else if (rt.harvest) {
      if (mgmtConfig.roundTripHarvestEnabled) {
        const exit = gateExit({
          action: "ROUND_TRIP_HARVEST",
          rule: "round_trip",
          reason: rt.reason,
          needs_confirmation: true,
        });
        if (exit) return exit;
      } else {
        const lastLog = pos.roundtrip_shadow_last_log_at
          ? new Date(pos.roundtrip_shadow_last_log_at).getTime()
          : 0;
        if (Date.now() - lastLog >= ROUNDTRIP_SHADOW_LOG_INTERVAL_MS) {
          pos.roundtrip_shadow_last_log_at = new Date().toISOString();
          save(state);
          log(
            "roundtrip_shadow",
            `[ROUNDTRIP_SHADOW] would-harvest ${pos.pool_name || position_address}: ${rt.reason} (live rules: holding)`
          );
        }
      }
    }
  }

  // ── Dynamic Fee Surge Decay & Rotation Engine ─────────────────
  // Rotates capital if dynamic fee or fee/TVL collapses >=50% from peak after >=15m with pnl >= 0
  if (!pnl_pct_suspicious) {
    const surgeDecision = evaluateSurgeDecay(pos, positionData, {
      thresholdPct: mgmtConfig.surgeDecayThresholdPct,
      minAgeMinutes: mgmtConfig.surgeDecayMinAgeMinutes,
    });
    if (surgeDecision.wouldFire) {
      if (mgmtConfig.surgeDecayExitEnabled) {
        const exit = gateExit({ action: "SURGE_DECAY", reason: surgeDecision.reason, rule: "surge_decay" });
        if (exit) return exit;
      } else {
        const lastLog = pos.surge_shadow_last_log_at ? new Date(pos.surge_shadow_last_log_at).getTime() : 0;
        if (Date.now() - lastLog >= SURGE_SHADOW_LOG_INTERVAL_MS) {
          pos.surge_shadow_last_log_at = new Date().toISOString();
          save(state);
          log(
            "surge_shadow",
            `[SURGE_SHADOW] would-rotate ${pos.pool_name || position_address}: ${surgeDecision.reason} (surgeDecayExitEnabled=false — holding)`
          );
        }
      }
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
      // null = OOR-below auto-close explicitly disabled (resolved by config.js).
      const limitBelow = mgmtConfig.outOfRangeWaitMinutesBelow;
      if (limitBelow != null && limitBelow > 0 && minutesOOR >= limitBelow) {
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

export function syncOpenPositions(active_addresses, { authoritative = false } = {}) {
  // Fast PnL reads are address-scoped and can be partial during RPC failover,
  // indexing lag, or a provider 429. Treating that partial list as authoritative
  // auto-closed real positions and fed them into orphan adoption, which is how
  // valid bot deployments became MANUAL. The owner-wide reconciliation path is
  // the authoritative closer; callers must opt in explicitly.
  if (!authoritative) return 0;
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
    pos.external_close_pending = true;
    pos.external_close_source = "onchain_reconciliation";
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
  return changed;
}

/**
 * Close one state row after an owner-discovery omission has been confirmed by
 * a direct position-account liveness check. Discovery can be partial, so the
 * caller must perform that direct check before invoking this helper.
 */
/**
 * A rebalance/straddle closed the on-chain account (step 1) but the re-deploy did not
 * happen. Mark the row closed and leave it to the external-close reconciliation to
 * fetch the realized figures from Meteora's closed-position endpoint (that path also
 * writes the performance record).
 */
export function markPositionClosedAfterFailedRebalance(position_address, reason = "rebalance aborted after close") {
  if (!position_address) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.close_reason = reason;
  pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
  pos.notes.push(reason);
  pos.external_close_pending = true;
  pos.external_close_source = "rebalance_aborted";
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
  return true;
}

export function markPositionClosedByReconciliation(position_address, {
  minAgeMinutes = 5,
  note = "Auto-closed during state reconciliation (not found on-chain)",
} = {}) {
  if (!position_address) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;
  const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
  if (Number.isFinite(deployedAt) && Date.now() - deployedAt < Math.max(0, Number(minAgeMinutes)) * 60_000) {
    return false;
  }
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.close_reason = note;
  pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
  pos.notes.push(note);
  pos.external_close_pending = true;
  pos.external_close_source = "onchain_reconciliation";
  save(state);
  log("state", `Position ${position_address} auto-closed by confirmed reconciliation`);
  return true;
}

/**
 * Finalize a reconciliation close with realized values fetched from Meteora's
 * closed-position endpoint. This also handles rows that were already marked
 * closed by an earlier reconciliation pass but had no performance record.
 */
export function recordReconciledClose(position_address, {
  closedAt = null,
  exitPnlPct = null,
  exitPnlValue = null,
  feesValue = null,
  feesTrueUsd = null,
  feesSol = null,
  source = "closed_api_reconciliation",
  note = "Realized close PnL recovered from Meteora closed-position data",
} = {}) {
  if (!position_address) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;

  const closedAtMs = closedAt ? new Date(closedAt).getTime() : NaN;
  pos.closed = true;
  if (!pos.close_reason && note) pos.close_reason = note;
  if (Number.isFinite(closedAtMs)) pos.closed_at = new Date(closedAtMs).toISOString();
  else if (!pos.closed_at) pos.closed_at = new Date().toISOString();
  if (Number.isFinite(Number(exitPnlPct))) pos.exit_pnl_pct = Number(exitPnlPct);
  if (Number.isFinite(Number(exitPnlValue))) pos.exit_pnl_usd = Number(exitPnlValue);
  if (Number.isFinite(Number(feesValue))) pos.total_fees_claimed_usd = Number(feesValue);
  if (Number.isFinite(Number(feesTrueUsd))) pos.total_fees_claimed_true_usd = Number(feesTrueUsd);
  if (Number.isFinite(Number(feesSol))) pos.total_fees_claimed_sol = Number(feesSol);
  pos.external_close_pending = false;
  pos.external_close_source = source;
  pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
  if (note && !pos.notes.includes(note)) pos.notes.push(note);
  save(state);
  log("state", `Position ${position_address} reconciliation close finalized from Meteora closed PnL`);
  return true;
}

export function updateClosedPositionPnL(position_address, exit_pnl_pct, exit_pnl_usd, fees_earned_usd, exit_pnl_sol = null, exit_pnl_true_usd = null) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.exit_pnl_pct = Number(exit_pnl_pct);
  pos.exit_pnl_usd = Number(exit_pnl_true_usd ?? exit_pnl_usd);
  if (exit_pnl_sol != null && Number.isFinite(Number(exit_pnl_sol))) {
    pos.exit_pnl_sol = Number(exit_pnl_sol);
  }
  if (exit_pnl_true_usd != null && Number.isFinite(Number(exit_pnl_true_usd))) {
    pos.exit_pnl_true_usd = Number(exit_pnl_true_usd);
  }
  if (fees_earned_usd !== undefined && fees_earned_usd !== null && !isNaN(fees_earned_usd)) {
    pos.total_fees_claimed_usd = Number(fees_earned_usd);
  }
  save(state);
  log("state", `Position ${position_address} updated PnL: pct=${exit_pnl_pct}%, usd=$${pos.exit_pnl_usd}, fees=$${fees_earned_usd}`);
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

// ── Deferred exit swaps ───────────────────────────────────────────────────────
// When the exit-swap price-impact guard refuses a post-close sale it hands the
// balance to the dust sweeper ("re-quotes on later passes"). But the sweeper skips
// any mint belonging to an OPEN position, so if the agent re-enters that pool
// before the sweeper gets there, the remainder is stranded until the new position
// closes — observed 2026-07-27: CATE closed 19:14 leaving $11.50 guarded at 6.6%
// impact, re-deployed 19:21, remainder unsellable.
//
// This records exactly which mints the GUARD deferred, so the sweeper can make a
// narrow exception for those without broadening its skip in general. That matters:
// a wallet balance for an open-position mint is normally claimed-fee residue.
// Only guard-deferred balances get the exception.
export function getDeferredExitSwaps() {
  const state = load();
  const v = state._deferredExitSwaps;
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export function recordDeferredExitSwap(mint, info = {}) {
  if (!mint) return false;
  const state = load();
  if (!state._deferredExitSwaps || typeof state._deferredExitSwaps !== "object" || Array.isArray(state._deferredExitSwaps)) {
    state._deferredExitSwaps = {};
  }
  state._deferredExitSwaps[mint] = {
    at: new Date().toISOString(),
    usd: Number.isFinite(info.usd) ? Number(info.usd) : null,
    impact_pct: Number.isFinite(info.impact_pct) ? Number(info.impact_pct) : null,
    label: typeof info.label === "string" ? info.label.slice(0, 40) : null,
  };
  save(state);
  return true;
}

export function clearDeferredExitSwap(mint) {
  if (!mint) return false;
  const state = load();
  const map = state._deferredExitSwaps;
  if (!map || typeof map !== "object" || !(mint in map)) return false;
  delete map[mint];
  save(state);
  return true;
}

/**
 * Run on-chain state reconciliation.
 * - Auto-closes phantom positions (open in state, missing on-chain)
 * - Alerts on orphaned positions (active on-chain, untracked/closed in state)
 * - Alerts on PnL discrepancies > 5.0%
 */
export async function reconcileStateWithChain({ minAgeMinutes = 5 } = {}) {
  await ensureStateInitialized();
  log("state", "Starting on-chain state reconciliation check");
  const { getMyPositions } = await import("./tools/dlmm.js");
  const { isPositionAccountLive } = await import("./tools/pnl.js");
  const { sendMessage: sendTelegramMessage } = await import("./telegram.js");

  // Reconciliation must use the owner-wide discovery path. The default fast
  // PnL path intentionally reads only addresses already tracked in state to
  // control RPC usage; using it here would make this orphan-healing backstop
  // blind to exactly the untracked positions it is meant to adopt.
  const liveResult = await getMyPositions({
    force: true,
    silent: true,
    discovery: true,
    persist: false,
  }).catch(() => null);
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

    // The discovery result may be a cached/partial owner snapshot. Confirm the
    // account directly before changing a tracked row; a live account means the
    // snapshot was incomplete, while an unavailable check is not evidence of a
    // close. Both cases leave the row open for the next reconciliation.
    const stillLive = await isPositionAccountLive(posId);
    if (stillLive !== false) {
      log("state", `[RECONCILIATION] leaving ${posId} open: discovery omitted it but direct account check is ${stillLive === true ? "live" : "unavailable"}`);
      continue;
    }

    // Grace period check (5 minutes) to avoid race conditions during deploy
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (now - deployedAt < 5 * 60 * 1000) {
      continue;
    }

    // Auto-heal local state
    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push("Auto-closed during state reconciliation (not found on-chain)");
    pos.external_close_pending = true;
    pos.external_close_source = "onchain_reconciliation";
    changed = true;
    log("state", `Reconciliation: Auto-closed phantom position ${posId}`);

    await sendTelegramMessage(
      `⚠️ <b>Drift Warning: Phantom Position</b>\nPosition <code>${posId}</code> (${pos.pool_name || pos.pool}) was tracked as open in local state, but not found on-chain. Local state has been auto-healed and marked as closed.`
    , "HTML").catch(e => log("telegram_error", `Failed to send phantom alert: ${e.message}`));
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
    // Callers that KNOW the position is operator-made (/adopt) pass minAgeMinutes=0
    // — they carry their own busy-guard against a bot deploy in flight.
    if (Number.isFinite(p.age_minutes) && p.age_minutes < minAgeMinutes) {
      log("state", `Reconciliation: skipping fresh untracked position ${posId} (${p.pair}, age ${p.age_minutes}m) — within deploy grace window`);
      continue;
    }

    // Owner discovery can reuse a stale result after a close. Never reopen a
    // closed row or adopt an already-closed account without a direct liveness
    // confirmation. null means the provider failed, so retry later.
    const stillLive = await isPositionAccountLive(posId);
    if (stillLive !== true) {
      log("state", `[RECONCILIATION] ignoring stale orphan ${posId}: direct account is ${stillLive === false ? "closed" : "unavailable"}`);
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
    , "HTML").catch(e => log("telegram_error", `Failed to send orphaned alert: ${e.message}`));
  }

  // 3. Detect PnL Discrepancy > 5.0%
  for (const p of onChainPositions) {
    if (p.pnl_pct_diff != null && p.pnl_pct_diff > 5.0) {
      log("state_error", `Reconciliation: PnL discrepancy for ${p.position} (${p.pair}): diff=${p.pnl_pct_diff}% (ourPct=${p.pnl_pct}%, reported=${p.pnl_pct_reported ?? "n/a"}%)`);

      const posState = state.positions[p.position];
      const lastAlertAt = posState?.last_pnl_drift_alert_at ? new Date(posState.last_pnl_drift_alert_at).getTime() : 0;
      if (now - lastAlertAt >= 6 * 60 * 60 * 1000) {
        if (posState) {
          posState.last_pnl_drift_alert_at = new Date().toISOString();
          changed = true;
        }
        const reportedStr = p.pnl_pct_reported != null ? `${p.pnl_pct_reported}%` : `${(p.pnl_pct - p.pnl_pct_diff).toFixed(2)}%`;
        await sendTelegramMessage(
          `⚠️ <b>Drift Warning: PnL Discrepancy</b>\nPosition <code>${p.position.slice(0, 8)}...</code> (${p.pair}) has a PnL discrepancy.\nOn-chain derived: ${p.pnl_pct}%\nMeteora reported: ${reportedStr}\nDifference: ${p.pnl_pct_diff}%.`
        , "HTML").catch(e => log("telegram_error", `Failed to send PnL discrepancy alert: ${e.message}`));
      }
    }
  }

  if (changed) {
    save(state);
  }
  log("state", "State reconciliation check complete");
}
