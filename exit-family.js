// exit-family.js — close reason → exit family (leaf module, no imports).
//
// Moved verbatim from lessons.js (2026-11-25) so read-only tools that must not load the agent's
// stores (scripts/experiments/*) can use the same derivation; lessons.js re-exports both helpers,
// so every existing import keeps working.

/**
 * Explicit exit family (audit 01 §2, 2026-09-25). Every close reason the exit stack
 * emits has a canonical prefix, so the family is derived once, most-specific first,
 * and stored on the record as `exit_family`. The old keyword scan misfiled the
 * round-trip harvest as `oor_above` ("above"), toxic conversion and surge decay as
 * `low_yield` ("yield"), and ratchet/young-stop/rug/manual closes as `other`.
 */
const EXIT_FAMILY_RULES = [
  ["flow guard:", "flow_guard"], // flow-guard.js — operator-armed per-position flow stop; overrides HOLD and hands-off
  ["max hold:", "max_hold"], // max-hold.js — a bot position held maxHoldMinutes (shadow by default)
  ["tvl exit:", "tvl_floor"], // TVL-floor exit (tvl-floor-exit.js) — overrides HOLD
  ["thin-pool hold limit", "hold_limit"], // hold-thin-limit.js — a held thin-pool position at -25 %; overrides HOLD
  ["first-entry probation", "probation_stop"], // first-entry-probation.js — −8 % within 240 min of a pool's first entry
  ["young stop", "young_stop"],
  ["young-token stop", "young_stop"],
  ["stop loss", "stop_loss"],
  ["in-range rug", "rug"],
  ["crash-below", "crash"],
  ["crash", "crash"],
  ["round-trip complete", "harvest"],
  ["trailing tp", "trailing_tp"],
  ["trailing", "trailing_tp"],
  ["profit ratchet", "ratchet"],
  ["lineage take", "lineage_tp"],
  ["take profit", "take_profit"],
  ["toxic conversion", "toxic_conversion"],
  ["dynamic fee collapsed", "surge_decay"],
  ["yield collapsed", "surge_decay"],
  ["unfilled ladder", "oor_above_unfilled"],
  ["pumped far above", "oor_above"],
  ["pumped above", "oor_above"],
  ["oor (above)", "oor_above"],
  ["out of range above", "oor_above"],
  ["oor (below)", "oor_below"],
  ["out of range below", "oor_below"],
  ["low yield", "low_yield"],
  ["rebalance:", "rebalance_leg"],
  ["rebalance-failed", "rebalance_leg"],
  ["external close", "external"],
  ["auto-closed during discovery", "external"],
  ["manual close", "manual"],
  ["/close", "manual"],
  ["closeall", "manual"],
  ["agent decision", "llm"],
  ["volume", "volume_death"],
  ["below", "oor_below"],
  ["above", "oor_above"],
  ["out of range", "oor_other"],
  ["yield", "low_yield"],
];
export function exitFamilyFromReason(reason) {
  const r = String(reason || "").toLowerCase();
  for (const [needle, fam] of EXIT_FAMILY_RULES) if (r.includes(needle)) return fam;
  return "other";
}
export function exitFamilyOf(perf) {
  return perf?.exit_family || exitFamilyFromReason(perf?.close_reason);
}
