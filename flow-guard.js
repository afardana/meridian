/**
 * Flow guard (2026-11-27, operator): an operator-armed, per-position stop that closes ONE
 * position when the token's market flow turns unfavourable — sell pressure with a falling
 * price, a liquidity pull, a holder exodus — instead of a price or TVL threshold. The operator
 * holds fresh, volatile tokens on purpose; the PnL valuation is unreliable around top-ups, so
 * nothing here reads the position's PnL.
 *
 * Leaf module (imports only rule-mode.js): parsing, defaults, the reading, the per-condition
 * streaks, the confirmed peaks, the on-chain price ring and the corroboration. No I/O. The I/O
 * lives in flow-guard-cycle.js (orchestration with injected deps), tools/token-flow.js (Jupiter
 * read), tools/dlmm.js getPoolActiveBinFresh (active bin) and state.js (the guard on the position).
 *
 * Arming: POST /command/set-flow-guard (operator only; not an LLM tool, not an update_config
 * key). The thresholds are stored on the position at arming, so what is armed is explicit.
 * Global kill switch: flowGuardMode armed | off (off = no armed guard evaluates or fires).
 *
 * Proof, in order (fail-closed at every step; 2026-11-27 review round):
 *   1. A reading COUNTS only when the Jupiter datapi read of this cycle succeeded, the asset is
 *      the exact mint, the fetch is fresh, and its snapshot (`updatedAt`) is no older than 5 min
 *      and no more than 60 s ahead of the answer's own clock (its HTTP `Date` header, else the
 *      local clock) and strictly newer than the last counted reading's (and than the arming
 *      read's) — otherwise it is unusable ("stale snapshot"): neither counts nor resets. Counted
 *      snapshots less than 60 s apart are one reading. No counted reading for 30 min → blind.
 *   2. ONE streak per condition (sell pressure / liquidity pull / holder exodus). A counted
 *      reading on which a condition can be evaluated advances that condition's streak when it
 *      holds and resets it when it does not; a condition it cannot evaluate is left alone.
 *      > 15 min since a streak's last reading restarts it.
 *   3. A condition is ready after `confirm_readings` of its own readings spanning ≥
 *      `confirm_minutes`, and fires only with its corroboration on the firing reading:
 *        sell pressure  — on-chain pool price over the guard's own ring (≈ last hour) down
 *                         ≥ price_drop_1h_pct × 2/3;
 *        liquidity pull — this pool's Meteora TVL ≤ 85 % of its raw peak AND (minus the position's
 *                         own value) ≤ 70 % of its adjusted peak, OR the ring price down ≥ 15 %;
 *        holder exodus  — the ring price down ≥ 10 %.
 *      The ring price must hold on the last two ring entries against one base (45–75 min old, or
 *      the oldest of 15–45 min of gap-free history); otherwise unavailable.
 *      Unavailable → no fire this cycle (streaks kept).
 *   Liquidity figures are market figures: the position's own USD value is subtracted, and they
 *   are not used at all on a reading where that value is untrustworthy or just changed (an
 *   operator top-up / withdrawal is not a market move).
 *   The liquidity condition needs the RAW all-venue figure ≤ 70 % of its raw peak as well, and
 *   is suspended 30 min after a reading on which the own value rose > 20 % (a top-up).
 *   Peaks (raw / adjusted liquidity, holders, raw / adjusted pool TVL) are CONFIRMED peaks built
 *   only from counted readings: a new one needs THREE consecutive counted readings at or above
 *   it (the lowest is taken). The arming read is kept as `ref` for display only — it can never be
 *   a peak or a cycle reading.
 */

import { modeFor } from "./rule-mode.js";

export const FLOW_GUARD_HOLD_OVERRIDE = "flow_guard";

/** Param name → { def, min, max, int? } (inclusive ranges). */
export const FLOW_GUARD_PARAM_SPECS = Object.freeze({
  sell_buy_5m: Object.freeze({ def: 2.0, min: 1.2, max: 10 }),
  sell_buy_1h: Object.freeze({ def: 1.3, min: 1.0, max: 10 }),
  price_drop_1h_pct: Object.freeze({ def: 15, min: 5, max: 90 }),
  liquidity_drop_pct: Object.freeze({ def: 50, min: 20, max: 95 }),
  holders_drop_pct: Object.freeze({ def: 5, min: 2, max: 50 }),
  confirm_readings: Object.freeze({ def: 3, min: 2, max: 10, int: true }),
  confirm_minutes: Object.freeze({ def: 6, min: 3, max: 60 }),
});
export const FLOW_GUARD_DEFAULT_PARAMS = Object.freeze(
  Object.fromEntries(Object.entries(FLOW_GUARD_PARAM_SPECS).map(([k, s]) => [k, s.def])),
);

/** Both sides of the 5-minute window together below this (USD) → the ratio is not computed. */
export const FLOW_VOL_FLOOR_5M_USD = 200;
/** Both sides of the 1-hour window together below this (USD) → the ratio is not computed. */
export const FLOW_VOL_FLOOR_1H_USD = 1_000;
/** More than this since a condition's last reading starts its streak over. */
export const FLOW_GUARD_MAX_GAP_MS = 15 * 60_000;
/** Two counted snapshots closer than this are one reading. */
export const FLOW_GUARD_MIN_SPACING_MS = 60_000;
/** A fetch older than this at evaluation is not this cycle's. */
export const FLOW_READ_MAX_AGE_MS = 4 * 60_000;
/** A Jupiter snapshot (`updatedAt`) older than this at fetch time is stale. */
export const FLOW_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;
/** The "counting" Telegram alert at most this often per position. */
export const FLOW_START_ALERT_INTERVAL_MS = 30 * 60_000;
/** Shadow: at most this many distinct base mints are read per cycle. */
export const FLOW_SHADOW_MAX_MINTS = 8;
/** On-chain price ring: entries kept (≈ 90 min at the 3-min cycle). */
export const FLOW_RING_MAX = 30;
/** Ring change: the base is the entry closest to 60 min ago; under 15 min of ring → unavailable. */
export const FLOW_RING_TARGET_MS = 60 * 60_000;
export const FLOW_RING_MIN_SPAN_MS = 15 * 60_000;
/** The ring's newest entry must be this fresh to stand for "now". */
export const FLOW_RING_NOW_MAX_AGE_MS = 2 * 60_000;
/** Ring continuity: a gap over this between consecutive entries ends the usable history. */
export const FLOW_RING_MAX_GAP_MS = 10 * 60_000;
/** Ring base: 45–75 min older than the newest entry (closest to 60), else the oldest continuous entry when it spans 15–45 min. */
export const FLOW_RING_BASE_MIN_MS = 45 * 60_000;
export const FLOW_RING_BASE_MAX_MS = 75 * 60_000;
/** A snapshot whose updatedAt is this far ahead of the answer's clock is refused. */
export const FLOW_SNAPSHOT_MAX_AHEAD_MS = 60_000;
/** Blind alert: an armed guard with no counted reading for 30 min; repeated at most hourly. */
export const FLOW_BLIND_AFTER_MS = 30 * 60_000;
export const FLOW_BLIND_REPEAT_MS = 60 * 60_000;
// Corroboration constants (thresholds of the review rounds, not params).
export const FLOW_SELL_CORR_SHARE = 2 / 3; // sell pressure: ring price down ≥ price_drop_1h_pct × 2/3
export const FLOW_LIQ_RAW_SHARE = 0.70; // liquidity condition: raw Jupiter liquidity ≤ 70 % of its raw peak (as well as the adjusted test)
export const FLOW_LIQ_CORR_TVL_RAW_SHARE = 0.85; // liquidity corroboration: raw pool TVL ≤ 85 % of its raw peak AND …
export const FLOW_LIQ_CORR_TVL_SHARE = 0.70; // … pool TVL − own ≤ 70 % of its adjusted peak
export const FLOW_LIQ_CORR_PRICE_DROP_PCT = 15; // … or ring price down ≥ 15 %
export const FLOW_HOLD_CORR_PRICE_DROP_PCT = 10; // holders: ring price down ≥ 10 % (the only corroboration)
/** Own value rose more than this share since the last counted reading (a top-up) → the liquidity condition is suspended. */
export const FLOW_OWN_RISE_SUSPEND_SHARE = 0.20;
export const FLOW_LIQ_SUSPEND_MS = 30 * 60_000;
/** Own value moved more than this share (and more than OWN_JUMP_MIN_USD) since the last counted reading → liquidity figures not used. */
export const FLOW_OWN_JUMP_SHARE = 0.25;
export const FLOW_OWN_JUMP_MIN_USD = 25;

export const FLOW_CONDITIONS = Object.freeze(["sell_pressure", "liquidity_pull", "holder_exodus"]);

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonNeg = (v) => { const n = num(v); return n != null && n >= 0 ? n : null; };
const iso = (ms) => new Date(ms).toISOString();
const msOf = (v) => (typeof v === "string" || typeof v === "number" ? new Date(v).getTime() : NaN);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const ratioOut = (v) => (v === Infinity ? "inf" : r4(v ?? null));

/** Shadow mode: off | shadow (log only). */
export function flowGuardShadowMode(mgmt = {}) {
  return modeFor("flowGuardShadowMode", mgmt?.flowGuardShadowMode);
}
/** Global kill switch: armed (default) | off; an unknown value reads as off (fail closed). Operator only. */
export function flowGuardMode(mgmt = {}) {
  return modeFor("flowGuardMode", mgmt?.flowGuardMode);
}

// Off latch: set when the operator turned the guards OFF and user-config.json could not be
// written, so a reload of the stale file cannot turn them back on (config.js reads it).
let _offLatch = false;
export function setFlowGuardOffLatch(v) { _offLatch = v === true; }
export function flowGuardOffLatched() { return _offLatch; }

/** POST /command/set-flow-guard `{ mode }` body → { ok, mode } or { ok:false, error }. */
export function parseFlowGuardModeBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "mode") return { ok: false, error: "the mode form takes exactly { \"mode\": \"armed\" | \"off\" }" };
  if (body.mode !== "armed" && body.mode !== "off") return { ok: false, error: "`mode` must be \"armed\" or \"off\"" };
  return { ok: true, mode: body.mode };
}

/** Plain facts the operator gets at arming (endpoint response + log line). */
export const FLOW_GUARD_ARMING_FACTS = Object.freeze([
  "cannot fire for the first 15 minutes (the on-chain price history must build up)",
  "best case ≈ 7–10 minutes after a collapse starts, plus up to 5 minutes of Jupiter data lag",
  "the liquidity condition is suspended for 30 minutes after your own top-up",
  "LPs leaving on another venue while this pool's price stays flat does not fire",
  "a token whose trading stops makes the guard blind (you get a blind alert)",
]);

/**
 * Validate params. undefined / null → the defaults. Otherwise a plain object whose keys are a
 * subset of FLOW_GUARD_PARAM_SPECS (plus a tolerated `use_gmgn: false`); missing keys take the
 * default. Strict types; ranges inclusive. `use_gmgn: true` is refused (not available).
 */
export function parseFlowGuardParams(raw) {
  if (raw === undefined || raw === null) return { ok: true, params: { ...FLOW_GUARD_DEFAULT_PARAMS } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "`params` must be an object" };
  const out = { ...FLOW_GUARD_DEFAULT_PARAMS };
  for (const [k, v] of Object.entries(raw)) {
    if (k === "use_gmgn") {
      if (v === undefined || v === false) continue;
      return { ok: false, error: "`use_gmgn` is not available (the GMGN exodus check does not run on held positions)" };
    }
    const s = FLOW_GUARD_PARAM_SPECS[k];
    if (!s) return { ok: false, error: `unknown param \`${k}\`` };
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `\`${k}\` must be a number` };
    if (s.int && !Number.isInteger(v)) return { ok: false, error: `\`${k}\` must be a whole number` };
    if (v < s.min || v > s.max) return { ok: false, error: `\`${k}\` must be between ${s.min} and ${s.max}` };
    out[k] = v;
  }
  return { ok: true, params: out };
}

/** A stored params object, re-validated (a hand-edited row must not loosen the rule). */
export function storedFlowGuardParams(guard) {
  const p = parseFlowGuardParams(guard?.params ?? null);
  return p.ok ? p.params : null;
}

/**
 * POST /command/set-flow-guard body → { ok:true, position, arm, params|null } or { ok:false, error }.
 * { position, arm: true, params? } arms; { position, arm: false } disarms (params not allowed).
 */
export function parseFlowGuardBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
  for (const k of Object.keys(body)) {
    if (!["position", "arm", "params"].includes(k)) return { ok: false, error: `unknown field \`${k}\`` };
  }
  const position = typeof body.position === "string" ? body.position.trim() : "";
  if (!BASE58_RE.test(position)) return { ok: false, error: "Missing or malformed `position` (base58 address expected)" };
  if (typeof body.arm !== "boolean") return { ok: false, error: "`arm` must be true or false" };
  if (!body.arm) {
    if (body.params !== undefined) return { ok: false, error: "`params` is only allowed with arm: true" };
    return { ok: true, position, arm: false, params: null };
  }
  const p = parseFlowGuardParams(body.params);
  if (!p.ok) return { ok: false, error: p.error };
  return { ok: true, position, arm: true, params: p.params };
}

/** The base mint the guard reads, or null (missing, or the pool's base token is SOL). */
export function flowGuardMintOf(tracked, row = null) {
  const m = tracked?.base_mint || row?.base_mint || null;
  if (typeof m !== "string" || !BASE58_RE.test(m) || m === WSOL_MINT) return null;
  return m;
}

/** May the guard be armed / disarmed on this tracked position? null = yes; else { status, error }. */
export function flowGuardRefusal(tracked, { disarming = false } = {}) {
  if (!tracked || tracked.closed) return { status: 404, error: "Position is not open in the bot" };
  if (!disarming && !flowGuardMintOf(tracked)) return { status: 409, error: "Position has no readable base token (missing, or the base token is SOL)" };
  return null;
}

export function flowGuardParamsText(p) {
  if (!p) return "no valid params";
  return `sell/buy 5m ≥ ${p.sell_buy_5m}× and 1h ≥ ${p.sell_buy_1h}× with price 1h down ≥ ${p.price_drop_1h_pct}%; ` +
    `market liquidity down ≥ ${p.liquidity_drop_pct}% from its peak; holders down ≥ ${p.holders_drop_pct}% from their peak; ` +
    `one condition on ${p.confirm_readings} distinct readings over ≥ ${p.confirm_minutes} min, corroborated`;
}

// ── The reading ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a Jupiter datapi `/v1/assets/search?query=<mint>` payload into a reading. Only the asset
 * whose `id` is EXACTLY the mint is used; figures only when they are finite numbers. `updatedAt`
 * (top level, ISO with nanoseconds) is the time Jupiter last refreshed that asset record — it
 * moves with `priceBlockId`; two fetches returning the same value are the same snapshot.
 * `serverDateMs` = the HTTP response's `Date` header (null → the local clock is the reference):
 * snapshot staleness is measured against it, so a skewed VM clock cannot make every read stale.
 */
export function readFlowAsset(payload, mint, fetchedAtMs = Date.now(), { serverDateMs = null } = {}) {
  const at = iso(fetchedAtMs);
  const list = Array.isArray(payload) ? payload : payload && typeof payload === "object" ? [payload] : [];
  const t = list.find((x) => x && typeof x === "object" && x.id === mint);
  if (!t) return { ok: false, reason: list.length ? "no asset with this exact mint in the answer" : "empty answer", at, mint };
  const win = (s) => (s && typeof s === "object"
    ? {
        buy: nonNeg(s.buyVolume), sell: nonNeg(s.sellVolume), price_change: num(s.priceChange),
        num_buys: nonNeg(s.numBuys), num_sells: nonNeg(s.numSells), num_traders: nonNeg(s.numTraders),
      }
    : { buy: null, sell: null, price_change: null, num_buys: null, num_sells: null, num_traders: null });
  return {
    ok: true,
    mint,
    at,
    server_at: Number.isFinite(serverDateMs) ? iso(serverDateMs) : null,
    symbol: typeof t.symbol === "string" ? t.symbol : null,
    liquidity_usd: nonNeg(t.liquidity),
    holders: nonNeg(t.holderCount),
    price_usd: nonNeg(t.usdPrice),
    s5m: win(t.stats5m),
    s1h: win(t.stats1h),
    updated_at: typeof t.updatedAt === "string" ? t.updatedAt : null,
  };
}

/** sell ÷ buy, Infinity when only sells (with the window above its floor), else null. */
function sellBuyRatio(w, floor) {
  if (!w || w.buy == null || w.sell == null) return null;
  if (w.buy + w.sell < floor) return null;
  return w.buy > 0 ? w.sell / w.buy : Infinity;
}

/**
 * The position's own value input: { usd, trusted } (cycle: total_value_true_usd with pnl_quality
 * absent or "valid", no pending flow / capital re-base). Returns the usd to subtract or null when
 * the adjusted figures must not be used on this reading (untrusted, or just changed), and
 * `rose` when it rose more than FLOW_OWN_RISE_SUSPEND_SHARE (a top-up: liquidity is suspended).
 */
export function ownValueForReading(own, lastOwnUsd) {
  if (!own || own.trusted !== true) return { usd: null, reason: "own value untrustworthy" };
  const v = nonNeg(own.usd);
  if (v == null) return { usd: null, reason: "own value unknown" };
  const last = nonNeg(lastOwnUsd);
  const rose = last != null && v > last * (1 + FLOW_OWN_RISE_SUSPEND_SHARE) && v - last > FLOW_OWN_JUMP_MIN_USD;
  if (last != null) {
    const d = Math.abs(v - last);
    if (d > FLOW_OWN_JUMP_MIN_USD && d > FLOW_OWN_JUMP_SHARE * Math.max(v, last)) return { usd: null, reason: `own value changed $${Math.round(last)} → $${Math.round(v)}`, changed: true, new_usd: v, rose };
  }
  return { usd: v, rose };
}

// ── On-chain price ring ─────────────────────────────────────────────────────────────────────

/** Append one fresh active-bin read to the ring (pure; returns a new array, ≤ FLOW_RING_MAX). */
export function pushRing(ring, chain, nowMs) {
  const out = Array.isArray(ring) ? ring.slice() : [];
  if (!chain || chain.ok !== true) return out;
  const bin = num(chain.active_bin);
  if (bin == null) return out;
  const at = Number.isFinite(msOf(chain.at)) ? iso(msOf(chain.at)) : iso(nowMs);
  const last = out[out.length - 1];
  if (last && msOf(last.at) >= msOf(at)) return out; // never out of order / duplicate
  out.push({ at, bin });
  return out.slice(-FLOW_RING_MAX);
}

const median = (xs) => { const v = xs.slice().sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

/**
 * The ring's base for "the last hour", or null: { bin, at }. Only the CONTINUOUS tail of the ring
 * is used (walking back from the newest, no gap > 10 min between consecutive entries). The base is
 * the MEDIAN bin of the continuous entries 45–75 min older than the newest (so one wick in that
 * window cannot be the reference); with none there, and the continuous history spanning 15–45
 * min, the median of its oldest (up to) three entries that are ≥ 15 min old; otherwise null.
 * `at` = the newest entry that went into the base.
 */
export function ringBase(ring, lastIndex = ring.length - 1) {
  if (!Array.isArray(ring) || lastIndex < 1) return null;
  const lastMs = msOf(ring[lastIndex].at);
  let start = lastIndex;
  while (start > 0) {
    const gap = msOf(ring[start].at) - msOf(ring[start - 1].at);
    if (!Number.isFinite(gap) || gap > FLOW_RING_MAX_GAP_MS) break;
    start--;
  }
  const ageOf = (i) => lastMs - msOf(ring[i].at);
  const win = [];
  for (let i = start; i < lastIndex; i++) if (ageOf(i) >= FLOW_RING_BASE_MIN_MS && ageOf(i) <= FLOW_RING_BASE_MAX_MS) win.push(i);
  if (win.length) return { bin: median(win.map((i) => ring[i].bin)), at: ring[win[win.length - 1]].at, n: win.length };
  const span = ageOf(start);
  if (start < lastIndex && span >= FLOW_RING_MIN_SPAN_MS && span < FLOW_RING_BASE_MIN_MS) {
    const old = [];
    for (let i = start; i < lastIndex && old.length < 3; i++) if (ageOf(i) >= FLOW_RING_MIN_SPAN_MS) old.push(i);
    return { bin: median(old.map((i) => ring[i].bin)), at: ring[old[old.length - 1]].at, n: old.length };
  }
  return null;
}

/**
 * On-chain pool price change (%) over ≈ the last hour: (1 + binStep/1e4)^Δbins − 1 from the
 * ring's base (ringBase) to BOTH of the last two entries (this cycle's and the previous one, each
 * against the same base); the LESS severe of the two is returned, so one bad bin read cannot
 * corroborate a drop. The newest entry must be fresh (≤ 2 min). Anything missing → null.
 */
export function ringPriceChangePct(ring, binStep, nowMs) {
  const bs = num(binStep);
  if (!Array.isArray(ring) || ring.length < 3 || bs == null || !(bs > 0)) return null;
  const last = ring[ring.length - 1], prev = ring[ring.length - 2];
  if (!Number.isFinite(msOf(last.at)) || nowMs - msOf(last.at) > FLOW_RING_NOW_MAX_AGE_MS) return null;
  if (msOf(last.at) - msOf(prev.at) > FLOW_RING_MAX_GAP_MS) return null;
  const base = ringBase(ring, ring.length - 1);
  if (!base || msOf(base.at) >= msOf(prev.at)) return null; // the previous entry must be newer than the base
  const chg = (b) => (Math.pow(1 + bs / 1e4, b - base.bin) - 1) * 100;
  const v = Math.max(chg(last.bin), chg(prev.bin));
  return Number.isFinite(v) ? v : null;
}

// ── The guard ───────────────────────────────────────────────────────────────────────────────

const PEAK_KEYS = Object.freeze(["liquidity_raw_usd", "liquidity_mkt_usd", "holders", "pool_tvl_raw_usd", "pool_tvl_mkt_usd"]);
const EMPTY_PEAKS = () => Object.fromEntries(PEAK_KEYS.map((k) => [k, null]));
const EMPTY_HIST = () => Object.fromEntries(PEAK_KEYS.map((k) => [k, []]));

/**
 * A freshly armed guard. `ref` = the reading at arming ({ liquidity_usd, holders, price_usd,
 * price_sol, updated_at, active_bin, bin_step, at }) — display only, except that its on-chain bin
 * seeds the price ring and its `updated_at` is a snapshot a cycle reading must be newer than.
 */
export function newFlowGuard(params, ref = {}, nowMs = Date.now()) {
  const r = {
    liquidity_usd: nonNeg(ref?.liquidity_usd),
    holders: nonNeg(ref?.holders),
    price_usd: nonNeg(ref?.price_usd),
    price_sol: nonNeg(ref?.price_sol),
    updated_at: typeof ref?.updated_at === "string" ? ref.updated_at : null,
    active_bin: num(ref?.active_bin),
    bin_step: num(ref?.bin_step),
    at: ref?.at ?? null,
  };
  const ring = r.active_bin != null ? pushRing([], { ok: true, active_bin: r.active_bin, at: r.at ?? iso(nowMs) }, nowMs) : [];
  return {
    armed_at: iso(nowMs),
    params: { ...params },
    ref: r,
    peak: EMPTY_PEAKS(),
    hist: EMPTY_HIST(), // the last two counted readings' figures per key (a new peak needs three)
    counted: 0,
    ring,
    bin_step: r.bin_step,
    streaks: { sell_pressure: null, liquidity_pull: null, holder_exodus: null },
    liquidity_suspended_until: null,
    last: null,
    last_counted_at: null,
    last_counted_updated_at: null,
    last_own_usd: null,
    blind_since: null,
    confirmed_at: null, // HOLD-override stamp: written only on the firing reading
    start_alerted_at: null,
    fired_at: null,
    fire: null,
  };
}

function figuresOf(reading, ownUsd, poolTvlUsd) {
  const liq = nonNeg(reading?.liquidity_usd);
  const tvl = nonNeg(poolTvlUsd);
  return {
    liquidity_usd: liq,
    liquidity_raw_usd: liq,
    own_usd: ownUsd,
    liquidity_mkt_usd: liq != null && ownUsd != null ? Math.max(0, liq - ownUsd) : null,
    pool_tvl_usd: tvl,
    pool_tvl_raw_usd: tvl,
    pool_tvl_mkt_usd: tvl != null && ownUsd != null ? Math.max(0, tvl - ownUsd) : null,
    holders: nonNeg(reading?.holders),
    sell_buy_5m: sellBuyRatio(reading?.s5m, FLOW_VOL_FLOOR_5M_USD),
    sell_buy_1h: sellBuyRatio(reading?.s1h, FLOW_VOL_FLOOR_1H_USD),
    price_change_1h_pct: num(reading?.s1h?.price_change),
  };
}

/** Which conditions can be evaluated on these figures, and which hold (against the CONFIRMED peaks). */
export function evaluateConditions(f, peak, params, { liquiditySuspended = false } = {}) {
  const evaluable = [], qualified = [];
  if (f.sell_buy_5m != null && f.sell_buy_1h != null && f.price_change_1h_pct != null) {
    evaluable.push("sell_pressure");
    if (f.sell_buy_5m >= params.sell_buy_5m && f.sell_buy_1h >= params.sell_buy_1h && f.price_change_1h_pct <= -params.price_drop_1h_pct) qualified.push("sell_pressure");
  }
  // Liquidity pull: BOTH the raw Jupiter figure ≤ 70 % of its raw peak AND the own-adjusted
  // figure ≤ (100 − liquidity_drop_pct) % of its adjusted peak; never while suspended (top-up).
  const lr = num(peak?.liquidity_raw_usd), lm = num(peak?.liquidity_mkt_usd);
  if (!liquiditySuspended && f.liquidity_raw_usd != null && f.liquidity_mkt_usd != null && lr > 0 && lm > 0) {
    evaluable.push("liquidity_pull");
    if (f.liquidity_raw_usd <= FLOW_LIQ_RAW_SHARE * lr && f.liquidity_mkt_usd <= ((100 - params.liquidity_drop_pct) / 100) * lm) qualified.push("liquidity_pull");
  }
  const hp = num(peak?.holders);
  if (f.holders != null && hp != null && hp > 0) {
    evaluable.push("holder_exodus");
    if (f.holders <= ((100 - params.holders_drop_pct) / 100) * hp) qualified.push("holder_exodus");
  }
  return { evaluable, qualified };
}

/** Peak update from one counted reading: max(peak, min(last three counted)) — three readings at or above. */
function advancePeaks(peak, hist, f, { skip = [] } = {}) {
  const out = { ...peak }, next = {};
  for (const k of PEAK_KEYS) {
    const v = skip.includes(k) ? null : f[k];
    const h = Array.isArray(hist?.[k]) ? hist[k] : [];
    if (v == null) { next[k] = []; continue; } // a missing figure breaks the run
    if (h.length >= 2) {
      const cand = Math.min(h[h.length - 2], h[h.length - 1], v);
      out[k] = out[k] == null ? cand : Math.max(out[k], cand);
    }
    next[k] = [...h, v].slice(-2);
  }
  return { peak: out, hist: next };
}

/** Corroboration of one ready condition on the firing reading (ringChange = the two-entry figure). */
export function corroborate(cond, f, guard, params, ringChange) {
  if (cond === "sell_pressure") {
    const need = -params.price_drop_1h_pct * FLOW_SELL_CORR_SHARE;
    if (ringChange == null) return { ok: false, verdict: "unavailable", reason: "no continuous on-chain ring of ≥ 15 min or no fresh active bin" };
    return { ok: ringChange <= need, verdict: ringChange <= need ? "confirmed" : "disagree", ring_change_pct: r2(ringChange), need_pct: r2(need), by: "ring_price" };
  }
  if (cond === "liquidity_pull") {
    const tr = num(guard.peak?.pool_tvl_raw_usd), tm = num(guard.peak?.pool_tvl_mkt_usd);
    const tvlOk = f.pool_tvl_raw_usd != null && f.pool_tvl_mkt_usd != null && tr > 0 && tm > 0 &&
      f.pool_tvl_raw_usd <= FLOW_LIQ_CORR_TVL_RAW_SHARE * tr && f.pool_tvl_mkt_usd <= FLOW_LIQ_CORR_TVL_SHARE * tm;
    const pxOk = ringChange != null && ringChange <= -FLOW_LIQ_CORR_PRICE_DROP_PCT;
    const verdict = tvlOk || pxOk ? "confirmed" : (f.pool_tvl_mkt_usd == null || tm == null) && ringChange == null ? "unavailable" : "disagree";
    return { ok: tvlOk || pxOk, verdict, pool_tvl_mkt_usd: r2(f.pool_tvl_mkt_usd), pool_tvl_peak_usd: r2(tm), pool_tvl_raw_usd: r2(f.pool_tvl_raw_usd), pool_tvl_raw_peak_usd: r2(tr), ring_change_pct: r2(ringChange), by: tvlOk ? "pool_tvl" : pxOk ? "ring_price" : null };
  }
  if (cond === "holder_exodus") {
    const pxOk = ringChange != null && ringChange <= -FLOW_HOLD_CORR_PRICE_DROP_PCT;
    const verdict = pxOk ? "confirmed" : ringChange == null ? "unavailable" : "disagree";
    return { ok: pxOk, verdict, ring_change_pct: r2(ringChange), need_pct: -FLOW_HOLD_CORR_PRICE_DROP_PCT, by: pxOk ? "ring_price" : null };
  }
  return { ok: false, verdict: "unavailable", reason: "unknown condition" };
}

function spanMin(s) {
  if (!s) return 0;
  const a = msOf(s.first_at), b = msOf(s.last_at);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 60_000) : 0;
}

/** Blind = an armed guard with no COUNTED reading for FLOW_BLIND_AFTER_MS (from arming when none yet). */
function blindSince(g, nowMs) {
  const ref = Number.isFinite(msOf(g.last_counted_at)) ? msOf(g.last_counted_at) : msOf(g.armed_at);
  if (!Number.isFinite(ref)) return null;
  return nowMs - ref >= FLOW_BLIND_AFTER_MS ? iso(ref) : null;
}

/**
 * Advance the guard with one cycle's inputs. Pure: returns a NEW guard object.
 * input = { reading, chain: { ok, active_bin, bin_step, at }, pool_tvl_usd, own: { usd, trusted } }
 * events: off | ignored (no/failed/old fetch) | stale (snapshot not newer / too old / ahead) | merged | counted
 * @returns {{ guard, event, reason, counted, evaluable, qualified, figures, started, advanced, reset,
 *             ready: string[], cross: {}, fire, fired_condition, ring_change_pct, suspended_now }}
 */
export function advanceFlowGuard(prevGuard, input = {}, nowMs = Date.now(), { params: paramsOverride = null } = {}) {
  const g = JSON.parse(JSON.stringify(prevGuard || {}));
  g.peak = { ...EMPTY_PEAKS(), ...(g.peak || {}) };
  g.hist = { ...EMPTY_HIST(), ...(g.hist || {}) };
  g.streaks ||= { sell_pressure: null, liquidity_pull: null, holder_exodus: null };
  g.confirmed_at = null; // the stamp lives only on the firing reading
  const base = { counted: false, evaluable: [], qualified: [], figures: {}, started: [], advanced: [], reset: [], ready: [], cross: {}, fire: false, fired_condition: null, ring_change_pct: null, suspended_now: false };
  const params = paramsOverride || storedFlowGuardParams(g);
  if (!params) return { ...base, guard: g, event: "off", reason: "stored params are not valid" };

  // 1. The on-chain ring moves on every cycle with a fresh active-bin read.
  g.ring = pushRing(g.ring, input.chain, nowMs);
  if (input.chain?.ok === true && num(input.chain.bin_step) > 0) g.bin_step = num(input.chain.bin_step);
  const ringChange = ringPriceChangePct(g.ring, g.bin_step, nowMs);
  base.ring_change_pct = r2(ringChange);

  // 2. Does this reading count?
  const r = input.reading;
  const out = (event, reason, extra = {}) => {
    if (event !== "counted") g.blind_since = blindSince(g, nowMs);
    return { ...base, ...extra, guard: g, event, reason };
  };
  if (!r || r.ok !== true) { g.last = { at: iso(nowMs), counted: false, reason: r?.reason || "no reading" }; return out("ignored", r?.reason || "no reading"); }
  const fetchMs = msOf(r.at);
  if (!Number.isFinite(fetchMs) || nowMs - fetchMs > FLOW_READ_MAX_AGE_MS || fetchMs - nowMs > 60_000) { g.last = { at: iso(nowMs), counted: false, reason: "fetch is not from this cycle" }; return out("ignored", "fetch is not from this cycle"); }
  const clockMs = Number.isFinite(msOf(r.server_at)) ? msOf(r.server_at) : fetchMs; // the answer's own Date header when present
  const updMs = msOf(r.updated_at);
  const stale = (why) => { g.last = { at: r.at, counted: false, reason: `stale snapshot: ${why}`, updated_at: r.updated_at ?? null }; return out("stale", `stale snapshot: ${why}`); };
  if (!Number.isFinite(updMs)) return stale("no updatedAt");
  if (updMs - clockMs > FLOW_SNAPSHOT_MAX_AHEAD_MS) return stale(`updatedAt ${Math.round((updMs - clockMs) / 1000)} s ahead of the answer's clock`);
  if (clockMs - updMs > FLOW_SNAPSHOT_MAX_AGE_MS) return stale(`updatedAt ${Math.round((clockMs - updMs) / 60_000)} min old at fetch`);
  const lastCountedMs = msOf(g.last_counted_updated_at);
  const refMs = msOf(g.ref?.updated_at);
  if ((Number.isFinite(lastCountedMs) && updMs <= lastCountedMs) || (Number.isFinite(refMs) && updMs <= refMs)) return stale("same snapshot as the last counted (or the arming) reading");
  if (Number.isFinite(lastCountedMs) && updMs - lastCountedMs < FLOW_GUARD_MIN_SPACING_MS) return out("merged", "snapshot < 60 s after the last counted one");

  // 3. A counted reading.
  const own = ownValueForReading(input.own, g.last_own_usd);
  if (own.rose) {
    g.liquidity_suspended_until = iso(nowMs + FLOW_LIQ_SUSPEND_MS);
    base.suspended_now = true;
  }
  const suspended = Number.isFinite(msOf(g.liquidity_suspended_until)) && nowMs < msOf(g.liquidity_suspended_until);
  if (suspended && g.streaks.liquidity_pull) { base.reset.push("liquidity_pull"); g.streaks.liquidity_pull = null; }
  const f = figuresOf(r, own.usd, input.pool_tvl_usd);
  base.figures = f;
  const { evaluable, qualified } = evaluateConditions(f, g.peak, params, { liquiditySuspended: suspended });
  base.evaluable = evaluable; base.qualified = qualified;
  // Peaks: raw figures always; adjusted ones not while suspended (the own value is in flux).
  const pk = advancePeaks(g.peak, g.hist, f, { skip: suspended ? ["liquidity_mkt_usd", "pool_tvl_mkt_usd"] : [] });
  g.peak = pk.peak; g.hist = pk.hist;
  g.counted = (Number(g.counted) || 0) + 1;
  if (own.usd != null) g.last_own_usd = own.usd;
  else if (own.changed) g.last_own_usd = own.new_usd;
  g.last_counted_at = r.at;
  g.last_counted_updated_at = r.updated_at;
  g.blind_since = null;
  g.last = {
    at: r.at, counted: true, updated_at: r.updated_at, conditions: qualified, own_note: own.reason ?? null, liquidity_suspended: suspended,
    liquidity_usd: r2(f.liquidity_usd), liquidity_mkt_usd: r2(f.liquidity_mkt_usd), holders: f.holders,
    pool_tvl_usd: r2(f.pool_tvl_usd), pool_tvl_mkt_usd: r2(f.pool_tvl_mkt_usd), sell_buy_5m: ratioOut(f.sell_buy_5m), sell_buy_1h: ratioOut(f.sell_buy_1h),
    price_change_1h_pct: r2(f.price_change_1h_pct), ring_change_pct: r2(ringChange),
  };

  // 4. One streak per condition.
  for (const c of FLOW_CONDITIONS) {
    if (!evaluable.includes(c)) continue; // not evaluable: neither counts nor resets
    const s = g.streaks[c];
    if (!qualified.includes(c)) {
      if (s) base.reset.push(c);
      g.streaks[c] = null;
      continue;
    }
    const lastMs = msOf(s?.last_at);
    if (!s || !Number.isFinite(lastMs) || fetchMs - lastMs > FLOW_GUARD_MAX_GAP_MS || fetchMs < lastMs) {
      g.streaks[c] = { count: 1, first_at: r.at, last_at: r.at, restarted: !!s };
      base.started.push(c);
    } else {
      g.streaks[c] = { ...s, count: s.count + 1, last_at: r.at, restarted: false };
      base.advanced.push(c);
    }
  }

  // 5. Ready conditions and their corroboration.
  for (const c of qualified) {
    const s = g.streaks[c];
    if (!(s && s.count >= params.confirm_readings && spanMin(s) >= params.confirm_minutes)) continue;
    base.ready.push(c);
    base.cross[c] = corroborate(c, f, g, params, ringChange);
  }
  const firing = base.ready.find((c) => base.cross[c]?.ok);
  if (firing) {
    const s = g.streaks[firing];
    g.confirmed_at = iso(nowMs);
    g.fire = {
      at: iso(nowMs), condition: firing, readings: s.count, span_min: r2(spanMin(s)), corroboration: base.cross[firing],
      figures: g.last, peaks: { ...g.peak },
    };
    if (!g.fired_at) g.fired_at = g.fire.at;
    base.fire = true;
    base.fired_condition = firing;
  }
  return out("counted", null, { counted: true });
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────

const usd = (v) => `$${Math.round(Number(v)).toLocaleString("en-US")}`;
const ratio = (v) => (v === Infinity || v === "inf" ? "sells only" : `${Number(v).toFixed(2)}×`);
const pct = (v) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(1)}%`;

/** One condition in words with its figures (no "oor", "below", "floor", "above" — legacy scans). */
export function conditionText(cond, f = {}, params = FLOW_GUARD_DEFAULT_PARAMS, peak = {}, corr = null) {
  switch (cond) {
    case "sell_pressure":
      return `sell/buy ${ratio(f.sell_buy_5m)} in 5m (≥ ${params.sell_buy_5m}) and ${ratio(f.sell_buy_1h)} in 1h (≥ ${params.sell_buy_1h}), price 1h ${pct(f.price_change_1h_pct)} (≤ −${params.price_drop_1h_pct}%)` +
        (corr?.ring_change_pct != null ? `, pool price ${pct(corr.ring_change_pct)} on chain over the last hour` : "");
    case "liquidity_pull":
      return `market liquidity ${usd(f.liquidity_mkt_usd)}, ≤ ${100 - params.liquidity_drop_pct}% of its peak ${usd(peak.liquidity_mkt_usd)} since arming (all-venue ${usd(f.liquidity_raw_usd)} of ${usd(peak.liquidity_raw_usd)})` +
        (corr?.by === "pool_tvl" ? ` (pool TVL ${usd(corr.pool_tvl_mkt_usd)} of ${usd(corr.pool_tvl_peak_usd)})` : corr?.by === "ring_price" ? ` (pool price ${pct(corr.ring_change_pct)} on chain)` : "");
    case "holder_exodus":
      return `holders ${Math.round(f.holders).toLocaleString("en-US")}, ≤ ${100 - params.holders_drop_pct}% of the peak ${Math.round(peak.holders).toLocaleString("en-US")} since arming` +
        (corr?.by === "ring_price" ? ` (pool price ${pct(corr.ring_change_pct)} on chain)` : "");
    default:
      return String(cond);
  }
}

export function conditionsText(conds, f, params, peak, cross = {}) {
  return (conds || []).map((c) => conditionText(c, f, params, peak, cross?.[c])).join("; ");
}

/** Canonical close reason; exitFamilyFromReason keys on the "Flow guard:" prefix. */
export function flowGuardReason({ condition, figures, params, peak, corroboration, readings, spanMin: span }) {
  return `Flow guard: ${conditionText(condition, figures, params, peak, corroboration)} on ${readings} readings over ${Math.round(span)}m — operator-armed stop`;
}

/** The exit object (same shape as the TVL exit's). Always carries the HOLD override name. */
export function buildFlowGuardExit(args) {
  return {
    action: "FLOW_GUARD",
    rule: "flow_guard",
    family: "flow_guard",
    urgent: true,
    confirm_ticks: 1,
    hold_override: FLOW_GUARD_HOLD_OVERRIDE,
    reason: flowGuardReason(args),
  };
}

// ── Display / record ────────────────────────────────────────────────────────────────────────

const streakCounts = (g) => Object.fromEntries(FLOW_CONDITIONS.map((c) => [c, g?.streaks?.[c]?.count ?? 0]));

/** Card / report summary of an armed guard, or null. Display only. */
export function flowGuardSummary(guard) {
  if (!guard || typeof guard !== "object" || !guard.armed_at) return null;
  const counts = streakCounts(guard);
  return {
    armed: true,
    armed_at: guard.armed_at,
    params: guard.params ?? null,
    streak_count: Math.max(0, ...Object.values(counts)),
    streaks: counts,
    last: guard.last ?? null,
    blind_since: guard.blind_since ?? null,
    liquidity_suspended_until: guard.liquidity_suspended_until ?? null,
    fired_at: guard.fired_at ?? null,
  };
}

export function flowGuardCardFields(tracked) {
  return { flow_guard: flowGuardSummary(tracked?.flow_guard) };
}

/** " · 🛡 flow guard armed" (+ " (counting 2/3)"), or "". Takes the live guard or its summary. */
export function flowGuardRowSuffix(pos) {
  const g = pos?.flow_guard;
  if (!g || !g.armed_at) return "";
  const n = g.streaks ? Math.max(0, ...Object.values(streakCounts(g))) : (g.streak_count ?? 0);
  const need = g.params?.confirm_readings ?? FLOW_GUARD_DEFAULT_PARAMS.confirm_readings;
  return ` · 🛡 flow guard armed${n > 0 ? ` (counting ${n}/${need})` : ""}`;
}

/** What the close path keeps of the guard for the perf record (no stamp, no ring). */
export function flowGuardCloseSummary(guard) {
  if (!guard || typeof guard !== "object" || !guard.armed_at) return null;
  return {
    armed_at: guard.armed_at,
    params: guard.params ?? null,
    ref: guard.ref ?? null,
    peak: guard.peak ?? null,
    counted: guard.counted ?? 0,
    fired_at: guard.fired_at ?? null,
    fire: guard.fire ?? null,
    streaks: streakCounts(guard),
    last: guard.last ?? null,
  };
}

/** Perf record `flow_guard`: the live guard (summarised) or the close summary, else null. */
export function flowGuardRecordField(tracked) {
  return flowGuardCloseSummary(tracked?.flow_guard) ?? (tracked?.flow_guard_at_close && typeof tracked.flow_guard_at_close === "object" ? tracked.flow_guard_at_close : null);
}

// ── Shadow (log only, default params, positions that are not armed) ─────────────────────────

/**
 * Advance the shadow with one cycle's inputs: a guard armed with the DEFAULT params and no
 * arming reading. On a would-fire the record is written (first fire kept, `count` / `last_at`
 * move) and that condition's streak starts over. `ctx.pnl_pct` = a TRUSTED gross pnl % at this
 * reading or null; `ctx.amount_sol` = the capital it is on.
 */
export function advanceFlowGuardShadow(prevState, prevRecord, input, ctx = {}, nowMs = Date.now()) {
  const st0 = prevState && prevState.armed_at ? prevState : newFlowGuard(FLOW_GUARD_DEFAULT_PARAMS, {}, nowMs);
  const res = advanceFlowGuard(st0, input, nowMs, { params: FLOW_GUARD_DEFAULT_PARAMS });
  const state = res.guard;
  let record = prevRecord && typeof prevRecord === "object" ? prevRecord : null;
  let first = false;
  if (res.fire) {
    const at = iso(nowMs);
    const c = res.fired_condition;
    if (!record || !record.first_would_fire_at) {
      first = true;
      record = {
        first_would_fire_at: at,
        condition: c,
        corroborated_by: res.cross[c]?.by ?? (c === "sell_pressure" ? "ring_price" : null),
        pnl_pct_at_fire: num(ctx.pnl_pct), // gross pnl % (the record's pnl_pct is gross too)
        amount_sol_at_fire: num(ctx.amount_sol),
        liquidity_usd: r2(res.figures.liquidity_usd), liquidity_mkt_usd: r2(res.figures.liquidity_mkt_usd),
        holders: res.figures.holders ?? null,
        sell_buy_5m: ratioOut(res.figures.sell_buy_5m), sell_buy_1h: ratioOut(res.figures.sell_buy_1h),
        price_change_1h_pct: r2(res.figures.price_change_1h_pct), ring_change_pct: res.ring_change_pct,
        readings: state.streaks?.[c]?.count ?? null,
        last_at: at,
        count: 1,
      };
    } else {
      record = { ...record, last_at: at, count: (Number(record.count) || 1) + 1 };
    }
    state.streaks[c] = null; // a new would-fire needs a new streak
    state.fire = null;
    state.confirmed_at = null;
  }
  return { state, record, event: res.event, would_fire: res.fire, first, res };
}
