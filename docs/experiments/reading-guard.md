---
id: reading-guard
config_key: readingGuardMode
status: registered
mode: shadow (capture from the ship date)
registered_at: 2026-11-25
enforce_built: false
---

# Reading guard on non-held positions (a PnL move the price move cannot explain is not a market move)

## Claim
On a position that is NOT on HOLD, a PnL reading that moved more than 5 pp beyond what the
active-bin move since the last trusted reading explains is an accounting transient — an operator
top-up, withdrawal or re-range Meteora has not indexed yet — not a market move. Treating such a
reading as suspect (no peak confirmation, no exit signal) until it is explained, re-based or has
stood 15 min would prevent false stops and false take-profits without delaying a real exit.

## What was known at registration (2026-11-25)
Two live cases, both operator top-ups, neither closed anything:
- JIMMY-SOL CYCbgJBm 07:06 WIB: 58.93 % "valid" (49.33 pp divergence, under the 50 pp limit) for
  40 s during a ◎0.68 top-up; real ≈ 7 %. It was on HOLD (the held-reading guard, `cd53c58`,
  now covers that path). Not held, `takeProfitPct` 45 could have fired on it.
- Huss-SOL E96pMB2p 06:00:13 WIB: −37.27 % for one valuation during a top-up, real ≈ +12 %; the
  price had moved one bin down, so the existing drop guard (suspect only when the bin did NOT
  fall) let it through. The stop was paused by the adoption grace; the signal was reset 10 s
  later by a suspect reading.
The existing guards on non-held readings: an up-jump > 15 pp (suspect ≤ 60 s), a rise ≥ 2 pp
while the bin fell ≥ 3, a drop > 15 pp while the bin did not fall (≤ 30 min), and
`extreme_divergence` (> 50 pp between Meteora's figure and ours).

## Shadow capture (ships with this registration)
`readingGuardMode` off | **shadow** (no enforce exists). The check is the held-reading guard's:
rise ≤ (100 + ref pnl) × ((1 + binStep)^binsRose − 1) + 5 pp, drop ≤ the explained drop + 5 pp,
against the last accepted reading; a flagged reading is accepted after 15 min. Changes nothing.
Per episode (first flagged reading … explained / accepted / closed) the position → perf record
carries `reading_guard_shadow`: direction, from / to pnl, bins moved, explained pp, whether the
existing guards already marked the reading suspect, whether a peak was confirmed or an exit
signal started or fired on a flagged reading (and which rule), how it ended (`reverted`,
`capital_rebase`, `persisted`, `closed`) and how long it lasted.

## Pass rule
Registered 2026-11-25, before any capture.
1. ≥ 12 episodes on ≥ 6 positions, or 2027-01-06 — else `insufficient`.
2. ≥ 80 % of episodes ended `reverted` or `capital_rebase` (i.e. were not market moves).
3. No `persisted` episode had a stop-class exit (stop loss, young stop, probation, rug, crash)
   start or fire on a flagged reading — the guard must never have delayed a real downside exit.
4. ≥ 2 episodes the existing guards did NOT already mark suspect AND on which a peak was
   confirmed or an exit signal started — otherwise the guard adds nothing.

`met` → building `readingGuardMode=enforce` is proposed in the session (it changes exit timing).
At the threshold with check 2 under 50 %, or check 4 failing → **drop** (mode off).

## Revert rule
None yet — no enforce path exists.

## Grading log
