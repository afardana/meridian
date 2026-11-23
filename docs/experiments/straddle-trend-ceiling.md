---
id: straddle-trend-ceiling
config_key: harvestStraddleTrendCeilingMode
status: report_only
mode: shadow
registered_at: null
enforce_built: true
---

# Straddle trend ceiling (skip a straddle after ≥ +15 % over the gate candles)

## Claim
Straddles whose gate candles had already run ≥ +15 % do worst (10-03: price-only straddle −8.8 %
at +60 m, 2 of 7 positive).

## Evidence at registration (CLAUDE.md, 2026-10-03)
n = 7 — "Grade the ceiling on those records before enforcing (n = 7 is thin)."

## Pass rule
None registered. Report: positions with a `straddle_gate_events` entry carrying
`ceiling_would_skip: true` — outcome of those that straddled anyway (`straddle_count > 0`;
`harvestStraddleMode=enforce` in prod), against straddled positions with no ceiling would-skip.
Caveat: the record does not say which gate event the straddle followed.

## Revert rule
n/a.

## Grading log

### 2026-11-23 (1,455-record export) — report_only
- 96 records with gate events; 31 with a ceiling would-skip (26 bot): Σ net ◎+1.616, 1 at
  ≤ −10 %, 30 winners.
- flagged and straddled anyway: 16 → Σ net **◎+1.193**, mean +9.47 %, 1 at ≤ −10 % (NIO-SOL).
- not flagged, straddled: 29 → Σ net ◎−0.078, mean −0.16 %, **7 at ≤ −10 %**.
- Read: the ceiling would have skipped the better straddles. Enforcing it is not supported.
