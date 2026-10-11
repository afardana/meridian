/**
 * Early grace release — LOG ONLY (2026-10-11). The operator proposed: "The grace should be
 * disabled every 10 minutes elapsed time when the last 3 candles are also positive." A replay
 * of 76 graces favoured the fixed 60-minute grace (+2.01 SOL vs −0.28 for that rule), so the
 * rule ships as a shadow to collect live data: while a position is inside a profit grace
 * (adoption window or a straddle's `profit_grace_until`), at each 10-minute mark of elapsed
 * grace time the last 3 COMPLETED 5-minute candles are read; if all three closed up, one
 * `[GRACE_RELEASE_SHADOW] would-release` line is logged and `grace_release_shadow` is stored
 * on the position (→ perf record) so it can be graded against what the grace then did.
 *
 * Nothing is released: no function here writes a grace field, and there is no enforce mode.
 * Leaf module (no imports) — the caller injects the candle fetch and the two state writers.
 */

export const GRACE_RELEASE_STEP_MIN = 10;
export const GRACE_RELEASE_CANDLES = 3;
export const GRACE_RELEASE_TIMEFRAME = "5m";
const TIMEFRAME_SEC = 300;

/** off | shadow. Anything else (including a future "enforce") reads as shadow — enforce is not built. */
export function graceEarlyReleaseMode(mgmt = {}) {
  return mgmt?.graceEarlyReleaseMode === "off" ? "off" : "shadow";
}

/**
 * The profit grace the position is in at `nowMs`, or null. Same two sources and the same
 * arithmetic as state.profitGraceRemainingMin (the longer one wins); adds where it started.
 */
export function graceWindow(pos, mgmt = {}, nowMs = Date.now()) {
  if (!pos || pos.closed) return null;
  const found = [];
  const adoptMin = Number(mgmt.adoptedProfitGraceMinutes ?? 0);
  const adoptedAt = pos.adopted && pos.adopted_at ? new Date(pos.adopted_at).getTime() : NaN;
  if (adoptMin > 0 && Number.isFinite(adoptedAt) && !pos.profit_grace_released_at) {
    const remaining = adoptMin - (nowMs - adoptedAt) / 60_000;
    if (remaining > 0) found.push({ kind: "adoption", start_ms: adoptedAt, remaining_min: remaining });
  }
  const until = pos.profit_grace_until ? new Date(pos.profit_grace_until).getTime() : NaN;
  if (Number.isFinite(until) && until > nowMs) {
    const straddledAt = pos.straddled_at ? new Date(pos.straddled_at).getTime() : NaN;
    const start = Number.isFinite(straddledAt) && straddledAt <= nowMs
      ? straddledAt
      : until - Number(mgmt.harvestStraddleGraceMinutes ?? 60) * 60_000;
    found.push({ kind: "straddle", start_ms: start, remaining_min: (until - nowMs) / 60_000 });
  }
  if (!found.length) return null;
  const w = found.sort((a, b) => b.remaining_min - a.remaining_min)[0];
  return { ...w, elapsed_min: Math.max(0, (nowMs - w.start_ms) / 60_000) };
}

/**
 * Is a candle check due now? Pure. Due when the elapsed grace time has crossed a 10-minute
 * multiple that was not evaluated yet for this window (`grace_release_shadow_check` =
 * { start, mark }) — so at most one fetch per position per 10 minutes, whatever the cycle
 * cadence. Never on a held position, never after the position's one would-release was logged.
 */
export function graceReleaseShadowStep(pos, mgmt = {}, nowMs = Date.now()) {
  if (graceEarlyReleaseMode(mgmt) === "off") return { due: false, reason: "off" };
  if (!pos || pos.closed) return { due: false, reason: "not open" };
  if (pos.hold_mode === true) return { due: false, reason: "held" };
  if (pos.grace_release_shadow) return { due: false, reason: "already logged" };
  const window = graceWindow(pos, mgmt, nowMs);
  if (!window) return { due: false, reason: "no grace" };
  const mark = Math.floor(window.elapsed_min / GRACE_RELEASE_STEP_MIN);
  if (mark < 1) return { due: false, reason: "before the first mark", window };
  const start = new Date(window.start_ms).toISOString();
  const prev = pos.grace_release_shadow_check;
  if (prev && prev.start === start && Number(prev.mark) >= mark) return { due: false, reason: "mark already evaluated", window };
  return { due: true, mark, window, check: { start, mark, at: new Date(nowMs).toISOString() } };
}

/**
 * The last `count` COMPLETED candles (oldest → newest) from a chronological list, or null when
 * there are fewer. A candle is complete once its bucket has ended; the feed's newest row is
 * usually the bucket still in progress.
 */
export function lastCompletedCandles(candles, nowMs = Date.now(), { count = GRACE_RELEASE_CANDLES, timeframeSec = TIMEFRAME_SEC } = {}) {
  if (!Array.isArray(candles)) return null;
  const nowSec = nowMs / 1000;
  const done = candles.filter((c) => c && Number.isFinite(Number(c.timestamp)) && Number(c.timestamp) + timeframeSec <= nowSec
    && Number(c.open) > 0 && Number.isFinite(Number(c.close)));
  if (done.length < count) return null;
  const last = done.slice(-count);
  // Consecutive buckets only: a gap means a candle with no trades, not three rising ones in a row.
  for (let i = 1; i < last.length; i++) {
    if (Number(last[i].timestamp) - Number(last[i - 1].timestamp) !== timeframeSec) return null;
  }
  return last;
}

/** Open→close move of each candle in percent (2 dp). */
export function candleMovesPct(candles) {
  return candles.map((c) => Math.round(((Number(c.close) - Number(c.open)) / Number(c.open)) * 10000) / 100);
}

const signed = (v) => `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`;

/**
 * One evaluation for one position of the management cycle. Never throws, sends nothing,
 * releases nothing. Returns the stored record on a would-release, else null.
 *   noteCheck(position, check)   — persists the evaluated mark (called BEFORE the fetch)
 *   noteShadow(position, record) — persists `grace_release_shadow`; false when not stored
 */
export async function runGraceReleaseShadow({ p, tracked, mgmt = {}, nowMs = Date.now(), fetchCandles, noteCheck, noteShadow, log = () => {} }) {
  try {
    const step = graceReleaseShadowStep(tracked, mgmt, nowMs);
    if (!step.due) return null;
    // An untrusted valuation would be recorded as the grading reference: wait for the next cycle
    // (the mark is not consumed).
    const pnl = Number(p?.pnl_pct);
    if (p?.pnl_management_ready === false || p?.pnl_pct_suspicious === true || p?.pnl_pct == null || !Number.isFinite(pnl)) return null;
    noteCheck(p.position, step.check);
    const pool = p.pool || tracked?.pool;
    if (!pool) return null;
    const last = lastCompletedCandles(await fetchCandles(pool, { timeframe: GRACE_RELEASE_TIMEFRAME, limit: GRACE_RELEASE_CANDLES + 2 }), nowMs);
    if (!last) return null;
    const moves = candleMovesPct(last);
    if (!moves.every((m) => m > 0)) return null;
    const record = {
      at: new Date(nowMs).toISOString(),
      elapsed_min: Math.round(step.window.elapsed_min * 10) / 10,
      pnl_pct: Math.round(pnl * 100) / 100,
      candles: moves,
      grace: step.window.kind,
      remaining_min: Math.round(step.window.remaining_min * 10) / 10,
    };
    if (!noteShadow(p.position, record)) return null;
    log("grace_release_shadow", `[GRACE_RELEASE_SHADOW] would-release ${p.pair || tracked?.pool_name || p.position}: ${Math.floor(step.window.elapsed_min)} min into the grace, last 3 5m candles ${moves.map(signed).join(" ")}, pnl ${pnl.toFixed(2)}% (graceEarlyReleaseMode=shadow)`);
    return record;
  } catch {
    return null; // log-only feature: any fault is silent
  }
}
