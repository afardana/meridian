---
id: managed-hold-trailing
config_key: null
status: registered
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
