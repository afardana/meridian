---
id: max-hold
config_key: maxHoldMode
status: insufficient
mode: shadow
registered_at: 2026-11-07
enforce_built: true
---

# Max hold (close at the cap, 360 min)

## Claim
Closing a bot position at 360 min of age (unless it sits above its range) does better than
letting it run.

## Evidence at registration (CLAUDE.md, 2026-11-07)
Bot deploys since 09-26: a flat 360-min cap +◎0.73 but −◎0.13 without the top 2, 90 % CI
−0.22 … +1.92, 19 better / 27 worse; every T < 240 negative; sign flips between 3-week periods.

## Pass rule
Verbatim (CLAUDE.md, Max hold, 2026-11-07; max-hold.js header):
> after ≥ 30 would-fires at the cap or 6 weeks, enforce only if Σ Δ◎ > 0 and still > 0 without the largest |Δ|, better ≥ worse, worst truncation ≤ ½ Σ, same sign in both halves.

Encoding (reuses `max-hold.js`: `maxHoldCfRecords`, `summarizeMaxHoldCf`, `maxHoldConfig`):
- population: records with a usable `max_hold_cf` (bot, not a leg, never held).
- "would-fire at the cap" = a `max_hold_cf.grid[cap]` cell with `affected: true` (alive at the
  cap and not above range); Δ = its `delta_sol`. The cap is `maxHoldMinutes` from `--config`
  (default 360). `max_hold_shadow` stamps (only since 11-07) are counted beside it, not used.
- threshold: affected ≥ 30 OR ≥ 42 days since 2026-11-07 (→ 2026-12-19).
- checks over ALL records with a cf (not the evolver's last-60 window): Σ Δ > 0; Σ Δ without
  the largest |Δ| > 0; better ≥ worse (|Δ| ≤ ◎0.0005 is a tie, `MAX_HOLD_EVOLVE.tieSol`); worst
  Δ ≥ −½ Σ; halves (split by record count, as `summarizeMaxHoldCf`) same non-zero sign.
- robust: the record with the largest |Δ| removed (Δ is the graded quantity, not pnl_sol_net).

## Revert rule
After promotion: closes with `exit_family = max_hold` and a scored exit quality; n ≥ 8 and
early_exit > good_exit → revert. (Separately, max-hold.js's own evolver revert check stays.)

## Grading log

### 2026-11-23 (1,455-record export, `--now 2026-11-23T01:20:00Z`) — **insufficient**
- sample: 84 records with a cf (closes 2026-10-28 … 11-13; last cf computed 11-13 04:54Z), 19
  affected at 360. 12 `max_hold_shadow` would-fires. Needs 11 more affected closes or 2026-12-19.
- T=360 (all five checks PASS today): Σ Δ ◎+0.2968; without the largest ◎+0.2285; better/worse
  10/7; worst ◎−0.0301 (limit ◎−0.1484); halves ◎+0.1994 / ◎+0.0974; d = 0.54.
- context: CI Σ Δ ◎+0.109 … ◎+0.502. Robust (without CHOO-SOL, Δ ◎+0.0684): all pass.
- other caps (context): 240 n=25 Σ +0.197 (halves +/−), 480 n=13 Σ +0.284, 720 n=6, 1440 n=2.
- **warning:** the export has no bot close after 2026-11-13. If none arrive, the 6-week time arm
  makes this `met` on 2026-12-19 with n = 19 affected closes (below the evolver's own minimum of
  20), and automatic promotion would follow. Decide before then whether that is acceptable.
