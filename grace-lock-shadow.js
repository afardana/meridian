/**
 * Grace profit lock — LOG ONLY (2026-11-24, operator go-ahead for the forward capture;
 * docs/experiments/grace-profit-lock.md). Inside a profit grace (the adoption window or a
 * straddle's `profit_grace_until`) no profit rule runs and, with profitGraceStopLossMode
 * "paused", no stop either, so a position that ran far inside the grace can give it all back
 * before any rule looks (SATPAD-SOL, Mimi-SOL: past +10 % inside the grace, closed near −27 %).
 * The replay of 09-26 → 11-23 was insufficient by one fire (14 of 15); this module grades the
 * same rule forward on clean data.
 *
 * The rule, exactly as registered (primary variant only): while a grace is active, on the
 * trusted reading stream the grace counterfactual already uses (index.js feedGraceShadow):
 *   - an own in-grace confirmed peak, reset at the grace start to the first reading; a new peak
 *     needs TWO consecutive distinct readings above it and takes the lower of them
 *     (grace-shadow.confirmPeakStep, state.confirmPeak's rule);
 *   - armed once that peak ≥ A (`graceLockShadowArmPct`, 10);
 *   - fires on the SECOND consecutive distinct reading at or under peak − D
 *     (`graceLockShadowDropPct`, 5); the would-close pnl is that reading. No overshoot shortcut.
 * "Distinct" = (pnl, active bin) differs from the previous reading fed in — the replay's
 * definition; a repeat neither confirms nor resets, so the 5 s poller's unchanged valuations
 * and a management-cycle reading of the same valuation count once.
 * The first fire is kept and nothing more is simulated for the position (in the counterfactual
 * it is closed — also no later grace). A grace that ends without a fire is overwritten by a
 * later grace's fresh simulation. HOLD while a simulation is open and unfired marks it
 * `interrupted: "hold"` and stops it (the grader excludes it).
 *
 * Nothing here changes a grace, a peak, a stop or an exit: it writes `grace_lock_shadow` only.
 * Leaf module: grace-release-shadow.js (graceWindow), grace-shadow.js (confirmPeakStep),
 * rule-mode.js — no state.js import.
 */
import { graceWindow } from "./grace-release-shadow.js";
import { confirmPeakStep } from "./grace-shadow.js";
import { modeFor } from "./rule-mode.js";

/** Readings that confirm a new peak and that fire the lock (registered rule; not a config key). */
export const GRACE_LOCK_CONFIRM_READINGS = 2;
export const GRACE_LOCK_DEFAULT_ARM_PCT = 10;
export const GRACE_LOCK_DEFAULT_DROP_PCT = 5;

const positive = (v, dflt) => (v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);

/** { mode: off | shadow (an unknown value reads as shadow — there is no enforce), armPct, dropPct }. */
export function graceLockShadowConfig(mgmt = {}) {
  return {
    mode: modeFor("graceLockShadowMode", mgmt?.graceLockShadowMode),
    armPct: positive(mgmt?.graceLockShadowArmPct, GRACE_LOCK_DEFAULT_ARM_PCT),
    dropPct: positive(mgmt?.graceLockShadowDropPct, GRACE_LOCK_DEFAULT_DROP_PCT),
  };
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;
const round1 = (v) => Math.round(Number(v) * 10) / 10;
const iso = (ms) => new Date(ms).toISOString();
const NONE = Object.freeze({ changed: false, event: null });

function freshRecord(window, cfg, nowMs) {
  return {
    kind: window.kind,
    started_at: iso(window.start_ms),
    arm_pct: cfg.armPct,
    drop_pct: cfg.dropPct,
    peak_pct: null, peak_at: null,
    armed_at: null,
    fired_at: null, fire_pnl_pct: null, fire_peak_pct: null, fire_threshold_pct: null, minutes_into_grace: null,
    ended_by: null, ended_at: null, end_pct: null,
    interrupted: null, interrupted_at: null,
    readings: 0, first_at: null, last_pct: null, last_at: null,
    sim_last_key: null, sim_pending_pct: null, sim_pending_count: 0,
    sim_breach_count: 0, sim_first_breach_pct: null, sim_first_breach_at: null,
    created_at: iso(nowMs),
  };
}

const sameGrace = (s, window) => !!s && !!window && s.kind === window.kind && s.started_at === iso(window.start_ms);

/**
 * Feed one trusted reading (pnl on capital, SOL basis, and the active bin of the same reading).
 * Pure: mutates `pos.grace_lock_shadow` only. Returns { changed, event } with event
 * "started" | "restarted" | "fired" | "interrupted" | null.
 */
export function advanceGraceLockShadow(pos, { pnlPct, activeBin = null, nowMs = Date.now(), mgmt = {} } = {}) {
  const cfg = graceLockShadowConfig(mgmt);
  if (!pos || pos.closed || cfg.mode === "off") return NONE;
  const prev = pos.grace_lock_shadow && typeof pos.grace_lock_shadow === "object" ? pos.grace_lock_shadow : null;
  if (prev?.fired_at) return NONE; // first fire kept: closed in the counterfactual
  if (pos.hold_mode === true) {
    return interruptGraceLockShadow(pos, { nowMs, mgmt }) ? { changed: true, event: "interrupted" } : NONE;
  }
  const pnl = Number(pnlPct);
  if (pnlPct == null || !Number.isFinite(pnl)) return NONE;
  const window = graceWindow(pos, mgmt, nowMs);
  if (!window) return NONE;

  let s = prev;
  let event = null;
  if (!sameGrace(s, window)) {
    event = s ? "restarted" : "started"; // a new straddle (or adoption → straddle) starts a fresh simulation
    s = freshRecord(window, cfg, nowMs);
  } else if (s.ended_by || s.interrupted) {
    return NONE;
  } else {
    s = { ...s };
  }

  const bin = activeBin != null && Number.isFinite(Number(activeBin)) ? Number(activeBin) : null;
  const key = `${Math.round(pnl * 1e4) / 1e4}|${bin ?? ""}`;
  if (s.sim_last_key === key) return NONE; // not distinct: neither confirms nor resets
  const now = iso(nowMs);
  s.sim_last_key = key;
  s.readings = (Number(s.readings) || 0) + 1;
  s.last_pct = round2(pnl); s.last_at = now;

  if (s.peak_pct == null) {
    // the grace's first reading is its starting peak (after a capital reset: the first one after it)
    s.peak_pct = round2(pnl); s.peak_at = now; s.first_at = s.first_at ?? now;
  } else {
    const c = confirmPeakStep({ peak: s.peak_pct, pending: s.sim_pending_pct, count: s.sim_pending_count }, pnl, GRACE_LOCK_CONFIRM_READINGS);
    s.sim_pending_pct = c.pending; s.sim_pending_count = c.count;
    if (c.raised) { s.peak_pct = round2(c.peak); s.peak_at = now; }
  }
  if (!s.armed_at && s.peak_pct >= s.arm_pct) s.armed_at = now;

  if (s.armed_at) {
    const threshold = s.peak_pct - s.drop_pct;
    if (pnl <= threshold) {
      s.sim_breach_count = (Number(s.sim_breach_count) || 0) + 1;
      if (s.sim_breach_count === 1) { s.sim_first_breach_pct = round2(pnl); s.sim_first_breach_at = now; }
      if (s.sim_breach_count >= GRACE_LOCK_CONFIRM_READINGS) {
        s.fired_at = now;
        s.fire_pnl_pct = round2(pnl);
        s.fire_peak_pct = s.peak_pct;
        s.fire_threshold_pct = round2(threshold);
        s.minutes_into_grace = round1(Math.max(0, (nowMs - window.start_ms) / 60_000));
        event = "fired";
      }
    } else {
      s.sim_breach_count = 0; s.sim_first_breach_pct = null; s.sim_first_breach_at = null;
    }
  }
  pos.grace_lock_shadow = s;
  return { changed: true, event };
}

/**
 * HOLD set while a simulation of the CURRENT grace is open and unfired → `interrupted: "hold"`.
 * A grace with no record yet gets a stub marked interrupted, so readings after the release (same
 * grace, peak no longer reset at its start) are not simulated. Pure; true when it wrote.
 */
export function interruptGraceLockShadow(pos, { nowMs = Date.now(), mgmt = {} } = {}) {
  if (!pos || pos.closed || graceLockShadowConfig(mgmt).mode === "off") return false;
  const s = pos.grace_lock_shadow && typeof pos.grace_lock_shadow === "object" ? pos.grace_lock_shadow : null;
  if (s?.fired_at) return false;
  const window = graceWindow(pos, mgmt, nowMs);
  if (!window) return false; // no grace now: a hold after the grace changes nothing here
  if (sameGrace(s, window)) {
    if (s.ended_by || s.interrupted) return false;
    pos.grace_lock_shadow = { ...s, interrupted: "hold", interrupted_at: iso(nowMs) };
    return true;
  }
  pos.grace_lock_shadow = { ...freshRecord(window, graceLockShadowConfig(mgmt), nowMs), interrupted: "hold", interrupted_at: iso(nowMs) };
  return true;
}

/**
 * Stamp the grace end on the record of the grace that just ended (fired or not; not on an
 * interrupted one). `endedBy` "timer" | "release"; `endPct` the trusted reading at the end when
 * the caller has one, else the last reading fed in. Pure; true when it wrote. No log line.
 */
export function finishGraceLockShadow(pos, { endedBy, endPct = null, nowMs = Date.now() } = {}) {
  const s = pos?.grace_lock_shadow;
  if (!s || typeof s !== "object" || s.ended_by || s.interrupted) return false;
  const end = endPct != null && Number.isFinite(Number(endPct)) ? round2(endPct) : s.last_pct;
  pos.grace_lock_shadow = { ...s, ended_by: endedBy === "release" ? "release" : "timer", ended_at: iso(nowMs), end_pct: end ?? null };
  return true;
}

/** A fire stamped at most this long before a capital change is voided (the pre-index window). */
export const GRACE_SHADOW_CAPITAL_VOID_MS = 10 * 60_000;

const solTxt = (v) => (v != null && Number.isFinite(Number(v)) ? `◎${Number(v).toFixed(4)}` : "◎?");

/**
 * Capital change (2026-11-26): the operator topped up / partly withdrew and the reconciler
 * re-based the position's %-references (state.reconcileExternalCapital → capital-rebase.js). Until
 * Meteora indexes a top-up (~2–4 min) the valuation reads the deposit as profit, and the live path
 * trusts it while the divergence is under 50 pp, so this simulation's in-grace peak was built from
 * it: Pompom-SOL 5P3jAEQo (◎1.4998 → ◎2.0) "peak 34.71 %, fired at 1.06 %" and A1BM9YU7
 * (◎2.0 → ◎2.469) "peak 23.62 %, fired at 1.48 %" — both on the tick the re-base settled.
 *   - A fire stamped ≤ GRACE_SHADOW_CAPITAL_VOID_MS before the change is moved to `voided_fire`
 *     and cleared; an older fire stands (the simulation ended there) and nothing else moves.
 *   - An open simulation (not ended, not interrupted) is RESET: confirmed peak, pending-peak
 *     streak, armed flag, breach streak and last-reading key — the peak is re-seeded from the first
 *     reading fed after the re-base settled (state.noteGraceLockShadowReading feeds nothing while
 *     `capital_rebase_pending` is set). Kept: kind, started_at, readings, first / last reading.
 *     `capital_resets` counts these, `last_capital_reset_at` stamps the latest.
 * Known limit: a top-up under the reconciler's threshold (< ◎0.02 or < 5 % of the capital)
 * triggers no re-base, so a fake bump under ~5 pp can still enter the in-grace peak.
 * Mode off → nothing. Pure: mutates `pos.grace_lock_shadow` only. Returns { changed, voided, line }.
 */
export function resetGraceLockShadowForCapital(pos, { nowMs = Date.now(), fromSol = null, toSol = null, mgmt = {}, pair = null } = {}) {
  const out = { changed: false, voided: false, line: null };
  if (!pos || graceLockShadowConfig(mgmt).mode === "off") return out;
  const s0 = pos.grace_lock_shadow;
  if (!s0 || typeof s0 !== "object") return out;
  const s = { ...s0 };
  if (s.fired_at) {
    const firedMs = Date.parse(s.fired_at);
    const age = nowMs - firedMs;
    if (!(Number.isFinite(firedMs) && age <= GRACE_SHADOW_CAPITAL_VOID_MS && age >= -60_000)) return out; // an older fire stands
    s.voided_fire = {
      fired_at: s.fired_at, fire_pnl_pct: s.fire_pnl_pct, fire_peak_pct: s.fire_peak_pct, fire_threshold_pct: s.fire_threshold_pct,
      minutes_into_grace: s.minutes_into_grace, reason: "capital_rebase", voided_at: iso(nowMs),
      from_sol: fromSol != null && Number.isFinite(Number(fromSol)) ? Number(fromSol) : null,
      to_sol: toSol != null && Number.isFinite(Number(toSol)) ? Number(toSol) : null,
    };
    s.fired_at = null; s.fire_pnl_pct = null; s.fire_peak_pct = null; s.fire_threshold_pct = null; s.minutes_into_grace = null;
    out.voided = true;
    out.line = `[GRACE_LOCK_SHADOW] ${pair || pos.pool_name || pos.position || "?"}: fire voided — capital changed ${solTxt(fromSol)} → ${solTxt(toSol)} within 10 min of it (peak was on the old capital)`;
  }
  if (!s.ended_by && !s.interrupted) {
    s.peak_pct = null; s.peak_at = null; s.armed_at = null;
    s.sim_last_key = null; s.sim_pending_pct = null; s.sim_pending_count = 0;
    s.sim_breach_count = 0; s.sim_first_breach_pct = null; s.sim_first_breach_at = null;
    s.capital_resets = (Number(s.capital_resets) || 0) + 1;
    s.last_capital_reset_at = iso(nowMs);
  } else if (!out.voided) {
    return out;
  }
  pos.grace_lock_shadow = s;
  out.changed = true;
  return out;
}

/** The one `[GRACE_LOCK_SHADOW] would-close` line of a fired record. */
export function graceLockShadowLine(s, pair) {
  return `[GRACE_LOCK_SHADOW] would-close ${pair}: confirmed in-grace peak ${Number(s.fire_peak_pct).toFixed(2)}% ≥ ${Number(s.arm_pct)}% arm, ` +
    `pnl ${Number(s.fire_pnl_pct).toFixed(2)}% ≤ ${Number(s.fire_threshold_pct).toFixed(2)}% (peak − ${Number(s.drop_pct)} pp) ` +
    `at ${Math.floor(Number(s.minutes_into_grace) || 0)} min into the ${s.kind} grace (graceLockShadowMode=shadow)`;
}

/** Perf-record copy (perf-record.js buildPerfRecord). A grace still open at the close ends "close". */
export function graceLockShadowRecordField(pos, nowMs = Date.now()) {
  const s = pos?.grace_lock_shadow;
  if (!s || typeof s !== "object") return null;
  if (s.ended_by || s.interrupted) return { ...s };
  return { ...s, ended_by: "close", ended_at: iso(nowMs), end_pct: s.last_pct ?? null };
}
