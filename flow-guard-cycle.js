/**
 * Flow guard in the management cycle (flow-guard.js, 2026-11-27) — the I/O around the pure
 * rule, with every dependency injected (index.js passes the real ones; tests pass fakes).
 *
 *   prefetchArmedFlowGuardInputs(positionData, deps)  awaited by the cycle before the exit loop,
 *       ONLY for armed positions and only while flowGuardMode=armed: one Jupiter read per
 *       distinct base mint + one active-bin read per armed position, the whole prefetch bounded
 *       at FLOW_PREFETCH_BOUND_MS (each read itself ≤ 3 s). Nothing armed → no request, no wait.
 *   checkFlowGuard(p, inputs, deps)                   per position in the exit loop → exit | null
 *   runFlowGuardShadowDetached(positionData, deps)    NOT awaited by the cycle: log-only shadow on
 *       the positions that are not armed (default params), after the exit decisions.
 *
 * Failure isolation: every function catches; a throw, a timeout or a failed read closes nothing,
 * never blocks the cycle and never touches another rule. Repeated causes log once per 10 min.
 */
import {
  FLOW_SHADOW_MAX_MINTS, FLOW_START_ALERT_INTERVAL_MS, FLOW_BLIND_REPEAT_MS, flowGuardMintOf, flowGuardShadowMode, flowGuardMode,
  storedFlowGuardParams, buildFlowGuardExit, conditionText, FLOW_GUARD_DEFAULT_PARAMS,
} from "./flow-guard.js";

export const FLOW_PREFETCH_BOUND_MS = 4_000;
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

/** Run `tasks` (key → () => Promise) in parallel; whatever has not settled after `boundMs` gets `onTimeout(key)`. */
async function boundedAll(tasks, boundMs, onTimeout) {
  const out = new Map();
  let timer = null;
  const all = Promise.all([...tasks].map(async ([key, fn]) => {
    try { out.set(key, await fn()); } catch (e) { out.set(key, { ok: false, reason: `read failed: ${e.message}` }); }
  }));
  await Promise.race([all, new Promise((resolve) => { timer = setTimeout(resolve, boundMs); })]);
  if (timer) clearTimeout(timer);
  const done = new Map(out); // a read that settles later is ignored (snapshot of the bound)
  for (const [key] of tasks) if (!done.has(key)) done.set(key, onTimeout(key));
  return done;
}

const timedOut = (nowMs) => (key) => ({ ok: false, reason: `timed out (flow guard prefetch bound ${FLOW_PREFETCH_BOUND_MS} ms)`, at: new Date(nowMs).toISOString(), mint: key });

/** The armed positions' inputs. Empty maps (and no request) when nothing is armed or the mode is off. */
export async function prefetchArmedFlowGuardInputs(positionData, deps) {
  const nowMs = deps.nowMs ?? Date.now();
  const out = { assets: new Map(), chain: new Map() };
  try {
    if (flowGuardMode(deps.mgmt) !== "armed") return out;
    const armed = [];
    for (const p of positionData || []) {
      const tracked = deps.getTrackedPosition(p.position);
      if (!tracked || tracked.closed || !tracked.flow_guard?.armed_at) continue;
      const mint = flowGuardMintOf(tracked, p);
      if (mint) armed.push({ p, mint });
    }
    if (!armed.length) return out;
    const tasks = new Map();
    for (const { mint } of armed) tasks.set(`a:${mint}`, () => deps.fetchAsset(mint));
    for (const { p } of armed) tasks.set(`c:${p.position}`, () => deps.readActiveBin(p.pool));
    const res = await boundedAll(tasks, deps.boundMs ?? FLOW_PREFETCH_BOUND_MS, timedOut(nowMs));
    for (const [k, v] of res) {
      if (k.startsWith("a:")) out.assets.set(k.slice(2), v);
      else out.chain.set(k.slice(2), v);
    }
  } catch (e) {
    logOnce(deps, "prefetch:error", "flow_guard_warn", `[FLOW_GUARD] prefetch failed, nothing read this cycle (${e.message})`, nowMs);
  }
  return out;
}

function poolTvlOf(p) {
  return p?.tvl_floor_reading?.ok === true ? p.tvl_floor_reading.tvl_usd : null;
}

/**
 * The position's own USD value for the market-liquidity figures: trusted only when the row's
 * valuation is valid (pnl_quality absent or "valid") and no own capital flow is pending.
 */
export function ownValueOf(p, tracked) {
  const v = p?.total_value_true_usd;
  const trusted = typeof v === "number" && Number.isFinite(v) && v >= 0 &&
    (p.pnl_quality == null || p.pnl_quality === "valid") &&
    !tracked?.pending_flow && !tracked?.capital_rebase_pending && p.flow_pending !== true;
  return { usd: trusted ? v : null, trusted };
}

function inputFor(p, tracked, reading, chain) {
  return { reading, chain, pool_tvl_usd: poolTvlOf(p), own: ownValueOf(p, tracked) };
}

/**
 * One armed position. Returns the exit object (fired) or null.
 * deps: mgmt, getTrackedPosition, noteFlowGuardReading, noteFlowGuardMark, recordFlowReading,
 *       handsOffActive, log, sendHTML, tagPair, escapeHTML, ownerOf, fmtPct, nowMs
 */
export function checkFlowGuard(p, inputs, deps) {
  const nowMs = deps.nowMs ?? Date.now();
  try {
    const tracked = deps.getTrackedPosition(p.position);
    if (!tracked || tracked.closed || !tracked.flow_guard?.armed_at) return null;
    const pair = p.pair || tracked.pool_name || p.position;
    if (flowGuardMode(deps.mgmt) !== "armed") {
      logOnce(deps, `${p.position}:mode_off`, "flow_guard", `[FLOW_GUARD] ${pair}: flowGuardMode=${deps.mgmt?.flowGuardMode ?? "?"} — armed guard not evaluated (kill switch)`, nowMs);
      return null;
    }
    const params = storedFlowGuardParams(tracked.flow_guard);
    const mint = flowGuardMintOf(tracked, p);
    const reading = mint ? (inputs?.assets?.get(mint) ?? { ok: false, reason: "not read this cycle" }) : { ok: false, reason: "no readable base mint" };
    const chain = inputs?.chain?.get(p.position) ?? { ok: false, reason: "active bin not read this cycle" };
    const res = deps.noteFlowGuardReading(p.position, inputFor(p, tracked, reading, chain), nowMs);
    if (!res) return null;
    const g = res.guard;
    const need = params?.confirm_readings ?? FLOW_GUARD_DEFAULT_PARAMS.confirm_readings;
    if (res.counted) {
      try { deps.recordFlowReading({ position: p.position, pool: p.pool, kind: "armed", reading, conditions: res.qualified }); } catch { /* capture only */ }
    }
    if (res.event === "off") {
      logOnce(deps, `${p.position}:off`, "flow_guard_warn", `[FLOW_GUARD] ${pair}: stored params are not valid — guard inactive until re-armed`, nowMs);
      return null;
    }
    if (res.event === "ignored" || res.event === "stale") {
      logOnce(deps, `${p.position}:${res.event}:${String(res.reason).slice(0, 40)}`, "flow_guard", `[FLOW_GUARD] ${pair}: reading not counted (${res.reason}) — streaks kept, not advanced`, nowMs);
    }
    // Blindness: no counted reading for 30 min → one alert, repeated at most hourly; recovery once.
    if (g.blind_since) {
      const lastBlind = Date.parse(g.blind_alerted_at || "");
      if (!(Number.isFinite(lastBlind) && nowMs - lastBlind < FLOW_BLIND_REPEAT_MS)) {
        const mins = Math.round((nowMs - Date.parse(g.blind_since)) / 60_000);
        deps.noteFlowGuardMark(p.position, { blind_alerted_at: new Date(nowMs).toISOString() });
        deps.log("flow_guard", `[FLOW_GUARD] ${pair}: blind — no usable reading for ${mins} min (${g.last?.reason || res.reason || "unknown"})`);
        deps.sendHTML(`⚠️ <b>Flow guard blind</b> — ${deps.tagPair(deps.escapeHTML(pair), deps.ownerOf(p))}: no usable reading for ${mins} min (${deps.escapeHTML(g.last?.reason || res.reason || "unknown")})`);
      }
    } else if (res.counted && g.blind_alerted_at) {
      deps.noteFlowGuardMark(p.position, { blind_alerted_at: null });
      deps.log("flow_guard", `[FLOW_GUARD] ${pair}: reading again`);
      deps.sendHTML(`✅ <b>Flow guard reading again</b> — ${deps.tagPair(deps.escapeHTML(pair), deps.ownerOf(p))}`);
    }
    if (res.suspended_now) {
      deps.log("flow_guard", `[FLOW_GUARD] ${pair}: own position value rose > 20 % since the last counted reading (top-up) — liquidity condition suspended until ${g.liquidity_suspended_until}`);
    }
    const txt = (c) => conditionText(c, res.figures, params, g.peak, res.cross?.[c]);
    for (const c of res.started) {
      const s = g.streaks[c];
      deps.log("flow_guard", `[FLOW_GUARD] ${pair}: ${txt(c)} — reading 1/${need}${s?.restarted ? " (streak restarted after a gap)" : ""}`);
      const lastAlert = Date.parse(g.start_alerted_at || "");
      if (!(Number.isFinite(lastAlert) && nowMs - lastAlert < FLOW_START_ALERT_INTERVAL_MS)) {
        deps.noteFlowGuardMark(p.position, { start_alerted_at: new Date(nowMs).toISOString() });
        deps.sendHTML(
          `⚠️ <b>Flow guard counting</b> — ${deps.tagPair(deps.escapeHTML(pair), deps.ownerOf(p))}: ${deps.escapeHTML(txt(c))}, reading 1/${need}\n` +
          `<i>Closes after ${need} distinct readings of this condition over ≥ ${params.confirm_minutes} min, corroborated. ` +
          `Disarm: POST /command/set-flow-guard {"position": "${deps.escapeHTML(p.position)}", "arm": false}</i>`,
        );
      }
    }
    for (const c of res.advanced) {
      if (!res.ready.includes(c)) deps.log("flow_guard", `[FLOW_GUARD] ${pair}: ${txt(c)} — reading ${g.streaks[c]?.count}/${need}`);
    }
    for (const c of res.reset) deps.log("flow_guard", `[FLOW_GUARD] ${pair}: ${c.replace("_", " ")} no longer met on a counted reading — that streak cleared`);
    if (!res.fire) {
      for (const c of res.ready) {
        logOnce(deps, `${p.position}:uncorr:${c}:${g.streaks[c]?.first_at}`, "flow_guard",
          `[FLOW_GUARD] ${pair}: ${c.replace("_", " ")} on ${g.streaks[c]?.count} readings, but not corroborated (${JSON.stringify(res.cross[c])}) — not closing, re-checked next cycle`, nowMs);
      }
      return null;
    }
    const c = res.fired_condition;
    const s = g.streaks[c];
    const exit = buildFlowGuardExit({ condition: c, figures: res.figures, params, peak: g.peak, corroboration: res.cross[c], readings: s.count, spanMin: g.fire?.span_min ?? 0 });
    const held = tracked.hold_mode === true;
    const handsOff = held && deps.handsOffActive?.(tracked) === true;
    deps.log("flow_guard", `[FLOW_GUARD] ${pair}: ${exit.reason} — corroborated (${JSON.stringify(res.cross[c])}); pnl ${deps.fmtPct(p.pnl_pct)}; closing${held ? " a HELD position" : ""}${handsOff ? " (hands-off overridden: operator-armed)" : ""}`);
    const alertKey = `${c}:${s.first_at}`;
    if (g.fire_alerted_for !== alertKey) {
      deps.noteFlowGuardMark(p.position, { fire_alerted_for: alertKey });
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
 * Shadow, LOG ONLY, for one position with its reading: the default thresholds; the on-chain
 * ring is fed from the scan row's active bin when the row carries the lbPair's bin step (read
 * from chain in that scan) — no extra RPC read. Never closes anything.
 */
export function runFlowGuardShadow(p, reading, deps) {
  const nowMs = deps.nowMs ?? Date.now();
  try {
    if (flowGuardShadowMode(deps.mgmt) === "off" || !reading) return null;
    const tracked = deps.getTrackedPosition(p.position);
    if (!tracked || tracked.closed || tracked.flow_guard?.armed_at) return null;
    const bs = Number(p.bin_step), ab = Number(p.active_bin);
    const chain = p.bin_step != null && p.active_bin != null && bs > 0 && Number.isFinite(ab)
      ? { ok: true, active_bin: ab, bin_step: bs, at: new Date(nowMs).toISOString() }
      : { ok: false, reason: "scan row has no fresh active bin" };
    const trusted = p.pnl_management_ready !== false && p.pnl_pct_suspicious !== true;
    const pnl = trusted && typeof p.pnl_pct === "number" && Number.isFinite(p.pnl_pct) ? p.pnl_pct : null;
    const out = deps.noteFlowGuardShadowReading(p.position, inputFor(p, tracked, reading, chain), { pnl_pct: pnl, amount_sol: tracked.amount_sol ?? null }, nowMs);
    if (!out) return null;
    if (out.res?.counted) {
      try { deps.recordFlowReading({ position: p.position, pool: p.pool, kind: "shadow", reading, conditions: out.res.qualified }); } catch { /* capture only */ }
    }
    if (out.first) {
      const pair = p.pair || tracked.pool_name || p.position;
      const c = out.res.fired_condition;
      deps.log("flow_guard_shadow", `[FLOW_GUARD_SHADOW] would-close ${pair}: ${conditionText(c, out.res.figures, FLOW_GUARD_DEFAULT_PARAMS, out.state.peak, out.res.cross?.[c])} on ${out.record?.readings} readings — pnl ${pnl == null ? "n/a" : deps.fmtPct(pnl)}, nothing closed (flowGuardShadowMode=shadow)`);
    }
    return out;
  } catch (e) {
    logOnce(deps, `${p?.position}:shadow:${e.message}`, "flow_guard_warn", `[FLOW_GUARD_SHADOW] ${p?.pair}: ${e.message}`, nowMs);
    return null;
  }
}

/**
 * The shadow for the whole cycle, detached (the caller does `void` it): reads the non-armed
 * positions' base mints (≤ FLOW_SHADOW_MAX_MINTS distinct, else skipped; bounded like the armed
 * prefetch — the 60 s token cache serves a mint the armed prefetch already read), then evaluates
 * each. Shadow off or nothing to shadow → no request.
 */
export async function runFlowGuardShadowDetached(positionData, deps) {
  const nowMs = deps.nowMs ?? Date.now();
  try {
    if (flowGuardShadowMode(deps.mgmt) === "off") return { skipped: "off" };
    const rows = [];
    for (const p of positionData || []) {
      const tracked = deps.getTrackedPosition(p.position);
      if (!tracked || tracked.closed || tracked.flow_guard?.armed_at) continue;
      const mint = flowGuardMintOf(tracked, p);
      if (mint) rows.push({ p, mint });
    }
    if (!rows.length) return { skipped: "nothing" };
    const mints = new Set(rows.map((x) => x.mint));
    if (mints.size > FLOW_SHADOW_MAX_MINTS) {
      logOnce(deps, "shadow:budget", "flow_guard", `[FLOW_GUARD_SHADOW] ${mints.size} distinct base mints (> ${FLOW_SHADOW_MAX_MINTS}) — shadow skipped this cycle`, nowMs);
      return { skipped: "budget" };
    }
    const tasks = new Map([...mints].map((m) => [m, () => deps.fetchAsset(m)]));
    const assets = await boundedAll(tasks, deps.boundMs ?? FLOW_PREFETCH_BOUND_MS, timedOut(nowMs));
    for (const { p, mint } of rows) runFlowGuardShadow(p, assets.get(mint), deps);
    return { evaluated: rows.length };
  } catch (e) {
    logOnce(deps, "shadow:error", "flow_guard_warn", `[FLOW_GUARD_SHADOW] detached run failed (${e.message})`, nowMs);
    return { error: e.message };
  }
}
