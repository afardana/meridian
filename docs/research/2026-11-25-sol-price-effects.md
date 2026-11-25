# SOL price effects on how Meridian evaluates positions — audit (2026-11-25)

Read-only study. No code, config, VM or DB changes. Scripts and intermediate data:
`/private/tmp/claude-501/-Users-Angga-Repos-meridian/761265a4-8137-446b-83fe-2f68da13e683/scratchpad/solprice/`
(`beta.py`, `b2.py`, `b3.py`, `tvl.py`, `env.py`, plus the exported aggregates).

## Executive summary

1. **SOL price barely moves the pools the bot trades in SOL terms, so measuring PnL in SOL (the basis every exit rule reads since 2026-09-29) is the right choice.** On 108k five-minute and 8.8k one-hour pool-price steps (245 pools, 08-12 → 11-25), TOKEN/SOL moves *with* SOL/USD at +0.16 (5 m) to +0.60 (1 h). That rules out the "token price is fixed in USD" picture (it would give −1). But SOL explains under 0.2 % of the variance (r = 0.01–0.04). Once hold length is controlled for, close outcomes do not depend on which way SOL moved.
2. **The entry floors written in USD got about 85 % stricter in SOL terms from the 09-27 peak to today.** `minTvl` $100k was ≈ 800 SOL of pool depth at $125 and is ≈ 1,480 SOL at $67.6. In a live query today, 0 of the 7 pools in the screening envelope have TVL ≥ $100k.
3. **The "no disasters at ≥ $100k entry TVL" evidence (2026-07-27) did not hold up afterwards.** All 62 of those closes were entered with SOL ≈ $74. Since then the ≥ $100k bands show ≈ 10 % disasters in both later periods. Entry TVL no longer predicts disasters in either unit (AUC 0.50 USD / 0.50 SOL since 09-26). The floor is now mainly a cap on candidate supply that moves with the SOL price.
4. **The trading circuit breaker's drawdown check divides by the wrong units, so it can effectively never fire.** It divides a 24 h sum of `pnl_usd`, which holds SOL amounts under solMode, by gross deposits × SOL/USD. At today's price it would need about −420 SOL in one day. Its loss-streak counter also misses 39 of the 146 losses since 09-26, because `pnl_usd` rounds them to 0.00. It last fired on 06-17.
5. **The operator's USD/IDR result since the SOL peak comes from the SOL price as much as from LP performance.** Wallet split from 09-27 → 11-25: SOL price −$163 versus LP result −$122. From 10-09: −$83 versus −$204. Over the whole history the result is −10.9 % in SOL, −7.9 % in USD and −8.0 % in IDR. Per close the gap between SOL and USD is small (median 0.4 pp), but 15 % of bot closes show opposite signs in SOL and USD.
6. **IDR matters much less than USD.** Since the peak, USD/IDR moved +1.8 % (ECB) / +3.8 % (Indodax USDT) while SOL/USD fell −41.5 %. Daily USDT/IDR volatility is 8× smaller than SOL's. IDR changes the operator's figures by a few percent and changes no decision.
7. Other USD-tied items are smaller:
   - The $25 dust-sweeper ceiling, which is also where the exit-swap guard / slippage cap tier starts, now covers 84 % of exit remainders, against 66 % at $120.
   - The TVL exit ($10k) and the thin-pool limit ($100k) now apply to pools roughly twice as deep in SOL as at the peak.
   - Fixed SOL costs (gas, rent, minimum sizes) fell in USD terms and nothing is mis-sized.

---

## Data and method

| Source | What | Period / n |
|---|---|---|
| Binance public klines SOLUSDT | 1 h (4,262) and 5 m (30,408) candles | 2026-06-01 → 11-25 / 08-12 → 11-25 |
| ECB via frankfurter.dev (USD/IDR daily) and Indodax public USDTIDR daily candles | FX | 06-01 → 11-24 |
| VM `price_ticks` | last active bin per pool per 5-min bucket (aggregated in SQL) | 109,297 buckets, 249 pools, 08-12 → 11-25 |
| VM `balance_history` | every 10th sample: totalSol, solPriceUsd, limitOrdersSol | 5,750 samples, 06-16 → 11-25 (gap 06-30 → 07-29) |
| VM logs | daily average of `[SCREENING] funnel[rank]` counts; `below minTvl` reject lines; circuit-breaker trips | 07-12 → 11-25 (rank format from 09-26) |
| Perf records fixture | 1,471 closes; bot = not `adopted`, not `rebalance_leg` (1,005) | 06-14 → 11-25 |
| Status fixture | baseline deposits (17, ◎41.52) / withdrawals (32, ◎28.13), FX | snapshot 11-25 |
| Meteora discovery API (public) | one live envelope query, with floors as coded and with floors scaled to SOL @ $120 | 11-25 ~21:00 WIB |

**Pool price returns.** Δbin × ln(1 + binStep/10⁴) is the TOKEN/SOL log return. These are compared with the SOL/USD log return over the same span, using non-overlapping steps per pool. The beta CIs come from a pool-clustered bootstrap with the 1 % tails trimmed.

**Units.** Only `pnl_sol*`, `*_true` and `deposit_*_true` are used. Legacy `*_usd` fields hold SOL under solMode and are never used as dollars.

**Rule-stack eras used throughout:** A < 2026-09-26 (gate admission, adaptive trailing, …), B 09-26 → 10-04 (fee-rate admission, before the pool-price valuation), C ≥ 10-04. The TVL tables also split at 07-27/28, when the $100k floor was introduced.

---

## Findings, ranked

### F1 — SOL price is a small force on TOKEN/SOL. Pools move with SOL, not against it, and SOL-basis evaluation is not distorted by SOL moves.

**Mechanics.** Take a TOKEN-SOL pool with USD price p_tok and SOL price P. The pool price is p_tok / P. If p_tok has a USD beta b to SOL, then the slope of TOKEN/SOL returns on SOL/USD returns is b − 1:
- −1: the token price is fixed in USD. A SOL pump would push the price down into a SOL ladder (the ladder fills, a SOL-basis loss while flat in USD). A SOL dump would push the price out the top of the range.
- 0: the token price is fixed in SOL.
- > 0: the token is a leveraged SOL bet.

**Measured** (pooled, 1 % trimmed; 90 % CI clustered by pool):

| Horizon | n steps | pools | slope TOKEN/SOL on SOL/USD | 90 % CI | r |
|---|---|---|---|---|---|
| 5 m | 108,292 | 245 | +0.16 | [+0.07, +0.25] | 0.009 |
| 1 h | 8,828 | 219 | +0.60 | [+0.24, +0.97] | 0.030 |
| 4 h | 2,111 | 157 | +0.39 | [−0.25, +0.97] | 0.021 |
| 24 h | 363 | 91 | +0.10 | [−1.38, +1.75] | 0.006 |

- At every horizon the CI excludes −1. The meme tokens the bot trades have a USD beta to SOL of about 1.2–1.6: when SOL sells off, they fall harder.
- Conditional means (1 h): when SOL fell 0.8–2 % in the hour, TOKEN/SOL averaged −2.2 % (se 0.5). When SOL was flat (±0.2 %), it averaged −0.6 %. When SOL rose 0.8–2 %, it averaged −0.6 %.
- At 4 h: SOL −0.8…−2 % gives TOKEN/SOL −4.5 %, against −1.1 % when SOL is flat.
- So a SOL sell-off pushes the price down into a SOL ladder (the opposite of the USD-fixed intuition). The effect is small next to the pools' own volatility: the standard deviation of TOKEN/SOL over 1 h is 11.8 %, and over 4 h is 22 %.
- By band, the 1 h slope is positive in every TVL / mcap / age band with enough data (e.g. TVL 30–100k +1.06 [0.39, 1.66], ≥ 200k +0.64 [0.06, 1.34], mcap ≥ 2M +0.66 [0.30, 1.02]). Bands with few steps (< 30k TVL, < 500k mcap, token age < 24 h) are indistinguishable from 0 and no band is distinguishable from another.
- The tracked pools drift down ≈ −0.6 %/h in SOL terms even when SOL is flat. Price ticks exist only while a position is open, and the bot mostly sits in dips, so this is a selection effect, not a market fact.

**Close outcomes against the SOL move** (bot, all eras; disaster = pnl ≤ −10 %):

| SOL/USD change during hold | n | mean pnl % | disaster % | stop-class % | unfilled/above/harvest % |
|---|---|---|---|---|---|
| < −2 % | 43 | −3.24 | 23.3 | 16.3 | 18.6 |
| −2 … −0.5 % | 164 | +0.60 | 8.5 | 7.9 | 22.6 |
| ±0.5 % | 587 | +0.14 | 7.5 | 8.9 | 28.8 |
| +0.5 … +2 % | 162 | +0.16 | 9.3 | 9.9 | 19.8 |
| > +2 % | 49 | −4.51 | 24.5 | 14.3 | 14.3 |

The two tails look bad, but symmetrically. This is mostly hold length: a big SOL move needs a long hold, and long holds have more disasters whatever SOL does.
- < 1 h: 4 % disasters when SOL was flat.
- 4–12 h: 10 / 15 / 17 % for SOL down > 1 % / flat / up > 1 %.
- > 12 h: 19 / 21 / 19 %.

Spearman correlation of pnl with the SOL change during the hold is +0.02 overall (+0.05 / −0.06 / +0.04 by era). For the 24 h SOL change before entry it is −0.01, and the 1 h change before entry shows nothing either.
- "Unfilled above" closes do not cluster in SOL drops: oor_above_unfilled is 0–8 % of closes in every SOL-down cell. This is what the positive beta predicts.
- Operator positions (n = 466) look different: mean +6.5 % when SOL fell > 2 % during the hold, against −0.6 % when it rose > 2 %. But n = 31 / 22, and their holds and adoption-basis accounting differ, so this is not interpretable.

**Why it matters.** The bot judges positions in SOL. The question was whether SOL/USD moves leak into that judgement, for example by stopping a position out in a SOL pump while it is flat in USD. In this data they do not. The SOL basis tracks the pool, and SOL explains almost nothing of the pool's path.

**Recommendation: no action** on exit rules. As awareness: in a sharp SOL sell-off, expect SOL ladders to fill a little faster (≈ 1.5–3.5 pp extra TOKEN/SOL drop per 1–2 % SOL drop over 1–4 h). That is the opposite of the USD-fixed intuition.

### F2 — The USD entry floors drift with SOL: `minTvl` $100k now needs ≈ 1,480 SOL of pool, against ≈ 800 at the peak

**Mechanics.** A SOL-quoted pool's USD TVL is (SOL reserve × P) + (token reserve × p_tok). With TOKEN/SOL roughly flat (F1), a pool with unchanged SOL depth loses USD TVL roughly one-for-one with SOL, and a bit more since the token's USD beta is > 1. A fixed USD floor therefore demands a deeper pool, in SOL, as SOL falls.

| Point | SOL/USD | $100k in SOL | $10k in SOL |
|---|---|---|---|
| 2026-07-27 evidence era (median entry) | 73.9 | 1,352 | 135 |
| 07-28 … 09-25 | 101.9 | 981 | 98 |
| ≥ 09-26 | 118.0 | 848 | 85 |
| peak 09-27 | 124.95 | 800 | 80 |
| now 11-25 | 67.6 | 1,479 | 148 |

**Supply.** In the rank-admission era (38 days with ≥ 20 cycles, 09-27 → 11-13):
- Daily average `universe` fell from ≈ 30 at $120 to ≈ 15 at $90, correlation 0.84 with the SOL price. `safety` correlates 0.85, `gates` 0.58, `admitted` 0.56.
- But the correlation is entirely a shared trend. On day-to-day changes it is −0.18 / −0.13 / +0.03; detrended it is 0.13 / 0.08 / 0.00.
- The meme market and SOL fell together, and these data cannot separate "fewer pools because of USD floors" from "fewer pools because the market shrank".

The live sensitivity check (Meteora discovery API, prod envelope: timeframe 1h, bin step 80–125, token age 2–720 h) gives a direct reading:

| Envelope | pools | of which TVL ≥ $100k | TVL ≥ $56.3k |
|---|---|---|---|
| USD floors as coded ($10k TVL, $100k–20M mcap, $1k vol) | 7 | 0 | 2 |
| same floors scaled to SOL @ $120 (×0.563) | 9 | 0 | 2 |

- The fee/active-TVL floor (0.30 %/h, no unit) decides most of the envelope.
- The USD floors of the envelope cost about 2 pools today.
- `minTvl` $100k admits nothing at this moment. Its SOL-at-$120 equivalent ($56.3k) would admit 2.
- This is one snapshot.

**Recommendation: threshold to re-express or re-calibrate.**
- Decide explicitly whether `minTvl` is a liquidity rule or an attention / quality rule.
  - As a liquidity rule (exit depth for our remainder, which is sold into the SOL leg), the natural unit is SOL.
  - As an attention / quality rule, USD may be right.
- Test: tag every candidate the envelope admits with `tvl_sol = tvl / P` (the price is already in the funnel cycle), keep it in rejected-candidates, and compare the next 4 weeks' admitted count and outcomes under a shadow floor of ~850 SOL (its value when it was last re-validated, 09-26 → 11-13) against $100k.
- See F3 for why the evidence behind the $100k level is weak.

### F3 — The "≥ $100k entry TVL has zero disasters" evidence was a single-era result and did not hold up afterwards

Bot closes by entry TVL. The first block reproduces CLAUDE.md's 2026-07-27 table to the record count:

| USD entry TVL | ≤ 07-27 (SOL ≈ $74) n / dis % / mean | 07-28 … 09-25 (SOL ≈ $102) | ≥ 09-26 (SOL ≈ $118) |
|---|---|---|---|
| < 30k | 68 / 11.8 / −0.60 | 8 / 0.0 / +1.18 | 14 / 7.1 / +0.12 |
| 30–60k | 90 / 8.9 / −0.83 | 13 / 23.1 / −2.52 | 22 / 9.1 / +0.37 |
| 60–100k | 61 / 14.8 / −2.13 | 8 / 0.0 / +1.61 | 8 / 12.5 / −3.02 |
| 100–200k | 49 / **0.0** / +1.05 | 123 / **5.7** / +0.30 | 197 / **10.2** / +0.47 |
| ≥ 200k | 13 / **0.0** / +1.78 | 103 / **10.7** / −0.35 | 198 / **10.6** / +0.35 |

- The 0 % cells rest on 62 closes, all at SOL ≈ $74, i.e. pools of ≥ ~1,350 SOL.
- After the floor took effect, the ≥ $100k bands carried 6–11 % disasters, the same rate as the population.
- In SOL terms the picture is no cleaner:
  - ≥ 09-26: < 400 SOL 6.9 % (n 29); 800–1,300 SOL 13.3 % (113); 1,300–2,600 SOL 7.4 % (162); ≥ 2,600 SOL 11.7 % (120).
  - 07-28 … 09-25: 800–1,300 SOL 4.1 % (49).
  - It is not monotone and the bands disagree between eras.
- AUC of "low entry TVL predicts a disaster":

| Era | USD | SOL |
|---|---|---|
| ≤ 07-27 | 0.62 | 0.63 |
| 07-28 … 09-25 | 0.45 | 0.49 |
| ≥ 09-26 | 0.50 | 0.50 |

- Part of the AUC drop is range restriction (the floor cuts off the low end). Still, inside the range the bot actually trades, entry TVL in either unit carries no disaster information since July.
- By SOL price at entry, for ≥ $100k: P < 90 → 2.5 % disasters (n 162), 90–110 → 12.3 % (261), ≥ 110 → 8.8 % (260). Era and SOL price are almost the same variable here (SOL rose through August), so this cannot be pinned on SOL.

**Why it matters.** CLAUDE.md still says "do NOT compromise the floor". The original cliff is a single-era result, and the floor's cost in candidate supply now grows as SOL falls (F2). The 07-27 evidence holds for one period at one SOL price.

**Recommendation: threshold to re-calibrate** (with F2), and update the CLAUDE.md note. Also a hypothesis (H2).

### F4 — The trading circuit breaker's drawdown check mixes SOL and USD and cannot fire; its loss streak misses rounded losses

`circuit-breaker.js:139–165`:
- `recentPnlUsd` = Σ `pnl_usd` over 24 h. Under solMode this field carries SOL rounded to 0.01.
- It is divided by `baseline.total_deposited` (gross deposits, ◎41.52, never net of the ◎28.13 withdrawn) × `lastSolPrice` (USD).
- Today the −15 % threshold (`circuitBreakerDrawdownPct`) needs a 24 h Σ of about −421 "pnl_usd", i.e. about −421 SOL, against a wallet of ◎8.86.
- Even with matching units it would need −6.2 SOL (−15 % of gross deposits), which is 70 % of the current equity.
- The required loss also scales with the SOL price.
- The consecutive-loss condition reads `pnl_usd < 0`. Since 09-26, 39 of 146 losing closes (all small) have `pnl_usd` = 0 and silently reset the streak.
- The logs show one trip ever (06-17, loss streak 4). Prod: enabled, drawdown −15 %, 6 consecutive losses, 6 h cooldown.

**Why it matters.** This is a risk control the operator may believe is active. Its drawdown half is dead in every SOL regime, and its threshold drifts with the SOL price.

**Recommendation: threshold to re-express.** Compute drawdown from `pnl_sol_net` over a SOL equity figure (current AUM or net deposits), and the loss streak from `pnl_sol` sign (with a small epsilon). Test by replaying the 24 h windows of the perf history to see where a SOL-consistent breaker would have tripped. Not a SOL-price *effect* as such, but it is the one USD-mixed risk rule found.

### F5 — In USD/IDR, the operator's outcome since the peak is about half SOL price, half LP result

Wallet split from balance history (S = totalSol + limit orders, P = SOL/USD). Price effect = Σ S₀·ΔP. LP result = Σ (ΔS − flows)·P₁. Flows = baseline deposits / withdrawals.

| Window | Equity start → end | SOL price effect | LP result (USD) | LP result (SOL) | net flows (USD) |
|---|---|---|---|---|---|
| 06-16 → 11-25 | $122 → $604 | +$232 | −$468 | −◎4.29 | +$718 |
| 07-29 → 09-27 (SOL $74 → $123) | $435 → $275 | +$393 | −$173 | −◎1.30 | −$379 |
| 09-27 (peak) → 11-25 | $263 → $604 | **−$163** | **−$122** | −◎0.72 | +$626 |
| 10-09 → 11-25 | $848 → $604 | −$83 | −$204 | −◎1.52 | +$44 |

Over all deposits and withdrawals, each valued at its own time:

| Basis | Deposited | Withdrawn | Now | Result |
|---|---|---|---|---|
| SOL | ◎41.52 | ◎28.13 | ◎8.86 | −◎4.53 (−10.9 %) |
| USD | $3,593 (avg $86.5/SOL) | $2,712 (avg $96.4/SOL) | $599 | −$283 (−7.9 %) |
| IDR | Rp 64.7 m | Rp 48.5 m | Rp 11.0 m | −Rp 5.2 m (−8.0 %) |

The USD result is better than the SOL one because withdrawals were taken at a higher average SOL price than deposits came in at (+≈ $110). That comes from the timing of the operator's flows, not from LP skill.

**Per close.** `pnl_usd_true` = (deposit + pnl, in SOL) × P_close − deposit_usd at entry, so it includes the SOL drift of the capital during the hold. Median |SOL % − USD %| is 0.40 pp for bot closes and 0.26–0.29 pp for operator closes. SOL and USD signs disagree on 15 % of bot closes (124 of 823) and 6 % of operator closes. Since 09-26, bot closes average +0.14 % in SOL and −0.02 % in USD. Holds are short (hours), so per-position SOL drift is small. The wallet's standing SOL exposure is what dominates.

**Recommendation: awareness / display.**
- On the dashboard, show the wallet split (SOL price effect vs LP result) next to the USD/IDR equity figure, so a falling SOL is not read as bot underperformance or the reverse.
- Label a close's USD PnL as "incl. SOL move during the hold" where it is shown next to the SOL figure.
- The bot's judgement should stay in SOL.

### F6 — The $25 tier boundary (sweeper ceiling = exit-swap guard / slippage-cap tier) moved with SOL

`dustSweepMaxUsd` $25 decides whether an exit remainder is "sweeper-retryable" (guarded: held if quoted impact > 5 %, since `exitSwapGuardEnabled` is true in prod; capped when the slippage cap is enabled) or "urgent inventory, must fill" (`tools/executor.js:1417–1421, 1464, 1518, 1560–1561`).

For 498 exit swaps since 09-26 (median remainder ◎0.121, median position ◎0.45):

| SOL/USD | ceiling in SOL | share of remainders under the ceiling |
|---|---|---|
| $120 | ◎0.208 | 66 % |
| $100 | ◎0.250 | 72 % |
| $67.6 | ◎0.370 | 84 % |

At $67.6 the ceiling is 82 % of a minimum-size position (◎0.45), against 46 % at $120.
- Urgent exits bypass the guard since 09-30.
- The risk is on calm exits: more of them can now be held rather than sold. That is the case the sweeper exists for, but a held remainder of up to ◎0.37 is a larger share of capital than intended.

**Recommendation: threshold to re-express** (in SOL, or as a share of the position's capital). Check the `[EXIT_SWAP_GUARD]` hold counts per week against the SOL price; they are rare so far (≈ 6 skips in Oct–Nov logs).

### F7 — Exit rules tied to USD TVL now act on deeper pools

- **TVL exit** (`tvlFloorExitUsd` $10k, enforce, overrides HOLD; `tvl-floor-exit.js:23`, `tools/dlmm.js:658–664`). It now fires on a pool with ≤ ◎148 of depth, against ◎80 at the peak. On-chain confirmation uses reserves × active-bin price × SOL/USD and refuses when the SOL price is stale (> 30 min, `sol-price.js:15`). That is a safe failure mode.
- **Thin-pool hold limit** (`holdThinPoolTvlUsd` $100k, enforce again since 11-24; `hold-thin-limit.js:38`). "Thin" now means < ◎1,479 at entry. Operator positions with entry TVL < $100k were 49 % of closes in September (98/199) and 81 % in November (17/21). That is partly the operator's pool choice and partly SOL, which cannot be separated.
- **Calm-pair crash regime** eligibility (`crashRegimeMinTvl` $50k, `crash-regime.js:45`): fewer pools qualify as SOL falls.

All three are about liquidity / rug depth, which is naturally a SOL quantity, since what has to be absorbed is our SOL-valued remainder.

**Recommendation: candidate hypothesis** (H3), then re-express if it holds. No live harm is visible yet: the TVL exit fires rarely, and the 2026-10-11 rationale (FACTORY at $8–10k) would also hold at ◎150.

### F8 — Fixed SOL costs: nothing became mis-sized

Measured or configured, in SOL and in USD at $67.6:
- close + swap gas ≈ ◎0.00002 ($0.001)
- exit priority-fee cap 300k µL/CU × ~400k CU ≈ ◎0.00012 ($0.008)
- token-account rent ◎0.0020 ($0.14, refundable)
- `deployAmountSol` minimum ◎0.45 ($30, against $56 at the peak)
- straddle minimum ◎0.25 ($17)

Jupiter costs are in bps (no unit). The QR-pay swaps of 11-25 received 67.32–68.54 USDC per SOL, 0.1–0.4 % under the Binance mid at the same minute. In SOL terms the USD-priced floors became *more* conservative (`dustSweepMinUsd` $0.25 = ◎0.0037 against ◎0.0021; `burnMaxUsd` $1 = ◎0.015), and their reason (gas) is a fixed SOL amount, so this is harmless.

What does change for the operator: every IDR/USD payment needs more SOL as SOL falls (Rp 100k ≈ ◎0.080 now, against ◎0.045 at the peak).

**Recommendation: no action** (awareness for the operator's spending).

### F9 — IDR is second order

| Window | SOL/USD | USD/IDR (ECB) | USDT/IDR (Indodax) | SOL/IDR |
|---|---|---|---|---|
| 06-16 → 11-24 | −5.0 % | +2.9 % | +4.3 % | −2.3 % |
| 09-26 → 11-24 | −41.5 % | +1.8 % | +3.8 % | −40.5 % |
| 10-09 → 11-24 | −36.3 % | +1.9 % | +3.6 % | −35.1 % |

- Daily volatility: USDT/IDR 0.40 %, SOL/USD 3.12 % (8×).
- In the wallet split the FX term is −Rp 0.07 m over the whole history, against ±Rp 3–4 m from SOL price.
- The dashboard's IDR mode converts with the *current* Indodax rate (`fxIdrPerUsd`), so historical USD values in IDR carry up to ≈ 4 % rate drift. That is minor, but worth a tooltip.
- Indodax's USDT/IDR ran ~2 pp above ECB's USD/IDR over the period. Indodax's SOL/IDR (Rp 1,247,504) was 0.3 % above SOL/USD × USDT/IDR at the snapshot.

**Recommendation: awareness / display only.** IDR changes no bot decision.

### F10 — Smaller display / code items

- `config.solPriceUsd` is read but never set (`index.js:3604, 5713, 5816, 6945`; `tools/transfer.js:266`), so skim and transfer messages never show the USD value.
- Valuation is unaffected by the SOL price: base valued at the active bin × SOL/USD, divided back by SOL/USD (`tools/pnl.js:817, 849`).
- Two places carry SOL-price error into display-only USD fields:
  - the deposit fallback that prices SOL deposits at the *current* price (`tools/pnl.js:864–870`)
  - Meteora-lifetime USD figures on adopted positions
- The claimed-fee floor fix of 2026-09-29 keeps units separate (`tools/pnl.js:920–927`). It was confirmed in the code and does not re-price at the current SOL price any more.
- `minMcap` / `maxMcap` in config (prod 300k / 10M) are inert in rank admission. The envelope's hard-coded $100k–$20M applies (`tools/screening.js:77–78, 1066`), so the mcap floor in SOL terms is $100k = ◎1,479 now against ◎800 at the peak.

---

## USD-denominated or SOL-price-dependent rules — inventory

| Rule / value | file:line | prod value | unit | effect of SOL $125 → $67.6 |
|---|---|---|---|---|
| `minTvl` (entry; scouts off → reject) | config.js:134; tools/screening.js:1072–1073; tools/executor.js:164 | $100,000 | USD TVL | ◎800 → ◎1,479 (+85 %); 0 envelope pools ≥ $100k now (F2, F3) |
| `maxTvl` (entry) | config.js:135; tools/executor.js:155 | $800,000 | USD TVL | cap loosens in SOL (◎6.4k → ◎11.8k); irrelevant now |
| RANK_ENVELOPE tvl ≥ (rug floor) | tools/screening.js:76, 269, 1062; tvl-floor-exit.js:23 | $10,000 | USD | ◎80 → ◎148 |
| RANK_ENVELOPE mcap band | tools/screening.js:77–78, 265–266, 1066 | $100k–$20M | USD mcap | floor ◎800 → ◎1,479; tokens with USD beta > 1 shrink faster |
| RANK_ENVELOPE volume | tools/screening.js:80, 256 | $1,000 × tf/1h | USD vol | ≈ +85 % in SOL terms; ~2 pools today (F2) |
| `minMcap` / `maxMcap` | config.js:137–138 | 300k / 10M | USD | inert in rank mode |
| `rankSteadyMinTvl` (steady envelope) | config.js:189; tools/screening.js:355 | $100,000 | USD | as minTvl |
| `tvlFloorExitUsd` (hard exit, overrides HOLD) | config.js:399; tvl-floor-exit.js:23 | $10,000, enforce | USD (on-chain check × SOL/USD) | fires at ◎148 instead of ◎80 (F7) |
| `getPoolOnChainTvlUsd` | tools/dlmm.js:658–664 | — | SOL reserves × SOL/USD | refuses on stale SOL price (fail-safe) |
| `holdThinPoolTvlUsd` (−25 % hold limit) | config.js:391; hold-thin-limit.js:38 | $100,000, enforce | USD entry TVL | "thin" = < ◎1,479 (F7) |
| `crashRegimeMinTvl` | config.js:598; crash-regime.js:45 | $50,000 | USD | fewer calm-eligible pairs |
| `dustSweepMinUsd` / `dustSweepMaxUsd` | config.js:646–647; tools/executor.js:1417–1421, 1464, 1518, 1560–1561 | $0.25 / $25 | USD token value | ceiling ◎0.21 → ◎0.37; 66 % → 84 % of remainders in the guarded tier (F6) |
| `exitSwapMaxImpactPct` guard tier | tools/executor.js:1417 | 5 % for ≤ $25 | % (tier in USD) | via the ceiling above |
| `burnMaxUsd` | config.js:404; tools/wallet.js:1191 | $1 | USD | ◎0.008 → ◎0.015, harmless |
| exit-remainder alert | exit-swap-wait.js:132–140 | > dustSweepMaxUsd | USD via SOL/USD | as the ceiling |
| circuit breaker drawdown | circuit-breaker.js:139–165, 335 | −15 %, 6 losses | **mixed: SOL ÷ USD** | dead in every regime; required loss scales with P (F4) |
| `minVolumeToRebalance` | config.js:442 | 1,000 | USD (volume) | no reader found outside config / update_config |
| `sol-price.js` stale threshold | sol-price.js:15 | 30 min | — | display warning; TVL exit refuses on stale |
| live valuation | tools/pnl.js:817, 849 | — | SOL/USD cancels | none (SOL basis independent of P) |
| deposit fallback at current P | tools/pnl.js:864–870 | — | USD display | SOL-drift error in USD display only |
| claimed-fee floor | tools/pnl.js:920–927 | — | own unit | fixed 09-29 |
| legacy `*_usd` | lessons / dlmm records | — | SOL under solMode | used by the circuit breaker (F4); never render as $ |
| `config.solPriceUsd` | index.js:3604 etc.; tools/transfer.js:266 | never set | — | skim/transfer USD text missing |
| Unaffected (no unit or SOL): fee/active-TVL floors, vol/TVL, tx/min, bin-step band, `minTokenFeesSol` (◎30), all exit % rules, `deployAmountSol`, `positionSizePct`, priority-fee caps, straddle impact cap | | | | — |

---

## Candidate hypotheses (falsifiable; none is a rule design)

- **H1 — SOL sell-offs fill SOL ladders faster.** Claim: for open bot positions in range, a SOL/USD drop of 0.8–2 % over 4 h is followed by a TOKEN/SOL drop ≥ 2 pp larger than in 4 h windows with SOL flat (±0.2 %), and by a higher share of 4 h windows that end below the range. Grade: forward `price_ticks` (bins) with Binance 5 m candles, ≥ 300 four-hour windows in each group, pool-clustered CI. Current reading (post-hoc, one period): −4.5 % vs −1.1 %.
- **H2 — Entry TVL in SOL separates disasters no better than in USD, and neither helps inside the admitted range.** Claim (null): over the next ≥ 30 bot disasters, AUC(low TVL → disaster) is < 0.58 in both units and |AUC_SOL − AUC_USD| < 0.05. If AUC_SOL ≥ 0.60 with AUC_USD < 0.55, re-express `minTvl` in SOL. Grade: perf records (`entry_tvl` + SOL price at deploy, which needs capturing, or rebuilt from candles as here).
- **H3 — Liquidity rules belong in SOL.** Claim: exit slippage on remainders (`exit_swap` against pool basis) is explained better by the remainder's share of the pool's SOL reserve than by its share of USD TVL (higher R², rank correlation larger by ≥ 0.1). Grade: 300+ exit swaps since 10-05 with the pool's SOL reserve at close (would need capturing; USD TVL ÷ P is an approximation).
- **H4 — Lowering `minTvl` to its SOL equivalent at the 09-26 → 11-13 reference (~◎850 ≈ $57k at today's price) adds candidates without raising the disaster rate.** Claim: the pools between ◎850 and ◎1,479 admitted over 4 weeks reach a ≤ −10 % rate no higher than the ≥ ◎1,479 group + 5 pp. Grade: shadow-tag those candidates in rejected-candidates and follow their pool price paths (counterfactual ladder replay), or deploy at minimum size if the operator accepts it.
- **H5 (weak, post-hoc) — Bot closes do worse when SOL rose > 1 % during a 1–12 h hold.** Means −1.0 % / −3.3 % vs +0.6 % / +0.1 % flat. n 34 / 48, against the beta direction, likely era-confounded (SOL rose through August, era A). Register only to see it fail or hold. Grade: forward bot closes, ≥ 60 per cell.

---

## Limits

- **Era confounding.** SOL rose through August–September and fell through October–November while the rule stack changed repeatedly (07-27 floor, 09-26 fee-rate admission, 10-04 pool-price valuation). Any split by SOL price is also a split by era. No bucket here is a result. The bucket tables are descriptive and the hypotheses are what to test.
- **Price ticks exist only while the bot holds a position**, and positions close on stops / OOR. Pool return series are truncated and selected toward pools the bot sits in. Bins are quantized (1 bin ≈ 0.8–1.25 %), which pulls 5 m betas toward 0.
- **Funnel counts are daily averages over cycles.** Their definition changed at 09-26 (only the rank format is used). There is no screening between 11-13 and 11-25 (prod `maxPositions` was 0). `below minTvl` counts depend on how often the report prints, so they are not used as a rate.
- **The wallet split uses a 10 % sample of balance history** (~40 min steps) and the baseline flow list. Limit orders are counted from their snapshot field (absent before ~09-30). The 06-30 → 07-29 gap is bridged in one step. Balance-history LP result (−◎4.29) differs from the ledger Σ `pnl_sol_net` (+◎3.97) — the known ledger-vs-wallet drift, not studied here.
- **Per-close USD uses `pnl_usd_true`.** On adopted positions it inherits Meteora lifetime / adoption-basis quirks. The operator numbers are less reliable than the bot's.
- **The live envelope query is one snapshot.**
- **FX sources.** ECB (frankfurter.dev) is official mid; Indodax USDT/IDR is a crypto-exchange rate (≈ 2 pp premium over the period). Both are public, and no account was used.
