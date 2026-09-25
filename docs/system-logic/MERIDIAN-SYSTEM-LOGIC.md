# Meridian — System Logic (compiled 2026-09-25)

Single-file compilation of README + the four domain inventories. Source of truth is the split files in this directory.


---

<!-- ===== README.md ===== -->

## Meridian — System Logic Reference (2026-09-25)

This is the complete map of what Meridian does, rule by rule, with the data behind each rule and
the platforms it depends on. It is the input for the audit that follows (efficiency, complexity,
rule refinement). It was compiled from the `experimental` tree at `a0fcd12`/`1fee2cb`, the live
production `user-config.json` on the VM (secrets redacted), the production Postgres ledger, and the
Sep 2026 replay studies. Line numbers refer to that tree.

**Structure**

| File | Scope |
|---|---|
| `README.md` (this file) | system loop, capital frame, cross-domain correlation map, evidence base, prod config snapshot, audit questions |
| `01-screening-and-admission.md` | discovery → admission → LLM screener contract (17 sections, every gate with file:line) |
| `02-deploy-execution.md` | executor safety block, sizing, geometry, tx pricing, close path, perf record fields |
| `03-management-and-exits.md` | both exit evaluators in order, precedence tables, hold mode, rebalance engine, Telegram handlers |
| `04-infrastructure-and-learning.md` | crons, platforms/endpoints, stores, learning loop, ledger truth, logging |

Where a domain file says "prod uncertain", §9 of this README carries the verified production value.

---

### 1. The loop at a glance

```
 every 15 min ─ SCREENING ──► Meteora discovery (rank envelope + steady 24h + Top Performers)
 (+ 45 s degen poll,           → safety gates → prescore → GMGN/Jupiter enrichment → intel bar → TVL floor
  + free-slot trigger)         → velocity gates → admit ≤5 → recon (smart wallets, narrative, audit)
                               → candidate blocks → LLM SCREENER (glm-5.3-flash) → deploy_position
                                                                                        │
                               executor safety block (20 checks) ◄──────────────────────┘
                               → Meteora DLMM SDK deploy (single-sided SOL ladder, 45–69 bins below spot)
                                                                                        │
 every 5 s ──── PnL POLLER ──► RPC valuation → updatePnlAndCheckExits (state.js) ──► confirm ticks → close
 every 3 min ── MGMT CYCLE ──► same + getDeterministicCloseRule (index.js) + action map (CLAIM/STAY/REVIEW/LLM)
                               → closePosition (claim → remove → close account → Jupiter swap → dust sweep)
                               → recordPerformance (lessons) → pool-memory → post-close probes → evolution (frozen)
 every 4 h ──── LEDGER TRUTH ► wallet book vs ledger vs unrealised → drift
 daily ──────── BRIEFING, DB BACKUP, ATA SWEEP
```

Three LLM roles share one model (`glm-5.3-flash` via Ollama cloud, `reasoning_effort=low`):
SCREENER (judges ≤5 candidates, may call `deploy_position`), MANAGER (only reached for
`INSTRUCTION`/`REVIEW` actions; the exit stack is deterministic), GENERAL (Telegram chat). The
money path never depends on the LLM for exits.

**Strategy in one sentence.** Deploy SOL only, into a ladder of bins *below* the current price of a
memecoin/SOL DLMM pool that is paying high fees per unit of TVL, earn fees while price oscillates
through the ladder, and exit mechanically: trailing take-profit on a confirmed peak, harvest when the
ladder has fully round-tripped above the range, stop-loss / crash / rug fast-paths on the way down,
low-yield close when the pool goes quiet.

---

### 2. Capital and risk frame (production values)

| Control | Value | Where |
|---|---|---|
| Position size | `clamp((wallet − 0.05) × 0.5, 0.4, 3.2)` SOL | `computeDeployAmount`, config.js |
| Max positions | 5 (held positions count, `maxPositionsExcludeHold=false`) | executor + screener |
| Scout / probe tiers | ON: scout 0.15 SOL (≤2, intel ≥78), probe 0.25 SOL (≤1) | executor clamps |
| Ladder width | 45–69 bins below spot, `bins_above=0` fixed, spot shape; steady lane preset `single_account` {45,69} | screener formula, executor floor 35 |
| Entry TVL floor | $100k (exempt: clean pool history ≥3 closes, 0 disasters, avg ≥ +1%) | 3 mirrors |
| Stop loss | −15% effective PnL (RULE_1 fires within ~6 s in the poller) | index.js |
| Trailing TP | arm at +2% confirmed peak, close on a 1.5 pp drop (overshoot 0.5 pp immediate) | state.js |
| Profit ratchet | arm +2 / stop −2 (inert behind trailing 2/1.5) | state.js |
| Circuit breaker | drawdown −15% or 6 consecutive losses → 6 h pause | circuit-breaker.js |
| SOL volatility guard | pause screening when SOL moves >8% in 1h, 30 min | sol-volatility.js |
| Hold mode | operator `/hold`: all automatic exits off, claims continue | state/index |
| Skimmer to Pionex | OFF; when ON proposes on Telegram only, `/skim now` executes | tools/transfer.js |
| Evolution of floors | OFF (`evolutionEnabled=false`) until ledger drift ≤ ±0.2 SOL/7d | lessons.js |

Wallet as of 2026-09-25: ≈2.15 SOL total AUM (≈$253), 4 → 2 held positions after the operator
closed KNOB×2 overnight, one autonomous slot in practice. AUM path since Aug 22 is in §8.

---

### 3. Discovery and admission (summary; full detail in `01-…`)

Production runs **rank mode** at a **1h** screening timeframe. The server query is a hard-coded safety
envelope (`RANK_ENVELOPE`: tvl ≥ 10k, mcap 100k–20M, holders ≥ 500, volume ≥ 1000/h, fee/TVL ≥
0.30%/h, bin step 80–125), fetched for `trending` + `top` (250 rows each), plus one 24h pass for the
**steady lane** (tvl ≥ 100k, fee/TVL ≥ 1.5%/24h, up to 10 extras, re-fetched at 1h so windows match)
and the Meteora **Top Performers** tab (10, 24h-ranked, *not* re-fetched). Then, in order:

1. **Safety gates** — blacklist, dev blocklist, occupied pool/mint, pool/token cooldown, unusable
   volatility, TVL drain (−30% from an in-process peak), blocked launchpads.
2. **Prescore** — `intel_total + momentum(+5/−10) + 12·(feeTVL pct − .5) + 10·(feeEff pct − .5)`;
   the top 10 are enriched (GMGN dev info; Jupiter audit in `log_only`, so Safety stays pinned at 50).
3. **Per-pool gates** — dump-play guard (rejects every ≥20% dumper because dev score is neutral 50
   without a discriminating GMGN read), intel bar **61** (steady lane **42**), entry-TVL floor 100k
   with clean-history / Top-Performer-trend / scout branches, velocity gates (vol/TVL ≥ 0.05, tx/min ≥
   2 at 1h; waived for the steady lane).
4. **Admit** ≤5 by admission score; attach lane width hints; annotate fee-efficiency, momentum, PVP.
5. **Recon** per candidate — smart wallets on pool, Jupiter narrative, Jupiter token info + audit,
   pool memory; post-recon drops: launchpad lists, bot holders > 38%, `[RUG_FILTER]`/`[CRI]` (log only).
6. **Lone candidate** — 0 → no-deploy report + starvation counter; 1 → `getLoneCandidateSkipReason`
   (fees < 30 SOL, top10 > 60%, narrative/degen ≥ 50) decides without the LLM.
7. **LLM suppressors** — identical-set fingerprint (30 min), per-pool verdict cache (reads fields the
   condensed candidate does not carry → effectively never skips).
8. **SCREENER prompt** — pick ≤1 pool, `bins_below = round(45 + vol/5·24)` clamped [45,69], `bins_above=0`,
   SOL only, optional `tier=probe`, lane width line wins when present, ANTI-LVR judgment on
   `pool_price_change`. The model calls `deploy_position`; the executor re-validates everything.

Measured funnel (1,506 cycles, Sep 18–25): universe 24.9 → safety 20.8 → prescore pool 10 →
enriched gates **0.9** → admitted **0.82** per cycle. Candidate supply, not `maxPositions`, is the
binding constraint (CLAUDE.md, Jul 27 audit: ~8 qualifying pools universe-wide).

---

### 4. Deploy execution (summary; full detail in `02-…`)

`runSafetyChecks("deploy_position")` runs one fresh discovery read (`validateDeployPoolThresholds`:
TVL floor/exemption/scout, maxTvl 800k, fee/TVL floor 0.05 with the steady-lane 24h waiver, velocity
gates with lane waiver, bin step 80–125, volatility usable) and then the 20-step safety block: hold
guard, bin-step arg, max positions (fresh on-chain count, held included), duplicate pool, duplicate
base mint (arg-only — the executor-derived mint is not consulted), re-entry cooldown (shadow), scout
clamp, probe clamp, `bins_above=0`, range floor `max(35, lane min | minBinsBelow)`, ≤69 cap,
positive SOL amount, min deploy 0.4 (0.05 for tiers), balance ≥ amount + gasReserve 0.05, timing
size-down (ON, floor 0.3, only when ≥40 decisive closes and ≥8 in the 4h block), bear debate (OFF).

`deployPosition` (dlmm.js) re-checks the range, resolves strategy `spot`/`curve`/`bidask`, prices
the transaction (normal tier: p50 × 1.2, 10k µL floor, 1M µL cap; exit tier: p75 × 1.5, 3M cap,
×1.5 per retry), sends via `RPC_URL` (Helius, rebate address), confirms, then `trackPosition` with
entry metrics (`entry_tvl/mcap/volume/holders`, `fee_tvl_ratio`, `entry_price_change_pct`, lane/
scout/probe flags, `active_bin_at_deploy`).

Round-trip gas: deploy 1–3 tx + claim 1 + remove/close 3 + swap 1 at ≈5,000 + priority lamports each;
≈0.002–0.01 SOL. Bin-array initialisation on a cold range costs 0.0714 SOL per array (refundable rent,
not fees).

---

### 5. Monitoring and the exit stack (summary; full detail in `03-…`)

Two evaluators run against every open, non-held, valuation-ready position:

**state.js `updatePnlAndCheckExits`** (poller every 5 s and the mgmt cycle), first hit wins, each
wrapped by `gateExit` (TWAP guard, OFF):
`TOXIC_CONVERSION` (≥85% base within 20 min, fees <1.5%) → `PROFIT_RATCHET` → `YOUNG_STOP` (shadow) →
`STOP_LOSS` (15 s timer; pre-empted by RULE_1 in practice) → `TRAILING_TP` (2/1.5, close-eff gate
shadow) → `LINEAGE_TAKE_PROFIT` (+4% across a rebalance chain) → `ROUND_TRIP_HARVEST` (≥5 bins above,
pnl ≥1% frozen 6 ticks) → `SURGE_DECAY` (fee/TVL −50% vs peak, ON) → `OUT_OF_RANGE` below 60 min →
`LOW_YIELD` (fee/TVL 24h < 1% after 120 min, with adoption grace + history floor).

**index.js `getDeterministicCloseRule`** (only when state.js returned nothing):
RULE_1 stop −15 → RULE_2 take profit +35 → lineage TP → RULE_3 pumped ≥50 bins above → **RULE_3u
unfilled ≥25 bins above with pnl <1% (new 2026-09-25)** → RULE_4 above 720 min (+2 stable ticks) →
RULE_4 below 60 min → RULE_5 low yield.

**Poller overrides**: crash fast-path (OOR-below, ≥12 bins/min over 90 s, ≥8 bins, 3 ticks, ON) and
in-range rug (≥12 bins/min AND pnl ≤ −3%, ON) replace any computed signal and bypass TWAP. Confirm
ticks: 2 for normal signals, 3 for crash/rug, overshoot ≥0.5 pp makes trailing immediate.

**Management-cycle action map** per position: exit → hold (CLAIM/STAY) → not-ready STAY →
operator INSTRUCTION (LLM) → RULE_1/2 → OOR-below ≥15 min rebalance branch (shadow: logs and falls
through) → RULE_3/3u/4/5 (FLIP shadow) → CLAIM if unclaimed ≥ 5 USD-equivalent → REVIEW (off) → STAY.

**Close mechanics**: claim → remove liquidity (claim+close in-tx) → close account → auto-swap base to
SOL via Jupiter (`/swap/v2/order`, RTSE slippage; exit-swap guard ON for remainders ≤ $25 at >5%
impact) → dust sweep ($0.25–$25) → `recordPerformance` → pool-memory outcome + cooldowns → post-close
probes at 30/60/180/720/1440 min (exit quality good/early/flat/delisted).

---

### 6. After the close: records, learning, truth

- **Performance record** (`lessons.performance`, one per close): `pnl_pct` (recomputed from final +
  fees − initial), `pnl_sol`, `pnl_sol_net` (− gas − exit slippage), `pnl_usd_true`, fees, deposit,
  `minutes_held`, `close_reason`, `mfe/mae_pnl_pct`, `max_bins_above/below`, `range_width_bins`,
  `entry_*`, `signal_snapshot` (intel, momentum, fee-efficiency, sim, similar_past), `adopted`/
  `scout`/`probe`/`lane`, `adoption_lifetime` (audit of the rebase), `rebalance_leg`, `unit_era:"v3"`.
- **Outcome objective** `classifyOutcome`: success if not fee-death and (pnl ≥ 2% or fee yield ≥ 2%);
  failure on stop-loss, pnl ≤ −5%, fee-death with yield <1%, OOR collapse; else neutral.
- **Exit-quality** from probes: `early_exit` when the pool kept rising after our close; `/exits`
  and the briefing show per-family counts (`⚠ selling bottoms` when early > good, n ≥ 6).
- **Evolution** (`evolveThresholds`, every 5th close, OFF in prod): raises gate-mode floors only
  (`minFeeActiveTvlRatio`, `minOrganic`, `minIntelScore`) with Cohen's-d ≥ 0.35 significance,
  40-close window, closed-loop auto-revert. **Starvation relaxer** (ON, not gated by the evolution
  switch) lowers the same three keys after 12 empty cycles — it lowered `minIntelScore` 61→52 on
  2026-09-24 14:06 local; in rank mode that key is not the admission bar (`rankMinIntelScore` 61 is),
  so the change is inert for admission but defeats the freeze's intent.
- **Evolution switch side effect (fixed 2026-09-25, 0c35d7d)**: the `evolutionEnabled=false` guard
  returned from `recordPerformance` on every 5th close, skipping the Darwin weight recalc, the hive
  performance push and the post-close circuit-breaker trip check; it now gates `evolveThresholds` only.
- **Ledger truth** (`ledger-truth.js`, every 4 h): `book = ΔAUM − deposits + withdrawals`,
  `ledger = Σ pnl_sol_net`, `drift = book − ledger − Δunrealised`. History since it went live is in §8.
- **Pool memory**: per-pool deploy outcomes, snapshots (48/position), cooldowns (OOR-below 12 h after
  3 triggers, low-yield 4 h on the bare reason string, gas-negative extensions), clean-history
  exemption source, rejected-candidates ring for the replay harness.

---

### 7. Platforms and tech stack

| Platform | Role in the system | Endpoint / mechanism | Auth | Failure behaviour |
|---|---|---|---|---|
| **Helius** | primary Solana RPC for reads, all transaction sends (`RPC_URL` with `rebate-address` → ~50% of backrun MEV paid back in SOL), WebSocket PositionV2 discovery for adoption, priority-fee percentiles | `RPC_URL`, `RPC_URL_FALLBACK_1`, `HELIUS_API_KEYS` rotation (`tools/rpc.js`, helius load balancer) | env | 429 "max usage reached" on a key → failover pool; monthly credit exhaustion seen 09-20→22 |
| **Meteora** | pool universe and windowed metrics (`pool-discovery-api.datapi.meteora.ag/pools`), rival lookup (`dlmm.datapi.meteora.ag`), closed-position lifetime PnL (datapi, `allTimeDeposits/Withdrawals/Fees`), Top Performers tab, DLMM SDK `@meteora-ag/dlmm` (deploy/claim/remove; `patch-anchor.js` postinstall) | HTTPS + SDK over RPC | none | discovery failure → empty cycle; datapi settle retries 6×5 s before a close record is written |
| **Jupiter** | token info/audit/holders/narrative (`datapi.jup.ag/v1/*`), price (`api.jup.ag/price/v3`), swaps (`api.jup.ag/swap/v2/order`), read-only quotes for the exit-swap guard and close-efficiency gate | keyless datapi; swap API key — **a hard-coded fallback key in `tools/wallet.js` is the one in use (no `JUPITER_API_KEY` in prod `.env`)** | see note | swap failure → retry ×3 → dust sweeper; audit missing → Safety neutral 50 |
| **GMGN** | developer info → dev score (dump-play guard), token safety refinement, fee totals, smart-money exodus | `openapi.gmgn.ai/v1/token/info`, `/market/token_top_holders`, `/market/token_top_traders`; `GMGN_API_KEY`, `gmgnRequestDelayMs` 2500 | env | per-IP bans ("temporarily banned due to repeated rate limit violations" seen 09-25) → neutral 50 → every ≥20% dumper rejected |
| **GeckoTerminal** | 5-minute OHLCV for the Top-Performer trend gate and the roll-up trend gate; the Sep 25 replay source | `api.geckoterminal.com/api/v2/networks/solana/pools/<pool>/ohlcv/minute` | none | HTTP 429 → trend "insufficient candles" → not confirmed |
| **LPAgent / agentmeridian relay** | winning-LPer study lines (`/top-lp`, `/study-top-lp`), chart indicators (`/chart-indicators`, gate mode only), Discord signals (off) | `api.agentmeridian.xyz/api`, `x-api-key` | env | 429 → cached null, line omitted |
| **Ollama cloud** | all LLM inference (`https://ollama.com/v1`, `glm-5.3-flash`, effort low; fallback model `google/gemini-3.7-flash` via OpenRouter when configured); dormant `claude-cli/` backend | `OLLAMA_API_KEY` | env | 502/503/529 retry → fallback; no-tool reply → "declined" (not cached) |
| **Telegram** | operator control (`/positions /close /hold /unhold /rebalance /set /unset /deploy /skim /exits /timing …`), deploy/close/OOR/skim/briefing notifications (HTML) | bot token, chat id, allowed user ids | env | unclosed-tag HTML errors (142 seen in Sep) drop the message, not the action |
| **Pionex** | skim destination for profits above target working capital | `PIONEX_DEPOSIT_ADDRESS`, `tools/transfer.js` | env | OFF in prod; confirmation-only rails |
| **PostgreSQL 16** | `positions`, `position_events`, `state_meta`, `balance_history`, `price_ticks` (30 d), `kv_store` docs (lessons, pool-memory, decision-log, signal-weights, strategy-library, smart-wallets, blacklists, error-telemetry, dashboard-report, rejected-candidates, ledger-truth) | `PG*` env, pool ≤5 | env | sync cache over async write-through; external writes lose to the agent's flush |
| **PM2 / Oracle VM** | `meridian`, `meridian-watchdog`, `meridian-dashboard` (port 3002), `meridian-syncer` (hourly `git pull`), `meridian-db-backup` (03:17 `pg_dump`) | ecosystem.config.cjs | — | 897-restart storm after an `apt upgrade` on 09-12/13 |
| **Zabbix, UFW, fail2ban, WireGuard** | host monitoring and access | HomeArchitecture repo | — | — |
| **Hive mind** | optional lessons/deploy sync | `HIVE_MIND_URL` | env | not required |

---

### 8. Evidence base

All figures from the production Postgres ledger unless stated. "SOL" sums use `pnl_sol_net` where
present (net of gas and exit slippage), else `pnl_sol`. Note the ledger caveat in §8.6.

#### 8.1 Closes since 2026-08-22 by exit family (plan #15 §2, 433 closes to 09-24)

| Family | n | avg % | Σ SOL | win |
|---|---|---|---|---|
| trailing TP | 103 | +4.10 | +7.94 | 97% |
| manual (/close, dashboard, menu) | 108 | +1.91 | +6.43 | 75% |
| round-trip harvest | 75 | +3.51 | +3.02 | 97% |
| external close (reconciliation) | 25 | +4.65 | +2.69 | 64% |
| profit ratchet | 28 | −0.01 | −0.24 | 57% |
| fee-death / low-yield | 29 | −0.04 | −0.02 | 52% |
| OOR below | 8 | −8.67 | −1.59 | 0% |
| crash / rug fast-path | 15 | −21.65 | −4.68 | 0% |
| stop loss (+young stop) | 25 | −13.30 | −6.12 | 0% |

Winners are many and small; losers are few and large. The three downside families (48 closes)
cost −12.4 SOL against +20 SOL from the 311 positive-family closes — before the ledger correction.

#### 8.2 Closes since 2026-08-22 by segment (462 closes to 09-25)

| Segment | n | avg % | Σ SOL | win | median held |
|---|---|---|---|---|---|
| adopted / operator positions | 272 | +1.20 | +9.17 | 75% | 48 min |
| bot, burst lane | 73 | −0.19 | −0.26 | 71% | 96 min |
| bot, steady lane | 69 | −1.59 | −2.18 | 67% | 377 min |
| probe tier | 47 | +0.53 | +0.01 | 62% | 93 min |
| scout tier | 1 | +0.40 | 0.00 | — | 15 min |

The operator's own positions (adopted by the bot and managed by its exit stack) are the only
segment with a materially positive sum — and 21+ of those records are still lifetime-scored, so the
+9.17 is overstated (plan #15 §1). The steady lane, built to copy the operator's style, is the
worst bot segment: long holds, negative sum.

#### 8.3 Entry TVL band since 2026-08-22 (bot deploys only)

| Band | n | avg % | disasters (≤ −10%) | worst |
|---|---|---|---|---|
| 100–200k | 84 | +0.09 | 6 | −36.4 |
| ≥ 200k | 80 | −0.82 | 11 | −41.0 |
| unknown entry TVL | 23 | −1.79 | 3 | −79.0 |
| < 100k | 3 | +0.15 | 0 | 0.0 |

The Jul 27 finding ("≥100k = zero disasters") **no longer holds** in the Aug–Sep era: 17 disasters
above the floor. The floor still binds the universe (see §3 funnel) but is not buying safety.

#### 8.4 Holding time since 2026-08-22

| Held | n | avg % | Σ SOL |
|---|---|---|---|
| < 30 min | 158 | +0.50 | +1.21 |
| 30 min – 2 h | 91 | +0.96 | +0.56 |
| 2 – 6 h | 94 | +1.77 | +1.52 |
| 6 – 24 h | 84 | +0.80 | +1.99 |
| > 24 h | 35 | −4.90 | +1.46 (held cohort, lifetime-scored) |

#### 8.5 AUM path (daily mean total SOL, `balance_history`)

Aug 22 11.85 → Aug 28 12.55 → Sep 4 2.08 → Sep 9 13.18 → Sep 14 7.56 → Sep 21 2.45 → Sep 25 2.15.
Operator flows over the same span: −8.91 withdrawn, +1.75 deposited; book result −2.50 SOL to Sep 24,
of which −3.35 was unrealised on held positions (plan #15 §1). The swings on Sep 4→9 and Sep 14→21
are operator withdrawals/deposits, not trading.

#### 8.6 Ledger truth since it went live (2026-09-24)

| At (UTC) | 24h book | 24h ledger | 24h drift | 7d book | 7d ledger | 7d drift | fidelity |
|---|---|---|---|---|---|---|---|
| 09-24 05:11 | −0.24 | +0.02 | −0.12 | −4.22 | −1.69 | −1.41 | 54% |
| 09-24 13:11 | −0.22 | +0.03 | −0.10 | −4.94 | −1.87 | −1.88 | 50% |
| 09-24 21:11 | −0.08 | +0.03 | −0.05 | −3.52 | −0.47 | −2.07 | 19% |
| 09-25 01:11 | −0.07 | −1.85 | +0.90 | −3.76 | −2.35 | −1.21 | 66% |

The 7-day ledger still understates the wallet's loss by 1–2 SOL (adopted rows without a basis, exit
slippage before `pnl_sol_net`, unrecorded rebalance legs). The +0.90 on 09-25 is the operator's two
KNOB closes at −55%/−68% being lifetime-scored while the unrealised estimate for them was −36%.

#### 8.7 Replay / study results that shaped current rules

| Study | Result | Rule affected |
|---|---|---|
| 2026-07-27 exit replay, 278 closes | trailing 3/1 worst cell; 2/1.5 best on every axis; ratchet inert at 2/1.5; stop −15 monotone-best | trailing, ratchet |
| 2026-07-27 entry-TVL bands, 280 closes | step at $100k (60–100k worst band) | `minTvl` 100k + exemption |
| 2026-07-29 re-entry audit, 133 re-deploys | no penalty for rapid re-entry in Jul (June artifact) | re-entry cooldown → shadow |
| 2026-07-07 admission backtest, 181 closes | fee/TVL Spearman +0.39 (Q1→Q4 14%→67%), intel ≥52 knee, organic flat | rank mode, `RANK_ENVELOPE` |
| 2026-08-22 yield-window backtest, 300 records | log mode = monotone rescale, gate 52→61 | `intelYieldWindowMode=log`, bars 61/78 |
| 2026-09-24 replay re-run (Sep paths) | grids cannot rank 2/1.5 vs the 8% adaptive pin; OOR-below 60–90 leads; ratchet ≤ none | adaptive trailing → shadow, OOR 720/60 |
| 2026-09-25 far-above study, 59 events + GeckoTerminal 6h paths | unfilled ladder: 63% of paths retrace ≥20% within 6h; rolled-up ladder mean −11%/6h; original left open 23% tail < −2% | unfilled cap 25 bins, no auto re-centre |
| 2026-09-13→19 live roll-ups, 10 chains | ≈ +1.3 SOL wins vs −1.15 SOL losses with wallet-wide sizing | rebalance engine → shadow, proceeds-only sizing |

---

### 9. Production configuration snapshot (2026-09-25, secrets redacted)

Values that differ from code defaults are marked ▲. Keys not listed are at code default.

**Capital / cadence**: deployAmountSol 0.4 · maxDeployAmount 3.2 ▲ · positionSizePct 0.5 ▲ · gasReserve 0.05 · minSolToOpen 0.45 (no consumer) · maxPositions 5 ▲ · maxPositionsExcludeHold false · managementIntervalMin 3 ▲ · screeningIntervalMin 15 ▲ · pnlPollIntervalSec 5 · pnlSource rpc · solMode true.

**Screening**: screeningAdmissionMode rank ▲ · timeframe 1h ▲ · category trending · minTvl 100000 ▲ · maxTvl 800000 ▲ (executor only) · minMcap 300000 ▲ · maxMcap 10M · minHolders 500 · minLps 5 (gate only) · minVolume 1000 · minOrganic 60 · minQuoteOrganic 70 · minFeeActiveTvlRatio 0.05 · minBinStep 80 / maxBinStep 125 · minTokenAgeHours 2 / max 720 · minTxPerMin 5 · minVolumeTvlRatio 0.05 · maxBotHoldersPct 38 ▲ · maxTop10Pct 60 · maxBundlePct 35 · minTokenFeesSol 30 · minIntelScore 52 (gate key; relaxer-lowered) · rankMinIntelScore 61 ▲ · rankSteadyMinIntel 42 ▲ · rankSteadyEnvelopeEnabled true ▲ · steadyLanePlaystyle single_account ▲ · steadyLaneShape spot · intelYieldWindowMode log ▲ · safetyEnrichMode log_only ▲ · scoutTierEnabled true ▲ (scoutSizeSol 0.15, scoutMaxPositions 2, scoutMinIntel 78) · probeTierEnabled true ▲ · topPerformersEnabled true (limit 10, minTvl 15000, requireTrend true, 6×5m) · organicMomentumHardFilter true (inert in rank mode) · organicMomentumDecayTraderPct −18 · tvlDrainEnabled true (−30%) · rugFilterMode log_only · timingGateEnabled true ▲ (floor 0.3, size_down) · repeatDeployCooldownEnabled false · repeatDeployCooldownLosersOnly true · poolReentryCooldownEnabled false · bearDebateEnabled false · evolutionEnabled false ▲ · darwinEnabled true · chartIndicators.enabled true (gate only) · circuitBreaker −15% / 6 losses / 6 h · solVolatilityThresholdPct 8.

**Management / exits**: stopLossPct −15 · takeProfitPct 35 · trailingTriggerPct 2 / trailingDropPct 1.5 / trailingOvershootPct 0.5 / trailingMinPnlPct null · profitRatchet on, 2 / −2 · adaptiveTrailingMode shadow · inventoryExhaustionMode shadow · outOfRangeBinsToClose 50 · outOfRangeBinsToCloseUnfilled 25 ▲ / unfilledMaxPnlPct 1.0 · outOfRangeWaitMinutes 60 / Above 720 / Below 60 · oorAboveStableTicks 2 · minFeePerTvl24h 1 · minAgeBeforeYieldCheck 120 · crashFastPathEnabled true ▲ · inRangeRugEnabled true ▲ · youngStopEnabled true (shadow) · toxicConversionEnabled true (85% / 20 min / 1.5%) · surgeDecayExitEnabled true ▲ (50% / 15 min) · roundTripHarvestEnabled true ▲ · twapGuardEnabled false · exitSwapGuardEnabled true ▲ · rebalanceEnabled true / rebalanceMode shadow ▲ / rebalanceMaxCount 2 / rebalanceMinOorMinutes 15 / rebalanceLineageTakeProfitPct 4 / rebalanceBinsBelow 35 / Above 34 · minClaimAmount 5 · autoSwapAfterClaim true · manageUntracked true · postCloseProbeMinutes [30,60,180,720,1440] · rangeHarvestPools [1 pool] · closeSendsViaPrimaryRpc true.

**Transactions**: enablePriorityFees true · priorityFeeMultiplier 1.5 · maxPriorityFeeMicroLamports 5,000,000 · txMaxRetries 5 · exit priority tier on (p75 × 1.5, cap 3M).

**LLM**: all roles glm-5.3-flash · temperature 0.1 · maxTokens 16384 · maxSteps 20 · claudeCliFallbackModel google/gemini-3.7-flash.

**Skimmer**: enabled false · targetWorkingCapitalSol 6.25 · minTransfer 0.5 · maxDaily 2 · requireTelegramConfirmation true.

---

### 10. Cross-domain correlation map

The domain files end with their own correlation sections; this consolidates the ones that cross
domains. Numbers in brackets point to the domain file section.

#### 10.1 One signal, many gates (double counting)
- **fee / TVL** enters admission four times (envelope floor, intel Yield 35%, fee-TVL percentile ±6,
  fee-efficiency percentile ±5) and again at the executor floor and in the LLM's `sim:`/`fee_efficiency`
  lines. Thin pools maximise it, and thinness is the disaster driver [01 §17.1, CLAUDE.md TVL note].
- **Entry TVL floor + clean-history exemption** implemented independently at three sites; the rank
  path adds an intel bar for scouts, the executor does not [02 §16.1].
- **Bins-below formula** `min + vol/5·(max−min)` exists in five copies (prompt, STEPS, steady hint,
  `computeBinsBelow`, pool-simulator downside) [01 §17.6].
- **Hold-mode guard** in four places; **velocity gates** and **launchpad block** in three [02 §16].
- **Lineage take-profit** in three code paths with three reason strings and two exit families [03 §10.1].
- **Stop-loss, OOR-below, low-yield** each evaluated by both evaluators; the index.js copies win in
  practice, so the state.js STOP_LOSS timer, its TWAP wrapping and its urgency flag are dead [03 §4.3].

#### 10.2 Rules that contradict each other
- Prompt tells the SCREENER to buy −10…−35% dips (SPOT-ON-DUMP) while the dump-play guard rejects
  every ≥20% dumper before the LLM whenever GMGN returns neutral (banned IP → always) [01 §17.7].
- Prompt's RENEWED-FLOW and "ACCELERATING flow clears the solo bar" rules read a `flow:` line that is
  never rendered (fields `fee_tvl_24h`/`fee_per_tvl_24h` do not exist on candidates); the gas
  break-even filter reads the same missing fields and always passes [01 §17.15–16].
- Steady lane: screening admits at fee/TVL ≥ 1.5%/24h but the executor's lane waiver re-checks
  against `minFeePerTvl24h` (prod 1) — consistent today only because prod overrides the default 7 [02 §16].
- `maxTvl` is not applied in rank-mode screening but is at the executor → a pool can be judged by the
  LLM and then blocked [01 §17.11]. Same shape for the sub-floor incident that produced the scout tier.
- The starvation relaxer moves gate-mode keys that rank mode ignores; the evolution freeze does not
  cover it [README §6].
- Toxic-conversion and surge-decay reason strings contain "yield" → classified as fee-death;
  round-trip harvest contains "above" → classified OOR-above; ratchet/young-stop/rug/lineage → `other`.
  Exit-quality stats and evolution read those families [03 §10.2].
- `URGENT_EXIT_ACTIONS` keyed on the signal string means a poller RULE_1 stop-loss is not urgent for
  fast-close, while the mgmt-cycle RULE_1 is [03 §10.2].
- Operator `/rebalance` skips pool re-validation in code although the comment and CLAUDE.md say only
  the depth cap is skipped [03 §10.2].
- CLAUDE.md's `wide {60,110}` / `maxBinsBelow 90` are unreachable behind the hard 69-bin cap; the
  >69-bin deploy path and `isWide` gas estimate are dead code [02 §16].
- Documented defaults drifted from `config.js` (stop −18, ratchet 6/+1.5, RULE_3 10 bins, ratchet on,
  deployAmountSol 0.4, gasReserve 0.05) — prod values are correct only because `user-config.json`
  overrides them [02, 03].

#### 10.3 Dead or inert under production config
Screening: gas break-even filter, `flow:` line, verdict cache skip, Safety/Trust/Momentum
sub-scores (Safety pinned 50 in log_only), `minDevScore`, chart indicators, Discord signals, `minLps`
in rank mode, `organicMomentumHardFilter` in rank mode, gate-mode machinery + `[RANK_SHADOW]`,
`lpStyleSteerEnabled`, rug/CRI filters (log only), relaxer effect on admission.
Execution: `minSolToOpen`, wide-range path, LPAgent relay deploy/close, bear debate (and with it
`deploy_confidence`/`deploy_thesis` capture), `computeDeployAmount` fallback in `deployPosition`.
Exits: state.js STOP_LOSS action, profit ratchet, RULE_4 above (720 min, clock resets), REBALANCE /
STAY-wait (shadow), REVIEW (autoReview off), young stop, TWAP guard, close-efficiency gate, OOR flip,
swap-free redeposit, fee compounding, fast-close skip, slippage cap, adaptive trailing, inventory
exhaustion, re-entry cooldown, RULE_2 absolute TP at +35 (trailing always fires first).
Infra: skimmer, hive mind, claude-cli backend, evolution.

Roughly **two-thirds of the flag families in `config.js` are shadow or dead in production.** Each still
costs a code path, a log line, and in three cases an external API call per position tick (GeckoTerminal
trend fetch on every harvest hit for a shadow roll-up; Jupiter quotes for the shadow close-efficiency
gate; GMGN dev fetch for a neutral dev score).

#### 10.3a Infrastructure findings (from `04-…` §9)
- **Cron grid collisions**: skim `*/5`, health `0 * * * *`, screening `*/15` all land on the `*/3`
  management minute and are skipped by the busy guard on those ticks (reconciliation and baseline
  were already moved to `7,22,37,52` / `:50` for the same reason). The 45 s opportunity poller runs
  the full discovery funnel whenever a slot is free, multiplying Meteora/Jupiter load.
- **Send path has no failover**: every deploy/close/swap goes through the single `RPC_URL` key; reads
  fail over, sends do not. A quota 429 on that key stops the money path while screening continues.
- **Watchdog blind spot**: the heartbeat is written by the poller tick before its busy guard, so a
  wedged management cycle still looks alive.
- **`user-config.json` has four writers**, two non-atomic (`update_config`, hive pull), besides the
  operator's editor and the evolution/relaxer path.
- **Duplicated time series**: pool-memory snapshots (48/position), `price_ticks` (30 d), liquidity
  ticks (72 h) and the dashboard report all carry bin/PnL series at different cadences; ten typed
  tables from `001_init.sql` exist empty next to the kv docs that hold the same data.
- **Config/doc drift**: PM2 `max_memory_restart` is 2G (CLAUDE.md says 512M); `healthCheckIntervalMin`
  is not wired (hard-coded hourly); `darwin.recalcEvery` and `JUPITER_PRICE_API` are unused; hive mind
  is on by default via built-in constants, not the env vars CLAUDE.md names.
- **Command server** defaults to port 3001 (NeoTasker's port); prod avoids the clash only because
  `MERIDIAN_COMMAND_PORT` is set in `.env` (verified 2026-09-25).
- **Shared fallback credentials** hard-coded in source: Jupiter swap key (`tools/wallet.js`, in use
  in prod — no `JUPITER_API_KEY` in `.env`), Agent Meridian / hive-mind key (`config.js`).

#### 10.4 Where the money actually moves (what to audit first)
1. **Entry selection** — the funnel admits 0.8 candidates/cycle from a universe of ~25; the 100k floor
   no longer separates disasters (17 above it since Aug 22); fee/TVL is counted four times.
2. **Exit asymmetry** — 48 downside closes cost as much as 311 upside closes made; the fast paths
   (crash/rug/stop) are the only prod rules that fire on the way down and they fire late by design
   (−13 to −22% average).
3. **Adopted-operator flow** — the operator's manual entries are the only positive segment; the bot's
   copy of that style (steady lane) is the worst. The difference is entry timing, not exit rules.
4. **Accounting** — the ledger is now structurally honest for new records, but 21+ adopted rows and
   all pre-09-24 rebalance legs are still lifetime-scored; evolution must stay frozen until drift is
   inside ±0.2 SOL.
5. **Operational cost** — every shadow feature costs API quota (Helius 429s on 09-25 boot, GMGN IP
   ban, GeckoTerminal 429) on a VM already running four PM2 apps.

---

### 11. Questions to settle in the audit

1. Which of the ~30 shadow/dead flag families should be deleted outright rather than kept "for later"?
2. Should admission collapse to one fee/TVL term plus a rug filter, with the LLM judging trend/timing
   only (the operator's edge)?
3. Is the 100k TVL floor still earning its place, or should the disaster control move to position
   sizing and the downside fast-paths?
4. Should the two exit evaluators be merged into one ordered list (state.js) with index.js reduced to
   the mgmt-cycle action map?
5. Reason-string families → explicit `exit_family` field on the record instead of keyword matching.
6. Replace GMGN-dependent dev score (banned IP → neutral) with the Jupiter audit fields already fetched.
7. Rotate and remove the hard-coded Jupiter key; set `JUPITER_API_KEY` in `.env`.
8. Cap external calls per tick: no GeckoTerminal fetch for shadow roll-ups, no Jupiter quotes for a
   shadow gate.
9. Gate the starvation relaxer behind the evolution switch, and retarget both at rank-mode keys.
10. Decide the steady lane's future on its own data (69 closes, −2.18 SOL, 6-hour median hold).

---

<!-- ===== 01-screening-and-admission.md ===== -->

## Meridian — SCREENING / CANDIDATE DISCOVERY domain inventory

Read-only inventory of everything that decides which Meteora DLMM pools reach the SCREENER LLM and what candidate lines it sees. Compiled 2026-09-25 from the `experimental` checkout at `/Users/Angga/Repos/meridian` (HEAD `a0fcd12`). Line numbers are for that tree; `~` marks an estimate within a few lines.

Conventions
- Log tags: `log(category, msg)` renders `[CATEGORY-UPPERCASED] msg` (logger.js:41-49), so `log("screening", "funnel: …")` appears as `[SCREENING] funnel: …`; bracketed sub-tags such as `[TVL_EXEMPT]` are literal text inside the message.
- "Code default" = `config.js`. "Prod" = value stated in CLAUDE.md (the VM's `user-config.json` is not in this checkout; the local `user-config.json` is a dev copy carrying only rebalance/top-performer/risk keys and is NOT authoritative for screening floors). Anything marked *uncertain* could not be confirmed from code or CLAUDE.md.
- Prod screening timeframe: CLAUDE.md's config table lists the code default `"5m"`, but multiple dated code comments (tools/screening.js:71-77 "the ~1h live screening timeframe", intel-score.js:219 "prod feeds fields windowed by config.screening.timeframe (1h)", tools/executor.js:205) say prod runs **1h**. Treat prod = 1h (uncertain).

---

### 0. Funnel map (prod = Meteora source, `screeningAdmissionMode="rank"`)

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

### 1. Triggers and pre-cycle guards

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

### 2. Discovery fetch (Meteora Pool Discovery API)

Base: `POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag"` (tools/screening.js:22). Endpoint shape (477-491): `GET /pools?page_size=N&filter_by=<url-encoded '&&'-joined filters>&timeframe=<tf>&category=<cat>[&after_key=…]`. Detail fetch (493-507): `GET /pools?page_size=1&filter_by=pool_address=<addr>&timeframe=<tf>`.

The API's `volume`, `fee`, `fee_active_tvl_ratio`, `swap_count`, `*_change_pct`, `pool_price_change_pct` are WINDOWED by `timeframe`; `tvl`, `mcap`, `holders`, `bin_step` are levels.

#### 2.1 Gate-mode query — `discoverPools` (665-857)
`filter_by` (667-689): `base_token_has_critical_warnings=false && quote_token_has_critical_warnings=false && [base_token_has_high_supply_concentration=false if excludeHighSupplyConcentration] && base_token_has_high_single_ownership=false && pool_type=dlmm && base_token_market_cap>=minMcap && base_token_market_cap<=maxMcap && base_token_holders>=minHolders && volume>=minVolume && tvl>=minTvl && [tvl<=maxTvl] && dlmm_bin_step>=minBinStep && dlmm_bin_step<=maxBinStep && fee_active_tvl_ratio>=minFeeActiveTvlRatio && base_token_organic_score>=minOrganic && quote_token_organic_score>=minQuoteOrganic && [base_token_created_at<=now−minTokenAgeHours] && [base_token_created_at>=now−maxTokenAgeHours] && [base_token_launchpad=[allowedLaunchpads]]`; `page_size=50`, `timeframe=s.timeframe`, `category=s.category`.

This is the query that compounded to `total=0` in the 2026-07-07 starvation incident (CLAUDE.md Known Issues).

#### 2.2 Rank-mode query — `discoverPoolsBroad` (866-950)
Hardcoded `RANK_ENVELOPE` (78-85): `minTvl 10_000`, `minMcap 100_000`, `maxMcap 20_000_000`, `minHolders 500`, `minVolume1h 1_000`, `minFeeActiveTvlRatio1h 0.30`. Windowed floors are scaled `× tfMinutes/60` (873-876): at 1h → volume≥1000, fee_tvl≥0.30; at 5m → volume≥83, fee_tvl≥0.025. `filter_by` (878-894) = safety flags + `pool_type=dlmm` + mcap band + holders + scaled volume + `tvl>=10000` + scaled fee floor + configured bin-step band + token-age bounds. **No organic/quote-organic, no maxTvl, no minVolume/minMcap/minHolders from config.** Categories: `[s.category, "top"]` (897-898), `page_size=250` (89), max 3 requests total (90) → with two categories, 1 page each. Dedupe by `pool_address` (924-926). Then `discoverSteadyEnvelope` (939, §5) and `discoverTopPerformers` (942, §6). Universe count = `byAddr.size` (949).

Evidence in code comment (69-76): `fee_active_tvl_ratio >= 0.30` chosen because "bottom fee_tvl quartile had only 14% success (Spearman +0.39, Q1→Q4 14%→67%)" — 2026-07-07 backtest of 181 closes.

#### 2.3 Volatility timeframe override — `applyVolatilityTimeframe` (509-555)
`MIN_VOLATILITY_TIMEFRAME="30m"` (23): if `s.timeframe` is shorter than 30m, one detail GET per pool at 30m; `pool.volatility`/`pool.volume` are OVERWRITTEN with the 30m values (541-546) and both windows are kept as `volume_<tf>`/`volatility_<tf>`. At prod 1h this is a no-op (1h ≥ 30m), so `volatility` is the 1h value. Prompt text (prompt.js:82) explains the same.

#### 2.4 Timeframe scaling of config floors — screening-scales.js
`TIMEFRAME_SCREENING_SCALES` (8-16): 5m {fee 0.02, vol 500}, 30m {0.15, 1000}, 1h {0.2, 10000}, 2h {0.4, 20000}, 4h {0.4, 2000}, 12h {1.5, 60000}, 24h {2.0, 10000}. Applied ONLY by `update_config` when `timeframe` changes without explicit floors (tools/executor.js:1081-1088, log `[CONFIG] timeframe X → auto-scaled …`). `DEFAULT_TIMEFRAME="4h"` (18) is the fallback for an unknown string, while `config.screening.timeframe` defaults to "5m" (config.js:151). Same table is rendered to the LLM as "decent" guidance (prompt.js:84-93).

#### 2.5 Discord signals (inert)
`useDiscordSignals` false (config.js:219) → `fetchDiscordSignalCandidates` (468, `${config.api.url}/signals/discord/candidates`), `refreshDiscordOnlyPools` (645), `enrichDiscordSignalLaunchpads` (557, Jupiter `assets/search`) never run.

#### 2.6 GMGN source (not prod)
`screening.source` "meteora" (prod). `"gmgn"` routes to `discoverGmgnPools` (tools/gmgn.js:568) — not documented further here.

---

### 3. The two admission modes side by side

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

#### 3.1 Gate-mode client recheck order — `getRawPoolScreeningRejectReason` (367-466)
Returns the first failing reason string (family = text before `below|above|not|is|unusable|has`): supply-concentration flag → critical warnings (base, quote) → high single ownership → `pool_type!=dlmm` → `mcap<minMcap` / `>maxMcap` → `holders<minHolders` → `total_lps<minLps` (only if `minLps>0`; default 0) → `volume<minVolume` → `tvl<minTvl` unless `hasCleanPoolHistory(pool_address).clean` (`[SCREENING] [TVL_EXEMPT] <name>: TVL $x < minTvl $y but pool history is clean (n closes, worst w%, avg a%) — admitting`, 409) → `tvl>maxTvl` → bin_step band → volatility unusable (`isUsableVolatility`: finite and >0, 331) → `fee_active_tvl_ratio<minFeeActiveTvlRatio` → `volume/TVL<minVolumeTvlRatio` (425-431; ratio = `volume_tvl_ratio ?? volume/tvl`) → `tx/min<getMinTxPerMinForTimeframe(tf,minTxPerMin)` (433-443) → base organic `<minOrganic` → quote organic `<minQuoteOrganic` → allow-list (discord-signal pools only, 452-459) → `blockedLaunchpads` → token age bounds.

`getMinTxPerMinForTimeframe` (45-56): 5m → base; 1h → min(base,2.0); 24h → min(base,0.8); other → min(base,2.0). Code defaults: `minTxPerMin` 5.0, `minVolumeTvlRatio` 0.05 (local dev copy also 5 / 0.05).

Config defaults (config.js:134-153): `minFeeActiveTvlRatio` 0.05 (prod uncertain: 0.30 set 2026-07-07 per CLAUDE.md; executor comment dated 2026-08-22 at tools/executor.js:205 calls the floor "0.05%/h", and `EVOLVE_BASELINES.minFeeActiveTvlRatio=0.05` is where the starvation relaxer walks it), `minVolumeTvlRatio` 0.05, `minTxPerMin` 5, `minTvl` 10_000 → **prod 100_000**, `maxTvl` 150_000 → **prod 400_000** (CLAUDE.md), `minVolume` 500, `minOrganic` 60 (prod 74 as of 07-07), `minQuoteOrganic` 60, `minHolders` 500, `minLps` 0, `minMcap` 150_000 (prod 300_000 as of 07-07), `maxMcap` 10_000_000, `minBinStep` 80, `maxBinStep` 125, `timeframe` "5m" (prod 1h, uncertain), `category` "trending", `excludeHighSupplyConcentration` true, `allowedLaunchpads` [], `blockedLaunchpads` [], `minTokenAgeHours`/`maxTokenAgeHours` null.

---

### 4. Rank-mode admission in detail (`getTopCandidatesRank`, 1589-1895)

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

### 5. Steady lane end-to-end (plan #12)

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

### 6. Top Performers path

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

### 7. Scout and probe tiers as seen from screening

**Scout** (sub-floor, history-building): admission only in rank mode at 1759-1776 (bar `scoutMinIntel`, enriched intel), or via Top-Performer sub-floor without clean history (1735-1739). Candidate block line `scout_tier: TVL below the $minTvl floor — admitted as a HISTORY-BUILDING scout. The executor will cap the deploy at scoutSizeSol …` (index.js:1929-1931). Scouts bypass the gas break-even filter (1823-1826, `Gas filter: <name> exempt (scout tier …)`). Executor mirror: `validateDeployPoolThresholds` returns `scoutTier=true` for any sub-floor unproven pool when `scoutTierEnabled` (tools/executor.js:170-182, `[SCOUT] deploy below minTvl … treated as scout`), else `SAFETY_BLOCK` "Pool TVL $x is below configured minTvl $y" (184-187); safety block clamps `amount_y` to `scoutSizeSol` (min 0.05), caps open scouts at `scoutMaxPositions` (1909-1927; `Scout limit reached`, `[SCOUT] clamping deploy size`), sets `args.scout=true`, min-deploy floor 0.05 (1971). Config: `scoutTierEnabled` false (prod uncertain), `scoutSizeSol` 0.12, `scoutMinIntel` 70 → **prod 78**, `scoutMaxPositions` 1.

**Probe** (above-floor, low conviction): purely an LLM-requested `deploy_position.tier="probe"` (tools/definitions.js:203-207). Offered in the system prompt (prompt.js:117-118) and STEPS (index.js:2171-2172) only when `probeTierEnabled`. Executor (tools/executor.js:1929-1965): refused when disabled (`Probe tier is disabled (probeTierEnabled=false) …`), clamp to `probeSizeSol` (min 0.05), cap `probeMaxPositions` (`Probe limit reached`), `args.probe=true`; a scout never doubles as a probe (`probeRequested && !scoutTier`). Config: `probeTierEnabled` false (prod uncertain — enable order per CLAUDE.md is losers-only → steady → probe), `probeSizeSol` 0.25, `probeMaxPositions` 1.

Both `scout`/`probe` are stripped from caller args (1724-1725) and derived only by the executor.

---

### 8. Post-funnel processing in `runScreeningCycle` (index.js)

#### 8.1 Recon loop (1740-1752)
For each candidate (sequential, 150 ms spacing): `checkSmartWalletsOnPool({pool_address})` (smart-wallets.js:47-97; LP-type tracked wallets, `getWalletPositions` per wallet with cache; `in_pool` list), `getTokenNarrative({mint})` (tools/token.js:21-30, `GET https://datapi.jup.ag/v1/chaininsight/narrative/<mint>`), `getTokenInfo({query: mint})` (tools/token.js:36-97, `GET https://datapi.jup.ag/v1/assets/search?query=<mint>` → first hit: `mcap, liquidity, holders, organic_score, launchpad, graduated, global_fees_sol (Jupiter fees, refined by GMGN /v1/token/info total_fee when keyed + feeSource="gmgn"), audit{mint_disabled, freeze_disabled, top_holders_pct, bot_holders_pct, dev_migrations, insider_pct, sniper_pct, dev_balance_pct, dev_mints, permanent_control, bundler_pct, bundler_pct_ath}, stats_1h{price_change, buy_vol, sell_vol, buyers, net_buyers}, stats_24h_net_buyers`), `recallForPool(pool)` (pool-memory.js:598-643 → "POOL MEMORY [name]: n past deploy(s), avg PnL, win rate, last outcome" + POOL/TOKEN COOLDOWN lines + RECENT TREND + last NOTE).

#### 8.2 Rug signals + CRI (1757-1771; rug-signals.js)
Always computed: `extractRugSignals(ti, pool)` (75-151; returns all-null if `ti.mint !== pool.base.mint`), `evaluateRugFilter` (153-168: fires only when value AND threshold non-null and `value > limit` for `insider_pct > rugMaxInsiderPct`, `top10_pct > rugMaxTop10Pct`, `dev_mints > rugMaxDevMints`), `computeClusterRiskIndex` (242-317: `concentration` = √Σpct² over top-10 non-vault holders (or `top10_pct` fallback), weighted 0.40 + `bundler_pct` 0.35 + `fresh_wallet_pct` 0.25, re-normalised over available terms; levels ≥70 critical / ≥50 high / ≥25 medium), `evaluateClusterRisk` (327-338: `cri > criRejectThreshold`). Config: `rugFilterMode` "off", `rugMaxInsiderPct` 20, `rugMaxTop10Pct` 60, `rugMaxDevMints` null, `criFilterMode` "log_only", `criRejectThreshold` 75.0. Field availability evidence (rug-signals.js:22-31, 84-mint universe 2026-07-16): topHoldersPercentage 100%, devMints 100%, bundlerStats 67%, devMigrations 57%, devBalancePercentage 30%, insiderPct 12%, sniperPct 7%. The CRI also feeds a Safety multiplier inside intel-score (§13.1) but `pool.cri` is set AFTER intel scoring in the funnel, so it only affects the deploy-time `signal_snapshot`, not admission.

#### 8.3 Post-recon filters (1776-1814) — `passing`
- `allowedLaunchpads` non-empty and `ti.launchpad` not in it → drop (`[SCREENING] Skipping <name> — launchpad X not in allow-list`).
- `blockedLaunchpads.includes(ti.launchpad)` → drop (third launchpad check in the chain).
- `ti.audit.bot_holders_pct > maxBotHoldersPct` → drop (`[SCREENING] Bot-holder filter: dropped <name> — bots X% > Y%`). `maxBotHoldersPct` 30.
- `[RUG_FILTER] reject|would-reject <name>: check=value>limit` — drops only in `enforce`.
- `[CRI_SHADOW] reject|would-reject <name>: CRI x > t` — drops only in `enforce`.
GMGN-sourced pools skip this block (`if (pool.gmgn) return true`).

#### 8.4 Gas break-even filter (1816-1840)
`feeTvl = pool.fee_tvl_24h ?? pool.fee_per_tvl_24h ?? 0`; `isWide = (pool._binCount ?? 0) > 69`; `gasCost = estimateCycleGasCost(isWide)` (tools/dlmm.js:399-411: `(deployTxs(1|3)+3 close+1 swap) × (5000 + cached normal priority fee) / 1e9`); `breakEven = gasBreakEvenMinutes(gasCost, feeTvl, deployAmount)` (419-425: `gasCost / ((feeTvl/100)×deploySol/1440)`, `Infinity` when feeTvl ≤ 0); drop when `Number.isFinite(breakEven) && breakEven > maxGasBreakEvenMinutes` (30). **Neither `fee_tvl_24h`, `fee_per_tvl_24h` nor `_binCount` is produced by `condensePool` (only `fee_active_tvl_ratio_24h` on steady extras) — grep confirms those names exist only on position objects (index.js:875,1391,3896).** So on the Meteora path `feeTvl=0 → Infinity → passes`: the filter appears inert (verify with `grep "Gas filter:"` on VM logs). Scouts are explicitly exempt.

#### 8.5 Empty / lone candidate handling
- 0 passing (1843-1868): report "No candidates available." + `buildFunnelReport` (3910-3950: `discovery:` + `funnel:` lines + top-8 reject families) or filtered examples; `appendDecision({type:"no_deploy", summary:"No candidates available"})`; `funnelRan=true` feeds the starvation counter.
- 1 passing (1870-1901): `getLoneCandidateSkipReason` (3952-3988): hard → `is_wash` (GMGN only), `global_fees_sol < minTokenFeesSol` (30), `top10 > maxTop10Pct` (60), `bots > maxBotHoldersPct` (30, already filtered — redundant); conviction → `is_rugpull`/`is_pvp` need `degenScore >= loneCandidateMinDegen` (50); else needs `narrative OR degen >= 50`. Skip → "⛔ NO DEPLOY … Only one candidate survived filtering, but it was not worth deploying: <reason>" and `appendDecision("Single candidate skipped")` — the LLM is NOT called. Same function guards `/deploy` of a cached solo candidate (`deployLatestCandidate` 5300-5352).

`degenScore` (tools/screening.js:292-323): inputs normalised to a 30m reference (`tfScale = 30/tfMinutes`); `sTrading = clamp(volume_active_tvl_ratio×scale / targetVolRatio)`, `sLp = clamp((unique_lps+positions_created)×scale / targetLpCount)`, `sFees = clamp(fee_active_tvl_ratio×scale / targetFeeRatio)`, `sLiq = clamp(log10(active_tvl)/log10(targetLiquidity))`; score = `(sTrading×sLp×sFees×sLiq)^0.25 × 100` (any zero → 0). Targets `opportunity.targetVolRatio` 20, `targetLpCount` 40, `targetFeeRatio` 0.20, `targetLiquidity` 20000.

#### 8.6 Pre-LLM enrichment
- `getActiveBin` for every passing pool in parallel (1903-1905) → `active_bin:` line.
- LPAgent study (1909-1914): `getCachedLpStudy(pool)` for the first `lpStudyMaxPools` (4), 250 ms spacing, 30-min cache (lper-signal.js:14-33); `studyTopLPers` (tools/study.js:7-11) → `GET ${config.api.url}/top-lp/<pool>` + `GET …/study-top-lp/<pool>` with `x-api-key`; `config.api.url` default `https://api.agentmeridian.xyz/api`; 429 → thrown → cached null (`[SCREENING] LPAgent study skipped for …`).

#### 8.7 Candidate block (Meteora branch, index.js:~2005-2035; GMGN branch 1971-2003)
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

#### 8.8 Deploy-time signal snapshot (`stageSignals`, 2038-2105; gated `config.darwin.enabled` true)
Captures per pool: base_mint, organic_score, fee_tvl_ratio, volume, mcap, holder_count, bot_holders_pct, top10_pct, price_change_1h, net_buyers_1h, smart_wallets_present, narrative_quality present/absent, volatility, token_age_hours, all `rug_*` fields + `rug_checks_tripped`, `cri_score/risk_level/concentration`, `smart_flow_ratio`, `intel_safety/yield/momentum/trust/total`, `intel_safety_enriched`, `intel_total_enriched`, `lper_suggested_style`, `lper_consensus_style`. Feeds `signal_snapshot` on the perf record (lessons.js `buildSignalSnapshot` 71) — the data the evolution engine's `minIntelScore` floor and the rug/CRI backtests read.

#### 8.9 LLM-call suppressors
- Identical-set fingerprint (2120-2130): `candidateFp = sorted pool addresses`; if equal to `_lastDeclinedCandidates.fp` and age `< opportunity.retriggerCooldownMin` (30) → skip LLM (`[CRON] Screening: identical candidate set declined Nm ago — skipping LLM re-ask (Mm cooldown left)`). `candidatesReachedLLM` stays true (never feeds starvation). Cleared on a successful deploy (2257); set on any decline including no-tool fallbacks (2260). In-memory.
- Per-pool verdict cache (2133-2159, 2264-2272; `_verdictCache` 511): entries `{at, mcap, holders, fee_tvl, name}` written only on a genuine judgment decline (`!noToolFallback && !deployAttempted`); prune by `verdictCacheTtlMin`; a pool "needs judgment" if `mcapDrift > 0.20 || holderDrift > 0.30 || feeNow/cached.fee_tvl >= 1.6` (renewed-flow invalidation); all cached → skip (`[CRON] [VERDICT_CACHE] all N candidate(s) carry a fresh NO-DEPLOY verdict (<Tm, mcap ±20% / holders ±30% unmoved) — skipping LLM re-ask`); partial → `[VERDICT_CACHE] k/N candidate(s) cached NO-DEPLOY, m changed/new — running LLM on the full set`; cleared on deploy. **The drift check reads `pool.base?.market_cap` and `pool.base_token_holders`, but the condensed candidate exposes `mcap` / `holders` (and `base` = {symbol, mint, organic, warnings}, tools/screening.js:2014-2019, 2048-2049). With `mcapNow=0` the code sets `mcapDrift=1` ("missing data → drifted") for every pool, so the cache appears never to skip a call — verify by grepping `[VERDICT_CACHE] all` on the VM.** Config `verdictCacheEnabled` true, `verdictCacheTtlMin` 30.

#### 8.10 After the LLM (2256-2400)
`deploySucceeded` ⇔ tool success without `error`/`blocked`. Bear-debate summary line `🐻 Bear debate [log_only|enforce]: <verdict> …` + `appendDecision(type:"bear_debate")` when `deployVerdict` present (2287-2318; prod `bearDebateEnabled=false` → absent). `⛔ NO DEPLOY` regex → decision "LLM chose no deploy" with per-candidate intel scores. Funnel doc `setLastScreeningFunnel` + `publishReportTracked` (2360-2392). `finally`: `maybeRelaxOnStarvation({reachedLLM})` when `candidatesReachedLLM || funnelRan`.

---

### 9. Starvation counter + relaxer

`maybeRelaxOnStarvation` (index.js:2438-2488): state_meta singleton `_screeningStarvation {emptyCycles, lastRelaxedAt}` (state.js:229, 3324). `reachedLLM` → reset to 0. Else `emptyCycles++` (`[CRON] Screening produced no candidates (N consecutive empty cycles)` / `⚠️ N consecutive empty screening cycles` once ≥ threshold). When `emptyCycles >= starvationRelaxAfterEmptyCycles` AND `now − lastRelaxedAt >= starvationRelaxCooldownHours` → `applyStarvationRelaxation({trigger})` (lessons.js:856-881) → `computeStarvationStep` (826-838): among `minFeeActiveTvlRatio / minOrganic / minIntelScore`, pick the one furthest above `EVOLVE_BASELINES` {0.05, 60, 52} (ratio > 1.01), `nudge` toward baseline by ≤20% (`MAX_CHANGE_PER_STEP`), clamp to `EVOLVE_BOUNDS` {fee 0.05–0.60, organic 55–85, intel 52–70}, round (fee 2dp, others int); only lowers. Persists through `persistEvolution` (776-816: atomic `user-config.json` write, live `config.screening[k]=v`, evolution history row, lesson row). `lastRelaxedAt` advances even when nothing moved. Logs `[EVOLVE] Starvation relaxer stepped floors: k→v` / `… all floors already at baseline — nothing to relax`; Telegram "🔧 Starvation relaxer". Config: `starvationRelaxEnabled` true, `starvationRelaxAfterEmptyCycles` 12, `starvationRelaxCooldownHours` 3.

Note: in prod rank mode, `minFeeActiveTvlRatio`/`minOrganic` are not admission inputs (only the executor reads `minFeeActiveTvlRatio`), and the relaxer touches `minIntelScore` (gate-mode key) rather than `rankMinIntelScore`. Since verdict-cache and fingerprint skips keep `candidatesReachedLLM=true`, the counter only accrues on genuinely empty funnels.

---

### 10. Executor mirrors (deploy_position safety block)

`validateDeployPoolThresholds` (tools/executor.js:131-307), fresh detail GET at `config.screening.timeframe` (`fetchFreshPoolDetail` 121): TVL present → `tvl < minTvl` branch (§6/§7: Top-Performer log, clean-history `[EXECUTOR] [TVL_EXEMPT] deploy allowed below minTvl …`, scout, else block) → `tvl > maxTvl` block (189-194; the only maxTvl enforcement in rank mode) → `fee_active_tvl_ratio < minFeeActiveTvlRatio` block unless steady-lane 24h waiver (198-230) → vol/TVL and tx/min blocks unless steady waiver (234-254) → volatility re-fetched at `max(tf, 30m)` must be finite >0 (256-275) → bin-step band (277-291) → returns `entryMarketData {entry_mcap, entry_tvl, entry_volume, entry_holders, entry_price_change_pct}` + `baseMint` + `scoutTier`.

`runSafetyChecks("deploy_position")` (1718-1998): strip `scout/probe/lane/lane_min_bins` → bin_step band on `args.bin_step` → `amount_x > 0` refused ("only supports single-side SOL") → steady/top-performer hints (§5/§6) → `bins_below` clamped to `MAX_SAFE_BINS_BELOW=69` (1771-1774) → range floor: total bins ≥ `minBinsBelow` (lane min or `strategy.minBinsBelow`, never below 35) (1796-1812) → single-sided needs `bins_below ≥ min` and **`bins_above === 0`** (1814-1829, "Single-side SOL deploy must use bins_above=0.") → fresh `getMyPositions({force:true})`: `total_positions >= maxPositions` (1832-1838; NOTE: counts ALL positions incl. held — matches prod `maxPositionsExcludeHold=false`), duplicate pool (1840-1847), duplicate `base_mint` only if the LLM passed `base_mint` (1850-1859) → re-entry cooldown (1861-1900, §11) → scout clamp (1902-1927) → probe (1929-1965) → `amount_y > 0`, `>= minDeploy` (0.05 for scout/probe else `max(0.1, deployAmountSol)`), `<= maxDeployAmount` (1967-1984) → live SOL ≥ `amount + gasReserve` unless DRY_RUN (1987-1996).

---

### 11. Every cooldown / block that can stop a pool

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

### 12. LLM prompt contract (SCREENER)

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

### 13. Signal engines (formulas)

#### 13.1 Intel score (intel-score.js) — `computeIntelScore` 577-617
`total = 0.30·Safety + 0.35·Yield + 0.20·Momentum + 0.15·Trust` (weights `intelWeights`, normalised, 75-91); grade A≥80 B≥65 C≥50 D≥35 (26-31).
- Safety (121-200): mint_disabled 25|0|12.5 unknown; freeze_disabled 15|0|7.5; top10 `lerp(60→20 ⇒ 0→20)` else 10; bundler `lerp(50→0 ⇒ 0→15)` else 7.5; bot `lerp(50→0 ⇒ 0→10)` else 5; dev-hold `lerp(5→1 ⇒ 0→15)` else 7.5; × `(1 − CRI/100·0.5)` when `c.cri` present. Inputs `audit.mint_disabled/freeze_disabled`, `gmgn_top10_holder_pct ?? audit.top_holders_pct`, `gmgn_bundler_pct`, `gmgn_bot_degen_pct ?? audit.bot_holders_pct`, `gmgn_dev_team_hold_pct` — none exist on the Meteora condensed payload → **Safety pinned at 50** unless `safetyEnrichMode="enforce"`.
- Yield (249-327): legacy fee term `clamp(fee_active_tvl_ratio/2.0)·40` (window-agnostic → at 1h a 2.5%/day pool scores ~2/40, comment 216-227); log mode `logScale(max(fee×1440/tf, fee_24h), 1%/day, 48%/day)·40`; volume/TVL legacy `clamp((volume_window/tvl)/5)·25`, log `logScale(turnover×1440/tf, 0.2, 120)·25`; active_tvl/tvl `clamp(x/0.5)·15`; fee_trend `clamp((fee_change_pct+50)/100)·20`; dynamic-fee bonus ≤5. Backtest (CLAUDE.md, `scripts/yield_window_backtest.js`, 300 records): log is a pure monotone re-scaling (Spearman 1.00), gate moves 52→61.
- Momentum (361-434): price_trend bell curve (−50→0, 0→12, +20→25, +100→15, >100 decays to 5); traders/velocity `(clamp(unique_traders/150)·0.5 + clamp(tx_per_min/15)·0.5)·25`; buy/sell from `stats_1h` (not on candidate → 12.5); `indicator_confirmation` (set only by the indicator stage AFTER scoring in gate mode → 12.5).
- Trust (470-548): organic `organic/100·25`; smart-wallet presence `clamp(gmgn_smart_wallets/3)·20` ±35% flow (absent → 10); KOL `clamp(gmgn_kol_wallets/2)·10 + 5` (absent → 7.5); maturity `ageMaturScore(h)·10/15` (0h→0, 2h→2, 12h→5.3, 48h+→10; absent 5); dev reputation `devScore/100·20` (neutral 50 → 10); narrative fixed 5. Max attainable ≈95.
- All-unknown score = 50 in every dimension.
- Gate config: `minIntelScore` 45 code (prod 61; `EVOLVE_BASELINES` pins 52 and `EVOLVE_BOUNDS` 52–70), `rankMinIntelScore` 52 (prod 61), `intelWeights` 0.30/0.35/0.20/0.15.
- Format: `[INTEL: 72/100 B | Safety:85 Yield:68 Momentum:55 Trust:78]` (629-633), used in `Intel score too low:` log.

#### 13.2 Safety enrichment (tools/screening.js:109-212)
Per mint (30-min cache): `getTokenAudit(mint)` (tools/token.js:118-147, keyless Jupiter `assets/search`; `bundlerStats.holdingPct` already 0–100) ∥ `getGmgnSafetyInfo(mint)` (tools/gmgn.js:837-855, keyed `GET https://openapi.gmgn.ai/v1/token/info?chain=sol&address=<mint>` via 5-min shared cache 798-813: `stat.top_10_holder_rate/top_bundler_trader_percentage/bot_degen_rate/dev_team_hold_rate` → %); `mapSafetyInputs` prefers GMGN for rates, Jupiter for mint/freeze (121-137); `applySafetyInputs` writes the exact scoreSafety field names (143-155). Modes: `log_only` computes on a clone and attaches `_intelSafetyBase/Enriched`, `_intelTotalBase/Enriched`, `_safetyEnrichInputs`; `enforce` mutates. Log `[SCREENING] [SAFETY_ENRICH] <label>: safety A→B intel C→D (mode)`. Config `safetyEnrichMode` "off" (prod uncertain), `safetyEnrichMaxPerCycle` 6. Evidence (config.js:350-360, `scripts/safety_rebaseline.js`, 147 records): renouncement near-universal → +6..+11 constant shift, zero outcome signal; enforce must pair with intel bar 52→58–62 (≈69 under log-yield per CLAUDE.md).

#### 13.3 Organic momentum (organic-momentum.js) — `computeOrganicMomentum` 66-107
Inputs `unique_traders_change_pct` (T), `volume_change_pct` (V), `base_token_holders_change_pct` (H), `swap_count_change_pct`, `net_deposits_change_pct`, `unique_traders` (N). `unknown` if T and V both null. `thin = N < minUniqueTraders`; `decaying = T <= decayTraderPct || V <= decayVolumePct`; `growing = T >= growTraderPct && V >= 0`; class decaying > growing > steady; score = bucket(T,−22,+38) + bucket(V,−42,+50) + bucket(H,−10,+20) ∈ [−3,3]. Config `organicMomentumEnabled` true, `DecayTraderPct` −22 (p25), `DecayVolumePct` −42 (p25), `GrowTraderPct` 38 (p75), `MinUniqueTraders` 30, `HardFilter` false. Deploy-capture cache `getOrganicMomentumForPool` (129-132). Validation `analyzeOrganicMomentumOutcomes` (165-206) also drives evolution P2 (lessons.js:722-739: on "signal works" widen decay-trader cutoff toward −15 and enable the hard filter at ≥12 records). Grounding: MELT arXiv 2602.13480 (comment 21-24).

#### 13.4 Fee efficiency (fee-efficiency.js) — `computeFeeEfficiency` 66-77, `rankByFeeEfficiency` 90-122
`ratio = fee_active_tvl_ratio / volatility`; rank + percentile (best 100) within the set; deploy-capture cache `getFeeEfficiencyForPool` (46-49); validation `analyzeFeeEfficiencyOutcomes` (162-199, tiers ≥67/≥33, Pearson ±0.3 verdict). No config.

#### 13.5 Pool simulator `sim:` line (pool-simulator.js)
`representativeDownsidePct` (275-285): `bins = clamp(round(lo + vol/5·(hi−lo)))`, `down% = (1 − (1+bin_step/1e4)^−bins)·100`. `simulatePool` (81-215): `dilution = active_tvl/(active_tvl+deposit)`; `apr_in_range = fee_active_tvl_ratio × (525600/windowMin) × dilution`; `horizonVol = scaleVolToHorizon(vol, window, 1440)`; `irf = inRangeProbability(down, up, horizonVol)` (range-survival.js); `apr_effective = apr_in_range × irf`; IL from `simulatePnlCurve` (pnl-curve.js) at `−min(horizonVol, down)` vs quote-hold, else classic `2√k/(1+k)−1`; `risk_adjusted = apr_effective / (vol·√annualFactor)`; `volPremiumCheck` (241-266): `vol_premium_apr = |il| × 525600/horizon`, `edge = apr_effective / vol_premium`, verdict ≥1.5 fees_cover_premium / ≥0.8 marginal / else premium_exceeds_fees. Deposit for the line = `deployAmount × sol_price` (index.js:1932-1936). Also exposed as the `simulate_pool` tool (tools/executor.js:357).

#### 13.6 Episodic memory `similar_past:` (lessons.js:1259-1434)
Features/weights: entry_mcap (log, 1.0), entry_tvl (log, 1.0), volatility (1.0), fee_tvl_ratio (1.0), organic_score (0.8), token_age_hours (log, 0.6); scales 16/12/5/0.5/100/6; distance = √(Σw·((c−p)/scale)²/Σw) over dims present on both sides (≥2 dims); recency penalty `ln(1+ageDays)·0.015`; needs ≥2 scored records; K=3; outcome via `classifyOutcome`. Candidate features taken from `mcap`, `active_tvl ?? tvl`, `volatility`, `fee_active_tvl_ratio`, `organic_score`, `token_age_hours`.

#### 13.7 LPAgent winning-LPer signal (lper-signal.js, tools/study.js) — §8.6/§8.7. Config `lpStudyEnabled` true, `lpStudyMaxPools` 4, `lpStudyMinWinnersForStyle` 3, `lpStyleSteerEnabled` false.

#### 13.8 Deploy timing (deploy-timing.js)
`analyzeDeployTiming` (63-129): last `window` (120) perf records, deploy time = `recorded_at − minutes_held`, 4h UTC buckets, `classifyOutcome`, Wilson lower bound, `lowConfidence = decisive < minBucketN`. Advisory line only when `totalDecisive >= 40` (137-149; verdict ±0.07 vs baseline). Gate: §1.10. Briefing/`/timing` formatters 152-207.

#### 13.9 Dev score (dev-scoring.js:73-149)
launch_history 25 / ath_record 30 / alignment 20 / cto 10 / freshness 15 from GMGN `dev` object; string or missing dev → neutral 50 (165-199). `minDevScore` 50 (gate mode only) → passes at neutral. Feeds intel Trust and the dump-play guard (`< 70`).

#### 13.10 PVP (pvp.js) — `detectPvpRival` 49-81
`GET https://datapi.jup.ag/v1/assets/search?query=<SYMBOL>` → other mints with the exact symbol, top 2 by liquidity, need `holderCount >= 500` and `fees >= 30` SOL; rival pool via `GET https://dlmm.datapi.meteora.ag/pools?query=<mint>&sort_by=tvl:desc&filter_by=tvl>5000`. Only the top-2 intel candidates are checked (`PVP_SHORTLIST_LIMIT`, 36, 605-630). Log `[SCREENING] PVP guard: <name> has active rival …`. Config `avoidPvpSymbols` true, `blockPvpSymbols` false.

#### 13.11 Chart indicators (tools/chart-indicators.js:214-270) — gate mode only, `config.indicators.enabled` false → inert. `GET ${config.api.url}/chart-indicators/<mint>?interval=&candles=&rsiLength=`.

---

### 14. Learning loop touching screening (lessons.js)

- `classifyOutcome` (939-960): failure if stop-loss reason, `pnl <= −5`, fee-death with feeYield <1, OOR-collapse with pnl<0, or `range_efficiency<30 && pnl<0`; success if not fee-death and (`pnl >= 2` or feeYield ≥2); else neutral.
- `evolveThresholds` (658-753): every 5th close via `recordPerformance` (skipped when `evolutionEnabled=false`: `[EVOLVE] skipped — evolutionEnabled=false …`, 229-230; **prod false** since 2026-09-24). Window last 40; auto-revert if success-rate fell ≥0.08 after the last adjust; floors `minFeeActiveTvlRatio` (perf `fee_tvl_ratio`), `minOrganic` (`organic_score`), `minIntelScore` (`signal_snapshot.intel_total`) raised only when successes > failures with Cohen's d ≥0.35 and ≥3 per group, target `max(p50 failures, 0.95·p25 successes)`, ≤20% step, bounds; P2 organic-momentum; P4 throughput relaxer (<1.5 closes/day) → `computeStarvationStep`. Persist via `persistEvolution`.
- Note the evolved keys are the GATE-mode keys; prod rank mode reads `rankMinIntelScore`, not `minIntelScore`.
- `getLessonsForPrompt` (1161-1227) and `ROLE_TAGS` (1144).

---

### 15. External API index (strings from code)

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

### 16. Log tag index (screening domain)

`[SCREENING] discovery: …` (794), `[SCREENING] funnel: …` (1544), `[SCREENING] funnel[rank]: …` (1861), `[TVL_EXEMPT]` (409, 1749; executor 167), `[SCOUT_SHADOW]` (1767), `[SCOUT]` (1774; executor 180, 1921), `[TOP_PERFORMERS]` (1114), `[TOP_PERFORMER_ADMIT]`/`[TOP_PERFORMER_COOLING]` (1716/1719), `[TOP_PERFORMER]` (1737; executor 162, 1769), `[STEADY_ENVELOPE_SHADOW]`/`[STEADY_ENVELOPE]` (1045/1072), `[LANE]` (1807; executor 218, 253, 1761), `[YIELD_WINDOW_SHADOW]` (1854), `[RANK_SHADOW]` (1922), `[SAFETY_ENRICH]` (203/206), `PVP guard:` (628), `Intel score too low:` (1436), `Filtered candidate … dump play guard` (1400/1406), `TVL drain detected:` (1308), `Exit signals for` (1316), `Filtered cooldown pool|token` (1338/1343), `Indicator rejected` (1505), `Organic-momentum hard filter removed` (1532), `PVP hard filter removed` (1453), `[BLACKLIST]`/`[DEV_BLOCKLIST]` categories (772-782, 1262-1267, 1463-1470), `[CRON] [Opportunity]` (index 3363), `[CRON] Screening skipped — …` (1573-1660), `[CRON] Deploy-timing gate …` (1706-1713), `[SCREENING] Bot-holder filter:` (1792), `[SCREENING] [RUG_FILTER]` (1799), `[SCREENING] [CRI_SHADOW]` (1807), `Gas filter:` (1824/1832), `[CRON] Screening: identical candidate set declined` (2126), `[CRON] [VERDICT_CACHE]` (2153/2157), `[CRON] Screening produced no candidates (N …)` / `⚠️ N consecutive empty screening cycles` (2450-2452), `[EVOLVE] Starvation relaxer …` (2472-2475), `[POOL-MEMORY] Cooldown set for …` / `Base mint cooldown set …` / `[REPEAT_COOLDOWN_SHADOW]` / `Extended cooldown …` (pool-memory 201-274), `[EXECUTOR] [REENTRY]`/`[REENTRY_SHADOW]` (1889/1895), `[EXECUTOR] [PROBE]` (1952), `[LPAGENT]`-style `LPAgent study skipped for` (lper-signal 29).

---

### 17. Correlations, contradictions, dead/inert under prod config

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

---

<!-- ===== 02-deploy-execution.md ===== -->

## Meridian — Domain: Deploy Execution, Sizing, Safety Checks, On-Chain Tx Mechanics

Read-only inventory of `/Users/Angga/Repos/meridian` at commit `a0fcd12` (branch `experimental`, 2026-09-25).
Line numbers are from the checked-out files; "prod" values come from CLAUDE.md unless stated. The local
`user-config.json` is a **dev copy** (its `_lastAgentTune` = 2026-09-24T22:29Z) and is quoted only where it is
the sole evidence — treat those as *not confirmed for the VM*.

Conventions: `cfg.X` = `config.<section>.X` from `config.js`. "Code default" = the `??` fallback in `config.js`.
"⚠" marks a discrepancy or an uncertainty I could not resolve from the checkout.

---

### 0. External dependency map

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

### 1. Tool surface, roles and the dispatch seam

- **Role tool sets** — `agent.js:10-11`: `MANAGER_TOOLS` = {close_position, claim_fees, swap_token, get_position_pnl, simulate_pnl_curve, predict_range_survival, get_my_positions, get_wallet_positions, get_wallet_balance, set_position_note}; `SCREENER_TOOLS` = {deploy_position, get_active_bin, get_top_candidates, check_smart_wallets_on_pool, get_token_holders, get_token_narrative, get_token_info, search_pools, get_pool_memory, simulate_pool, get_wallet_balance, get_my_positions}. GENERAL = everything. Filter at agent.js:74-75. ⚠ `rebalance_position` is in neither role set → only GENERAL/operator/mechanical paths can call it (the autonomous engine calls `executeTool("rebalance_position")` from index.js:817, not via the LLM).
- **WRITE_TOOLS** (executor.js:1197-1203) = {deploy_position, claim_fees, close_position, rebalance_position, swap_token}; **PROTECTED_TOOLS** = WRITE_TOOLS ∪ {self_update} (1204-1207). Only PROTECTED_TOOLS run `runSafetyChecks` (executor.js:1454-1463).
- **executeTool flow** (executor.js:1417-1716), in order: (1) strip model artifacts from the tool name (1421); (2) unknown-tool error (1424-1429); (3) **HOLD guard**: `close_position` / `rebalance_position` without `operatorOverride` on a `hold_mode===true` tracked position → `{blocked:true}` (1435-1451, log tag `safety_block`); (4) `runSafetyChecks` for PROTECTED tools, args carry `_operator_override:true` when operator (1454-1463; log `safety_block` on fail); (5) execute `fn(args)` (1467); (6) `logAction` audit (1471-1477); (7) post-hooks on success (§8.4); (8) socket subscription resync after deploy/close/rebalance (1682-1690); errors are returned to the LLM as `{error, tool}` (1710-1713).
- **Bear-debate seam** (agent.js:502-580) — runs once per SCREENER session for `deploy_position` **before** `executeTool`: `extractDeployConfidence(lastAssistantText)` (llm-verdicts.js:33-58: last `confidence: NN` match, first `thesis:` line ≤240 chars) → if `cfg.screening.bearDebateEnabled` (code default **true** config.js:300; **prod false** since 2026-07-27) `runBearDebate` (llm-verdicts.js:150-176; temperature 0.2, max_tokens 2048; a `claude-cli/` bearDebateModel is redirected to `claudeCliFallbackModel`, agent.js:514). Verdict handling: `veto` + `bearDebateAction==="enforce"` → tool result `{blocked:true}` and `firedOnce.add("deploy_position")` (agent.js:543-557); `size_down` + enforce → **halves `amount_y`/`amount_sol` in place** (agent.js:559-570); everything else logs only (`Bear debate [log_only]…`, `Bear VETO (log_only) — would block`, `Bear size_down (log_only)`). Fail-open on any exception (agent.js:576-579). After a successful deploy, `attachDeployVerdicts(result.position, {deploy_confidence, deploy_thesis, bear_debate:{verdict,confidence,reason,action,enforced,parsed,error}})` persists onto the tracked row (agent.js:591-618 → state.js:1403-1445, adds `fail_open` = `parsed===false || error`). Evidence (CLAUDE.md): 78/78 vetoes at avg conf 91.3; all 17 historical "proceed" rows are `reason:null` fail-open defaults.
- **deploy_position is locked after the first attempt regardless of outcome** (`NO_RETRY_TOOLS`, agent.js:620-623) — a SAFETY_BLOCK'd deploy cannot be retried in the same LLM session.
- Tool schemas the LLM sees: `deploy_position` definitions.js:129-215 (params: pool_address*, amount_y, amount_x, amount_sol, strategy∈{bid_ask,spot,dynamic}, shape∈{spot,curve,bidask}, bins_below, bins_above, downside_pct, upside_pct, pool_name, base_mint, bin_step, base_fee, volatility, fee_tvl_ratio, organic_score, initial_value_usd, lazy, tier∈{full,probe}); `claim_fees` 322-340; `close_position` 344-375 (position_address*, skip_swap, reason); `rebalance_position` 378-415 (target_strategy∈{spot,curve,bid_ask} default curve, bins_below 35, bins_above 34, reason); `swap_token` 464-495 (input_mint*, output_mint*, amount* — **no slippage param exposed to the LLM**). ⚠ The `deploy_position` description says "never pass 'curve' in strategy" but the executor/dlmm `strategyMap` accepts `curve` (dlmm.js:1234-1239) — prompt guidance only.

---

### 2. Deploy path — pre-executor (screener, index.js)

Execution order inside `runScreeningCycle`:

1. **Size** — `deployAmount = computeDeployAmount(preBalance.sol)` (index.js:1700). See §4.
2. **Deploy-timing gate** (index.js:1704-1716; `getDeployTimingGate` deploy-timing.js:176-182 → `decideTimingGate` 165-175): only if `cfg.timing.gateEnabled` (default **false**, config.js:796) and the current UTC bucket has `n ≥ minBucketN` (8) and `successRate < deadHourSuccessFloor` (0.20). `action:"skip"` → cycle aborted with a `no_deploy` decision; `"size_down"` (default) → `deployAmount *= sizeDownPct` (0.5), rounded to 3 dp. Manual `/deploy` unaffected. Log tag `cron`.
3. Candidate recon, launchpad/bot-holder/rug/CRI filters (index.js:1760-1815) — screening domain, listed only for ordering.
4. **Gas break-even filter** (index.js:1817-1839): for each passing candidate (scout candidates exempt, 1822-1825): `gasCost = estimateCycleGasCost(pool._binCount > 69)`; `breakEven = gasBreakEvenMinutes(gasCost, pool.fee_tvl_24h ?? pool.fee_per_tvl_24h ?? 0, deployAmount)`; drop if `breakEven > cfg.screening.maxGasBreakEvenMinutes` (**30**, config.js:279). Formulas (dlmm.js:399-424): `perTx = 5000 + cachedPriorityFeeValue("normal")` lamports; `totalTxs = (wide?3:1) + 3 + 1`; `gasSol = totalTxs·perTx/1e9`; `yieldPerMin = (feeTvl24h/100)·deploySol/1440`; `breakEven = gasSol/yieldPerMin` (∞ if feeTvl ≤ 0). Log `screening` "Gas filter: …". ⚠ Under prod `playstyle` the max width is 69 bins so `isWide` is always false here; `cachedPriorityFeeValue` is 0 until a priority fee has been fetched this process (cold start → gas ≈ 5 tx × 5000 lamports = 0.000025 SOL).
5. **Bins formula** the screener is told to use (prompt.js:171, index.js:2180) and the mechanical/manual path actually uses (`computeBinsBelow` index.js:3990-3998): `bins_below = clamp(round(minBinsBelow + (vol/5)·(maxBinsBelow−minBinsBelow)), minBinsBelow, maxBinsBelow)`; throws on non-finite/≤0 volatility.
6. LLM decides → `deploy_position` tool call → §1 seam → §3.

Manual `/deploy` (index.js:5331-5340) calls `executeTool("deploy_position", {pool_address, amount_y: computeDeployAmount(wallet.sol), strategy: cfg.strategy.strategy, bins_below: computeBinsBelow(vol), bins_above: 0, …})` — same safety block, no bear debate.

---

### 3. Deploy path — `runSafetyChecks("deploy_position")` in execution order

Source: executor.js:1720-1999. Every branch returns `{pass:false, reason}` → `executeTool` logs `safety_block` and returns `{blocked:true, reason}` to the caller. Stateful side effects on `args` are noted because `deployPosition` consumes the mutated args.

#### 3.1 `validateDeployPoolThresholds(args)` (executor.js:131-308) — one fresh discovery-API read

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

#### 3.2 The safety block proper (executor.js:1720-1999), after V0–V9 pass

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

#### 3.3 `deployPosition()` (dlmm.js:1050-1793) — second gate layer + execution

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

### 4. Position sizing — every input in order

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

### 5. Bins / shape / strategy resolution (who wins)

Precedence for `bins_below` at deploy time: explicit LLM `bins_below` → (if omitted) steady-lane hint `bins_below` → top-performer hint (69) → `cfg.strategy.defaultBinsBelow` → `minBinsBelow` (executor S4/S5/S8, dlmm D8). `downside_pct`/`upside_pct` short-circuit everything (D8a) and also bypass the executor's integer/floor checks S8–S10 (they are gated on `downside_pct == null`), ⚠ leaving only dlmm's D13 total-bins floor as protection.

Playstyle → range (config.js:53-79): `PLAYSTYLE_PRESETS = {tight:{35,45}, balanced:{35,69}, wide:{60,69}, single_account:{45,69}}`; explicit `minBinsBelow`/`maxBinsBelow`/`binsBelow`/`defaultBinsBelow` in user-config win; everything is clamped to `[MIN_SAFE_BINS_BELOW=35, MAX_SAFE_BINS_BELOW=69]` at load (config.js:73-79) and again on `update_config` (executor.js:1017-1024, 1122-1134). ⚠ CLAUDE.md states `wide {60,110}` and "`maxBinsBelow` 120 → 90 in prod (Phase 3)": with `MAX_SAFE_BINS_BELOW = 69` in the current code any such value is **clamped to 69 on load**, so the documented prod width of 90 cannot be in effect unless the VM runs older code. The `isWideRange > 69` deploy path (D22) is likewise unreachable.

Steady-lane floor relaxation: executor computes `minBinsBelow = max(35, laneHint.min)` and passes `lane_min_bins` so dlmm D13 uses the same floor (prod lane preset `single_account` → 45).

Strategy vs shape: `strategy` (LLM or `cfg.strategy.strategy`, code default `bid_ask`) picks the StrategyType; a non-null `shape` (spot|curve|bidask) **overrides** it and is what gets recorded as `strategy` on the position/perf record (D15). `cfg.strategy.defaultShape` ("spot") is only consulted by hint fill-ins at screening; inside `deployPosition` the `?? defaultShape` is unreachable. Top-performer/steady-lane hints fill `shape` when omitted (S4/S5). `rebalance_position` resolves `target_strategy` separately: `curve` default, `spot`/`spot_balanced` → Spot, `bid_ask` → BidAsk (dlmm.js:4353-4358).

---

### 6. Transaction pricing, send and confirm

- **Connection**: primary `RPC_URL` (`getConnection` dlmm.js:108-117) with `RPC_CONNECTION_OPTIONS = {commitment:"confirmed", disableRequestBatching:true, disableRetryOnRateLimit:true}` (rpc.js:24-28). Close sends use `closeConnection = cfg.management.closeSendsViaPrimaryRpc !== false ? getConnection() : poolConnectionCache[pool].connection` (dlmm.js:3473-3478; default **true**, ships ON). Deploy/claim/compound/rebalance always send via `getConnection()`.
- **Urgency**: `urgencyForLabel(label)` (dlmm.js:299-305): labels starting `close:` or `flip:` → `"exit"`, everything else (`deploy:*`, `claim:*`, `rebalance:*`) → `"normal"`. ⚠ `rebalance:removeLiquidity`/`rebalance:closeEmpty` are liquidity removals priced at the *normal* tier.
- **`getDynamicPriorityFee(urgency, lockedWritableAccounts)`** (dlmm.js:203-250): exit tier requires `cfg.tx.exitPriorityFeeEnabled` (else falls to normal); normal requires `cfg.tx.enablePriorityFees` (default true) else 0. Cache key `${urgency}:${firstWritableAccount|global}`, TTL 30 s, ≤16 entries. `conn.getRecentPrioritizationFees({lockedWritableAccounts})` → `computePriorityFee(fees, opts)` (189-201): positive fees sorted, `idx = min(n−1, floor(n·p))`, `min(round(base·multiplier), cap)`. Tiers: **normal** p50 × `priorityFeeMultiplier` (1.2) cap `maxPriorityFeeMicroLamports` (1 000 000); **exit** p75 × `exitPriorityFeeMultiplier` (1.5) cap `maxExitPriorityFeeMicroLamports` (3 000 000 µL/CU ≈ 0.0042 SOL worst case at the SDK's 1.4M CU ceiling — comment dlmm.js:126-141). On fetch error returns stale cache or 0 (log `tx_priority`). Evidence: the `lockedWritableAccounts` arg was missing 2026-06-22 → 2026-08-19 so the bot paid base fee only (comment 210-214; memory note 28598b8).
- **`prependPriorityFee(tx, urgency, override)`** (255-278): legacy `Transaction` only (VersionedTransaction skipped — i.e. Jupiter swaps are never re-priced); finds an existing `SetComputeUnitPrice` ix by discriminator 3 and **replaces** it, else `unshift`. Log `tx_priority` "Set priority fee (urgency): N µL".
- **`sendAndConfirmWithRetry(conn, tx, signers, label, maxRetries)`** (307-392): `retries = maxRetries ?? cfg.tx.txMaxRetries ?? 2`. Attempt loop 0..retries: on retry, first `getSignatureStatuses([lastSig])` — if the prior broadcast already confirmed/finalized, **return it without resubmitting** (non-idempotent close/claim protection, log `tx_retry`); new blockhash; if exit tier & enabled: `bumped = min(round(max(fee, EXIT_RETRY_FLOOR 10 000 µL)·1.5^attempt), exit cap)` replaced in place; `sendAndConfirmTransaction`; then `fetchTxFeeLamports(conn, txHash, {attempts:4, delayMs:800})` (280-297, floor 5000 lamports; log `tx_gas` when floor returned). Retryable errors only: `TransactionExpiredBlockheightExceededError`, "Blockhash not found", "block height exceeded"; back-off `1500·(attempt+1)` ms. Non-retryable → `recordError("tx_failed")` and rethrow with `e.confirmedSignature = lastSig` for recovery paths (used by D26).
- **Slippage on SDK adds**: 10% everywhere (`slippage:1000` bps standard deploy/compound/rebalance; `slippage:10` % on chunkable wide path).
- **Gas estimators** (dlmm.js:399-472), all `perTx = 5000 + cachedPriorityFeeValue("normal")`: `estimateCycleGasCost` = (1|3)+3+1 txs; `estimateCompoundGasCost` = 2 txs; `estimateExitGasCost` = 1+3+1 = 5 txs. `cachedPriorityFeeValue` (156-165) = freshest **normal**-tier cache entry, 0 when nothing cached.
- **Jupiter swaps** (`swapToken`) are `VersionedTransaction`s signed locally and executed by Jupiter's `/execute`; priority fee is Jupiter's; gas looked up post-hoc via a *fresh* `Connection(RPC_URL)` + `fetchTxFeeLamports` (wallet.js:604-613).

---

### 7. `claim_fees` path

`toolMap.claim_fees = claimFeesWithCompoundGate` (executor.js:473-514, mapping at 537). Order: `estimateCompoundGasCost()`; `peekUnclaimedSolFees` (dlmm.js:2803-2822: read-only `pool.getPosition`, `feeY` lamports, 0 if token Y ≠ SOL or on error); `shouldCompound({fees, gas, min_multiple:feeCompoundMinMultiple 5, min_fees_sol:feeCompoundMinFeesSol 0.01})` (dlmm.js:487-499: `fees ≥ max(floor, multiple·gas)`). `feeCompoundEnabled` false (prod) → log `[FEE_COMPOUND_SHADOW] would compound …` when true, then plain `claimFees`. When ON and gate passes → `compoundFees` (dlmm.js:2958-3102): claim (`claim:fees`) → `recordClaim(full)` → `addLiquidityByStrategy({totalX:0, totalY:feeY, strategy within existing bins, slippage:1000})` (`claim:compoundAdd`) → `recordClaimReinvested` → `addGasToPosition`; degrades to plain claim on failure.

`claimFees` (dlmm.js:2870-2926): DRY_RUN short-circuit; closed row → error; clears pool cache; `valueClaimableFees` (2835-2868, Jupiter prices, SOL+USD) **before** `claimSwapFee` (claim zeroes them); sends each tx `claim:fees` (normal tier); `recordClaim(position,{sol,usd})` (state.js:1541-1549 sets `last_claim_at`, claim ledger, note). Returns `{success, position, txs, base_mint, asset_mints[X,Y], gas_cost_sol}`. Executor post-hook: if `cfg.management.autoSwapAfterClaim` (default **false**) swap every non-SOL `asset_mints` via `swapBaseToSolWithRetry(mint,"after claim")` (executor.js:1653-1663). Mechanical trigger: management-cycle CLAIM rule (`minClaimAmount` 5, index.js:802-812).

---

### 8. Close path

#### 8.1 Callers and urgency
- Mechanical: `executeManagementActions` CLOSE branch (index.js:755-785) passes `{position_address, reason, urgent: act.urgent===true, exit_context}`; `urgent` is `URGENT_EXIT_ACTIONS.has(exit.action)` (index.js:718: **STOP_LOSS, PROFIT_RATCHET, YOUNG_STOP, CRASH_FASTPATH, RUG_FASTPATH, TOXIC_CONVERSION** — ⚠ CLAUDE.md lists five; `TOXIC_CONVERSION` is a sixth) or `urgent:true` on the mgmt-cycle RULE_1 stop-loss (index.js:3766). Poller-confirmed exits build the same map (index.js:3195-3200). Close-efficiency gate runs before TRAILING_TP enters the map (index.js:1050-1058, 3607-3712; shadow unless `closeEffGateEnabled`).
- RPC back-off for failed mechanical closes: `_closeRetryState` exponential (`CLOSE_RETRY_INITIAL_MS`…`CLOSE_RETRY_MAX_MS`) on `/429|too many requests|rate.?limit|rpc/i` (index.js:757-782, log `[CLOSE_BACKOFF]`).
- Operator: `/close`, `/closeall` → `operatorOverride:true` (index.js:6167, 6215) → `isManual` inside dlmm. LLM MANAGER: plain `close_position` (hold guard applies).
- Flip/rebalance failure fallbacks call `close_position` with `flip-failed→close:`/`rebalance-failed→close:` reasons (index.js:808, 843).

#### 8.2 `closePosition` → `closePositionUnchecked` (dlmm.js:3125-3992), execution order (local path; relay path 3157-3465 is gated by `lpAgentRelayEnabled=false`)

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

#### 8.3 Executor post-close hooks (executor.js:1510-1651, in order)
1. `classifyOutcome({pnl_pct, fees_earned_usd: fees_usd, initial_value_usd: deployed_usd, close_reason})` for the emoji (lessons.js:939-960).
2. `notifyClose(...)` — dual-currency aware (solMode → legacy `*_usd` carry SOL), includes gas, peak, thesis/confidence from the tracked row (1524-1551).
3. Low-yield pool note: `args.reason` contains "yield" → `addPoolNote` (1552-1555).
4. **Auto-swap** unless `args.skip_swap`: `swapBaseToSolWithRetry(result.base_mint, "after close")` (1557-1559) — §8.5. On `skipped_high_impact` sets `result.auto_swap_note` telling the LLM not to re-sell (1560-1565). On `swapped`: `result.auto_swapped=true`, `sol_received`; then **`recordExitSwapOutcome(position, {sol_received, gas_sol, market_usd: token.usd, value_usd: solReceived·sol_price})`** (1575-1587 → lessons.js:293-339, §11); `notifySwap` with slippage vs mark (1596-1606); `[SWAP_FREE_SHADOW]` line when `swapFreeRedepositEnabled` is false (1614-1623); ATA rent reclaim after 2 s via `closeEmptyTokenAccount` (1628-1641, `result.rent_reclaimed_sol = 0.002`).
5. Extra `asset_mints` (non-SOL, ≠ base) swapped too (1645-1651).
6. Socket resync (1682-1690).
7. **Index.js maintenance** after the cycle (`runPostCloseMaintenance` index.js:689-699): `runPostCloseProbes()` when `postCloseProbeEnabled` (default true) — scan perf records newer than `max(probeMinutes)+60` min, fill `post_close.m30/m60/m180` via `getPoolDetail(pool,"5m")` mcap, `stale` if `ageMin ≥ m+20`, `delisted` on fetch error (649-686; log `probe`); then `sweepWalletDust()` when `dustSweepEnabled` and (`closedCount>0` or `_mgmtCycleCount % 10 === 1`).

#### 8.4 Fields the LLM/notify rely on from the close result
`pnl_sol`, `pnl_usd_true`, `deployed_sol_true`, `fees_sol_true` are the honest dual-currency fields; `pnl_usd`, `deployed_usd`, `fees_usd` carry SOL under `solMode` (prod true) — the CLAUDE.md unit landmine.

#### 8.5 `swapBaseToSolWithRetry(baseMint, label)` (executor.js:1219-1312)
- `attempts = max(1, autoSwapRetryAttempts 3)`, `delayMs = autoSwapRetryDelayMs 3000`.
- Each attempt: `getWalletBalances({})`; `token.usd < 0.10` → done (nothing to swap).
- **Exit-swap guard** (attempt 1 only, 1235-1277): `maxImpact = exitSwapMaxImpactPct (5)`; only when `token.usd ≤ dustSweepMaxUsd (25)`; `quote = getSwapQuote({input:baseMint, output:"SOL", amount:token.balance})`; `impactPct = (token.usd − out_amount/1e9·sol_price)/token.usd·100`; `> maxImpact` → if `exitSwapGuardEnabled` (default false) log `[EXIT_SWAP_GUARD] skipping …`, `recordDeferredExitSwap(mint,{usd,impact_pct,label})` and return `{swapped:false, skipped_high_impact:true, impact_pct}`; else `[EXIT_SWAP_GUARD_SHADOW] would skip …`. Fail-open on quote error.
- **Slippage cap** (1280-1291): `cap = swapSlippageCapBps (500)`, only when `token.usd ≤ dustSweepMaxUsd`; enabled (default false) → `capBps=cap`, else `[SLIPPAGE_CAP_SHADOW] would cap …` on attempt 1. Balances above 25 USD always keep RTSE.
- `swapToken({…, slippage_bps: capBps})`; success = `success!==false && !error && (tx || amount_out)`; on success `clearDeferredExitSwap(mint)`. Failure → `executor_warn` and retry; final failure `executor_warn` "base token left unsold".

#### 8.6 `sweepWalletDust()` (executor.js:1324-1415)
Gated by `dustSweepEnabled` (true). For each wallet token: skip SOL/USDC; skip mints with an OPEN tracked position **unless** in `getDeferredExitSwaps()` (guard-deferred remainders, the CATE 2026-07-27 fix); skip `usd < dustSweepMinUsd (0.25)`; skip `usd > dustSweepMaxUsd (25)` (→ `skipped_large`); `swapBaseToSolWithRetry(mint,"dust sweep")` (so the guard + cap apply again); `closeEmptyTokenAccount` after 2 s. Telegram "🧹 Dust swept". Janitor pass: `listEmptyTokenAccounts()` → close up to 5 empty ATAs not belonging to open mints (log `[DUST] reclaimed N empty ATA(s)`). Never throws (`executor_warn`).

---

### 9. `swap_token` (LLM/manual)
`runSafetyChecks` case `swap_token` → always `{pass:true}` (executor.js:2029-2033; DRY_RUN handled inside `swapToken`). `swapToken` (wallet.js:506-637): decimals via `getParsedAccountInfo`; `/order` with `taker` + referral, `slippageBps` only when the caller passes a finite positive `slippage_bps` (the LLM schema exposes none → RTSE); sign `VersionedTransaction`; `/execute`; `status==="Failed"` → throw; warns if `order.feeBps` ≠ requested referral fee; returns `{success, tx, amount_in, amount_out, referral_*, fee_bps_applied, fee_mint, gas_cost_sol}`. Executor post-hook `notifySwap` (1481-1488).

---

### 10. `rebalance_position`

**Safety case** (executor.js:2001-2027), in order: operator override (`_operator_override===true`) → `{pass:true}` skipping everything (log `[REBALANCE_GATE] operator override`); not tracked → block; `tracked.closed` → block; `rebalance_count ≥ rebalanceMaxCount (2)` → block "Rebalance chain depth …"; `validateDeployPoolThresholds({pool_address: tracked.pool})` (full V0–V9 re-validation) fails → block "Rebalance refused — pool no longer passes deploy validation".
Also the `executeTool` hold guard (1444-1451) and the mechanical engine is `rebalanceMode` **"shadow"** by default (config.js:733) → decision points log `[REBALANCE_SHADOW]` and take the ordinary close path (index.js:1079-1090 for the round-trip roll-up).

**`rebalancePosition`** (dlmm.js:4154-4471), order: hold guard (4163-4167); bins normalisation `bBelow+bAbove ≤ 69`, two-sided extreme-skew (`≥50` total and either side `<10`) → reset to `[35,34]` (4170-4189, log `rebalance_warn`); DRY_RUN (4191-4205); `lookupPoolForPosition`, `getPool`, `getPosition` (4210-4222); pre-close valuation from `_positionsCache` or pool-memory snapshot (4225-4246); **proceeds-only snapshot**: `preSol`, `preX` (wallet base balance), `rootSolPre = resolveRootInitialBasis(tracked).sol || root_initial_sol || amount_sol`, `preValueSol` (solMode `total_value_usd`); **refuse** when neither root basis nor pre-close value > 0 (4251-4267); Step 1 `removeLiquidity({bps:10000, shouldClaimAndClose:true})` label `rebalance:removeLiquidity` (normal tier) or `closePosition` `rebalance:closeEmpty` (4269-4297); sleep 4 s; Step 2 balances: `tokenXAmount = max(0, balance − preX)`; SOL: `maxAvailable = sol − gasReserve`, `legProceeds = solDelta > 0 ? solDelta : preValueSol`, `capSol = rootSol > 0 ? min(rootSol, legProceeds) : legProceeds`, `quoteAmount = min(maxAvailable, capSol)` (4303-4342, log `rebalance` "Rebalance sizing (proceeds-only)"); both zero → error; Step 3 `[active−bBelow, active+bAbove]`, single-sided edge cases collapse to one side with `min(69, bAbove+bBelow)` (4349-4366); `initializePositionAndAddLiquidityByStrategy({slippage:1000})` label `rebalance:initAndAdd` signed `[wallet, newPosition]` (4376-4392); `rebalancePositionState` (state.js:709-806: old row closed with exit_* snapshot, new row tracked with `rebalance_count+1`, `parent_position`, `root_parent_position`, `root_initial_sol/usd`, cumulative fees carried) (4396-4413); decision log; `requestPositionDiscovery`; **fire-and-forget `recordRebalanceLegPerformance`** (dlmm.js:2087-2178: dedup by position in `getAllPerformance`; `fetchClosedPositionPnl(retries 6, 5 s)`; adoption basis applied; `close_reason: "rebalance: <reason>"`, `rebalance_leg:true`, `rebalanced_into`, `gas_cost_sol`, `total_gas_sol`, `recorded_at: closed_at`) (4438-4447, log `[REBALANCE_LEG]`). Executor post-hook `notifyRebalance` (1664-1679).

---

### 11. Performance record — every field written

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

### 12. `getWalletBalances` / AUM (wallet.js:175-421)
`fetchRpcWalletSnapshot` (63-127): `getBalance` + `getParsedTokenAccountsByOwner` for SPL and Token-2022 via the failover pool; wrapped SOL merged into SOL; Jupiter prices; `recoverableRentSol` = Σ token-account lamports. Then positions via `getMyPositions({force: freshPositions})` + fresh discovery extras (≤2 min old); `deployed`/`unclaimed` summed in SOL or USD per `solMode`; position rent measured with `getMultipleAccountsInfo` in chunks of 100 (fallback 0.065 SOL each); held tokens; `total_sol = idle + deployed + unclaimed + rent + recoverableRent + heldTokensSol`; `total_usd = data.totalUsdValue + deployed + unclaimed + rent + recoverableRent` (held tokens already inside `totalUsdValue`). Returns `{wallet, sol, sol_price, sol_usd, usdc, tokens[{mint,symbol,balance,usd}], aum{…}, total_usd}`. Single attempt (`maxRetries = 1`).

### 13. `tools/pnl.js` — lifetime fields
`buildPositionsFromMap` emits per position (pnl.js:975-1015) the `*_usd` (SOL under solMode) / `*_true_usd` pairs plus raw Meteora **`lifetime_deposits_sol/usd`, `lifetime_withdrawals_sol/usd`, `lifetime_fees_sol/usd`** (1003-1008, no fallback substitution) — consumed by `buildAdoptionBasis(p)` (state.js:859-884: null when `deposits_sol ≤ 0`, `pnl_sol = withdrawals + fees − deposits`) at `adoptOrphanPosition` Case B (state.js:1085). `computePositions` (1170-1212): discovery mode → Helius `getProgramAccountsV2` scan; otherwise reads only tracked accounts via `getMultipleAccountsInfo`.

### 14. RPC failover pool (`tools/rpc.js`)
Per-node state (200-243): circuit (5 consecutive errors → open 60 s; force-reset the oldest when all are open), rate-limit back-off 30 s·2^n up to 1 h (`markRpcRateLimit` 623-640; quota-exceeded phrases → 1 h + `isQuotaExceeded`), capability failures (-32601/-32602 or HTTP 400/401/403/404) → method (or endpoint for 401/403/unknown method) blocked 30 min (612-621), 15 s per-call timeout, latency window 20. `callRpcWithConnection` (710-839): sort by `healthScore` (rate-limited/quota nodes last), filter available, **round-robin among healthy Helius nodes first**, then healthy non-Helius, then degraded; back-off `min(1000·2^(i−1), 10000)` ms between nodes; error telemetry `rpc_429`/`rpc_timeout`/`rpc_other`. Two pools: `standard` (Helius keys + non-Helius fallbacks + public) and `indexed` (Helius-only, for `getProgramAccountsV2`). **Not** used for any transaction send (see §0).

### 15. `update_config` (executor.js:620-1195) — execution-relevant behaviour
Flat key → `[section, field(, nested|persistPath)]` map (622-999); case-insensitive; bins keys clamped to `[35,69]` (1017-1024); `rebalanceBinsBelow/Above` clamped `[1,69]` (1026-1032); `outOfRangeWaitMinutes*` accept literal `null` (1034-1045); `playstyle` resolves preset min/max/default unless bins given in the same call (1063-1077); `timeframe` auto-scales `minFeeActiveTvlRatio`/`minVolume` (1092-1101); applied live then persisted to `user-config.json` (GMGN keys to `gmgn-config.json`); cron restart on interval keys; `[SELF-TUNED]` lesson. Sensitive keys redacted in logs (55-70). Keys **not** tunable: `postCloseProbeMinutes`, `rangeHarvestPools`, `crashSocketMode`, `topPerformerHint` widths.

---

### 16. Correlations, mirrors, contradictions, dead/inert checks

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

---

<!-- ===== 03-management-and-exits.md ===== -->

## Meridian — Position Management & Exit Stack Inventory

Read-only inventory of every rule that can close, hold, claim, flip, rebalance or defer an open position.
Source tree: `/Users/Angga/Repos/meridian` @ `a0fcd12` (branch `experimental`), read 2026-09-25.
Line numbers cite that checkout. "Prod" values come from CLAUDE.md / `docs/plans/15-*.md`; where neither
states a prod value it is marked **prod: unknown**. The local `user-config.json` is a dev copy that
**diverges** from documented prod (e.g. it has `stopLossPct=-18`, `profitRatchetArmPct=6`,
`maxPositionsExcludeHold=true`, `autoSkim.enabled=true`) — it is NOT used as evidence here.

---

### 0. Evaluators, cadence, and shared plumbing

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

### 1. `state.js updatePnlAndCheckExits` — exact evaluation order (`state.js:2523–3141`)

Entry gates (return `null`, **before any bookkeeping**): position missing/closed (2528); `hold_mode === true` (2529); `pnl_management_ready === false` (2530). `rangeHarvest` = `management_profile === "range_harvest"` (2533; pool allow-list `rangeHarvestPools`, default `[]`, prod unknown) suppresses TAKE_PROFIT / TRAILING_TP / PROFIT_RATCHET (`isRangeHarvestProfitExitSuppressed` 46–48).

#### Bookkeeping block (2536–2735, runs first, may `save`)
1. Bin-range sync + **external rebalance detection** (2541–2582): if tracked min/max differ from on-chain → `rebalance_count++`, `peak_pnl_pct := current`, ratchet disarmed, `trailing_active` cleared if peak < trigger, event `rebalance_external`.
2. **External capital change** (2585–2648): only when `pnl_quality==="valid"` and `net_deposit_sol` differs ≥0.02 SOL AND ≥5% → rebases `amount_sol`, `root_initial_*`; on top-up resets peak/ratchet/trailing.
3. **Trailing activation** (2654–2669): `trailingParams` = static `{trailingTriggerPct??3, trailingDropPct??1.5}` unless `adaptiveTrailingMode==="enforce"` → `resolveDynamicTrailingParams` (2443–2453: trigger `clamp(1.5·vol, 8, 25)`, drop `clamp(0.2·trigger, 1.5, 3)`). `trailing_active := true` when `mgmtConfig.trailingTakeProfit` (default true) and confirmed peak ≥ trigger. Shadow line `[ADAPTIVE_TRAILING_SHADOW]` when the adaptive trigger would still be waiting.
4. OOR clock (2672–2680): `out_of_range_since` set/cleared from `in_range` (also maintained independently by `markOutOfRange` in `tools/pnl.js:911`, so the clock keeps running under hold).
5. MFE/MAE + `pushPnlTick` (2687–2695); `max_bins_below/above` (2696–2703); `peak_dynamic_fee_pct` / `peak_fee_per_tvl_24h` (2705–2714); `initial_base_ratio_pct` captured once at age ≤1 min (2717–2733).
6. `pos.lazy === true` → return null (2737) — lazy LP bypasses every exit.

#### Exit rules, in order (first `gateExit`-approved hit returns)

| # | Rule / `action` | Family keyword → `reasonFamily` (lessons.js:483–495) | file:line | Condition | Config (code default → prod) | Confirm / urgency / guards | Shadow state + tag |
|---|---|---|---|---|---|---|---|
| 1 | **TOXIC_CONVERSION** (`rule:"toxic_conversion"`) | reason "Toxic conversion: … with low fee yield (…)" contains **"yield" → `low_yield`** (and `classifyOutcome` treats it as fee-death) | 2789–2803; pure fn `evaluateToxicConversion` 2113–2165 | `baseLiq/totalLiq ≥ thresholdPct` AND `age ≤ maxAgeMinutes` AND `fee_yield_pct < maxFeeYieldPct`; skipped if `initial_base_ratio_pct ≥ 70`; needs `liq_x_usd/liq_y_usd` | `toxicConversionEnabled` **true** (config.js:736 — ON by default, not in CLAUDE.md); `toxicConversionThresholdPct` 85; `toxicConversionMaxAgeMinutes` 20; `toxicConversionMaxFeeYieldPct` 1.5. Prod: unknown (defaults → ON) | poller 2 ticks; mgmt immediate; TWAP-gated; **URGENT** (in `URGENT_EXIT_ACTIONS`, index.js:718); close-eff n/a | No shadow log when disabled (silently skipped) |
| 2 | **PROFIT_RATCHET** (`rule:"profit_ratchet"`) | "Profit ratchet: peaked … (stop tightened from …)" → **no keyword → `other`** | 2805–2856; `evaluateProfitRatchet` 2040–2053 | armed := sticky `ratchet_armed` OR confirmed `peak_pnl_pct ≥ armPct`; fires when armed AND `pnl_pct ≤ stopPct` | `profitRatchetEnabled` code **true** (config.js:492; CLAUDE.md says code default false — stale); `profitRatchetArmPct` code **6** / `profitRatchetStopPct` code **+1.5** (config.js:493–494) vs **prod arm 2 / stop −2** (plan-15 §3.2 restore) | poller 2 ticks; TWAP-gated; **URGENT**; excluded for `rangeHarvest` | OFF → `[RATCHET_SHADOW] armed` once + `would-close` 1/10 min |
| 3 | **YOUNG_STOP** (`rule:"young_stop"`) | "Young-token stop: PnL …" → **no "stop loss" → `other`** | 2858–2914; `evaluateYoungStop` 2082–2096 | `token_age_hours_at_deploy < youngStopMaxAgeHours` (null age → not young) AND `!ratchet_armed` AND `pnl ≤ youngStopPct`; own 15 s timer `young_stop_violated_since` | `youngStopEnabled` **false**; `youngStopPct` −10; `youngStopMaxAgeHours` 12. Prod OFF | 15 s timer + poller 2 ticks; TWAP-gated; **URGENT** | `[YOUNG_SL_SHADOW] would-close` 1/hr |
| 4 | **STOP_LOSS** | "Stop loss: Effective PnL …" → `stop_loss` | 2916–2937 | `effective_pnl_pct ≤ stopLossPct`; 15 s `stop_loss_violated_since` timer before the exit object is built | `stopLossPct` code **−18** (config.js:463) → **prod −15** | 15 s timer + 2 ticks; TWAP-gated; **URGENT** | always on. **In practice superseded by RULE_1** — see §4 |
| 5 | **TRAILING_TP** | "Trailing TP: peak …" → `trailing_tp` | 2939–2984; `evaluateTrailingTakeProfit` 2465–2513 | requires `trailing_active`; threshold = `peak − dropPct` (optionally `max(·, trailingMinPnlPct)`); fires when `current ≤ threshold`; `needs_confirmation` unless overshoot ≥ `trailingOvershootPct` (0.5 pp) → `bypass_confirmation` (poller confirm 1). Inventory-exhaustion tightening (base fraction ≤20% & pnl>0 → drop `min(drop,1.0)`, floor 1.5%) only when `inventoryExhaustionMode==="enforce"` | `trailingTakeProfit` true; `trailingTriggerPct` 3 → **prod 2**; `trailingDropPct` 1.5 → **prod 1.5**; `trailingMinPnlPct` null; `trailingOvershootPct` 0.5; `adaptiveTrailingMode` / `inventoryExhaustionMode` **"shadow"** (prod shadow) | 2 ticks (or 1 on overshoot); TWAP-gated; **close-efficiency gate applies (only rule that is)**; NOT urgent | `[ADAPTIVE_TRAILING_SHADOW]`, `[INVENTORY_EXHAUSTION_SHADOW] would-close` |
| 6 | **LINEAGE_TAKE_PROFIT** (`rule:"lineage_take_profit"`) | "Lineage take-profit: …" → **hyphen ≠ "take profit" → `other`** | 2986–3008 | `rebalance_count ≥ 1` AND `root_initial_sol > 0`; `(value + cumulative_fees_claimed_sol + claimable − root)/root ≥ rebalanceLineageTakeProfitPct` | `rebalanceLineageTakeProfitPct` 4.0 | 2 ticks; TWAP-gated; not urgent; suppressed for rangeHarvest | always on (only reachable on legacy chains while rebalance is shadow) |
| 7 | **ROUND_TRIP_HARVEST** (`rule:"round_trip"`, `needs_confirmation:true`) | "Round-trip complete: N bins above range …" → **"above" → `oor_above`** | 3010–3039; `evaluateRoundTripHarvest` 2327–2366 | `active − upper ≥ roundTripMinBinsAbove` AND `pnl ≥ roundTripMinPnlPct` AND last `roundTripFrozenTicks` entries of `pnl_tick_history` all within ±`roundTripFrozenEpsilonPct` of current | `roundTripHarvestEnabled` code **false** → **prod true** (since 2026-08-21); MinPnl 1.0; FrozenTicks 6; Epsilon 0.05; MinBinsAbove 5 | 2 ticks; TWAP-gated; not urgent; **mgmt/poller then run the roll-up branch (§2.B / §3)** | OFF → `[ROUNDTRIP_SHADOW] would-harvest` 1/10 min |
| 8 | **SURGE_DECAY** (`rule:"surge_decay"`) | type `dynamic_fee`: "Dynamic fee collapsed …" → `other`; type `fee_tvl`: "Fee/TVL yield collapsed …" → **`low_yield`** (fee-death in `classifyOutcome`) | 3041–3064; `evaluateSurgeDecay` 2182–2227 | age ≥ minAge AND pnl ≥ 0 AND (`peak_dynamic_fee_pct ≥ 0.5` and drop ≥ threshold%) OR (`peak_fee_per_tvl_24h ≥ 5.0` and drop ≥ threshold%) | `surgeDecayExitEnabled` **false**; `surgeDecayThresholdPct` 50; `surgeDecayMinAgeMinutes` 15. Prod unknown (local dev copy has true) | 2 ticks; TWAP-gated; not urgent | `[SURGE_SHADOW] would-rotate` 1/10 min |
| 9 | **OUT_OF_RANGE (below)** | "Out of range below for Nm (limit: Nm)" → `oor_below` | 3066–3092 | `out_of_range_since` set AND `active < lower` AND `outOfRangeWaitMinutesBelow != null && > 0` AND `floor(minutesOOR) ≥ limit`. **Above is deliberately NOT handled here** (3089–3091) | `outOfRangeWaitMinutesBelow` code default 180 (absent key inherits `outOfRangeWaitMinutes`; explicit null = disabled) → **prod 60** | 2 ticks; TWAP-gated; not urgent; flip/rebalance branches consulted after confirm (§3) | always on (null disables) |
| 10 | **LOW_YIELD** | "Low yield: fee/TVL … < min …" → `low_yield` | 3094–3138 | `fee_per_tvl_24h < minFeePerTvl24h` AND (`age_minutes == null` OR ≥ `minAgeBeforeYieldCheck`); **Guard A** adoption grace: `adopted && now − adopted_at < adoptGraceMinutes`; **Guard B** history floor: `fresh_snapshots < poolHealthMinSnapshots` → suppressed with a log line | `minFeePerTvl24h` 7 (prod unknown); `minAgeBeforeYieldCheck` 60; `adoptGraceMinutes` 30; `poolHealthMinSnapshots` 3 | 2 ticks; TWAP-gated; not urgent; close-eff gate only logs a `lowyield-cost` breakdown (never defers) | always on |

**T. TWAP wick guard (`gateExit`, 2744–2787; pure fn `evaluateTwapWickGuard` 1946–1976):** compares current pnl to the mean of the last `twapGuardTicks` (5) prior ticks; deviation > `twapGuardDeviationPct` (8 pp) → defer, bounded by `twapGuardMaxDeferrals` (2) consecutive (`twap_guard_deferrals`, lifetime `twap_guard_deferrals_total`). `twapGuardEnabled` **false** (prod OFF) → `[TWAP_GUARD_SHADOW] would-defer` / `deferral cap reached`, exit passes through. Never sees crash/rug (structural).

---

### 2. `index.js getDeterministicCloseRule` — order (`index.js:3716–3908`)

Gates → `null`: untracked and `!manageUntracked` (default false) (3720); `lazy` (3725); `hold_mode` (3730); `pnl_management_ready === false` (3733). `pnlSuspect` (3737–3747) = `pnl_pct_suspicious` OR (pnl ≤ −90 while value > 0.01 SOL). Reason strings are deliberately keyword-disciplined (comment 3749–3755): the family classifier is `reasonFamily()` in `lessons.js:483–495` (index.js's comment calls it `classifyExitFamily`; no function of that name exists). Match order: `stop loss → crash → trailing → take profit → below → above → out of range|oor → yield → volume → other`.

| # | Rule id / signal | Family | file:line | Condition | Config (code default → prod) | Urgency / notes |
|---|---|---|---|---|---|---|
| R1 | `rule:1` **stop loss** (`urgent:true`) | "stop loss: effective pnl …" → `stop_loss` | 3759–3767 | `!pnlSuspect` AND `effective_pnl ≤ stopLossPct` | `stopLossPct` −18 → **prod −15** | mgmt: `urgent:true` flows to `closePosition`. **Poller: signal is `"RULE_1"`, NOT in `URGENT_EXIT_ACTIONS` → non-urgent** (3199). No 15 s timer, no TWAP |
| R2 | `rule:2` **take profit** | "take profit: effective pnl …" → `take_profit` | 3768–3777 | `effective_pnl ≥ takeProfitPct`; suppressed for `range_harvest` | `takeProfitPct` code **5** (config.js:464); local dev copy 35; **prod unknown** (if 5, this hard-caps every trailing ride at +5%; the +4.10 avg / 103 trailing exits in plan-15 §2 suggest prod ≫5 — inference, unverified) | not urgent |
| R2' | `rule:2` **lineage take profit** | "lineage take profit: cumulative lineage pnl …" → `take_profit` | 3779–3816 | `rebalance_count ≥ 1`; root basis via `resolveRootInitialBasis`; totals `value + unclaimed + cumulative_fees_claimed_sol + total_fees_claimed_sol` (both fields summed — possible double count, **uncertain**) ≥ `rebalanceLineageTakeProfitPct` | 4.0 | third string variant of the same rule (see §1.6 and §2.B) |
| R3 | `rule:3` **pumped far above** (`oor_direction:"above"`) | "pumped far above range …" → `oor_above` | 3821–3833 | `active > upper + outOfRangeBinsToClose`; no pnl condition, no stability check | `outOfRangeBinsToClose` code **10** (config.js:428) → **prod 50** (CLAUDE.md) | not urgent |
| R3u | `rule:3` **unfilled-ladder cap** (`unfilled:true`) | "pumped above range with an unfilled ladder …" → `oor_above` | 3834–3857 | `outOfRangeBinsToCloseUnfilled` non-null >0 AND `active > upper + N` AND `pnl_pct < unfilledMaxPnlPct` | `outOfRangeBinsToCloseUnfilled` null → **prod 25** (2026-09-25, be2fcea); `unfilledMaxPnlPct` 1.0 | shipped after harvest so a filled ladder (pnl ≥1) is never mislabelled |
| R4a | `rule:4` **OOR above** | "OOR (above): … bins past upper" → `oor_above` | 3858–3878 | `active > upper` AND `outOfRangeWaitMinutesAbove != null && >0` AND `minutes_out_of_range ≥ limit` AND **`isPriceStable`** (3868) — if not stable **returns `null` for the whole function** (R4b/R5 not reached) | `outOfRangeWaitMinutesAbove` code 15 (config.js:446) → **prod 720**; `oorAboveStableTicks` 2 | `isPriceStable` (202–212) keeps the last N+1 active bins per position **in-process**, fed by every call (poller 3 s ticks AND mgmt) → "2 stable management ticks" is really "2 stable evaluations" (≈6 s in the poller). Plan-15 §3.5: R4a has **never fired since Aug** (clock resets on any wick back in) |
| R4b | `rule:4` **OOR below** (`oor_direction:"below"`) | "OOR (below): … bins past lower" → `oor_below` | 3879–3894 | `active < lower` AND `outOfRangeWaitMinutesBelow != null && >0` AND `minutes_out_of_range ≥ limit` | 180 → **prod 60** | uses scan-side `minutes_out_of_range`; same threshold as state.js #9 |
| R5 | `rule:5` **low yield** | "low yield: fee/TVL … < min" → `low_yield` | 3895–3906 | `fee_per_tvl_24h < minFeePerTvl24h` AND `age ≥ minAgeBeforeYieldCheck`. **No adoption grace, no history floor** (contrast state.js #10) | 7 / 60 | not urgent |

#### 2.A Management-cycle action map (`index.js:1033–1301`) — order per position
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

### 3. PnL poller decision path (`index.js:2940–3215`)

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

### 4. Precedence tables

#### 4.1 Poller (per tick, first confirmed signal wins; crash/rug override whatever was computed)
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

#### 4.2 Management cycle (per position, first match)
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

#### 4.3 Where the two evaluators disagree or double-evaluate
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

### 5. Companion decision modules

#### 5.1 OOR-below flip (`shouldFlipOorBelow`, `index.js:404–448`; plan #07)
Gates, all must pass: (1) `active < lower`; (2) `_crashFired` never marked (set by crash **and** rug hits, even in shadow, 2997/3013); (3) `getOrganicMomentumForPool` ≠ `decaying`; (4) no `volume_death` health alert (mgmt only — poller has no `health`); (5) pool/base-mint not on repeat-deploy cooldown; (6) `flip_count < oorFlipMaxPerPosition` (1); (7) `flipped_at` older than `oorFlipBailHours` (6) → `bail_timeout`. Flags: `oorFlipEnabled` **false** (prod OFF) → `[OOR_FLIP_SHADOW] would flip|no flip blocked_by=…`; companion `swapFreeRedepositEnabled` false (`[SWAP_FREE_SHADOW]`, executor auto-swap path), `swapFreeRedepositBins` 20. ON path: `flipPositionInPlace` → ask ladder `active+1…active+20`, failure → real close (index.js:792–811). Cleared on FLIP: `_binTrail/_rugTrail/_crashFired/_socket*` (3206). Consulted only on the RULE_4b path (see §4.3).

#### 5.2 Rebalance / roll-up engine (plan #15 item 3, plan #11)
- `rebalanceEngine()` (490–494): `enabled = rebalanceEnabled` (default **true**); `enforce = enabled && rebalanceMode === "enforce"` (`rebalanceMode` default **"shadow"**, prod shadow).
- Four decision points: mgmt ROUND_TRIP roll-up (1072–1099), mgmt OOR-below (1152–1241), poller ROUND_TRIP roll-up (3116–3136), poller OOR-below deferral (3137–3153). All log `[REBALANCE_SHADOW]` and take the ordinary close/flip path in shadow; **no STAY-while-waiting in shadow**.
- Keys: `rebalanceMinOorMinutes` 15, `rebalanceMaxCount` 2, `rebalanceBinsBelow` 35, `rebalanceBinsAbove` 34 (OOR-below rebalance = `curve` 35/34; roll-up = `spot` 69/0), `rebalanceTrendTimeframe` "5m", `rebalanceTrendCandles` 6, `rebalanceLineageTakeProfitPct` 4.0 (config.js:745–763). Manual `/rebalance n [strat]` uses 35/34 (index.js:6186–6192).
- Executor safety case `rebalance_position` (`tools/executor.js:2001–2027`): depth cap `rebalance_count ≥ rebalanceMaxCount` → refuse; `validateDeployPoolThresholds(pool)` → refuse if the pool no longer passes deploy gates. **Operator override returns `pass:true` before both checks** (2008–2012) — the inline comment at 2006 ("skips only the depth cap, never the pool validation") and CLAUDE.md say only the cap is skipped; the code skips both. Hold blocks non-override rebalances (1444–1451).
- `rebalancePosition` (`tools/dlmm.js:4154`, proceeds-only sizing 4253–4334; refuses before closing when no capital basis) and `recordRebalanceLegPerformance` (2087; `close_reason: "rebalance: …"`, `rebalance_leg:true`).
- Trend predicate `isRebalanceTrendIncreasing` (`tools/rebalance-trend.js:58–121`): GeckoTerminal OHLCV, `confirmed` = netGain > 0 AND latest advancing (≥ −0.5 %) AND (higher closes OR higher lows OR green ≥ ceil(0.6·n)).
- Evidence: Sep 13–24 live (pre-shadow) 33 chains ≈ **−4.0 SOL** net (plan-15 §2); 09-13→19 roll-up children ≈ +1.3 SOL vs KEVIN −0.48 / baton −0.67 (§3.5); GeckoTerminal replay of 40 unfilled far-above moments: immediate 69-bin roll-up mean **−7.0 % @3h / −11.4 % @6h**, worst −95 % (§3.5) → "no re-centre; free the capital". Plan-11 §2 (153 closes): 71 % of ≥5-bin above-range excursions wick back (64 % from ≥15 bins) → eager roll-up whipsaws ~2 of 3.

#### 5.3 Position alerts (`position-alerts.js`, advisory)
`getPoolHealthConfig` (46–58): `poolHealthAlertsEnabled` true, `poolHealthAutoReview` **false**, `poolHealthMinSnapshots` 3, `poolHealthMinAgeMinutes` 20, `poolHealthWindowSize` 12, `poolHealthYieldDecayPct` 50, `poolHealthTvlDilutionRisePct` 40, `poolHealthVolumeDeathPct` 60, `poolHealthFeeRatioCollapsePct` 60. `analyzePositionHealth` (69–154): `yield_decay` (current fee/TVL vs early-window avg −50 %) → `fee_share_dilution` if pool TVL +40 % (review=true) else `yield_decay` (no review); `volume_death` (−60 % from window peak, review=true); `fee_ratio_collapse` (−60 %, no review). `review` forced false unless autoReview (152). Used by: mgmt report lines, LLM action block, REVIEW action, and flip GATE 4. Never auto-closes.

#### 5.4 PVP on open positions (`pvp.js`, mgmt cycle 1021–1028)
`checkPositionsPvp` → `detectPvpRival(symbol, mint)`: Jupiter asset search for same symbol, rival needs `holderCount ≥ 500` and `fees ≥ 30` SOL, and a Meteora pool with `tvl > 5000`. Attached as `p.pvp`; rendered via `formatPvpAlert`; LLM rule "do NOT close solely for PVP". No mechanical effect.

#### 5.5 OOR notify (`index.js:1532–1562`, `telegram.js:920–935`)
After a notifying cycle, for each open, **non-held** position with `!in_range` and `minutes_out_of_range ≥ outOfRangeWaitMinutes` (generic, 30): direction/limit resolved per side; **skipped when the direction limit is null** (auto-close disabled); suppressed while a live message is active (`hasActiveLiveMessage`). Hold sets "Auto-close disabled (On Hold)".

#### 5.6 Post-close probes (plan #05; `runPostCloseProbes` 649–680, `runPostCloseMaintenance` 689–699)
Every mgmt cycle (also the zero-positions path, 984): for perf records younger than `max(postCloseProbeMinutes)+60` min, each due slot m ∈ `[30,60,180]` (not `update_config`-tunable) fetches pool mcap (`getPoolDetail`) once (idempotent `post_close.m{m}`), `stale` if past `graceMin` 20, `delisted` on fetch failure, `unprobeable` when `exit_mcap` missing. Exit quality (`lessons.js:355–368`) anchors on m60 → m180 → m30; verdicts `flat|good_exit|early_exit|marginal|delisted|no_data`; rollup `getExitQualitySummary` (505–545) by `reasonFamily`, `selling_bottoms` = n ≥ 6 and early > good. Dust sweep after any close and every ~10th cycle (`dustSweepEnabled` true).

#### 5.7 Balance-history piggyback
`recordBalanceHistory({freshPositions:false})` fire-and-forget at the end of every positions-carrying cycle (1457–1458) + cron `*/5` (3373) + boot (2557); CLAUDE.md: 2.5-min min-gap dedupe. Also `_lastSampledAum` feeds the report.

#### 5.8 Adoption & reconciliation
- `reconcileStateWithChain({minAgeMinutes=5})` (`state.js:3389–3525`): owner-wide discovery scan; (1) phantom: tracked-open but absent on-chain AND `isPositionAccountLive === false` AND deployed >5 min ago → `closed`, `external_close_pending`, Telegram; (2) orphan: on-chain, untracked/closed, age ≥ 5 min, liveness true → `adoptOrphanPosition(p,{reason:"reconciliation"})`; (3) `pnl_pct_diff > 5` → alert (6 h rate limit). Poller-side repair `repairPendingExternalCloses` (2753–2772) recovers PnL for external closes via `reconcileExternallyClosedPosition`.
- `adoptOrphanPosition` (`state.js:936–1110`): Case A resurrect a closed row (`adopted_at` reset, `valuation_valid_ticks=0`, `management_armed=false`); Case B `trackPosition` with `adopted:true`, `deployed_at` **backdated by on-chain age**, `amount_sol` = first-scan SOL value, strategy `manual` unless a deploy event proves bot origin, **`adoption_basis = buildAdoptionBasis(p)`** (859–883: lifetime deposits/withdrawals/fees snapshot; null if indexer has none). `applyAdoptionBasis` (892–934): `pnl_sol = (lifetime.pnl − basis.pnl) − capitalAtAdoption` (b069ac2 fix), `pnl_pct` vs `capitalAtAdoption + post-adoption deposits`.
- Adoption-specific exit behaviour: `pnl_management_ready` false until `postAdoptionValidTicks` (2) valid ticks (`state.js:1349–1370`) → both evaluators return null / STAY; LOW_YIELD state.js path grace `adoptGraceMinutes` (30) from `adopted_at` + `poolHealthMinSnapshots` floor; RULE_5 has no such guard (§4.3).

#### 5.9 Auto-skimmer rails (`tools/transfer.js`)
Config `autoSkim` (`config.js:975–985`): `enabled` **false** (prod OFF per CLAUDE.md), `destinationAddress` (env `PIONEX_DEPOSIT_ADDRESS` wins), `targetWorkingCapitalSol` 6.2529, `minTransferAmountSol` 0.5, `minWalletReserveSol` 0.1, `transferIntervalMin` 60, `maxDailyTransferSol` 2.0, `requireTelegramConfirmation` **true**. `getAutoSkimStatus` (84–176): equity = free SOL + `deployed_sol`; surplus = equity − target; transferable = min(surplus, free − reserve); block reasons in order: disabled → invalid destination → cooldown → daily cap (in-memory ledger floored by persisted baseline withdrawals ≤24 h) → surplus < min → cash < min. `checkAndExecuteAutoSkim` (335–390): chunks of `minTransferAmountSol`; with confirmation required returns `confirmation_required` (cron proposes on Telegram ≤1/6 h, index.js:3473–3483). `transferSol` (185–301): `validateDestinationAddress` (base58, on-curve, ≠ own wallet), ≥0.01 SOL, reserve check, daily cap, priority fee 50k µL, simulate, confirm ≤45 s, records `baseline.withdrawals`. `_transferLock` serialises. Cron `*/5` (3447) skipped while busy.

---

### 6. Hold mode — full semantics

- **Set/clear**: `setPositionHold(addr, enabled, reason)` `state.js:1683–1721` — sets `hold_mode/hold_set_at/hold_reason` (reason sanitised ≤280 chars), and on hold **clears** `pending_exit_*`, `stop_loss_violated_since`, `young_stop_violated_since`, `twap_guard_deferrals`; pushes `hold|resume` event. Entry points: `/hold <n|pair>` `/unhold` + natural-language "hold" detection (`isExplicitHoldRequest` 5734–5743, `handleTelegramHoldControl` 5771–5815; reason = the message text); positions-menu button (5015–5024, reason "telegram_button"); dashboard `POST /command/set-hold` (4208–4255, reason "dashboard operator hold"); `/unset n` clears **both** instruction and hold (6248–6249); `/unhold` clears hold only (instruction kept).
- **Suppressed while held**: `updatePnlAndCheckExits` → null before bookkeeping (state.js:2529) — so `peak_pnl_pct`, `trailing_active`, ratchet arming, `pnl_tick_history`, MFE/MAE, `peak_dynamic_fee_pct` all **freeze**; `confirmPeak` skipped by both callers; `getDeterministicCloseRule` → null (3730); poller `continue` before crash/rug detectors (2942–2946) so bin trails go stale; INSTRUCTION not evaluated (hold branch precedes it, 1112 vs 1134); `executeTool close_position|rebalance_position` blocked without `operatorOverride` (executor.js:1435–1451; dlmm.js:3141–3145); `executeManagementActions` suppresses any non CLAIM/STAY action (746–750); OOR notify skipped (1534) and marked "Auto-close disabled (On Hold)"; screening's post-mgmt slot count depends on `maxPositionsExcludeHold`.
- **Still runs**: CLAIM when `unclaimed ≥ minClaimAmount` (1118); `recordTick` capture; pool-memory snapshots, health alerts, PVP, report publish; OOR clock (`markOutOfRange` in pnl.js) keeps counting — on `/unhold` an OOR-below position past 60 min closes on the next 2 poller ticks; reconciliation phantom/orphan handling; manual `/close`, `/closeall`, dashboard close, `/rebalance` (operatorOverride) all work.
- **`maxPositionsExcludeHold`** (`config.risk`, code default **false** since plan-15 §3.4; prod false): index.js:1491–1494 and 1620–1622 count only non-held positions when true (`!== false`); the executor's deploy cap (executor.js:1836) always counts held rows → with true, screener saw free slots the executor refused (187 "Max positions reached" blocks, 09-12→22). Settings menu toggle at 4604.

---

### 7. Telegram / command handlers acting on positions (`index.js`)

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

### 8. Config reference (management section, `config.js:423–763`) — exit-relevant keys

| Key | Code default | Prod (documented) | Used by |
|---|---|---|---|
| stopLossPct | −18 (`?? emergencyPriceDropPct ?? -18`) | **−15** | state STOP_LOSS, RULE_1 |
| takeProfitPct | 5 | unknown | RULE_2, prompt `TP_PCT` |
| trailingTakeProfit / TriggerPct / DropPct / MinPnlPct / OvershootPct | true / 3 / 1.5 / null / 0.5 | 2 / 1.5 | TRAILING_TP |
| adaptiveTrailingMode / inventoryExhaustionMode | "shadow" | shadow | TRAILING_TP |
| profitRatchetEnabled / ArmPct / StopPct | true / 6 / 1.5 | ON / 2 / −2 | PROFIT_RATCHET |
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
| rebalanceEnabled / rebalanceMode / MinOorMinutes / MaxCount / BinsBelow / BinsAbove / TrendTimeframe / TrendCandles / LineageTakeProfitPct | true / "shadow" / 15 / 2 / 35 / 34 / "5m" / 6 / 4.0 | shadow | engine |
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

### 9. Evidence ledger (numbers cited in code/CLAUDE.md/plans)

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

### 10. Correlations, contradictions, dead/inert rules

#### 10.1 Rules overlapping on the same signal
1. **Ratchet vs trailing at 2/1.5** — both arm off `peak_pnl_pct ≥ 2`; trailing fires at `peak − 1.5 ≥ +0.5` before the ratchet's −2 → ratchet inert (CLAUDE.md, replay). It becomes live only if trailing is deferred (close-eff enforce / TWAP) or under `adaptiveTrailingMode=enforce` (8 % trigger leaves a 2–8 % peak window where only the ratchet protects).
2. **Above-range family** — harvest (state.js, pnl ≥1 frozen, ≥5 bins) → RULE_3 (≥50 bins, any pnl) → RULE_3u (≥25 bins, pnl <1) → RULE_4a (≥720 min continuous + stable). Gap: a *filled but still-converting* ladder (pnl ≥1, not frozen) between 25 and 50 bins is held; a frozen ladder with 0 < pnl < 1 at 5–25 bins is held until 25. RULE_4a's clock reset + stability check make it a near-null backstop.
3. **Downside family** — crash (OOR-below, ≥8 bins, ≥12 b/min, 3 ticks, no TWAP) ⊃ rug (in-range, pnl ≤ −3, 12 b/min over ≥60 s) vs OOR-below timer (60 min) vs RULE_1 stop (−15, ~6 s) vs toxic conversion (≥85 % base within 20 min, fees <1.5 %, no pnl condition). With crash/rug OFF, the stop-loss is the only fast downside rule; toxic conversion (ON by default) is effectively a "ladder filled fast with no fees" exit that overlaps crash/rug's territory without a velocity or pnl test and can fire on a benign dip-fill (bidask "dip-entry theses" are only exempt if `initial_base_ratio_pct ≥ 70`).
4. **Yield-decay trio** — position-alerts `yield_decay` (−50 % vs early-window baseline, advisory), SURGE_DECAY `fee_tvl` (−50 % vs peak ≥5 %, exit if enabled), LOW_YIELD/RULE_5 (absolute floor `minFeePerTvl24h`). All read `fee_per_tvl_24h`; only the last is enforced in prod (assuming surge OFF).
5. **Lineage TP ×3** — state.js LINEAGE_TAKE_PROFIT (after trailing), RULE_2' (before RULE_3), mgmt OOR-below branch (only when OOR-below ≥15 min); same 4 % threshold, slightly different fee sums (`cumulative_fees_claimed_sol` vs `+ total_fees_claimed_sol`).
6. **Stop-loss ×2** and **OOR-below ×2** and **low-yield ×2** (state.js vs index.js) — see §4.3; the index.js copies are the ones that actually fire in the poller for stop-loss.
7. **Fee-share/volume alerts feed two consumers** — LLM REVIEW (if autoReview) and OOR-flip GATE 4.
8. **Rebalance roll-up vs harvest** — every harvest hit in prod runs a GeckoTerminal trend fetch (engine `enabled` true) purely to log `[REBALANCE_SHADOW]`.

#### 10.2 Contradictions / inconsistencies found
- **Reason-family leakage**: TOXIC_CONVERSION and SURGE_DECAY(fee_tvl) reasons contain "yield" → bucketed `low_yield` and treated as **fee-death** by `classifyOutcome`; ROUND_TRIP_HARVEST reason contains "above" → bucketed `oor_above` in `/exits`; PROFIT_RATCHET, YOUNG_STOP, RUG_FASTPATH, LINEAGE ("take-profit" hyphen), manual closes all fall to `other`. The index.js keyword discipline (3749–3755) is not applied to state.js strings.
- **RULE_1 urgency** is `true` from the mgmt cycle but the poller derives urgency from the signal string (`RULE_1` ∉ `URGENT_EXIT_ACTIONS`), so the most common stop-loss path is non-urgent for fast-close.
- **Operator `/rebalance` skips pool re-validation** in code (executor.js:2008–2012) while the adjacent comment and CLAUDE.md say only the depth cap is skipped.
- **`isPriceStable` "management ticks"** (config comment 448) are really per-evaluation ticks fed by the 3 s poller.
- **RULE_5 lacks the adoption/history guards** that state.js LOW_YIELD carries; an OOR-above-unstable RULE_4a `return null` also masks RULE_5.
- **Config defaults drifted from CLAUDE.md** (ratchet 6/+1.5, stop −18, RULE_3 10, ratchet enabled true).
- **Crash flag state** — CLAUDE.md says shipped OFF; plan-15 §2 shows 15 crash/rug-family closes since 08-22 → the prod flag history is inconsistent; verify on the VM before relying on either.
- **`hold` freezes `pnl_tick_history`/peak** — after `/unhold`, harvest needs 6 fresh ticks and trailing resumes from the stale confirmed peak (could fire instantly if pnl fell during the hold).
- **Poller cadence documentation** (3 s code default vs "5 s"/"~45 s" in comments) — affects every "N ticks" statement (crash 3 ticks ≈ 9 s only at 3 s).

#### 10.3 Dead or inert under documented prod config
- state.js **STOP_LOSS** action (RULE_1 pre-empts it in both evaluators) → TWAP guard, 15 s timer and STOP_LOSS urgency are unreachable in practice.
- **PROFIT_RATCHET** (inert at trailing 2/1.5; left ON as backstop).
- **RULE_4a OOR-above 720 min** (never fired since Aug).
- **REBALANCE / STAY-wait actions** (rebalanceMode shadow) and therefore **new lineage chains**; LINEAGE_TAKE_PROFIT only on the 4 legacy open chains.
- **REVIEW** (needs `poolHealthAutoReview=true`); **INSTRUCTION** only after `/set`.
- **YOUNG_STOP, TWAP guard, close-eff gate, OOR flip, swap-free redeposit, fee compounding, fast-close skip, slippage cap, exit-swap guard, socket crash, adaptive trailing, inventory exhaustion, re-entry cooldown** — all shadow (log tags: `[YOUNG_SL_SHADOW] [TWAP_GUARD_SHADOW] [CLOSE_EFF_SHADOW] [OOR_FLIP_SHADOW] [SWAP_FREE_SHADOW] [FEE_COMPOUND_SHADOW] [FAST_CLOSE_SHADOW] [SLIPPAGE_CAP_SHADOW] [EXIT_SWAP_GUARD_SHADOW] [CRASH_SOCKET_SHADOW] [ADAPTIVE_TRAILING_SHADOW] [INVENTORY_EXHAUSTION_SHADOW] [REENTRY_SHADOW] [REBALANCE_SHADOW] [RATCHET_SHADOW] [ROUNDTRIP_SHADOW] [SURGE_SHADOW] [RUG_SHADOW] crash_shadow`).
- **SURGE_DECAY** (code default OFF; prod unknown), **range_harvest profile** (`rangeHarvestPools` empty by default), **manageUntracked** false (untracked rows are adopted instead), **skimmer** (prod OFF; even ON it only proposes).
- **RULE_2 absolute TP** — inert if prod `takeProfitPct` ≫ trailing outcomes (local copy 35); dominant if 5. Unresolved.

---

<!-- ===== 04-infrastructure-and-learning.md ===== -->

## Meridian — Infrastructure, Scheduling, Data Stores, Learning Loop, External Platforms

Read-only inventory of `/Users/Angga/Repos/meridian` (branch `experimental`, HEAD `a0fcd12`, 2026-09-25). All paths relative to the repo root; `file:line` cites the local checkout. **Prod values** come from CLAUDE.md and in-code comments — the local `user-config.json` is a near-empty dev copy (only `profitRatchetEnabled`, `stopLossPct=-18`, and an `autoSkim.enabled=true` block are set), so anything marked *(prod per CLAUDE.md)* or *(prod per comment)* is not verifiable from this checkout.

---

### 1. Process topology (VM)

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

### 2. Scheduler inventory (index.js `startCronJobs()` :2553-3511)

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

### 3. External platforms

#### 3.1 Solana RPC / Helius

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

#### 3.2 Meteora

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

#### 3.3 Jupiter

| Purpose | Endpoint | Where | Auth | Notes | Cite |
|---|---|---|---|---|---|
| Token prices (never cached; symbols cached) | `GET https://datapi.jup.ag/v1/assets/search?query=<mint,…>` | `tools/pnl.js:32, 149-165`; `tools/wallet.js:98` | none | called every 3s tick and every AUM sample; failure → `pnl_price` log, prices `{}` | |
| Token info / audit / holders / narrative | `…/assets/search?query=`, `…/holders/<mint>?limit=100`, `…/holders/<mint>?addresses=`, `…/pnl-positions?address=&assetId=`, `…/chaininsight/narrative/<mint>` | `tools/token.js:4, 22, 36-38, 118-121, 153-157, 197, 214`; `tools/screening.js:807` | none | Safety-enrich cache 30 min/mint (`tools/screening.js:109`); serialized holder fetch delay against burst 429s (`:1483`). | |
| Swap quote (read-only) | `GET https://api.jup.ag/swap/v2/order?…&referralAccount&referralFee` (+`skip_taker`) | `tools/wallet.js:458-504` | `x-api-key` = `config.jupiter.apiKey` \|\| `JUPITER_API_KEY` \|\| **hard-coded default key** (`:139-142`) | used by exit-swap guard, close-efficiency gate, slippage cap | |
| Swap execute | `GET …/order` then `POST …/execute` | `tools/wallet.js:506-640` | same; referral `JUPITER_REFERRAL_ACCOUNT` (default hard-coded) / `JUPITER_REFERRAL_FEE_BPS` 50 (`config.js:962-968`); `slippageBps` omitted → RTSE unless `swapSlippageCapEnabled` | `DRY_RUN` short-circuit `:521` | |
| `JUPITER_PRICE_API = https://api.jup.ag/price/v3` | defined `tools/wallet.js:137` | | | **dead constant — never referenced** | |

#### 3.4 GMGN (`tools/gmgn.js`)

- Base `config.gmgn.baseUrl` \|\| `https://openapi.gmgn.ai` (`:90`); key `config.gmgn.apiKey` \|\| `GMGN_API_KEY` (`:65, 784-786`); config from `gmgn-config.json` (written by `update_config`, `tools/executor.js:1124-1167`). IPv4 forced (`:9`).
- Live calls all hit `/v1/token/info?chain=sol&address=<mint>` through a 5-min in-flight-promise cache (`:793-816`) feeding `getGmgnTokenFees`/`getGmgnSafetyInfo`/`getGmgnDevInfo`/`getGmgnSmartMoneyInfo`/`checkGmgnSmartExodus` (`:817-917`).
- Pacing: `config.gmgn.requestDelayMs` 2500 × weight multiplier {1:1, 2:1.5, 3:2.2, 5:3.5}; weights by path regex (`:44-62`).
- **IP ban / 429 handling**: `res.status===429` or `/rate limit|temporarily banned/` → `"temporarily banned"` enters cooldown `banCooldownMinutes` 180; persistent 429 after `Retry-After`-based backoff → cooldown `rateLimitCooldownMinutes` 15 (`:14-32, 120-137`). All callers fail open to the Jupiter audit.
- Also fetches Meteora discovery for `screeningSource=gmgn` (`:10, 355-380`) — not the prod path.

#### 3.5 GeckoTerminal (`tools/rebalance-trend.js`)

`GET https://api.geckoterminal.com/api/v2/networks/solana/pools/<pool>/ohlcv/<minute|hour>?aggregate=&limit=` (`:19`), 6s abort, no key; non-OK (incl. 429) → `candle_warn` log + `[]` (`:24-27`). Consumer: `isRebalanceTrendIncreasing` for the roll-up/rebalance trend gate (`index.js:3124, 72`). No caching → one call per round-trip/OOR decision in enforce mode. (CLAUDE.md's "GeckoTerminal 429" behaviour is just the generic non-OK branch — there is no dedicated 429 backoff.)

#### 3.6 LPAgent / Agent Meridian API

| Purpose | Endpoint | Auth | Notes | Cite |
|---|---|---|---|---|
| Top-LPer study (screener `top_lpers:` line, `simulate`/`study` tools) | `GET https://api.agentmeridian.xyz/api/top-lp/<pool>` + `/study-top-lp/<pool>` | `x-api-key` = `config.api.publicApiKey` \|\| `PUBLIC_API_KEY` \|\| hard-coded default (`config.js:11, 878-880`; `tools/study.js:3-8`) | 429 → throws "Rate limit exceeded… wait 60 seconds"; `lper-signal.js` caches 30 min/pool and degrades to null (`:14-30`) | |
| Discord signal candidates | `GET …/api/signals/discord/candidates` | same | `tools/screening.js:468-475` | |
| Chart indicators (`config.indicators.enabled`, default false) | `GET …/api/chart-indicators/<mint>?interval&candles&rsiLength` | same | `tools/chart-indicators.js:214-244` | |
| LPAgent direct | `GET https://api.lpagent.io/open-api/v1/lp-positions/opening?owner=` | `LPAGENT_API_KEY` (optional; no key → `{}`) | `tools/dlmm.js:1840-1868` — legacy enrichment, effectively inert without the key | |

#### 3.7 HiveMind (`hivemind.js`)

- Base `config.hiveMind.url` = user `hiveMindUrl` \|\| **`https://api.agentmeridian.xyz`**; key = user `hiveMindApiKey` \|\| `HIVEMIND_API_KEY` \|\| **built-in default** (`config.js:9-12, 871-876`). `isHiveMindEnabled()` = both non-empty (`:85-87`) → **enabled by default** with the shipped constants. ⚠️ CLAUDE.md ("enabled by setting `HIVE_MIND_URL`/`HIVE_MIND_API_KEY`") names env vars the code never reads.
- Endpoints (all `x-api-key`): `POST /api/hivemind/agents/register` (boot + 15-min heartbeat, `:166-187`), `/lessons/pull`, `/presets/pull` (auto mode), `POST /lessons/push` (each derived lesson, `lessons.js:193`), `POST /performance/push` (each close, `lessons.js:249-254`). Cache file `hivemind-cache.json`; `agentId` written to `user-config.json` (`:89-101`). `dryRun` flag sent in register payload (`:179`).

#### 3.8 Telegram (`telegram.js`)

- `TOKEN=TELEGRAM_BOT_TOKEN`, `BASE=https://api.telegram.org/bot<token>` (`:26-27`); chat id from `TELEGRAM_CHAT_ID` or user-config `telegramChatId`; inbound allow-list `TELEGRAM_ALLOWED_USER_IDS` (`:28-33`).
- Transport `postTelegram` (`:128-201`): **429** → honour `parameters.retry_after` (+1s) up to 3 attempts except `sendChatAction`; **401** → token hint (mentions the `.envrypt` key); **HTML parse failure** (`"can't parse entities"`, i.e. unclosed/unescaped tags) → strip all tags, unescape entities, resend as plain text (`:163-175`); network failure → 2s·2^n retry ×3 (`:187-198`). `sendMessage` ids recorded to `.telegram-marker.json` (`telegram-marker.js`) for the rolling-bubble logic.
- Long poll `getUpdates?offset&timeout=30` (`:633-672`); `setMyCommands` with `BOT_COMMANDS` (`:676-697`).
- Notification builders: `notifyDeploy` (:722), `notifyClose` (:763), `notifySwap` (:807), `notifyRebalance` (:910), `notifyOutOfRange` (:920, gated in `index.js:1532-1560`: only when the cycle notifies, `minutes_out_of_range >= outOfRangeWaitMinutes`, direction limit not null, not held). Other senders via `sendHTML`: adoption (`index.js:2699`), drift/phantom/orphan/PnL-discrepancy (`state.js:3449-3511`), exit review (`lessons.js:445-465`), starvation relaxer (`index.js:2474`), deposit/withdrawal (`:3431-3441`), skim + proposal (`:3455-3482`), smart-money exodus (`:3055-3062`), briefing, health, circuit breaker, plus watchdog/syncer/db-backup from their own processes.
- Command surface (`index.js:5817-6730`, help text `:5236-5283`): `/manage /positions /status /wallet /pool /health /briefing /close /rebalance /hold /unhold /adopt /closeall /set /unset /screen /candidates /deploy /cri /timing /exits /config /settings /setcfg /skim /pause /resume /hive /agy /sessions /gitstatus /gitpull [force] /restart /sync /cooldowns`; REPL-only `/stop /thresholds /learn /evolve` (`:6911-7026`).

#### 3.9 LLM (Ollama cloud / OpenRouter / claude-cli)

- Client: OpenAI SDK, `baseURL = LLM_BASE_URL || https://ollama.com/v1`, key = `OLLAMA_API_KEY || LLM_API_KEY || OPENROUTER_API_KEY` on Ollama (reverse precedence otherwise), 5-min timeout, `Connection: close` (`agent.js:108-128`). `reasoning_effort = LLM_REASONING_EFFORT || "low"` only for Ollama (`:118-120, 323`).
- Models per role from `config.llm.{managementModel,screeningModel,generalModel}` (legacy DeepSeek ids normalized to `glm-5.3-flash`, `config.js:14-24, 805-812`); `maxTokens` 4096, `maxSteps` 20, `temperature` 0.373.
- Fallback chain (`agent.js:132-137, 280-380, 637`): transient 429/502/503/529 → retry ×3 with backoff; on 502/503/529 at attempt 1 switch to `PROVIDER_FALLBACK_MODEL` = Ollama: `LLM_FALLBACK_MODEL || primary`; OpenRouter: `deepseek/deepseek-v4-flash-vision-exp`. Provider quirks retried: system role rejected, `tool_choice=required` unsupported, thinking+tool_choice.
- **claude-cli backend** (`llm-cli.js`): `claude -p --output-format json --model <suffix> --no-session-persistence [--effort <role>]` (`:268-269`); `CLAUDE_EFFORT_BY_ROLE` SCREENER/GENERAL medium, MANAGER low (`:38`); rate-limit text parsed (`resets in N minutes` / `resets 10pm (TZ)`) → module cooldown; failure/limit → OpenRouter path with `claudeCliFallbackModel` (`config.js:831`); `claudeCliTimeoutMs` 240000. Dormant unless a role model is `claude-cli/…`.
- Bear debate (`llm-verdicts.js`) — prod `bearDebateEnabled=false`.

#### 3.10 Pionex skimmer (`tools/transfer.js`)

Destination `PIONEX_DEPOSIT_ADDRESS` \|\| `autoSkim.destinationAddress` (`:97`); status math: `netCapitalAtRisk = total_deposited − total_withdrawn`, `surplus = equity − targetWorkingCapitalSol (6.2529)`, 24h cap `max(in-memory transfers, persisted baseline withdrawals)` vs `maxDailyTransferSol` 2.0, `minTransferAmountSol` 0.5, `minWalletReserveSol` 0.1, `transferIntervalMin` 60 (`:20-24, 95-180`). `transferSol` simulates, broadcasts a `SystemProgram.transfer` via RPC_URL, appends to `baseline.withdrawals` (`:190-312`). `checkAndExecuteAutoSkim` returns `confirmation_required` unless `requireTelegramConfirmation===false` (`:351-390`); `/skim now` executes.

---

### 4. Persistence

#### 4.1 Backend switch & design
- `PERSIST_BACKEND` (`json` default, **prod `pg`**) read by `usePg()` (`db/pool.js:16`). `pg.Pool` max `PG_POOL_MAX` 5, idle 30s, connect 10s; libpq env vars (`:23-34`); `withTransaction` (`:45-58`).
- **Sync API over async store**: `makeDocStore(name, file, empty)` (`db/doc-store.js:25-79`): in-memory `cache`, `get()` sync (throws under pg if not primed), `set()` replaces cache then chains an `INSERT … ON CONFLICT` into `kv_store` on a per-store `writeChain` (json: temp+rename). `initAllDocStores()`/`flushAllDocStores()` (`:88-96`) wired into boot/shutdown/cli.
- **state.js** (`:147-446`): cache `_cache`; `save()` stamps `lastUpdated`, diffs each position JSON against `_lastPersisted`, queues upserts/deletes + `_pendingEvents` + the `meta` object, chains `persistNormalized()` (one transaction: `positions` upsert w/ promoted columns, `position_events` insert, **all `META_KEYS` upserted unconditionally**). On failure `_lastPersisted` is rolled back + `recordError("state_corruption")`. json backend: `state.json.tmp` → copy `.bak` → rename; corrupt file + no bak → rename to `state.json.corrupt-<ts>` and **throw (halt)** (`:175-205`).
- `META_KEYS` (`:229`): `baseline, cumulative_gas_sol, _lastBriefingDate, recentEvents, lastUpdated, _circuitBreaker, _screeningStarvation, _deferredExitSwaps` — must also appear in `hydrateFromPg` (`:270-287`) and the `save()` meta object (`:346-355`) or round-trip to null. `walletAddress` is a 9th singleton written only by `persistWalletAddress` (`:424-435`).
- **Clobber race**: because `save()` rewrites every singleton from cache, any external writer (`cli.js baseline`, scripts) loses on the agent's next save/flush. `cli.js` primes + flushes but cannot avoid this (CLAUDE.md known issue).
- Crash-safety under pg: write-behind loss is healed by `reconcileStateWithChain` (15-min) and the discovery path.

#### 4.2 Tables (migrations `db/migrations/001-006`)

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

#### 4.3 kv docs — shape & caps

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

#### 4.4 Files still written outside the DB (survive `reset --hard`, gitignored)
`.env` (+ `.envrypt` key), `user-config.json` (4 writers: `update_config` non-atomic `tools/executor.js:1163`, evolution atomic `lessons.js:769-774`, `hivemind.js ensureAgentId:97`, `config.js` reload), `gmgn-config.json`, `.heartbeat`, `.force-sync`, `.telegram-marker.json`, `.telegram-rolling.json`, `hivemind-cache.json`, `logs/agent-YYYY-MM-DD.log`, `logs/actions-YYYY-MM-DD.jsonl`, `logs/snapshots-*.jsonl`, `daily-briefings/` (json fallback only), legacy `*.json` stores (cold copies).

---

### 5. Learning loop

#### 5.1 `recordPerformance(perf)` (`lessons.js:115-267`) — called from `closePosition` (before the exit swap), external-close reconcile, rebalance legs
1. Guards: unit-mix (`initial_value_usd ≥ 20 && amount_sol ≥ 0.25 && final ≤ 2·amount_sol` → skip, `:121-133`); absurd (`pnl_pct ≤ −90` on non-stop-loss with initial ≥ 20 → skip, `:140-152`).
2. `pnl_usd = (final_value_usd + fees_earned_usd) − initial_value_usd`; `pnl_pct = pnl_usd / initial_value_usd × 100`; `range_efficiency = minutes_in_range / minutes_held × 100` (`:133-139`). ⚠️ `*_usd` carry SOL under `solMode`.
3. `pnl_sol_net = pnl_sol − (total_gas_sol ?? gas_cost_sol ?? 0)`; `unit_era: "v3"`; `signal_snapshot` from `PERFORMANCE_SIGNAL_FIELDS` + intel dims (`:40-53, 71-113, 160-180`). Later amended by `recordExitSwapOutcome` (`exit_swap{}`, `pnl_usd_net_exit_swap`, slippage folded into `pnl_sol_net`, `:293-335`) and probes (`post_close{}`).
4. `derivLesson` → `pushPerformanceLesson` (dedup by first 60 chars, cap 60) → `pushHiveLesson` (`:185-193`).
5. `recordPoolDeploy` mirror into pool-memory (`:195-225`, cooldown logic `pool-memory.js:223-247`).
6. **Every 5th close** (`length % 5 === 0`): if `config.screening.evolutionEnabled === false` → log and **`return`** (`:226-232`); else `evolveThresholds` + `reloadScreeningThresholds`, then Darwin `recalculateWeights` if `config.darwin.enabled` (`:233-247`).
7. `pushHivePerformanceEvent` (`:249-254`), then `checkCircuitBreaker`/`tripCircuitBreaker` (`:257-265`).
   ⚠️ Because of the early `return` in step 6, **with prod `evolutionEnabled=false` every 5th close skips steps 7 (hive performance push AND the circuit-breaker trip check) and Darwin recalculation** — see correlations.

#### 5.2 `classifyOutcome(perf)` (`lessons.js:939-961`)
`feeYield = fees_earned_usd / initial_value_usd × 100`; `isFeeDeath = reason∋"yield"`; `isStopLoss = reason∋"stop loss"`; `isOorCollapse = reason∋(oor|out of range|below) && pnl<0`; `rangeEff` default 100.
- **failure** if `isStopLoss || pnl ≤ −5 || (isFeeDeath && feeYield < 1) || isOorCollapse || (rangeEff < 30 && pnl < 0)`
- **success** if `!isFeeDeath && (pnl ≥ 2 || feeYield ≥ 2)`
- else **neutral**.

#### 5.3 `derivLesson` (`:547-644`) — only success/failure produce a lesson. Rules: `AVOID` (bad, range_eff<30), `PREFER` (good, range_eff>80), `AVOID volume collapse`, `WORKED`, `FAILED`. Confidence: good 0.82 if `feeYield≥1 || fees≥3 || pnl≥3` else 0.22; bad 0.88 if `pnl≤−5 || range_eff≤30 || reason∋oor/low yield/volume` else 0.45.

#### 5.4 `evolveThresholds(perfData, config)` (`:658-754`) — constants `:21-38`
- Needs ≥ `MIN_EVOLVE_POSITIONS` 5 records; operates on `window = last RECENCY_WINDOW (40)` closes; `curRate = successes/(successes+failures)`.
- **Auto-revert** (`:676-690`): last `type:"adjust"` evolution not `_superseded` with `curRate < metric_before − REGRESSION_MARGIN (0.08)` → restore each `from` value, mark superseded, persist as `type:"revert"` and return.
- **Floor raises** (`:694-712`) only if ≥ `MIN_GROUP_SAMPLE` 3 successes AND 3 failures. For each of `minFeeActiveTvlRatio` (`fee_tvl_ratio`), `minOrganic` (`organic_score`), `minIntelScore` (`signal_snapshot.intel_total`): `adjustFloor` (`:756-767`) requires `mean_s − mean_f > 0` and Cohen's-d `≥ EFFECT_SIZE_MIN 0.35` (pooled sd, `:925-931`); `target = max(p50(failures), 0.95·p25(successes))`; `moved = clamp(nudge(cur, target, MAX_CHANGE_PER_STEP 0.20), bounds)`; rounded (2dp for fee ratio, int otherwise); only raises.
- `EVOLVE_BASELINES = {minFeeActiveTvlRatio 0.05, minOrganic 60, minIntelScore 52}`; `EVOLVE_BOUNDS = {fee 0.05–0.60, organic 55–85, intel 52–70}` (`:34-39`). ⚠️ Prod runs `minIntelScore=61` (log yield mode) — inside bounds, but the relaxer's baseline 52 predates the 2026-08-22 re-baseline (`:30-33` comment).
- **Organic-momentum** (`:715-731`): if `analyzeOrganicMomentumOutcomes(window)` is `ready` and verdict matches `/signal works/` → nudge `organicMomentumDecayTraderPct` toward −15 (clamp −40..−10); `count ≥ 12` → `organicMomentumHardFilter=true`.
- **Throughput relaxer** (`:735-747`): if nothing changed and `closesPerDay(window) < STARVATION_CLOSES_PER_DAY 1.5` → `computeStarvationStep` lowers the floor furthest above baseline (ratio > 1.01) by ≤20% toward baseline.
- `persistEvolution` (`:776-812`): atomic `user-config.json` write (root keys + `_lastEvolved`, `_positionsAtEvolution`), live `config.screening[k]=v`, `evolutions.push({ts,type,positions,window,metric_before,changes{from,to},rationale})` cap 50, plus an `[AUTO-EVOLVED|AUTO-REVERT]` lesson.

#### 5.5 Cycle-based starvation relaxer (`index.js:2438-2486`; `lessons.js:826-881`)
State `_screeningStarvation {emptyCycles, lastRelaxedAt}` (state_meta). `reachedLLM` resets to 0. Else `emptyCycles++`; when `≥ starvationRelaxAfterEmptyCycles (12)` and `now − lastRelaxedAt ≥ starvationRelaxCooldownHours (3)·3600s` → `applyStarvationRelaxation` (same `computeStarvationStep`, `persistEvolution type:"adjust"`), `lastRelaxedAt` advanced regardless, Telegram if a floor moved. Only lowers the three evolution-owned floors; `minTvl/minMcap/minVolume/minHolders` are never touched. Verdict-cache skips set `candidatesReachedLLM` before the check so they don't count as starvation.

#### 5.6 Darwin signal weights (`signal-weights.js:96-200`)
Config `darwin` (`config.js:834-843`): enabled true, `windowDays` 60, `recalcEvery` 5 (unused — the cadence is the `%5` in recordPerformance), `boostFactor` 1.05, `decayFactor` 0.95, floor 0.3, ceiling 2.5, `minSamples` 10. Lift per signal (numeric: win/loss value split; boolean: win-rate present vs absent; categorical). Weights injected into prompts via `getWeightsSummary`. Captured at deploy via `signal-tracker.js` staging (10-min TTL).

#### 5.7 Post-close probes & exit quality (`index.js:649-687`; `lessons.js:337-546`)
`pct = (mcap_m / exit_mcap − 1)·100`; anchor m60 → m180 → m30; `flat` if |pct| < 3; `good_exit` if saved ≥ 8; `early_exit` if missed ≥ 8; else `marginal`; `delisted` when the detail fetch throws or mcap is 0/null; `stale` slot if past `m + 20` min; `unprobeable` if no `exit_mcap`. `complete` + `exit_quality` once every slot resolved. Exit review Telegram only for good/early/delisted on the anchor write. `getExitQualitySummary({limit:30})` groups by `reasonFamily` (stop_loss, crash, trailing_tp, take_profit, oor_below, oor_above, oor_other, low_yield, volume_death, other) with `selling_bottoms = n≥6 && early>good`.

#### 5.8 Decision log — `appendDecision` calls: timing-gate skip, circuit-breaker skip, SOL-vol skip, max-positions/insufficient-SOL skips, deploy/no_deploy verdicts (`index.js:1604,1615,1650,1707,1854,1889,2301,2318,2338`). Injected into prompts via `getDecisionSummary`.

#### 5.9 Ledger truth (`ledger-truth.js`)
`book = aumEnd − aumStart − deposits + withdrawals`; `Δunreal = unrealEnd − unrealStart`; `drift = book − ledger − Δunreal`; `ledger_fidelity_pct = ledger/(book − Δunreal)·100` when |book−Δunreal| > 0.05 (`:28-43`). `aumAt` = median `snapshot.totalSol` of `balance_history` within ±15 min, else last row ≤ t (`:46-60`). `unrealizedAt` = Σ `pnl_pct/100 × positions.data.amount_sol` using the latest `price_ticks.pnl_pct` ≤ t within 30 min for positions open at t (`:63-80`). `flowsBetween` from state_meta `baseline.deposits/withdrawals` timestamps (`:82-88`). `ledgerBetween` = Σ `pnl_sol_net` (fallback `pnl_sol − total_gas_sol`) over perf `recorded_at` in window, counting `adopted && !adoption_lifetime` as `adopted_lifetime_scored` (`:90-106`). Windows 24h + 7d; pg-only, never throws.

#### 5.10 Circuit breaker (`circuit-breaker.js`) — trips screening on consecutive-loss streak or 24h drawdown % (config `risk.*`), state in state_meta `_circuitBreaker`, auto-reset after cooldown; checked at every screening entry (`index.js:1590`) and after each close (subject to the §5.1 early-return caveat).

---

### 6. Report & briefing outputs

**`dashboard-report` doc** (`report.js:105-256`, published every mgmt cycle incl. 0 positions, on screening skips, and by the poller on a new position): `ts, sol_mode, sol_price_usd, next_screen_sec, positions[] (pair, pool, position, in_range, minutes_out_of_range, age_minutes, bins, pnl_* dual-currency, fees, action{action,rule,reason}, health_alerts[], pvp, bins[] histogram, pnl_ticks, peak_pnl_pct, ratchet_armed, trailing_active, stop_pct, trailing_floor_pct, token/liq/fee breakdown, price_lower/upper/active), totals{value_sol,value_true_usd,unclaimed_sol,unclaimed_true_usd}, baseline{total_deposited, deposit_count, last_deposit_at, total_withdrawn, withdrawal_count}, performance{total_pnl_sol, total_pnl_usd, closed, win_rate_pct_legacy, outcome_breakdown, fee_efficiency_validation, organic_momentum_validation}, exit_quality, ledger_truth, held_tokens (from `_lastSampledAum`, ≤1 cycle stale), timing_line, crash_shadow_count_48h (greps today's+yesterday's log files), crash_fast_path_enabled, screening_funnel`. Then `flush` → `NOTIFY meridian_report`. Poller `NOTIFY meridian_tick` payload `{ts, complete, positions[]}` tier-stripped to < 7500 bytes (`index.js:3218-3288`).

**Briefing lines** (`briefing.js:41-320`): AUM headline (`💼 AUM ◎ ($) · 24h % · ROI %` from `balance_history` last 300 + baseline), Activity opened/closed 24h, Performance 24h (Net PnL, Fees, Win %, Best/Worst), Portfolio now (live value/unclaimed/open + per-position lines), All-time era-split totals, lessons 24h, deploy-timing line, `🚪 Exits:` line, `🧾 Wallet truth` ledger line, evolution/threshold drift. Saved to kv `daily_briefing:*`.

---

### 7. Logging (`logger.js`)
- `log(category, msg)`: level inferred from category substring (`error`→error, `warn`→warn, else info) vs `LOG_LEVEL` (default info); stderr + `logs/agent-<local date>.log` (daily rotation by filename; no size cap, no deletion) (`:43-60`). Timestamps local-tz with offset (`:19-28`). `redactSecrets` scrubs `api-key|api_key|apikey|rebate-address` query params (`:33-37`).
- `logAction(action)` → console one-liner + `logs/actions-<date>.jsonl` full JSON (`{timestamp, tool, args, result(summarized), duration_ms, success}`), fail-open on EACCES (`:87-108`); called from `executeTool` (`tools/executor.js:1472, 1699`).
- `logSnapshot` → `logs/snapshots-<date>.jsonl` (`:113-124`).
- Tag inventory (repo-wide, count of call sites): `state` 65, `screening` 53, `cron` 32, `cron_warn` 26, `agent` 26, `telegram_error` 25, `cron_error` 22, `executor` 19, `rebalance` 18, `deploy` 17, `close`/`close_warn` 17, `gmgn` 14, `socket_monitor(_error)` 12/12, `wallet` 9, `startup` 9, `state_error` 8, `safety_block` 7, `lessons` 7, `evolve` 5, `rpc_health` 5, `tx_retry` 5, `signal_weights` 5, `compound` 5, … plus the shadow tags `crash_shadow, rug_shadow, crash_socket_shadow, oor_flip_shadow, swap_free_shadow, close_eff_shadow, fast_close_shadow, exit_telemetry, rpc_rate_limit, rpc_quota, rpc_capability, rpc_failover, rpc_metrics, ledger_truth(_warn), probe(_warn), auto_skim(_warn/_error), transfer(_warn/_error), claude, claude_cli, bear_debate, candle_warn/error, memory/memory_warn, shutdown, command(_error), report_warn, hivemind(_warn)`. Bracketed in-message markers used for grepping: `[SCREENING] funnel:`, `[VERDICT_CACHE]`, `[RANK_SHADOW]`, `[REPORT]`, `[PNL_DISCOVERY]`, `[RECONCILIATION]`, `[WS_HEALTH]`, `[TICK]`, `[EXIT_TELEMETRY]`, `[LEDGER_TRUTH]`, `[ADOPTION_BASIS]`, `[TVL_EXEMPT]`, `[Balance History]`, `[Force Sync]`, `[Opportunity]`.

---

### 8. Env & secrets
- `envcrypt.js` (imported first by `index.js:4`, `cli.js`, replay/extract and most scripts): `dotenv.config({path: .env, override: true})` — **`.env` wins over shell/PM2 env** (`:72-74`); values under a `# encrypted` marker are XOR+base64 decrypted with `ENVRYPT_KEY`/`ENVCRYPT_KEY`/`.envrypt` file (`:35-47, 55-70, 84-90`); keys auto-selected for encryption when `*_KEY` or matching `PRIVATE|SECRET|TOKEN|PASSPHRASE|PASSWORD|MNEMONIC` (`:48-53`). `npm run env:encrypt` → `scripts/envrypt.js`.
- `config.js:83-87` back-fills `LLM_MODEL`, `LLM_BASE_URL`, `DRY_RUN` from user-config with `||=` (env wins). Fallback secrets (`rpcUrl`, `walletKey`, `llmApiKey`, `gmgnApiKey`) may be read from `user-config.json` — scrubbed in prod 2026-06-30.
- Env vars referenced: `WALLET_PRIVATE_KEY, RPC_URL, RPC_URL_FALLBACK_1/2, RPC_INDEXED_URL(_FALLBACK_1/2), PNL_RPC_URL, PNL_RPC_URL_ALT, PNL_RPC_URL_FALLBACK, HELIUS_API_KEYS, HELIUS_API_KEY(_ALT/_FB/_FALLBACK), OLLAMA_API_KEY, LLM_API_KEY, OPENROUTER_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_FALLBACK_MODEL, LLM_REASONING_EFFORT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ALLOWED_USER_IDS, DRY_RUN, PERSIST_BACKEND, PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, PG_POOL_MAX, PG_BACKUP_DIR, PG_BACKUP_KEEP, TICK_STORE_DISABLED, JUPITER_API_KEY, JUPITER_REFERRAL_ACCOUNT, JUPITER_REFERRAL_FEE_BPS, GMGN_API_KEY, LPAGENT_API_KEY, HIVEMIND_API_KEY, AGENT_MERIDIAN_API_URL, PUBLIC_API_KEY, PIONEX_DEPOSIT_ADDRESS, MERIDIAN_COMMAND_PORT/HOST/TOKEN, LOG_LEVEL, ENVRYPT_KEY/ENVCRYPT_KEY, HEARTBEAT_FILE, STALE_THRESHOLD_MS, CHECK_INTERVAL_MS, HEAP_WARN_MB, LOOP_LAG_WARN_MS`.
- **`DRY_RUN=true`** short-circuits: deploy (`tools/dlmm.js:1268`), claim (`:2872`), compound (`:2960`), close (`:3146`), flip (`:4004`), rebalance (`:4193`), swap (`tools/wallet.js:521`), ATA sweep (`:1059`), cooldown gates skipped (`tools/dlmm.js:1117,1125`), executor swap check (`tools/executor.js:1986, 2030`), screening balance pre-checks (`index.js:1651, 3325-3328`); reported in `/config`, `/command/health`, hive register. `cli.js --dry-run` sets it (`cli.js:17`). Persistence, Telegram, LLM calls and DB writes are **not** suppressed.

---

### 9. Correlations, collisions, duplication, SPOFs, dead/inert

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
