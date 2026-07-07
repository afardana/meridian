import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown, recordRejectedCandidate } from "../pool-memory.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import { discoverGmgnPools, getGmgnDevInfo } from "./gmgn.js";
import { computeIntelScore, formatIntelScore } from "../intel-score.js";
import { rankByFeeEfficiency, computeFeeEfficiency } from "../fee-efficiency.js";
import { annotateOrganicMomentum, getOrganicMomentumConfig, computeOrganicMomentum } from "../organic-momentum.js";
import { recordTvlSnapshot, checkTvlDrain, checkExitSignals } from "../tvl-guard.js";
import { computeDevScore } from "../dev-scoring.js";
import { detectPvpRival, searchAssetsBySymbol } from "../pvp.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

// Rejected/accepted-candidate capture caps (offline replay/backtest data feed).
// Hardcoded — not config-tunable by design (see CLAUDE.md task constraints).
const REJECTED_CAPTURE_MAX_POOLS_PER_CYCLE = 15;

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
// Degen Score normalizes window-dependent inputs (volume/fee/LP) to this reference
// window, so its targets stay valid regardless of the configured screening timeframe.
const DEGEN_REFERENCE_MINUTES = 30;
const PVP_SHORTLIST_LIMIT = 2;

// ── "Rank, don't gate" mode — broad safety/structural envelope ──────────────
// In rank mode the server-side query keeps ONLY the safety envelope + these broad
// sanity bands (deliberately HARDCODED, not the user's gate thresholds — those
// become score inputs, not kill switches). NO organic / quote-organic constraints
// server-side (2026-07-07 backtest of 181 closes: organic_score is statistically
// FLAT vs outcomes). token-age bounds are taken live from config
// (minTokenAgeHours / maxTokenAgeHours) since those are structural, not quality.
//
// Floors set from the 2026-07-07 backtest of 181 closes: holders/volume stay as
// RUG-SAFETY floors (mcap/holders point slightly wrong-way as quality signals but
// remain valid safety floors); fee_active_tvl_ratio >= 0.30 added because the
// bottom fee_tvl quartile had only 14% success (fee_tvl_ratio was the strongest
// outcome discriminator: Spearman +0.39, Q1→Q4 success 14%→67%).
//
// ⚠️ Timeframe-relativity: the API's `volume` and `fee_active_tvl_ratio` fields are
// WINDOWED by the query's `timeframe` param, so a fixed floor silently tightens as
// the window shrinks (a $1000 floor over 5m ≈ $12k/h — this exact mismatch broke
// the broad⊇gate superset property in the first smoke test, which ran at the dev
// default 5m vs the live 1h). The `*1h` values below are expressed for a 1-HOUR
// reference window (the ~1h live screening timeframe the 0.30 backtest figure
// assumes) and are linearly scaled to the configured timeframe at query-build time
// in discoverPoolsBroad(). Levels (tvl/mcap/holders) are not windowed, not scaled.
const RANK_ENVELOPE = {
  minTvl: 10_000,   // no max — TVL is a score input above the floor
  minMcap: 100_000,
  maxMcap: 20_000_000,
  minHolders: 500,              // rug-safety floor (2026-07-07 backtest)
  minVolume1h: 1_000,           // rug-safety floor, 1h reference window
  minFeeActiveTvlRatio1h: 0.30, // 2026-07-07 backtest: Q1 fee_tvl band = 14% success
};
const RANK_ENVELOPE_REFERENCE_MINUTES = 60;
// Broad-fetch tuning. The public Meteora discovery API accepts larger page sizes
// (the funnel-audit script uses 500); stay to a small request budget per cycle.
const RANK_FETCH_PAGE_SIZE = 250;
const RANK_FETCH_MAX_REQUESTS = 3;

export function scoreCandidate(pool) {
  const intel = computeIntelScore(pool);
  pool._intelScore = intel;
  return intel.total;
}

/**
 * Composite candidate-admission score for "rank, don't gate" mode.
 *
 * PURE and payload-only — computed entirely from the discovery payload the broad
 * fetch already returned, with NO per-pool API calls, so it can be run over the
 * whole safety-survivor set cheaply (both for real admission pre-ranking and for
 * the gate-mode RANK_SHADOW would-admit log). The expensive enrichment/gates
 * (dev-score, dump-play, full intel rescoring) run afterwards on only the top
 * slice, exactly as gate mode does.
 *
 *   admission_score = intel_total_from_payload
 *                   + momentum_modifier         (+5 GROWING / 0 steady / −10 DECAYING)
 *                   + fee_tvl_modifier           (12 × (fee_tvl percentile − 0.5), ±6)
 *                   + fee_efficiency_modifier    (10 × (fee-eff percentile − 0.5), ±5)
 *
 * Weighting grounded in the 2026-07-07 backtest of 181 closed positions:
 * - fee_tvl_ratio was the STRONGEST outcome discriminator (Spearman +0.39,
 *   Q1→Q4 success 14%→67%) — hence its ±6 modifier deliberately outweighs the
 *   momentum modifier's +5 upside. Intel leads (intel_total ≥52 blocked 68% of
 *   failures while keeping 71% of winners — the knee used for rankMinIntelScore);
 *   fee_tvl is the secondary signal.
 * - organic_score was statistically FLAT vs outcomes — deliberately NOT a score
 *   term here beyond its (small) role inside intel's Trust dimension.
 * - entry_volume was real (+0.30) but volume already feeds intel's Yield
 *   dimension and the envelope's rug-safety floor; no separate term.
 *
 * Term details:
 * - intel_total_from_payload: the existing scoreCandidate/computeIntelScore
 *   machinery, which already falls back to neutral midpoints for absent
 *   GMGN/audit sub-inputs (intel-score.js scoreSafety/scoreTrust) — so a pool
 *   that hasn't been enriched yet is scored on its payload fields, not penalized.
 * - momentum_modifier: from computeOrganicMomentum() (payload trend fields only).
 * - fee_tvl_modifier: the pool's raw fee_active_tvl_ratio percentile WITHIN the
 *   fetched set (ctx.feeTvlPercentile, 0..1): best +6 / median 0 / worst −6.
 * - fee_efficiency_modifier: fee yield per unit IL risk (fee_ratio/volatility)
 *   percentile within the set (ctx.feePercentile, 0..1): best +5 / median 0 /
 *   worst −5.
 * Either percentile missing → that term is neutral (0).
 *
 * @param {object} pool - condensed candidate (from condensePool)
 * @param {object} [ctx] - { momentumCfg, feePercentile, feeTvlPercentile } — both
 *   percentiles are in [0,1], computed within the current fetched set.
 * @returns {number} the composite admission score (higher = admit sooner)
 */
export function computeAdmissionScore(pool, ctx = {}) {
  const intel = pool?._intelScore?.total != null
    ? pool._intelScore.total
    : scoreCandidate(pool);

  const momentumCfg = ctx.momentumCfg ?? getOrganicMomentumConfig(config.screening);
  const m = pool?._organicMomentum ?? computeOrganicMomentum(pool, momentumCfg);
  const momentumModifier = m?.classification === "growing" ? 5
    : m?.classification === "decaying" ? -10
    : 0; // steady / unknown

  const feeTvlPct = numeric(ctx.feeTvlPercentile);
  const feeTvlModifier = feeTvlPct == null ? 0 : 12 * (feeTvlPct - 0.5);

  const pct = numeric(ctx.feePercentile);
  const feeEfficiencyModifier = pct == null ? 0 : 10 * (pct - 0.5);

  const total = intel + momentumModifier + feeTvlModifier + feeEfficiencyModifier;
  return Number.isFinite(total) ? total : 0;
}

/**
 * Degen Score — a pool's efficiency relative to its liquidity, on a 0..100 scale.
 * Geometric mean of four liquidity-relative sub-scores so a HIGH score requires balance
 * across all four (a pool spiking one metric can't dominate):
 *   1. Recent trading activity   → volume / active_tvl   (volume_active_tvl_ratio)
 *   2. Recent LP activity        → unique_lps + positions_created
 *   3. Fees paid to LPs          → fee / active_tvl       (fee_active_tvl_ratio)
 *   4. Liquidity                 → active_tvl (log floor — dust pools can't win on ratios)
 * Efficiency only (no momentum/change_pct), per design. Targets are configurable so the
 * score can be calibrated; each sub-score saturates at its target.
 *
 * The volume/fee/LP inputs are measured over `config.screening.timeframe`, so they are
 * normalized to a fixed 30m reference window before scoring — the targets are expressed
 * in 30m terms and stay valid even if the timeframe changes (5m, 1h, 24h, …). Liquidity
 * is a level, not a rate, so it is not scaled.
 */
export function degenScore(pool, targets = {}) {
  const {
    targetVolRatio = 20,    // (30m) volume/active_tvl that earns a full trading sub-score
    targetLpCount = 40,     // (30m) unique_lps + positions_created for a full LP sub-score
    targetFeeRatio = 0.20,  // (30m) fee/active_tvl for a full fee sub-score
    targetLiquidity = 20000, // active_tvl ($) floor for full liquidity sub-score (not timeframe-scaled)
  } = targets;

  const La = Number(pool.active_tvl ?? pool.tvl ?? 0);
  if (!Number.isFinite(La) || La <= 0) return 0;

  const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

  // Normalize window-dependent inputs to the 30m reference (rate × scale).
  const tfMinutes = TIMEFRAME_MINUTES[config.screening.timeframe] || DEGEN_REFERENCE_MINUTES;
  const tfScale = DEGEN_REFERENCE_MINUTES / tfMinutes;

  const volRatio = Number(pool.volume_active_tvl_ratio);
  const tradingRatio = (Number.isFinite(volRatio) ? volRatio : Number(pool.volume_window || 0) / La) * tfScale;
  const feeRatio = (Number.isFinite(Number(pool.fee_active_tvl_ratio))
    ? Number(pool.fee_active_tvl_ratio)
    : Number(pool.fee_window || 0) / La) * tfScale;
  const lpActivity = (Number(pool.unique_lps || 0) + Number(pool.positions_created || 0)) * tfScale;

  const sTrading = clamp01(tradingRatio / targetVolRatio);
  const sLp      = clamp01(lpActivity / targetLpCount);
  const sFees    = clamp01(feeRatio / targetFeeRatio);
  const sLiq     = clamp01(Math.log10(La) / Math.log10(targetLiquidity));

  // Geometric mean (×100). Any zero sub-score → 0, enforcing balance across all four.
  return (sTrading * sLp * sFees * sLiq) ** 0.25 * 100;
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUsableVolatility(value) {
  const n = numeric(value);
  return n != null && n > 0;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function getRawPoolScreeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const totalLps = numeric(pool?.total_lps);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (s.minLps != null && s.minLps > 0) {
    if (totalLps == null || totalLps < s.minLps) return `total LPs ${totalLps ?? "unknown"} below minLps ${s.minLps}`;
  }
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (!isUsableVolatility(volatility)) return `volatility ${volatility ?? "unknown"} unusable`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (
    pool?.discord_signal &&
    Array.isArray(s.allowedLaunchpads) &&
    s.allowedLaunchpads.length > 0 &&
    launchpad &&
    !includesCaseInsensitive(s.allowedLaunchpads, launchpad)
  ) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  return null;
}

async function fetchDiscordSignalCandidates() {
  const res = await fetch(`${config.api.url}/signals/discord/candidates`, {
    headers: config.api.publicApiKey ? { "x-api-key": config.api.publicApiKey } : {},
  });
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);

  // Tag primary-timeframe values on every pool before any overwrite
  for (const pool of rawPools) {
    if (!pool) continue;
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  if (sourceTimeframe === volatilityTimeframe) return rawPools;

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const longResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({
          poolAddress,
          volatility: numeric(pool?.volatility),
          volume: numeric(pool?.volume),
        }))
    )
  );

  const metricsByPool = new Map();
  for (const result of longResults) {
    if (result.status !== "fulfilled") continue;
    metricsByPool.set(result.value.poolAddress, result.value);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    const metrics = metricsByPool.get(pool.pool_address);
    if (!metrics) continue;

    pool[`volume_${volatilityTimeframe}`] = metrics.volume;
    pool[`volatility_${volatilityTimeframe}`] = metrics.volatility;

    // Use longer-timeframe values as the canonical ones for filtering
    if (metrics.volatility != null) pool.volatility = metrics.volatility;
    if (metrics.volume != null) pool.volume = metrics.volume;
  }

  return rawPools;
}

async function enrichDiscordSignalLaunchpads(rawPools) {
  const missing = rawPools.filter((pool) =>
    pool?.discord_signal &&
    !getPoolLaunchpad(pool) &&
    getPoolBaseMint(pool)
  );
  if (missing.length === 0) return;

  const uniqueMints = [...new Set(missing.map(getPoolBaseMint).filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueMints.map(async (mint) => {
      const assets = await searchAssetsBySymbol(mint);
      const asset = assets.find((item) => item?.id === mint) || assets[0] || null;
      return { mint, asset };
    })
  );

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const launchpad = result.value.asset?.launchpad || result.value.asset?.launchpadPlatform || null;
    if (!launchpad) continue;
    byMint.set(result.value.mint, {
      launchpad,
      dev: result.value.asset?.dev || null,
      holderCount: numeric(result.value.asset?.holderCount),
      organicScore: numeric(result.value.asset?.organicScore),
      marketCap: numeric(result.value.asset?.mcap ?? result.value.asset?.fdv),
      createdAt: result.value.asset?.createdAt ? Date.parse(result.value.asset.createdAt) : null,
    });
  }

  for (const pool of missing) {
    const mint = getPoolBaseMint(pool);
    const asset = byMint.get(mint);
    if (!asset) continue;
    pool.token_x ||= {};
    pool.token_x.launchpad = asset.launchpad;
    pool.base_token_launchpad = asset.launchpad;
    if (asset.dev && !pool.token_x.dev) pool.token_x.dev = asset.dev;
    if (asset.holderCount != null && pool.base_token_holders == null) pool.base_token_holders = asset.holderCount;
    if (asset.organicScore != null && pool.token_x.organic_score == null) pool.token_x.organic_score = asset.organicScore;
    if (asset.marketCap != null && pool.token_x.market_cap == null) pool.token_x.market_cap = asset.marketCap;
    if (asset.createdAt != null && pool.token_x.created_at == null) pool.token_x.created_at = asset.createdAt;
    log("screening", `Discord signal launchpad enriched from Jupiter: ${pool.name || mint} — ${asset.launchpad}`);
  }
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  await Promise.all(shortlist.map(async (pool) => {
    const ownMint = pool.base?.mint;
    if (!ownMint) return;

    const rival = await detectPvpRival(pool.base?.symbol, ownMint).catch(() => null);
    if (!rival) return;

    pool.is_pvp = true;
    pool.pvp_risk = "high";
    pool.pvp_symbol = pool.base?.symbol || null;
    pool.pvp_rival_name = rival.rival_name;
    pool.pvp_rival_mint = rival.rival_mint;
    pool.pvp_rival_pool = rival.rival_pool;
    pool.pvp_rival_tvl = rival.rival_tvl;
    pool.pvp_rival_holders = rival.rival_holders;
    pool.pvp_rival_fees = rival.rival_fees;
    log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.rival_mint.slice(0, 8)})`);
  }));
}



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */

/**
 * Refresh live metrics for discord-only signal pools.
 * Their discovery_pool is a snapshot from when the signal was captured — volume/volatility/fee
 * can be 0 even if the pool is active right now. We overwrite with fresh data from the
 * pool discovery API so filtering uses current numbers, not stale ones.
 */
async function refreshDiscordOnlyPools(pools, timeframe) {
  if (!pools.length) return;
  const FIELDS = ["volume", "fee", "active_tvl", "tvl", "volatility", "fee_active_tvl_ratio"];
  const results = await Promise.allSettled(
    pools.map((pool) =>
      fetchPoolDiscoveryDetail({ poolAddress: pool.pool_address, timeframe })
        .then((fresh) => ({ pool, fresh }))
    )
  );
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value.fresh) continue;
    const { pool, fresh } = result.value;
    for (const field of FIELDS) {
      const val = numeric(fresh[field]);
      if (val != null) pool[field] = val;
    }
    log("screening", `Discord signal refreshed live data: ${pool.name || pool.pool_address} — vol=${pool.volume?.toFixed(0)} fee=${pool.fee?.toFixed(2)}`);
  }
}

export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");

  const data = await fetchPoolDiscoveryPage({
    page_size,
    filters,
    timeframe: s.timeframe,
    category: s.category,
  });

  let rawPools = Array.isArray(data.data) ? data.data : [];

  if (config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
      // Refresh all signal pools with live data since discovery_pool is a stale snapshot
      await refreshDiscordOnlyPools(rawPools, s.timeframe);
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      const discordOnlyPools = [];
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
          discordOnlyPools.push(signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
      // Refresh discord-only pools with live data — their discovery_pool is a stale snapshot
      // so volume/volatility/fee may be 0 even when the pool is active right now
      if (discordOnlyPools.length > 0) {
        await refreshDiscordOnlyPools(discordOnlyPools, s.timeframe);
      }
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);
  await enrichDiscordSignalLaunchpads(rawPools);

  const filteredExamples = [];
  const recheckRejects = {}; // reason-family → count (Stage-A client re-check attrition)
  const thresholdedRawPools = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, s);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    // Collapse the reason to a compact family (strip the trailing value clause).
    const family = reason.split(/\s+(?:below|above|not|is|unusable|has)\b/)[0].trim() || reason;
    recheckRejects[family] = (recheckRejects[family] || 0) + 1;
    if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    return false;
  });

  const condensed = thresholdedRawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const blacklistDropped = condensed.length - pools.length;
  if (blacklistDropped > 0) log("blacklist", `Filtered ${blacklistDropped} pool(s) with blacklisted tokens/devs`);

  // ── Stage-A funnel telemetry (never throws — must not break screening) ──
  try {
    const breakdown = Object.entries(recheckRejects)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason}=${n}`)
      .join(", ");
    log("screening",
      `discovery: api_total=${data.total ?? "?"} fetched=${rawPools.length}` +
      ` → client_recheck=${thresholdedRawPools.length} → blacklist=${pools.length}` +
      (breakdown ? ` | recheck_rejects: ${breakdown}` : ""));
  } catch { /* telemetry only */ }

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: data.total,
    pools,
    filtered_examples: filteredExamples,
    stage_a: {
      api_total: data.total ?? null,
      fetched: rawPools.length,
      client_recheck: thresholdedRawPools.length,
      after_blacklist: pools.length,
      recheck_rejects: recheckRejects,
    },
  };
}

/**
 * Broad universe fetch for "rank, don't gate" mode.
 *
 * Server-side query keeps ONLY the safety/structural envelope — pool_type=dlmm,
 * critical-warnings + supply-concentration + single-ownership exclusion, bin_step
 * within [minBinStep, maxBinStep], plus the hardcoded RANK_ENVELOPE sanity bands
 * (tvl floor / mcap band / holders / volume / fee_tvl floor — the windowed
 * volume + fee_tvl floors are timeframe-scaled from their 1h-reference values,
 * see RANK_ENVELOPE) and the configured token-age bounds. Deliberately NO
 * organic / quote-organic constraints — those become admission-score inputs,
 * not kill switches (2026-07-07 backtest: organic flat vs outcomes).
 *
 * Fetches the configured category plus one volume-ranked alternate ("top"),
 * dedupes by pool address, paging with after_key, bounded to
 * RANK_FETCH_MAX_REQUESTS requests total. Returns condensed pools (the same shape
 * as discoverPools' `pools`) plus the raw universe count. Best-effort: any page
 * error just stops that category's paging.
 *
 * @returns {Promise<{ pools: object[], universe: number, requests: number }>}
 */
export async function discoverPoolsBroad() {
  const s = config.screening;
  // Scale the WINDOWED envelope floors (volume, fee/active-TVL ratio) from their
  // 1h-reference values to the configured timeframe — the API windows those fields
  // by the `timeframe` param, so a fixed floor would silently tighten on shorter
  // windows and break the broad⊇gate superset property (see RANK_ENVELOPE note).
  const tfMinutes = TIMEFRAME_MINUTES[s.timeframe] || RANK_ENVELOPE_REFERENCE_MINUTES;
  const tfScale = tfMinutes / RANK_ENVELOPE_REFERENCE_MINUTES;
  const minVolumeScaled = Math.max(1, Math.round(RANK_ENVELOPE.minVolume1h * tfScale));
  const minFeeRatioScaled = Number((RANK_ENVELOPE.minFeeActiveTvlRatio1h * tfScale).toFixed(6));

  const envelopeFilters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${RANK_ENVELOPE.minMcap}`,
    `base_token_market_cap<=${RANK_ENVELOPE.maxMcap}`,
    `base_token_holders>=${RANK_ENVELOPE.minHolders}`,
    `volume>=${minVolumeScaled}`,
    `tvl>=${RANK_ENVELOPE.minTvl}`,
    `fee_active_tvl_ratio>=${minFeeRatioScaled}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
  ].filter(Boolean).join("&&");

  // Configured category first, then one volume-ranked alternate ("top").
  const categories = [s.category];
  if (!categories.includes("top")) categories.push("top");

  const byAddr = new Map();
  let requests = 0;
  const maxPagesPerCat = Math.max(1, Math.floor(RANK_FETCH_MAX_REQUESTS / categories.length));

  for (const category of categories) {
    if (requests >= RANK_FETCH_MAX_REQUESTS) break;
    let afterKey = null;
    let pages = 0;
    while (pages < maxPagesPerCat && requests < RANK_FETCH_MAX_REQUESTS) {
      let data;
      try {
        const url = `${POOL_DISCOVERY_BASE}/pools?` +
          `page_size=${RANK_FETCH_PAGE_SIZE}` +
          `&filter_by=${encodeURIComponent(envelopeFilters)}` +
          `&timeframe=${s.timeframe}` +
          `&category=${category}` +
          (afterKey ? `&after_key=${encodeURIComponent(afterKey)}` : "");
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        data = await res.json();
      } catch (err) {
        log("screening", `rank broad-fetch category=${category} page ${pages + 1} error: ${err.message}`);
        break;
      }
      requests++;
      pages++;
      const rows = Array.isArray(data.data) ? data.data : [];
      for (const p of rows) {
        if (p?.pool_address && !byAddr.has(p.pool_address)) byAddr.set(p.pool_address, p);
      }
      afterKey = data.after_key;
      if (!data.has_more || !afterKey || rows.length === 0) break;
    }
  }

  const rawPools = await applyVolatilityTimeframe([...byAddr.values()], s.timeframe);
  return { pools: rawPools.map(condensePool), universe: byAddr.size, requests };
}

/**
 * SAFETY-only hard gates for rank mode. Quality metric floors
 * (minTvl/maxTvl/minVolume/minOrganic/minQuoteOrganic/minHolders/minMcap/maxMcap/
 * minFeeActiveTvlRatio) are deliberately NOT applied here — they are score inputs.
 * Mutates `filteredOut` (for rejected-candidate capture) and returns survivors.
 *
 * @param {object[]} pools - condensed candidates
 * @param {object} sctx - { occupiedPools, occupiedMints, filteredOut }
 * @returns {object[]}
 */
function applyRankSafetyGates(pools, { occupiedPools, occupiedMints, filteredOut }) {
  return pools.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      pushFilteredReason(filteredOut, p, "blacklisted token");
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      pushFilteredReason(filteredOut, p, "blocked deployer");
      return false;
    }
    if (occupiedPools.has(p.pool)) {
      pushFilteredReason(filteredOut, p, "already have an open position in this pool");
      return false;
    }
    if (occupiedMints.has(p.base?.mint)) {
      pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
      return false;
    }
    if (isPoolOnCooldown(p.pool)) {
      pushFilteredReason(filteredOut, p, "pool cooldown active");
      return false;
    }
    if (isBaseMintOnCooldown(p.base?.mint)) {
      pushFilteredReason(filteredOut, p, "token cooldown active");
      return false;
    }
    if (!isUsableVolatility(p.volatility)) {
      pushFilteredReason(filteredOut, p, `volatility ${p.volatility ?? "unknown"} unusable`);
      return false;
    }
    // TVL-drain guard (safety, not a quality floor)
    const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
    if (config.screening.tvlDrainEnabled && tvl > 0) {
      recordTvlSnapshot(p.pool, tvl);
      const drain = checkTvlDrain(p.pool, tvl, config.screening.tvlDrainThresholdPct);
      if (drain.draining) {
        pushFilteredReason(filteredOut, p, `TVL drain: ${drain.changePct.toFixed(0)}% drop from peak`);
        return false;
      }
    }
    // Launchpad block-list (safety/policy)
    if (includesCaseInsensitive(config.screening.blockedLaunchpads, p.launchpad)) {
      pushFilteredReason(filteredOut, p, `blocked launchpad (${p.launchpad})`);
      return false;
    }
    return true;
  });
}

/**
 * Assign each pool its fee-efficiency percentile AND its raw fee_tvl_ratio
 * percentile (both in [0,1], WITHIN the given set), then compute + attach
 * `pool._admissionScore` via computeAdmissionScore. Payload-only, no API calls.
 * Returns the same array sorted by admission score (desc).
 */
function prescoreRankCandidates(pools, momentumCfg) {
  // Generic within-set percentile: rank pools by `value(p)` desc; best → 1.0,
  // worst → 0.0 (single-usable set → 1.0). Unusable values get no entry.
  const percentileBy = (value) => {
    const usable = [];
    for (const p of pools) {
      const v = numeric(value(p));
      if (v != null) usable.push([p, v]);
    }
    usable.sort((a, b) => b[1] - a[1]);
    const n = usable.length;
    const map = new Map();
    usable.forEach(([p], i) => map.set(p.pool, n > 1 ? (n - 1 - i) / (n - 1) : 1));
    return map;
  };

  // Fee-efficiency (fee_ratio / volatility) percentile — IL-adjusted yield.
  const fePct = percentileBy((p) => computeFeeEfficiency(p)?.ratio ?? null);
  // Raw fee_active_tvl_ratio percentile — the strongest outcome discriminator
  // in the 2026-07-07 backtest (Spearman +0.39; see computeAdmissionScore).
  const feeTvlPct = percentileBy((p) => p.fee_active_tvl_ratio);

  // Annotate organic momentum (payload-based) so computeAdmissionScore reuses it.
  annotateOrganicMomentum(pools, momentumCfg);

  for (const p of pools) {
    // Stash the within-set percentiles so the post-enrichment rescore in
    // getTopCandidatesRank can reuse them (fee_tvl stays the secondary signal
    // in the FINAL ranking too, per the 2026-07-07 backtest's best rule).
    p._rankFeePct = fePct.has(p.pool) ? fePct.get(p.pool) : null;
    p._rankFeeTvlPct = feeTvlPct.has(p.pool) ? feeTvlPct.get(p.pool) : null;
    p._admissionScore = computeAdmissionScore(p, {
      momentumCfg,
      feePercentile: p._rankFeePct,
      feeTvlPercentile: p._rankFeeTvlPct,
    });
  }
  return [...pools].sort((a, b) => (b._admissionScore ?? 0) - (a._admissionScore ?? 0));
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const source = String(config.screening.source || "meteora").toLowerCase();
  if (!["meteora", "gmgn"].includes(source)) {
    throw new Error(`Invalid screeningSource: ${config.screening.source}. Use meteora or gmgn.`);
  }

  // "Rank, don't gate" mode — meteora source only. Fetch a broad safety-envelope
  // universe, apply only SAFETY gates client-side, rank by admission score, admit
  // the top rankAdmitCount. Gate mode (default) falls through unchanged below.
  if (source === "meteora" && String(config.screening.screeningAdmissionMode || "gate").toLowerCase() === "rank") {
    return getTopCandidatesRank({ limit });
  }

  const discovery = source === "gmgn"
    ? await discoverGmgnPools({ limit: Math.max(limit, config.gmgn.enrichLimit || 20) })
    : await discoverPools({ page_size: 50 });
  let { pools } = discovery;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];

  // ── Meteora Stage-B funnel counts (mirrors the GMGN stage_counts shape so the
  //    Telegram funnel report can be shared). Populated alongside the existing
  //    filter steps; never restructures filter logic and never throws. ──────
  const meteoraStages = source === "meteora" ? { input: pools.length } : null;
  const meteoraStage = (key, count) => { if (meteoraStages) meteoraStages[key] = count; };

  // Token blacklist + dev blocklist (Meteora path runs these inside discoverPools; GMGN path does not)
  if (source === "gmgn") {
    const before = pools.length;
    pools = pools.filter((p) => {
      if (isBlacklisted(p.base?.mint)) {
        log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "blacklisted token");
        return false;
      }
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    if (pools.length < before) log("blacklist", `GMGN: filtered ${before - pools.length} blacklisted/blocked pool(s)`);
  }

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const minTvl = source === "gmgn"
    ? Number(config.gmgn.minTvl ?? config.screening.minTvl ?? 0)
    : Number(config.screening.minTvl ?? 0);
  const maxTvl = config.screening.maxTvl == null ? null : Number(config.screening.maxTvl);
  const minFeeActiveTvlRatio = Number(config.screening.minFeeActiveTvlRatio ?? 0);

  // Record TVL snapshots for all discovered pools (for TVL drain detection)
  for (const p of pools) {
    const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
    if (p.pool && tvl > 0) recordTvlSnapshot(p.pool, tvl);
  }

  const eligible = pools
    .filter((p) => {
      const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
      if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} below minTvl $${minTvl}`);
        return false;
      }
      if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} above maxTvl $${maxTvl}`);
        return false;
      }
      // TVL drain guard
      if (config.screening.tvlDrainEnabled) {
        const drain = checkTvlDrain(p.pool, tvl, config.screening.tvlDrainThresholdPct);
        if (drain.draining) {
          log("screening", `TVL drain detected: ${p.name} dropped ${drain.changePct.toFixed(0)}% (peak: $${drain.peakTvl.toFixed(0)} → $${tvl.toFixed(0)})`);
          pushFilteredReason(filteredOut, p, `TVL drain: ${drain.changePct.toFixed(0)}% drop from peak`);
          return false;
        }
      }
      // Exit signals guard (smart money exiting)
      const exits = checkExitSignals(p);
      if (exits.exiting) {
        log("screening", `Exit signals for ${p.name}: ${exits.signals.join(", ")}`);
        pushFilteredReason(filteredOut, p, `exit signals: ${exits.signals.join(", ")}`);
        return false;
      }
      const feeActiveTvlRatio = Number(p.fee_active_tvl_ratio);
      if (Number.isFinite(minFeeActiveTvlRatio) && minFeeActiveTvlRatio > 0 && (!Number.isFinite(feeActiveTvlRatio) || feeActiveTvlRatio < minFeeActiveTvlRatio)) {
        pushFilteredReason(filteredOut, p, `fee/active-TVL ${Number.isFinite(feeActiveTvlRatio) ? feeActiveTvlRatio : "unknown"} below minFeeActiveTvlRatio ${minFeeActiveTvlRatio}`);
        return false;
      }
      if (!isUsableVolatility(p.volatility)) {
        pushFilteredReason(filteredOut, p, `volatility ${p.volatility ?? "unknown"} unusable`);
        return false;
      }
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    });
  // Combined metrics gate (tvl/drain/exit-signals/fee-ratio/volatility/occupied/cooldown).
  meteoraStage("metrics", eligible.length);

  // Populate full developer reputation info from GMGN (for Meteora path where dev details are missing)
  await Promise.all(
    eligible.map(async (p) => {
      try {
        if ((!p.dev || typeof p.dev === "string") && p.base?.mint) {
          const devInfo = await getGmgnDevInfo(p.base.mint);
          if (devInfo) p.dev = devInfo;
        }
        p._devScore = computeDevScore(p);
      } catch (err) {
        log("screening", `Failed to fetch/compute dev score for ${p.name}: ${err.message}`);
        p._devScore = null;
      }
    })
  );

  // Filter candidates by minimum developer reputation score
  const minDevScore = Number(config.screening.minDevScore ?? 0);
  if (minDevScore > 0) {
    const before = eligible.length;
    const verifiedDevs = [];
    for (const p of eligible) {
      const score = p._devScore?.total ?? 50;
      if (score < minDevScore) {
        log("screening", `Filtered candidate ${p.name} due to low developer score: ${score} < ${minDevScore}`);
        pushFilteredReason(filteredOut, p, `developer score ${score} < ${minDevScore}`);
        continue;
      }
      verifiedDevs.push(p);
    }
    eligible.splice(0, eligible.length, ...verifiedDevs);
    if (eligible.length < before) {
      log("screening", `Developer score filter removed ${before - eligible.length} candidate(s)`);
    }
  }
  meteoraStage("dev_score", eligible.length);

  // Enforce developer reputation and holding status guards for dump plays
  const verified = [];
  for (const p of eligible) {
    const change = p.price_change_pct ?? 0;
    if (change <= -20) {
      const score = p._devScore?.total ?? 50;
      const status = p.dev?.creator_token_status;
      const devSells = status === "creator_close" || (status && status.includes("sell"));
      
      if (score < 70) {
        log("screening", `Filtered candidate ${p.name} due to dump play guard: price change ${change.toFixed(1)}% <= -20% but dev score ${score} < 70`);
        pushFilteredReason(filteredOut, p, `dump play: dev score ${score} < 70`);
        continue;
      }
      if (devSells) {
        log("screening", `Filtered candidate ${p.name} due to dump play guard: price change ${change.toFixed(1)}% <= -20% but dev sold/closed`);
        pushFilteredReason(filteredOut, p, `dump play: dev sold/closed`);
        continue;
      }
    }
    verified.push(p);
  }
  eligible.splice(0, eligible.length, ...verified);
  meteoraStage("dump_guard", eligible.length);

  for (const p of eligible) {
    scoreCandidate(p);
  }
  eligible.sort((a, b) => (b._intelScore?.total ?? 0) - (a._intelScore?.total ?? 0));
  eligible.splice(limit);

  // Filter by minimum intel score
  const minIntelScore = Number(config.screening.minIntelScore ?? 0);
  if (minIntelScore > 0) {
    const before = eligible.length;
    const belowScore = eligible.filter(p => (p._intelScore?.total ?? 0) < minIntelScore);
    belowScore.forEach(p => {
      pushFilteredReason(filteredOut, p, `intel score ${p._intelScore?.total?.toFixed(0) ?? "?"} below min ${minIntelScore}`);
      log("screening", `Intel score too low: ${p.name} ${formatIntelScore(p._intelScore)}`);
    });
    eligible.splice(0, eligible.length, ...eligible.filter(p => (p._intelScore?.total ?? 0) >= minIntelScore));
    if (eligible.length < before) {
      log("screening", `Intel score filter removed ${before - eligible.length} candidate(s)`);
    }
  }
  meteoraStage("intel", eligible.length);

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Dev blocklist check — filter pools whose creator is on the blocklist
  if (eligible.length > 0) {
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via dev blocklist`);
  }
  meteoraStage("pvp", eligible.length);

  if (config.indicators.enabled && eligible.length > 0) {
    const confirmations = [];
    for (const pool of eligible) {
      try {
        const confirmation = await confirmIndicatorPreset({
          mint: pool.base?.mint,
          side: "entry",
        });
        confirmations.push({ pool: pool.pool, confirmation });
        // Serialized fetch delay to prevent concurrent burst rate limit on Jupiter API
        await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (error) {
        confirmations.push({
          pool: pool.pool,
          confirmation: {
            enabled: true,
            confirmed: true,
            skipped: true,
            reason: `Indicator confirmation unavailable: ${error.message}`,
            intervals: [],
          },
        });
      }
    }
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`);
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }
  meteoraStage("indicators", eligible.length);

  // Fee-efficiency ranking — fee yield per unit of IL risk (relative to this set).
  // Annotates each candidate with pool._feeEfficiency; surfaced in the candidate
  // block, not used as a hard filter.
  rankByFeeEfficiency(eligible);

  // Organic-momentum — is the crowd growing or leaving? Annotates
  // pool._organicMomentum + caches it for deploy-time capture. Advisory by
  // default; optional hard-filter drops decaying candidates once validated.
  const momentumCfg = getOrganicMomentumConfig(config.screening);
  if (momentumCfg.enabled) {
    annotateOrganicMomentum(eligible, momentumCfg);
    if (momentumCfg.hardFilter) {
      const before = eligible.length;
      const decaying = eligible.filter((p) => p._organicMomentum?.decay_risk);
      decaying.forEach((p) => pushFilteredReason(filteredOut, p, "organic momentum: decaying (crowd leaving)"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p._organicMomentum?.decay_risk));
      if (before - eligible.length > 0) {
        log("screening", `Organic-momentum hard filter removed ${before - eligible.length} decaying candidate(s)`);
      }
    }
  }

  meteoraStage("final", eligible.length);

  // ── Meteora Stage-B funnel summary (never throws) ──
  if (meteoraStages) {
    try {
      const order = ["input", "metrics", "dev_score", "dump_guard", "intel", "pvp", "indicators", "final"];
      const line = order.filter((k) => meteoraStages[k] != null).map((k) => `${k}=${meteoraStages[k]}`).join(" → ");
      log("screening", `funnel: ${line}`);
    } catch { /* telemetry only */ }
  }

  // ─── Offline replay/backtest capture: snapshot rejected + accepted-but-
  // not-yet-deployed candidates so "should we have deployed here?" is
  // answerable later. Best-effort only — must never break screening.
  try {
    captureScreeningSnapshots(eligible, filteredOut);
  } catch (err) {
    log("screening", `Rejected-candidate capture failed (non-fatal): ${err.message}`);
  }

  // ─── RANK_SHADOW — gate mode still runs the CHEAP part of the rank pipeline
  // (broad fetch + safety gates + payload-only pre-score, NO enrichment calls)
  // and logs what rank mode WOULD admit, for calibration before flipping the
  // flag. Fully isolated: any failure logs nothing and never affects the cycle.
  if (source === "meteora" && config.screening.rankShadowEnabled) {
    try {
      const occPools = new Set(positions.map((p) => p.pool));
      const occMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
      await runRankShadow({ eligible, occupiedPools: occPools, occupiedMints: occMints });
    } catch { /* shadow only — never throws into the cycle */ }
  }

  return {
    candidates: eligible,
    total_screened: discovery.total ?? pools.length,
    source,
    filtered_examples: filteredOut.slice(0, 3),
    stage_counts: source === "gmgn"
      ? (discovery.stage_counts ? { ranked: discovery.total, ...discovery.stage_counts } : null)
      : (meteoraStages ? { source: "meteora", stage_a: discovery.stage_a ?? null, ...meteoraStages } : null),
    all_filtered: filteredOut,
  };
}

/**
 * "Rank, don't gate" admission pipeline (meteora source). Fetch a broad
 * safety-envelope universe → SAFETY hard gates only → payload-only pre-score →
 * expensive enrichment/gates on just the top ~2×rankAdmitCount → admit the final
 * top rankAdmitCount by admission score. Return shape mirrors gate-mode
 * getTopCandidates (candidates / total_screened / source / filtered_examples /
 * stage_counts / all_filtered) so downstream consumers are unchanged.
 */
async function getTopCandidatesRank({ limit = 10 } = {}) {
  const s = config.screening;
  const admitCount = Math.max(1, Number(s.rankAdmitCount ?? 8));
  const minIntel = Number(s.rankMinIntelScore ?? 35);
  const momentumCfg = getOrganicMomentumConfig(s);
  const filteredOut = [];

  // 1) Broad universe fetch (safety/structural envelope only).
  const { pools: universe, universe: universeCount } = await discoverPoolsBroad();

  // Occupied pools/mints (fresh scan).
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  // 2) SAFETY hard gates only (no quality metric floors).
  const safe = applyRankSafetyGates(universe, { occupiedPools, occupiedMints, filteredOut });

  // 3) Payload-only pre-score, then take the top ~2×admitCount for enrichment.
  const preScored = prescoreRankCandidates(safe, momentumCfg);
  const enrichSlice = preScored.slice(0, admitCount * 2);

  // 4) Expensive enrichment/gates on the slice only (same calls gate mode makes):
  //    dev-score fetch + dump-play guard + full intel rescoring.
  await Promise.all(
    enrichSlice.map(async (p) => {
      try {
        if ((!p.dev || typeof p.dev === "string") && p.base?.mint) {
          const devInfo = await getGmgnDevInfo(p.base.mint);
          if (devInfo) p.dev = devInfo;
        }
        p._devScore = computeDevScore(p);
      } catch (err) {
        log("screening", `rank: dev score failed for ${p.name}: ${err.message}`);
        p._devScore = null;
      }
    })
  );

  const survivors = [];
  for (const p of enrichSlice) {
    // Dump-play guard (same as gate mode).
    const change = p.price_change_pct ?? 0;
    if (change <= -20) {
      const score = p._devScore?.total ?? 50;
      const status = p.dev?.creator_token_status;
      const devSells = status === "creator_close" || (status && status.includes("sell"));
      if (score < 70) {
        pushFilteredReason(filteredOut, p, `dump play: dev score ${score} < 70`);
        continue;
      }
      if (devSells) {
        pushFilteredReason(filteredOut, p, `dump play: dev sold/closed`);
        continue;
      }
    }
    // Full intel rescoring now that dev score is present, then recompute the
    // admission score (dev reputation feeds intel's Trust dimension). The
    // within-set fee percentiles from prescore are reused so fee_tvl remains
    // the secondary ranking signal alongside the now-enriched intel.
    scoreCandidate(p);
    p._admissionScore = computeAdmissionScore(p, {
      momentumCfg,
      feePercentile: p._rankFeePct ?? null,
      feeTvlPercentile: p._rankFeeTvlPct ?? null,
    });
    // rankMinIntelScore garbage backstop.
    if ((p._intelScore?.total ?? 0) < minIntel) {
      pushFilteredReason(filteredOut, p, `intel score ${p._intelScore?.total?.toFixed(0) ?? "?"} below rankMinIntelScore ${minIntel}`);
      continue;
    }
    survivors.push(p);
  }

  // 5) Admit the final top rankAdmitCount by admission score.
  survivors.sort((a, b) => (b._admissionScore ?? 0) - (a._admissionScore ?? 0));
  const admitted = survivors.slice(0, Math.min(admitCount, limit || admitCount));

  // Fee-efficiency + organic-momentum candidate-block annotations (advisory
  // lines the LLM sees — same as gate mode's tail).
  rankByFeeEfficiency(admitted);
  if (momentumCfg.enabled) annotateOrganicMomentum(admitted, momentumCfg);

  // PVP enrichment / optional hard filter (same as gate mode).
  if (s.avoidPvpSymbols && admitted.length > 0) {
    await enrichPvpRisk(admitted);
    if (s.blockPvpSymbols) {
      const kept = admitted.filter((p) => {
        if (p.is_pvp) { pushFilteredReason(filteredOut, p, "PVP hard filter"); return false; }
        return true;
      });
      admitted.splice(0, admitted.length, ...kept);
    }
  }

  // Funnel telemetry (rank variant).
  try {
    log("screening",
      `funnel[rank]: universe=${universeCount} → safety=${safe.length}` +
      ` → prescore_pool=${enrichSlice.length} → enriched_gates=${survivors.length}` +
      ` → admitted=${admitted.length}`);
  } catch { /* telemetry only */ }

  // Rejected-candidate capture (unchanged store; must still run).
  try {
    captureScreeningSnapshots(admitted, filteredOut);
  } catch (err) {
    log("screening", `Rejected-candidate capture failed (non-fatal): ${err.message}`);
  }

  return {
    candidates: admitted,
    total_screened: universeCount,
    source: "meteora",
    filtered_examples: filteredOut.slice(0, 3),
    stage_counts: {
      source: "meteora",
      mode: "rank",
      universe: universeCount,
      safety: safe.length,
      prescore_pool: enrichSlice.length,
      enriched_gates: survivors.length,
      admitted: admitted.length,
    },
    all_filtered: filteredOut,
  };
}

/**
 * RANK_SHADOW — the cheap half of the rank pipeline, run while gate mode is live,
 * to log what rank mode WOULD admit (top 10) vs. what gate mode admitted + the
 * overlap. Broad fetch + safety gates + payload-only pre-score only (NO
 * enrichment). Caller wraps this in try/catch; if the extra fetch fails it throws
 * and the caller logs nothing.
 */
async function runRankShadow({ eligible, occupiedPools, occupiedMints }) {
  const s = config.screening;
  const admitCount = Math.max(1, Number(s.rankAdmitCount ?? 8));
  const momentumCfg = getOrganicMomentumConfig(s);

  const { pools: universe } = await discoverPoolsBroad();
  const shadowRejects = [];
  const safe = applyRankSafetyGates(universe, {
    occupiedPools, occupiedMints, filteredOut: shadowRejects,
  });
  const preScored = prescoreRankCandidates(safe, momentumCfg);
  const wouldAdmit = preScored.slice(0, admitCount);

  const gateAdmittedMints = new Set(
    (Array.isArray(eligible) ? eligible : []).map((p) => p.base?.mint).filter(Boolean)
  );
  const overlap = wouldAdmit.filter((p) => gateAdmittedMints.has(p.base?.mint)).length;

  const top = wouldAdmit
    .slice(0, 10)
    .map((p) => `${p.base?.symbol || "?"}(${(p._admissionScore ?? 0).toFixed(1)})`)
    .join(" ");

  log("screening",
    `[RANK_SHADOW] would-admit top${Math.min(wouldAdmit.length, 10)}: ${top}` +
    ` | gate-mode admitted: ${Array.isArray(eligible) ? eligible.length : 0} | overlap: ${overlap}`);
}

/**
 * Record compact snapshots of this cycle's rejected + accepted-but-not-
 * deployed candidates into the dedicated rejected-candidates store, for
 * offline replay ("would we have wanted this pool?"). Hard-capped and
 * try/catch-wrapped by the caller — never allowed to affect screening.
 *
 * Rejected entries only carry a resolvable pool_address once they've been
 * condensed (i.e. filtered inside this function, not the pre-condense
 * discovery.filtered_examples seed) — those are naturally skipped since
 * there's nothing to key the store on.
 *
 * @param {object[]} eligible - final candidate list returned to the LLM
 *   (accepted, not-yet-deployed)
 * @param {object[]} filteredOut - accumulated { name, reason, pool_address,
 *   _candidate } entries from this cycle's funnel
 */
function captureScreeningSnapshots(eligible, filteredOut) {
  // De-dupe rejected entries by pool address, keeping the LAST (furthest-
  // through-the-funnel) reason/candidate snapshot for each pool.
  const rejectedByPool = new Map();
  for (const entry of filteredOut) {
    if (!entry?.pool_address) continue; // pre-condense seed entries — no address, skip
    rejectedByPool.set(entry.pool_address, entry);
  }

  // Funnel order in filteredOut already means later entries got further
  // (survived more filters before failing); Map insertion-order iteration
  // preserves that, so slicing the tail favors "furthest through" when we
  // need to cap. Fall back to the first N if that distinction is moot.
  const rejectedEntries = [...rejectedByPool.values()];
  const cappedRejected = rejectedEntries.length > REJECTED_CAPTURE_MAX_POOLS_PER_CYCLE
    ? rejectedEntries.slice(-REJECTED_CAPTURE_MAX_POOLS_PER_CYCLE)
    : rejectedEntries;

  for (const entry of cappedRejected) {
    recordRejectedCandidate(entry.pool_address, {
      ...entry._candidate,
      name: entry.name,
      reason: entry.reason,
      accepted: false,
    });
  }

  // Accepted candidates that were returned to the LLM but not (yet)
  // deployed — cheaply distinguishable here since `eligible` at this point
  // IS exactly "returned to the LLM, not deployed" (deploy happens later,
  // in a separate tool call). Same per-cycle cap applies.
  const cappedAccepted = eligible.slice(0, REJECTED_CAPTURE_MAX_POOLS_PER_CYCLE);
  for (const p of cappedAccepted) {
    if (!p?.pool) continue;
    recordRejectedCandidate(p.pool, {
      ...p,
      name: p.name,
      accepted: true,
    });
  }
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),

    // Per-timeframe breakdown (populated when sourceTimeframe !== volatilityTimeframe)
    ...(p.volatility_timeframe && p.volatility_timeframe !== config.screening.timeframe ? {
      [`volume_${config.screening.timeframe}`]: round(p[`volume_${config.screening.timeframe}`] ?? null),
      [`volume_${p.volatility_timeframe}`]: round(p[`volume_${p.volatility_timeframe}`] ?? null),
      [`volatility_${config.screening.timeframe}`]: fix(p[`volatility_${config.screening.timeframe}`] ?? null, 4),
      [`volatility_${p.volatility_timeframe}`]: fix(p[`volatility_${p.volatility_timeframe}`] ?? null, 4),
    } : {}),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    total_lps: p.total_lps || 0,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
    // Organic-momentum trends (crowd growing vs leaving) — used by organic-momentum.js
    unique_traders_change_pct: fix(p.unique_traders_change_pct, 1),
    swap_count_change_pct: fix(p.swap_count_change_pct, 1),
    base_token_holders_change_pct: fix(p.base_token_holders_change_pct, 1),
    fee_active_tvl_ratio_change_pct: fix(p.fee_active_tvl_ratio_change_pct, 1),
    net_deposits_change_pct: fix(p.net_deposits_change_pct, 1),

    // Liquidity-relative + LP-activity metrics (Degen Score inputs)
    volume_active_tvl_ratio: p.volume_active_tvl_ratio != null ? fix(p.volume_active_tvl_ratio, 4) : null,
    unique_lps: p.unique_lps,
    unique_lps_change_pct: fix(p.unique_lps_change_pct, 1),
    positions_created: p.positions_created,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = numeric(n);
  return value != null ? Number(value.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
    // Kept only for same-cycle rejected-candidate capture (see end of
    // getTopCandidates); pool_address is undefined for pre-condense
    // (discovery.filtered_examples) entries, which is fine — those are
    // skipped by the capture step since there's no address to key on.
    pool_address: pool.pool || pool.pool_address || null,
    _candidate: pool,
  });
}
