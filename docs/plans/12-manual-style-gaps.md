# Plan 12 — Gaps between the operator's manual deployments and the autonomous path

Status: Phase 1 BUILT 2026-08-22 (items 1–6 below, all flag-gated; G5/G7 documented, not built)
Motivated by: the operator's 7 manual positions of 2026-08-21/22, evaluated against what
the bot did with the same pools at the same times.

## 1. The manual book (all closed)

| Pool | Deployed (UTC) | Size / width / shape | Held | Result | What the bot was doing with that pool |
|---|---|---|---|---|---|
| MANLET #1 | 08-21 07:57 | ~$93, 69 bins, spot → rebalanced to curve (two-sided) | 164m | +4.19% trailing-TP | Bot deployed it 15h earlier (84 bins bidask, 3 SOL) → fee-death in 2h → low-yield + gas-negative cooldowns; LLM refused it as "+28%/1h chase, zero smart wallets, prior loss" |
| MANLET #2 | 08-21 11:22 | $523, 69 bins curve | 278m | −1.30% (peak +2.61) | Bot locked out: 24h token cooldown set 10:41Z by the repeat-deploy rule, triggered by the operator's +4.19% close |
| TOAD #1 | 08-21 11:51 | $181, 81 bins | 442m | +0.67% trailing-TP | Bot locked out (24h token cooldown from the 10:51Z /closeall) |
| BULLSHIT #1 | 08-21 12:57 | 2.00 SOL, 70 bins | 105m | +5.57% round-trip harvest | Bot closed its own BULLSHIT 09:00Z (+2.32% pumped-above) → 2h anti-LVR cooldown; pool then left the discovery envelope |
| BULLSHIT #2 | 08-21 22:47 | 1.99 SOL, 70 bins | 253m | +3.18% round-trip harvest | Bot locked out (24h token cooldown from the 14:43Z harvest) |
| MADE | 08-22 00:17 | 0.2 SOL, 70 bins | 100m | +0.46% (/close) | Visible 4.5h; cut at un-enriched intel 44<52, then LLM refused 4× as solo candidate |
| TOAD #2 | 08-22 00:18 | 2.00 SOL, 71 bins | 97m | +0.13% (/close) | Bot locked out (24h token cooldown from the 19:14Z close) |

Aggregate: 7 closes, avg +1.84%, 6/7 positive, 0 fee-deaths, 0 disasters, avg hold 206 min.
Bot book since 2026-08-01: 71 closes, avg +0.95%, 58% win, 3 disasters, 17 fee-deaths (24%),
avg hold 462 min.

## 2. Gaps (ranked by how many of the 7 each blocked)

- **G1 — `repeatDeployCooldown` locks the bot out of the pools the operator keeps re-entering
  (5/7).** Trigger 2, scope token, 24h. `isFeeGeneratingDeploy` counts *winners*, so two
  profitable closes on a token forbid the bot from the pool that just paid. Same finding as
  the reverted `poolReentryCooldown` (re-entry penalty was a June artifact).
- **G2 — the rank-mode envelope only sees pools mid-burst.** `RANK_ENVELOPE.minFeeActiveTvlRatio1h=0.30`
  at the live 1h timeframe = 0.30%/h ≈ 7%/day. Measured 2026-08-22 (quiet hour, trending):
  fee≥0.30 → 7 pools, 0 with TVL≥100k; fee≥0.10 → 17/6; fee≥0.05 → 29/10. MANLET/TOAD/BULLSHIT
  read 0.06/0.11/0.14 at 1h with 24h fee/TVL 2.9/2.5/3.1% — invisible while healthy. 7-day
  funnel: 71% of cycles admitted zero. The pools that clear 0.30%/h are the spiking ones the
  LLM then refuses as chases (G4) — a structural contradiction.
- **G3 — solo-candidate bar + stale smart-wallet wording.** 942/1135 non-empty cycles admitted
  exactly one pool. Code (`getLoneCandidateSkipReason`) says smart wallets are not a gate;
  prompt.js and both STEPS blocks still said "skip if the only candidate lacks narrative or
  smart-wallet confirmation". 7-day refusal phrase counts: narrative 173, smart-wallet 207,
  fee-death 145, chase 168.
- **G4 — chase rule applied at +11–29%/1h although written at +50%; no entry price-change is
  captured anywhere (0/126 perf records), so it cannot be backtested.**
- **G5 — safety enrichment `log_only` rejects at un-enriched intel** (MADE 44 vs enriched 55).
  Enforce must ship with the intel bar re-baselined (~58) — not built here.
- **G6 — range width.** Operator 69–81 bins; bot 85–124 (23 of ~70 pinned at 121). Closed
  positions since 07-20 by width: ≤72 n=5 +2.71% (all manual); 73–95 n=20 +0.86%; 96–110 n=37
  +1.20%; >110 n=63 −0.29%, 10% lost >5%, worst −32%. Confounded by volatility. ≤69 is also the
  single-account geometry that makes Meteora's rebalance button available.
- **G7 — no two-sided / re-centre geometry** (MANLET #2). Plan #11 routes this via
  close→harvest→re-enter; stays manual.
- **G8 — no probe-size path above the TVL floor** (MADE at 0.2 SOL). Scout tier exists only
  below $100k; an above-floor solo candidate is full size or nothing.
- **G9 — adopted positions teach the learning engine nothing.** entry_* null, no `adopted`
  flag in perf records, no width field; `similar_past`/evolution/TVL-band blind to the
  best-performing cohort. (`hasCleanPoolHistory` does count them.)

## 3. What was built (Phase 1, 2026-08-22)

1. **G1** `repeatDeployCooldownLosersOnly` (management, default false → shadow). When ON, the
   repeat-deploy lock fires only when the last N deploys on the pool were ALL non-successes
   (low-yield family, OOR-below, or pnl ≤ 0). While OFF, legacy behaviour + `[REPEAT_COOLDOWN_SHADOW]
   would-NOT-lock` when the modes disagree.
2. **G2** `rankSteadyEnvelopeEnabled` (screening, default false → shadow), `rankSteadyMinFeeTvl24h`
   (1.5), `rankSteadyMinTvl` (100000), `rankSteadyMaxExtra` (10). One extra discovery request at the
   24h timeframe (same safety envelope, TVL ≥ rankSteadyMinTvl, fee/active-TVL(24h) ≥
   rankSteadyMinFeeTvl24h); pools not already in the 1h universe are re-fetched at the configured
   timeframe (so every downstream windowed field stays 1h-consistent) and unioned in, tagged
   `steady_envelope`. Shadow logs `[STEADY_ENVELOPE_SHADOW] would-add`.
3. **G3** prompt wording fixed in prompt.js, the screener STEPS, and the REPL `auto` goal: a lone
   candidate is the normal state; smart wallets are a boost, never a requirement; deploy on
   narrative OR degen/metric conviction OR ACCELERATING flow with a clean safety profile.
4. **G9 + G4** entry capture: `entry_price_change_pct` (Meteora `pool_price_change_pct` at the
   screening timeframe) captured at deploy by the executor and stored on the position → perf
   record. Adopted positions get entry metrics via an injected enricher (`setAdoptionEnricher`
   in state.js, registered from index.js) that fetches the pool detail right after adoption
   and fills entry_mcap/tvl/volume/holders/fee_tvl_ratio/organic/volatility/price-change.
   Perf records now carry `adopted`, `probe`, `range_width_bins`, `entry_price_change_pct`.
5. **G6** `playstyle=single_account` preset `{45, 69}` (one Meteora position account; rebalance-able).
   Not the default — switch with `update_config playstyle=single_account`.
6. **G8** probe tier: `probeTierEnabled` (screening, default false), `probeSizeSol` (0.25),
   `probeMaxPositions` (1). `deploy_position` accepts `tier: "probe"`; the executor hard-clamps the
   size, enforces the open-probe cap, tags `probe: true` (state → perf). Offered to the LLM only
   when enabled; a `tier=probe` call while disabled is refused (the model signalled low conviction).

## 4. Enable sequence (prod)

- Day 0: deploy; set `repeatDeployCooldownLosersOnly=true` after the first `[REPEAT_COOLDOWN_SHADOW]`
  line confirms the decision logic on a live close (or immediately — the rule's legacy behaviour
  is documented as wrong for winners).
- Day 0–1: watch `[STEADY_ENVELOPE_SHADOW]` — expect MANLET/TOAD/BULLSHIT-class pools to appear
  during quiet hours. Flip `rankSteadyEnvelopeEnabled=true` once the would-add list looks like
  pools we'd want the LLM to see (and note any intel<52 kills — those are G5's problem).
- Probe tier: enable once the steady envelope is on; otherwise there are no solo candidates to probe.
- Re-run the width table once ≥20 single_account/probe closes exist before moving the default playstyle.

## 4b. Enable log + first finding (2026-08-22 08:36–08:45Z)

All three flags enabled in prod (`user-config.json.bak.plan12` holds the pre-change file). The
three stale legacy "repeat fee-generating deploys (2x)" token locks (TOAD, BULLSHIT, MADE, set by
the rule item 1 replaces) were cleared with the agent stopped (0 positions open).

**Finding — the steady pools now reach the intel gate and all die there, on Yield.** Live
un-enriched intel with Safety pinned at 50 (timeframe=1h):

| pool | lane | intel | Safety | Yield | Momentum | Trust | fee 1h | fee 24h | TVL |
|---|---|---|---|---|---|---|---|---|---|
| Doge2-SOL | burst | 60.8 | 50 | 75.6 | 56 | 54 | 7.07 | — | $28k |
| GTA6-SOL | steady | 51.1 | 50 | 40.8 | 63 | 62 | 0.26 | 6.70 | $166k |
| STONK-SOL | steady | 45.8 | 50 | 36.7 | 43 | 63 | 0.08 | 2.55 | $172k |
| BULLSHIT-SOL | steady | 45.1 | 50 | 35.7 | 40 | 64 | 0.03 | 2.86 | $413k |
| TOAD-SOL | steady | 43.0 | 50 | 30.6 | 38 | 65 | 0.04 | 2.32 | $313k |
| MANLET-SOL | steady | 38.8 | 50 | 17.9 | 42 | 62 | 0.01 | 2.36 | $298k |

`scoreYield` (intel-score.js) normalizes `fee_active_tvl_ratio` as `min(ratio/2.0,1)×40` and
`volume/tvl` as `min((v/tvl)/5,1)×25` — thresholds that only make sense for a **24h** window
(2%/day fee yield, 5× TVL/day turnover). Prod feeds **1h**-windowed fields, so the Yield
dimension scores every healthy pool near zero and saturates only on micro-pool spikes (Doge2:
$28k TVL, 7%/h → Yield 75 → admitted → LLM correctly declined it as a dump play). Trust (59–65)
and enriched Safety (85–98) of the steady pools are fine; enriched intel lands 55–66, i.e. at
or just under the rebaselined bar.

`scripts/safety_rebaseline.js` on 363 records (2026-08-22): admission-preserving cutoff 58
(renouncement-only) / 63 (+concentration) / 52 (worst case); Safety carries no outcome signal
(Spearman 0.09 vs success) — it is a filter, not a ranker, as documented.

**Next (not done — needs a backtest, not a flag):** make `scoreYield` window-aware (scale the
windowed inputs to a 24h equivalent, or prefer `fee_active_tvl_ratio_24h` when present) and re-run
`scripts/rank_admission_backtest.js` before changing the gate; then `safetyEnrichMode=enforce`
with `rankMinIntelScore` ≈ 58–60. Until then the steady envelope is on but inert at the intel gate.

## 4c. Phase 2 — window-aware Yield, backtested (2026-08-22)

`intelYieldWindowMode` ("legacy" | "log") in intel-score.js. "log" maps the 24h-equivalent fee
rate (windowed × 1440/tf, or the pool's own 24h average when higher) on a log scale between
1%/day (0 pts, = the low-yield exit threshold) and 48%/day (40 pts, = the legacy 2.0 cap at 1h);
turnover between 0.2× and 120× TVL/day (0–25 pts). `scripts/yield_window_backtest.js` on the
363-record dump (300 usable, tf=1h assumed for all — config backups show 1h since ≥07-12):

- **Pure monotone re-scaling on the historical population**: Spearman(total legacy, total log)
  = 1.00; Spearman vs success unchanged (0.20 both); quartile success-rates move only with the
  bin edges. Median intel_total 55.1 → 63.2; fee component saturation identical (88/300).
- **The gate moves, not the ordering**: legacy@52 admits 77.3% / blocks 31.8% of failures →
  LOG-mode bar preserving admission ≈ **61**, preserving failure-blocked ≈ 62. Applied in prod
  as `intelYieldWindowMode=log`, `rankMinIntelScore=61`, `minIntelScore=61`, `scoutMinIntel=78`
  (+8 ≈ the median shift, keeps the scout bar neutral). Safety-enrich enforce would need ≈69
  under log mode (61 + the ~8 enrichment lift; 158 records carry intel_total_enriched).
- **Live universe (08-22 15:50 local)** legacy→log: Doge2 59→63, CONK 51→60, GTA6* 52→60,
  Qenis* 46→51, BULLSHIT* 45→50, BUTTHOLE* 42→49, LAYOOO* 44→47, MANLET* 42→46, STONK* 39→43,
  TOAD* 38→42 (*=steady lane). Same admitted set at log@61 as legacy@52 (Doge2 only).
- **Honest limit**: history holds only burst-era entries (median 29%/day fee rate at deploy);
  the steady regime (2–4%/day) is absent, so the backtest cannot show steady pools win — it
  shows the fix is admission-neutral for everything the bot used to do. Under any honest
  24h yield measure the steady pools ARE lower-yield than bursts; what made the operator's
  steady entries pay (+1.84% avg, 0 fee-deaths) was timing on the flow: line, not absolute
  yield. Hence the steady lane needs its own bar, not a different Yield curve.
- **Built, inert**: `rankSteadyMinIntel` (null). Rationale for a lower bar on that lane: steady
  pools already clear the ≥$100k entry-TVL band (zero disasters in our history) and carry
  enriched Safety 85–98, so the intel gate's rug-filter role is largely done; pool quality is
  then the LLM's flow-line judgment with the probe tier as the conviction-gap outlet. Under log
  mode a bar of 48 admits GTA6/Qenis/BULLSHIT/BUTTHOLE; 45 adds LAYOOO/MANLET; TOAD/STONK need
  ≤42. Not enabled — operator's call. While legacy, `[YIELD_WINDOW_SHADOW]` logs legacy→log
  per enriched-gate pool each cycle.

## 4d. First autonomous steady-lane deploy — GTA6-SOL post-mortem (2026-08-22)

Deployed 09:00:38Z (3.2 SOL bid_ask, 120 bins, active bin −1080 = top of range) as the first
admission under log-mode intel (61/65 Yield). **Zero fees, closed by the low-yield rule at 120
min (fee/TVL 0.00%), net ≈ −0.05% (gas only).** Bin path: −1080 at deploy → −1079 at 09:07Z
(OOR-above after 7 minutes) → never back below −1080 for the whole 2h (max 19 bins above).
Entry was a **+18.4% window move** (`entry_price_change_pct`, the field's first live record)
with volume +286% / traders +174% — a burst, not a steady hour. GTA6 was in the steady lane only
because its 1h fee/TVL (0.26–0.28) sat just under the 0.30 burst floor, and the candidate-block
line I added said "NOT mid-burst", which was wrong for boundary pools. Fixed: the line now states
the pool merely failed the burst floor and shows window vs own-hourly-avg fee velocity, plus a
new `pool_price_change:` line (Meteora window price change) in both candidate-block branches so
the ANTI-LVR judgment has the number in front of it. Lesson engine recorded "AVOID GTA6-type
(vol 5.49, bin_step 100) bid_ask — OOR 94% of the time". `rankSteadyMinIntel=42` set on the
operator's instruction (backup `user-config.json.bak.steadybar`).

## 5. Not built (needs data first)

- G5 enforce + intel re-baseline (scripts/safety_rebaseline.js exists).
- G7 in-place re-centre (plan #11 Phase 2).
- Low-yield 4h cooldown in pool-memory compares `close_reason === "low yield"` against a
  free-text reason ("Low yield: fee/TVL …") and never fires; the gas-negative extension covers
  the case today. Left as-is because the renewed-flow rule deliberately wants fee-death pools
  re-judgeable on live flow.
