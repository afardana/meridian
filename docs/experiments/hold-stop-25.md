---
id: hold-stop-25
config_key: holdThinPoolTvlUsd (existing key; no new code path)
status: registered (forward-only; no forward data yet)
mode: none (replay only)
registered_at: 2026-11-25
enforce_built: false
---

# Hold stop at −25 % on every held position (the thin-pool hold limit without its TVL bar)

## Claim
Extending the −25 % hold limit to every held position — not only positions in pools whose entry
TVL was under `holdThinPoolTvlUsd` ($100k) — ends with more SOL than the indefinite hold.

## Why this is a second look at a rejected idea
"Loss floor on held positions" was rejected on 2026-10-02 (58 held positions: actual −0.17 SOL;
a −20 % floor −0.26, a −30 % floor −0.89; half the breaches recovered). The thin-pool hold limit
study of 2026-10-11 found that on pools with entry TVL ≥ $100k any such limit loses (CRAWL-SOL was
cut at −29 % and finished +66 %); that is why the shipped limit has a TVL bar.

New since then: the 2026-11-25 managed-hold replay ([managed-hold-trailing](managed-hold-trailing.md))
reported a secondary row, "stop −25 alone", over its 65-position verdict set: 30 fires, Σ Δ
◎+2.7034, ◎+4.1515 without the largest, 21 better / 9 worse, halves ◎−0.0771 / ◎+2.7805, worst
single Δ ◎−1.4480. That is a post-hoc look at data that was already SEEN, so it cannot grade this
claim. The test below is forward-only.

The thin-pool hold limit (`holdThinPoolLimitMode`, enforce in prod since 2026-11-24) already closes
a held position with entry TVL under $100k at −25 %. The only NEW population is held positions
where that live limit does not apply.

### Context — seen data, not part of the verdict
The 30 "stop −25 alone" fires of the 2026-11-25 replay, split by the entry TVL on the position's
perf record (one record per position, joined on the position address against the export of
2026-11-25):

| entry TVL | fires | Σ Δ ◎ | better / worse |
|---|---|---|---|
| under $100k (the live limit covers these today) | 15 | +3.5018 | 13 / 2 |
| $100k or more | 13 | −0.5494 | 7 / 6 |
| unknown (no entry TVL on the record) | 2 | −0.2490 | 1 / 1 |
| all | 30 | +2.7034 | 21 / 9 |

The whole of the replay's gain comes from positions the live limit already covers; on the new
population (≥ $100k or unknown, 15 fires) the seen data reads Σ Δ ◎−0.7984, 8 better / 7 worse
(largest negative OTC-SOL −◎1.4480). This is consistent with the 2026-10-11 finding and is the
reason the claim is tested forward before anything changes.

## Method (forward replay; nothing is built)
- **Population:** positions (bot or operator) that were on HOLD at any time, with the hold
  starting on or after 2026-11-26 00:00 WIB, closed, with a tick path covering the hold, and to
  which the live thin-pool limit did NOT apply during the hold. Each position is listed with the
  reason the live limit did not apply: entry TVL ≥ `holdThinPoolTvlUsd`; entry TVL unknown;
  exempted by the operator (`hold_thin_limit_exempt`); or `holdThinPoolLimitMode` not `enforce`
  at the time.
- **Basis:** SOL; each reading's percent is on the capital in the position at that reading. Held
  positions are capital-synced and re-range-synced since 2026-11-25, so the stored percent can be
  used from then on, but every position is checked: one whose basis cannot be established for the
  hold is excluded and listed with the reason.
- **Rule simulated from the hold start:** the shipped thin-pool hold limit's own proof
  (`hold-thin-limit.js`) at −25 % with the TVL bar removed — a streak starts only on a reading
  whose drop from the last usable reading above the limit the price move explains (the plausible
  crossing test, 5 pp slack); it fires after ≥ 2 distinct valuations (an unchanged one counts again
  after 30 s) and ≥ 60 s with every usable reading at or under the limit (one above resets; a pause
  over 3 min starts over). A hold released before a fire ends the simulation (no difference for
  that position).
- **Result of a fire:** that reading, less 1.5 % of the base side then held (0.75 % of capital when
  the base side is unknown). Capital is idle afterwards — no re-entry is credited, and capital the
  operator added after the simulated exit is not in the managed figure.
- **Δ per position** = managed SOL − actual final SOL (`pnl_sol_net`, else `pnl_sol`).
- **Reported beside it, descriptive only:** held positions the LIVE thin-pool limit closed in the
  same period (count, close pnl, post-close probe at +60 / +180 min), and the same simulation at
  −20 % and −30 %.

## Pass rule
Registered 2026-11-25, before any forward data exists.
1. ≥ 10 positions on which the rule fires — else `insufficient`. There is no forced verdict date;
   the count is reported to the operator on 2027-02-28.
2. Σ Δ > 0 SOL, and > 0 without the largest |Δ|.
3. Positions better > positions worse.
4. Σ Δ > 0 in each half of the fires by hold-start time.
5. The worst single Δ is no larger in size than half of Σ Δ.
6. Check 2 still holds when positions with a top-up after the simulated exit are left out.

Drop clause: at ≥ 10 fires with Σ Δ ≤ 0 → `not_met`; the 2026-10-02 and 2026-10-11 rejections
stand and the idea is not looked at again without new evidence.

`met` → an operator decision in the session: the existing key `holdThinPoolTvlUsd` could be raised
so the live limit covers every held position with a known entry TVL (no new code). Nothing changes
automatically, and HOLD itself is never changed by the grader.

## Revert rule
None while it is a replay. If the operator later raises the key, the same replay is re-run on the
fires since the change, and early exits outnumbering good exits over ≥ 8 scored fires (post-close
probes) is reported for a revert decision.

## Grading log

### 2026-11-25 — **registered** (registration)
(none yet — forward-only; first count due with the 14-day re-check)
