---
id: grace-shadow
config_key: graceShadowEnabled
status: report_only
mode: shadow
registered_at: null
enforce_built: false
---

# Grace counterfactual (no-grace trailing / take-profit fire)

## Claim
Measure what the fixed 60-min profit grace (straddle or adoption) costs or earns per position.

## Evidence at registration (CLAUDE.md, 2026-10-19)
PIERRE-SOL 10-19: in-grace high 10.68 %, released at 3.85 %, trailing fired at 2.25 %; without
the grace trailing would have closed near +9 %. The 2026-10-03 straddle evaluation favoured 60 min
(+0.135 SOL vs no grace +0.098) on 6 straddles.

## Pass rule
None registered (report only). CLAUDE.md: "Grade per `kind`: Σ (record `pnl_pct` −
`no_grace_fire_pct`) over records with a fire, and how often the grace ended above its no-grace
fire."

Encoding: per `kind`, over records with a `grace_shadow` object and a `no_grace_fire_pct`:
Σ and mean of (record pnl_pct − no_grace_fire_pct) in pp and SOL (× amount_sol); share whose
`end_pct` (reading at the grace end) > the fire, and share whose final pnl_pct > the fire.

## Revert rule
n/a.

## Grading log

### 2026-11-23 (1,455-record export) — report_only
- 29 records with a grace_shadow object (108 carry the key).
- straddle (18, all bot): 17 with a no-grace fire; Σ (pnl − fire) **−54.44 pp ≈ ◎−0.246**, mean
  −3.20 pp; grace end above the fire 9/16; final above the fire 10/17.
- adoption (11, all operator): 2 with a fire; Σ −27.08 pp ≈ ◎−0.067; 4 still in their grace at close.
- Read: on straddles the no-grace trailing would have done better in aggregate, contrary to the
  10-03 six-straddle evaluation. Worth a registered rule if the operator wants to revisit the grace.
