/**
 * Thin-pool hold limit (2026-10-11, operator: "Please make the thin pool -25% close too,
 * along with the telegram alerts."). A position that is ON HOLD, in a pool whose TVL at
 * entry was under the thin-pool bar ($100k), is closed (remainder sold to SOL) once its PnL
 * on capital is confirmed at or under the limit (−25 %). With the TVL exit
 * (tvl-floor-exit.js) it is one of the two rules that close a held position, so a wrong
 * reading must never fire it.
 *
 * Leaf module (imports only rule-mode.js, tvl-floor-exit.js and capital-rebase.js, all leaves): the pure decision pieces, shared by state.js (streak on the
 * position), index.js (PnL poller hold branch + management-cycle hold block) and
 * hold-override.js (the HOLD-guard authorisation both rules use).
 *
 * Why a bad reading cannot fire it:
 *   1. a reading is used only when the valuation is management-ready, not flagged
 *      suspicious, SOL-basis, a finite number, and no in-place capital flow is pending
 *      (`holdThinLimitReading`); anything else neither counts nor resets;
 *   2. held positions keep no valuation-jump reference (index.js forgetValuationReference),
 *      so the rule keeps its own: the last usable reading ABOVE the limit. A streak can only
 *      START on a reading whose drop from that reference the price move explains — a
 *      SOL-quoted position cannot lose more than the price fell (an unindexed withdrawal /
 *      re-range shows a large drop at an unchanged bin: tOpenAI-SOL 09-29 read −49 % with
 *      the bin rising). An unexplained drop is ignored until the bin move explains it or the
 *      reading returns above the limit; it is never accepted just because it persisted;
 *   3. the level must then hold on >= 2 distinct valuations AND for >= confirmSec (60 s),
 *      every usable reading in between at or under the limit — one reading above resets;
 *      a pause longer than HOLD_THIN_LIMIT_MAX_GAP_MS starts over.
 */

import { modeFor } from "./rule-mode.js";
import { tvlFloorExitConfig } from "./tvl-floor-exit.js";
import { avgCostBasisPnlPct, AVG_COST_BASIS_MIN_SOL, effectiveAvgCostBasis } from "./capital-rebase.js";

export const HOLD_THIN_LIMIT_MODES = ["off", "shadow", "enforce"];
export const HOLD_THIN_LIMIT_DEFAULT_PCT = -25;
/**
 * A fixed default, deliberately NOT tied to screening `minTvl`: moving the bot's entry bar
 * must not silently move the level at which a held position is closed.
 */
export const HOLD_THIN_POOL_DEFAULT_TVL_USD = 100_000;
export const HOLD_THIN_LIMIT_DEFAULT_CONFIRM_SEC = 60;
/** Shortest confirmation a config value may set; anything under it reads as the default. */
export const HOLD_THIN_LIMIT_MIN_CONFIRM_SEC = 15;
export const HOLD_THIN_LIMIT_MIN_VALUATIONS = 2;
/**
 * An unchanged valuation counts as a second one only after this long (two ~15 s refresh
 * cycles; same rule as valuationReconfirmSec / HOLD_PEAK_RECONFIRM_MS) — a quiet pool
 * returns the identical valuation for minutes.
 */
export const HOLD_THIN_LIMIT_RECONFIRM_MS = 30_000;
/** No usable reading for longer than this (poller paused, feed outage, restart) starts the streak over. */
export const HOLD_THIN_LIMIT_MAX_GAP_MS = 3 * 60_000;
/** Slack on the "price move explains the drop" test (fees, rounding, valuation noise). */
export const HOLD_THIN_LIMIT_PLAUSIBILITY_SLACK_PP = 5;
export const HOLD_LIMIT_HOLD_OVERRIDE = "hold_limit";

const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function holdThinLimitConfig(mgmt = {}) {
  // Absent = enforce (the operator asked for it live); a present but unknown value is a typo
  // and must not enforce by accident.
  const mode = modeFor("holdThinPoolLimitMode", mgmt?.holdThinPoolLimitMode);
  const pct = Number(mgmt?.holdThinPoolLimitPct);
  const tvl = Number(mgmt?.holdThinPoolTvlUsd);
  const sec = Number(mgmt?.holdThinPoolLimitConfirmSec);
  return {
    mode,
    // A limit must be a loss: 0 or a positive value would close every held thin-pool position.
    limitPct: mgmt?.holdThinPoolLimitPct != null && Number.isFinite(pct) && pct < 0 ? pct : HOLD_THIN_LIMIT_DEFAULT_PCT,
    tvlUsd: mgmt?.holdThinPoolTvlUsd != null && Number.isFinite(tvl) && tvl > 0 ? tvl : HOLD_THIN_POOL_DEFAULT_TVL_USD,
    confirmSec: mgmt?.holdThinPoolLimitConfirmSec != null && Number.isFinite(sec) && sec >= HOLD_THIN_LIMIT_MIN_CONFIRM_SEC
      ? sec : HOLD_THIN_LIMIT_DEFAULT_CONFIRM_SEC,
  };
}

/**
 * Was the pool thin when the position was entered? Only the position's recorded `entry_tvl`
 * counts, and only as a real number > 0 and under the bar. Unknown / missing / coerced →
 * NOT thin (the rule and the alerts then never apply — fail closed).
 */
export function thinPoolEntry(pos, cfg) {
  const c = cfg && cfg.tvlUsd ? cfg : holdThinLimitConfig(cfg);
  const tvl = fin(pos?.entry_tvl);
  if (tvl == null || !(tvl > 0)) return { thin: false, entry_tvl_usd: null };
  return { thin: tvl < c.tvlUsd, entry_tvl_usd: tvl };
}

/**
 * Fields every open position carries for the dashboard card (position scan + dashboard-report
 * doc; the dashboard codes to exactly these names). `tracked` is the tracked position.
 */
export function holdThinLimitCardFields(tracked, mgmt = {}) {
  const cfg = holdThinLimitConfig(mgmt);
  const entry = thinPoolEntry(tracked, cfg);
  return {
    thin_pool: entry.thin,
    entry_tvl_usd: entry.entry_tvl_usd,
    hold_thin_limit_exempt: tracked?.hold_thin_limit_exempt === true,
    hold_thin_limit_pct: cfg.limitPct,
    hold_thin_limit_mode: cfg.mode,
  };
}

/** POST /command/set-thin-limit-exempt body → { ok, position, exempt } or { ok:false, error } (400). */
export function parseThinLimitExemptBody(body) {
  const position = typeof body?.position === "string" ? body.position.trim() : "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(position)) {
    return { ok: false, error: "Missing or malformed `position` (base58 address expected)" };
  }
  if (typeof body.exempt !== "boolean") return { ok: false, error: "`exempt` must be a boolean" };
  return { ok: true, position, exempt: body.exempt };
}

/**
 * May the operator's exemption switch be used on this position? null = yes; otherwise the
 * HTTP status and message: 404 unknown / closed, 409 not on hold, 409 not a thin-pool position.
 */
export function thinLimitExemptRefusal(tracked, mgmt = {}) {
  if (!tracked || tracked.closed) return { status: 404, error: "Position is not open in the bot" };
  if (tracked.hold_mode !== true) return { status: 409, error: "Position is not on hold — the thin-pool hold limit only applies to held positions" };
  const cfg = holdThinLimitConfig(mgmt);
  const entry = thinPoolEntry(tracked, cfg);
  if (!entry.thin) {
    return {
      status: 409,
      error: entry.entry_tvl_usd == null
        ? "Position is not a thin-pool position — its pool TVL at entry is unknown, so the limit never applies to it"
        : `Position is not a thin-pool position — pool TVL at entry $${Math.round(entry.entry_tvl_usd).toLocaleString("en-US")} is at or above the $${Math.round(cfg.tvlUsd).toLocaleString("en-US")} bar`,
    };
  }
  return null;
}

/** Is the average-cost reading switched on (management.holdThinPoolAvgCostBasis, default true)? */
export function avgCostBasisEnabled(mgmt = {}) {
  const v = mgmt?.holdThinPoolAvgCostBasis;
  return !(v === false || v === "false");
}

/** The position's recorded average-cost basis (capital-rebase.js nextAvgCostBasis), or null. */
export function avgCostBasisOf(tracked) {
  const b = tracked?.avg_cost_basis;
  const v = b && typeof b === "object" ? fin(b.basis_sol) : null;
  return v != null && v >= AVG_COST_BASIS_MIN_SOL ? v : null;
}

/**
 * The figure the limit reads for one row (2026-11-26): the plain `pnl_pct`, or — when a cost
 * basis applies (stored, or PROVISIONAL while a capital change is pending; capital-rebase.js
 * effectiveAvgCostBasis) and the key is on — the PnL on the cost of what is left, whichever is
 * HIGHER. It never reads lower than the plain percent.
 * Returns { ok, pnl_pct, raw_pnl_pct, adjusted, basis_sol, provisional, dual, adj_ok, reason? }:
 *   ok      — the plain figure is usable (false only when pnl_pct itself is not a number)
 *   dual    — a basis applies: the limit runs two machines (advanceHoldThinLimitDual)
 *   adj_ok  — the cost-basis figure could be computed for this row; when false (no pnl_sol_rule,
 *             unknown capital, a provisional basis whose guards fail) the cost-basis machine
 *             skips the row and the plain machine is fed as before
 */
export function holdThinLimitPnl(p, tracked = null, mgmt = {}) {
  const raw = fin(p?.pnl_pct);
  const out = (o) => ({ provisional: false, dual: false, adj_ok: false, basis_sol: null, adjusted: false, ...o });
  if (raw == null) return out({ ok: false, pnl_pct: null, raw_pnl_pct: null, reason: "pnl is not a finite number" });
  if (!avgCostBasisEnabled(mgmt)) return out({ ok: true, pnl_pct: raw, raw_pnl_pct: raw, basis_sol: avgCostBasisOf(tracked) });
  const pnlSol = fin(p?.pnl_sol_rule);
  const eff = effectiveAvgCostBasis(tracked, pnlSol);
  if (!eff.applies) return out({ ok: true, pnl_pct: raw, raw_pnl_pct: raw });
  const base = { ok: true, raw_pnl_pct: raw, dual: true, provisional: eff.provisional === true, basis_sol: eff.basis_sol ?? null };
  if (!eff.ok) return out({ ...base, pnl_pct: raw, reason: eff.reason });
  const capital = fin(tracked?.amount_sol);
  if (pnlSol == null) return out({ ...base, pnl_pct: raw, reason: "cost basis applies but the valuation has no SOL PnL (pnl_sol_rule)" });
  if (capital == null || !(capital > 0)) return out({ ...base, pnl_pct: raw, reason: "cost basis applies but the tracked capital is unknown" });
  const adj = avgCostBasisPnlPct(eff.basis_sol, capital, pnlSol);
  if (adj == null) return out({ ...base, pnl_pct: raw, reason: "cost-basis PnL could not be computed" });
  const r = Math.round(adj * 100) / 100;
  return out({ ...base, adj_ok: true, pnl_pct: r > raw ? r : raw, adjusted: r > raw });
}

/**
 * Turn one scan row of a held position into a reading. `pnl_pct` is the SOL-basis percent on
 * the capital — the field the stop loss reads — or, when a cost basis applies, the higher
 * cost-basis figure (holdThinLimitPnl). Not usable → { ok:false, reason }. The valuation `key`
 * is built from the raw row. A pending capital change no longer blocks the reading: the
 * cost-basis machine reads a provisional basis (2026-11-26, round 4).
 */
export function holdThinLimitReading(p, tracked = null, mgmt = {}) {
  if (!p || typeof p !== "object") return { ok: false, reason: "no valuation" };
  if (p.pnl_management_ready === false) return { ok: false, reason: "valuation not management-ready" };
  if (p.pnl_pct_suspicious === true) return { ok: false, reason: "valuation flagged suspicious" };
  if (p.flow_pending === true || tracked?.pending_flow) return { ok: false, reason: "capital flow pending" };
  if (p.pnl_basis != null && p.pnl_basis !== "sol") return { ok: false, reason: `pnl basis is ${p.pnl_basis}` };
  const pnl = fin(p.pnl_pct);
  if (pnl == null) return { ok: false, reason: "pnl is not a finite number" };
  const fig = holdThinLimitPnl(p, tracked, mgmt);
  const bin = fin(p.active_bin);
  return {
    ok: true, pnl_pct: fig.pnl_pct, raw_pnl_pct: pnl, adjusted: fig.adjusted, basis_sol: fig.basis_sol,
    // dual: a basis applies (stored or provisional, key on) -> two machines, ready only when both are.
    dual: fig.dual === true, adj_ok: fig.adj_ok === true, provisional: fig.provisional === true,
    ...(fig.dual && !fig.adj_ok ? { adj_reason: fig.reason } : {}),
    bin, key: `${pnl}|${bin ?? ""}|${p.total_value_usd ?? ""}`,
  };
}

/**
 * Card fields beside holdThinLimitCardFields (scan row + dashboard-report doc). Display only:
 *   hold_thin_limit_pnl_pct — the figure the limit reads now (the provisional one while a
 *                             capital change is pending); null when not held / not thin / no
 *                             basis applies / it cannot be computed for this row
 *   avg_cost_basis_sol      — the stored basis, or null
 */
export function avgCostBasisCardFields(tracked, row = {}, mgmt = {}) {
  const basis = avgCostBasisOf(tracked);
  let limitPct = null;
  if (tracked?.hold_mode === true && thinPoolEntry(tracked, holdThinLimitConfig(mgmt)).thin) {
    const fig = holdThinLimitPnl(row, tracked, mgmt);
    limitPct = fig.dual && fig.adj_ok ? fig.pnl_pct : null;
  }
  return { hold_thin_limit_pnl_pct: limitPct, avg_cost_basis_sol: basis };
}

/**
 * Largest PnL drop (pp of capital) a price fall of `binsFell` bins can explain, for a position
 * worth (100 + refPnl) % of its capital: all of it in the base token is the worst case.
 */
export function maxExplainedDropPp(refPnlPct, binsFell, binStep) {
  const bs = Number(binStep);
  if (!(binsFell > 0) || !(bs > 0)) return 0;
  const value = Math.max(0, 100 + Number(refPnlPct));
  return value * (1 - Math.pow(1 + bs / 1e4, -binsFell));
}

/**
 * May a streak start on this at/under-limit reading? With no reference (the first usable
 * reading of the hold was already under the limit) there is nothing to compare → yes.
 * With one, the active bins and the bin step must be known and the price fall must explain
 * the drop; otherwise the reading is left out.
 */
export function crossingIsPlausible(ref, reading, binStep) {
  if (!ref) return { ok: true };
  const drop = Number(ref.pnl_pct) - reading.pnl_pct;
  if (!(drop > HOLD_THIN_LIMIT_PLAUSIBILITY_SLACK_PP)) return { ok: true };
  const rb = fin(ref.bin), b = fin(reading.bin);
  if (rb == null || b == null || !(Number(binStep) > 0)) return { ok: false, reason: "active bin or bin step unknown — the drop cannot be checked against the price" };
  const fell = rb - b;
  const max = maxExplainedDropPp(ref.pnl_pct, fell, binStep);
  if (drop > max + HOLD_THIN_LIMIT_PLAUSIBILITY_SLACK_PP) {
    return { ok: false, reason: `PnL fell ${drop.toFixed(1)} pp (${Number(ref.pnl_pct).toFixed(2)}% → ${reading.pnl_pct.toFixed(2)}%) while the price moved ${fell >= 0 ? `${fell} bins down` : `${-fell} bins up`} (explains at most ${max.toFixed(1)} pp)` };
  }
  return { ok: true };
}

/**
 * Advance a held position's limit state with one reading. Pure.
 * @param {object|null} prev   stored state { ref, streak } or null
 *   ref    — last usable reading above the limit { pnl_pct, bin, at }
 *   streak — { count, first_at, last_at, counted_at, last_key, first_pnl_pct, last_pnl_pct, worst_pnl_pct, … }
 * @returns {{ state: object|null, event: string, ready: boolean, held_sec: number, changed: boolean, reason?: string }}
 *   event: ignored | above | reset | implausible | started | restarted | counted | repeat
 */
export function advanceHoldThinLimit(prev, reading, cfg, { binStep = null, nowMs = Date.now() } = {}) {
  const c = cfg && cfg.limitPct ? cfg : holdThinLimitConfig(cfg);
  const st = prev && typeof prev === "object" ? prev : null;
  const ref = st?.ref ?? null;
  const streak = st?.streak && Number(st.streak.count) > 0 ? st.streak : null;
  const heldSec = (s) => (s ? Math.max(0, (nowMs - new Date(s.first_at).getTime()) / 1000) : 0);

  // Unusable reading: neither counts nor resets. It can never complete a streak.
  if (reading?.ok !== true || fin(reading.pnl_pct) == null) {
    return { state: st, event: "ignored", ready: false, held_sec: heldSec(streak), changed: false, reason: reading?.reason };
  }
  const pnl = reading.pnl_pct;
  const nowIso = new Date(nowMs).toISOString();

  if (pnl > c.limitPct) {
    // Above the limit: this is the reference the next crossing is judged against. Rewritten
    // only when it moved (bin, 0.25 pp) or aged a minute, so a quiet hold does not write every tick.
    const refAt = ref ? new Date(ref.at).getTime() : NaN;
    const moved = !ref || ref.bin !== reading.bin || Math.abs(Number(ref.pnl_pct) - pnl) >= 0.25 || !(nowMs - refAt < 60_000);
    if (!streak && !moved) return { state: st, event: "above", ready: false, held_sec: 0, changed: false };
    const next = { ref: moved ? { pnl_pct: pnl, bin: reading.bin, at: nowIso } : ref, streak: null };
    return { state: next, event: streak ? "reset" : "above", ready: false, held_sec: 0, changed: true };
  }

  const lastMs = streak ? new Date(streak.last_at).getTime() : NaN;
  const stale = !!streak && (!Number.isFinite(lastMs) || nowMs - lastMs > HOLD_THIN_LIMIT_MAX_GAP_MS || nowMs < lastMs);
  if (!streak || stale) {
    const plausible = crossingIsPlausible(ref, reading, binStep);
    if (!plausible.ok) {
      const next = stale ? { ref, streak: null } : st;
      return { state: next, event: "implausible", ready: false, held_sec: 0, changed: stale, reason: plausible.reason };
    }
    const fresh = {
      count: 1, first_at: nowIso, last_at: nowIso, counted_at: nowIso, last_key: reading.key,
      first_pnl_pct: pnl, last_pnl_pct: pnl, worst_pnl_pct: pnl,
    };
    return { state: { ref, streak: fresh }, event: stale ? "restarted" : "started", ready: false, held_sec: 0, changed: true };
  }

  const countedMs = new Date(streak.counted_at).getTime();
  const distinct = reading.key !== streak.last_key || !(nowMs - countedMs < HOLD_THIN_LIMIT_RECONFIRM_MS);
  const next = {
    ...streak,
    last_at: nowIso,
    last_pnl_pct: pnl,
    worst_pnl_pct: Math.min(Number(streak.worst_pnl_pct), pnl),
    ...(distinct ? { count: streak.count + 1, counted_at: nowIso, last_key: reading.key } : {}),
  };
  const ready = next.count >= HOLD_THIN_LIMIT_MIN_VALUATIONS && heldSec(next) >= c.confirmSec;
  return { state: { ref, streak: next }, event: distinct ? "counted" : "repeat", ready, held_sec: heldSec(next), changed: true };
}

/**
 * One reading through the limit (2026-11-26). Without a basis (or the key off) this is exactly
 * advanceHoldThinLimit on `prev` — the same state, no `adj` key (a stale `adj` from an earlier
 * basis is dropped). With a basis TWO machines run on the same reading: the plain one on
 * `raw_pnl_pct`, stored where it always was (`ref` / `streak`, so hold-override.js and every
 * existing reader are untouched), and the cost-basis one on the limit figure (`adj` =
 * { ref, streak }). The rule is ready only when BOTH are ready on this reading, so it never
 * closes on a step where the plain machine alone would not (an unexplained plain drop stays
 * implausible on the plain machine whatever the cost-basis figure does). Pure.
 * Returns { state, event, ready, held_sec, changed, reason?, plain, adj, dual, plain_only_ready }:
 *   plain / adj — each machine's own result (adj null when single)
 *   event / held_sec / reason — the cost-basis machine's when dual (it drives the logs), else plain's
 *   plain_only_ready — dual, the plain machine is ready and the cost-basis one is not
 */
export function advanceHoldThinLimitDual(prev, reading, cfg, opts = {}) {
  const st = prev && typeof prev === "object" ? prev : null;
  const { adj: adjPrev, ...plainOnly } = st || {};
  const plainPrev = st ? plainOnly : null;
  if (reading?.ok !== true) {
    // Unusable: neither counts nor resets either machine (state returned unchanged, adj included).
    const r = advanceHoldThinLimit(st, reading, cfg, opts);
    return { ...r, plain: r, adj: null, dual: false, plain_only_ready: false };
  }
  if (reading.dual !== true) {
    const hadAdj = st != null && Object.prototype.hasOwnProperty.call(st, "adj");
    const r = advanceHoldThinLimit(hadAdj ? plainPrev : st, reading, cfg, opts);
    return { ...r, changed: r.changed || hadAdj, plain: r, adj: null, dual: false, plain_only_ready: false };
  }
  const p = advanceHoldThinLimit(plainPrev, { ...reading, pnl_pct: reading.raw_pnl_pct }, cfg, opts);
  // No cost-basis figure for this row (no pnl_sol_rule, guards): the cost-basis machine skips it
  // (neither counts nor resets) and cannot be ready on it; the plain machine was fed as before.
  const a = reading.adj_ok === false
    ? advanceHoldThinLimit(adjPrev ?? null, { ok: false, reason: reading.adj_reason || "no cost-basis figure for this reading" }, cfg, opts)
    : advanceHoldThinLimit(adjPrev ?? null, reading, cfg, opts);
  const state = { ...(p.state ?? { ref: null, streak: null }), adj: a.state ?? { ref: null, streak: null } };
  return {
    state,
    event: a.event,
    ready: p.ready === true && a.ready === true,
    held_sec: a.held_sec,
    changed: p.changed || a.changed || !st || !Object.prototype.hasOwnProperty.call(st, "adj"),
    reason: a.reason,
    plain: p,
    adj: a,
    dual: true,
    plain_only_ready: p.ready === true && a.ready !== true,
  };
}

const usd = (v) => `$${Math.round(Number(v)).toLocaleString("en-US")}`;
const pct = (v) => `${Number(v).toFixed(1)}%`;

/**
 * Canonical close reason. `exitFamilyFromReason` keys on the "Thin-pool hold limit" prefix.
 * The wording avoids "floor" and "below" on purpose: legacy substring scans (pool-memory.js,
 * lessons.js, hivemind.js) read "oor" / "below" in a close reason as an out-of-range close.
 */
export function holdThinLimitReason({ pnlPct, heldSec, entryTvlUsd, cfg, rawPnlPct = null, adjusted = false }) {
  const figure = adjusted && fin(rawPnlPct) != null
    ? `PnL ${pct(pnlPct)} on the cost basis of what is left after a partial withdrawal (${pct(rawPnlPct)} on net capital)`
    : `PnL ${pct(pnlPct)}`;
  return `Thin-pool hold limit: ${figure} at or under ${cfg.limitPct}% for ${Math.round(heldSec)}s on a held position` +
    ` (pool TVL at entry ${usd(entryTvlUsd)}, under ${usd(cfg.tvlUsd)}) — hard exit (overrides HOLD)`;
}

/** The exit object, same shape the single evaluator emits (see finalizeExit in state.js). */
export function buildHoldThinLimitExit({ pnlPct, heldSec, entryTvlUsd, cfg, rawPnlPct = null, adjusted = false }) {
  return {
    action: "HOLD_THIN_LIMIT",
    rule: "hold_limit",
    family: "hold_limit",
    urgent: true, // a collapsing thin pool only gets worse: no exit-swap guard, no slippage cap, no pre-close claim
    confirm_ticks: 1, // the rule carries its own confirmation (2 valuations, confirmSec)
    hold_override: HOLD_LIMIT_HOLD_OVERRIDE,
    reason: holdThinLimitReason({ pnlPct, heldSec, entryTvlUsd, cfg, rawPnlPct, adjusted }),
  };
}

/**
 * Why the one-off adoption warning applies (2026-11-24): the pool was thin at entry (under
 * the hold-limit bar), and/or already under the TVL exit's minimum — the TVL exit closes ANY
 * position, held or not, once that is confirmed (three operator positions opened under $10k
 * were closed 7–18 min later). Same fail-closed entry-TVL reading as thinPoolEntry.
 * Independent of holdThinPoolLimitMode (the warning describes the modes, it is not gated on them).
 */
export function thinPoolAdoptionWarning(pos, mgmt = {}) {
  const entry = thinPoolEntry(pos, holdThinLimitConfig(mgmt));
  const tvlExit = tvlFloorExitConfig(mgmt);
  const underTvlExitFloor = entry.entry_tvl_usd != null && entry.entry_tvl_usd < tvlExit.floorUsd;
  return { thin: entry.thin, under_tvl_exit_floor: underTvlExitFloor, tvl_exit_mode: tvlExit.mode, entry_tvl_usd: entry.entry_tvl_usd };
}

/**
 * Alert A: should the one-off adoption warning go out for this adopted position? Operator
 * positions only (a recovered bot deploy is not one), entry TVL known and either under the
 * thin-pool bar or under the TVL-exit minimum (with the TVL exit not off), not warned before.
 */
export function shouldWarnThinPoolAdoption(pos, mgmt = {}) {
  if (!pos || pos.closed) return false;
  if (mgmt?.adoptThinPoolWarnEnabled === false) return false;
  if (pos.adopted !== true || String(pos.strategy_source || "").startsWith("bot_")) return false;
  if (pos.thin_pool_adopt_warned_at) return false;
  const w = thinPoolAdoptionWarning(pos, mgmt);
  return w.thin || (w.under_tvl_exit_floor && w.tvl_exit_mode !== "off");
}
