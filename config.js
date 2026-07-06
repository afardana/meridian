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
};
const playstyle = ["tight", "balanced", "wide"].includes(u.playstyle) ? u.playstyle : "balanced";
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
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    loneCandidateMinDegen: u.loneCandidateMinDegen ?? 50, // degen score that lets a SOLO candidate deploy without a narrative
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
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
    manageUntracked:       u.manageUntracked       ?? false,
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
