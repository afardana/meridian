/**
 * Flow guard (2026-11-27, operator): an operator-armed, per-position stop that closes ONE
 * position when the token's market flow turns unfavourable — sell pressure with a falling
 * price, a liquidity pull, a holder exodus — instead of a price or TVL threshold. The operator
 * holds fresh, volatile tokens on purpose; the PnL valuation is unreliable around top-ups, so
 * nothing here reads the position's PnL.
 *
 * Leaf module (imports only rule-mode.js): parsing, defaults, the reading, the per-reading
 * evaluation, the streak and the cross-check. No I/O. The I/O lives in flow-guard-cycle.js
 * (orchestration with injected deps), tools/token-flow.js (Jupiter read) and state.js (the
 * guard on the position).
 *
 * Arming: POST /command/set-flow-guard (operator only; not an LLM tool, not an update_config
 * key). The thresholds are stored on the position at arming, so what is armed is explicit.
 *
 * Proof, in order (fail-closed at every step):
 *   1. a reading is USABLE only when the Jupiter datapi asset read of this cycle succeeded, the
 *      asset is the exact mint, the read is fresh, and at least one condition is evaluable
 *      (every figure it needs is a finite number; volume windows above the dust floors);
 *   2. it QUALIFIES when at least one evaluable condition holds; a usable non-qualifying reading
 *      resets the streak; an unusable one neither counts nor resets; > 15 min between usable
 *      readings restarts it; readings < 60 s apart are one reading;
 *   3. ready after `confirm_readings` consecutive qualifying readings spanning ≥ `confirm_minutes`;
 *   4. a second source must confirm one of the conditions that qualified the firing reading
 *      (`crossCheckFlowGuard`): the pool's active bin for sell pressure, Meteora's holder count
 *      for the holder exodus; the liquidity pull has no all-venue second source and relies on the
 *      streak (the Meteora pool TVL can only refute it); the GMGN exodus is itself a second source.
 *      Unavailable → no fire this cycle.
 * Peaks (liquidity, holders, Meteora holders, active bin) are CONFIRMED peaks: a new peak needs
 * two consecutive readings above the old one and takes the lower of the two, so one spiked
 * reading can never define the reference a later drop is measured from.
 */

import { modeFor } from "./rule-mode.js";

export const FLOW_GUARD_HOLD_OVERRIDE = "flow_guard";

/** Param name → { def, min, max, int?, bool? } (inclusive ranges). */
export const FLOW_GUARD_PARAM_SPECS = Object.freeze({
  sell_buy_5m: Object.freeze({ def: 2.0, min: 1.2, max: 10 }),
  sell_buy_1h: Object.freeze({ def: 1.3, min: 1.0, max: 10 }),
  price_drop_1h_pct: Object.freeze({ def: 15, min: 5, max: 90 }),
  liquidity_drop_pct: Object.freeze({ def: 50, min: 20, max: 95 }),
  holders_drop_pct: Object.freeze({ def: 5, min: 2, max: 50 }),
  confirm_readings: Object.freeze({ def: 3, min: 2, max: 10, int: true }),
  confirm_minutes: Object.freeze({ def: 6, min: 3, max: 60 }),
  use_gmgn: Object.freeze({ def: false, bool: true }),
});
export const FLOW_GUARD_DEFAULT_PARAMS = Object.freeze(
  Object.fromEntries(Object.entries(FLOW_GUARD_PARAM_SPECS).map(([k, s]) => [k, s.def])),
);

/** Both sides of the 5-minute window together below this (USD) → the ratio is not computed. */
export const FLOW_VOL_FLOOR_5M_USD = 200;
/** Both sides of the 1-hour window together below this (USD) → the ratio is not computed. */
export const FLOW_VOL_FLOOR_1H_USD = 1_000;
/** More than this between two usable readings starts the streak over. */
export const FLOW_GUARD_MAX_GAP_MS = 15 * 60_000;
/** Two readings closer than this are one reading (a cycle run twice, a cached read). */
export const FLOW_GUARD_MIN_SPACING_MS = 60_000;
/** A reading older than this is not fresh (the cycle's own read is seconds old). */
export const FLOW_READ_MAX_AGE_MS = 4 * 60_000;
/** A GMGN smart-money result older than this is not used. */
export const FLOW_GMGN_MAX_AGE_MS = 15 * 60_000;
/** The "counting" Telegram alert at most this often per position. */
export const FLOW_START_ALERT_INTERVAL_MS = 30 * 60_000;
/** Shadow: at most this many distinct base mints are read per cycle (armed mints always). */
export const FLOW_SHADOW_MAX_MINTS = 8;

export const FLOW_CONDITIONS = Object.freeze(["sell_pressure", "liquidity_pull", "holder_exodus", "smart_money_exodus"]);
const COND_WORDS = Object.freeze({
  sell_pressure: "sell pressure with a falling price",
  liquidity_pull: "liquidity pull",
  holder_exodus: "holder exodus",
  smart_money_exodus: "smart-money exodus",
});

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonNeg = (v) => { const n = num(v); return n != null && n >= 0 ? n : null; };
const iso = (ms) => new Date(ms).toISOString();
const msOf = (v) => (typeof v === "string" || typeof v === "number" ? new Date(v).getTime() : NaN);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

/** Shadow mode: off | shadow (no enforce exists — arming IS the live path). */
export function flowGuardShadowMode(mgmt = {}) {
  return modeFor("flowGuardShadowMode", mgmt?.flowGuardShadowMode);
}

/**
 * Validate params. undefined / null → the defaults. Otherwise a plain object whose keys are a
 * subset of FLOW_GUARD_PARAM_SPECS; missing keys take the default. Strict types: numbers must
 * be finite numbers (no strings), in range; confirm_readings an integer; use_gmgn a boolean.
 * Returns { ok:true, params } (every key present) or { ok:false, error }.
 */
export function parseFlowGuardParams(raw) {
  if (raw === undefined || raw === null) return { ok: true, params: { ...FLOW_GUARD_DEFAULT_PARAMS } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "`params` must be an object" };
  const out = { ...FLOW_GUARD_DEFAULT_PARAMS };
  for (const [k, v] of Object.entries(raw)) {
    const s = FLOW_GUARD_PARAM_SPECS[k];
    if (!s) return { ok: false, error: `unknown param \`${k}\`` };
    if (v === undefined) continue;
    if (s.bool) {
      if (typeof v !== "boolean") return { ok: false, error: `\`${k}\` must be true or false` };
      out[k] = v;
      continue;
    }
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

/** "sell/buy 5m ≥ 2, 1h ≥ 1.3, price 1h ≤ −15%; liquidity −50% …" — params in words for logs. */
export function flowGuardParamsText(p) {
  if (!p) return "no valid params";
  return `sell/buy 5m ≥ ${p.sell_buy_5m}× and 1h ≥ ${p.sell_buy_1h}× with price 1h down ≥ ${p.price_drop_1h_pct}%; ` +
    `liquidity down ≥ ${p.liquidity_drop_pct}% from its peak; holders down ≥ ${p.holders_drop_pct}% from their peak` +
    `${p.use_gmgn ? "; GMGN smart-money exodus" : ""}; ${p.confirm_readings} readings over ≥ ${p.confirm_minutes} min`;
}

// ── The reading ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a Jupiter datapi `/v1/assets/search?query=<mint>` payload into a reading. Only the asset
 * whose `id` is EXACTLY the mint is used. Figures are kept only when they are finite numbers
 * (no coercion of strings / null). Returns { ok:true, mint, at, … } or { ok:false, reason, at }.
 */
export function readFlowAsset(payload, mint, fetchedAtMs = Date.now()) {
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

export function isGmgnExodus(g) {
  const ex = num(g?.smart_exiting), acc = num(g?.smart_accumulating);
  if (ex == null || acc == null) return false;
  return ex > 2 || (acc === 0 && ex >= 1); // the criterion the existing exodus alert uses
}

/**
 * Evaluate one reading against the guard's stored peaks. Pure.
 * @returns {{ usable, reason, evaluable: string[], qualified: string[], figures }}
 */
export function evaluateFlowReading(reading, guard, params, { nowMs = Date.now(), gmgn = null } = {}) {
  const out = { usable: false, reason: null, evaluable: [], qualified: [], figures: {} };
  if (!reading || reading.ok !== true) { out.reason = reading?.reason || "no reading"; return out; }
  if (!params) { out.reason = "no valid params"; return out; }
  const atMs = msOf(reading.at);
  if (!Number.isFinite(atMs) || nowMs - atMs > FLOW_READ_MAX_AGE_MS || atMs - nowMs > 60_000) { out.reason = "reading is not fresh"; return out; }
  const f = out.figures;
  // 1. Sell pressure with a falling price.
  const r5 = sellBuyRatio(reading.s5m, FLOW_VOL_FLOOR_5M_USD);
  const r1 = sellBuyRatio(reading.s1h, FLOW_VOL_FLOOR_1H_USD);
  const pc1 = num(reading.s1h?.price_change);
  f.sell_buy_5m = r5; f.sell_buy_1h = r1; f.price_change_1h_pct = pc1;
  if (r5 != null && r1 != null && pc1 != null) {
    out.evaluable.push("sell_pressure");
    if (r5 >= params.sell_buy_5m && r1 >= params.sell_buy_1h && pc1 <= -params.price_drop_1h_pct) out.qualified.push("sell_pressure");
  }
  // 2. Liquidity pull, against the confirmed peak since arming.
  const liq = nonNeg(reading.liquidity_usd);
  const liqPeak = num(guard?.peak?.liquidity_usd);
  f.liquidity_usd = liq; f.liquidity_peak_usd = liqPeak;
  if (liq != null && liqPeak != null && liqPeak > 0) {
    out.evaluable.push("liquidity_pull");
    if (liq <= ((100 - params.liquidity_drop_pct) / 100) * liqPeak) out.qualified.push("liquidity_pull");
  }
  // 3. Holder exodus, against the confirmed peak since arming.
  const h = nonNeg(reading.holders);
  const hPeak = num(guard?.peak?.holders);
  f.holders = h; f.holders_peak = hPeak;
  if (h != null && hPeak != null && hPeak > 0) {
    out.evaluable.push("holder_exodus");
    if (h <= ((100 - params.holders_drop_pct) / 100) * hPeak) out.qualified.push("holder_exodus");
  }
  // 4. GMGN smart-money exodus (use_gmgn only): a cached result of the existing exodus check,
  //    fresh, and newer than the previous usable reading (one observation counts once).
  if (params.use_gmgn && gmgn) {
    const gAt = msOf(gmgn.at);
    const lastAt = msOf(guard?.last_read_at);
    if (Number.isFinite(gAt) && nowMs - gAt <= FLOW_GMGN_MAX_AGE_MS && gAt <= nowMs + 60_000 && !(Number.isFinite(lastAt) && gAt <= lastAt)) {
      out.evaluable.push("smart_money_exodus");
      f.smart_exiting = num(gmgn.smart_exiting); f.smart_accumulating = num(gmgn.smart_accumulating);
      if (isGmgnExodus(gmgn)) out.qualified.push("smart_money_exodus");
    }
  }
  out.usable = out.evaluable.length > 0;
  if (!out.usable) out.reason = "no condition could be evaluated (figures missing or volume under the dust floors)";
  return out;
}

// ── Confirmed peaks ─────────────────────────────────────────────────────────────────────────

/** New peak = max(old, min(previous value, current value)): two readings above, the lower one. */
function confirmPeakValue(peak, prev, cur) {
  if (cur == null) return peak;
  if (prev == null) return peak;
  const cand = Math.min(prev, cur);
  return peak == null ? cand : Math.max(peak, cand);
}

/** Advance peak + prev for one figure. */
function advancePeakPair(peak, prev, key, value) {
  if (value == null) return;
  peak[key] = confirmPeakValue(peak[key] ?? null, prev[key] ?? null, value);
  prev[key] = value;
}

// ── The guard ───────────────────────────────────────────────────────────────────────────────

/** A freshly armed guard. `ref` = the reading at arming ({ liquidity_usd, holders, meteora_holders, active_bin, price_sol, price_usd, at }). */
export function newFlowGuard(params, ref = {}, nowMs = Date.now()) {
  const r = {
    liquidity_usd: nonNeg(ref?.liquidity_usd),
    holders: nonNeg(ref?.holders),
    meteora_holders: nonNeg(ref?.meteora_holders),
    active_bin: num(ref?.active_bin),
    price_sol: nonNeg(ref?.price_sol),
    price_usd: nonNeg(ref?.price_usd),
    at: ref?.at ?? null,
  };
  return {
    armed_at: iso(nowMs),
    params: { ...params },
    ref: r,
    peak: { liquidity_usd: null, holders: null, meteora_holders: null, active_bin: null },
    // The arming reading pairs with the first cycle reading for the first confirmed peak.
    prev: { liquidity_usd: r.liquidity_usd, holders: r.holders, meteora_holders: r.meteora_holders, active_bin: r.active_bin },
    streak: null,
    last: null,
    last_read_at: null,
    start_alerted_at: null,
    fired_at: null,
    fire: null,
  };
}

/** Pool price change in % between two active bins of the same pool ((1+bs/1e4)^Δ − 1). */
export function binPriceChangePct(fromBin, toBin, binStep) {
  const a = num(fromBin), b = num(toBin), bs = num(binStep);
  if (a == null || b == null || bs == null || !(bs > 0)) return null;
  const v = (Math.pow(1 + bs / 1e4, b - a) - 1) * 100;
  return Number.isFinite(v) ? v : null;
}

/**
 * Second-source check for the firing reading. Pure.
 * @param {string[]} qualified   conditions that qualified the firing reading
 * @param {object} guard         the guard BEFORE this reading's peak update (references)
 * @param {object} input         { chain: { ok, active_bin, bin_step }, meteora_holders, pool_tvl_usd, reading }
 * @returns {{ confirmed: string[], details: object, fire: boolean }}
 */
export function crossCheckFlowGuard(qualified, guard, params, input = {}) {
  const details = {};
  const confirmed = [];
  for (const c of qualified) {
    if (c === "sell_pressure") {
      const ch = input.chain;
      const refBin = Math.max(num(guard?.ref?.active_bin) ?? -Infinity, num(guard?.peak?.active_bin) ?? -Infinity);
      if (!ch || ch.ok !== true || num(ch.active_bin) == null || !Number.isFinite(refBin)) {
        details.sell_pressure = { verdict: "unavailable", reason: ch?.reason || (Number.isFinite(refBin) ? "no active-bin reading this cycle" : "no reference bin since arming") };
        continue;
      }
      const chg = binPriceChangePct(refBin, ch.active_bin, ch.bin_step);
      if (chg == null) { details.sell_pressure = { verdict: "unavailable", reason: "bin step unknown" }; continue; }
      const need = params.price_drop_1h_pct / 2;
      const ok = chg <= -need;
      details.sell_pressure = { verdict: ok ? "confirmed" : "disagree", pool_change_pct: r2(chg), need_pct: -need, ref_bin: refBin, active_bin: ch.active_bin };
      if (ok) confirmed.push(c);
    } else if (c === "holder_exodus") {
      const mh = nonNeg(input.meteora_holders);
      const mPeak = num(guard?.peak?.meteora_holders);
      if (mh == null || mPeak == null || !(mPeak > 0)) {
        details.holder_exodus = { verdict: "unavailable", reason: mh == null ? "no Meteora holder count this cycle" : "no confirmed Meteora holder peak yet" };
        continue;
      }
      const ok = mh <= ((100 - params.holders_drop_pct) / 100) * mPeak;
      details.holder_exodus = { verdict: ok ? "confirmed" : "disagree", meteora_holders: mh, meteora_peak: mPeak };
      if (ok) confirmed.push(c);
    } else if (c === "liquidity_pull") {
      // No second source for all-venue liquidity. The Meteora TVL of this one pool can only
      // REFUTE it: all-venue liquidity cannot be below one of its pools.
      const liq = nonNeg(input.reading?.liquidity_usd);
      const tvl = nonNeg(input.pool_tvl_usd);
      if (liq != null && tvl != null && tvl > liq) {
        details.liquidity_pull = { verdict: "disagree", reason: `Jupiter liquidity $${Math.round(liq)} is under this pool's own TVL $${Math.round(tvl)}`, pool_tvl_usd: tvl };
        continue;
      }
      details.liquidity_pull = { verdict: "confirmed", reason: "no second source (streak only)", pool_tvl_usd: tvl };
      confirmed.push(c);
    } else if (c === "smart_money_exodus") {
      details.smart_money_exodus = { verdict: "confirmed", reason: "GMGN is itself the second source" };
      confirmed.push(c);
    }
  }
  return { confirmed, details, fire: confirmed.length > 0 };
}

/**
 * Advance the guard with one cycle's inputs. Pure: returns a NEW guard object.
 * input = { reading, gmgn, meteora_holders, chain, pool_tvl_usd }
 * events: off (no params) | ignored | merged | calm | reset | started | restarted | counted
 * @returns {{ guard, event, usable, qualified, evaluable, figures, ready, cross, fire, reason, span_min }}
 */
export function advanceFlowGuard(prevGuard, input = {}, nowMs = Date.now(), { params: paramsOverride = null } = {}) {
  const g = JSON.parse(JSON.stringify(prevGuard || {}));
  g.peak ||= { liquidity_usd: null, holders: null, meteora_holders: null, active_bin: null };
  g.prev ||= { liquidity_usd: null, holders: null, meteora_holders: null, active_bin: null };
  // The HOLD-override stamp is written only on the firing reading; any other reading drops it.
  if (g.streak && g.streak.confirmed_at) g.streak.confirmed_at = null;
  const params = paramsOverride || storedFlowGuardParams(g);
  const base = { guard: g, usable: false, qualified: [], evaluable: [], figures: {}, ready: false, cross: null, fire: false, span_min: 0 };
  if (!params) return { ...base, event: "off", reason: "stored params are not valid" };

  // The pool's own figures (active bin, Meteora holders) move their peaks on every cycle
  // they are known, independent of the Jupiter reading; evaluated against the OLD peaks.
  const refGuard = JSON.parse(JSON.stringify(g));
  const chainBin = input.chain?.ok === true ? num(input.chain.active_bin) : null;
  const mh = nonNeg(input.meteora_holders);

  const ev = evaluateFlowReading(input.reading, g, params, { nowMs, gmgn: input.gmgn });
  const lastReadMs = msOf(g.last_read_at);
  const readMs = msOf(input.reading?.at);
  const isMerged = ev.usable && Number.isFinite(lastReadMs) && Number.isFinite(readMs) && readMs - lastReadMs < FLOW_GUARD_MIN_SPACING_MS;

  // Move the pool peaks unless this is a repeat of the same reading.
  if (!isMerged) {
    advancePeakPair(g.peak, g.prev, "active_bin", chainBin);
    advancePeakPair(g.peak, g.prev, "meteora_holders", mh);
  }

  const lastSummary = {
    at: input.reading?.at ?? iso(nowMs),
    usable: ev.usable,
    reason: ev.reason,
    conditions: ev.qualified,
    liquidity_usd: r2(ev.figures.liquidity_usd ?? input.reading?.liquidity_usd ?? null),
    holders: ev.figures.holders ?? input.reading?.holders ?? null,
    sell_buy_5m: ev.figures.sell_buy_5m === Infinity ? "inf" : r4(ev.figures.sell_buy_5m ?? null),
    sell_buy_1h: ev.figures.sell_buy_1h === Infinity ? "inf" : r4(ev.figures.sell_buy_1h ?? null),
    price_change_1h_pct: r2(ev.figures.price_change_1h_pct ?? null),
  };

  if (!ev.usable) {
    g.last = lastSummary;
    return { ...base, guard: g, event: "ignored", reason: ev.reason, figures: ev.figures, span_min: spanMin(g.streak) };
  }
  if (isMerged) {
    return { ...base, guard: g, event: "merged", usable: true, evaluable: ev.evaluable, qualified: ev.qualified, figures: ev.figures, span_min: spanMin(g.streak) };
  }

  // A usable, new reading: move the Jupiter peaks (after evaluating against the old ones).
  advancePeakPair(g.peak, g.prev, "liquidity_usd", nonNeg(input.reading.liquidity_usd));
  advancePeakPair(g.peak, g.prev, "holders", nonNeg(input.reading.holders));
  g.last = lastSummary;
  g.last_read_at = input.reading.at;
  const readIso = input.reading.at;

  if (!ev.qualified.length) {
    const had = !!g.streak;
    g.streak = null;
    return { ...base, guard: g, event: had ? "reset" : "calm", usable: true, evaluable: ev.evaluable, figures: ev.figures };
  }

  let event;
  const cur = g.streak;
  const curLast = msOf(cur?.last_at);
  if (!cur || !Number.isFinite(curLast) || readMs - curLast > FLOW_GUARD_MAX_GAP_MS || readMs < curLast) {
    event = cur ? "restarted" : "started";
    g.streak = { count: 1, first_at: readIso, last_at: readIso, readings: [{ at: readIso, conditions: ev.qualified }], confirmed_at: null };
  } else {
    event = "counted";
    const readings = [...(cur.readings || []), { at: readIso, conditions: ev.qualified }].slice(-10);
    g.streak = { ...cur, count: cur.count + 1, last_at: readIso, readings, confirmed_at: null };
  }
  const span = spanMin(g.streak);
  const ready = g.streak.count >= params.confirm_readings && span >= params.confirm_minutes;
  if (!ready) return { ...base, guard: g, event, usable: true, evaluable: ev.evaluable, qualified: ev.qualified, figures: ev.figures, span_min: span };

  const cross = crossCheckFlowGuard(ev.qualified, refGuard, params, { chain: input.chain, meteora_holders: mh, pool_tvl_usd: input.pool_tvl_usd, reading: input.reading });
  if (cross.fire) {
    g.streak.confirmed_at = iso(nowMs);
    const fire = {
      at: iso(nowMs),
      conditions: ev.qualified,
      confirmed_by: cross.confirmed,
      readings: g.streak.count,
      span_min: r2(span),
      figures: lastSummary,
      cross: cross.details,
      references: { liquidity_peak_usd: refGuard.peak.liquidity_usd, holders_peak: refGuard.peak.holders, meteora_holders_peak: refGuard.peak.meteora_holders, bin_high: refGuard.peak.active_bin, ref_bin: refGuard.ref?.active_bin ?? null },
    };
    g.fire = fire;
    if (!g.fired_at) g.fired_at = fire.at;
  }
  return { ...base, guard: g, event, usable: true, evaluable: ev.evaluable, qualified: ev.qualified, figures: ev.figures, ready: true, cross, fire: cross.fire, span_min: span };
}

function spanMin(s) {
  if (!s) return 0;
  const a = msOf(s.first_at), b = msOf(s.last_at);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 60_000) : 0;
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────

const usd = (v) => `$${Math.round(Number(v)).toLocaleString("en-US")}`;
const ratio = (v) => (v === Infinity || v === "inf" ? "sells only" : `${Number(v).toFixed(2)}×`);
const pct = (v) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(1)}%`;

/** One condition in words with its figures (no "oor", "below", "floor", "above" — legacy scans). */
export function conditionText(cond, figures = {}, params = FLOW_GUARD_DEFAULT_PARAMS, cross = null) {
  const f = figures || {};
  switch (cond) {
    case "sell_pressure": {
      const pc = cross?.sell_pressure?.pool_change_pct;
      return `sell/buy ${ratio(f.sell_buy_5m)} in 5m (≥ ${params.sell_buy_5m}) and ${ratio(f.sell_buy_1h)} in 1h (≥ ${params.sell_buy_1h}), price 1h ${pct(f.price_change_1h_pct)} (≤ −${params.price_drop_1h_pct}%)` +
        (pc != null ? `, pool price ${pct(pc)} from its high` : "");
    }
    case "liquidity_pull":
      return `liquidity ${usd(f.liquidity_usd)}, ≤ ${100 - params.liquidity_drop_pct}% of its peak ${usd(f.liquidity_peak_usd)} since arming`;
    case "holder_exodus": {
      const m = cross?.holder_exodus;
      return `holders ${Math.round(f.holders).toLocaleString("en-US")}, ≤ ${100 - params.holders_drop_pct}% of the peak ${Math.round(f.holders_peak).toLocaleString("en-US")} since arming` +
        (m?.meteora_holders != null ? ` (Meteora ${Math.round(m.meteora_holders).toLocaleString("en-US")} of ${Math.round(m.meteora_peak).toLocaleString("en-US")})` : "");
    }
    case "smart_money_exodus":
      return `smart-money exodus (GMGN: ${f.smart_exiting ?? "?"} exiting, ${f.smart_accumulating ?? "?"} accumulating)`;
    default:
      return COND_WORDS[cond] || String(cond);
  }
}

export function conditionsText(conds, figures, params, cross) {
  return (conds || []).map((c) => conditionText(c, figures, params, cross)).join("; ");
}

/** Canonical close reason; exitFamilyFromReason keys on the "Flow guard:" prefix. */
export function flowGuardReason({ conditions, figures, params, cross, readings, spanMin: span }) {
  return `Flow guard: ${conditionsText(conditions, figures, params, cross)} on ${readings} readings over ${Math.round(span)}m — operator-armed stop`;
}

/** The exit object (same shape as the TVL exit's). Always carries the HOLD override name. */
export function buildFlowGuardExit({ conditions, figures, params, cross, readings, spanMin: span }) {
  return {
    action: "FLOW_GUARD",
    rule: "flow_guard",
    family: "flow_guard",
    urgent: true, // the operator asked for an exit on unfavourable flow: no exit-swap guard, no slippage cap
    confirm_ticks: 1,
    hold_override: FLOW_GUARD_HOLD_OVERRIDE,
    reason: flowGuardReason({ conditions, figures, params, cross, readings, spanMin: span }),
  };
}

// ── Display / record ────────────────────────────────────────────────────────────────────────

/** Card / report summary of an armed guard, or null. Display only. */
export function flowGuardSummary(guard) {
  if (!guard || typeof guard !== "object" || !guard.armed_at) return null;
  return {
    armed: true,
    armed_at: guard.armed_at,
    params: guard.params ?? null,
    streak_count: guard.streak?.count ?? 0,
    streak_conditions: guard.streak?.readings?.length ? guard.streak.readings[guard.streak.readings.length - 1].conditions : [],
    last: guard.last ? {
      at: guard.last.at ?? null, usable: guard.last.usable ?? null,
      liquidity_usd: guard.last.liquidity_usd ?? null, holders: guard.last.holders ?? null,
      sell_buy_5m: guard.last.sell_buy_5m ?? null, sell_buy_1h: guard.last.sell_buy_1h ?? null,
      price_change_1h_pct: guard.last.price_change_1h_pct ?? null,
    } : null,
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
  const n = g.streak?.count ?? g.streak_count ?? 0;
  const need = g.params?.confirm_readings ?? FLOW_GUARD_DEFAULT_PARAMS.confirm_readings;
  return ` · 🛡 flow guard armed${n > 0 ? ` (counting ${n}/${need})` : ""}`;
}

/** What the close path keeps of the guard for the perf record (no stamp, no working fields). */
export function flowGuardCloseSummary(guard) {
  if (!guard || typeof guard !== "object" || !guard.armed_at) return null;
  return {
    armed_at: guard.armed_at,
    params: guard.params ?? null,
    ref: guard.ref ?? null,
    peak: guard.peak ?? null,
    fired_at: guard.fired_at ?? null,
    fire: guard.fire ?? null,
    streak_count: guard.streak?.count ?? 0,
    last: guard.last ?? null,
  };
}

/** Perf record `flow_guard`: the live guard (summarised) or the close summary, else null. */
export function flowGuardRecordField(tracked) {
  return flowGuardCloseSummary(tracked?.flow_guard) ?? (tracked?.flow_guard_at_close && typeof tracked.flow_guard_at_close === "object" ? tracked.flow_guard_at_close : null);
}

// ── Shadow (log only, default params, positions that are not armed) ─────────────────────────

/**
 * Advance the shadow with one cycle's inputs. The working state is a guard armed with the
 * DEFAULT params and no reference reading. On a would-fire the record is written (first fire
 * kept, `count` and `last_at` move) and the streak starts over, so `count` counts distinct
 * would-fires. Pure. `ctx.pnl_pct` = a TRUSTED pnl at this reading, or null.
 * @returns {{ state, record, event, would_fire, first, res }}
 */
export function advanceFlowGuardShadow(prevState, prevRecord, input, ctx = {}, nowMs = Date.now()) {
  const st0 = prevState && prevState.armed_at ? prevState : newFlowGuard(FLOW_GUARD_DEFAULT_PARAMS, {}, nowMs);
  const res = advanceFlowGuard(st0, input, nowMs, { params: FLOW_GUARD_DEFAULT_PARAMS });
  const state = res.guard;
  let record = prevRecord && typeof prevRecord === "object" ? prevRecord : null;
  let first = false;
  if (res.fire) {
    const at = iso(nowMs);
    if (!record || !record.first_would_fire_at) {
      first = true;
      record = {
        first_would_fire_at: at,
        condition: res.qualified.join("+"),
        confirmed_by: res.cross?.confirmed ?? [],
        pnl_pct_at_fire: num(ctx.pnl_pct),
        amount_sol_at_fire: num(ctx.amount_sol),
        liquidity_usd: r2(res.figures.liquidity_usd ?? null),
        holders: res.figures.holders ?? null,
        sell_buy_5m: res.figures.sell_buy_5m === Infinity ? "inf" : r4(res.figures.sell_buy_5m ?? null),
        sell_buy_1h: res.figures.sell_buy_1h === Infinity ? "inf" : r4(res.figures.sell_buy_1h ?? null),
        price_change_1h_pct: r2(res.figures.price_change_1h_pct ?? null),
        readings: state.streak?.count ?? null,
        last_at: at,
        count: 1,
      };
    } else {
      record = { ...record, last_at: at, count: (Number(record.count) || 1) + 1 };
    }
    state.streak = null; // a new would-fire needs a new streak
    state.fire = null;
  }
  return { state, record, event: res.event, would_fire: res.fire, first, res };
}
