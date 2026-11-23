---
id: hold-downside
config_key: holdDownsideMode
status: report_only
mode: shadow
registered_at: null
enforce_built: false
---

# Hold that keeps the stop loss (would-close on held positions)

## Claim
A held position should still have its −15 % stop.

## Evidence at registration (CLAUDE.md, 2026-10-04)
DUST-SOL held −85 % in 13 h; six held positions carried ≈ ◎4.2 unrealised on ◎8.4. The earlier
58-position study found a mechanical floor worse than holding (half the breaches recovered).

## Pass rule
None. CLAUDE.md: "compare each held position's eventual result with its `first_pnl_pct`".

Encoding: final pnl_pct − hold_downside_shadow.first_pnl_pct per record.

## Revert rule
n/a (enforce not built).

## Grading log

### 2026-11-23 (1,455-record export) — report_only, **no data**
- 0 records carry `hold_downside_shadow`: it is stored on the position (state.js
  `noteHoldDownsideShadow`) but perf-record.js does not copy it into the record. Nothing can be
  graded until that field is added to `buildPerfRecord`.
