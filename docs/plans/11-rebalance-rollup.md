# Plan 11 — Rebalancing decision-making (roll-up after full conversion)

Status: PLANNED (Phase 0 approved for build; Phases gated on shadow data)
Motivated by: operator's MANLET-SOL manual rebalance 2026-08-21 (spot → re-centred curve,
+4%/hr immediately after) + the recurring frozen-capital cases (CATE 07-27, CYBERLEEK 08-20,
BULLSHIT 08-21: PnL frozen for hours while parked above range).

## 1. What "rebalance" means for this bot

Meteora DLMM position accounts carry a FIXED bin range (≤70 bins per account) — the UI's
"rebalance" is only offered when the position fits one account (the operator's observation;
their MANLET at <70 bins qualified). On-chain there is no in-place range mutation: every
rebalance is economically **close → redeploy**. That means the bot does not need a new
primitive — it needs a **decision layer** over primitives it already has, plus sequencing
that avoids a Jupiter swap when composition allows.

Three rebalance situations, triaged:

| Situation | Verdict |
|---|---|
| **Price exited ABOVE range** (position fully converted to SOL, PnL frozen) | **The target.** Exit is provably free (all-SOL, no swap, no slippage); capital is earning zero; re-centring below the new price is a fresh SOL ladder — the bot's native strategy. |
| Price exited BELOW range (position all base token) | **Out of scope.** Already owned by the OOR-flip tactic (#07) and the close path. "Rebalancing down" = realizing the loss to chase a falling token. Never. |
| In-range re-centring / shape change (the operator's MANLET move) | **Deferred.** Requires conviction judgment (consolidation read) + tolerates partial conversion costs. Human craft for now; revisit only if Phase 1 data is strong. |

## 2. Empirical grounding (measured 2026-08-21, 153 closes with path features)

The central question: when price leaves the top of our range, does it come back?

- **137/153 (90%)** of positions went ≥5 bins above range at some point — excursion is
  the NORM, not an event.
- **97/137 (71%) wicked back** and ended through in-range rules (trailing/low-yield/SL/ratchet).
- Even at ≥15 bins above, **68/106 (64%) still returned**.
- Closed-while-still-above group avg +1.29% vs wick-back group +0.64% (the ones that kept
  going were the better outcomes — but only 22/137 ended that way).

**Conclusion: naive/eager roll-up would whipsaw ~2 times out of 3** — paying round-trip
gas to re-centre above a price that is about to fall back through the old range (and, if
composition weren't all-SOL yet, realizing conversion losses at the local top — LVR chasing).
Any roll-up trigger must therefore prove **the excursion is a departure, not an oscillation**.
We already own the right proof: the round-trip harvest's frozen-PnL test (pnl unchanged
across N ticks while ≥K bins above = conversion complete, all-SOL, exit literally free).
Live cases: CATE frozen 7.98% across 12 ticks/16-31 bins; CYBERLEEK harvest-equal at +2.47%
(trailing later realized the same number 5.4h later — harvest would have freed 2.77 SOL
~5h sooner); BULLSHIT today frozen +2.33% across 6+ ticks, 29 bins above, 5h+.

Cost side: a close+redeploy round trip ≈ 4-6 txs ≈ 0.0002–0.001 SOL incl. priority fees
(post-28598b8 real pricing) + rent recycled. At 3-SOL positions and pool fee velocities of
1-10%/24h, one hour of restored fee flow repays gas by orders of magnitude. Gas is not the
constraint; whipsaw and pool quality are.

## 3. Decision framework (ALL gates must pass to roll up)

1. **Conversion proven**: round-trip harvest condition — pnl ≥ roundTripMinPnlPct (only
   ever roll a WIN), frozen within epsilon across roundTripFrozenTicks, ≥ roundTripMinBinsAbove
   bins above. (Reuses `evaluateRoundTripHarvest()` verbatim — that gate exists and is
   currently logging shadow hits.)
2. **Dwell**: ≥ `rollupMinDwellMin` (default 45m) continuously above range — filters the
   64-71% oscillators the data shows; RULE_4's wick-reset fragility becomes a feature here
   (a reset proves it wasn't a departure).
3. **Flow alive**: the pool's live fee velocity (the new `flow:` reading) is steady or
   ACCELERATING — never roll into a FADING pool (that's exactly a fee-death re-entry;
   close and let screening find a better pool instead).
4. **Safety unchanged**: pool still passes the deploy-time safety checks (TVL floor or
   clean-history exemption, blacklists, PVP) — the executor re-validates on the redeploy
   leg anyway; the decision layer just shouldn't propose doomed rolls.
5. **Caps**: `rollupMaxPerPosition` (default 1) lifetime rolls per original position;
   re-entry sizing via computeDeployAmount as usual; ≤69-bin target width (single account).

## 4. Implementation path — composition first, new code second

**Phase 1 needs almost no new machinery.** Two shipped features already compose into a
manual-free roll-up:
- `roundTripHarvestEnabled` (built, shadow) exits the frozen position free;
- the renewed-flow re-entry rules (shipped 2026-08-21, a665676) let the screener re-enter
  the same pool on its next cycle when flow justifies it — with fresh judgment, fresh
  safety checks, and standard sizing.

So the phases are:

- **Phase 0 (build now): `[ROLLUP_SHADOW]` instrumentation.** At every would-harvest hit,
  also log the roll-up counterfactual inputs (dwell, flow label, bins above) and afterwards
  track what the pool's fee velocity did next (the post-close probe machinery already
  snapshots the pool at +30/60/180m — extend the record with fee/TVL, not just mcap).
  Output: measured "would a same-pool redeploy have earned?" per event.
- **Phase 1 (flip one flag): enable `roundTripHarvestEnabled`.** Harvest frees the capital;
  screening re-entry (already live) closes the loop when the pool deserves it. Accept the
  one-cycle latency (≤15 min) as the price of full judgment + safety re-validation.
- **Phase 2 (only if data demands): dedicated `rollup` fast path** — a MANAGER-side
  mechanical close+redeploy that skips the screening queue, carrying gates §3 in code,
  shadow-first like everything else. Build ONLY if Phase-1 data shows the screening path
  systematically misses profitable rolls (e.g., verdict latency loses the flow window in
  >30% of events).

## 5. Risks

- **Whipsaw** (the 64-71%): owned by gates 1-2. The frozen-PnL test is load-bearing.
- **Rolling into a dying pool**: owned by gate 3 (FADING = never).
- **RULE_3/RULE_4 interplay**: harvest fires before OOR timers by design; no conflict.
- **Baseline hygiene**: each roll is a new position — peak/ratchet/trailing state resets
  (correct: the new ladder is a new bet). Perf records stay per-position; pool-memory links
  the sequence via pool address.
- **Crowding**: post-Bonk-migration thin pools — a roll-up keeps capital in an already-proven
  pool rather than competing for the ~8-pool universe; this is arguably the strongest
  argument FOR the feature in the current regime.

## 6. Success metrics (judge Phase 1 after ~2 weeks / n≥10 events)

- Harvested-then-re-entered pools: subsequent-position PnL vs the counterfactual of RULE_4
  patience (holding frozen to the 12h timer).
- Zero rolls into pools that fee-death within 2h of re-entry (gate 3's job).
- Capital idle-hours recovered per event (CYBERLEEK baseline: ~5.4h × 2.77 SOL).
