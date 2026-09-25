# Meridian — Position Management & Exit Stack Inventory

Read-only inventory of every rule that can close, hold, claim, flip, rebalance or defer an open position.
Source tree: `/Users/Angga/Repos/meridian` @ `a0fcd12` (branch `experimental`), read 2026-09-25.
Line numbers cite that checkout. "Prod" values come from CLAUDE.md / `docs/plans/15-*.md`; where neither
states a prod value it is marked **prod: unknown**. The local `user-config.json` is a dev copy that
**diverges** from documented prod (e.g. it has `stopLossPct=-18`, `profitRatchetArmPct=6`,
`maxPositionsExcludeHold=true`, `autoSkim.enabled=true`) — it is NOT used as evidence here.

---

## 0. Evaluators, cadence, and shared plumbing

| Evaluator | Where | Cadence | Confirm requirement | Notes |
|---|---|---|---|---|
| **PnL poller** | `index.js:2887–3215` (`setInterval` in `startCronJobs`) | `config.pnl.pollIntervalSec` default **3 s** (`config.js:890`); CLAUDE.md variously says "~5s" and (state.js:2295 comment) "~45s effective" — effective rate is RPC-latency bound, **unverified** | `config.pnl.confirmTicks` default **2** (`config.js:920`) consecutive identical signals via `registerExitSignal`; crash/rug use `crashConfirmTicks` (3); trailing overshoot ≥ `trailingOvershootPct` → 1 | Skips entirely while `_managementBusy/_screeningBusy/_pnlPollBusy/_pnlDiscoveryBusy` (2913); **one action per tick** (`break`, 3214) |
| **Management cycle** | `runManagementCycle` `index.js:919–1568`, cron `*/managementIntervalMin` (2559) | code default 10 min (`config.js`), **prod 3 min** (index.js:3376 comment) | none — `confirmPeak(…,1)` (1046) and acts directly; exit signals cleared with `registerExitSignal(null,1)` for held/unready rows | Also: snapshots, health alerts, PVP, report publish, balance-history piggyback (1457), post-close probes + dust sweep (1487), post-mgmt screening trigger (1490–1498) |
| **Reconciliation cron** | `runReconciliation` `index.js:3381–3397` → `reconcileStateWithChain` `state.js:3389–3525` | `7,22,37,52 * * * *` (offset chosen to dodge the 3-min grid) | n/a | phantom-close / orphan-adopt / PnL-drift alert |
| **Discovery + adoption burst** | `index.js:2617–2746`, `runPnlDiscovery` (~2773–2885) | discovery 30 s (5 min when wallet WS healthy); burst every 5 s for 120 s per candidate, 10 s dwell | liveness recheck before adopt | poller auto-adoption of manual deploys |

**Shared primitives (state.js):**
- `confirmPeak(pos, candidate, confirmTicks)` `state.js:1727–1777` — raises `peak_pnl_pct` only after N consecutive ticks ≥ pending candidate (pending fields `pending_peak_*`). Mgmt cycle uses 1 tick, poller uses `confirmTicks`.
- `registerExitSignal(pos, signal, confirmTicks, metadata)` `state.js:1779–1829` — streak counter on `pending_exit_action/_count/_started_at/_context`; **any change of signal string resets the streak**; `fire` when count ≥ confirmTicks; first-tick metadata retained for `[EXIT_TELEMETRY]`.
- `pushPnlTick` `state.js:1925–1933` — `pos.pnl_tick_history` ring, cap `MAX_PNL_TICK_HISTORY` (20 per CLAUDE.md), fed **unconditionally** by every non-suspicious tick (2687–2695) so TWAP/harvest have a warm window. **Not fed while `hold_mode` or `pnl_management_ready=false`** (early returns at 2529/2530 precede bookkeeping).
- `gateExit(exit)` closure `state.js:2744–2787` — the TWAP wick guard wrapper (§1.T). Every state.js exit except crash/rug (which never construct an exit object there) passes through it.
- Valuation gates (`tools/pnl.js:900–999`, `tools/dlmm.js:2480–2607`): `pnl_quality` ∈ {valid, missing_asset_metadata, missing_pnl_data, extreme_divergence}; `pnl_pct_suspicious` = no PnL at all OR adopted-with-missing-mints OR |reported−derived| > `pnlExtremeDivergencePct` (50, floor 10); `effective_pnl_pct` = `ourPct` (derived) (`tools/pnl.js:789`); `pnl_management_ready` = quality valid AND `management_armed` — adopted rows need `postAdoptionValidTicks` (2) consecutive valid ticks (`recordPositionValuationState` `state.js:1320–1387`, `valuation_valid_ticks`), bot rows are armed at track time (`state.js:636–638`). Informational-only: `pnlSanityMaxDiffPct` (5).

---

## 1. `state.js updatePnlAndCheckExits` — exact evaluation order (`state.js:2523–3141`)

Entry gates (return `null`, **before any bookkeeping**): position missing/closed (2528); `hold_mode === true` (2529); `pnl_management_ready === false` (2530). `rangeHarvest` = `management_profile === "range_harvest"` (2533; pool allow-list `rangeHarvestPools`, default `[]`, prod unknown) suppresses TAKE_PROFIT / TRAILING_TP / PROFIT_RATCHET (`isRangeHarvestProfitExitSuppressed` 46–48).

### Bookkeeping block (2536–2735, runs first, may `save`)
1. Bin-range sync + **external rebalance detection** (2541–2582): if tracked min/max differ from on-chain → `rebalance_count++`, `peak_pnl_pct := current`, ratchet disarmed, `trailing_active` cleared if peak < trigger, event `rebalance_external`.
2. **External capital change** (2585–2648): only when `pnl_quality==="valid"` and `net_deposit_sol` differs ≥0.02 SOL AND ≥5% → rebases `amount_sol`, `root_initial_*`; on top-up resets peak/ratchet/trailing.
3. **Trailing activation** (2654–2669) — adaptive trailing removed 2026-09-25 (audit 01 §3); only the static params remain: `trailingParams` = static `{trailingTriggerPct??3, trailingDropPct??1.5}` unless `adaptiveTrailingMode==="enforce"` → `resolveDynamicTrailingParams` (2443–2453: trigger `clamp(1.5·vol, 8, 25)`, drop `clamp(0.2·trigger, 1.5, 3)`). `trailing_active := true` when `mgmtConfig.trailingTakeProfit` (default true) and confirmed peak ≥ trigger. Shadow line `[ADAPTIVE_TRAILING_SHADOW]` when the adaptive trigger would still be waiting.
4. OOR clock (2672–2680): `out_of_range_since` set/cleared from `in_range` (also maintained independently by `markOutOfRange` in `tools/pnl.js:911`, so the clock keeps running under hold).
5. MFE/MAE + `pushPnlTick` (2687–2695); `max_bins_below/above` (2696–2703); `peak_dynamic_fee_pct` / `peak_fee_per_tvl_24h` (2705–2714); `initial_base_ratio_pct` captured once at age ≤1 min (2717–2733).
6. `pos.lazy === true` → return null (2737) — lazy LP bypasses every exit.

### Exit rules, in order (first `gateExit`-approved hit returns)

| # | Rule / `action` | Family keyword → `reasonFamily` (lessons.js:483–495) | file:line | Condition | Config (code default → prod) | Confirm / urgency / guards | Shadow state + tag |
|---|---|---|---|---|---|---|---|
| 1 | **TOXIC_CONVERSION** (`rule:"toxic_conversion"`) | reason "Toxic conversion: … with low fee yield (…)" contains **"yield" → `low_yield`** (and `classifyOutcome` treats it as fee-death) | 2789–2803; pure fn `evaluateToxicConversion` 2113–2165 | `baseLiq/totalLiq ≥ thresholdPct` AND `age ≤ maxAgeMinutes` AND `fee_yield_pct < maxFeeYieldPct`; skipped if `initial_base_ratio_pct ≥ 70`; needs `liq_x_usd/liq_y_usd` | `toxicConversionEnabled` **true** (config.js:736 — ON by default, not in CLAUDE.md); `toxicConversionThresholdPct` 85; `toxicConversionMaxAgeMinutes` 20; `toxicConversionMaxFeeYieldPct` 1.5. Prod: unknown (defaults → ON) | poller 2 ticks; mgmt immediate; TWAP-gated; **URGENT** (in `URGENT_EXIT_ACTIONS`, index.js:718); close-eff n/a | No shadow log when disabled (silently skipped) |
| 2 | **PROFIT_RATCHET** — removed 2026-09-25 (audit 01 §3: inert at trailing 2/1.5) (`rule:"profit_ratchet"`) | "Profit ratchet: peaked … (stop tightened from …)" → **no keyword → `other`** | 2805–2856; `evaluateProfitRatchet` 2040–2053 | armed := sticky `ratchet_armed` OR confirmed `peak_pnl_pct ≥ armPct`; fires when armed AND `pnl_pct ≤ stopPct` | `profitRatchetEnabled` code **true** (config.js:492; CLAUDE.md says code default false — stale); `profitRatchetArmPct` code **6** / `profitRatchetStopPct` code **+1.5** (config.js:493–494) vs **prod arm 2 / stop −2** (plan-15 §3.2 restore) | poller 2 ticks; TWAP-gated; **URGENT**; excluded for `rangeHarvest` | OFF → `[RATCHET_SHADOW] armed` once + `would-close` 1/10 min |
| 3 | **YOUNG_STOP** (`rule:"young_stop"`) | "Young-token stop: PnL …" → **no "stop loss" → `other`** | 2858–2914; `evaluateYoungStop` 2082–2096 | `token_age_hours_at_deploy < youngStopMaxAgeHours` (null age → not young) AND `!ratchet_armed` AND `pnl ≤ youngStopPct`; own 15 s timer `young_stop_violated_since` | `youngStopEnabled` **false**; `youngStopPct` −10; `youngStopMaxAgeHours` 12. Prod OFF | 15 s timer + poller 2 ticks; TWAP-gated; **URGENT** | `[YOUNG_SL_SHADOW] would-close` 1/hr |
| 4 | **STOP_LOSS** | "Stop loss: Effective PnL …" → `stop_loss` | 2916–2937 | `effective_pnl_pct ≤ stopLossPct`; 15 s `stop_loss_violated_since` timer before the exit object is built | `stopLossPct` code **−18** (config.js:463) → **prod −15** | 15 s timer + 2 ticks; TWAP-gated; **URGENT** | always on. **In practice superseded by RULE_1** — see §4 |
| 5 | **TRAILING_TP** | "Trailing TP: peak …" → `trailing_tp` | 2939–2984; `evaluateTrailingTakeProfit` 2465–2513 | requires `trailing_active`; threshold = `peak − dropPct` (optionally `max(·, trailingMinPnlPct)`); fires when `current ≤ threshold`; `needs_confirmation` unless overshoot ≥ `trailingOvershootPct` (0.5 pp) → `bypass_confirmation` (poller confirm 1). Inventory-exhaustion tightening (base fraction ≤20% & pnl>0 → drop `min(drop,1.0)`, floor 1.5%) only when `inventoryExhaustionMode==="enforce"` | `trailingTakeProfit` true; `trailingTriggerPct` 3 → **prod 2**; `trailingDropPct` 1.5 → **prod 1.5**; `trailingMinPnlPct` null; `trailingOvershootPct` 0.5; `adaptiveTrailingMode` / `inventoryExhaustionMode` **"shadow"** (prod shadow) | 2 ticks (or 1 on overshoot); TWAP-gated; **close-efficiency gate applies (only rule that is)**; NOT urgent | `[ADAPTIVE_TRAILING_SHADOW]`, `[INVENTORY_EXHAUSTION_SHADOW] would-close` |
| 6 | **LINEAGE_TAKE_PROFIT** — removed 2026-09-25 (audit 01 §3, with the rebalance engine) (`rule:"lineage_take_profit"`) | "Lineage take-profit: …" → **hyphen ≠ "take profit" → `other`** | 2986–3008 | `rebalance_count ≥ 1` AND `root_initial_sol > 0`; `(value + cumulative_fees_claimed_sol + claimable − root)/root ≥ rebalanceLineageTakeProfitPct` | `rebalanceLineageTakeProfitPct` 4.0 | 2 ticks; TWAP-gated; not urgent; suppressed for rangeHarvest | always on (only reachable on legacy chains while rebalance is shadow) |
| 7 | **ROUND_TRIP_HARVEST** (`rule:"round_trip"`, `needs_confirmation:true`) | "Round-trip complete: N bins above range …" → **"above" → `oor_above`** | 3010–3039; `evaluateRoundTripHarvest` 2327–2366 | `active − upper ≥ roundTripMinBinsAbove` AND `pnl ≥ roundTripMinPnlPct` AND last `roundTripFrozenTicks` entries of `pnl_tick_history` all within ±`roundTripFrozenEpsilonPct` of current | `roundTripHarvestEnabled` code **false** → **prod true** (since 2026-08-21); MinPnl 1.0; FrozenTicks 6; Epsilon 0.05; MinBinsAbove 5 | 2 ticks; TWAP-gated; not urgent; **mgmt/poller then run the roll-up branch (§2.B / §3)** | OFF → `[ROUNDTRIP_SHADOW] would-harvest` 1/10 min |
| 8 | **SURGE_DECAY** (`rule:"surge_decay"`) | type `dynamic_fee`: "Dynamic fee collapsed …" → `other`; type `fee_tvl`: "Fee/TVL yield collapsed …" → **`low_yield`** (fee-death in `classifyOutcome`) | 3041–3064; `evaluateSurgeDecay` 2182–2227 | age ≥ minAge AND pnl ≥ 0 AND (`peak_dynamic_fee_pct ≥ 0.5` and drop ≥ threshold%) OR (`peak_fee_per_tvl_24h ≥ 5.0` and drop ≥ threshold%) | `surgeDecayExitEnabled` **false**; `surgeDecayThresholdPct` 50; `surgeDecayMinAgeMinutes` 15. Prod unknown (local dev copy has true) | 2 ticks; TWAP-gated; not urgent | `[SURGE_SHADOW] would-rotate` 1/10 min |
| 9 | **OUT_OF_RANGE (below)** | "Out of range below for Nm (limit: Nm)" → `oor_below` | 3066–3092 | `out_of_range_since` set AND `active < lower` AND `outOfRangeWaitMinutesBelow != null && > 0` AND `floor(minutesOOR) ≥ limit`. **Above is deliberately NOT handled here** (3089–3091) | `outOfRangeWaitMinutesBelow` code default 180 (absent key inherits `outOfRangeWaitMinutes`; explicit null = disabled) → **prod 60** | 2 ticks; TWAP-gated; not urgent; flip/rebalance branches consulted after confirm (§3) | always on (null disables) |
| 10 | **LOW_YIELD** | "Low yield: fee/TVL … < min …" → `low_yield` | 3094–3138 | `fee_per_tvl_24h < minFeePerTvl24h` AND (`age_minutes == null` OR ≥ `minAgeBeforeYieldCheck`); **Guard A** adoption grace: `adopted && now − adopted_at < adoptGraceMinutes`; **Guard B** history floor: `fresh_snapshots < poolHealthMinSnapshots` → suppressed with a log line | `minFeePerTvl24h` 7 (prod unknown); `minAgeBeforeYieldCheck` 60; `adoptGraceMinutes` 30; `poolHealthMinSnapshots` 3 | 2 ticks; TWAP-gated; not urgent; close-eff gate only logs a `lowyield-cost` breakdown (never defers) | always on |

**T. TWAP wick guard (`gateExit`, 2744–2787; pure fn `evaluateTwapWickGuard` 1946–1976):** compares current pnl to the mean of the last `twapGuardTicks` (5) prior ticks; deviation > `twapGuardDeviationPct` (8 pp) → defer, bounded by `twapGuardMaxDeferrals` (2) consecutive (`twap_guard_deferrals`, lifetime `twap_guard_deferrals_total`). `twapGuardEnabled` **false** (prod OFF) → `[TWAP_GUARD_SHADOW] would-defer` / `deferral cap reached`, exit passes through. Never sees crash/rug (structural).

---

## 2. `index.js getDeterministicCloseRule` — order (`index.js:3716–3908`)

Gates → `null`: untracked and `!manageUntracked` (default false) (3720); `lazy` (3725); `hold_mode` (3730); `pnl_management_ready === false` (3733). `pnlSuspect` (3737–3747) = `pnl_pct_suspicious` OR (pnl ≤ −90 while value > 0.01 SOL). Reason strings are deliberately keyword-disciplined (comment 3749–3755): the family classifier is `reasonFamily()` in `lessons.js:483–495` (index.js's comment calls it `classifyExitFamily`; no function of that name exists). Match order: `stop loss → crash → trailing → take profit → below → above → out of range|oor → yield → volume → other`.

| # | Rule id / signal | Family | file:line | Condition | Config (code default → prod) | Urgency / notes |
|---|---|---|---|---|---|---|
| R1 | `rule:1` **stop loss** (`urgent:true`) | "stop loss: effective pnl …" → `stop_loss` | 3759–3767 | `!pnlSuspect` AND `effective_pnl ≤ stopLossPct` | `stopLossPct` −18 → **prod −15** | mgmt: `urgent:true` flows to `closePosition`. **Poller: signal is `"RULE_1"`, NOT in `URGENT_EXIT_ACTIONS` → non-urgent** (3199). No 15 s timer, no TWAP |
| R2 | `rule:2` **take profit** | "take profit: effective pnl …" → `take_profit` | 3768–3777 | `effective_pnl ≥ takeProfitPct`; suppressed for `range_harvest` | `takeProfitPct` code **5** (config.js:464); local dev copy 35; **prod unknown** (if 5, this hard-caps every trailing ride at +5%; the +4.10 avg / 103 trailing exits in plan-15 §2 suggest prod ≫5 — inference, unverified) | not urgent |
| R2' | `rule:2` **lineage take profit** — removed 2026-09-25 (audit 01 §3) | "lineage take profit: cumulative lineage pnl …" → `take_profit` | 3779–3816 | `rebalance_count ≥ 1`; root basis via `resolveRootInitialBasis`; totals `value + unclaimed + cumulative_fees_claimed_sol + total_fees_claimed_sol` (both fields summed — possible double count, **uncertain**) ≥ `rebalanceLineageTakeProfitPct` | 4.0 | third string variant of the same rule (see §1.6 and §2.B) |
| R3 | `rule:3` **pumped far above** (`oor_direction:"above"`) | "pumped far above range …" → `oor_above` | 3821–3833 | `active > upper + outOfRangeBinsToClose`; no pnl condition, no stability check | `outOfRangeBinsToClose` code **10** (config.js:428) → **prod 50** (CLAUDE.md) | not urgent |
| R3u | `rule:3` **unfilled-ladder cap** (`unfilled:true`) | "pumped above range with an unfilled ladder …" → `oor_above` | 3834–3857 | `outOfRangeBinsToCloseUnfilled` non-null >0 AND `active > upper + N` AND `pnl_pct < unfilledMaxPnlPct` | `outOfRangeBinsToCloseUnfilled` null → **prod 25** (2026-09-25, be2fcea); `unfilledMaxPnlPct` 1.0 | shipped after harvest so a filled ladder (pnl ≥1) is never mislabelled |
| R4a | `rule:4` **OOR above** | "OOR (above): … bins past upper" → `oor_above` | 3858–3878 | `active > upper` AND `outOfRangeWaitMinutesAbove != null && >0` AND `minutes_out_of_range ≥ limit` AND **`isPriceStable`** (3868) — if not stable **returns `null` for the whole function** (R4b/R5 not reached) | `outOfRangeWaitMinutesAbove` code 15 (config.js:446) → **prod 720**; `oorAboveStableTicks` 2 | `isPriceStable` (202–212) keeps the last N+1 active bins per position **in-process**, fed by every call (poller 3 s ticks AND mgmt) → "2 stable management ticks" is really "2 stable evaluations" (≈6 s in the poller). Plan-15 §3.5: R4a has **never fired since Aug** (clock resets on any wick back in) |
| R4b | `rule:4` **OOR below** (`oor_direction:"below"`) | "OOR (below): … bins past lower" → `oor_below` | 3879–3894 | `active < lower` AND `outOfRangeWaitMinutesBelow != null && >0` AND `minutes_out_of_range ≥ limit` | 180 → **prod 60** | uses scan-side `minutes_out_of_range`; same threshold as state.js #9 |
| R5 | `rule:5` **low yield** | "low yield: fee/TVL … < min" → `low_yield` | 3895–3906 | `fee_per_tvl_24h < minFeePerTvl24h` AND `age ≥ minAgeBeforeYieldCheck`. **No adoption grace, no history floor** (contrast state.js #10) | 7 / 60 | not urgent |

### 2.A Management-cycle action map (`index.js:1033–1301`) — order per position
1. **exitMap** (1034–1062): held → `registerExitSignal(null,1)` + log; `pnl_management_ready===false` → same; else `confirmPeak(…,1)` + `updatePnlAndCheckExits`. TRAILING_TP → `evaluateCloseEfficiencyGate("TRAILING_TP")`, defer ⇒ dropped from the map (1054); LOW_YIELD → calibration log only.
2. **exitMap hit → CLOSE** (1070–1110), `rule:"exit"`, `urgent = URGENT_EXIT_ACTIONS.has(exit.action)`. **ROUND_TRIP_HARVEST roll-up branch first** (1072–1099): `rebalanceEngine().enabled` (`rebalanceEnabled` default true) AND `rebalance_count < rebalanceMaxCount` (2) → `isRebalanceTrendIncreasing(pool)` (`tools/rebalance-trend.js:58–121`: last 6×5 m GeckoTerminal candles; net gain >0 AND latest close ≥ prev (−0.5% tolerance) AND (higher closes OR higher lows OR ≥60% green)); confirmed + `rebalanceMode==="enforce"` → `REBALANCE spot 69/0` (`[ROUND_TRIP_ROLLUP]`); confirmed + shadow → `[REBALANCE_SHADOW] would roll up` then CLOSE; not confirmed → `[ROUND_TRIP_CLOSE]` → CLOSE.
3. **hold_mode → CLAIM / STAY** (1112–1123): CLAIM when `unclaimed_fees_usd ≥ minClaimAmount` (USD→SOL via cached price under solMode; `Infinity` if no price) else STAY `{hold_mode:true}`.
4. **`pnl_management_ready===false` → STAY** (1125–1131) "automatic management paused".
5. **`instruction` → INSTRUCTION** (1134–1136) — hands to the LLM and **skips every deterministic rule below** (the exitMap rules in step 1 still applied).
6. `getDeterministicCloseRule` → **R1/R2 only** → CLOSE immediately (1139–1143); other rules held in `closeRule` for step 8.
7. **OOR-below rebalance branch** (1152–1241): `rebalanceEnabled` AND `active < lower` AND `minutes_out_of_range ≥ rebalanceMinOorMinutes` (15). (a) `rebalance_count ≥ 1` → lineage TP ≥ 4% → CLOSE `rule:"lineage_take_profit"` reason "Lineage take-profit: …" (**`other` family**). (b) `isNetProfitable` = effective pnl ≥ 0 OR lineage ≥ 0; if not → `[REBALANCE_SKIP_UNPROFITABLE]`, fall through. (c) profitable, `count < max`, **shadow** → `[REBALANCE_SHADOW] … would REBALANCE|WAIT` then fall through (never STAY). (d) enforce → trend confirmed → `REBALANCE curve rebalanceBinsBelow/Above (35/34)`; else **STAY "rebalance waiting for trend"** (enforce only — this is the only place the engine can hold a position the exit stack would close).
8. **closeRule (R3/R3u/R4/R5) → CLOSE** (1243–1272); for `oor_direction==="below"` first `shouldFlipOorBelow` (§5) → `FLIP` when `oorFlipEnabled` else `[OOR_FLIP_SHADOW]`.
9. **CLAIM** (1278–1294) when `unclaimed_fees_usd ≥ minClaimAmount` (unit-converted).
10. **REVIEW** (1296–1299) when `health.review && alerts.length` — only possible with `poolHealthAutoReview=true` (position-alerts.js:152 zeroes `review` otherwise).
11. **STAY** (1300).

**Execution** `executeManagementActions` (727–913): re-checks `hold_mode` (746, suppresses anything but CLAIM/STAY); CLOSE → `executeTool("close_position",{reason, urgent, exit_context})` with RPC-429 backoff 30 s→5 min (`_closeRetryState`); FLIP → `flipPositionInPlace`, fallback close; CLAIM → `claim_fees` (routed through `claimFeesWithCompoundGate`, executor.js:473 — `[FEE_COMPOUND_SHADOW]`, `feeCompoundEnabled` false); REBALANCE → `rebalance_position` (fallback close); INSTRUCTION/REVIEW → `agentLoop(... "MANAGER")` with rules text at 889–892 ("Bias to hold"; PVP informational). Closed positions get `clearPriceHistory` (1480–1483).

**Manual/LLM closes** bypass both evaluators: `close_position` via executor; `hold_mode` blocks LLM/auto closes at `executor.js:1435–1442` and `dlmm.js:3141–3145` unless `operatorOverride`.

---

## 3. PnL poller decision path (`index.js:2940–3215`)

Per position (tracked only — `getMyPositions({force:true, silent:true})` fast path):
1. held → `registerExitSignal(null, confirmTicks)`, `recordTick`, **`continue` (crash/rug detectors do not run)**; `pnl_management_ready===false` → same (2941–2951).
2. `confirmPeak(p, pnl, confirmTicks)`; `recordTick` (price_ticks capture); `p.fresh_snapshots` (2952–2962).
3. `exit = updatePnlAndCheckExits(...)`; TRAILING_TP → close-eff gate (defer ⇒ `exit=null`); LOW_YIELD → log (2963–2973).
4. `closeRule = exit ? null : getDeterministicCloseRule(...)` (2974). Signal: `exit.action` or `RULE_${rule}`.
5. **Crash fast-path** `detectPriceCrash` (302–322; gates 287–300): always runs; trail `_binTrail` window `crashWindowSec` (90 s); GATE 1 `active < lower`; GATE 2 `lower − active ≥ crashMinBinDistance` (8); GATE 3 span ≥ `crashMinSpanSec` (9) and `binsDropped/min ≥ crashBinsPerMin` (12). Hit → `_crashFired.add` (even in shadow, blocks flips); `crashFastPathEnabled` → signal `CRASH_FASTPATH`, `rule:"crash"`, reason "crash-below N bins/Ns …" (→ `crash` family); OFF → `crash_shadow` "[shadow] would fast-close". Socket twin `handleSocketBinEvent` (339–382) is **shadow only** (`crashSocketMode` "shadow"; `[CRASH_SOCKET_SHADOW] armed/would-close/poller confirmed/recovered`).
6. **In-range rug** `detectInRangeRug` (256–283), only if `rule !== "crash"`: trail `_rugTrail` window `rugWindowSec` (300); GATE 1 `active ≥ lower`; GATE 2 `pnl ≤ rugMaxPnlPct` (−3); GATE 3 span ≥ `rugMinSpanSec` (60), `binsDropped ≥ rugMinBinsDropped` (10), velocity ≥ `rugBinsPerMin` (12). `inRangeRugEnabled` → `RUG_FASTPATH`, `rule:"crash"`, reason "in-range rug …" (→ **`other` family — no keyword**); OFF → `[RUG_SHADOW]`.
7. Smart-money exodus alert (3025–3054; `screening.smartExodusAlertEnabled`, 15 min rate limit) — notify only.
8. `effectiveConfirm` = crash/rug → `crashConfirmTicks` (3); `exit.bypass_confirmation` → 1; else `confirmTicks` (2) (3055–3059). `registerExitSignal` (3075); `[EXIT_TELEMETRY] first_breach|confirmed` for trailing.
9. On fire: `action="CLOSE"`; **ROUND_TRIP_HARVEST** → poller roll-up branch (3116–3136, identical logic to §2.A.2; enforce → `action="REBALANCE"` spot 69/0). **OOR-below** (`closeRule.oor_direction==="below" && rule !== "crash" && rule !== 1`, 3137–3168): engine enabled, `count < max`, `effective_pnl ≥ 0` → enforce ⇒ `continue` (defer to mgmt cycle — no close this tick); shadow ⇒ `[PnL poll] [REBALANCE_SHADOW] would defer`; then flip gates (no volume-death gate in the poller — `p.health` absent) → `FLIP` when enabled else `[OOR_FLIP_SHADOW]`.
10. `executeManagementActions([p], {action, rule, reason, urgent: URGENT_EXIT_ACTIONS.has(signal), exit_context})` under `_managementBusy` (3190–3213); FLIP resets only crash/bin trails; CLOSE → `clearPriceHistory`; **`break`** (one action per tick).

`URGENT_EXIT_ACTIONS` (718) = {STOP_LOSS, PROFIT_RATCHET, YOUNG_STOP, CRASH_FASTPATH, RUG_FASTPATH, TOXIC_CONVERSION}. Urgent → `closePositionUnchecked({urgent})` (`tools/dlmm.js:3138`): with `fastCloseSkipClaim` (false, prod OFF) would skip Step-1 claim (3506–3522; `[FAST_CLOSE_SHADOW] would-skip`), and shortens closed-record polling (`maxClosedAttempts` 1, sleep 1 s; 3703–3704). Manual closes (`_operator_override`) always skip the pre-claim.

**Close-efficiency gate** `evaluateCloseEfficiencyGate(p, kind)` (3607–3714; pure `evaluateCloseEfficiency` state.js:2253–2280): TRAILING_TP only; `positionValueSol` (solMode: `total_value_usd` carries SOL); `baseFrac = estimateBaseTokenFraction` (state.js:2368–2377, `(upper−active)/(upper−lower)` clamped); round-trip Jupiter quote (SOL→base→SOL, half the loss = one-way cost) cached `closeEffQuoteMinIntervalSec` (60) in `close_eff_cached_impact_pct`; dust base side (<0.0005 SOL) → impact 0; `gasSol = estimateExitGasCost()`; `net = gross − impactCost% − gasCost%`; defer when `net < closeEffMinNetPnlPct` (0.5). `closeEffGateEnabled` false (prod OFF) → `[CLOSE_EFF_SHADOW] would-defer|deferring` 1/10 min + `lowyield-cost` on LOW_YIELD. Fail-open on any error.

---

## 4. Precedence tables

### 4.1 Poller (per tick, first confirmed signal wins; crash/rug override whatever was computed)
```
 hold_mode / !pnl_management_ready  → no evaluation at all (signal streak reset)
 lazy                                → null from both evaluators
 [state.js, gateExit-wrapped]  TOXIC_CONVERSION > PROFIT_RATCHET > YOUNG_STOP > STOP_LOSS(15s) > TRAILING_TP(close-eff)
                               > LINEAGE_TAKE_PROFIT > ROUND_TRIP_HARVEST > SURGE_DECAY > OUT_OF_RANGE(below) > LOW_YIELD
 [index.js, only if exit==null] RULE_1 stop > RULE_2 TP > RULE_2 lineage > RULE_3 (50) > RULE_3 unfilled (25) > RULE_4 above(+stable, else null) > RULE_4 below > RULE_5 yield
 [override]                    CRASH_FASTPATH (if ON) > RUG_FASTPATH (if ON)   — replace the signal, confirm 3 ticks, no TWAP, urgent
 [post-confirm routing]        ROUND_TRIP → roll-up?;  OOR-below (non-crash, non-R1) → rebalance defer? → flip? → CLOSE
```
Signal-string streaks: a tick that alternates between e.g. `STOP_LOSS` (state.js, after 15 s) and `RULE_1` resets the counter; in practice RULE_1 is registered from tick 1 (state.js returns null during its 15 s wait) and fires on tick 2.

### 4.2 Management cycle (per position, first match)
```
 exitMap (same state.js order as above; TRAILING_TP may be close-eff-deferred)  → CLOSE (ROUND_TRIP may become REBALANCE in enforce)
 hold_mode           → CLAIM | STAY
 !management_ready   → STAY
 instruction         → INSTRUCTION (LLM)           ← deterministic RULE_1..5 NOT evaluated for this position
 RULE_1 | RULE_2     → CLOSE
 OOR-below ≥15m      → lineage TP CLOSE | (shadow: log, fall through) | enforce: REBALANCE | STAY-wait
 RULE_3/3u/4/5       → FLIP (below, if enabled) | CLOSE
 unclaimed ≥ minClaim→ CLAIM
 health.review       → REVIEW (LLM)   [only with poolHealthAutoReview]
 else                → STAY
```

### 4.3 Where the two evaluators disagree or double-evaluate
| Signal | state.js path | index.js path | Consequence |
|---|---|---|---|
| Stop loss | STOP_LOSS: 15 s violation timer, TWAP-gated, urgent | RULE_1: immediate, no timer, no TWAP; `urgent:true` only in mgmt (poller signal `RULE_1` is not in the urgent set) | state.js returns null during its 15 s wait → poller takes RULE_1 and fires after 2 ticks (~6 s); mgmt cycle likewise closes via RULE_1 on first sighting. **The state.js STOP_LOSS action is effectively dead; TWAP guard never covers stop-loss; poller stop-losses are not fast-close-urgent.** Both use `effective_pnl_pct`. |
| OOR below | uses `pos.out_of_range_since`, TWAP-gated, then flip/rebalance branches | RULE_4b uses scan `minutes_out_of_range`, same threshold | If TWAP (when enabled) defers OUT_OF_RANGE, RULE_4b fires anyway next evaluation — the guard is bypassable. Both route to the same flip/rebalance branches (poller condition `closeRule.oor_direction==="below"` is only true on the RULE_4b path; a state.js OUT_OF_RANGE confirm has `closeRule=null` → **no flip/rebalance check on the state.js OOR path in the poller**; the mgmt cycle's flip check also only runs on `closeRule`, i.e. the exitMap OOR close never consults `shouldFlipOorBelow`). |
| Low yield | Guard A adoption grace + Guard B history floor | RULE_5 has neither guard | A suppressed state.js LOW_YIELD (log "Low-yield exit suppressed") falls through to RULE_5 in both evaluators when `fee_per_tvl_24h` is a number (0) rather than null → the CRED-SOL-class insta-close may still be reachable. **Uncertain** whether the missing-data case yields 0 or null. |
| Lineage TP | LINEAGE_TAKE_PROFIT ("Lineage take-profit" → family `other`) after trailing | RULE_2' ("lineage take profit" → `take_profit`) and mgmt rebalance-branch ("Lineage take-profit" → `other`) | Same rule, three reason strings, two families. |
| Take profit (absolute) | none | RULE_2 at `takeProfitPct` | Only index.js has a hard TP; it is evaluated only when state.js returned null (i.e. trailing did not fire this tick), so a rising position hits RULE_2 the moment it crosses the target even with trailing armed. |
| OOR above | none (explicitly left to index.js) | RULE_3 → RULE_3u → RULE_4a (+`isPriceStable`) | RULE_4a unstable → `null` for the entire function → RULE_4b/RULE_5 unreachable that tick (harmless for below — can't be both — but **RULE_5 low-yield is masked while a position oscillates above range past 720 min**). |
| Round-trip harvest | state.js only | — | Evaluated before RULE_3u by construction (exit non-null ⇒ closeRule skipped). |
| Peak confirmation | poller `confirmTicks` (2) | mgmt cycle 1 tick | A single mgmt-cycle tick can raise `peak_pnl_pct` on a noisy reading (documented as intended backstop, 1030–1032). |
| Crash / rug | never (structurally excluded from gateExit) | poller only | Mgmt cycle has no crash path — a crash between poller ticks/while the poller is busy waits for RULE_1/OOR. |

---

## 5. Companion decision modules

### 5.1 OOR-below flip (`shouldFlipOorBelow`, `index.js:404–448`; plan #07)
Gates, all must pass: (1) `active < lower`; (2) `_crashFired` never marked (set by crash **and** rug hits, even in shadow, 2997/3013); (3) `getOrganicMomentumForPool` ≠ `decaying`; (4) no `volume_death` health alert (mgmt only — poller has no `health`); (5) pool/base-mint not on repeat-deploy cooldown; (6) `flip_count < oorFlipMaxPerPosition` (1); (7) `flipped_at` older than `oorFlipBailHours` (6) → `bail_timeout`. Flags: `oorFlipEnabled` **false** (prod OFF) → `[OOR_FLIP_SHADOW] would flip|no flip blocked_by=…`; companion `swapFreeRedepositEnabled` false (`[SWAP_FREE_SHADOW]`, executor auto-swap path), `swapFreeRedepositBins` 20. ON path: `flipPositionInPlace` → ask ladder `active+1…active+20`, failure → real close (index.js:792–811). Cleared on FLIP: `_binTrail/_rugTrail/_crashFired/_socket*` (3206). Consulted only on the RULE_4b path (see §4.3).

### 5.2 Rebalance / roll-up engine (plan #15 item 3, plan #11) — removed 2026-09-25 (audit 01 §3; manual `/rebalance` path kept)
- `rebalanceEngine()` (490–494): `enabled = rebalanceEnabled` (default **true**); `enforce = enabled && rebalanceMode === "enforce"` (`rebalanceMode` default **"shadow"**, prod shadow).
- Four decision points: mgmt ROUND_TRIP roll-up (1072–1099), mgmt OOR-below (1152–1241), poller ROUND_TRIP roll-up (3116–3136), poller OOR-below deferral (3137–3153). All log `[REBALANCE_SHADOW]` and take the ordinary close/flip path in shadow; **no STAY-while-waiting in shadow**.
- Keys: `rebalanceMinOorMinutes` 15, `rebalanceMaxCount` 2, `rebalanceBinsBelow` 35, `rebalanceBinsAbove` 34 (OOR-below rebalance = `curve` 35/34; roll-up = `spot` 69/0), `rebalanceTrendTimeframe` "5m", `rebalanceTrendCandles` 6, `rebalanceLineageTakeProfitPct` 4.0 (config.js:745–763). Manual `/rebalance n [strat]` uses 35/34 (index.js:6186–6192).
- Executor safety case `rebalance_position` (`tools/executor.js:2001–2027`): depth cap `rebalance_count ≥ rebalanceMaxCount` → refuse; `validateDeployPoolThresholds(pool)` → refuse if the pool no longer passes deploy gates. **Operator override returns `pass:true` before both checks** (2008–2012) — the inline comment at 2006 ("skips only the depth cap, never the pool validation") and CLAUDE.md say only the cap is skipped; the code skips both. Hold blocks non-override rebalances (1444–1451).
- `rebalancePosition` (`tools/dlmm.js:4154`, proceeds-only sizing 4253–4334; refuses before closing when no capital basis) and `recordRebalanceLegPerformance` (2087; `close_reason: "rebalance: …"`, `rebalance_leg:true`).
- Trend predicate `isRebalanceTrendIncreasing` (`tools/rebalance-trend.js:58–121`): GeckoTerminal OHLCV, `confirmed` = netGain > 0 AND latest advancing (≥ −0.5 %) AND (higher closes OR higher lows OR green ≥ ceil(0.6·n)).
- Evidence: Sep 13–24 live (pre-shadow) 33 chains ≈ **−4.0 SOL** net (plan-15 §2); 09-13→19 roll-up children ≈ +1.3 SOL vs KEVIN −0.48 / baton −0.67 (§3.5); GeckoTerminal replay of 40 unfilled far-above moments: immediate 69-bin roll-up mean **−7.0 % @3h / −11.4 % @6h**, worst −95 % (§3.5) → "no re-centre; free the capital". Plan-11 §2 (153 closes): 71 % of ≥5-bin above-range excursions wick back (64 % from ≥15 bins) → eager roll-up whipsaws ~2 of 3.

### 5.3 Position alerts (`position-alerts.js`, advisory)
`getPoolHealthConfig` (46–58): `poolHealthAlertsEnabled` true, `poolHealthAutoReview` **false**, `poolHealthMinSnapshots` 3, `poolHealthMinAgeMinutes` 20, `poolHealthWindowSize` 12, `poolHealthYieldDecayPct` 50, `poolHealthTvlDilutionRisePct` 40, `poolHealthVolumeDeathPct` 60, `poolHealthFeeRatioCollapsePct` 60. `analyzePositionHealth` (69–154): `yield_decay` (current fee/TVL vs early-window avg −50 %) → `fee_share_dilution` if pool TVL +40 % (review=true) else `yield_decay` (no review); `volume_death` (−60 % from window peak, review=true); `fee_ratio_collapse` (−60 %, no review). `review` forced false unless autoReview (152). Used by: mgmt report lines, LLM action block, REVIEW action, and flip GATE 4. Never auto-closes.

### 5.4 PVP on open positions (`pvp.js`, mgmt cycle 1021–1028)
`checkPositionsPvp` → `detectPvpRival(symbol, mint)`: Jupiter asset search for same symbol, rival needs `holderCount ≥ 500` and `fees ≥ 30` SOL, and a Meteora pool with `tvl > 5000`. Attached as `p.pvp`; rendered via `formatPvpAlert`; LLM rule "do NOT close solely for PVP". No mechanical effect.

### 5.5 OOR notify (`index.js:1532–1562`, `telegram.js:920–935`)
After a notifying cycle, for each open, **non-held** position with `!in_range` and `minutes_out_of_range ≥ outOfRangeWaitMinutes` (generic, 30): direction/limit resolved per side; **skipped when the direction limit is null** (auto-close disabled); suppressed while a live message is active (`hasActiveLiveMessage`). Hold sets "Auto-close disabled (On Hold)".

### 5.6 Post-close probes (plan #05; `runPostCloseProbes` 649–680, `runPostCloseMaintenance` 689–699)
Every mgmt cycle (also the zero-positions path, 984): for perf records younger than `max(postCloseProbeMinutes)+60` min, each due slot m ∈ `[30,60,180]` (not `update_config`-tunable) fetches pool mcap (`getPoolDetail`) once (idempotent `post_close.m{m}`), `stale` if past `graceMin` 20, `delisted` on fetch failure, `unprobeable` when `exit_mcap` missing. Exit quality (`lessons.js:355–368`) anchors on m60 → m180 → m30; verdicts `flat|good_exit|early_exit|marginal|delisted|no_data`; rollup `getExitQualitySummary` (505–545) by `reasonFamily`, `selling_bottoms` = n ≥ 6 and early > good. Dust sweep after any close and every ~10th cycle (`dustSweepEnabled` true).

### 5.7 Balance-history piggyback
`recordBalanceHistory({freshPositions:false})` fire-and-forget at the end of every positions-carrying cycle (1457–1458) + cron `*/5` (3373) + boot (2557); CLAUDE.md: 2.5-min min-gap dedupe. Also `_lastSampledAum` feeds the report.

### 5.8 Adoption & reconciliation
- `reconcileStateWithChain({minAgeMinutes=5})` (`state.js:3389–3525`): owner-wide discovery scan; (1) phantom: tracked-open but absent on-chain AND `isPositionAccountLive === false` AND deployed >5 min ago → `closed`, `external_close_pending`, Telegram; (2) orphan: on-chain, untracked/closed, age ≥ 5 min, liveness true → `adoptOrphanPosition(p,{reason:"reconciliation"})`; (3) `pnl_pct_diff > 5` → alert (6 h rate limit). Poller-side repair `repairPendingExternalCloses` (2753–2772) recovers PnL for external closes via `reconcileExternallyClosedPosition`.
- `adoptOrphanPosition` (`state.js:936–1110`): Case A resurrect a closed row (`adopted_at` reset, `valuation_valid_ticks=0`, `management_armed=false`); Case B `trackPosition` with `adopted:true`, `deployed_at` **backdated by on-chain age**, `amount_sol` = first-scan SOL value, strategy `manual` unless a deploy event proves bot origin, **`adoption_basis = buildAdoptionBasis(p)`** (859–883: lifetime deposits/withdrawals/fees snapshot; null if indexer has none). `applyAdoptionBasis` (892–934): `pnl_sol = (lifetime.pnl − basis.pnl) − capitalAtAdoption` (b069ac2 fix), `pnl_pct` vs `capitalAtAdoption + post-adoption deposits`.
- Adoption-specific exit behaviour: `pnl_management_ready` false until `postAdoptionValidTicks` (2) valid ticks (`state.js:1349–1370`) → both evaluators return null / STAY; LOW_YIELD state.js path grace `adoptGraceMinutes` (30) from `adopted_at` + `poolHealthMinSnapshots` floor; RULE_5 has no such guard (§4.3).

### 5.9 Auto-skimmer rails (`tools/transfer.js`)
Config `autoSkim` (`config.js:975–985`): `enabled` **false** (prod OFF per CLAUDE.md), `destinationAddress` (env `PIONEX_DEPOSIT_ADDRESS` wins), `targetWorkingCapitalSol` 6.2529, `minTransferAmountSol` 0.5, `minWalletReserveSol` 0.1, `transferIntervalMin` 60, `maxDailyTransferSol` 2.0, `requireTelegramConfirmation` **true**. `getAutoSkimStatus` (84–176): equity = free SOL + `deployed_sol`; surplus = equity − target; transferable = min(surplus, free − reserve); block reasons in order: disabled → invalid destination → cooldown → daily cap (in-memory ledger floored by persisted baseline withdrawals ≤24 h) → surplus < min → cash < min. `checkAndExecuteAutoSkim` (335–390): chunks of `minTransferAmountSol`; with confirmation required returns `confirmation_required` (cron proposes on Telegram ≤1/6 h, index.js:3473–3483). `transferSol` (185–301): `validateDestinationAddress` (base58, on-curve, ≠ own wallet), ≥0.01 SOL, reserve check, daily cap, priority fee 50k µL, simulate, confirm ≤45 s, records `baseline.withdrawals`. `_transferLock` serialises. Cron `*/5` (3447) skipped while busy.

---

## 6. Hold mode — full semantics

- **Set/clear**: `setPositionHold(addr, enabled, reason)` `state.js:1683–1721` — sets `hold_mode/hold_set_at/hold_reason` (reason sanitised ≤280 chars), and on hold **clears** `pending_exit_*`, `stop_loss_violated_since`, `young_stop_violated_since`, `twap_guard_deferrals`; pushes `hold|resume` event. Entry points: `/hold <n|pair>` `/unhold` + natural-language "hold" detection (`isExplicitHoldRequest` 5734–5743, `handleTelegramHoldControl` 5771–5815; reason = the message text); positions-menu button (5015–5024, reason "telegram_button"); dashboard `POST /command/set-hold` (4208–4255, reason "dashboard operator hold"); `/unset n` clears **both** instruction and hold (6248–6249); `/unhold` clears hold only (instruction kept).
- **Suppressed while held**: `updatePnlAndCheckExits` → null before bookkeeping (state.js:2529) — so `peak_pnl_pct`, `trailing_active`, ratchet arming, `pnl_tick_history`, MFE/MAE, `peak_dynamic_fee_pct` all **freeze**; `confirmPeak` skipped by both callers; `getDeterministicCloseRule` → null (3730); poller `continue` before crash/rug detectors (2942–2946) so bin trails go stale; INSTRUCTION not evaluated (hold branch precedes it, 1112 vs 1134); `executeTool close_position|rebalance_position` blocked without `operatorOverride` (executor.js:1435–1451; dlmm.js:3141–3145); `executeManagementActions` suppresses any non CLAIM/STAY action (746–750); OOR notify skipped (1534) and marked "Auto-close disabled (On Hold)"; screening's post-mgmt slot count depends on `maxPositionsExcludeHold`.
- **Still runs**: CLAIM when `unclaimed ≥ minClaimAmount` (1118); `recordTick` capture; pool-memory snapshots, health alerts, PVP, report publish; OOR clock (`markOutOfRange` in pnl.js) keeps counting — on `/unhold` an OOR-below position past 60 min closes on the next 2 poller ticks; reconciliation phantom/orphan handling; manual `/close`, `/closeall`, dashboard close, `/rebalance` (operatorOverride) all work.
- **`maxPositionsExcludeHold`** (`config.risk`, code default **false** since plan-15 §3.4; prod false): index.js:1491–1494 and 1620–1622 count only non-held positions when true (`!== false`); the executor's deploy cap (executor.js:1836) always counts held rows → with true, screener saw free slots the executor refused (187 "Max positions reached" blocks, 09-12→22). Settings menu toggle at 4604.

---

## 7. Telegram / command handlers acting on positions (`index.js`)

| Command | Line | Effect |
|---|---|---|
| `/close <n>` | 6156–6176 | `executeTool("close_position",{reason:"manual close (/close)"},{operatorOverride:true})` — bypasses hold; reason family `other`; manual → pre-claim skipped, `maxClosedAttempts` 0/1 |
| `/closeall` | 6205–6227 | same per position |
| `/rebalance <n> [strat]` | 6178–6203 | `rebalance_position` operatorOverride, `curve` default, 35/34 → executor override skips depth cap **and** pool re-validation (code) |
| `/set <n> <note>` | 6229–6240 | `setPositionInstruction` → INSTRUCTION path (LLM judges each cycle; deterministic R1–R5 skipped, state.js exits still apply) |
| `/unset <n>` | 6242–6253 | clears instruction + hold |
| `/hold` `/unhold` `<n|pair>` (+ natural language) | 5771–5815 | `setPositionHold` |
| `/skim on|off|now` | 6275–6309+ | on/off → `update_config autoSkimEnabled`; now → `getAutoSkimStatus({freshPositions:true})` checks then transfer (lines past 6309 not read; **assumed** to call `transferSol`) |
| `/setcfg key val` | 6255–6273 | `update_config` (all exit knobs in `CONFIG_MAP`, executor.js:740–850, are reachable) |
| Dashboard `POST /command/close`, `/command/set-hold` | 4074–4255 | token-auth (`MERIDIAN_COMMAND_TOKEN`), operatorOverride close with progress stream |

---

## 8. Config reference (management section, `config.js:423–763`) — exit-relevant keys

| Key | Code default | Prod (documented) | Used by |
|---|---|---|---|
| stopLossPct | −18 (`?? emergencyPriceDropPct ?? -18`) | **−15** | state STOP_LOSS, RULE_1 |
| takeProfitPct | 5 | unknown | RULE_2, prompt `TP_PCT` |
| trailingTakeProfit / TriggerPct / DropPct / MinPnlPct / OvershootPct | true / 3 / 1.5 / null / 0.5 | 2 / 1.5 | TRAILING_TP |
| adaptiveTrailingMode / inventoryExhaustionMode | removed 2026-09-25 (audit 01 §3) | — | TRAILING_TP |
| profitRatchetEnabled / ArmPct / StopPct | removed 2026-09-25 (audit 01 §3) | — | PROFIT_RATCHET |
| roundTripHarvestEnabled / MinPnlPct / FrozenTicks / FrozenEpsilonPct / MinBinsAbove | false / 1.0 / 6 / 0.05 / 5 | **true** | ROUND_TRIP_HARVEST |
| youngStopEnabled / Pct / MaxAgeHours | false / −10 / 12 | OFF | YOUNG_STOP |
| toxicConversionEnabled / ThresholdPct / MaxAgeMinutes / MaxFeeYieldPct | **true** / 85 / 20 / 1.5 | unknown (defaults ⇒ ON) | TOXIC_CONVERSION |
| surgeDecayExitEnabled / ThresholdPct / MinAgeMinutes | false / 50 / 15 | unknown | SURGE_DECAY |
| outOfRangeWaitMinutes / Above / Below | 30 / 15 / 180 (absent inherits generic; explicit null disables) | — / **720** / **60** | notify gate / RULE_4a / OOR-below (both) |
| oorAboveStableTicks | 2 | — | `isPriceStable` |
| outOfRangeBinsToClose / outOfRangeBinsToCloseUnfilled / unfilledMaxPnlPct | 10 / null / 1.0 | **50 / 25 / 1.0** | RULE_3 / RULE_3u |
| minFeePerTvl24h / minAgeBeforeYieldCheck / adoptGraceMinutes / poolHealthMinSnapshots | 7 / 60 / 30 / 3 | unknown | LOW_YIELD, RULE_5 |
| crashFastPathEnabled / BinsPerMin / MinBinDistance / ConfirmTicks / WindowSec / MinSpanSec; crashSocketMode / crashSocketConfirmSpanSec | false / 12 / 8 / 3 / 90 / 9; "shadow" / 15 | CLAUDE.md: OFF — but plan-15 §2 records **15 "crash / rug fast-path" closes since 08-22** (MCAT "crash-below"), so the flag was ON for at least part of Sept; **current prod state uncertain** | poller |
| inRangeRugEnabled / rugBinsPerMin / rugMinBinsDropped / rugMaxPnlPct / rugWindowSec / rugMinSpanSec | false / 12 / 10 / −3 / 300 / 60 | see above | poller |
| twapGuardEnabled / Ticks / DeviationPct / MaxDeferrals | false / 5 / 8 / 2 | OFF | gateExit |
| closeEffGateEnabled / MinNetPnlPct / QuoteMinIntervalSec | false / 0.5 / 60 | OFF | trailing |
| oorFlipEnabled / BailHours / MaxPerPosition; swapFreeRedepositEnabled / Bins | false / 6 / 1; false / 20 | OFF | flip |
| (engine removed 2026-09-25, audit 01 §3; MaxCount/BinsBelow/BinsAbove kept for manual `/rebalance`) rebalanceEnabled / rebalanceMode / MinOorMinutes / MaxCount / BinsBelow / BinsAbove / TrendTimeframe / TrendCandles / LineageTakeProfitPct | true / "shadow" / 15 / 2 / 35 / 34 / "5m" / 6 / 4.0 | shadow | engine |
| fastCloseSkipClaim | false | OFF | closePosition |
| feeCompoundEnabled / MinMultiple / MinFeesSol | false / 5 / 0.01 | OFF | claim |
| exitSwapGuardEnabled / MaxImpactPct; swapSlippageCapEnabled / Bps | false / 5; false / 500 | OFF | post-close swap |
| postCloseProbeEnabled / Minutes; dustSweepEnabled / MinUsd / MaxUsd | true / [30,60,180]; true / 0.25 / 25 | ON | maintenance |
| poolHealthAlertsEnabled / AutoReview / … | true / false / (3,20,12,50,40,60,60) | unknown | alerts |
| pnlExtremeDivergencePct / pnlSanityMaxDiffPct / postAdoptionValidTicks | 50 / 5 / 2 | — | valuation gates |
| manageUntracked / lazy (per-position) / rangeHarvestPools / minClaimAmount / solMode | false / — / [] / 5 (USD) / false | solMode **true** in prod | gates, CLAIM |
| risk.maxPositionsExcludeHold | false | false | slot counting |
| pnl.pollIntervalSec / pnl.confirmTicks | 3 / 2 | unknown | poller |

Note the **code-default vs CLAUDE.md-table drift**: CLAUDE.md lists ratchet code default false/arm 2/stop −2, RULE_3 trigger 50, stop −15; `config.js` now ships true/6/+1.5, 10, −18 (the 4333b44 wave). Prod was hand-restored to the replay values; anything that re-reads defaults (a fresh `user-config.json`) would land on the drifted set.

---

## 9. Evidence ledger (numbers cited in code/CLAUDE.md/plans)

- **Trailing 2/1.5** — 2026-07-27 replay, 278 closes/195 paths: live 3/1 worst cell in its grid (mean +0.48, median −0.29, win 35 %); 2/1.5 best on every axis (mean +1.98, median +0.76, win 50 %, W/L 19–18); `worstTrunc` identical BULLCAT −5.84 in all 12 cells. 2026-09-24 re-run (plan-15 §3.2a, 800 closes): every mechanical trailing cell negative vs actuals (dominated by 93 manual / 67 harvest); tightest drops (0.75–1.0 pp) least bad; cannot rank 2/1.5 vs the 8 % adaptive pin (grid stops at 4 %). Adaptive pin: 0 trailing exits in 4 days vs 3–4/day before; trailing was +7.94 SOL / 103 closes / 97 % win since 08-22.
- **Profit ratchet** — 07-08 replay (101 paths): arm 2/stop −2 ~1–2×/100 closes, +15 pt each; revised 07-27: truncates BULLCAT −5.84; arm 1.5 whipsaws Chaton −18.10; **inert at trailing 2/1.5** (byte-identical rows with/without). Sep re-run: every ratchet cell below no-ratchet. Since 08-22: 28 ratchet closes avg −0.01 %.
- **Stop-loss** — Sep re-run: −15 monotone best (−25 costs −11…−14 pt further); since 08-22: 25 stop/young-stop closes avg −13.30 %, Σ −6.12 SOL, 0 % win.
- **Young stop** — 2026-07-19, 137 paths: <12 h tokens 19 % disaster vs 7.8 %; −10 young-only stop zero winner-kills, 3–7 pt earlier; −5 rejected (winners dipped −5.8/−6.1); n=5 → shadow.
- **OOR-below wait** — Sep re-run: 63–90 min leads (+5.3…+5.9 mean vs 180; n 18–19); prod 60. Since 08-22: 8 OOR-below closes avg −8.67 %, 0 % win.
- **Round-trip harvest** — CATE 7.98 % frozen 12 ticks / 16→31 bins; CYBERLEEK +2.47 % 5.4 h earlier than trailing (2.77 SOL freed); BULLSHIT +2.33 % / 29 bins. Plan-11: 137/153 went ≥5 bins above, 71 % wicked back. Since 08-22: 75 harvests avg +3.51 %, +3.02 SOL, 97 % win.
- **Unfilled cap 25** — plan-15 §3.5: 59 positions ≥20 bins above since 08-25; 40 unfilled (pnl<1): 8 returned (20 %), RULE_3(50) closed 11/15 fires at ≤0.6 %; 19 filled: 53 % returned, avg +14.6 %; immediate roll-up mean −7 % @3h / −11.4 % @6h; leaving the ladder: median 0, 23 % tail < −2 %.
- **Crash fast-path** — plan-04 §3: 1 bin ≈ 0.8–1.25 %; 12 b/min ≈ 12 %/min at bin_step 100; confirm 3 ticks ≈ 9 s vs 60 min OOR wait; worked −20 %/60 s fires in 9–15 s, healthy −4 %/3 min never. Since 08-22: 15 crash/rug closes avg −21.65 %, Σ −4.68 SOL.
- **In-range rug** — 12-position tick study 2026-07-15: winners dip ≤11 b/min, flat pools spike 18 b/min at pnl≈0; joint gate fires TrumpCoin at −7.1 % (vs −18.35 % stop + 48.9 % slippage), Flea at −3.3 %.
- **Rebalance engine** — Sep 13–24: 33 chains ≈ −4.0 SOL net (MCAT −1.05 rb=3, JEANPHIL −0.63 rb=4, KEVIN −0.48, PAID −0.41); `rebalance_count` 3–4 existed vs cap 2.
- **Hold cohort** — 44 held positions closed since 09-01: avg +4.87 %, +2.36 SOL, range −65…+66 %.
- **Fast close** — Step-1 claim measured 2.4–5.3 s, median ~3.5 s across 13 closes; RAKO moved −11 pt in one 45 s tick (not a gap-risk fix).
- **Close-eff / exit slippage** — febu $1.15 on $10.66, Bison $0.92 on $5.74 (10.8–16 %); brain-SOL $40.39 @ 11 % quoted / 10.4 % realized.
- **Adoption basis** — GO-SOL +1.15 % booked +101 % / +1.01 SOL before b069ac2.

---

## 10. Correlations, contradictions, dead/inert rules

### 10.1 Rules overlapping on the same signal
1. **Ratchet vs trailing at 2/1.5** — both arm off `peak_pnl_pct ≥ 2`; trailing fires at `peak − 1.5 ≥ +0.5` before the ratchet's −2 → ratchet inert (CLAUDE.md, replay). It becomes live only if trailing is deferred (close-eff enforce / TWAP) or under `adaptiveTrailingMode=enforce` (8 % trigger leaves a 2–8 % peak window where only the ratchet protects).
2. **Above-range family** — harvest (state.js, pnl ≥1 frozen, ≥5 bins) → RULE_3 (≥50 bins, any pnl) → RULE_3u (≥25 bins, pnl <1) → RULE_4a (≥720 min continuous + stable). Gap: a *filled but still-converting* ladder (pnl ≥1, not frozen) between 25 and 50 bins is held; a frozen ladder with 0 < pnl < 1 at 5–25 bins is held until 25. RULE_4a's clock reset + stability check make it a near-null backstop.
3. **Downside family** — crash (OOR-below, ≥8 bins, ≥12 b/min, 3 ticks, no TWAP) ⊃ rug (in-range, pnl ≤ −3, 12 b/min over ≥60 s) vs OOR-below timer (60 min) vs RULE_1 stop (−15, ~6 s) vs toxic conversion (≥85 % base within 20 min, fees <1.5 %, no pnl condition). With crash/rug OFF, the stop-loss is the only fast downside rule; toxic conversion (ON by default) is effectively a "ladder filled fast with no fees" exit that overlaps crash/rug's territory without a velocity or pnl test and can fire on a benign dip-fill (bidask "dip-entry theses" are only exempt if `initial_base_ratio_pct ≥ 70`).
4. **Yield-decay trio** — position-alerts `yield_decay` (−50 % vs early-window baseline, advisory), SURGE_DECAY `fee_tvl` (−50 % vs peak ≥5 %, exit if enabled), LOW_YIELD/RULE_5 (absolute floor `minFeePerTvl24h`). All read `fee_per_tvl_24h`; only the last is enforced in prod (assuming surge OFF).
5. **Lineage TP ×3** — state.js LINEAGE_TAKE_PROFIT (after trailing), RULE_2' (before RULE_3), mgmt OOR-below branch (only when OOR-below ≥15 min); same 4 % threshold, slightly different fee sums (`cumulative_fees_claimed_sol` vs `+ total_fees_claimed_sol`).
6. **Stop-loss ×2** and **OOR-below ×2** and **low-yield ×2** (state.js vs index.js) — see §4.3; the index.js copies are the ones that actually fire in the poller for stop-loss.
7. **Fee-share/volume alerts feed two consumers** — LLM REVIEW (if autoReview) and OOR-flip GATE 4.
8. **Rebalance roll-up vs harvest** — every harvest hit in prod runs a GeckoTerminal trend fetch (engine `enabled` true) purely to log `[REBALANCE_SHADOW]`.

### 10.2 Contradictions / inconsistencies found
- **Reason-family leakage**: TOXIC_CONVERSION and SURGE_DECAY(fee_tvl) reasons contain "yield" → bucketed `low_yield` and treated as **fee-death** by `classifyOutcome`; ROUND_TRIP_HARVEST reason contains "above" → bucketed `oor_above` in `/exits`; PROFIT_RATCHET, YOUNG_STOP, RUG_FASTPATH, LINEAGE ("take-profit" hyphen), manual closes all fall to `other`. The index.js keyword discipline (3749–3755) is not applied to state.js strings.
- **RULE_1 urgency** is `true` from the mgmt cycle but the poller derives urgency from the signal string (`RULE_1` ∉ `URGENT_EXIT_ACTIONS`), so the most common stop-loss path is non-urgent for fast-close.
- **Operator `/rebalance` skips pool re-validation** in code (executor.js:2008–2012) while the adjacent comment and CLAUDE.md say only the depth cap is skipped.
- **`isPriceStable` "management ticks"** (config comment 448) are really per-evaluation ticks fed by the 3 s poller.
- **RULE_5 lacks the adoption/history guards** that state.js LOW_YIELD carries; an OOR-above-unstable RULE_4a `return null` also masks RULE_5.
- **Config defaults drifted from CLAUDE.md** (ratchet 6/+1.5, stop −18, RULE_3 10, ratchet enabled true).
- **Crash flag state** — CLAUDE.md says shipped OFF; plan-15 §2 shows 15 crash/rug-family closes since 08-22 → the prod flag history is inconsistent; verify on the VM before relying on either.
- **`hold` freezes `pnl_tick_history`/peak** — after `/unhold`, harvest needs 6 fresh ticks and trailing resumes from the stale confirmed peak (could fire instantly if pnl fell during the hold).
- **Poller cadence documentation** (3 s code default vs "5 s"/"~45 s" in comments) — affects every "N ticks" statement (crash 3 ticks ≈ 9 s only at 3 s).

### 10.3 Dead or inert under documented prod config
- state.js **STOP_LOSS** action (RULE_1 pre-empts it in both evaluators) → TWAP guard, 15 s timer and STOP_LOSS urgency are unreachable in practice.
- **PROFIT_RATCHET** (inert at trailing 2/1.5; left ON as backstop).
- **RULE_4a OOR-above 720 min** (never fired since Aug).
- **REBALANCE / STAY-wait actions** (rebalanceMode shadow) and therefore **new lineage chains**; LINEAGE_TAKE_PROFIT only on the 4 legacy open chains.
- **REVIEW** (needs `poolHealthAutoReview=true`); **INSTRUCTION** only after `/set`.
- **YOUNG_STOP, TWAP guard, close-eff gate, OOR flip, swap-free redeposit, fee compounding, fast-close skip, slippage cap, exit-swap guard, socket crash, adaptive trailing, inventory exhaustion, re-entry cooldown** — all shadow (log tags: `[YOUNG_SL_SHADOW] [TWAP_GUARD_SHADOW] [CLOSE_EFF_SHADOW] [OOR_FLIP_SHADOW] [SWAP_FREE_SHADOW] [FEE_COMPOUND_SHADOW] [FAST_CLOSE_SHADOW] [SLIPPAGE_CAP_SHADOW] [EXIT_SWAP_GUARD_SHADOW] [CRASH_SOCKET_SHADOW] [ADAPTIVE_TRAILING_SHADOW] [INVENTORY_EXHAUSTION_SHADOW] [REENTRY_SHADOW] [REBALANCE_SHADOW] [RATCHET_SHADOW] [ROUNDTRIP_SHADOW] [SURGE_SHADOW] [RUG_SHADOW] crash_shadow`).
- **SURGE_DECAY** (code default OFF; prod unknown), **range_harvest profile** (`rangeHarvestPools` empty by default), **manageUntracked** false (untracked rows are adopted instead), **skimmer** (prod OFF; even ON it only proposes).
- **RULE_2 absolute TP** — inert if prod `takeProfitPct` ≫ trailing outcomes (local copy 35); dominant if 5. Unresolved.
