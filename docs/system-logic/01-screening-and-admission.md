# Meridian — SCREENING / CANDIDATE DISCOVERY domain inventory

Read-only inventory of everything that decides which Meteora DLMM pools reach the SCREENER LLM and what candidate lines it sees. Compiled 2026-09-25 from the `experimental` checkout at `/Users/Angga/Repos/meridian` (HEAD `a0fcd12`). Line numbers are for that tree; `~` marks an estimate within a few lines.

Conventions
- Log tags: `log(category, msg)` renders `[CATEGORY-UPPERCASED] msg` (logger.js:41-49), so `log("screening", "funnel: …")` appears as `[SCREENING] funnel: …`; bracketed sub-tags such as `[TVL_EXEMPT]` are literal text inside the message.
- "Code default" = `config.js`. "Prod" = value stated in CLAUDE.md (the VM's `user-config.json` is not in this checkout; the local `user-config.json` is a dev copy carrying only rebalance/top-performer/risk keys and is NOT authoritative for screening floors). Anything marked *uncertain* could not be confirmed from code or CLAUDE.md.
- Prod screening timeframe: CLAUDE.md's config table lists the code default `"5m"`, but multiple dated code comments (tools/screening.js:71-77 "the ~1h live screening timeframe", intel-score.js:219 "prod feeds fields windowed by config.screening.timeframe (1h)", tools/executor.js:205) say prod runs **1h**. Treat prod = 1h (uncertain).

---

## 0. Funnel map (prod = Meteora source, `screeningAdmissionMode="rank"`)

```
TRIGGER (cron */screeningIntervalMin | mgmt-cycle empty-book/free-slot | [Opportunity] degen poll | /screen)
  └─ runScreeningCycle (index.js:1570)
       ├─ PRE-GUARDS: circuit breaker → SOL-vol guard → maxPositions → SOL balance → deploy-timing gate
       ├─ getTopCandidates({limit:10}) (tools/screening.js:1231) ──► getTopCandidatesRank (1589)
       │     ├─ discoverPoolsBroad (866): RANK_ENVELOPE query ×(category + "top") + steady-envelope 24h pass + Top Performers tab
       │     ├─ applyRankSafetyGates (1132): blacklist / dev-blocklist / occupied pool+mint / pool+token cooldown / volatility / TVL-drain / blockedLaunchpads
       │     ├─ prescoreRankCandidates (1187): payload intel + momentum ±5/−10 + fee_tvl pct ±6 + fee-eff pct ±5 → sort
       │     ├─ enrichment slice = top 2×rankAdmitCount: GMGN dev info → dev score; safetyEnrich (flag) → rescore intel
       │     ├─ per-pool gates: dump-play guard → intel bar (rankMinIntelScore | rankSteadyMinIntel) → minTvl floor (+ clean-history exemption / Top-Performer trend / scout) → vol/TVL + tx/min velocity (waived for steady lane)
       │     ├─ admit top rankAdmitCount by admission score; lane hints (steady width / top-performer 69-spot)
       │     └─ annotate fee-efficiency + organic momentum; PVP enrich (top 2) [+ optional hard filter]; capture rejected-candidates
       ├─ RECON per candidate (index.js:1740): checkSmartWalletsOnPool + getTokenNarrative + getTokenInfo (+ recallForPool)
       ├─ rug-signals + CRI compute (always) → post-recon filters: allow/block launchpad, bot-holders %, [RUG_FILTER], [CRI]
       ├─ gas break-even filter (inert on Meteora path — see §12)
       ├─ 0 candidates → NO DEPLOY report (+ starvation counter) | 1 candidate → getLoneCandidateSkipReason
       ├─ active_bin prefetch; LPAgent study (≤ lpStudyMaxPools)
       ├─ candidate blocks (metrics / fee_efficiency / sim / flow / momentum / similar_past / top_lpers / audit / pvp / scout_tier / steady_envelope / pool_price_change / lane_width / smart_wallets / active_bin / 1h / narrative / memory)
       ├─ LLM suppressors: identical-set fingerprint (opportunity.retriggerCooldownMin) → per-pool verdict cache (verdictCacheTtlMin)
       ├─ agentLoop(SCREENER goal + STEPS) → deploy_position → executor safety block (tools/executor.js:1718) → validateDeployPoolThresholds (131)
       └─ finally: maybeRelaxOnStarvation (index.js:2438)
```

Gate mode (`screeningAdmissionMode="gate"`, code default) replaces the rank branch with `discoverPools` (665) → Stage-A client recheck → Stage-B: metrics → dev_score → dump_guard → [safety-enrich] → intel → pvp → indicators → final, then runs `[RANK_SHADOW]` for comparison. See §3.

---

## 1. Triggers and pre-cycle guards

| # | Rule | Location | Condition / formula | Config (code default → prod) | Log |
|---|------|----------|---------------------|------------------------------|-----|
| 1.1 | Screening cron | index.js:2567 | `cron.schedule("*/${screeningIntervalMin} * * * *", runScreeningCycle)` | `screeningIntervalMin` 30 | — |
| 1.2 | Mgmt-cycle trigger (empty book) | index.js:949, 969-979 | positions.length===0 AND `Date.now()-_screeningLastTriggered > 5*60*1000` → `runScreeningCycle()` | hardcoded 5-min `screeningCooldownMs` | `[CRON] No open positions — triggering screening cycle` |
| 1.3 | Mgmt-cycle trigger (free slot) | index.js:1489-1497 | `afterCount < risk.maxPositions` (held positions excluded only if `maxPositionsExcludeHold`) AND 5-min cooldown | `maxPositionsExcludeHold` false (prod false per plan #15; local dev copy has true) | `[CRON] Post-management: n/max positions — triggering screening` |
| 1.4 | Opportunity poller ("degen fast-path") | index.js:3302-3370 | every `pollIntervalSec` (min 15s): skip if `_screeningBusy||_managementBusy||_opportunityPollBusy` or `<5 min` since last screening (3309); requires open slots and `sol >= deployAmountSol+gasReserve` (3320-3328); runs the FULL `getTopCandidates({limit})` funnel (3330); sorts by `degenScore` (3331); triggers when `degen >= minScore`, or `degen >= minScore−smartWalletScoreBonus` AND a tracked smart wallet is in the pool (3334-3357); per-pool re-trigger lockout `retriggerCooldownMin` (3342-3346); then `runScreeningCycle({silent:true})` (3364) | `opportunity.enabled` true, `pollIntervalSec` 45, `limit` 10, `minScore` 40, `smartWalletScoreBonus` 20, `retriggerCooldownMin` 30 | `[CRON] [Opportunity] <name> degen X >= Y … — triggering screening deploy decision` |
| 1.5 | Busy/TOCTOU guard | index.js:1571-1576 | skip if `_screeningBusy || _commandCloseInFlight || busy`; sets `_screeningBusy` + `_screeningLastTriggered` immediately | — | `[CRON] Screening skipped — previous cycle or close operation in flight` |
| 1.6 | Circuit breaker | index.js:1592-1600; circuit-breaker.js:100 | `checkCircuitBreaker().tripped` → skip cycle | `risk.circuitBreakerEnabled` true, `DrawdownPct` −15, `ConsecutiveLosses` 4, `CooldownHours` 6 | `[CRON] Screening skipped — circuit breaker active: …` |
| 1.7 | SOL volatility guard | index.js:1610-1618; sol-volatility.js:42-72 | `max(deviation from 1h min/max, range spread) > solVolatilityThresholdPct` → skip | `solVolatilityThresholdPct` 8, `solVolatilityPauseMin` 30 | `[CRON] Screening skipped — SOL volatility guard: X% up/down move in 1h` |
| 1.8 | Max positions | index.js:1620-1650 | `activeManagedPositions >= risk.maxPositions` → skip (writes funnel doc with `skipped_reason`) | `maxPositions` 3 | `[CRON] Screening skipped — Max positions reached (n/max)` |
| 1.9 | Min SOL | index.js:1651-1676 | `!DRY_RUN && preBalance.sol < deployAmountSol + gasReserve` → skip | `deployAmountSol` 0.4 code (CLAUDE.md table 0.5), `gasReserve` 0.05 code (table 0.2) | `[CRON] Screening skipped — Insufficient SOL (…)` |
| 1.10 | Deploy-timing gate (plan #1 Phase 2) | index.js:1704-1715; deploy-timing.js:165-182 | `getDeployTimingGate()`: needs ≥40 decisive closes (`MIN_DECISIVE_FOR_ADVISORY`, deploy-timing.js:24) and current 4h-UTC bucket with `n >= minBucketN` and `successRate < deadHourSuccessFloor`; `skip` → return before funnel; `size_down` → `deployAmount *= sizeDownPct` | `timing.gateEnabled` **false**, `minBucketN` 8, `deadHourSuccessFloor` 0.20, `deadHourAction` "size_down", `sizeDownPct` 0.5 | `[CRON] ⏸️ Deploy-timing gate: skipping…` / `Deploy-timing gate: size-down A → B SOL` |
| 1.11 | Deploy amount | index.js:1702; config.js:~1000 | `computeDeployAmount(sol)` = `clamp((sol−gasReserve)×positionSizePct, deployAmountSol, maxDeployAmount)` | `positionSizePct` 0.35 code → **0.5 prod**; `maxDeployAmount` 50 | `[CRON] Computed deploy amount: X SOL` |

Timing-gate `skip` returns BEFORE the funnel, so neither `candidatesReachedLLM` nor `funnelRan` is set and the starvation counter is untouched (index.js:2395).

---

## 2. Discovery fetch (Meteora Pool Discovery API)

Base: `POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag"` (tools/screening.js:22). Endpoint shape (477-491): `GET /pools?page_size=N&filter_by=<url-encoded '&&'-joined filters>&timeframe=<tf>&category=<cat>[&after_key=…]`. Detail fetch (493-507): `GET /pools?page_size=1&filter_by=pool_address=<addr>&timeframe=<tf>`.

The API's `volume`, `fee`, `fee_active_tvl_ratio`, `swap_count`, `*_change_pct`, `pool_price_change_pct` are WINDOWED by `timeframe`; `tvl`, `mcap`, `holders`, `bin_step` are levels.

### 2.1 Gate-mode query — `discoverPools` (665-857)
`filter_by` (667-689): `base_token_has_critical_warnings=false && quote_token_has_critical_warnings=false && [base_token_has_high_supply_concentration=false if excludeHighSupplyConcentration] && base_token_has_high_single_ownership=false && pool_type=dlmm && base_token_market_cap>=minMcap && base_token_market_cap<=maxMcap && base_token_holders>=minHolders && volume>=minVolume && tvl>=minTvl && [tvl<=maxTvl] && dlmm_bin_step>=minBinStep && dlmm_bin_step<=maxBinStep && fee_active_tvl_ratio>=minFeeActiveTvlRatio && base_token_organic_score>=minOrganic && quote_token_organic_score>=minQuoteOrganic && [base_token_created_at<=now−minTokenAgeHours] && [base_token_created_at>=now−maxTokenAgeHours] && [base_token_launchpad=[allowedLaunchpads]]`; `page_size=50`, `timeframe=s.timeframe`, `category=s.category`.

This is the query that compounded to `total=0` in the 2026-07-07 starvation incident (CLAUDE.md Known Issues).

### 2.2 Rank-mode query — `discoverPoolsBroad` (866-950)
Hardcoded `RANK_ENVELOPE` (78-85): `minTvl 10_000`, `minMcap 100_000`, `maxMcap 20_000_000`, `minHolders 500`, `minVolume1h 1_000`, `minFeeActiveTvlRatio1h 0.30`. Windowed floors are scaled `× tfMinutes/60` (873-876): at 1h → volume≥1000, fee_tvl≥0.30; at 5m → volume≥83, fee_tvl≥0.025. `filter_by` (878-894) = safety flags + `pool_type=dlmm` + mcap band + holders + scaled volume + `tvl>=10000` + scaled fee floor + configured bin-step band + token-age bounds. **No organic/quote-organic, no maxTvl, no minVolume/minMcap/minHolders from config.** Categories: `[s.category, "top"]` (897-898), `page_size=250` (89), max 3 requests total (90) → with two categories, 1 page each. Dedupe by `pool_address` (924-926). Then `discoverSteadyEnvelope` (939, §5) and `discoverTopPerformers` (942, §6). Universe count = `byAddr.size` (949).

Evidence in code comment (69-76): `fee_active_tvl_ratio >= 0.30` chosen because "bottom fee_tvl quartile had only 14% success (Spearman +0.39, Q1→Q4 14%→67%)" — 2026-07-07 backtest of 181 closes.

### 2.3 Volatility timeframe override — `applyVolatilityTimeframe` (509-555)
`MIN_VOLATILITY_TIMEFRAME="30m"` (23): if `s.timeframe` is shorter than 30m, one detail GET per pool at 30m; `pool.volatility`/`pool.volume` are OVERWRITTEN with the 30m values (541-546) and both windows are kept as `volume_<tf>`/`volatility_<tf>`. At prod 1h this is a no-op (1h ≥ 30m), so `volatility` is the 1h value. Prompt text (prompt.js:82) explains the same.

### 2.4 Timeframe scaling of config floors — screening-scales.js
`TIMEFRAME_SCREENING_SCALES` (8-16): 5m {fee 0.02, vol 500}, 30m {0.15, 1000}, 1h {0.2, 10000}, 2h {0.4, 20000}, 4h {0.4, 2000}, 12h {1.5, 60000}, 24h {2.0, 10000}. Applied ONLY by `update_config` when `timeframe` changes without explicit floors (tools/executor.js:1081-1088, log `[CONFIG] timeframe X → auto-scaled …`). `DEFAULT_TIMEFRAME="4h"` (18) is the fallback for an unknown string, while `config.screening.timeframe` defaults to "5m" (config.js:151). Same table is rendered to the LLM as "decent" guidance (prompt.js:84-93).

### 2.5 Discord signals (inert)
`useDiscordSignals` false (config.js:219) → `fetchDiscordSignalCandidates` (468, `${config.api.url}/signals/discord/candidates`), `refreshDiscordOnlyPools` (645), `enrichDiscordSignalLaunchpads` (557, Jupiter `assets/search`) never run.

### 2.6 GMGN source (not prod)
`screening.source` "meteora" (prod). `"gmgn"` routes to `discoverGmgnPools` (tools/gmgn.js:568) — not documented further here.

---

## 3. The two admission modes side by side

| Aspect | GATE (`screeningAdmissionMode="gate"`, code default) | RANK (`"rank"`, **prod**) |
|---|---|---|
| Entry | `getTopCandidates` 1231 → `discoverPools` 665 | `getTopCandidates` 1231 → `getTopCandidatesRank` 1589 |
| Server query | all configured quality floors (§2.1) | hardcoded safety envelope only (§2.2) |
| Categories / page | `s.category` (default "trending"), 50 rows | `s.category` + `"top"`, 250 rows each; + steady 24h pass; + Top Performers tab |
| Client recheck | `getRawPoolScreeningRejectReason` (367-466) re-applies every server floor + `minLps`, `volume/TVL`, `tx/min`, launchpads, token age, TVL exemption | none of the quality floors; `applyRankSafetyGates` (1132-1185) |
| Blacklist / dev blocklist | inside `discoverPools` (770-782) + dev fetch from Jupiter when blocklist non-empty (807-829) + again at 1458-1471 | `applyRankSafetyGates` 1134-1141 |
| Occupied pool / mint | Stage-B metrics filter 1329-1336 | 1142-1149 |
| Pool / token cooldown (pool-memory) | 1337-1345 | 1150-1157 |
| TVL drain guard | `recordTvlSnapshot` for all (1286-1289), `checkTvlDrain` 1303-1311 | 1163-1172 |
| GMGN exit-signals guard | `checkExitSignals` 1313-1319 (reads `gmgn_*` fields → inert on Meteora payload) | not applied |
| minTvl / maxTvl | server + recheck (with `hasCleanPoolHistory` exemption 400-413) + Stage-B 1293-1301 | `minTvl` enforced at admission 1695-1782 with exemption / Top-Performer / scout branches; **maxTvl not applied anywhere in rank mode** (only later by the executor, §10) |
| minFeeActiveTvlRatio | server + recheck 421-423 + Stage-B 1321-1325 | NOT applied (envelope 0.30/1h is the wall — CLAUDE.md plan #12); executor still checks it (§10) |
| Volatility usable | recheck 420 + Stage-B 1326-1328 | 1158-1161 |
| Dev score fetch + `minDevScore` | 1352-1385 (`getGmgnDevInfo` per candidate) | GMGN dev fetch on the 2×N enrichment slice 1611-1623; `minDevScore` NOT applied in rank mode |
| Dump-play guard | 1388-1411 | 1636-1650 |
| Safety enrichment | 1414-1418 (after dump guard, before intel) | 1628-1631 (same insertion) |
| Intel scoring | `scoreCandidate` all, sort desc, `splice(limit)`, then `minIntelScore` filter 1420-1440 | `scoreCandidate` on slice, `computeAdmissionScore` again 1654-1660; bar `rankMinIntelScore` or `rankSteadyMinIntel` 1676-1685 |
| Velocity gates (vol/TVL, tx/min) | in recheck 425-443 | at admission 1784-1808, waived for steady lane |
| PVP | `enrichPvpRisk` top-2 + optional block 1442-1456 | same on admitted 1838-1849 |
| Chart indicators | 1473-1510 (`config.indicators.enabled` false → skipped) | not applied |
| Fee-efficiency / momentum annotate + `organicMomentumHardFilter` | 1515-1535 | annotate only 1834-1836 — **hard filter NOT applied in rank mode** |
| Final cut | sort by intel, `limit` (10) | sort by `_admissionScore`, `min(rankAdmitCount, limit)` |
| Telemetry | `[SCREENING] discovery: api_total=… fetched=… → client_recheck=… → blacklist=… \| recheck_rejects: …` (794) + `[SCREENING] funnel: input=… → metrics → dev_score → dump_guard → intel → pvp → indicators → final` (1544) | `[SCREENING] funnel[rank]: universe=… → safety=… → prescore_pool=… → enriched_gates=… → admitted=…` (1861) |
| Shadow of the other mode | `runRankShadow` (1898-1925) when `rankShadowEnabled` → `[SCREENING] [RANK_SHADOW] would-admit topN: SYM(score) … \| gate-mode admitted: n \| overlap: k` | none |

Config: `screeningAdmissionMode` "gate" → **prod "rank"**; `rankAdmitCount` 5; `rankMinIntelScore` 52 → **prod 61**; `rankShadowEnabled` true.

### 3.1 Gate-mode client recheck order — `getRawPoolScreeningRejectReason` (367-466)
Returns the first failing reason string (family = text before `below|above|not|is|unusable|has`): supply-concentration flag → critical warnings (base, quote) → high single ownership → `pool_type!=dlmm` → `mcap<minMcap` / `>maxMcap` → `holders<minHolders` → `total_lps<minLps` (only if `minLps>0`; default 0) → `volume<minVolume` → `tvl<minTvl` unless `hasCleanPoolHistory(pool_address).clean` (`[SCREENING] [TVL_EXEMPT] <name>: TVL $x < minTvl $y but pool history is clean (n closes, worst w%, avg a%) — admitting`, 409) → `tvl>maxTvl` → bin_step band → volatility unusable (`isUsableVolatility`: finite and >0, 331) → `fee_active_tvl_ratio<minFeeActiveTvlRatio` → `volume/TVL<minVolumeTvlRatio` (425-431; ratio = `volume_tvl_ratio ?? volume/tvl`) → `tx/min<getMinTxPerMinForTimeframe(tf,minTxPerMin)` (433-443) → base organic `<minOrganic` → quote organic `<minQuoteOrganic` → allow-list (discord-signal pools only, 452-459) → `blockedLaunchpads` → token age bounds.

`getMinTxPerMinForTimeframe` (45-56): 5m → base; 1h → min(base,2.0); 24h → min(base,0.8); other → min(base,2.0). Code defaults: `minTxPerMin` 5.0, `minVolumeTvlRatio` 0.05 (local dev copy also 5 / 0.05).

Config defaults (config.js:134-153): `minFeeActiveTvlRatio` 0.05 (prod uncertain: 0.30 set 2026-07-07 per CLAUDE.md; executor comment dated 2026-08-22 at tools/executor.js:205 calls the floor "0.05%/h", and `EVOLVE_BASELINES.minFeeActiveTvlRatio=0.05` is where the starvation relaxer walks it), `minVolumeTvlRatio` 0.05, `minTxPerMin` 5, `minTvl` 10_000 → **prod 100_000**, `maxTvl` 150_000 → **prod 400_000** (CLAUDE.md), `minVolume` 500, `minOrganic` 60 (prod 74 as of 07-07), `minQuoteOrganic` 60, `minHolders` 500, `minLps` 0, `minMcap` 150_000 (prod 300_000 as of 07-07), `maxMcap` 10_000_000, `minBinStep` 80, `maxBinStep` 125, `timeframe` "5m" (prod 1h, uncertain), `category` "trending", `excludeHighSupplyConcentration` true, `allowedLaunchpads` [], `blockedLaunchpads` [], `minTokenAgeHours`/`maxTokenAgeHours` null.

---

## 4. Rank-mode admission in detail (`getTopCandidatesRank`, 1589-1895)

1. `admitCount = max(1, rankAdmitCount ?? 8)`, `minIntel = rankMinIntelScore ?? 35` (~1591-1592; the `??` fallbacks differ from config defaults 5/52 — only relevant if the keys are deleted).
2. `discoverPoolsBroad()` → universe (1601).
3. Occupied pools/mints from a fresh `getMyPositions()` (1604-1607).
4. `applyRankSafetyGates` (1132-1185): reasons `blacklisted token`, `blocked deployer`, `already have an open position in this pool`, `already holding this base token in another pool`, `pool cooldown active`, `token cooldown active`, `volatility X unusable`, `TVL drain: N% drop from peak` (needs `tvlDrainEnabled` true, threshold `tvlDrainThresholdPct` −30, in-process snapshots: ≥2 min apart, ≤12 kept, ≤2h old — tvl-guard.js:7-13,28-63,136-165), `blocked launchpad (X)`.
5. `prescoreRankCandidates` (1187-1229): within-set percentiles of `computeFeeEfficiency().ratio` and raw `fee_active_tvl_ratio` (best 1.0, worst 0.0), `annotateOrganicMomentum`, `_admissionScore = computeAdmissionScore(p, {feePercentile, feeTvlPercentile})`, sort desc.
6. `computeAdmissionScore` (255-276): `intel_total + {growing:+5, decaying:−10, else 0} + 12×(feeTvlPct−0.5) + 10×(feePct−0.5)` (missing percentile → 0). Weighting rationale in comment 221-254 (2026-07-07 backtest: fee_tvl strongest, organic flat, volume already inside intel).
7. Enrichment slice = `preScored.slice(0, admitCount*2)` (1614). For each: `getGmgnDevInfo(mint)` (keyed GMGN only) → `computeDevScore` (1617-1623; log `[SCREENING] rank: dev score failed …`). Then `enrichSafetyInputs` if `safetyEnrichMode != "off"` (1628-1631).
8. Per pool (1633-1811), in order:
   - Dump-play guard (1636-1650): if `price_change_pct <= −20`: reject when `dev.creator_token_status` is `creator_close`/contains `sell` (`dump play: dev sold/closed`), or when `devScore < 70` and not Top Performer (`dump play: dev score S < 70`). Without a GMGN key `_devScore.total` is the neutral 50 → every ≥20% dumper is rejected unless it is a Top Performer.
   - `scoreCandidate` + `computeAdmissionScore` again with dev score present (1654-1660).
   - Yield-window shadow row when `intelYieldWindowMode="legacy"` (1662-1667).
   - Intel bar (1676-1685): `intelBar = (steady_envelope && rankSteadyMinIntel>0) ? rankSteadyMinIntel : minIntel`; reason `intel score X below rankMinIntelScore|rankSteadyMinIntel Y`. Prod: rankMinIntelScore 61, rankSteadyMinIntel 42.
   - Entry-TVL floor (1695-1782): if `tvl < minTvl`:
     - Top Performer with `tvl >= max(10_000, topPerformersMinTvl)` → GeckoTerminal trend check (`isRebalanceTrendIncreasing`, only if `topPerformersRequireTrend !== false`; 1705-1723): confirmed → `_isTopPerformer`, `_admissionScore += 15`, hint {69 bins, 0 above, spot}; if `!hasCleanPoolHistory().clean` → `_scoutTier = true` (`[SCREENING] [TOP_PERFORMER] <name>: TVL $x < minTvl $y — admitted as SCOUT (size capped at 0.12 SOL), not full size`). Not confirmed → reject `Top performer 15m trend not confirmed`. Logs `[TOP_PERFORMER_ADMIT]` / `[TOP_PERFORMER_COOLING]` (1716/1719).
     - else clean history → `[SCREENING] [TVL_EXEMPT] … — admitting` (1748-1750).
     - else scout path (1759-1776): needs `intel >= scoutMinIntel`; if `!scoutTierEnabled` → `[SCREENING] [SCOUT_SHADOW] would-admit …` and reject `TVL $x below minTvl $y`; else `_scoutTier=true`, `[SCREENING] [SCOUT] admitting … as scout: … size capped at … (history-building)`.
   - Velocity gates (1784-1808): `volume/TVL < minVolumeTvlRatio` and `tx/min < getMinTxPerMinForTimeframe` reject unless `steady_envelope` (waived; `[SCREENING] [LANE] velocity gates waived for steady-lane <name>: …`).
9. Sort survivors by `_admissionScore`, admit `slice(0, min(admitCount, limit))` (1814-1815).
10. Lane hints (1820-1832): steady → `computeSteadyLaneHint` stored in `_steadyLaneHints` (TTL 3h, 955-984); Top Performer → `{bins_below:69, bins_above:0, shape:"spot"}` in `_topPerformerHints` (TTL 3h, 987-998). Both attach `p.lane_width`.
11. `rankByFeeEfficiency(admitted)`, `annotateOrganicMomentum(admitted)` (1834-1836), PVP (1838-1849), `[YIELD_WINDOW_SHADOW]` line (1851-1855), `funnel[rank]` telemetry (1859-1865), `captureScreeningSnapshots` (1869).

Return shape: `{candidates, total_screened: universeCount, source:"meteora", filtered_examples (first 3), stage_counts:{mode:"rank", universe, safety, prescore_pool, enriched_gates, admitted}, all_filtered}`.

---

## 5. Steady lane end-to-end (plan #12)

| Step | Location | Detail |
|---|---|---|
| Envelope fetch | `discoverSteadyEnvelope` 1004-1084 | One extra request `timeframe=24h`, `category=s.category`, `page_size=250`, `filter_by` = safety flags + `pool_type=dlmm` + RANK_ENVELOPE mcap/holders + `tvl>=rankSteadyMinTvl` + `fee_active_tvl_ratio>=rankSteadyMinFeeTvl24h` + bin-step band + token-age. Candidates = rows not already in `byAddr`. OFF → `[SCREENING] [STEADY_ENVELOPE_SHADOW] would-add N pool(s) outside the <tf> burst envelope: … (rankSteadyEnvelopeEnabled=false)`. ON → sort by 24h fee desc, take `rankSteadyMaxExtra`, re-fetch each at `s.timeframe` via `fetchPoolDiscoveryDetail` (so windowed fields are consistent), tag `_steadyEnvelope=true`, `fee_active_tvl_ratio_24h=<24h value>`; `[SCREENING] [STEADY_ENVELOPE] added a/b steady pool(s) to the universe: … (capped at rankSteadyMaxExtra=N)`. Failure → `[STEADY_ENVELOPE] pass failed (ignored)`. |
| Tag | `condensePool` 2003-2099 | `steady_envelope: !!p._steadyEnvelope`, `fee_active_tvl_ratio_24h` |
| Intel bar | 1676-1685 | `rankSteadyMinIntel` (null = inert → `rankMinIntelScore`) — prod **42** |
| Yield scoring | intel-score.js:249-276 | in `"log"` mode the fee term uses `max(windowed×1440/tf, fee_active_tvl_ratio_24h)` — steady pools scored on their own 24h average |
| Velocity waivers | 1784-1808 | vol/TVL and tx/min skipped; `[LANE] velocity gates waived …` |
| Width hint | `computeSteadyLaneHint` 958-974 | needs `steadyLanePlaystyle` ∈ `PLAYSTYLE_PRESETS`; `min=max(35, preset.min)`, `max=max(min,preset.max)`, `bins = clamp(round(min + vol/5×(max−min)), min, max)` (same shape as global formula), `shape = steadyLaneShape ∈ {spot,curve,bidask}` else spot. Prod preset `single_account` {45,69}. |
| Candidate lines | index.js:1988-1996 (gmgn branch) / 2020-2028 (meteora) | `steady_envelope: … fee/TVL 24h X% (own hourly avg Y%/hr) vs this <tf> window Z% …` + `pool_price_change: <tf> ±N% …` + `lane_width: steady lane → use bins_below = B (preset [min,max] …) and shape = S …` |
| STEPS rule | index.js:2181 | when `steadyLanePlaystyle` set: "LANE WIDTH: if the chosen candidate shows a lane_width line, pass exactly that bins_below and shape" |
| Executor width | tools/executor.js:1753-1762 | `getSteadyLaneHint(pool)`: fills `bins_below`/`shape` if omitted, sets `args.lane="steady"`, `args.lane_min_bins=hint.min`; bins floor becomes `max(35, hint.min)` (1782-1784); `deployPosition` range guard reads `lane_min_bins` (tools/dlmm.js:1220-1221). Log `[EXECUTOR] [LANE] steady-lane width for …` |
| Executor fee floor waiver | tools/executor.js:198-230 | if window `fee_active_tvl_ratio < minFeeActiveTvlRatio` AND a steady hint exists → one extra 24h detail GET; pass if `fee24 >= management.minFeePerTvl24h (7 code; comment says 1%/day) ?? 1.0`; fail-closed on error. `[EXECUTOR] [LANE] fee floor satisfied on the 24h window …` |
| Executor velocity waiver | tools/executor.js:234-254 | `steadyLaneVelocityWaiver = !!getSteadyLaneHint(pool)`; `[EXECUTOR] [LANE] velocity gates waived for steady-lane deploy …` |
| Perf record | executor → state → lessons | `lane:"steady"` flows to the perf record (CLAUDE.md) |

Config: `rankSteadyEnvelopeEnabled` false (prod: ON — inferred from CLAUDE.md "First lane deploy: STONK-SOL … 2026-08-22"; uncertain), `rankSteadyMinFeeTvl24h` 1.5, `rankSteadyMinTvl` 100_000, `rankSteadyMaxExtra` 10, `rankSteadyMinIntel` null → prod 42, `steadyLanePlaystyle` null → prod `single_account`, `steadyLaneShape` "spot", `intelYieldWindowMode` "legacy" → prod "log".

Evidence (CLAUDE.md plan #12): fee≥0.30/1h fetched 7 pools, 0 with TVL≥100k on 2026-08-22; MANLET/TOAD/BULLSHIT at 0.06–0.14%/h but 2.5–3.1%/24h were invisible; GTA6-SOL first steady deploy entered on +18.4% window move → OOR-above in 7 min, 0 fees (hence the `pool_price_change:` line).

---

## 6. Top Performers path

| Step | Location | Detail |
|---|---|---|
| Fetch | `fetchMeteoraTopPerformers` 1086-1093 | `GET https://pool-discovery-api.datapi.meteora.ag/pools?page_size=20&category=top&timeframe=24h&filter_by=pool_type=dlmm`; keep `pool_type==="dlmm"`, slice `limit` |
| Merge | `discoverTopPerformers` 1095-1122 | skipped if `topPerformersEnabled===false`; tags `_isTopPerformer=true` on new and existing rows; `[SCREENING] [TOP_PERFORMERS] Added N top performer pool(s) from Meteora Top Performers tab`; failure non-fatal |
| Condense | 2020 | `top_performer: !!p._isTopPerformer` |
| Dump guard bypass | 1400-1408 (gate), 1645-1649 (rank) | `isTop` skips the `devScore < 70` branch (not the dev-sold branch) |
| Sub-floor admission | 1697-1740 | only when `tvl < minTvl` AND `tvl >= max(10_000, topPerformersMinTvl)`; GeckoTerminal trend (`isRebalanceTrendIncreasing`, tools/rebalance-trend.js:65-120: last N `topPerformerTrendCandles` candles of `topPerformerTrendTimeframe`; `netGain>0 && latestAdvancing && (higherCloses || higherLows || greens >= ceil(0.6N))`; candles from `https://api.geckoterminal.com/api/v2/networks/solana/pools/<pool>/ohlcv/<minute|hour>?aggregate=A&limit=L`); +15 admission score; scout tag unless clean history |
| Above-floor Top Performers | — | no special handling beyond the tag; still get the 69/0/spot hint at admission (1826-1830) |
| Executor | tools/executor.js:152-163, 1763-1770 | sub-floor Top Performer gets NO full-size bypass (plan #15 item 4) — falls to clean-history exemption or scout clamp (`[EXECUTOR] [TOP_PERFORMER] sub-floor Top Performer … no full-size bypass; scout clamp applies (scoutTierEnabled=false → blocked)`); width hint fills `bins_below=69, bins_above=0, shape=spot` when omitted, `args.lane="top_performer"` (`[TOP_PERFORMER] deploy width for …`) |

Config: `topPerformersEnabled` true, `topPerformersLimit` 10, `topPerformersMinTvl` 15_000, `topPerformersRequireTrend` true, `topPerformerTrendTimeframe` "5m", `topPerformerTrendCandles` 6. Note the Top Performers tab is 24h-ranked while everything else is windowed at `s.timeframe`; a Top Performer row that was NOT already in `byAddr` keeps its 24h-window `volume`/`fee_active_tvl_ratio` values (it is not re-fetched at `s.timeframe`, unlike steady extras) — its windowed fields are therefore inconsistent with the rest of the set (code reading; not flagged in comments).

---

## 7. Scout and probe tiers as seen from screening

**Scout** (sub-floor, history-building): admission only in rank mode at 1759-1776 (bar `scoutMinIntel`, enriched intel), or via Top-Performer sub-floor without clean history (1735-1739). Candidate block line `scout_tier: TVL below the $minTvl floor — admitted as a HISTORY-BUILDING scout. The executor will cap the deploy at scoutSizeSol …` (index.js:1929-1931). Scouts bypass the gas break-even filter (1823-1826, `Gas filter: <name> exempt (scout tier …)`). Executor mirror: `validateDeployPoolThresholds` returns `scoutTier=true` for any sub-floor unproven pool when `scoutTierEnabled` (tools/executor.js:170-182, `[SCOUT] deploy below minTvl … treated as scout`), else `SAFETY_BLOCK` "Pool TVL $x is below configured minTvl $y" (184-187); safety block clamps `amount_y` to `scoutSizeSol` (min 0.05), caps open scouts at `scoutMaxPositions` (1909-1927; `Scout limit reached`, `[SCOUT] clamping deploy size`), sets `args.scout=true`, min-deploy floor 0.05 (1971). Config: `scoutTierEnabled` false (prod uncertain), `scoutSizeSol` 0.12, `scoutMinIntel` 70 → **prod 78**, `scoutMaxPositions` 1.

**Probe** (above-floor, low conviction): purely an LLM-requested `deploy_position.tier="probe"` (tools/definitions.js:203-207). Offered in the system prompt (prompt.js:117-118) and STEPS (index.js:2171-2172) only when `probeTierEnabled`. Executor (tools/executor.js:1929-1965): refused when disabled (`Probe tier is disabled (probeTierEnabled=false) …`), clamp to `probeSizeSol` (min 0.05), cap `probeMaxPositions` (`Probe limit reached`), `args.probe=true`; a scout never doubles as a probe (`probeRequested && !scoutTier`). Config: `probeTierEnabled` false (prod uncertain — enable order per CLAUDE.md is losers-only → steady → probe), `probeSizeSol` 0.25, `probeMaxPositions` 1.

Both `scout`/`probe` are stripped from caller args (1724-1725) and derived only by the executor.

---

## 8. Post-funnel processing in `runScreeningCycle` (index.js)

### 8.1 Recon loop (1740-1752)
For each candidate (sequential, 150 ms spacing): `checkSmartWalletsOnPool({pool_address})` (smart-wallets.js:47-97; LP-type tracked wallets, `getWalletPositions` per wallet with cache; `in_pool` list), `getTokenNarrative({mint})` (tools/token.js:21-30, `GET https://datapi.jup.ag/v1/chaininsight/narrative/<mint>`), `getTokenInfo({query: mint})` (tools/token.js:36-97, `GET https://datapi.jup.ag/v1/assets/search?query=<mint>` → first hit: `mcap, liquidity, holders, organic_score, launchpad, graduated, global_fees_sol (Jupiter fees, refined by GMGN /v1/token/info total_fee when keyed + feeSource="gmgn"), audit{mint_disabled, freeze_disabled, top_holders_pct, bot_holders_pct, dev_migrations, insider_pct, sniper_pct, dev_balance_pct, dev_mints, permanent_control, bundler_pct, bundler_pct_ath}, stats_1h{price_change, buy_vol, sell_vol, buyers, net_buyers}, stats_24h_net_buyers`), `recallForPool(pool)` (pool-memory.js:598-643 → "POOL MEMORY [name]: n past deploy(s), avg PnL, win rate, last outcome" + POOL/TOKEN COOLDOWN lines + RECENT TREND + last NOTE).

### 8.2 Rug signals + CRI (1757-1771; rug-signals.js)
Always computed: `extractRugSignals(ti, pool)` (75-151; returns all-null if `ti.mint !== pool.base.mint`), `evaluateRugFilter` (153-168: fires only when value AND threshold non-null and `value > limit` for `insider_pct > rugMaxInsiderPct`, `top10_pct > rugMaxTop10Pct`, `dev_mints > rugMaxDevMints`), `computeClusterRiskIndex` (242-317: `concentration` = √Σpct² over top-10 non-vault holders (or `top10_pct` fallback), weighted 0.40 + `bundler_pct` 0.35 + `fresh_wallet_pct` 0.25, re-normalised over available terms; levels ≥70 critical / ≥50 high / ≥25 medium), `evaluateClusterRisk` (327-338: `cri > criRejectThreshold`). Config: `rugFilterMode` "off", `rugMaxInsiderPct` 20, `rugMaxTop10Pct` 60, `rugMaxDevMints` null, `criFilterMode` "log_only", `criRejectThreshold` 75.0. Field availability evidence (rug-signals.js:22-31, 84-mint universe 2026-07-16): topHoldersPercentage 100%, devMints 100%, bundlerStats 67%, devMigrations 57%, devBalancePercentage 30%, insiderPct 12%, sniperPct 7%. The CRI also feeds a Safety multiplier inside intel-score (§13.1) but `pool.cri` is set AFTER intel scoring in the funnel, so it only affects the deploy-time `signal_snapshot`, not admission.

### 8.3 Post-recon filters (1776-1814) — `passing`
- `allowedLaunchpads` non-empty and `ti.launchpad` not in it → drop (`[SCREENING] Skipping <name> — launchpad X not in allow-list`).
- `blockedLaunchpads.includes(ti.launchpad)` → drop (third launchpad check in the chain).
- `ti.audit.bot_holders_pct > maxBotHoldersPct` → drop (`[SCREENING] Bot-holder filter: dropped <name> — bots X% > Y%`). `maxBotHoldersPct` 30.
- `[RUG_FILTER] reject|would-reject <name>: check=value>limit` — drops only in `enforce`.
- `[CRI_SHADOW] reject|would-reject <name>: CRI x > t` — drops only in `enforce`.
GMGN-sourced pools skip this block (`if (pool.gmgn) return true`).

### 8.4 Gas break-even filter (1816-1840)
`feeTvl = pool.fee_tvl_24h ?? pool.fee_per_tvl_24h ?? 0`; `isWide = (pool._binCount ?? 0) > 69`; `gasCost = estimateCycleGasCost(isWide)` (tools/dlmm.js:399-411: `(deployTxs(1|3)+3 close+1 swap) × (5000 + cached normal priority fee) / 1e9`); `breakEven = gasBreakEvenMinutes(gasCost, feeTvl, deployAmount)` (419-425: `gasCost / ((feeTvl/100)×deploySol/1440)`, `Infinity` when feeTvl ≤ 0); drop when `Number.isFinite(breakEven) && breakEven > maxGasBreakEvenMinutes` (30). **Neither `fee_tvl_24h`, `fee_per_tvl_24h` nor `_binCount` is produced by `condensePool` (only `fee_active_tvl_ratio_24h` on steady extras) — grep confirms those names exist only on position objects (index.js:875,1391,3896).** So on the Meteora path `feeTvl=0 → Infinity → passes`: the filter appears inert (verify with `grep "Gas filter:"` on VM logs). Scouts are explicitly exempt.

### 8.5 Empty / lone candidate handling
- 0 passing (1843-1868): report "No candidates available." + `buildFunnelReport` (3910-3950: `discovery:` + `funnel:` lines + top-8 reject families) or filtered examples; `appendDecision({type:"no_deploy", summary:"No candidates available"})`; `funnelRan=true` feeds the starvation counter.
- 1 passing (1870-1901): `getLoneCandidateSkipReason` (3952-3988): hard → `is_wash` (GMGN only), `global_fees_sol < minTokenFeesSol` (30), `top10 > maxTop10Pct` (60), `bots > maxBotHoldersPct` (30, already filtered — redundant); conviction → `is_rugpull`/`is_pvp` need `degenScore >= loneCandidateMinDegen` (50); else needs `narrative OR degen >= 50`. Skip → "⛔ NO DEPLOY … Only one candidate survived filtering, but it was not worth deploying: <reason>" and `appendDecision("Single candidate skipped")` — the LLM is NOT called. Same function guards `/deploy` of a cached solo candidate (`deployLatestCandidate` 5300-5352).

`degenScore` (tools/screening.js:292-323): inputs normalised to a 30m reference (`tfScale = 30/tfMinutes`); `sTrading = clamp(volume_active_tvl_ratio×scale / targetVolRatio)`, `sLp = clamp((unique_lps+positions_created)×scale / targetLpCount)`, `sFees = clamp(fee_active_tvl_ratio×scale / targetFeeRatio)`, `sLiq = clamp(log10(active_tvl)/log10(targetLiquidity))`; score = `(sTrading×sLp×sFees×sLiq)^0.25 × 100` (any zero → 0). Targets `opportunity.targetVolRatio` 20, `targetLpCount` 40, `targetFeeRatio` 0.20, `targetLiquidity` 20000.

### 8.6 Pre-LLM enrichment
- `getActiveBin` for every passing pool in parallel (1903-1905) → `active_bin:` line.
- LPAgent study (1909-1914): `getCachedLpStudy(pool)` for the first `lpStudyMaxPools` (4), 250 ms spacing, 30-min cache (lper-signal.js:14-33); `studyTopLPers` (tools/study.js:7-11) → `GET ${config.api.url}/top-lp/<pool>` + `GET …/study-top-lp/<pool>` with `x-api-key`; `config.api.url` default `https://api.agentmeridian.xyz/api`; 429 → thrown → cached null (`[SCREENING] LPAgent study skipped for …`).

### 8.7 Candidate block (Meteora branch, index.js:~2005-2035; GMGN branch 1971-2003)
Lines in order (null lines dropped):
1. `POOL: <name> (<address>)`
2. `metrics: bin_step=, fee_pct=%, fee_tvl=<fee_active_tvl_ratio>, vol=$<volume_window>, tvl=$<tvl ?? active_tvl>, volatility_<tf>=, mcap=$, organic=, age=<h>`
3. `fee_efficiency=<ratio> (fee%/volatility, #rank/of, pP)` — fee-efficiency.js:206-211
4. `sim: rar=… irf24h=… il=…% aprE=…% (range -D%, ballpark) edge=Nx (fees vs vol-premium)[ ⚠️ premium>fees]` — pool-simulator.js:295-320 (§13.4)
5. `flow: live fee velocity X%/hr vs 24h-avg Y%/hr → ACCELERATING|steady|FADING (xF)` — index.js:1943-1957: `liveHourly = fee_active_tvl_ratio×60/tfMin`, `trailHourly = (fee_tvl_24h ?? fee_per_tvl_24h)/24`, factor ≥1.5 ACCELERATING, ≤0.5 FADING. **Reads the same non-existent fields as §8.4 (and its tfMin map at 1945 lacks "4h") — appears never to render on Meteora candidates; verify on VM logs.**
6. `momentum: GROWING|steady|DECAYING ⚠️ (traders ±%, vol ±%, holders ±%, n=N[, THIN])` — organic-momentum.js:138-147
7. `similar_past: N like this → k fee-death (~Mm), k success +P%, k neutral | nearest: <pool> <when> ±P% <reason>` — lessons.js:1404-1434
8. `top_lpers: N winners, style=X (a/b), ~B bins, hold Hh, win W%, open_pnl ±P% [suggested: S]` — lper-signal.js:91-119
9. `bins_hint: B (match winning LPers [basis] — use as bins_below)` — only when `lpStyleSteerEnabled` (index.js:1966-1973; lper-signal.js:66-84 clamps avg `range_width_pct` (treated as bins) or consensus style → lo/mid/hi into [minBins,maxBins])
10. `audit: top10=%, bots=%, fees=<global_fees_sol>SOL[, launchpad=]`
11. `gmgn_price: …` (GMGN only)
12. `pvp: HIGH — rival <name> (<mint>) has pool …, tvl=$, holders=, fees=SOL`
13. `scout_tier: …` (§7)
14. `steady_envelope: …` (§5)
15. `pool_price_change: <tf> ±N% (Meteora pool price over the screening window; persisted as entry_price_change_pct …)`
16. `lane_width: steady lane → use bins_below = B … shape = S …`
17. `smart_wallets: N present[ → CONFIDENCE BOOST (names)]`
18. `active_bin: <binId>`
19. `1h: price±P%, net_buyers=N` (from `ti.stats_1h`)
20. `narrative_untrusted: <sanitized ≤500 chars> | none`
21. `memory_untrusted: <recallForPool text, sanitized ≤500>`

### 8.8 Deploy-time signal snapshot (`stageSignals`, 2038-2105; gated `config.darwin.enabled` true)
Captures per pool: base_mint, organic_score, fee_tvl_ratio, volume, mcap, holder_count, bot_holders_pct, top10_pct, price_change_1h, net_buyers_1h, smart_wallets_present, narrative_quality present/absent, volatility, token_age_hours, all `rug_*` fields + `rug_checks_tripped`, `cri_score/risk_level/concentration`, `smart_flow_ratio`, `intel_safety/yield/momentum/trust/total`, `intel_safety_enriched`, `intel_total_enriched`, `lper_suggested_style`, `lper_consensus_style`. Feeds `signal_snapshot` on the perf record (lessons.js `buildSignalSnapshot` 71) — the data the evolution engine's `minIntelScore` floor and the rug/CRI backtests read.

### 8.9 LLM-call suppressors
- Identical-set fingerprint (2120-2130): `candidateFp = sorted pool addresses`; if equal to `_lastDeclinedCandidates.fp` and age `< opportunity.retriggerCooldownMin` (30) → skip LLM (`[CRON] Screening: identical candidate set declined Nm ago — skipping LLM re-ask (Mm cooldown left)`). `candidatesReachedLLM` stays true (never feeds starvation). Cleared on a successful deploy (2257); set on any decline including no-tool fallbacks (2260). In-memory.
- Per-pool verdict cache (2133-2159, 2264-2272; `_verdictCache` 511): entries `{at, mcap, holders, fee_tvl, name}` written only on a genuine judgment decline (`!noToolFallback && !deployAttempted`); prune by `verdictCacheTtlMin`; a pool "needs judgment" if `mcapDrift > 0.20 || holderDrift > 0.30 || feeNow/cached.fee_tvl >= 1.6` (renewed-flow invalidation); all cached → skip (`[CRON] [VERDICT_CACHE] all N candidate(s) carry a fresh NO-DEPLOY verdict (<Tm, mcap ±20% / holders ±30% unmoved) — skipping LLM re-ask`); partial → `[VERDICT_CACHE] k/N candidate(s) cached NO-DEPLOY, m changed/new — running LLM on the full set`; cleared on deploy. **The drift check reads `pool.base?.market_cap` and `pool.base_token_holders`, but the condensed candidate exposes `mcap` / `holders` (and `base` = {symbol, mint, organic, warnings}, tools/screening.js:2014-2019, 2048-2049). With `mcapNow=0` the code sets `mcapDrift=1` ("missing data → drifted") for every pool, so the cache appears never to skip a call — verify by grepping `[VERDICT_CACHE] all` on the VM.** Config `verdictCacheEnabled` true, `verdictCacheTtlMin` 30.

### 8.10 After the LLM (2256-2400)
`deploySucceeded` ⇔ tool success without `error`/`blocked`. Bear-debate summary line `🐻 Bear debate [log_only|enforce]: <verdict> …` + `appendDecision(type:"bear_debate")` when `deployVerdict` present (2287-2318; prod `bearDebateEnabled=false` → absent). `⛔ NO DEPLOY` regex → decision "LLM chose no deploy" with per-candidate intel scores. Funnel doc `setLastScreeningFunnel` + `publishReportTracked` (2360-2392). `finally`: `maybeRelaxOnStarvation({reachedLLM})` when `candidatesReachedLLM || funnelRan`.

---

## 9. Starvation counter + relaxer

`maybeRelaxOnStarvation` (index.js:2438-2488): state_meta singleton `_screeningStarvation {emptyCycles, lastRelaxedAt}` (state.js:229, 3324). `reachedLLM` → reset to 0. Else `emptyCycles++` (`[CRON] Screening produced no candidates (N consecutive empty cycles)` / `⚠️ N consecutive empty screening cycles` once ≥ threshold). When `emptyCycles >= starvationRelaxAfterEmptyCycles` AND `now − lastRelaxedAt >= starvationRelaxCooldownHours` → `applyStarvationRelaxation({trigger})` (lessons.js:856-881) → `computeStarvationStep` (826-838): among `minFeeActiveTvlRatio / minOrganic / minIntelScore`, pick the one furthest above `EVOLVE_BASELINES` {0.05, 60, 52} (ratio > 1.01), `nudge` toward baseline by ≤20% (`MAX_CHANGE_PER_STEP`), clamp to `EVOLVE_BOUNDS` {fee 0.05–0.60, organic 55–85, intel 52–70}, round (fee 2dp, others int); only lowers. Persists through `persistEvolution` (776-816: atomic `user-config.json` write, live `config.screening[k]=v`, evolution history row, lesson row). `lastRelaxedAt` advances even when nothing moved. Logs `[EVOLVE] Starvation relaxer stepped floors: k→v` / `… all floors already at baseline — nothing to relax`; Telegram "🔧 Starvation relaxer". Config: `starvationRelaxEnabled` true, `starvationRelaxAfterEmptyCycles` 12, `starvationRelaxCooldownHours` 3.

Note: in prod rank mode, `minFeeActiveTvlRatio`/`minOrganic` are not admission inputs (only the executor reads `minFeeActiveTvlRatio`), and the relaxer touches `minIntelScore` (gate-mode key) rather than `rankMinIntelScore`. Since verdict-cache and fingerprint skips keep `candidatesReachedLLM=true`, the counter only accrues on genuinely empty funnels.

---

## 10. Executor mirrors (deploy_position safety block)

`validateDeployPoolThresholds` (tools/executor.js:131-307), fresh detail GET at `config.screening.timeframe` (`fetchFreshPoolDetail` 121): TVL present → `tvl < minTvl` branch (§6/§7: Top-Performer log, clean-history `[EXECUTOR] [TVL_EXEMPT] deploy allowed below minTvl …`, scout, else block) → `tvl > maxTvl` block (189-194; the only maxTvl enforcement in rank mode) → `fee_active_tvl_ratio < minFeeActiveTvlRatio` block unless steady-lane 24h waiver (198-230) → vol/TVL and tx/min blocks unless steady waiver (234-254) → volatility re-fetched at `max(tf, 30m)` must be finite >0 (256-275) → bin-step band (277-291) → returns `entryMarketData {entry_mcap, entry_tvl, entry_volume, entry_holders, entry_price_change_pct}` + `baseMint` + `scoutTier`.

`runSafetyChecks("deploy_position")` (1718-1998): strip `scout/probe/lane/lane_min_bins` → bin_step band on `args.bin_step` → `amount_x > 0` refused ("only supports single-side SOL") → steady/top-performer hints (§5/§6) → `bins_below` clamped to `MAX_SAFE_BINS_BELOW=69` (1771-1774) → range floor: total bins ≥ `minBinsBelow` (lane min or `strategy.minBinsBelow`, never below 35) (1796-1812) → single-sided needs `bins_below ≥ min` and **`bins_above === 0`** (1814-1829, "Single-side SOL deploy must use bins_above=0.") → fresh `getMyPositions({force:true})`: `total_positions >= maxPositions` (1832-1838; NOTE: counts ALL positions incl. held — matches prod `maxPositionsExcludeHold=false`), duplicate pool (1840-1847), duplicate `base_mint` only if the LLM passed `base_mint` (1850-1859) → re-entry cooldown (1861-1900, §11) → scout clamp (1902-1927) → probe (1929-1965) → `amount_y > 0`, `>= minDeploy` (0.05 for scout/probe else `max(0.1, deployAmountSol)`), `<= maxDeployAmount` (1967-1984) → live SOL ≥ `amount + gasReserve` unless DRY_RUN (1987-1996).

---

## 11. Every cooldown / block that can stop a pool

| Block | Where set | Where enforced | Condition | Config |
|---|---|---|---|---|
| Token blacklist | `addToBlacklist` (token-blacklist.js:35), kv `token-blacklist` | screening.js:772 (gate), 1134 (rank), 1262 (gmgn) | `isBlacklisted(base.mint)` | — |
| Dev blocklist | `blockDev` (dev-blocklist.js:30), kv `dev-blocklist` | screening.js:777 / 822 (Jupiter dev lookup only when blocklist non-empty) / 1138 / 1458-1471 | `isDevBlocked(dev)` accepts string or `{creator_address}` | — |
| Pool cooldown `cooldown_until` (pool-memory) | `recordPoolDeploy` (pool-memory.js:123-280): (a) `close_reason === "low yield"` exactly → 4h (198-202); (b) last `oorCooldownTriggerCount` deploys ALL OOR-below → `oorCooldownHours` pool + base-mint (205-221); (c) repeat-deploy rule (223-266) with scope pool/both; (d) avg `gas_adjusted_pnl_sol` of last 3 (≥2 with data) < 0 → 6h (268-277) | `isPoolOnCooldown` 282-288 → screening 1337-1340 / 1150-1153 (reason `pool cooldown active`); also `recallForPool` text | `new Date(cooldown_until) > now` | `oorCooldownTriggerCount` 3, `oorCooldownHours` 12 |
| Base-mint cooldown `base_mint_cooldown_until` | (b) above; repeat-deploy rule with scope token/both (`repeatDeployCooldownScope` default "token") | `isBaseMintOnCooldown` 290-299 → screening 1342-1345 / 1154-1157 (`token cooldown active`) | any pool-memory entry with that `base_mint` still cooling | `repeatDeployCooldownEnabled` true, `TriggerCount` 3, `Hours` 12, `Scope` "token", `MinFeeEarnedPct` 0, `LosersOnly` false (prod uncertain; shadow logs `[POOL-MEMORY] [REPEAT_COOLDOWN_SHADOW] would-NOT-lock …`) |
| Repeat-deploy trigger semantics | pool-memory.js:63-82, 227-240 | — | legacy: last N deploys all `isFeeGeneratingDeploy` (fees>0 and `fee_earned_pct >= MinFeeEarnedPct`) — fires on WINNERS; losers-only: all `isNonSuccessDeploy` (reason contains low yield/fee-death, OOR-below, or `pnl_pct <= 0`) | evidence: locked MANLET/TOAD/BULLSHIT/MADE after winning closes 2026-08-21 (CLAUDE.md plan #12) |
| Anti-LVR cooldowns | set elsewhere (management side; reason text contains "anti-lvr"); `clearAntiLvrCooldowns` 306-330 | same pool/mint checks | — | — |
| Re-entry cooldown (state.js) | closed positions in the state cache | executor 1861-1900 via `evaluateReentryCooldown` (state.js:2411-2433): most recent close with same `pool` or same `base_mint` within `poolReentryCooldownMinutes` → blocked; enforce → SAFETY_BLOCK `Re-entry cooldown: pool|base token closed Nm ago (<Mm)…` (`[EXECUTOR] [REENTRY] blocking …`); shadow → `[EXECUTOR] [REENTRY_SHADOW] would-block …` | `poolReentryCooldownEnabled` false (prod false — reverted 2026-07-29), `poolReentryCooldownMinutes` 240 |
| Opportunity per-pool re-trigger | index.js:3312, 3344-3346 | opportunity poll only | `now − lastTriggered < retriggerCooldownMin` → skip that pool | `retriggerCooldownMin` 30 |
| Declined-set fingerprint | index.js:2120-2130 | before LLM | identical set within `retriggerCooldownMin` | same key |
| Verdict cache | index.js:2133-2159 | before LLM | all pools fresh + unmoved (§8.9, appears inert) | `verdictCacheEnabled` true, `verdictCacheTtlMin` 30 |
| Occupied pool / mint | screening 1329-1336 / 1142-1149; executor 1840-1859 | — | open position in pool, or same `base_mint` in another pool | — |
| TVL drain | tvl-guard.js | screening 1303-1311 / 1163-1172 | `current <= peak × (1 + tvlDrainThresholdPct/100)` over in-process snapshots | `tvlDrainEnabled` true, `tvlDrainThresholdPct` −30 |
| Circuit breaker | circuit-breaker.js | screening pre-guard | tripped state in `state_meta._circuitBreaker` | §1.6 |

---

## 12. LLM prompt contract (SCREENER)

System prompt `buildSystemPrompt("SCREENER", …)` (prompt.js:41-185). Contents (line refs):
- Common header (41-100): portfolio/positions/memory/performance JSON, full `config.screening/management/schedule` JSON (53-57), LESSONS block (`getLessonsForPrompt({agentType:"SCREENER"})`, lessons.js:1161-1227: pinned ≤5, role-tag matched ≤6, recent fill to 10, hive ≤4), RECENT DECISIONS, BEHAVIORAL CORE 1-5 (73-80; #4 POST-DEPLOY INTERVAL: vol ≥5 → managementIntervalMin 3, 2–5 → 5, <2 → 10), TIMEFRAME SCALING table (82-93), "fee_active_tvl_ratio values are ALREADY in percentage form … Never convert" (95 — interpretation, not enforced in code per CLAUDE.md), current timeframe (97).
- SCREENER body (103-185):
  - HARD RULE (109-111): `fees_sol < minTokenFeesSol` (30) → SKIP; `bots > maxBotHoldersPct` already hard-filtered.
  - RISK SIGNALS (113-118): `top10 > maxTop10Pct` (60) risky; PVP major negative; "no narrative + weak degen + flow not ACCELERATING → skip"; **solo-candidate wording** (117): "A SINGLE returned candidate is the NORMAL state … Smart wallets are a CONFIDENCE BOOST, never a requirement"; PROBE TIER line only when enabled (118).
  - NARRATIVE QUALITY (120-123).
  - ENTRY TVL evidence block (125-130): 280 closes 2026-07-27 — `<30k` 11.8% disasters / −0.60 avg; `30–60k` 8.9% / −0.83; `60–100k` 14.8% / −2.13 (worst −59.7); `100–200k` 0% / +1.02; `>=200k` 0% / +1.78; exemption-pool caveat.
  - FEE EFFICIENCY (132), SIM (134), edge (136), MOMENTUM (138), SIMILAR PAST (140), FLOW LINE (141; ACCELERATING ≥1.5× makes a prior low-yield close stale; FADING ≤0.5× do not deploy), POOL MEMORY (143).
  - LP PLAYBOOK (145-155): 1 consolidation/early-trend SOL-below spot ("token already up ~+50% in the last hour is a CHASE — skip"); 2 SPOT-ON-DUMP (price −10% to −35%, organic ≥80, positive net buyers); 3 ANTI-LVR (OOR-above pools on cooldown; don't chase pumps).
  - INTEL SCORE (157-161): "Candidates below `minIntelScore` are auto-rejected" (text uses the gate-mode key even in rank mode), grade bands A80/B65/C50/D35, prefer B+.
  - DEPLOY RULES (163-175): amount from goal EXACTLY; `strategy = config.strategy.strategy` ("bid_ask" default) — never change; `shape` optional spot|curve|bidask (166-168); **bins**: if `targetDownsidePct` set → omit `bins_below` (executor computes), else `playstyle = X → range [min,max]` and **`bins_below = round(min + (candidate volatility/5)*(max−min)) clamped to [min,max]. bins_above = 0.`** (171); "Maximum 70 total bins (bins_below <= 69)" (173); bin steps in `[minBinStep-maxBinStep]` (174); "Pick ONE pool only if it qualifies" (175).
  - STRUCTURED CONFIDENCE (177-182): `CONFIDENCE: NN` + `THESIS: …` lines before `deploy_position` (parsed by llm-verdicts.js; non-blocking).
  - Optional Darwin weights summary, LESSONS, timestamp.
- Goal message (index.js:2161-2245): `SCREENING CYCLE` / `DEPLOY STRATEGY: <strategy> (from config) | bins_above: 0 (FIXED — never change) | deposit: SOL only (amount_y, amount_x=0)` (+ STRATEGY CONTEXT from strategy-library) / `Positions: n/max | SOL: x | Deploy: A SOL` / optional `DEPLOY TIMING (advisory): …` (deploy-timing.js:136-149, ≥40 decisive closes) / `PRE-LOADED CANDIDATES (N pools):` blocks / STEPS 1-5 (2169-2244): solo-candidate normality (1), conviction sources narrative | degen | ACCELERATING flow, smart wallets boost only (2), PROBE TIER when enabled, deploy rules (3): strategy fixed, shape guidance, RENEWED-FLOW RE-ENTRY paragraph, `playstyle = X → range [min,max]`, same `bins_below` formula (2180), `bins_hint` rule when `lpStyleSteerEnabled`, `LANE WIDTH` rule when `steadyLanePlaystyle`, `pass deploy_position.volatility = the candidate volatility value`, `bins_above = 0. Single-side SOL only: set amount_y, keep amount_x = 0.` (2183); exact 🚀 DEPLOYED / ⛔ NO DEPLOY report templates (4-5). `agentLoop(..., maxSteps, [], "SCREENER", screeningModel, 2048, hooks)`.
- Tool schema `deploy_position` (tools/definitions.js:129-215): params `pool_address` (required), `amount_y`/`amount_sol`, `amount_x` (unsupported), `strategy` enum bid_ask|spot|dynamic, `shape` enum spot|curve|bidask, `bins_below` (≤69), `bins_above` (keep 0), `downside_pct`/`upside_pct`, `pool_name`, `base_mint`, `bin_step`, `base_fee`, `volatility`, `fee_tvl_ratio`, `organic_score`, `initial_value_usd`, `lazy`, `tier` enum full|probe.
- Deterministic mirror: `computeBinsBelow(vol)` (index.js:3990-3997) = same formula, throws on non-finite/≤0 volatility; used by `/deploy` of a cached `/screen` candidate (5333). `representativeDownsidePct` (pool-simulator.js:275-285) uses the same bins formula for the `sim:` line.
- Playstyle presets (config.js:53-62): tight {35,45}, balanced {35,69}, wide {60,69}, single_account {45,69}; `MIN_SAFE_BINS_BELOW=35`, `MAX_SAFE_BINS_BELOW=69` (40-41) clamp `minBinsBelow/maxBinsBelow/defaultBinsBelow` at load (68-78) and on `update_config` (1115-1123). **CLAUDE.md's "maxBinsBelow 120 → 90 in prod" predates the 69 cap; effective prod max is 69.**

---

## 13. Signal engines (formulas)

### 13.1 Intel score (intel-score.js) — `computeIntelScore` 577-617
`total = 0.30·Safety + 0.35·Yield + 0.20·Momentum + 0.15·Trust` (weights `intelWeights`, normalised, 75-91); grade A≥80 B≥65 C≥50 D≥35 (26-31).
- Safety (121-200): mint_disabled 25|0|12.5 unknown; freeze_disabled 15|0|7.5; top10 `lerp(60→20 ⇒ 0→20)` else 10; bundler `lerp(50→0 ⇒ 0→15)` else 7.5; bot `lerp(50→0 ⇒ 0→10)` else 5; dev-hold `lerp(5→1 ⇒ 0→15)` else 7.5; × `(1 − CRI/100·0.5)` when `c.cri` present. Inputs `audit.mint_disabled/freeze_disabled`, `gmgn_top10_holder_pct ?? audit.top_holders_pct`, `gmgn_bundler_pct`, `gmgn_bot_degen_pct ?? audit.bot_holders_pct`, `gmgn_dev_team_hold_pct` — none exist on the Meteora condensed payload → **Safety pinned at 50** unless `safetyEnrichMode="enforce"`.
- Yield (249-327): legacy fee term `clamp(fee_active_tvl_ratio/2.0)·40` (window-agnostic → at 1h a 2.5%/day pool scores ~2/40, comment 216-227); log mode `logScale(max(fee×1440/tf, fee_24h), 1%/day, 48%/day)·40`; volume/TVL legacy `clamp((volume_window/tvl)/5)·25`, log `logScale(turnover×1440/tf, 0.2, 120)·25`; active_tvl/tvl `clamp(x/0.5)·15`; fee_trend `clamp((fee_change_pct+50)/100)·20`; dynamic-fee bonus ≤5. Backtest (CLAUDE.md, `scripts/yield_window_backtest.js`, 300 records): log is a pure monotone re-scaling (Spearman 1.00), gate moves 52→61.
- Momentum (361-434): price_trend bell curve (−50→0, 0→12, +20→25, +100→15, >100 decays to 5); traders/velocity `(clamp(unique_traders/150)·0.5 + clamp(tx_per_min/15)·0.5)·25`; buy/sell from `stats_1h` (not on candidate → 12.5); `indicator_confirmation` (set only by the indicator stage AFTER scoring in gate mode → 12.5).
- Trust (470-548): organic `organic/100·25`; smart-wallet presence `clamp(gmgn_smart_wallets/3)·20` ±35% flow (absent → 10); KOL `clamp(gmgn_kol_wallets/2)·10 + 5` (absent → 7.5); maturity `ageMaturScore(h)·10/15` (0h→0, 2h→2, 12h→5.3, 48h+→10; absent 5); dev reputation `devScore/100·20` (neutral 50 → 10); narrative fixed 5. Max attainable ≈95.
- All-unknown score = 50 in every dimension.
- Gate config: `minIntelScore` 45 code (prod 61; `EVOLVE_BASELINES` pins 52 and `EVOLVE_BOUNDS` 52–70), `rankMinIntelScore` 52 (prod 61), `intelWeights` 0.30/0.35/0.20/0.15.
- Format: `[INTEL: 72/100 B | Safety:85 Yield:68 Momentum:55 Trust:78]` (629-633), used in `Intel score too low:` log.

### 13.2 Safety enrichment (tools/screening.js:109-212)
Per mint (30-min cache): `getTokenAudit(mint)` (tools/token.js:118-147, keyless Jupiter `assets/search`; `bundlerStats.holdingPct` already 0–100) ∥ `getGmgnSafetyInfo(mint)` (tools/gmgn.js:837-855, keyed `GET https://openapi.gmgn.ai/v1/token/info?chain=sol&address=<mint>` via 5-min shared cache 798-813: `stat.top_10_holder_rate/top_bundler_trader_percentage/bot_degen_rate/dev_team_hold_rate` → %); `mapSafetyInputs` prefers GMGN for rates, Jupiter for mint/freeze (121-137); `applySafetyInputs` writes the exact scoreSafety field names (143-155). Modes: `log_only` computes on a clone and attaches `_intelSafetyBase/Enriched`, `_intelTotalBase/Enriched`, `_safetyEnrichInputs`; `enforce` mutates. Log `[SCREENING] [SAFETY_ENRICH] <label>: safety A→B intel C→D (mode)`. Config `safetyEnrichMode` "off" (prod uncertain), `safetyEnrichMaxPerCycle` 6. Evidence (config.js:350-360, `scripts/safety_rebaseline.js`, 147 records): renouncement near-universal → +6..+11 constant shift, zero outcome signal; enforce must pair with intel bar 52→58–62 (≈69 under log-yield per CLAUDE.md).

### 13.3 Organic momentum (organic-momentum.js) — `computeOrganicMomentum` 66-107
Inputs `unique_traders_change_pct` (T), `volume_change_pct` (V), `base_token_holders_change_pct` (H), `swap_count_change_pct`, `net_deposits_change_pct`, `unique_traders` (N). `unknown` if T and V both null. `thin = N < minUniqueTraders`; `decaying = T <= decayTraderPct || V <= decayVolumePct`; `growing = T >= growTraderPct && V >= 0`; class decaying > growing > steady; score = bucket(T,−22,+38) + bucket(V,−42,+50) + bucket(H,−10,+20) ∈ [−3,3]. Config `organicMomentumEnabled` true, `DecayTraderPct` −22 (p25), `DecayVolumePct` −42 (p25), `GrowTraderPct` 38 (p75), `MinUniqueTraders` 30, `HardFilter` false. Deploy-capture cache `getOrganicMomentumForPool` (129-132). Validation `analyzeOrganicMomentumOutcomes` (165-206) also drives evolution P2 (lessons.js:722-739: on "signal works" widen decay-trader cutoff toward −15 and enable the hard filter at ≥12 records). Grounding: MELT arXiv 2602.13480 (comment 21-24).

### 13.4 Fee efficiency (fee-efficiency.js) — `computeFeeEfficiency` 66-77, `rankByFeeEfficiency` 90-122
`ratio = fee_active_tvl_ratio / volatility`; rank + percentile (best 100) within the set; deploy-capture cache `getFeeEfficiencyForPool` (46-49); validation `analyzeFeeEfficiencyOutcomes` (162-199, tiers ≥67/≥33, Pearson ±0.3 verdict). No config.

### 13.5 Pool simulator `sim:` line (pool-simulator.js)
`representativeDownsidePct` (275-285): `bins = clamp(round(lo + vol/5·(hi−lo)))`, `down% = (1 − (1+bin_step/1e4)^−bins)·100`. `simulatePool` (81-215): `dilution = active_tvl/(active_tvl+deposit)`; `apr_in_range = fee_active_tvl_ratio × (525600/windowMin) × dilution`; `horizonVol = scaleVolToHorizon(vol, window, 1440)`; `irf = inRangeProbability(down, up, horizonVol)` (range-survival.js); `apr_effective = apr_in_range × irf`; IL from `simulatePnlCurve` (pnl-curve.js) at `−min(horizonVol, down)` vs quote-hold, else classic `2√k/(1+k)−1`; `risk_adjusted = apr_effective / (vol·√annualFactor)`; `volPremiumCheck` (241-266): `vol_premium_apr = |il| × 525600/horizon`, `edge = apr_effective / vol_premium`, verdict ≥1.5 fees_cover_premium / ≥0.8 marginal / else premium_exceeds_fees. Deposit for the line = `deployAmount × sol_price` (index.js:1932-1936). Also exposed as the `simulate_pool` tool (tools/executor.js:357).

### 13.6 Episodic memory `similar_past:` (lessons.js:1259-1434)
Features/weights: entry_mcap (log, 1.0), entry_tvl (log, 1.0), volatility (1.0), fee_tvl_ratio (1.0), organic_score (0.8), token_age_hours (log, 0.6); scales 16/12/5/0.5/100/6; distance = √(Σw·((c−p)/scale)²/Σw) over dims present on both sides (≥2 dims); recency penalty `ln(1+ageDays)·0.015`; needs ≥2 scored records; K=3; outcome via `classifyOutcome`. Candidate features taken from `mcap`, `active_tvl ?? tvl`, `volatility`, `fee_active_tvl_ratio`, `organic_score`, `token_age_hours`.

### 13.7 LPAgent winning-LPer signal (lper-signal.js, tools/study.js) — §8.6/§8.7. Config `lpStudyEnabled` true, `lpStudyMaxPools` 4, `lpStudyMinWinnersForStyle` 3, `lpStyleSteerEnabled` false.

### 13.8 Deploy timing (deploy-timing.js)
`analyzeDeployTiming` (63-129): last `window` (120) perf records, deploy time = `recorded_at − minutes_held`, 4h UTC buckets, `classifyOutcome`, Wilson lower bound, `lowConfidence = decisive < minBucketN`. Advisory line only when `totalDecisive >= 40` (137-149; verdict ±0.07 vs baseline). Gate: §1.10. Briefing/`/timing` formatters 152-207.

### 13.9 Dev score (dev-scoring.js:73-149)
launch_history 25 / ath_record 30 / alignment 20 / cto 10 / freshness 15 from GMGN `dev` object; string or missing dev → neutral 50 (165-199). `minDevScore` 50 (gate mode only) → passes at neutral. Feeds intel Trust and the dump-play guard (`< 70`).

### 13.10 PVP (pvp.js) — `detectPvpRival` 49-81
`GET https://datapi.jup.ag/v1/assets/search?query=<SYMBOL>` → other mints with the exact symbol, top 2 by liquidity, need `holderCount >= 500` and `fees >= 30` SOL; rival pool via `GET https://dlmm.datapi.meteora.ag/pools?query=<mint>&sort_by=tvl:desc&filter_by=tvl>5000`. Only the top-2 intel candidates are checked (`PVP_SHORTLIST_LIMIT`, 36, 605-630). Log `[SCREENING] PVP guard: <name> has active rival …`. Config `avoidPvpSymbols` true, `blockPvpSymbols` false.

### 13.11 Chart indicators (tools/chart-indicators.js:214-270) — gate mode only, `config.indicators.enabled` false → inert. `GET ${config.api.url}/chart-indicators/<mint>?interval=&candles=&rsiLength=`.

---

## 14. Learning loop touching screening (lessons.js)

- `classifyOutcome` (939-960): failure if stop-loss reason, `pnl <= −5`, fee-death with feeYield <1, OOR-collapse with pnl<0, or `range_efficiency<30 && pnl<0`; success if not fee-death and (`pnl >= 2` or feeYield ≥2); else neutral.
- `evolveThresholds` (658-753): every 5th close via `recordPerformance` (skipped when `evolutionEnabled=false`: `[EVOLVE] skipped — evolutionEnabled=false …`, 229-230; **prod false** since 2026-09-24). Window last 40; auto-revert if success-rate fell ≥0.08 after the last adjust; floors `minFeeActiveTvlRatio` (perf `fee_tvl_ratio`), `minOrganic` (`organic_score`), `minIntelScore` (`signal_snapshot.intel_total`) raised only when successes > failures with Cohen's d ≥0.35 and ≥3 per group, target `max(p50 failures, 0.95·p25 successes)`, ≤20% step, bounds; P2 organic-momentum; P4 throughput relaxer (<1.5 closes/day) → `computeStarvationStep`. Persist via `persistEvolution`.
- Note the evolved keys are the GATE-mode keys; prod rank mode reads `rankMinIntelScore`, not `minIntelScore`.
- `getLessonsForPrompt` (1161-1227) and `ROLE_TAGS` (1144).

---

## 15. External API index (strings from code)

| API | URL | Used by | Notes |
|---|---|---|---|
| Meteora pool discovery | `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=&filter_by=&timeframe=&category=[&after_key=]` | screening.js:477, 493, 866-922, 1004-1060, 1086; gmgn.js:376 | windowed fields; categories `trending`/`top`; `after_key` paging; local `scripts/screening_funnel_audit.js` replays the gate chain |
| Meteora DLMM API | `https://dlmm.datapi.meteora.ag/pools?query=<mint>&sort_by=tvl:desc&filter_by=tvl>5000` | pvp.js:34; gmgn.js:10 | rival pool lookup |
| Jupiter datapi | `https://datapi.jup.ag/v1/assets/search?query=` (token.js:37,121,157; pvp.js:27; screening.js:812), `/chaininsight/narrative/<mint>` (token.js:22), `/holders/<mint>?limit=100` and `?addresses=` (token.js:156,198), `/pnl-positions?address=&assetId=` (token.js:214) | recon, audit, PVP, holders tool | keyless |
| GMGN | `https://openapi.gmgn.ai/v1/token/info?chain=sol&address=` (gmgn.js:809), `/v1/market/token_top_holders`, `/v1/market/token_top_traders` (gmgn.js:893-897) | dev score, safety enrich, fees refinement, smart exodus | requires `GMGN_API_KEY`; per-IP bans (memory note) |
| GeckoTerminal | `https://api.geckoterminal.com/api/v2/networks/solana/pools/<pool>/ohlcv/<minute|hour>?aggregate=&limit=` | rebalance-trend.js:19 | Top-Performer trend confirmation |
| agentmeridian (LPAgent relay, indicators, discord) | `${config.api.url}` default `https://api.agentmeridian.xyz/api`: `/top-lp/<pool>`, `/study-top-lp/<pool>` (study.js:10-11), `/chart-indicators/<mint>` (chart-indicators.js:231), `/signals/discord/candidates` (screening.js:469) | LPAgent line, indicators, discord | `x-api-key` = `PUBLIC_API_KEY` |
| Helius / RPC | via `tools/dlmm.js` `getMyPositions`, `getActiveBin`, `getWalletPositions` | occupied-pool checks, `active_bin:` line, smart-wallet presence | not documented here |

---

## 16. Log tag index (screening domain)

`[SCREENING] discovery: …` (794), `[SCREENING] funnel: …` (1544), `[SCREENING] funnel[rank]: …` (1861), `[TVL_EXEMPT]` (409, 1749; executor 167), `[SCOUT_SHADOW]` (1767), `[SCOUT]` (1774; executor 180, 1921), `[TOP_PERFORMERS]` (1114), `[TOP_PERFORMER_ADMIT]`/`[TOP_PERFORMER_COOLING]` (1716/1719), `[TOP_PERFORMER]` (1737; executor 162, 1769), `[STEADY_ENVELOPE_SHADOW]`/`[STEADY_ENVELOPE]` (1045/1072), `[LANE]` (1807; executor 218, 253, 1761), `[YIELD_WINDOW_SHADOW]` (1854), `[RANK_SHADOW]` (1922), `[SAFETY_ENRICH]` (203/206), `PVP guard:` (628), `Intel score too low:` (1436), `Filtered candidate … dump play guard` (1400/1406), `TVL drain detected:` (1308), `Exit signals for` (1316), `Filtered cooldown pool|token` (1338/1343), `Indicator rejected` (1505), `Organic-momentum hard filter removed` (1532), `PVP hard filter removed` (1453), `[BLACKLIST]`/`[DEV_BLOCKLIST]` categories (772-782, 1262-1267, 1463-1470), `[CRON] [Opportunity]` (index 3363), `[CRON] Screening skipped — …` (1573-1660), `[CRON] Deploy-timing gate …` (1706-1713), `[SCREENING] Bot-holder filter:` (1792), `[SCREENING] [RUG_FILTER]` (1799), `[SCREENING] [CRI_SHADOW]` (1807), `Gas filter:` (1824/1832), `[CRON] Screening: identical candidate set declined` (2126), `[CRON] [VERDICT_CACHE]` (2153/2157), `[CRON] Screening produced no candidates (N …)` / `⚠️ N consecutive empty screening cycles` (2450-2452), `[EVOLVE] Starvation relaxer …` (2472-2475), `[POOL-MEMORY] Cooldown set for …` / `Base mint cooldown set …` / `[REPEAT_COOLDOWN_SHADOW]` / `Extended cooldown …` (pool-memory 201-274), `[EXECUTOR] [REENTRY]`/`[REENTRY_SHADOW]` (1889/1895), `[EXECUTOR] [PROBE]` (1952), `[LPAGENT]`-style `LPAgent study skipped for` (lper-signal 29).

---

## 17. Correlations, contradictions, dead/inert under prod config

**Double-counting the same signal**
1. `fee_active_tvl_ratio` enters admission four times in rank mode: RANK_ENVELOPE fetch floor (0.30/1h), intel Yield term (up to 40 pts × 0.35), `fee_tvl` percentile modifier (±6), fee-efficiency percentile modifier (±5, ratio = fee_tvl/volatility) — plus the `fee_efficiency=` and `sim:` (apr) candidate lines and the executor `minFeeActiveTvlRatio` re-check. CLAUDE.md itself notes fee/TVL is fees÷TVL, so thinness inflates it.
2. Organic momentum is applied twice in rank mode (`prescoreRankCandidates` and the post-enrichment `computeAdmissionScore`) — idempotent, but the `annotateOrganicMomentum` cache is overwritten on every pass; the momentum modifier (−10 for decaying) is also the only place organic momentum affects admission, while the prompt tells the LLM to weigh DECAYING "heavily".
3. Launchpad block-list is enforced three times (client recheck / rank safety gates; post-recon on `ti.launchpad`; plus server `base_token_launchpad` for the allow-list in gate mode only). Bot-holder % is filtered in code (index.js:1789-1794) AND restated as "already hard-filtered" in the prompt AND re-checked in `getLoneCandidateSkipReason` (3973-3975).
4. `minTvl` is checked at the server query (gate), client recheck (gate), Stage-B (gate), rank admission, and the executor — with the clean-history exemption implemented independently at three sites (screening.js:400-413, 1741-1750, executor 156-169).
5. Top-Performer trend confirmation reuses `isRebalanceTrendIncreasing` (a rebalance-engine helper); `topPerformerTrendTimeframe/Candles` and `rebalanceTrendTimeframe/Candles` share defaults 5m/6.
6. The `sim:` line's `representativeDownsidePct`, `computeBinsBelow`, `computeSteadyLaneHint`, and the two prompt renderings (prompt.js:171, index.js:2180) all carry the same `min + vol/5·(max−min)` formula — five copies to keep in sync.

**Contradictions**
7. Dump-play guard vs the prompt's SPOT-ON-DUMP playbook: the prompt tells the LLM to buy −10…−35% dips (prompt.js:150-151), but with no GMGN key `_devScore=50` so every candidate with `price_change_pct <= −20` is rejected before the LLM (rank 1645-1649 / gate 1403-1408) unless it is a Top Performer.
8. Prompt says "Candidates below `minIntelScore` are auto-rejected" (prompt.js:160) — in prod rank mode the bar is `rankMinIntelScore` (both 61 in prod, so numerically consistent today; the config JSON dump in the prompt shows both).
9. `minIntelScore` code default 45 vs `EVOLVE_BASELINES.minIntelScore=52`/bounds 52–70: the relaxer treats 45 as "below baseline" (ratio <1.01 → never selected) and evolution can only raise it to ≥52.
10. CLAUDE.md config table (`minTvl` 100k/`maxTvl` 400k, `deployAmountSol` 0.5, `gasReserve` 0.2, `positionSizePct` 0.5, `maxBinsBelow` 90) vs config.js defaults (10k/150k, 0.4, 0.05, 0.35, hard cap 69): prod values live only in the VM's `user-config.json`; the 69-bin cap makes any `maxBinsBelow > 69` unreachable.
11. `maxTvl` is not applied anywhere in rank mode screening; it is applied at the executor (tools/executor.js:189-194) → a >maxTvl pool can be admitted, judged by the LLM, then SAFETY_BLOCKed (same shape as the 2026-07-27 sub-floor incident the rank-mode `minTvl` check was added for).
12. `organicMomentumHardFilter`, `minDevScore`, chart indicators, and the GMGN `checkExitSignals` guard exist only in the gate branch; in prod rank mode they cannot fire even if enabled.
13. Steady-envelope re-fetches extras at `s.timeframe` for consistency, but Top-Performer extras are merged with their 24h-window values un-refetched (1095-1122), so their `volume`/`fee_active_tvl_ratio` (and hence intel Yield and fee percentiles) are not comparable with the rest of the set.
14. The verdict cache / `[VERDICT_CACHE]` description in CLAUDE.md ("skips when every candidate carries a fresh verdict") does not match the field names the check reads on condensed candidates (§8.9) — the fingerprint suppressor is what actually throttles re-asks.

**Dead or inert under current prod config (by code reading; confirm on VM logs)**
15. Gas break-even filter (`maxGasBreakEvenMinutes` 30) — feeTvl source fields absent on candidates → always passes (§8.4).
16. `flow:` candidate line — same missing fields → never rendered, so the RENEWED-FLOW RE-ENTRY and "ACCELERATING flow clears the solo bar" instructions (prompt.js:117,141; index.js:2171,2176) have no input; the verdict-cache `feeFlowRecovered` clause is likewise unreachable.
17. Per-pool verdict cache skip (§8.9).
18. Intel Safety dimension (pinned 50 while `safetyEnrichMode != "enforce"`), Trust smart-wallet/KOL sub-scores, Momentum buy/sell + indicator sub-scores — all neutral on the Meteora payload; intel_total variance comes only from Yield, price_trend, traders/tx, organic, age, dev (neutral without GMGN).
19. `minDevScore` gate (neutral 50 passes), `checkExitSignals`, chart indicators, discord signals, `minTokenAgeHours/maxTokenAgeHours` (null), `minLps` (0), `allowedLaunchpads` ([]), `blockedLaunchpads` ([]), `timing.gateEnabled` (off), `lpStyleSteerEnabled` (off), `rugFilterMode` (off), `criFilterMode` (log_only), `poolReentryCooldownEnabled` (false → shadow), `bearDebateEnabled` (prod false), `evolutionEnabled` (prod false), `screeningAdmissionMode="gate"` machinery incl. `RANK_SHADOW` (prod runs rank).
20. `deploy-timing` advisory/gate needs ≥40 decisive closes and `n >= 8` per 4h block — advisory may render, gate is off.
21. The starvation relaxer's three keys are gate-mode floors; in prod rank mode a relaxation changes nothing about admission (only the executor's `minFeeActiveTvlRatio` check).
