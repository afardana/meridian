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
- **Reference:** `ref_usd` = max(entry TVL (`entry_tvl`, finite > 0), the highest usable reading
  since the position was first evaluated by this code); `ref_source` entry | peak.
- **Own value:** the position's own `total_value_true_usd` (always USD) is subtracted from the
  reading and the reference — both at the current value — when it is a finite number ≥ 0 and the
  row's `pnl_quality` is absent or "valid"; otherwise nothing is subtracted
  (`own_value_subtracted: false`). Adjusted figures are floored at 0.
- **Qualifies:** adjusted reading < $10,000 AND ≤ `tvlRelativeExitPct` (50) % of the adjusted
  reference.
- **Proof:** ≥ `tvlRelativeExitMinReadings` (3) qualifying readings spanning ≥
  `tvlRelativeExitMinMinutes` (30) min; a usable non-qualifying reading resets, an unusable one
  neither counts nor resets, readings < 60 s apart are one, a gap > 45 min between usable readings
  restarts. Then the live rule's on-chain reserve figure with the same subtraction and both bars:
  unavailable → tried next cycle, disagree → reset, confirmed → `would_fire` (first only).
- **Fields** (position → perf record): `tvl_relative_exit` = { ref_usd, ref_source, peak_usd,
  own_value_usd, own_value_subtracted, last_at, streak, would_fire { at, tvl_usd, ref_usd,
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
   instead.
2. Every position that ended ≤ −30 % and on which the old rule was ready was also caught by the
   new rule, each at a PnL no more than 10 pp worse than the old-ready PnL, OR was closed earlier
   by another rule (implemented as: closed by anything other than the fixed TVL exit — another
   exit rule or by hand — before the new rule fired; under a replacement that close would happen
   the same way).
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
closed within 60 min of old-ready, and holds the verdict at `insufficient` ("graded by hand from
price_ticks") while any check-1 case or check-2 unknown needs ticks; those are graded by hand
from `price_ticks` and logged below.

## Revert rule
None — no enforce path exists.

## Grading log

### 2026-11-27 — **registered** (registration)
(none yet — forward capture starts with the deploy)
