/**
 * TVL-floor exit (2026-10-11, operator): when a pool's TVL is confirmed below the floor
 * ($10,000) the bot closes its position there and sells the remainder — even on HOLD.
 * It is the one exit that overrides HOLD, so a wrong reading must never fire it.
 *
 * Leaf module (no imports): the pure decision pieces, shared by state.js (streak on the
 * position), index.js (management cycle), tools/dlmm.js (on-chain figure) and the hold
 * guards in tools/executor.js / tools/dlmm.js.
 *
 * Confirmation, in order:
 *   1. a reading counts only when the Meteora pool-discovery fetch succeeded, returned
 *      THIS pool, and its `tvl` field is a finite number >= 0 (`readPoolTvlUsd`);
 *   2. N readings below the floor in a row, spanning >= M minutes (`advanceTvlFloorStreak`);
 *      a reading at/above the floor resets, a failed/missing one neither counts nor resets;
 *   3. the pool's on-chain reserves (RPC), valued at the active-bin price, must also be
 *      below the floor (`crossCheckTvlFloor`). Unavailable → no exit this cycle.
 */

/** The TVL rug floor in USD. tools/screening.js builds RANK_ENVELOPE.minTvl (RUG_FLOOR_TVL) from it. */
export const RUG_FLOOR_TVL_USD = 10_000;

export const TVL_FLOOR_EXIT_MODES = ["off", "shadow", "enforce"];
export const TVL_FLOOR_DEFAULT_MIN_READINGS = 3;
export const TVL_FLOOR_DEFAULT_MIN_MINUTES = 5;
/** Two readings closer than this are one reading (a cycle triggered twice in a row). */
export const TVL_FLOOR_MIN_SPACING_MS = 60_000;
/** A gap longer than this between two below-floor readings starts the streak over (restart, feed outage). */
export const TVL_FLOOR_MAX_GAP_MS = 30 * 60_000;
/** How long a confirmation lets a close through the HOLD guards. */
export const TVL_FLOOR_CONFIRM_TTL_MS = 10 * 60_000;
export const TVL_FLOOR_HOLD_OVERRIDE = "tvl_floor";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function tvlFloorExitConfig(mgmt = {}) {
  // Absent = enforce (the operator asked for it live); a present but unknown value is a typo
  // and must not enforce by accident.
  const raw = mgmt?.tvlFloorExitMode;
  const mode = TVL_FLOOR_EXIT_MODES.includes(raw) ? raw : (raw == null ? "enforce" : "shadow");
  const floor = Number(mgmt?.tvlFloorExitUsd);
  const n = Math.floor(Number(mgmt?.tvlFloorExitMinReadings));
  const m = Number(mgmt?.tvlFloorExitMinMinutes);
  return {
    mode,
    floorUsd: Number.isFinite(floor) && floor > 0 ? floor : RUG_FLOOR_TVL_USD,
    // Never below 2 readings: one reading is exactly the single bad response this must survive.
    minReadings: Number.isFinite(n) && n >= 2 ? n : TVL_FLOOR_DEFAULT_MIN_READINGS,
    minMinutes: Number.isFinite(m) && m >= 0 ? m : TVL_FLOOR_DEFAULT_MIN_MINUTES,
  };
}

/**
 * Turn a pool-discovery row into a reading. Only the raw `tvl` field is used — never
 * `active_tvl` (liquidity around the active bin: FACTORY-SOL showed $0.0000007 there with
 * $1,275 TVL) and never a coerced value (`Number(x) || null` turns a real 0 into "missing"
 * and `Number(null)` turns "missing" into 0). A literal numeric 0 IS a reading: a fully
 * drained pool is the case the rule exists for, and the on-chain check is what tells a real
 * 0 from an indexer fault.
 */
export function readPoolTvlUsd(detail, poolAddress) {
  if (!detail || typeof detail !== "object") return { ok: false, reason: "no pool row" };
  if (poolAddress && detail.pool_address !== poolAddress) return { ok: false, reason: "row is for another pool" };
  const tvl = detail.tvl;
  if (typeof tvl !== "number") return { ok: false, reason: `tvl is ${tvl === null ? "null" : typeof tvl}` };
  if (!Number.isFinite(tvl)) return { ok: false, reason: "tvl is not finite" };
  if (tvl < 0) return { ok: false, reason: "tvl is negative" };
  return { ok: true, tvl_usd: tvl };
}

/**
 * Advance a position's below-floor streak with one reading. Pure.
 * @param {object|null} prev   stored streak ({ count, first_at, last_at, … }) or null
 * @param {object} reading     { ok, tvl_usd } from readPoolTvlUsd (or { ok:false })
 * @returns {{ streak: object|null, event: string, ready: boolean, span_min: number }}
 *   event: ignored | reset | started | restarted | merged | counted
 */
export function advanceTvlFloorStreak(prev, reading, cfg, nowMs = Date.now()) {
  const c = cfg && cfg.floorUsd ? cfg : tvlFloorExitConfig(cfg);
  const cur = prev && Number(prev.count) > 0 ? prev : null;
  const tvl = reading?.ok === true ? num(reading.tvl_usd) : null;
  const spanMin = (s) => (s ? Math.max(0, (new Date(s.last_at).getTime() - new Date(s.first_at).getTime()) / 60_000) : 0);
  const isReady = (s) => !!s && s.count >= c.minReadings && spanMin(s) >= c.minMinutes;

  // Failed / missing / malformed reading: neither counts nor resets. It can never complete a streak.
  if (tvl == null || tvl < 0) return { streak: cur, event: "ignored", ready: false, span_min: spanMin(cur) };
  if (tvl >= c.floorUsd) return { streak: null, event: cur ? "reset" : "ignored", ready: false, span_min: 0 };

  const nowIso = new Date(nowMs).toISOString();
  const lastMs = cur ? new Date(cur.last_at).getTime() : NaN;
  if (!cur || !Number.isFinite(lastMs) || nowMs - lastMs > TVL_FLOOR_MAX_GAP_MS || nowMs < lastMs) {
    const streak = { count: 1, first_at: nowIso, last_at: nowIso, first_tvl_usd: tvl, last_tvl_usd: tvl, max_tvl_usd: tvl };
    return { streak, event: cur ? "restarted" : "started", ready: isReady(streak), span_min: 0 };
  }
  if (nowMs - lastMs < TVL_FLOOR_MIN_SPACING_MS) {
    const streak = { ...cur, last_tvl_usd: tvl, max_tvl_usd: Math.max(Number(cur.max_tvl_usd) || 0, tvl) };
    return { streak, event: "merged", ready: isReady(streak), span_min: spanMin(streak) };
  }
  const streak = { ...cur, count: cur.count + 1, last_at: nowIso, last_tvl_usd: tvl, max_tvl_usd: Math.max(Number(cur.max_tvl_usd) || 0, tvl) };
  return { streak, event: "counted", ready: isReady(streak), span_min: spanMin(streak) };
}

/**
 * The independent figure: the pool's reserve token accounts (read over RPC) valued at the
 * active-bin price — the same definition Meteora's `tvl` uses, from a different source.
 * SOL-quoted pools only; anything missing → null (the caller treats that as "unavailable").
 */
export function onChainTvlUsd({ xUi, yUi, activeId, binStep, decX, decY, solUsd } = {}) {
  const x = num(xUi), y = num(yUi), a = num(activeId), bs = num(binStep), dx = num(decX), dy = num(decY), px = num(solUsd);
  if (x == null || y == null || a == null || bs == null || dx == null || dy == null || px == null) return null;
  if (x < 0 || y < 0 || !(bs > 0) || !(px > 0)) return null;
  const solPerBase = Math.pow(1 + bs / 1e4, a) * Math.pow(10, dx - dy);
  if (!Number.isFinite(solPerBase) || !(solPerBase > 0)) return null;
  const usd = (x * solPerBase + y) * px;
  return Number.isFinite(usd) ? usd : null;
}

/**
 * @param {object|null} chain  { ok, tvl_usd, reason } from getPoolOnChainTvlUsd
 * @returns {{ verdict: "confirmed"|"disagree"|"unavailable", chain_tvl_usd: number|null, reason?: string }}
 */
export function crossCheckTvlFloor(chain, cfg) {
  const c = cfg && cfg.floorUsd ? cfg : tvlFloorExitConfig(cfg);
  const v = chain?.ok === true ? num(chain.tvl_usd) : null;
  if (v == null || v < 0) return { verdict: "unavailable", chain_tvl_usd: null, reason: chain?.reason || "no on-chain figure" };
  return { verdict: v < c.floorUsd ? "confirmed" : "disagree", chain_tvl_usd: v };
}

const usd = (v) => `$${Math.round(Number(v)).toLocaleString("en-US")}`;

/**
 * Canonical close reason. `exitFamilyFromReason` keys on the "TVL exit" prefix. The wording
 * avoids "floor" and "below" on purpose: legacy substring scans (pool-memory.js, lessons.js,
 * hivemind.js) read "oor" / "below" in a close reason as an out-of-range close.
 */
export function tvlFloorExitReason({ streak, chainTvlUsd, cfg, held = false }) {
  const span = Math.round((new Date(streak.last_at).getTime() - new Date(streak.first_at).getTime()) / 60_000);
  return `TVL exit: pool TVL ${usd(streak.last_tvl_usd)} under the ${usd(cfg.floorUsd)} minimum for ${streak.count} readings in ${span}m` +
    ` (on-chain reserves ${usd(chainTvlUsd)}) — hard exit${held ? " (overrides HOLD)" : ""}`;
}

/** The exit object, same shape the single evaluator emits (see finalizeExit in state.js). */
export function buildTvlFloorExit({ streak, chainTvlUsd, cfg, held = false }) {
  return {
    action: "TVL_FLOOR",
    rule: "tvl_floor",
    family: "tvl_floor",
    urgent: true, // a dying pool only gets worse: no exit-swap guard, no slippage cap, no pre-close claim
    confirm_ticks: 1,
    hold_override: held ? TVL_FLOOR_HOLD_OVERRIDE : null,
    reason: tvlFloorExitReason({ streak, chainTvlUsd, cfg, held }),
  };
}

/**
 * May a close pass the HOLD guards? Only for a position whose TVL-floor exit was confirmed
 * (both sources) in the last few minutes, in enforce mode. The caller must also have asked
 * for it (`hold_override: "tvl_floor"`), so the flag alone — e.g. set by a model in tool
 * args — opens nothing, and neither does a stale stamp.
 */
export function tvlFloorOverrideActive(tracked, mgmt, requested, nowMs = Date.now()) {
  if (requested !== TVL_FLOOR_HOLD_OVERRIDE) return false;
  if (tvlFloorExitConfig(mgmt).mode !== "enforce") return false;
  const at = tracked?.tvl_floor_exit?.confirmed_at ? new Date(tracked.tvl_floor_exit.confirmed_at).getTime() : NaN;
  return Number.isFinite(at) && nowMs >= at && nowMs - at <= TVL_FLOOR_CONFIRM_TTL_MS;
}
