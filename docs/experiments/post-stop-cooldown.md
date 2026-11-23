---
id: post-stop-cooldown
config_key: postStopCooldownMode
status: already_enforced
mode: enforce
registered_at: 2026-11-08
enforce_built: true
---

# Post-stop cooldown (no bot re-entry within 24 h of a stop-class close)

## Claim
A bot re-entry into a pool within 24 h of a bot stop-class close there loses.

## Evidence at registration (CLAUDE.md, 2026-11-08)
398 bot deploys 09-26 → 11-08: 24 h blocks 24, Σ net −◎0.446 (90 % CI −0.73 … −0.18), negative in
both periods; blocked winners +◎0.06 vs losses −◎0.51.

## Pass rule
Verbatim (CLAUDE.md, Post-stop cooldown, 2026-11-08):
> after ≥ 10 would-skips or three weeks, enforce only if the would-skipped deploys' Σ net (`pnl_sol_net`) < 0 AND their winners' Σ ≤ ⅓ of |their losers' Σ|.

The grader reports it only: prod runs `postStopCooldownMode=enforce`, and under enforce a
would-skip deploy never happens, so records cannot grade it any more (needs the
rejected-candidates counterfactual).

## Revert rule
Entry gate: not gradable from records.

## Grading log

### 2026-11-23 (1,455-record export, prod config) — already_enforced
- 50 records carry `post_stop_gate_would_skip` (43 bot, 2026-11-08 … 11-13); **0 would-skips**.
- The pre-registered rule was therefore not met (0 of 10 would-skips; three weeks would end
  2026-11-29) when the mode went to enforce — the promotion rests on the replay alone.
