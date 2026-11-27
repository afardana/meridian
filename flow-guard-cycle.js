/**
 * Flow guard in the management cycle (flow-guard.js, 2026-11-27) — the I/O around the pure
 * rule, with every dependency injected (index.js passes the real ones; tests pass fakes).
 *
 *   prefetchFlowGuardInputs(positionData, deps)  once per cycle, before the exit loop:
 *       one Jupiter datapi read per distinct base mint (armed positions always; the shadow's
 *       positions only while all mints together are ≤ FLOW_SHADOW_MAX_MINTS), and one fresh
 *       on-chain active-bin read per ARMED position (the sell-pressure cross-check).
 *   checkFlowGuard(p, inputs, deps)              per position in the exit loop → exit | null
 *   runFlowGuardShadow(p, inputs, deps)          per position, log only (default params, not armed)
 *
 * Failure isolation: every function catches; a throw or a failed read closes nothing, never
 * blocks the cycle and never touches another rule. Log lines for a repeated cause are rate-
 * limited to once per 10 min.
 */
import {
  FLOW_SHADOW_MAX_MINTS, FLOW_START_ALERT_INTERVAL_MS, flowGuardMintOf, flowGuardShadowMode,
  storedFlowGuardParams, buildFlowGuardExit, conditionsText, FLOW_GUARD_DEFAULT_PARAMS,
} from "./flow-guard.js";

const LOG_ONCE_MS = 10 * 60_000;
const _logOnce = new Map(); // key -> last ms

function logOnce(deps, key, cat, msg, nowMs) {
  const last = _logOnce.get(key) || 0;
  if (nowMs - last < LOG_ONCE_MS) return;
  _logOnce.set(key, nowMs);
  deps.log(cat, msg);
}

/** Forget the rate-limit memory (tests). */
export function resetFlowGuardLogMemory() {
  _logOnce.clear();
}

const EMPTY = () => ({ assets: new Map(), chain: new Map(), shadowSkipped: false });

export async function prefetchFlowGuardInputs(positionData, deps) {
  const nowMs = deps.nowMs ?? Date.now();
  const out = EMPTY();
  try {
    const shadowOn = flowGuardShadowMode(deps.mgmt) !== "off";
    const armed = [], shadow = [];
    for (const p of positionData || []) {
      const tracked = deps.getTrackedPosition(p.position);
      if (!tracked || tracked.closed) continue;
      const mint = flowGuardMintOf(tracked, p);
      if (!mint) continue;
      if (tracked.flow_guard?.armed_at) armed.push({ p, mint });
      else if (shadowOn) shadow.push({ p, mint });
    }
    const armedMints = new Set(armed.map((x) => x.mint));
    const allMints = new Set([...armedMints, ...shadow.map((x) => x.mint)]);
    let toRead = armedMints;
    if (allMints.size <= FLOW_SHADOW_MAX_MINTS) toRead = allMints;
    else if (shadow.length) {
      out.shadowSkipped = true;
      logOnce(deps, "shadow:budget", "flow_guard", `[FLOW_GUARD_SHADOW] ${allMints.size} distinct base mints (> ${FLOW_SHADOW_MAX_MINTS}) — shadow skipped this cycle; armed guards still read`, nowMs);
    }
    await Promise.all([...toRead].map(async (mint) => {
      try { out.assets.set(mint, await deps.fetchAsset(mint)); }
      catch (e) { out.assets.set(mint, { ok: false, reason: `read failed: ${e.message}`, at: new Date(nowMs).toISOString(), mint }); }
    }));
    await Promise.all(armed.map(async ({ p }) => {
      try { out.chain.set(p.position, await deps.readActiveBin(p.pool)); }
      catch (e) { out.chain.set(p.position, { ok: false, reason: `on-chain read failed: ${e.message}` }); }
    }));
  } catch (e) {
    logOnce(deps, "prefetch:error", "flow_guard_warn", `[FLOW_GUARD] prefetch failed, nothing read this cycle (${e.message})`, nowMs);
  }
  return out;
}

function poolTvlOf(p) {
  return p?.tvl_floor_reading?.ok === true ? p.tvl_floor_reading.tvl_usd : null;
}

/** Meteora's holder count of the pool row the cycle fetched (index.js: flow_pool_holders). */
function meteoraHoldersOf(p) {
  const v = p?.flow_pool_holders;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * One armed position. Returns the exit object (fired) or null.
 * deps: getTrackedPosition, noteFlowGuardReading, noteFlowGuardMark, recordFlowReading,
 *       gmgnFor(mint), handsOffActive, log, sendHTML, tagPair, escapeHTML, ownerOf, fmtPct, nowMs
 */
export function checkFlowGuard(p, inputs, deps) {
  const nowMs = deps.nowMs ?? Date.now();
  try {
    const tracked = deps.getTrackedPosition(p.position);
    if (!tracked || tracked.closed || !tracked.flow_guard?.armed_at) return null;
    const params = storedFlowGuardParams(tracked.flow_guard);
    const mint = flowGuardMintOf(tracked, p);
    const reading = mint ? (inputs?.assets?.get(mint) ?? { ok: false, reason: "not read this cycle" }) : { ok: false, reason: "no readable base mint" };
    const input = {
      reading,
      gmgn: params?.use_gmgn && mint ? (deps.gmgnFor?.(mint) ?? null) : null,
      meteora_holders: meteoraHoldersOf(p),
      chain: inputs?.chain?.get(p.position) ?? { ok: false, reason: "active bin not read this cycle" },
      pool_tvl_usd: poolTvlOf(p),
    };
    const res = deps.noteFlowGuardReading(p.position, input, nowMs);
    if (!res) return null;
    const pair = p.pair || tracked.pool_name || p.position;
    const need = params?.confirm_readings ?? FLOW_GUARD_DEFAULT_PARAMS.confirm_readings;
    const s = res.guard?.streak;
    if (res.usable && res.event !== "merged") {
      try { deps.recordFlowReading({ position: p.position, pool: p.pool, kind: "armed", reading, conditions: res.qualified }); } catch { /* capture only */ }
    }
    if (res.event === "off") {
      logOnce(deps, `${p.position}:off`, "flow_guard_warn", `[FLOW_GUARD] ${pair}: stored params are not valid — guard inactive until re-armed`, nowMs);
      return null;
    }
    const cond = () => conditionsText(res.qualified, res.figures, params);
    if (res.event === "started" || res.event === "restarted") {
      deps.log("flow_guard", `[FLOW_GUARD] ${pair}: ${cond()} — reading 1/${need}${res.event === "restarted" ? " (streak restarted after a gap)" : ""}`);
      const lastAlert = Date.parse(res.guard?.start_alerted_at || "");
      if (!(Number.isFinite(lastAlert) && nowMs - lastAlert < FLOW_START_ALERT_INTERVAL_MS)) {
        deps.noteFlowGuardMark(p.position, { start_alerted_at: new Date(nowMs).toISOString() });
        deps.sendHTML(
          `⚠️ <b>Flow guard counting</b> — ${deps.tagPair(deps.escapeHTML(pair), deps.ownerOf(p))}: ${deps.escapeHTML(cond())}, reading 1/${need}\n` +
          `<i>Closes after ${need} readings over ≥ ${params.confirm_minutes} min with a second source agreeing. ` +
          `Disarm: POST /command/set-flow-guard {"position": "${deps.escapeHTML(p.position)}", "arm": false}</i>`,
        );
      }
    } else if (res.event === "counted" && !res.ready) {
      deps.log("flow_guard", `[FLOW_GUARD] ${pair}: ${cond()} — reading ${s?.count}/${need} over ${Math.round(res.span_min)}m`);
    } else if (res.event === "reset") {
      deps.log("flow_guard", `[FLOW_GUARD] ${pair}: usable reading with no condition met — streak cleared`);
    } else if (res.event === "ignored" && s) {
      logOnce(deps, `${p.position}:ignored:${res.reason}`, "flow_guard", `[FLOW_GUARD] ${pair}: no usable reading this cycle (${res.reason}) — streak ${s.count}/${need} kept, not advanced`, nowMs);
    } else if (res.event === "ignored") {
      logOnce(deps, `${p.position}:ignored:${res.reason}`, "flow_guard", `[FLOW_GUARD] ${pair}: no usable reading this cycle (${res.reason})`, nowMs);
    }
    if (!res.ready) return null;
    if (!res.fire) {
      if (s && !s.unconfirmed_logged_at) {
        deps.noteFlowGuardMark(p.position, { unconfirmed_logged_at: new Date(nowMs).toISOString() }, { onStreak: true });
        deps.log("flow_guard", `[FLOW_GUARD] ${pair}: ${s.count} qualifying readings over ${Math.round(res.span_min)}m, but no second source confirms (${JSON.stringify(res.cross?.details ?? {})}) — not closing, re-checked next cycle`);
      }
      return null;
    }
    const exit = buildFlowGuardExit({ conditions: res.qualified, figures: res.figures, params, cross: res.cross?.details, readings: s.count, spanMin: res.span_min });
    const held = tracked.hold_mode === true;
    const handsOff = held && deps.handsOffActive?.(tracked) === true;
    deps.log("flow_guard", `[FLOW_GUARD] ${pair}: ${exit.reason} — confirmed by ${res.cross.confirmed.join(", ")}; pnl ${deps.fmtPct(p.pnl_pct)}; closing${held ? " a HELD position" : ""}${handsOff ? " (hands-off overridden: operator-armed)" : ""}`);
    if (!s.fire_alerted_at) {
      deps.noteFlowGuardMark(p.position, { fire_alerted_at: new Date(nowMs).toISOString() }, { onStreak: true });
      deps.sendHTML(
        `🛡 <b>Flow guard — closing${held ? " (HOLD overridden)" : ""}${handsOff ? " (hands-off overridden)" : ""}</b>\n` +
        `${deps.tagPair(deps.escapeHTML(pair), deps.ownerOf(p))}: ${deps.escapeHTML(exit.reason)}\n` +
        `PnL ${deps.escapeHTML(deps.fmtPct(p.pnl_pct))}. Closing now and selling the remainder to SOL.\n` +
        `<i>Armed by the operator ${deps.escapeHTML(String(tracked.flow_guard.armed_at))}.</i>`,
      );
    }
    return exit;
  } catch (e) {
    logOnce(deps, `${p?.position}:error:${e.message}`, "flow_guard_warn", `[FLOW_GUARD] ${p?.pair}: check failed, nothing closed (${e.message})`, nowMs);
    return null;
  }
}

/**
 * Shadow, LOG ONLY: the default thresholds on a position that is NOT armed. The pool-price
 * cross-check uses the scan row's active bin when the row carries the lbPair's bin step (read
 * from chain in that scan); no extra RPC read. Never closes anything.
 */
export function runFlowGuardShadow(p, inputs, deps) {
  const nowMs = deps.nowMs ?? Date.now();
  try {
    if (flowGuardShadowMode(deps.mgmt) === "off") return null;
    const tracked = deps.getTrackedPosition(p.position);
    if (!tracked || tracked.closed || tracked.flow_guard?.armed_at) return null;
    const mint = flowGuardMintOf(tracked, p);
    if (!mint) return null;
    const reading = inputs?.assets?.get(mint);
    if (!reading) return null; // not read this cycle (budget) — the shadow state is left alone
    const bs = Number(p.bin_step), ab = Number(p.active_bin);
    const chain = p.bin_step != null && p.active_bin != null && bs > 0 && Number.isFinite(ab)
      ? { ok: true, active_bin: ab, bin_step: bs }
      : { ok: false, reason: "scan row has no fresh active bin" };
    const trusted = p.pnl_management_ready !== false && p.pnl_pct_suspicious !== true;
    const pnl = trusted && typeof p.pnl_pct === "number" && Number.isFinite(p.pnl_pct) ? p.pnl_pct : null;
    const input = { reading, gmgn: null, meteora_holders: meteoraHoldersOf(p), chain, pool_tvl_usd: poolTvlOf(p) };
    const out = deps.noteFlowGuardShadowReading(p.position, input, { pnl_pct: pnl, amount_sol: tracked.amount_sol ?? null }, nowMs);
    if (!out) return null;
    if (out.res?.usable && out.event !== "merged") {
      try { deps.recordFlowReading({ position: p.position, pool: p.pool, kind: "shadow", reading, conditions: out.res.qualified }); } catch { /* capture only */ }
    }
    if (out.first) {
      const pair = p.pair || tracked.pool_name || p.position;
      deps.log("flow_guard_shadow", `[FLOW_GUARD_SHADOW] would-close ${pair}: ${conditionsText(out.res.qualified, out.res.figures, FLOW_GUARD_DEFAULT_PARAMS, out.res.cross?.details)} on ${out.record?.readings} readings — pnl ${pnl == null ? "n/a" : deps.fmtPct(pnl)}, nothing closed (flowGuardShadowMode=shadow)`);
    }
    return out;
  } catch (e) {
    logOnce(deps, `${p?.position}:shadow:${e.message}`, "flow_guard_warn", `[FLOW_GUARD_SHADOW] ${p?.pair}: ${e.message}`, nowMs);
    return null;
  }
}
