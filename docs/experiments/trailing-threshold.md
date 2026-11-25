---
id: trailing-threshold
config_key: trailingTriggerPct / trailingDropPct (existing keys; no new code path)
status: registered
mode: none (replay only)
registered_at: 2026-11-25
enforce_built: true (the keys exist; a change is the operator's decision)
---

# Trailing take-profit threshold (is 2 / 1.5 the right setting, or should trailing go?)

## Claim
The live trailing TP (armed at a confirmed peak ≥ 2 %, fires 1.5 pp under the peak) locks in a
gross result as low as 0.5 % (2 − 1.5), which is at or under the cost of leaving a position that
holds base inventory (exit swap 0.3–2 % of the base side, plus a 0.7 %-class entry premium on a
two-sided position). A wider setting — or no trailing at all, leaving the stop, the round-trip
harvest, the above-range caps, low yield and the fixed take-profit — ends with more SOL.

## What was known at registration (2026-11-25)
- Operator question of 2026-11-25 with one case: JIMMY-SOL EvJVmJjC (bot deploy, re-ranged
  two-sided by the operator at 14:15 WIB): confirmed peak 2.43 %, first breach 0.84 %, closed on
  the overshoot shortcut at 0.43 % gross = ◎0.0090 on ◎2.1, before a 0.70 % entry premium and
  the exit swap. `[CLOSE_EFF_SHADOW]` estimated net 0.38 % at the breach.
- The hold replay of 2026-11-25 (two open held operator positions): trailing 2 / 1.5 exits at
  +7.1 % / +2.1 % on a position the operator took to +30 %; only 20 / 10 or wider kept it.
- History that points the other way: the 2026-07-27 grid (278 closes, snapshot paths) picked
  2 / 1.5 over 3 / 1; the 2026-09-25 tick replay found static 2 / 1.5 +0.92 SOL / 30 d better
  than the adaptive (8 %-pinned) trailing on bot deploys. Both replays END each path at the live
  close, so neither could credit a wider setting with anything that happened after it.
- No number for any variant below has been computed.

## Method (replay; nothing is built)
- **Population:** bot deploys (not adopted, not a rebalance leg, never on HOLD) closed
  2026-10-05 → 2026-11-25 (pool-price valuation era). Operator positions are replayed too and
  reported separately; they do not count toward the verdict.
- **Path:** the position's own `price_ticks` up to the live close; after it, the pool's price
  path (other positions' ticks in the same pool where they exist, else GeckoTerminal candles)
  through a passive bin model of the position (the `bidask_flip_replay.js` model), to a horizon
  of 24 h after the deploy. Still open at the horizon → marked there, less the exit cost.
- **Exit stack in the model, identical for every variant:** stop −15 %, fixed take-profit 45 %,
  round-trip harvest (closed to cash — no straddle branch), pumped-above 50 bins, unfilled-ladder
  cap 25 bins, OOR-below 60 min, OOR-above 720 min. Not modelled: low yield, crash / rug fast
  paths, the calm-pair rule, max hold (shadow), LLM closes.
- **Costs:** exit swap = the record's own realized slippage ratio applied to the base side at the
  simulated exit (0.3 % + ◎0.00002 when the record has none); nothing for an all-SOL exit.
- **Fees after the live close:** primary = **zero** (a lower bound for every variant that holds
  longer than live did). Secondary = the position's own fee per bin crossed before the close.
- **Baseline:** live 2 / 1.5 simulated in the same model. The model is accepted only if that
  baseline reproduces the recorded close (same exit family, |Δ pnl| ≤ 1 pp) on ≥ 80 % of the
  population; the reproduction rate is reported either way.
- **Variants (all registered now; trigger / drop in pp):** V0 no trailing; V1 3 / 1.5;
  V2 5 / 2.5; V3 5 / 3; V4 8 / 4; V5 10 / 5; V6 15 / 7.5; V7 2 / 1.5 firing only when the
  estimated net of exit costs is ≥ +0.5 % (the close-efficiency gate as specified); V8 armed at
  2, drop = max(1.5, 0.4 × peak); V9 2 / 1.0; V10 2 / 1.5 without the overshoot shortcut.

## Pass rule
Registered 2026-11-25, before any variant was computed. A variant passes when ALL hold, with
fees after the live close at zero, Δ = variant − baseline in SOL net of exit costs:
1. ≥ 30 positions whose outcome differs from the baseline — otherwise `insufficient`.
2. Σ Δ > 0, and the bootstrap 90 % CI lower bound > 0 (eleven variants are being compared).
3. Σ Δ > 0 without the largest |Δ|.
4. Positions better ≥ positions worse.
5. Σ Δ > 0 in each half of the period (split at the median deploy time).
6. The worst single Δ is no larger in size than half of Σ Δ.
7. The model reproduction rate is ≥ 80 %.

Several pass → the one with the largest Σ Δ without its largest term. `met` → the setting is
proposed in the session; `trailingTriggerPct` / `trailingDropPct` are changed only on the
operator's word (config backup, restart, 14-day re-grade on live closes). None passes → 2 / 1.5
stays and "wider / no trailing" joins the rejected list with these numbers.

Reported beside the verdict, not part of it: the realized net (`pnl_sol_net`) of live trailing
closes by confirmed-peak bucket and how many netted ≤ 0; `post_close.exit_quality` of trailing
closes; the same grid on operator positions; the same grid on straddled positions only (see
`trail-straddle-trigger.md`).

## Revert rule
A changed setting is re-graded after 14 days or 20 bot trailing closes: Σ `pnl_sol_net` per close
below the 2 / 1.5 era's median → back to 2 / 1.5.

## Grading log
