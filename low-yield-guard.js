// low-yield-guard.js — leaf module (no imports). Pure helpers for the low-yield exit
// (state.js, step 10 of updatePnlAndCheckExits).
//
// 2026-11-27: three times (BULLSHIT-SOL and MADE-SOL 08-20, Snowball-SOL FYu6yYB6 11-27)
// the bot's own fee claim was followed 7–12 s later by a fee/TVL reading of 0.00 % and
// the rule closed an earning position. Guards, all of which must pass before LOW_YIELD fires:
//   - claim quiet period: no low-yield exit while the later of `last_claim_at` and
//     `own_fee_reset_at` (unclaimed fees seen to drop without recordClaim) is younger than
//     lowYieldClaimQuietMinutes;
//   - persistence: the low reading must stand lowYieldPersistMinutes (pos.low_yield_streak);
//   - verification (a): the low reading was seen on ≥ LOW_YIELD_MIN_FETCHES distinct Meteora
//     fetches (required whenever lowYieldPersistMinutes > 0);
//   - verification (b): the position's own unclaimed fees (token units, read on chain) over
//     ≥ lowYieldVerifyMinutes accrue at less than the minimum too.
// A check that cannot be evaluated does not pass (fail closed = no close). Each key 0 = off.

export const LOW_YIELD_CLAIM_QUIET_DEFAULT_MIN = 30;
export const LOW_YIELD_PERSIST_DEFAULT_MIN = 10;
export const LOW_YIELD_VERIFY_DEFAULT_MIN = 30;
export const LOW_YIELD_MINUTES_MAX = 240;
/** A streak whose last qualifying reading is older than this restarts (e.g. after a HOLD). */
export const LOW_YIELD_STREAK_GAP_MS = 15 * 60_000;
/** Distinct Meteora fetches a low reading must be seen on before it can close. */
export const LOW_YIELD_MIN_FETCHES = 2;
/** Own-fee ring: at most one sample per 5 min, at most 30 samples (≈ 2.5 h). */
export const OWN_FEE_SAMPLE_INTERVAL_MS = 5 * 60_000;
export const OWN_FEE_RING_CAP = 30;

const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Finite number, or a numeric string that is not blank. Booleans, arrays, objects → null. */
function strictNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** True when `raw` is an acceptable minutes value for the three keys: finite, 0 … 240. */
export function isValidLowYieldMinutes(raw) {
  const n = strictNumber(raw);
  return n != null && n >= 0 && n <= LOW_YIELD_MINUTES_MAX;
}

/** Resolve a minutes key: a valid value is used as is, anything else falls back. */
export function lowYieldMinutes(raw, fallback) {
  return isValidLowYieldMinutes(raw) ? strictNumber(raw) : fallback;
}

/**
 * Pool cooldown after a low-yield close (pool-memory.js recordPoolDeploy, 2026-11-27).
 * Hours, finite, 0 … 72; 0 = no cooldown. Before 2026-11-27 the cooldown compared the close
 * reason with the exact string "low yield" and never matched a real reason.
 */
export const LOW_YIELD_COOLDOWN_DEFAULT_HOURS = 4;
export const LOW_YIELD_COOLDOWN_MAX_HOURS = 72;
export function isValidLowYieldCooldownHours(raw) {
  const n = strictNumber(raw);
  return n != null && n >= 0 && n <= LOW_YIELD_COOLDOWN_MAX_HOURS;
}
export function lowYieldCooldownHours(raw, fallback = LOW_YIELD_COOLDOWN_DEFAULT_HOURS) {
  return isValidLowYieldCooldownHours(raw) ? strictNumber(raw) : fallback;
}

/** The three keys resolved from a management config (absent → the defaults). */
export function lowYieldGuardConfig(mgmt = {}) {
  return {
    quietMin: lowYieldMinutes(mgmt?.lowYieldClaimQuietMinutes, LOW_YIELD_CLAIM_QUIET_DEFAULT_MIN),
    persistMin: lowYieldMinutes(mgmt?.lowYieldPersistMinutes, LOW_YIELD_PERSIST_DEFAULT_MIN),
    verifyMin: lowYieldMinutes(mgmt?.lowYieldVerifyMinutes, LOW_YIELD_VERIFY_DEFAULT_MIN),
  };
}

function isoMs(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  return new Date(v).getTime();
}

/**
 * Minutes since the quiet period's start (the later of the stamps) when inside it, else null.
 * @param {Array<string|number|null>} stamps ISO or ms (last_claim_at, own_fee_reset_at)
 * @param {number} quietMin 0 = off
 * @param {number} nowMs
 */
export function claimQuietMinutesAgo(stamps, quietMin, nowMs) {
  if (!(quietMin > 0)) return null;
  const list = Array.isArray(stamps) ? stamps : [stamps];
  const t = Math.max(...list.map(isoMs).filter(Number.isFinite));
  if (!Number.isFinite(t)) return null;
  const ago = nowMs - t;
  if (ago < 0) return 0; // clock skew: a claim "in the future" is a claim just now
  return ago < quietMin * 60_000 ? ago / 60_000 : null;
}

/**
 * Start or continue the low-yield streak on a qualifying reading (every pre-verification
 * condition holds). A streak whose last reading is more than LOW_YIELD_STREAK_GAP_MS old
 * restarts. `fetchedAt` (ms) is when Meteora was actually fetched for this reading; a new
 * stamp adds a fetch, a repeat or a missing one does not.
 * @returns {{ streak: object, started: boolean, persisted: boolean, standingMin: number }}
 */
export function advanceLowYieldStreak(prev, { reading, nowMs, persistMin, fetchedAt = null }) {
  const nowIso = new Date(nowMs).toISOString();
  const lastMs = prev?.last_at ? new Date(prev.last_at).getTime() : NaN;
  const sinceMs = prev?.since ? new Date(prev.since).getTime() : NaN;
  const continues = !!prev && Number.isFinite(lastMs) && Number.isFinite(sinceMs) && nowMs - lastMs <= LOW_YIELD_STREAK_GAP_MS;
  const stamp = strictNumber(fetchedAt);
  let streak;
  if (continues) {
    const newFetch = stamp != null && stamp !== prev.last_fetch_at;
    streak = {
      since: prev.since,
      last_at: nowIso,
      readings: (Number(prev.readings) || 0) + 1,
      min_value: Number.isFinite(Number(prev.min_value)) ? Math.min(Number(prev.min_value), reading) : reading,
      fetches: (Number(prev.fetches) || 0) + (newFetch ? 1 : 0),
      first_fetch_at: prev.first_fetch_at ?? (newFetch ? stamp : null),
      last_fetch_at: newFetch ? stamp : (prev.last_fetch_at ?? null),
      unverified_causes: Array.isArray(prev.unverified_causes) ? [...prev.unverified_causes] : [],
    };
  } else {
    streak = {
      since: nowIso, last_at: nowIso, readings: 1, min_value: reading,
      fetches: stamp != null ? 1 : 0,
      first_fetch_at: stamp, last_fetch_at: stamp,
      unverified_causes: [],
    };
  }
  const standingMs = nowMs - new Date(streak.since).getTime();
  const persist = Number(persistMin) > 0 ? Number(persistMin) : 0;
  return { streak, started: !continues, persisted: standingMs >= persist * 60_000, standingMin: standingMs / 60_000 };
}

// ── Own-fee verification ─────────────────────────────────────────────────────

/** Unclaimed fee amounts (whole tokens) from a scan row: unrounded companions first. */
export function ownFeeAmountsFromRow(row) {
  const fx = strictNumber(row?.fee_x_amount_raw) ?? strictNumber(row?.fee_x_amount);
  const fy = strictNumber(row?.fee_y_amount_raw) ?? strictNumber(row?.fee_y_amount);
  if (fx == null || fy == null || fx < 0 || fy < 0) return null;
  return { fx, fy };
}

/**
 * SOL per base token at the pool's active bin, for a SOL-quoted pool (token Y = SOL, X ≠ SOL):
 * (1 + binStep/1e4)^active × 10^(decX − decY). Else { cause }.
 */
export function solPerBaseFromRow(row) {
  const x = row?.token_x_mint, y = row?.token_y_mint;
  if (!x || !y || y !== SOL_MINT || x === SOL_MINT) return { cause: "not SOL-quoted" };
  const active = strictNumber(row?.active_bin), binStep = strictNumber(row?.bin_step);
  const decX = strictNumber(row?.token_x_decimals), decY = strictNumber(row?.token_y_decimals);
  if (active == null || binStep == null || !(binStep > 0) || decX == null || decY == null) return { cause: "no pool price" };
  const p = Math.pow(1 + binStep / 1e4, active) * Math.pow(10, decX - decY);
  return Number.isFinite(p) && p > 0 ? { solPerBase: p } : { cause: "no pool price" };
}

/**
 * Advance the own-fee ring with this pass's amounts. A DECREASE of either amount versus the
 * last sample (a claim, ours or the operator's; a re-range) resets the ring to this sample.
 * Otherwise a sample is appended at most once per OWN_FEE_SAMPLE_INTERVAL_MS, capped.
 * @returns {{ ring: object[], changed: boolean, decreased: boolean }}
 */
export function advanceOwnFeeSamples(ring, { fx, fy, nowMs }) {
  const cur = { at: new Date(nowMs).toISOString(), fx, fy };
  const list = Array.isArray(ring) ? ring : [];
  const last = list.length ? list[list.length - 1] : null;
  if (!last) return { ring: [cur], changed: true, decreased: false };
  const dropped = (now, before) => now < Number(before) - Math.max(1e-12, Math.abs(Number(before)) * 1e-9);
  if (dropped(fx, last.fx) || dropped(fy, last.fy)) return { ring: [cur], changed: true, decreased: true };
  if (nowMs - new Date(last.at).getTime() >= OWN_FEE_SAMPLE_INTERVAL_MS) {
    const next = [...list, cur];
    return { ring: next.length > OWN_FEE_RING_CAP ? next.slice(-OWN_FEE_RING_CAP) : next, changed: true, decreased: false };
  }
  return { ring: list, changed: false, decreased: false };
}

/**
 * Own fee rate, % of the position's value per 24 h, from the oldest ring sample to now:
 * (Δfy + Δfx × solPerBase) / valueSol × (1440 / windowMin) × 100. Token-unit deltas: a price
 * move cannot make the accrual negative. null window when the ring is empty.
 */
export function ownFeeRate({ ring, fx, fy, solPerBase, valueSol, nowMs }) {
  const oldest = Array.isArray(ring) && ring.length ? ring[0] : null;
  if (!oldest) return { ownPct: null, windowMin: 0 };
  const windowMin = (nowMs - new Date(oldest.at).getTime()) / 60_000;
  if (!(windowMin > 0) || !(valueSol > 0) || !(solPerBase > 0)) return { ownPct: null, windowMin: Math.max(0, windowMin) };
  const dfx = Math.max(0, fx - Number(oldest.fx));
  const dfy = Math.max(0, fy - Number(oldest.fy));
  const ownPct = ((dfy + dfx * solPerBase) / valueSol) * (1440 / windowMin) * 100;
  return { ownPct, windowMin };
}

/**
 * Denominator of the own rate: the smaller of the row's SOL value and the tracked capital
 * (a smaller denominator gives a larger rate = harder to verify, so neither figure being
 * inflated can make an earner look dead). One usable → that one; neither → null.
 */
export function ownFeeDenominatorSol(valueSol, capitalSol) {
  const v = strictNumber(valueSol), c = strictNumber(capitalSol);
  const usable = [v, c].filter((n) => n != null && n > 0);
  return usable.length ? Math.min(...usable) : null;
}

/**
 * Verification of a persisted low-yield streak. Fail closed: anything that cannot be
 * evaluated returns verified:false with a cause.
 * @returns {{ verified: boolean, cause: string|null, causeKey: string|null, ownPct: number|null, windowMin: number|null, fetches: number, fetchSpanMin: number|null }}
 */
export function verifyLowYield({ streak, row, ring, minPct, persistMin, verifyMin, nowMs, capitalSol = null, valuationReady = true }) {
  const fetches = Number(streak?.fetches) || 0;
  const fetchSpanMin = Number.isFinite(Number(streak?.first_fetch_at)) && Number.isFinite(Number(streak?.last_fetch_at))
    ? (Number(streak.last_fetch_at) - Number(streak.first_fetch_at)) / 60_000 : null;
  const out = { verified: false, cause: null, causeKey: null, ownPct: null, windowMin: null, fetches, fetchSpanMin };
  // Only a usable reading can verify (suspect PnL, capital re-base or bot flow pending).
  if (!valuationReady && (verifyMin > 0 || persistMin > 0)) return { ...out, cause: "valuation not ready", causeKey: "valuation_not_ready" };
  if (verifyMin > 0) {
    const amounts = ownFeeAmountsFromRow(row);
    if (!amounts) return { ...out, cause: "no fee amounts", causeKey: "no_fee_amounts" };
    const price = solPerBaseFromRow(row);
    if (price.cause) return { ...out, cause: price.cause, causeKey: price.cause === "not SOL-quoted" ? "not_sol_quoted" : "no_pool_price" };
    const valueSol = ownFeeDenominatorSol(row?.total_value_sol, capitalSol);
    if (valueSol == null) return { ...out, cause: "no position value", causeKey: "no_position_value" };
    const { ownPct, windowMin } = ownFeeRate({ ring, fx: amounts.fx, fy: amounts.fy, solPerBase: price.solPerBase, valueSol, nowMs });
    out.windowMin = windowMin;
    if (windowMin < verifyMin || ownPct == null) {
      return { ...out, cause: `own-fee history ${Math.floor(windowMin)} min < ${verifyMin}`, causeKey: "own_fee_history" };
    }
    out.ownPct = ownPct;
    if (!(ownPct < minPct)) return { ...out, cause: null, causeKey: "own_rate" };
  }
  if (persistMin > 0 && fetches < LOW_YIELD_MIN_FETCHES) {
    return { ...out, cause: "one Meteora fetch only", causeKey: "one_fetch" };
  }
  return { ...out, verified: true };
}

/** The proof appended after the unchanged "Low yield: …" prefix ("" when nothing was checked). */
export function lowYieldProofSuffix(v, { persistMin, verifyMin }) {
  const parts = [];
  if (verifyMin > 0 && v.ownPct != null) parts.push(`own fees ${v.ownPct.toFixed(2)}%/24h over ${Math.floor(v.windowMin)}m`);
  if (persistMin > 0) parts.push(`${v.fetches} Meteora fetches over ${Math.round(v.fetchSpanMin ?? 0)}m`);
  return parts.length ? ` — verified: ${parts.join(", ")}` : "";
}

/** Log line for a persisted streak that is not verified. */
export function lowYieldUnverifiedLine({ pair, address, reading, minPct, standingMin, v }) {
  const head = `[LOW_YIELD_UNVERIFIED] ${pair} ${String(address).slice(0, 8)}: Meteora fee/TVL ${Number(reading).toFixed(2)}% < ${minPct}% for ${Math.floor(standingMin)} min`;
  if (v.causeKey === "own_rate") {
    return `${head}, but the position's own fees over the last ${Math.floor(v.windowMin)} min equal ${v.ownPct.toFixed(2)}%/24h — not closing`;
  }
  return `${head} — cannot verify (${v.cause}) — not closing`;
}
