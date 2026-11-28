---
id: tvl-exit-distress
config_key: tvlFloorExitDistressMode
status: registered (operator instruction, live 2026-11-28; forward records only)
mode: live (the distress gate is in effect; every hold-back is recorded)
registered_at: 2026-11-28
enforce_built: true
---

# TVL exit closes only when the pool also shows distress

## What is live
Operator instruction of 2026-11-28 ("Please make the thin TVL exit depend on other factors too,
so the latest one, the WLFI, would not have happened … They were not real collapses"): the TVL
exit (pool TVL under $10,000 on 3 readings over ≥ 5 min, confirmed by the on-chain reserves)
closes a position only when the pool ALSO shows distress on 3 readings over ≥ 5 min of its own
(`tvlFloorExitDistressMode` enforce; `tvl-floor-distress.js`). A reading is distress when
- the position's PnL on capital is ≤ `tvlFloorExitLossPct` (−10 %) — the thin-pool hold limit's
  figure: after a partial withdrawal the cost-basis figure when it is higher — with no usable PnL on
  that reading, the price since entry (bins) ≤ `tvlFloorExitPriceDropPct` (−30 %) instead; or
- the pool row's 1h volume ÷ pool TVL ≥ `tvlFloorExitDumpTurnover` (2) AND the price since entry
  ≤ `tvlFloorExitDumpPricePct` (−5 %).
On a pool positively known not to be SOL-quoted the price is unknown (only the PnL leg can fire).
Ranges: loss −95 … −1, price drop −99 … −5, turnover 0.25 … 100, dump price −99 … −1.
A calm reading (both legs evaluated, both false) resets the distress streak; a reading with an
unknown leg and no true leg neither counts nor resets. A TVL proof without the gate is held back:
no exit, no HOLD-override stamp, one log line per streak, one Telegram line per position.

This file does not test whether to switch the gate on — the operator decided that. It registers,
before any forward record exists, how its cost or gain will be reported.

## Seen data (not counted) — exploratory
Same-day study (session scratchpad `tvlfactors/`, `tvldistress/`): all 13 ready moments of the
live rule (2026-11-22 → 11-28) and 7 historical collapses. With the rule above, required on 3
readings: the 10 closes the operator called false (MCAT 5QdSx6Kb, OpenIndex BnWXrhnY / 3vEXhx99,
JIMMY 9wTNkyoB / CN7nrAvn, WLFI DUGfTjPR / Czjm1Xz4 / HehYo3tG, Snowball UzWyKKJ2 / 3htham3c;
1h volume 0.2–0.7× pool TVL, or the price near entry) are all held back; PVE 4sXgrxZt (pool at
$349 two hours later) still closes at its live ready moment (dump leg: 5.6×, price −36 %);
WINSTON 4C4jzy4R (pool died) closes 6 min after its first ready moment (one calm reading at
15:48 UTC restarted the distress count; its second ready moment at 17:18 is calm, −2.9 %, and
would have fired at 17:27); all 7 historical collapses (DUST, ART ×3, FACTORY, SAPIJIJU, wifout)
close at their first TVL proof. The thresholds were chosen on these same cases; n is small. This
proves the rule reproduces its own study (`test/fixtures/tvl-floor-distress-cases.json`), not
that it is right.

## Capture
`tvl_floor_distress` on the position → perf record (`buildPerfRecord`): `held_back_count` (TVL
streaks held back), `first_held_back_at`, `pnl_pct_at_first`, `price_pct_at_first`,
`turnover_at_first`, `raw_pnl_pct_at_first` (the plain percent, only when the cost basis lifted
the leg's figure), `pool_tvl_at_first`, `worst_pnl_pct` (lowest usable PnL on any later
below-minimum reading), `last_held_back_at`, `alerted_at`, `ref_bin` / `ref_bin_source` (only for
a position without an entry bin), and on a TVL-exit close `fired_at`, `fired_legs`,
`fired_pnl_pct`, `fired_price_pct`, `fired_turnover`, `fired_mode`, `would_hold_back` (distress
mode shadow: closed on TVL alone while the gate was not satisfied). Recorded only while
`tvlFloorExitMode=enforce`.

## Population
Perf records (bot and operator) closed on or after 2026-11-28T15:00Z that carry
`tvl_floor_distress.first_held_back_at`. One case per record.

## Measure
Per record: Δ = (`pnl_pct` − (`raw_pnl_pct_at_first` ?? `pnl_pct_at_first`)) / 100 × `amount_sol`
(both plain percents) (gross vs gross; a record
whose `pnl_pct_at_first` is null is reported with its price instead), and whether the record
ended ≤ −30 %. A top-up or withdrawal after the first hold-back is noted and the case reported
separately.

## Report rule (fixed)
At 10 held-back records, or on 2027-02-28 with fewer: report n, Σ Δ, Σ Δ without the largest |Δ|,
cases better / worse, the number that ended ≤ −30 % (each named, with its `worst_pnl_pct` and how
it was closed), and the worst single Δ.
- Any record ending ≤ −30 % that the gate held back and no other rule closed within 10 pp of
  `pnl_pct_at_first` → reported to the operator as "the gate let a collapse through", with the
  one-key switch-off (`tvlFloorExitDistressMode=off`).
- Otherwise → reported as it is. Nothing is changed automatically in either case (operator
  decision).

## Not covered
A pool that dies quietly (low turnover) while the position stays above −10 % and the price
since entry above −30 % is no longer closed by this rule. After a partial withdrawal the loss leg
reads the cost-basis figure only when a basis is recorded (or provisional) and computable;
otherwise the plain percent can read too low and satisfy it. A pool that cannot be classified as
non-SOL-quoted from the stored mints is treated as SOL-quoted. The price is measured
since entry (`active_bin_at_deploy`, or the first evaluation's bin), not over the last hour.
Turnover is one window of one API field (`volume` at the screening timeframe).

## Grading log
(none yet)
