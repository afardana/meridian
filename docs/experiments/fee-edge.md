---
id: fee-edge
config_key: feeEdgeGateMode
status: closed: not met 2026-11-23
mode: shadow
registered_at: 2026-10-04
enforce_built: false
---

# Fee-versus-loss edge tag (fee_edge_ratio < 5)

## Claim
Deploys whose fee edge (fee APR ÷ the volatility-implied loss of the representative range) is
under 5 are the disaster-prone side.

## Evidence at registration (CLAUDE.md, 2026-10-04)
305 bot closes since 08-22: edge < 5 → 111 deploys, 14 % at ≤ −10 %, −1.03 SOL; edge ≥ 5 → 194,
7 %, +0.85 SOL; the split held inside fee/TVL halves and both periods, but since 09-26 the
skipped side netted +0.09 SOL and Spearman(edge, pnl) = 0.04 (it separates disasters, does not
rank winners).

## Pass rule
Verbatim (CLAUDE.md, Fee-versus-loss edge tag, 2026-10-04):
> after 30 tagged closes, enforce only if the tagged group's ≤ −10 % rate is ≥ 2× the rest's AND its net SOL is negative.

Encoding: as reentry-gate (bot deploys carrying `fee_edge_gate_would_skip`; tagged `true`, rest
`false`, `null` = no edge reading in neither), threshold tagged ≥ 30 (no time arm). The rule has
no drop clause: a failed rule at the threshold is `not_met` → do not enforce; enforce is not
built, so `met` would mean `build_enforce`.

## Revert rule
Entry gate: not gradable from records once enforced.

## Grading log

### 2026-11-23 (1,455-record export, `--now 2026-11-23T01:20:00Z`) — **not_met**
- sample: 114 tagged, 182 rest (5 null). Shadow 50.1 days.
- check 1 FAIL: tagged 14/114 = 12.3 % vs rest 19/182 = 10.4 % → ratio 1.18 (need ≥ 2).
- check 2 PASS: tagged Σ net ◎−0.3084 (81 winners, mean pnl −0.43 %).
- context: CI Σ ◎−1.22 … ◎+0.51; ratio CI 0.67 … 2.05.
- robust (without VEIL-SOL −72.4 %, ◎−0.3302 — a held position closed manually after 6.3 days):
  ratio 1.10 FAIL, Σ ◎+0.0218 FAIL. The net check hangs on that one record.
- decision point 2026-10-07 (30th tagged close): ratio 0.90 FAIL, Σ ◎+0.132 FAIL — same verdict.
- action: none (keep or switch off the capture at the operator's discretion; do not build enforce).
