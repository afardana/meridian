# Plan 07 — OOR-Below Flip Tactic (withdraw + re-add token-side, same range)

**Status:** IDEA / DEFERRED — decision gated on `/exits` probe data (see §4). Do not implement
before the gate condition is met.
**Origin:** community discussion 2026-07-01 (withdraw-vs-close mechanics + "ngeflip" play);
captured 2026-07-06.

---

## 1. The mechanics

Three DLMM exit operations differ in what survives:

| Operation | Liquidity | Fees | Position account | Rent (~◎0.057) |
|---|---|---|---|---|
| Withdraw liquidity | → wallet | claim separately | **kept** (bins intact) | stays locked |
| Close position | → wallet | claimed | closed | refunded |
| Close + zap-out (Meridian today) | → wallet | claimed | closed | refunded, all → SOL |

**The flip:** a SOL single-sided bid_ask below price converts SOL→token as price falls through
the range. Once OOR-below, the position is ~100% token in bins priced *above* current price.
Instead of close+zap (market-selling the token at the local bottom — the `early_exit` pattern
the probes measure), withdraw the tokens (account survives) and **re-add them token-single-sided
into the same bins**. The position becomes an ask ladder: price recovering up through the range
sells the token back to SOL at the original bin prices + earns fees on the way up.

## 2. When it wins / loses

- **Wins:** mean-reverting wick — recover at range prices instead of bottom-ticking, plus fees.
- **Loses catastrophically:** genuine rug — an ask ladder above a dead token never fills; rides
  to zero with no stop. This is exactly the June fat-tail pattern (plan #06 §2).
- Discriminators already in the system: crash fast-path bin-velocity (rug vs wick), organic
  momentum (crowd leaving vs staying), pool-health volume death.

## 3. Implementation sketch (when green-lit)

- New mechanical action `FLIP` next to CLOSE in the OOR-below rule: instead of close at
  `outOfRangeWaitMinutesBelow`, if flip-gates pass → withdraw (SDK `removeLiquidity` with
  `shouldClaimAndClose: false`) + re-add token-side into the tracked `bin_range` (bid_ask,
  `bins_above` = old `bins_below`). Track as the SAME position with `flipped_at`,
  `flip_count` (cap 1).
- **Flip gates (all must pass):** crash detector never fired for this position; organic momentum
  ≠ DECAYING at flip time; pool volume-death alert not active; token still on discovery API.
- **Bail-out:** if price hasn't re-entered the range within `flipBailHours` (default 6), close +
  zap for real (the loss was real; stop waiting). Trailing: if the ladder partially fills and
  price re-exits below, close immediately (one chance only).
- PnL accounting: the flip realizes nothing; perf record must carry `flipped: true` and the
  final close's `pnl_pct` measures the whole arc — plus `post_close` probes score it like any
  close. Config: `flipEnabled` (OFF), `flipBailHours`, `flipMaxPerPosition` (1).

## 4. The decision gate (why deferred)

Wait for ≥15 probed `oor_below`-family closes in `/exits`:
- **`early_exit` > `good_exit` persistently** (the `⚠ selling bottoms` flag) → the flip attacks a
  real, quantified loss; implement behind gates above. Expected value ≈ avg `missed_pct` ×
  frequency − rug-tail risk.
- **`good_exit`/`delisted` dominate** → current close-and-move-on is already right; the flip
  would only add rug exposure. Drop this plan.

Cross-check against `crash_shadow`/crash-close telemetry: flips should only ever be considered
for the slow-drift OOR population, never the velocity-crash population.
