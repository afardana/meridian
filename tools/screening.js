import { config, PLAYSTYLE_PRESETS, MIN_SAFE_BINS_BELOW } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown, recordRejectedCandidate, hasCleanPoolHistory } from "../pool-memory.js";
import { getGmgnDevInfo, getGmgnSafetyInfo } from "./gmgn.js";
import { getTokenAudit } from "./token.js";
import { computeIntelScore, resolveYieldWindowMode } from "../intel-score.js";
import { rankByFeeEfficiency, computeFeeEfficiency } from "../fee-efficiency.js";
import { annotateOrganicMomentum, getOrganicMomentumConfig, computeOrganicMomentum } from "../organic-momentum.js";
import { recordTvlSnapshot, checkTvlDrain } from "../tvl-guard.js";
import { computeDevScore } from "../dev-scoring.js";
import { detectPvpRival } from "../pvp.js";

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

/**
 * Scales minTxPerMin according to the screening timeframe.
 * Bursts over 5m require higher velocity (e.g. 5.0 tx/min = 25 swaps),
 * while sustained 1h windows (e.g. 2.0 tx/min = 120 swaps/h) and
 * steady 24h windows (0.8 tx/min = 1,152 swaps/day) allow established
 * high-TVL pools to qualify.
 */
export function getMinTxPerMinForTimeframe(timeframe = "1h", baseThreshold = 5.0) {
  if (baseThreshold == null) return 0;
  const base = Number(baseThreshold);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const tf = String(timeframe || "1h").toLowerCase();
  if (tf === "5m") return base;
  if (tf === "1h") return Math.min(base, 2.0);
  if (tf === "24h") return Math.min(base, 0.8);
  return Math.min(base, 2.0);
}

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

// ── Intel Safety-input enrichment ───────────────────────────────────────────
// The Meteora discovery payload never carries the on-chain safety fields that
// intel-score.js scoreSafety reads (audit.mint_disabled, gmgn_top10_holder_pct,
// gmgn_bundler_pct, gmgn_bot_degen_pct, gmgn_dev_team_hold_pct), so Safety is
// permanently pinned at its neutral 50 fallback — capping genuinely-clean tokens
// ~6-12 intel points below their true score and worsening intel-gate starvation.
// This step fetches those fields (Jupiter audit, keyless + GMGN stat when keyed),
// maps them onto the exact scoreSafety-facing names, and — flag-gated — either
// logs the would-change (log_only) or applies it before scoreCandidate (enforce).
// Every fetch failure degrades to null inputs → the current Safety-50 behavior.

const SAFETY_ENRICH_TTL_MS = 30 * 60 * 1000; // repeat cycles see the same pools
const _safetyEnrichCache = new Map(); // mint -> { data, ts }

/**
 * Combine the Jupiter audit + GMGN stat blocks into the six scoreSafety inputs.
 * PURE + null-safe: any missing source field stays null (→ scoreSafety's neutral
 * midpoint for that component). GMGN is preferred for the overlapping
 * concentration/bundler/bot/dev rates (curated), Jupiter fills the rest.
 * @param {object|null} jup - getTokenAudit() result
 * @param {object|null} gmgn - getGmgnSafetyInfo() result
 * @returns {{ mint_disabled, freeze_disabled, top10_holder_pct, bundler_pct, bot_pct, dev_team_hold_pct }}
 */
export function mapSafetyInputs(jup, gmgn) {
  const j = jup || {};
  const g = gmgn || {};
  const pick = (...vals) => {
    for (const v of vals) if (v != null && v !== "") return v;
    return null;
  };
  return {
    mint_disabled: j.mint_disabled != null ? j.mint_disabled : null,
    freeze_disabled: j.freeze_disabled != null ? j.freeze_disabled : null,
    top10_holder_pct: pick(g.top10_holder_pct, j.top_holders_pct),
    bundler_pct: pick(g.bundler_pct, j.bundler_pct),
    bot_pct: pick(g.bot_pct, j.bot_holders_pct),
    dev_team_hold_pct: pick(g.dev_team_hold_pct, j.dev_balance_pct),
  };
}

/**
 * Write the mapped Safety inputs onto a candidate under the exact field names
 * scoreSafety reads. Only sets fields that are non-null so partial data never
 * clobbers an existing value with a null. Mutates and returns the pool.
 */
export function applySafetyInputs(pool, m) {
  if (!pool || !m) return pool;
  if (m.mint_disabled != null || m.freeze_disabled != null) {
    pool.audit = pool.audit || {};
    if (m.mint_disabled != null) pool.audit.mint_disabled = m.mint_disabled;
    if (m.freeze_disabled != null) pool.audit.freeze_disabled = m.freeze_disabled;
  }
  if (m.top10_holder_pct != null) pool.gmgn_top10_holder_pct = m.top10_holder_pct;
  if (m.bundler_pct != null) pool.gmgn_bundler_pct = m.bundler_pct;
  if (m.bot_pct != null) pool.gmgn_bot_degen_pct = m.bot_pct;
  if (m.dev_team_hold_pct != null) pool.gmgn_dev_team_hold_pct = m.dev_team_hold_pct;
  return pool;
}

// Fetch + map the Safety inputs for one mint, cached per-mint with a TTL.
async function fetchSafetyInputs(mint) {
  if (!mint) return null;
  const cached = _safetyEnrichCache.get(mint);
  if (cached && (Date.now() - cached.ts) < SAFETY_ENRICH_TTL_MS) return cached.data;
  const [jup, gmgn] = await Promise.all([
    getTokenAudit(mint).catch(() => null),
    getGmgnSafetyInfo(mint).catch(() => null),
  ]);
  const data = (jup || gmgn) ? mapSafetyInputs(jup, gmgn) : null;
  _safetyEnrichCache.set(mint, { data, ts: Date.now() });
  return data;
}

/**
 * Enrich the Safety sub-inputs for up to safetyEnrichMaxPerCycle candidates.
 * Insertion point: after the metric/dev/dump gates, before scoreCandidate. Fully
 * isolated (try/catch per candidate) — never throws into the screening cycle.
 *   - "off": no fetches (should not be called; guarded anyway).
 *   - "log_only": compute enriched score, log, attach _intelSafety* + _safetyEnrichInputs
 *                 to the candidate; DO NOT mutate the scoring fields (admission unchanged).
 *   - "enforce": additionally apply the inputs so the following scoreCandidate() —
 *                and the deploy-time signal_snapshot (index.js reads _intelScore.safety)
 *                — reflect the enriched Safety.
 * @param {object[]} candidates - survivors, in admission-priority order
 * @param {string} mode - resolved config.screening.safetyEnrichMode
 */
async function enrichSafetyInputs(candidates, mode) {
  if (mode === "off" || !Array.isArray(candidates) || candidates.length === 0) return;
  const maxN = Math.max(0, Number(config.screening.safetyEnrichMaxPerCycle ?? 6));
  if (!maxN) return;
  const slice = candidates.slice(0, maxN);
  for (const p of slice) {
    try {
      const mint = p.base?.mint;
      if (!mint) continue;
      const inputs = await fetchSafetyInputs(mint);
      if (!inputs) continue;
      const baseIntel = p._intelScore ?? computeIntelScore(p);
      const enrichedIntel = computeIntelScore(applySafetyInputs({ ...p, audit: { ...(p.audit || {}) } }, inputs));
      p._intelSafetyBase = baseIntel.safety;
      p._intelSafetyEnriched = enrichedIntel.safety;
      p._intelTotalBase = baseIntel.total;
      p._intelTotalEnriched = enrichedIntel.total;
      p._safetyEnrichInputs = inputs;
      const label = p.name || p.pool || mint.slice(0, 8);
      log("screening", `[SAFETY_ENRICH] ${label}: safety ${baseIntel.safety}→${enrichedIntel.safety} intel ${baseIntel.total}→${enrichedIntel.total} (${mode})`);
      if (mode === "enforce") applySafetyInputs(p, inputs);
    } catch (err) {
      log("screening", `[SAFETY_ENRICH] error for ${p?.name || p?.base?.mint || "?"}: ${err.message}`);
    }
  }
}

/**
 * Composite candidate-admission score for "rank, don't gate" mode.
 *
 * PURE and payload-only — computed entirely from the discovery payload the broad
 * fetch already returned, with NO per-pool API calls, so it can be run over the
 * whole safety-survivor set cheaply for admission pre-ranking. The expensive
 * enrichment/gates (dev-score, dump-play, full intel rescoring) run afterwards on
 * only the top slice.
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

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

export async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
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
 * RANK_FETCH_MAX_REQUESTS requests total. Returns condensed pools (condensePool
 * shape) plus the raw universe count. Best-effort: any page
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

  // ── Steady-pool envelope (plan #12). The 1h fee floor above only surfaces pools
  // mid-burst; pools paying 2–3%/24h on >$100k TVL read 0.05–0.15%/h between bursts
  // and never get fetched. One extra request at the 24h timeframe; extras are
  // re-fetched at the screening timeframe so every windowed field downstream
  // (fee_active_tvl_ratio, volume, the flow: line) stays 1h-consistent.
  const steadyExtra = await discoverSteadyEnvelope(s, byAddr);
  requests += steadyExtra.requests;

  const topExtra = await discoverTopPerformers(s, byAddr);
  requests += topExtra.requests;

  const rawPools = await applyVolatilityTimeframe([...byAddr.values()], s.timeframe);
  return { pools: rawPools.map(condensePool), universe: byAddr.size, requests };
}

// ── Plan #12 Phase 3: steady-lane width hints ────────────────────────────────
// pool address → { bins_below, min, max, shape, playstyle, at }. Written at rank
// admission for steady-envelope pools when steadyLanePlaystyle names a preset;
// read by the executor's deploy_position safety block (floor relaxation + default
// bins/shape when the LLM omits them). TTL guards against a stale hint outliving
// the candidate set that produced it.
const _steadyLaneHints = new Map();
const STEADY_LANE_HINT_TTL_MS = 3 * 60 * 60 * 1000;

function computeSteadyLaneHint(p) {
  const s = config.screening;
  const styleKey = String(s.steadyLanePlaystyle ?? "").toLowerCase();
  if (!styleKey || !Object.prototype.hasOwnProperty.call(PLAYSTYLE_PRESETS, styleKey)) return null;
  const preset = PLAYSTYLE_PRESETS[styleKey];
  const min = Math.max(MIN_SAFE_BINS_BELOW, Math.round(preset.min));
  const max = Math.max(min, Math.round(preset.max));
  const vol = Number(p.volatility);
  // Same shape as the global formula (computeBinsBelow in index.js), on the lane's range.
  const bins = Number.isFinite(vol) && vol > 0
    ? Math.max(min, Math.min(max, Math.round(min + (vol / 5) * (max - min))))
    : max;
  const shapeRaw = String(s.steadyLaneShape ?? "spot").toLowerCase();
  const shape = ["spot", "curve", "bidask"].includes(shapeRaw) ? shapeRaw : "spot";
  return { bins_below: bins, min, max, shape, playstyle: styleKey };
}

/** Executor-side lookup (fresh within TTL) — null when the pool is not a steady-lane admission. */
export function getSteadyLaneHint(poolAddress) {
  if (!poolAddress) return null;
  const h = _steadyLaneHints.get(poolAddress);
  if (!h) return null;
  if (Date.now() - h.at > STEADY_LANE_HINT_TTL_MS) { _steadyLaneHints.delete(poolAddress); return null; }
  return h;
}

// ── Top Performers hints ──────────────────────────────────────────────────
// pool address → { bins_below, bins_above, shape, at }. Recorded when a top-
// performer pool is admitted; read by the executor's deploy_position safety block.
const _topPerformerHints = new Map();
const TOP_PERFORMER_HINT_TTL_MS = 3 * 60 * 60 * 1000;

/** Executor-side lookup (fresh within TTL) — null when the pool is not a top-performer admission. */
export function getTopPerformerHint(poolAddress) {
  if (!poolAddress) return null;
  const h = _topPerformerHints.get(poolAddress);
  if (!h) return null;
  if (Date.now() - h.at > TOP_PERFORMER_HINT_TTL_MS) { _topPerformerHints.delete(poolAddress); return null; }
  return h;
}

/**
 * Plan #12 steady-pool pass. Mutates `byAddr` (adds extras, tagged `_steadyEnvelope`)
 * when rankSteadyEnvelopeEnabled; otherwise logs [STEADY_ENVELOPE_SHADOW] would-add.
 * Never throws — any failure degrades to "no extras".
 */
async function discoverSteadyEnvelope(s, byAddr) {
  const enabled = !!s.rankSteadyEnvelopeEnabled;
  const minTvl = Math.max(0, Number(s.rankSteadyMinTvl ?? 100_000));
  const minFee24h = Math.max(0, Number(s.rankSteadyMinFeeTvl24h ?? 1.5));
  const maxExtra = Math.max(0, Number(s.rankSteadyMaxExtra ?? 10));
  let requests = 0;
  try {
    const filters = [
      "base_token_has_critical_warnings=false",
      "quote_token_has_critical_warnings=false",
      s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
      "base_token_has_high_single_ownership=false",
      "pool_type=dlmm",
      `base_token_market_cap>=${RANK_ENVELOPE.minMcap}`,
      `base_token_market_cap<=${RANK_ENVELOPE.maxMcap}`,
      `base_token_holders>=${RANK_ENVELOPE.minHolders}`,
      `tvl>=${minTvl}`,
      `fee_active_tvl_ratio>=${minFee24h}`,
      `dlmm_bin_step>=${s.minBinStep}`,
      `dlmm_bin_step<=${s.maxBinStep}`,
      s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
      s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    ].filter(Boolean).join("&&");
    const url = `${POOL_DISCOVERY_BASE}/pools?` +
      `page_size=${RANK_FETCH_PAGE_SIZE}` +
      `&filter_by=${encodeURIComponent(filters)}` +
      `&timeframe=24h` +
      `&category=${s.category}`;
    const res = await fetch(url);
    requests++;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    const rows = Array.isArray(data.data) ? data.data : [];
    const candidates = rows.filter((p) => p?.pool_address && !byAddr.has(p.pool_address));
    if (candidates.length === 0) return { requests, added: 0 };

    const describe = (p) =>
      `${p.name || p.pool_address.slice(0, 8)} (tvl $${Math.round(p.tvl || 0)}, fee24h ${Number(p.fee_active_tvl_ratio || 0).toFixed(2)}%)`;

    if (!enabled) {
      log("screening",
        `[STEADY_ENVELOPE_SHADOW] would-add ${candidates.length} pool(s) outside the ${s.timeframe} burst envelope: ` +
        candidates.slice(0, 12).map(describe).join(", ") +
        (candidates.length > 12 ? `, +${candidates.length - 12} more` : "") +
        " (rankSteadyEnvelopeEnabled=false)");
      return { requests, added: 0 };
    }

    // Highest 24h fee velocity first; cap the per-cycle re-fetch budget.
    candidates.sort((a, b) => Number(b.fee_active_tvl_ratio || 0) - Number(a.fee_active_tvl_ratio || 0));
    const slice = candidates.slice(0, maxExtra);
    const refetched = await Promise.allSettled(
      slice.map((p) => fetchPoolDiscoveryDetail({ poolAddress: p.pool_address, timeframe: s.timeframe }))
    );
    requests += slice.length;
    let added = 0;
    const names = [];
    refetched.forEach((r, i) => {
      const pool = r.status === "fulfilled" ? r.value : null;
      if (!pool?.pool_address || byAddr.has(pool.pool_address)) return;
      pool._steadyEnvelope = true;
      pool.fee_active_tvl_ratio_24h = Number(slice[i].fee_active_tvl_ratio ?? null);
      byAddr.set(pool.pool_address, pool);
      added++;
      names.push(describe(slice[i]));
    });
    if (added > 0) {
      log("screening",
        `[STEADY_ENVELOPE] added ${added}/${candidates.length} steady pool(s) to the universe: ${names.join(", ")}` +
        (candidates.length > maxExtra ? ` (capped at rankSteadyMaxExtra=${maxExtra})` : ""));
    }
    return { requests, added };
  } catch (err) {
    log("screening", `[STEADY_ENVELOPE] pass failed (ignored): ${err.message}`);
    return { requests, added: 0 };
  }
}

/**
 * Top Performers discovery: Ingest top DLMM pools directly from Meteora Top Performers tab.
 * Endpoint: category=top&timeframe=24h&filter_by=pool_type=dlmm
 */
export async function fetchMeteoraTopPerformers({ limit = 10 } = {}) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=20&category=top&timeframe=24h&filter_by=pool_type=dlmm`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Top performers API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows.filter((p) => p?.pool_address && p.pool_type === "dlmm").slice(0, limit);
}

async function discoverTopPerformers(s, byAddr) {
  if (s.topPerformersEnabled === false) return { requests: 0, added: 0 };
  let requests = 0;
  let added = 0;
  try {
    const limit = Math.max(1, Number(s.topPerformersLimit ?? 10));
    const pools = await fetchMeteoraTopPerformers({ limit });
    requests++;
    for (const p of pools) {
      if (!p?.pool_address) continue;
      p._isTopPerformer = true;
      if (!byAddr.has(p.pool_address)) {
        byAddr.set(p.pool_address, p);
        added++;
      } else {
        byAddr.get(p.pool_address)._isTopPerformer = true;
      }
    }
    if (added > 0) {
      log("screening", `[TOP_PERFORMERS] Added ${added} top performer pool(s) from Meteora Top Performers tab`);
    }
  } catch (err) {
    log("screening", `Top performers discovery failed (non-fatal): ${err.message}`);
  }
  return { requests, added };
}

/**
 * SAFETY-only hard gates. Quality metric floors (minHolders/minMcap/maxMcap/
 * minFeeActiveTvlRatio) are deliberately NOT applied here — they are score inputs;
 * minTvl is enforced at admission (getTopCandidatesRank), maxTvl below.
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
    // maxTvl (audit 01 §2): previously applied only by the executor in rank mode, so a
    // pool above the ceiling could be judged by the LLM and then SAFETY_BLOCKed.
    const maxTvl = Number(config.screening.maxTvl);
    if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
      pushFilteredReason(filteredOut, p, `tvl above maxTvl`);
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
 * Returns eligible pools for the agent to evaluate and pick from. Rank admission
 * is the only pipeline (gate-mode admission + [RANK_SHADOW] removed 2026-09-25,
 * audit 01 §3): broad safety-envelope fetch → safety gates → admission-score
 * ranking → enrichment on the top slice → admit the top rankAdmitCount.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  return getTopCandidatesRank({ limit });
}

/**
 * "Rank, don't gate" admission pipeline (meteora source). Fetch a broad
 * safety-envelope universe → SAFETY hard gates only → payload-only pre-score →
 * expensive enrichment/gates on just the top ~2×rankAdmitCount → admit the final
 * top rankAdmitCount by admission score. Return shape: candidates /
 * total_screened / source / filtered_examples / stage_counts / all_filtered.
 */
async function getTopCandidatesRank({ limit = 10 } = {}) {
  const s = config.screening;
  const admitCount = Math.max(1, Number(s.rankAdmitCount ?? 8));
  const minIntel = Number(s.rankMinIntelScore ?? 35);
  const momentumCfg = getOrganicMomentumConfig(s);
  const filteredOut = [];
  // Plan #12 Phase 2: while intelYieldWindowMode=legacy, record what the window-
  // aware ("log") Yield would score each enriched-gate pool — one line per cycle.
  const yieldShadowMode = resolveYieldWindowMode() === "legacy";
  const yieldShadowRows = [];

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

  // 4) Expensive enrichment/gates on the slice only:
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

  // Intel Safety-input enrichment (flag-gated) on the enrichment slice —
  // after dev-score, before intel rescoring, so
  // an enforced enriched Safety affects the admission score + rankMinIntelScore gate.
  const safetyEnrichMode = String(s.safetyEnrichMode || "off").toLowerCase();
  if (safetyEnrichMode !== "off" && enrichSlice.length > 0) {
    await enrichSafetyInputs(enrichSlice, safetyEnrichMode);
  }

  const survivors = [];
  for (const p of enrichSlice) {
    // Dump-play guard.
    const change = p.price_change_pct ?? 0;
    if (change <= -20) {
      const score = p._devScore?.total ?? 50;
      const status = p.dev?.creator_token_status;
      const devSells = status === "creator_close" || (status && status.includes("sell"));
      if (devSells) {
        pushFilteredReason(filteredOut, p, `dump play: dev sold/closed`);
        continue;
      }
      const isTop = !!(p.top_performer || p._isTopPerformer);
      if (score < 70 && !isTop) {
        pushFilteredReason(filteredOut, p, `dump play: dev score ${score} < 70`);
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
    const intelTotal = p._intelScore?.total ?? 0;
    if (yieldShadowMode) {
      try {
        const alt = computeIntelScore(p, { yieldMode: "log" });
        yieldShadowRows.push(`${p.name || String(p.pool || "").slice(0, 8)}${p.steady_envelope ? "*" : ""} ${intelTotal.toFixed(0)}→${alt.total.toFixed(0)}`);
      } catch { /* shadow only */ }
    }
    // rankMinIntelScore garbage backstop. Steady-envelope pools (plan #12) may use
    // their own bar (rankSteadyMinIntel): they already sit in the >=$100k entry-TVL
    // band (zero disasters in our history) with enriched Safety available, so the
    // intel gate's rug-filter job is largely done there and the LLM judges the
    // quality on the flow: line (+ probe tier). null = same bar (inert).
    const steadyBarRaw = Number(s.rankSteadyMinIntel);
    const useSteadyBar = !!p.steady_envelope && Number.isFinite(steadyBarRaw) && steadyBarRaw > 0;
    const intelBar = useSteadyBar ? steadyBarRaw : minIntel;
    if (intelTotal < intelBar) {
      pushFilteredReason(filteredOut, p, `intel score ${intelTotal.toFixed(0)} below ${useSteadyBar ? "rankSteadyMinIntel" : "rankMinIntelScore"} ${intelBar}`);
      continue;
    }
    // Entry-TVL floor + pool-memory exemption. RANK_ENVELOPE.minTvl (10k) is a broad
    // rug-safety floor for the FETCH; the configured screening.minTvl is the much
    // higher quality floor and must still apply here, or rank mode silently ignores
    // it. It is enforced at admission rather than in the broad query so that
    // history-exempt pools below the floor remain discoverable at all.
    // Mirrors validateDeployPoolThresholds (executor). Without this, prod (which runs rank
    // mode) admitted sub-floor pools, burned a full LLM cycle + bear debate on them,
    // and only then hit the executor's SAFETY_BLOCK — observed 2026-07-27 on an
    // $18,329 TVL pool.
    const rankTvl = Number(p.tvl ?? p.active_tvl ?? 0);
    const rankMinTvl = Number(s.minTvl ?? 0);
    if (Number.isFinite(rankMinTvl) && rankMinTvl > 0 && rankTvl > 0 && rankTvl < rankMinTvl) {
      const proven = hasCleanPoolHistory(p.pool ?? p.pool_address);
      const isTopPerformer = !!(p.top_performer || p._isTopPerformer);
      const topMinTvl = Math.max(10_000, Number(s.topPerformersMinTvl ?? 15_000));

      if (isTopPerformer && rankTvl >= topMinTvl) {
        let trendOk = true;
        if (s.topPerformersRequireTrend !== false) {
          try {
            const { isRebalanceTrendIncreasing } = await import("./rebalance-trend.js");
            const trend = await isRebalanceTrendIncreasing(p.pool ?? p.pool_address, {
              timeframe: s.topPerformerTrendTimeframe || "5m",
              candleCount: s.topPerformerTrendCandles || 6,
            });
            if (trend.confirmed) {
              p._topPerformerTrend = trend;
              log("screening", `[TOP_PERFORMER_ADMIT] ${p.name || p.pool}: TVL $${Math.round(rankTvl)}, trend confirmed (${trend.reason})`);
            } else {
              trendOk = false;
              log("screening", `[TOP_PERFORMER_COOLING] ${p.name || p.pool}: TVL $${Math.round(rankTvl)}, trend not confirmed (${trend.reason})`);
            }
          } catch (e) {
            log("screening_warn", `Top performer trend check error for ${p.name || p.pool}: ${e.message}`);
          }
        }
        if (trendOk) {
          p._isTopPerformer = true;
          p._admissionScore = (p._admissionScore ?? 50) + 15;
          _topPerformerHints.set(p.pool ?? p.pool_address, {
            bins_below: 69,
            bins_above: 0,
            shape: "spot",
            at: Date.now(),
          });
          // Plan #15 item 4: a sub-floor Top Performer is admitted for judgment but
          // never at full size — 60–100k TVL is the worst band in our history (14.8%
          // disasters, 07-27 audit). Unless the pool has clean history it deploys as
          // a SCOUT (executor clamps to scoutSizeSol; mirrored in
          // validateDeployPoolThresholds). scoutTierEnabled=false → executor blocks.
          if (!proven.clean) {
            p._scoutTier = true;
            log("screening", `[TOP_PERFORMER] ${p.name || p.pool}: TVL $${Math.round(rankTvl)} < minTvl $${rankMinTvl} — admitted as SCOUT (size capped at ${s.scoutSizeSol ?? 0.12} SOL), not full size`);
          }
        } else {
          pushFilteredReason(filteredOut, p, `Top performer 15m trend not confirmed`);
          continue;
        }
      } else if (proven.clean) {
        log("screening",
          `[TVL_EXEMPT] ${p.name || p.pool || p.pool_address}: TVL $${Math.round(rankTvl)} < minTvl $${rankMinTvl} ` +
          `but pool history is clean (${proven.closes} closes, worst ${proven.worst_pnl_pct}%, avg ${proven.avg_pnl_pct}%) — admitting`);
      } else {
        // Scout tier: sub-floor pool with high enriched intel admitted at a hard-
        // capped size (executor clamps to scoutSizeSol) to BUILD the pool history
        // the exemption needs — without scouts the exemptable set can only shrink,
        // since the floor blocks the first deploy that would create history.
        // Intel bar enforced here (only place enriched intel exists); size cap +
        // concurrency enforced in the executor (validateDeployPoolThresholds).
        const scoutIntelBar = Number(s.scoutMinIntel ?? 70);
        const intelNow = p._intelScore?.total ?? 0;
        const scoutEligible = intelNow >= scoutIntelBar;
        if (!scoutEligible) {
          pushFilteredReason(filteredOut, p, `TVL $${Math.round(rankTvl)} below minTvl $${rankMinTvl}`);
          continue;
        }
        if (!s.scoutTierEnabled) {
          log("screening",
            `[SCOUT_SHADOW] would-admit ${p.name || p.pool}: TVL $${Math.round(rankTvl)} < floor but intel ` +
            `${intelNow.toFixed(0)} >= ${scoutIntelBar} — scout tier (scoutTierEnabled=false)`);
          pushFilteredReason(filteredOut, p, `TVL $${Math.round(rankTvl)} below minTvl $${rankMinTvl}`);
          continue;
        }
        p._scoutTier = true;
        log("screening",
          `[SCOUT] admitting ${p.name || p.pool} as scout: TVL $${Math.round(rankTvl)} < floor $${rankMinTvl}, ` +
          `intel ${intelNow.toFixed(0)} >= ${scoutIntelBar} — size capped at ${s.scoutSizeSol ?? 0.12} SOL (history-building)`);
      }
    }

    // Feature 4: Volume/TVL Utilization gate
    // Plan #15 item 5: both velocity gates are BURST gates measured on the screening
    // window. A steady-lane pool (plan #12) is by definition between bursts — it
    // was admitted on its 24h fee/TVL — so these gates would delete the lane
    // (they did: MANLET/TOAD-class pools could not pass at 1h). Waived for the
    // steady lane, mirrored in validateDeployPoolThresholds; the 24h fee floor
    // (rankSteadyMinFeeTvl24h) remains the lane's activity requirement.
    const steadyLaneWaiver = !!p.steady_envelope;
    const volTvl = numeric(p.volume_tvl_ratio) ?? (rankTvl > 0 && p.volume != null ? numeric(p.volume) / rankTvl : null);
    if (!steadyLaneWaiver && s.minVolumeTvlRatio != null && s.minVolumeTvlRatio > 0) {
      if (volTvl == null || volTvl < s.minVolumeTvlRatio) {
        pushFilteredReason(filteredOut, p, `volume/TVL ratio ${volTvl != null ? volTvl.toFixed(4) : "unknown"} below minVolumeTvlRatio ${s.minVolumeTvlRatio}`);
        continue;
      }
    }

    // Feature 1: Transaction Velocity (Tx/min) gate
    const tfMinutes = TIMEFRAME_MINUTES[s.timeframe] || 5;
    const swapCount = numeric(p.swap_count);
    const txPerMin = p.tx_per_min != null ? numeric(p.tx_per_min) : (swapCount != null && tfMinutes > 0 ? swapCount / tfMinutes : null);
    const effectiveMinTx = getMinTxPerMinForTimeframe(s.timeframe, s.minTxPerMin);
    if (!steadyLaneWaiver && effectiveMinTx > 0) {
      if (txPerMin == null || txPerMin < effectiveMinTx) {
        pushFilteredReason(filteredOut, p, `tx/min ${txPerMin != null ? txPerMin.toFixed(2) : "unknown"} below minTxPerMin ${effectiveMinTx}`);
        continue;
      }
    }
    if (steadyLaneWaiver) {
      log("screening", `[LANE] velocity gates waived for steady-lane ${p.name || p.pool}: vol/TVL ${volTvl != null ? volTvl.toFixed(4) : "?"} (floor ${s.minVolumeTvlRatio ?? "-"}), tx/min ${txPerMin != null ? txPerMin.toFixed(2) : "?"} (floor ${effectiveMinTx})`);
    }

    survivors.push(p);
  }

  // 5) Admit the final top rankAdmitCount by admission score.
  survivors.sort((a, b) => (b._admissionScore ?? 0) - (a._admissionScore ?? 0));
  const admitted = survivors.slice(0, Math.min(admitCount, limit || admitCount));

  // Plan #12 Phase 3: per-lane width. Steady-lane admissions get a bins/shape hint
  // from steadyLanePlaystyle (candidate-block `lane_width:` line + executor floor/
  // default via getSteadyLaneHint). Inert while steadyLanePlaystyle is null.
  for (const p of admitted) {
    if (p.steady_envelope) {
      const hint = computeSteadyLaneHint(p);
      if (hint) {
        p.lane_width = hint;
        _steadyLaneHints.set(p.pool, { ...hint, at: Date.now() });
      }
    }
    if (p.top_performer || p._isTopPerformer) {
      const topHint = { bins_below: 69, bins_above: 0, shape: "spot", at: Date.now() };
      p.lane_width = topHint;
      _topPerformerHints.set(p.pool, topHint);
    }
  }

  // Fee-efficiency + organic-momentum candidate-block annotations (advisory
  // lines the LLM sees).
  rankByFeeEfficiency(admitted);
  if (momentumCfg.enabled) annotateOrganicMomentum(admitted, momentumCfg);

  // PVP enrichment / optional hard filter.
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

  if (yieldShadowMode && yieldShadowRows.length) {
    log("screening",
      `[YIELD_WINDOW_SHADOW] intel legacy→log at the enriched gate (bar ${minIntel}; *=steady lane): ` +
      yieldShadowRows.join(", "));
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

  // Proposed admission (audit 01 §5 Q2/Q3/Q10) in SHADOW: same safe set, one fee-rate
  // sort, no intel bar, sub-floor = scout, no steady-lane waivers. One line per cycle
  // comparing the two admitted sets; changes nothing.
  if (s.admissionShadowEnabled !== false) {
    try {
      const shadow = admitByFeeRate(safe, { screening: s, limit: Math.min(admitCount, limit || admitCount) });
      logAdmissionShadow(admitted, shadow, filteredOut);
    } catch (err) {
      log("screening", `[ADMISSION_SHADOW] failed (non-fatal): ${err.message}`);
    }
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
export function condensePool(p) {
  const tfMinutes = TIMEFRAME_MINUTES[config.screening.timeframe] || 5;
  const txPerMin = p.tx_per_min != null
    ? fix(p.tx_per_min, 2)
    : (p.swap_count != null && tfMinutes > 0 ? fix(p.swap_count / tfMinutes, 2) : null);
  const volTvl = p.volume_tvl_ratio != null
    ? fix(p.volume_tvl_ratio, 4)
    : (p.tvl > 0 && p.volume != null ? fix(p.volume / p.tvl, 4) : null);

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
    dynamic_fee_pct: p.dynamic_fee_pct != null ? fix(p.dynamic_fee_pct, 4) : null,
    // Plan #12: surfaced by the steady-pool (24h) envelope pass, not the 1h burst envelope.
    steady_envelope: !!p._steadyEnvelope,
    top_performer: !!p._isTopPerformer,
    fee_active_tvl_ratio_24h: p.fee_active_tvl_ratio_24h != null ? fix(p.fee_active_tvl_ratio_24h, 4) : null,
    // 24h fee/TVL under the name the `flow:` candidate line reads (audit 01 §2 — the line
    // previously read a field nothing produced). Only steady-envelope extras carry it.
    fee_tvl_24h: p.fee_active_tvl_ratio_24h != null ? fix(p.fee_active_tvl_ratio_24h, 4) : null,

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


    // Raw safety flags (the envelope fetches already filter these server-side; the
    // Top-Performer feed does not, so the proposed admission checks them client-side).
    critical_warnings: p.base_token_has_critical_warnings === true || p.quote_token_has_critical_warnings === true ? true
      : (p.base_token_has_critical_warnings === false ? false : null),
    single_ownership: p.base_token_has_high_single_ownership === true ? true
      : (p.base_token_has_high_single_ownership === false ? false : null),

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
    tx_per_min: txPerMin,
    unique_traders: p.unique_traders,
    // Organic-momentum trends (crowd growing vs leaving) — used by organic-momentum.js
    unique_traders_change_pct: fix(p.unique_traders_change_pct, 1),
    swap_count_change_pct: fix(p.swap_count_change_pct, 1),
    base_token_holders_change_pct: fix(p.base_token_holders_change_pct, 1),
    fee_active_tvl_ratio_change_pct: fix(p.fee_active_tvl_ratio_change_pct, 1),
    net_deposits_change_pct: fix(p.net_deposits_change_pct, 1),

    // Liquidity-relative + LP-activity metrics (Degen Score inputs)
    volume_tvl_ratio: volTvl,
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

// ── Proposed admission (audit 01 §5 Q2 / Q3 / Q10) — pure, shadow-first ──────
// Safety floors stay hard gates; quality is ONE sort on the 24h-equivalent fee rate
// (max of the windowed fee/TVL scaled to a day and the pool's own 24h figure — the
// same number the log-mode Yield score uses); intel is not an admission bar; a pool
// under minTvl is admitted at scout size (or rejected when the scout tier is off);
// no steady-lane velocity waivers; the dump guard is the rule it already is under the
// GMGN ban: window move ≤ −20 % rejects unless the pool is a Top Performer.
export function feeRate24hEq(p, tfMinutes) {
  const toDay = 1440 / (Number(tfMinutes) > 0 ? Number(tfMinutes) : 60);
  const windowed = numeric(p.fee_active_tvl_ratio);
  const daily = numeric(p.fee_active_tvl_ratio_24h);
  const candidates = [];
  if (windowed != null) candidates.push(windowed * toDay);
  if (daily != null) candidates.push(daily);
  return candidates.length ? Math.max(...candidates) : null;
}

export function admitByFeeRate(pools, { screening: s, limit } = {}) {
  const cfg = s || config.screening;
  const tfMinutes = TIMEFRAME_MINUTES[cfg.timeframe] || 5;
  const minTvl = Number(cfg.minTvl ?? 0);
  const minBinStep = Number(cfg.minBinStep ?? 0), maxBinStep = Number(cfg.maxBinStep ?? Infinity);
  const minVolTvl = Number(cfg.minVolumeTvlRatio ?? 0);
  const effectiveMinTx = getMinTxPerMinForTimeframe(cfg.timeframe, cfg.minTxPerMin);
  const rejected = [];
  const survivors = [];
  for (const p of pools || []) {
    const name = p.name || String(p.pool || "").slice(0, 8);
    const reject = (reason) => rejected.push({ name, pool: p.pool ?? p.pool_address ?? null, reason });
    const holders = numeric(p.holders);
    const mcap = numeric(p.mcap);
    const binStep = numeric(p.bin_step);
    const tvl = numeric(p.tvl ?? p.active_tvl) ?? 0;
    if (p.critical_warnings === true) { reject("critical token warnings"); continue; }
    if (p.single_ownership === true) { reject("high single ownership"); continue; }
    if (holders != null && holders < RANK_ENVELOPE.minHolders) { reject(`holders ${holders} < ${RANK_ENVELOPE.minHolders}`); continue; }
    if (mcap != null && (mcap < RANK_ENVELOPE.minMcap || mcap > RANK_ENVELOPE.maxMcap)) { reject(`mcap $${Math.round(mcap)} outside ${RANK_ENVELOPE.minMcap}–${RANK_ENVELOPE.maxMcap}`); continue; }
    if (binStep != null && (binStep < minBinStep || binStep > maxBinStep)) { reject(`bin step ${binStep} outside ${minBinStep}–${maxBinStep}`); continue; }
    const isTop = !!(p.top_performer || p._isTopPerformer);
    const change = numeric(p.price_change_pct);
    if (change != null && change <= -20 && !isTop) { reject(`window dump ${change.toFixed(1)}% ≤ −20%`); continue; }
    let scout = false;
    if (Number.isFinite(minTvl) && minTvl > 0 && tvl > 0 && tvl < minTvl) {
      if (!cfg.scoutTierEnabled) { reject(`TVL $${Math.round(tvl)} below minTvl $${minTvl}`); continue; }
      scout = true;
    }
    const volTvl = numeric(p.volume_tvl_ratio) ?? (tvl > 0 && p.volume_window != null ? numeric(p.volume_window) / tvl : null);
    if (minVolTvl > 0 && (volTvl == null || volTvl < minVolTvl)) { reject(`volume/TVL ${volTvl != null ? volTvl.toFixed(4) : "unknown"} < ${minVolTvl}`); continue; }
    const txPerMin = p.tx_per_min != null ? numeric(p.tx_per_min) : (numeric(p.swap_count) != null && tfMinutes > 0 ? numeric(p.swap_count) / tfMinutes : null);
    if (effectiveMinTx > 0 && (txPerMin == null || txPerMin < effectiveMinTx)) { reject(`tx/min ${txPerMin != null ? txPerMin.toFixed(2) : "unknown"} < ${effectiveMinTx}`); continue; }
    const feeRate = feeRate24hEq(p, tfMinutes);
    survivors.push({ pool: p, name, address: p.pool ?? p.pool_address ?? null, feeRate: feeRate ?? -Infinity, scout, tvl });
  }
  // Full-size candidates first, then scouts; each group by fee rate (desc).
  survivors.sort((a, b) => (a.scout === b.scout ? b.feeRate - a.feeRate : a.scout ? 1 : -1));
  const n = Math.max(1, Number(limit ?? cfg.rankAdmitCount ?? 5));
  const admitted = survivors.slice(0, n);
  for (const sv of survivors.slice(n)) rejected.push({ name: sv.name, pool: sv.address, reason: `ranked #${survivors.indexOf(sv) + 1} by fee rate (${sv.feeRate === -Infinity ? "?" : sv.feeRate.toFixed(2)}%/d), top ${n} admitted` });
  return { admitted, rejected, survivors: survivors.length };
}

function logAdmissionShadow(oldAdmitted, shadow, filteredOut) {
  const key = (p) => p.pool ?? p.pool_address ?? p.name;
  const oldSet = new Map((oldAdmitted || []).map((p) => [key(p), p]));
  const newSet = new Map(shadow.admitted.map((a) => [a.address ?? a.name, a]));
  const oldReason = new Map((filteredOut || []).map((f) => [f.pool_address ?? f.name, f.reason]));
  const newReason = new Map(shadow.rejected.map((r) => [r.pool ?? r.name, r.reason]));
  const fmtNew = (a) => `${a.name}${a.scout ? "(scout)" : ""}@${a.feeRate === -Infinity ? "?" : a.feeRate.toFixed(1)}%/d`;
  const overlap = [...newSet.keys()].filter((k) => oldSet.has(k)).length;
  const newOnly = [...newSet.values()].filter((a) => !oldSet.has(a.address ?? a.name)).map((a) => `${fmtNew(a)} [old: ${oldReason.get(a.address ?? a.name) || "not admitted"}]`);
  const oldOnly = [...oldSet.values()].filter((p) => !newSet.has(key(p))).map((p) => `${p.name || String(key(p)).slice(0, 8)} [new: ${newReason.get(key(p)) || "not admitted"}]`);
  log("screening",
    `[ADMISSION_SHADOW] old=[${[...oldSet.values()].map((p) => p.name || String(key(p)).slice(0, 8)).join(", ")}] ` +
    `new=[${shadow.admitted.map(fmtNew).join(", ")}] overlap=${overlap}/${Math.max(oldSet.size, newSet.size)} ` +
    `survivors=${shadow.survivors}` +
    (newOnly.length ? ` new_only=${newOnly.join("; ")}` : "") +
    (oldOnly.length ? ` old_only=${oldOnly.join("; ")}` : ""));
}

