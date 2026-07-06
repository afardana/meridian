/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import { log } from "./logger.js";
import { config } from "./config.js";

import { repoPath } from "./repo-root.js";
import { makeDocStore } from "./db/doc-store.js";

const POOL_MEMORY_FILE = repoPath("pool-memory.json");
const MAX_NOTE_LENGTH = 280;
const _store = makeDocStore("pool-memory", POOL_MEMORY_FILE, () => ({}));

// ─── Rejected-candidate snapshots (offline replay/backtest data) ───────────
// Dedicated doc store — kept OUT of the main pool-memory doc so screening's
// per-cycle writes don't bloat the (already-hot) deploy-history document.
const REJECTED_CANDIDATES_FILE = repoPath("rejected-candidates.json");
const REJECTED_MAX_SNAPS_PER_POOL = 12; // ring buffer per pool
const REJECTED_MAX_REASONS = 5; // last few rejection reasons kept
const REJECTED_MAX_POOLS = 400; // evict oldest last_seen beyond this
const _rejectedStore = makeDocStore("rejected-candidates", REJECTED_CANDIDATES_FILE, () => ({}));

function sanitizeStoredNote(text, maxLen = MAX_NOTE_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() { return _store.get(); }
function save(data) { _store.set(data); }

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" ||
    text.includes("out of range") ||
    text.includes("oor") ||
    text.includes("above range") ||
    text.includes("below range");
}

function isOorBelowCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("below") || text === "oor" || (text.includes("oor") && !text.includes("above"));
}

function isOorAboveCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("above") || text.includes("pumped far above");
}

function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor");
}

function isFeeGeneratingDeploy(deploy) {
  const minFeeEarnedPct = Number(config.management.repeatDeployCooldownMinFeeEarnedPct ?? 0);
  const feeEarnedPct = Number(deploy.fee_earned_pct ?? 0);
  const feesUsd = Number(deploy.fees_earned_usd ?? 0);
  const feesSol = Number(deploy.fees_earned_sol ?? 0);
  const hasFees = (Number.isFinite(feesUsd) && feesUsd > 0) || (Number.isFinite(feesSol) && feesSol > 0);
  if (!hasFees) return false;
  return Number.isFinite(feeEarnedPct) && feeEarnedPct >= minFeeEarnedPct;
}

function setPoolCooldown(entry, hours, reason) {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_until = cooldownUntil;
  entry.cooldown_reason = reason;
  return cooldownUntil;
}

function setBaseMintCooldown(db, baseMint, hours, reason) {
  if (!baseMint) return null;
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      entry.base_mint_cooldown_until = cooldownUntil;
      entry.base_mint_cooldown_reason = reason;
    }
  }
  return cooldownUntil;
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    fees_earned_usd: deployData.fees_earned_usd ?? null,
    fees_earned_sol: deployData.fees_earned_sol ?? null,
    fee_earned_pct: deployData.fee_earned_pct ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
    fee_efficiency_at_deploy: deployData.fee_efficiency ?? null,
    organic_momentum_at_deploy: deployData.organic_momentum ?? null,
    entry_mcap: deployData.entry_mcap ?? null,
    entry_tvl: deployData.entry_tvl ?? null,
    entry_volume: deployData.entry_volume ?? null,
    exit_mcap: deployData.exit_mcap ?? null,
    exit_tvl: deployData.exit_tvl ?? null,
    exit_volume: deployData.exit_volume ?? null,
    gas_cost_sol: deployData.gas_cost_sol ?? null,
    total_gas_sol: deployData.total_gas_sol ?? null,
    gas_adjusted_pnl_sol: deployData.gas_adjusted_pnl_sol ?? null,
  };

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100
    ) / 100;
  }
  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
  entry.adjusted_win_rate_sample_count = adjusted.length;
  entry.adjusted_win_rate = adjusted.length > 0
    ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
    : 0;

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  // Set cooldown for low yield closes — pool wasn't profitable enough, don't redeploy soon
  if (deploy.close_reason === "low yield") {
    const cooldownHours = 4;
    const cooldownUntil = setPoolCooldown(entry, cooldownHours, "low yield");
    log("pool-memory", `Cooldown set for ${entry.name} until ${cooldownUntil} (low yield close)`);
  }

  // Anti-LVR cooldown for OOR-above closes — price pumped out of range, don't chase higher
  if (deploy.close_reason && isOorAboveCloseReason(deploy.close_reason)) {
    const oorAboveCooldownMin = config.management.oorAboveCooldownMinutes ?? 30;
    if (oorAboveCooldownMin > 0) {
      const cooldownHours = oorAboveCooldownMin / 60;
      const cooldownUntil = setPoolCooldown(entry, cooldownHours, "OOR above — anti-LVR cooldown");
      log("pool-memory", `Anti-LVR cooldown for ${entry.name} until ${cooldownUntil} (OOR above close)`);
      if (entry.base_mint) {
        const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, "OOR above — anti-LVR cooldown");
        if (mintCooldownUntil) {
          log("pool-memory", `Anti-LVR mint cooldown for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil}`);
        }
      }
    }
  }

  const oorTriggerCount = config.management.oorCooldownTriggerCount ?? 3;
  const oorCooldownHours = config.management.oorCooldownHours ?? 12;
  const recentDeploys = entry.deploys.slice(-oorTriggerCount);
  const repeatedOorCloses =
    recentDeploys.length >= oorTriggerCount &&
    recentDeploys.every((d) => isOorBelowCloseReason(d.close_reason));

  if (repeatedOorCloses) {
    const reason = `repeated OOR closes (${oorTriggerCount}x)`;
    const poolCooldownUntil = setPoolCooldown(entry, oorCooldownHours, reason);
    const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, oorCooldownHours, reason);
    log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
    if (entry.base_mint && mintCooldownUntil) {
      log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
    }
  }

  if (config.management.repeatDeployCooldownEnabled) {
    const triggerCount = Math.max(1, Number(config.management.repeatDeployCooldownTriggerCount ?? 3));
    const cooldownHours = Math.max(0, Number(config.management.repeatDeployCooldownHours ?? 12));
    const rawScope = String(config.management.repeatDeployCooldownScope || "token").toLowerCase();
    const scope = ["pool", "token", "both"].includes(rawScope) ? rawScope : "token";
    const recentRepeatDeploys = entry.deploys.slice(-triggerCount);
    const repeatedFeeGeneratingDeploys =
      cooldownHours > 0 &&
      recentRepeatDeploys.length >= triggerCount &&
      recentRepeatDeploys.every((d) => d.pnl_pct != null && isFeeGeneratingDeploy(d));

    if (repeatedFeeGeneratingDeploys) {
      const reason = `repeat fee-generating deploys (${triggerCount}x)`;
      if (scope === "pool" || scope === "both" || !entry.base_mint) {
        const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason);
        log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
      }
      if ((scope === "token" || scope === "both") && entry.base_mint) {
        const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason);
        if (mintCooldownUntil) {
          log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
        }
      }
    }
  }

  // Gas-adjusted PnL feedback — extend cooldown for gas-negative pools
  const recentWithGas = entry.deploys.slice(-3).filter(d => d.gas_adjusted_pnl_sol != null);
  if (recentWithGas.length >= 2) {
    const avgGasAdjPnl = recentWithGas.reduce((s, d) => s + d.gas_adjusted_pnl_sol, 0) / recentWithGas.length;
    if (avgGasAdjPnl < 0) {
      const gasNegCooldownHours = 6;
      const cooldownUntil = setPoolCooldown(entry, gasNegCooldownHours, `gas-negative avg PnL (${avgGasAdjPnl.toFixed(6)} SOL)`);
      log("pool-memory", `Extended cooldown for ${entry.name} until ${cooldownUntil} — gas-adjusted PnL avg: ${avgGasAdjPnl.toFixed(6)} SOL`);
    }
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.cooldown_until) return false;
  return new Date(entry.cooldown_until) > new Date();
}

export function isBaseMintOnCooldown(baseMint) {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  return Object.values(db).some((entry) =>
    entry?.base_mint === baseMint &&
    entry?.base_mint_cooldown_until &&
    new Date(entry.base_mint_cooldown_until) > now
  );
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    adjusted_win_rate: entry.adjusted_win_rate ?? 0,
    adjusted_win_rate_sample_count: entry.adjusted_win_rate_sample_count ?? 0,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    cooldown_until: entry.cooldown_until || null,
    cooldown_reason: entry.cooldown_reason || null,
    base_mint_cooldown_until: entry.base_mint_cooldown_until || null,
    base_mint_cooldown_reason: entry.base_mint_cooldown_reason || null,
    notes: entry.notes,
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    // Always-USD PnL (for the dashboard's USD-denominated display, matching Fabriq).
    pnl_true_usd: snapshot.pnl_true_usd ?? null,
    pnl_pct_usd: snapshot.pnl_pct_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    fee_per_tvl_24h: snapshot.fee_per_tvl_24h ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
    lower_bin: snapshot.lower_bin ?? null,
    upper_bin: snapshot.upper_bin ?? null,
    active_bin: snapshot.active_bin ?? null,
    // Current position liquidity value (USD, excl. unclaimed fees) — lets the
    // dashboard compute deployed AUM the same way as getWalletBalances().aum
    // instead of approximating with amount_sol + pnl (which double-counts fees).
    total_value_usd: snapshot.total_value_true_usd ?? snapshot.total_value_usd ?? null,
    // Per-token breakdown + prices for the dashboard position card.
    token_x_symbol: snapshot.token_x_symbol ?? null,
    token_y_symbol: snapshot.token_y_symbol ?? null,
    bin_step: snapshot.bin_step ?? null,
    liq_x_amount: snapshot.liq_x_amount ?? null,
    liq_x_usd: snapshot.liq_x_usd ?? null,
    liq_y_amount: snapshot.liq_y_amount ?? null,
    liq_y_usd: snapshot.liq_y_usd ?? null,
    fee_x_amount: snapshot.fee_x_amount ?? null,
    fee_x_usd: snapshot.fee_x_usd ?? null,
    fee_y_amount: snapshot.fee_y_amount ?? null,
    fee_y_usd: snapshot.fee_y_usd ?? null,
    price_lower: snapshot.price_lower ?? null,
    price_upper: snapshot.price_upper ?? null,
    price_active: snapshot.price_active ?? null,
    // Pool-level metrics (for concentration/leave-pool trend detection).
    pool_tvl: snapshot.pool_tvl ?? null,
    pool_volume: snapshot.pool_volume ?? null,
    pool_fee_active_tvl_ratio: snapshot.pool_fee_active_tvl_ratio ?? null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Get the recorded live-position snapshots for a pool (oldest→newest).
 * Used by position-health analysis to build a trend dataset.
 * @param {string} poolAddress
 * @returns {object[]}
 */
export function getPoolSnapshots(poolAddress) {
  if (!poolAddress) return [];
  const db = load();
  return db[poolAddress]?.snapshots ?? [];
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary
  if (entry.total_deploys > 0) {
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}`);
  }

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
    lines.push(`POOL COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`);
  }

  if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
    lines.push(`TOKEN COOLDOWN: active until ${entry.base_mint_cooldown_until}${entry.base_mint_cooldown_reason ? ` (${entry.base_mint_cooldown_reason})` : ""}`);
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === false).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  if (entry.notes?.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    const safeNote = sanitizeStoredNote(lastNote.note);
    if (safeNote) lines.push(`NOTE: ${safeNote}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note: safeNote,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}

/**
 * Get all active pool and base mint/token cooldowns.
 * @returns {Array<object>} list of active cooldown objects
 */
export function getActiveCooldowns() {
  const db = load();
  const list = [];
  const now = new Date();
  const seenMints = new Set();
  
  for (const [pool, entry] of Object.entries(db)) {
    if (entry.cooldown_until && new Date(entry.cooldown_until) > now) {
      list.push({
        type: "pool",
        address: pool,
        name: entry.name || "Unknown Pool",
        until: entry.cooldown_until,
        reason: entry.cooldown_reason
      });
    }
    if (entry.base_mint && entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > now) {
      if (!seenMints.has(entry.base_mint)) {
        seenMints.add(entry.base_mint);
        list.push({
          type: "token",
          address: entry.base_mint,
          name: entry.name ? entry.name.split("-")[0] : "Unknown Token",
          until: entry.base_mint_cooldown_until,
          reason: entry.base_mint_cooldown_reason
        });
      }
    }
  }
  return list;
}

/**
 * Manually release an active cooldown by type and address.
 * @param {object} param
 * @param {"pool"|"token"} param.type
 * @param {string} param.address
 * @returns {boolean} true if a cooldown was released, false otherwise
 */
export function releaseCooldown({ type, address }) {
  const db = load();
  let released = false;
  
  if (type === "pool") {
    if (db[address]) {
      db[address].cooldown_until = null;
      db[address].cooldown_reason = null;
      released = true;
    }
  } else if (type === "token") {
    for (const entry of Object.values(db)) {
      if (entry.base_mint === address) {
        entry.base_mint_cooldown_until = null;
        entry.base_mint_cooldown_reason = null;
        released = true;
      }
    }
  }
  
  if (released) {
    save(db);
    log("pool-memory", `Manually released ${type} cooldown for ${address.slice(0, 8)}...`);
  }
  return released;
}

// ─── Rejected-candidate capture (offline replay/backtest data) ────────────

const REJECTED_SNAPSHOT_FIELDS = [
  "tvl",
  "volume",
  "fee_active_tvl_ratio",
  "volatility",
  "mcap",
  "organic_score",
  "unique_traders",
  "unique_traders_change_pct",
  "volume_change_pct",
  "holders",
  "intel_total",
];

/**
 * Build a compact snapshot object from a screening candidate, pulling
 * whatever of REJECTED_SNAPSHOT_FIELDS exists on it (condensed pool shape
 * from tools/screening.js) and omitting anything missing/undefined.
 * @param {object} candidate
 * @returns {object} { ts, ...present fields }
 */
function buildRejectedSnapshot(candidate) {
  const snap = { ts: new Date().toISOString() };
  const src = candidate || {};
  const values = {
    tvl: src.tvl,
    volume: src.volume_window ?? src.volume,
    fee_active_tvl_ratio: src.fee_active_tvl_ratio,
    volatility: src.volatility,
    mcap: src.mcap,
    organic_score: src.organic_score,
    unique_traders: src.unique_traders,
    unique_traders_change_pct: src.unique_traders_change_pct,
    volume_change_pct: src.volume_change_pct,
    holders: src.holders,
    intel_total: src._intelScore?.total ?? src.intel_total,
  };
  for (const field of REJECTED_SNAPSHOT_FIELDS) {
    const v = values[field];
    if (v !== undefined && v !== null) snap[field] = v;
  }
  return snap;
}

/**
 * Record a rejected (or accepted-but-not-deployed) screening candidate.
 * Stored in a dedicated "rejected-candidates" doc store — kept separate
 * from pool-memory.json to avoid bloating that hot document.
 *
 * @param {string} poolAddress
 * @param {object} snapshot - candidate-shaped object (condensed pool from
 *   tools/screening.js) plus optional { reason, accepted, name }.
 */
export function recordRejectedCandidate(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = _rejectedStore.get();
  const nowIso = new Date().toISOString();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot?.name || poolAddress.slice(0, 8),
      first_seen: nowIso,
      last_seen: nowIso,
      times_rejected: 0,
      accepted: false,
      reasons: [],
      snaps: [],
    };
  }

  const entry = db[poolAddress];
  entry.name = snapshot?.name || entry.name;
  entry.last_seen = nowIso;
  if (snapshot?.accepted) {
    entry.accepted = true;
  } else {
    entry.times_rejected = (entry.times_rejected || 0) + 1;
  }

  if (snapshot?.reason) {
    entry.reasons.push({ ts: nowIso, reason: String(snapshot.reason).slice(0, 200) });
    if (entry.reasons.length > REJECTED_MAX_REASONS) {
      entry.reasons = entry.reasons.slice(-REJECTED_MAX_REASONS);
    }
  }

  entry.snaps.push(buildRejectedSnapshot(snapshot));
  if (entry.snaps.length > REJECTED_MAX_SNAPS_PER_POOL) {
    entry.snaps = entry.snaps.slice(-REJECTED_MAX_SNAPS_PER_POOL);
  }

  // Evict oldest (by last_seen) once the store exceeds the pool cap.
  const keys = Object.keys(db);
  if (keys.length > REJECTED_MAX_POOLS) {
    const sorted = keys
      .map((k) => ({ k, last_seen: db[k]?.last_seen || "" }))
      .sort((a, b) => (a.last_seen < b.last_seen ? -1 : a.last_seen > b.last_seen ? 1 : 0));
    const toEvict = sorted.slice(0, keys.length - REJECTED_MAX_POOLS);
    for (const { k } of toEvict) delete db[k];
  }

  _rejectedStore.set(db);
}

/**
 * Read-only accessor for the rejected-candidates store.
 * @returns {object} keyed by pool address
 */
export function getRejectedCandidates() {
  return _rejectedStore.get();
}
