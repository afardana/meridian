/**
 * Relative TVL exit — SHADOW ONLY (2026-11-27, operator-approved forward capture;
 * experiment `tvl-relative-exit`, docs/experiments/tvl-relative-exit.md).
 *
 * The live TVL exit (tvl-floor-exit.js) closes a position once its pool's TVL is confirmed under
 * a fixed $10,000. Its six fires so far were operator positions entered at ≤ 1.3× that floor
 * whose pools had fallen ≤ 27 % from entry — not collapses — while real collapses crossed $10K
 * late. The rule simulated here asks for BOTH: pool TVL under the floor AND at or under
 * `tvlRelativeExitPct` % of the position's own TVL reference. It closes nothing and changes no
 * field of the live rule; it records the first completed proof (`would_fire`) on the position
 * and, beside it, when the LIVE rule was first ready, so the two can be compared per position.
 *
 * Leaf module (imports only rule-mode.js and tvl-floor-exit.js, both leaves): pure functions.
 *
 *   other liq. = max(0, pool TVL − the position's own value in USD at that reading). Own value =
 *              `total_value_true_usd` of the scan row (always USD, whatever solMode displays), used
 *              only when it is a finite number ≥ 0 and the row's valuation is not flagged
 *              (`pnl_quality` absent or "valid"); otherwise nothing is subtracted and
 *              `own_value_subtracted: false` is recorded.
 *   reference  ref_usd = max(entry reference, the peak of OTHER liquidity over the usable readings
 *              since this code first evaluated the position). Entry reference = `entry_tvl`
 *              (finite > 0) minus the own value at the first reading that had it (nothing
 *              subtracted when the own value was unknown then), fixed from then on. ref_source
 *              "entry" when the entry reference is the larger (ties → entry), else "peak".
 *   qualifies  other liquidity now < floor (`tvlFloorExitUsd`) AND reference > 0 AND other
 *              liquidity now ≤ pct % of the reference.
 *   proof      ≥ minReadings qualifying readings spanning ≥ minMinutes; a usable reading that does
 *              not qualify resets; an unusable one neither counts nor resets; two readings
 *              < 60 s apart are one reading (the live rule's merge); a gap > 45 min between
 *              usable readings starts the streak over.
 *   chain      the live rule's on-chain reserve figure minus the own value now, same two bars:
 *              unavailable (incl. a read over 5 s) → nothing this cycle; disagree → streak reset;
 *              confirmed → would_fire.
 *   writes     a reading that changes only last_at / the own value is stored at most every 10 min.
 */

import { modeFor } from "./rule-mode.js";
import { RUG_FLOOR_TVL_USD, TVL_FLOOR_MIN_SPACING_MS } from "./tvl-floor-exit.js";

export const TVL_RELATIVE_DEFAULT_PCT = 50;
export const TVL_RELATIVE_MIN_PCT = 10;
export const TVL_RELATIVE_MAX_PCT = 90;
export const TVL_RELATIVE_DEFAULT_MIN_READINGS = 3;
export const TVL_RELATIVE_DEFAULT_MIN_MINUTES = 30;
export const TVL_RELATIVE_MIN_MINUTES_FLOOR = 5;
/** A gap longer than this between two usable readings starts the streak over. */
export const TVL_RELATIVE_MAX_GAP_MS = 45 * 60_000;
/** Accepted values of the mode key as stored (config.js keeps "enforce" so it can be logged). */
export const TVL_RELATIVE_STORED_MODES = Object.freeze(["off", "shadow", "enforce"]);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Config. Mode off | shadow (no enforce exists): "enforce" and any unknown value read as shadow;
 * `enforceRequested` tells the caller to log that once.
 */
export function tvlRelativeExitConfig(mgmt = {}) {
  const raw = mgmt?.tvlRelativeExitMode;
  const floor = Number(mgmt?.tvlFloorExitUsd);
  const pct = Number(mgmt?.tvlRelativeExitPct);
  const n = Math.floor(Number(mgmt?.tvlRelativeExitMinReadings));
  const m = Number(mgmt?.tvlRelativeExitMinMinutes);
  return {
    mode: modeFor("tvlRelativeExitMode", raw),
    enforceRequested: raw === "enforce",
    floorUsd: Number.isFinite(floor) && floor > 0 ? floor : RUG_FLOOR_TVL_USD,
    pct: Number.isFinite(pct) && pct > 0 ? Math.min(TVL_RELATIVE_MAX_PCT, Math.max(TVL_RELATIVE_MIN_PCT, pct)) : TVL_RELATIVE_DEFAULT_PCT,
    minReadings: Number.isFinite(n) && n >= 2 ? n : TVL_RELATIVE_DEFAULT_MIN_READINGS,
    minMinutes: Number.isFinite(m) && m >= 0 ? Math.max(TVL_RELATIVE_MIN_MINUTES_FLOOR, m) : TVL_RELATIVE_DEFAULT_MIN_MINUTES,
  };
}

/** The live rule's reading (`p.tvl_floor_reading`, from readPoolTvlUsd), usable or not. */
export function usableTvlReading(reading) {
  const v = reading?.ok === true ? num(reading.tvl_usd) : null;
  return v != null && v >= 0 ? v : null;
}

/** The position's own value in USD from the scan row, or { usd: 0, subtracted: false }. */
export function ownValueForTvl(row) {
  const v = num(row?.total_value_true_usd);
  const q = row?.pnl_quality;
  if (v == null || v < 0 || (q != null && q !== "valid")) return { usd: 0, subtracted: false };
  return { usd: v, subtracted: true };
}

/** Other liquidity in the pool = max(0, pool TVL − the position's own value at that reading). */
const other = (v, own) => Math.max(0, v - (own?.usd || 0));
const spanMin = (s) => (s ? Math.max(0, (Date.parse(s.last_at) - Date.parse(s.since)) / 60_000) : 0);
/** Only these change on every reading; a state differing in nothing else is not re-saved within the window. */
const VOLATILE = new Set(["last_at", "own_value_usd", "own_value_subtracted"]);
/** At most one save per this long when only the volatile fields moved. */
export const TVL_RELATIVE_SAVE_EVERY_MS = 10 * 60_000;

function evaluate(otherNow, refUsd, cfg) {
  const ref = num(refUsd) ?? 0;
  const pctOfRef = ref > 0 ? (otherNow / ref) * 100 : null;
  const qualifies = otherNow < cfg.floorUsd && ref > 0 && otherNow <= (cfg.pct / 100) * ref;
  return { otherNow, ref, pctOfRef, qualifies };
}

export function emptyTvlRelativeState() {
  return { ref_usd: null, ref_source: null, peak_usd: null, entry_ref_usd: null, entry_own_value_usd: null, own_value_usd: null, own_value_subtracted: null, last_at: null, streak: null, would_fire: null };
}

function onlyVolatileChanged(a, b) {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (VOLATILE.has(k)) continue;
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  return true;
}

/**
 * Advance the position's shadow state with one management-cycle reading. Pure.
 * All figures are OTHER liquidity (pool TVL − own value at that reading): the peak is the peak of
 * other liquidity; the entry reference is entry_tvl − the own value at the first reading that had
 * an entry_tvl (nothing subtracted when the own value was unknown then); ref = max of the two.
 * @returns {{ state, event, ready, tvl_adj_usd, ref_adj_usd, pct_of_ref }}
 *   event: done (would_fire already set) | ignored | tracked | reset | started | restarted | merged | counted
 *   `state` is the SAME object as `prev` when nothing changed — and when only last_at / the own
 *   value moved and the stored state is < 10 min old (write throttle).
 */
export function advanceTvlRelativeExit(prev, { reading, entryTvlUsd = null, own = { usd: 0, subtracted: false }, cfg, nowMs = Date.now() } = {}) {
  const c = cfg && cfg.floorUsd ? cfg : tvlRelativeExitConfig(cfg);
  const cur = prev && typeof prev === "object" ? prev : null;
  const none = { ready: false, tvl_adj_usd: null, ref_adj_usd: null, pct_of_ref: null };
  if (cur?.would_fire) return { state: cur, event: "done", ...none };
  const tvl = usableTvlReading(reading);
  if (tvl == null) return { state: cur, event: "ignored", ...none };

  const base = cur || emptyTvlRelativeState();
  const otherNow = other(tvl, own);
  const entry = num(entryTvlUsd) != null && entryTvlUsd > 0 ? entryTvlUsd : null;
  let entryRef = num(base.entry_ref_usd), entryOwn = base.entry_own_value_usd ?? null;
  if (entryRef == null && entry != null) { entryRef = other(entry, own); entryOwn = own?.subtracted ? own.usd : null; }
  const peak = Math.max(num(base.peak_usd) ?? -Infinity, otherNow);
  const refSource = entryRef != null && entryRef >= peak ? "entry" : "peak";
  const ref = refSource === "entry" ? entryRef : peak;
  const e = evaluate(otherNow, ref, c);
  const nowIso = new Date(nowMs).toISOString();
  const common = {
    ...base,
    ref_usd: ref,
    ref_source: refSource,
    peak_usd: peak,
    entry_ref_usd: entryRef,
    entry_own_value_usd: entryOwn,
    own_value_usd: own?.subtracted ? own.usd : null,
    own_value_subtracted: own?.subtracted === true,
    last_at: nowIso,
  };
  const out = (streak, event) => {
    let state = { ...common, streak };
    const lastMs = Date.parse(base.last_at);
    if (cur && onlyVolatileChanged(cur, state) && Number.isFinite(lastMs) && nowMs >= lastMs && nowMs - lastMs < TVL_RELATIVE_SAVE_EVERY_MS) state = cur;
    const ready = !!streak && streak.count >= c.minReadings && spanMin(streak) >= c.minMinutes;
    return { state, event, ready, tvl_adj_usd: e.otherNow, ref_adj_usd: e.ref, pct_of_ref: e.pctOfRef };
  };

  const s = base.streak && Number(base.streak.count) > 0 ? base.streak : null;
  if (!e.qualifies) return out(null, s ? "reset" : "tracked");

  const lastMs = s ? Date.parse(s.last_at) : NaN;
  if (!s || !Number.isFinite(lastMs) || nowMs - lastMs > TVL_RELATIVE_MAX_GAP_MS || nowMs < lastMs) {
    return out({ since: nowIso, last_at: nowIso, count: 1, min_tvl_usd: e.otherNow, last_tvl_usd: e.otherNow, last_pct_of_ref: e.pctOfRef }, s ? "restarted" : "started");
  }
  const upd = { ...s, last_tvl_usd: e.otherNow, last_pct_of_ref: e.pctOfRef, min_tvl_usd: Math.min(num(s.min_tvl_usd) ?? e.otherNow, e.otherNow) };
  if (nowMs - lastMs < TVL_FLOOR_MIN_SPACING_MS) return out(upd, "merged");
  return out({ ...upd, count: s.count + 1, last_at: nowIso }, "counted");
}

/**
 * The on-chain figure through the same subtraction (own value now) against the same reference
 * (already other liquidity) and the same two bars.
 * @returns {{ verdict: "confirmed"|"disagree"|"unavailable", chain_tvl_usd: number|null, chain_adj_usd?: number, reason?: string }}
 */
export function crossCheckTvlRelative(chain, { refUsd, own = { usd: 0, subtracted: false }, cfg } = {}) {
  const c = cfg && cfg.floorUsd ? cfg : tvlRelativeExitConfig(cfg);
  const v = chain?.ok === true ? num(chain.tvl_usd) : null;
  if (v == null || v < 0) return { verdict: "unavailable", chain_tvl_usd: null, reason: chain?.reason || "no on-chain figure" };
  const e = evaluate(other(v, own), refUsd, c);
  return { verdict: e.qualifies ? "confirmed" : "disagree", chain_tvl_usd: v, chain_adj_usd: e.otherNow };
}

/**
 * Apply the cross-check to the state. confirmed → `would_fire` (first proof only, never
 * overwritten); disagree → streak reset; unavailable → unchanged (same object).
 */
export function applyTvlRelativeCrossCheck(state, check, { nowMs = Date.now(), pnlPct = null, held = false, handsOff = false, refAdjUsd = null, pctOfRef = null } = {}) {
  if (!state || typeof state !== "object" || state.would_fire) return state;
  if (check?.verdict === "disagree") return { ...state, streak: null };
  if (check?.verdict !== "confirmed" || !state.streak) return state;
  const s = state.streak;
  return {
    ...state,
    would_fire: {
      at: new Date(nowMs).toISOString(),
      tvl_usd: num(s.last_tvl_usd),
      ref_usd: num(refAdjUsd),
      entry_ref_usd: num(state.entry_ref_usd),
      ref_source: state.ref_source,
      pct_of_ref: num(pctOfRef),
      chain_tvl_usd: num(check.chain_adj_usd),
      chain_raw_usd: num(check.chain_tvl_usd),
      own_value_usd: state.own_value_usd,
      own_value_subtracted: state.own_value_subtracted === true,
      pnl_pct: num(pnlPct),
      held: held === true,
      hands_off: handsOff === true,
      readings: s.count,
      span_min: Math.round(spanMin(s) * 10) / 10,
    },
  };
}

// ── Comparison with the live rule (tvl_floor_shadow_compare) ───────────────────────────────

export function emptyTvlFloorCompare() {
  return { old_first_ready_at: null, old_first_ready_pnl_pct: null, old_closed: false, new_would_fire_at: null, new_would_fire_pnl_pct: null };
}

/** The live rule's proof completed AND its on-chain check agreed (first time only). */
export function noteOldReady(compare, { pnlPct = null, nowMs = Date.now() } = {}) {
  const c = compare && typeof compare === "object" ? compare : emptyTvlFloorCompare();
  if (c.old_first_ready_at) return compare;
  return { ...c, old_first_ready_at: new Date(nowMs).toISOString(), old_first_ready_pnl_pct: num(pnlPct) };
}

/** The shadow's first would-fire (first time only). */
export function noteNewWouldFire(compare, { at, pnlPct = null } = {}) {
  const c = compare && typeof compare === "object" ? compare : emptyTvlFloorCompare();
  if (c.new_would_fire_at) return compare;
  return { ...c, new_would_fire_at: at, new_would_fire_pnl_pct: num(pnlPct) };
}

/** A close reason the live TVL exit wrote (tvlFloorExitReason; exitFamilyFromReason keys on it). */
export const isTvlFloorCloseReason = (reason) => /^TVL exit/.test(String(reason || ""));

/**
 * Perf-record fields (both null when the position never carried them). `old_closed` = the
 * close was the live TVL exit's (from the close reason), or the stored flag.
 */
export function tvlRelativeRecordFields(tracked, closeReason = null) {
  const rel = tracked?.tvl_relative_exit && typeof tracked.tvl_relative_exit === "object" ? tracked.tvl_relative_exit : null;
  const cmp = tracked?.tvl_floor_shadow_compare && typeof tracked.tvl_floor_shadow_compare === "object" ? tracked.tvl_floor_shadow_compare : null;
  return {
    tvl_relative_exit: rel ? { ...rel, streak: rel.streak ? { ...rel.streak } : null, would_fire: rel.would_fire ? { ...rel.would_fire } : null } : null,
    tvl_floor_shadow_compare: cmp ? { ...cmp, old_closed: cmp.old_closed === true || (!!cmp.old_first_ready_at && isTvlFloorCloseReason(closeReason)) } : null,
  };
}

// ── Log lines (no Telegram) ───────────────────────────────────────────────────────────────

const usd = (v) => (num(v) == null ? "n/a" : `$${Math.round(v).toLocaleString("en-US")}`);
const pct = (v, d = 1) => (num(v) == null ? "n/a" : `${v.toFixed(d)} %`);
const signed = (v) => (num(v) == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)} %`);

export function tvlRelativeReferenceLine(pair, state, refAdjUsd) {
  const own = state?.own_value_subtracted ? `own ${usd(state.own_value_usd)} subtracted from this reading` : "own value not subtracted";
  return `[TVL_RELATIVE_SHADOW] ${pair}: reference ${usd(refAdjUsd)} (${state?.ref_source || "?"}; other liquidity — ${own})`;
}

export function tvlRelativeWouldCloseLine(pair, wf, cfg) {
  return `[TVL_RELATIVE_SHADOW] would-close ${pair}: pool TVL ${usd(wf.tvl_usd)} under ${usd(cfg.floorUsd)} and ${pct(wf.pct_of_ref)} of its reference ${usd(wf.ref_usd)}` +
    ` for ${wf.readings} readings over ${Math.round(wf.span_min)}m (on-chain ${usd(wf.chain_tvl_usd)}) — pnl ${signed(wf.pnl_pct)}, nothing closed (tvlRelativeExitMode=shadow)` +
    `${wf.held ? " [held]" : ""}${wf.hands_off ? " [hands-off]" : ""}`;
}
