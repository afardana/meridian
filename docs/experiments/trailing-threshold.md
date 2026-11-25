---
id: trailing-threshold
config_key: trailingTriggerPct / trailingDropPct (existing keys; no new code path)
status: applied_under_revert_check (replay verdict met_with_deviation; V9 2 / 1.0 applied in prod 2026-11-25)
mode: none (replay only; prod trailingDropPct 1.0 since 2026-11-25, revert check running)
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

### 2026-11-25 — V9 (2 / 1.0) passes under the stated deviation; nothing passes the literal spec
Replay: session scratchpad `trailing2/` (`tables.md`, `results.json`); tick data to 2026-11-25 07:58 UTC.

- Population: bot positions closed 2026-10-05 → 11-25, no rebalance legs: 269; included 260
  (8 on HOLD and 1 with a late first tick excluded). Operator 137 → 108 included, reported
  separately. Bot included: straddled 32, operator-re-ranged 12; 3 horizons cut by the data end.
- Deviations from the registered method (both stated by the study):
  - **D1** — 60 of 260 bot closes were made by rules the spec leaves out of the model (low yield 22,
    manual 27, rug 9, young-token stop 2), so the baseline could reproduce at most ≈ 77 % and check 7
    (≥ 80 %) was unreachable as written. Those closes are imposed at their live time and PnL (a variant
    differs only if it exited earlier).
  - **D2** — live straddles are kept on the recorded path (60-min grace, trailing reset).
  - Under the LITERAL spec (no imposed closes, straddles ignored; mode L) reproduction is 63.8 % and
    every variant fails check 7, i.e. nothing passes. V9 passes checks 1–6 there too (Σ ◎+0.192,
    CI +0.100 … +0.281, 63 / 6).
- Mode D (the graded mode), baseline reproduction 246 / 260 = 94.6 % (live closes by a modelled rule
  187 / 200). Δ = variant − baseline, ◎ net of the modelled exit swap, fees after the live close 0;
  baseline Σ net ◎−0.5109:

| variant | n differ | Σ Δ ◎ | 90 % CI | Σ w/o largest | better / worse | halves | worst Δ | Σ Δ (secondary fees) | checks 1–7 | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| V0 no trailing | 90 | −4.7992 | −6.2912 … −3.4164 | −4.3735 | 35 / 55 | −1.2691 / −3.5301 | −0.4257 Diamond-SOL | −0.5824 | PFFFFFP | FAIL |
| V1 3 / 1.5 | 31 | −1.2121 | −2.0721 … −0.4504 | −0.8935 | 18 / 13 | −0.3710 / −0.8411 | −0.3186 Diamond-SOL | +0.0351 | PFFPFFP | FAIL |
| V2 5 / 2.5 | 86 | −2.3894 | −3.4199 … −1.4335 | −2.0708 | 33 / 52 | −0.7335 / −1.6559 | −0.3186 Diamond-SOL | −0.0587 | PFFFFFP | FAIL |
| V3 5 / 3 | 88 | −2.3590 | −3.3963 … −1.3914 | −2.0404 | 34 / 54 | −0.6879 / −1.6712 | −0.3186 Diamond-SOL | −0.0760 | PFFFFFP | FAIL |
| V4 8 / 4 | 90 | −3.5738 | −4.7433 … −2.5010 | −3.2551 | 33 / 57 | −1.1425 / −2.4312 | −0.3186 Diamond-SOL | +0.3799 | PFFFFFP | FAIL |
| V5 10 / 5 | 90 | −4.4204 | −5.8612 … −3.1035 | −3.9947 | 34 / 56 | −1.1807 / −3.2397 | −0.4257 Diamond-SOL | +0.4767 | PFFFFFP | FAIL |
| V6 15 / 7.5 | 90 | −4.4081 | −5.8674 … −3.0761 | −3.9824 | 36 / 54 | −1.0963 / −3.3118 | −0.4257 Diamond-SOL | −0.3563 | PFFFFFP | FAIL |
| V7 2 / 1.5 + net ≥ +0.5 % gate | 23 | −0.2000 | −0.5081 … +0.0732 | −0.0896 | 16 / 7 | −0.1297 / −0.0703 | −0.1104 PUSSY-SOL | +0.2251 | FFFPFFP | insufficient |
| V8 arm 2, drop max(1.5, 0.4×peak) | 31 | −0.3172 | −0.5003 … −0.1634 | −0.2440 | 3 / 26 | −0.1238 / −0.1934 | −0.0732 Diamond-SOL | +0.0604 | PFFFFFP | FAIL |
| **V9 2 / 1.0** | 70 | **+0.1722** | +0.0878 … +0.2577 | +0.1945 | 62 / 8 | +0.0555 / +0.1167 | −0.0222 QI-SOL | +0.1677 | PPPPPPP | **PASS** |
| V10 2 / 1.5 without overshoot shortcut | 8 | −0.0104 | −0.0254 … +0.0020 | −0.0041 | 3 / 5 | −0.0040 / −0.0064 | −0.0063 VEIL-SOL | −0.0088 | FFFFFFP | insufficient |

- **Verdict: V9 (trigger 2 / drop 1.0) is the only variant that passes all seven checks** (n 70,
  Σ Δ ◎+0.172, CI +0.088 … +0.258, ◎+0.195 without the largest, 62 / 8, halves +0.056 / +0.117, worst
  −◎0.022 QI-SOL, secondary fees +0.168). +0.159 of the +0.172 comes from exits on the recorded path
  (live family trailing_tp: ◎+0.2152 over 64 positions; harvest −0.0390 (4), take_profit −0.0040 (2)).
  No trailing (V0) ◎−4.799 (CI −6.29 … −3.42), 35 / 55: the positions trailing released mostly ran on
  into the −15 % stop (72 stop-loss exits vs 26 in the baseline). Every wider setting fails; V7 (net-cost
  gate) and V10 are insufficient and negative.
- Robustness (not part of the verdict): close latency 15 s / 30 s → V9 ◎+0.241 / +0.303 (V0 −4.7135 /
  −4.6404). Never-straddled n 228: V9 +0.162, 55 / 5, PPPPPPP. Straddled n 32: all insufficient
  (V9 +0.0106, 7 / 3). Operator positions n 108: V9 +0.198 (CI −0.05 … +0.45, fails check 2), V0 −5.49 with
  zero fees but +2.82 under the secondary fee assumption.
- Descriptive (not part of the verdict): live bot trailing closes since 10-05 by confirmed peak
  (n 88): peak 2–3 n 32, mean gross +0.47 %, Σ net ◎−0.025, 12 netted ≤ 0; 3–5 n 31, +2.01 %, Σ +0.158,
  6 netted ≤ 0; 5–10 n 20, +5.32 %, Σ +0.802, 0; > 10 n 5, +13.03 %, Σ +0.364, 0. All 88: Σ net
  ◎+1.299, 18 netted ≤ 0, 29 through the overshoot shortcut, median give-back 1.74 pp. After-close mcap
  median −1.3 / −2.9 / −4.9 % at +30 / +60 / +180 min (n 87). JIMMY-SOL EvJVmJjC (path available for 40 min after the close): baseline, V8
  and V10 close at 14:32:09 WIB, +0.43 % gross, ◎+0.0090; V9 closes at 14:32:04, +0.84 %, ◎+0.0176
  (Δ +◎0.0086); V0–V7 are still open at the end of the available path (15:11:54 WIB), modelled −5.44 %
  (low −6.66 % at 15:05:14), ◎−0.1142, Δ −◎0.1233.
- What the replay cannot model: the rules left out of the exit stack (low yield, crash / rug fast paths,
  calm-pair rule, max hold, LLM closes, young-token stop, first-entry probation) except by imposing the
  live close; fee income after the live close (primary = 0, a lower bound for variants that stay open;
  secondary uses the position's own fee per bin crossed, and the signs of several variants flip between
  the two); post-close price paths for 64.6 % of the minutes come from candles, not internal ticks
  (calibration MAD median 1.52 bins); a straddle branch at the harvest (mode D keeps the live straddle
  only on the recorded path); close latency (15 / 30 s shown above); horizon 24 h after deploy (3 cut by
  the data end).
- Caveat: V9 was the only variant tighter than live, so "tighter is better" rests on one grid point, and
  the gain is small (≈ +◎0.17 over 51 days).

Proposal to the operator: `trailingDropPct` 1.5 → 1.0, trigger unchanged. Not changed — the setting moves only on the operator's word (config backup, restart, re-grade after 14 days or 20 bot trailing closes per the revert rule). Removing trailing and every wider setting join the rejected list.

### 2026-11-25 — operator approved V9 (2 / 1.0); applied in prod the same day
- 2026-11-25 — operator approved V9 (2 / 1.0) in the session; applied in prod the same day (config
  backup in /home/angga/meridian-config-backups/). Prod is now `trailingTriggerPct` 2,
  `trailingDropPct` 1.0, `trailingOvershootPct` 0.5 (trigger and overshoot unchanged).
- The revert rule is now running: re-grade after 14 days (2026-12-09) or 20 bot trailing-TP closes
  since the change, whichever comes first. Σ `pnl_sol_net` per bot trailing close below the
  2 / 1.5 era's median → back to 2 / 1.5; a revert is the operator's decision.
- Confound, stated now so the re-grade does not over-read it: the replay's +◎0.172 was measured by
  applying drop 1.0 to price paths that were produced while live ran 1.5 (the recorded paths end at a
  1.5 close; what 1.0 changes after its own earlier exit comes from the model). Live closes under 1.0
  are the first direct evidence. Any other exit-rule change made in the same window (stop, harvest,
  grace, above-range caps, max hold, low yield) will confound the re-grade; such changes are to be
  listed in this log when they happen.
