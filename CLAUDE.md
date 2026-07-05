# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Deployment & Runtime (where this actually runs)

Production Meridian runs **24/7 on the Oracle Cloud "Always Free" VM**, not on a local
Mac. The local checkout (`/Users/Angga/Repos/meridian`) is a dev copy — its `state.json`
is typically empty and `.env` is absent; live wallet/position state and secrets live on
the VM. Source of truth for the surrounding infra is the **HomeArchitecture** repo
(`/Users/Angga/Repos/HomeArchitecture`, `AGENTS.md` + `docs/network/topology.md`).

**Host — Oracle Cloud VM (`oraclevm.fardana.com`)**
- Public IP `161.118.200.222`; WireGuard overlay IP `10.100.0.10` (home `wireguard-biznet` mesh, `10.100.0.0/24`).
- Ubuntu 24.04 LTS, **aarch64** (4 ARM OCPUs / 24 GB RAM / 200 GB SSD) — Ampere Always-Free shape. Build native deps for ARM.
- SSH: `ssh root@oraclevm.fardana.com` (or `root@10.100.0.10`), port 22, key-only. `angga` user also exists.
- Hardening: UFW (only SSH public ingress; full ingress on `wg0`), fail2ban, unattended-upgrades. Zabbix `zabbix-agent2` reports to Zabbix server `192.168.1.254` (host technical name `10.100.0.10`).

**Process management on the VM**
- Runs under **PM2** via `ecosystem.config.cjs`. Apps: `meridian` (main, fork mode, autorestart, 512M `max_memory_restart`), `meridian-watchdog` (always-on), `meridian-dashboard` (web UI), `meridian-syncer` (cron, hourly git pull — `autorestart:false`, so "stopped" between ticks is normal), `meridian-db-backup` (cron, daily 03:17 → `pg_dump`). (The old `meridian-status-generator` cron + `monitor-status.json` were retired once the dashboard read everything live from the DB.)
- Operate with the npm wrappers: `npm run pm2:start` / `pm2:restart` (`--update-env`) / `pm2:logs`. Always start via the ecosystem file so `cwd`/script paths stay pinned. After changing the running set, `pm2 save` so it survives reboot.
- **Deploy flow:** the live tree at `/opt/meridian` tracks branch `experimental` and is updated by git (the `meridian-syncer` job pulls hourly). Push from the Mac, then update the VM — **in this order, as separate commands, never combined into one ssh invocation**:
  1. **Inspect first:** `sudo -u angga git -C /opt/meridian status --short` + `git stash list`. If any TRACKED file is modified, STOP — direct-on-VM hotfixes happen (and the Antigravity monitor can edit files too). Capture them before anything destructive: `sudo -u angga git -C /opt/meridian diff > /tmp/vm-edits.patch`, review, and port to git if novel (compare against history first — commits like `85e296a` have ported VM edits before, so a dirty file may be a stale already-ported leftover).
  2. **Prefer merge over reset:** with a clean tree use `sudo -u angga git -C /opt/meridian pull --ff-only` (the syncer's native mechanism). With dirty-but-captured edits, try `git stash && git pull --ff-only && git stash pop` to preserve them through the update. Reach for `git fetch && git reset --hard origin/experimental` ONLY when the tree is clean or the dirty files are confirmed stale/ported — `reset --hard` destroys uncommitted work irrecoverably (near-miss on 2026-07-05).
  3. `sudo -u angga pm2 restart meridian --update-env` to load the new code (a pull alone does not reload the running process).
  Do NOT leave rsync'd files in the tree — the next syncer pull will fight them. Gitignored files (`.env`, `user-config.json`, `state.json`, the `*.json` data stores) survive a hard reset.

**LLM runtime**
- Inference goes to the **OpenRouter API** (HomeArchitecture notes local Ollama was decommissioned to free VM RAM/CPU). Per-role models live in `user-config.json`.

**Co-tenant services on the same VM (don't disrupt)**
- **NeoTasker** production instance on port 3001 (its own PM2-managed process + monitor + cron scanner).
- **PostgreSQL 16** at `localhost:5432`. NeoTasker uses database `fardana`; **Meridian uses its own database `meridian`** (role `meridian`, least-privilege). Keep them separate.

**Access path from the Mac**: VPN through the Biznet bastion (`biz.fardana.com`) → WireGuard. The VM is reachable at `10.100.0.10` over that overlay.

**⚠️ Env loading gotcha:** `envcrypt.js` calls `dotenv.config({ override: true })`, so values in `.env` **win over shell exports**. To change `PERSIST_BACKEND`, `DRY_RUN`, RPC keys, etc., edit `/opt/meridian/.env` — `PERSIST_BACKEND=pg node index.js` on the command line will be silently overridden by `.env`.

**Helius backrun rebates (enabled 2026-06-22):** `RPC_URL` carries a `&rebate-address=<agent wallet>` query param. Helius shares ~50% of the MEV our trades create (post-trade backruns) and pays it in SOL directly to that address. Because all transaction sends — DLMM deploy/close/claim (`tools/dlmm.js`) and Jupiter swaps (`tools/wallet.js`) — broadcast through `process.env.RPC_URL` directly (bypassing the `tools/rpc.js` failover pool, which is read-only), 100% of our sends are rebate-eligible. The param is harmless on the read calls that share `RPC_URL` (Helius ignores it for non-`sendTransaction` methods) and is stripped from logs by `maskUrl()`. No latency/reliability cost — our tx is placed first in the bundle and lands independent of the backrun. Rebate income is small at our position sizes (~0.35–0.5 SOL) but strictly additive and **auto-compounds**, since the SOL lands in the wallet balance `computeDeployAmount()` reads. Minor accounting caveat: async rebate SOL registers as unattributed wallet growth, so balance-history/PnL slightly over-credits the wallet vs. position performance — negligible, not a bug. To disable: remove the param from `.env` and restart. (Set to `json`-style instant rollback — the `.env.bak.rebate` backup holds the pre-change line.)

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
balance-history.js  AUM time-series persistence (pg `balance_history` table; json → balance-history.json). Normalized out of kv_store 2026-06-30.
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

Pre-deploy analytics & signals (surfaced into the SCREENER candidate blocks; advisory unless noted):
fee-efficiency.js   Ranks candidates by fee yield per unit of IL risk (fee_active_tvl_ratio/volatility), relative to the set. Caches per-pool for deploy capture; analyzeFeeEfficiencyOutcomes() validates rank→PnL.
organic-momentum.js Is the crowd growing or leaving? Classifies GROWING/steady/DECAYING from unique-trader/volume/holder _change_pct trends (already in the discovery payload) + a breadth floor. The strongest persistence signal — a hot pool the crowd is abandoning dies in ~1h. Deploy capture + analyzeOrganicMomentumOutcomes() validation; optional hard-filter (config organicMomentumHardFilter, default off).
pool-simulator.js   Pre-deploy what-if for a representative range: APR, in-range factor, ballpark IL, risk-adjusted score (the `sim:` candidate line). Also exposed as the simulate_pool tool.
pnl-curve.js        CL closed-form position value across a price range (simulate_pnl_curve tool / pool-simulator IL geometry).
range-survival.js   In-range survival probability across horizons (1h/6h/24h) + the shared volatility/in-range math used by pool-simulator (predict_range_survival tool).
position-alerts.js  Open-position health alerts in the management cycle: fee-share dilution, yield decay, volume death, fee-ratio collapse (config poolHealth*).
pvp.js              Same-symbol rival detection (shared by screening's enrichPvpRisk and the management-cycle PVP-on-positions check).
deploy-timing.js    Hour-of-day deploy-timing analytics from our own closed-position history (getAllPerformance): UTC blocks with success-rate/avg-PnL/OOR per block, Wilson-bounded; reuses lessons.classifyOutcome. Deploy time derived as recorded_at − minutes_held. Phase 1: advisory line in the screener goal (gated on ≥40 decisive closes) + /timing command + briefing line. Phase 2 (getDeployTimingGate/decideTimingGate): the AUTONOMOUS screener size-downs or skips deploys in historically weak UTC blocks (config `timing.*`, default OFF; manual /deploy unaffected). See docs/plans/01-deploy-timing.md.
lper-signal.js      LPAgent winning-LPer signal for the screener (study.js aggregates): a `top_lpers:` candidate line (consensus range style, ~avg bins, hold, win-rate, open-PnL, suggested style). Deterministic enrichment in runScreeningCycle — studies only the few post-filter candidates (config lpStudyMaxPools), 30m client cache, 429/no-data degrades silently; fields sanitized. ADVISORY (config lpStudy*); staged into Darwinian signals. Phase 2 (lperBinsRecommendation): with `lpStyleSteerEnabled`, surfaces a per-candidate `bins_hint` matching the winning LPers' range width (clamped to the playstyle envelope) + a screener STEPS rule to prefer it over the volatility formula. See docs/plans/03-lpagent-screener-signal.md.

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API

db/                 PostgreSQL persistence layer (see "Persistence & Database")
  pool.js           pg.Pool + usePg() backend flag + withTransaction()
  doc-store.js      makeDocStore(): cache + ordered write-through for the non-state stores
  migrate.js        forward-only SQL migration runner (npm run db:migrate / db:status)
  migrations/       001_init.sql, 002_state_doc.sql, 003_kv_store.sql
  import-state.js   one-shot: state.json  → state_doc
  import-kv.js      one-shot: the other JSON files → kv_store
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool, simulate_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note, simulate_pnl_curve, predict_range_survival |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBotHoldersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |
| playstyle | strategy | balanced (tight/balanced/wide → bins presets; see bins_below Calculation) |

Signal/alert keys live in the same `screening`/`management` sections (defaults in `config.js`): `organicMomentum*` (Enabled, DecayTraderPct −22, DecayVolumePct −42, GrowTraderPct 38, MinUniqueTraders 30, HardFilter off) for organic-momentum; `poolHealth*` (Enabled, AutoReview, MinSnapshots, MinAgeMinutes, WindowSize, YieldDecayPct, TvlDilutionRisePct, VolumeDeathPct, FeeRatioCollapsePct) for position-alerts. LPAgent/steer keys (screening): `lpStudyEnabled`, `lpStudyMaxPools` (4), `lpStudyMinWinnersForStyle` (3), `lpStyleSteerEnabled` (off). Deploy-timing gate lives in its own `timing` section: `timingGateEnabled` (off), `timingMinBucketN` (8), `timingDeadHourSuccessFloor` (0.20), `timingDeadHourAction` (size_down|skip), `timingSizeDownPct` (0.5) — all tunable via `update_config`. Price-crash fast-path keys (management, plan #04): `crashFastPathEnabled` (off — shadow mode logs `crash_shadow` would-fires while off), `crashBinsPerMin` (12), `crashMinBinDistance` (8), `crashConfirmTicks` (3), `crashWindowSec` (90), `crashMinSpanSec` (9). When ON, the PnL poller fast-closes an OOR-below position falling ≥ crashBinsPerMin (velocity over the trail window), bypassing `outOfRangeWaitMinutesBelow` via the existing confirm-tick + mechanical-close path (rule `crash`). Downside-only; never fires in-range or above.

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Persistence & Database

Meridian persists through a **swappable backend** chosen by the `PERSIST_BACKEND` env var
(read via `db/pool.js` `usePg()`):

- `json` (legacy, still the fallback): each store is a flat JSON file at the repo root,
  written atomically (temp file + `rename`).
- `pg` (**current production backend**, live since 2026-06-18): PostgreSQL 16 on the VM,
  database `meridian`. **Production runs `PERSIST_BACKEND=pg`.** Flip back to `json` (in
  `.env`) for an instant rollback — the JSON files remain as a cold copy.

**Design — synchronous API over an async store.** A full async/await rewrite would have
touched ~75 call sites on the money path. Instead every store keeps its **synchronous**
`load()`/`save()` (and `get*`/`record*`) API, fronted by an **in-process cache with ordered
write-through**:
- Reads return from the cache synchronously → call sites unchanged.
- Mutations update the cache synchronously, then enqueue an **ordered** async persist
  (a `_writeChain` promise) so concurrent writes can't clobber each other.
- The single live PM2 `meridian` process is the sole writer; `cli` and the dashboard read
  through the same code (or read-only DB queries), so there is no cross-process write race.

**Startup is mandatory under `pg`** (Postgres can't be read synchronously): the cache must be
primed before any accessor runs.
- `index.js` boot (the `isMain` block) does top-level `await initState()` + `await initAllDocStores()`.
- `cli.js` primes both caches once before its command switch.
- Shutdown drains pending writes: `flushState()` + `flushAllDocStores()` in the SIGINT/SIGTERM handler.

**Storage shapes in Postgres:**
| Store | Module | Table(s) | Notes |
|-------|--------|----------|-------|
| position registry | `state.js` | **`positions`** (1 row/position, full object in `data` jsonb + promoted query columns), **`position_events`** (append-only audit), **`state_meta`** (singletons) | **NORMALIZED** (2026-06-18). The capital-critical store. |
| balance history | `balance-history.js` | **`balance_history`** (1 row/sample: `total_usd` + full `snapshot` jsonb + `created_at`) | **NORMALIZED** (2026-06-30). INSERT/sample + count-based retention (8640); dashboard `/api/balance-history` reads the table. |
| lessons, pool-memory, decision-log, signal-weights, strategy-library, smart-wallets, token-blacklist, dev-blocklist, error-telemetry | resp. | `kv_store` (one jsonb row per store, keyed by name) | document form, via `db/doc-store.js` `makeDocStore()` |

**state normalization (state.js under pg):** the cache façade is unchanged (25 sync
accessors, unchanged call sites). `save()` diffs the positions map against an in-process
`_lastPersisted` snapshot and **upserts only changed rows** into `positions` (via
`withTransaction()`); `pushEvent()` queues rows for `position_events`; singletons go to
`state_meta`. `initState()` reconstructs the exact cache shape from these tables (lossless —
`positions.data` holds the full object), with a one-time fallback to `state_doc` if the tables
are empty. The legacy `state_doc` row is **retained untouched as a rollback snapshot**.
Seed/repair with `node db/import-state-normalized.js` (`--force` to truncate+reimport).

The remaining 9 doc stores stay `kv_store` documents (several are inherently document/singleton
shaped). The typed tables `closed_positions`/`pools`/`pool_snapshots`/etc. from `001_init.sql`
are still provisioned for a later per-store normalization if their query value warrants it.

**Crash safety (state.js).** `save()` writes atomically; `load()` recovers from a rolling
`state.json.bak` on corruption and **halts rather than returning empty positions** (an empty
load would make the agent forget live on-chain positions). Under `pg` the write-behind window
(a mutation lost to SIGKILL before its async flush) is self-healed by
`reconcileStateWithChain()`, which reconciles tracked state against on-chain truth every cycle.

**Operations:**
- Migrate: `npm run db:migrate` (status: `npm run db:status`). Forward-only; each migration
  runs in a transaction and is recorded in `schema_migrations`.
- Seed from legacy files (one-shot, run with the agent stopped): `node db/import-state.js`,
  `node db/import-kv.js` (`--force` to overwrite).
- Credentials: standard libpq vars (`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`) in
  `/opt/meridian/.env` (gitignored). Pool capped small (`PG_POOL_MAX`, default 5) — VM RAM is
  shared with NeoTasker + PG.
- **Backups (Phase 6):** `scripts/db_backup.js` (PM2 cron `meridian-db-backup`, daily 03:17)
  writes compressed `pg_dump -Fc` files to `/opt/meridian-backups` (outside the repo, so the
  git syncer's `reset --hard` can't touch them; dir is `angga`-owned), retaining
  `PG_BACKUP_KEEP` (default 14) and pinging Telegram. **Restore:**
  `pg_restore -h 127.0.0.1 -U meridian -d meridian --clean --if-exists <file.dump>`.
- Full design + migration history: see `POSTGRES_MIGRATION.md`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- Deploy amount must include positive SOL (`amount_y` or `amount_sol`)
- Range width must be at least the configured safe bins floor (`minBinsBelow`, never below 35)
- Single-side SOL deploys must keep `bins_above=0`
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Linear formula based on pool volatility (set in screener prompt, `index.js`). The lower/upper bounds are configurable, with a hard safety floor of 35 bins:

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow))
clamped to [minBinsBelow, maxBinsBelow]
```

- Volatility must be finite and > 0; zero/missing volatility is treated as an unusable feed
- Low valid volatility → minBinsBelow
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

**Playstyle presets (plan #2).** `config.strategy.playstyle` selects the tight/balanced/wide
bins range via `PLAYSTYLE_PRESETS` in `config.js`: `tight {35,45}`, `balanced {35,69}` (=the
historical default, so unset/balanced is a no-op), `wide {60,110}`. The preset only fills the
`minBinsBelow`/`maxBinsBelow` *defaults* — explicit values in `user-config.json` still win. The
active mode is surfaced in the screener prompt (both `prompt.js` and the `index.js` STEPS block,
which share the formula). Switch at runtime with `update_config playstyle=wide` — the executor
resolves the preset into `min/max/defaultBinsBelow` (unless the same call sets bins explicitly),
applies live, and persists. The 35-bin `MIN_SAFE_BINS_BELOW` floor still clamps everything. Note
`wide` can exceed 69 bins → the gas-break-even filter treats those deploys as wide (higher gas
estimate), which is correct.

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBotHoldersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json.
  Prod (2026-06-19): `screeningModel = deepseek-v4-pro` (more tool-reliable for the deploy
  decision); management/general stay on `deepseek-v4-flash`.
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)
- **OpenRouter model ids are the unprefixed `deepseek-v4-flash`/`deepseek-v4-pro`** (the
  gateway rejects the `deepseek/…` prefixed form). Verify a new id with a test completion
  before putting it in user-config.json — a bad id silently degrades to empty responses.
- **No-tool-call quirk:** deepseek *thinking* models don't support `tool_choice` (cached per
  model), so tool use can't be forced and the model occasionally returns a final text answer
  with no tool call. The agent loop retries 3× then returns a calm `noToolFallback` result;
  cron cycles present it as an ℹ️ "no action this cycle" notice (not an error). See agent.js.

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- **`classifyOutcome(perf)` → `success | failure | neutral`** — the learning objective. **NOT pnl-sign**: a break-even *fee-death* (low-yield close) is a `failure`/`neutral`, never a success. Drives both `evolveThresholds` and `derivLesson` (so a fee-death can't become a "PREFER" lesson). Fixing this was the core of the evolution overhaul — the old pnl-sign objective counted 75/118 closes as "winners" (22 of them fee-deaths) vs the true ~34% success rate.
- `evolveThresholds()` — every 5 closes, adjusts `minFeeActiveTvlRatio`/`minOrganic`/`minIntelScore` (+ organic-momentum filter) using the corrected objective over a **recency window** (last 40 closes), with: a significance gate (≥3 per group AND Cohen's-d ≥ 0.35), **direction-correct** floor raises only (lowering is the starvation relaxer), percentile targets, hard bounds (`EVOLVE_BOUNDS`) to cap ratcheting, and **closed-loop self-correction** — each change stores the success-rate at decision time and is **auto-reverted** next cycle if the rate regresses. Gated organic-momentum changes consume `analyzeOrganicMomentumOutcomes`. Atomic `user-config.json` write.
- **Dashboard getters:** `getEvolutionHistory()` (change log w/ from→to + rationale), `getThresholdDrift()` (current vs baseline per floor), and `getPerformanceSummary().outcome_breakdown` (success/failure/neutral, real success-rate, fee-death-rate).

---

## Hive Mind (hive-mind.js)

Optional feature. Enabled by setting `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` in `.env`.
Syncs lessons/deploys to a shared server, queries consensus patterns.
Not required for normal operation.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint (Helius in prod; carries `&rebate-address=<wallet>` for backrun rebates — see Deployment) |
| `RPC_URL_FALLBACK_1` / `_2` | No | Failover RPC endpoints for the read-only `tools/rpc.js` pool (primary `RPC_URL` is preferred while healthy) |
| `PNL_RPC_URL` | No | RPC endpoint for the PnL poller/deposit history (`config.pnl.rpcUrl`); falls back to `https://pump.helius-rpc.com` |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |
| `PERSIST_BACKEND` | No | `json` (default) or `pg` — selects the persistence backend (see Persistence & Database). **Prod = `pg`.** |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | when `pg` | Postgres connection (libpq vars) |
| `PG_POOL_MAX` | No | pg pool size (default 5) |

**Secrets live in `.env` only — never in `user-config.json` or source.** `config.js` *can* read
a few secrets from `user-config.json` as a fallback (`rpcUrl`/`walletKey`/`llmApiKey`/`gmgnApiKey`,
applied with `||=` so `.env` always wins), but that file is plaintext, agent-writable, and would
land in `pg_dump` backups if it held a secret — so keep keys out of it. They were scrubbed from the
prod `user-config.json` on 2026-06-30 (`pnlRpcUrl` moved to `.env` `PNL_RPC_URL`), and a hardcoded
key was removed from `scripts/compare_rpcs.js` (which reads `RPC_COMPARE_A`/`_B` now). Postgres is
*not* a secret store — PG creds themselves come from `.env`, so secrets can't bootstrap from it.

---

## Adding a New Persisted Store

1. `const _store = makeDocStore("my-store", repoPath("my-store.json"), () => ({}))` (`db/doc-store.js`).
2. Replace the module's `load()`/`save()` bodies with `_store.get()` / `_store.set(data)` — keep them synchronous so call sites don't change.
3. The store auto-registers, so `initAllDocStores()` / `flushAllDocStores()` (already wired in `index.js` + `cli.js`) cover it.
4. To seed existing data into Postgres, add the file to the `STORES` map in `db/import-kv.js`.
5. Avoid reading the raw JSON file elsewhere via `fs` — go through the module's exports, or that path goes stale under `pg` (this bit the `/thresholds` evolve command; fixed via `getAllPerformance()` in lessons.js).

---

## Known Issues / Tech Debt

- **⚠️ Unit landmine: `*_usd` fields carry SOL when `management.solMode=true`** (prod runs solMode).
  `pnl_usd`, `fees_usd`, `deployed_usd`, `fees_earned_usd`, `initial/final_value_usd`,
  `exit_pnl_usd`, `total_fees_claimed_usd` etc. are SOL-denominated end-to-end (dlmm → state →
  lessons → decision-log). The lessons/evolution engine is internally consistent (ratios cancel),
  but NEVER render these with a `$` sign. For honest display use: the `*_true_usd` fields on open
  positions (getMyPositions), the `pnl_usd_true`/`deployed_*_true`/`fees_*_true` fields on
  closePosition results + performance records (dual-written since 2026-07-05), or `sol-price.js`
  (`getSolPriceUsd()`, fed by every getWalletBalances call; `telegram.js fmtSolUsd()` renders
  "◎X ($Y)"). Full unit normalization of the legacy fields remains open tech debt.
- **Price-crash fast-path (implemented 2026-07-05, shipped OFF in shadow mode):**
  `docs/plans/04-price-crash-fastpath.md`. Bin-velocity detector in the PnL poller bypasses
  `outOfRangeWaitMinutesBelow` on rugs (~63 min → ~15 s). While `crashFastPathEnabled=false`
  the detector logs `crash_shadow` would-fire lines for live calibration — grep them for a few
  days, cross-check against position outcomes, then enable via `update_config`. Rollback is
  instant (`crashFastPathEnabled=false`, no restart).
- **state + balance-history are normalized; 9 doc stores are not.** State lives in real `positions`/`position_events`/`state_meta` rows; balance-history lives in `balance_history` rows (normalized 2026-06-30 — was the worst offender, an 8640-element array rewritten whole every 5 min). The remaining 9 doc stores are still single `kv_store` jsonb documents (each write re-serializes the whole doc — same as the old files, no regression). The still-tabular ones (pool-memory snapshots, lessons.performance, error-telemetry) would benefit from row normalization; signal-weights/strategy-library/decision-log/blacklists are inherently document-shaped and fine as-is.
- **Phase 6 done:** daily `pg_dump` via `meridian-db-backup` → `/opt/meridian-backups` (see Persistence ops above). Note these are logical dumps, not WAL/PITR — restore granularity is daily.
- **Phase 5 done (now superseded):** monitoring data was first surfaced via `status_generator` → `monitor-status.json`; the dashboard now reads everything live from Postgres (decisions/positions from `kv_store`/`positions`, wallet address from `state_meta`) + live RPC for on-chain `balance`/`positions`, so that generator + file were retired.
- **Circuit Breaker resolved (2026-06-19)**: The circuit breaker state (`_circuitBreaker`) is now fully normalized into PostgreSQL (`state_meta` table) via synchronous wrappers in `state.js`. Performance logs are correctly loaded via `getAllPerformance()` from `lessons.js` instead of the stale `lessons.json` file on disk.
- The legacy `*.json` data files and the `state_doc` row are now **stale under `pg`** — intentionally kept as a cold rollback copy. Don't read them directly.
- **Gas-fee accounting (fixed 2026-06-22).** `fetchTxFeeLamports` now retries (4×800ms) so priority fees are captured for all tx types. Exit-swap slippage is also now captured additively via `recordExitSwapOutcome` (called from executor.js after every auto-swap) — stored in `exit_swap.slippage_usd` + `pnl_usd_net_exit_swap` on the closed-position record. The canonical `pnl_pct`/`pnl_usd` is still the pre-swap market value (consumed by lessons/evolve before the swap runs), so realized PnL remains mildly optimistic for illiquid exits, but the slippage cost is now tracked for analysis.
