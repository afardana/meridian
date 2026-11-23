---
id: pump-gate
config_key: pumpGateMode
status: closed: dropped 2026-11-23
mode: shadow
registered_at: 2026-11-23
enforce_built: true
---

# 24h pump gate (skip candidates up ≥ +100 % in 24 h)

## Claim
Tokens that ran ≥ +100 % in the 24 h before the deploy are a disaster bucket.

## Evidence at registration
Shadow since 2026-09-29 (CLAUDE.md): backtest of 194 bot deploys / 31 d — 24h ≥ +100 % carried 5
of the covered disasters (Token +717 %, OTC +546 %, ELON +433 %, YAP +406 %, OP +153 %);
skipping them +0.65 SOL on 27 deploys (+0.44 without the largest loss). CLAUDE.md gave no pass
rule.

## Pass rule
Registered **2026-11-23**, mirroring reentry-gate:
> ≥ 20 tagged bot closes; tagged ≤ −10 % rate ≥ 2× the rest's AND tagged Σ net < 0; drop if after 40 tagged closes it is not met.

**Weaker than a true pre-registration:** written after partial sight of the data (two FLOAT-SOL
would-skips that ended positive, +1.05 % and +1.47 %), and after 72 tagged closes had already
accrued.

Encoding: as reentry-gate on `pump_gate_would_skip` (`null` = no 24h reading, young pool, in
neither group); threshold tagged ≥ 20; not met → `not_met` below 40 tagged, `drop` at ≥ 40.

## Revert rule
Entry gate: not gradable from records once enforced.

## Grading log

### 2026-11-23 (1,455-record export, `--now 2026-11-23T01:20:00Z`) — **drop**
- sample: 72 tagged, 289 rest (6 null), 367 bot carrying. Shadow 55.1 days.
- check 1 FAIL: tagged 9/72 = 12.5 % vs rest 29/289 = 10.0 % → ratio 1.25.
- check 2 FAIL: tagged Σ net ◎+2.6494 (50 winners, mean +1.21 %).
- context: CI Σ ◎+0.27 … ◎+6.31 (the only CI that excludes zero — on the wrong side for the
  gate); ratio CI 0.57 … 2.18.
- robust (without CRAWL-SOL 69F2FsPS ◎+1.8595, the same record that tops reentry-gate): ratio 1.26
  FAIL, Σ ◎+0.7899 FAIL.
- decision point 2026-10-05 (20th tagged): ratio 0.48 FAIL, Σ ◎+0.728 FAIL — same verdict.
- action: set `pumpGateMode=off`.
