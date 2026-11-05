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
// Dependencies are injected (index.js holdObserverDeps()): the state functions, log, the
// Telegram sender and formatters, and index.js's own checkHoldThinLimit.

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

  registerExitSignal(p.position, null, management ? 1 : confirmTicks);
  forgetValuationReference(p.position);
  if (management) log("state", "Automatic exits suppressed for " + p.pair + ": operator HOLD is active");

  // Held high for the give-back alert only (no exit rule reads it; peak_pnl_pct is frozen on HOLD).
  if (p.pnl_management_ready !== false && p.pnl_pct_suspicious !== true) {
    try { noteHoldPeakReading(p.position, p.pnl_pct); } catch { /* visibility only */ }
  }
  // Path extremes for the perf record keep moving on HOLD (record-only; noteHoldPathReading applies the same trust gate).
  try { noteHoldPathReading(p.position, p); } catch { /* mfe / mae / max bins: record only */ }
  if (!management) {
    recordTick({ pool_address: p.pool, position_address: p.position, active_bin: p.active_bin, pnl_pct: p.pnl_pct, source: "poller" });
  }

  // Thin-pool hold limit (hold-thin-limit.js): the one PnL rule that runs on a held
  // position. Pure decision on this reading — no network call. Fires only on its own
  // 2-valuation / 60 s confirmation; the close passes the HOLD guards through the stamp it
  // writes (hold-override.js).
  const holdLimitExit = checkHoldThinLimit(p);
  if (holdLimitExit) return holdLimitExit;

  if (management) {
    holdGiveBackAlert(p, tracked, cfg, deps);
    holdDownsideShadow(p, tracked, cfg, deps);
  }
  return null;
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
