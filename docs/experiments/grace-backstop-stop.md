---
id: grace-backstop-stop
config_key: null
status: insufficient
mode: none (graded from the existing `grace_stop_paused` capture)
registered_at: 2026-11-24
enforce_built: false
---

# Backstop stop inside the grace (a deeper stop while the −15 % stop is paused)

## Claim
Since 2026-10-17 (`profitGraceStopLossMode=paused`, operator: "The grace is supposed to let
everything happen within the timeframe") the stop loss, young-token stop and first-entry
probation do not fire inside a profit grace. A backstop at −B % on capital inside the grace,
deeper than the −15 % stop, ends with more SOL than no stop at all in the grace — and no less
than simply re-activating the −15 % stop there (`profitGraceStopLossMode=active`, which already
exists).

## What was known at registration (2026-11-24)
Seen — the four records that carry `grace_stop_paused` so far (all operator positions):
- 索拉纳-SOL: held back at −15.8 %, closed by the crash rule at −32.2 %.
- mucron-SOL: held back at −20.7 %, closed at −29.1 %; the token was +44.6 % 30 min later.
- Mimi-SOL: held back at −15.7 %, closed at −27.8 %; the token was +11.8 % 60 min later.
- Nothing-SOL: held back at −15.9 %, stop loss at −15.8 % after the grace.
Against the −15 % stop firing at the held-back reading these four cost ≈ ◎0.27–0.30 in total.
Before the pause, in-grace stops also cut positions that recovered (darwin-SOL twice, stopped
10–12 min after adoption, token +155 % / +42 % afterwards). So the direction is known for n = 4
and contradicted by older cases; nothing is known about a level between "−15 %" and "none".
The `worst_pnl_pct` values of the four have not been looked at.

## Grade (records only — no replay needed, the capture exists)
- **Population:** perf records closed on or after 2026-10-17 with a non-null `grace_stop_paused`
  (a stop-class rule was held back by the grace at least once). Bot and operator pooled;
  reported per owner.
- **Three policies per record**, all in gross `pnl_pct` × `amount_sol` / 100:
  - paused (what happened): the record's `pnl_pct`.
  - active-15: fires at `grace_stop_paused.pnl_pct` (the first held-back reading) − 2 pp.
  - backstop-B: fires only if `grace_stop_paused.worst_pnl_pct` ≤ −B, at −B − 2 pp; otherwise
    the record's `pnl_pct`.
  The 2 pp allowance stands for the overshoot past the line plus the exit swap on a falling
  token (operator stop-loss closes booked a median −16.06 % against the −15 % line).
- **Primary:** B = 20. Reported beside it: B = 25 and 30.

## Pass rule
Registered 2026-11-24, with four records seen (above).
1. ≥ 12 records in the population AND ≥ 6 backstop fires — otherwise `insufficient`. No time arm
   forces a verdict; on 2027-01-31 the count is reported to the operator, who decides whether to
   keep waiting.
2. Σ (backstop − paused) > 0 SOL over the fires.
3. The same sum > 0 without the largest term.
4. Σ (backstop − active-15) ≥ 0 over the whole population — the backstop must not lose to
   re-activating the existing stop.
5. At most 1 in 3 of the fires finished (record `pnl_pct`) more than 5 pp above its fire level
   (recoveries cut).
6. Check 2 still holds with the allowance at 4 pp.

`met` → building a `graceBackstopStopPct` (shadow first) is proposed in the session; it reverses
part of the operator's 2026-10-17 instruction, so it is the operator's decision either way.
If check 4 is the only failure and Σ (active-15 − paused) > 0 also without its largest term, the
finding reported is "re-activate the stop inside the grace" — again a proposal, not a change.

Not covered: closes by the crash / rug / calm-regime rules inside the grace (they are not
paused); the profit side (see `grace-profit-lock.md`).

## Revert rule
None — no enforce path exists.

## Grading log

### 2026-11-24 — **insufficient** (registration)
4 of 12 records. Not graded beyond the figures listed under "What was known at registration".
The bot has made no deploy since 2026-11-13, so the count grows with operator positions only.

### 2026-11-24 08:55 WIB (1,461-record export) — **insufficient**
6 of 12 records; 3 of 6 fires at B = 20.
- Correction to "What was known at registration": the export held FIVE records, not four.
  INVERSE-SOL (held back at −15.26 %, worst −15.26 %, finished **+16.74 %**) was not in the
  review's list. It points the other way from the four that were seen: the −15 % stop in the
  grace would have cut a +16.7 % result.
- New today: JIMMY-SOL 31ir6RAo — held back at −15.34 %, worst −17.08 %, closed by the in-range
  rug latch at −16.27 % (that latch is paused inside a grace on operator positions from 07:43 WIB,
  `profitGraceRugMode`, so later records will run further before any rule acts).
- `worst_pnl_pct`, now read: 索拉纳 −34.11, mucron −29.10, Mimi −22.27, Nothing −16.73,
  INVERSE −15.26, JIMMY −17.08 → a −20 % backstop would fire on the first three only.
- Not graded: the threshold is not reached.

### 2026-11-26 08:55 WIB (1,482-record export) — **insufficient**
7 of 12 records by the mechanical count; 4 of 6 "fires" at B = 20, of which one is not a real one.
- New: Huss-SOL E96pMB2p — `grace_stop_paused` first −37.27 %, worst −37.27 %, finished **+6.00 %**
  (closed by hand). The −37.27 % is ONE valuation taken during the operator's top-up on 11-25
  (≈ 06:00 WIB) before Meteora indexed it, with the bin one lower; the position was at ≈ +12 %
  before and after. It is a valuation artefact, not a drawdown: a stop (−15 % or a −20 % backstop)
  needs two distinct valuations and would not have confirmed on it. When this experiment is
  graded by hand, Huss is counted in the population as a record with NO real held-back stop
  and NO backstop fire → honest count **6 records with a real held-back stop, 3 fires**
  (unchanged from 11-24). The scoreboard's automatic counter still shows 7 / 12 and 4 / 6.
- `worst_pnl_pct` of the real ones, unchanged: 索拉纳 −34.11, mucron −29.10, Mimi −22.27,
  Nothing −16.73, INVERSE −15.26, JIMMY −17.08.
- Not graded: the threshold is not reached.
