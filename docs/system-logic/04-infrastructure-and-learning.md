# Meridian — Infrastructure, Scheduling, Data Stores, Learning Loop, External Platforms

Read-only inventory of `/Users/Angga/Repos/meridian` (branch `experimental`, HEAD `a0fcd12`, 2026-09-25). All paths relative to the repo root; `file:line` cites the local checkout. **Prod values** come from CLAUDE.md and in-code comments — the local `user-config.json` is a near-empty dev copy (only `profitRatchetEnabled`, `stopLossPct=-18`, and an `autoSkim.enabled=true` block are set), so anything marked *(prod per CLAUDE.md)* or *(prod per comment)* is not verifiable from this checkout.

---

## 1. Process topology (VM)

| PM2 app | Script | Mode | Notes | Cite |
|---|---|---|---|---|
| `meridian` | `index.js` | fork, autorestart, `restart_delay` 5s, `kill_timeout` 10s, `max_restarts` 10, `min_uptime` 10s, **`max_memory_restart: "2G"`** | env pins `LLM_MODEL=glm-5.3-flash`, `LLM_BASE_URL=https://ollama.com/v1`, `LLM_REASONING_EFFORT=low`. ⚠️ CLAUDE.md says 512M; the file says 2G. | `ecosystem.config.cjs:7-27` |
| `meridian-syncer` | `scripts/repo_syncer.js` | `cron_restart: "0 * * * *"`, `autorestart:false` | hourly `git fetch` → if behind and tree clean: `git pull` + `npm install` + `pm2 restart meridian --update-env`; if dirty: Telegram warn, no pull; diverged: Telegram warn. Also syncs `/opt/meridian-dashboard` → `pm2 restart meridian-dashboard`. Telegram via raw `sendMessage` with `parse_mode: Markdown`. | `ecosystem.config.cjs:36-46`, `scripts/repo_syncer.js:51-140,228-231` |
| `meridian-db-backup` | `scripts/db_backup.js` | `cron_restart: "17 3 * * *"` | `pg_dump -Fc -h -p -U -d -f /opt/meridian-backups/<db>-<stamp>.dump`; keeps `PG_BACKUP_KEEP` (14); Telegram OK/FAIL (Markdown). Restore: `pg_restore --clean --if-exists`. | `ecosystem.config.cjs:47-57`, `scripts/db_backup.js:28-29,76-89` |
| `meridian-watchdog` | `scripts/watchdog.js` | autorestart, `restart_delay` 10s, `max_restarts` 5 | Reads `.heartbeat` every `CHECK_INTERVAL_MS` 60s; stale > `STALE_THRESHOLD_MS` 300s → `pm2 restart meridian`; 3 restarts/30min → lock + CRITICAL alert; heap > 1500MB / loop lag > 500ms warnings deduped 30min; missing file 10× → warn. Standalone (no project imports), raw Telegram HTTPS. Touches `.telegram-marker.json` sentinel. | `ecosystem.config.cjs:58-68`, `scripts/watchdog.js:15-21,57-149` |
| `meridian-dashboard` | separate repo `/opt/meridian-dashboard`, port 3002 | — | reads Postgres directly + `dashboard-report` kv doc + `LISTEN meridian_report`/`meridian_tick`; posts closes to the bot's loopback command server. Not in this repo. | CLAUDE.md, `report.js:49-58`, `index.js:4257-4290` |
| (retired) `meridian-monitor` / `meridian-status-generator` | — | — | retired 2026-07-05 (`ecosystem.config.cjs:28-35` comment). `scripts/antigravity_monitor.py` manual only. | |

**Zabbix**: no artifacts in this repo (`grep -i zabbix` → nothing outside CLAUDE.md). `zabbix-agent2` is host-level (HomeArchitecture).

**Heartbeat contract** (`index.js:136-149`): `.heartbeat` JSON `{timestamp, cycle, pid, uptime_s, heap_mb, event_loop_lag_ms}` written by `writeHeartbeat()` from `management` (`:923`), `screening` (`:1577`), `pnl_discovery` (`:2880`), `pnl_poll` (`:2888`). ⚠️ The `pnl_poll` write is the **first statement** of the 3-second poller tick, before any busy-guard — so the heartbeat stays fresh whenever the event loop is alive, even if every cycle is wedged behind a stuck `_managementBusy`. The watchdog therefore detects only process death / event-loop hangs, not logical stalls.

**Startup order** (`index.js:154-178` isMain block; `:7064-7067` non-TTY): `envcrypt` (import side-effect, `index.js:4`) → `initState()` → `initAllDocStores()` → `normalizeAdoptedStrategies` → `syncConfiguredManagementProfiles` → `persistWalletAddress` (state_meta `walletAddress`) → `ensureAgentId` (writes `user-config.json`) → `bootstrapHiveMind` + `startHiveMindBackgroundSync` → … → `startCronJobs()` → `startPolling(telegramHandler)` → `startCommandServer()`. In a TTY the crons start only on the REPL `auto`/launch path (`:6779-6785`). `registerCronRestarter` (`:6761`) lets `update_config` restart crons when intervals change (`tools/executor.js:1170-1177`).

**Shutdown** (`index.js:3532-3569`): SIGINT/SIGTERM → `stopPolling` → `stopCronJobs` (also `stopSocketMonitor`) → command server close → 5s-bounded position snapshot → `flushState` → `flushAllDocStores` → `flushTicks` → `flushLiquidityTicks` (each 5s-bounded) → `process.exit(0)`. PM2 `kill_timeout` 10s can still abort an in-flight close (`index.js:4283-4284` comment).

**Localhost command server** (`index.js:4014-4028,4257-4290`): `http://127.0.0.1:${MERIDIAN_COMMAND_PORT||3001}`; `GET /command/health`, `POST /command/close`, `POST /command/set-hold`; optional `x-meridian-token` == `MERIDIAN_COMMAND_TOKEN`; waits up to `COMMAND_BUSY_WAIT_MS` 90s for engine idle; sets `_commandCloseInFlight` which blocks mgmt/screening entry. ⚠️ Port 3001 default is the same port CLAUDE.md lists for NeoTasker — loopback bind + `EADDRINUSE` handler (`:4285-4288`) means a collision would silently disable dashboard closes; verify `MERIDIAN_COMMAND_PORT` on the VM.

---

## 2. Scheduler inventory (index.js `startCronJobs()` :2553-3511)

Busy flags: `busy` (REPL/Telegram command in flight, `:4005`), `_managementBusy` (`:482`), `_screeningBusy` (`:484`), `_commandCloseInFlight` (`:4028`), `_pnlPollBusy` (`:2612`), `_pnlDiscoveryBusy` (`:2809`), `_adoptionBurstBusy` (`:2621`), `_opportunityPollBusy` (`:3313`); `engineBusy()` = `busy||_managementBusy||_screeningBusy` (`:4030`). `_screeningLastTriggered` (`:495`) is the 5-min screening cooldown clock shared by mgmt-triggered, opportunity-triggered and cron screening.

| Name | Schedule (default → prod) | Guard | Reads | Writes | Cite |
|---|---|---|---|---|---|
| **Management cycle** `mgmtTask` → `runManagementCycle({quiet:true})` | `*/${managementIntervalMin} * * * *`; default **10** (`config.js:787`), **prod 3** (comments `index.js:3375-3380,3423-3425`) | returns if `_managementBusy`; inside also `_commandCloseInFlight||busy` | `getMyPositions({force:true})`, `getPoolDetail` per position when `poolHealthAlertsEnabled`, pool-memory snapshots, tracked state | `recordPositionSnapshot` (pool-memory doc), `updatePnlAndCheckExits` (state rows: peak/ratchet/tick ring), deterministic close/claim/flip via `executeManagementActions` → `executeTool` (chain + perf + pool-memory + decision-log + hive), `publishReportTracked` (`dashboard-report` kv + `NOTIFY meridian_report`), piggyback `recordBalanceHistory({freshPositions:false})` (`balance_history` row), `runPostCloseMaintenance` (probes amend lessons perf; dust sweep), OOR alerts (`notifyOutOfRange`), rolling Telegram bubble, `.heartbeat`; triggers `runScreeningCycle` when 0 positions or slots free and cooldown passed | `index.js:2559-2565, 919-1567` |
| **Screening cycle** `screenTask` → `runScreeningCycle` | `*/${screeningIntervalMin}`; default **30** (`config.js:788`), **prod 15** (comments `:3313 "15-min screening cron"`, `:3378`) | `_screeningBusy||_commandCloseInFlight||busy` → skip; sets `_screeningLastTriggered` | circuit breaker state, `getMyPositions`, `getWalletBalances` (SOL price → `recordSolPrice`/`updateSolPrice`), `getTopCandidates` (Meteora + Jupiter + GMGN + LPAgent + smart wallets), lessons/similar-deploys, timing gate | `appendDecision` (decision-log), `stageSignals` (in-mem), `recordRejectedCandidate` (rejected-candidates kv, via screening.js), `_verdictCache`/`_lastDeclinedCandidates` (in-mem), `setLastScreeningFunnel` + `publishReportTracked`, `maybeRelaxOnStarvation` (state_meta `_screeningStarvation`; may write `user-config.json` + lessons.evolutions + Telegram), deploys via `executeTool("deploy_position")`, `.heartbeat` | `index.js:2567, 1570-2436` |
| **Hourly health check** `healthTask` | `0 * * * *` (`healthCheckIntervalMin` 60 in config but the cron string is hard-coded) | `_managementBusy` → return; sets `_managementBusy` itself | `getWalletBalances({freshPositions:false})`, `getMyPositions({force:true,silent:true})` | log line only (read-only by design after the Qenis-SOL 2026-08-30 incident) | `index.js:2569-2594` |
| **Morning briefing** `briefingTask` → `runBriefing` | `0 1 * * *` UTC (08:00 UTC+7) | none | `generateBriefingData()` | Telegram HTML send, `setLastBriefingDate` (state_meta `_lastBriefingDate`), `saveDailyBriefing` (kv `daily_briefing:<date>`, `daily_briefing:latest`, `daily_briefings_index`) | `index.js:2596-2599, 586-598`; `briefing.js:325-360` |
| **Briefing watchdog** `briefingWatchdog` → `maybeRunMissedBriefing` | `0 */6 * * *` UTC | skips if already sent today or before 01:00 UTC | `getLastBriefingDate` | same as briefing | `index.js:2601-2603, 604-617` |
| **PnL poller** `pnlPollInterval` | `setInterval` every `pnlPollIntervalSec` **3s** (`config.js:890`); `confirmTicks` 2 (`:920`) | writes heartbeat first; consumes `.force-sync` IPC (60s min gap `FORCE_SYNC_MIN_INTERVAL_MS`, `:502-504`); then returns if `_managementBusy||_screeningBusy||_pnlPollBusy||_pnlDiscoveryBusy` or no tracked positions; sets `_pnlPollBusy`; on a confirmed exit takes `_managementBusy` for the close | `getMyPositions({force:true,silent:true})` (known-address RPC path) | `recordTick` (`price_ticks` source=poller), `confirmPeak`/`updatePnlAndCheckExits`/`registerExitSignal` (state), `evaluateCloseEfficiencyGate` (Jupiter quote), crash/rug shadow logs, GMGN smart-exodus check (15-min/position), direct close/flip/rebalance via `executeManagementActions` (one action per tick), fast `publishReportTracked` on new position, `recordLiquidityTicks` (`position_liquidity_ticks`), `pgNotify("meridian_tick")` ≤ 1/2s (`_lastTickNotify`, `:500,3220`) | `index.js:2607-2611, 2887-3300` |
| **Owner discovery scan** `pnlDiscoveryInterval` → `runPnlDiscovery` | timer every `pnlDiscoveryIntervalSec` **30s** (`config.js:899`); effective cadence 30s when the wallet WebSocket is unhealthy, `pnlDiscoveryFallbackIntervalSec` **300s** when healthy (`:904`; `index.js:2877-2884`); also on demand via `setPositionDiscoveryTrigger` (`requestPositionDiscovery` from dlmm/socket) and once at boot | if `_managementBusy` → re-queue in 1s; if `_pnlPollBusy||_pnlDiscoveryBusy` → mark pending (drained from the poller's `finally`) | `getMyPositions({force,silent,discovery:true,persist:false})` (Helius `getProgramAccountsV2` owner-wide) | `reconcileMissingTrackedPositions` (external-close repair → `reconcileExternallyClosedPosition` / `markPositionClosedByReconciliation`), `observeOrphanPositions` (`_orphanCandidates` map), `.heartbeat` | `index.js:2809-2885, 2763-2807` |
| **Adoption burst** `adoptionBurstInterval` → `runAdoptionBurst` | every `pnlAdoptionBurstIntervalSec` **5s**; candidate window `pnlAdoptionBurstWindowSec` **120s**; dwell `ORPHAN_ADOPTION_DWELL_MS` 10s | `_adoptionBurstBusy` or empty map → return; `_managementBusy||_pnlPollBusy||_pnlDiscoveryBusy` → defer | `isPositionAccountLive` (RPC) per candidate | `adoptOrphanPosition` (state row + `position_events`), Telegram "Position Adopted" (300ms-delayed re-check) | `index.js:2617-2621, 2680-2746, 2874-2876` |
| **Opportunity poller** `opportunityPollInterval` | every `opportunityPollIntervalSec` **45s** if `opportunityPollEnabled` (default **true**, `config.js:925-926`); 5-min global re-trigger cooldown; per-pool `retriggerCooldownMin` 30 | `_screeningBusy||_managementBusy||_opportunityPollBusy` → return; skip while `Date.now()-_screeningLastTriggered < 5m` | `getMyPositions({force:true})`, `getSolBalance()` only if a slot is free, `getTopCandidates({limit:10})` (full discovery + holder audits every 45s when slots are free), `checkSmartWalletsOnPool` for borderline degen scores | `_oppPoolLastTriggered` (in-mem), triggers `runScreeningCycle({silent:true})` | `index.js:3305-3371`; `config.js:924-950` |
| **Balance history** `balanceHistoryTask` → `recordBalanceHistory` | `*/5 * * * *` + once at `startCronJobs` + piggyback per mgmt cycle | no busy guard; 2.5-min min-gap vs last row (`latestBalanceTs`); skips if untracked positions have incomplete valuation | `getWalletBalances({freshPositions})` (RPC + Jupiter prices + positions) | `recordBalanceEntry` → `balance_history` INSERT + count retention 17280 rows; `_lastSampledAum` for the report doc | `index.js:2488-2551, 2557, 3373`; `balance-history.js:15,47-65` |
| **State reconciliation** `reconciliationTask` → `reconcileStateWithChain` | `7,22,37,52 * * * *` (offset ≡1 mod 3 chosen to dodge the */3 mgmt grid; 3 × 45s busy-retries) | `_managementBusy||_screeningBusy` → retry ≤3× | `getMyPositions({discovery:true,persist:false})`, `isPositionAccountLive` | phantom auto-close (`external_close_pending`), orphan auto-adopt, PnL-drift alert (6h/position), Telegram drift warnings, `recordError("state_corruption")` | `index.js:3375-3397`; `state.js:3389-3525` |
| **ATA sweep** `ataSweepTask` | `30 3 * * *` (VM local tz — node-cron default; no `timezone` option) | `_managementBusy||_screeningBusy||busy` → skip | `listEmptyTokenAccounts` | `sweepEmptyTokenAccounts` (close-account txs via RPC_URL) | `index.js:3401-3412`; `tools/wallet.js:1035` |
| **Baseline deposit scan** `baselineTask` | `50 * * * *` (minute 50 avoids */3 and */15 grids) | `_managementBusy||_screeningBusy||busy` → skip + log | `getSignaturesForAddress` (limit 1000, `until: last_signature`) + `getParsedTransaction` per sig with 150ms spacing | `saveBaselineState` (state_meta `baseline`: deposits/withdrawals/total_*/last_signature), Telegram "Deposit/Withdrawal detected" | `index.js:3414-3445`; `tools/wallet.js:706-760` |
| **Auto-skim** `autoSkimTask` | `*/5 * * * *`, only if `config.autoSkim.enabled` (default **false**; **prod OFF** per CLAUDE.md plan #15; the *local* dev `user-config.json` has it `true`) | `_managementBusy||_screeningBusy||busy` → skip + `auto_skim` log | `getAutoSkimStatus` (equity, baseline, 24h cap) | with `requireTelegramConfirmation` (default true) → Telegram proposal ≤1/6h (`_skimProposalNotifiedAt`); else `transferSol` (SystemProgram transfer via RPC_URL) + baseline withdrawals ledger | `index.js:3447-3489`; `tools/transfer.js:351-390, 190-312`; `config.js:975-985` |
| **Ledger truth** `ledgerTruthTask` → `runLedgerTruth` | `11 */4 * * *` | none (read-only) | `balance_history`, `positions`, `price_ticks`, baseline, lessons perf | `ledger-truth` kv doc (latest + 60 history), `[LEDGER_TRUTH]` log | `index.js:3491-3493`; `ledger-truth.js:137-149` |
| **Post-close probes** (not a cron — runs inside every mgmt cycle incl. 0-position path via `runPostCloseMaintenance`) | per mgmt cycle; slots `postCloseProbeMinutes` [30,60,180], grace 20 min, scan horizon max+60 min | `postCloseProbeEnabled` | `getPoolDetail({timeframe:"5m"})` → `token_x.market_cap` | `recordPostCloseProbe` / `markPostCloseUnprobeable` (lessons perf `post_close`), Telegram exit review | `index.js:649-724`; `lessons.js:410-482` |
| **Dust sweep** (inside `runPostCloseMaintenance`) | after any close, first cycle after boot, every 10th cycle (`_mgmtCycleCount % 10 === 1`) | `dustSweepEnabled` | `getWalletBalances`, `getDeferredExitSwaps` | Jupiter swaps, ATA closes | `index.js:695-703`; `tools/executor.js:1324-1416` |
| **Socket monitor** (WebSocket, not polling) | started once after crons: `getPnlConnectionWithFailover()` → `startSocketMonitor` → `syncSocketSubscriptions(open)` | — | `accountSubscribe` per open pool's lbPair + wallet-filtered PositionV2 `programSubscribe` | `recordTick` (source=socket, deduped), `markOutOfRange`/`markInRange`, `.force-sync` IPC file (60s min gap), `requestPositionDiscovery` hints (5s cooldown), `[WS_HEALTH]` logs, `setPositionDiscoverySignalSink` health → discovery cadence | `index.js:3505-3512, 339-388`; `tools/socket-monitor.js:15-35, 89-131, 133-160, 225-250, 296-352` |
| **HiveMind heartbeat** | `setInterval` 15 min (`HEARTBEAT_INTERVAL_MS`) + at boot | `isHiveMindEnabled()` | — | `POST /api/hivemind/agents/register`; if `pullMode==="auto"` also `lessons/pull`, `presets/pull` → `hivemind-cache.json` (plain file, not a doc store) | `hivemind.js:10, 225-246, 166-222` |
| **Telegram long-poll** | continuous `getUpdates?offset&timeout=30` (35s abort), 5s sleep on error | messages received while `engineBusy()` are queued in `_telegramQueue` and drained by `drainTelegramQueue()` when idle | — | command handlers | `telegram.js:633-672`; `index.js:5727-5732, 5817` |
| **REPL prompt refresh** | `setInterval` 10s (TTY only) | `!busy` | — | stdout | `index.js:6772-6777` |
| **Tick-store flush** | `setInterval` 30s (`FLUSH_MS`) or at 200 rows; prune ≤1/h to 720h | pg only, `TICK_STORE_DISABLED!=="1"` | — | `price_ticks` batched INSERT/DELETE | `db/tick-store.js:39-45,71-100` |
| **Liquidity-tick flush** | `setInterval` 15s or 200 rows; prune ≤1/h to 72h | pg only | — | `position_liquidity_ticks` | `db/liquidity-tick-store.js:6-8,44-108` |
| **RPC telemetry log** | every 5 min (`RPC_TELEMETRY_LOG_INTERVAL_MS`) | — | — | `rpc_metrics` log line | `tools/rpc.js:15` |

`stopCronJobs()` (`index.js:619-647`) clears node-cron tasks + all intervals + retry timer + socket monitor; `/pause` calls it, `/resume` restarts + resets the circuit breaker (`:6643-6666`).

---

## 3. External platforms

### 3.1 Solana RPC / Helius

| Purpose | Endpoint / method | Where | Auth | Failure mode / fallback | Cite |
|---|---|---|---|---|---|
| **All transaction sends** (deploy/close/claim/flip/rebalance/swap/transfer/ATA sweep) | `process.env.RPC_URL` (Helius mainnet, `&rebate-address=<wallet>`) via `getConnection()` — a *direct* `Connection`, not the failover pool | `tools/dlmm.js:108-117`, `tools/wallet.js:27`, `tools/transfer.js` | `RPC_URL` (api-key in query) | No send-path failover. Plan #15 item 5: `closeSendsViaPrimaryRpc` (default true) forces close sends onto `RPC_URL` even when reads came from a pooled node (`tools/dlmm.js:3469-3478`). web3 built-in 429 retry disabled (`RPC_CONNECTION_OPTIONS.disableRetryOnRateLimit`, `tools/rpc.js:24-28`). | |
| **Read failover pool** (`callRpc`/`callRpcMethod`/`callRpcBatch`) | standard pool = every discovered Helius key endpoint (`https://<RPC_URL host>/?api-key=K&<extra params incl. rebate-address>`) + non-Helius `RPC_URL_FALLBACK_1/2` + `https://api.mainnet-beta.solana.com`; indexed pool = Helius-only (for `getProgramAccountsV2`) | `tools/rpc.js:70-193, 710-832, 859-885, 971-1130` | keys harvested from `HELIUS_API_KEYS` (csv), `HELIUS_API_KEY`, `_ALT`, `_FB`, `_FALLBACK`, and any Helius URL in `RPC_URL*`, `RPC_INDEXED_URL*`, `PNL_RPC_URL*` | Round-robin over healthy Helius tier → healthy other tier → degraded tier (`:749-767`). Circuit breaker: 5 consecutive errors → open 60s (`:5-6`); 15s call timeout; backoff 1s→10s. **429 / "rate limit" / "too many requests"** → exponential cooldown 30s·2^n up to 1h (`:11-12, 623-640`). **Quota exhausted** (regex `credit.*limit|quota.*exceed|monthly.*limit|usage.*limit|max.*usage|usage.*reach|…`) → 1h cooldown, `rpc_quota` log (`:13, 597-608, 626-632`). Capability errors (-32601/-32602/400/401/403/404) → method or endpoint blocked 30 min (`:14, 611-621`). Non-Helius fallbacks get a 10 000 priority penalty (`:258-268`). Every 429 → `recordError("rpc_429")` (`:811, 1112`). | |
| Wallet snapshot (AUM sampler, 3-min cadence) | `getBalance`, `getParsedTokenAccountsByOwner` (Token + Token-2022) via pool | `tools/wallet.js:63-125` | pool | Replaced the paid Helius Wallet API (100 credits/req) — comment `:58-61`. | |
| SOL balance | `getBalance` via pool | `tools/wallet.js:48-56` | | | |
| Owner-wide position discovery | `getProgramAccountsV2` on DLMM program `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`, paginated (`MAX_POSITION_DISCOVERY_PAGES` 100), `changedSinceSlot` incremental | `tools/pnl.js:216, 440-490` | indexed pool (Helius-only) | throws past 100 pages; deletions unreliable → direct `isPositionAccountLive` checks (`:348`) | |
| Fast PnL read (3s) | known-address account reads via DLMM SDK on the PnL connection set | `tools/pnl.js:44-54, 1170` | `config.pnl.rpcUrl` = first non-empty of `PNL_RPC_URL_ALT`, `PNL_RPC_URL`, user `pnlRpcUrl`/`rpcUrl`, `RPC_URL`, else `https://api.mainnet-beta.solana.com` (`config.js:888`) | `getPnlRpcUrls()` = `[config.pnl.rpcUrl, PNL_RPC_URL_ALT, PNL_RPC_URL, PNL_RPC_URL_FALLBACK, …discoverHeliusEndpoints(), config.rpcUrl]` **minus `https://pump.helius-rpc.com`** (`:44-53`). ⚠️ CLAUDE.md says the poller "defaults to pump.helius-rpc.com"; code explicitly filters that host out and defaults to public mainnet. | |
| WebSocket monitor | long-lived `Connection` chosen by `getPnlConnectionWithFailover()` (`getSlot` probe per URL) | `tools/pnl.js:79-98`; `tools/socket-monitor.js:168-191` | same list | `[WS_HEALTH]` open/error/close handlers on `connection._rpcWebSocket`; PositionV2 subscribe retry 6× exp backoff from 1s (`:29-30, 66-87`); on reconnect → discovery hint after 2s. Unhealthy socket → discovery cadence drops to 30s. | |
| Priority fees | `getRecentPrioritizationFees({lockedWritableAccounts})` on `getConnection()` (RPC_URL) — **not** Helius' `getPriorityFeeEstimate` | `tools/dlmm.js:205-245` | RPC_URL | 30s cache per `${urgency}:${firstWritableAccount}` (max 16 keys); normal = p50 × 1.2 cap 1 000 000 µL; exit = p75 × 1.5 cap 3 000 000 µL (`config.js:847-863`); on fetch error uses stale cache or 0; exit-retry floor 10 000 µL (`:151`). | |
| Tx fee capture | `getTransaction` retry 4×800ms | `tools/dlmm.js:280` | | | |
| Baseline deposits | `getSignaturesForAddress` (limit 1000) + `getParsedTransaction` with 150ms spacing "Helius free-tier 10 RPS" | `tools/wallet.js:737-756` | pool | | |
| `beta.helius-rpc.com` | appears **only** in `test/helius-load-balancer.test.js`; `isHeliusRpcUrl` accepts any `*.helius-rpc.com` host (`tools/rpc.js:53-58`) and reuses `RPC_URL`'s hostname for every generated key endpoint (`:72, 84-87, 136-138`). | | | | |
| `/health` Telegram | `getRpcHealthReport`, `getRpcTelemetrySnapshot({kind:"wire"})` | `index.js:6014-6049` | | | |

### 3.2 Meteora

| Purpose | Endpoint | Where | Params | Failure mode | Cite |
|---|---|---|---|---|---|
| Pool discovery (gate mode) | `GET https://pool-discovery-api.datapi.meteora.ag/pools?page_size=50&filter_by=<enc>&timeframe=<tf>&category=<cat>` | `tools/screening.js:477-491, 665-760` | `filter_by` compounded from `config.screening` floors (`minTvl`, `minMcap`, `minHolders`, `minVolume`, `minFeeActiveTvlRatio`, bin-step…); `timeframe` = `config.screening.timeframe` (default "5m"; **windows `volume`/`fee_active_tvl_ratio`**) | throws on `!res.ok` — no retry/429 handling; the 2026-07-07 starvation was this query compounding to `total=0` | |
| Pool discovery (rank mode, **prod**) | same endpoint, `page_size=250` × ≤3 requests (`RANK_FETCH_PAGE_SIZE/MAX_REQUESTS`), broad `RANK_ENVELOPE` filter: `tvl>=10000`, `base_token_market_cap 100000..20000000`, `base_token_holders>=500`, `volume>=1000·tf/60`, `fee_active_tvl_ratio>=0.30·tf/60` | `tools/screening.js:78-90, 866-950` | timeframe-scaled from 1h reference (`:71-77, 872-875`) | same | |
| Steady envelope (plan #12 flag `rankSteadyEnvelopeEnabled`) | one extra request at `timeframe=24h`, extras re-fetched at screening tf | `tools/screening.js:1017-1060` | `rankSteadyMinFeeTvl24h` 1.5, `rankSteadyMinTvl` 100k, `rankSteadyMaxExtra` 10 | shadow log while off | |
| Top Performers tab | `GET …/pools?page_size=20&category=top&timeframe=24h&filter_by=pool_type=dlmm` | `tools/screening.js:1084-1120` | `topPerformersEnabled`, `topPerformersLimit` 10 | non-fatal | |
| Pool detail (single) | `GET …/pools?page_size=1&filter_by=pool_address=<addr>&timeframe=<tf>` | `tools/screening.js:493-509` (`fetchPoolDiscoveryDetail`/`getPoolDetail:1989`) | used by: mgmt health alerts (per position per cycle), post-close probes (tf 5m), exit mcap capture in `closePosition` (`tools/dlmm.js:3343, 3823`), `pnl.js` 60s-cached pool detail (`:175-196`), volatility timeframe re-fetch (`:513-560`) | throws on non-OK; probe path maps throw → `delisted` | |
| Pool metadata | `GET https://dlmm.datapi.meteora.ag/pools/<key>` | `tools/dlmm.js:942-960` | | | |
| Pool search | `GET https://dlmm.datapi.meteora.ag/pools?query=<q>` | `tools/dlmm.js:2772-2780` | | | |
| Open-position deposit history (cost basis) | `GET https://dlmm.datapi.meteora.ag/positions/<pool>/pnl?user=<wallet>&status=open&pageSize=100&page=1` | `tools/pnl.js:118-140` (`fetchDlmmPnlForPool`), `tools/dlmm.js:1872` | cached per pool for `pnlDepositCacheTtlSec` 300s, signature-invalidated (`tools/pnl.js:168-172, 637-700`), signature re-check every `pnlSignatureCheckIntervalSec` 300s | live pnl fields from the API are deliberately ignored — only deposits/withdrawals/fees are read (`:26-30`) | |
| Closed-position record (authoritative realized PnL) | `…/positions/<pool>/pnl?user=<wallet>&status=closed&pageSize=50|100&page=1` | `tools/dlmm.js:2010-2085` (`fetchClosedPositionPnl`), `:3295-3300` (closePosition, 2.5s timeout variant `:3706-3708`), `recordRebalanceLegPerformance:2087` | reads `allTimeDeposits/Withdrawals/Fees` (lifetime → rebased by `applyAdoptionBasis`) | | |
| Portfolio fallback (when `config.pnl.source !== "rpc"` or the RPC path throws) | `GET https://dlmm.datapi.meteora.ag/portfolio/open?user=<wallet>` | `tools/dlmm.js:2425-2440` | | | |
| SDK | `@meteora-ag/dlmm` **1.9.14** (`package.json`, lockfile); lazy `import()` in dlmm.js/pnl.js/socket-monitor.js; `postinstall: node scripts/patch-anchor.js` adds an `exports` map to `@coral-xyz/anchor/package.json` and rewrites bare `@coral-xyz/anchor/dist/cjs/utils/<dir>` imports in `dist/index.mjs` for Node 24 ESM | `scripts/patch-anchor.js:1-60`; memory note `meridian-dlmm-sdk-upgrades.md` | | |

### 3.3 Jupiter

| Purpose | Endpoint | Where | Auth | Notes | Cite |
|---|---|---|---|---|---|
| Token prices (never cached; symbols cached) | `GET https://datapi.jup.ag/v1/assets/search?query=<mint,…>` | `tools/pnl.js:32, 149-165`; `tools/wallet.js:98` | none | called every 3s tick and every AUM sample; failure → `pnl_price` log, prices `{}` | |
| Token info / audit / holders / narrative | `…/assets/search?query=`, `…/holders/<mint>?limit=100`, `…/holders/<mint>?addresses=`, `…/pnl-positions?address=&assetId=`, `…/chaininsight/narrative/<mint>` | `tools/token.js:4, 22, 36-38, 118-121, 153-157, 197, 214`; `tools/screening.js:807` | none | Safety-enrich cache 30 min/mint (`tools/screening.js:109`); serialized holder fetch delay against burst 429s (`:1483`). | |
| Swap quote (read-only) | `GET https://api.jup.ag/swap/v2/order?…&referralAccount&referralFee` (+`skip_taker`) | `tools/wallet.js:458-504` | `x-api-key` = `config.jupiter.apiKey` \|\| `JUPITER_API_KEY` \|\| **hard-coded default key** (`:139-142`) | used by exit-swap guard, close-efficiency gate, slippage cap | |
| Swap execute | `GET …/order` then `POST …/execute` | `tools/wallet.js:506-640` | same; referral `JUPITER_REFERRAL_ACCOUNT` (default hard-coded) / `JUPITER_REFERRAL_FEE_BPS` 50 (`config.js:962-968`); `slippageBps` omitted → RTSE unless `swapSlippageCapEnabled` | `DRY_RUN` short-circuit `:521` | |
| `JUPITER_PRICE_API = https://api.jup.ag/price/v3` | defined `tools/wallet.js:137` | | | **dead constant — never referenced** | |

### 3.4 GMGN (`tools/gmgn.js`)

- Base `config.gmgn.baseUrl` \|\| `https://openapi.gmgn.ai` (`:90`); key `config.gmgn.apiKey` \|\| `GMGN_API_KEY` (`:65, 784-786`); config from `gmgn-config.json` (written by `update_config`, `tools/executor.js:1124-1167`). IPv4 forced (`:9`).
- Live calls all hit `/v1/token/info?chain=sol&address=<mint>` through a 5-min in-flight-promise cache (`:793-816`) feeding `getGmgnTokenFees`/`getGmgnSafetyInfo`/`getGmgnDevInfo`/`getGmgnSmartMoneyInfo`/`checkGmgnSmartExodus` (`:817-917`).
- Pacing: `config.gmgn.requestDelayMs` 2500 × weight multiplier {1:1, 2:1.5, 3:2.2, 5:3.5}; weights by path regex (`:44-62`).
- **IP ban / 429 handling**: `res.status===429` or `/rate limit|temporarily banned/` → `"temporarily banned"` enters cooldown `banCooldownMinutes` 180; persistent 429 after `Retry-After`-based backoff → cooldown `rateLimitCooldownMinutes` 15 (`:14-32, 120-137`). All callers fail open to the Jupiter audit.
- Also fetches Meteora discovery for `screeningSource=gmgn` (`:10, 355-380`) — not the prod path.

### 3.5 GeckoTerminal (`tools/rebalance-trend.js`)

`GET https://api.geckoterminal.com/api/v2/networks/solana/pools/<pool>/ohlcv/<minute|hour>?aggregate=&limit=` (`:19`), 6s abort, no key; non-OK (incl. 429) → `candle_warn` log + `[]` (`:24-27`). Consumer: `isRebalanceTrendIncreasing` for the roll-up/rebalance trend gate (`index.js:3124, 72`). No caching → one call per round-trip/OOR decision in enforce mode. (CLAUDE.md's "GeckoTerminal 429" behaviour is just the generic non-OK branch — there is no dedicated 429 backoff.)

### 3.6 LPAgent / Agent Meridian API

| Purpose | Endpoint | Auth | Notes | Cite |
|---|---|---|---|---|
| Top-LPer study (screener `top_lpers:` line, `simulate`/`study` tools) | `GET https://api.agentmeridian.xyz/api/top-lp/<pool>` + `/study-top-lp/<pool>` | `x-api-key` = `config.api.publicApiKey` \|\| `PUBLIC_API_KEY` \|\| hard-coded default (`config.js:11, 878-880`; `tools/study.js:3-8`) | 429 → throws "Rate limit exceeded… wait 60 seconds"; `lper-signal.js` caches 30 min/pool and degrades to null (`:14-30`) | |
| Discord signal candidates | `GET …/api/signals/discord/candidates` | same | `tools/screening.js:468-475` | |
| Chart indicators (`config.indicators.enabled`, default false) | `GET …/api/chart-indicators/<mint>?interval&candles&rsiLength` | same | `tools/chart-indicators.js:214-244` | |
| LPAgent direct | `GET https://api.lpagent.io/open-api/v1/lp-positions/opening?owner=` | `LPAGENT_API_KEY` (optional; no key → `{}`) | `tools/dlmm.js:1840-1868` — legacy enrichment, effectively inert without the key | |

### 3.7 HiveMind (`hivemind.js`)

- Base `config.hiveMind.url` = user `hiveMindUrl` \|\| **`https://api.agentmeridian.xyz`**; key = user `hiveMindApiKey` \|\| `HIVEMIND_API_KEY` \|\| **built-in default** (`config.js:9-12, 871-876`). `isHiveMindEnabled()` = both non-empty (`:85-87`) → **enabled by default** with the shipped constants. ⚠️ CLAUDE.md ("enabled by setting `HIVE_MIND_URL`/`HIVE_MIND_API_KEY`") names env vars the code never reads.
- Endpoints (all `x-api-key`): `POST /api/hivemind/agents/register` (boot + 15-min heartbeat, `:166-187`), `/lessons/pull`, `/presets/pull` (auto mode), `POST /lessons/push` (each derived lesson, `lessons.js:193`), `POST /performance/push` (each close, `lessons.js:249-254`). Cache file `hivemind-cache.json`; `agentId` written to `user-config.json` (`:89-101`). `dryRun` flag sent in register payload (`:179`).

### 3.8 Telegram (`telegram.js`)

- `TOKEN=TELEGRAM_BOT_TOKEN`, `BASE=https://api.telegram.org/bot<token>` (`:26-27`); chat id from `TELEGRAM_CHAT_ID` or user-config `telegramChatId`; inbound allow-list `TELEGRAM_ALLOWED_USER_IDS` (`:28-33`).
- Transport `postTelegram` (`:128-201`): **429** → honour `parameters.retry_after` (+1s) up to 3 attempts except `sendChatAction`; **401** → token hint (mentions the `.envrypt` key); **HTML parse failure** (`"can't parse entities"`, i.e. unclosed/unescaped tags) → strip all tags, unescape entities, resend as plain text (`:163-175`); network failure → 2s·2^n retry ×3 (`:187-198`). `sendMessage` ids recorded to `.telegram-marker.json` (`telegram-marker.js`) for the rolling-bubble logic.
- Long poll `getUpdates?offset&timeout=30` (`:633-672`); `setMyCommands` with `BOT_COMMANDS` (`:676-697`).
- Notification builders: `notifyDeploy` (:722), `notifyClose` (:763), `notifySwap` (:807), `notifyRebalance` (:910), `notifyOutOfRange` (:920, gated in `index.js:1532-1560`: only when the cycle notifies, `minutes_out_of_range >= outOfRangeWaitMinutes`, direction limit not null, not held). Other senders via `sendHTML`: adoption (`index.js:2699`), drift/phantom/orphan/PnL-discrepancy (`state.js:3449-3511`), exit review (`lessons.js:445-465`), starvation relaxer (`index.js:2474`), deposit/withdrawal (`:3431-3441`), skim + proposal (`:3455-3482`), smart-money exodus (`:3055-3062`), briefing, health, circuit breaker, plus watchdog/syncer/db-backup from their own processes.
- Command surface (`index.js:5817-6730`, help text `:5236-5283`): `/manage /positions /status /wallet /pool /health /briefing /close /rebalance /hold /unhold /adopt /closeall /set /unset /screen /candidates /deploy /cri /timing /exits /config /settings /setcfg /skim /pause /resume /hive /agy /sessions /gitstatus /gitpull [force] /restart /sync /cooldowns`; REPL-only `/stop /thresholds /learn /evolve` (`:6911-7026`).

### 3.9 LLM (Ollama cloud / OpenRouter / claude-cli)

- Client: OpenAI SDK, `baseURL = LLM_BASE_URL || https://ollama.com/v1`, key = `OLLAMA_API_KEY || LLM_API_KEY || OPENROUTER_API_KEY` on Ollama (reverse precedence otherwise), 5-min timeout, `Connection: close` (`agent.js:108-128`). `reasoning_effort = LLM_REASONING_EFFORT || "low"` only for Ollama (`:118-120, 323`).
- Models per role from `config.llm.{managementModel,screeningModel,generalModel}` (legacy DeepSeek ids normalized to `glm-5.3-flash`, `config.js:14-24, 805-812`); `maxTokens` 4096, `maxSteps` 20, `temperature` 0.373.
- Fallback chain (`agent.js:132-137, 280-380, 637`): transient 429/502/503/529 → retry ×3 with backoff; on 502/503/529 at attempt 1 switch to `PROVIDER_FALLBACK_MODEL` = Ollama: `LLM_FALLBACK_MODEL || primary`; OpenRouter: `deepseek/deepseek-v4-flash-vision-exp`. Provider quirks retried: system role rejected, `tool_choice=required` unsupported, thinking+tool_choice.
- **claude-cli backend** (`llm-cli.js`): `claude -p --output-format json --model <suffix> --no-session-persistence [--effort <role>]` (`:268-269`); `CLAUDE_EFFORT_BY_ROLE` SCREENER/GENERAL medium, MANAGER low (`:38`); rate-limit text parsed (`resets in N minutes` / `resets 10pm (TZ)`) → module cooldown; failure/limit → OpenRouter path with `claudeCliFallbackModel` (`config.js:831`); `claudeCliTimeoutMs` 240000. Dormant unless a role model is `claude-cli/…`.
- Bear debate (`llm-verdicts.js`) — prod `bearDebateEnabled=false`.

### 3.10 Pionex skimmer (`tools/transfer.js`)

Destination `PIONEX_DEPOSIT_ADDRESS` \|\| `autoSkim.destinationAddress` (`:97`); status math: `netCapitalAtRisk = total_deposited − total_withdrawn`, `surplus = equity − targetWorkingCapitalSol (6.2529)`, 24h cap `max(in-memory transfers, persisted baseline withdrawals)` vs `maxDailyTransferSol` 2.0, `minTransferAmountSol` 0.5, `minWalletReserveSol` 0.1, `transferIntervalMin` 60 (`:20-24, 95-180`). `transferSol` simulates, broadcasts a `SystemProgram.transfer` via RPC_URL, appends to `baseline.withdrawals` (`:190-312`). `checkAndExecuteAutoSkim` returns `confirmation_required` unless `requireTelegramConfirmation===false` (`:351-390`); `/skim now` executes.

---

## 4. Persistence

### 4.1 Backend switch & design
- `PERSIST_BACKEND` (`json` default, **prod `pg`**) read by `usePg()` (`db/pool.js:16`). `pg.Pool` max `PG_POOL_MAX` 5, idle 30s, connect 10s; libpq env vars (`:23-34`); `withTransaction` (`:45-58`).
- **Sync API over async store**: `makeDocStore(name, file, empty)` (`db/doc-store.js:25-79`): in-memory `cache`, `get()` sync (throws under pg if not primed), `set()` replaces cache then chains an `INSERT … ON CONFLICT` into `kv_store` on a per-store `writeChain` (json: temp+rename). `initAllDocStores()`/`flushAllDocStores()` (`:88-96`) wired into boot/shutdown/cli.
- **state.js** (`:147-446`): cache `_cache`; `save()` stamps `lastUpdated`, diffs each position JSON against `_lastPersisted`, queues upserts/deletes + `_pendingEvents` + the `meta` object, chains `persistNormalized()` (one transaction: `positions` upsert w/ promoted columns, `position_events` insert, **all `META_KEYS` upserted unconditionally**). On failure `_lastPersisted` is rolled back + `recordError("state_corruption")`. json backend: `state.json.tmp` → copy `.bak` → rename; corrupt file + no bak → rename to `state.json.corrupt-<ts>` and **throw (halt)** (`:175-205`).
- `META_KEYS` (`:229`): `baseline, cumulative_gas_sol, _lastBriefingDate, recentEvents, lastUpdated, _circuitBreaker, _screeningStarvation, _deferredExitSwaps` — must also appear in `hydrateFromPg` (`:270-287`) and the `save()` meta object (`:346-355`) or round-trip to null. `walletAddress` is a 9th singleton written only by `persistWalletAddress` (`:424-435`).
- **Clobber race**: because `save()` rewrites every singleton from cache, any external writer (`cli.js baseline`, scripts) loses on the agent's next save/flush. `cli.js` primes + flushes but cannot avoid this (CLAUDE.md known issue).
- Crash-safety under pg: write-behind loss is healed by `reconcileStateWithChain` (15-min) and the discovery path.

### 4.2 Tables (migrations `db/migrations/001-006`)

| Table | Writer | Row shape | Retention | Cite |
|---|---|---|---|---|
| `positions` | `state.js persistNormalized` | 1 row/position: PK `position_address`, promoted `pool_address, base_mint, pair, lower_bin, upper_bin, strategy, deployed_at, out_of_range_at, gas_sol, note, closed, closed_at`, full object in `data` jsonb | forever (closed rows kept) | `001_init.sql:6-25`; `state.js:380-399` |
| `position_events` | `pushEvent` → `save()` | append-only `(position_address, kind=action, payload, created_at)`; kinds seen: deploy, close, rebalance, hold, instruction, exit-signal events (`state.js:640, 1003, 1213, 1636, 1705, 2571, 2637`) | forever | `001_init.sql:28-36`; `state.js:1613-1623, 400-407` |
| `state_meta` | `save()` (all META_KEYS every save) + `persistWalletAddress` | `(key, value jsonb, updated_at)` | — | `004_state_meta.sql`; `state.js:409-416` |
| `state_doc` | none (legacy, one-time hydrate fallback `state.js:250-260`) | single jsonb | rollback snapshot | `002_state_doc.sql` |
| `kv_store` | every `makeDocStore` + briefing | `(key, doc jsonb, updated_at)`; keys: `lessons, pool-memory, rejected-candidates, decision-log, signal-weights, strategy-library, smart-wallets, token-blacklist, dev-blocklist, error-telemetry, dashboard-report, ledger-truth, daily_briefing:<date>, daily_briefing:latest, daily_briefings_index` | whole-doc rewrite per `set()`; per-doc caps below | `003_kv_store.sql`; doc-store list via `grep makeDocStore(`; `briefing.js:325-360` |
| `balance_history` | `recordBalanceEntry` | `(total_usd, snapshot jsonb {ts, idleSol, deployedSol, unclaimedFeesSol, rentSol, tokensSol, totalSol, solPriceUsd, totalUsd}, created_at)` | newest **17280** rows (≈30d at ~2.5-3 min) | `balance-history.js:15, 47-65`; `001_init.sql:110-116` |
| `price_ticks` | `recordTick` (poller: pool, position, active_bin, pnl_pct; socket: pool, active_bin deduped on unchanged bin) | `(pool_address, position_address, ts, active_bin, pnl_pct, price, source)` | **720h (30d)**, prune ≤1/h; buffer cap 5000 | `005_price_ticks.sql`; `db/tick-store.js:39-45, 71-100` |
| `position_liquidity_ticks` | `recordLiquidityTicks` (poller, ≤1/2s) | `(position_address, pool_address, pair, captured_at, liquidity_usd, liquidity_sol, liq_x_usd, liq_y_usd, valuation_quality, value_valid)` | **72h** | `006_position_liquidity_ticks.sql`; `db/liquidity-tick-store.js:6-8` |
| `closed_positions, pools, pool_snapshots, lessons, smart_wallets, token_blacklist, dev_blocklist, strategy_library, signal_weights, error_telemetry` | **nobody** — provisioned in `001_init.sql:39-123` for a future normalization; the data lives in `kv_store` docs | | | |
| `schema_migrations` | `db/migrate.js` | forward-only | | |

### 4.3 kv docs — shape & caps

| Doc | Module | Shape / cap | Cite |
|---|---|---|---|
| `lessons` | `lessons.js:20` | `{lessons[], performance[], evolutions[]}`; auto-lessons capped `MAX_AUTO_LESSONS` 60; evolutions capped 50; performance **unbounded** | `:21-28, 776-812` |
| `pool-memory` | `pool-memory.js:16` | per pool `{name, base_mint, deploys[], total_deploys, avg_pnl_pct, win_rate, adjusted_win_rate, last_*, notes[], cooldown_until, base_mint_cooldown_until, snapshots}`; snapshots 48/position, 10 buckets, 480/pool | `:123-140, 383-386` |
| `rejected-candidates` | `pool-memory.js:25` | 12 snaps/pool ring, 5 reasons, 400 pools | `:21-25, 813-860` |
| `decision-log` | `decision-log.js:6` | `{decisions[]}` newest-first, cap **100**, fields `id, ts, type, actor, pool, pool_name, position, summary(280), reason(500), risks≤6, metrics, rejected≤8, intel_score` | `:5-44` |
| `signal-weights` | `signal-weights.js:62` | `{weights{18 signals}, last_recalc, recalc_count, history[]}` | `:21-67` |
| `error-telemetry` | `error-telemetry.js:6` (legacy file `logs/error-telemetry.json`) | array cap **200** of `{ts, category, message≤150}`; categories `rpc_429, rpc_timeout, rpc_other, tx_failed, llm_error, state_corruption, state_recovered, memory_warning, generic` | `:4-40` |
| `dashboard-report` | `report.js:24` | see §6 | |
| `ledger-truth` | `ledger-truth.js:27` | `{latest, history≤60}` | |
| `strategy-library, smart-wallets, token-blacklist, dev-blocklist` | resp. modules | small documents | |

### 4.4 Files still written outside the DB (survive `reset --hard`, gitignored)
`.env` (+ `.envrypt` key), `user-config.json` (4 writers: `update_config` non-atomic `tools/executor.js:1163`, evolution atomic `lessons.js:769-774`, `hivemind.js ensureAgentId:97`, `config.js` reload), `gmgn-config.json`, `.heartbeat`, `.force-sync`, `.telegram-marker.json`, `.telegram-rolling.json`, `hivemind-cache.json`, `logs/agent-YYYY-MM-DD.log`, `logs/actions-YYYY-MM-DD.jsonl`, `logs/snapshots-*.jsonl`, `daily-briefings/` (json fallback only), legacy `*.json` stores (cold copies).

---

## 5. Learning loop

### 5.1 `recordPerformance(perf)` (`lessons.js:115-267`) — called from `closePosition` (before the exit swap), external-close reconcile, rebalance legs
1. Guards: unit-mix (`initial_value_usd ≥ 20 && amount_sol ≥ 0.25 && final ≤ 2·amount_sol` → skip, `:121-133`); absurd (`pnl_pct ≤ −90` on non-stop-loss with initial ≥ 20 → skip, `:140-152`).
2. `pnl_usd = (final_value_usd + fees_earned_usd) − initial_value_usd`; `pnl_pct = pnl_usd / initial_value_usd × 100`; `range_efficiency = minutes_in_range / minutes_held × 100` (`:133-139`). ⚠️ `*_usd` carry SOL under `solMode`.
3. `pnl_sol_net = pnl_sol − (total_gas_sol ?? gas_cost_sol ?? 0)`; `unit_era: "v3"`; `signal_snapshot` from `PERFORMANCE_SIGNAL_FIELDS` + intel dims (`:40-53, 71-113, 160-180`). Later amended by `recordExitSwapOutcome` (`exit_swap{}`, `pnl_usd_net_exit_swap`, slippage folded into `pnl_sol_net`, `:293-335`) and probes (`post_close{}`).
4. `derivLesson` → `pushPerformanceLesson` (dedup by first 60 chars, cap 60) → `pushHiveLesson` (`:185-193`).
5. `recordPoolDeploy` mirror into pool-memory (`:195-225`, cooldown logic `pool-memory.js:223-247`).
6. **Every 5th close** (`length % 5 === 0`): if `config.screening.evolutionEnabled === false` → log and **`return`** (`:226-232`); else `evolveThresholds` + `reloadScreeningThresholds`, then Darwin `recalculateWeights` if `config.darwin.enabled` (`:233-247`).
7. `pushHivePerformanceEvent` (`:249-254`), then `checkCircuitBreaker`/`tripCircuitBreaker` (`:257-265`).
   ⚠️ Because of the early `return` in step 6, **with prod `evolutionEnabled=false` every 5th close skips steps 7 (hive performance push AND the circuit-breaker trip check) and Darwin recalculation** — see correlations.

### 5.2 `classifyOutcome(perf)` (`lessons.js:939-961`)
`feeYield = fees_earned_usd / initial_value_usd × 100`; `isFeeDeath = reason∋"yield"`; `isStopLoss = reason∋"stop loss"`; `isOorCollapse = reason∋(oor|out of range|below) && pnl<0`; `rangeEff` default 100.
- **failure** if `isStopLoss || pnl ≤ −5 || (isFeeDeath && feeYield < 1) || isOorCollapse || (rangeEff < 30 && pnl < 0)`
- **success** if `!isFeeDeath && (pnl ≥ 2 || feeYield ≥ 2)`
- else **neutral**.

### 5.3 `derivLesson` (`:547-644`) — only success/failure produce a lesson. Rules: `AVOID` (bad, range_eff<30), `PREFER` (good, range_eff>80), `AVOID volume collapse`, `WORKED`, `FAILED`. Confidence: good 0.82 if `feeYield≥1 || fees≥3 || pnl≥3` else 0.22; bad 0.88 if `pnl≤−5 || range_eff≤30 || reason∋oor/low yield/volume` else 0.45.

### 5.4 `evolveThresholds(perfData, config)` (`:658-754`) — constants `:21-38`
- Needs ≥ `MIN_EVOLVE_POSITIONS` 5 records; operates on `window = last RECENCY_WINDOW (40)` closes; `curRate = successes/(successes+failures)`.
- **Auto-revert** (`:676-690`): last `type:"adjust"` evolution not `_superseded` with `curRate < metric_before − REGRESSION_MARGIN (0.08)` → restore each `from` value, mark superseded, persist as `type:"revert"` and return.
- **Floor raises** (`:694-712`) only if ≥ `MIN_GROUP_SAMPLE` 3 successes AND 3 failures. For each of `minFeeActiveTvlRatio` (`fee_tvl_ratio`), `minOrganic` (`organic_score`), `minIntelScore` (`signal_snapshot.intel_total`): `adjustFloor` (`:756-767`) requires `mean_s − mean_f > 0` and Cohen's-d `≥ EFFECT_SIZE_MIN 0.35` (pooled sd, `:925-931`); `target = max(p50(failures), 0.95·p25(successes))`; `moved = clamp(nudge(cur, target, MAX_CHANGE_PER_STEP 0.20), bounds)`; rounded (2dp for fee ratio, int otherwise); only raises.
- `EVOLVE_BASELINES = {minFeeActiveTvlRatio 0.05, minOrganic 60, minIntelScore 52}`; `EVOLVE_BOUNDS = {fee 0.05–0.60, organic 55–85, intel 52–70}` (`:34-39`). ⚠️ Prod runs `minIntelScore=61` (log yield mode) — inside bounds, but the relaxer's baseline 52 predates the 2026-08-22 re-baseline (`:30-33` comment).
- **Organic-momentum** (`:715-731`): if `analyzeOrganicMomentumOutcomes(window)` is `ready` and verdict matches `/signal works/` → nudge `organicMomentumDecayTraderPct` toward −15 (clamp −40..−10); `count ≥ 12` → `organicMomentumHardFilter=true`.
- **Throughput relaxer** (`:735-747`): if nothing changed and `closesPerDay(window) < STARVATION_CLOSES_PER_DAY 1.5` → `computeStarvationStep` lowers the floor furthest above baseline (ratio > 1.01) by ≤20% toward baseline.
- `persistEvolution` (`:776-812`): atomic `user-config.json` write (root keys + `_lastEvolved`, `_positionsAtEvolution`), live `config.screening[k]=v`, `evolutions.push({ts,type,positions,window,metric_before,changes{from,to},rationale})` cap 50, plus an `[AUTO-EVOLVED|AUTO-REVERT]` lesson.

### 5.5 Cycle-based starvation relaxer (`index.js:2438-2486`; `lessons.js:826-881`)
State `_screeningStarvation {emptyCycles, lastRelaxedAt}` (state_meta). `reachedLLM` resets to 0. Else `emptyCycles++`; when `≥ starvationRelaxAfterEmptyCycles (12)` and `now − lastRelaxedAt ≥ starvationRelaxCooldownHours (3)·3600s` → `applyStarvationRelaxation` (same `computeStarvationStep`, `persistEvolution type:"adjust"`), `lastRelaxedAt` advanced regardless, Telegram if a floor moved. Only lowers the three evolution-owned floors; `minTvl/minMcap/minVolume/minHolders` are never touched. Verdict-cache skips set `candidatesReachedLLM` before the check so they don't count as starvation.

### 5.6 Darwin signal weights (`signal-weights.js:96-200`)
Config `darwin` (`config.js:834-843`): enabled true, `windowDays` 60, `recalcEvery` 5 (unused — the cadence is the `%5` in recordPerformance), `boostFactor` 1.05, `decayFactor` 0.95, floor 0.3, ceiling 2.5, `minSamples` 10. Lift per signal (numeric: win/loss value split; boolean: win-rate present vs absent; categorical). Weights injected into prompts via `getWeightsSummary`. Captured at deploy via `signal-tracker.js` staging (10-min TTL).

### 5.7 Post-close probes & exit quality (`index.js:649-687`; `lessons.js:337-546`)
`pct = (mcap_m / exit_mcap − 1)·100`; anchor m60 → m180 → m30; `flat` if |pct| < 3; `good_exit` if saved ≥ 8; `early_exit` if missed ≥ 8; else `marginal`; `delisted` when the detail fetch throws or mcap is 0/null; `stale` slot if past `m + 20` min; `unprobeable` if no `exit_mcap`. `complete` + `exit_quality` once every slot resolved. Exit review Telegram only for good/early/delisted on the anchor write. `getExitQualitySummary({limit:30})` groups by `reasonFamily` (stop_loss, crash, trailing_tp, take_profit, oor_below, oor_above, oor_other, low_yield, volume_death, other) with `selling_bottoms = n≥6 && early>good`.

### 5.8 Decision log — `appendDecision` calls: timing-gate skip, circuit-breaker skip, SOL-vol skip, max-positions/insufficient-SOL skips, deploy/no_deploy verdicts (`index.js:1604,1615,1650,1707,1854,1889,2301,2318,2338`). Injected into prompts via `getDecisionSummary`.

### 5.9 Ledger truth (`ledger-truth.js`)
`book = aumEnd − aumStart − deposits + withdrawals`; `Δunreal = unrealEnd − unrealStart`; `drift = book − ledger − Δunreal`; `ledger_fidelity_pct = ledger/(book − Δunreal)·100` when |book−Δunreal| > 0.05 (`:28-43`). `aumAt` = median `snapshot.totalSol` of `balance_history` within ±15 min, else last row ≤ t (`:46-60`). `unrealizedAt` = Σ `pnl_pct/100 × positions.data.amount_sol` using the latest `price_ticks.pnl_pct` ≤ t within 30 min for positions open at t (`:63-80`). `flowsBetween` from state_meta `baseline.deposits/withdrawals` timestamps (`:82-88`). `ledgerBetween` = Σ `pnl_sol_net` (fallback `pnl_sol − total_gas_sol`) over perf `recorded_at` in window, counting `adopted && !adoption_lifetime` as `adopted_lifetime_scored` (`:90-106`). Windows 24h + 7d; pg-only, never throws.

### 5.10 Circuit breaker (`circuit-breaker.js`) — trips screening on consecutive-loss streak or 24h drawdown % (config `risk.*`), state in state_meta `_circuitBreaker`, auto-reset after cooldown; checked at every screening entry (`index.js:1590`) and after each close (subject to the §5.1 early-return caveat).

---

## 6. Report & briefing outputs

**`dashboard-report` doc** (`report.js:105-256`, published every mgmt cycle incl. 0 positions, on screening skips, and by the poller on a new position): `ts, sol_mode, sol_price_usd, next_screen_sec, positions[] (pair, pool, position, in_range, minutes_out_of_range, age_minutes, bins, pnl_* dual-currency, fees, action{action,rule,reason}, health_alerts[], pvp, bins[] histogram, pnl_ticks, peak_pnl_pct, ratchet_armed, trailing_active, stop_pct, trailing_floor_pct, token/liq/fee breakdown, price_lower/upper/active), totals{value_sol,value_true_usd,unclaimed_sol,unclaimed_true_usd}, baseline{total_deposited, deposit_count, last_deposit_at, total_withdrawn, withdrawal_count}, performance{total_pnl_sol, total_pnl_usd, closed, win_rate_pct_legacy, outcome_breakdown, fee_efficiency_validation, organic_momentum_validation}, exit_quality, ledger_truth, held_tokens (from `_lastSampledAum`, ≤1 cycle stale), timing_line, crash_shadow_count_48h (greps today's+yesterday's log files), crash_fast_path_enabled, screening_funnel`. Then `flush` → `NOTIFY meridian_report`. Poller `NOTIFY meridian_tick` payload `{ts, complete, positions[]}` tier-stripped to < 7500 bytes (`index.js:3218-3288`).

**Briefing lines** (`briefing.js:41-320`): AUM headline (`💼 AUM ◎ ($) · 24h % · ROI %` from `balance_history` last 300 + baseline), Activity opened/closed 24h, Performance 24h (Net PnL, Fees, Win %, Best/Worst), Portfolio now (live value/unclaimed/open + per-position lines), All-time era-split totals, lessons 24h, deploy-timing line, `🚪 Exits:` line, `🧾 Wallet truth` ledger line, evolution/threshold drift. Saved to kv `daily_briefing:*`.

---

## 7. Logging (`logger.js`)
- `log(category, msg)`: level inferred from category substring (`error`→error, `warn`→warn, else info) vs `LOG_LEVEL` (default info); stderr + `logs/agent-<local date>.log` (daily rotation by filename; no size cap, no deletion) (`:43-60`). Timestamps local-tz with offset (`:19-28`). `redactSecrets` scrubs `api-key|api_key|apikey|rebate-address` query params (`:33-37`).
- `logAction(action)` → console one-liner + `logs/actions-<date>.jsonl` full JSON (`{timestamp, tool, args, result(summarized), duration_ms, success}`), fail-open on EACCES (`:87-108`); called from `executeTool` (`tools/executor.js:1472, 1699`).
- `logSnapshot` → `logs/snapshots-<date>.jsonl` (`:113-124`).
- Tag inventory (repo-wide, count of call sites): `state` 65, `screening` 53, `cron` 32, `cron_warn` 26, `agent` 26, `telegram_error` 25, `cron_error` 22, `executor` 19, `rebalance` 18, `deploy` 17, `close`/`close_warn` 17, `gmgn` 14, `socket_monitor(_error)` 12/12, `wallet` 9, `startup` 9, `state_error` 8, `safety_block` 7, `lessons` 7, `evolve` 5, `rpc_health` 5, `tx_retry` 5, `signal_weights` 5, `compound` 5, … plus the shadow tags `crash_shadow, rug_shadow, crash_socket_shadow, oor_flip_shadow, swap_free_shadow, close_eff_shadow, fast_close_shadow, exit_telemetry, rpc_rate_limit, rpc_quota, rpc_capability, rpc_failover, rpc_metrics, ledger_truth(_warn), probe(_warn), auto_skim(_warn/_error), transfer(_warn/_error), claude, claude_cli, bear_debate, candle_warn/error, memory/memory_warn, shutdown, command(_error), report_warn, hivemind(_warn)`. Bracketed in-message markers used for grepping: `[SCREENING] funnel:`, `[VERDICT_CACHE]`, `[RANK_SHADOW]`, `[REPORT]`, `[PNL_DISCOVERY]`, `[RECONCILIATION]`, `[WS_HEALTH]`, `[TICK]`, `[EXIT_TELEMETRY]`, `[LEDGER_TRUTH]`, `[ADOPTION_BASIS]`, `[TVL_EXEMPT]`, `[Balance History]`, `[Force Sync]`, `[Opportunity]`.

---

## 8. Env & secrets
- `envcrypt.js` (imported first by `index.js:4`, `cli.js`, replay/extract and most scripts): `dotenv.config({path: .env, override: true})` — **`.env` wins over shell/PM2 env** (`:72-74`); values under a `# encrypted` marker are XOR+base64 decrypted with `ENVRYPT_KEY`/`ENVCRYPT_KEY`/`.envrypt` file (`:35-47, 55-70, 84-90`); keys auto-selected for encryption when `*_KEY` or matching `PRIVATE|SECRET|TOKEN|PASSPHRASE|PASSWORD|MNEMONIC` (`:48-53`). `npm run env:encrypt` → `scripts/envrypt.js`.
- `config.js:83-87` back-fills `LLM_MODEL`, `LLM_BASE_URL`, `DRY_RUN` from user-config with `||=` (env wins). Fallback secrets (`rpcUrl`, `walletKey`, `llmApiKey`, `gmgnApiKey`) may be read from `user-config.json` — scrubbed in prod 2026-06-30.
- Env vars referenced: `WALLET_PRIVATE_KEY, RPC_URL, RPC_URL_FALLBACK_1/2, RPC_INDEXED_URL(_FALLBACK_1/2), PNL_RPC_URL, PNL_RPC_URL_ALT, PNL_RPC_URL_FALLBACK, HELIUS_API_KEYS, HELIUS_API_KEY(_ALT/_FB/_FALLBACK), OLLAMA_API_KEY, LLM_API_KEY, OPENROUTER_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_FALLBACK_MODEL, LLM_REASONING_EFFORT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ALLOWED_USER_IDS, DRY_RUN, PERSIST_BACKEND, PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, PG_POOL_MAX, PG_BACKUP_DIR, PG_BACKUP_KEEP, TICK_STORE_DISABLED, JUPITER_API_KEY, JUPITER_REFERRAL_ACCOUNT, JUPITER_REFERRAL_FEE_BPS, GMGN_API_KEY, LPAGENT_API_KEY, HIVEMIND_API_KEY, AGENT_MERIDIAN_API_URL, PUBLIC_API_KEY, PIONEX_DEPOSIT_ADDRESS, MERIDIAN_COMMAND_PORT/HOST/TOKEN, LOG_LEVEL, ENVRYPT_KEY/ENVCRYPT_KEY, HEARTBEAT_FILE, STALE_THRESHOLD_MS, CHECK_INTERVAL_MS, HEAP_WARN_MB, LOOP_LAG_WARN_MS`.
- **`DRY_RUN=true`** short-circuits: deploy (`tools/dlmm.js:1268`), claim (`:2872`), compound (`:2960`), close (`:3146`), flip (`:4004`), rebalance (`:4193`), swap (`tools/wallet.js:521`), ATA sweep (`:1059`), cooldown gates skipped (`tools/dlmm.js:1117,1125`), executor swap check (`tools/executor.js:1986, 2030`), screening balance pre-checks (`index.js:1651, 3325-3328`); reported in `/config`, `/command/health`, hive register. `cli.js --dry-run` sets it (`cli.js:17`). Persistence, Telegram, LLM calls and DB writes are **not** suppressed.

---

## 9. Correlations, collisions, duplication, SPOFs, dead/inert

**Cron collisions**
1. `autoSkimTask` (`*/5`) fires at :00/:15/:30/:45 exactly when the prod `*/3` mgmt cycle (and `*/15` screening) start; its `_managementBusy||_screeningBusy||busy` guard skips those ticks ("Auto-skim skipped: agent busy"), leaving only :05/:10/:20/:25/:35/:40/:50/:55. Same grid issue that forced reconciliation to `7,22,37,52` and baseline to `:50` (comments `index.js:3375-3380, 3423-3425`). Moot while skim is OFF.
2. `healthTask` (`0 * * * *`) shares the top-of-hour minute with the mgmt cron; both callbacks fire in the same tick, mgmt is registered first and sets `_managementBusy` synchronously (`runManagementCycle:920-921`), so the hourly health check is almost certainly starved every hour in prod (uncertain: depends on node-cron dispatch order; behaviour is a harmless log line either way).
3. `balanceHistoryTask` (`*/5`) has no busy guard and races the piggyback sample; dedup is the 2.5-min `latestBalanceTs` gap, which under pg is one extra query per tick.
4. Screening cron (`*/15`) and mgmt cron (`*/3`) both fire at :00/:15/:30/:45; mgmt's post-cycle "trigger screening" is then blocked by `_screeningBusy` or the 5-min `_screeningLastTriggered` cooldown — fine, but the opportunity poller (45s) also competes for `getTopCandidates` whenever a slot is free, multiplying Meteora/Jupiter discovery load.
5. Poller vs discovery vs mgmt: the 3s poller yields to `_pnlDiscoveryBusy` and vice-versa; a long discovery scan (100 pages) starves exit checks for its duration.
6. `.force-sync` (socket OOR transition) triggers `runManagementCycle({silent:false})` from inside the poller tick; 60s min gap on both writer (`socket-monitor.js:16,340-352`) and consumer (`index.js:502-504`).

**Stores that duplicate data**
- `state_meta.recentEvents` (20-cap ring) ⊂ `position_events` (full audit).
- `pool-memory.deploys[]` mirrors `lessons.performance` per close (`lessons.js:195-225`); `pool-memory` snapshots vs `price_ticks` vs `position_liquidity_ticks` vs `dashboard-report.positions` all carry bin/PnL time series at different cadences and retentions (48/position · 30d · 72h · latest).
- `dashboard-report` copies `getPerformanceSummary`, `exit_quality`, `ledger_truth`, baseline — all also readable from their source docs.
- `daily_briefing:*` snapshots duplicate the same summaries.
- `user-config.json` is both config source and mutable store with four independent writers, two of them non-atomic (`tools/executor.js:1163`, `hivemind.js:97`).
- Legacy `*.json`, `state_doc`, `logs/error-telemetry.json` are stale cold copies under pg.
- Typed tables from `001_init.sql` (`closed_positions, pools, pool_snapshots, lessons, smart_wallets, token_blacklist, dev_blocklist, strategy_library, signal_weights, error_telemetry`) exist empty alongside the kv docs that hold the same data.

**Single points of failure**
- One PM2 `meridian` process is the only writer and the only heartbeat source; the watchdog cannot see a wedged `_managementBusy`/`busy` (heartbeat still written by the poller tick, §1).
- `RPC_URL` (one Helius key) for **every send**; no failover on the send path; quota/429 on that key blocks deploys, closes, swaps, transfers even while reads fail over.
- `pool-discovery-api.datapi.meteora.ag` — screening, pool health, exit-mcap capture, post-close probes, and rank envelope all depend on it with no retry/backoff; a 429/5xx burst throws through `getTopCandidates` and marks probes `delisted`.
- `datapi.jup.ag` prices are fetched uncached every 3s tick; an outage zeros valuations (positions flagged `missing_price`) and stalls AUM sampling.
- Postgres: every store's `set()` chains on it; failures are logged and dropped (`db/doc-store.js:69`), state upserts retry on next mutation — but `initState()` at boot is mandatory, so a DB outage prevents restart.
- Telegram token: inbound control + all alerts; watchdog/syncer/backup each open their own HTTPS path (no shared queue).
- `.heartbeat`, `.force-sync`, `.telegram-marker.json` are single files in the repo dir (a `reset --hard` does not remove them since untracked, but `git clean` would).
- Hard-coded default API keys for Jupiter (`tools/wallet.js:139`) and Agent Meridian/HiveMind (`config.js:11-12`) — shared/public credentials are the fallback for everyone.

**Dead / inert under prod config**
- `evolveThresholds`: skipped (`evolutionEnabled=false` prod) — and the early `return` at `lessons.js:229-231` also skips Darwin recalculation, `pushHivePerformanceEvent`, and the post-close circuit-breaker check on every 5th close. Circuit breaker is still checked at every screening entry, so the trip is delayed at most to the next screening cycle, but the `tripCircuitBreaker` Telegram notice path from a close never fires on those closes.
- `darwin.recalcEvery` config key is read nowhere; cadence is the `%5` above.
- `JUPITER_PRICE_API` constant (`tools/wallet.js:137`) unused.
- `fetchLpAgentOpenPositions` inert without `LPAGENT_API_KEY`.
- Bear debate (`bearDebateEnabled=false`), rebalance engine shadow, adaptive trailing / inventory exhaustion shadow, crash/rug fast-paths shadow, OOR-flip, swap-free redeposit, fee compounding, TWAP guard, close-efficiency gate, exit-swap guard, slippage cap, scout/probe tiers, timing gate, re-entry cooldown, safety-enrich: all log-only in prod per CLAUDE.md — their shadow logs are the only artifact.
- `healthCheckIntervalMin` config value is not wired to the hard-coded `0 * * * *`.
- `config.pnl.source` default `"rpc"`; the Meteora `portfolio/open` path is fallback only.
- GMGN paths dormant unless `GMGN_API_KEY` present (safety enrich then relies on Jupiter audit only).
- `indicators.enabled` false → chart-indicators endpoint unused.
- `RPC_URL_FALLBACK_*` Helius URLs are dropped from the standard pool (only their keys are harvested); only non-Helius fallbacks are admitted as-is (`tools/rpc.js:155-158`).
- CLAUDE.md drift vs code: PM2 `max_memory_restart` 2G (not 512M); PnL RPC default is public mainnet with `pump.helius-rpc.com` explicitly excluded; HiveMind is on by default via built-in constants, not `HIVE_MIND_URL/_API_KEY`; the heap warning in `index.js:927-933` assumes a 2048MB limit, watchdog warns at 1500MB.

**Uncertainties**: prod cadences (3-min mgmt / 15-min screening), `autoSkim.enabled`, `evolutionEnabled=false`, `screeningAdmissionMode=rank` are taken from CLAUDE.md/in-code comments, not from a prod `user-config.json`; node-cron same-minute dispatch order (§9 item 2) not verified; whether the VM sets `MERIDIAN_COMMAND_PORT` to avoid NeoTasker's 3001 not verifiable here.
