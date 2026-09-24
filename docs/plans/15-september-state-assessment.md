# Plan 15 — State assessment after the Aug 22 → Sep 21 change wave

Status: ASSESSMENT (2026-09-24). No code or config changed by this document. Read-only audit of
92 commits (8a1d72b..4333b44), the prod config, 14 days of logs, and the outcome record.

## 1. Where the money went (SOL basis, balance_history + baseline ledger)

| | SOL |
|---|---|
| AUM 2026-08-22 11:00Z → 2026-09-24 01:45Z | 11.865 → 2.209 (**−9.656**) |
| Operator withdrawals (14, on-chain classified, each matched to a balance step) | −8.910 |
| Operator deposits (2) | +1.752 |
| **Book result net of flows** | **−2.498** |
| of which unrealized on the 4 open (all HOLD) positions | −3.35 |
| ⇒ realized all-in over the window (incl. gas −0.11, exit slippage −2.79) | ≈ +0.85 |
| Perf ledger's own claim for the same closes (Σ pnl_sol, 433 records) | **+8.52** |

The ledger overstates realized by ≈ 4.8 SOL (all-in) — the fee term (Σ fees_sol_true 39 SOL) sits
mostly on adopted / rebalance-lineage records (n=310, +9.9 SOL) that credit lifetime indexer fees
per lineage; bot-originated closes are n=123, −1.37 SOL. Exit-swap slippage (−2.79 SOL) is never
part of pnl_sol. 09-13+ "true-USD era" records mix units again. **Consequence: evolution, lessons,
briefings and the dashboard graded a losing month as +8.5 SOL** — evolution lowered minIntelScore
61 → 52 on 09-23 on that basis.

Pionex auto-skimmer: enabled in prod since 09-20, requireTelegramConfirmation=false, **never
transferred** (289 × "skipped: agent busy"; the `*/5` cron collides with the 3-min mgmt cycle +
its immediate screening retrigger). All outflows above were the operator's.

## 2. What the exit stack did (433 closes since 08-22)

| Family | n | avg % | Σ SOL | win |
|---|---|---|---|---|
| trailing TP | 103 | +4.10 | **+7.94** | 97% |
| manual (/close, dashboard, menu) | 108 | +1.91 | +6.43 | 75% |
| round-trip harvest (plan #11/#12) | 75 | +3.51 | +3.02 | 97% |
| external close (reconciliation) | 25 | +4.65 | +2.69 | 64% |
| profit ratchet | 28 | −0.01 | −0.24 | 57% |
| fee-death / low-yield | 29 | −0.04 | −0.02 | 52% |
| OOR below | 8 | −8.67 | −1.59 | 0% |
| crash / rug fast-path | 15 | −21.65 | **−4.68** | 0% |
| stop loss (+young stop) | 25 | −13.30 | **−6.12** | 0% |

Rebalance/roll-up engine (live 09-13): 33 chains, realized −0.63 SOL, plus all 4 open chains
(baton rb=3 −0.99, wifout rb=4 −0.51, KNOB×2 −1.27/−0.58) ⇒ **≈ −4.0 SOL net**. Worst chains:
MCAT −1.05 (rb=3, crash-below), JEANPHIL −0.63 (rb=4), KEVIN −0.48, PAID −0.41. 11 of the 15 worst
closes are operator-adopted/manual positions. Hold cohort (44 held positions closed since 09-01):
avg +4.87%, +2.36 SOL, range −65…+66% — hold has paid in aggregate; the current four are its tail.

Since the 09-21 deploy (4333b44): **0 trailing-TP exits in 4 days** (3–4/day before). The
volatility-adaptive trailing trigger `clamp(1.5·vol, 8, 25)` pins at 8% on Meteora's 0–5 vol
scale, silently replacing the replay-tuned 2/1.5 (CLAUDE.md 07-27: tighter won every axis).

## 3. Gaps to the ideal implementation, ranked

1. **Accounting truth.** Wallet-truth reconciliation (AUM − flows) must be the ground truth the
   learning engine and briefings are graded against; per-leg perf records for rebalance closes;
   exit slippage inside realized PnL; one unit per field. Until then freeze `evolveThresholds`
   (it is acting on a +8.5 SOL fiction) and restore `minIntelScore` 61.
2. **Exit stack regressed without evidence.** Adaptive trailing (no flag, no replay), stopLossPct
   −15 → −18, ratchet arm 2 → 6, `outOfRangeWaitMinutesAbove/Below = null` (OOR auto-close and
   OOR alerts OFF both directions; OOR-below now only handled by the rebalance path). Ideal:
   revert to the replay-backed 2/1.5 + ratchet 2/−2, put adaptive trailing behind a shadow flag,
   and re-run scripts/replay on the Sep paths before any of it goes live again.
3. **Rebalance/roll-up engine shipped ON and outside the safety gates.** `rebalance_position` has
   no executor safety case (no TVL/intel/tx/velocity gates, no computeDeployAmount); it re-deposits
   the *wallet-wide* base + SOL balance (capped to root basis only when resolvable); a failure
   between close and re-deploy leaves an untracked base bag; roll-up re-enters at the local top
   with the anti-LVR cooldown removed (4d689df); `rebalance_count` 3–4 exists vs `rebalanceMaxCount`
   2. Net −4.0 SOL. Ideal: shadow-first (`[REBALANCE_SHADOW]`), route the re-deploy leg through
   `runSafetyChecks("deploy_position")`, size from the closed leg's proceeds only, perf record per
   leg, restore the anti-LVR cooldown for roll-ups.
4. **Top Performers ingestion bypasses the 100k entry-TVL floor** (down to 15k, both mirrors,
   before hasCleanPoolHistory, no scout clamp, +15 admission, skips dump-play guard). This
   contradicts the strongest discriminator in the dataset (60–100k = worst band). Ideal: route
   through the scout tier (size-capped) or the clean-history exemption, never full size.
5. **Hold mode vs the position cap.** `maxPositionsExcludeHold=true` lets the screener count
   held positions as free slots while the executor still counts them → 11 days (09-12→22) with
   zero autonomous deploys and 187 "Max positions reached" blocks; on 09-14 nine positions were
   held at once. Ideal: one shared count; a hold budget (SOL, not slots); a scheduled hold
   re-review with the honest unrealized number in front of the operator.
6. **Skimmer safety rails don't work as written.** `requireTelegramConfirmation` is read nowhere;
   equity uses a non-existent `positionsValueSol` (free SOL only); cooldown + daily cap are
   in-memory (reset on every PM2 restart); target/enabled are `update_config` keys reachable by
   the GENERAL-role LLM; `skim:now` has no confirm. It has never fired, but the design is armed.
   Ideal: OFF until the confirmation gate is real and the cap is persisted (baseline ledger).
7. **Latent crash of the same class that took 70 mgmt cycles on 09-21.** `index.js:3116` reads
   `maxRebalances` from a sibling block scope — the first confirmed non-crash OOR-below close
   signal with rebalanceEnabled throws and aborts the whole poller tick. Also live: 361 "report
   publish failed (Cannot read 'positions')" 09-20→23, 142 Telegram "Unclosed start tag".
8. **Plan #12 steady lane is dead under the new rank hard gates.** `minTxPerMin 5` and
   `minVolumeTvlRatio 0.05` apply to every survivor at the 1h/5m timeframe with no lane waiver
   (only the fee-ratio check has one) — MANLET/TOAD-class pools cannot pass. Ideal: mirror the
   24h waiver for the steady lane, or drop the lane.
9. **RPC.** Closes now send through whichever pooled endpoint answered `getPool` (may be the
   public mainnet node; Helius rebate lost; "No standard RPC endpoints available" has no
   RPC_URL fallback → 30s–5min close backoff); Helius monthly credits exhausted on one key
   09-20→22; PnL socket now burns the primary key. Ideal: sends always via RPC_URL (reads via
   the pool), quota state persisted, per-key budgets.
10. **Ops hygiene.** `gasReserve` 0.3 → 0.05 while exit priority fees can cost 0.004/tx;
    `maxBinsBelow=90` silently clamped to 69; test suite run inside /opt/meridian wrote
    `state.json`/`lessons.json`/`rejected-candidates.json` + `TEST_*` lines into prod logs; all
    `user-config.json.bak.*` deleted; an unexplained 897-restart storm 09-12 12:51 → 09-13 21:07
    after a manual `apt upgrade`; dashboard restarted hourly by cron; CLAUDE.md drift (512M vs 2G).

## 3.1 Item 1 — accounting truth — BUILT 2026-09-24

Root cause pinned: 44 perf records whose Meteora lifetime deposits are ≥2× the tracked
amount (operator accounts adopted mid-life, e.g. OTC-SOL 15.19 SOL lifetime deposits)
carry **+7.66 of the ledger's +8.52 SOL** — the close paths recorded Meteora's *lifetime*
`withdrawals + fees − deposits`, i.e. PnL the account made before the bot managed it (and
before the window). Built:

| Piece | Where | Effect |
|---|---|---|
| `adoption_basis` snapshot + `applyAdoptionBasis()` | state.js, tools/pnl.js (`lifetime_*` raw fields), tools/dlmm.js (3 close paths) | adopted accounts scored from adoption onward; `adoption_lifetime` kept for audit; `[ADOPTION_BASIS]` log |
| `pnl_sol_net` + `unit_era: "v3"` | lessons.js (recordPerformance, recordExitSwapOutcome) | all-in SOL per record (gas + exit slippage); units declared per record |
| rebalance-leg perf record | tools/dlmm.js `recordRebalanceLegPerformance` | every closed leg of a chain is now a record (`rebalance_leg`, `rebalanced_into`) |
| `ledger-truth.js` + cron `11 */4 * * *` + briefing line + report field + `scripts/ledger_truth_audit.js` | new | book vs ledger vs Δunrealized, drift as a standing number |
| `evolutionEnabled` (prod false), `minIntelScore` 52 → 61 | config.js, lessons.js, prod user-config | evolution frozen until 7d drift ≤ ±0.2 SOL |

Not changed: historical records (no rewrite — the audit script quantifies the legacy drift
instead); the per-field unit refactor (v3 stamp is the migration hook).

## 3.2 Item 2 — exit stack — BUILT 2026-09-24

The 4333b44 changes were made without a flag or a replay: `resolveDynamicTrailingParams` pins
the trailing trigger at clamp(1.5·vol, 8, 25) = 8% on Meteora's 0–5 vol scale (0 trailing exits
in the 4 days after deploy vs 3–4/day before, on the book's largest profit centre), the
inventory-exhaustion ratchet tightens drop/floor with no evidence, and prod config moved
stopLoss −15→−18, ratchet arm 2→6 / stop −2→+1.5, trailing 2/1.2→10/2, OOR auto-close off both
directions. Built: `adaptiveTrailingMode` + `inventoryExhaustionMode` (management,
"shadow" default | "enforce"); in shadow the static replay-backed params govern and
`[ADAPTIVE_TRAILING_SHADOW]` / `[INVENTORY_EXHAUSTION_SHADOW]` log where the 4333b44 logic would
have differed. Prod restored to the 2026-07-27 replay winners: trailing **2 / 1.5**, ratchet
**arm 2 / stop −2**, stop-loss **−15**, `outOfRangeWaitMinutesAbove` **720** / `Below` **60**
(OOR auto-close + alerts back on; OOR-below closes therefore no longer route only through the
rebalance engine). Re-run of scripts/replay on the Sep paths recorded in §3.2a below.

### 3.2a Replay re-run on the Sep paths (2026-09-24, read-only, `/tmp/meridian-replay-20260924` on the VM)

Coverage: 800 closes (609 with series, 593 with bins); ≥08-22 subset 440 (354 usable).
Limits that matter: the grids are hard-coded — trigger ∈ {2, 2.5, 3, 4} × drop ∈ {0.75, 1, 1.5},
stop ∈ {−15, −25, …}, ratchet arm ∈ {1.5, 2, 2.5} × stop ∈ {0…−3} — so **8–10% triggers, −18
stop and arm 6 / stop +1.5 are not expressible**; the composite baseline is still the 07-08
`LIVE 3/1`. Findings (hi-confidence columns, Δ = variant − actual):
- Trailing: **every cell negative in both windows** (2/1.5 full −1.80 mean / −0.29 median, subset
  −3.90 / −0.69). Not a mark bias (median actual − last-snap mark = 0.00). The ≥08-22 actuals
  are dominated by rules the composite doesn't model (93 manual, 67 round-trip harvest, 24
  external, 22 ratchet vs 72 trailing), so these Δs measure "mechanical rule vs operator +
  harvest reality", not rule vs rule. Least-bad cells are the **tightest drops** (2/0.75, 4/0.75);
  2/1.5 is the worst drop at every trigger. The July "2/1.5 wins" ordering does not reproduce.
- Stop-loss: monotone — −15 best (full −5.32 mean / +0.42 median on the stopped population);
  −25 costs a further −11…−14 pts. −18 not measurable; direction only.
- OOR-below wait: 63–90 min lead (+5.3…+5.9 mean vs the 180 reference; n 18–19); live 60 is fine.
- Ratchet: every cell below the no-ratchet reference (−0.5…−1.8 incremental) — inert/neutral,
  as in July. Crash variants: nHi = 0 (never high-confidence).
- Conclusion: the revert to 2/1.5 is supported by the July replay + the zero-trailing-exits
  observation under the 8% pin, **not** by this re-run, which cannot rank the two. Next
  calibration step is a rule-vs-rule grid (needs the harness's `LIVE` block + grids extended
  to 8–25% triggers and the harvest/manual exits modelled) before any trailing change beyond
  the revert; the tighter-drop signal (0.75–1.0pp) is the candidate worth testing there.

## 3.3 Item 3 — rebalance / roll-up engine — BUILT 2026-09-24

`rebalanceMode` (management, "shadow" default | "enforce"): all four decision points (mgmt
round-trip roll-up, mgmt OOR-below rebalance, poller roll-up, poller OOR-below deferral) evaluate
and log `[REBALANCE_SHADOW]` but take the ordinary close/flip path in shadow — including no
`STAY`-while-waiting-for-trend (a shadow must never hold a position the exit stack would close).
Executor: new `rebalance_position` safety case re-validates the pool with
`validateDeployPoolThresholds` (TVL/fee/volatility/bin-step, the same gate a deploy passes) and
hard-caps chain depth at `rebalanceMaxCount` (operator `/rebalance` skips only the depth cap).
`rebalancePosition` now sizes the re-deposit **proceeds-only**: wallet SOL/base snapshot before
the close, re-deposit = min(free, what the leg returned, root basis) and only the base tokens the
close returned — and refuses *before closing anything* when no capital basis exists (the old
code fell back to the whole wallet). Latent `maxRebalances` ReferenceError in the poller
OOR-below branch fixed (block-scoped declaration). Roll-up anti-LVR cooldown: not restored —
moot in shadow; to be reconsidered with the rule-vs-rule replay before any enforce.

## 3.4 Items 4–5 — BUILT 2026-09-24

- **Top Performers → scout-capped.** A sub-floor Top Performer is still admitted for judgment
  (trend gate unchanged) but tagged `_scoutTier` unless the pool has clean history; the
  executor no longer has a full-size TVL bypass for it — it falls through to the
  clean-history exemption or the scout clamp (`scoutSizeSol`, `scoutMaxPositions`), and is
  blocked when `scoutTierEnabled=false`.
- **Hold vs cap unified.** `maxPositionsExcludeHold` code default true → **false**, prod false:
  held positions count against `maxPositions` in the screener exactly as the executor already
  counted them. With 4 held of 5 that leaves one autonomous slot — the honest number.
- **Skimmer.** Prod `autoSkim.enabled=false`. Rails fixed for whenever it is re-enabled:
  `requireTelegramConfirmation` (now default **true**) is honoured — the cron proposes via
  Telegram (≤1/6h) and never signs; `/skim now` is the confirmation. Equity uses
  `deployed_sol` (the field `positionsValueSol` never existed). The 24h cap is floored with the
  persisted baseline withdrawals so a PM2 restart cannot reset it.
- **Steady-lane velocity waiver.** `minVolumeTvlRatio` / `minTxPerMin` are burst gates on the
  screening window; waived for `steady_envelope` candidates at screening and for steady-lane
  deploys in `validateDeployPoolThresholds` (mirror), logged `[LANE] velocity gates waived`.
  The lane's activity floor remains `rankSteadyMinFeeTvl24h`.
- **Close sends via RPC_URL.** `closeSendsViaPrimaryRpc` (management, default true): claim /
  remove-liquidity / close-account transactions are sent through `getConnection()` (Helius,
  rebate-address) while reads keep the failover pool; `false` restores 6d63ec8.

## 4. What is working and should be kept

Round-trip harvest (+3.0 SOL, 97% win) and trailing TP (+7.9 SOL, 97%) — the replay-backed
mechanics remain the profit centres. Adoption/discovery is now ~5 s (wallet-filtered PositionV2
subscription). Asset-aware valuation (plan #13) removed the SOL/USDC phantom-TP class. Helius key
pooling ended the 09-12/13 429 floods (7,400/day → ~40/day). Hold has been net positive as an
operator tool. Manual closes: +6.4 SOL at 75% win.

## 5. Suggested order of work (each flag-gated, each verified on data)

1. Accounting: wallet-truth daily reconciliation + freeze evolution + fix rebalance-leg records.
2. Exit stack: revert to replay-backed params; adaptive trailing → shadow; OOR auto-close back on.
3. Rebalance engine → shadow + executor gates + proceeds-only sizing; fix `maxRebalances`.
4. Top Performers → scout-capped; hold cap unified; skimmer OFF until rails are real.
5. Steady-lane waiver for tx/min + vol/tvl; RPC sends via RPC_URL.
