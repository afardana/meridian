# Experiment registry

Meridian runs many rules in SHADOW: they stamp a would-fire verdict on each closed-position perf
record and change nothing. This directory holds one file per hypothesis, with the pass rule that
decides it. `scripts/experiments/grade.js` grades them against an export of the perf records.

## Process

1. **Hypothesis.** A claim about one rule ("re-entry 60–240 min after a win is a disaster bucket").
2. **Pass rule, registered before grading, with a date.** Written into `docs/experiments/<id>.md`
   (and, for rules shipped with a CLAUDE.md entry, quoted verbatim from it) before anyone cuts
   the data that will grade it. A rule written after seeing the data says so in its file and
   counts as weaker evidence (see `pump-gate.md`).
3. **Shadow capture.** The bot stamps the verdict on every perf record from the ship date. Only
   records carrying the field are graded.
4. **Daily grade.** `node scripts/experiments/grade.js --input <export> --config <modes.json>`
   on the operator's Mac, against an export (never the live DB). The verdict comes from the
   pre-registered rule only; the bootstrap CI, the robust re-run (largest record removed) and
   the decision-point view are context.
5. **Automatic promotion when `met`.** The operator pre-approved automatic promotion on
   2026-11-23, on three conditions: a config backup before the change, a Telegram notice, and
   an automatic revert check. Only an experiment with `action: promote` (met + enforce built +
   mode shadow) is promoted; `build_enforce` needs code first.
6. **Revert check.** For exit rules, once promoted: closes made BY the rule (its exit family)
   after the promotion with a scored `post_close.exit_quality`; with n ≥ 8, early exits
   outnumbering good exits → revert. Entry gates cannot be graded from records once enforced
   (the blocked deploys never happen) — they need the rejected-candidates counterfactual.
   CLI: `--promoted <id>=<ISO>`.
7. **Verdict logged** in the experiment's "Grading log".

### Guards on the automatic path

- **Promotion guard.** `promote` needs more than `met`: the robust re-run (largest record
  removed) must pass every check too. A rule that is `met` but fails the robust re-run gets
  `escalate` — the operator decides, nothing is changed.
- **Recorded decisions.** `scripts/experiments/decisions.json` lists experiments that are
  finished (`dropped`, `closed_not_met`, `promoted`, `reverted`) with the date and the numbers.
  A listed experiment's action is `none` whatever later data says; re-opening one needs a new
  registration (new file section, new date, new pass rule).
- **A dropped shadow may keep running as capture.** "Drop" means never enforce. The config key
  stays at `shadow` when the shadow costs nothing and its capture feeds other analysis (the pump
  gate's candle fetch feeds the entry-range fields); it is set to `off` only when it has a cost.
- **How a promotion is made.** Config backup in `/home/angga/meridian-config-backups/`, one key
  changed in prod `user-config.json`, no close / swap / deploy / straddle in flight, restart as
  `angga`, verify the mode in the log, Telegram notice, entry in `decisions.json` and in the
  experiment's grading log. A revert is the same steps back to `shadow`.

### Daily run and the board

- `scripts/experiments/export.sh` — read-only export of the perf records and the rule-mode keys
  of prod `user-config.json` (no secrets) into `.experiments/status/` (gitignored).
- `node scripts/experiments/grade.js --input .experiments/status/performance.json --config .experiments/status/modes.json`
- `.experiments/BOARD.md` (local, gitignored) is the two-way file: the grading session appends a
  dated log entry per run; the operator writes `hold <id>`, `revert <id>` or `pause` in its
  inbox. Those three only ever reduce what the bot does and are always honoured. Anything that
  adds or enables behaviour is answered in the log and must be asked for in the session itself.

A new hypothesis needs a file here **before any data is cut** for it.

### Re-evaluation schedule (2026-11-25, operator request)

Every open experiment has a row in `scripts/experiments/schedule.json`: what produces its numbers
(`by`: grader | records | replay | report), how stale they may get (`recheck_days`), the sample
arm of its pass rule (`need`), the date that forces a verdict (`time_arm`) or, where the rule has
none, the date its count is put in front of the operator (`report_by`).

- **Daily** (session cron, ≈ 08:53 WIB, the operator's main session): export → grade → act on
  `action_list` → post-mortems → `node scripts/experiments/scoreboard.js --out .experiments/SCOREBOARD.md`
  → board entry. The only run allowed to promote or revert.
- **Weekly** (durable scheduled task `meridian-experiments-weekly`, Monday ≈ 09:15 WIB, a fresh
  session, report only): export → grade → scoreboard → re-run every `records` / `replay`
  experiment flagged DUE or STALE and log it in that file's grading log and in
  `.experiments/status/replay-runs.json` → board entry → Telegram digest. It also reports when
  the daily loop has left no board entry for 2 days.
- **Scoreboard** (`scripts/experiments/scoreboard.js`, `test/experiment-scoreboard.test.js`): per
  open experiment n / need, the change over 7 days, pace and ETA, the next decision date, and a
  DUE / STALE flag; plus the objective block (bot vs operator closes, net SOL, win rate, share at
  ≤ −10 %, over 7 and 30 days) so a frozen population is visible.
- **Board publisher** (`scripts/experiments/publish.js`, PM2 cron `meridian-experiments-publisher` on the VM, hourly at :37):
  grades and builds the board, writes the one kv row `experiments-board`, read-only otherwise; the dashboard's Experiments section renders it.

| id | by | next decision |
|---|---|---|
| max-hold | grader, daily | 30 affected closes or 2026-12-19 (time arm → automatic promotion if every check and the robust re-run pass) |
| trail-straddle-trigger | grader, daily | 30 straddled trailing closes; count reported 2026-12-31 |
| grace-profit-lock | grader, daily | 15 forward fires; count reported 2027-01-31 |
| reading-guard | grader, daily | 12 episodes on 6 positions or 2027-01-06 |
| flow-guard | grader, daily | 15 shadow would-fires; 2027-02-25 without them → closed insufficient |
| grace-backstop-stop | records, weekly | 12 records and 6 fires; count reported 2027-01-31 |
| trailing-threshold | replay, every 14 days | 2 / 1.0 applied in prod 2026-11-25; revert check on 2026-12-09 or at 20 bot trailing-TP closes since the change, whichever first (revert is the operator's decision) |
| hold-stop-25 | replay, every 14 days | 10 forward fires on held positions the live thin-pool limit does not cover (holds started ≥ 2026-11-26); count reported 2027-02-28 |
| fresh-top-lane | replay (`scripts/experiments/fresh_lane_sim.js`), daily; n = ENDED paper entries counted from `lane_paper_trades` | 40 ended paper entries over ≥ 14 days, or 60 days from the first capture day (2027-01-26 if capture starts 2026-11-27) → drop without 40; met → proposal to the operator |
| tvl-relative-exit | grader, daily | 21 days AND 10 positions where the relative and the fixed TVL exit disagree, or 2027-02-25 (90 days); `met` → proposal to the operator |

## Verdicts and actions

| verdict | meaning |
|---|---|
| `met` | sample/time threshold reached and every check passes |
| `not_met` | threshold reached, a check fails; the rule has no drop clause → do not enforce (a later `met` on more data is a second look and needs a new registration) |
| `drop` | threshold reached, a check fails, and the rule says "otherwise drop" (or the drop point is passed) |
| `insufficient` | threshold not reached; the reason says how many more closes / until when |
| `report_only` | descriptive statistics only (no pass rule or no promotion path) |
| `already_enforced` | the effective mode is enforce |

| action | when |
|---|---|
| `promote` | met + enforce built + mode shadow |
| `build_enforce` | met but no enforce path exists |
| `drop` | verdict drop (set the mode to off) |
| `wait` | insufficient |
| `none` | everything else |

## Status (grader run 2026-11-23T01:20Z on the 1,455-record export of 2026-11-23)

Prod config: `postStopCooldownMode=enforce`, `crashRegimeMode=enforce`, `harvestStraddleMode=enforce`;
every other mode key below is absent → code default.

| id | mode | n tagged / need | key numbers | verdict | action |
|---|---|---|---|---|---|
| [reentry-gate](reentry-gate.md) | shadow | 21 / 20 or 21 d | ≤ −10 %: 1/21 (4.8 %) vs 36/326 (11.0 %), ×0.43; Σ net ◎+1.6356 | drop | drop |
| [fee-edge](fee-edge.md) | shadow | 114 / 30 | ≤ −10 %: 14/114 (12.3 %) vs 19/182 (10.4 %), ×1.18; Σ net ◎−0.3084 | not_met | none |
| [first-entry-probation](first-entry-probation.md) | shadow | 3 / 15 or 21 d | Σ net ◎−0.0111 on ◎1.35 = −0.82 %; winners 2/3 | not_met | none |
| [max-hold](max-hold.md) | shadow | 19 / 30 or 42 d | T=360: Σ Δ ◎+0.2968, w/o largest ◎+0.2285, 10/7, all five checks pass | insufficient (until 2026-12-19) | wait |
| [trail-straddle-trigger](trail-straddle-trigger.md) | shadow (3 %) | 10 / ~30 | would_hold 2, same 8; probe + 1/2; "the gain" not computable | insufficient | wait |
| [pump-gate](pump-gate.md) | shadow | 72 / 20 (drop at 40) | ≤ −10 %: 9/72 (12.5 %) vs 29/289 (10.0 %), ×1.25; Σ net ◎+2.6494 | drop | drop |
| [grace-shadow](grace-shadow.md) | shadow | — | straddle: 17 fires, Σ (pnl − no-grace fire) −54.44 pp; adoption: 2 fires, −27.08 pp | report_only | none |
| [grace-early-release](grace-early-release.md) | shadow | — | 16 would-release; final − at-release Σ +28.29 pp (10 above / 6 below) | report_only | none |
| [hold-downside](hold-downside.md) | shadow | — | 0 records (not written to perf records) | report_only | none |
| [straddle-trend-ceiling](straddle-trend-ceiling.md) | shadow | — | 31 flagged; 16 straddled anyway: Σ ◎+1.1933, 1 at ≤ −10 % | report_only | none |
| [post-stop-cooldown](post-stop-cooldown.md) | enforce | — | 0 would-skips on 43 bot records before enforce | already_enforced | none |
| [bidask-flip](bidask-flip.md) | none (replay only) | 201 flipped / 30 | N=15: Σ Δ ◎+0.1831 (CI −0.07 … +0.46), better/worse 67/90, halves −0.04 / +0.22, fee-robust ◎−1.23 | not_met | none |

| [grace-profit-lock](grace-profit-lock.md) | shadow (forward capture since 2026-11-24) | 0 forward fires / 15 | replay (not counted): A = 10, D = 5 over 205 graces, 14 fires, Σ Δ ◎+0.3349 (CI +0.02 … +0.66), 10 / 4; forward rule registered 2026-11-24, bot + operator pooled | insufficient | wait |
| [grace-backstop-stop](grace-backstop-stop.md) | none (records: `grace_stop_paused`) | 6 / 12 (3 fires / 6) | registered 2026-11-24: backstop −20 % inside the grace vs paused vs −15 % active; INVERSE-SOL (+16.74 % after a held-back −15.26 %) was missed at registration | insufficient | wait |
| [unchanged-bin-drop-guard](unchanged-bin-drop-guard.md) | none (event study only) | 1 / 20 events | 10-05 → 11-24, 399 positions: 3 raw events at X = 3, 1 after exclusions (reverted in 36 s, fees claimed outside the bot); 0 closes fired on one | insufficient (closed 2026-11-24) | none |
| reading-guard | shadow (capture since 2026-11-25) | 0 / 12 episodes | log-only capture of PnL readings the price move cannot explain on non-held positions; pass rule in its file | insufficient | wait |
| [flow-guard](flow-guard.md) | shadow (capture since 2026-11-27) | 0 / 15 would-fires | default flow thresholds (sell pressure + falling price, liquidity pull, holder exodus; 3 readings over ≥ 6 min, second source agreeing) on positions the operator did not arm; the operator-armed guard itself is live per position; thresholds are judgement (no flow history existed — every reading stored from 2026-11-27) | insufficient | wait |
| [trailing-threshold](trailing-threshold.md) | none (replay only; prod drop 1.0 since 2026-11-25) | 70 differ / 30 | V9 2 / 1.0: Σ Δ ◎+0.172, CI +0.088 … +0.258, 62 / 8; V0 no trailing ◎−4.80; reproduction 94.6 % with imposed closes, 63.8 % literal | met (with deviation D1/D2) → operator approved; prod `trailingDropPct` 1.0 since 2026-11-25 (trigger 2) | revert check: 14 days (2026-12-09) or 20 bot trailing-TP closes since the change |
| [managed-hold-trailing](managed-hold-trailing.md) | none (replay only) | 44 fires / 15 | 15 / 7.5 + stop −15 over 65 held positions: Σ Δ ◎−1.0987 (◎+1.2880 without CRAWL-SOL 69F2FsPS −2.3866), 22 / 22, halves −1.2213 / +0.1227; checks 2, 4, 5, 6 fail | not_met | none |
| [hold-age-alert](hold-age-alert.md) | none (event study only) | 32 / 15 | final below the event figure in 18 of 32 (56 %, need 60 %); Σ (event − final) ◎−0.6505 (◎+2.0111 without CRAWL-SOL 69F2FsPS); median Δ ◎−0.0551 | not_met | none |
| [hybrid-shape](hybrid-shape.md) | none (replay only) | 332 / 100 positions | registered 2026-11-25 (HawkFi "Precision Hybrid" post), replayed the same day: 50 / 50 Σ Δ ◎+0.130 (CI −0.099 … +0.379), better / worse 77 / 176, halves −0.072 / +0.202; capital +1.14 vs fees −1.06; stop-class +0.50, rest −0.37; exit paths differ on 155 positions; related rejections: bid-ask flip, roll-up / re-centre, two-sided first deploy | not_met | none |
| [hold-stop-25](hold-stop-25.md) | none (forward replay only) | 0 / 10 forward fires | registered 2026-11-25: the thin-pool hold limit's −25 % proof without its TVL bar, on holds started ≥ 2026-11-26 that the live limit does not cover; seen-data context (not counted): of the replay's +◎2.70 over 30 fires, entry TVL < $100k +◎3.50 (15), ≥ $100k −◎0.55 (13), unknown −◎0.25 (2) | registered | wait |
| [fresh-top-lane](fresh-top-lane.md) | shadow (paper capture since the deploy; plan 16 Phase 1) | 0 / 40 ended paper entries (≥ 14 days) | registered 2026-11-27 before capture: paper entries at rank ≤ 5 on Meteora's 2h Top Performers list, token ≤ 24 h, active TVL ≥ $10K, mcap ≥ $100K, holders ≥ 500, authorities off, no transfer fee / hook, token fees ≥ 30 SOL; simulated two-sided ±34 spot, stop −10 / trailing 3 / 1.5 / box 120 min / TVL < $10K; fees estimated, halved-fee stress in the rule; context (seen, not counted): operator's fresh thin entries −◎4.57 over 80 since 09-26 | registered | wait |
| [tvl-relative-exit](tvl-relative-exit.md) | shadow (capture since 2026-11-27) | 0 / 10 disagreements (and ≥ 21 days) | registered 2026-11-27: pool TVL < $10K AND ≤ 50 % of the position's TVL reference (entry or peak, own value subtracted), 3 readings over ≥ 30 min, on-chain confirmed, vs the fixed $10K exit; exploratory study (52 small-pool positions): 9 of 16 collapses caught with 3 other fires vs 16 / 30 for the fixed rule; bot + operator pooled | insufficient | wait |

The three rows registered 2026-11-24 come from the review of the operator's manual positions
(178 since 09-26). `grace-profit-lock` has a forward shadow capture since 2026-11-24 and is in
`scripts/experiments/definitions.js` (population `bot_and_operator`; a `met` gives
`build_enforce`, never `promote`); the other two are not: one needs the tick history, and the
backstop stop is graded by hand from the export until it has enough records.

**Data caveat for every row:** the export has no bot close after 2026-11-13T04:42Z (only seven
operator closes on 11-22/23), so every bot population has been frozen for 10 days.

## Rejected — do not re-test without new evidence

| idea | date | evidence |
|---|---|---|
| Peak-crash exit | 2026-09-25 | fires 4× in 30 d (0× on bot deploys ahead of trailing); best variant +0.21 SOL / 30 d with more truncations than saves |
| Slow-bleed exit | 2026-09-25 | fires 2× in 30 d, both on positions that recovered; reaches none of the 37 disasters (they are fast, < 7 h) |
| Tighter stops (−6 … −12 %) | 2026-09-25 | net negative on 380 scored closes; −15 % stays |
| Bin-estimated trailing trigger | 2026-09-29 | 381-close stack replay: every variant net ≤ 0; 43 live trailing closes: +0.5 pp on 22 but 8 closed on earlier wicks (−14.9 pp) |
| Fee-acceleration entry filter | 2026-10-04 | decelerating 128 deploys +0.24 % / 12 % disasters vs accelerating 182 −0.31 % / 8 %; non-monotone, sign flips by period (339-deploy re-run: same verdict) |
| Downtrend (falling-token) entry gate | 2026-09-29 | 24h ≤ −30 %: +0.04 SOL, 12 winners lost — noise |
| Pump gate extended to young pools (≤ 24 h run-up) | 2026-10-02 | run-up ≥ +300 %: 40 deploys, +1.92 %, 78 % wins, 0 disasters — it would skip the best deploys |
| Loss floor on held positions | 2026-10-02 | 58 held positions: actual −0.17 SOL; −20 % floor −0.26, −30 % −0.89 (half the breaches recovered); a forward-only second look at −25 % on held positions the thin-pool limit does not cover is registered as [hold-stop-25](hold-stop-25.md) (2026-11-25) — the rejection stands until it is graded |
| Trailing on held positions | 2026-10-02 | arm 10–20 % all worse; arm 30 / drop 15 better on only 10 fires; second look 2026-11-25 on capital-basis paths: 15 / 7.5 + stop −15 over 65 positions Σ −◎1.10 (one +65 % recovery, CRAWL, carries −◎2.39), 22 / 22, first half negative ([managed-hold-trailing](managed-hold-trailing.md)) |
| Hold-age alert (pool-age-scaled T of 6 / 24 / 48 h) | 2026-11-25 | 32 events: final below the event figure in 56 % (need 60 %), Σ (event − final) −◎0.65 ([hold-age-alert](hold-age-alert.md)) |
| Two-sided first deploy as the default | 2026-10-02 | −3.5 … −4.9 SOL over 182 deploys (memory: two-sided entry replay) |
| Rapid re-entry cooldown | 2026-07-29 (reverted), removed 2026-09-25 | no penalty for rapid re-entry (the apparent one was a June artifact); blocks cost idle SOL |
| Roll-up / re-centre engine | 2026-09-25 | −4 SOL live, ≈ break-even under gates; re-centring at the top is LVR (≈ 3 % on a 20-bin retrace) |
| Bid-ask flip on the current exit stack (re-shape converted bins as top-heavy asks every 10–20 bins down, close time unchanged) | 2026-11-23 | 361-position bin-level replay: capital ◎+0.85 vs fees ◎−0.59 → Σ ◎+0.18 (90 % CI −0.07 … +0.46), 67 better / 90 worse, first half negative ([bidask-flip](bidask-flip.md)) |
| Hybrid initial shape (50 % spot + 50 % bid-ask on the same single-sided range; also 30/70, 70/30, 100 % bid-ask, 100 % curve) | 2026-11-25 | 332-position bin-level replay, close times fixed: 50 / 50 Σ ◎+0.13 (90 % CI −0.10 … +0.38), 77 better / 176 worse, first half negative; capital +1.14 vs fees −1.06 — a smaller position near the price bought with fee income; no mix separates from zero ([hybrid-shape](hybrid-shape.md); HawkFi post assessment in docs/research) |
| Dip entry (deploy after a 0.382–0.786 retracement of the 24 h leg; X post "Dip Hunter Strategy") | 2026-11-27 | 353 bot deploys since 10-02: zone 134 mean −0.21 % vs rest 219 −0.03 % (difference −0.18 pp, 90 % CI −1.65 … +1.25), disasters 11.2 % vs 10.0 %, sign flips between halves; entries nearest the high did best (+1.13 %), nearest the low worst (−1.07 %). Entry timing only — narrow width and a pre-placed range are untested ([dip-entry-retracement](dip-entry-retracement.md)) |
| Removing trailing / wider trailing (3 / 1.5 … 15 / 7.5, proportional drop, net-cost gate) | 2026-11-25 | 260 bot positions with paths extended past the live close: no trailing −◎4.80 (35 / 55), 5 / 2.5 −◎2.39, 10 / 5 −◎4.42; released positions mostly ran into the −15 % stop ([trailing-threshold](trailing-threshold.md)) |
| Sub-1 % frozen harvest | 2026-11-08 | studied, leave as is (evidence figure not recorded in CLAUDE.md) |
| Probation stop on re-entries | 2026-10-17 | would have cut CRAWL (+66 %) and HIGGS: −◎2.5 |
| Max hold under 240 min / naive best-T evolver | 2026-11-07 | every T < 240 negative; a best-of-40 evolver lost out of sample |
| Post-stop cooldown 48 h | 2026-11-08 | fails on one +66 % outlier (CRAWL-SOL) |
| Early grace release as a rule | 2026-10-11 | 76 graces: fixed 60 min +2.01 SOL vs early release −0.28 |
| Shorter straddle grace (15 / 30 min, harvest − K floor) | 2026-10-03 | 60 min +0.135 SOL vs 30 min +0.096, 15 min +0.075, no grace +0.098 |
| Straddle trend gate as a predictor | 2026-10-03 | price up 2 h later after only 8 of 22 passes (avg −0.2 %) |
| Bear-case debate veto | 2026-07-27, removed 2026-09-25 | veto on 78/78 calls, including both of the day's winners |
| Breakeven profit ratchet | 2026-07-27, removed 2026-09-25 | byte-identical to no ratchet at trailing 2/1.5 |
| Adaptive (vol-scaled) trailing | removed 2026-09-25 | trigger pinned at 8 %, 0 trailing exits in 4 days |
| Surge-decay exit | OFF 2026-09-25 | 26 closes netted +0.012 SOL at a 35-min average hold; closes ladders as the oscillation regime begins |

## Ungraded — no gradable capture

| rule | key | what capture is needed |
|---|---|---|
| Close-efficiency gate | `closeEffGateEnabled` | `[CLOSE_EFF_SHADOW] would-defer` is log only — a `close_eff_shadow` stamp (first would-defer: at, gross pnl, estimated net, threshold) on the record |
| TWAP wick guard | `twapGuardEnabled` | only a deferral counter reaches the record — the would-defer reading and the pnl one deferral later |
| Swap slippage cap | `swapSlippageCapEnabled` | `[SLIPPAGE_CAP_SHADOW]` is log only — the cap that would have applied + realized slippage bps on `exit_swap` |
| Crash-regime below half | `crashRegimeBelowMode` | `[CRASH_REGIME_SHADOW]` is log only — a `crash_regime_below_shadow` stamp (first would-close: at, pnl, bins below) |
| Adoption-PnL shadow | `adoptionPnlShadowMode` | `adoption_pnl_shadow` is captured (null on all 215 carrying records) but records a divergence, not an outcome — needs a pass rule and the counterfactual exit |
| Hold downside (listed above as report-only) | `holdDownsideMode` | `hold_downside_shadow` lives on the position only; perf-record.js does not copy it |

## Files

- `scripts/experiments/definitions.js` — the experiments (rule text, thresholds, fields)
- `scripts/experiments/lib.js` — pure graders, bootstrap, revert check, human formatter
- `scripts/experiments/grade.js` — CLI
- `test/experiment-grader.test.js`
- `.experiments/` (gitignored) — local board and daily status

Note: `docs/` is in `.gitignore`; files here are committed with `git add -f` like `docs/plans/`.
