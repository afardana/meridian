/**
 * Distress gate on the TVL exit (2026-11-28, operator: "make the thin TVL exit depend on other
 * factors too … They were not real collapses").
 *
 * The TVL exit (tvl-floor-exit.js) closed five operator positions on 2026-11-28 in pools that
 * merely hover around $10K (WLFI ×3, Snowball ×2; +1.8 %, +11.1 %, +9.0 %, −0.5 %, −0.3 % at the
 * close). Dying pools trade heavily into the dump; those pools were quiet with the price near
 * entry. So the TVL proof (pool TVL under the minimum on N readings over M minutes, confirmed by
 * the on-chain reserves) may close only when the pool ALSO shows distress on N readings over M
 * minutes of its own. EXPLORATORY: the thresholds were chosen on the same cases they were
 * checked on (10 false closes, PVE, WINSTON, 7 historical collapses) — the operator's
 * instruction, not a validated result.
 *
 * Per reading (one per management cycle, only a usable below-minimum reading of the TVL streak):
 *   LOSS  — PnL on capital ≤ lossPct (−10): the thin-pool hold limit's figure (the higher of the
 *           plain percent and the cost-basis figure when a basis applies). No usable PnL on this
 *           reading → the price since entry ≤ priceDropPct (−30) decides; price unknown too → unknown.
 *   DUMP  — hourly turnover (the row's windowed volume ÷ its tvl, scaled to one hour) ≥
 *           dumpTurnover (2) AND price since entry ≤ dumpPricePct (−5). Missing volume or price
 *           → unknown. The price is unknown on a pool positively known not to be SOL-quoted.
 *   verdict: distress (any leg true) | calm (both legs evaluated, both false) | unknown.
 * Streak (on the TVL streak object, cleared with it): distress +1 (readings < 60 s apart merge),
 * calm → 0, unknown → unchanged; a corrupt stored streak counts as none. Gate satisfied when the
 * streak has ≥ minReadings readings over ≥ minMinutes (the TVL proof's own two keys) and the
 * current reading is itself distress.
 *
 * Leaf module (imports only rule-mode.js): pure functions, no I/O. The invalid-value warning
 * goes through a registered `warn` callback (config.js registers the logger).
 */

import { modeFor } from "./rule-mode.js";

export const TVL_DISTRESS_MODES = Object.freeze(["off", "shadow", "enforce"]);
export const TVL_DISTRESS_DEFAULTS = Object.freeze({
  lossPct: -10,
  priceDropPct: -30,
  dumpTurnover: 2,
  dumpPricePct: -5,
});
/** Two distress readings closer than this are one (same rule as the TVL streak). */
export const TVL_DISTRESS_MIN_SPACING_MS = 60_000;
/** A gap longer than this between two counted distress readings starts the distress streak over. */
export const TVL_DISTRESS_MAX_GAP_MS = 30 * 60_000;

// key → [config field, validator, description for the warning, reader (literal property names:
// scripts/lint_config_keys.js finds the user-config keys config.js reads through them)].
// The floors keep every setting on the side of a real loss / a real dump (review 2026-11-28).
const NUM_KEYS = Object.freeze({
  tvlFloorExitLossPct:      ["lossPct",      (v) => v >= -95 && v <= -1,    "−95 … −1",   (m) => m?.tvlFloorExitLossPct],
  tvlFloorExitPriceDropPct: ["priceDropPct", (v) => v >= -99 && v <= -5,    "−99 … −5",   (m) => m?.tvlFloorExitPriceDropPct],
  tvlFloorExitDumpTurnover: ["dumpTurnover", (v) => v >= 0.25 && v <= 100,  "0.25 … 100", (m) => m?.tvlFloorExitDumpTurnover],
  tvlFloorExitDumpPricePct: ["dumpPricePct", (v) => v >= -99 && v <= -1,    "−99 … −1",   (m) => m?.tvlFloorExitDumpPricePct],
});
export const TVL_DISTRESS_NUMERIC_KEYS = Object.freeze(Object.keys(NUM_KEYS));

const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A finite number, or a non-blank numeric string; anything else → null. */
function strictNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") { const n = Number(raw); return Number.isFinite(n) ? n : null; }
  return null;
}

/** Is `raw` a valid stored value for `key`? (update_config validation uses this.) */
export function isValidTvlDistressValue(key, raw) {
  if (key === "tvlFloorExitDistressMode") return TVL_DISTRESS_MODES.includes(raw);
  const k = NUM_KEYS[key];
  if (!k) return false;
  const n = strictNumber(raw);
  return n != null && k[1](n);
}

const _warned = new Set();
let _defaultWarn = null;
/** The warning sink used when a call passes none (config.js registers the logger once). */
export function setTvlDistressWarn(fn) { _defaultWarn = typeof fn === "function" ? fn : null; }
/**
 * The gate's settings from config.management (or a raw user-config object — config.js load and
 * hot reload both go through here, so a restart and a reload give the same value for the same
 * file). Mode: absent → enforce; any value outside off|shadow|enforce → enforce (rule-mode.js
 * spec). Numbers: absent → default; present and in range → that value; present but invalid or
 * out of range → the default, with one `warn(message)` per process per key and value.
 */
export function tvlFloorDistressConfig(mgmt = {}, { warn = _defaultWarn } = {}) {
  const out = { mode: modeFor("tvlFloorExitDistressMode", mgmt?.tvlFloorExitDistressMode), ...TVL_DISTRESS_DEFAULTS };
  for (const [key, [field, ok, desc, read]] of Object.entries(NUM_KEYS)) {
    const raw = read(mgmt);
    if (raw === undefined) continue;
    const n = strictNumber(raw);
    if (n != null && ok(n)) { out[field] = n; continue; }
    if (typeof warn === "function") {
      let shown;
      try { shown = JSON.stringify(raw); } catch { shown = String(raw); }
      if (shown === undefined) shown = String(raw);
      const id = `${key}=${shown}`;
      if (!_warned.has(id)) {
        _warned.add(id);
        try { warn(`[TVL_FLOOR_EXIT] ${key} ${shown} is invalid (${desc} expected) — using the default ${TVL_DISTRESS_DEFAULTS[field]}`); } catch { /* never breaks the reader */ }
      }
    }
  }
  return out;
}

/** The row's windowed volume, only when the row is this pool and the field is a finite number ≥ 0. */
export function readPoolVolumeUsd(detail, poolAddress) {
  if (!detail || typeof detail !== "object") return null;
  if (poolAddress && detail.pool_address !== poolAddress) return null;
  const v = detail.volume;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** % price change from `entryBin` to `activeBin` at `binStep` (bps). null when anything is missing. */
export function priceChangeSinceEntryPct(activeBin, entryBin, binStep) {
  const a = fin(activeBin), e = fin(entryBin), bs = fin(binStep);
  if (a == null || e == null || bs == null || !(bs > 0)) return null;
  const v = (Math.pow(1 + bs / 1e4, a - e) - 1) * 100;
  return Number.isFinite(v) ? v : null;
}

/** Hourly turnover: volume ÷ tvl, scaled from the row's window to one hour. null when not computable. */
export function hourlyTurnover(volumeUsd, tvlUsd, timeframeMinutes) {
  const v = fin(volumeUsd), t = fin(tvlUsd), m = fin(timeframeMinutes);
  if (v == null || t == null || m == null || v < 0 || !(t > 0) || !(m > 0)) return null;
  const x = (v / t) * (60 / m);
  return Number.isFinite(x) ? x : null;
}

/**
 * The PnL the loss leg may use, from `thinLimitReading` = holdThinLimitReading(row, tracked, mgmt)
 * (management-ready, not suspicious, SOL basis, no bot flow pending) with no capital re-base
 * pending. The figure is the thin-pool hold limit's own: its `pnl_pct` is the higher of the plain
 * percent and the cost-basis figure when a cost basis applies (stored or provisional, key
 * holdThinPoolAvgCostBasis on, computable for this row — holdThinLimitPnl), else the plain one.
 * Held or not makes no difference there. Returns { pnl_pct, raw_pnl_pct, adjusted, reason }.
 */
export function distressPnlFromReading(thinLimitReading, tracked = null) {
  const none = (reason) => ({ pnl_pct: null, raw_pnl_pct: null, adjusted: false, reason });
  if (!thinLimitReading || thinLimitReading.ok !== true) return none(thinLimitReading?.reason || "no usable valuation");
  if (tracked?.capital_rebase_pending) return none("capital re-base pending");
  const raw = fin(thinLimitReading.raw_pnl_pct);
  if (raw == null) return none("pnl is not a finite number");
  const fig = fin(thinLimitReading.pnl_pct);
  // never lower than the plain percent (the gate can only remove closes)
  const v = fig != null && fig > raw ? fig : raw;
  return { pnl_pct: v, raw_pnl_pct: raw, adjusted: v !== raw, reason: null };
}

/**
 * The reference bin for "price since entry": the tracked entry bin (active_bin_at_deploy — a
 * bot deploy's bin, or the active bin of the scan that adopted an operator position); else a
 * reference stored earlier on the record (first_seen = the first reading under the minimum);
 * else this reading's bin (to be stored).
 * @returns {{ bin: number|null, source: "entry"|"first_seen"|null, store: boolean }}
 */
export function distressRefBin(tracked, activeBin) {
  const e = tracked?.active_bin_at_deploy;
  if (Number.isInteger(e)) return { bin: e, source: "entry", store: false };
  const r = tracked?.tvl_floor_distress?.ref_bin;
  if (Number.isInteger(r)) return { bin: r, source: "first_seen", store: false };
  if (Number.isInteger(activeBin)) return { bin: activeBin, source: "first_seen", store: true };
  return { bin: null, source: null, store: false };
}

/**
 * One reading → { verdict: "distress"|"calm"|"unknown", legs: ["loss"|"dump"], loss, dump,
 * pnl_pct (the figure the loss leg used), raw_pnl_pct, price_pct, price_ref, turnover,
 * loss_by_price, unknown: [what could not be read, with why] } (loss / dump: true | false | null).
 * `priceUnavailable` (a reason) forces the price unknown (a pool not known to be SOL-quoted).
 */
export function evaluateTvlFloorDistress({
  pnlPct = null, rawPnlPct = undefined, pnlReason = null, activeBin = null, entryBin = null, binStep = null,
  refSource = "entry", priceUnavailable = null, volumeUsd = null, tvlUsd = null, timeframeMinutes = null,
} = {}, cfg = TVL_DISTRESS_DEFAULTS) {
  const c = { ...TVL_DISTRESS_DEFAULTS, ...(cfg || {}) };
  const pnl = fin(pnlPct);
  const raw = rawPnlPct === undefined ? pnl : fin(rawPnlPct);
  const price = priceUnavailable ? null : priceChangeSinceEntryPct(activeBin, entryBin, binStep);
  const turnover = hourlyTurnover(volumeUsd, tvlUsd, timeframeMinutes);
  const unknown = [];
  if (pnl == null) unknown.push(`PnL (${pnlReason || "not usable"})`);
  if (price == null) {
    unknown.push(`price since ${refSource === "first_seen" ? "the first reading under the minimum" : "entry"} (${priceUnavailable
      || (fin(entryBin) == null ? "no reference bin" : fin(activeBin) == null ? "no active bin" : "no bin step")})`);
  }
  if (turnover == null) unknown.push(`1h volume (${fin(volumeUsd) == null ? "not in the pool row" : "pool TVL unusable"})`);
  let loss = null, lossByPrice = false;
  if (pnl != null) loss = pnl <= c.lossPct;
  else if (price != null) { loss = price <= c.priceDropPct; lossByPrice = true; }
  const dump = turnover == null || price == null ? null : (turnover >= c.dumpTurnover && price <= c.dumpPricePct);
  const legs = [...(loss === true ? ["loss"] : []), ...(dump === true ? ["dump"] : [])];
  const verdict = legs.length > 0 ? "distress" : (loss === false && dump === false ? "calm" : "unknown");
  const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  return {
    verdict, legs, loss, dump, loss_by_price: lossByPrice, pnl_pct: pnl, raw_pnl_pct: raw,
    price_pct: r2(price), price_ref: refSource === "first_seen" ? "first_seen" : "entry", turnover: r2(turnover), unknown,
  };
}

const spanMinOf = (s) => (s && s.first_at && s.last_at ? Math.max(0, (Date.parse(s.last_at) - Date.parse(s.first_at)) / 60_000) : 0);

/**
 * A stored distress streak, or null when it is missing or corrupt: count must be a positive
 * integer no larger than the TVL streak's own count (when given), first_at / last_at parseable
 * and in order. A corrupt one counts as no streak (the gate restarts from this reading).
 */
export function sanitizeDistressState(state, tvlCount = null) {
  if (!state || typeof state !== "object") return null;
  const n = state.count;
  if (!Number.isInteger(n) || n <= 0) return null;
  if (tvlCount != null && !(Number.isInteger(tvlCount) && n <= tvlCount)) return null;
  const a = typeof state.first_at === "string" ? Date.parse(state.first_at) : NaN;
  const b = typeof state.last_at === "string" ? Date.parse(state.last_at) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return state;
}

/**
 * Advance the distress streak with one reading. Pure.
 * @param {object|null} prev   stored state { count, first_at, last_at, last } or null
 * @param {object} verdict     from evaluateTvlFloorDistress
 * @param {string} event       the TVL streak's event for this reading
 * @param {number|null} tvlCount the TVL streak's count AFTER this reading (bounds a corrupt prev)
 * @returns {object|null} the new state (the stored one unchanged when nothing applies)
 */
export function advanceTvlFloorDistress(prev, verdict, event, nowMs = Date.now(), tvlCount = null) {
  if (!["started", "restarted", "counted", "merged"].includes(event)) return prev ?? null;
  const base = event === "started" || event === "restarted" ? null : sanitizeDistressState(prev, tvlCount);
  const nowIso = new Date(nowMs).toISOString();
  const last = {
    at: nowIso, verdict: ["distress", "calm"].includes(verdict?.verdict) ? verdict.verdict : "unknown",
    legs: Array.isArray(verdict?.legs) ? verdict.legs.filter((l) => l === "loss" || l === "dump") : [],
    pnl_pct: fin(verdict?.pnl_pct), raw_pnl_pct: fin(verdict?.raw_pnl_pct), price_pct: fin(verdict?.price_pct),
    price_ref: verdict?.price_ref === "first_seen" ? "first_seen" : "entry", turnover: fin(verdict?.turnover),
    loss: verdict?.loss ?? null, dump: verdict?.dump ?? null, loss_by_price: verdict?.loss_by_price === true,
    unknown: Array.isArray(verdict?.unknown) ? verdict.unknown.map(String) : [],
  };
  if (last.verdict === "distress" && last.legs.length === 0) last.verdict = "unknown"; // a distress verdict must name a leg
  const count = base ? base.count : 0;
  if (last.verdict === "calm") return { count: 0, first_at: null, last_at: null, last };
  if (last.verdict !== "distress") return { count, first_at: count > 0 ? base.first_at : null, last_at: count > 0 ? base.last_at : null, last };
  const lastMs = count > 0 ? Date.parse(base.last_at) : NaN;
  if (count === 0 || !Number.isFinite(lastMs) || nowMs - lastMs > TVL_DISTRESS_MAX_GAP_MS || nowMs < lastMs) {
    return { count: 1, first_at: nowIso, last_at: nowIso, last };
  }
  if (nowMs - lastMs < TVL_DISTRESS_MIN_SPACING_MS) return { count, first_at: base.first_at, last_at: base.last_at, last };
  return { count: count + 1, first_at: base.first_at, last_at: nowIso, last };
}

/**
 * Is the gate satisfied on this reading? `state` is the streak's `distress` object, `tvlCfg` the
 * TVL proof's settings (minReadings, minMinutes). `readingAtMs` = this reading's time: the last
 * evaluated reading must be it, and distress. `tvlCount` = the TVL streak's count: a distress
 * count above it is corrupt and counts as none.
 */
export function tvlFloorDistressGate(state, tvlCfg, readingAtMs = null, tvlCount = null) {
  const clean = sanitizeDistressState(state, tvlCount);
  const n = clean ? clean.count : 0;
  const span = n > 0 ? spanMinOf(clean) : 0;
  const lastAt = typeof state?.last?.at === "string" ? Date.parse(state.last.at) : NaN;
  const currentIsDistress = state?.last?.verdict === "distress"
    && Array.isArray(state.last.legs) && state.last.legs.length > 0
    && (readingAtMs == null || lastAt === readingAtMs);
  const ok = !!clean && currentIsDistress && n >= tvlCfg.minReadings && span >= tvlCfg.minMinutes;
  return { ok, count: n, span_min: span, current: state?.last ?? null, current_is_distress: currentIsDistress };
}

// ── Text ─────────────────────────────────────────────────────────────────────────────

const pct = (v) => (v == null ? "unknown" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`);
const x1 = (v) => `${Number(v).toFixed(1)}×`;
/**
 * "the price 7% under entry" / "… over entry" / "the price at entry"; with ref "first_seen" (no
 * entry bin): "the price 7% down since the first reading under the minimum". Never "above" /
 * "below" (legacy scans read those in close reasons).
 */
export function priceVsEntryText(p, ref = "entry") {
  const first = ref === "first_seen";
  if (p == null) return first ? "the price change since the first reading under the minimum unknown" : "the price change since entry unknown";
  const r = Math.round(Math.abs(p));
  if (first) return r === 0 ? "the price unchanged since the first reading under the minimum" : `the price ${r}% ${p < 0 ? "down" : "up"} since the first reading under the minimum`;
  if (r === 0) return "the price at entry";
  return `the price ${r}% ${p < 0 ? "under" : "over"} entry`;
}
const priceOf = (cur) => priceVsEntryText(cur?.price_pct ?? null, cur?.price_ref);

/**
 * The evidence clause of a close reason / alert — after "TVL exit: … " and before "— hard exit".
 * Says "turnover", never "volume" (lessons.js reads "volume" in a bad close's reason as a volume
 * collapse), nor "oor" / "below" / "floor" / "above".
 */
export function distressEvidenceText(current, cfg = TVL_DISTRESS_DEFAULTS) {
  const c = { ...TVL_DISTRESS_DEFAULTS, ...(cfg || {}) };
  const parts = [];
  const legs = Array.isArray(current?.legs) ? current.legs : [];
  if (legs.includes("dump")) parts.push(`heavy selling (1h turnover ${x1(current.turnover)} pool TVL, ${priceOf(current).replace(/^the /, "")})`);
  if (legs.includes("loss")) {
    parts.push(current.loss_by_price
      ? `${priceOf(current)} (limit ${Math.abs(c.priceDropPct)}%, no usable PnL)`
      : `the position at ${Number(current.pnl_pct).toFixed(1)}% (limit ${c.lossPct}%)`);
  }
  return parts.length ? `with ${parts.join(" and ")}` : "";
}

const usdTxt = (v) => (fin(v) == null ? "n/a" : `$${Math.round(v).toLocaleString("en-US")}`);

/** What closes a position under the minimum now — one sentence fragment for alerts. */
export function distressTriggerText(cfg = TVL_DISTRESS_DEFAULTS) {
  const c = { ...TVL_DISTRESS_DEFAULTS, ...(cfg || {}) };
  return `the position is at or under ${c.lossPct}% (or, with no usable PnL, the price at least ${Math.abs(c.priceDropPct)}% under entry) or the pool shows heavy selling with the price falling (1h volume at least ${c.dumpTurnover}× pool TVL with the price at least ${Math.abs(c.dumpPricePct)}% under entry)`;
}

/** "unknown: PnL (…), 1h volume (…)" — what the current reading could not read, or "". */
function unknownText(cur) {
  return Array.isArray(cur?.unknown) && cur.unknown.length ? cur.unknown.join(", ") : "";
}

/**
 * Telegram text, once per position, when the distress gate holds a TVL exit back. `pairHtml` is
 * the escaped, owner-tagged pair. HTML (<b>, <i> only); the caller sends it through the sanitised sender.
 */
export function distressHeldBackAlertText({ pairHtml, poolTvlUsd, chainTvlUsd, floorUsd, gate, cfg = TVL_DISTRESS_DEFAULTS, tvlCfg = { minReadings: 3, minMinutes: 5 } }) {
  const c = { ...TVL_DISTRESS_DEFAULTS, ...(cfg || {}) };
  const cur = gate?.current || {};
  const pnlTxt = cur.pnl_pct == null ? "PnL unknown" : `PnL ${pct(cur.pnl_pct)}`;
  const turn = cur.turnover == null ? "1h volume unknown" : `1h volume ${x1(cur.turnover)} pool TVL`;
  let why;
  if (gate?.current_is_distress) {
    why = `Not closing yet: signs of a dying pool on ${gate.count} of the ${tvlCfg.minReadings} readings over ${tvlCfg.minMinutes} min it needs (${turn}, ${priceOf(cur)}).`;
  } else if (cur.verdict === "unknown") {
    why = `Not closing: no loss at or under ${c.lossPct}% could be confirmed — could not read ${unknownText(cur) || "the inputs"}.`;
  } else {
    why = `Not closing: no loss at or under ${c.lossPct}% and no heavy selling (${turn}, ${priceOf(cur)}).`;
  }
  return `ℹ️ <b>Pool under the TVL minimum — not closing</b>\n${pairHtml}: pool TVL ${usdTxt(poolTvlUsd)} (on-chain ${usdTxt(chainTvlUsd)}) is under the ${usdTxt(floorUsd)} minimum; ${pnlTxt}.\n` +
    `${why}\nIt closes if, on ${tvlCfg.minReadings} readings over at least ${tvlCfg.minMinutes} min while pool TVL stays under ${usdTxt(floorUsd)}, ${distressTriggerText(c)}.` +
    "\n<i>tvlFloorExitDistressMode=off restores the old rule (TVL alone closes).</i>";
}

/** The held-back log line's explanation (what is missing and what would close it). */
export function distressHeldBackText(gate, cfg = TVL_DISTRESS_DEFAULTS, tvlCfg = { minReadings: 3, minMinutes: 5 }) {
  const c = { ...TVL_DISTRESS_DEFAULTS, ...(cfg || {}) };
  const cur = gate?.current || {};
  const pnlPart = cur.pnl_pct != null
    ? `PnL ${pct(cur.pnl_pct)}${cur.raw_pnl_pct != null && cur.raw_pnl_pct !== cur.pnl_pct ? ` on the cost basis (${pct(cur.raw_pnl_pct)} on net capital)` : ""} (closes at ≤ ${c.lossPct}%)`
    : `PnL unknown (with no usable PnL the price must be ≥ ${Math.abs(c.priceDropPct)}% under entry)`;
  const turn = cur.turnover == null ? "1h volume unknown" : `1h volume ${x1(cur.turnover)} pool TVL`;
  const dumpPart = `${turn} with ${priceOf(cur)} (closes at ≥ ${c.dumpTurnover}× with the price ≥ ${Math.abs(c.dumpPricePct)}% under entry)`;
  if (gate?.current_is_distress) {
    return `distress on ${gate.count}/${tvlCfg.minReadings} readings over ${Math.round(gate.span_min)}m of ${tvlCfg.minMinutes}m so far — ${pnlPart}, ${dumpPart}`;
  }
  if (cur.verdict === "unknown") {
    return `no sign of a dying pool could be confirmed — unknown: ${unknownText(cur) || "inputs"} — ${pnlPart}, ${dumpPart}`;
  }
  return `no sign of a dying pool — ${pnlPart}, ${dumpPart}`;
}
