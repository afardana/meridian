# Audit 01 — rules, complexity and profitability (2026-09-25)

Scope: README §10 (correlation map) and §11 (open questions). Method: each item gets a verdict
(**Delete** / **Merge** / **Refine** / **Keep** / **Decide**), the evidence behind it, and the effort.
New evidence pulled for this audit is in §A (bot-deploy outcome drivers), §B (anatomy of the 54
disasters), §C (steady lane by family), §D (winners that gave everything back), §E (entry
price-change buckets). Nothing here has been applied; §5 is the proposed change plan.

---

## 0. Headline findings (what the numbers say before any rule is touched)

1. **The admission machinery does not predict outcomes.** Over 169 bot deploys since Aug 22, no entry
   feature separates winners from losers monotonically: fee/TVL quartiles run +0.45 / −2.35 / −1.33 /
   +1.22, intel quartiles −2.08 / +0.73 / 0.00 / +0.02, entry TVL +0.57 / −0.41 / −0.10 / −1.39
   (highest TVL is the worst quartile), organic flat within ±0.1, volatility −0.19 / −1.35 / −1.01 /
   +0.41. Win rate (≥2%) sits at 24–38% in every bucket. Caveat: this is the post-filter population,
   so it says the *ranking among admitted pools* carries no signal, not that the safety floors are
   useless. (§A)
2. **The losses are concentrated in held and manually managed positions, not in bot rules.** 54 closes
   at or below −10% cost −21.9 SOL; 34 of them are adopted operator positions and 8 of the 10 largest
   are manual or external closes of positions held for days (KNOB ×2 −1.91, CTO −1.66, GPRO −1.38,
   MCAT −1.05, JEANPHIL −1.05, TJR −0.81). 28 closes reached a peak of +3% or better (average peak
   **+55%**) and still closed below +1%, for −5.64 SOL — those are the hold cohort riding round trips.
   (§B, §D)
3. **Half of all disasters were winners first.** 21 of 54 had a max favourable excursion ≥ +2%, 31 of
   54 ≥ +1%. The exit stack only protects a *confirmed* peak (2 poller ticks) and needs a 1.5 pp
   drop; a gap through that band (crash) or a hold flag defeats it. (§B2)
4. **The bot's own disasters come from the steady lane.** Of the 20 bot disasters, 14 are steady-lane:
   10 stop-losses averaging 18 hours held (−2.23 SOL) and 6 OOR-below at 12 hours (−1.02 SOL). The
   lane's winners (trailing 22, harvest 15) made +1.89 SOL; its losers took −4.9. It is a slow-bleed
   lane: positions sit in quiet pools until the token drifts through the ladder. (§C)
5. **Entry timing evidence contradicts the "never deploy into a pump" story.** The 13 bot deploys made
   into a ≥20% window move had 0 disasters and +1.20% average; the 100 deploys into a −20…0% window
   had 12 disasters and −0.96%. Small n on the pump side, but the operator's edge (entering on
   flow) is visible in the bot's own data. (§E)

Implication for the audit: **cut complexity on the entry side (it isn't paying), and spend the
saved effort on two things that do pay — protecting unconfirmed peaks, and stopping slow bleeds.**

---

## 1. §10.1 One signal, many gates

| Item | Verdict | Why | Effort |
|---|---|---|---|
| fee/TVL counted 4× in admission (envelope floor, intel Yield 35%, fee-TVL percentile ±6, fee-eff percentile ±5) + executor floor + LLM lines | **Merge → one term** | §A: fee/TVL quartiles are U-shaped, not monotone; the four terms all move the same score and reward thin pools (CLAUDE.md TVL note). Keep the envelope floor (0.30%/h) as a universe filter and the 24h rate as the LLM's number; drop the two percentile modifiers and the executor re-check (it re-reads the API for a value the screener already had). | S |
| Entry-TVL floor + clean-history exemption in 3 mirrors | **Merge → one function, two callers** | Three copies with slightly different scout handling (rank adds an intel bar, executor doesn't). One `admissionTvlDecision(pool)` used by screening and executor. | S |
| bins-below formula in 5 copies | **Merge → `computeBinsBelow` only** | Prompt and STEPS should render the *result* of the function for the candidate (a `bins_below:` line), not restate the formula for the model to compute. Removes a class of drift and lets the executor verify the LLM's number against its own. | S |
| Hold-mode guard ×4, velocity gates ×3, launchpad block ×3 | **Merge** | Pure duplication; one predicate each. | S |
| Lineage take-profit ×3 (three reason strings, two families) | **Delete two** | Rebalance engine is shadow; lineage chains exist only on 4 legacy positions. Keep the state.js copy, delete the index.js RULE_2' and the mgmt OOR-below branch copy. | S |
| Stop-loss / OOR-below / low-yield evaluated in both evaluators | **Merge → one evaluator** | §03 §4.3: the index.js copies win in practice; the state.js STOP_LOSS timer, its TWAP wrapper and its urgency flag are dead; RULE_5 lacks the adoption/history guards that state.js has. See Q4. | M |

## 2. §10.2 Contradictions

| Item | Verdict | Why | Effort |
|---|---|---|---|
| SPOT-ON-DUMP prompt vs dump-play guard (rejects every ≥20% dumper when GMGN is neutral) | **Refine: drop the guard's dev-score branch** | GMGN is IP-banned in prod (09-25 log) → dev score is always 50 → the branch is a blanket "no dumps" rule the prompt then contradicts. §E: the 3 dump entries that got through were +1.53% avg, 0 disasters. Keep only the "dev sold/closed" branch when GMGN actually answers; let the Jupiter audit `dev_migrations`/`dev_balance_pct` stand in (Q6). | S |
| RENEWED-FLOW / ACCELERATING-flow prompt rules read a `flow:` line that never renders; gas break-even filter reads the same missing fields | **Delete the prompt rules and the filter, or fix the field** | Both consume `fee_tvl_24h`, which `condensePool` never produces. The steady lane already carries `fee_active_tvl_ratio_24h`; wire that one field and the `flow:` line works, then decide if the rules earn their prompt tokens. The gas filter is redundant with the scout/probe floors and `deployAmountSol`. | S |
| Steady-lane fee waiver reads `minFeePerTvl24h` (default 7) vs screening bar 1.5 | **Refine** | Consistent only because prod sets 1. Make the executor read `rankSteadyMinFeeTvl24h`. | XS |
| `maxTvl` applied only at the executor in rank mode | **Refine** | Apply in `applyRankSafetyGates` so the LLM never judges a pool the executor will block. | XS |
| Starvation relaxer moves gate-mode keys, not gated by the evolution switch | **Refine** | It lowered `minIntelScore` 61→52 on 09-24 for no admission effect. Gate it behind `evolutionEnabled` and point both at `rankMinIntelScore`. | XS |
| Reason-string families (toxic/surge → fee-death, harvest → OOR-above, ratchet/young/rug/lineage → other) | **Refine: explicit `exit_family` field** | Exit-quality stats, `classifyOutcome`, evolution and the briefing all read the family. Set it at the source (`action` → family map) and stop keyword matching. See Q5. | S |
| `URGENT_EXIT_ACTIONS` keyed on the signal string → poller RULE_1 not urgent | **Refine** | Add `RULE_1` (or carry `urgent` on the exit object end to end). Only matters when `fastCloseSkipClaim` is enabled; do it with the evaluator merge. | XS |
| Operator `/rebalance` skips pool re-validation | **Refine docs or code** | Decide which is intended; the comment says cap-only. Recommend: keep re-validation, let the operator override with an explicit `force`. | XS |
| `wide {60,110}` / `maxBinsBelow 90` unreachable behind the 69 cap; >69 deploy path dead | **Delete the dead path, fix the docs** | Multi-account ranges were never used; the single-account limit is 69 bins. | S |
| config.js defaults drifted from CLAUDE.md (stop −18, ratchet 6/+1.5, RULE_3 10, ratchet on, deployAmountSol 0.4, gasReserve 0.05) | **Refine: make code defaults = prod** | A fresh checkout or a lost `user-config.json` would boot with the wrong exit stack. | XS |

## 3. §10.3 Dead or inert under production config

Two-thirds of flag families are shadow or dead. Each costs a code path, a log line, and in three
cases an external call. Verdicts, grouped by what the shadow logs have shown:

**Delete now (shadow long enough, data says no, or superseded)**
- Bear debate (100% veto rate, retired 07-27) — and with it `deploy_confidence`/`deploy_thesis`
  capture, or move capture out of the debate block if the verdict correlation is wanted.
- Profit ratchet (byte-identical to no-ratchet at trailing 2/1.5 in two replays).
- Adaptive trailing + inventory exhaustion (pinned at 8%, 0 exits in 4 days; replay could not rank it).
- Re-entry cooldown (07-29 audit: no penalty for rapid re-entry; blocks idle-SOL alternatives).
- Repeat-deploy cooldown (both modes) — the losers-only variant is on, but the outcome data behind
  the original gate was the same June artifact.
- Discord signals, chart indicators, LPAgent style steer, GMGN source path, hive mind default-on,
  claude-cli backend (dormant since July), LPAgent relay deploy/close, `minSolToOpen`,
  `darwin.recalcEvery`, `JUPITER_PRICE_API`, wide-range path, gate-mode admission + `[RANK_SHADOW]`
  (prod has run rank since July; keep `discoverPools` only for the funnel-audit script).
- Rebalance engine (all four decision points, `rebalancePosition`, lineage TP, trend module for
  roll-ups): −4 SOL live, ≈ break-even under gates, and the 09-25 study shows re-centring is LVR.
  Keep `/rebalance` as an operator tool only if the operator uses it; otherwise delete.
- OOR-flip + swap-free redeposit (shadow since July, never enabled; the OOR-below population is 8
  closes at 0% win — the fix is not flipping, it is not being there).
- Fee compounding (shadow since July; at 0.4–3 SOL sizes fees rarely clear 5× gas).

**Keep in shadow, with a decision date**
- Close-efficiency gate — but stop the Jupiter quotes: compute the shadow from the cached impact
  only, or run it once per position, not per tick.
- TWAP wick guard — decide after the evaluator merge (it only wraps rules that never fire today).
- Exit-swap price-impact guard is ON; the slippage cap (500 bps) should be enabled with it or deleted.
- Young stop, in-range rug (ON), crash fast-path (ON) — keep; see §4 for the refinement they need.
- Fast-close skip — enable; it is a free 3.5 s on urgent exits and the accounting is unaffected.
- Safety enrichment `log_only` — enable `enforce` **only** together with the intel bar move to ≈69
  (CLAUDE.md pairing), or delete the Safety dimension and use the rug filter as a hard gate instead.

**Keep**
- Round-trip harvest (75 closes, +3.02 SOL, 97% win), trailing 2/1.5, stop −15, crash/rug fast
  paths, OOR-below 60, low-yield with guards, unfilled cap 25, dust sweep, exit priority fees,
  ledger truth, post-close probes, scout tier (bounded tuition), verdict fingerprint suppressor.

**Fix the external-call leaks regardless**
- GeckoTerminal trend fetch on every harvest hit for a shadow roll-up → gone with the engine.
- GMGN dev fetch on the enrichment slice while the IP is banned → skip when the last N calls were
  bans (there is already a 180-min cooldown; make the dump guard not depend on it).
- Jupiter quotes for the shadow close-efficiency gate → cache per position (above).

## 4. §10.4 Where the money moves — refinements that the data supports

1. **Protect unconfirmed peaks.** 21 of 54 disasters were ≥ +2% at some point. Two changes:
   (a) arm trailing on the *raw* tick peak once it clears the trigger by the overshoot margin (the
   2-tick confirmation exists to filter one-tick noise; a +2.5% raw peak followed by a −1.5 pp drop is
   not noise), (b) treat a drop of ≥ 3 pp within one 5-second tick from any raw peak ≥ +2% as an
   urgent exit — a "peak crash" rule that sits between trailing and the crash fast-path. Replay
   the 195-path Sep set before enabling; expected effect is on the crash family (−4.68 SOL) and the
   give-back cohort.
2. **Stop the slow bleed.** Steady-lane losers averaged 12–18 hours held. A time-in-drawdown rule —
   PnL ≤ −5% for ≥ 4 hours with no bin crossings in the last hour — closes a dead ladder before the
   −15 stop, at roughly a third of the cost. The OOR-below 60-minute rule already does this for the
   fully-exited case; this covers the half-filled case. Replay first.
3. **Hold cohort.** Hold mode is the operator's decision and stays. But the bot can still *tell*: a
   daily line "held positions: peak +55% → now −17%, X SOL of unrealised give-back" in the briefing,
   and a Telegram alert when a held position falls more than 10 pp from its peak. Zero rule changes,
   visibility only.
4. **Entry side.** Remove the ranking terms that carry no signal (§1) and the dump guard's neutral
   branch (§2); keep the safety floors; let the LLM judge flow/timing with the `pool_price_change`,
   `flow` (once wired) and `1h` lines. This shrinks the screener prompt and the funnel code by
   roughly a third without changing what gets admitted — the admission score's variance is
   effectively random today.
5. **Accounting.** Nothing more to build; keep evolution frozen until 7-day drift is inside
   ±0.2 SOL (currently −1.2). The 21 legacy adopted rows will age out of the 7-day window by 10-02.

---

## 5. §11 questions — answers

1. **Which shadow/dead flag families to delete?** The "Delete now" list in §3 (≈17 families,
   ≈4,000 lines by a rough count of the modules and branches involved). Keep the four in
   "keep in shadow" with dates, keep the "Keep" list.
2. **Collapse admission to fee/TVL + rug filter, LLM judges timing?** Yes, with one nuance: keep the
   *safety* floors (critical warnings, single ownership, holders ≥ 500, mcap band, bin step, TVL drain,
   blacklists) as hard gates; make the *quality* ranking a single fee/TVL-24h sort; drop intel as an
   admission bar (its quartiles carry no signal, §A) but keep the Yield/Safety numbers as candidate
   lines. The LLM then sees ≤5 pools ranked by fee yield with price-change, flow and audit lines, and
   decides. Expected: same admitted set, ~half the screening code, no GMGN dependency.
3. **Is the 100k TVL floor earning its place?** Not as a disaster control any more (17 disasters
   above it since Aug 22; highest-TVL quartile is the worst). It does keep the universe small, which
   limits churn. Recommendation: keep it as a *sizing* threshold rather than a gate — full size ≥
   100k, scout size below — which is what the scout tier already does; then the exemption logic and
   the Top-Performer sub-floor special case collapse into one rule.
4. **Merge the two exit evaluators?** Yes: `updatePnlAndCheckExits` becomes the single ordered list
   (stop → peak-crash → trailing → harvest → unfilled cap → RULE_3 → OOR below → low-yield with
   guards → surge/toxic), `getDeterministicCloseRule` is deleted, and the mgmt-cycle action map
   consumes the exit object. Precedence becomes one table, urgency travels on the object, TWAP
   wraps everything or nothing.
5. **Explicit `exit_family`?** Yes — set from the exit `action` at the point of close; backfill the
   Sep records from the reason strings once; `classifyOutcome`, `/exits`, briefing and evolution
   read the field.
6. **Replace GMGN dev score with Jupiter audit?** Yes for the dump guard (use `dev_migrations`,
   `dev_balance_pct`, `permanent_control` from the audit already fetched in recon); keep GMGN only
   for the smart-money exodus check if that ever leaves shadow.
7. **Jupiter key.** Rotate; set `JUPITER_API_KEY` in `.env`; delete the constant. Operator action.
8. **Cap external calls per tick.** Falls out of §3 deletions plus the close-eff cache. Target: per
   poller tick one RPC valuation and one cached Jupiter price; per mgmt cycle one discovery read;
   per screening cycle ≤ 3 Meteora reads, ≤ 5 Jupiter reads, 0 GMGN, 0 GeckoTerminal.
9. **Relaxer gating.** Gate behind `evolutionEnabled`; retarget to `rankMinIntelScore` (or delete
   with the intel bar, per Q2).
10. **Steady lane.** On its own data it is net −2.18 SOL with a 6-hour median hold and 14 of the bot's
    20 disasters. Either give it the slow-bleed rule (§4.2) and a 6-hour max hold, or retire it and
    let the operator's manual entries (which the bot adopts and exits fine) be the steady strategy.
    Recommendation: retire the autonomous lane, keep the 24h envelope fetch as *information* for the
    LLM, revisit if the slow-bleed rule proves out on the burst lane.

---

## 6. Proposed change plan (nothing applied yet)

**Phase 1 — deletions and consistency, no behaviour change on the money path (1–2 days)**
delete the §3 "Delete now" families; merge the duplicated predicates (§1); make `config.js`
defaults equal to prod; fix `maxTvl`, steady fee waiver key, relaxer gating; wire `fee_tvl_24h` or
delete its consumers; explicit `exit_family` + backfill; rotate the Jupiter key. Tests + shadow-log
diff before/after on the VM (the admitted set must be identical for a day).

**Phase 2 — the two rules that address the losses, shadow-first (replay, then 1 week shadow)**
peak-crash exit (§4.1) and slow-bleed exit (§4.2); enable fast-close skip; cache the close-eff quote.

**Phase 3 — structural (after Phase 2 data)**
single exit evaluator (Q4); admission collapse (Q2); TVL floor → sizing threshold (Q3); steady lane
decision (Q10); safety-enrich enforce with the intel bar move, or delete Safety.

Each phase ends with the ledger-truth 7-day drift and the segment table (README §8.2) re-run.

---

## A. Outcome drivers — bot deploys since 2026-08-22 (n=169), quartiles

| Feature (Q1→Q4 boundaries) | Q1 avg / win≥2% / dis | Q2 | Q3 | Q4 |
|---|---|---|---|---|
| fee/TVL at entry (0.14 / 0.42 / 1.50) | +0.45 / 31% / 3 | −2.35 / 29% / 8 | −1.33 / 26% / 5 | +1.22 / 32% / 2 |
| entry TVL ($138k / $196k / $269k) | +0.57 / 26% / 2 | −0.41 / 33% / 4 | −0.10 / 26% / 7 | −1.39 / 24% / 4 |
| intel total (52.6 / 58.8 / 63.3) | −2.08 / 29% / 7 | +0.73 / 38% / 4 | 0.00 / 24% / 3 | +0.02 / 19% / 3 |
| price change at entry (−8.4 / −2.0 / +4.1 %) | +0.52 / 26% / 3 | −2.56 / 26% / 7 | −0.52 / 29% / 5 | +1.23 / 29% / 2 |
| volatility (1.69 / 2.77 / 3.84) | −0.19 / 35% / 4 | −1.35 / 28% / 6 | −1.01 / 26% / 6 | +0.41 / 30% / 4 |
| organic score | −0.50 / 38% / 5 | −0.62 / 23% / 6 | −0.47 / 28% / 4 | −0.58 / 28% / 5 |

## B. The 54 disasters (pnl ≤ −10%) since 2026-08-22

Total −21.9 SOL. 34 adopted / operator, 14 steady lane, 6 burst lane. 21 had MFE ≥ +2%, 31 ≥ +1%.
Median held 393 min. 14 entered on a ≥ +20% window move, 3 on ≤ −20%. Ten largest: KNOB −1.30 and
−0.61 (manual, held 10 days), CTO −1.66 (external, steady, 4.6 days), GPRO −1.38 (manual, 7 days),
MCAT −1.05 (crash, burst, peak +7.8%), JEANPHIL −1.05 (manual, burst, peak +5.9%), fone −0.88 (stop,
adopted), TJR −0.81 (manual, 7 days), CYBERLEEK −0.80 (stop, adopted), GPRO −0.75 (manual, 14 min).

## C. Steady lane by family (69 closes)

| Family | n | avg % | Σ SOL | avg held |
|---|---|---|---|---|
| trailing | 22 | +3.37 | +0.94 | 578 min |
| harvest | 15 | +2.44 | +0.95 | 405 |
| manual | 18 | −0.58 | +0.48 | 1714 |
| oor-above | 2 | +2.73 | +0.32 | 352 |
| low-yield / decay | 17 | +0.03 | 0.00 | 113 |
| ratchet | 3 | −1.07 | −0.01 | 176 |
| oor-below | 6 | −10.02 | −1.02 | 749 |
| stop | 10 | −11.53 | −2.23 | 1095 |
| other (external) | 1 | −41.0 | −1.66 | 6622 |

## D. Winners that gave everything back

28 closes with MFE ≥ +3% and final PnL < +1%: average peak +55.3%, average close −16.7%, −5.64 SOL.

## E. Bot deploys by entry price change (screening window)

| Window move | n | avg % | win ≥2% | disasters | Σ SOL |
|---|---|---|---|---|---|
| ≤ −20% | 3 | +1.53 | 33% | 0 | +0.07 |
| −20 … 0% | 100 | −0.96 | 27% | 12 | −1.92 |
| 0 … +20% | 53 | +0.39 | 26% | 5 | +0.16 |
| +20 … +100% | 13 | +1.20 | 31% | 0 | +0.15 |

---

## 7. Phase 1 — applied 2026-09-25

Commits `5c99981` … `7b54b3f` on `experimental` (merged from `phase1-wp3-screening`), deployed to
the VM 13:12 local with a config backup `user-config.json.*.pre-phase1`. Net **−6,800 lines** across
46 files. No production config value was changed; removed keys in `user-config.json` are ignored.

**Removed** (§3 "delete now"): gate-mode admission + `[RANK_SHADOW]` (rank is the only mode),
Discord signals, GMGN discovery source, chart indicators, LPAgent style steer, gas break-even
filter, profit ratchet, adaptive trailing + inventory exhaustion, lineage take-profit (×3),
autonomous rebalance/roll-up engine (manual `/rebalance` kept), OOR-flip + swap-free redeposit,
fee compounding, re-entry cooldown + repeat-deploy cooldown, bear-case debate (+ confidence/thesis
capture), claude-cli backend, LPAgent relay deploy/close, wide-range >69-bin path, `minSolToOpen`,
`darwin.recalcEvery`, `JUPITER_PRICE_API`, hive-mind built-in credentials (env-only now).

**Consistency** (§2): `config.js` defaults = production (60 keys); `maxTvl` applied at the rank
safety gates; steady-lane fee waiver reads `rankSteadyMinFeeTvl24h`; starvation relaxer frozen with
evolution; poller `RULE_1` in the urgent set; `healthCheckIntervalMin` wired; `flow:` line now
renders for steady-envelope candidates (`fee_tvl_24h` emitted); verdict cache reads the fields
candidates actually carry (first time it can skip a re-ask); explicit `exit_family` on every record
+ backfill of the history.

**Behaviour notes** (all deliberate): a single-tick gap from >+2% to ≤−10% now labels `TRAILING_TP`
where it labelled `PROFIT_RATCHET`; children of a manual `/rebalance` no longer get the +4% lineage
close; hive mind is OFF until `HIVE_MIND_URL`/`HIVE_MIND_API_KEY` are set in `.env`; the verdict
cache can now suppress an LLM re-ask when every candidate carries a fresh unmoved NO-DEPLOY verdict.

**Not done in Phase 1** (deferred to Phase 2/3 by design): dump-guard neutral branch, fee/TVL term
merge, TVL-floor mirrors merge, evaluator merge, safety-enrich decision, Jupiter key rotation
(operator), steady-lane decision.

---

## 8. Incident audit — surge-decay exit on a manual GO-SOL position (2026-09-25)

**What happened.** The operator's manual GO-SOL position `4P8fGn…` (1.0 SOL, adopted by the poller
at 18:31 local) was closed at 18:58 by `SURGE_DECAY` with the reason "Dynamic fee collapsed 69.0%
(peak 1.4758% → current 0.4569%) at age 28m with PnL +1.01%". Realised result −0.73% (−0.0073 SOL).
The previous manual position `Hkggq1…` was closed the same way at 40 minutes for −0.36%.

**The rule.** `evaluateSurgeDecay` (state.js, commit 07443b1 "micro-structure upgrades", 2026-09-16;
`surgeDecayExitEnabled=true` in prod, threshold 50%, min age 15 min) tracks the highest Meteora
*dynamic fee* (the variable fee component that rises with volatility) seen since the position was
tracked and exits when the current dynamic fee is ≥50% below that peak while PnL ≥ 0. A second
variant does the same on the 24h fee/TVL ratio (peak ≥5%).

**Why it is wrong for this position — and in general.**
1. The dynamic fee is *by construction* high while price is volatile and reverts as it calms. The
   rule therefore closes a ladder at the moment the market settles into the oscillation regime the
   ladder exists to earn from. It cannot distinguish "flow left the pool" from "the spike ended".
2. For an adopted position the "peak" is whatever the fee was in the first ticks after adoption. A
   position adopted during a spike (this one: 1.48%) is guaranteed to be closed once the fee reverts
   — nothing about the position's own performance enters the decision.
3. The `PnL ≥ 0` gate fired on a one-tick valuation blip: the position had been read at −0.2…−1.4%
   for the previous 13 minutes, printed +1.01% on two consecutive 5-second ticks at 18:58:12/17, and
   was closed on them. The realised close was −0.73%. A rule that waits for a non-negative reading and
   then acts on the first one it sees is selecting for noise.
4. Track record since it went live (26 closes, all bot positions until today): average +0.2%, +0.012
   SOL in total, average hold 35 minutes, four GO-SOL deploys closed at exactly 0.00% between 15 and
   31 minutes. It is a churn engine that hands the same pool back to the screener every half hour
   (GO-SOL was deployed six times today).

**Action taken.** `surgeDecayExitEnabled=false` in production (backup `*.pre-surge-off`), agent
restarted; the rule now only logs `[SURGE_SHADOW]`. Code default set to false to match. The
sibling rule from the same commit, `toxicConversionEnabled` (≥85% converted to base within 20 min
with low fees), is still ON; it has fired twice (MET-SOL −1.01% at 8 minutes among them) and is on
the Phase 2 list to replay before it stays enabled.

**Follow-up for Phase 2/3.** Delete `evaluateSurgeDecay` and the `peak_dynamic_fee_pct` /
`peak_fee_per_tvl_24h` tracking unless a replay shows a variant that beats holding; the yield-decay
family (position-alerts `yield_decay`, surge decay, low-yield RULE_5) collapses to the single
low-yield rule with its adoption grace.

### 8.1 Follow-up fixes (same day)

- **Confirmation counted repeated readings.** 82% of consecutive 5-second poller ticks carry the
  same PnL as the previous one (7,879 same vs 1,714 changed over 6 hours): the valuation refreshes
  about every 15 s while the poller runs every 5 s. "2 consecutive ticks" was therefore one
  valuation seen twice — which is how a one-valuation +1.01% blip confirmed `SURGE_DECAY`, how a
  +223% blip fired take-profit (GP-SOL, realised −2.65%), and how today's manual GO-SOL positions
  got a fake +2.7% peak confirmed, trailing armed, and were closed at +1% on the next real reading.
  Fix: peak and exit-signal confirmation advance only on a distinct valuation and never fire on a
  stale tick; a positive jump > 15 pp between two valuations is treated as suspect while it lasts.
- **Toxic conversion** (same commit as surge decay) set to OFF in prod and in code: both of its
  fires were the operator's MET-SOL dip ladders at 5 and 8 minutes.
- **`exit_family` was stamped on the wrong object** in `recordPerformance` (the pool-memory
  summary, not the persisted entry) — new records since 13:12 had no family. Fixed; the three
  affected records will be re-stamped by the backfill script on the next stopped window.
- **Adopted-position profit grace** (operator request, same evening): `adoptedProfitGraceMinutes`
  (60) — no trailing TP / take-profit / harvest on an operator position for the first hour after
  adoption; downside rules unchanged; bot deploys unaffected.

## 9. Harvest → straddle (operator proposal, 2026-09-25)

Instead of cashing out at a round-trip harvest on a pool still trending up, convert half the SOL
proceeds to base and open a symmetric ±34-bin range (spot or curve) around the price — the
operator's manual Meteora "Rebalance" practice. Built shadow-first (`harvestStraddleMode`), see
CLAUDE.md for the keys and safety rails. Evidence: none available from the ledger (the operator's
two-sided entries were not captured); the shadow log records every would-straddle with the trend
reason; enable on the operator's word and grade the `lane="straddle"` records afterwards.
Enabled (`enforce`) the same evening on the operator's instruction. Upgraded to an **in-place** rebalance
(same position account via the DLMM `RebalanceLiquidity` instruction, the mechanism Meteora's own UI
uses — verified on the operator's SWARM-SOL rebalance at 14:51Z): withdraw-ratio → Jupiter buy → re-deposit
centred, one lifecycle in state and in Meteora's PnL; the close-and-reopen variant remains behind
`harvestStraddleInPlace=false`.

## 10. Phase 2 — tick-level replay of the proposed exits (2026-09-25)

**Method.** `scripts/replay/tick_exit_replay.js` (read-only) over `price_ticks` 2026-08-26 → 09-25
(5 s poller cadence, 3.3 M rows): 444 closed positions, **380 scored** (53 hold-mode excluded —
no exit rule touches them — and 11 with too few valuations); bot deploys 143 / adopted 237. The
live valuation semantics are mirrored (consecutive identical readings are one valuation, a +15 pp
jump is suspect). Counterfactual outcome = PnL at the rule's fire, realised 10 s later; compared
against the recorded outcome **and** against a *live baseline* (trailing 2/1.5 on the confirmed
peak, stop −15, adopted grace) so that a rule is only credited for fires that pre-empt what the
current stack already does.

**1. The live baseline vs history.** On bot deploys the current stack is **+0.92 SOL** better than
what actually happened: the adaptive trailing (removed 09-25) had the trigger pinned at 8 % from
09-16, so MCAT −35.7, KEVIN −15.6, JEANPHIL −24.9 and TOAD −15.5 ran to the stop where static 2/1.5
closes them at +3.3 / +3.0 / +2.3 / +0.7. On adopted positions it is **−0.98 SOL** worse: the
operator holds through dips the rules would cut (STACY +7.5 recorded vs −14.9 at the stop, CHAIN
+22.9 vs +3.3 at trailing). Net −0.06. The give-back cohort (raw peak ≥ 3 %, close < 1 %) is 24
positions, −3.02 SOL, and the baseline already covers most of it.

**2. Peak-crash exit (§4.1) — not supported.** As specified (a ≥ 3 pp drop within one 5 s tick from a
raw peak ≥ 2 %) it fires **4 times in 30 days** across 380 positions and **0 times on bot deploys**
ahead of the baseline; fast give-backs take minutes, not one tick. The best variant in a 60-cell
grid (peak ≥ 5, drop 2 pp, within 5 min) adds **+0.21 SOL / 30 d** over the baseline with 9 saves
against 13 truncations; every wider cell truncates more. Not built.

**3. Slow-bleed exit (§4.2) — not supported.** PnL ≤ −5 for ≥ 4 h with no bin change in 60 min fires
**twice**, both on positions that later recovered (LEVERCAT −0.25 SOL, Token −0.18 SOL). All 18
grid cells are net ≤ 0 except −3 / 2 h / 30 min on bot deploys (4 fires, +0.36 SOL, n too small to
trust). **None of the 37 scored disasters (−8.0 SOL) is reachable by a slow rule**: they are fast
(most held < 7 h, peaks ≤ 3 %, closed by the stop or the crash path). The 12–18 h losers that
motivated the rule were hold-mode / operator positions. Not built.

**4. Stop level.** A stop at −6 / −8 / −10 / −12 is net negative on both segments (whipsaws outweigh
saves: CHAIN −0.77 SOL at −8). −15 stays.

**5. Applied instead** (commit after this section):
- `fastCloseSkipClaim` **ON** (code default true): 4 would-skips in 7 days, accounting unaffected,
  RULE_1 already carries urgency.
- `closeEffQuoteMinIntervalSec` 60 → **600**: the shadow close-efficiency quote shares Jupiter's
  gateway limit with the real exit swaps (10 shadow 429s / 30 d).
- **429-aware auto-swap retry** (`autoSwapRateLimitExtraAttempts` 2, 8 s × streak): 103 auto-swap
  429s in 30 days; on 09-25 02:29 a close's remainder was left unsold after three attempts 3 s
  apart (the dust sweeper sold it 19 min later; a remainder above `dustSweepMaxUsd` would strand).
- **Hold-cohort give-back alert** (§4.3): `holdGiveBackAlertPp` 10 — a held position that has given
  back another 10 pp from its confirmed peak gets one Telegram line per step (`[HOLD_GIVEBACK]`),
  and the briefing shows `🧊 held (peak → −N pp)` per position plus the cohort's unrealised
  give-back. No rule change.

**6. Still open.** The Jupiter key in `tools/wallet.js` is the shared, rate-limited one — rotation is
the operator's decision. Phase 3 (§6) is unchanged.
