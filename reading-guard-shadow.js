/**
 * Reading guard on non-held positions — LOG ONLY (2026-11-25, operator go-ahead for the shadow;
 * docs/experiments/reading-guard.md, pass rule registered before any capture).
 *
 * Claim under test: on a position that is NOT on HOLD, a PnL reading that moved more than 5 pp
 * beyond what the active-bin move since the last accepted reading explains is an accounting
 * transient (an operator top-up / withdrawal / re-range Meteora has not indexed yet), not a
 * market move. Two live cases, both operator top-ups: JIMMY-SOL CYCbgJBm 7 % → 58.93 % for 40 s
 * (held — the held-reading guard covers that path; not held, takeProfitPct 45 could have fired),
 * Huss-SOL E96pMB2p +12 % → −37.27 % for one valuation with the bin one lower (the live drop
 * guard only flags a drop while the bin did NOT fall).
 *
 * The check is the held-reading guard's (hold-observer.js advanceHeldReadingRef, reused as is):
 *   rise ≤ (100 + ref pnl) × ((1 + binStep/1e4)^binsRose − 1) + 5 pp,
 *   drop ≤ maxExplainedDropPp(ref pnl, binsFell, binStep) + 5 pp (hold-thin-limit.js),
 * against the last ACCEPTED reading (an unexplained one keeps the reference); a flagged level
 * that stands 15 min is accepted; no reading for 10 min drops the reference.
 *
 * Episode = first flagged reading … the end:
 *   reverted        a reading is plausible against the reference again
 *   capital_rebase  the external-capital reconciler moved amount_sol (or a capital re-base is
 *                   pending) while the episode was open
 *   persisted       the flagged level stood 15 min and was accepted
 *   closed          the position closed with the episode open (perf record / clearPriceHistory)
 *   hold            the operator put the position on HOLD (the held path has its own guard)
 *   unresolved      the reference was lost (restart, or no reading for 10 min)
 * (`hold` and `unresolved` are not in the registration's list; they exist so an episode never
 * stays open forever. They count against check 2 of the pass rule.)
 *
 * Readings that are not management-ready, not SOL-basis, have no finite pnl, no active bin or no
 * bin step neither count nor reset (fail-open: the guard stays out). A capital change drops the
 * reference; the next reading after the re-base settled starts a new one.
 *
 * Nothing here changes a peak, a suspect flag, a valuation reference, an exit signal or an exit:
 * the only write is `pos.reading_guard_shadow`. No rule module reads that field (test-guarded).
 * The reference lives in memory (a restart starts fresh), like the held one.
 *
 * Leaf module: hold-observer.js, hold-thin-limit.js, rule-mode.js — no state.js import.
 */
import { advanceHeldReadingRef, HELD_READING_SLACK_PP, HELD_REF_STALE_MS, HELD_READING_PERSIST_MS } from "./hold-observer.js";
import { maxExplainedDropPp } from "./hold-thin-limit.js";
import { modeFor } from "./rule-mode.js";

export const READING_GUARD_SLACK_PP = HELD_READING_SLACK_PP;
export const READING_GUARD_STALE_MS = HELD_REF_STALE_MS;
export const READING_GUARD_PERSIST_MS = HELD_READING_PERSIST_MS;
export const READING_GUARD_RECENT = 6;
export const READING_GUARD_ENDS = Object.freeze(["reverted", "capital_rebase", "persisted", "closed", "hold", "unresolved"]);
/** Exit families the pass rule calls stop-class (check 3). */
export const READING_GUARD_STOP_FAMILIES = Object.freeze(["stop_loss", "young_stop", "probation_stop", "rug", "crash"]);

/** off | shadow (an unknown value reads as shadow — there is no enforce). */
export function readingGuardMode(mgmt = {}) {
  return modeFor("readingGuardMode", mgmt?.readingGuardMode);
}

const fin = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
const iso = (ms) => new Date(ms).toISOString();

// position address → { ref (advanceHeldReadingRef's), key (last reading's pnl|bin|value) }
const _refs = new Map();
export function forgetReadingGuardRef(address) { _refs.delete(address); }
export function _resetReadingGuardRefs() { _refs.clear(); }
export function _readingGuardRef(address) { return _refs.get(address) ?? null; }

/** One usable reading of a non-held row, or { ok: false } (it neither counts nor resets). */
export function readingGuardReading(row, tracked = null) {
  if (!row || row.pnl_management_ready === false) return { ok: false, reason: "not management-ready" };
  if (row.pnl_basis != null && row.pnl_basis !== "sol") return { ok: false, reason: `pnl basis is ${row.pnl_basis}` };
  const pnl = fin(row.pnl_pct);
  if (pnl == null) return { ok: false, reason: "pnl is not a finite number" };
  const bin = fin(row.active_bin);
  if (bin == null) return { ok: false, reason: "active bin unknown" };
  const binStep = fin(row.bin_step) ?? fin(tracked?.bin_step);
  if (!(binStep > 0)) return { ok: false, reason: "bin step unknown" };
  return { ok: true, pnl_pct: pnl, bin, binStep, key: `${row.pnl_pct}|${row.active_bin}|${row.total_value_usd ?? ""}` };
}

/**
 * The explained move for the record (advanceHeldReadingRef decides; this only describes):
 * direction of the PnL move, bins moved (signed, + = price up), the largest move the bins
 * explain and the excess over it.
 */
export function explainReadingMove(refPnl, refBin, pnl, bin, binStep) {
  const move = pnl - refPnl;
  const direction = move > 0 ? "up" : "down";
  const binsMoved = bin - refBin;
  const bs = Number(binStep);
  const explained = direction === "up"
    ? Math.max(0, 100 + refPnl) * (Math.pow(1 + bs / 1e4, Math.max(0, binsMoved)) - 1)
    : maxExplainedDropPp(refPnl, refBin - bin, bs);
  return { direction, bins_moved: binsMoved, explained_pp: explained, excess_pp: Math.abs(move) - explained };
}

/** Snapshot of the live fields the capture compares after the live path ran (null = mode off). */
export function readingGuardSnapshot(tracked, mgmt = {}) {
  if (readingGuardMode(mgmt) === "off" || !tracked) return null;
  return {
    peak_pnl_pct: fin(tracked.peak_pnl_pct),
    amount_sol: fin(tracked.amount_sol),
    capital_rebase_pending: !!tracked.capital_rebase_pending,
  };
}

/**
 * What the live path did with this reading, from the snapshot taken before it and the position
 * after it. `exit` = the exit object the evaluator (+ fast paths) built for the reading, or null;
 * `registration` = registerExitSignal's result (poller) — the management cycle acts on any exit
 * directly, so there an exit is both a signal and a fire.
 */
export function readingGuardContext(before, after, row, { suspect = false, exit = null, registration = null, source = "poller" } = {}) {
  const amtBefore = before?.amount_sol, amtAfter = fin(after?.amount_sol);
  const capitalChange = !!before?.capital_rebase_pending || !!after?.capital_rebase_pending
    || (amtBefore != null && amtAfter != null && Math.abs(amtAfter - amtBefore) > 1e-12);
  const peakBefore = before?.peak_pnl_pct, peakAfter = fin(after?.peak_pnl_pct);
  const peakRose = peakAfter != null && (peakBefore == null || peakAfter > peakBefore);
  const tag = exit && exit.action ? { action: exit.action, family: exit.family ?? null } : null;
  let exitSignal = null, exitFired = null;
  if (tag && source === "management") { exitSignal = tag; exitFired = tag; }
  else if (tag && registration) {
    if (registration.action && !registration.stale) exitSignal = tag;
    if (registration.fire === true) exitFired = tag;
  }
  return {
    suspect: suspect === true || row?.pnl_pct_suspicious === true || !!before?.capital_rebase_pending || !!after?.capital_rebase_pending,
    peakRose,
    exitSignal,
    exitFired,
    capitalChange,
    capitalPendingAfter: !!after?.capital_rebase_pending,
  };
}

const emptyStore = () => ({ episodes: 0, recent: [], open: null, counts: emptyCounts() });
const emptyCounts = () => ({ reverted: 0, capital_rebase: 0, persisted: 0, closed: 0, hold: 0, unresolved: 0, trusted: 0, trusted_effect: 0, persisted_stop_class: 0 });
const cloneStore = (s) => (s ? { ...s, recent: [...(s.recent || [])], counts: { ...emptyCounts(), ...(s.counts || {}) }, open: s.open ? { ...s.open } : null } : null);
const isStopClass = (family) => family != null && READING_GUARD_STOP_FAMILIES.includes(family);

/** Close the open episode of `s` (mutates the clone). Returns the finished episode. */
function endEpisode(s, reason, nowMs) {
  const ep = s.open;
  ep.ended = reason;
  ep.ended_at = iso(nowMs);
  const started = Date.parse(ep.started_at);
  ep.duration_s = Number.isFinite(started) ? Math.max(0, Math.round((nowMs - started) / 1000)) : null;
  s.recent = [...s.recent, ep].slice(-READING_GUARD_RECENT);
  s.counts[reason] = (s.counts[reason] ?? 0) + 1;
  if (!ep.already_suspect) {
    s.counts.trusted++;
    if (ep.peak_confirmed || ep.exit_signal) s.counts.trusted_effect++;
  }
  if (reason === "persisted" && (isStopClass(ep.exit_signal_family) || isStopClass(ep.exit_fired_family))) s.counts.persisted_stop_class++;
  s.open = null;
  return ep;
}

/**
 * Pure step. `store` = the stored field (or null), `refEntry` = { ref, key } (or null),
 * `reading` from readingGuardReading, `ctx` from readingGuardContext.
 * Returns { store, refEntry, changed, events: [{ type: "start" | "end", episode }] }.
 * `changed` = an episode opened or ended or one of its booleans / verdict fields flipped (the
 * caller saves only then; readings counts and the extreme ride along with the next save).
 */
export function stepReadingGuard(store, refEntry, reading, ctx, nowMs) {
  let s = cloneStore(store);
  const events = [];
  let changed = false;
  const end = (reason) => { events.push({ type: "end", episode: endEpisode(s, reason, nowMs) }); changed = true; };

  if (ctx?.capitalChange) {
    if (s?.open) end("capital_rebase");
    refEntry = null;
    if (ctx.capitalPendingAfter) return { store: s, refEntry: null, changed, events };
  }
  if (!reading?.ok) return { store: s, refEntry, changed, events };

  if (s?.open && (!refEntry?.ref || nowMs - refEntry.ref.seen_at > READING_GUARD_STALE_MS)) {
    end("unresolved");
    refEntry = null;
  }
  const prev = refEntry?.ref ?? null;
  const distinct = !refEntry || refEntry.key !== reading.key;
  const r = advanceHeldReadingRef(prev, { pnl_pct: reading.pnl_pct, bin: reading.bin }, reading.binStep, nowMs);
  const next = { ref: r.ref, key: reading.key };

  if (r.plausible) {
    if (s?.open) end(r.accepted_by_persistence ? "persisted" : "reverted");
    return { store: s, refEntry: next, changed, events };
  }

  // Flagged: the move is more than 5 pp beyond what the bins explain.
  const d = explainReadingMove(prev.pnl_pct, prev.bin, reading.pnl_pct, reading.bin, reading.binStep);
  if (!s) s = emptyStore();
  let ep = s.open;
  if (!ep) {
    ep = s.open = {
      started_at: iso(nowMs),
      direction: d.direction,
      from_pct: round2(prev.pnl_pct),
      to_pct: round2(reading.pnl_pct),
      bins_moved: d.bins_moved,
      explained_pp: round2(d.explained_pp),
      excess_pp: round2(d.excess_pp),
      already_suspect: ctx?.suspect === true,
      peak_confirmed: false,
      exit_signal: null, exit_signal_family: null,
      exit_fired: null, exit_fired_family: null,
      readings: 1,
      last_at: iso(nowMs),
      ended: null, ended_at: null, duration_s: null,
    };
    s.episodes++;
    events.push({ type: "start", episode: { ...ep } });
    changed = true;
  } else {
    ep.last_at = iso(nowMs);
    if (distinct) ep.readings++;
    const more = ep.direction === "up" ? reading.pnl_pct > ep.to_pct : reading.pnl_pct < ep.to_pct;
    if (more && d.direction === ep.direction) {
      ep.to_pct = round2(reading.pnl_pct);
      ep.bins_moved = d.bins_moved;
      ep.explained_pp = round2(d.explained_pp);
      ep.excess_pp = round2(d.excess_pp);
    }
    if (ep.already_suspect && ctx?.suspect !== true) { ep.already_suspect = false; changed = true; }
  }
  if (ctx?.peakRose && !ep.peak_confirmed) { ep.peak_confirmed = true; changed = true; }
  if (ctx?.exitSignal && !ep.exit_signal) { ep.exit_signal = ctx.exitSignal.action; ep.exit_signal_family = ctx.exitSignal.family ?? null; changed = true; }
  if (ctx?.exitFired && !ep.exit_fired) { ep.exit_fired = ctx.exitFired.action; ep.exit_fired_family = ctx.exitFired.family ?? null; changed = true; }
  return { store: s, refEntry: next, changed, events };
}

/** `[READING_GUARD_SHADOW] would-suspect …` — one line per episode at its start. */
export function readingGuardStartLine(pair, ep, mode = "shadow") {
  const n = Math.abs(ep.bins_moved);
  const word = ep.bins_moved > 0 ? "up" : ep.bins_moved < 0 ? "down" : ep.direction;
  return `[READING_GUARD_SHADOW] would-suspect ${pair}: PnL ${Number(ep.from_pct).toFixed(2)}% → ${Number(ep.to_pct).toFixed(2)}% while the price moved ${n} bins ${word} (explains at most ${Number(ep.explained_pp).toFixed(1)} pp) — ${ep.already_suspect ? "already suspect by the live guards" : "TRUSTED by the live path"} (readingGuardMode=${mode})`;
}

/** `[READING_GUARD_SHADOW] <pair>: episode ended …` — one line per episode at its end. */
export function readingGuardEndLine(pair, ep) {
  return `[READING_GUARD_SHADOW] ${pair}: episode ended ${ep.ended} after ${ep.duration_s ?? "?"}s; peak_confirmed=${ep.peak_confirmed}, exit_signal=${ep.exit_signal ?? "null"}, exit_fired=${ep.exit_fired ?? "null"}`;
}

/**
 * Feed one reading of a NON-held position after the live path acted on it. Mutates
 * `pos.reading_guard_shadow` only (created on the first episode; absent until then).
 * Returns { changed, lines }. Mode off: drops the reference, writes nothing.
 */
export function advanceReadingGuardShadow(pos, address, { row, before, suspect = false, exit = null, registration = null, source = "poller", mgmt = {}, nowMs = Date.now() } = {}) {
  const mode = readingGuardMode(mgmt);
  if (mode === "off" || !before) { _refs.delete(address); return { changed: false, lines: [] }; }
  if (!pos || pos.closed || pos.hold_mode === true) return { changed: false, lines: [] };
  const reading = readingGuardReading(row, pos);
  const ctx = readingGuardContext(before, pos, row, { suspect, exit, registration, source });
  const r = stepReadingGuard(pos.reading_guard_shadow ?? null, _refs.get(address) ?? null, reading, ctx, nowMs);
  if (r.refEntry) _refs.set(address, r.refEntry); else _refs.delete(address);
  if (r.store) pos.reading_guard_shadow = r.store;
  const pair = row?.pair || pos.pool_name || address;
  const lines = r.events.map((e) => (e.type === "start" ? readingGuardStartLine(pair, e.episode, mode) : readingGuardEndLine(pair, e.episode)));
  return { changed: r.changed, lines };
}

/** End an open episode (`hold` on setPositionHold, `closed` on a close). Drops the reference. */
export function endReadingGuardShadow(pos, address, reason, nowMs = Date.now()) {
  _refs.delete(address);
  if (!pos?.reading_guard_shadow?.open) return { changed: false, line: null };
  const s = cloneStore(pos.reading_guard_shadow);
  const ep = endEpisode(s, reason, nowMs);
  pos.reading_guard_shadow = s;
  return { changed: true, line: readingGuardEndLine(pos.pool_name || address, ep) };
}

/** Perf-record field: null without an episode; an episode still open at the close ends `closed`. */
export function readingGuardRecordField(pos, nowMs = Date.now()) {
  const s = pos?.reading_guard_shadow;
  if (!s || typeof s !== "object") return null;
  const c = cloneStore(s);
  if (c.open) endEpisode(c, "closed", nowMs);
  return c;
}
