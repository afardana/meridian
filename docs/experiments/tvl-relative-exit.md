---
id: tvl-relative-exit
config_key: tvlRelativeExitMode
status: registered
mode: shadow (forward capture from the ship date)
registered_at: 2026-11-27
enforce_built: false
---

# Relative TVL exit (pool TVL under $10K AND at or under 50 % of the position's TVL reference) vs the fixed $10K exit

## Claim
Closing a position on a pool-TVL collapse RELATIVE to that position's own TVL reference — pool
TVL under `tvlFloorExitUsd` ($10,000) AND at or under 50 % of the higher of the entry TVL and the
highest TVL seen since — keeps the protection the fixed $10K TVL exit gives against real
collapses while no longer closing positions in small pools that only dip under $10K and come back.

## What was known at registration (2026-11-27) — exploratory
The study behind this rule is exploratory: its thresholds were chosen on the same cases they were
tested on, so it cannot grade the claim; the test below is forward-only.
- All 6 fires of the live TVL exit so far (MCAT 4.7K → 6.1K, OpenIndex 10.0K → 9.7K, OpenIndex
  6.3K → 5.5K, JIMMY 12.7K → 9.2K, JIMMY 11.7K → 9.3K, PVE 10.4K → 8.2K; entry → fire TVL) were
  operator positions entered at ≤ 1.3× the floor; none was a collapse (TVL ≤ 27 % below entry),
  and only 1 of the 6 pools later died.
- Small pools that dip under $10K mostly come back; real collapses cross $10K far too late
  (FACTORY-SOL 10-10: $42.9K at adoption, first under $10K with the position already at −51 %).
- On 52 small-pool positions (16 collapses) the proposed rule caught 9 collapses with 3 other
  fires, against 16 / 30 for today's rule, and 0 of 8 named false fires.

## Shadow capture (ships with this registration)
`tvlRelativeExitMode` off | **shadow** (no enforce exists; "enforce" reads as shadow and is
logged once). Module `tvl-relative-exit.js`; it closes nothing and changes no field of the live
rule.
- **Reading:** the live rule's own `p.tvl_floor_reading` (Meteora pool-discovery `tvl`, usable
  only when the fetch succeeded for this pool and the value is a finite number ≥ 0), once per
  management cycle.
- **Other liquidity:** at each usable reading, other liquidity = max(0, pool TVL − the position's
  own `total_value_true_usd` (always USD) at THAT reading); the own value is used when it is a
  finite number ≥ 0 and the row's `pnl_quality` is absent or "valid", otherwise nothing is
  subtracted (`own_value_subtracted: false`).
- **Reference (on other liquidity):** `ref_usd` = max(entry reference, the peak of other liquidity
  over the usable readings since this code first evaluated the position); entry reference =
  `entry_tvl` (finite > 0) minus the own value at the first reading that had it (nothing
  subtracted when the own value was unknown then), fixed from then on; `ref_source` entry | peak.
  (Amended 2026-11-27 before capture: the first version subtracted the CURRENT own value from a
  raw peak, so a peak of $12K with own $8K, later own $4K and TVL $6K, read 25 % while other
  liquidity had only halved — 50 % now.)
- **Qualifies:** other liquidity now < $10,000 AND ≤ `tvlRelativeExitPct` (50) % of the reference.
- **Proof:** ≥ `tvlRelativeExitMinReadings` (3) qualifying readings spanning ≥
  `tvlRelativeExitMinMinutes` (30) min; a usable non-qualifying reading resets, an unusable one
  neither counts nor resets, readings < 60 s apart are one, a gap > 45 min between usable readings
  restarts. Then the live rule's on-chain reserve figure minus the own value now, both bars:
  unavailable (incl. a read taking > 5 s) → tried next cycle, disagree → reset, confirmed →
  `would_fire` (first only).
- **Order:** in the management cycle the shadow runs AFTER the fixed rule's decision for the
  position is made and its exit (if any) recorded, detached (never awaited), so it cannot delay
  a close; a reading that changes only `last_at` / the own value is stored at most every 10 min.
- **Fields** (position → perf record): `tvl_relative_exit` = { ref_usd, ref_source, peak_usd (other liquidity),
  entry_ref_usd, entry_own_value_usd, own_value_usd, own_value_subtracted, last_at, streak, would_fire { at, tvl_usd, ref_usd,
  pct_of_ref, chain_tvl_usd, pnl_pct, held, hands_off, readings, span_min, … } };
  `tvl_floor_shadow_compare` = { old_first_ready_at, old_first_ready_pnl_pct, old_closed,
  new_would_fire_at, new_would_fire_pnl_pct } — "old ready" = the live rule's proof completed AND
  its on-chain check agreed, whether or not it then closed (hands-off / shadow mode); `old_closed`
  = the record's close was the live TVL exit's.
- **Logs** (no Telegram): `[TVL_RELATIVE_SHADOW] would-close …` once per position;
  `[TVL_RELATIVE_SHADOW] <pair>: reference $z (entry | peak …)` when a streak starts.

## Pass rule
Registered 2026-11-27, before any capture. Population: records carrying
`tvl_floor_shadow_compare`, bot and operator pooled (`bot_and_operator`).

Capture until 21 days have passed AND ≥ 10 positions exist where the two rules DISAGREE (old
ready and new not, or new would-fire and old not), or 90 days (2027-02-25), whichever first.

`met` requires all of:
1. Among positions where the old rule was ready and the new one never fired, the position's PnL
   60 min after the old-ready time is at or above the old-ready PnL in ≥ 60 % of cases AND the
   sum of the differences is ≥ 0. The 60-min PnL comes from `price_ticks`; when the position
   closed within 60 min of the old-ready time (by any path), its close PnL (`pnl_pct`) is used
   instead. **Minimum: ≥ 5 gradeable cases** (old ready, new never fired, a 60-min-later PnL
   available); with fewer the verdict is `insufficient` — and at the 90-day arm the experiment
   is closed as `insufficient`, never `met`.
2. Every position that ended ≤ −30 % and on which the old rule was ready was also caught by the
   new rule, each at a PnL no more than 10 pp worse than the old-ready PnL, OR was closed earlier
   by another rule — meaning closed by something other than the fixed TVL exit (another rule or
   by hand) **within 60 min of the old-ready time, or at a PnL no more than 10 pp under the
   old-ready PnL**. Otherwise the case FAILS (the new rule missed a collapse the old one would
   have cut). With no such position the check is reported as "no cases"; that does not by itself
   block `met`.
3. The new rule fired on at most 1 position that ended above its would-fire PnL by more than
   10 pp.

`met` → a proposal to the operator to replace the fixed rule (`build_enforce`-style; never
automatic). `not_met` → the fixed rule stays and the idea is listed as rejected.

**Confound:** a position the OLD rule closes stops existing, so the new rule cannot be observed on
it after that point. `old_closed` is recorded and such positions are treated as "old ready, new
unknown": excluded from check 1's numerator and denominator; in check 2 an old-closed position
the new rule had not fired on is "unknown". Implemented: the grader excludes / flags them; it does
NOT look for ticks of another position in the same pool. When grading by hand, such a case may be
included only if ticks from another position in the same pool cover the next 60 min — say so in
the grading log.

**Grader** (`scripts/experiments/definitions.js` id `tvl-relative-exit`, `lib.js`
`gradeTvlRelative`): counts the disagreements, answers check 1 from the record where the position
closed within 60 min of old-ready, holds the verdict at `insufficient` with fewer than 5
gradeable check-1 cases (`closed_insufficient` at the 90-day arm), and at `insufficient`
("graded by hand from price_ticks") while any check-1 case or check-2 unknown needs ticks; those
are graded by hand from `price_ticks` and logged below.

## Revert rule
None — no enforce path exists.

## Grading log

### 2026-11-27 — **registered** (registration)
(none yet — forward capture starts with the deploy)

### 2026-11-27 — amended before capture (independent review of 2c64f5c)
Before any record existed: reference tracked on other liquidity (own value at each reading);
check 1 minimum of 5 gradeable cases (90-day arm with fewer → closed as `insufficient`); check 2
"closed earlier" bounded to ≤ 60 min after old-ready or ≤ 10 pp under the old-ready PnL, else a
fail; check 2 with no cases reported as such; shadow moved after the fixed rule's decision,
detached, on-chain read capped at 5 s; write throttle. The pass rule is frozen from here.

### 2026-11-28 — note: the live rule changed (pass rule unchanged)
From 2026-11-28 the live TVL exit no longer closes on TVL alone: a distress gate
(`tvlFloorExitDistressMode`, default enforce; `tvl-floor-distress.js`, registered as
[tvl-exit-distress](tvl-exit-distress.md)) also requires a loss ≤ −10 % or heavy selling with the
price falling on its own N readings over M minutes. For this experiment: `old_first_ready_at`
still marks the TVL-only proof (TVL streak complete + on-chain agree — `noteTvlFloorReadyForShadow`
is called before hands-off and before the gate, unchanged), so "old ready" keeps its meaning;
`old_closed` now means the record was closed by the live TVL exit UNDER the distress gate. A
position whose old-ready proof the gate held back stays open, so from this date fewer old-ready
cases are confounded by an old close. Records before / after 2026-11-28 should be reported
separately. The pass rule above is not edited.
