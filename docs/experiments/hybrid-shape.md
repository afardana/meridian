---
id: hybrid-shape
config_key: null
status: not_met
mode: none
registered_at: 2026-11-25
enforce_built: false
---

# Hybrid initial shape (50 % spot + 50 % bid-ask, same range)

## Claim
Deploying the bot's single-sided SOL ladder as 50 % spot + 50 % bid-ask (by capital, same range)
ends with more SOL than the shape actually deployed, with close times unchanged.

Source: a HawkFi (hawkfi.ag) promotion seen 2026-11-25 ("Precision Hybrid: 50 % Spot … 50 %
Bid-Ask continuously trades price swings"); HawkFi's GitBook documents the shape as "50% Spot and
50% Bid-Ask split around the active bin" and recommends a "wide, single-side SOL only" entry
(assessment: `docs/research/2026-11-25-hawkfi-post-assessment.md`). Only the INITIAL distribution
is tested here — HawkFi's continuous re-shape / "Ping Pong" rebalance is the rejected re-centre and
flip family (see README "Rejected": roll-up / re-centre engine 2026-09-25, bid-ask flip 2026-11-23,
two-sided first deploy 2026-10-02) and is not re-opened by this file.

Pass rule set by the orchestrating session (2026-11-25) and written here as given, before any
tick data for this replay was exported or any per-position result computed.

## What was known at registration (2026-11-25, before the data was cut)
Seen: the bid-ask flip replay (2026-11-23, 361 positions 09-26 → 11-13: spot 340, bid_ask 21;
passive model median |err| 0.02 pp) and its data caveats (records before 2026-10-11 carry no
`was_held`; CRAWL-SOL 69F2FsPS was held; 11 positions re-ranged without a counter, first tick
33–44 bins under `bin_range.max`); the perf-record strategy counts for bot closes since 09-26
(spot 416, bid_ask 24, curve 1). Not seen: any result of a shape-swap replay. Expectation written
down before running (not part of the rule): moving capital from the top bins to the bottom bins
lowers fee income (the top bins are crossed most) and changes capital only on positions whose
price went deep into the ladder, so the sign is open.

## Replay (scripts/replay/hybrid_shape_replay.js; bin model and helpers imported from scripts/replay/bidask_flip_replay.js)
- **Population:** bot deploys (not adopted, not a rebalance leg) closed 2026-09-26 → 2026-11-25
  (close < 2026-11-26T00:00Z) with a usable tick path. Excluded and listed with reasons:
  straddled (`straddle_count` > 0), re-ranged (`rebalance_count` > 0 — operator re-range or in
  place), ever held (`was_held` true, plus CRAWL-SOL 69F2FsPS by address because records before
  2026-10-11 carry no `was_held`), positions whose first tick in the window sits more than
  10 bins under `bin_range.max` (the flip study's re-range-without-counter cases), the flip
  study's other filters (missing geometry, non-SOL quote, < 2 ticks, first tick > 15 min late,
  strategy not spot / bid_ask / curve), and positions where the model does not reproduce the
  recorded close pnl within 0.5 pp under the ACTUAL shape.
- **Model:** the flip study's passive bin model (all values in SOL; bin i holds X_i tokens below
  the active bin and X_i·p_i SOL above it). Initial SOL per bin from a weight vector over the
  range, by capital: spot = equal; bid-ask = linear, top bin weight 1 … bottom bin weight n (as
  the flip harness); curve = linear, top bin weight n … bottom bin weight 1 (a linear stand-in
  for Meteora's one-sided curve); a hybrid α / (1 − α) = α × spot weights + (1 − α) × bid-ask
  weights, each normalised to the capital before mixing.
- **Fee scaling:** fee income per bin crossing ∝ the SOL value the position holds in the crossed
  bin (its liquidity share, the pool's other liquidity taken as unchanged). The recorded fee
  income under the actual shape is the anchor: c = recorded fees / W_actual, where W is the sum
  over crossings of the crossed bins' SOL value; a variant's fees = c × W_variant. A position with
  no in-range crossing (W_actual = 0) keeps its recorded fees under every variant (Δfee = 0;
  counted). Because a ladder is never re-shaped, a bin's SOL value is its deposit for the whole
  hold, so W = Σ_i (crossings of bin i) × deposit_i. Sensitivity, not deciding (added at
  registration because the crossing model ignores swaps inside the active bin, which matter for
  the top bin where spot and bid-ask differ most): fees ∝ Σ over tick intervals of the deposit in
  the active bin × the interval length while the active bin is in range, anchored the same way.
- **Gas** unchanged (no extra transaction). **Exit swap cost** scaled with the base-token value
  held at the close: Δexit = (token value at close under the variant − under the actual shape) ×
  r, signed. As given: "0.3 % + the record's own slippage ratio where present". Operationalised
  at registration as r = the record's own pool-basis exit-slippage ratio (clamped 0 … 10 %) where
  present, else 0.3 %; the literal reading r = 0.3 % + own ratio is reported beside it as a
  sensitivity and does not decide.
- **Δ per position** = Δcapital at the last active bin + Δfee − Δexit, at the recorded close time.
- **Primary variant:** 50 / 50 hybrid. Reported beside it, not graded: 100 % bid-ask, 100 % curve,
  30 / 70 and 70 / 30 (spot / bid-ask), and "actual shape" as the control (must reproduce the
  records: Δ ≡ 0, err as above).

## Pass rule (all must hold, on the primary variant, over the verdict set)
1. ≥ 100 positions in the verdict set, else `insufficient`.
2. Σ Δ > 0 SOL with the 90 % bootstrap interval's lower bound > 0.
3. better ≥ worse (|Δ| ≤ ◎0.0005 is a tie).
4. Σ Δ > 0 in each half of the period (split by close time into two halves of equal count).
5. Σ Δ still > 0 when the fee income attributed to the changed distribution is cut by half
   (fee-model uncertainty). Operationalised: per crossing, the variant earns c × min(w_var, w_act)
   in full and only half of c × max(0, w_var − w_act), i.e. liquidity the actual shape did not
   have in that bin earns half.
6. The worst single Δ is no larger in size than half of Σ Δ (|min Δ| ≤ ½ Σ Δ).
7. Σ Δ > 0 separately on closes by stop-class rules (stop_loss, rug, crash, young_stop,
   probation_stop) OR their Σ Δ is no worse than −25 % of the total gain — the shape must not buy
   its gain by deepening disasters.

`met` → a proposal to the operator in the session (a shadow tag or a size-limited trial; nothing
changes automatically). Anything else → not built; added to the rejected list with the numbers.

**Known limitation.** Close times are held fixed, but the exits read pnl, so a different shape
would in reality move some exits (direction unknown). Reported as a sensitivity count: positions
whose hybrid pnl path (recorded pnl + 100 × (Δvalue + c × ΔW) / capital, tick by tick) first
reaches the trailing arm (2 %), fires trailing (peak − 1.5 pp, the drop in force for this period),
or first reaches the stop (−15 %) at a different tick than the recorded path.

## Grading log

### 2026-11-25 (1,470-record export of 2026-11-25 17:28 WIB; tick export of 272,037 deduplicated poller rows) — **not_met**
Order, stated plainly: this file and its README row were written first; then the ticks were
exported (`scripts/replay/bidask_flip_export.sql`, read-only COPY on the VM) and the replay
written and run. One amendment was made after the export and before any per-position figure was
computed: the time-in-active-bin fee sensitivity and the W_actual = 0 rule were added to the
Model section (neither decides). Nothing was changed after the result.

Run: `node scripts/replay/hybrid_shape_replay.js --records <performance.json> --ticks <ticks.csv.gz>`
(session scratchpad `hawkfi/`: `report.txt`, `report.json`).

- **population:** 351 candidates → verdict set **332** (spot 311, bid_ask 21; no curve deploy
  survived), capital ◎169.67, recorded fees ◎4.628. Bot closes in the window end 2026-11-13 except
  two on 2026-11-25 (prod `maxPositions` 0 in between).
  Excluded (beyond adopted 465 / before 09-26 564): straddled 48, re-ranged 27, `was_held` 1
  (BORDR-SOL D6xwrzqb), known held 1 (CRAWL-SOL 69F2FsPS), missing geometry 3 (e/acc GXTwWq81,
  moin GoNCwAKK, moin 49SVAvcj), first tick > 10 bins under the top 10 (Agency BQUveLt9, CRAWL
  8Scki4XQ, knightcat Hx8eDVWn, Aiden 8bxcRK9a, CRAWL CuuQbVxW, baton B8DuoxF1, FTR 61T8mnDQ, HIGH
  Gc82ajNu, mihao DHiEwUyD, mihao EiUexv5x), model error > 0.5 pp 19 (|err| 0.51 … 15.14; 8 of them
  stop-class: OMNINU, CALI, swordcat AhLUT6Sx, OCTO GUcpmp1p, AUTON, CHOO, Diamond 6QvgecXm stop
  losses, www young stop; plus LEVERAGE / OCTO rug and 9 others — full list in `report.json`).
- **model:** actual-shape |err| median 0.014 pp, p90 0.044 on the verdict set (0.015 / 0.163 on all
  candidates); control Δ ≡ 0 on every position (max |Δ| 7e-18). 2 positions without an in-range
  crossing (Δfee = 0). Own exit-slippage ratio on 144 of 332, 0.3 % on the rest.

**Variants** (◎, Σ over the 332; exit column is −ΣΔexit; "time-fee" = Σ Δ under the
time-in-active-bin fee sensitivity; "exit-lit" = r = 0.3 % + own ratio; "sens" = positions whose
pnl path changes the first arm / trailing fire / stop tick):

| variant | ΣΔcap | ΣΔfee | exit | **ΣΔ** | CI 90 % | better / worse / tie | halves | fee-robust | time-fee | exit-lit | stop-class (32) | sens any / trail / stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| actual (control) | 0 | 0 | 0 | 0 | — | 0 / 0 / 332 | 0 / 0 | 0 | 0 | 0 | 0 | 0 |
| **50 / 50 (primary)** | +1.1424 | −1.0574 | +0.0448 | **+0.1298** | −0.099 … +0.379 | 77 / 176 / 79 | −0.0717 / +0.2015 | +0.0603 | +0.1152 | +0.1401 | +0.5010 | 155 / 83 / 17 |
| 30 / 70 | +1.6234 | −1.5277 | +0.0628 | +0.1585 | −0.154 … +0.511 | 77 / 182 / 73 | −0.1237 / +0.2821 | +0.0860 | +0.1285 | +0.1730 | +0.7129 | 157 / 88 / 17 |
| 70 / 30 | +0.6614 | −0.5870 | +0.0268 | +0.1011 | −0.046 … +0.265 | 73 / 151 / 108 | −0.0198 / +0.1209 | +0.0346 | +0.1018 | +0.1073 | +0.2891 | 145 / 69 / 18 |
| 100 % bid-ask | +2.3448 | −2.2331 | +0.0898 | +0.2015 | −0.241 … +0.697 | 70 / 193 / 69 | −0.2016 / +0.4031 | +0.1245 | +0.1486 | +0.2222 | +1.0306 | 150 / 92 / 17 |
| 100 % curve | −2.4649 | +2.4700 | −0.0903 | −0.0852 | −0.620 … +0.395 | 205 / 76 / 51 | +0.3178 / −0.4031 | −1.4028 | +0.0151 | −0.1059 | −1.0880 | 198 / 111 / 33 |
| 100 % spot (only the 21 bid_ask deploys change) | −0.0601 | +0.1184 | −0.0003 | +0.0581 | −0.023 … +0.147 | 12 / 6 / 314 | +0.0581 / 0 | −0.0039 | +0.0818 | +0.0581 | −0.0287 | 11 / 6 / 1 |

**Checks (primary 50 / 50):**
1. n ≥ 100: **PASS** (332)
2. Σ Δ > 0 with CI lower bound > 0: **FAIL** (Σ ◎+0.1298, CI −0.0992 … +0.3794; +0.08 % of capital)
3. better ≥ worse: **FAIL** (77 / 176, 79 ties)
4. both halves > 0: **FAIL** (−0.0717 / +0.2015)
5. fee-robust Σ Δ > 0: PASS (+0.0603)
6. |worst Δ| ≤ ½ Σ Δ: PASS (−0.0442 vs 0.0649)
7. stop-class Σ Δ > 0: PASS (+0.5010 over 32 closes)

**By exit family (primary, ΣΔ / ΣΔcap / ΣΔfee):** trailing TP 98: +0.019 / +0.562 / −0.582;
harvest 80: −0.308 / 0 / −0.308; unfilled-above 68: −0.048 / 0 / −0.048; low yield 28: −0.004;
manual 25: −0.029; stop loss 20: +0.336 / +0.351 / −0.016; rug 9: +0.107; young stop 3: +0.059.
Stop-class +◎0.50, everything else −◎0.37. Largest Δ: HeeHaw-SOL 10-10 stop loss +0.056, SPEC
young stop +0.047, Aiden stop +0.041, FTR rug +0.033, knightcat stop +0.033. Smallest: swordcat
harvest 10-05 −0.044, JEANPHIL harvest −0.030, HIGGS trailing −0.017.

**Exit sensitivity (the known limitation):** on 155 of 332 positions the hybrid pnl path reaches
the trailing arm, the trailing fire or the −15 % stop at a different tick than the recorded path:
arm 126, trailing fire 83 (earlier on 14, later or never on 69), stop 17 (never earlier — the
hybrid reaches −15 % later or not at all). So the fixed-close-time result is a weak guide: in live
use roughly half the positions would have closed at a different time.

**Reading.** The hybrid is a bottom-heavier ladder: it buys fewer tokens in the first bins under the
price. That saves capital on the positions whose price kept falling (stop-class +◎0.50) and costs
fee income on every position whose price oscillated near the top of the range (harvests, trailing
TPs: −◎1.06 in fees overall). The two nearly cancel; the sign flips between the halves; 176 positions
are worse and 77 better. The same trade-off runs monotonically along the mix (curve → spot → 70/30
→ 50/50 → 30/70 → bid-ask: Σ capital −2.46 … +2.34, Σ fees +2.47 … −2.23); no point on it is
distinguishable from zero. In effect the shape is a smaller position near the price bought with
fee income — the same thing a smaller deploy size does, without the bin-shape machinery.

**Decision:** not built. Added to the rejected list.
