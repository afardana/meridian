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

## 5. Not built (needs data first)

- G5 enforce + intel re-baseline (scripts/safety_rebaseline.js exists).
- G7 in-place re-centre (plan #11 Phase 2).
- Low-yield 4h cooldown in pool-memory compares `close_reason === "low yield"` against a
  free-text reason ("Low yield: fee/TVL …") and never fires; the gas-negative extension covers
  the case today. Left as-is because the renewed-flow rule deliberately wants fee-death pools
  re-judgeable on live flow.
