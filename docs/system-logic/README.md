# Meridian — System Logic Reference (2026-09-25)

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

## 1. The loop at a glance

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

## 2. Capital and risk frame (production values)

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

## 3. Discovery and admission (summary; full detail in `01-…`)

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

## 4. Deploy execution (summary; full detail in `02-…`)

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

## 5. Monitoring and the exit stack (summary; full detail in `03-…`)

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

## 6. After the close: records, learning, truth

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

## 7. Platforms and tech stack

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

## 8. Evidence base

All figures from the production Postgres ledger unless stated. "SOL" sums use `pnl_sol_net` where
present (net of gas and exit slippage), else `pnl_sol`. Note the ledger caveat in §8.6.

### 8.1 Closes since 2026-08-22 by exit family (plan #15 §2, 433 closes to 09-24)

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

### 8.2 Closes since 2026-08-22 by segment (462 closes to 09-25)

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

### 8.3 Entry TVL band since 2026-08-22 (bot deploys only)

| Band | n | avg % | disasters (≤ −10%) | worst |
|---|---|---|---|---|
| 100–200k | 84 | +0.09 | 6 | −36.4 |
| ≥ 200k | 80 | −0.82 | 11 | −41.0 |
| unknown entry TVL | 23 | −1.79 | 3 | −79.0 |
| < 100k | 3 | +0.15 | 0 | 0.0 |

The Jul 27 finding ("≥100k = zero disasters") **no longer holds** in the Aug–Sep era: 17 disasters
above the floor. The floor still binds the universe (see §3 funnel) but is not buying safety.

### 8.4 Holding time since 2026-08-22

| Held | n | avg % | Σ SOL |
|---|---|---|---|
| < 30 min | 158 | +0.50 | +1.21 |
| 30 min – 2 h | 91 | +0.96 | +0.56 |
| 2 – 6 h | 94 | +1.77 | +1.52 |
| 6 – 24 h | 84 | +0.80 | +1.99 |
| > 24 h | 35 | −4.90 | +1.46 (held cohort, lifetime-scored) |

### 8.5 AUM path (daily mean total SOL, `balance_history`)

Aug 22 11.85 → Aug 28 12.55 → Sep 4 2.08 → Sep 9 13.18 → Sep 14 7.56 → Sep 21 2.45 → Sep 25 2.15.
Operator flows over the same span: −8.91 withdrawn, +1.75 deposited; book result −2.50 SOL to Sep 24,
of which −3.35 was unrealised on held positions (plan #15 §1). The swings on Sep 4→9 and Sep 14→21
are operator withdrawals/deposits, not trading.

### 8.6 Ledger truth since it went live (2026-09-24)

| At (UTC) | 24h book | 24h ledger | 24h drift | 7d book | 7d ledger | 7d drift | fidelity |
|---|---|---|---|---|---|---|---|
| 09-24 05:11 | −0.24 | +0.02 | −0.12 | −4.22 | −1.69 | −1.41 | 54% |
| 09-24 13:11 | −0.22 | +0.03 | −0.10 | −4.94 | −1.87 | −1.88 | 50% |
| 09-24 21:11 | −0.08 | +0.03 | −0.05 | −3.52 | −0.47 | −2.07 | 19% |
| 09-25 01:11 | −0.07 | −1.85 | +0.90 | −3.76 | −2.35 | −1.21 | 66% |

The 7-day ledger still understates the wallet's loss by 1–2 SOL (adopted rows without a basis, exit
slippage before `pnl_sol_net`, unrecorded rebalance legs). The +0.90 on 09-25 is the operator's two
KNOB closes at −55%/−68% being lifetime-scored while the unrealised estimate for them was −36%.

### 8.7 Replay / study results that shaped current rules

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

## 9. Production configuration snapshot (2026-09-25, secrets redacted)

Values that differ from code defaults are marked ▲. Keys not listed are at code default.

**Capital / cadence**: deployAmountSol 0.4 · maxDeployAmount 3.2 ▲ · positionSizePct 0.5 ▲ · gasReserve 0.05 · minSolToOpen 0.45 (no consumer) · maxPositions 5 ▲ · maxPositionsExcludeHold false · managementIntervalMin 3 ▲ · screeningIntervalMin 15 ▲ · pnlPollIntervalSec 5 · pnlSource rpc · solMode true.

**Screening**: screeningAdmissionMode rank ▲ · timeframe 1h ▲ · category trending · minTvl 100000 ▲ · maxTvl 800000 ▲ (executor only) · minMcap 300000 ▲ · maxMcap 10M · minHolders 500 · minLps 5 (gate only) · minVolume 1000 · minOrganic 60 · minQuoteOrganic 70 · minFeeActiveTvlRatio 0.05 · minBinStep 80 / maxBinStep 125 · minTokenAgeHours 2 / max 720 · minTxPerMin 5 · minVolumeTvlRatio 0.05 · maxBotHoldersPct 38 ▲ · maxTop10Pct 60 · maxBundlePct 35 · minTokenFeesSol 30 · minIntelScore 52 (gate key; relaxer-lowered) · rankMinIntelScore 61 ▲ · rankSteadyMinIntel 42 ▲ · rankSteadyEnvelopeEnabled true ▲ · steadyLanePlaystyle single_account ▲ · steadyLaneShape spot · intelYieldWindowMode log ▲ · safetyEnrichMode log_only ▲ · scoutTierEnabled true ▲ (scoutSizeSol 0.15, scoutMaxPositions 2, scoutMinIntel 78) · probeTierEnabled true ▲ · topPerformersEnabled true (limit 10, minTvl 15000, requireTrend true, 6×5m) · organicMomentumHardFilter true (inert in rank mode) · organicMomentumDecayTraderPct −18 · tvlDrainEnabled true (−30%) · rugFilterMode log_only · timingGateEnabled true ▲ (floor 0.3, size_down) · repeatDeployCooldownEnabled false · repeatDeployCooldownLosersOnly true · poolReentryCooldownEnabled false · bearDebateEnabled false · evolutionEnabled false ▲ · darwinEnabled true · chartIndicators.enabled true (gate only) · circuitBreaker −15% / 6 losses / 6 h · solVolatilityThresholdPct 8.

**Management / exits**: stopLossPct −15 · takeProfitPct 35 · trailingTriggerPct 2 / trailingDropPct 1.5 / trailingOvershootPct 0.5 / trailingMinPnlPct null · profitRatchet on, 2 / −2 · adaptiveTrailingMode shadow · inventoryExhaustionMode shadow · outOfRangeBinsToClose 50 · outOfRangeBinsToCloseUnfilled 25 ▲ / unfilledMaxPnlPct 1.0 · outOfRangeWaitMinutes 60 / Above 720 / Below 60 · oorAboveStableTicks 2 · minFeePerTvl24h 1 · minAgeBeforeYieldCheck 120 · crashFastPathEnabled true ▲ · inRangeRugEnabled true ▲ · youngStopEnabled true (shadow) · toxicConversionEnabled true (85% / 20 min / 1.5%) · surgeDecayExitEnabled true ▲ (50% / 15 min) · roundTripHarvestEnabled true ▲ · twapGuardEnabled false · exitSwapGuardEnabled true ▲ · rebalanceEnabled true / rebalanceMode shadow ▲ / rebalanceMaxCount 2 / rebalanceMinOorMinutes 15 / rebalanceLineageTakeProfitPct 4 / rebalanceBinsBelow 35 / Above 34 · minClaimAmount 5 · autoSwapAfterClaim true · manageUntracked true · postCloseProbeMinutes [30,60,180,720,1440] · rangeHarvestPools [1 pool] · closeSendsViaPrimaryRpc true.

**Transactions**: enablePriorityFees true · priorityFeeMultiplier 1.5 · maxPriorityFeeMicroLamports 5,000,000 · txMaxRetries 5 · exit priority tier on (p75 × 1.5, cap 3M).

**LLM**: all roles glm-5.3-flash · temperature 0.1 · maxTokens 16384 · maxSteps 20 · claudeCliFallbackModel google/gemini-3.7-flash.

**Skimmer**: enabled false · targetWorkingCapitalSol 6.25 · minTransfer 0.5 · maxDaily 2 · requireTelegramConfirmation true.

---

## 10. Cross-domain correlation map

The domain files end with their own correlation sections; this consolidates the ones that cross
domains. Numbers in brackets point to the domain file section.

### 10.1 One signal, many gates (double counting)
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

### 10.2 Rules that contradict each other
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

### 10.3 Dead or inert under production config
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

### 10.3a Infrastructure findings (from `04-…` §9)
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

### 10.4 Where the money actually moves (what to audit first)
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

## 11. Questions to settle in the audit

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
