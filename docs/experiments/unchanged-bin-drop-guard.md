---
id: unchanged-bin-drop-guard
config_key: null
status: insufficient (closed — too rare to grade)
mode: none
registered_at: 2026-11-24
enforce_built: false
---

# Guard on PnL drops at an unchanged bin (tighter than the 15 pp jump guard)

## Claim
A position's SOL-basis PnL cannot fall by several points between two valuations while the pool's
active bin has not fallen: the token amounts and the price are the same, so only fees (up) move
it. A drop of X pp or more at an unchanged or higher bin is therefore a valuation artefact (fees
claimed but not yet in the ledger or the indexer, an unindexed withdrawal or re-range), not a
market move. The live guard (`classifyPnlJump`, `pnlJumpSuspectPp` 15) only catches drops above
15 pp. Treating a drop of ≥ X pp at an unchanged bin as suspect until it has persisted would
stop exits that fire on such a reading, at the cost of delaying an exit by up to the hold time
when the drop is real.

## What was known at registration (2026-11-24, before any event study)
Seen:
- MCAT-SOL CY2JGang (11-22): 14.77 % → 5.45 % → 14.77 % over 36 s at an unchanged bin, followed
  by `claimed fees floored to indexer`; inside the grace, so nothing fired.
- Aiden-SOL (10-04): 4.87 % → 0.18 % on the first valuation after an aborted straddle stage A;
  trailing fired; fixed at the source (`recordClaim` in `noteFlow`).
- baton-SOL B8DuoxF1 (10-08): −0.32 % instead of +1.87 % for 3 min at an unchanged bin after an
  external rebalance claimed the fees; trailing was not armed.
Each of these was fixed or harmless at its source. Not seen: how often such drops occur across
the tick history, how many revert, and whether any recorded close fired on one.

## Event study (read-only, on `price_ticks` poller rows)
- **Window:** 2026-10-05 (pool-price valuation and the 30 s reconfirm are both live) … the
  export date. All positions, bot and operator; held positions count for checks 1–2 only.
- **Event:** two consecutive distinct valuations of one position with pnl falling by ≥ X pp and
  < 15 pp (the live guard already covers ≥ 15) while the active bin of the second is ≥ the
  first's. Rows with pnl ≤ −99.9 are dropped. Excluded: events within 2 min of a recorded
  capital change, straddle stage, or range change of that position (`position_events`,
  `last_capital_rebase`, `straddled_at`), which have their own handling.
- **Outcome of an event:** `reverted` — within 120 s a reading returns to within 1 pp of the
  pre-drop reading at a bin ≥ the pre-drop bin; `fell` — the active bin drops below the
  pre-drop bin within 120 s before any such return (the market moved after all); otherwise
  `persisted`.
- **Close on an event:** a perf record whose mechanical close (any family except manual,
  external, rebalance leg) was recorded within 90 s after the event's second reading, with no
  return before the close.
- **Primary variant:** X = 3, hold 60 s (a guarded reading counts again once it has stood 60 s
  on ≥ 2 distinct valuations, or at once when the bin falls). Reported beside it: X = 2 and 5.

## Pass rule (study stage — decides whether a shadow capture is proposed)
Registered 2026-11-24, before the study is written or run. Primary variant:
1. n ≥ 20 events — otherwise `insufficient`.
2. `reverted` ≥ 80 % of the events that are not `fell`.
3. At least one recorded mechanical close fired on a `reverted` event. Without one the verdict
   is `not_met`: the artefact exists but the confirmation rules already absorb it, so a guard
   adds nothing.
4. Cost of waiting: over `persisted` and `fell` events on non-held positions,
   Σ (pnl 60 s after the event's second reading − pnl at that reading) / 100 × capital ≥ −◎0.05.
5. At most one `persisted` or `fell` event was followed within 60 s by a stop-class close whose
   PnL fell a further 3 pp or more in that minute (the guard must not hold a real stop into a
   dump).

`met` → a shadow capture (`[PNL_DROP_SHADOW] would-suspect`, counted per position and stamped on
the perf record when an exit fired on it) is proposed in the session. No guard that changes an
exit decision is built without the operator's go-ahead. `not_met` → the rejected list, and each
artefact keeps being fixed at its source.

Not covered: drops while the bin falls (real moves; the rise-on-fall guard is the mirror case),
the up-jump guard, valuations of held positions as far as rules go (no rule reads them).

## Revert rule
None — no enforce path exists.

## Grading log

### 2026-11-24 (ticks 2026-10-05 → 2026-11-24, 399 positions, 81,321 distinct valuations; 1,459-record export) — **insufficient**, closed
Run: `node scripts/replay/drop_guard_study.js` (exports: `scripts/replay/drop_guard_export_ticks.sql`,
`drop_guard_export_context.sql`).

- events, primary X = 3: 3 raw → **1** after the exclusions (both excluded ones sit on the tick an
  external rebalance was detected). X = 2: 10 raw → 2. X = 5: 2 raw → 1.
  1. n ≥ 20: **FAIL** (1)
  2. reverted ≥ 80 %: pass (1 / 1)
  3. a mechanical close on a reverted event: **FAIL** (0 — and none within 300 s of a kept event)
  4. cost of waiting: pass, vacuous (no persisted / fell event at X = 3)
  5. delayed stop-class closes: pass, vacuous (0)
- the one event is the case that prompted the registration: MCAT-SOL CY2JGang 11-23 01:49 WIB,
  14.77 % → 5.45 % → 14.77 % in 35.5 s at bin −508; the return carries `claimed fees floored to
  indexer: sol=0.025606` = 9.35 pp of its ◎0.2739 (the drop was 9.32 pp): fees claimed outside the
  bot and missing from the ledger until the indexer showed them. Inside the grace; nothing fired.
- held positions: none of the events. Operator positions: all three raw X = 3 events.
- outside the registration, for context: without exclusions and without the 15 pp cap X = 3 finds
  6 events in 50 days; in 09-25 → 10-04 (market-feed valuation, before the pool-price fix) the
  same detector finds 159.
- noted in passing, not part of this rule: on the tick an external rebalance is detected the
  trailing peak was re-based to a reading that was itself the dropped one on three positions
  (BUBBLE-SOL GVSWztLt 10-16, ART-SOL EPszauZR 10-07, FTR-SOL CFXKmPuy 10-16); none led to a
  wrong exit.
- **decision:** closed. One event in 50 days cannot reach 20 within any useful time, and no close
  has fired on such a reading since the pool-price valuation. No guard is built; artefacts of this
  kind keep being fixed at their source (the claim ledger). A new look needs a new registration.
