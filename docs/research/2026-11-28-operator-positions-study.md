# Operator positions, holds and token age — exploratory study (2026-11-28)

Read-only. Population: **215 closed operator positions** (adopted, not a recovered bot deploy, not a rebalance leg) closed **2026-09-26 → 2026-11-28** (unit era v3; 77 tokens). Net = `pnl_sol_net` (159 wallet-audited, 34 group-allocated, 22 modelled). Token age at entry = (close − `minutes_held`) − Jupiter `firstPool.createdAt` (known for all 77 tokens). Holds come from `position_events` hold/resume rows; since 10-11 these match `was_held` on 93 of 93 records. Tick work uses raw poller `price_ticks` of the 45 held positions. **Every cut below was chosen after looking at the data, so each finding is a hypothesis.** "Halves" means 09-26→10-26 (n=165) vs 10-27→11-28 (n=50). The operator had almost no positions between 10-21 and 11-21, so the second half is effectively 11-22→11-28.

## Summary

- All 215 operator positions: Σ net **−◎4.52**, median +1.07 %, 61 % wins, 16 % at ≤ −10 %. Without the 2 best and 2 worst: −◎3.14. Halves: −◎4.89 then +◎0.36.
- **Held positions carry the loss.** Held: n=45, −◎5.48, 40 % at ≤ −10 %. Never held: n=170, +◎0.95. The split does not survive halving: the held group is −◎5.68 in the first half and +◎0.21 in the second.
- **The worst cell is young (< 24 h) + thin (< $100K) + held:** n=21, −◎4.71, median −13.7 %. The same young thin pools when not held: n=46, +◎0.02. Halves: −◎4.81 (n=10, October) then +◎0.10 (n=11). This rests on the October cases DUST, FACTORY and ART ×2.
- **Thin-pool limit counterfactual.** 10 held young thin positions crossed −25 % for 60 s. 4 were closed by the limit. Of the 6 it did not close, 5 finished at −34 … −95 %. One, WINSTON on 11-27, recovered to +17.9 % and is ≈ +◎1.13 better than closing at the crossing. Σ (actual − close at the crossing) over the 6 = **−◎1.46**, or −◎1.33 without the two largest.
- **Fees are real but do not cover price on young tokens.** On tokens < 6 h old, fees were 12.1 % of capital and price/IL −18.5 %.
- The operator's own exits and the rules' exits net about the same: −◎2.02 (n=87) vs −◎2.50 (n=128). After a stop, rug or crash exit, mcap rose within 60 min more often than after the operator's own losing closes: 51 % vs 19 %.

## Q1 Token age at entry

| age | n | Σ net ◎ | mean % | median % | win | ≤−10 % | Σ ex 2+2 |
|---|---|---|---|---|---|---|---|
| < 6 h | 47 | −3.859 | −7.06 | +0.47 | 55% | 32% | −2.078 |
| 6–24 h | 41 | −0.911 | −0.47 | +1.07 | 66% | 15% | −0.365 |
| 24–72 h | 53 | +0.858 | +1.45 | +1.25 | 60% | 13% | +0.977 |
| 3–7 d | 35 | +0.026 | +1.12 | +1.89 | 74% | 6% | +0.584 |
| > 7 d | 39 | −0.638 | −1.90 | +0.54 | 54% | 13% | +0.024 |

Young and thin overlap heavily: 67 of the 88 positions on tokens < 24 h old were in pools under $100K (median entry TVL $40K vs $145K for older tokens). The 2×2 table points to the interaction rather than to age alone:

| | n | Σ net ◎ | median % | ≤−10 % | halves Σ |
|---|---|---|---|---|---|
| young & thin | 67 | −4.69 | +0.51 | 30% | −5.09 / +0.40 |
| young & ≥$100K | 21 | −0.08 | +1.46 | 5% | (all 1st half) |
| old & thin | 52 | +0.39 | +1.08 | 13% | +0.45 / −0.06 |
| old & ≥$100K | 75 | −0.14 | +1.45 | 9% | −0.16 / +0.02 |

Held vs not held, by age: tokens < 6 h held n=15, −◎3.64 vs not held n=32, −◎0.22. Tokens 6–24 h held n=7, −◎1.02 vs not held n=34, +◎0.11. Holding is most common on the youngest tokens: 32 % of < 6 h positions vs 15–21 % in the other buckets. Conclusion: "young" is mostly a thin-pool population. On these 21 positions young-but-thick does not lose. The young-thin loss sits in the held subset and in October.

## Q2 Thin-pool hold limit

All 6 fires were operator positions:

| pair | close (UTC) | age h | entry TVL | close % | net ◎ | mcap +60 / +180 / +720 min | all-base proxy Δ◎ +60 / +180 | later entries same token |
|---|---|---|---|---|---|---|---|---|
| PRIME | 10-17 12:37 | 6.2 | $27K | −27.7 | −0.312 | −19 / −42 / −56 | −0.14 / −0.29 | none |
| 索拉纳 | 10-17 15:26 | 2.5 | $35K | −29.3 | −0.447 | −59 / −68 / −74 | −0.51 / −0.58 | none |
| JIMMY | 11-25 18:38 | 40.8 | $77K | −26.1 | −0.714 | +13 / −31 / −45 | +0.27 / −0.64 | 2 (+0.029, +0.151) |
| BASKET | 11-25 18:51 | 9.2 | $80K | −25.2 | −0.403 | +13 / −18 / +47 | +0.14 / −0.20 | 1 (+0.010) |
| MoonBoy | 11-27 22:21 | 1.0 | $21K | −29.5 | −0.390 | +34 / +47 / – | +0.34 / +0.46 | none |
| Snowball | 11-28 02:16 | 43.3 | $42K | −31.7 | −0.949 | +11 / +16 / – | +0.23 / +0.34 | none yet |

The proxy is (1 + close %) × (1 + mcap move) − 1, i.e. a position fully in the base token. It is an inference, not a measurement. Over the 6 fires it sums to +◎0.34 at +60 min and −◎0.93 at +180 min. For the 4 young fires: −◎0.17 / −◎0.62.

**Counterfactual for exempting young tokens.** I emulated the rule on the ticks of the 45 held positions: inside a hold interval, every reading ≤ −25 % for 60 s, with ≥ 2 distinct readings. It reproduces the documented FACTORY fire time (14:07Z) and 4 of the 6 real fires; it misses JIMMY and BASKET, whose real fires were 65 s / 60 s. The record field `mae_pnl_pct` shows ≤ −25 on 11 held thin positions vs 13 by ticks; it was frozen on HOLD before 10-11, e.g. DUST −4.5 against a final −94.8.

Held thin positions that crossed and were **not** closed (limit not live, or hands-off):

| pair | date | age h | crossing % | final % | Δ actual − close at crossing ◎ |
|---|---|---|---|---|---|
| SM | 10-05 | 6.5 | −30.3 | −34.3 | −0.040 |
| DUST | 10-03 | 5.6 | −31.6 | −94.8 | −1.265 |
| ART | 10-07 | 2.6 | −29.0 | −58.0 | −0.439 |
| ART | 10-07 | 1.3 | −36.2 | −76.2 | −0.204 |
| FACTORY | 10-10 | 2.7 | −29.7 | −73.0 | −0.641 |
| WINSTON | 11-27 | 1.6 | −31.5 | +17.9 | +1.127 (on the pre-top-up ◎2.28) |
| PsyopAnime | 10-17 | 6,706 | −30.2 | −12.6 | +0.176 (old token, OFF window) |

- **< 24 h, < 72 h and < 7 d give the same set.** No unfired thin crossing had an age between 24 h and 7 d. That is 6 unfired cases: 5 worse, 1 better, Σ −◎1.46 (−◎1.33 without DUST and WINSTON). An exemption would also have kept the 4 young fires open, with the proxy results shown above.
- **10-17 → 11-24, limit OFF.** One thin crossing closed in that window: PsyopAnime, recovered to −12.6 %. snowball-SOL 11-22 was closed by hand at −25.7 %, at the line. Thick-pool held crossings over the whole period: 5, Σ −◎0.11.
- **Basis.** This rests on 10 young-thin crossings, 4 of them fires. WINSTON is the only recovery, and the limit did not fire on it although it was live. Probably the operator's hands-off set that day; I did not verify this. 20 held thin positions never crossed: +◎3.30, median +6.5 %.

## Q3 Holds

| | n | Σ net ◎ | median % | ≤−10 % | Σ ex 2+2 |
|---|---|---|---|---|---|
| held | 45 | −5.475 | +2.88 | 40% | −4.094 |
| never held | 170 | +0.952 | +1.06 | 10% | +1.338 |
| closed while on HOLD | 33 | −6.972 | −13.67 | 55% | −5.591 |
| released before close | 12 | +1.497 | +7.49 | 0% | +0.655 |

- **Hold length:** median 283 min (quartiles 54 / 596). Holds over 24 h: 7, of which 6 lost; Σ −◎3.62, median −41 %. This is selection: a hold stays on because the position is under water.
- **Give-back from the held high**, using the record `hold_peak_pnl_pct` (since 10-10; 15 positions without a capital change): median 24.5 pp, 9 of 15 gave back ≥ 10 pp. The tick-derived highs are polluted by pre-index top-up readings (JIMMY "317 %"), so I did not use them.
- **Operator hand-closes while held (25).** The big losers were closed near their worst: DUST −94.8 (worst −95.1), FACTORY −73.0 / −73.0, SAPIJIJU −69.5 / −75.7. Some were closed above the worst: CRAWL −46 / −65, FTR −17.9 / −43.3, PsyopAnime −12.6 / −30.2.

## Q4 Exits

| family | n | Σ net ◎ | median % | mcap +60 min median / % up | +180 min median / % up |
|---|---|---|---|---|---|
| manual | 77 | −1.013 | +0.71 | −6.9 / 31% | −11.0 / 34% |
| external | 10 | −1.008 | 0.00 | n/a (unprobeable) | |
| trailing_tp | 65 | +2.913 | +3.24 | −9.5 / 22% | −14.0 / 28% |
| harvest | 15 | +0.513 | +2.14 | −11.5 / 27% | −18.3 / 20% |
| stop_loss | 11 | −1.423 | −16.09 | +4.5 / 64% | −6.0 / 45% |
| hold_limit | 6 | −3.215 | −28.50 | +12.0 / 67% | −24.3 / 33% |
| rug | 8 | −0.357 | −4.99 | +5.4 / 62% | +13.9 / 75% |
| crash | 5 | −1.128 | −27.78 | −4.7 / 40% | −32.5 / 40% |
| tvl_floor | 6 | −0.056 | 0.00 | +23.2 / 67% | +12.6 / 67% |

- **Operator-closed (87): −◎2.02.** Without the 2 largest: +◎1.01. Halves: −◎4.27 / +◎2.25.
- **Rule-closed (128): −◎2.50.** Halves: −◎0.61 / −◎1.89.
- **After the close:** following the operator's winning closes, mcap fell (median −6.2 % at +60 min, 38 % up). Following its losing closes, 19 % up at +60 min. Following rule-closed losers, 51 % up.
- **Base rate:** mcap after a close declines in most families, so "price fell after the exit" is the norm and is not evidence of skill.

## Q5 Fees vs price

Fields: `fees_sol_true`; price/IL = `pnl_sol` − fees, a residual that includes swap costs. Coverage: 207 of 215.

| group | n | Σ gross ◎ | Σ fees ◎ | Σ price/IL ◎ | fees % cap | price % cap |
|---|---|---|---|---|---|---|
| < 6 h | 47 | −3.45 | +6.55 | −10.00 | 12.1% | −18.5% |
| 6–24 h | 40 | −0.69 | +1.54 | −2.23 | 5.1% | −7.4% |
| 24–72 h | 50 | +1.17 | +4.71 | −3.54 | 7.7% | −5.8% |
| 3–7 d | 34 | +0.22 | +1.28 | −1.06 | 4.0% | −3.3% |
| > 7 d | 36 | −0.33 | +1.57 | −1.90 | 4.6% | −5.5% |
| open < 1 h | 79 | −0.16 | +2.75 | −2.91 | 3.6% | −3.8% |
| 1–6 h | 97 | +1.33 | +6.31 | −4.98 | 6.6% | −5.2% |
| 6–24 h | 23 | −0.67 | +5.83 | −6.50 | 18.5% | −20.7% |
| > 24 h | 8 | −3.57 | +0.77 | −4.34 | 10.1% | −57.1% |

- **Fee rate:** young tokens earn about 5× the fees per hour of older ones (median 6.6 % vs 1.2 % of capital per hour).
- **Coverage of price loss:** fees covered the price loss in 32 of the 62 young positions that had one. In aggregate, the young positions are not paid by fees.

## Q6 Repeat tokens

23 tokens had ≥ 3 positions. Most are small ±. The losers are DUST (5, −◎2.00), ART (8, −◎1.13), 索拉纳 (3, −◎0.53) and SI (6, −◎0.44); each is driven by one held collapse. By n-th entry (#1 / #2 / #3 / #4 / #5+): Σ −0.53 / −2.26 / −0.51 / +1.15 / −2.37, so there is no decay pattern.

- **After a win:** n=89, −◎1.77.
- **After a loss:** n=49, −◎2.22; without the 2 largest +◎0.58.
- **Re-entry ≤ 30 min after a loss:** n=27, −◎2.66, mean −6.0 %. Without the 2 largest it is +◎0.15, and 23 of the 27 are in the first half. Re-entry > 30 min after a loss: n=22, +◎0.44.

## Q7 Size

< 0.5 ◎: n=73, −◎0.29 · 0.5–1: n=47, −◎1.29 · 1–2: n=76, −◎0.88 · 2–3: n=17, −◎2.54 (ex 2+2 −◎0.73) · ≥ 3: n=2. Medians range +0.6 … +2.7 %. No monotone relation in percent; the SOL losses in the 2–3 ◎ band come from a few large collapses.

## Q8 Time

| period | n | Σ net ◎ | median % | ≤−10 % |
|---|---|---|---|---|
| 09-26 → 09-30 | 21 | −0.053 | +1.65 | 10% |
| October | 146 | −4.917 | +1.21 | 17% |
| November (all 11-22 → 11-28) | 48 | +0.447 | +0.29 | 17% |
| last 14 days (≥ 11-14) | 48 | +0.447 | +0.29 | 17% |

Weeks 41–42 (10-05 → 10-18) account for −◎5.49. The 272 operator positions before 09-26 can only be compared in percent (mean +2.1 %, median +1.8 %, 12 % at ≤ −10 %).

## Q9 Other

1. **Grace with the stop paused on operator positions:** 8 positions, −◎0.28, 6 of 8 at ≤ −10 %. Two were apparent pre-index readings that ended positive (Huss, Snowball).
2. **Positions with a capital change (top-up or withdrawal):** 8, +◎0.94, but every percent field on them is unreliable.
3. **Wallet audit:** 11 of the 215 records are `mismatch` and 34 `incomplete`; their net stays modelled.

## Candidate hypotheses (to register, not to act on)

- H1: Held positions on tokens < 24 h old in pools < $100K that cross −25 % for 60 s finish below that level more often than not (5 of 6 unfired cases did).
- H2: The operator-position loss comes from young × thin × held, not from token age by itself (young but ≥ $100K: n=21, ≈ flat).
- H3: Stop, rug and crash exits on operator positions sell nearer the low than the operator's own losing closes (mcap up at +60 min: 51 % vs 19 %).
- H4: Fees on tokens < 6 h old do not offset price/IL in aggregate (+12 % vs −18 % of capital).
- H5: Re-entering the same token ≤ 30 min after a loss underperforms. Weak: it does not survive dropping the top 2.

## Data caveats

- **Owner:** the `owner` field exists on only 37 records; operator was otherwise taken from `adopted` plus the registry's `strategy_source`.
- **Second half is thin:** n=50, all from one week.
- **Token age:** taken from the first pool's creation time; this may differ from the mint time.
- **Δ figures:** a pp difference × final `amount_sol`. Top-ups distort them; WINSTON was recomputed on its pre-top-up capital.
- **Tick paths:** re-ranged positions were diluted before 10-03. Pre-index top-ups inflate highs, and single −94 % `missing_price` readings occur; the 60 s rule filters most of them.
- **Post-close probes:** these are pool mcap, not position value.
- **WINSTON hands-off:** not verified.

Scripts: session scratchpad `study-operator/` (`build.py`, `q1.py`, `q2*.py`, `q3to8.py`, `q9.py`).
