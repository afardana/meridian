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
- Runs under **PM2** via `ecosystem.config.cjs`. Apps: `meridian` (main, fork mode, autorestart, 512M `max_memory_restart`), `meridian-watchdog` (always-on), `meridian-dashboard` (web UI), `meridian-syncer` (cron, hourly git pull — `autorestart:false`, so "stopped" between ticks is normal), `meridian-db-backup` (cron, daily 03:17 → `pg_dump`). (The old `meridian-status-generator` cron + `monitor-status.json` were retired once the dashboard read everything live from the DB. The `meridian-monitor` Antigravity agy cron was **retired 2026-07-05** — it applied config changes autonomously from stale premises with no audit trail; `scripts/antigravity_monitor.py` remains for manual ADVISORY-ONLY runs, and continuous adaptation is owned by the native data loop: evolveThresholds + post-close probes /exits + crash telemetry.)
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
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json). recordPositionSnapshot
                    keys snapshots per distinct position (48 snaps/position, max 10 buckets/480
                    total per pool, whole-oldest-bucket eviction) so a later position in the same
                    pool no longer evicts an earlier position's series. Also owns the
                    rejected-candidates doc store (separate from the hot pool-memory doc):
                    per-cycle snapshots of funnel-rejected and accepted-but-not-deployed candidates
                    (15 pools/cycle, 12-snap ring, 5 reasons, 400-pool cap) — the prerequisite for
                    the replay harness's selection counterfactuals. try/catch-isolated, never breaks
                    screening.
strategy-library.js Saved LP strategies (strategy-library.json)
balance-history.js  AUM time-series persistence (pg `balance_history` table; json → balance-history.json). Normalized out of kv_store 2026-06-30.
briefing.js         Daily Telegram briefing (HTML)
report.js           Dashboard report publisher: at the end of every management cycle (incl.
                    zero-positions), writes a `dashboard-report` kv doc — positions w/
                    dual-currency + Σ derived PnL + actions/health, totals, performance
                    outcome_breakdown, exit-quality summary, deploy-timing line, crash_shadow
                    48h count, baseline. The web dashboard RENDERS this doc instead of
                    re-deriving from raw tables (re-derivation caused its unit drift — SOL-
                    carrying *_usd fields displayed as "$"). Non-fatal by construction.
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
llm-verdicts.js     Deploy confidence capture (CONFIDENCE: NN + THESIS parse) + bear-case debate:
                    one extra adversarial LLM call attacks each deploy thesis before execution
                    (VERDICT: veto/proceed/size_down). Gate lives in agent.js's tool-dispatch seam
                    (the only place that can cancel/mutate before executeTool). Fail-open on any
                    parse/API error. Default bearDebateAction="log_only" (runs + logs the 🐻
                    would-do verdict, changes nothing); "enforce" makes veto block the cycle and
                    size_down halve the amount in-flight. Both verdicts attach to the position
                    record (state.attachDeployVerdicts) and flow into perf records for outcome
                    correlation (lessons.js analyzeConfidenceCalibration/analyzeBearDebateOutcomes).
logger.js           Daily-rotating log files + action audit trail

Pre-deploy analytics & signals (surfaced into the SCREENER candidate blocks; advisory unless noted):
fee-efficiency.js   Ranks candidates by fee yield per unit of IL risk (fee_active_tvl_ratio/volatility), relative to the set. Caches per-pool for deploy capture; analyzeFeeEfficiencyOutcomes() validates rank→PnL.
organic-momentum.js Is the crowd growing or leaving? Classifies GROWING/steady/DECAYING from unique-trader/volume/holder _change_pct trends (already in the discovery payload) + a breadth floor. The strongest persistence signal — a hot pool the crowd is abandoning dies in ~1h. Deploy capture + analyzeOrganicMomentumOutcomes() validation; optional hard-filter (config organicMomentumHardFilter, default off).
pool-simulator.js   Pre-deploy what-if for a representative range: APR, in-range factor, ballpark IL, risk-adjusted score (the `sim:` candidate line). Also exposed as the simulate_pool tool. volPremiumCheck() (Panoptic/Gauntlet framing: an LP position is a short option whose premium is expected IL) reuses apr_effective_pct + horizon-scaled il_pct to compute a fee_edge_ratio — verdicts fees_cover_premium (>=1.5x) / marginal / premium_exceeds_fees (<0.8x), surfaced as `edge=Nx` on the `sim:` line (⚠️ when premium>fees). Advisory only, no config keys, no filtering.
pnl-curve.js        CL closed-form position value across a price range (simulate_pnl_curve tool / pool-simulator IL geometry).
range-survival.js   In-range survival probability across horizons (1h/6h/24h) + the shared volatility/in-range math used by pool-simulator (predict_range_survival tool).
position-alerts.js  Open-position health alerts in the management cycle: fee-share dilution, yield decay, volume death, fee-ratio collapse (config poolHealth*).
pvp.js              Same-symbol rival detection (shared by screening's enrichPvpRisk and the management-cycle PVP-on-positions check).
deploy-timing.js    Hour-of-day deploy-timing analytics from our own closed-position history (getAllPerformance): UTC blocks with success-rate/avg-PnL/OOR per block, Wilson-bounded; reuses lessons.classifyOutcome. Deploy time derived as recorded_at − minutes_held. Phase 1: advisory line in the screener goal (gated on ≥40 decisive closes) + /timing command + briefing line. Phase 2 (getDeployTimingGate/decideTimingGate): the AUTONOMOUS screener size-downs or skips deploys in historically weak UTC blocks (config `timing.*`, default OFF; manual /deploy unaffected). See docs/plans/01-deploy-timing.md.
lper-signal.js      LPAgent winning-LPer signal for the screener (study.js aggregates): a `top_lpers:` candidate line (consensus range style, ~avg bins, hold, win-rate, open-PnL, suggested style). Deterministic enrichment in runScreeningCycle — studies only the few post-filter candidates (config lpStudyMaxPools), 30m client cache, 429/no-data degrades silently; fields sanitized. ADVISORY (config lpStudy*); staged into Darwinian signals. Phase 2 (lperBinsRecommendation): with `lpStyleSteerEnabled`, surfaces a per-candidate `bins_hint` matching the winning LPers' range width (clamped to the playstyle envelope) + a screener STEPS rule to prefer it over the volatility formula. See docs/plans/03-lpagent-screener-signal.md.
episodic memory     (lessons.js, FinMem pattern) Each screening candidate shows the K=3 most similar
                    PAST deploys and their real outcomes (`similar_past:` candidate line) — distance
                    over log-scaled mcap/tvl + volatility + fee_tvl + organic + token-age, missing
                    dimensions skipped with weight renormalization, mild recency tie-break, null below
                    2 usable records. getSimilarDeploys() in lessons.js; cluster-correctness verified
                    (low-mcap/high-vol candidates only retrieve their own history era).

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
  tick-store.js     `price_ticks` bin/PnL ring (DATA CAPTURE ONLY, nothing money-path reads it).
                    Poller rows carry pnl_pct + active_bin (~45s); socket rows carry active_bin
                    only, on every lbPair write. **Socket rows are deduped on unchanged
                    active_bin** — 98.8% of captured socket rows repeated the previous bin
                    (470,885 rows → 5,445 real transitions, measured 2026-07-25), and a repeat
                    carries nothing a transition + timestamp doesn't (dwell time is recoverable
                    from the next change). Poller rows are never deduped (pnl moves while the bin
                    holds). Retention `RETENTION_HOURS` = **30d** (was 72h): bin-level history is
                    the ground truth for exit-rule counterfactuals and a 72h ring capped those
                    studies at ~25 closes / 3 disasters. Post-dedupe 30d costs less disk than the
                    old 72h ring (222 MB/3d → ~1 MB/3d).

scripts/replay/     Offline shadow-replay harness (read-only, zero live-agent footprint). See
                    "Shadow-Replay Harness" below.
scripts/screening_funnel_audit.js  Standalone read-only Meteora universe sweep: fetches ~9.5k DLMM
                    pools from the discovery API, replays the metric filter chain (same order/
                    semantics as tools/screening.js), prints per-stage attrition, near-misses, and
                    relaxation scenarios. No .env/db/project-module imports.
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
| minTvl / maxTvl | screening | **100k** / 400k (prod; minTvl raised 2026-07-27 — see TVL floor below) |
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
| positionSizePct | management | **0.5** (prod; was 0.22 live despite a 0.35 default — raised 2026-07-27) |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |
| playstyle | strategy | balanced (tight/balanced/wide → bins presets; see bins_below Calculation) |
| defaultShape | strategy | "spot" (spot/curve/bidask bin-distribution shape; see below) |

Signal/alert keys live in the same `screening`/`management` sections (defaults in `config.js`): `organicMomentum*` (Enabled, DecayTraderPct −22, DecayVolumePct −42, GrowTraderPct 38, MinUniqueTraders 30, HardFilter off) for organic-momentum; `poolHealth*` (Enabled, AutoReview, MinSnapshots, MinAgeMinutes, WindowSize, YieldDecayPct, TvlDilutionRisePct, VolumeDeathPct, FeeRatioCollapsePct) for position-alerts. LPAgent/steer keys (screening): `lpStudyEnabled`, `lpStudyMaxPools` (4), `lpStudyMinWinnersForStyle` (3), `lpStyleSteerEnabled` (off). Deploy-timing gate lives in its own `timing` section: `timingGateEnabled` (off), `timingMinBucketN` (8), `timingDeadHourSuccessFloor` (0.20), `timingDeadHourAction` (size_down|skip), `timingSizeDownPct` (0.5) — all tunable via `update_config`. Price-crash fast-path keys (management, plan #04): `crashFastPathEnabled` (off — shadow mode logs `crash_shadow` would-fires while off), `crashBinsPerMin` (12), `crashMinBinDistance` (8), `crashConfirmTicks` (3), `crashWindowSec` (90), `crashMinSpanSec` (9). **In-range rug detector** (management, shadow — default OFF, 2026-07-15): `inRangeRugEnabled` (false), `rugBinsPerMin` (12), `rugMinBinsDropped` (10), `rugMaxPnlPct` (−3), `rugWindowSec` (300), `rugMinSpanSec` (60). Sibling of the crash fast-path for dumps that run INSIDE a wide bid ladder (TrumpCoin 2026-07-14: −64% mcap entirely in-range → −18.35% stop + 48.9% exit slippage; the OOR-below detector is structurally blind there). Fires only on descent velocity AND pnl jointly — the 12-position price_ticks study showed winners dip at ≤11 b/min and flat pools spike to 18 b/min at pnl≈0, so neither gate alone separates; joint gates fire on TrumpCoin at −7.1% (11pt + slippage saved) and Flea at −3.3% (~1pt cost vs its armed ratchet), zero winner-kills. While OFF logs `[RUG_SHADOW]` would-fire lines; when ON routes through the crash close path (crashConfirmTicks, bypasses TWAP guard, suppresses OOR-flips). When ON, the PnL poller fast-closes an OOR-below position falling ≥ crashBinsPerMin (velocity over the trail window), bypassing `outOfRangeWaitMinutesBelow` via the existing confirm-tick + mechanical-close path (rule `crash`). Downside-only; never fires in-range or above. Post-close probe keys (management, plan #05, ships ON): `postCloseProbeEnabled` (true), `postCloseProbeMinutes` ([30,60,180] — not update_config-tunable, array). Dust-sweep keys (management, ships ON): `dustSweepEnabled` (true), `dustSweepMinUsd` (0.25 — below this a swap is net-negative vs gas/route minimums; ATA rent stays AUM-recoverable), `dustSweepMaxUsd` (25 — larger balances are deliberate holds, never auto-sold). `sweepWalletDust()` (executor.js) runs after any close + every ~10th mgmt cycle, skips open-position mints, and reclaims ATA rent per sweep. The management cycle scan-probes each close's pool mcap at those offsets, amends `perf.post_close` (idempotent, restart-safe, 0–2 GETs/cycle) and scores `exit_quality` (good_exit/early_exit/flat/delisted) — surfaced via `/exits` + a briefing line (`getExitQualitySummary()` in lessons.js). Ground truth for tuning `outOfRangeWaitMinutesBelow`, crash thresholds, and trailing TP; the `⚠ selling bottoms` flag = early exits outnumber good ones (n≥6) in a reason family. Path features per closed position (state.js poller tracking → perf record): `mfe_pnl_pct`/`mae_pnl_pct` (max favorable/adverse excursion, unconfirmed unlike `peak_pnl_pct`), `max_bins_below`/`max_bins_above`.

**Newer flag families (2026-07-06 session), all `update_config`-tunable:**
- **Bear-case debate — ⚠️ RETIRED 2026-07-27 (`bearDebateEnabled=false` in prod).** Ran 78 parsed calls and returned **veto on 78/78 (100%, avg confidence 91.3)** — a gate with zero discrimination is not a signal. It vetoed BOTH of the day's winners: CATE-SOL at confidence 95 (which closed +8.38% with a 10.7% fee yield) and again at confidence 90 on the re-entry (+3.99%). Its reasons are generic anti-strategy arguments about single-sided SOL ladders ("earns zero fees if price rises") that apply identically to every deploy this agent makes by design, and ignore pool history entirely. ⚠️ Never set `bearDebateAction="enforce"` — at a 100% veto rate it would halt ALL deploying. Also note the historical `proceed` records are NOT approvals: `runBearDebate()` is fail-open, so an API error or unparseable reply also returns "proceed" — all 17 historical proceeds carry `reason: null` + `confidence: null`, i.e. they are error defaults. That provenance is now persisted (`parsed`/`error`/`fail_open` on the position's `bear_debate` object) so the two can be told apart. Code left in place and reversible via `update_config bearDebateEnabled=true`; re-enabling would need recalibration against outcomes first. Original spec: `bearDebateEnabled`, `bearDebateAction` ("log_only"|"enforce", default `log_only` — runs the adversarial gate and logs a 🐻 report + `bear_debate` decision row, changes nothing until "enforce"), `bearDebateModel` (llm section, null → falls back to screeningModel). See `llm-verdicts.js`.
- **OOR-flip tactic #07 + swap-free redeposit** (management, shadow — both default OFF): `oorFlipEnabled` (false), `oorFlipBailHours` (6), `oorFlipMaxPerPosition` (1), `swapFreeRedepositEnabled` (false), `swapFreeRedepositBins` (20). While OFF: `[OOR_FLIP_SHADOW]` at both OOR-below decision points (mgmt cycle + PnL poller) and `[SWAP_FREE_SHADOW]` in the post-close auto-swap path (estimates Jupiter slippage vs. the swap-free strip alternative). See `docs/plans/07-oor-flip-tactic.md`.
- **Profit-gated fee compounding** (management, shadow, default OFF): `feeCompoundEnabled` (false), `feeCompoundMinMultiple` (5 — fees must clear ≥5× estimated round-trip gas), `feeCompoundMinFeesSol` (0.01 floor). `claim_fees` now always routes through `claimFeesWithCompoundGate` (tool name unchanged); while OFF it's a read-only peek + `[FEE_COMPOUND_SHADOW]` would-fire log, then a plain claim. See `compoundFees()`/`shouldCompound()` in `tools/dlmm.js`.
- **TWAP wick guard** (management, shadow, default OFF): `twapGuardEnabled` (false), `twapGuardTicks` (5), `twapGuardDeviationPct` (8), `twapGuardMaxDeferrals` (2). Before a non-crash mechanical close (stop-loss/trailing-TP/OOR/low-yield) fires, compares the current pnl tick against the mean of the last N ticks (`pos.pnl_tick_history` ring, cap 20); a wild single-tick deviation defers the exit once, capped at `twapGuardMaxDeferrals` so it can never block an exit indefinitely. Never applies to the crash fast-path (separate code path). While OFF, logs `[TWAP_GUARD_SHADOW]` would-defer lines. See `evaluateTwapWickGuard()`/`applyTwapWickGuard()` in `state.js`.
- **Breakeven profit ratchet** (management, **ships ON in prod**): `profitRatchetEnabled` (true in prod; false default), `profitRatchetArmPct` (2), `profitRatchetStopPct` (−2). Once a position's CONFIRMED peak (`pos.peak_pnl_pct`, same field trailing TP reads) crosses the arm level, the effective stop tightens from `stopLossPct` to `profitRatchetStopPct` — converts profit-round-trips (peak +2.9% → −15.6% SL, the 2026-07-08 ok-SOL case) into small controlled exits. Arming is sticky (persisted `ratchet_armed*` fields, survives restarts); firing routes through the TWAP `gateExit` wrapper before the plain stop-loss check and never touches the crash fast-path. `evaluateProfitRatchet()` in state.js. Empirical basis (2026-07-08 replay, 101 paths): arm=2/stop=−2 fired ~1–2×/100 closes at ~+15pt each, zero winner-whipsaws; arm=1.5 whipsawed a +12% winner — do not lower below 2. While OFF: one-time `[RATCHET_SHADOW] armed` lines + rate-limited `would-close` lines.
  **⚠️ Revised by the 2026-07-27 replay (278 closes / 195 paths — supersedes the 101-path numbers above):** (a) "arm=2/stop=−2 has **zero winner-whipsaws**" is now **false** — it truncates BULLCAT-SOL −5.84 (+5.86→+0.02). (b) "arm=1.5 whipsawed a +12% winner — do not lower below 2" is **confirmed and worse than recorded**: Chaton-SOL −18.10 (+12.02→−6.08). The floor stays at 2. (c) **"Tighter trailing triggers tested WORSE than live 3/1 (winner truncation)" is RETRACTED** — `worstTrunc` is the identical BULLCAT-SOL −5.84 in **all twelve** trailing cells, so truncation does not discriminate between variants at all. Live 3/1 was the **worst cell in its own grid** (mean +0.48pt, median −0.29, win 35%, W/L 14–25); **trig=2 drop=1.5** led on every axis (mean +1.98, median +0.76, win 50%, W/L 19–18) with monotone gradients in both dimensions. **Applied 2026-07-27: `trailingTriggerPct=2`, `trailingDropPct=1.5`.** (d) At trigger=2/drop=1.5 the ratchet becomes **inert** — `2/1.5 + arm2 stop−2` and `2/1.5` with no ratchet return byte-identical rows, because trailing always fires first. The ratchet's apparent +0.67pt/close value was an artifact of 3/1 being loose enough that positions peaking between +2% and +3% never armed trailing. Left enabled as an inert backstop.
- **Exit-urgency priority fees** (tx section, **ships ON**): `exitPriorityFeeEnabled` (true), `exitPriorityFeeMultiplier` (1.5), `maxExitPriorityFeeMicroLamports` (3,000,000 µL/CU cap ≈0.0042 SOL worst case). Close/flip transactions (`close:*`/`flip:*` labels → "exit" urgency) are priced off the p75 fee percentile × the multiplier instead of the normal-tier median×1.2, with retry escalation (×1.5^attempt, capped) that replaces the `SetComputeUnitPrice` instruction on each retry. `deploy:*`/`claim:*` stay on the byte-identical normal tier. Instant rollback via `exitPriorityFeeEnabled=false`. See `getDynamicPriorityFee()`/`computePriorityFee()` in `tools/dlmm.js`.
- **Bin-distribution shape** (strategy section, **ships ON**, default byte-identical): `defaultShape` ("spot"). `deploy_position` takes an optional `shape` param (`spot`/`curve`/`bidask`) orthogonal to `bins_below` — playstyle governs range width, shape governs the intra-range liquidity curve. Omitted `shape` leaves the legacy strategy→StrategyType resolution untouched. `curve` only on strong consolidation conviction (concentrates fees near price but bleeds fastest once OOR); `bidask` for dip-entry theses (weights liquidity toward the range edge).
- **Exit-swap price-impact guard** (management, shadow — default OFF, 2026-07-14): `exitSwapGuardEnabled` (false), `exitSwapMaxImpactPct` (5). Small remainders in thin pools lost 10.8-16% to Jupiter slippage on post-close auto-swaps (febu $1.15 on $10.66, Bison $0.92 on $5.74 — live [SWAP_FREE_SHADOW] data). Before every auto-swap (`swapBaseToSolWithRetry` — covers after-close, after-claim, dust sweep), a read-only Jupiter quote (`getSwapQuote` in tools/wallet.js, same /order endpoint + referral params as the real swap) is compared to the token's market value; quoted impact > cap → skip and hold (ON) or log `[EXIT_SWAP_GUARD_SHADOW]` would-skip (OFF, shipped default). Held balances fall to the dust sweeper, which re-quotes through the same guard each pass and sells once impact recovers under the cap. **Only remainders <= dustSweepMaxUsd are guarded** — larger balances are urgent-exit inventory (a ratchet/stop close mid-dump; brain-SOL $40.39 @ 11% quoted impact, realized 10.4%, 2026-07-14) where holding to dodge slippage strands a collapsing token the sweeper will never touch; those always sell immediately. The close-path result carries an `auto_swap_note` steering the LLM away from re-selling manually at the same bad quote. Fail-open on quote errors; negative-slippage swaps (quote beats market, the world.xyz case) never trigger it.
- **Cycle-based starvation relaxer** (screening, **ships ON**, 2026-07-07): `starvationRelaxEnabled` (true), `starvationRelaxAfterEmptyCycles` (12), `starvationRelaxCooldownHours` (3). Deadlock breaker: `evolveThresholds`' only call site is `recordPerformance` (every 5th close), so zero candidates → zero closes meant floors could never self-relax. When zero candidates reach the LLM for N consecutive cycles (counter persisted as state_meta singleton `_screeningStarvation`, survives restarts), `maybeRelaxOnStarvation` (index.js) → `applyStarvationRelaxation` (lessons.js) steps ONE evolution-owned floor (`minFeeActiveTvlRatio`/`minOrganic`/`minIntelScore`, whichever is furthest above baseline) toward baseline within `EVOLVE_BOUNDS`, at most once per cooldown, through the same `persistEvolution` path (atomic user-config.json write + evolution history + Telegram notify). Only ever lowers screening floors; closed-loop evolution re-tightens once closes resume.
- **Screening funnel telemetry** (2026-07-07, always on): every cycle logs `[SCREENING] discovery:` (Stage-A: api_total → fetched → client_recheck → blacklist, with a recheck-reject reason breakdown) and `[SCREENING] funnel:` (Stage-B: input → metrics → dev_score → dump_guard → intel → pvp → indicators → final). Meteora `stage_counts` now feed the (renamed) `buildFunnelReport` in index.js, so the no-candidates Telegram report shows real per-stage attrition.
- **Safety-score enrichment** (screening, default `"off"` = byte-identical): `safetyEnrichMode` ("off"|"log_only"|"enforce"), `safetyEnrichMaxPerCycle` (6). Fixes the historical Safety≡50 pin: scoreSafety's inputs (mint/freeze renouncement, top10/bundler/bot/dev-hold %) are now fetched per-candidate — keyless Jupiter audit (`getTokenAudit` in tools/token.js) covers all six, GMGN (`getGmgnSafetyInfo`) refines the four rate fields when keyed — after the metric gates, before the intel filter, in BOTH gate and rank mode, 30-min per-mint cache, fail-open (any error → neutral 50). `log_only` computes/logs `[SAFETY_ENRICH] <pool>: safety 50→X intel old→new` on a clone (admission unchanged) and persists `intel_safety_enriched`/`intel_total_enriched` into signal_snapshot for validation. ⚠️ **enforce PAIRING** (2026-07-11 rebaseline, scripts/safety_rebaseline.js, 147 records): renouncement is ~universal in our population, so real Safety adds a near-constant +6..+11 to intel_total — a distribution shift, not a discriminator (zero outcome signal; Safety is a rug FILTER, not a ranker). Enforce MUST ship with minIntelScore/rankMinIntelScore raised 52 → ~58 (renouncement-only) / ~60-62 (full audit) in the same change, else the intel gate is silently disabled (admission 52%→93-99%).
- **"Rank, don't gate" admission mode** (screening, shadow — default `"gate"` = byte-identical): `screeningAdmissionMode` ("gate"|"rank"), `rankAdmitCount` (5), `rankMinIntelScore` (52), `rankShadowEnabled` (true). Rank mode replaces the ~12 AND-ed quality thresholds with: broad safety-envelope fetch (`RANK_ENVELOPE` in tools/screening.js — tvl≥10k, mcap 100k–20M, holders≥500, volume≥1000·tf/1h, fee_tvl≥0.30·tf/1h; **windowed floors are 1h-reference values scaled to the screening timeframe** because the discovery API windows volume/fee_tvl by the query's `timeframe` param — unscaled floors at 5m are ~12× tighter and break the broad⊇gate superset property), safety-only client gates, composite ranking (`computeAdmissionScore`: payload intel + momentum ±5/−10 + fee_tvl percentile ±6 + fee-efficiency percentile ±5), enrichment on top 2N only, admit top N with enriched intel ≥ rankMinIntelScore. While in gate mode, `[RANK_SHADOW] would-admit topN: …` logs the comparison each cycle. Defaults from the 2026-07-07 backtest of 181 closes (scripts/rank_admission_backtest.js): fee_tvl_ratio was the strongest outcome discriminator (Spearman +0.39, Q1→Q4 success 14%→67%), intel≥52 the knee (blocks 68% of failures, keeps 71% of winners), organic_score statistically flat (hence no organic term/clause in rank mode), mcap/holders wrong-direction as quality signals (kept only as rug-safety floors).
- **Close-efficiency gate** (management, shadow — default OFF, RSRLP `closeMinReturnPct` pattern): `closeEffGateEnabled` (false), `closeEffMinNetPnlPct` (0.5), `closeEffQuoteMinIntervalSec` (60). Trailing-TP fires on GROSS `pnl_pct`, but a close pays gas (claim+close+swap) + Jupiter price impact on the base-token remainder; at ~1.25 SOL sizes a "+2% win" can net a loss. When a **TRAILING_TP** exit is detected, `evaluateCloseEfficiencyGate()` (index.js, async — the seam is the poller + mgmt-cycle just-in-time, since `updatePnlAndCheckExits` is sync and can't await a quote) estimates net = gross − (impactCostPct + gasCostPct): impact from a read-only ROUND-TRIP `getSwapQuote` pair (SOL→base for the base side's SOL value, then base→SOL of the quoted out_amount via `amount_raw`; half the round-trip loss = one-way all-in sell cost incl. route fees — same out_amount measure as the exit-swap guard, deliberately not Jupiter's ambiguous `priceImpactPct` field; cached per position for `closeEffQuoteMinIntervalSec`) scaled by the bin-geometry base fraction (`estimateBaseTokenFraction`), gas from `estimateExitGasCost()` (claim+close+swap, sibling of `estimateCompoundGasCost`). Net < `closeEffMinNetPnlPct` → the trailing-TP close is DEFERRED (position keeps running; trigger re-evaluates next tick; stop-loss/ratchet still protect downside). Pure math + defer decision in `evaluateCloseEfficiency()` (state.js); persisted `close_eff_*` fields (cached impact + defer counters) for observability. **Applies ONLY to TRAILING_TP** — never stop-loss, young stop, crash/rug fast-paths, profit ratchet, OOR, LOW_YIELD, RULE_3/pumped-above, or manual/LLM closes (all have a distinct `action`, or bypass the exit object entirely). While OFF logs `[CLOSE_EFF_SHADOW] would-defer` (rate-limited ~1/10min/position) + a free `[CLOSE_EFF_SHADOW] lowyield-cost` breakdown on LOW_YIELD closes (never gated, calibration only). Fail-open everywhere: any quote/data error logs once and lets the close proceed. Calibrate the shadow `net` numbers against realized close outcomes (post-close [EXIT_SWAP_GUARD]/slippage lines) before enabling.
- **⚠️ Entry-TVL band evidence (2026-07-27, 280 closes) — do NOT compromise the floor.** Disaster rate and mean PnL by entry TVL: `<30k` n=68 avg −0.60 / 11.8% disasters; `30–60k` n=90 avg −0.83 / 8.9%; `60–100k` n=61 avg **−2.13** / **14.8%** (worst −59.7 — the single worst band in the dataset); `100–200k` n=48 avg **+1.02** / **0 disasters** (worst −1.8); `>=200k` n=13 avg **+1.78** / **0 disasters**. The cliff is a step at 100k, NOT a gradient — there is no safer middle band, so lowering `minTvl` to 50–60k buys the worst-performing slice. Note the structural tension: `fee_active_tvl_ratio` is fees÷TVL, so raising the floor mechanically suppresses the strongest *success* discriminator; thinness drives both high fee yield and disaster risk, so they are not independent signals.
- **⚠️ Candidate supply is the binding constraint on deploying capital, not `maxPositions`.** Funnel audit 2026-07-27 over 9,786 DLMM pools at live thresholds: only **13** pools clear `tvl>=100k` plus the volume/holders gates, ~**8** in the 100–400k band, **2** survive the full chain (and both were the same token, CATE — which is why the agent deployed it twice in one evening). Raising `maxPositions` cannot help; raising `maxTvl` to 2M and relaxing mcap changed nothing. The correct response to a thin-candidate regime is FEWER, LARGER positions — hence `positionSizePct` 0.22→0.5 and `poolReentryCooldownEnabled=true` on the same date. Caveat: the audit replays the GATE chain, but prod runs `screeningAdmissionMode="rank"` (RANK_ENVELOPE, no minLps, minMcap 100k), so its `mcap>=300k`/`total_lps>=5` kills describe universe shape, not live attrition.
- **Auto-swap slippage cap** (management, shadow — default OFF, 2026-07-30): `swapSlippageCapEnabled` (false), `swapSlippageCapBps` (500). Our Jupiter Swap V2 `/order` calls historically sent **no `slippageBps`**, so RTSE (Jupiter's dynamic slippage) chose the tolerance on every auto-swap — the same gap as Kaiser.charon audit finding C1, and a plausible contributor to the 10–16% realized exit slippage cases (febu, brain). Verified against Jupiter docs: omitting the param = RTSE; passing `slippageBps` "overrides RTSE with a fixed value." When ON, `swapBaseToSolWithRetry` sends the cap **only for sweeper-retryable remainders (≤ `dustSweepMaxUsd`)** — a slippage-exceeded failure falls to the existing retry + dust-sweeper machinery; balances above the ceiling are urgent-exit inventory that MUST fill (a capped swap failing mid-dump strands a collapsing token) and always keep RTSE. Same tier boundary as the exit-swap guard, deliberately. Manual/LLM `swap_token` calls untouched (`swapToken`'s `slippage_bps` param is mechanism-only). While OFF logs `[SLIPPAGE_CAP_SHADOW] would cap`.
- **Per-pool NO-DEPLOY verdict cache** (screening, **ships ON**, 2026-07-30): `verdictCacheEnabled` (true), `verdictCacheTtlMin` (30). Charon decision-cache pattern. Finer-grained sibling of the `_lastDeclinedCandidates` fingerprint suppressor (which only skips on an IDENTICAL candidate set): each pool the screener declines gets a cached verdict `{at, mcap, holders}`, and the LLM call is skipped when EVERY passing candidate carries a fresh verdict (< TTL) with unmoved metrics (**mcap ±20%, holders ±30%** — drift re-judges; missing data fails open to re-judge). Partial hits log and run the full set. Only genuine judgment declines are cached (no-tool fallbacks are model failures; a blocked deploy attempt means the model WANTED a pool); any successful deploy clears the whole cache. In-memory, restart-clears. `candidatesReachedLLM` is set before the check so cache-skips never feed the starvation counter. Cuts claude-cli quota burn during droughts where the same 1–3 pools recycle for hours. `[VERDICT_CACHE]` log lines.
- **Fast close — skip the redundant pre-close claim on urgent exits** (management, shadow — default OFF, 2026-07-30): `fastCloseSkipClaim` (false). closePosition Step 1 sends a standalone `claimSwapFee` (2 txs, measured **2.4–5.3s / median ~3.5s across 13 live closes**) before Step 2's `removeLiquidity({shouldClaimAndClose:true})` — which claims the same fees in-transaction, making Step 1 pure latency + 2 extra failable txs on the exit critical path. The pre-existing `recentlyClaimed` branch (claim <60s ago → straight to Step 2) has always exercised the skip path, and post-close PnL/fee accounting reads the datapi closed record after Step 2, so accounting is unaffected. When ON, only **URGENT** exits skip: `URGENT_EXIT_ACTIONS` in index.js = STOP_LOSS, PROFIT_RATCHET, YOUNG_STOP, CRASH_FASTPATH, RUG_FASTPATH (+ the mgmt-cycle RULE_1 stop-loss backstop carries `urgent:true`); calm exits (TRAILING_TP, ROUND_TRIP_HARVEST, OOR, LOW_YIELD, manual/LLM closes) always keep the explicit claim. Urgency threads caller→executor→`closePosition({urgent})` (the exitMap now stores the full exit object, not just the reason string). While OFF logs `[FAST_CLOSE_SHADOW] would-skip` on urgent closes. NOT a fix for gap risk (RAKO moved −11pt in one 45s tick; 3.5s wouldn't have saved it) — it's a modest free latency cut. Community-sourced (2026-07-29 Telegram scrape).
- **Round-trip harvest** (management, **ENABLED in prod 2026-08-21** — plan #11 Phase 1; code default still false): `roundTripHarvestEnabled` (false default, true in prod), `roundTripMinPnlPct` (1.0), `roundTripFrozenTicks` (6), `roundTripFrozenEpsilonPct` (0.05), `roundTripMinBinsAbove` (5). Enabled off 3 shadow calibration cases (CATE frozen 7.98%/12 ticks; CYBERLEEK harvest-equal +2.47% but 5.4h earlier than trailing; BULLSHIT frozen +2.33%/29 bins). Pairs with the renewed-flow re-entry rules (a665676) to form the plan-#11 roll-up loop: free exit at frozen PnL → screener re-enters the same pool when live flow justifies. Empirical guard basis: 71% of ≥5-bin above-range excursions wick back (64% from ≥15 bins), so the frozen-PnL proof — not bin distance — is the load-bearing gate. Harvests a position that has completed a full round trip **out the TOP** of its range. A single-sided SOL ladder holds SOL in bins below spot; price falling through converts it to base, and price rallying back out the top sells that base back — so once the active bin clears the whole range the position is **100% SOL**: the gain is locked, further upside is exactly zero, and an exit pays **no swap slippage** (nothing left to sell). Measured on CATE-SOL 2026-07-27: pnl pinned at exactly **7.98% across 12 consecutive poller ticks while the active bin swung 16→31 bins above** (~12% price move, zero pnl response). No existing rule reaches this state — trailing TP needs pnl to DROP from peak (a frozen pnl never drops), RULE_3 needs `outOfRangeBinsToClose` (50) bins above, and RULE_4's `outOfRangeWaitMinutesAbove` (720m) clock **resets on any wick back into range** (observed resetting every few minutes during boundary oscillation; it does accumulate cleanly once parked decisively above, so the honest value is recovering capital ~11h sooner + removing wick-reset fragility, not rescuing otherwise-unrecoverable capital). `evaluateRoundTripHarvest()` (state.js) requires ALL of: ≥`roundTripMinBinsAbove` past `upper_bin` (boundary oscillation is still crossing bins, so still earning); pnl ≥ `roundTripMinPnlPct` (**only ever harvests a WIN** — a position frozen at a LOSS falls through to stop-loss/OOR rather than laundering a loss as a "harvest" in the outcome record); and pnl unchanged within `roundTripFrozenEpsilonPct` across the last `roundTripFrozenTicks` entries of `pnl_tick_history`. The frozen-pnl test is load-bearing — it PROVES conversion completed instead of inferring it from bin position, which is what makes the exit provably free rather than probably cheap, and it excludes the still-converting tail (pnl rising as the topmost bins sell). Placed after stop-loss/ratchet/trailing (downside protection always wins), routes through the same `gateExit` TWAP wrapper, never touches the crash fast-path. While OFF logs `[ROUNDTRIP_SHADOW] would-harvest` (rate-limited 1/10min/position). All five keys `update_config`-tunable.
- **Entry-TVL floor + pool-memory exemption** (screening, **ships ON**, 2026-07-27): `minTvl` raised 20k → **100k**, paired with `hasCleanPoolHistory()` (pool-memory.js). Entry TVL is the strongest outcome discriminator in our history: at/above ~$100k → 58 closes, **zero disasters**, worst −1.8%; below → 217 closes, **25 disasters**, −248 net points (replicates within June and July separately, so not era leakage). But it is a population statistic, not a law — febu-SOL ran 7 deploys at ~$42k TVL for 5 trailing-TP winners and zero losses. A pool is exempted from `minTvl` when it has ≥3 recorded closes, zero disasters (worst > −10%), **AND avg PnL ≥ +1.0%**. ⚠️ **The avg-PnL floor is load-bearing**: a disasters-only rule also exempted chronic **fee-death** pools — SOLdiers-SOL (avg −0.40%/4), Joby-SOL (−0.06%), Jotchua-SOL (+0.04%), Jimothy-SOL (0.00%/3, the pool fee-death-closed 3× in ~10h) — and `classifyOutcome()` already treats break-even fee-death as failure/neutral, so exempting them would contradict the learning objective. Mirrored at **BOTH** gates (`getRawPoolScreeningRejectReason` in tools/screening.js **and** `validateDeployPoolThresholds` in tools/executor.js) — exempting only at screening would let the LLM propose pools the executor blocks. Keyed on **pool address** via `entry.deploys[].pnl_pct`; lessons perf records have **no `pool_address` field** and `pool_name` is unsafe (same-symbol rival pools exist — see pvp.js). Fails **closed** on any read error; logs `[TVL_EXEMPT]`. ⚠️ `minTvl` is NOT evolution-owned and the starvation relaxer does not touch it, so a too-high floor **cannot self-correct** — watch the `[SCREENING] funnel:` TVL stage.
- **Scout tier** (screening, shadow — default OFF, 2026-07-31): `scoutTierEnabled` (false), `scoutSizeSol` (0.12), `scoutMinIntel` (70), `scoutMaxPositions` (1). Fixes the **one-way ratchet in the TVL exemption**: `hasCleanPoolHistory` needs ≥3 recorded closes, but the `minTvl` floor blocks the first deploy that would create history — so the exemptable set can only shrink as legacy pools die. A sub-floor pool with **enriched intel ≥ scoutMinIntel** (bar enforced at rank admission, the only place enriched intel exists) is admitted as a SCOUT: the executor (`validateDeployPoolThresholds` returns `scoutTier`; the deploy safety block) **hard-clamps size to `scoutSizeSol` regardless of what the LLM or a manual /deploy requests**, enforces max `scoutMaxPositions` open scouts (tag counted via tracked `scout` flag), and skips the normal `deployAmountSol` minimum (scout floor 0.05). Scout candidates bypass the gas break-even filter (at 0.12 SOL the break-even is ~10× longer by construction; the gas is tuition for history, bounded by size) and carry a `scout_tier:` candidate-block line so the LLM judges token quality knowing size is pre-capped. `scout: true` flows trackPosition → perf record, so scout outcomes stay separable in all analytics. Purpose is **history-building, not yield** — success metric is closes recorded; bounded worst case ≈ 0.12 × worst-band −59.7% ≈ **$5**. Normal exit stack applies unchanged. Evidence basis: new-era (≥07-20) band table — ≥100k n=13 avg +2.11 / 0 disasters; 30–100k n=22 avg −2.43 / 3 disasters; <30k n=13 avg +0.77 but selection-biased (exemption pools only). While OFF logs `[SCOUT_SHADOW] would-admit`; enabled logs `[SCOUT] admitting/clamping`. Executor mirror also converts a manual sub-floor `/deploy` into a scout instead of blocking it.
- **Plan #12 — manual-style gaps (2026-08-22, `docs/plans/12-manual-style-gaps.md`).** Built from the operator's 7 manual positions of 08-21/22 (avg +1.84%, 0 fee-deaths) vs what the bot did with the same pools. Flags (all `update_config`-tunable): (1) `repeatDeployCooldownLosersOnly` (management, default false → `[REPEAT_COOLDOWN_SHADOW]`): the legacy `repeatDeployCooldown` trigger counts ANY fee-generating deploy, so two WINNING closes locked the token 24h — it fired on every operator pool that day (MANLET/TOAD/BULLSHIT/MADE) while the operator re-entered for +5.57/+3.18/+0.67. When ON, locks only when the last N deploys were all non-successes (`isNonSuccessDeploy`: low-yield family / OOR-below / pnl ≤ 0). (2) `rankSteadyEnvelopeEnabled` (screening, default false → `[STEADY_ENVELOPE_SHADOW]`), `rankSteadyMinFeeTvl24h` 1.5, `rankSteadyMinTvl` 100k, `rankSteadyMaxExtra` 10: `RANK_ENVELOPE`'s hard-coded 0.30%/h fee floor at the 1h timeframe only fetches pools mid-burst (measured 08-22: fee≥0.30 → 7 pools, 0 with TVL≥100k; MANLET/TOAD/BULLSHIT at 0.06–0.14%/h with 2.5–3.1%/24h were invisible); `discoverSteadyEnvelope()` adds one 24h-timeframe request and re-fetches extras at the screening timeframe (windowed fields stay consistent), tagging `steady_envelope` (+ a candidate-block line). Note the config `minFeeActiveTvlRatio` is NOT used by the rank-mode fetch — the envelope constant is the wall. (3) Solo-candidate prompt wording (prompt.js, screener STEPS, REPL `auto`) now matches `getLoneCandidateSkipReason`: a lone candidate is the normal state (942/1135 non-empty cycles in the prior 7d), smart wallets are a boost not a gate. (4) Entry capture: `entry_price_change_pct` (Meteora `pool_price_change_pct` @ screening timeframe) captured by the executor; adopted positions get entry metrics via `setAdoptionEnricher`/`attachEntryMetrics` (state.js, registered from index.js — state must not import screening); perf records now carry `adopted`, `probe`, `range_width_bins`, `entry_price_change_pct`. (5) `playstyle=single_account` preset `{45,69}` (one position account, rebalance-able; not default). (6) Probe tier `probeTierEnabled` (false), `probeSizeSol` 0.25, `probeMaxPositions` 1: `deploy_position.tier="probe"` → executor clamps size/caps concurrency/tags `probe:true`; refused while OFF. Enable order: losers-only → steady envelope → probe. Not built: safety-enrich enforce (needs intel re-baseline), in-place re-centre (plan #11). **Phase 2 (same day): window-aware intel Yield** — `intelYieldWindowMode` ("legacy"|"log", prod = **log** since 2026-08-22) in intel-score.js: the legacy `scoreYield` normalizers (fee/active-TVL ÷2.0 → 40 pts, volume/TVL ÷5.0 → 25 pts) are 24h thresholds applied to 1h-windowed fields, so healthy pools scored Yield ~20–40 and only micro-pool spikes saturated. "log" scores the 24h-equivalent rate (windowed×1440/tf, or the pool's own 24h average if higher) on a log scale 1%/day→48%/day (and 0.2×→120× TVL/day turnover). `scripts/yield_window_backtest.js` (300 usable records): pure monotone re-scaling (Spearman legacy↔log total = 1.00, outcome correlation unchanged 0.20), gate moves 52→**61** to preserve admission/failure-blocking — prod bars set to `rankMinIntelScore=61`, `minIntelScore=61`, `scoutMinIntel=78`; a future safety-enrich enforce would need ≈69. ⚠️ The backtest population is burst-era entries (median 29%/day fee rate at deploy) — it proves neutrality for what the bot used to do, not that steady pools win. Steady-lane pools still score 42–60 under log mode (2–4%/day IS low yield vs bursts; the operator's edge on them was flow timing), so `rankSteadyMinIntel` (screening, **null = inert**) exists as the lane-specific bar (48 admits GTA6/Qenis/BULLSHIT/BUTTHOLE-class; 45 adds MANLET; TOAD/STONK need ≤42) — operator's call, justified by the ≥$100k band's zero-disaster record + enriched Safety. While legacy, `[YIELD_WINDOW_SHADOW]` logs legacy→log per enriched-gate pool.
- **Per-pool/token re-entry cooldown** (management, **REVERTED TO SHADOW 2026-07-29** — was enabled 07-27): `poolReentryCooldownEnabled` (false), `poolReentryCooldownMinutes` (240). ⚠️ **The outcome data never supported this gate.** Enabled 07-27 off a single anecdote; a 133-re-deploy audit on 07-29 (join `positions` self-lag on `base_mint` → lessons perf) found no penalty for rapid re-entry in the current era: JUL `re<240m same-pool` n=18 avg **+0.53%**, 67% win, 1 disaster vs JUL first-entries n=54 avg **−2.16%**, 8 disasters. The apparent penalty is a **JUNE artifact** (n=55, −0.91%, 7 disasters) — era leakage again. Gap bands show no gradient (JUL `<15m` +2.24, `15-45m` +2.27, worst band is `45-120m` at −2.12). The different-pool arm has n=7 lifetime, **zero** disasters. Concretely: the gate as fixed would have blocked the FRANK-SOL re-deploy of 07-29 00:35Z (111m after a +2.95% TP close, into a DIFFERENT pool), which ran to +2.46%. Selection caveat: this compares re-entries that happened against first entries, not against the pool the capital would otherwise have taken — but with candidate supply as the binding constraint (~8 qualifying pools universe-wide), the realistic alternative is **idle SOL at 0%**, which re-entries beat in every era. The anecdote's actual harm (the stranded remainder) was fixed separately via `_deferredExitSwaps` + the dust-sweeper exception. Re-enabling would need a same-pool-only arm and a much shorter window, justified by fresh data. Original rationale (kept for context): the agent closed CATE-SOL at +8.38% (19:14) and re-deployed the SAME pool 7 minutes later (19:21) — paying a full round trip of gas plus a stranded $11.50 remainder for no repositioning benefit, with the shadow gate and a confidence-90 bear veto both logging objections. Knock-on: the guard-deferred remainder then became unsweepable because the re-entry made CATE an open-position mint (fixed separately via `_deferredExitSwaps`). Deploy hard-gate blocking re-entry into a pool/base-token we CLOSED within the window (rapid re-entry churns gas+slippage — Jimothy-SOL was fee-death-closed 3× in ~10h, 2026-07-18/19; the upstream fork raced 5–7 deploys into one pool). Lives in the `deploy_position` safety block (tools/executor.js), beside the duplicate-pool / duplicate-base-token checks; source is the in-process state closed-position cache (`getTrackedPositions(false)` — pool/base_mint + closed_at, guaranteed primed at deploy time, no async/DB round-trip, chosen over lessons `getAllPerformance()` for that reason). Pure decision in `evaluateReentryCooldown()` (state.js): most-recent CLOSE in the same `pool_address` OR same `base_mint` within `poolReentryCooldownMinutes`; malformed/missing `closed_at` fail-open (never manufacture a block). Enforce → `SAFETY_BLOCK` refusal ("Re-entry cooldown: pool closed 43m ago (<240m)…"); shadow → `[REENTRY_SHADOW] would-block` log + allow. Distinct from `repeatDeployCooldown*` (that gate is trigger-count-based on repeated OOR/fee-death outcomes; this is a simpler time-since-last-close hard gate). Deterministic, no LLM.

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
| balance history | `balance-history.js` | **`balance_history`** (1 row/sample: `total_usd` + full `snapshot` jsonb + `created_at`) | **NORMALIZED** (2026-06-30). INSERT/sample + count-based retention (17280 ≈ 30d). Sampled by a **piggyback at the end of each mgmt cycle** (~3 min, reuses the cycle's position cache — `getWalletBalances({freshPositions:false})`) + the 5-min cron as idle fallback; a 2.5-min min-gap guard dedupes the two. Dashboard `/api/balance-history` reads the table. |
| lessons, pool-memory, decision-log, signal-weights, strategy-library, smart-wallets, token-blacklist, dev-blocklist, error-telemetry, dashboard-report, rejected-candidates | resp. | `kv_store` (one jsonb row per store, keyed by name) | document form, via `db/doc-store.js` `makeDocStore()` |

**state normalization (state.js under pg):** the cache façade is unchanged (25 sync
accessors, unchanged call sites). `save()` diffs the positions map against an in-process
`_lastPersisted` snapshot and **upserts only changed rows** into `positions` (via
`withTransaction()`); `pushEvent()` queues rows for `position_events`; singletons go to
`state_meta`. `initState()` reconstructs the exact cache shape from these tables (lossless —
`positions.data` holds the full object), with a one-time fallback to `state_doc` if the tables
are empty. The legacy `state_doc` row is **retained untouched as a rollback snapshot**.
Seed/repair with `node db/import-state-normalized.js` (`--force` to truncate+reimport).

The remaining doc stores (lessons, pool-memory, decision-log, signal-weights, strategy-library,
smart-wallets, token-blacklist, dev-blocklist, error-telemetry, dashboard-report, and
rejected-candidates added 2026-07-06) stay `kv_store` documents (several are inherently
document/singleton shaped). The typed tables `closed_positions`/`pools`/`pool_snapshots`/etc. from
`001_init.sql` are still provisioned for a later per-store normalization if their query value
warrants it.

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
- **Claude Code CLI backend (2026-07-12, ships dormant):** a per-role model string prefixed
  `claude-cli/` (e.g. `update_config screeningModel=claude-cli/sonnet`) routes that role's
  completions through `claude -p --output-format json --no-session-persistence` on the VM's
  Claude subscription OAuth (no API key; adapted from the fciaf420/meridian fork's provider,
  hardened: stdout JSON envelope is read even on non-zero exit so rate-limit messages survive).
  The CLI returns a strict JSON action (`respond`|`tool`) that llm-cli.js synthesizes into
  OpenAI-style tool_calls — agentLoop, executor safety checks, WRITE_TOOLS, and the bear-debate
  gate are untouched (a `claude-cli/` bearDebateModel is redirected to OpenRouter). Rate-limit
  messages ("resets 10pm (TZ)") parse into a module cooldown; while limited or on any CLI
  failure the attempt falls back to the OpenRouter path (`claudeCliFallbackModel`, default =
  existing FALLBACK_MODEL; also `claudeCliTimeoutMs` 240000 — both update_config-tunable).
  Prereq on the VM: `claude` binary on PATH + one-time interactive `claude setup-token` by the
  operator. Recommended: CLI for SCREENER only (judgment-heavy, few calls/hr); keep MANAGER on
  deepseek (mechanical, frequent) to conserve plan limits. Effort per role: SCREENER/GENERAL
  medium, MANAGER low (CLAUDE_EFFORT_BY_ROLE in llm-cli.js).
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

## Shadow-Replay Harness (scripts/replay/)

Offline, read-only counterfactual tool for exit-knob tuning: `extract.js` joins closed-position
perf records with their pool-memory snapshot series into a normalized dataset; `replay.js` replays
alternative exit rules over the recorded paths (OOR-below waits, trailing-TP trigger/drop pairs,
stop-loss thresholds, crash bins/min variants) and reports per-variant PnL/win-rate deltas.
Every evaluation is bucketed high/low confidence by whether the decision boundary is resolvable at
the recorded snapshot cadence — trust the `hi*` aggregate columns; crash variants are never high-
confidence, and trailing-TP across >12min snapshot gaps or stop-loss whipsaws get demoted. Cannot
answer pool-selection counterfactuals until `rejected-candidates` data accrues, and is blind below
the snapshot cadence (no sub-cadence timing/slippage/survivorship modeling). Zero live-agent
footprint; imports `envcrypt.js` first so it resolves `PERSIST_BACKEND` the same way `index.js`/
`cli.js` do (a prior bug read the stale legacy JSON cold-copy silently — now it prints the resolved
backend with a loud warning on `json`). Run on the VM for real history:
```
ssh root@oraclevm.fardana.com
cd /opt/meridian && npm run replay:extract && npm run replay:run
```
`--diagnose` on `extract.js` prints per-position join/exclusion reasons when coverage looks off.
See `scripts/replay/README.md` for the full option list and honesty notes.

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

- **Screening starvation incident (2026-07-07):** the server-side `filter_by` discovery query had
  compounded to `total=0` — `minOrganic` 81 and `minFeeActiveTvlRatio` 0.49 were the walls (found
  via `scripts/screening_funnel_audit.js` against a 9.5k-pool universe). Manually relaxed to
  74 / 0.30 (+ `minTvl` 30k, `minMcap` 300k) on 2026-07-07; the cycle-based starvation relaxer is
  the ongoing backstop. Note `minTvl`/`minMcap`/`minVolume`/`minHolders` are NOT evolution-owned —
  only manual edits move them. Also flagged during the audit: `fee_active_tvl_ratio` flows raw from
  the API with no scaling anywhere in code — prompt.js's "ALREADY in percentage form" claim
  (prompt.js:94) is interpretation, not enforced; and `athFilterPct` is read only by the GMGN path
  (dead on Meteora).
- **⚠️ Adding a `state_meta` singleton requires THREE edits, or it silently round-trips to null.** (1) `META_KEYS`, (2) the `initState()` cache reconstruction (an explicit whitelist — an unlisted key is read into `meta` then dropped), and (3) the `meta` object built inside `save()` (~state.js:231, also explicit, and it is what `persistNormalized` writes). Missing (2) or (3) writes `null` on the very next save. Cost me two failed deploys on `_deferredExitSwaps` (2026-07-27): a value seeded with the agent stopped flushed OK and read back `null` after start, twice. Also note an EMPTY map and a BROKEN map both read as `null` in the DB, so absence of a value proves nothing — verify with a real value round-trip.
- **⚠️ state_meta singleton clobber race (external writers lose):** `state.js save()`
  unconditionally upserts ALL META_KEYS singletons from the in-process cache, so a state_meta
  write made by an EXTERNAL process while the agent runs (e.g. `node cli.js baseline`) is
  silently overwritten by the agent's next save/shutdown flush (bit us 2026-07-05: a CLI
  baseline scan was clobbered by the PM2 restart's shutdown flush). Run CLI state mutations
  only with the agent stopped — or rely on in-process paths: baseline deposits are auto-
  detected by an hourly in-process cron (`45 * * * *`, index.js, added 2026-07-05) that
  Telegram-notifies "Deposit detected" and rebases ROI. (cli.js now drains flushState +
  flushAllDocStores before exit, which fixes the lost-write half; the clobber half is
  inherent to the cache design.)
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
- **Four shadow-mode features awaiting calibration + enable (2026-07-06 session):** OOR-flip
  tactic #07 (`oorFlipEnabled`) + swap-free redeposit (`swapFreeRedepositEnabled`), profit-gated
  fee compounding (`feeCompoundEnabled`), and the TWAP wick guard (`twapGuardEnabled`) all default
  OFF and log `[OOR_FLIP_SHADOW]`/`[SWAP_FREE_SHADOW]`/`[FEE_COMPOUND_SHADOW]`/`[TWAP_GUARD_SHADOW]`
  would-fire lines with zero on-chain behavior change, following the crash-fast-path house pattern
  above. Calibrate by grepping the shadow logs and cross-checking against `/exits` outcomes (and,
  for OOR-flip/compounding, the shadow-replay harness below) before flipping each flag.
- **Replay coverage is limited for pre-2026-07-06 closes.** The shadow-replay harness's per-pool
  snapshot ring was fixed 2026-07-06 (`fe8dffb`, per-position buckets instead of one flat 48-snap
  array per pool) — before that fix, a later position in the same pool could evict an earlier
  position's entire snapshot series, so closes recorded before this date may show up as
  `no_matching_position_snaps` exclusions in `extract.js --diagnose` output. Snapshot eras also
  differ: bins fields (`active`/`lower`/`upper_bin`) only exist post-06-16, so `replay.js`
  classifies the `oor` family as high-confidence only when bins are present, falling back to
  `in_range` + `minutes_out_of_range` + close-reason-family (lower confidence) for older records.
- **state + balance-history are normalized; the remaining doc stores are not.** State lives in real `positions`/`position_events`/`state_meta` rows; balance-history lives in `balance_history` rows (normalized 2026-06-30 — was the worst offender, an 8640-element array rewritten whole every 5 min). The rest (including the new `rejected-candidates` store added 2026-07-06) are still single `kv_store` jsonb documents (each write re-serializes the whole doc — same as the old files, no regression). The still-tabular ones (pool-memory snapshots, lessons.performance, error-telemetry) would benefit from row normalization; signal-weights/strategy-library/decision-log/blacklists/rejected-candidates are inherently document-shaped and fine as-is.
- **Phase 6 done:** daily `pg_dump` via `meridian-db-backup` → `/opt/meridian-backups` (see Persistence ops above). Note these are logical dumps, not WAL/PITR — restore granularity is daily.
- **Phase 5 done (now superseded):** monitoring data was first surfaced via `status_generator` → `monitor-status.json`; the dashboard now reads everything live from Postgres (decisions/positions from `kv_store`/`positions`, wallet address from `state_meta`) + live RPC for on-chain `balance`/`positions`, so that generator + file were retired.
- **Circuit Breaker resolved (2026-06-19)**: The circuit breaker state (`_circuitBreaker`) is now fully normalized into PostgreSQL (`state_meta` table) via synchronous wrappers in `state.js`. Performance logs are correctly loaded via `getAllPerformance()` from `lessons.js` instead of the stale `lessons.json` file on disk.
- The legacy `*.json` data files and the `state_doc` row are now **stale under `pg`** — intentionally kept as a cold rollback copy. Don't read them directly.
- **Gas-fee accounting (fixed 2026-06-22).** `fetchTxFeeLamports` now retries (4×800ms) so priority fees are captured for all tx types. Exit-swap slippage is also now captured additively via `recordExitSwapOutcome` (called from executor.js after every auto-swap) — stored in `exit_swap.slippage_usd` + `pnl_usd_net_exit_swap` on the closed-position record. The canonical `pnl_pct`/`pnl_usd` is still the pre-swap market value (consumed by lessons/evolve before the swap runs), so realized PnL remains mildly optimistic for illiquid exits, but the slippage cost is now tracked for analysis.
