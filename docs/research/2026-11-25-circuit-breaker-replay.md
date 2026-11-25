# Circuit breaker — what a unit-correct breaker would have done (replay, 2026-11-25)

Read-only replay. No code, config or VM change. Script and raw output:
`/private/tmp/claude-501/-Users-Angga-Repos-meridian/761265a4-8137-446b-83fe-2f68da13e683/scratchpad/breaker/replay.py`,
`…/scratchpad/breaker/out.json` (every variant × threshold × cooldown rule, with every trip).

## Summary

- **As shipped (V0) it cannot trip at prod settings, confirmed.** Window 09-26 → 11-25: worst 24 h "drawdown" the shipped arithmetic ever computed was **−0.26 %** (needs −15 %); longest `pnl_usd < 0` streak **4** (needs 6). It would only have tripped with the old example-config streak of 4 (twice: 10-06 and 10-19).
- **The loss-streak half is inert on bot outcomes even after the fix.** Longest real BOT loss streak (sign of `pnl_sol_net`, ties ±◎0.0005 skipped) in 60 days: **3** (09-29, and 11-12 → 11-13). Bot record mix: 277 wins / 105 losses / 65 ties. Streak thresholds 4, 5, 6 and 8 never fire in V2/V3. With operator closes mixed in (V1) the longest is 6 (10-18 → 10-19).
- **Units fixed, bot outcomes only, prod intent (V2, streak 6, −15 %): 4 trips in 60 days, all in the last 30 days** (10-28, 11-05, 11-11, 11-13), all on drawdown, 72 h paused under the module's own resume rule. The pauses would have blocked **12 bot deploys, Σ −◎0.034** (◎0.034 saved; 1 at ≤ −10 %). With a clean 6 h pause the same idea gives 5 trips / 30 h / 5 blocked deploys **Σ +◎0.109 (cost)**. The sign flips with the cooldown rule. n = 4–5: too small to read.
- **Most sensitive version that is still rare: V2 at −10 %.** 6 trips (shipped resume rule, 113 h paused, 25 blocked, Σ −◎0.068, 90 % CI −◎0.24…+◎0.08) or 7 trips (clean 6 h pause, 42 h, 10 blocked, Σ +◎0.013, CI −◎0.22…+◎0.20). −5 % is not rare (10–13 trips, up to 315 h = 13 of 60 days paused).
- **Mixing operator closes in (V1) pauses the bot constantly**: 10 episodes, **427 h ≈ 17.8 of 60 days** at −15 %, 331 trip alerts, and the pauses would have blocked 200 bot deploys that netted **+◎1.75** (the CRAWL +◎1.86 run sat inside the 10-06 → 10-10 pause).
- **The equity base, not the threshold, decides when it fires.** AUM (balance history `totalSol`) collapses whenever the operator withdraws: the 11-13 trip is a **◎0.005** loss against a ◎0.024 wallet (−22 %); the 10-28 trip is −173 % (◎0.33 against ◎0.19). Net capital (deposits − withdrawals) is the opposite problem: it reads ◎5–9 while AUM was ◎0.2–3.7 (the baseline misses payments routed through swaps — see bb8e388), so with it −10/−15 % never fire at all.
- **Realised PnL lags the drawdown it is meant to catch.** The largest trip (10-28) is VEIL-SOL, a bot deploy held 6.3 days and closed by hand from the dashboard at −72 % (−◎0.33): the loss happened over days, the breaker would have reacted to the booking.
- **A second code bug, independent of units:** during a pause every close calls `checkCircuitBreaker()` (returns `tripped:true`) and `lessons.js:281-283` then calls `tripCircuitBreaker()` again because `_wasAlreadyTripped` is never set — so **every close in a pause restarts the 6 h cooldown and sends another "Circuit Breaker Tripped" Telegram alert**. Operator closes count. The two V0 trips at streak 4 would have lasted 90.7 h (122 restarts) and 31 h.
- **Rounding**: 148 window records were gross losses (`pnl_sol < 0`), 39 of them stored as `pnl_usd` 0.00. By the corrected definition (net, ties skipped) 156 losses, 37 of them at 0.00. In practice the 0.00 records reset a running shipped streak **17 times**: 7 were real losses, 10 were near-ties. Only 3 hit a real streak of ≥ 3. The worst: 10-19 10:09, where the shipped count fell 4 → 0 while the real (all-records) streak went on to 5 and then 6.

**Recommendation: fix units in shadow first** (reasons at the end).

## What the shipped module does (read from the code)

- `circuit-breaker.js` `checkCircuitBreaker()`:
  - **Streak:** walks the performance array (all records: bot, operator, rebalance legs) from the newest and counts `pnl_usd < 0` until the first non-negative record.
  - **Drawdown:** `drawdownPct` = Σ `pnl_usd` over records with `recorded_at` in the last 24 h (rounded to 2 dp) ÷ (`baseline.total_deposited` × `lastSolPrice`).
  - It trips when streak ≥ `circuitBreakerConsecutiveLosses` OR drawdown ≤ `circuitBreakerDrawdownPct`. `tripCircuitBreaker` sets `resumesAt` = now + `circuitBreakerCooldownHours`.
  - At the first check after `resumesAt` it resets and re-evaluates over the FULL history, so a condition that still holds re-trips at once.
- **Callers:**
  - The screening cycle (`index.js:1749`): a trip skips the whole autonomous screening cycle, opportunity-poll triggers included.
  - `recordPerformance` (`lessons.js:280`): after every close, with the re-trip-on-every-close bug described above.
  - `/resume` resets it.
- **What it does not stop:** the management cycle, exits, straddles, and manual `/deploy` or GENERAL-agent deploys.
- **Config** (`config.risk`): code defaults `circuitBreakerEnabled` true, `DrawdownPct` −15, `ConsecutiveLosses` 6, `CooldownHours` 6. **Prod values confirmed** from the dashboard status snapshot (`api-status.json` `userConfig`, taken with the fixtures): 6 / −15 / 6 h, enabled, `solMode` true. `lastSolPrice` 67.59. `baseline.total_deposited` ◎41.52, `total_withdrawn` ◎28.13.

## Data and method

- **Perf records:** 1,471; 635 in the window 2026-09-26 00:00 WIB → snapshot 2026-11-25 18:50 WIB (last record 17:34 WIB). By owner: 447 bot (2 of them close-and-reopen straddle children, excluded from "blocked deploys"), 188 adopted. **0 rebalance legs in the window, so V3 ≡ V2.** `pnl_usd` = round(`pnl_sol`, 2) on 633 / 635 records: SOL, gross.
- **Evaluation times:** every record's `recorded_at`, plus a 10-minute grid. The 24 h sum also changes when an old record leaves the window and the equity moves between closes, so per-close alone would miss trips. Records before the window feed the streak and the 24 h sum, but only trips that start inside the window are counted.
- **Variants:**
  - V0: the shipped arithmetic. `total_deposited` = deposits up to t; SOL price from balance history, or implied from `pnl_usd_true / pnl_sol` before 10-09.
  - V1: all records. Drawdown = Σ 24 h `pnl_sol_net` (fallback `pnl_sol`; none was missing) ÷ AUM `totalSol` at or just before t, within 30 min. Streak = sign of `pnl_sol_net`; |x| < ◎0.0005 neither extends nor breaks it.
  - V2 = V1 on bot records only (not adopted, not a leg).
  - V3 = V2 + legs in the drawdown sum (identical here).
  - "n" suffix = net capital (deposits − withdrawals up to t) as the base. "a24" = AUM 24 h earlier as the base.
- **AUM coverage:** the balance-history file covers only 2026-10-09 22:42Z onward (20,000-row cap). Before that the AUM variants fall back to net capital (flagged). No V2 trip at −10 / −15 % falls in that stretch. In V1 the 09-26 and 10-06 trips do.
- **Cooldown / resume rules:**
  - **A (as shipped):** a 6 h pause. Every record that arrives during the pause restarts it at the record's time + 6 h (the lessons.js call sequence; it applies to every close, operator ones included, in all variants). At expiry the conditions are re-evaluated over the full history, and a re-trip at that check continues the same episode. The trip count is episodes, not alerts; "alerts" counts every trip call.
  - **B (clean):** a fixed 6 h pause; after resuming, only records after the resume count toward either condition.
- **"Blocked":** a bot screening deploy (not adopted, no `parent_position`) whose deploy time (`recorded_at − minutes_held`) falls inside the pause. "24 h": deploy time in [trip, trip + 24 h). Σ = Σ `pnl_sol_net` of those deploys. A negative Σ means the pause would have saved that much, a positive Σ means it would have cost it.
- **Bootstrap:** a 90 % interval over per-trip Σ (10k resamples), computed only with ≥ 5 trips.

## Variant × threshold (full window 09-26 → 11-25, 60.4 days)

For each variant the streak thresholds 4 / 5 / 6 / 8 give identical rows, because the drawdown trips first or the streak never reaches 4. Exceptions: V1 at streak 4 (one extra streak trip; detail in out.json) and V0 (below). Baseline for scale: 443 bot deploys closed in the window, Σ +◎2.10.

| Variant | Rule | DD thr | Trips (dd / streak) | Alerts | Paused h | Blocked n | Σ blocked ◎ | ≤ −10 % | 24 h n | Σ 24 h ◎ | 90 % CI Σ blocked |
|---|---|---|---|---|---|---|---|---|---|---|---|
| V0 shipped | A | −5 / −10 / −15 | 0 (2 with streak 4) | 0 (134) | 0 (121.7) | 0 (75) | 0 (+1.707) | 0 (9) | 0 (32) | 0 (+2.006) | — |
| V1 all, AUM | A | −15 | 10 (10/0) | 331 | 426.6 | 200 | **+1.748** | 22 | 75 | +2.014 | −0.40…+5.11 |
| V1 all, AUM | A | −10 | 10 | 362 | 484.6 | 216 | +1.686 | 24 | 77 | +2.002 | −0.55…+5.04 |
| V1 all, AUM | A | −5 | 15 | 401 | 619.0 | 239 | +1.722 | 25 | 94 | +1.927 | −0.78…+5.68 |
| V1 all, AUM | B | −15 | 13 | 13 | 78.0 | 25 | +1.908 | 2 | 92 | +1.900 | −0.13…+5.73 |
| V1 all, AUM | B | −10 | 15 | 15 | 90.0 | 34 | +1.590 | 5 | 114 | +2.026 | −0.53…+5.44 |
| V1 all, net cap | A | −15 | 6 | 265 | 282.2 | 178 | +1.881 | 19 | 71 | +2.119 | −0.15…+5.18 |
| **V2 bot, AUM** | **A** | **−15** | **4 (4/0)** | 19 | **72.2** | **12** | **−0.034** | 1 | 17 | −0.099 | n too small |
| V2 bot, AUM | A | −10 | 6 | 35 | 113.0 | 25 | −0.068 | 3 | 32 | −0.158 | −0.24…+0.08 |
| V2 bot, AUM | A | −5 | 10 | 221 | 314.9 | 131 | +2.190 | 12 | 66 | +0.083 | −0.18…+6.65 |
| **V2 bot, AUM** | **B** | **−15** | **5** | 5 | **30.0** | **5** | **+0.109** | 0 | 20 | −0.052 | +0.02…+0.20 |
| V2 bot, AUM | B | −10 | 7 | 7 | 42.0 | 10 | +0.013 | 1 | 35 | −0.111 | −0.22…+0.20 |
| V2 bot, AUM | B | −5 | 13 | 13 | 78.0 | 22 | −0.009 | 2 | 82 | +0.121 | −0.25…+0.20 |
| V2 bot, AUM 24 h earlier | A | −15 | 2 | 12 | 45.3 | 7 | −0.054 | 1 | 10 | −0.127 | n too small |
| V2 bot, AUM 24 h earlier | A | −10 | 3 | 20 | 68.7 | 14 | −0.186 | 4 | 17 | −0.259 | n too small |
| V2 bot, net cap | A | −10 / −15 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| V2 bot, net cap | A | −5 | 3 | 171 | 147.1 | 98 | +2.296 | 9 | 30 | +0.222 | n too small |
| V3 (= V2) | A | all | identical to V2 | | | | | | | | |

Notes on the table:
- **V0:** the bracketed figures are the streak-4 run (10-06 09:21 → 10-10 04:04 and 10-19 02:56 → 10-20 09:55 WIB). At streaks 5 / 6 / 8 it never trips.
- **Large blocked counts under rule A** (V1, V2 −5 %, V2n −5 %) come from the 10-05/06 → 10-10 stretch, when ~90 bot deploys ran inside one restarted pause, CRAWL +◎1.86 among them.

**Last 30 days (10-26 18:50 → 11-25 18:50 WIB):**
- V2 at −15 %: the same 4 trips (A: 72 h, 12 blocked, Σ −◎0.034; B: 5 trips, 30 h, Σ +◎0.109).
- V2 at −10 %: 4 trips (A, 85.5 h, 19 blocked, Σ −◎0.031) or 5 (B, 30 h, 7 blocked, Σ −◎0.001).
- V1 at −15 %: 6 trips (A, 104.6 h).
- V0: none at any setting.
- Bot deploys in the 30 days: 87, Σ −◎0.16.

## Per-trip — V2 (bot only, AUM base), streak 6, −15 % (nearest the shipped intent)

Rule A (as shipped):

| Trip (WIB) | Ends | h | Fired on | 24 h bot loss / equity | Restarts | Blocked in pause: n, Σ ◎, ≤ −10 %, best / worst | Next 24 h: n, Σ ◎ |
|---|---|---|---|---|---|---|---|
| 10-28 05:00 | 10-29 20:18 | 39.3 | dd −172.9 % | −◎0.330 / ◎0.191 | 8 (+2 re-trips) | 6, −0.087, 1, +0.063 / −0.145 | 4, −0.070 |
| 11-05 05:13 | 11-05 11:13 | 6.0 | dd −19.0 % | −◎0.146 / ◎0.769 | 0 | 1, +0.033, 0 | 6, −0.056 |
| 11-11 16:31 | 11-12 07:27 | 14.9 | dd −18.0 % | −◎0.237 / ◎1.312 | 4 | 5, +0.020, 0, +0.009 / −0.000 | 7, +0.028 |
| 11-13 11:50 | 11-13 23:50 | 12.0 | dd −22.0 % | −◎0.005 / ◎0.024 | 0 (+1 re-trip) | 0 | 0 |
| **Σ** | | **72.2** | | | | **12, −0.034, 1** | **17, −0.099** |

Rule B (clean 6 h pause):
- The same trips, except that 10-28 splits into 05:00 (blocked 1, +◎0.007) and 20:10 (dd −18.0 %, blocked 1, +◎0.063 — INVERSE-SOL's +16.7 % trailing win).
- Σ 5 blocked, **+◎0.109**.

Reading:
- **10-28 05:00:** VEIL-SOL (a bot deploy held 6.3 days, closed by hand at −72 %) against a wallet the operator had drained to ◎0.19. The pause would have blocked the LAUNCH-SOL −16.4 % stop (−◎0.145) and the INVERSE +16.7 % win.
- **11-13:** a ◎0.005 loss on a ◎0.024 wallet. The operator had withdrawn ◎1.2 that morning, and `maxPositions` was 0 from then on, so nothing was blocked.
- **11-05 and 11-11:** look like the intended use (◎0.15–0.24 of bot losses in a day on ◎0.8–1.3 of equity), but what the pause would have blocked was flat to positive.

## Per-trip — V2, streak 6, −10 % (most sensitive that still reads as rare)

Rule A:

| Trip (WIB) | Ends | h | Fired on | 24 h loss / equity | Blocked: n, Σ ◎, ≤ −10 % | Next 24 h: n, Σ ◎ |
|---|---|---|---|---|---|---|
| 10-11 08:40 | 10-11 14:40 | 6.0 | dd −10.3 % | −◎0.230 / ◎2.234 | 0 | 6, −0.002 |
| 10-19 12:23 | 10-20 09:55 | 21.5 | dd −12.1 % | −◎0.158 / ◎1.306 | 6, −0.037, 1 | 6, −0.037 |
| 10-28 05:00 | 10-29 20:18 | 39.3 | dd −172.9 % | −◎0.330 / ◎0.191 | 6, −0.087, 1 | 4, −0.070 |
| 11-05 05:10 | 11-05 11:13 | 6.1 | dd −10.3 % | −◎0.079 / ◎0.769 | 1, +0.033, 0 | 6, −0.056 |
| 11-11 03:20 | 11-12 07:27 | 28.1 | dd −10.5 % | −◎0.154 / ◎1.463 | 12, +0.023, 1 | 10, +0.007 |
| 11-13 11:50 | 11-13 23:50 | 12.0 | dd −22.0 % | −◎0.005 / ◎0.024 | 0 | 0 |
| **Σ** | | **113.0** | | | **25, −0.068, 3** | **32, −0.158** |

Rule B:
- 7 trips × 6 h. 10-28 again splits in two (05:00 and 20:10). 10-19 blocks 3 (+◎0.014). 11-11 blocks 4 (−◎0.104, incl. one −◎0.084).
- Σ 10 blocked, **+◎0.013**; next 24 h Σ −◎0.111.

## Descriptive figures

| | Full window | Last 30 d |
|---|---|---|
| Longest shipped streak (`pnl_usd < 0`, all records) | 4 (10-06 09:01 → 09:21) | 2 |
| Longest real streak, all records | 6 (10-18 20:27 → 10-19 12:23) | 3 |
| Longest real streak, bot only | **3** (09-29 06:42 → 07:47) | 3 (11-12 20:09 → 11-13 11:42) |
| Worst 24 h drawdown, shipped arithmetic | −0.26 % (10-07 09:10; "$1.55" on "$591") | −0.02 % |
| Worst 24 h drawdown, bot, AUM base | −173 % (10-28 05:10) | same |
| Worst 24 h drawdown, bot, AUM 24 h earlier | −242 % (10-29 00:40, −◎0.47 / ◎0.19) | same |
| Worst 24 h drawdown, bot, net capital | −7.3 % (10-28 20:00) | same |
| Worst 24 h drawdown, all, net capital | −31.8 % (09-26 06:20, −◎1.83 / ◎5.75) | −8.6 % |
| Losses (net, ties skipped) / stored as `pnl_usd` 0.00 | 156 / 37 | 29 / 5 |
| Shipped streaks reset by a 0.00 record | 17 (7 real losses, 10 near-ties; 3 with real streak ≥ 3) | 4 (0 with ≥ 3) |

Percentages above 100 % are real arithmetic, not errors: a held position's whole loss is booked at once against a wallet that was smaller than that position by then.

## Caveats

- **No counterfactual for what the bot does after resuming.** "Blocked" outcomes are what those deploys actually returned. A paused bot might have deployed something else afterwards, or the same pool later. Deploys still open at the snapshot have no record and are not counted (few: prod `maxPositions` is 0 since 11-13).
- **A pause closes nothing.** Positions open at the trip keep running and their closes keep arriving, which under rule A restart the pause.
- **The rule stack changed inside the window**, for example:
  - the trailing drop moved to 1.0;
  - the grace / rug changes;
  - `maxPositions` was 3 → 1 → 0 at various points;
  - the bot was mostly idle from 11-13.

  So trips late in the window have few deploys to block by construction.
- **Equity includes operator capital and operator / held positions.** AUM moved by ◎2–8 on single operator deposits and withdrawals (10-28 +◎1.96 / −◎1.16, 11-10 −◎2.0, 11-13 −◎1.2, 11-24 +◎7.8). Net capital is overstated by withdrawals the baseline scan missed. Neither is a clean "bot capital" figure.
- **The AUM base exists only from 10-09 22:42Z.** Earlier V1 trips use net capital (flagged in out.json). The V2 −10 / −15 % results do not depend on it.
- **Bot / operator attribution** uses the record's `adopted` flag. A bot deploy the operator closes by hand (VEIL-SOL) counts as a bot outcome.
- The real breaker is evaluated per screening cycle and per close. This replay uses closes + a 10-min grid. Expiry is taken at the exact `resumesAt`, where in reality it is the next check (≤ one screening interval later).

## Recommendation: fix units in shadow first

Evidence for the choice:

1. **Keeping the thresholds cannot be justified yet, and the evidence for changing them is no better.**
   - At the shipped intent (V2, 6 / −15 %) the corrected breaker fires 4–5 times in 60 days, all in the last 30.
   - The money it would have moved is ◎−0.03 to ◎+0.11 depending only on the cooldown rule, with n far too small for an interval.
   - At −10 % (6–7 trips) the interval spans zero (−◎0.24…+◎0.08 / −◎0.22…+◎0.20).
   - No threshold is shown to be useful or harmful. Any other number picked from this table would be post-hoc and would have to be registered before use.
2. **The streak condition does nothing on bot outcomes.** The longest bot loss streak in 60 days is 3, so 4–8 never fire. Making it bite would take a streak of 3 — post-hoc, unregistered, and within the noise of a 27 %-of-non-ties loss rate (105 / 382). The shadow should record the real streak without setting a new threshold.
3. **The equity base decides the trips.**
   - AUM gives absurd trips when the wallet is drained (◎0.005 loss → −22 %).
   - Net capital never fires at −10 / −15 %.
   - Using AUM 24 h earlier halves the trips.
   - Which base is right is a design decision. A shadow log carrying all three per would-trip is the cheap way to settle it on forward data.
4. **Population matters more than units.** With operator closes included (V1) the breaker would have paused the bot ~30 % of the time and cost about ◎2 (the CRAWL run). Whatever is enforced must be bot-only (V2).
5. **The re-trip-on-every-close bug must be fixed before any enforce.** Under it a pause lasts as long as positions keep closing, plus 6 h (90.7 h for the V0 10-06 trip), and every close sends a Telegram alert.

Suggested shadow capture: per check, log a would-trip line with:
- V2 streak;
- Σ 24 h bot `pnl_sol_net`;
- drawdown % on AUM now, on AUM 24 h earlier and on net capital;
- the cooldown rule B outcome.

Register the pass rule (e.g. Σ net of would-blocked bot deploys < 0 over ≥ 10 would-trips and in both halves) in `docs/experiments/` before grading.
