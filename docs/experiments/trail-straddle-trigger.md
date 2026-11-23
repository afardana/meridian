---
id: trail-straddle-trigger
config_key: trailStraddleShadowTrigger
status: insufficient
mode: shadow (trigger 3)
registered_at: 2026-10-19
enforce_built: false
---

# Straddle trailing trigger 3 % (shadow of the live 2 %)

## Claim
On straddled positions a trailing trigger of 3 % (drop unchanged 1.5) beats the live 2 %.

## Evidence at registration (CLAUDE.md, 2026-10-19)
Replay: +◎0.07, 3 better / 0 worse, n = 23 — too thin to enforce.

## Pass rule
Verbatim (CLAUDE.md, Straddle trailing shadow, 2026-10-19):
> after ~30 straddled trailing closes, enforce only if the would_hold cases' +60 min probe is positive in ≥ 2/3 AND the Σ of the tail risk those holds take on (live fire pnl − the stop, per would-hold case) stays under the gain.

Encoding:
- population: bot records carrying `trail_straddle_shadow`; a case = the object has a
  `verdict` (stamped only when the live trailing TP closed a straddled position).
- threshold: cases ≥ 30 ("~30" read as 30).
- check 1: share of `would_hold` cases with `post_close.m60.pct` > 0, among those with an m60
  probe, ≥ 2/3. The probe is the pool mcap change 60 min after the close — not position pnl.
- check 2: Σ over would_hold of (`live_fire_pct` − `stopLossPct`) — stop from `--config`, default
  −15 — reported in pp and SOL. **"The gain" is not computable from the records**: nothing
  records what holding past the live fire would have earned (the probes are pool mcap moves).
  The check is `n/a` and the verdict stays `insufficient` even at 30 cases until a capture
  exists (e.g. the position's pnl at the 3 % shadow's own fire, from price_ticks).

## Revert rule
Enforce is not built; none defined.

## Grading log

### 2026-11-23 (1,455-record export, `--now 2026-11-23T01:20:00Z`) — **insufficient**
- sample: 10 straddled trailing closes (would_hold 2, same 8); 97 bot records carry the field.
  Needs 20 more.
- would_hold: CHOO-SOL peak 2.01, fired 0.43 %, m60 −1.4 %; BAGSPAY-SOL peak 2.72, fired 1.22 %,
  m60 +6.1 %. Check 1: 1/2 = 0.50 (FAIL at this n). Tail risk Σ 31.65 pp ≈ ◎0.314.
- would_hold Σ net ◎−0.0141; same Σ net (8) recorded in the JSON.
