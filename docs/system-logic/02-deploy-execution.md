# Meridian — Domain: Deploy Execution, Sizing, Safety Checks, On-Chain Tx Mechanics

Read-only inventory of `/Users/Angga/Repos/meridian` at commit `a0fcd12` (branch `experimental`, 2026-09-25).
Line numbers are from the checked-out files; "prod" values come from CLAUDE.md unless stated. The local
`user-config.json` is a **dev copy** (its `_lastAgentTune` = 2026-09-24T22:29Z) and is quoted only where it is
the sole evidence — treat those as *not confirmed for the VM*.

Conventions: `cfg.X` = `config.<section>.X` from `config.js`. "Code default" = the `??` fallback in `config.js`.
"⚠" marks a discrepancy or an uncertainty I could not resolve from the checkout.

---

## 0. External dependency map

| Dependency | URL / method | Used by | Notes |
|---|---|---|---|
| **Helius / Solana RPC (sends)** | `new Connection(process.env.RPC_URL)` — `sendAndConfirmTransaction`, `getLatestBlockhash("confirmed")`, `getSignatureStatuses`, `getTransaction(…,{commitment:"confirmed",maxSupportedTransactionVersion:0})`, `getRecentPrioritizationFees({lockedWritableAccounts})`, `getAccountInfo`, `getMultipleAccountsInfo`, `getParsedAccountInfo` | `tools/dlmm.js:108-117` (`getConnection`), all deploy/close/claim/compound/rebalance sends (`sendAndConfirmWithRetry` dlmm.js:307-392), bin-array guard dlmm.js:821-872, close verification dlmm.js:3614-3666, `swapToken` fee lookup wallet.js:604-613, `closeEmptyTokenAccount` wallet.js:852-921 | **Bypasses the `tools/rpc.js` failover pool by design** so every send carries the `&rebate-address=` param (CLAUDE.md "Helius backrun rebates"). Registered with the pool only for telemetry (`registerRpcConnection`). |
| **RPC failover pool (reads)** | `callRpc` / `callRpcWithConnection` (`tools/rpc.js:710-844`) → `getBalance`, `getParsedTokenAccountsByOwner` (SPL + Token-2022), `getMultipleAccountsInfo`, `getSignaturesForAddress`, `getTransaction`, `SDK:DLMM.create`, `SDK:DLMM.getAllLbPairPositionsByUser`; indexed pool → Helius `getProgramAccountsV2` (`callRpcMethod`, pnl.js:467-468) | `wallet.js:48-127`, `dlmm.js:922-935` (`getPool`), `dlmm.js:4473-4497` (`lookupPoolForPosition`), `pnl.js` position discovery/valuation | Endpoints: all discovered Helius keys (`discoverHeliusEndpoints` rpc.js:70-140: `RPC_URL` api-key + `HELIUS_API_KEYS` + `HELIUS_API_KEY[_ALT|_FB|_FALLBACK]` + keys scraped from `RPC_URL_FALLBACK_*`, `RPC_INDEXED_URL*`, `PNL_RPC_URL*`; extra query params like `rebate-address` are propagated to every generated URL) + non-Helius `RPC_URL_FALLBACK_1/2` + public `https://api.mainnet-beta.solana.com` (rpc.js:142-171). |
| **Meteora DLMM SDK** (`@meteora-ag/dlmm`, lazy-loaded dlmm.js:74-103) | `DLMM.create`, `pool.getActiveBin`, `initializePositionAndAddLiquidityByStrategy`, `createExtendedEmptyPosition`, `addLiquidityByStrategyChunkable`, `addLiquidityByStrategy`, `claimSwapFee`, `removeLiquidity`, `closePosition`, `getPosition`, `getBinArrayKeysCoverage`/`getBinArrayIndexesCoverage`, `deriveBinArrayBitmapExtension`, `isOverflowDefaultBinArrayBitmap`, `BIN_ARRAY_FEE` (0.07143744 SOL), `BIN_ARRAY_BITMAP_FEE` (0.01180416 SOL) | deploy/close/claim/compound/rebalance | `patch-anchor.js` postinstall (memory note). |
| **Meteora datapi — pool discovery** | `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=pool_address=<addr>&timeframe=<tf>` | `fetchFreshPoolDetail` executor.js:121-130 (deploy validation, 1–3 GETs/deploy), exit-market snapshot dlmm.js:3823 & 3343, post-close probes via `getPoolDetail` index.js:670 | Windowed fields (`volume`, `fee_active_tvl_ratio`, `pool_price_change_pct`) depend on `timeframe`. |
| **Meteora datapi — positions/pnl** | `https://dlmm.datapi.meteora.ag/positions/<pool>/pnl?user=<wallet>&status=closed&pageSize=50&page=1` (close paths dlmm.js:3295, 3706); `…&status=open&pageSize=100…` (pnl.js:118-143 `fetchDlmmPnlForPool`); `pageSize=100` variant in `fetchClosedPositionPnl` dlmm.js:2026; `https://dlmm.datapi.meteora.ag/pools/<addr>` (`getPoolMetadata` dlmm.js:949); `https://dlmm.datapi.meteora.ag/portfolio/open?user=` (fallback path dlmm.js:2425) | realized PnL after close, adoption lifetime figures (`allTimeDeposits/Withdrawals/Fees.total.{sol,usd}`, `pnlSol`, `pnlUsd`, `pnlSolPctChange`, `pnlPctChange`, `closedAt`) | Authoritative realized-PnL source; **retried up to 6×5s** on calm closes (dlmm.js:3703-3704). |
| **Jupiter Swap V2** | `https://api.jup.ag/swap/v2/order?inputMint&outputMint&amount&taker[&slippageBps][&referralAccount&referralFee]` (GET, header `x-api-key`), `https://api.jup.ag/swap/v2/execute` (POST `{signedTransaction, requestId}`) | `getSwapQuote` wallet.js:458-504 (order only, `skip_taker` option), `swapToken` wallet.js:506-637 | Referral: `cfg.jupiter.referralAccount` default `9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey`, `referralFeeBps` 50 (env `JUPITER_REFERRAL_FEE_BPS`), only sent when 50 ≤ bps ≤ 255 (wallet.js:145-165). Omitting `slippageBps` = Jupiter RTSE dynamic slippage. API key default hard-coded `b15d42e9-…` (wallet.js:139) ⚠ secret-in-source. |
| **Jupiter price v3 / datapi** | `https://api.jup.ag/price/v3` (wallet.js:137), `https://datapi.jup.ag/v1/assets/search` (pnl.js:32, `getJupiterPrices`) | wallet snapshot USD values, `valueClaimableFees` | |
| **Priority-fee source** | `conn.getRecentPrioritizationFees({lockedWritableAccounts})` on the primary `RPC_URL` connection (dlmm.js:224-226), keyed by first writable account of the tx | every legacy `Transaction` send | 30 s cache, ≤16 keys (dlmm.js:144-146). |
| **LPAgent / agentmeridian relay** | `https://api.agentmeridian.xyz/api` `/execution/zap-in/order|submit`, `/execution/zap-out/order|submit` (dlmm.js:514, 1339-1373, 3172-3220) | relay deploy/close | **Dead for deploys**: `shouldUseLpAgentRelayForDeploy()` hard-returns `false` (dlmm.js:529-531). Close relay gated by `cfg.api.lpAgentRelayEnabled` (code default `false`, config.js:881). Relay tx safety: `assertNoUnsafeSystemTransfer` (dlmm.js:687-713), `assertNoInitializeBinArrayInstructions` (874-892), `signAndSimulateRelayTransactions` with `maxSolLoss: 0.05`. |
| **LPAgent open-positions** | `https://api.lpagent.io/open-api/v1` (dlmm.js:1840) | `getWalletPositions` | not on the money path. |

---

## 1. Tool surface, roles and the dispatch seam

- **Role tool sets** — `agent.js:10-11`: `MANAGER_TOOLS` = {close_position, claim_fees, swap_token, get_position_pnl, simulate_pnl_curve, predict_range_survival, get_my_positions, get_wallet_positions, get_wallet_balance, set_position_note}; `SCREENER_TOOLS` = {deploy_position, get_active_bin, get_top_candidates, check_smart_wallets_on_pool, get_token_holders, get_token_narrative, get_token_info, search_pools, get_pool_memory, simulate_pool, get_wallet_balance, get_my_positions}. GENERAL = everything. Filter at agent.js:74-75. ⚠ `rebalance_position` is in neither role set → only GENERAL/operator/mechanical paths can call it (the autonomous engine calls `executeTool("rebalance_position")` from index.js:817, not via the LLM).
- **WRITE_TOOLS** (executor.js:1197-1203) = {deploy_position, claim_fees, close_position, rebalance_position, swap_token}; **PROTECTED_TOOLS** = WRITE_TOOLS ∪ {self_update} (1204-1207). Only PROTECTED_TOOLS run `runSafetyChecks` (executor.js:1454-1463).
- **executeTool flow** (executor.js:1417-1716), in order: (1) strip model artifacts from the tool name (1421); (2) unknown-tool error (1424-1429); (3) **HOLD guard**: `close_position` / `rebalance_position` without `operatorOverride` on a `hold_mode===true` tracked position → `{blocked:true}` (1435-1451, log tag `safety_block`); (4) `runSafetyChecks` for PROTECTED tools, args carry `_operator_override:true` when operator (1454-1463; log `safety_block` on fail); (5) execute `fn(args)` (1467); (6) `logAction` audit (1471-1477); (7) post-hooks on success (§8.4); (8) socket subscription resync after deploy/close/rebalance (1682-1690); errors are returned to the LLM as `{error, tool}` (1710-1713).
- **Bear-debate seam** (agent.js:502-580) — runs once per SCREENER session for `deploy_position` **before** `executeTool`: `extractDeployConfidence(lastAssistantText)` (llm-verdicts.js:33-58: last `confidence: NN` match, first `thesis:` line ≤240 chars) → if `cfg.screening.bearDebateEnabled` (code default **true** config.js:300; **prod false** since 2026-07-27) `runBearDebate` (llm-verdicts.js:150-176; temperature 0.2, max_tokens 2048; a `claude-cli/` bearDebateModel is redirected to `claudeCliFallbackModel`, agent.js:514). Verdict handling: `veto` + `bearDebateAction==="enforce"` → tool result `{blocked:true}` and `firedOnce.add("deploy_position")` (agent.js:543-557); `size_down` + enforce → **halves `amount_y`/`amount_sol` in place** (agent.js:559-570); everything else logs only (`Bear debate [log_only]…`, `Bear VETO (log_only) — would block`, `Bear size_down (log_only)`). Fail-open on any exception (agent.js:576-579). After a successful deploy, `attachDeployVerdicts(result.position, {deploy_confidence, deploy_thesis, bear_debate:{verdict,confidence,reason,action,enforced,parsed,error}})` persists onto the tracked row (agent.js:591-618 → state.js:1403-1445, adds `fail_open` = `parsed===false || error`). Evidence (CLAUDE.md): 78/78 vetoes at avg conf 91.3; all 17 historical "proceed" rows are `reason:null` fail-open defaults.
- **deploy_position is locked after the first attempt regardless of outcome** (`NO_RETRY_TOOLS`, agent.js:620-623) — a SAFETY_BLOCK'd deploy cannot be retried in the same LLM session.
- Tool schemas the LLM sees: `deploy_position` definitions.js:129-215 (params: pool_address*, amount_y, amount_x, amount_sol, strategy∈{bid_ask,spot,dynamic}, shape∈{spot,curve,bidask}, bins_below, bins_above, downside_pct, upside_pct, pool_name, base_mint, bin_step, base_fee, volatility, fee_tvl_ratio, organic_score, initial_value_usd, lazy, tier∈{full,probe}); `claim_fees` 322-340; `close_position` 344-375 (position_address*, skip_swap, reason); `rebalance_position` 378-415 (target_strategy∈{spot,curve,bid_ask} default curve, bins_below 35, bins_above 34, reason); `swap_token` 464-495 (input_mint*, output_mint*, amount* — **no slippage param exposed to the LLM**). ⚠ The `deploy_position` description says "never pass 'curve' in strategy" but the executor/dlmm `strategyMap` accepts `curve` (dlmm.js:1234-1239) — prompt guidance only.

---

## 2. Deploy path — pre-executor (screener, index.js)

Execution order inside `runScreeningCycle`:

1. **Size** — `deployAmount = computeDeployAmount(preBalance.sol)` (index.js:1700). See §4.
2. **Deploy-timing gate** (index.js:1704-1716; `getDeployTimingGate` deploy-timing.js:176-182 → `decideTimingGate` 165-175): only if `cfg.timing.gateEnabled` (default **false**, config.js:796) and the current UTC bucket has `n ≥ minBucketN` (8) and `successRate < deadHourSuccessFloor` (0.20). `action:"skip"` → cycle aborted with a `no_deploy` decision; `"size_down"` (default) → `deployAmount *= sizeDownPct` (0.5), rounded to 3 dp. Manual `/deploy` unaffected. Log tag `cron`.
3. Candidate recon, launchpad/bot-holder/rug/CRI filters (index.js:1760-1815) — screening domain, listed only for ordering.
4. **Gas break-even filter** (index.js:1817-1839): for each passing candidate (scout candidates exempt, 1822-1825): `gasCost = estimateCycleGasCost(pool._binCount > 69)`; `breakEven = gasBreakEvenMinutes(gasCost, pool.fee_tvl_24h ?? pool.fee_per_tvl_24h ?? 0, deployAmount)`; drop if `breakEven > cfg.screening.maxGasBreakEvenMinutes` (**30**, config.js:279). Formulas (dlmm.js:399-424): `perTx = 5000 + cachedPriorityFeeValue("normal")` lamports; `totalTxs = (wide?3:1) + 3 + 1`; `gasSol = totalTxs·perTx/1e9`; `yieldPerMin = (feeTvl24h/100)·deploySol/1440`; `breakEven = gasSol/yieldPerMin` (∞ if feeTvl ≤ 0). Log `screening` "Gas filter: …". ⚠ Under prod `playstyle` the max width is 69 bins so `isWide` is always false here; `cachedPriorityFeeValue` is 0 until a priority fee has been fetched this process (cold start → gas ≈ 5 tx × 5000 lamports = 0.000025 SOL).
5. **Bins formula** the screener is told to use (prompt.js:171, index.js:2180) and the mechanical/manual path actually uses (`computeBinsBelow` index.js:3990-3998): `bins_below = clamp(round(minBinsBelow + (vol/5)·(maxBinsBelow−minBinsBelow)), minBinsBelow, maxBinsBelow)`; throws on non-finite/≤0 volatility.
6. LLM decides → `deploy_position` tool call → §1 seam → §3.

Manual `/deploy` (index.js:5331-5340) calls `executeTool("deploy_position", {pool_address, amount_y: computeDeployAmount(wallet.sol), strategy: cfg.strategy.strategy, bins_below: computeBinsBelow(vol), bins_above: 0, …})` — same safety block, no bear debate.

---

## 3. Deploy path — `runSafetyChecks("deploy_position")` in execution order

Source: executor.js:1720-1999. Every branch returns `{pass:false, reason}` → `executeTool` logs `safety_block` and returns `{blocked:true, reason}` to the caller. Stateful side effects on `args` are noted because `deployPosition` consumes the mutated args.

### 3.1 `validateDeployPoolThresholds(args)` (executor.js:131-308) — one fresh discovery-API read

| # | Check | Condition (as implemented) | Config (code default / prod) | Lines | Log tag |
|---|---|---|---|---|---|
| V0 | Fresh detail | `fetchFreshPoolDetail(pool_address, cfg.screening.timeframe)` → null/throw → **block** "Could not verify pool screening thresholds" | `timeframe` "5m" (prod 1h per RANK notes ⚠ unverified) | 132-140 | — |
| V1 | TVL readable | `tvl = detail.tvl ?? active_tvl ?? liquidity`; null → block | — | 142-150 | — |
| V2 | **Entry-TVL floor + exemptions** | if `tvl < minTvl`: (a) `hasCleanPoolHistory(pool)` (pool-memory.js:566-597: ≥3 deploys with numeric `pnl_pct`, `worst > −10`, `avg ≥ +1.0`) → allow, log `[TVL_EXEMPT]`; else (b) `cfg.screening.scoutTierEnabled` → `scoutTier=true`, log `[SCOUT]`; else **block**. A sub-floor Top Performer (`getTopPerformerHint` + `tvl ≥ topPerformersMinTvl` 15k) gets **no** full-size bypass (Plan #15 item 4), only the `[TOP_PERFORMER]` log line. | `minTvl` code 10 000 / **prod 100 000**; `scoutTierEnabled` false / prod false; `topPerformersMinTvl` 15 000 | 152-189 | `executor` |
| V3 | Max TVL | `tvl > maxTvl` → block | `maxTvl` code 150 000 / **prod 400 000** | 190-195 | — |
| V4 | Fee/active-TVL floor | `feeActiveTvlRatio < minFeeActiveTvlRatio` (or null) → block **unless** steady-lane hint present AND a second 24h-timeframe GET shows `fee24 ≥ (cfg.management.minFeePerTvl24h ?? cfg.screening.minFeePerTvl24h ?? 1.0)` (fail-closed on fetch error). | `minFeeActiveTvlRatio` 0.05 (evolution-owned; prod 0.30 per starvation note ⚠); `minFeePerTvl24h` mgmt default **7** (config.js:457) ⚠ the comment says "1%/day threshold" but the mgmt default is 7 — the waiver therefore requires ≥7%/24h in prod unless overridden | 197-232 | `[LANE]` |
| V5 | Volume/TVL velocity | skipped if steady-lane; else `volume_tvl_ratio` (or `volume/tvl`) `< minVolumeTvlRatio` → block | `minVolumeTvlRatio` 0.05 | 234-242 | `[LANE] velocity gates waived` |
| V6 | Tx/min velocity | skipped if steady-lane; `txPerMin = tx_per_min ?? swap_count/tfMinutes`; `< getMinTxPerMinForTimeframe(tf, minTxPerMin)` → block. Scaling (screening.js:45-54): 5m → base; 1h → min(base,2.0); 24h → min(base,0.8); other → min(base,2.0). | `minTxPerMin` 5.0 | 244-254 | same |
| V7 | Volatility usable | timeframe for vol = max(screening tf, 30m) (`getVolatilityTimeframe` 77-82); second GET if needed; `volatility == null || ≤ 0` → block | — | 256-275 | — |
| V8 | Bin step | `bin_step < minBinStep` or `> maxBinStep` → block (from `dlmm_params.bin_step ?? pool_config.bin_step`) | 80 / 125 | 277-291 | — |
| V9 | Capture | returns `{pass:true, entryMarketData:{entry_mcap, entry_tvl, entry_volume, entry_holders, entry_price_change_pct}, baseMint (token_x.address), scoutTier}` | — | 293-307 | — |

### 3.2 The safety block proper (executor.js:1720-1999), after V0–V9 pass

| # | Check | Condition | Config | Lines | Notes |
|---|---|---|---|---|---|
| S1 | Merge entry data | `Object.assign(args, entryMarketData)`; `delete args.scout; delete args.probe` (never trusted from caller) | — | 1723-1728 | |
| S2 | Bin step (args) | `args.bin_step` given and outside `[minBinStep,maxBinStep]` → block | 80/125 | 1731-1738 | Mirror of V8 on the **LLM-supplied** value. |
| S3 | Single-side only | `amount_x > 0` → block | — | 1740-1747 | |
| S4 | Steady-lane width hint | `delete args.lane, args.lane_min_bins`; if `getSteadyLaneHint(pool)` (screening.js:976-982, 3h TTL): fill `bins_below`/`shape` if omitted, set `args.lane="steady"`, `args.lane_min_bins=hint.min` | `steadyLanePlaystyle` null / **prod single_account {45,69}**, `steadyLaneShape` "spot" | 1753-1762 | `[LANE]` |
| S5 | Top-performer width hint | `getTopPerformerHint(pool)` (screening.js:991-997, 3h TTL, set at rank admission with `{bins_below:69,bins_above:0,shape:"spot"}`): fills omitted bins/shape, `args.lane="top_performer"` (**overwrites** a steady lane tag) | `topPerformersEnabled` true | 1763-1770 | `[TOP_PERFORMER]` |
| S6 | Hard width clamp | `bins_below > MAX_SAFE_BINS_BELOW (69)` → clamped to 69 | — | 1771-1774 | log `executor` "Clamping args.bins_below" |
| S7 | Volatility arg | provided but non-finite/≤0 → block | — | 1786-1791 | |
| S8 | Range floor (total) | when no `downside_pct`/`upside_pct`: `requestedBelow = min(69, bins_below ?? defaultBinsBelow ?? minBinsBelow)`, `requestedAbove = bins_above ?? 0`; non-integer/negative or `below+above < minBinsBelow` → block. `minBinsBelow = laneHint ? max(35, hint.min) : max(35, cfg.strategy.minBinsBelow)` | `MIN_SAFE_BINS_BELOW` 35; `cfg.strategy.minBinsBelow` from playstyle (balanced 35; single_account 45) | 1775-1809 | |
| S9 | Range floor (single-side) | single-side SOL and `bins_below < minBinsBelow` → block | | 1811-1819 | |
| S10 | bins_above=0 | single-side SOL and `bins_above !== 0` (no `upside_pct`) → block | | 1821-1829 | |
| S11 | Max positions | `getMyPositions({force:true}).total_positions ≥ cfg.risk.maxPositions` → block | `maxPositions` 3; `maxPositionsExcludeHold` false (held positions count) ⚠ dev user-config has `true` | 1832-1838 | force-fresh scan (race note CLAUDE.md) |
| S12 | Duplicate pool | any open position with same `pool` → block | | 1839-1847 | |
| S13 | Duplicate base token | only if `args.base_mint` supplied: open position with same `base_mint` → block ⚠ **not** using `poolThresholds.baseMint` (unlike S14), so an LLM that omits `base_mint` bypasses this check | | 1850-1860 | |
| S14 | Re-entry cooldown | `evaluateReentryCooldown(getTrackedPositions(false), {poolAddress, baseMint: args.base_mint || poolThresholds.baseMint, cooldownMinutes})` (state.js:2411-2434: most recent closed row with same pool OR same mint within window); enabled → block "Re-entry cooldown: …"; else `[REENTRY_SHADOW] would-block`. Runs only when `poolReentryCooldownEnabled != null`; fail-open on throw | `poolReentryCooldownEnabled` false (prod shadow since 2026-07-29), `poolReentryCooldownMinutes` 240 | 1869-1906 | `[REENTRY]`/`[REENTRY_SHADOW]` |
| S15 | Scout clamp | if `scoutTier`: `openScouts = tracked open with .scout` ≥ `scoutMaxPositions` → block; else `amount = min(requested>0 ? requested : scoutSize, scoutSize)` with `scoutSize = max(0.05, scoutSizeSol)`; `args.scout=true` | `scoutSizeSol` 0.12, `scoutMaxPositions` 1 | 1909-1929 | `[SCOUT] clamping` |
| S16 | Probe clamp | `args.tier==="probe"` (then deleted) and not scout: `probeTierEnabled` false → **block**; open probes ≥ `probeMaxPositions` → block; else clamp to `max(0.05, probeSizeSol)`, `args.probe=true` | `probeTierEnabled` false, `probeSizeSol` 0.25, `probeMaxPositions` 1 | 1932-1957 | `[PROBE] clamping` |
| S17 | Positive amount | `amount_y ?? amount_sol ?? 0 ≤ 0` → block | | 1960-1967 | ⚠ an omitted amount is blocked here, so `deployPosition`'s own `computeDeployAmount` fallback (dlmm.js:1176-1179) is unreachable via `executeTool`. |
| S18 | Min deploy | `minDeploy = scout/probe ? 0.05 : max(0.1, cfg.management.deployAmountSol)`; `amount < minDeploy` → block | `deployAmountSol` code **0.4** (CLAUDE.md table says 0.5 ⚠; dev copy 0.4) | 1971-1977 | |
| S19 | Max deploy | `amount > cfg.risk.maxDeployAmount` → block | `maxDeployAmount` 50 | 1978-1983 | |
| S20 | SOL balance | unless `DRY_RUN==="true"`: `getWalletBalances().sol < amount + cfg.management.gasReserve` → block | `gasReserve` code **0.05** (CLAUDE.md table says 0.2 ⚠; dev copy 0.05) | 1986-1996 | RPC pool read |

### 3.3 `deployPosition()` (dlmm.js:1050-1793) — second gate layer + execution

Ordered as executed:

| # | Step | Condition / formula | Lines | Log |
|---|---|---|---|---|
| D1 | `ensureStateInitialized`, normalize pool | | 1088-1089 | |
| D2 | Volatility sanity | provided & non-finite/≤0 → **throw** | 1093-1097 | |
| D3 | Strategy resolve | `activeStrategy = strategy || cfg.strategy.strategy` (code default **"bid_ask"** config.js:768); `"dynamic"`/`"mixed"` → `vol ≥ dynamicVolatilityThreshold (1.5)` ? `bid_ask` : `spot` (no vol → spot) | 1090, 1099-1114 | `deploy` "Dynamic strategy: …" |
| D4 | **Pool cooldown** | `isPoolOnCooldown(pool)` (pool-memory `cooldown_until`) → `{success:false, error:"Pool on cooldown…"}` (skipped under DRY_RUN) | 1117-1120 | `deploy` |
| D5 | Load pool via failover pool (`getPool` 922-935, `SDK:DLMM.create`), `baseMint = lbPair.tokenXMint` | | 1122-1124 | |
| D6 | **Base-mint cooldown** | `isBaseMintOnCooldown(baseMint)` → `{success:false, error:"Token on cooldown…"}` | 1125-1128 | |
| D7 | Active bin & price | `pool.getActiveBin()`, `getPriceOfBinByBinId` | 1129-1131 | |
| D8 | Range derivation | (a) `downside_pct`/`upside_pct` given → bins via `getBinIdFromPrice` (downside must be <100); (b) else `bins_below ?? (targetDownsidePct ? clamp(ceil(ln(P/P·(1−t/100))/ln(1+binStep/1e4)), [minBinsBelow, min(69,maxBinsBelow)]) : defaultBinsBelow ?? minBinsBelow)`, `bins_above ?? 0` | 1133-1170 | `deploy` "Dynamic range scaling" |
| D9 | Amount | `finalAmountY = amount_y ?? amount_sol ?? computeDeployAmount(wallet.sol)` (fallback only when both null — unreachable via executor, see S17); `amount_x > 0` → throw; `≤ 0` → throw | 1174-1191 | |
| D10 | Single-side geometry | single-side & (`bins_above>0` or `upside_pct>0`) → throw; forces `activeBinsAbove=0` | 1192-1200 | |
| D11 | Integer/negative bins | throw on non-finite, negative, non-integer | 1201-1210 | |
| D12 | Width clamp | `activeBinsBelow > 69` → 69; if `below+above > 69` → `below = 69−above` | 1211-1214, 1223-1227 | `deploy` "Clamping" |
| D13 | **Range floor mirror** | `minBinsBelow = lane==="steady" && lane_min_bins ? max(35, round(lane_min_bins)) : max(35, cfg.strategy.minBinsBelow)`; `totalBins < minBinsBelow` → throw (STONK 2026-08-22 incident: without lane awareness this re-derived 69 and rejected the 60-bin lane deploy) | 1220-1232 | |
| D14 | StrategyType | `strategyMap = {spot:Spot, curve:Curve, bid_ask:BidAsk, bidask:BidAsk}`; unknown → throw | 1234-1242 | |
| D15 | **Shape override** | only if `shape != null`: `resolvedShape = lower(shape ?? cfg.strategy.defaultShape ?? "spot")` (⚠ the `?? defaultShape` fallback is dead — `shape` is non-null inside this branch); invalid → throw; `strategyType = map[shape]`, **`activeStrategy = resolvedShape`** (so the recorded `strategy` string becomes the shape) | 1257-1267 | `deploy` "Bin-distribution shape override" |
| D16 | DRY_RUN | returns `would_deploy` descriptor | 1269-1286 | |
| D17 | Bin ids | `minBinId = active − below`; `maxBinId = single-side ? active : active + above`; span `> 70` → throw; single-side must end at active bin | 1288-1305 | |
| D18 | **Bin-array init guard** | `assertRangeDoesNotRequireBinArrayInitialization` (821-872): `getMultipleAccountsInfo` on bin-array PDAs; any missing → throw ("~N × 0.07143744 SOL non-refundable"); bitmap-extension missing → throw (0.01180416 SOL) | 1307 | |
| D19 | Base fee capture | `base_fee ?? baseFactor·binStep/1e6·100` (4 dp) | 1318-1319 | |
| D20 | Lamports | `totalY = floor(finalAmountY·1e9)`; X decimals via `getParsedAccountInfo` (unused for single-side) | 1321-1327 | |
| D21 | Relay branch | dead (`shouldUseLpAgentRelayForDeploy()` = false) | 1329-1541 | |
| D22 | **Send** | `isWideRange = totalBins > 69` (unreachable after D12 clamp ⚠ dead path in practice): wide → `createExtendedEmptyPosition` (signers `[wallet,newPosition]` on tx0) then `addLiquidityByStrategyChunkable({slippage:10})`, cleanup via `pool.closePosition` on add failure; standard → `initializePositionAndAddLiquidityByStrategy({slippage:1000 bps = 10%})` signed `[wallet, newPosition]`, label `deploy:initAndAdd` | 1562-1632 | `deploy` |
| D23 | Gas | `deploy_gas_sol = Σ fetchTxFeeLamports / 1e9` | 1634-1635 | |
| D24 | Track | `invalidatePositionPnlCache`, `trackPosition({… amount_sol:finalAmountY, initial_value_usd: finalAmountY·getSolPriceUsd() (fallback caller estimate), signal_snapshot (darwin), entry_*, fee_efficiency, organic_momentum, token_age_hours, lazy, gas_cost_sol, scout, probe, entry_price_change_pct, lane})`; `requestPositionDiscovery("local deploy")` | 1638-1684 | |
| D25 | Decision log | `appendDecision({type:"deploy", actor:"SCREENER", intel_score, metrics:{…gas_cost_sol}})` | 1697-1722 | |
| D26 | Failure recovery | on throw: `recoverLandedDeploy({positionPubkey…})` (1006-1048): sleep 4 s, force `getMyPositions`, match by pubkey, `adoptOrphanPosition(match,{reason:"post-failure deploy verification", extra:{scout,…}})` → returns `success:true, recovered_after_error:true` | 1746-1792 | `deploy_error`, `deploy` "Recovered orphaned deploy" |

Result object (1724-1745): `{success, position, pool, pool_name, bin_range{min,max,active}, price_range, range_coverage{downside_pct,upside_pct,width_pct,active_price}, bin_step, base_fee, strategy, wide_range, amount_x, amount_y, txs[], gas_cost_sol}`. Executor post-hook: `notifyDeploy` (executor.js:1489-1509) enriched from the tracked row.

---

## 4. Position sizing — every input in order

1. **`computeDeployAmount(walletSol)`** (config.js:1001-1010):
   `deployable = max(0, walletSol − gasReserve)`; `dynamic = deployable·positionSizePct`; `result = min(maxDeployAmount, max(deployAmountSol, dynamic))`, 2 dp.
   Inputs: `cfg.management.gasReserve` (code 0.05; CLAUDE.md table 0.2 ⚠), `positionSizePct` (code 0.35; **prod 0.5** since 2026-07-27), `deployAmountSol` floor (code 0.4; CLAUDE.md table 0.5 ⚠), `cfg.risk.maxDeployAmount` ceiling (50). Called from the screener (index.js:1700), manual `/deploy` (5331), wallet status (4337), and `deployPosition`'s unreachable fallback (dlmm.js:1178).
2. **Timing gate size-down** ×`timingSizeDownPct` (0.5) — autonomous screener only, default OFF (index.js:1711-1716).
3. **LLM may pass any `amount_y`** — the prompt gives it `deployAmount`; nothing in the executor re-derives it, only bounds it (S17–S20).
4. **Bear-debate `size_down`** halves `amount_y`/`amount_sol` **only in enforce mode** (agent.js:559-570) — prod: bear debate disabled → inert.
5. **Scout clamp** → `min(requested, max(0.05, scoutSizeSol=0.12))`; **probe clamp** → `min(requested, max(0.05, probeSizeSol=0.25))` (both OFF in prod: scout → sub-floor pools are *blocked* at V2; probe → tier request is *blocked* at S16).
6. **Floors/ceilings**: `amount ≥ max(0.1, deployAmountSol)` (or 0.05 for scout/probe); `amount ≤ maxDeployAmount`; `wallet.sol ≥ amount + gasReserve`.
7. **`minSolToOpen`** (code 0.45; CLAUDE.md table 0.55; setup.js presets 0.45/0.55/0.65): ⚠ **dead knob** — present in `config.js:459`, the `update_config` map (executor.js:874) and `definitions.js:505`, but **no runtime consumer** anywhere (`grep` over index.js/state.js/tools/*.js finds none).
8. **Rebalance re-deposit sizing** is separate (proceeds-only, §10).

---

## 5. Bins / shape / strategy resolution (who wins)

Precedence for `bins_below` at deploy time: explicit LLM `bins_below` → (if omitted) steady-lane hint `bins_below` → top-performer hint (69) → `cfg.strategy.defaultBinsBelow` → `minBinsBelow` (executor S4/S5/S8, dlmm D8). `downside_pct`/`upside_pct` short-circuit everything (D8a) and also bypass the executor's integer/floor checks S8–S10 (they are gated on `downside_pct == null`), ⚠ leaving only dlmm's D13 total-bins floor as protection.

Playstyle → range (config.js:53-79): `PLAYSTYLE_PRESETS = {tight:{35,45}, balanced:{35,69}, wide:{60,69}, single_account:{45,69}}`; explicit `minBinsBelow`/`maxBinsBelow`/`binsBelow`/`defaultBinsBelow` in user-config win; everything is clamped to `[MIN_SAFE_BINS_BELOW=35, MAX_SAFE_BINS_BELOW=69]` at load (config.js:73-79) and again on `update_config` (executor.js:1017-1024, 1122-1134). ⚠ CLAUDE.md states `wide {60,110}` and "`maxBinsBelow` 120 → 90 in prod (Phase 3)": with `MAX_SAFE_BINS_BELOW = 69` in the current code any such value is **clamped to 69 on load**, so the documented prod width of 90 cannot be in effect unless the VM runs older code. The `isWideRange > 69` deploy path (D22) is likewise unreachable.

Steady-lane floor relaxation: executor computes `minBinsBelow = max(35, laneHint.min)` and passes `lane_min_bins` so dlmm D13 uses the same floor (prod lane preset `single_account` → 45).

Strategy vs shape: `strategy` (LLM or `cfg.strategy.strategy`, code default `bid_ask`) picks the StrategyType; a non-null `shape` (spot|curve|bidask) **overrides** it and is what gets recorded as `strategy` on the position/perf record (D15). `cfg.strategy.defaultShape` ("spot") is only consulted by hint fill-ins at screening; inside `deployPosition` the `?? defaultShape` is unreachable. Top-performer/steady-lane hints fill `shape` when omitted (S4/S5). `rebalance_position` resolves `target_strategy` separately: `curve` default, `spot`/`spot_balanced` → Spot, `bid_ask` → BidAsk (dlmm.js:4353-4358).

---

## 6. Transaction pricing, send and confirm

- **Connection**: primary `RPC_URL` (`getConnection` dlmm.js:108-117) with `RPC_CONNECTION_OPTIONS = {commitment:"confirmed", disableRequestBatching:true, disableRetryOnRateLimit:true}` (rpc.js:24-28). Close sends use `closeConnection = cfg.management.closeSendsViaPrimaryRpc !== false ? getConnection() : poolConnectionCache[pool].connection` (dlmm.js:3473-3478; default **true**, ships ON). Deploy/claim/compound/rebalance always send via `getConnection()`.
- **Urgency**: `urgencyForLabel(label)` (dlmm.js:299-305): labels starting `close:` or `flip:` → `"exit"`, everything else (`deploy:*`, `claim:*`, `rebalance:*`) → `"normal"`. ⚠ `rebalance:removeLiquidity`/`rebalance:closeEmpty` are liquidity removals priced at the *normal* tier.
- **`getDynamicPriorityFee(urgency, lockedWritableAccounts)`** (dlmm.js:203-250): exit tier requires `cfg.tx.exitPriorityFeeEnabled` (else falls to normal); normal requires `cfg.tx.enablePriorityFees` (default true) else 0. Cache key `${urgency}:${firstWritableAccount|global}`, TTL 30 s, ≤16 entries. `conn.getRecentPrioritizationFees({lockedWritableAccounts})` → `computePriorityFee(fees, opts)` (189-201): positive fees sorted, `idx = min(n−1, floor(n·p))`, `min(round(base·multiplier), cap)`. Tiers: **normal** p50 × `priorityFeeMultiplier` (1.2) cap `maxPriorityFeeMicroLamports` (1 000 000); **exit** p75 × `exitPriorityFeeMultiplier` (1.5) cap `maxExitPriorityFeeMicroLamports` (3 000 000 µL/CU ≈ 0.0042 SOL worst case at the SDK's 1.4M CU ceiling — comment dlmm.js:126-141). On fetch error returns stale cache or 0 (log `tx_priority`). Evidence: the `lockedWritableAccounts` arg was missing 2026-06-22 → 2026-08-19 so the bot paid base fee only (comment 210-214; memory note 28598b8).
- **`prependPriorityFee(tx, urgency, override)`** (255-278): legacy `Transaction` only (VersionedTransaction skipped — i.e. Jupiter swaps are never re-priced); finds an existing `SetComputeUnitPrice` ix by discriminator 3 and **replaces** it, else `unshift`. Log `tx_priority` "Set priority fee (urgency): N µL".
- **`sendAndConfirmWithRetry(conn, tx, signers, label, maxRetries)`** (307-392): `retries = maxRetries ?? cfg.tx.txMaxRetries ?? 2`. Attempt loop 0..retries: on retry, first `getSignatureStatuses([lastSig])` — if the prior broadcast already confirmed/finalized, **return it without resubmitting** (non-idempotent close/claim protection, log `tx_retry`); new blockhash; if exit tier & enabled: `bumped = min(round(max(fee, EXIT_RETRY_FLOOR 10 000 µL)·1.5^attempt), exit cap)` replaced in place; `sendAndConfirmTransaction`; then `fetchTxFeeLamports(conn, txHash, {attempts:4, delayMs:800})` (280-297, floor 5000 lamports; log `tx_gas` when floor returned). Retryable errors only: `TransactionExpiredBlockheightExceededError`, "Blockhash not found", "block height exceeded"; back-off `1500·(attempt+1)` ms. Non-retryable → `recordError("tx_failed")` and rethrow with `e.confirmedSignature = lastSig` for recovery paths (used by D26).
- **Slippage on SDK adds**: 10% everywhere (`slippage:1000` bps standard deploy/compound/rebalance; `slippage:10` % on chunkable wide path).
- **Gas estimators** (dlmm.js:399-472), all `perTx = 5000 + cachedPriorityFeeValue("normal")`: `estimateCycleGasCost` = (1|3)+3+1 txs; `estimateCompoundGasCost` = 2 txs; `estimateExitGasCost` = 1+3+1 = 5 txs. `cachedPriorityFeeValue` (156-165) = freshest **normal**-tier cache entry, 0 when nothing cached.
- **Jupiter swaps** (`swapToken`) are `VersionedTransaction`s signed locally and executed by Jupiter's `/execute`; priority fee is Jupiter's; gas looked up post-hoc via a *fresh* `Connection(RPC_URL)` + `fetchTxFeeLamports` (wallet.js:604-613).

---

## 7. `claim_fees` path

`toolMap.claim_fees = claimFeesWithCompoundGate` (executor.js:473-514, mapping at 537). Order: `estimateCompoundGasCost()`; `peekUnclaimedSolFees` (dlmm.js:2803-2822: read-only `pool.getPosition`, `feeY` lamports, 0 if token Y ≠ SOL or on error); `shouldCompound({fees, gas, min_multiple:feeCompoundMinMultiple 5, min_fees_sol:feeCompoundMinFeesSol 0.01})` (dlmm.js:487-499: `fees ≥ max(floor, multiple·gas)`). `feeCompoundEnabled` false (prod) → log `[FEE_COMPOUND_SHADOW] would compound …` when true, then plain `claimFees`. When ON and gate passes → `compoundFees` (dlmm.js:2958-3102): claim (`claim:fees`) → `recordClaim(full)` → `addLiquidityByStrategy({totalX:0, totalY:feeY, strategy within existing bins, slippage:1000})` (`claim:compoundAdd`) → `recordClaimReinvested` → `addGasToPosition`; degrades to plain claim on failure.

`claimFees` (dlmm.js:2870-2926): DRY_RUN short-circuit; closed row → error; clears pool cache; `valueClaimableFees` (2835-2868, Jupiter prices, SOL+USD) **before** `claimSwapFee` (claim zeroes them); sends each tx `claim:fees` (normal tier); `recordClaim(position,{sol,usd})` (state.js:1541-1549 sets `last_claim_at`, claim ledger, note). Returns `{success, position, txs, base_mint, asset_mints[X,Y], gas_cost_sol}`. Executor post-hook: if `cfg.management.autoSwapAfterClaim` (default **false**) swap every non-SOL `asset_mints` via `swapBaseToSolWithRetry(mint,"after claim")` (executor.js:1653-1663). Mechanical trigger: management-cycle CLAIM rule (`minClaimAmount` 5, index.js:802-812).

---

## 8. Close path

### 8.1 Callers and urgency
- Mechanical: `executeManagementActions` CLOSE branch (index.js:755-785) passes `{position_address, reason, urgent: act.urgent===true, exit_context}`; `urgent` is `URGENT_EXIT_ACTIONS.has(exit.action)` (index.js:718: **STOP_LOSS, PROFIT_RATCHET, YOUNG_STOP, CRASH_FASTPATH, RUG_FASTPATH, TOXIC_CONVERSION** — ⚠ CLAUDE.md lists five; `TOXIC_CONVERSION` is a sixth) or `urgent:true` on the mgmt-cycle RULE_1 stop-loss (index.js:3766). Poller-confirmed exits build the same map (index.js:3195-3200). Close-efficiency gate runs before TRAILING_TP enters the map (index.js:1050-1058, 3607-3712; shadow unless `closeEffGateEnabled`).
- RPC back-off for failed mechanical closes: `_closeRetryState` exponential (`CLOSE_RETRY_INITIAL_MS`…`CLOSE_RETRY_MAX_MS`) on `/429|too many requests|rate.?limit|rpc/i` (index.js:757-782, log `[CLOSE_BACKOFF]`).
- Operator: `/close`, `/closeall` → `operatorOverride:true` (index.js:6167, 6215) → `isManual` inside dlmm. LLM MANAGER: plain `close_position` (hold guard applies).
- Flip/rebalance failure fallbacks call `close_position` with `flip-failed→close:`/`rebalance-failed→close:` reasons (index.js:808, 843).

### 8.2 `closePosition` → `closePositionUnchecked` (dlmm.js:3125-3992), execution order (local path; relay path 3157-3465 is gated by `lpAgentRelayEnabled=false`)

| # | Step | Detail | Lines | Log |
|---|---|---|---|---|
| C0 | Concurrency guard | `_closesInFlight` Set per position → `{success:false, error:"A close … already in progress"}` | 3123-3136 | |
| C1 | Hold guard (2nd copy) | `hold_mode===true && !_operator_override` → blocked | 3140-3145 | `safety_block` |
| C2 | DRY_RUN | `would_close` | 3146-3148 | |
| C3 | Snapshot | `preCloseCachedPos` from `_positionsCache`; `isManual = _operator_override===true` | 3151-3153 | |
| C4 | Pool lookup | `lookupPoolForPosition` (state → cache → `SDK:DLMM.getAllLbPairPositionsByUser` via pool); `getPoolMetadata` (datapi `/pools/<addr>`) | 3158-3159 | `close` |
| C5 | Fresh pool + send connection | clear `poolCache`/`poolConnectionCache`; `getPool` (failover read); `closeConnection` per `closeSendsViaPrimaryRpc` | 3468-3478 | `close` "Close RPC (reads): … sends via …" |
| C6 | Existence check | `pool.getPosition` null / "not found"/"does not exist"/"owned by a different program" → `alreadyClosed=true` (skip C7–C8) | 3486-3500 | `close` |
| C7 | **Step 1 — claim** | `recentlyClaimed = last_claim_at < 60 s ago`; `fastSkipClaim = (urgent && cfg.management.fastCloseSkipClaim===true) || isManual || skip_claim`; urgent && !fastSkip && !recentlyClaimed → `[FAST_CLOSE_SHADOW] would-skip`. Skip if any of the three; else `claimSwapFee` txs sent with label **`close:claimFees`** (exit tier). Errors swallowed (`close_warn`). | 3503-3542 | `fast_close_shadow`, `close` |
| C8 | **Step 2 — remove & close** | read `positionData` for `lowerBinId/upperBinId` + `hasLiquidity` (any `positionLiquidity>0`); with liquidity → `removeLiquidity({fromBinId,toBinId,bps:10000,shouldClaimAndClose:true})` label `close:removeLiquidity`; else `pool.closePosition` label `close:emptyAccount`. Gas summed into `closeGasLamports`. `onProgress` callbacks for Telegram live message. | 3545-3591 | `close` |
| C9 | Telemetry + settle | `[EXIT_TELEMETRY] phase=tx_confirmed` (TRAILING_TP only, `logExitTelemetry` 3104-3116); sleep 2 s unless manual/skip_swap; cache invalidation | 3593-3610 | `exit_telemetry` |
| C10 | **On-chain confirm** | `closeConnection.getAccountInfo(position) === null` → confirmed; else verify loop (`isManual ? 2×1 s : 4×3 s`) mixing `getAccountInfo` and `getMyPositions({force:true})`; then a **final authoritative** `getAccountInfo` — if the account still exists → return `{success:false, status:"close_unconfirmed"}` and **do not** record anything | 3614-3666 | `close_warn` |
| C11 | `recordClose(position, reason)` (state.js:1628-1638: `closed=true, closed_at, close_reason`, event `close`); `invalidatePositionDiscovery`; `requestPositionDiscovery("local close")` | | 3668-3670 | `state` |
| C12 | **Realized PnL (datapi)** | `maxClosedAttempts = isManual ? (preCloseCachedPos ? 0 : 1) : (urgent ? 1 : 6)`, sleep `isManual||urgent ? 1000 : 5000` ms, fetch timeout 2.5 s. Per hit: `pnlTrueUsd = pnlUsd`, `pnlSol = pnlSol ?? pnl.valueNative`, `pnlPct = solMode ? pnlSolPctChange : pnlPctChange` (fallback pnl/deposit), `finalValueUsd = allTimeWithdrawals.total.{sol|usd}`, `initialUsd = allTimeDeposits…`, `feesUsd = allTimeFees…`, dual `*_true` fields. **Reject** if `pct ≤ −90` and reason lacks "stop loss" (`shouldRejectClosedPnl` 3682-3689). `realizedPnlSource="closed_api"`. | 3703-3748 | `close` "Closed PnL from API: …", `close_warn` |
| C13 | Cache fallback | if `finalValueUsd===0`: use `preCloseCachedPos` (`pnl_true_usd`, `pnl_sol`, `pnl_pct`, fees = collected+unclaimed true USD; `finalValueUsd = max(0, initial + pnlTrue − fees)`), `realizedPnlSource="cache_fallback"` | 3750-3775 | `close_warn` "Using cached pnl fallback" |
| C14 | **Adoption basis rebase** | only when `realizedPnlSource==="closed_api"` and `tracked.adoption_basis`: `applyAdoptionBasis` (state.js:892-934): `pnl_sol = (lifetime.pnl_sol − basis.pnl_sol) − capitalAtAdoption` where `capitalAtAdoption = amount_sol > 0 ? amount_sol : basis.deposits − basis.withdrawals`; `capital = capitalAtAdoption + max(0, lifetimeDeposits − basisDeposits)`; `pnl_pct = pnl_sol/capital·100`; fees/USD rebased likewise; under solMode the legacy fields are rebased too. Returns `lifetime{pnl_sol, pnl_usd_true, fees_sol_true, deposit_sol_true, basis_at, basis_pnl_sol}` → `adoption_lifetime`. (Identity fixed b069ac2 after GO-SOL +101% mis-booking.) | 3777-3800 | `close` `[ADOPTION_BASIS]` |
| C15 | `[EXIT_TELEMETRY] phase=realized`; `updateClosedPositionPnL(position, pnlPct, pnlUsd, feesUsd, pnlSol, pnlTrueUsd)` (state.js:3271-3288: `exit_pnl_pct/usd/sol/true_usd`, `total_fees_claimed_usd`) | | 3802-3810 | `state` |
| C16 | Signal snapshot + exit market | `resolvePerformanceSignalSnapshot`; discovery-API GET for `exit_mcap/exit_tvl/exit_volume` (non-blocking) | 3812-3832 | |
| C17 | **`recordPerformance({...})`** — see §11 for every field | | 3834-3899 | `lessons` |
| C18 | `appendDecision({type:"close", actor:"MANAGER", metrics:{pnl_usd, pnl_pct, fees_usd, minutes_held, gas_cost_sol, total_gas_sol, net_pnl_sol}})` | | 3901-3920 | |
| C19 | Return | `{success, position, pool, pool_name, claim_txs, close_txs, txs, pnl_usd, pnl_sol, pnl_pct, deployed_usd, deployed_sol, fees_usd, pnl_usd_true, deployed_sol_true, deployed_usd_true, fees_sol_true, fees_usd_true, peak_pnl_pct, hold_time, strategy, reason, base_mint, asset_mints[X,Y], gas_cost_sol, total_gas_sol}` | 3922-3948 | |
| C20 | Untracked position | no `tracked` row → decision log only, minimal return (no perf record) | 3951-3970 | |

### 8.3 Executor post-close hooks (executor.js:1510-1651, in order)
1. `classifyOutcome({pnl_pct, fees_earned_usd: fees_usd, initial_value_usd: deployed_usd, close_reason})` for the emoji (lessons.js:939-960).
2. `notifyClose(...)` — dual-currency aware (solMode → legacy `*_usd` carry SOL), includes gas, peak, thesis/confidence from the tracked row (1524-1551).
3. Low-yield pool note: `args.reason` contains "yield" → `addPoolNote` (1552-1555).
4. **Auto-swap** unless `args.skip_swap`: `swapBaseToSolWithRetry(result.base_mint, "after close")` (1557-1559) — §8.5. On `skipped_high_impact` sets `result.auto_swap_note` telling the LLM not to re-sell (1560-1565). On `swapped`: `result.auto_swapped=true`, `sol_received`; then **`recordExitSwapOutcome(position, {sol_received, gas_sol, market_usd: token.usd, value_usd: solReceived·sol_price})`** (1575-1587 → lessons.js:293-339, §11); `notifySwap` with slippage vs mark (1596-1606); `[SWAP_FREE_SHADOW]` line when `swapFreeRedepositEnabled` is false (1614-1623); ATA rent reclaim after 2 s via `closeEmptyTokenAccount` (1628-1641, `result.rent_reclaimed_sol = 0.002`).
5. Extra `asset_mints` (non-SOL, ≠ base) swapped too (1645-1651).
6. Socket resync (1682-1690).
7. **Index.js maintenance** after the cycle (`runPostCloseMaintenance` index.js:689-699): `runPostCloseProbes()` when `postCloseProbeEnabled` (default true) — scan perf records newer than `max(probeMinutes)+60` min, fill `post_close.m30/m60/m180` via `getPoolDetail(pool,"5m")` mcap, `stale` if `ageMin ≥ m+20`, `delisted` on fetch error (649-686; log `probe`); then `sweepWalletDust()` when `dustSweepEnabled` and (`closedCount>0` or `_mgmtCycleCount % 10 === 1`).

### 8.4 Fields the LLM/notify rely on from the close result
`pnl_sol`, `pnl_usd_true`, `deployed_sol_true`, `fees_sol_true` are the honest dual-currency fields; `pnl_usd`, `deployed_usd`, `fees_usd` carry SOL under `solMode` (prod true) — the CLAUDE.md unit landmine.

### 8.5 `swapBaseToSolWithRetry(baseMint, label)` (executor.js:1219-1312)
- `attempts = max(1, autoSwapRetryAttempts 3)`, `delayMs = autoSwapRetryDelayMs 3000`.
- Each attempt: `getWalletBalances({})`; `token.usd < 0.10` → done (nothing to swap).
- **Exit-swap guard** (attempt 1 only, 1235-1277): `maxImpact = exitSwapMaxImpactPct (5)`; only when `token.usd ≤ dustSweepMaxUsd (25)`; `quote = getSwapQuote({input:baseMint, output:"SOL", amount:token.balance})`; `impactPct = (token.usd − out_amount/1e9·sol_price)/token.usd·100`; `> maxImpact` → if `exitSwapGuardEnabled` (default false) log `[EXIT_SWAP_GUARD] skipping …`, `recordDeferredExitSwap(mint,{usd,impact_pct,label})` and return `{swapped:false, skipped_high_impact:true, impact_pct}`; else `[EXIT_SWAP_GUARD_SHADOW] would skip …`. Fail-open on quote error.
- **Slippage cap** (1280-1291): `cap = swapSlippageCapBps (500)`, only when `token.usd ≤ dustSweepMaxUsd`; enabled (default false) → `capBps=cap`, else `[SLIPPAGE_CAP_SHADOW] would cap …` on attempt 1. Balances above 25 USD always keep RTSE.
- `swapToken({…, slippage_bps: capBps})`; success = `success!==false && !error && (tx || amount_out)`; on success `clearDeferredExitSwap(mint)`. Failure → `executor_warn` and retry; final failure `executor_warn` "base token left unsold".

### 8.6 `sweepWalletDust()` (executor.js:1324-1415)
Gated by `dustSweepEnabled` (true). For each wallet token: skip SOL/USDC; skip mints with an OPEN tracked position **unless** in `getDeferredExitSwaps()` (guard-deferred remainders, the CATE 2026-07-27 fix); skip `usd < dustSweepMinUsd (0.25)`; skip `usd > dustSweepMaxUsd (25)` (→ `skipped_large`); `swapBaseToSolWithRetry(mint,"dust sweep")` (so the guard + cap apply again); `closeEmptyTokenAccount` after 2 s. Telegram "🧹 Dust swept". Janitor pass: `listEmptyTokenAccounts()` → close up to 5 empty ATAs not belonging to open mints (log `[DUST] reclaimed N empty ATA(s)`). Never throws (`executor_warn`).

---

## 9. `swap_token` (LLM/manual)
`runSafetyChecks` case `swap_token` → always `{pass:true}` (executor.js:2029-2033; DRY_RUN handled inside `swapToken`). `swapToken` (wallet.js:506-637): decimals via `getParsedAccountInfo`; `/order` with `taker` + referral, `slippageBps` only when the caller passes a finite positive `slippage_bps` (the LLM schema exposes none → RTSE); sign `VersionedTransaction`; `/execute`; `status==="Failed"` → throw; warns if `order.feeBps` ≠ requested referral fee; returns `{success, tx, amount_in, amount_out, referral_*, fee_bps_applied, fee_mint, gas_cost_sol}`. Executor post-hook `notifySwap` (1481-1488).

---

## 10. `rebalance_position`

**Safety case** (executor.js:2001-2027), in order: operator override (`_operator_override===true`) → `{pass:true}` skipping everything (log `[REBALANCE_GATE] operator override`); not tracked → block; `tracked.closed` → block; `rebalance_count ≥ rebalanceMaxCount (2)` → block "Rebalance chain depth …"; `validateDeployPoolThresholds({pool_address: tracked.pool})` (full V0–V9 re-validation) fails → block "Rebalance refused — pool no longer passes deploy validation".
Also the `executeTool` hold guard (1444-1451) and the mechanical engine is `rebalanceMode` **"shadow"** by default (config.js:733) → decision points log `[REBALANCE_SHADOW]` and take the ordinary close path (index.js:1079-1090 for the round-trip roll-up).

**`rebalancePosition`** (dlmm.js:4154-4471), order: hold guard (4163-4167); bins normalisation `bBelow+bAbove ≤ 69`, two-sided extreme-skew (`≥50` total and either side `<10`) → reset to `[35,34]` (4170-4189, log `rebalance_warn`); DRY_RUN (4191-4205); `lookupPoolForPosition`, `getPool`, `getPosition` (4210-4222); pre-close valuation from `_positionsCache` or pool-memory snapshot (4225-4246); **proceeds-only snapshot**: `preSol`, `preX` (wallet base balance), `rootSolPre = resolveRootInitialBasis(tracked).sol || root_initial_sol || amount_sol`, `preValueSol` (solMode `total_value_usd`); **refuse** when neither root basis nor pre-close value > 0 (4251-4267); Step 1 `removeLiquidity({bps:10000, shouldClaimAndClose:true})` label `rebalance:removeLiquidity` (normal tier) or `closePosition` `rebalance:closeEmpty` (4269-4297); sleep 4 s; Step 2 balances: `tokenXAmount = max(0, balance − preX)`; SOL: `maxAvailable = sol − gasReserve`, `legProceeds = solDelta > 0 ? solDelta : preValueSol`, `capSol = rootSol > 0 ? min(rootSol, legProceeds) : legProceeds`, `quoteAmount = min(maxAvailable, capSol)` (4303-4342, log `rebalance` "Rebalance sizing (proceeds-only)"); both zero → error; Step 3 `[active−bBelow, active+bAbove]`, single-sided edge cases collapse to one side with `min(69, bAbove+bBelow)` (4349-4366); `initializePositionAndAddLiquidityByStrategy({slippage:1000})` label `rebalance:initAndAdd` signed `[wallet, newPosition]` (4376-4392); `rebalancePositionState` (state.js:709-806: old row closed with exit_* snapshot, new row tracked with `rebalance_count+1`, `parent_position`, `root_parent_position`, `root_initial_sol/usd`, cumulative fees carried) (4396-4413); decision log; `requestPositionDiscovery`; **fire-and-forget `recordRebalanceLegPerformance`** (dlmm.js:2087-2178: dedup by position in `getAllPerformance`; `fetchClosedPositionPnl(retries 6, 5 s)`; adoption basis applied; `close_reason: "rebalance: <reason>"`, `rebalance_leg:true`, `rebalanced_into`, `gas_cost_sol`, `total_gas_sol`, `recorded_at: closed_at`) (4438-4447, log `[REBALANCE_LEG]`). Executor post-hook `notifyRebalance` (1664-1679).

---

## 11. Performance record — every field written

`recordPerformance(perf)` (lessons.js:115-291) receives the object below from the main close (dlmm.js:3834-3899; relay variant 3354-3418 lacks gas/adoption/rebalance fields), the rebalance leg (2122-2176) and external reconciliation (2241-2296), then **derives** and stamps more. Two guards drop the record entirely: `suspiciousUnitMix` (`initial ≥ 20 && amount_sol ≥ 0.25 && 0 < final ≤ 2·amount_sol`, log `lessons_warn`) and `suspiciousAbsurdClosedPnl` (`initial ≥ 20 && pnl_pct ≤ −90 && !stop loss`).

| Field | Source | Notes |
|---|---|---|
| `position`, `pool`, `pool_name`, `base_mint` | close path | `base_mint = lbPair.tokenXMint` |
| `asset_profile`, `strategy`, `management_profile`, `bin_range`, `bin_step`, `volatility`, `fee_tvl_ratio`, `fee_efficiency`, `organic_momentum`, `organic_score` | tracked row | `strategy` = shape string when a shape was used |
| `amount_sol` | tracked | |
| `pnl_sol` | datapi `pnlSol` (or cache fallback), **rebased** by adoption basis | SOL, market-priced pre-swap |
| `pnl_usd_true`, `fees_sol_true`, `fees_usd_true`, `deposit_sol_true`, `deposit_usd_true` | datapi `allTime*` (rebased) | never solMode-dependent |
| `scout`, `probe`, `adopted`, `lane` | tracked flags | `undefined` when false (omitted) |
| `range_width_bins` | `max − min + 1` | |
| `entry_price_change_pct`, `entry_mcap`, `entry_tvl`, `entry_volume`, `entry_holders` | executor capture at deploy | |
| `adoption_lifetime` | `applyAdoptionBasis().lifetime` or null | `{pnl_sol, pnl_usd_true, fees_sol_true, deposit_sol_true, basis_at, basis_pnl_sol}` |
| `rebalance_count`, `parent_position` | tracked | leg records add `rebalance_leg:true`, `rebalanced_into` |
| `mfe_pnl_pct`, `mae_pnl_pct`, `max_bins_below`, `max_bins_above`, `peak_pnl_pct` | poller tracking on the row | |
| `twap_guard_deferrals_total` | tracked | |
| `fees_earned_usd`, `final_value_usd`, `initial_value_usd` | datapi (SOL under solMode) | inputs to derived `pnl_usd` |
| `minutes_in_range`, `minutes_held` | `now − deployed_at`, minus `out_of_range_since` | ⚠ `minutes_in_range` subtracts only the *current* OOR stint |
| `close_reason` | caller reason or "agent decision" | reason-family keywords drive `classifyOutcome`/exit-quality |
| `signal_snapshot` | `resolvePerformanceSignalSnapshot` | rebuilt via `buildSignalSnapshot` in recordPerformance |
| `deploy_confidence`, `bear_debate` | tracked (attachDeployVerdicts) | |
| `gas_cost_sol` | close gas | `total_gas_sol = (tracked.total_gas_sol ?? gas_cost_sol ?? 0) + close gas` |
| `exit_mcap`, `exit_tvl`, `exit_volume` | discovery API at close | `exit_mcap` null → probes mark `unprobeable` |
| **derived in recordPerformance** | | |
| `pnl_usd` | `(final + fees) − initial` (2 dp) | SOL under solMode |
| `pnl_pct` | `pnl_usd/initial·100` (2 dp), 0 if initial ≤ 0 | ⚠ **recomputed**, not the datapi `pnlPct` passed in — the adoption-rebased `pnlPct` computed at C14 is *not* what lands here; under solMode the rebased legacy fields (`initialUsd = depSolTrue`, `finalValueUsd = initial + pnlSol − fees`) make it agree by construction |
| `pnl_sol_net` | `pnl_sol − (total_gas_sol ?? gas_cost_sol ?? 0)` (6 dp) | later amended |
| `unit_era` | `"v3"` | |
| `range_efficiency` | `minutes_in_range/minutes_held·100` | |
| `recorded_at` | `perf.recorded_at || now` | rebalance leg/external use datapi `closedAt` |
| **amended later** | | |
| `exit_swap {sol_received, gas_sol, market_usd, value_usd, slippage_usd}`, `pnl_usd_net_exit_swap`, `exit_slippage_sol`, `pnl_sol_net` (recomputed `pnl_sol − gas − slippageSol`) | `recordExitSwapOutcome` (lessons.js:293-339) | `slippageSol = slippage_usd / (value_usd/sol_received)` |
| `post_close {exit_mcap, m30, m60, m180: {mcap, pct, at | status}, complete, exit_quality, exit_review_*}` | `recordPostCloseProbe` (lessons.js:410-448) | |
| `external_close`, `external_close_source` | reconciliation only | |

Side effects of `recordPerformance`: `derivLesson` → lessons; `recordPoolDeploy(pool, {… pnl_pct, pnl_usd, fees_earned_sol (⚠ never passed by closePosition → null), fee_earned_pct, close_reason, gas_adjusted_pnl_sol …})` (pool-memory.js:123-280) which sets **cooldowns** consumed by D4/D6: `close_reason === "low yield"` (exact match ⚠ mechanical reasons are longer strings, so this branch rarely fires) → 4 h pool cooldown; last `oorCooldownTriggerCount` (3) deploys all OOR-below → `oorCooldownHours` (12) pool + mint; `repeatDeployCooldownEnabled` (true) last 3 fee-generating (or, with `repeatDeployCooldownLosersOnly`, non-success) deploys → 12 h on scope `token` (default) / `pool` / `both` (`[REPEAT_COOLDOWN_SHADOW]` when they differ); avg `gas_adjusted_pnl_sol < 0` over last ≥2 → 6 h. Also every 5th record → `evolveThresholds` unless `evolutionEnabled===false` (prod false), Darwin weights, hive push, circuit-breaker check.

---

## 12. `getWalletBalances` / AUM (wallet.js:175-421)
`fetchRpcWalletSnapshot` (63-127): `getBalance` + `getParsedTokenAccountsByOwner` for SPL and Token-2022 via the failover pool; wrapped SOL merged into SOL; Jupiter prices; `recoverableRentSol` = Σ token-account lamports. Then positions via `getMyPositions({force: freshPositions})` + fresh discovery extras (≤2 min old); `deployed`/`unclaimed` summed in SOL or USD per `solMode`; position rent measured with `getMultipleAccountsInfo` in chunks of 100 (fallback 0.065 SOL each); held tokens; `total_sol = idle + deployed + unclaimed + rent + recoverableRent + heldTokensSol`; `total_usd = data.totalUsdValue + deployed + unclaimed + rent + recoverableRent` (held tokens already inside `totalUsdValue`). Returns `{wallet, sol, sol_price, sol_usd, usdc, tokens[{mint,symbol,balance,usd}], aum{…}, total_usd}`. Single attempt (`maxRetries = 1`).

## 13. `tools/pnl.js` — lifetime fields
`buildPositionsFromMap` emits per position (pnl.js:975-1015) the `*_usd` (SOL under solMode) / `*_true_usd` pairs plus raw Meteora **`lifetime_deposits_sol/usd`, `lifetime_withdrawals_sol/usd`, `lifetime_fees_sol/usd`** (1003-1008, no fallback substitution) — consumed by `buildAdoptionBasis(p)` (state.js:859-884: null when `deposits_sol ≤ 0`, `pnl_sol = withdrawals + fees − deposits`) at `adoptOrphanPosition` Case B (state.js:1085). `computePositions` (1170-1212): discovery mode → Helius `getProgramAccountsV2` scan; otherwise reads only tracked accounts via `getMultipleAccountsInfo`.

## 14. RPC failover pool (`tools/rpc.js`)
Per-node state (200-243): circuit (5 consecutive errors → open 60 s; force-reset the oldest when all are open), rate-limit back-off 30 s·2^n up to 1 h (`markRpcRateLimit` 623-640; quota-exceeded phrases → 1 h + `isQuotaExceeded`), capability failures (-32601/-32602 or HTTP 400/401/403/404) → method (or endpoint for 401/403/unknown method) blocked 30 min (612-621), 15 s per-call timeout, latency window 20. `callRpcWithConnection` (710-839): sort by `healthScore` (rate-limited/quota nodes last), filter available, **round-robin among healthy Helius nodes first**, then healthy non-Helius, then degraded; back-off `min(1000·2^(i−1), 10000)` ms between nodes; error telemetry `rpc_429`/`rpc_timeout`/`rpc_other`. Two pools: `standard` (Helius keys + non-Helius fallbacks + public) and `indexed` (Helius-only, for `getProgramAccountsV2`). **Not** used for any transaction send (see §0).

## 15. `update_config` (executor.js:620-1195) — execution-relevant behaviour
Flat key → `[section, field(, nested|persistPath)]` map (622-999); case-insensitive; bins keys clamped to `[35,69]` (1017-1024); `rebalanceBinsBelow/Above` clamped `[1,69]` (1026-1032); `outOfRangeWaitMinutes*` accept literal `null` (1034-1045); `playstyle` resolves preset min/max/default unless bins given in the same call (1063-1077); `timeframe` auto-scales `minFeeActiveTvlRatio`/`minVolume` (1092-1101); applied live then persisted to `user-config.json` (GMGN keys to `gmgn-config.json`); cron restart on interval keys; `[SELF-TUNED]` lesson. Sensitive keys redacted in logs (55-70). Keys **not** tunable: `postCloseProbeMinutes`, `rangeHarvestPools`, `crashSocketMode`, `topPerformerHint` widths.

---

## 16. Correlations, mirrors, contradictions, dead/inert checks

**Duplicated mirrors (must be kept in sync)**
1. Entry-TVL floor + clean-history exemption: `getRawPoolScreeningRejectReason` (screening.js:398-411, gate mode) ≡ rank-mode admission (screening.js:1688-1775) ≡ `validateDeployPoolThresholds` V2 (executor.js:152-189). Rank mode additionally requires `_intelScore.total ≥ scoutMinIntel` for scouts — the executor has **no intel bar** (it trusts admission) so a manual `/deploy` on a sub-floor pool becomes a scout with no intel check when `scoutTierEnabled` is on.
2. Range floor: executor S8/S9 (`max(35, laneHint.min | cfg.minBinsBelow)`) ≡ dlmm D13 (`lane_min_bins` | `cfg.minBinsBelow`) — but the executor passes `lane_min_bins` only for the steady lane; a top-performer hint sets `lane="top_performer"` with no `lane_min_bins`, so dlmm falls back to the global floor (consistent today because the hint width is 69).
3. Bin-step: V8 (fresh API) and S2 (LLM arg) — S2 is skipped when the LLM omits `bin_step`.
4. Velocity gates (`minVolumeTvlRatio`, `minTxPerMin`) and the steady-lane waiver exist both in screening and in V5/V6.
5. Hold-mode guard: `executeTool` (1435-1451), `closePositionUnchecked` (3140-3145), `rebalancePosition` (4163-4167), and `executeManagementActions` (index.js:747-751) — four copies, same semantics.
6. `fastCloseSkipClaim`'s "skip Step 1" path is the same code path the pre-existing `recentlyClaimed` (<60 s) and manual-close branches already take (C7).
7. Duplicate-mint guard S13 uses only `args.base_mint` while the re-entry gate S14 falls back to `poolThresholds.baseMint` — the same omission that silently disabled S14's mint arm on 2026-07-29 still disables S13.

**Checks that can contradict each other**
- V4's steady-lane waiver reads `cfg.management.minFeePerTvl24h` (default **7**) although its comment claims a 1%/day bar; the screening-side lane bar is `rankSteadyMinFeeTvl24h` (1.5). A lane-admitted pool at 2–4%/24h therefore passes screening but can be blocked at deploy unless prod overrides `minFeePerTvl24h` ⚠ (unverified on VM).
- CLAUDE.md's documented widths (`wide {60,110}`, prod `maxBinsBelow` 90, "wide > 69 → gas filter treats as wide") contradict `MAX_SAFE_BINS_BELOW = 69` clamps in config.js:73-79, executor.js:1017-1024/1771-1774 and dlmm.js:1211-1214; the >69 wide-range deploy path (dlmm.js:1562-1621) and the `isWide` gas estimate are unreachable in the current tree.
- Bear-debate `size_down` (halves the amount) can push `amount_y` below `minDeploy` (S18) → the deploy would then be SAFETY_BLOCK'd and locked for the session (only in enforce mode; inert in prod).
- `deploy_position` schema text says never pass `curve` as `strategy`, but D14 accepts it; `shape` overwrites the recorded `strategy` string, so analytics keyed on `strategy` mix "width preset" semantics with "shape" semantics after 2026-07 shape deploys.
- `recordPerformance` recomputes `pnl_pct` from `final/fees/initial` rather than trusting the datapi/rebased `pnlPct`; under `solMode` C14 rewrites the legacy fields so the two agree, but under non-solMode an adopted account's `pnl_pct` would be the unrebased USD ratio ⚠ (prod is solMode, so latent).
- `URGENT_EXIT_ACTIONS` in code includes `TOXIC_CONVERSION`; CLAUDE.md lists five actions.
- `close_reason === "low yield"` exact-match cooldown in pool-memory vs. the enriched mechanical reason strings (e.g. "low yield: fee/TVL …") — the 4 h low-yield cooldown fires only for the bare string.

**Dead / inert under prod config**
- `minSolToOpen` — no consumer anywhere (config + update_config + docs only).
- `computeDeployAmount` fallback inside `deployPosition` (dlmm.js:1176-1179) — unreachable through `executeTool` because S17 blocks a missing amount first.
- `shape ?? cfg.strategy.defaultShape` inside `deployPosition` — unreachable (`shape != null` guard).
- LPAgent relay deploy (`shouldUseLpAgentRelayForDeploy() === false`) and relay close (`lpAgentRelayEnabled` default false).
- Wide-range (>69 bins) deploy path and `estimateCycleGasCost(isWide=true)`.
- Bear debate: prod `bearDebateEnabled=false` → confidence/thesis are still extracted only when the debate runs (both live inside the `if (bearEnabled)` block, agent.js:517) → **no `deploy_confidence`/`deploy_thesis` is persisted in prod either** ⚠.
- Shadow-only in prod (log lines only): re-entry cooldown `[REENTRY_SHADOW]`, exit-swap guard `[EXIT_SWAP_GUARD_SHADOW]`, slippage cap `[SLIPPAGE_CAP_SHADOW]`, fast close `[FAST_CLOSE_SHADOW]`, fee compound `[FEE_COMPOUND_SHADOW]`, swap-free redeposit `[SWAP_FREE_SHADOW]`, close-efficiency `[CLOSE_EFF_SHADOW]`, rebalance engine `[REBALANCE_SHADOW]`, repeat-cooldown losers-only `[REPEAT_COOLDOWN_SHADOW]`, scout `[SCOUT_SHADOW]`, timing gate (off).
- Scout/probe clamps are effectively unreachable in prod (`scoutTierEnabled=false` → V2 blocks; `probeTierEnabled=false` → S16 blocks), so the only prod size controls are `computeDeployAmount` + S18/S19/S20.
- `DRY_RUN` skips S20 but not the discovery-API fetches in V0–V8.
- `autoSwapAfterClaim` default false → the after-claim swap hook is inert unless prod set it (⚠ unverified).
- CLAUDE.md config-table defaults for `deployAmountSol` (0.5), `gasReserve` (0.2), `minSolToOpen` (0.55), `stopLossPct` (prod −15) differ from code defaults (0.4 / 0.05 / 0.45 / −18); the dev `user-config.json` matches the code side for the first three. Prod values on the VM were not verifiable from this checkout.

**Evidence numbers referenced in code comments (for calibration)**
- Step 1 claim latency 2.4–5.3 s / median ~3.5 s over 13 live closes (config.js:658-660; dlmm.js:3504-3509).
- Exit-priority worst-case tip 0.0042 SOL at 3 000 000 µL × 1.4 M CU (dlmm.js:126-141); realistic <0.001 SOL.
- Priority fees effectively 0 from 2026-06-22 to 2026-08-19 (dlmm.js:210-214).
- Bin-array init cost 0.07143744 SOL each, bitmap extension 0.01180416 SOL (dlmm.js:853-868).
- Adopted-account lifetime scoring inflated the ledger by +7.66 of +8.52 SOL (Aug 22–Sep 24) (dlmm.js:3752-3755); GO-SOL +1.15% booked as +101% before b069ac2 (state.js:910-913).
- Rebalance legs: 33 chains ≈ −4 SOL net, Sep 13–24, none recorded before Plan #15 (dlmm.js:4434-4437; config.js:728-731).
- Exit-swap slippage cases: febu $1.15 on $10.66, Bison $0.92 on $5.74, brain-SOL $40.39 @ 11% quoted / 10.4% realized (executor.js:1240-1243; CLAUDE.md).
- Entry-TVL step at 100k: ≥100k n=58 zero disasters vs <100k n=217, 25 disasters (CLAUDE.md; pool-memory.js hasCleanPoolHistory rationale).
