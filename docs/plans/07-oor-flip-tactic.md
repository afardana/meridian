# Plan 07 — OOR-Below Flip Tactic (withdraw + re-add token-side, same range)

**Status:** IMPLEMENTED 2026-07-06 (shipped OFF — shadow mode active). Ecosystem research
(Kamino / Orca / Gamma / Charm all rebalance-in-place rather than exit-to-SOL) promoted this from
DEFERRED to build-now, but it ships behind two flags that both default `false`, mirroring the
plan #04 crash fast-path house pattern: while OFF the flip decision runs every cycle and only
emits `[OOR_FLIP_SHADOW]` log lines (would-flip / no-flip-because-`blocked_by`) for live
calibration against the `/exits` probe data — **zero on-chain change**. Enable per §5 once the
probe gate in §4 confirms `early_exit > good_exit` on the `oor_below` family.
**Origin:** community discussion 2026-07-01 (withdraw-vs-close mechanics + "ngeflip" play);
captured 2026-07-06; implemented same day with the companion Charm-style swap-free redeposit.

---

## 0. What shipped (2026-07-06)

Two flags, both **default `false`**, both `update_config`-tunable, both shadow-logging while OFF:

| Flag (config.management / user-config.json) | Default | Effect when ON | Shadow log when OFF |
|---|---|---|---|
| `oorFlipEnabled` | `false` | An OOR-below close that passes the flip gates (§3) becomes a `FLIP` action: `flipPositionInPlace()` withdraws (keeps the account) + re-adds the received base token as a single-sided bid_ask ask ladder just above the active bin, same tracked position. | `[OOR_FLIP_SHADOW] would flip <pair>: <reason>` / `[OOR_FLIP_SHADOW] no flip <pair>: blocked_by=<gate>` |
| `swapFreeRedepositEnabled` | `false` | (companion) reserved for the post-close base-token-strip path. | `[SWAP_FREE_SHADOW]` in the executor post-close auto-swap: estimates the Jupiter market-sell slippage just paid vs. the fee-earning strip alternative, using the already-captured `recordExitSwapOutcome` slippage. |

Tuning keys (all `?? default`, all `update_config`-tunable): `oorFlipBailHours` (6),
`oorFlipMaxPerPosition` (1), `swapFreeRedepositBins` (20).

Decision predicate `shouldFlipOorBelow(position, tracked, cfg)` is a pure/total function in
`index.js` (returns `{flip, reason}` | `{flip:false, blocked_by}`, never throws). It is consulted at
BOTH OOR-below decision points — the management cycle (full `p.health` enrichment, so the
volume-death gate is live) and the fast PnL poller (backstop; health gate simply absent there, all
other gates apply). The `oorFlipEnabled` flag is checked by the *caller*, not the predicate — so
shadow mode exercises the full gate logic exactly as the live path would. A failed flip falls back
to a real close, so a flip fault never strands a position OOR-below.

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
for the slow-drift OOR population, never the velocity-crash population. This cross-check is
enforced in code by GATE 2 below: the crash fast-path detector marks `_crashFired` (an in-process
set) for any position it fires on — even in its own shadow mode — and a `_crashFired` position can
never flip.

---

## 5. As-built + rollout (2026-07-06)

### Flip gates as implemented (`shouldFlipOorBelow`, all must pass)

1. `active_bin < lower_bin` (OOR-below break) — else `blocked_by: not_oor_below`.
2. crash fast-path never fired for this position (`_crashFired`) — else `crash_fired`.
3. organic momentum ≠ `decaying` (`getOrganicMomentumForPool(pool)`) — else `momentum_decaying`.
4. no `volume_death` health alert (mgmt cycle only; absent in the poller backstop) — else `volume_death`.
5. pool + base-mint not on a repeat-deploy cooldown (`isPoolOnCooldown`/`isBaseMintOnCooldown`) — else `pool_cooldown`/`mint_cooldown`.
6. `flip_count < oorFlipMaxPerPosition` (cap 1) — else `flip_cap`.
7. bail: an already-flipped position older than `oorFlipBailHours` closes for real — else `bail_timeout`.

### As-built deviations from §3

- **Re-add geometry:** the ask ladder is `swapFreeRedepositBins` (default 20) bins *just above the
  live active bin* (`active+1 → active+strip`, single-sided token X, `StrategyType.BidAsk`), rather
  than literally re-using the old `bins_below` width mirrored above. Rationale: after a slow drift
  the active bin has moved; anchoring the fresh ask ladder to the *current* active bin is what makes
  a recovery fill it. The tracked `bin_range` is rewritten to the new ladder and `out_of_range_since`
  cleared so the recovered ladder isn't instantly re-flagged.
- **"token still on discovery API" gate** from §3 was dropped in favor of the stronger, already-wired
  volume-death + momentum-decaying + cooldown gates (a delisted/dead token trips volume-death or
  momentum-decaying). Kept the surface minimal per the no-new-files/no-new-API-calls constraint.
- **Bail as two mechanisms:** the flip cap (1) already forces a real close the *second* time a
  position hits OOR-below; GATE 7 is the belt-and-suspenders time bail for a stale first-flip
  re-entry.
- **PnL accounting:** the flip realizes nothing on-chain; the tracked position carries `flip_count`
  + `flipped_at`, and the eventual real close runs `recordPerformance` over the whole arc exactly as
  before (post-close probes score it like any close). A `type:"flip"` decision-log row is appended.
- **Swap-free redeposit (companion):** shipped as a shadow-only estimator in the executor post-close
  auto-swap path (`[SWAP_FREE_SHADOW]`, reusing the captured exit-swap slippage). The ON path for a
  *post-close* token-single-sided fresh deploy was intentionally NOT wired, because a token-side
  fresh deploy contradicts the executor's SOL-only single-side deploy invariant; the live-position
  ask-strip is instead delivered by the flip path (`flipPositionInPlace`), which operates before the
  account is closed. The flag + shadow log exist for calibration and to reserve the config surface.

### Rollout

- **Phase 0 (done):** merge OFF. Both flags `false`; every touched path is flag-gated → zero behavior
  change. `node --check` + full module-graph import verified; the `shouldFlipOorBelow` gate logic
  smoke-tested (10/10 synthetic cases) against the real momentum/cooldown modules.
- **Phase 1 — shadow (3–7 days):** grep `OOR_FLIP_SHADOW` / `SWAP_FREE_SHADOW` in the daily logs.
  Cross-check each would-flip against the position's actual later outcome (recovered vs rugged) and
  against the `/exits` `oor_below`-family rollup (§4). Calibrate.
- **Phase 2 — enable in DRY_RUN / one position:** `update_config oorFlipEnabled=true` (optionally
  `DRY_RUN=true` first — `flipPositionInPlace` short-circuits with a `would_flip` descriptor). Watch
  for a `flip` decision-log row + Telegram.
- **Phase 3 — live:** flip `DRY_RUN` off. Then, separately, evaluate `swapFreeRedepositEnabled`.
- **Rollback (instant):** `update_config oorFlipEnabled=false` (and/or `swapFreeRedepositEnabled=false`)
  — live-applies via the executor apply loop, persists to user-config.json, no restart. Every touched
  code path is flag-gated, so OFF fully restores prior behavior.
