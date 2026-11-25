---
id: managed-hold-trailing
config_key: null
status: not_met
mode: none (replay only)
registered_at: 2026-11-25
enforce_built: false
---

# Managed hold (a wide trailing + the stop on held positions, instead of no rule at all)

## Claim
A position on HOLD has no exit except the TVL exit and the thin-pool limit. A "managed hold" —
a WIDE trailing (armed at a confirmed peak ≥ A %, fires D pp under it) plus the −15 % stop,
everything else still off — ends with more SOL than the indefinite hold did.

## Why this is a second look at a rejected idea
"Trailing on held positions" was rejected on 2026-10-02 (58 held positions: arm 10–20 % all
worse; arm 30 / drop 15 better on only 10 fires), and "loss floor on held positions" the same
day. New since then: (a) that study ran on tick percentages that were diluted for every
re-ranged position (fixed 2026-10-03, capital basis) and, for positions re-ranged while held,
until 2026-11-25 (`50833c6`); (b) 2026-11-25 hold replay: on five positions wide trails
(≥ 15 / 7.5) matched the operator on the two open winners and beat him on snowball-SOL
(−25.7 % held vs ≈ −15 % stop); (c) the token-death study: price ≥ 50 % under entry within 48 h
in 43 % of entries (78 % for pools under 24 h old). The five replayed positions were SEEN before
this registration and are reported but excluded from the verdict.

## Method (replay; nothing is built)
- **Population:** every position that was on HOLD at any time since 2026-09-01 and is closed,
  bot or operator, with a tick path covering the hold. Excluded from the verdict: the five
  positions of the 2026-11-25 replay; positions whose percent basis during the hold cannot be
  put on the capital (state which and why).
- **Basis:** SOL. Each reading's percent is re-expressed on the capital actually in the position
  at that time (top-ups and re-ranges handled; the stored percent is not trusted for re-ranged
  positions before the two fixes above).
- **Rule simulated from the hold start:** own confirmed peak (two consecutive distinct readings
  above it, the lower one); armed at peak ≥ A; fires on the second consecutive distinct reading
  ≤ peak − D. Stop: second consecutive distinct reading ≤ −15 %. A hold released by the operator
  before a fire ends the simulation (no difference for that position).
- **Result of a fire:** that reading, less 1.5 % of the base side then held (0.75 % of capital
  when the base side is unknown). Capital is idle afterwards — no re-entry is credited, and
  capital the operator added AFTER the simulated exit is not in the managed figure.
- **Δ per position** = managed SOL − actual final SOL (`pnl_sol_net`, else `pnl_sol`).
- **Primary:** A = 15, D = 7.5, with the stop. Reported beside it: 10 / 5, 20 / 10, 30 / 15,
  each with and without the stop, and the stop alone at −15 and −25.

## Pass rule
Registered 2026-11-25, before the population was cut.
1. ≥ 15 positions on which the primary rule fires (trailing or stop) — else `insufficient`.
2. Σ Δ > 0 SOL, and > 0 without the largest |Δ|.
3. Positions better ≥ positions worse.
4. Σ Δ > 0 in each half of the population by hold-start time.
5. The worst single Δ is no larger in size than half of Σ Δ.
6. Check 2 still holds when positions with a top-up after the simulated exit are left out
   (the operator's edge there is adding capital, which the rule cannot do).

`met` → a per-position opt-in "managed hold" mode is proposed in the session (shadow capture
first); HOLD itself is never changed. Anything else → the 2026-10-02 rejection stands, with
these numbers added.

## Revert rule
None — no enforce path exists.

## Grading log

### 2026-11-25 — **not_met** (replay, 105 held positions since 09-01)
- Population: 105 positions with a HOLD on/after 2026-09-01 (position_events hold / resume /
  close; un-hold / re-hold gaps under 5 min merged). 36 unusable: 22 percent basis not
  established during the hold (denominator unknown), 9 last tick does not reconcile with the
  record, 2 no performance record, 1 no ticks during the hold, 2 still open. 69 usable, 4 of them
  the positions seen before registration (snowball, JIMMY ×3) → verdict set n = 65.
- Primary 15 / 7.5 + stop −15: fires 44 (7 trailing / 37 stop); Σ Δ ◎−1.0987; without the
  largest (CRAWL-SOL 69F2FsPS −◎2.3866) ◎+1.2880; better / worse 22 / 22; halves (split 09-29
  21:10) ◎−1.2213 / ◎+0.1227; no position with a top-up after the exit.
  1. ≥ 15 fires: PASS (44)
  2. Σ Δ > 0 and > 0 without the largest: **FAIL**
  3. better ≥ worse: PASS (22 / 22)
  4. Σ Δ > 0 in both halves: **FAIL**
  5. |worst| ≤ Σ Δ / 2: **FAIL** (worst −◎2.3866)
  6. check 2 without top-up-after positions: **FAIL** (same figures, none to remove)
- Secondary grid (cannot rescue):

| variant | fires (trail / stop) | Σ Δ ◎ | w/o largest | better / worse | half 1 / half 2 | worst Δ |
|---|---|---|---|---|---|---|
| 15 / 7.5 + stop −15 (primary) | 44 (7 / 37) | −1.0987 | +1.2880 | 22 / 22 | −1.2213 / +0.1227 | −2.3866 |
| 10 / 5 + stop | 45 (10 / 35) | −0.4301 | +1.9565 | 25 / 20 | −0.9090 / +0.4789 | −2.3866 |
| 10 / 5 no stop | 22 (22 / 0) | +1.1130 | −0.2219 | 12 / 10 | +0.5789 / +0.5341 | −0.9026 |
| 15 / 7.5 no stop | 16 (16 / 0) | −0.1452 | −1.6271 | 5 / 11 | +0.3635 / −0.5088 | −0.9305 |
| 20 / 10 + stop | 41 (2 / 39) | −0.6193 | +1.7674 | 23 / 18 | −0.2214 / −0.3979 | −2.3866 |
| 20 / 10 no stop | 11 (11 / 0) | +1.3139 | −0.1340 | 5 / 6 | +1.5850 / −0.2712 | −0.8336 |
| 30 / 15 + stop | 41 (2 / 39) | −0.7387 | +1.6480 | 23 / 18 | −0.3408 / −0.3979 | −2.3866 |
| 30 / 15 no stop | 7 (7 / 0) | −0.6150 | −1.3123 | 3 / 4 | −0.6150 / +0.0000 | −0.5869 |
| stop −15 alone | 40 (0 / 40) | −0.9869 | +1.3997 | 22 / 18 | −0.5890 / −0.3979 | −2.3866 |
| stop −25 alone | 30 (0 / 30) | +2.7034 | +4.1515 | 21 / 9 | −0.0771 / +2.7805 | −1.4480 |

- Deviations and limits the study states:
  - The percent basis (capital in the position at each reading) was recovered from pool-memory
    snapshots plus position_events (top-ups, re-ranges), not from stored percents. Two
    back-extension assumptions were needed: D ≈ 2C assumed back to the first snapshot (stated per
    position in the table) and D extended back to the last re-range event. Sensitivity (primary
    rule, not part of the verdict): without the D ≈ 2C positions n 58, Σ Δ ◎+1.3595, without the
    largest ◎+3.7461, checks PPPFFP; without any back-extension over 30 min n 49, Σ Δ ◎+0.5785,
    without the largest ◎+2.9651, PPPFFP. Both turn Σ Δ positive (checks 1–3 and 6 pass) but checks 4 and 5
    still fail (a negative half, worst Δ −◎2.3866) — the verdict does not move.
  - Era: pre-10-04 readings carry market-feed noise (pool-price valuation from 2026-10-04).
    Hold start ≥ 10-04: n 28, 17 fires, Σ Δ ◎−1.4849 (PFPFFF); before: n 37, 27 fires, Σ Δ
    ◎+0.3862 (PFFFFF). Operator positions n 48 ◎+0.7846; bot positions n 17 ◎−1.8832.
  - Holds merged when the gap was under 5 min; a hold released before a fire ends the simulation.
  - The stop is live from the hold start, so 11 positions that began the hold at or under −15 %
    are stopped on their second reading (the hold had been placed to ride exactly those).
- Seen positions (excluded from the verdict, Δ ◎): snowball-SOL GGqfMp5g +0.0307, JIMMY-SOL
  9wTNkyoB −0.0554, 9gH8jqU9 +0.0000 (no fire), CYCbgJBm −0.3638; Huss-SOL still open, not graded.
- Not part of the verdict: stop −25 alone Σ +◎2.7034, 21 / 9 (post-hoc; a second look needs its
  own forward registration; the thin-pool hold limit already applies −25 % to held positions
  with entry TVL under $100k).

The 2026-10-02 rejection stands.
