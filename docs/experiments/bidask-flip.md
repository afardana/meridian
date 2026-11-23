---
id: bidask-flip
config_key: null
status: replay
mode: none
registered_at: 2026-11-23
enforce_built: false
---

# Bid-ask flip (re-shape the converted bins as asks on the way down)

## Claim
A bot ladder that re-shapes its converted bins on the way down — every N bins of decline, withdraw
every bin above the active bin (they hold only the base token) and re-add the same tokens as a
top-heavy (bid-ask) ask ladder over those same bins, same position account, same range, no swap —
ends with more SOL than the same ladder left alone, with the close time unchanged.

Source: yunus (@0xyunss), X post 2026-11-22 and article "Why Bid-Ask Flip on Meteora?" 2026-11-19
(memory `meridian-yunus-bidask-flip`). Distinct from plan #07 (flip once, only after the whole
ladder converted — removed 2026-09-25) and from the rejected roll-up / re-centre engine (moves the
range and buys at the top; this keeps the range and swaps nothing).

## What was known at registration (2026-11-23, before any bin-level replay)
Seen: the perf-record aggregates (439 bot closes 09-26 → 11-13: fees ◎11.36, net ◎1.40; 115 closes
with MAE between −3 % and −15 %; 37 stop losses) and a frictionless toy bin model (the flip never
lowers the value at a given active bin; spot ladder 30 bins down and back to the top: ≈ 0 passive
vs ≈ +2.2 % of capital flipped). Not seen: any per-position replay result. The frictionless model
makes the capital term ≥ 0 by construction, so this rule is decided by the costs (fee income lost
on the re-shaped bins, gas, the larger exit swap) and by the interaction with the trailing exit.

## Replay (scripts/replay/bidask_flip_replay.js)
- **Population:** perf records of bot deploys (not `adopted`, not a rebalance leg), closed
  2026-09-26 … 2026-11-13, `straddle_count` 0, `rebalance_count` 0, `was_held` false, strategy
  spot or bid_ask, SOL-quoted, with a poller tick path (`price_ticks`) covering the hold.
- **Bin model:** bin i holds X_i tokens when the active bin is below it and X_i·p_i SOL when it is
  above (p_i = (1 + binStep/1e4)^i); value at active bin a = Σ_{i<a} X_i·p_i + X_a·p_a +
  Σ_{i>a} X_i·p_a. Initial X_i from the deploy shape (spot: equal SOL per bin; bid_ask: SOL
  rising linearly away from the top bin).
- **Flip:** anchor = the deploy's top bin; when the active bin is ≥ N bins under the anchor, the
  tokens of every bin above the active bin are pooled and re-added over those bins with SOL-value
  weights rising linearly from the bin just above the active bin to the top bin; anchor = the
  active bin. Repeats at each further N bins under the anchor.
- **Δ◎ per position** (flipped − passive at the recorded close time) =
  capital difference at the last active bin
  + fee difference (fees are attributed to bin crossings in proportion to the position's SOL-value
    in the crossed bin, scaled so the passive ladder's modelled fees equal the recorded fees)
  − ◎0.0001 gas per flip
  − extra exit-swap cost (extra token value held at the close × the record's own exit-slippage
    ratio, else the population median).
- **Primary variant (the only one that decides):** N = 15, bid-ask re-add. Reported beside it and
  unable to rescue it: N = 10 and 20, spot re-add, flip only once the whole ladder has converted.

## Pass rule (replay stage — decides whether a shadow capture is proposed to the operator)
Registered 2026-11-23, before the replay was written or run. All on the primary variant, over the
positions with at least one flip:
1. n ≥ 30 positions with a flip — otherwise `insufficient`.
2. Σ Δ◎ > 0.
3. Σ Δ◎ > 0 without the largest Δ.
4. better ≥ 2 × worse (|Δ| ≤ ◎0.0005 is a tie).
5. Both halves of the flipped positions, split by close time, have Σ Δ◎ > 0.
6. Fee-robust: Σ Δ◎ > 0 when the flipped ladder's fee income on the re-shaped bins is halved.
7. Exit interaction: Σ Δ◎ > 0 when the trailing rule (arm 2 %, drop 1.5 pp from the running
   peak) is re-run on the flipped PnL path and allowed to close earlier than the recorded close.
8. Model validity (a precondition, not a pass check): the passive model's capital PnL plus the
   recorded fees must be within 1 pp of the recorded `pnl_pct` at the close on the median
   position; if not, the verdict is `invalid_model` and nothing is concluded.

`met` → a shadow capture (`[FLIP_SHADOW] would-flip`, a `flip_shadow` stamp on the perf record)
is proposed in the session; nothing that changes a position is built without the operator's
go-ahead. `not_met` → the idea goes on the rejected list with these numbers.

Not covered by this rule: holding past the stop loss to wait for a bounce (needs its own
registration — it changes the close time), Token-2022 transfer-fee mints (a fee on every
withdraw and deposit), and any live effect on Meteora's deposit accounting.

## Grading log
