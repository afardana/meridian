// post-stop-cooldown.js — no new bot deploy into a POOL within H hours after a bot close of that
// pool with a stop-class exit (2026-11-08, "Rule A"), SHADOW by default.
//
// Replay (session scratchpad entryrules/, out_rules.md + out_followup.md; 398 bot deploys
// 09-26 → 11-08, sequential — a blocked deploy's own close does not re-trigger): with H = 24 h
// the rule blocks 24 deploys, Σ net −◎0.446 (90 % CI [−0.73, −0.18]), negative in both
// three-week periods (P1 17 / −◎0.226, P2 7 / −◎0.221); blocked winners Σ +◎0.06 vs losses
// avoided −◎0.51; 7 of 24 at ≤ −10 %. 12 h also passes (17, −◎0.247); 48 h fails on one +66 %
// outlier (CRAWL-SOL). Matching on the base mint instead of the pool adds only −◎0.023, so the
// rule keys on the POOL ADDRESS. Before this the only post-loss cooldown was the hard-coded 6 h
// when a pool's last 3 deploys average gas-negative (pool-memory.js).
//
// "Stop-class" = exit family stop_loss | rug | crash | probation_stop | young_stop (lessons.js
// exitFamilyOf — the caller passes it in as `familyOf`, this module stays a leaf). "Bot close" =
// a perf record that is not `adopted` and not a rebalance leg. The block runs from the latest
// such close of the pool to that close + H.
//
// postStopCooldownMode: off | shadow (default) | enforce (unknown → shadow).
// postStopCooldownHours 24 (min 1, max 72). Leaf module (imports rule-mode.js only).

import { modeFor } from "./rule-mode.js";

export const POST_STOP_FAMILIES = Object.freeze(["stop_loss", "rug", "crash", "probation_stop", "young_stop"]);
export const POST_STOP_COOLDOWN_MODES = Object.freeze(["off", "shadow", "enforce"]);
export const POST_STOP_DEFAULT_HOURS = 24;
export const POST_STOP_MIN_HOURS = 1;
export const POST_STOP_MAX_HOURS = 72;

const HOUR_MS = 3600_000;

export function isStopClassFamily(family) {
  return POST_STOP_FAMILIES.includes(String(family || ""));
}

/** Resolved settings: { mode, hours }. Unknown mode = shadow; hours clamped to [1, 72], unusable → 24. */
export function postStopCooldownConfig(screening = {}) {
  const mode = modeFor("postStopCooldownMode", screening?.postStopCooldownMode);
  const raw = screening?.postStopCooldownHours;
  const h = raw == null || raw === "" ? NaN : Number(raw);
  const hours = Number.isFinite(h) ? Math.min(POST_STOP_MAX_HOURS, Math.max(POST_STOP_MIN_HOURS, h)) : POST_STOP_DEFAULT_HOURS;
  return { mode, hours };
}

const isRebalanceLeg = (r) =>
  r?.rebalance_leg === true || r?.exit_family === "rebalance_leg" || /^rebalance(-failed)?:/i.test(String(r?.close_reason || ""));

const closedAtMs = (r) => {
  const t = r?.recorded_at ?? r?.closed_at;
  const ms = t ? new Date(t).getTime() : NaN;
  return Number.isFinite(ms) ? ms : NaN;
};

const resolveCfg = (cfg) => (cfg && cfg.mode && Number.isFinite(cfg.hours) ? cfg : postStopCooldownConfig(cfg || {}));

/**
 * The latest stop-class BOT close of `poolAddress` within the window, as
 * { closedAtMs, family, gapHours, untilMs } — null when there is none. Pure.
 * `familyOf(record)` defaults to the stored `exit_family`; callers pass lessons.js exitFamilyOf.
 */
export function postStopBlockingClose(records, poolAddress, nowMs = Date.now(), cfg = {}, { familyOf = (r) => r?.exit_family } = {}) {
  if (!poolAddress || !Array.isArray(records)) return null;
  const { hours } = resolveCfg(cfg);
  const windowMs = hours * HOUR_MS;
  let best = null;
  for (const r of records) {
    if (!r || r.pool !== poolAddress || r.adopted === true || isRebalanceLeg(r)) continue;
    const at = closedAtMs(r);
    if (!Number.isFinite(at) || at > nowMs || nowMs - at >= windowMs) continue;
    let family = null;
    try { family = familyOf(r); } catch { family = null; }
    if (!isStopClassFamily(family)) continue;
    if (!best || at > best.closedAtMs) best = { closedAtMs: at, family };
  }
  if (!best) return null;
  return { ...best, gapHours: (nowMs - best.closedAtMs) / HOUR_MS, untilMs: best.closedAtMs + windowMs };
}

/** ISO time until which the pool is blocked, or null. Pure. */
export function postStopBlockUntil(records, poolAddress, nowMs = Date.now(), cfg = {}, opts = {}) {
  const b = postStopBlockingClose(records, poolAddress, nowMs, cfg, opts);
  return b ? new Date(b.untilMs).toISOString() : null;
}

/** Funnel / refusal reason: `post-stop cooldown: stop_loss close 7.2h ago (24 h rule)`. Null without a blocking close. */
export function postStopRejectReason(records, poolAddress, nowMs = Date.now(), cfg = {}, opts = {}) {
  const b = postStopBlockingClose(records, poolAddress, nowMs, cfg, opts);
  return b ? postStopReasonFor(b, resolveCfg(cfg).hours) : null;
}

export function postStopReasonFor(blocking, hours) {
  return `post-stop cooldown: ${blocking.family} close ${blocking.gapHours.toFixed(1)}h ago (${hours} h rule)`;
}

/**
 * One verdict for the gates: { mode, hours, blockUntil, family, gapHours, wouldSkip, reason }.
 * `wouldSkip` is the rule's answer whatever the mode (the deploy tag); only enforce blocks.
 */
export function postStopVerdict(records, poolAddress, nowMs = Date.now(), screening = {}, opts = {}) {
  const cfg = postStopCooldownConfig(screening);
  const b = postStopBlockingClose(records, poolAddress, nowMs, cfg, opts);
  return {
    mode: cfg.mode,
    hours: cfg.hours,
    blockUntil: b ? new Date(b.untilMs).toISOString() : null,
    family: b ? b.family : null,
    gapHours: b ? b.gapHours : null,
    wouldSkip: !!b,
    reason: b ? postStopReasonFor(b, cfg.hours) : null,
  };
}
