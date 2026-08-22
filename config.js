import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES } from "./screening-scales.js";

export { REPO_ROOT, repoPath, getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES };

const USER_CONFIG_PATH = repoPath("user-config.json");
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : {};
}

const u = readJsonIfExists(USER_CONFIG_PATH);
const gmgnUserConfig = readJsonIfExists(GMGN_CONFIG_PATH);
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Playstyle presets → the tight/balanced/wide bins range (plan #2). `balanced` preserves the
// historical default (min = MIN_SAFE_BINS_BELOW, max = 69), so an unset/balanced playstyle is a
// no-op. Explicit minBinsBelow/maxBinsBelow always override the preset.
export const PLAYSTYLE_PRESETS = {
  tight:    { min: MIN_SAFE_BINS_BELOW, max: 45 },
  balanced: { min: MIN_SAFE_BINS_BELOW, max: 69 },
  wide:     { min: 60, max: 110 },
  // single_account (plan #12, 2026-08-22): bins_below <= 69 → 70 bins incl. the
  // active bin = ONE Meteora position account, which is the geometry the Meteora
  // UI's rebalance button requires and the width the operator's manual winners
  // used (69–81 bins). Closed positions since 07-20: <=72 bins avg +2.71% (n=5),
  // >110 bins avg −0.29% / worst −32% (n=63) — confounded by volatility, so this
  // is opt-in, not the default.
  single_account: { min: 45, max: 69 },
};
const playstyle = Object.prototype.hasOwnProperty.call(PLAYSTYLE_PRESETS, u.playstyle) ? u.playstyle : "balanced";
const _playstylePreset = PLAYSTYLE_PRESETS[playstyle];

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? _playstylePreset.min;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : _playstylePreset.max);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function gmgnValue(key, legacyKey, fallback) {
  return gmgnUserConfig[key] ?? u[legacyKey] ?? fallback;
}

function gmgnArray(key, legacyKey, fallback) {
  if (Array.isArray(gmgnUserConfig[key])) return gmgnUserConfig[key];
  if (Array.isArray(u[legacyKey])) return u[legacyKey];
  return fallback;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
    // Portfolio circuit breaker
    circuitBreakerEnabled:          u.circuitBreakerEnabled          ?? true,
    circuitBreakerDrawdownPct:      u.circuitBreakerDrawdownPct      ?? -15,
    circuitBreakerConsecutiveLosses: u.circuitBreakerConsecutiveLosses ?? 4,
    circuitBreakerCooldownHours:    u.circuitBreakerCooldownHours    ?? 6,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    source:            u.screeningSource    ?? "meteora", // meteora | gmgn
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minLps:            u.minLps            ?? 0,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    // ── Per-pool NO-DEPLOY verdict cache (Charon decision-cache pattern) — ships ON.
    //    A screener decline is cached per pool for verdictCacheTtlMin and the LLM is
    //    skipped while every candidate's verdict is fresh AND its metrics unmoved
    //    (mcap ±20%, holders ±30% — drift re-judges). Cleared on any deploy. Cuts
    //    redundant claude-cli quota burn during candidate droughts. See index.js.
    verdictCacheEnabled: u.verdictCacheEnabled ?? true,
    verdictCacheTtlMin:  u.verdictCacheTtlMin  ?? 30,
    // ── Scout tier (2026-07-31) — default OFF (shadow logs [SCOUT_SHADOW]).
    //    Sub-minTvl pools with enriched intel >= scoutMinIntel are admitted as
    //    SCOUTS: size hard-clamped to scoutSizeSol in the executor (whatever the
    //    LLM requests), max scoutMaxPositions open at once, tagged scout:true
    //    through state → perf records. Purpose: build the >=3-close history the
    //    TVL exemption needs — without scouts the exemptable set only shrinks,
    //    because the floor blocks the first deploy that would create history.
    //    Bounded worst case ≈ scoutSizeSol × worst-band loss (~$5 at 0.12 SOL).
    scoutTierEnabled:   u.scoutTierEnabled   ?? false,
    scoutSizeSol:       u.scoutSizeSol       ?? 0.12,
    scoutMinIntel:      u.scoutMinIntel      ?? 70,
    scoutMaxPositions:  u.scoutMaxPositions  ?? 1,
    // ── Probe tier (plan #12, 2026-08-22) — default OFF. Sibling of the scout tier
    //    for ABOVE-floor solo candidates the LLM lacks full-size conviction on
    //    (the operator's 0.2 SOL MADE-SOL pattern). deploy_position accepts
    //    tier:"probe"; the executor hard-clamps size to probeSizeSol, caps open
    //    probes at probeMaxPositions, tags probe:true (state → perf). Offered to
    //    the LLM only while enabled; a tier=probe call while OFF is refused.
    probeTierEnabled:   u.probeTierEnabled   ?? false,
    probeSizeSol:       u.probeSizeSol       ?? 0.25,
    probeMaxPositions:  u.probeMaxPositions  ?? 1,
    // ── Steady-pool envelope (plan #12, 2026-08-22) — default OFF (shadow logs
    //    [STEADY_ENVELOPE_SHADOW]). RANK_ENVELOPE's 1h fee/active-TVL floor (0.30%/h)
    //    only surfaces pools mid-burst; steady payers (24h fee/TVL 2–3%, TVL > $100k)
    //    are invisible between bursts. When ON, discoverPoolsBroad() runs one extra
    //    discovery request at the 24h timeframe and unions pools with TVL >=
    //    rankSteadyMinTvl and fee/active-TVL(24h) >= rankSteadyMinFeeTvl24h, re-fetched
    //    at the screening timeframe so downstream windowed fields stay consistent.
    // ── Window-aware intel Yield (plan #12 Phase 2) — "legacy" default (shadow logs
    //    [YIELD_WINDOW_SHADOW] would-pass at the rank intel gate) | "log". See
    //    scoreYield() in intel-score.js: the legacy ÷2.0 / ÷5.0 normalizers are 24h
    //    thresholds applied to 1h-windowed fields. Backtest: scripts/yield_window_backtest.js.
    intelYieldWindowMode: u.intelYieldWindowMode ?? "legacy",
    rankSteadyEnvelopeEnabled: u.rankSteadyEnvelopeEnabled ?? false,
    rankSteadyMinFeeTvl24h:    u.rankSteadyMinFeeTvl24h    ?? 1.5,
    rankSteadyMinTvl:          u.rankSteadyMinTvl          ?? 100_000,
    rankSteadyMaxExtra:        u.rankSteadyMaxExtra        ?? 10,
    //    Steady-lane intel bar (plan #12 Phase 2). null = inert (steady pools use
    //    rankMinIntelScore). Steady pools sit in the >=$100k entry-TVL band (zero
    //    disasters in history) and get enriched Safety, so a lower bar there leaves
    //    pool quality to the LLM's flow: read + probe tier. Set via update_config.
    rankSteadyMinIntel:        u.rankSteadyMinIntel        ?? null,
    //    Per-lane width (plan #12 Phase 3, 2026-08-22). Steady-lane pools get their own
    //    playstyle preset (e.g. "single_account" {45,69} = one position account,
    //    rebalance-able) and shape (spot/curve concentrate fees near price, which is
    //    what a tight range wants; the global "dynamic" strategy would pick bid_ask).
    //    Evidence: 86% of 117 bot closes never dipped past 69 bins; the operator's
    //    <=72-bin steady positions ran +2.71% avg / 0 losses. null = inert (global
    //    formula). Hint computed at admission (screening.js getSteadyLaneHint), applied
    //    by the executor (floor + default) when the LLM omits bins_below/shape.
    steadyLanePlaystyle:       u.steadyLanePlaystyle       ?? null,
    steadyLaneShape:           u.steadyLaneShape           ?? "spot",
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    loneCandidateMinDegen: u.loneCandidateMinDegen ?? 50, // degen score that lets a SOLO candidate deploy without a narrative

    // ─── Rug-signal filter (rug-signals.js) — practitioner rug heuristics ───
    //   Two experienced Meteora DLMM practitioners flagged rug signals we lack:
    //   insider holdings >0%, unburnt initial liquidity, a pump.fun "offchain coin"
    //   signature (creator wallet != minter), and top10 >30%. Their claimed rug shape
    //   matches our worst loss (TrumpCoin 2026-07-14, -64% mcap inside the range).
    //   ⚠️ Their horizon is DAYS; ours is minutes-to-hours, and none of this is
    //   validated against our own closes yet — so the detector always runs and always
    //   lands in the deploy signal snapshot (free: the fields ride along on the
    //   getTokenInfo call the recon loop already makes), while the GATE ships off.
    //     "off"      — detect + capture only. No logs, no admission change (default).
    //     "log_only" — additionally log a [RUG_FILTER] would-reject line per tripped
    //                  candidate. Still zero admission change. Grep these to size the
    //                  gate against live candidates without risking starvation.
    //     "enforce"  — reject tripped candidates before the LLM sees them.
    //   Every check FAILS OPEN: a null value or a null threshold never rejects. This
    //   matters because the audit fields are sparse (insiderPct present on ~12% of
    //   tokens) and absence is ambiguous between "zero" and "unknown".
    rugFilterMode:     u.rugFilterMode     ?? "off", // "off" | "log_only" | "enforce"
    // Deliberately OUR existing bars, NOT the practitioners' — tightening to their
    // values is a separate, evidence-gated decision (they say insider >0% and top10
    // >30%; measured over an 84-mint live universe those reject 11.9% and 44.0%
    // respectively, vs 3.6% and 20.2% here — a starvation risk on a funnel that
    // already admits ~5).
    rugMaxInsiderPct:  u.rugMaxInsiderPct  ?? 20,   // matches the existing gmgn.maxRatTraderRate (0.2) insider bar
    rugMaxTop10Pct:    u.rugMaxTop10Pct    ?? 60,   // = maxTop10Pct, which today only gates the SOLO-candidate path
    rugMaxDevMints:    u.rugMaxDevMints    ?? null, // null = disabled; keyless proxy for creator!=minter, unvalidated
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    // Intel score system
    minIntelScore:       u.minIntelScore       ?? 45,
    // Developer score system
    minDevScore:         u.minDevScore         ?? 50,
    intelWeights: {
      safety:   u.intelWeightSafety   ?? 0.30,
      yield:    u.intelWeightYield    ?? 0.35,
      momentum: u.intelWeightMomentum ?? 0.20,
      trust:    u.intelWeightTrust    ?? 0.15,
    },
    // SOL volatility guard
    solVolatilityThresholdPct: u.solVolatilityThresholdPct ?? 8,
    solVolatilityPauseMin:     u.solVolatilityPauseMin     ?? 30,
    // TVL drain guard
    tvlDrainEnabled:       u.tvlDrainEnabled       ?? true,
    tvlDrainThresholdPct:  u.tvlDrainThresholdPct  ?? -30,
    // Gas break-even filter — skip pools where gas cost takes too long to recoup
    maxGasBreakEvenMinutes: u.maxGasBreakEvenMinutes ?? 30,
    // LPAgent winning-LPer study surfaced into the screener candidate blocks (advisory).
    // Studies only the few post-filter candidates, rate-limit-aware + 30m client cache.
    lpStudyEnabled:            u.lpStudyEnabled            ?? true,
    lpStudyMaxPools:           u.lpStudyMaxPools           ?? 4,   // cap API calls per cycle
    lpStudyMinWinnersForStyle: u.lpStudyMinWinnersForStyle ?? 3,   // consensus needed to treat suggested_style as actionable
    // Playstyle Phase 2: when on, surface a per-candidate bins_hint from the winning LPers'
    // range width and instruct the screener to prefer it over the volatility formula. Advisory
    // (LLM still decides); OFF by default until staged-signal validation shows it helps.
    lpStyleSteerEnabled:       u.lpStyleSteerEnabled       ?? false,
    // Organic-momentum signal — is the crowd growing or leaving? (organic-momentum.js)
    // Advisory by default; thresholds are the live candidate-population quartiles.
    organicMomentumEnabled:          u.organicMomentumEnabled          ?? true,
    organicMomentumDecayTraderPct:   u.organicMomentumDecayTraderPct   ?? -22,
    organicMomentumDecayVolumePct:   u.organicMomentumDecayVolumePct   ?? -42,
    organicMomentumGrowTraderPct:    u.organicMomentumGrowTraderPct    ?? 38,
    organicMomentumMinUniqueTraders: u.organicMomentumMinUniqueTraders ?? 30,
    organicMomentumHardFilter:       u.organicMomentumHardFilter       ?? false,
    // Adversarial bear-debate pass on deploy candidates (bear-debate workstream).
    // Declared here so it's tunable via update_config; agent.js already reads these
    // with ?? fallbacks — this just makes them declared config instead of implicit.
    bearDebateEnabled: u.bearDebateEnabled ?? true,
    bearDebateAction: u.bearDebateAction ?? "log_only", // "log_only" | "enforce"
    // Cycle-based starvation relaxer — breaks the zero-deploy deadlock. When the
    // screener returns zero candidates for N consecutive cycles, relax one
    // evolution-owned floor by one bounded step (within EVOLVE_BOUNDS), on a
    // cooldown. Ships ON — only ever loosens screening floors, never touches
    // execution; the closed-loop evolution re-tightens once closes resume.
    starvationRelaxEnabled:          u.starvationRelaxEnabled          ?? true,
    starvationRelaxAfterEmptyCycles: u.starvationRelaxAfterEmptyCycles ?? 12,
    starvationRelaxCooldownHours:    u.starvationRelaxCooldownHours    ?? 3,
    // ── "Rank, don't gate" candidate admission (screening redesign) — default
    //    "gate" (byte-identical to today). In "rank" mode we fetch a BROAD universe
    //    constrained only by a hardcoded safety/structural envelope (RANK_ENVELOPE in
    //    tools/screening.js), apply only SAFETY hard gates client-side, rank survivors
    //    by a composite admission score (computeAdmissionScore: intel-from-payload +
    //    organic-momentum modifier + fee_tvl-percentile modifier + fee-efficiency
    //    modifier), and admit the top rankAdmitCount — quality metric floors
    //    (organic/fee-ratio/tvl/mcap/volume/holders) become score inputs instead of
    //    kill switches, leaving the downstream LLM + bear-debate + sim/momentum/
    //    similar_past lines to judge quality among the admitted set. The
    //    AND-compounding of ~12 gate-mode thresholds is what starved the funnel to
    //    zero for ~29h. rankMinIntelScore is an absolute garbage backstop even in
    //    rank mode (distinct from the gate-mode minIntelScore). While mode="gate"
    //    AND rankShadowEnabled, the cheap part of the rank pipeline (broad fetch + safety
    //    gates + payload-only pre-score, NO enrichment) also runs and logs a
    //    `[RANK_SHADOW]` would-admit line — the calibration data for flipping the flag.
    //    All try/catch-isolated; never affects the live gate-mode cycle.
    //    Defaults set from the 2026-07-07 backtest of 181 closes: intel_total is real
    //    but only above ~52 (≥52 blocked 68% of failures, kept 71% of winners — the
    //    knee → rankMinIntelScore=52); best tested rule was intel-led rank with
    //    fee_tvl as secondary signal admitting a SMALL top-N (→ rankAdmitCount=5).
    screeningAdmissionMode: u.screeningAdmissionMode ?? "gate", // "gate" | "rank"
    rankAdmitCount:         u.rankAdmitCount         ?? 5,      // top-N admitted in rank mode (2026-07-07 backtest)
    rankMinIntelScore:      u.rankMinIntelScore      ?? 52,     // absolute intel floor even in rank mode (backtest knee)
    rankShadowEnabled:      u.rankShadowEnabled      ?? true,   // log what rank mode WOULD admit while in gate mode
    // ── Intel Safety enrichment (populates the intel-score Safety sub-inputs on
    //    the Meteora path, which are otherwise never set → Safety pinned at its
    //    neutral 50 fallback). Calibration-first, flag-gated:
    //      "off"      — zero fetches, byte-identical to today (default).
    //      "log_only" — fetch + compute enriched Safety, but admission still uses
    //                   the old (Safety=50) score; logs a [SAFETY_ENRICH] line and
    //                   attaches _intelSafetyEnriched to the candidate for capture.
    //      "enforce"  — the enriched Safety feeds admission (and signal_snapshot).
    //    Sources: Jupiter token audit (keyless: mint/freeze authority, top-holder,
    //    bot-holder, dev-balance, bundler) + GMGN token stat (when keyed) — mapped
    //    onto the exact fields intel-score.js scoreSafety reads. Every fetch failure
    //    degrades to the current neutral behavior (null inputs → Safety 50).
    //    ⚠️ enforce PAIRING (2026-07-11 rebaseline, scripts/safety_rebaseline.js over
    //    147 records): mint/freeze renouncement is ~universal in our population, so
    //    real Safety adds a near-constant +6..+11 to intel_total — a distribution
    //    shift, not a discriminator (reconstructed Safety showed zero outcome signal;
    //    it is a rug FILTER). Flipping to "enforce" MUST be paired with raising
    //    minIntelScore/rankMinIntelScore 52 → ~58 (renouncement-only) / ~60-62 (full
    //    audit incl. concentration) in the same change, else the intel gate is
    //    silently disabled (admission 52%→93-99%).
    safetyEnrichMode:        u.safetyEnrichMode        ?? "off", // "off" | "log_only" | "enforce"
    safetyEnrichMaxPerCycle: u.safetyEnrichMaxPerCycle ?? 6,     // max candidates enriched per screening cycle
  },

  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    // gmgn = use GMGN /v1/token/info total_fee for global_fees_sol (minTokenFeesSol gate); jupiter = legacy Jupiter fees
    feeSource: nonEmptyString(gmgnUserConfig.feeSource, u.gmgnFeeSource, "gmgn"),
    interval: gmgnValue("interval", "gmgnInterval", "5m"),
    orderBy: gmgnValue("orderBy", "gmgnOrderBy", "default"),
    direction: gmgnValue("direction", "gmgnDirection", "desc"),
    limit: gmgnValue("limit", "gmgnLimit", 100),
    enrichLimit: gmgnValue("enrichLimit", "gmgnEnrichLimit", 20),
    requestDelayMs: gmgnValue("requestDelayMs", "gmgnRequestDelayMs", 350),
    maxRetries: gmgnValue("maxRetries", "gmgnMaxRetries", 2),
    holdersLimit: gmgnValue("holdersLimit", "gmgnHoldersLimit", 100),
    klineResolution: gmgnValue("klineResolution", "gmgnKlineResolution", "5m"),
    klineLookbackMinutes: gmgnValue("klineLookbackMinutes", "gmgnKlineLookbackMinutes", 60),
    filters: gmgnArray("filters", "gmgnFilters", ["renounced", "frozen", "not_wash_trading"]),
    platforms: gmgnArray("platforms", "gmgnPlatforms", ["Pump.fun", "meteora_virtual_curve", "pool_meteora"]),
    minMcap: gmgnValue("minMcap", "gmgnMinMcap", u.minMcap ?? 150_000),
    maxMcap: gmgnValue("maxMcap", "gmgnMaxMcap", u.maxMcap ?? 10_000_000),
    minTvl: gmgnValue("minTvl", "gmgnMinTvl", u.minTvl ?? 10_000),
    minVolume: gmgnValue("minVolume", "gmgnMinVolume", 1000),
    minHolders: gmgnValue("minHolders", "gmgnMinHolders", u.minHolders ?? 500),
    minTokenAgeHours: gmgnValue("minTokenAgeHours", "gmgnMinTokenAgeHours", 2),
    maxTokenAgeHours: gmgnValue("maxTokenAgeHours", "gmgnMaxTokenAgeHours", 24 * 7),
    minSmartDegenCount: gmgnValue("minSmartDegenCount", "gmgnMinSmartDegenCount", 1),
    requireKol: gmgnValue("requireKol", "gmgnRequireKol", true),
    minKolCount: gmgnValue("minKolCount", "gmgnMinKolCount", 1),
    maxRugRatio: gmgnValue("maxRugRatio", "gmgnMaxRugRatio", 0.3),
    maxTop10HolderRate: gmgnValue("maxTop10HolderRate", "gmgnMaxTop10HolderRate", 0.5),
    maxBundlerRate: gmgnValue("maxBundlerRate", "gmgnMaxBundlerRate", 0.5),
    maxRatTraderRate: gmgnValue("maxRatTraderRate", "gmgnMaxRatTraderRate", 0.2),
    maxFreshWalletRate: gmgnValue("maxFreshWalletRate", "gmgnMaxFreshWalletRate", 0.2),
    maxDevTeamHoldRate: gmgnValue("maxDevTeamHoldRate", "gmgnMaxDevTeamHoldRate", 0.02),
    preferredKolMinHoldPct: gmgnValue("preferredKolMinHoldPct", "gmgnPreferredKolMinHoldPct", 1),
    dumpKolMinHoldPct: gmgnValue("dumpKolMinHoldPct", "gmgnDumpKolMinHoldPct", 0.5),
    maxBotDegenRate: gmgnValue("maxBotDegenRate", "gmgnMaxBotDegenRate", 0.4),
    maxSniperCount: gmgnValue("maxSniperCount", "gmgnMaxSniperCount", 20),
    maxSniperHoldRate: gmgnValue("maxSniperHoldRate", "gmgnMaxSniperHoldRate", 0.3),
    minTotalFeeSol: gmgnValue("minTotalFeeSol", "gmgnMinTotalFeeSol", 30),
    athFilterPct: gmgnValue("athFilterPct", "gmgnAthFilterPct", null),
    preferredKolNames: gmgnArray("preferredKolNames", "gmgnPreferredKolNames", []),
    dumpKolNames: gmgnArray("dumpKolNames", "gmgnDumpKolNames", []),
    indicatorFilter: gmgnValue("indicatorFilter", "gmgnIndicatorFilter", true),
    indicatorInterval: gmgnValue("indicatorInterval", "gmgnIndicatorInterval", "15_MINUTE"),
    indicatorRules: (() => {
      const r = gmgnUserConfig.indicatorRules || {};
      return {
        requireBullishSupertrend: r.requireBullishSupertrend ?? true,
        rejectAlreadyAtBottom:    r.rejectAlreadyAtBottom    ?? true,
        requireAboveSupertrend:   r.requireAboveSupertrend   ?? false,
        minRsi:                   r.minRsi                   ?? null,
        maxRsi:                   r.maxRsi                   ?? null,
        requireBbPosition:        r.requireBbPosition        ?? null,
      };
    })(),
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    outOfRangeWaitMinutesAbove: u.outOfRangeWaitMinutesAbove ?? u.outOfRangeWaitMinutes ?? 15,
    outOfRangeWaitMinutesBelow: u.outOfRangeWaitMinutesBelow ?? u.outOfRangeWaitMinutes ?? 180,
    oorAboveStableTicks:    u.oorAboveStableTicks    ?? 2,   // require N stable management ticks before closing OOR-above
    oorAboveCooldownMinutes: u.oorAboveCooldownMinutes ?? 30, // anti-LVR cooldown after OOR-above close
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    // Plan #12 (2026-08-22): the legacy trigger counts ANY fee-generating deploy, so two
    // WINNING closes on a token locked the bot out of the pool that just paid (it fired on
    // every one of the operator's 2026-08-21 pools). When true, the lock fires only when the
    // last N deploys were ALL non-successes (low-yield family / OOR-below / pnl <= 0).
    // Default false = legacy + [REPEAT_COOLDOWN_SHADOW] would-NOT-lock lines.
    repeatDeployCooldownLosersOnly: u.repeatDeployCooldownLosersOnly ?? false,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    // ── Breakeven profit ratchet — default OFF (shadow mode). Once a position's
    //    CONFIRMED peak PnL reaches profitRatchetArmPct, the effective stop tightens
    //    from stopLossPct (−15) to profitRatchetStopPct (−2), converting a would-be
    //    profit round-trip into a small controlled exit. Empirical basis: 2026-07-08
    //    replay over 101 recorded paths — arm=2 converted profit round-trips into
    //    ~+15pt exits (~1–2 firings/100 closes) with zero winner-whipsaws; arm=1.5
    //    whipsawed a +12% winner, so 2 is the floor. Fires BEFORE plain stop-loss and
    //    routes through the same TWAP wick-guard (gateExit) as the other mechanical
    //    exits. While OFF it logs `[RATCHET_SHADOW]` would-fire lines only. See
    //    state.js updatePnlAndCheckExits().
    profitRatchetEnabled:  u.profitRatchetEnabled  ?? false,
    profitRatchetArmPct:   u.profitRatchetArmPct   ?? 2,    // confirmed peak PnL that arms the ratchet
    profitRatchetStopPct:  u.profitRatchetStopPct  ?? -2,   // effective stop once armed
    // ── Round-trip harvest — default OFF (shadow mode). Harvests a position that has
    //    completed a full round trip OUT THE TOP of its range: all bins reconverted to
    //    SOL, so the gain is locked, further upside is exactly zero, and the exit pays
    //    no swap slippage. Measured on CATE-SOL 2026-07-27: pnl pinned at exactly 7.98%
    //    across 12 consecutive ticks while the active bin swung 16→28 bins above range.
    //    No existing rule reaches this state — trailing TP needs pnl to fall (it can't,
    //    frozen), RULE_3 needs 50 bins above, and RULE_4's 720m clock resets on any wick
    //    back into range. While OFF logs `[ROUNDTRIP_SHADOW]` would-harvest lines only.
    //    See evaluateRoundTripHarvest() in state.js.
    roundTripHarvestEnabled:     u.roundTripHarvestEnabled     ?? false,
    roundTripMinPnlPct:          u.roundTripMinPnlPct          ?? 1.0,  // only ever harvests a win
    roundTripFrozenTicks:        u.roundTripFrozenTicks        ?? 6,    // ~4.5m at the ~45s poller cadence
    roundTripFrozenEpsilonPct:   u.roundTripFrozenEpsilonPct   ?? 0.05, // pnl "unchanged" band
    roundTripMinBinsAbove:       u.roundTripMinBinsAbove       ?? 5,    // ignore boundary oscillation
    // ── Age-conditional stop-loss ("young stop") — default OFF (shadow mode). A
    //    tighter stop that applies ONLY to positions whose base token was younger
    //    than youngStopMaxAgeHours at deploy. Empirical basis: 2026-07-19 study over
    //    137 replayed paths — tokens <12h old at deploy had a ~19% disaster rate vs
    //    7.8% for older, and a −10% stop restricted to young positions had ZERO
    //    winner-kills in-sample (no young winner ever dipped ≤−10) while cutting young
    //    disasters ~3–7pt earlier than the global −15 stop. A −5 threshold was
    //    REJECTED: two of our best winners dipped −5.8/−6.1 mid-hold, so −5 would have
    //    whipsawed them. Small affected-n (5) → ships shadow-first. Fires via the same
    //    confirm-tick + TWAP gateExit path as the plain stop; positions with the
    //    profit ratchet already ARMED are excluded (ratchet stop −2 is tighter).
    //    Unknown token age (null) is treated as NOT young — never tightens on unknown.
    //    While OFF it logs `[YOUNG_SL_SHADOW]` would-close lines only (rate-limited
    //    1/hr per position). See state.js updatePnlAndCheckExits().
    youngStopEnabled:      u.youngStopEnabled      ?? false,
    youngStopPct:          u.youngStopPct          ?? -10,  // stop threshold for young-token positions
    youngStopMaxAgeHours:  u.youngStopMaxAgeHours  ?? 12,   // token age (at deploy) below which the young stop applies
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
    manageUntracked:       u.manageUntracked       ?? false,
    // Adopted-position grace: an orphaned on-chain position re-imported by
    // adoptOrphanPosition (state.js) starts with NO tracked fee/snapshot history,
    // so history-based mechanical exits (esp. LOW_YIELD, which reads a fee/TVL
    // that is 0 until snapshots accrue) would fire on the very first management
    // tick and insta-close it — even though on-chain `age_minutes` is already
    // large (the position may have existed for hours before we adopted it, which
    // defeats minAgeBeforeYieldCheck). Suppress those exits for this many minutes
    // AFTER adoption (measured from `adopted_at`, not the backdated deploy time)
    // so the position accumulates live data before it can be judged. Paired with
    // the poolHealthMinSnapshots history floor below. update_config-tunable.
    adoptGraceMinutes:     u.adoptGraceMinutes     ?? 30,
    // Position health alerts (concentration risk + leave-pool) — advisory by default
    poolHealthAlertsEnabled:   u.poolHealthAlertsEnabled   ?? true,
    poolHealthAutoReview:      u.poolHealthAutoReview      ?? false, // promote alerting positions to LLM review
    poolHealthMinSnapshots:    u.poolHealthMinSnapshots    ?? 3,
    poolHealthMinAgeMinutes:   u.poolHealthMinAgeMinutes   ?? 20,
    poolHealthWindowSize:      u.poolHealthWindowSize      ?? 12,
    poolHealthYieldDecayPct:   u.poolHealthYieldDecayPct   ?? 50,
    poolHealthTvlDilutionRisePct: u.poolHealthTvlDilutionRisePct ?? 40,
    poolHealthVolumeDeathPct:  u.poolHealthVolumeDeathPct  ?? 60,
    poolHealthFeeRatioCollapsePct: u.poolHealthFeeRatioCollapsePct ?? 60,
    // ── Price-crash fast-path (plan #04) — default OFF. Bypasses outOfRangeWaitMinutesBelow
    //    ONLY when price is falling through the lower edge fast enough to be a rug/crash
    //    (velocity-gated, never fires on mere OOR duration or upside breaks). Fires via the
    //    PnL poller's existing confirm-tick + mechanical-close path. While OFF the detector
    //    still runs in shadow mode: would-fire events are logged as `crash_shadow` for live
    //    threshold calibration with zero closes. See docs/plans/04-price-crash-fastpath.md.
    crashFastPathEnabled: u.crashFastPathEnabled ?? false,
    crashBinsPerMin:      u.crashBinsPerMin      ?? 12, // min downward bins/min (≈12%/min at bin_step 100)
    crashMinBinDistance:  u.crashMinBinDistance  ?? 8,  // min bins below lower edge to arm (anti-flicker)
    crashConfirmTicks:    u.crashConfirmTicks    ?? 3,  // consecutive confirming polls (~9s at 3s cadence)
    crashWindowSec:       u.crashWindowSec       ?? 90, // velocity trailing window (s)
    crashMinSpanSec:      u.crashMinSpanSec      ?? 9,  // min trail span before trusting a velocity (s)
    // ── Socket-fed crash detection (Phase 1: SHADOW ONLY). Every websocket lbPair write
    //    feeds a twin of the crash detector to measure socket-vs-poller detection lead
    //    time on live dumps ([CRASH_SOCKET_SHADOW] armed/would-close/poller-confirmed/
    //    recovered lines). Never closes; "enforce" is Phase 2, not implemented.
    crashSocketMode:           u.crashSocketMode           ?? "shadow", // off | shadow
    crashSocketConfirmSpanSec: u.crashSocketConfirmSpanSec ?? 15, // min sec from arm before Phase-2 semantics would fire
    // ── In-range rug detector — the crash fast-path's sibling for dumps that run INSIDE
    //    a wide bid ladder (TrumpCoin 2026-07-14: −64% mcap inside a 117-bin range →
    //    −18.35% stop + 48.9% exit slippage). Fires only on velocity AND pnl jointly —
    //    the 12-position tick study showed winners dip at ≤11 b/min and flat pools spike
    //    to 18 b/min at pnl≈0, so neither gate alone separates. Ships OFF (shadow:
    //    [RUG_SHADOW] would-fire lines); when ON it routes through the crash close path
    //    (crashConfirmTicks, no TWAP defer, flips suppressed).
    inRangeRugEnabled:    u.inRangeRugEnabled    ?? false,
    rugBinsPerMin:        u.rugBinsPerMin        ?? 12,   // min in-range descent velocity (bins/min)
    rugMinBinsDropped:    u.rugMinBinsDropped    ?? 10,   // min bins fallen within the window
    rugMaxPnlPct:         u.rugMaxPnlPct         ?? -3,   // fire only at/below this pnl (never on profitable dips)
    rugWindowSec:         u.rugWindowSec         ?? 300,  // trailing window (s) — dumps inside wide ladders are slower than OOR breaks
    rugMinSpanSec:        u.rugMinSpanSec        ?? 60,   // min trail span before trusting a velocity (s)
    // ── Post-close outcome probe (plan #05) — read-only. Samples the pool's token price
    //    (mcap ∝ price) at ~30/60/180 min after each close and scores exit quality
    //    (good_exit / early_exit) per close-reason family — the ground truth for tuning
    //    outOfRangeWaitMinutesBelow, crash thresholds, and trailing TP. Ships ON: GETs +
    //    an additive analytics field only, bounded to 0–2 fetches/cycle; cannot trade.
    //    See docs/plans/05-post-close-probe.md. /exits shows the rollup.
    postCloseProbeEnabled: u.postCloseProbeEnabled ?? true,
    postCloseProbeMinutes: u.postCloseProbeMinutes ?? [30, 60, 180],
    // ── Wallet dust sweep — auto-swap leftover non-SOL tokens back to SOL.
    //    Catches dust from failed/bypassed auto-swaps and partial fills. Only sweeps
    //    tokens worth >= dustSweepMinUsd (below that, swap gas/route minimums make it
    //    net-negative — the ATA rent is still counted in AUM as recoverable) and
    //    <= dustSweepMaxUsd (larger balances are deliberate holds, e.g. skip_swap —
    //    never auto-sold). Skips mints with open positions. Runs after closes + every
    //    ~10th management cycle; each sweep also reclaims the ~0.002 SOL ATA rent.
    dustSweepEnabled: u.dustSweepEnabled ?? true,
    dustSweepMinUsd:  u.dustSweepMinUsd  ?? 0.25,
    dustSweepMaxUsd:  u.dustSweepMaxUsd  ?? 25,
    // ── Exit-swap price-impact guard — default OFF, ships in shadow mode.
    //    Small base-token remainders in thin/dying pools have lost 10-16% to Jupiter
    //    slippage on the post-close auto-swap (live 2026-07-13/14 data). Before every
    //    auto-swap (after close / after claim / dust sweep) a read-only Jupiter quote
    //    is compared against the token's market value; if the quoted impact exceeds
    //    exitSwapMaxImpactPct the swap is SKIPPED (guard ON) — the balance stays in
    //    the wallet and the dust sweeper re-quotes on later passes, selling only once
    //    impact is back under the cap. While OFF: [EXIT_SWAP_GUARD_SHADOW] would-skip
    //    lines only, zero behavior change. Quote failures always fail-open to the swap.
    exitSwapGuardEnabled: u.exitSwapGuardEnabled ?? false,
    exitSwapMaxImpactPct: u.exitSwapMaxImpactPct ?? 5,
    // ── Profit-gated fee compounding (Kamino/Revert Compoundor pattern) — default
    //    OFF, ships in shadow mode. Today, claimed fees sit in the wallet and only
    //    compound at the NEXT deploy. When ON, the claim_fees path (both the
    //    management cycle's CLAIM rule and any LLM-invoked claim) checks whether
    //    the position's unclaimed SOL-side fees clear the round-trip claim+re-add
    //    gas cost by >= feeCompoundMinMultiple (and >= the feeCompoundMinFeesSol
    //    floor) — if so, it claims AND re-adds the SOL straight back into the same
    //    position (tools/dlmm.js compoundFees()) instead of leaving it idle in the
    //    wallet. Base-token-side fees are untouched (follow the normal autoSwap/
    //    dust-sweep path). While OFF, every claim still runs the same gate check
    //    and logs `[FEE_COMPOUND_SHADOW]` whenever it WOULD have fired, for
    //    calibration with zero on-chain change. See tools/executor.js
    //    claimFeesWithCompoundGate() and tools/dlmm.js compoundFees()/shouldCompound().
    feeCompoundEnabled: u.feeCompoundEnabled ?? false,
    feeCompoundMinMultiple: u.feeCompoundMinMultiple ?? 5,
    feeCompoundMinFeesSol: u.feeCompoundMinFeesSol ?? 0.01,
    // ── OOR-below flip tactic (plan #07) — default OFF, ships in shadow mode.
    //    When an OOR-below position would close, and the pool still passes the flip
    //    gates (crash never fired for this position, organic momentum ≠ decaying,
    //    no volume-death health alert, pool/base-mint not on cooldown, flip cap not
    //    reached), the ecosystem-standard move (Kamino/Orca/Gamma/Charm) is to
    //    withdraw + re-add the received base tokens as a single-sided ask ladder in
    //    the same range instead of close→zap-to-SOL at the local bottom. While OFF
    //    the decision is only logged as `[OOR_FLIP_SHADOW]` for live calibration —
    //    zero on-chain change. See docs/plans/07-oor-flip-tactic.md.
    oorFlipEnabled:      u.oorFlipEnabled      ?? false,
    oorFlipBailHours:    u.oorFlipBailHours    ?? 6,  // close+zap for real if price hasn't re-entered range in this window
    oorFlipMaxPerPosition: u.oorFlipMaxPerPosition ?? 1, // one flip attempt per position, then close for real
    // ── Charm-style swap-free redeposit (companion to plan #07) — default OFF,
    //    shadow mode. In the post-close auto-swap path, when the flip conditions
    //    hold, redeposit leftover base tokens as a tight single-sided bin strip just
    //    above the active bin (earning fees on the SOL conversion) instead of paying
    //    Jupiter slippage. While OFF, logs `[SWAP_FREE_SHADOW]` estimating the swap
    //    slippage the Jupiter route cost vs. what the strip would have looked like.
    swapFreeRedepositEnabled: u.swapFreeRedepositEnabled ?? false,
    swapFreeRedepositBins:    u.swapFreeRedepositBins    ?? 20, // width of the ask-strip just above active bin
    // ── TWAP wick guard (Charm maxTwapDeviation pattern) — default OFF, ships in
    //    shadow mode. Before a non-crash MECHANICAL close fires (stop loss / trailing
    //    TP / OOR / low yield — the deterministic rules in updatePnlAndCheckExits),
    //    compares the current pnl_pct tick against a short TWAP of our own recently
    //    recorded pnl_pct ticks; a wild deviation suggests a 1-tick manipulation wick
    //    rather than a real move, and the close is deferred one tick instead of acted
    //    on. Bounded to twapGuardMaxDeferrals consecutive deferrals per position, then
    //    the close proceeds regardless — this guard can never indefinitely block an
    //    exit. NEVER applies to the crash fast-path (that has its own confirm-tick
    //    design; delaying rug exits is dangerous) — crash exits are decided entirely
    //    in index.js's detectPriceCrash()/registerExitSignal path and never flow
    //    through this guard. While OFF, logs `[TWAP_GUARD_SHADOW]` would-defer lines
    //    for calibration with zero behavior change. See state.js applyTwapWickGuard()/
    //    evaluateTwapWickGuard().
    twapGuardEnabled:        u.twapGuardEnabled        ?? false,
    twapGuardTicks:          u.twapGuardTicks          ?? 5,   // TWAP window, in poller ticks
    twapGuardDeviationPct:   u.twapGuardDeviationPct   ?? 8,   // |current - TWAP| pp threshold to suspect a wick
    twapGuardMaxDeferrals:   u.twapGuardMaxDeferrals   ?? 2,   // max consecutive deferrals before forcing the close through
    // ── Close-efficiency gate (RSRLP closeMinReturnPct pattern) — default OFF,
    //    ships in shadow mode. Trailing-TP fires on GROSS pnl_pct, but closing
    //    costs gas + Jupiter swap impact on the base-token remainder; at our
    //    position sizes (~1.25 SOL) a "+2% win" can net a loss. When a TRAILING_TP
    //    exit would fire, this estimates the net-of-cost pnl — a read-only Jupiter
    //    quote for the base-token side (rate-limited to closeEffQuoteMinIntervalSec
    //    per position) plus a conservative claim+close+swap gas estimate
    //    (estimateExitGasCost) — and DEFERS the close when net < closeEffMinNetPnlPct
    //    (the trigger naturally re-evaluates on later ticks; stop-loss/ratchet still
    //    protect downside). Applies ONLY to TRAILING_TP — never to stop-loss, young
    //    stop, crash/rug fast-paths, profit ratchet, OOR, LOW_YIELD, or manual/LLM
    //    closes. While OFF it logs `[CLOSE_EFF_SHADOW] would-defer` (and, as free
    //    calibration, a `[CLOSE_EFF_SHADOW] lowyield-cost` breakdown on LOW_YIELD
    //    closes, which it NEVER gates) with zero behavior change. Fail-open: any
    //    quote/data error logs once and lets the close proceed. See
    //    evaluateCloseEfficiency() in state.js + evaluateCloseEfficiencyGate() in
    //    index.js.
    closeEffGateEnabled:        u.closeEffGateEnabled        ?? false,
    closeEffMinNetPnlPct:       u.closeEffMinNetPnlPct       ?? 0.5,  // min net-of-cost pnl % to allow a trailing-TP close
    closeEffQuoteMinIntervalSec: u.closeEffQuoteMinIntervalSec ?? 60, // min seconds between base-side quotes per position
    // ── Auto-swap slippage cap — default OFF (shadow). Our Jupiter /order calls
    //    historically sent no slippageBps, so RTSE (Jupiter's dynamic slippage)
    //    chose the tolerance on every swap — same gap as Charon audit C1. When ON,
    //    auto-swaps of sweeper-retryable remainders (<= dustSweepMaxUsd) send a
    //    fixed slippageBps cap; a slippage-exceeded failure falls to the existing
    //    retry + dust-sweeper machinery. Balances above the ceiling are urgent-exit
    //    inventory that must fill — always RTSE, never capped. Manual/LLM
    //    swap_token calls are untouched. While OFF logs [SLIPPAGE_CAP_SHADOW].
    swapSlippageCapEnabled:     u.swapSlippageCapEnabled     ?? false,
    swapSlippageCapBps:         u.swapSlippageCapBps         ?? 500, // 5%, matches exitSwapMaxImpactPct
    // ── Fast close: skip the separate pre-close claim on URGENT exits — default OFF.
    //    closePosition Step 1 sends a standalone claimSwapFee (2 txs, measured
    //    2.4–5.3s / median ~3.5s across 13 live closes) before Step 2's
    //    removeLiquidity({shouldClaimAndClose:true}) — which claims the same fees
    //    itself, so Step 1 is redundant latency on the exit critical path. The
    //    recentlyClaimed branch already proves the skip path (claim <60s ago →
    //    straight to Step 2). When ON, urgent exits (crash/rug fast-path, stop-loss,
    //    profit ratchet, young stop) skip Step 1; trailing-TP/OOR/low-yield/manual
    //    closes keep the explicit claim. While OFF logs [FAST_CLOSE_SHADOW]
    //    would-skip on urgent closes. Community-sourced (2026-07-29 scrape: "alur
    //    closenya ubah — claim dulu baru close, ganti langsung close saja").
    fastCloseSkipClaim:         u.fastCloseSkipClaim         ?? false,
    // ── Per-pool/token re-entry cooldown (deploy hard-gate) — default OFF, ships
    //    in shadow mode. Nothing else stops rapid re-entry into a just-closed pool
    //    (Jimothy-SOL: deployed + fee-death-closed 3× in ~10h, 2026-07-18/19). Blocks
    //    a deploy when a position in the SAME pool_address OR same base_mint was
    //    CLOSED within the last poolReentryCooldownMinutes (source: the in-process
    //    state closed-position cache — pool/base_mint + closed_at, always primed at
    //    deploy time). Distinct from repeatDeployCooldown* above: that gate is
    //    trigger-count-based on repeated OOR/fee-death outcomes; this is a simpler
    //    time-since-last-close hard gate. Enforce → SAFETY_BLOCK refusal; shadow →
    //    `[REENTRY_SHADOW] would-block` log + allow. See the deploy_position safety
    //    block in tools/executor.js. Deterministic, no LLM.
    poolReentryCooldownEnabled: u.poolReentryCooldownEnabled ?? false,
    poolReentryCooldownMinutes: u.poolReentryCooldownMinutes ?? 240,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    playstyle:    playstyle,
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
    dynamicVolatilityThreshold: u.dynamicVolatilityThreshold ?? 1.5,
    targetDownsidePct: u.targetDownsidePct ?? null,
    // Bin-distribution SHAPE fallback when the SCREENER opts into shape selection
    // but names no shape. "spot" = uniform (today's behavior). Only consulted when
    // a `shape` is being resolved — an omitted shape arg leaves the existing
    // strategy→StrategyType resolution untouched, so the default deploy path is
    // byte-identical regardless of this value. Not tied to playstyle: playstyle
    // governs range WIDTH (bins), shape governs the intra-range liquidity CURVE —
    // orthogonal axes, so no shapeByPlaystyle mapping (would conflate the two).
    defaultShape: u.defaultShape ?? "spot",
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── Deploy-timing gate (plan #1 Phase 2) ─────
  // Governs the AUTONOMOUS screener only (manual /deploy keeps user intent). Uses the same
  // hour-of-day analysis as the advisory. OFF by default — enable after the advisory confirms
  // a stable edge. Default action is size_down (deploy smaller in weak blocks), not skip.
  timing: {
    gateEnabled:          u.timingGateEnabled          ?? false,
    minBucketN:           u.timingMinBucketN           ?? 8,     // per-block decisive closes needed to gate
    deadHourSuccessFloor: u.timingDeadHourSuccessFloor ?? 0.20,  // block below this success-rate is "weak"
    deadHourAction:       u.timingDeadHourAction       ?? "size_down", // "size_down" | "skip"
    sizeDownPct:          u.timingSizeDownPct          ?? 0.5,   // deploy-size multiplier in weak blocks
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    bearDebateModel: u.bearDebateModel ?? null, // null → screening model
    // ── Claude Code CLI backend (llm-cli.js). Prefix ANY per-role model with
    //    `claude-cli/` to route that role's reasoning through the `claude -p`
    //    subprocess instead of per-token OpenRouter — e.g.
    //    screeningModel: "claude-cli/opus". The suffix after the slash is passed
    //    to `claude --model` verbatim (aliases opus/sonnet/haiku or full model
    //    ids). No API key is involved: auth is the operator's Claude subscription
    //    OAuth, so the `claude` binary must be on PATH and pre-authorized on the
    //    VM via `claude setup-token` (a one-time interactive step). Because a
    //    Claude subscription has usage limits (unlike metered OpenRouter), default
    //    only the judgment-heavy roles (screening/general) to the CLI and keep the
    //    frequent, cheap management cycle on OpenRouter — or set a
    //    claudeCliFallbackModel so CLI rate-limits degrade cleanly.
    //      claudeCliTimeoutMs    — per-call subprocess timeout (SIGKILL after grace).
    //      claudeCliFallbackModel — model to use when the CLI fails/rate-limits;
    //                    null → reuse the role's existing OpenRouter fallback chain
    //                    (same machinery as the 502/529 fallback). Must NOT itself
    //                    be a claude-cli/ id.
    claudeCliTimeoutMs:     u.claudeCliTimeoutMs     ?? 240000,
    claudeCliFallbackModel: u.claudeCliFallbackModel ?? null,
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Transaction Settings ─────────────
  tx: {
    enablePriorityFees:          u.enablePriorityFees          ?? true,
    priorityFeeMultiplier:       u.priorityFeeMultiplier       ?? 1.2,
    maxPriorityFeeMicroLamports: u.maxPriorityFeeMicroLamports ?? 1_000_000,
    txMaxRetries:                u.txMaxRetries                ?? 2,
    // ── Exit-urgency priority fee (AutoLP-Orca pattern) — closes/flips matter most
    //    during congestion (rugs/crashes), exactly when a static/median fee fails to
    //    land. Pegs to the 75th percentile (vs. median for normal txs) and multiplies
    //    higher, still hard-capped. Ships ON: strictly bounded extension of the
    //    already-enabled priority-fee machinery (see getDynamicPriorityFee() in
    //    tools/dlmm.js for the worst-case-tip cap math).
    exitPriorityFeeEnabled:         u.exitPriorityFeeEnabled         ?? true,
    exitPriorityFeeMultiplier:      u.exitPriorityFeeMultiplier      ?? 1.5,
    maxExitPriorityFeeMicroLamports: u.maxExitPriorityFeeMicroLamports ?? 3_000_000,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── PnL fetcher / poller (public infra: RPC + Meteora deposits + Jupiter) ──
  pnl: {
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, "https://pump.helius-rpc.com"),
    source: nonEmptyString(u.pnlSource, "rpc"), // rpc | meteora (fallback-only)
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  // ─── Opportunity poller (catches strong pools between screening cycles) ──
  opportunity: {
    enabled: u.opportunityPollEnabled ?? true,
    pollIntervalSec: Number(u.opportunityPollIntervalSec ?? 45),
    limit: Number(u.opportunityPollLimit ?? 10),
    // Pre-gate: only trigger the full deploy decision when the best candidate's
    // Degen Score (0..100) clears this bar — avoids running screening every 45s.
    minScore: Number(u.opportunityMinScore ?? 40),
    // A smart wallet (from the agentmeridian server) sitting on the pool LOWERS the
    // effective minScore by this much — a strong signal nudges a borderline pool through.
    smartWalletScoreBonus: Number(u.opportunitySmartWalletBonus ?? 20),
    // After the fast-path triggers a deploy decision for a pool, that same pool cannot
    // re-trigger it for this long — the 15-min screening cron still re-evaluates everything.
    // Caps LLM spend when one hot-scoring candidate is repeatedly declined (TrumpCoin
    // 2026-07-14: ~12 identical NO DEPLOY decisions/hour off the 45s poll).
    retriggerCooldownMin: Number(u.opportunityRetriggerCooldownMin ?? 30),
    // Degen Score targets (each sub-score saturates at its target). Tune to calibrate.
    // Inputs are normalized to a fixed 30m reference window, so these are timeframe-independent.
    targetVolRatio: Number(u.degenTargetVolRatio ?? 20),     // (30m) volume/active_tvl for full trading sub-score
    targetLpCount: Number(u.degenTargetLpCount ?? 40),       // (30m) unique_lps + positions_created for full LP sub-score
    targetFeeRatio: Number(u.degenTargetFeeRatio ?? 0.20),   // (30m) fee/active_tvl for full fee sub-score (tune per timeframe; fees don't normalize as cleanly as volume)
    // active_tvl ($) for full liquidity sub-score. NOT timeframe-scaled. Set near your
    // active-TVL floor (≈ minTvl) so it acts as a dust floor, not a stretch goal — the
    // screening minTvl filter already removes tiny pools.
    targetLiquidity: Number(u.degenTargetLiquidity ?? 20000),
  },

  jupiter: {
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    const fresh = readJsonIfExists(USER_CONFIG_PATH);
    const s = config.screening;
    if (fresh.screeningSource != null) s.source = fresh.screeningSource;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minLps         != null) s.minLps         = fresh.minLps;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    if (fresh.minIntelScore    != null) s.minIntelScore    = fresh.minIntelScore;
    if (fresh.solVolatilityThresholdPct != null) s.solVolatilityThresholdPct = fresh.solVolatilityThresholdPct;
    if (fresh.solVolatilityPauseMin     != null) s.solVolatilityPauseMin     = fresh.solVolatilityPauseMin;
    if (fresh.tvlDrainThresholdPct != null) s.tvlDrainThresholdPct = fresh.tvlDrainThresholdPct;
    if (fresh.tvlDrainEnabled !== undefined) s.tvlDrainEnabled = fresh.tvlDrainEnabled;
    if (fresh.strategy != null) config.strategy.strategy = fresh.strategy;
    if (fresh.playstyle != null) config.strategy.playstyle = fresh.playstyle;
    if (fresh.dynamicVolatilityThreshold != null) {
      config.strategy.dynamicVolatilityThreshold = Number(fresh.dynamicVolatilityThreshold);
    }
    if (fresh.targetDownsidePct !== undefined) {
      config.strategy.targetDownsidePct = fresh.targetDownsidePct === null ? null : Number(fresh.targetDownsidePct);
    }
    if (fresh.outOfRangeWaitMinutesAbove != null) {
      config.management.outOfRangeWaitMinutesAbove = Number(fresh.outOfRangeWaitMinutesAbove);
    }
    if (fresh.outOfRangeWaitMinutesBelow != null) {
      config.management.outOfRangeWaitMinutesBelow = Number(fresh.outOfRangeWaitMinutesBelow);
    }
    if (fresh.manageUntracked !== undefined) {
      config.management.manageUntracked = !!fresh.manageUntracked;
    }
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
  try {
    const freshGmgn = readJsonIfExists(GMGN_CONFIG_PATH);
    const g = config.gmgn;
    for (const [key, value] of Object.entries(freshGmgn)) {
      if (key in g && key !== "apiKey") g[key] = value;
    }
    if (freshGmgn.apiKey) g.apiKey = freshGmgn.apiKey;
  } catch { /* ignore */ }
}
