// hold-observer.js — what the bot does with a reading of a position on HOLD (2026-11-05).
//
// A held position is skipped by the exit evaluator, but both the 5 s PnL poller and the
// 3-min management cycle feed its record-only trackers and the HOLD-overriding thin-pool
// limit. These are the two hold branches, moved out of index.js as they were (characterized
// by test/hold-observer.test.js before they are unified). Dependencies are injected: index.js
// passes the state functions, log, the Telegram sender and its own checkHoldThinLimit.

/**
 * PnL poller's hold branch (index.js, `if (operatorHold)` in the 5 s poll loop). Returns the
 * thin-pool hold-limit exit object, or null. The caller closes on an exit.
 */
export function observeHeldPositionPoller(p, { confirmTicks, deps }) {
  const { registerExitSignal, forgetValuationReference, noteHoldPeakReading, noteHoldPathReading, recordTick, checkHoldThinLimit } = deps;
  registerExitSignal(p.position, null, confirmTicks);
  forgetValuationReference(p.position);
  // Held high for the give-back alert only (no exit rule reads it).
  if (p.pnl_management_ready !== false && p.pnl_pct_suspicious !== true) {
    try { noteHoldPeakReading(p.position, p.pnl_pct); } catch { /* visibility only */ }
  }
  try { noteHoldPathReading(p.position, p); } catch { /* mfe / mae / max bins: record only */ }
  recordTick({ pool_address: p.pool, position_address: p.position, active_bin: p.active_bin, pnl_pct: p.pnl_pct, source: "poller" });
  // Thin-pool hold limit (hold-thin-limit.js): the one PnL rule that runs on a held
  // position. Pure decision on this tick's reading — no network call. Fires only on
  // its own 2-valuation / 60 s confirmation; the close passes the HOLD guards through
  // the stamp it writes (hold-override.js).
  const holdLimitExit = checkHoldThinLimit(p);
  return holdLimitExit || null;
}

/**
 * Management cycle, exit loop: the hold branch after the TVL-floor check (index.js). Returns
 * the thin-pool hold-limit exit object, or null.
 */
export function observeHeldPositionManagementExit(p, { deps }) {
  const { registerExitSignal, forgetValuationReference, log, checkHoldThinLimit } = deps;
  registerExitSignal(p.position, null, 1);
  forgetValuationReference(p.position);
  log("state", "Automatic exits suppressed for " + p.pair + ": operator HOLD is active");
  // Thin-pool hold limit — second caller (the 5 s poller is the first); same streak on the position.
  const holdLimitExit = checkHoldThinLimit(p);
  return holdLimitExit || null;
}

/**
 * Management cycle, action loop: the hold block before the CLAIM / STAY decision (index.js).
 * Held high, path extremes, give-back alert, downside shadow. Returns nothing.
 */
export function observeHeldPositionManagementAlerts(p, tracked, { cfg, deps }) {
  const {
    noteHoldPeakReading, noteHoldPathReading, evaluateHoldGiveBack, noteHoldGiveBackAlert,
    evaluateHoldDownside, noteHoldDownsideShadow, getTrackedPosition, holdDownsideAlertText,
    sendHTML, log, tagPair, escapeHTML, fmtPct,
  } = deps;
  // Hold-cohort visibility (audit 01 §4.3): no rule touches a held position, but the
  // operator is told when it has given back another 10 pp from its confirmed peak.
  try {
    // The reference follows the held high (peak_pnl_pct is frozen on HOLD); trusted readings only.
    if (p.pnl_management_ready !== false && p.pnl_pct_suspicious !== true) noteHoldPeakReading(p.position, p.pnl_pct);
    // Path extremes for the perf record keep moving on HOLD (record-only; same trust gate).
    noteHoldPathReading(p.position, p);
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
  // Shadow: would a hold that keeps the stop loss have closed this position?
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
