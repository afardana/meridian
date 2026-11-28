# Bot deploys and the whole book — data study (2026-11-28)

Read-only, exploratory. Source: `.experiments/status/performance.json` (1,508 closed records, exported 2026-11-28 16:43 WIB) plus `balance_history` on the VM (SELECT only). Scripts: scratchpad `study-book/` (`common.py`, `q1.py` … `q9.py`, `robust.py`). Every cut below was chosen after looking at the data — each finding is a hypothesis, not a result.

## Summary

- **The bot is ≈ break-even without one position.** Since 09-26: 451 bot closes, Σ net ◎+2.017, but CRAWL-SOL 69F2FsPS (a bot deploy the operator held, +66 %) is ◎+1.859 of it. Without it: ◎+0.158 over 450 closes (◎+0.01 per 100 SOL-hours). Positions the operator never touched: 413 closes, ◎+0.353; first half ◎+0.903, second half (from 10-07) ◎−0.549.
- **The operator book carries the loss:** 215 closes, ◎−4.524; its five worst records (◎−5.657) exceed its total. Whole book: 666 closes, ◎−2.506. November is positive for both owners (bot ◎+0.590, operator ◎+0.447).
- **Fees are the only source of profit.** Bot fees ◎+11.81, price/IL ◎−8.62, so gross ◎+3.15 and net ◎+2.02. For winners, price was negative too (◎−0.83 against ◎+9.08 of fees).
- **37 stop losses (8 % of closes) lost ◎−3.334.** That is 81 % of the ◎+4.08 that 252 trailing and harvest closes made. An average stop costs as much as 5.6 average wins. Stops realise −17.95 % net against the −15 % line.
- **Costs take 36 % of gross.** Gross minus net = ◎1.136 (13.8 % of gross wins): gas ◎0.10, exit slippage ◎0.35, and the wallet audit marking records down by a further ◎0.64.
- **Two entry features survive both robustness checks:** deploys starting 00:00–04:00 WIB (n 90, 21 % disasters vs 7 %) and the top volatility quartile (n 113, 16 % vs 8 %). Both are candidate hypotheses, not rules.
- **Straddles:** 48 bot closes, ◎+1.071 net. Since 10-26: 15 closes, ◎+0.018, below the ≈ ◎+0.26 their harvests were worth when they straddled (inference).

## 1. Scoreboard

Owner = `owner` field, else `adopted === true` → operator. Since 09-26 there are no rebalance-leg records (one exists, from 09-17), so no leg SOL is involved. Mean and median are **net %** (`pnl_sol_net / amount_sol`). Disaster share uses gross `pnl_pct` ≤ −10. "trim" = Σ without the two best and two worst. "cw" = Σ net / Σ capital.

| group | n | Σ net ◎ | mean % | med % | win | ≤−10 % | trim ◎ | cw % | SOL-h | ◎/100 SOL-h |
|---|---|---|---|---|---|---|---|---|---|---|
| bot since 09-26 | 451 | +2.017 | −0.26 | +0.66 | 69 % | 10 % | +0.764 | +0.80 | 2481 | +0.08 |
| bot Sep (26–30) | 90 | +0.252 | +0.05 | +0.49 | 66 % | 9 % | +0.096 | +0.91 | 93 | +0.27 |
| bot Oct | 276 | +1.175 | −0.46 | +0.70 | 72 % | 11 % | +0.032 | +0.73 | 2064 | +0.06 |
| bot Nov | 85 | +0.590 | +0.03 | +0.66 | 65 % | 9 % | +0.286 | +0.92 | 324 | +0.18 |
| bot last 14 d | 12 | +0.623 | +2.05 | +1.08 | 83 % | 0 % | +0.125 | +3.08 | 108 | +0.57 |
| bot last 30 d | 91 | +0.568 | −0.03 | +0.62 | 65 % | 10 % | +0.264 | +0.85 | 339 | +0.17 |
| operator since 09-26 | 215 | −4.524 | −2.10 | +0.67 | 61 % | 16 % | −3.142 | −2.07 | 1343 | −0.34 |
| operator Oct | 146 | −4.917 | −3.06 | +0.70 | 62 % | 17 % | −2.703 | −3.39 | 1090 | −0.45 |
| operator Nov (= last 14 d = last 30 d) | 48 | +0.447 | +0.39 | +0.08 | 54 % | 17 % | +0.460 | +0.70 | 231 | +0.19 |
| all since 09-26 | 666 | −2.506 | −0.86 | +0.67 | 67 % | 12 % | −2.278 | −0.53 | 3824 | −0.07 |
| all Nov | 133 | +1.037 | +0.16 | +0.55 | 61 % | 12 % | +1.049 | +0.81 | 555 | +0.19 |

Operator Sep (26–30): 21 closes, ◎−0.053.

**Concentration:**

| owner | total ◎ | top 5 ◎ | bottom 5 ◎ |
|---|---|---|---|
| bot | +2.02 | +2.94 | −1.80 |
| operator | −4.52 | +3.24 | −5.66 |
| book | −2.51 | +4.66 | −5.66 |

The book's bottom five are DUST, FACTORY, Snowball (hold limit), ART and mucron — all operator positions. Seven bot positions held ≥ 24 h hold **64 % of the bot's SOL-hours** (1,592 of 2,481). They include CRAWL (+1.86), wifout (−0.61) and VEIL (−0.33).

## 2. Bot: where money is made and lost

| exit family | n | Σ net ◎ | mean % | med % |
|---|---|---|---|---|
| trailing_tp | 164 | +2.848 | +2.26 | +1.40 |
| manual (operator closed a bot deploy) | 35 | +1.530 | −0.96 | +0.64 |
| harvest (cashed) | 88 | +1.229 | +2.72 | +1.97 |
| take_profit | 4 | +0.366 | +20.8 | +20.0 |
| oor_above_unfilled | 70 | +0.089 | +0.19 | +0.07 |
| low_yield | 29 | +0.000 | −0.02 | −0.01 |
| young_stop | 5 | −0.272 | −10.8 | −11.0 |
| rug | 12 | −0.374 | −6.81 | −5.02 |
| stop_loss | 37 | −3.334 | −17.95 | −16.84 |

**Loss tail** (≤ −10 %, n 46, ◎−4.658):

- By family: 37 stop loss, 4 young stop, 2 rug, 2 manual, 1 crash.
- Speed: median 212 min from deploy (quartiles 90 / 212 / 527 min; all bot closes 61 / 120 / 251). The tail is not faster than the rest.
- Entry medians, tail vs rest: volatility 3.73 vs 3.18; window price change +3.2 % vs 0.0 %; 24 h change +41.5 % vs +26.6 % (54 % coverage). TVL, mcap and organic score are about the same.
- Stops are mostly positions that never made money: median MFE +0.65 %, and only 1 of 37 had a confirmed peak ≥ 2 %.

**Fees vs price** (99 % coverage of `fees_sol_true`): for all bot closes, fees ◎+11.81 and price ◎−8.62. For winners, fees ◎+9.08 and price ◎−0.83. Stop losses: fees ◎+0.82, price ◎−3.90.

## 3. Cost leak (bot)

Gross `pnl_sol` ◎+3.153, net ◎+2.017. The gap is ◎1.136 (◎0.0025 per close; 36 % of gross; 13.8 % of gross wins):

| part | ◎ | coverage |
|---|---|---|
| gas (`total_gas_sol`) | 0.092 | |
| exit-swap gas | 0.010 | |
| exit slippage | 0.349 | 78 % of records |
| wallet-audit adjustment (net − modelled) | −0.637 | 346 audited records (77 %) |
| residual | ≈ 0.05 | |

The audit adjustment carries what the model misses: straddle entry premium (measured only on 37 records, ◎0.132) and zap and route costs. `pnl_sol_net_components` exists on only 2 % of records.

By family:

| family | gap ◎ | % of capital | slippage ◎ |
|---|---|---|---|
| trailing_tp | 0.777 | 0.79 | 0.231 |
| stop_loss | 0.251 | 1.34 | 0.103 |
| take_profit | 0.024 | 1.36 | |
| phantom stop | | 2.99 | |
| harvest | 0.026 | 0.05 | |
| unfilled / low yield | | ≈ 0.06 | |

Harvests and unfilled ladders exit nearly free of cost. Stop losses average −16.65 % gross and −17.95 % net, so the realised stop sits ≈ 3 pp below its line. Tighter stops are on the rejected list; this is a fill-cost observation, not a proposal.

## 4. Entry features vs outcome (bot, era v3)

Quartiles by feature, with Spearman ρ against net %. The halves split at 10-07 02:21Z (deploy time).

**Survive** (worst cell in both halves, still negative after dropping the two largest contributors):

| cut | n | Σ ◎ | ≤−10 % (vs rest) | drop-2 ◎ | half 1 ◎ | half 2 ◎ |
|---|---|---|---|---|---|---|
| deploy 00:00–04:00 WIB | 90 | −0.750 | 21 % (7 %) | −0.609 | −0.275 | −0.475 |
| … same, volatility < 4.43 only | 69 | −0.629 | 20 % (5 %) | | | |
| volatility ≥ 4.43 (top quartile) | 113 | −1.572 | 16 % (8 %) | −0.636 | −0.260 | −1.312 |
| bot holders < 11.2 % (weak) | 112 | −0.975 | 13 % (9 %) | −0.268 | −0.448 | −0.527 |

- The 00–04 WIB window holds 17 of the 37 stop losses.
- Range width ≥ 67 bins is the same cut as the volatility quartile (ρ 0.99, because width is derived from volatility).
- The bot-holder cut is not monotone in half 2.

**Fail the half split:**

- Top-performer lane: half 1 ◎+0.169.
- Entry ≥ 45 % below the high: half 1 ◎+0.071.
- Mechanical re-entries > 15 min after a close: half 1 +1.29 % mean, half 2 −1.34 %.

**No signal** (non-monotone, |ρ| ≤ 0.12): entry TVL, mcap, holders, fee/TVL, organic score, bin step, token age, window and 1 h price change, run-up from low, fee edge, top-10 share, intel total, net buyers, CRI, fee-efficiency, day of week, conviction (full ◎+2.46 vs low ◎−0.45, but the sign flips by half for full), organic-momentum class.

**Coverage too low** (< 60 %): pool age (34 %), 24 h change (54 %), previous-close gap (55 %).

Re-entries ≤ 15 min after a close (n 107, ◎+1.315, 7 % disasters, positive in both halves) are consistent with the rejected rapid-re-entry cooldown. This is descriptive only.

## 5. Hold time and path

By minutes held:

| minutes held | n | Σ ◎ | ≤−10 % |
|---|---|---|---|
| < 30 | 46 | −0.03 | |
| 30–480 | 352 | +1.40 | 6–13 % |
| 480–1440 | 46 | −0.11 | 20 % |
| ≥ 1440 (held positions) | 7 | +0.76 | 3 of 7 |

Give-back (MFE → final) by family:

| family | median MFE % | median final % | median give-back pp | Σ give-back ◎ |
|---|---|---|---|---|
| trailing | +3.69 | +1.92 | 1.74 | 2.31 |
| harvest | | | 0.00 | |
| stop loss | +0.65 | | 16.6 | 3.35 |
| rug | | | 7.9 | |

- Time in range: median 89.6 %. Trailing and stop closes are ≈ 100 %, unfilled ladders 19.6 %, low yield 8.3 %.
- Never-filled ladders: 70 unfilled-above closes (◎+0.089, median 35 min, 41.7 SOL-h = 1.7 % of bot SOL-hours) plus 29 low-yield closes (45.1 SOL-h, 1.8 %). The capital lost to idle ladders is small.

## 6. Straddle lane

| group | n | gross ◎ | net ◎ | ≤−10 % |
|---|---|---|---|---|
| bot, straddled | 48 | +1.470 | +1.071 | 19 % |
| bot, harvest cashed out | 87 | +1.130 | +1.102 | 0 % |
| straddled since 10-26 | 15 | +0.117 | +0.018 | |
| harvest cashed out since 10-26 | 11 | | +0.173 | |

- Straddled closes: measured entry premium ◎0.075 on 29 of them. Net per close ◎0.0083 below gross, against ◎0.0003 for cashed harvests.
- A straddled record also contains the harvest gain made before the straddle. Using `harvest_pnl_pct` from `straddle_gate_events` (41 of 48 records), the harvests were worth ≈ ◎0.61 before 10-26 (final ◎+0.77) and ≈ ◎0.26 since (final ◎+0.02).
- Inference: straddling added ≈ ◎+0.16 early and ≈ ◎−0.24 since 10-26. These harvest values are gross, so the comparison flatters the cashed-out side slightly. It has **not** paid since 10-26.

## 7. Capacity and idleness

`balance_history`, weekly averages from week 09-28 to week 11-23 (WIB Mondays):

| week | AUM ◎ (balance_history) | bot deployed ◎ (records) | operator deployed ◎ (records) |
|---|---|---|---|
| 09-28 | 3.17 | 3.3 | 1.9 |
| 10-05 | 5.80 | 3.0 | 2.9 |
| 10-12 | 2.29 | 0.7 | 1.7 |
| 10-19 | 0.86 | 0.6 | 0.1 |
| 10-26 | 0.68 | 0.3 | 0.0 |
| 11-02 | 2.09 | 0.4 | 0.0 |
| 11-09 | 1.79 | 0.9 | 0.0 |
| 11-16 | 0.06 | 0.0 | 0.0 |
| 11-23 | 5.88 | 0.6 | 1.4 |

- `deployedSol` in `balance_history` was 2.28 / 4.32 / 1.78 / 0.57 / 0.31 / 0.46 / 1.02 / 0.03 / 3.56 over the same weeks.
- The records count capital at entry, so held, underwater positions make them exceed AUM in late September and early October.
- 20 of 64 days (09-26 → 11-28 WIB) had no bot deploy that has closed (10-22 → 10-27 and 11-14 → 11-24 included). 34 days had no operator deploy.

## 8. Since the 11-25 changes

| group | n | Σ ◎ | median % | win | ≤−10 % |
|---|---|---|---|---|---|
| bot, deployed since 11-25 10:29Z | 9 | +0.222 | +1.00 | 89 % | 0 % |
| bot, the 30 days before | 87 | −0.116 | +0.49 | 62 % | 11 % |

- Trailing closes: median give-back 1.17 pp (n 4) vs 1.97 pp (n 29); median final +2.26 % vs +1.32 %.
- Four of the nine closes are FLOAT-SOL.
- Too small to read.

## 9. Other standouts

1. **The bot's operator-touched deploys decide its sign.** 38 closes (manual, external or held) made ◎+1.664 on 769 SOL-hours. The other 413 made ◎+0.353 on 1,712.
2. **The stop/win asymmetry is the bot's economics.** One stop ≈ 5.6 average trailing or harvest wins (◎−0.090 vs ◎+0.016).
3. **The operator's October** (◎−4.917) is the whole book's loss. Held operator positions: 28 closes, ◎−1.342, 39 % disasters. Not held: 187, ◎−3.181 (`was_held` exists only since 10-11, 43 % coverage).

## Candidate hypotheses to register

1. Deploys starting 00:00–04:00 WIB carry about three times the disaster rate. n 90; survives drop-2 and both halves, and holds within volatility < 4.43. Relates to the existing, off deploy-timing gate, whose blocks are UTC-aligned (00–04 WIB = 17–21 UTC).
2. Top-quartile volatility (≥ 4.43, ≈ width ≥ 67 bins) deploys lose money. n 113; survives drop-2 and both halves.
3. Low bot-holder share (< 11.2 %) deploys lose money. n 112; survives drop-2 and both halves but is not monotone in half 2 — weak.
4. Straddling a harvest beats cashing it out. n 41 with harvest values; sign flips between halves (≈ +0.16 / −0.24 ◎) — not robust.

## Data caveats

- SOL figures only from 09-26 on. All 666 records carry `pnl_sol_net`; 77 % of bot records are wallet-audited.
- Coverage is under 90 % for:

| field | coverage | note |
|---|---|---|
| `was_held` | 39 % (bot) | since 10-11 |
| `exit_slippage_sol` | 78 % | |
| measured entry premium | 37 records | |
| `pnl_sol_net_components` | 2 % | |
| run-up / off-high | 78 % | |
| fee edge | 68 % | |
| previous-close gap | 55 % | |
| 24 h change | 54 % | |
| pool age | 34 % | |

- `token_age_hours` comes from `signal_snapshot`.
- Means are pulled by a few records (CRAWL +66 %, wifout −91 %); medians and trimmed sums are the safer read.
- Open positions are not in the records, which understates the latest week's deployment.
