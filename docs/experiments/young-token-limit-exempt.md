---
id: young-token-limit-exempt
config_key: holdThinPoolYoungTokenHours
status: registered (operator instruction, live 2026-11-28; forward records only)
mode: live (the exemption is in effect; its counterfactual is recorded)
registered_at: 2026-11-28
enforce_built: true
---

# Thin-pool hold limit not applied to young tokens

## What is live
Operator instruction of 2026-11-28: the thin-pool hold limit (−25 % for 60 s on a held position
whose pool TVL at entry was under $100k) does not close a position whose base token was under
`holdThinPoolYoungTokenHours` (72) old at entry. For such a position the limit runs log-only and
every completed proof is recorded on the position → perf record as `hold_thin_limit_young`
(`first_would_fire_at`, `pnl_pct_at_would_fire`, `worst_pnl_pct`, `would_fire_count`).

This file does not test whether to switch the exemption on — the operator decided that. It
registers, before any forward record exists, how its cost or gain will be reported.

## Seen data (not counted)
Operator-positions study of 2026-11-28 (`docs/research/2026-11-28-operator-positions-study.md`,
exploratory): held positions on tokens under 24 h old in pools under $100k that crossed −25 % for
60 s with no limit acting — 6 cases, 5 finished lower (DUST −94.8 %, ART −58.0 % / −76.2 %,
FACTORY −73.0 %, SM −34.3 %), 1 higher (WINSTON +17.9 %); Σ (actual − close at the crossing)
−◎1.46. The 4 young-token fires of the limit (PRIME, 索拉纳, BASKET, MoonBoy): two tokens lower and
two higher three hours later. No unclosed crossing had a token age between 24 h and 7 d.

## Population
Perf records (bot and operator) closed on or after 2026-11-28T12:00Z that carry
`hold_thin_limit_young.first_would_fire_at`. One case per record.

## Measure
Δ = (`pnl_pct` − `pnl_pct_at_would_fire`) / 100 × `amount_sol` (gross vs gross; a top-up or
withdrawal after the would-fire is noted and the case reported separately).

## Report rule (fixed)
At 8 cases, or on 2027-02-28 with fewer: report n, Σ Δ, Σ Δ without the largest |Δ|, cases better /
worse, and the worst single Δ.
- Σ Δ < 0 AND still < 0 without the largest AND worse > better → reported to the operator as
  "the exemption cost SOL on this sample" with the one-key switch-off (`holdThinPoolYoungTokenHours=0`).
- Otherwise → reported as it is. Nothing is changed automatically in either case.

## Grading log
(none yet)
