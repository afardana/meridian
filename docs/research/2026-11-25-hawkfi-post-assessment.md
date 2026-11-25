# HawkFi "Precision Hybrid / MEV Boost" post — assessment against Meridian's evidence (2026-11-25)

## Summary
- **The product:** HawkFi (formerly Hawksight) automates Meteora DLMM positions through its own program. "Precision Hybrid" is a 50 % spot + 50 % bid-ask shape with "Ping Pong" range moves that do not swap. "MEV Boost" is an opt-in alpha feature. HawkFi charges an 8 % performance fee on yield.
- **Documentation is thin.** The docs describe settings, not execution. There is no definition of "Trading PnL" or "markouts", no MEV Boost mechanism, signal or latency, and no published results. The post's formula "Fees + Trading PnL + MEV PnL" does not appear in the docs.
- **Claim by claim:**
  - *LPs lose value to arbitrage* — **supported**, by the literature and by our own fills (Part 4).
  - *Continuous rebalance keeps you in range* — **contradicted** for us: re-centring at the top is LVR, and our engine lost −4 SOL.
  - *Turn negative IL into positive IL* — **unsupported**. In SOL terms a single-sided bid ladder's trading PnL is ≤ 0 by construction. HawkFi's own docs only say rebalances "amplify" IL either way.
  - *MEV Boost* — **unverifiable**, and not feasible for a 5-second retail keeper (Part 5).
  - *50 / 50 shape* — **tested: not met** (below).
- **Replay of the 50 / 50 initial shape** (registered first, 332 bot positions, close times fixed; [hybrid-shape](../experiments/hybrid-shape.md)): Σ Δ ◎+0.13 (90 % CI −0.10 … +0.38), 77 better / 176 worse, first half negative. Capital +1.14 against fees −1.06. **NOT MET.**
- **Our "Trading PnL":** fees ◎4.63 against an inventory mark-down of −◎4.44, so net +◎0.18 (+0.11 % of capital) before exit costs. Ladder buy fills mark out −2.2 % at 1 min and −0.4 % (SOL-weighted) at 60 min. Only 36 % of buy fills are above water at 60 min. Fees cover adverse selection everywhere except stop-class closes, where it is worst (fees 4.2 % vs mark-down −16.5 %).
- **Recommendation:** change nothing. Bin shape, re-centring and "MEV" repositioning all trade fees against inventory, and none beats zero on our data. The lever that does show up is the stop-class tail, already handled by entry rules (TVL band, post-stop cooldown).

---

## Part 1 — What HawkFi actually documents
The source is HawkFi's GitBook (page index: https://hawkfi.gitbook.io/whitepaper/llms.txt), read 2026-11-25. Two pages linked from search results return 404:
- `…/precision-hybrid-50-50-spot-bid-ask`
- `…/market-making-mm-agents`

X, Discord and YouTube were not opened. Nothing about the operator, the wallet or the bot was sent anywhere.

| topic | documented (quotes ≤ 15 words) | only asserted in marketing | not found |
|---|---|---|---|
| **Precision Hybrid** ([model page](https://hawkfi.gitbook.io/whitepaper/hawkfi-solana/hawkfi-models/precision-hybrid.md)) | "50% Spot and 50% Bid-Ask split around the active bin"; spot keeps liquidity "concentrated near the current price"; entry advice "wide, single-side SOL only" during corrections; the "+ Rebalance" variant defaults to "34 BINS", "UP & DOWN, 0M COOLDOWN, PING PONG 68-0-68" | "turn negative IL into positive IL"; "fee printing + bid-ask trading". The docs' own line: "Rebalances amplify positive IL upwards, and negative IL downwards" ([how-to-reduce-il](https://hawkfi.gitbook.io/whitepaper/learn-hawkfi/how-to-reduce-il.md)) | how the two halves are laid out against each other; one- vs two-sided by default; total range width; the AMM is not named on the model page (MEV Boost and the FAQ name Meteora DLMM only) |
| **Rebalance** ([reshape](https://hawkfi.gitbook.io/whitepaper/hawkfi-solana/hawkfi-models/build-your-own-models/reshape-liquidity-rl.md), [auto-rebalance](https://hawkfi.gitbook.io/whitepaper/hawkfi-solana/hawkfi-models/build-your-own-models/auto-rebalance-ar.md), [ping pong](https://hawkfi.gitbook.io/whitepaper/hawkfi-solana/hawkfi-models/build-your-own-models/auto-rebalance-ar/ping-pong-auto-rebalance.md), [FAQ](https://hawkfi.gitbook.io/whitepaper/guides-and-support/faqs.md)) | reshape keeps the range and moves the shape after "Allowed Bin Movement (1 to 51 bins)" (another page says 1–69); auto-rebalance moves the range — swapped, swapless or Ping Pong, cooldown 0 min–24 h; Ping Pong fires when the position "goes out of range below" (or above) and "uses swapless rebalance mechanics"; fees "0% deposit/withdrawal", an 8 % performance fee "on the yield only, not initial deposit"; custody is a program-derived "HFI wallet" | "continuously stays in range" | how the new range is centred; who signs and how fast (keeper design); per-rebalance cost; whether the program is upgradeable. The Ping Pong page says its example values are placeholders |
| **MEV Boost** ([alpha](https://hawkfi.gitbook.io/whitepaper/hawkfi-solana/mev-boost-alpha.md), [quick start](https://hawkfi.gitbook.io/whitepaper/quick-start/mev-boost.md), [risks](https://hawkfi.gitbook.io/whitepaper/guides-and-support/understand-fees-and-risks.md)) | opt-in alpha, eligible DLMM positions only; (1) cross-pool arbitrage when an asset is "priced differently elsewhere", (2) pulling liquidity from bins where "anticipated flow may be net-negative", (3) re-quoting after an arbitrage; PnL cards show "estimated uplift" and a "landed-arbitrage count"; "does not guarantee higher PnL"; does not eliminate adverse selection | "MEV the bots back"; repositioning "when toxic MEV & Arb bots show up" | the toxicity signal; latency; on-chain vs off-chain; who keeps the arbitrage profit; how "estimated uplift" is computed; any results |
| **Backtests / Trading PnL** ([laboratory](https://hawkfi.gitbook.io/whitepaper/hawkfi-laboratory/hawkfi-laboratory.md)) | backtests on "real historical pool data" against "HODL and passive benchmarks"; "Backtests do not predict the future"; triggers use the pool price | "Fees + Trading PnL + MEV PnL"; "Institutional market makers heavily print from spread"; a search snippet ("keep 100% of PnL spread (Markouts)") points to the 404 page | any definition of Trading PnL, markouts or IL; what the backtests model (fees, gas, fills); any published returns |
| **Independent coverage** | [Solana Compass](https://solanacompass.com/projects/hawkfi): one CertiK audit of Hawksight's programs (2022, 29 findings, 4 major) that "predates the current HawkFi product"; DefiLlama about $565k TVL (search snippet only) | — | any independent review, on-chain study or dashboard of results |

**The independent view of LVR and markouts:**
- **LVR** (Milionis, Moallemi, Roughgarden, Zhang 2022, https://arxiv.org/abs/2208.06046) is the running cost a passive AMM LP pays to arbitrageurs, who trade against stale prices. Fees must exceed it. It scales with volatility and with the marginal liquidity near the price, and it applies to concentrated liquidity.
- **IL and LVR agree for small moves** (https://arxiv.org/html/2410.00854v2).
- **Markouts as the measure of LP profitability** on Uniswap v3: FLAIR (https://arxiv.org/html/2306.09421v1) uses markouts for exactly this. An ethresear.ch analysis (https://ethresear.ch/t/order-flow-toxicity-on-dexes/13177) finds LPs lose to toxic flow on average.
- **Re-centring at the market price** realises the inventory the arbitrage already left the LP with. It does not undo that loss. The literature implies this rather than testing it directly, and our 2026-09-25 study measured it (re-centring at the top ≈ 3 % on a 20-bin retrace).
- **Meteora's own docs** ([strategies](https://docs.meteora.ag/overview/products/dlmm/strategies-and-use-cases)) describe bid-ask as edge-weighted liquidity that needs more frequent rebalancing. No independent backtest of bid-ask against spot was found.

## Part 2 — What Meridian already knew, claim by claim
| post claim | Meridian evidence (before today) | verdict |
|---|---|---|
| Passive LPs leak value to arbitrage | Structural for us: a single-sided ladder's upside is capped at break-even plus fees, and its downside is open (07-26 post-exit check). 12 % of fees kept on bot deploys 09-26 → 11-13 (◎11.36 fees → ◎1.40 net). | supported |
| "Rebalance continuously stays in range" | The autonomous roll-up / re-centre engine was removed 2026-09-25 after −4 SOL live, ≈ break-even under gates; re-centring at the top is LVR. The OOR-below flip (plan #07) was removed un-enabled. | contradicted for our flow |
| Two-sided exposure / "spread capture" | Two-sided first deploy replay (2026-10-02, 182 deploys): −3.5 … −4.9 SOL as a default, because it holds the token from minute one. The straddle lane (two-sided re-range at the top) is ≈ break-even net of its ≈ 0.7 % entry premium (wallet-vs-modelled gap study, 2026-11-25: 15 straddles, gross +◎0.117 → wallet +◎0.008). | contradicted as a default |
| "50 % bid-ask continuously trades price swings" | Bid-ask flip replay (2026-11-23, 361 positions): capital +0.85 vs fees −0.59 → Σ +◎0.18 (CI −0.07 … +0.46), 67 / 90 better / worse — NOT MET. Trailing closes before the price reaches the re-added asks. | contradicted on our exit stack |
| "Turn negative IL into positive IL" | For a SOL-denominated single-sided ladder below the price, the capital term at the close is ≤ 0. It is 0 only when the price ends at or above the range. A positive "IL" exists only in a numéraire that holds the token (USD, token-hold) or on a favourable path for a two-sided position. HawkFi's docs say rebalances "amplify" IL both ways. | unsupported (mathematically impossible in SOL for our ladder) |
| Initial 50 / 50 shape | never tested before today | → Part 3 |

The bot's shape mix in the window was spot 416, bid_ask 24 and curve 1 (`defaultShape` spot, bid-ask only on dip-entry theses).

## Part 3 — Replay of the 50 % spot + 50 % bid-ask initial shape
Registration, model and full grading log: [docs/experiments/hybrid-shape.md](../experiments/hybrid-shape.md). The order was: registration and README row, then the tick export, then the code and the run. Code: `scripts/replay/hybrid_shape_replay.js` (it imports the flip harness's bin model). Test: `test/hybrid-shape-replay.test.js`.

**Setup:**
- 332 positions, capital ◎169.67, fees ◎4.63.
- The model reproduces recorded close PnL to a median 0.014 pp.
- Close times fixed.
- Fees are weighted by bin crossings and anchored on the recorded fees.

| variant | ΣΔcap | ΣΔfee | −ΣΔexit | **ΣΔ** | CI 90 % | better / worse / tie | halves | stop-class (32) |
|---|---|---|---|---|---|---|---|---|
| **50 / 50 (primary)** | +1.142 | −1.057 | +0.045 | **+0.130** | −0.099 … +0.379 | 77 / 176 / 79 | −0.072 / +0.202 | +0.501 |
| 70 / 30 | +0.661 | −0.587 | +0.027 | +0.101 | −0.046 … +0.265 | 73 / 151 / 108 | −0.020 / +0.121 | +0.289 |
| 30 / 70 | +1.623 | −1.528 | +0.063 | +0.159 | −0.154 … +0.511 | 77 / 182 / 73 | −0.124 / +0.282 | +0.713 |
| 100 % bid-ask | +2.345 | −2.233 | +0.090 | +0.202 | −0.241 … +0.697 | 70 / 193 / 69 | −0.202 / +0.403 | +1.031 |
| 100 % curve | −2.465 | +2.470 | −0.090 | −0.085 | −0.620 … +0.395 | 205 / 76 / 51 | +0.318 / −0.403 | −1.088 |
| actual (control) | 0 | 0 | 0 | 0 | — | 0 / 0 / 332 | 0 / 0 | 0 |

| check (primary) | result |
|---|---|
| 1 n ≥ 100 | PASS (332) |
| 2 Σ Δ > 0 and CI low > 0 | **FAIL** (+0.130; low −0.099) |
| 3 better ≥ worse | **FAIL** (77 / 176) |
| 4 both halves > 0 | **FAIL** (−0.072 / +0.202) |
| 5 fee-robust > 0 | PASS (+0.060) |
| 6 \|worst\| ≤ ½ Σ | PASS (0.044 ≤ 0.065) |
| 7 stop-class > 0 or ≥ −25 % of gain | PASS (+0.501) |

**Sensitivities** (none of these decide):
- The time-in-active-bin fee model gives Σ +0.115.
- Exit rate 0.3 % + own slippage gives Σ +0.140.
- 155 of 332 positions would hit the trailing arm, the trailing fire or the stop at a different tick (trailing fire 83, earlier on only 14; stop 17, never earlier).

**Reading:**
- Moving capital down the ladder saves inventory on the stop-class closes (+◎0.50). It loses fee income on everything that oscillated near the top (the rest −◎0.37; harvests alone −◎0.31).
- The trade-off is monotone along the whole mix, from curve to bid-ask, and no point on it is distinguishable from zero.

**Verdict: not met → not built, added to the rejected list.**

## Part 4 — Markouts on our own fills (descriptive, no verdict)
`scripts/replay/fill_markout_study.js`, same 332 positions. A buy fill is the ladder buying tokens with a bin's SOL as the active bin moves down through it. A sell fill is the reverse.

The markout of a buy at horizon h is p(t+h) / p(bin) − 1 (positive is good for us). The price is the active bin while the position is open. After the close it is the pool's mcap ratio from the post-close probes (USD, log-linear between +30 / +60 / +180 min). At 60 min that applies to 6,403 of the 15,433 buy fills.

**Fees vs adverse selection (◎, % of capital):**

| group | n | fees | inventory mark-down at close | net |
|---|---|---|---|---|
| all | 332 | +4.628 (2.73 %) | −4.443 (−2.62 %) | **+0.185 (+0.11 %)** |
| positions with ≥ 1 buy fill | 298 | +4.624 | −4.443 | +0.185 (fees ≥ mark-down on 252) |
| stop-class (stop, rug, young stop) | 32 | +0.719 (4.16 %) | −2.846 (−16.47 %) | **−2.127** |
| everything else | 300 | +3.909 (2.57 %) | −1.597 (−1.05 %) | +2.312 |
| trailing TP | 98 | +2.635 (4.98 %) | −1.554 (−2.94 %) | +1.081 |
| harvest | 80 | +1.004 (2.56 %) | 0 | +1.004 |
| entry TVL ≥ $200k | 154 | +2.124 (2.65 %) | −1.739 (−2.17 %) | +0.385 |
| entry TVL $100–200k | 144 | +2.373 (2.83 %) | −2.606 (−3.11 %) | −0.233 |
| entry TVL < $100k (scouts) | 34 | +0.131 | −0.098 | +0.033 |
| pool age < 24 h | 75 | +1.436 (3.41 %) | −1.503 (−3.57 %) | −0.067 |
| pool age 1–7 d | 36 | +0.747 | −0.960 | −0.213 |
| pool age unknown (before 10-02) | 221 | +2.445 | −1.981 | +0.464 |

These figures are before exit-swap cost and gas, which the replay keeps separate.

**Markouts of buy fills** (15,433 fills; SOL-weighted mean / median / share positive):

| horizon | all | ≤ 2 bins in the prior 60 s (8,228) | ≥ 7 bins in the prior 60 s (2,442) |
|---|---|---|---|
| at the fill | −1.70 % / −0.99 % / 0 % | −1.10 % / −0.99 % / 0 % | −3.54 % / −2.94 % / 0 % |
| +1 min | −2.21 % / −1.23 % / 5 % | −1.44 % / −0.99 % / 4 % | −4.06 % / −3.90 % / 9 % |
| +5 min | −2.09 % / −1.97 % / 18 % | −1.62 % / −1.23 % / 17 % | −2.37 % / −2.94 % / 24 % |
| +30 min | −0.75 % / −2.94 % / 34 % | −1.57 % / −2.36 % / 33 % | +4.93 % / −3.62 % / 36 % |
| +60 min | −0.38 % / −3.14 % / 36 % (Σ −◎0.51) | −1.42 % / −2.94 % / 35 % (Σ −◎1.01) | +6.45 % / −3.90 % / 38 % (Σ +◎1.27) |

What the table shows:
- **At the fill.** A crossed bin is at least one bin above the new active bin, so the markout at the fill is always negative. That is DLMM's spread: one bin step, paid back by the swap fee.
- **Early momentum.** The price keeps falling for the first 1–5 minutes after the ladder buys.
- **The recovery is in a minority.** The SOL-weighted mean recovers by 60 min, but the median keeps sliding (−3.1 %) and only 36 % of fills are above water. A small number of large rebounds carry the mean.
- **Fast moves.** Fills during fast moves (≥ 7 bins in 60 s) are the worst at 1 min. They are also the ones that rebound most: their 60-min mean is positive, though their median is not.
- **Sell fills (12,584).** The ladder selling back as the price rises marks out −1.6 % at the fill and −3.7 % (mean) at 60 min, with 46 % positive. The price keeps rising after we sell. That is the capped upside of a SOL-scored ladder.
- **Where it is worst:** stop-class closes, the $100–200k entry-TVL band, and pools under 7 days old. Of these, only the stop-class tail is large.

## Part 5 — "MEV Boost" and continuous rebalance: feasible for Meridian?
1. **Timing.** Arbitrage and sandwich flow lands within a slot (≈ 400 ms), often in Jito bundles.
   - Our PnL poller runs every 5 s.
   - The socket monitor hears an lbPair write only after the trade has landed.
   - Any reaction on our side is therefore at least one slot after the flow it is meant to avoid.
   - Getting ahead of it needs a leading signal. In memecoin pools, price discovery is on-chain in other pools (Pump.fun / Raydium / other DLMM pools) and the arbitrage that moves our pool comes from searchers acting on those very moves.
   - Beating them means landing a bundle before theirs, which is searcher work, not LP work. HawkFi documents no signal, no latency and no results.
2. **Cost per action.**
   - A pull and re-add is two transactions (or one `RebalanceLiquidity` plus one add). At our measured exit fees that is ◎0.00002–0.0003 per action, which looks cheap.
   - The real costs are elsewhere. Fees are forgone while the liquidity is out: by Part 4, fills during fast moves pay the most fee per bin, because DLMM's variable fee rises with the volatility accumulator.
   - Meteora counts every re-deposit in `allTimeDeposits`. That broke our PnL percent basis before (fixed by `pnlPctBasisSol`).
   - A pull realises inventory at the current price; it does not avoid the loss already taken.
3. **Is toxic flow separable in advance in our data?** We store the active bin every 5 s (poller) and on every lbPair write (socket), the position's `peak_dynamic_fee_pct`, and nothing per trade (no trade size, no signer, no per-tick variable fee).
   - The only observable we have is bin velocity at the fill.
   - On it, fast-move fills are worse for 1–5 minutes and better at 30–60 minutes (mean +6.5 %, Σ +◎1.27 at 60 min against −◎1.01 for calm fills).
   - A "pull liquidity when the price moves fast" rule would have given up the fills that later rebounded. That matches the 2026-09-26 crash-regime replay, where every faster exit on fresh, thin or volatile pairs lost.
4. **Judgment:** not feasible for Meridian and not supported by our data. The DLMM variable fee is already the on-chain defence against fast toxic flow, and the bot's measured adverse selection is concentrated in the stop-class tail. That tail is decided at entry (TVL band, post-stop cooldown), not by a keeper's reaction time.
   - **Measurement to register: none.** If the question returns, the prerequisite is capture, not a rule: the lbPair variable fee (volatility accumulator) on each socket tick in `price_ticks`, so fill markouts can be set against the fee actually charged at the fill. That is a code change in the capture path and needs the operator's go-ahead.

## Limits
- **Close times are fixed in the replay.** In live use, 155 of 332 positions would have closed at a different tick under the hybrid (direction mixed). The fixed-time result is a guide, not a forecast.
- **Fee attribution is modelled.** It is crossing-weighted and anchored on recorded fees, with time-in-bin as a sensitivity. Our liquidity is assumed not to change the pool's other liquidity or the flow. A larger top-bin share might draw more flow in reality, or less.
- **Shapes are linear stand-ins.** Curve is a linear stand-in for Meteora's one-sided curve. HawkFi's exact hybrid layout is undocumented ("split around the active bin"); the test used our single-sided range.
- **Some positions are excluded.** 19 positions where the model misses the recorded PnL by > 0.5 pp are out, 8 of them stop-class (Diamond-SOL −25.8 % among them). The stop-class gain could be larger or smaller with them.
- **Markouts after the close** use USD mcap probes, so SOL/USD drift and close selection are mixed in (stops close at lows). The 60-min figures lean on them for 41 % of fills.
- **Era.** Pool age is known only from 2026-10-02. No bot close between 2026-11-13 and 2026-11-25 (prod `maxPositions` 0).
- **Scope of the HawkFi review.** Only public docs were read; X, Discord and the app were not. HawkFi's backtests and the MEV Boost mechanism could not be checked.
