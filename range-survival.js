/**
 * Range Survival Predictor.
 *
 * "Weather forecast" for an open position: the probability its price range
 * survives (stays in range) over a set of horizons — e.g. "80% chance of
 * surviving 1h, 45% of surviving 24h". Also the shared volatility/in-range math
 * used by pool-simulator.js (single source of truth for the heuristic).
 *
 * Heuristic (deliberately ballpark — see pool-simulator.js for the framing):
 * window volatility is treated as a ~1-window stdev of % price moves and scaled
 * to a horizon by √(horizon/window). The probability the *nearer* range edge is
 * not breached over the horizon is a logistic, erf-free normal-tail approximation.
 */

const TIMEFRAME_MINUTES = {
  "5m": 5, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "12h": 720, "24h": 1440,
};

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Minutes for a metric timeframe label (default 5m). */
export function timeframeMinutes(timeframe) {
  return TIMEFRAME_MINUTES[timeframe] ?? 5;
}

/**
 * Scale a per-window volatility to a holding horizon: σ_h = σ_w · √(h/w).
 * @returns {number|null}
 */
export function scaleVolToHorizon(windowVol, windowMin, horizonMin) {
  const v = numeric(windowVol);
  if (v == null || v <= 0) return null;
  const w = Math.max(1, numeric(windowMin) ?? 5);
  const h = Math.max(1, numeric(horizonMin) ?? w);
  return v * Math.sqrt(h / w);
}

/**
 * Probability the range survives (nearer edge not breached) given a
 * horizon-scaled volatility. For a single-sided range the absent edge is
 * effectively infinite, so the binding edge is the non-zero one.
 *
 * @param {number} downsidePct - downside coverage magnitude (%), 0 if none
 * @param {number} upsidePct   - upside coverage magnitude (%), 0 if none
 * @param {number} horizonVol  - volatility scaled to the horizon (%)
 * @returns {number} 0..1
 */
export function inRangeProbability(downsidePct, upsidePct, horizonVol) {
  if (!(horizonVol > 0)) return 0.5; // unknown vol → neutral
  const edges = [Math.abs(numeric(downsidePct) ?? 0), Math.abs(numeric(upsidePct) ?? 0)].filter((e) => e > 0);
  const nearEdge = edges.length ? Math.min(...edges) : 0;
  if (nearEdge <= 0) return 0.02;
  const z = nearEdge / horizonVol;
  return clamp(1 - Math.exp(-0.5 * z * z * 1.1), 0.02, 0.99);
}

/** Default forecast horizons (minutes) → label. */
const DEFAULT_HORIZONS = [
  { minutes: 60, label: "1h" },
  { minutes: 360, label: "6h" },
  { minutes: 1440, label: "24h" },
];

/**
 * Predict survival probabilities across horizons for a range.
 *
 * @param {object} params
 * @param {number} params.downside_pct  - downside coverage magnitude (%)
 * @param {number} params.upside_pct    - upside coverage magnitude (%)
 * @param {number} params.volatility    - window volatility (%)
 * @param {string} [params.timeframe="5m"] - the window the volatility describes
 * @param {Array<{minutes:number,label:string}>} [params.horizons]
 * @returns {object}
 */
export function predictRangeSurvival({
  downside_pct,
  upside_pct = 0,
  volatility,
  timeframe = "5m",
  horizons = DEFAULT_HORIZONS,
} = {}) {
  const down = Math.abs(numeric(downside_pct) ?? 0);
  const up = Math.abs(numeric(upside_pct) ?? 0);
  const vol = numeric(volatility);
  if (down <= 0 && up <= 0) return { error: "provide downside_pct and/or upside_pct" };
  if (vol == null || vol <= 0) return { error: "usable volatility required" };

  const windowMin = timeframeMinutes(timeframe);
  const forecast = horizons.map((h) => {
    const horizonVol = scaleVolToHorizon(vol, windowMin, h.minutes);
    const prob = inRangeProbability(down, up, horizonVol);
    return {
      horizon: h.label,
      horizon_minutes: h.minutes,
      survival_prob: Math.round(prob * 100) / 100,
      survival_pct: Math.round(prob * 100),
      horizon_volatility_pct: horizonVol != null ? Math.round(horizonVol * 10) / 10 : null,
    };
  });

  return {
    range: { downside_pct: down ? -down : 0, upside_pct: up },
    volatility: vol,
    timeframe,
    binding_edge_pct: Math.min(...[down, up].filter((e) => e > 0)),
    forecast,
    note: "Ballpark normal-tail heuristic from window volatility scaled by √(horizon/window). For intuition, not a guarantee.",
  };
}

/**
 * Convert a position's bins to range edge percentages, using the bin step.
 * @returns {{ downside_pct: number, upside_pct: number } | null}
 */
export function binsToRangePct({ lower_bin, upper_bin, active_bin, bin_step }) {
  const lower = numeric(lower_bin);
  const upper = numeric(upper_bin);
  const active = numeric(active_bin);
  const step = numeric(bin_step);
  if (lower == null || upper == null || active == null || step == null || step <= 0) return null;
  const s = step / 10_000;
  const lowerRel = Math.pow(1 + s, lower - active);
  const upperRel = Math.pow(1 + s, upper - active);
  return {
    downside_pct: Math.round((1 - lowerRel) * 10000) / 100, // positive magnitude below
    upside_pct: Math.round((upperRel - 1) * 10000) / 100,
  };
}
