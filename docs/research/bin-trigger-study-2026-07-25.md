# Bin-movement exit-trigger study

**Question.** `tools/socket-monitor.js` sees every active-bin change in real time but only calls
`triggerImmediateSync()` on an out-of-range crossing. Would *also* forcing an exit evaluation when
the active bin has moved DOWN by ≥ N bins have saved the Syrax / RAKO / WORM losses — and what
would it have cost on the 20 positions that ended fine?

**Answer: no, and the evidence is unusually clear about *why*. Recommendation: do not ship.**

- Script: `/Users/Angga/Repos/meridian/scripts/replay/bin_trigger_study.js` (read-only, imports no
  meridian module, no `.env`, no DB).
- Run: `node scripts/replay/bin_trigger_study.js --ticks ticks.csv --meta position_meta.csv --closes closes.json [--verbose] [--confirm hybrid|poller] [--ratchet off|on|seeded] [--young known|all] [--json out.json]`
- Data: 476,760 ticks / 24 positions / 25 closes, 2026-07-21 → 07-25. 23 positions usable.

---

## Headline

| Measure | Value |
|---|---|
| Net effect, best grid cell (N=4, interval 45 s, lag 5 s) | **+0.05 SOL** across 23 positions (~22.5 SOL deployed) |
| Net effect, full grid range (20 cells) | **−0.03 … +0.05 SOL** — 13/20 cells positive |
| Saving on Syrax-SOL | **0.00 SOL (0.00 pp)** |
| Saving on RAKO-SOL | **0.00 SOL (0.00 pp)** |
| Saving on WORM-SOL | **−0.001 SOL (−0.12 pp) — a small loss** |
| Total saving on the 3 disasters | **≈ 0.00 SOL in every one of the 20 grid cells** |
| Gain on the other 20 | +0.00 … +0.05 SOL, from 3 trailing-TP exits landing nearer their peak |
| Model fit (leave-one-out, pooled) | MAE **0.10 pp**; on ≥8-bin gaps **0.18 pp**, max 3.40 pp |

The whole measured effect is smaller than one position's gas bill and comfortably inside the
model's own error bars. There is no cell where this pays for itself.

---

## Step 1 — the blind spot is real, and much smaller than it looks

5,740 inter-poller-sample gaps. Median gap 45.0 s, p99 135 s.

Downward active-bin movement *inside a single gap* (socket ground truth, so this includes
excursions the poller never saw):

| | median | p90 | p99 | max |
|---|---|---|---|---|
| bins down within one gap | 0 | 2 | 10 | **42** |

Only **105 / 5,740 gaps (1.8 %)** hide ≥8 bins of downward movement. Per-position maxima:
Syrax 20 bins (11 fully hidden), RAKO 41, WORM 25 (17 hidden), KET 42 (18 hidden).

So the blind spot exists — the worst single gap hid a 42-bin drop — but it is a thin tail, not a
systematic condition. Full per-position table in the script's STEP 1 output.

## Step 1b — the finding that settles the question

The socket monitor **already** force-syncs on the OOR crossing, and that path
(`runManagementCycle`, index.js:711-777) has *no* 2-tick confirmation — it closes on the spot.
So a denser **in-range** clock can only help for a threshold the position actually crosses
**while still in range**. Minimum observed in-range PnL, per threshold:

| threshold | reachable in range on |
|---|---|
| stop-loss −15 % | **0 / 23 positions** |
| young stop −10 % | 3 / 23 (RAKO, WORM, febu) |
| profit ratchet −2 % | 11 / 23 |

This is geometry, not luck. A single-sided SOL ladder 119 bins wide at bin_step 80–125 bottoms out
around −10 to −20 % *at the very edge of its range*: Syrax's worst in-range reading was **−7.47 %**,
RAKO's **−11.02 %**. A −15 % stop **cannot fire while in range on these positions**. By the time PnL
reaches −15 %, the price is at or past the lower bin — which is exactly when the shipped OOR trigger
already fires.

Traced on the tape:

- **Syrax** — poller 11:00:02 bin −743 / −5.84 %. Socket: −743 → −808 in **16 seconds**
  (11:00:32 → 11:00:48, ≈244 bins/min). Lower bin −767, crossed 11:00:44.97 → force-sync →
  closed 11:01:10 (23 s end-to-end). A bin trigger at N=4 does fire earlier, at 11:00:37 / bin −747
  — where modeled PnL is **−7.5 %**, nowhere near the stop. The next eval is throttled past the OOR
  crossing. **The bin trigger changes nothing.**
- **RAKO** — the −15 % crossing sits at ≈bin −589, reached 02:50:48. Lower bin −596, crossed
  02:51:00.5 → closed 02:51:13 (12.5 s). Best case a forced eval fires at 02:50:59 — **1.2 seconds**
  before the OOR trigger it was supposed to beat.
- **WORM** — never went OOR at all (lower −824, floor −813). Its **young stop −10 % *was* reachable
  in range**, so this is the one disaster the trigger touches — and it makes it worse (below).

## Step 2 — bin→PnL model, validated before use

Model, per position: (a) linear interpolation of PnL in bin between the poller observations
bracketing the evaluation in time (~45 s apart, so fee drift is negligible); (b) where the bin falls
outside that bracket, anchor on the nearest observation and add `k ×` the closed-form
concentrated-liquidity difference, `k` fitted per position on consecutive observation pairs
(same closed form as `pnl-curve.js`, re-parameterised on bins). Leave-one-out over every observed
poller `(bin, pnl)` pair, using the identical code path:

| model | n | MAE | max |
|---|---|---|---|
| hybrid (what the replay uses) | 5,717 | **0.10 pp** | 5.76 pp |
| interpolation only | 2,808 | 0.11 pp | 5.76 pp |
| extrapolation only (fallback) | 400 | 0.19 pp | 3.65 pp |
| uncalibrated closed form, k=1 | 5,717 | 0.16 pp | 9.39 pp |

Stratified by how far the bin actually moved across the hidden gap — the honest cut, since half of
all gaps have no bin movement at all and need no model:

| bin moved | n | MAE | max |
|---|---|---|---|
| 0 | 2,597 | 0.07 pp | 3.65 pp |
| 1–3 | 2,070 | 0.11 pp | 5.76 pp |
| 4–7 | 700 | 0.11 pp | 2.15 pp |
| **≥8** | **350** | **0.18 pp** | **3.40 pp** |

**The uncalibrated closed form is not usable on its own** at these sizes: fitted `k` ranges 0.10–1.23
across positions (Syrax 0.81, RAKO 0.59, WORM 0.58), i.e. real bid-ask/spot liquidity shapes are far
less bin-sensitive than uniform CL. Every result above is the empirical-interpolation model; the
closed form only supplies the slope for extrapolation, and each use is counted (25–85 % of forced
evals depending on N).

Fee accrual is unmodelled. Fees only ever add to PnL, so a modeled counterfactual PnL is biased
**low** — the bias favours the null hypothesis and cannot manufacture a saving.

Worst single extrapolation error observed: Syrax's baseline exit modeled at −30.83 % vs a recorded
decision-time −25.40 % (**5.4 pp**), deep in the collapse zone where only one observation exists.
This affects the *level* of Syrax's exit, not the *delta* (baseline and counterfactual fire on the
same evaluation, so it cancels).

## Step 3 — replay fidelity

The replay reproduces four evaluation streams: the ~45 s poller (2-tick `registerExitSignal`
confirmation, 15 s `*_violated_since` timers), the 10-minute management cron (`confirmPeak(…, 1)`,
no 2-tick confirmation), the existing socket OOR force-sync (either direction), and the proposed bin
trigger. Live thresholds were reverse-engineered from the recorded `close_reason` strings rather than
`config.js` defaults, which differ: stop −15, trailing 3 / 1, young stop −10 @ <12 h,
`outOfRangeBinsToClose` 50.

Baseline (no bin trigger) reproduces **12 / 17** bin-and-PnL-driven close families, including all
three disasters with the correct rule. The 6 low-yield closes are fee-driven and deliberately out of
scope. All 5 misses share one cause: the tick series **ends at the close**, so the evaluation that
actually fired — the read immediately after the last recorded tick — is absent, and a 2-tick
confirmation cannot complete inside the window. Each miss's recorded decision PnL equals or just
passes the last recorded poller PnL, confirming that diagnosis. Consequence: the baseline is
slightly late or silent on trailing-TP, which biases this study **toward** finding the trigger
useful. Non-firing baselines fall back to the recorded decision PnL in the grid, removing most of it.

Two confirmation semantics were run, because the task's specification and the code disagree:
`--confirm poller` puts forced evals in the 2-tick poller stream (as specified); `--confirm hybrid`
(default) has them fire immediately, which is what would actually happen if the trigger reused
`triggerImmediateSync()` — the force-sync path has no 2-tick gate, which is precisely why
Syrax/RAKO's recorded reason is the lowercase deterministic `"stop loss: pnl …"` string from
`getDeterministicCloseRule`. Both give the same conclusion (`poller`: −0.02 … +0.04 SOL, 10/20 cells
positive).

## Step 4 — the grid, both sides

Δ = counterfactual exit PnL − **same-rules baseline** exit PnL, × `amount_sol`/100. Measuring against
the baseline replay rather than the recorded outcome isolates the trigger from rule-set drift and
from the decision→realized execution gap.

| N | interval | lag | changed | helped | hurt | Σ SOL Δ | disasters | others |
|---|---|---|---|---|---|---|---|---|
| 4 | 20 s | 5 s | 4 | 3 | 1 | +0.04 | −0.01 | +0.05 |
| 4 | 20 s | 15 s | 3 | 2 | 1 | +0.01 | −0.02 | +0.03 |
| 4 | 45 s | 5 s | 4 | 3 | 1 | **+0.05** | −0.00 | +0.05 |
| 4 | 45 s | 15 s | 3 | 2 | 1 | +0.02 | −0.00 | +0.03 |
| 6 | 20 s | 5 s | 3 | 2 | 1 | +0.01 | −0.02 | +0.03 |
| 6 | 45 s | 15 s | 3 | 2 | 1 | +0.02 | −0.00 | +0.03 |
| 8 | 20 s | 15 s | 3 | 2 | 1 | +0.00 | −0.02 | +0.02 |
| 8 | 45 s | 15 s | 3 | 2 | 1 | −0.00 | −0.03 | +0.02 |
| 10 | 45 s | 15 s | 3 | 2 | 1 | −0.00 | −0.03 | +0.02 |
| 12 | 20 s | 5 s | 1 | 0 | 1 | −0.02 | −0.02 | 0.00 |
| 12 | 45 s | 15 s | 1 | 0 | 1 | −0.03 | −0.03 | 0.00 |

(abridged; all 20 cells in the script output.) At most **4 of 23 positions change outcome in any
cell.** N=12 changes exactly one — and it is the harm case.

### Harm cases, named

- **WORM-SOL** — the only position harmed, in every cell where it changes. Baseline young stop
  −12.40 % → counterfactual −12.52 %, **35 s earlier**, exit bin −810 → −811. WORM's floor was
  −813 at 13:09:26 and it had already recovered to −808 by the real close. The trigger fires nearer
  the local minimum by construction: a downward-velocity trigger is adversely selected toward the
  bottom of the move. Corroborated independently — WORM's post-close probe reads **+15.5 % at
  +30 min**: the pool rose after our exit. We sold a bottom; the trigger would have sold it 35 s
  deeper.

No other position is harmed in any cell. Under `--ratchet seeded` (see below) the harm broadens to
3 positions per cell and the range widens to **−0.09 … +0.05 SOL**.

### Help cases, named

All three are trailing-TP exits landing closer to their peak — the trigger detects the ≥1 % drop
from peak sooner, so it sells higher on a falling path:

| position | Δ | base → counterfactual | earlier |
|---|---|---|---|
| BOP-SOL (FS5uNJ6g) | +1.23 pp (+0.01 SOL) | +1.63 % → +2.86 % | 92 s |
| 旺旺-SOL (2NStSDhC) | +1.06 pp (+0.01 SOL) | +0.64 % → +1.70 % | 61 s |
| Waddles-SOL | +2.29 pp (+0.02 SOL) | −1.06 % → +1.23 % | 35 s |

**Truncation test** (the bank's confirmed failure mode, tested directly rather than argued): for each
counterfactual exit, the max *recorded* PnL strictly after the exit time. All three help cases come
back **"clean — never recovered"** (Waddles' regret is −2.29 pp, i.e. it only went down). So in this
sample the earlier trailing-TP exits are genuine, not truncation. That is the one mechanism by which
the trigger does real work — and it is worth 0.01–0.02 SOL per instance on ~1 SOL positions.

The caveat the sample cannot settle: with a denser clock, trailing TP will also fire on transient
1 % dips the sparse poller sleeps through. Every position here closed at its trailing TP anyway, so
the "would have kept running" counterfactual is unobservable. n=3.

### vs the recorded outcomes

Σ counterfactual − recorded **decision-time** PnL: **−0.02 SOL**.
Σ counterfactual − recorded **realized** PnL: +0.09 SOL — but this silently credits the trigger with
dodging execution slippage it was never modelled to avoid (the recorded decision→realized gap is
−6.78 pp on Syrax and −6.60 pp on RAKO). The −0.02 figure is the honest one.

### Post-close probe cross-check

- **Syrax** `good_exit`, −54.3 % / −42.8 % / −35.0 % at +30/60/180 min → kept collapsing, so an
  earlier exit *is* corroborated as directionally better. There simply is no earlier exit available:
  the −15 % stop is unreachable in range.
- **RAKO** `good_exit`, −60.7 % / −36.1 % / **−1.3 %** → collapsed then fully recovered within 3 h.
  Earlier exit better than ours; *holding* would have been better than either.
- **WORM** +15.5 % at +30 min → we sold a local bottom, and the trigger sells it deeper.

## An order-of-magnitude aside the study kept running into

`pnl_pct` is a pre-swap market-value measure. The separately recorded `exit_swap` slippage on the
same closes:

| position | market_usd | received | slippage | % |
|---|---|---|---|---|
| Syrax-SOL | 99.34 | 52.86 | **46.48** | **46.8 %** |
| RAKO-SOL | 90.34 | 47.69 | **42.65** | **47.2 %** |
| WORM-SOL | 49.44 | 40.29 | 9.15 | 18.5 % |

Σ over the usable set: **$99.03**. (Treat `market_usd` cautiously — on Syrax it exceeds the $84.74
initial deposit, so the mid price it references is likely stale in a collapsing pool. The direction
and rough scale are not in doubt.) On the two big disasters this cost is one to two orders of
magnitude larger than anything the evaluation clock moves, and the already-shipped
`exitSwapGuardEnabled` shadow feature is aimed straight at it.

Separately, on the profit ratchet. **⚠️ REVIEWER CORRECTION (orchestrator, verified against the live
VM logs — the study's original claim here was wrong and is retracted).** The study inferred from the
tick tape that "the profit ratchet was disabled during this window — febu, looong, PUNY, BOP and RAKO
all sat below −2 % with `ratchet_armed=true` and did not fire." That is not what happened:

- The ratchet was **ON and firing**: `POB-SOL` closed 2026-07-22T12:46Z with reason
  `Profit ratchet: peaked +2.01% >= 2%, now -3.92% <= -2%`.
- Re-running the "dipped ≤ −2 % *after* the confirmed peak crossed +2 %" test over the same poller
  tape finds only **two** such positions, not five — `BOP-SOL FS5uNJ6g` and `RAKO-SOL`. The other
  three never dipped below −2 % post-arming; the original list came from applying the *final*
  `ratchet_armed` flag to pre-arming dips (look-ahead) and using a running max instead of the
  confirmed 2-tick peak.
- **RAKO's ratchet DID fire**, at exactly −11.02 %, and was suppressed by the TWAP wick guard:
  `[TWAP_GUARD_SHADOW] would-defer PROFIT_RATCHET … now -11.02% <= -2% … (twapGuardEnabled=true)`.
  So the ~0.14 SOL the study attributes to "a live ratchet" is real, but the cause was the TWAP
  guard deferring a correct exit — not a disabled ratchet. That guard was reverted to its documented
  default (off) on 2026-07-25 after costing a measured net ~7 pp over its first three live firings.
- **BOP's ratchet correctly did not fire.** Its dip was a single tick (−0.58 → **−2.36** → −1.39 →
  recovered), so the 2-tick confirmation cleared the signal — and BOP went on to close at **+2.37 %**.
  The non-fire *gained* ~4.7 pp. This is the confirmation logic working as designed, not a bug.

The study's structural observation stands and is the useful part: the ratchet's −2 % stop is
reachable in range on 11/23 positions, unlike the −15 % stop (0/23), so it — not the plain stop — is
the threshold an evaluation clock actually interacts with. The `--ratchet seeded` bound over-arms
deliberately (it converts +4.64 % and +6.07 % winners into ~−2 % exits) and is not a fair ratchet
evaluation.

---

## Honesty section

1. **n is very small.** 23 usable positions, 3 disasters, one 72-hour tick-ring window
   (2026-07-21 → 07-25). At most 4 positions change outcome in any grid cell, and the harm side is a
   single position. No confidence interval on ±0.05 SOL would exclude zero.
2. **PnL in the gaps is modeled, not observed.** Validated (LOO MAE 0.10 pp overall, 0.18 pp on
   ≥8-bin gaps) but the regime that matters most — deep excursions with one bracketing observation —
   is exactly where extrapolation carries a 5.4 pp error (Syrax).
3. **Fee accrual unmodelled** → counterfactual PnL biased low → favours the null.
4. **Exit-swap slippage unmodelled.** `pnl_pct` is pre-swap throughout. An earlier exit would
   plausibly face lower slippage in a less-collapsed pool, but that is not credited with any number
   here, and the recorded slippage (up to 47 %) dwarfs the effect under study.
5. **Confirmation and lag are approximated.** Modelled from the code plus two observed
   trigger→close latencies (Syrax 23 s, RAKO 12.5 s), so the specified 5 s / 15 s lags are on the
   optimistic side of reality; 15 s is the realistic one. Both semantics (`poller`, `hybrid`) were
   run and agree.
6. **5 / 17 closes not reproduced by the baseline**, all because the deciding read falls after the
   last recorded tick. This biases the study *toward* the trigger; the decision-PnL fallback removes
   most but not all of it.
7. **Rule-set uncertainty.** Thresholds were reverse-engineered from close-reason strings. Results
   were run with ratchet off / on / seeded and the conclusion is unchanged in all three. (The study's
   inference that the ratchet was *off* in this window is **retracted** — see the reviewer correction
   above; it was on and firing. Because the conclusion holds across all three ratchet modes, this
   does not affect the headline result.)
8. **Token age is missing** from `position_meta` for every row; only WORM's age (5 h) is recoverable,
   from its close-reason text. Unknown age → not young (matching the code's fail-open). The
   `--young all` sensitivity, which treats every position as young, does not change the result.
9. **Positions excluded (6):** TRUMP2028 `ExYu5AEi` (still open); JACOBIAN, Agamemnon, GMEBULL ×2,
   POB (no ticks — pre-capture, deployed 07-21/22). FRED-SOL is included but has only 42 socket rows
   and 5 poller rows over 5 minutes, with a clamped `k=3.00` and LOO MAE 1.92 pp on n=3 — treat it as
   noise. SOLdiers-SOL spent its entire life above its upper bin, so it has no in-range PnL reading.
10. **Not tested:** the crash/rug fast-paths (off in this window), the OOR-below time rule, and
    LOW_YIELD (fee-driven, no fee series in the dataset). A bin-velocity trigger overlaps
    conceptually with `detectPriceCrash`/`detectInRangeRug`, which are already implemented and
    shadowed — this study does not evaluate those.

## Recommendation

**Insufficient evidence to ship — and, unusually, a structural reason to expect it not to work.**
The −15 % stop is unreachable while in range on 0/23 positions, so on the two positions that
motivated the change the existing OOR force-sync is already the first evaluation that can fire the
stop; Syrax lost its money to a 65-bin/16-second plunge plus ~47 % exit slippage, neither of which is
an evaluation-frequency problem. The one disaster the trigger does reach (WORM) it makes slightly
worse, and the post-close probe independently confirms that exit was already too early.

If the orchestrator wants to pursue this anyway, the least-bad cell is **N=4, interval 45 s, lag 15 s**
(+0.02 SOL, harm confined to WORM at −0.12 pp) — but the effect is indistinguishable from zero and
N=4 fires 363 extra evaluations for it. **N≥12 is strictly negative** in all four of its cells.

Better-supported places to spend the same effort, both already implemented as shadow features:
`exitSwapGuardEnabled` (the ~47 % slippage on the disasters) and a decision on the profit ratchet
(whose −2 % stop is reachable in range on 11/23 positions, unlike the −15 % stop).
