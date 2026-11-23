---
id: first-entry-probation
config_key: firstEntryProbationMode
status: closed: not met 2026-11-23
mode: shadow
registered_at: 2026-10-17
enforce_built: true
---

# First-entry probation (−8 % within 240 min on a pool's first entry)

## Claim
On a bot deploy into a pool with no bot close in the prior 12 h, a stop at −8 % within 240 min
catches most disasters at little cost.

## Evidence at registration (CLAUDE.md, 2026-10-17)
112 first entries since 09-26: −◎0.51, 13 at ≤ −10 %. The stop fires on 14, catches 11 of 13
disasters, cuts 2 winners (QI +5.0 %, BORDR +3.7 %) — net +◎0.44 (two large positions carry half).

## Pass rule
Verbatim (CLAUDE.md, First-entry probation, 2026-10-17):
> after 15 would-fires or three weeks, enforce only if the would-fire positions finished at net worse than −8 % on their capital AND at most 1 in 4 of them were winners.

Encoding:
- population: bot deploys carrying `first_entry_probation` (key present); tagged = the field is a
  would-fire object; rest (context only) = `first_entry === true` without a would-fire.
- threshold: would-fires ≥ 15 OR ≥ 21 days since 2026-10-17.
- "finished at net worse than −8 % on their capital" = **Σ `pnl_sol_net` ÷ Σ `amount_sol` × 100
  < −8** over the would-fire positions (capital-weighted; the unweighted mean of `pnl_pct` is
  reported beside it).
- "at most 1 in 4 winners" = winners (`pnl_sol_net` > 0) / n ≤ 0.25.
- no drop clause → a failed rule at the threshold is `not_met`.

## Revert rule
After promotion: closes with `exit_family = probation_stop` and a scored
`post_close.exit_quality` (good_exit / early_exit / flat / marginal); n ≥ 8 and early_exit >
good_exit → revert.

## Grading log

### 2026-11-23 (1,455-record export, `--now 2026-11-23T01:20:00Z`) — **not_met**
- sample: 3 would-fires, 40 first entries without one (110 bot records carry the field; 43 first
  entries). Threshold reached by time (2026-11-07), not by n.
- would-fires: INVERSE-SOL fired −14.32 % at 166 min, finished +16.74 % (◎+0.0634); Anakin-SOL
  −8.22 % at 42 min → +1.24 % (◎+0.0087); NIO-SOL −8.59 % at 112 min → −16.84 % (◎−0.0832).
- check 1 FAIL: Σ net ◎−0.0111 on ◎1.35 = −0.82 % (need < −8 %); unweighted mean +0.38 %.
- check 2 FAIL: winners 2/3 = 0.67 (need ≤ 0.25).
- robust (without NIO-SOL): FAIL / FAIL.
- fragility: n = 3. The verdict is a consequence of the time arm; it says the rule would have cut
  one +16.7 % winner and one +1.2 % winner to save one −16.8 % loser, nothing more.
- action: none (do not enforce). A later `met` on more data would be a second look.
