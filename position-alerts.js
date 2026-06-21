/**
 * Position Health Alerts — Concentration Risk + Leave-Pool detection.
 *
 * Runs each management cycle over an open position's recorded snapshot trend
 * (from pool-memory) plus live pool metrics. Surfaces two families of advisory
 * alert the raw close/claim rules don't cover:
 *
 *   • Fee-share dilution (concentration risk): the position's realized yield
 *     (fee_per_tvl_24h) is decaying while pool TVL climbs — more liquidity is
 *     piling into the same bins, diluting our share of the fee stream.
 *
 *   • Leave-pool (volume death): pool volume / fee_active_tvl_ratio is collapsing
 *     — the fee engine is dying regardless of our range.
 *
 * Everything here is a pure function over already-collected data (no fetching),
 * and the output is *advisory*: it's rendered into the cycle report and the LLM
 * action context. It only escalates a position into LLM review when explicitly
 * enabled (config.management.poolHealthAutoReview); it never auto-closes.
 */

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function avg(values) {
  const nums = values.map(numeric).filter((v) => v != null);
  if (nums.length === 0) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

/**
 * Default thresholds; overridable via config.management.
 */
const DEFAULTS = {
  enabled: true,
  autoReview: false,
  minSnapshots: 3,
  minAgeMinutes: 20,
  windowSize: 12,            // last N snapshots considered (~1h at 5min)
  yieldDecayPct: 50,         // fee_per_tvl_24h decay vs baseline to flag (%)
  tvlDilutionRisePct: 40,    // pool TVL rise vs baseline that turns decay into dilution (%)
  volumeDeathPct: 60,        // pool volume drop vs window peak to flag (%)
  feeRatioCollapsePct: 60,   // pool fee_active_tvl_ratio drop vs window peak to flag (%)
};

export function getPoolHealthConfig(managementConfig = {}) {
  const m = managementConfig || {};
  return {
    enabled:           m.poolHealthAlertsEnabled ?? DEFAULTS.enabled,
    autoReview:        m.poolHealthAutoReview ?? DEFAULTS.autoReview,
    minSnapshots:      numeric(m.poolHealthMinSnapshots) ?? DEFAULTS.minSnapshots,
    minAgeMinutes:     numeric(m.poolHealthMinAgeMinutes) ?? DEFAULTS.minAgeMinutes,
    windowSize:        numeric(m.poolHealthWindowSize) ?? DEFAULTS.windowSize,
    yieldDecayPct:     numeric(m.poolHealthYieldDecayPct) ?? DEFAULTS.yieldDecayPct,
    tvlDilutionRisePct: numeric(m.poolHealthTvlDilutionRisePct) ?? DEFAULTS.tvlDilutionRisePct,
    volumeDeathPct:    numeric(m.poolHealthVolumeDeathPct) ?? DEFAULTS.volumeDeathPct,
    feeRatioCollapsePct: numeric(m.poolHealthFeeRatioCollapsePct) ?? DEFAULTS.feeRatioCollapsePct,
  };
}

/**
 * Analyze one position's health from its snapshot trend.
 *
 * @param {object} params
 * @param {object} params.position   - live position object (from getMyPositions)
 * @param {object[]} params.snapshots - recorded snapshots for the pool (oldest→newest)
 * @param {object} [params.config]   - resolved config from getPoolHealthConfig()
 * @returns {{ alerts: Array<{code:string,severity:string,message:string}>, review: boolean }}
 */
export function analyzePositionHealth({ position, snapshots = [], config = DEFAULTS } = {}) {
  const out = { alerts: [], review: false };
  if (!config.enabled || !position) return out;

  const ageMinutes = numeric(position.age_minutes);
  if (ageMinutes != null && ageMinutes < config.minAgeMinutes) return out;

  const window = (Array.isArray(snapshots) ? snapshots : []).slice(-config.windowSize);
  if (window.length < config.minSnapshots) return out;

  const half = Math.max(1, Math.floor(window.length / 2));
  const early = window.slice(0, half);
  const late = window.slice(-Math.max(1, Math.ceil(window.length / 4)));

  // ── Yield decay / fee-share dilution ─────────────────────────────
  const baselineYield = avg(early.map((s) => s.fee_per_tvl_24h));
  const currentYield = numeric(position.fee_per_tvl_24h) ?? avg(late.map((s) => s.fee_per_tvl_24h));
  if (baselineYield != null && baselineYield > 0 && currentYield != null) {
    const decayPct = ((baselineYield - currentYield) / baselineYield) * 100;
    if (decayPct >= config.yieldDecayPct) {
      // Is pool TVL rising? → dilution, more LPs crowding our bins.
      const baselineTvl = avg(early.map((s) => s.pool_tvl));
      const currentTvl = avg(late.map((s) => s.pool_tvl));
      const tvlRisePct = baselineTvl != null && baselineTvl > 0 && currentTvl != null
        ? ((currentTvl - baselineTvl) / baselineTvl) * 100
        : null;
      if (tvlRisePct != null && tvlRisePct >= config.tvlDilutionRisePct) {
        out.alerts.push({
          code: "fee_share_dilution",
          severity: "warn",
          message: `Fee-share diluting: yield −${decayPct.toFixed(0)}% (${baselineYield.toFixed(2)}→${currentYield.toFixed(2)}%/24h) while pool TVL +${tvlRisePct.toFixed(0)}% — liquidity crowding in`,
        });
        out.review = true;
      } else {
        out.alerts.push({
          code: "yield_decay",
          severity: "warn",
          message: `Yield decaying: fee/TVL −${decayPct.toFixed(0)}% (${baselineYield.toFixed(2)}→${currentYield.toFixed(2)}%/24h) over ${window.length} cycles`,
        });
      }
    }
  }

  // ── Leave-pool: volume death ─────────────────────────────────────
  const peakVolume = Math.max(...window.map((s) => numeric(s.pool_volume) ?? 0));
  const currentVolume = numeric(position.pool_volume) ?? numeric(window[window.length - 1]?.pool_volume);
  if (peakVolume > 0 && currentVolume != null) {
    const dropPct = ((peakVolume - currentVolume) / peakVolume) * 100;
    if (dropPct >= config.volumeDeathPct) {
      out.alerts.push({
        code: "volume_death",
        severity: "warn",
        message: `Volume dying: −${dropPct.toFixed(0)}% from window peak ($${Math.round(peakVolume)}→$${Math.round(currentVolume)}) — fee engine fading`,
      });
      out.review = true;
    }
  }

  // ── Leave-pool: fee_active_tvl_ratio collapse ────────────────────
  const peakFeeRatio = Math.max(...window.map((s) => numeric(s.pool_fee_active_tvl_ratio) ?? 0));
  const currentFeeRatio = numeric(position.pool_fee_active_tvl_ratio) ?? numeric(window[window.length - 1]?.pool_fee_active_tvl_ratio);
  if (peakFeeRatio > 0 && currentFeeRatio != null) {
    const dropPct = ((peakFeeRatio - currentFeeRatio) / peakFeeRatio) * 100;
    if (dropPct >= config.feeRatioCollapsePct) {
      out.alerts.push({
        code: "fee_ratio_collapse",
        severity: "warn",
        message: `Pool fee/active-TVL collapsing: −${dropPct.toFixed(0)}% (${peakFeeRatio.toFixed(3)}→${currentFeeRatio.toFixed(3)})`,
      });
    }
  }

  if (!config.autoReview) out.review = false;
  return out;
}

/**
 * Compact emoji-prefixed lines for the Telegram cycle report.
 * @param {Array<{severity:string,message:string}>} alerts
 * @returns {string[]}
 */
export function formatHealthAlertLines(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return [];
  return alerts.map((a) => `   └ ${a.severity === "warn" ? "🟠" : "ℹ️"} <i>${a.message}</i>`);
}
