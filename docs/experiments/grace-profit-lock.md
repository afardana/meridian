---
id: grace-profit-lock
config_key: graceLockShadowMode
status: insufficient
mode: shadow
registered_at: 2026-11-24
enforce_built: false
---

# Profit lock inside the grace (wide trailing once the in-grace peak passes +10 %)

## Claim
Inside a profit grace (the 60-min adoption window or a straddle's `profit_grace_until`), no
profit rule runs and, since 2026-10-17, no stop either. A position that runs far inside the grace
can give all of it back before any rule looks. A WIDE trailing stop that only exists once the
confirmed in-grace peak has passed +A % — close when PnL falls D pp from that peak — ends with
more SOL than the current behaviour (nothing until the grace ends, then trailing 2 / 1.5 on a
peak re-based to the reading at the grace end), without giving up what the grace earns on the
small-profit positions.

## What was known at registration (2026-11-24, before any replay of this rule)
Seen:
- MCAT-SOL CY2JGang (operator, 11-22): in-grace peak 15.44 %, closed by hand inside the grace at
  7.85 %.
- OpenIndex-SOL FrJp148v (operator, 11-22): in-grace peak 18.64 %, reference re-based to 16.58 %
  at the grace end, trailing booked 13.80 %.
- PIERRE-SOL 72jUBSia (straddle, 10-19): in-grace high 10.68 %, released by hand at 3.85 %,
  trailing fired at 2.25 %.
- 12 operator trailing closes within 15 min after the grace end: median in-grace high 5.31 % →
  3.53 % at minute 60 → 2.62 % booked.
- The opposite evidence: on operator positions the 60-min grace beat NO grace (trailing 2 / 1.5
  from the start) by ◎+1.72 (16 better / 6 worse) in a tick replay; straddled JACK-SOL (+18.6 %)
  and SAPLING-SOL (+16.2 %) dipped right after the straddle and then ran. `grace_shadow`
  (2 / 1.5 with no grace) on 17 straddles: Σ (final − no-grace fire) −54.4 pp.
Not seen: any replay of a lock with a high arm and a wide drop; how many graces reach +10 % at
all; whether the big runners (JACK, SAPLING, CRAWL) would have been cut by it.

## Replay
- **Population:** perf records closed 2026-09-26 … the export date whose position had a profit
  grace (adopted operator positions: the first `adoptedProfitGraceMinutes` after adoption;
  straddled positions: from each straddle to its `profit_grace_until`), with a poller tick path
  (`price_ticks`) covering the grace. Excluded: positions on HOLD at any time inside the grace,
  rebalance legs, tick paths with a gap > 3 min inside the grace. A position with two graces
  (adoption then straddle, or two straddles) contributes each grace until the lock fires.
  Grace windows come from the record (`grace_shadow.started_at` / `ended_at` / `ended_by`), else
  from the position row (`adopted_at`, `straddled_at`, `profit_grace_until`,
  `profit_grace_released_at`), else — adopted records only — the first 60 min of the tick path.
- **Readings:** poller rows; a row with pnl ≤ −99.9 (missing price) is dropped; a reading that
  differs from the previous one by more than 15 pp is dropped (the live guard's suspect rule).
- **Lock:** the in-grace peak is confirmed as live (`confirmPeak`): two consecutive distinct
  readings above the current peak, the lower of the two. Armed once the confirmed peak ≥ A.
  Fires on the second consecutive distinct reading at or under (peak − D); the exit PnL is that
  second reading. After a fire the position is closed in the counterfactual (the rest of its
  recorded path is not used).
- **Δ◎ per position** = (lock exit PnL − recorded `pnl_pct`) / 100 × `amount_sol`
  − lock exit cost + the record's own realized exit-swap cost,
  where the lock exit cost = `amount_sol` × the median realized exit-swap cost of trailing closes
  of the same owner (operator / bot) as a share of capital, computed from the same export.
  Positions where the lock never fires have Δ = 0 and are not counted in the checks.
- **Primary variant (the only one that decides):** A = 10, D = 5, both grace kinds pooled.
  Reported beside it and unable to rescue it: A 8 / 15; D 3 / 7; "keep half" (fire at peak ÷ 2);
  per grace kind (adoption / straddle) and per owner.

## Pass rule (replay stage — decides whether a shadow capture is proposed to the operator)
Registered 2026-11-24, before the replay is written or run. All on the primary variant, over the
positions where the lock fires:
1. n ≥ 15 fires — otherwise `insufficient`.
2. Σ Δ◎ > 0.
3. Σ Δ◎ > 0 without the largest Δ.
4. better ≥ 1.5 × worse (|Δ| ≤ ◎0.0005 is a tie).
5. The worst single truncation (most negative Δ) is no larger in size than ½ Σ Δ◎.
6. Both halves of the fires, split by close time, have Σ Δ◎ > 0.
7. Cost-robust: Σ Δ◎ > 0 with the lock exit cost doubled.
8. Latency-robust: Σ Δ◎ > 0 when the exit PnL is the first reading at least 30 s after the fire.
9. A grace kind is only proposed if its own Σ Δ◎ ≥ 0.

`met` → a shadow capture (`[GRACE_LOCK_SHADOW] would-close`, a `grace_lock_shadow` stamp on the
perf record, graded against the record's final result) is proposed in the session. Nothing that
closes a position is built without the operator's go-ahead. `not_met` → the rejected list.

Not covered: what the operator would have done with the freed capital; a lock outside a grace
(that is the live trailing rule); the stop side of the grace (see `grace-backstop-stop.md`).

## Shadow stage (forward capture)
Registered 2026-11-24, before any forward record exists. Built on the operator's go-ahead after
the replay above came out `insufficient` by one fire. `grace-lock-shadow.js` runs the primary
variant (A = 10, D = 5) beside the live rules on the trusted reading stream of the grace
counterfactual and writes `grace_lock_shadow` on the position → perf record; the first fire logs
one `[GRACE_LOCK_SHADOW] would-close` line. It closes nothing (`graceLockShadowMode` off | shadow;
there is no enforce). Graded by `scripts/experiments/grade.js` (id `grace-profit-lock`, population
`bot_and_operator`).

**Pass rule (forward stage):**
- Population: perf records closed after the capture went live that carry `grace_lock_shadow` with
  a non-null `fired_at`, no `interrupted`, not a rebalance leg; bot and operator pooled, reported
  per owner and per grace kind.
- Δ◎ per record = (`fire_pnl_pct` − the record's `pnl_pct`) / 100 × `amount_sol` (gross on both
  sides: both exits pay an exit swap).
1. ≥ 15 fires — otherwise `insufficient`; no time arm, the count is reported in the daily run.
2. Σ Δ◎ > 0.
3. Σ Δ◎ > 0 without the largest Δ.
4. better ≥ 1.5 × worse (|Δ| ≤ ◎0.0005 is a tie).
5. The worst single truncation is no larger than ½ Σ Δ◎.
6. Both halves of the fires by close time have Σ Δ◎ > 0.
7. Cost-robust: Σ Δ◎ > 0 with 1 % of `amount_sol` charged on every fire (the lock sells into a
   falling price).

`met` → an enforce path (a real close inside the grace) is PROPOSED to the operator in the
session (grader action `build_enforce`, never `promote`); nothing that closes a position is built
without the operator's go-ahead. `not_met` → the rejected list; the mode key is set to off.

Caveats: the record's `pnl_pct` after a later capital change (operator top-up / withdrawal, a
straddle's re-deposit) is on a different capital than the fire's reading; the replay fires (14,
09-26 → 11-23) are NOT counted toward the 15. "Distinct" is (pnl, active bin) changed, as in the
replay — the live 30 s reconfirm of an unchanged valuation is not used.

## Revert rule
None — no enforce path exists.

## Grading log

### 2026-11-24 (617 records closed 09-26 → 11-23; 1,051,108 raw poller rows) — **insufficient** (14 fires of 15)
Run: `node scripts/replay/grace_lock_replay.js` (exports: `scripts/replay/grace_lock_export_rows.sql`,
`_events.sql`, `_ticks.sql`).

- population: 226 records with a grace → 232 graces (adoption / operator 178, straddle / bot 50,
  straddle / operator 4) → **205 usable**; excluded 19 held inside the grace and 8 with a tick gap
  > 3 min (all adoption; none of them would have fired). Windows: 33 from `grace_shadow`, 197
  from the position row, 2 earlier straddles from `position_events`; the 60-min fallback was not
  needed. Tick path vs record at the close: median 0.01 pp.
- 32 graces reached a confirmed in-grace peak ≥ 10 %; the lock fires on **14**; the other 18 never
  fell 5 pp from their peak inside the grace (largest drop 4.61 pp).
- primary (A = 10, D = 5): Σ Δ ◎+0.3349 (bootstrap 90 % CI +0.02 … +0.66), 10 better / 4 worse.
  1. n ≥ 15: **FAIL** (14)
  2. Σ Δ > 0: pass (+0.3349)
  3. without the largest: pass (+0.1995; the largest is SATPAD-SOL 3EH4RCLT +0.1353)
  4. better ≥ 1.5 × worse: pass (10 / 4)
  5. worst truncation ≤ ½ Σ: pass (CLAUDIA-SOL CC9jDsKq −0.0692 vs 0.1674)
  6. both halves > 0: pass (+0.1947 / +0.1402)
  7. lock exit cost doubled: pass (+0.3183)
  8. exit 30 s later: pass (+0.3384)
  9. per kind ≥ 0: pass (straddle +0.1185 on 10, adoption +0.2163 on 4)
- the fires (peak → lock exit vs recorded, Δ◎): SATPAD 11.99 → 3.68 vs −26.28 (+0.1353);
  Mimi 10.07 → 3.96 vs −27.78 (+0.0897); swordcat ABUEPEvU 23.25 → 17.51 vs 11.39 (+0.0885);
  CRAWL G1cNfPFe 12.41 → 7.35 vs 3.33 (+0.0492); VEIL 2nd straddle 30.08 → 24.66 vs 20.48
  (+0.0274); WEFT 12.83 → 7.76 vs 2.95 (+0.0193); PIERRE 10.53 → 4.39 vs 2.26 (+0.0143);
  baton 2nd straddle 20.35 → 15.14 vs 15.21 (+0.0131); JEANPHIL 12.04 → 6.69 vs 4.71 (+0.0065);
  MCAT CY2JGang 15.25 → 8.30 vs 7.85 (+0.0025); GTA6 11.95 → 4.46 vs 4.16 (−0.0018);
  OpenIndex FrJp148v 18.14 → 9.84 vs 13.80 (−0.0112); CLAUDIA D12CAqf5 10.85 → 4.43 vs 11.53
  (−0.0287); CLAUDIA CC9jDsKq 13.53 → 7.68 vs 16.89 (−0.0692).
- secondary (cannot rescue): A 8 Σ +0.1848 (17 fires, 11 / 6; fails 5, 6); A 15 +0.1203 (5);
  D 3 +0.2272 (18, 10 / 8; fails 4); D 7 +0.2055 (10, 5 / 4); keep half +0.1521 (9, 4 / 5).
- data caveats:
  - 3 fires (swordcat ABUEPEvU, CLAUDIA CC9jDsKq, CRAWL G1cNfPFe) are straddled records that were
    corrected after the close (flow basis, fee double count), so their ticks and records differ by
    2–5.7 pp. Without them: 11 fires, Σ +0.2664, only check 1 fails.
  - 7 straddled positions from before the 2026-10-03 capital-basis fix (JACK, SAPLING ×2, …) have
    tick paths on the diluted % (ratio 2.7–3.5 to the record). On the ticks as stored none fires.
    A crude rescale makes three of them fire (n 17, every check passes), but the paths step
    around each straddle and cannot be recovered, so that figure is not a result.
  - the 15 pp suspect rule compares with the last KEPT reading, as the live guard does. Compared
    with the previous raw reading, FTR-SOL FQ9bKV9a's spurious +418 % rows confirm a "peak" and
    add a 15th fire — an artefact, not counted.
- reading: the lock mostly saves positions that ran past +10 % inside the grace and then collapsed
  before any rule could act (SATPAD, Mimi — both ended near −27 %), and trims modestly elsewhere;
  its cost is the runners it cuts (the two CLAUDIA straddles). Direction and every robustness
  check agree, on one fire too few and with the two largest gains carrying 67 % of the total.
- **decision:** `insufficient` under the registered rule — nothing is proposed as `met`. The replay
  cannot gain fires faster than new graces occur, and its pre-10-03 paths are unusable; a forward
  shadow capture would grade the same rule on clean data. Whether to build that capture is the
  operator's call.

### 2026-11-24 — shadow capture built on the operator's go-ahead; 0 forward fires
`grace-lock-shadow.js`, `graceLockShadowMode=shadow` (code default), `grace_lock_shadow` on the
perf record; registered in `scripts/experiments/definitions.js`. The live module reproduces two of
the replay's fires from their poller ticks (CRAWL-SOL G1cNfPFe 12.41 → 7.35, SATPAD-SOL 3EH4RCLT
11.99 → 3.68; `test/grace-lock-shadow.test.js`).
