---
id: grace-early-release
config_key: graceEarlyReleaseMode
status: report_only
mode: shadow
registered_at: null
enforce_built: false
---

# Early grace release after 3 green 5m candles (log only)

## Claim
Operator proposal: release the grace every 10 min when the last 3 candles are positive.

## Evidence at registration (CLAUDE.md, 2026-10-11)
Replay of 76 graces favoured the fixed 60 min (+2.01 SOL vs −0.28); only the measurement ships.
No enforce exists.

## Pass rule
None. CLAUDE.md: "Grade: records with `grace_release_shadow` — result vs its `pnl_pct`."

Encoding: Σ (record pnl_pct − grace_release_shadow.pnl_pct) in pp and SOL; counts above / below.
An early release would not have closed at that moment — it would only have let the profit rules
run — so this bounds, it does not measure, the effect.

## Revert rule
n/a.

## Grading log

### 2026-11-23 (1,455-record export) — report_only
- 16 would-release records (12 bot, 4 operator); Σ final − at-release **+28.29 pp ≈ ◎+0.113**;
  10 finished above the would-release pnl, 6 below; their Σ net ◎+0.663.
