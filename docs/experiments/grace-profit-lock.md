---
id: grace-profit-lock
config_key: null
status: registered
mode: none
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

## Revert rule
None — no enforce path exists.

## Grading log
(empty — replay not run)
