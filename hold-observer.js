// hold-observer.js — what the bot does with one reading of a position on HOLD (2026-11-05).
//
// A held position is skipped by the exit evaluator, but both the 5 s PnL poller and the
// 3-min management cycle feed its record-only trackers and the HOLD-overriding thin-pool
// limit. These used to be two hand-copied branches in index.js that had drifted apart; this
// is the one copy (characterized in test/hold-observer.test.js before the merge).
//
// Order, both sources:
//   registerExitSignal (cleared) → forget the valuation reference → [management: "exits
//   suppressed" log] → held high (trusted readings only) → path extremes → [poller: tick
//   capture] → thin-pool hold limit (an exit returns here) → [management: give-back alert →
//   downside shadow].
// The held high and the path reading are record-only and each sits in its own try/catch for
// both sources, so a throw there skips nothing else. The TVL-floor exit (runs on every
// position, held or not) and the adoption-PnL shadow (likewise) stay in index.js.
//
// Since 2026-11-25 the held reading first syncs an operator re-range (noteHoldRangeReading) and
// the capital (noteHoldCapitalReading); a change in either skips the trackers and the limit check
// for that tick. The capital sync is followed by a plausibility guard (advanceHeldReadingRef):
// the held high and the path extremes are fed only when !capitalChanged and the PnL move is
// explained by the price move (an unindexed deposit reads as profit). Nothing else moves.
// Since 2026-11-26 the give-back alert (management) takes only a reading the held high would
// also take (giveBackReadingUsable + that guard), and the guard is seeded at the hold start from
// the last trusted non-held valuation (seedHeldReadingRefFromValuation).
//
// Dependencies are injected (index.js holdObserverDeps()): the state functions, log, the
// Telegram sender and formatters, and index.js's own checkHoldThinLimit.

import { maxExplainedDropPp } from "./hold-thin-limit.js";

/**
 * One reading of a held position. `source`: "poller" | "management". `confirmTicks` is the
 * poller's exit-signal confirmation count (the management cycle always uses 1). `cfg` is
 * config.management (management only). Returns the thin-pool hold-limit exit object, or null;
 * the caller closes on an exit (poller) or queues it (management).
 */
export function observeHeldPosition(p, tracked, { source, deps, cfg = {}, confirmTicks = 1 }) {
  const management = source === "management";
  if (!management && source !== "poller") throw new Error(`observeHeldPosition: unknown source ${source}`);
  const { registerExitSignal, forgetValuationReference, noteHoldPeakReading, noteHoldPathReading, recordTick, checkHoldThinLimit, log } = deps;

  // Before the valuation reference is dropped: on the first held reading it is still the last
  // TRUSTED non-held valuation, which seeds the held-reading guard (2026-11-26).
  seedHeldReadingRefFromValuation(p.position, deps);
  registerExitSignal(p.position, null, management ? 1 : confirmTicks);
  forgetValuationReference(p.position);
  if (management) log("state", "Automatic exits suppressed for " + p.pair + ": operator HOLD is active");

  const capitalChanged = syncHeldCapital(p, deps); // true: this reading may be on the old capital
  if (capitalChanged) _heldReadingRefs.delete(p.position);
  const feed = !capitalChanged && heldReadingPlausible(p, tracked, deps);

  // Held high for the give-back alert only (no exit rule reads it).
  if (feed && p.pnl_management_ready !== false && p.pnl_pct_suspicious !== true) {
    try { noteHoldPeakReading(p.position, p.pnl_pct); } catch { /* visibility only */ }
  }
  // Path extremes for the perf record (record-only; same trust gate inside).
  if (feed) {
    try { noteHoldPathReading(p.position, p); } catch { /* mfe / mae / max bins: record only */ }
  }
  if (!management) {
    recordTick({ pool_address: p.pool, position_address: p.position, active_bin: p.active_bin, pnl_pct: p.pnl_pct, source: "poller" });
  }
  if (capitalChanged) return null;

  // Thin-pool hold limit (hold-thin-limit.js): the one PnL rule that runs on a held
  // position. Pure decision on this reading — no network call. Fires only on its own
  // 2-valuation / 60 s confirmation; the close passes the HOLD guards through the stamp it
  // writes (hold-override.js).
  const holdLimitExit = checkHoldThinLimit(p);
  if (holdLimitExit) return holdLimitExit;

  if (management) {
    // Give-back alert only on a reading the held-high tracker would also take (2026-11-26):
    // BASKET-SOL / Pompom-SOL 2026-11-25 23:02 WIB read −94.89 % / −96.23 % on the first
    // valuation after a restart (SOL price missing, not management-ready) and Telegram got
    // "peak 0.23 % → now −94.89 %". An unusable reading neither alerts nor resets the latch.
    if (feed && giveBackReadingUsable(p, tracked, deps)) holdGiveBackAlert(p, tracked, cfg, deps);
    holdDownsideShadow(p, tracked, cfg, deps);
  }
  return null;
}

/**
 * The held-high tracker's own standard for a reading (management-ready, not suspicious, SOL
 * basis, finite pnl) plus no capital re-base pending. The caller also requires `feed`: not the
 * capital-change tick and not a reading the held-reading guard found unexplained by the price.
 */
export function giveBackReadingUsable(p, tracked, deps = {}) {
  if (!p || p.pnl_management_ready === false || p.pnl_pct_suspicious === true) return false;
  if (p.pnl_basis != null && p.pnl_basis !== "sol") return false;
  if (finNum(p.pnl_pct) == null) return false;
  let row = tracked;
  try { row = deps.getTrackedPosition?.(p.position) ?? tracked; } catch { /* use the row in hand */ }
  return !row?.capital_rebase_pending;
}

export const HELD_SEED_MAX_AGE_MS = 10 * 60_000;

/**
 * Fix C (2026-11-26). JIMMY-SOL CV7AUcQh 2026-11-25 20:55 WIB: an operator top-up not yet
 * indexed read 0.85 % → 50.85 % at an unchanged bin (the non-held path marked it suspect), HOLD
 * was set 16 s later, and the held-reading guard — with no reference on the first held reading —
 * accepted ≈ 50.5 % as the held high (rescaled on every later re-base, four false give-back
 * alerts). Now the guard's reference is seeded from the last TRUSTED non-held valuation
 * (index.js assessValuation's reference: pnl + active bin of the last trusted reading — a
 * suspect reading keeps the trusted one) when it is at most 10 min old and newer than any
 * reference the guard already has (one left from an earlier hold). Called before the hold
 * branch drops that valuation reference, so only the first held reading of a hold can find it.
 * No trusted reference (restart, hold set at deploy, a reference older than 10 min): nothing is
 * seeded and the first held reading starts the reference, as before.
 */
function seedHeldReadingRefFromValuation(position, deps) {
  try {
    const v = deps.peekTrustedValuation?.(position);
    if (!v) return;
    const pnl = finNum(v.pnl), at = finNum(v.at);
    if (pnl == null || at == null) return;
    const now = Date.now();
    if (now - at > HELD_SEED_MAX_AGE_MS || at > now + 60_000) return;
    const cur = _heldReadingRefs.get(position);
    if (cur && !(Number(cur.seen_at) < at)) return;
    _heldReadingRefs.set(position, { pnl_pct: pnl, bin: finNum(v.bin), at, seen_at: at, unexplained_since: null, seeded_from_valuation: true });
  } catch { /* record-only guard: never blocks the hold branch */ }
}

/** Test hook: the guard's reference of one position (or undefined). */
export function _heldReadingRefOf(position) { return _heldReadingRefs.get(position); }

/**
 * Capital sync (2026-11-25): an operator top-up / partial withdrawal on a HELD position is booked
 * here (state.noteHoldCapitalReading) — the exit evaluator, which used to be the only place, does
 * not run on HOLD, so JIMMY-SOL CYCbgJBm kept reading its PnL on the pre-top-up capital. Returns
 * true on the tick the capital changes: that reading may still be on the old capital, so the
 * caller feeds no PnL tracker and runs no limit check on it; the next reading settles the re-base.
 * Range sync (2026-11-25, state.noteHoldRangeReading) runs first: an operator re-range while held
 * changes the percent basis, so a tick that records one is treated the same way (returns true).
 */
function syncHeldCapital(p, deps) {
  let rangeChanged = false;
  try {
    rangeChanged = deps.noteHoldRangeReading?.(p.position, p)?.rangeChanged === true;
  } catch (e) {
    deps.log("state_warn", `[REBALANCE_EVENT] ${p.pair}: range sync on HOLD failed: ${e.message}`);
  }
  let capitalChanged = false;
  try {
    capitalChanged = deps.noteHoldCapitalReading?.(p.position, p)?.capitalChanged === true;
  } catch (e) {
    deps.log("state_warn", `[CAPITAL_REBASE] ${p.pair}: capital sync on HOLD failed: ${e.message}`);
  }
  return rangeChanged || capitalChanged;
}

export const HELD_READING_SLACK_PP = 5;
export const HELD_REF_STALE_MS = 10 * 60_000;
export const HELD_READING_PERSIST_MS = 15 * 60_000;

const _heldReadingRefs = new Map(); // position address → ref (memory only; a restart starts fresh)
export function _resetHeldReadingRefs() { _heldReadingRefs.clear(); }

const finNum = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Plausibility of one held reading against the last accepted one (2026-11-25). A deposit Meteora
 * has not indexed yet reads as profit (JIMMY-SOL: +48 pp in 6 bins); the held high and the path
 * extremes must not take it. Pure. `ref` = { pnl_pct, bin, at, seen_at, unexplained_since } | null,
 * `reading` = { pnl_pct, bin }. An unexplained reading keeps the ref; one that stands for
 * HELD_READING_PERSIST_MS is accepted (a real accounting step must not freeze the trackers).
 */
export function advanceHeldReadingRef(ref, reading, binStep, nowMs) {
  const fresh = () => ({ pnl_pct: reading.pnl_pct, bin: finNum(reading.bin), at: nowMs, seen_at: nowMs, unexplained_since: null });
  if (!ref || nowMs - ref.seen_at > HELD_REF_STALE_MS) return { ref: fresh(), plausible: true, reason: null, accepted_by_persistence: false };
  const move = reading.pnl_pct - ref.pnl_pct;
  if (Math.abs(move) <= HELD_READING_SLACK_PP) return { ref: fresh(), plausible: true, reason: null, accepted_by_persistence: false };

  const rb = finNum(ref.bin), b = finNum(reading.bin), bs = Number(binStep);
  let reason = null;
  if (rb == null || b == null || !(bs > 0)) {
    reason = "active bin or bin step unknown — the PnL move cannot be checked against the price";
  } else if (move > 0) {
    const rose = Math.max(0, b - rb);
    const explained = Math.max(0, 100 + ref.pnl_pct) * (Math.pow(1 + bs / 1e4, rose) - 1);
    if (move > explained + HELD_READING_SLACK_PP) {
      reason = `PnL ${ref.pnl_pct.toFixed(2)}% → ${reading.pnl_pct.toFixed(2)}% while the price moved ${rose} bins up (explains at most ${explained.toFixed(1)} pp)`;
    }
  } else {
    const explained = maxExplainedDropPp(ref.pnl_pct, rb - b, bs);
    if (-move > explained + HELD_READING_SLACK_PP) {
      const fell = rb - b;
      reason = `PnL ${ref.pnl_pct.toFixed(2)}% → ${reading.pnl_pct.toFixed(2)}% while the price moved ${fell >= 0 ? `${fell} bins down` : `${-fell} bins up`} (explains at most ${explained.toFixed(1)} pp)`;
    }
  }
  if (!reason) return { ref: fresh(), plausible: true, reason: null, accepted_by_persistence: false };

  const since = ref.unexplained_since ?? nowMs;
  if (nowMs - since >= HELD_READING_PERSIST_MS) return { ref: fresh(), plausible: true, reason, accepted_by_persistence: true };
  return { ref: { ...ref, unexplained_since: since, seen_at: nowMs }, plausible: false, reason, accepted_by_persistence: false };
}

/**
 * Guard for the record-only trackers. true = feed them. Unusable readings pass without touching
 * the ref (the trackers' own gates skip them); without a bin step the move cannot be judged, so
 * the guard stays out of the way; any throw lets the reading through.
 */
function heldReadingPlausible(p, tracked, deps) {
  try {
    if (p.pnl_management_ready === false || p.pnl_pct_suspicious === true) return true;
    const pnl = finNum(p.pnl_pct);
    if (pnl == null) return true;
    const binStep = finNum(p.bin_step) ?? finNum(tracked?.bin_step);
    if (!(binStep > 0)) return true;
    const prev = _heldReadingRefs.get(p.position) ?? null;
    const r = advanceHeldReadingRef(prev, { pnl_pct: pnl, bin: p.active_bin }, binStep, Date.now());
    _heldReadingRefs.set(p.position, r.ref);
    if (!r.plausible && r.ref.unexplained_since != null && prev?.unexplained_since == null) {
      deps.log("state_warn", `[HOLD_READING] ${p.pair}: ${r.reason} — not used for the held high or the path extremes (a deposit or withdrawal Meteora has not indexed yet?)`);
    } else if (r.accepted_by_persistence) {
      deps.log("state_warn", `[HOLD_READING] ${p.pair}: ${r.reason} — still standing after 15 min, accepted`);
    }
    return r.plausible;
  } catch {
    return true;
  }
}

/**
 * Hold-cohort visibility (audit 01 §4.3): no rule touches a held position, but the operator
 * is told when it has given back another 10 pp from its held high.
 */
function holdGiveBackAlert(p, tracked, cfg, deps) {
  const { evaluateHoldGiveBack, noteHoldGiveBackAlert, sendHTML, log, tagPair, escapeHTML, fmtPct } = deps;
  try {
    const gb = evaluateHoldGiveBack(tracked, p.pnl_pct, cfg);
    if (gb.alert) {
      noteHoldGiveBackAlert(p.position, gb.level_pp);
      const amt = Number(tracked.amount_sol) || 0;
      const giveBackSol = amt > 0 ? (gb.drop_pp / 100) * amt : null;
      const solText = giveBackSol != null ? `, ≈◎${giveBackSol.toFixed(3)} unrealised` : "";
      log("hold_giveback", `[HOLD_GIVEBACK] ${p.pair}: peak ${gb.peak.toFixed(2)}% → now ${gb.current.toFixed(2)}% (−${gb.drop_pp.toFixed(1)} pp${solText}) — held position, no rule fires`);
      sendHTML(
        `🧊 <b>Held position giving back</b>\n${tagPair(escapeHTML(p.pair), tracked)}: peak ${fmtPct(gb.peak)} → now ${fmtPct(gb.current)} (−${gb.drop_pp.toFixed(1)} pp${solText}).\nHold mode is yours — the bot will not close it. /unset hands it back to the rules.`
      ).catch(() => {});
    } else if (gb.reset) {
      noteHoldGiveBackAlert(p.position, 0);
    }
  } catch (e) {
    log("hold_giveback_warn", `[HOLD_GIVEBACK] ${p.pair}: ${e.message}`);
  }
}

/** Shadow: would a hold that keeps the stop loss have closed this position? (+ Alert B) */
function holdDownsideShadow(p, tracked, cfg, deps) {
  const { evaluateHoldDownside, noteHoldDownsideShadow, getTrackedPosition, holdDownsideAlertText, sendHTML, log, fmtPct } = deps;
  try {
    if (p.pnl_management_ready !== false && p.pnl_pct_suspicious !== true) {
      const hv = evaluateHoldDownside(tracked, p.pnl_pct, cfg);
      if (noteHoldDownsideShadow(p.position, hv, p.pnl_pct)) {
        const heldMin = getTrackedPosition(p.position)?.hold_downside_shadow?.held_minutes_at_fire;
        log("hold_downside_shadow", `[HOLD_DOWNSIDE_SHADOW] would-close ${p.pair}: ${hv.rule === "young_stop" ? "young-token stop" : "stop loss"} ${fmtPct(hv.pnl_pct)} <= ${hv.threshold_pct}%${heldMin != null ? ` (${heldMin} min into the hold)` : ""} — held, nothing closed (holdDownsideMode=${cfg.holdDownsideMode ?? "shadow"})`);
        // Alert B: same once-per-hold latch (hold_downside_shadow) — tell the operator too.
        if (cfg.holdDownsideAlertEnabled !== false) {
          sendHTML(holdDownsideAlertText({ pair: p.pair, verdict: hv, heldMin, tracked, mgmt: cfg, owner: tracked })).catch(() => {});
        }
      }
    }
  } catch (e) {
    log("hold_giveback_warn", `[HOLD_DOWNSIDE_SHADOW] ${p.pair}: ${e.message}`);
  }
}
