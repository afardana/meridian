---
id: bidask-flip
config_key: null
status: not_met
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

### 2026-11-23 (1,455-record export; tick export of 267,915 deduplicated poller rows) — **not_met**
Run: `node scripts/replay/bidask_flip_replay.js --records .experiments/status/performance.json --ticks <ticks.csv.gz>`
(tick export: `scripts/replay/bidask_flip_export.sql`). An independent second implementation of the
primary variant (Python, session scratchpad) reproduces every figure below to four decimals.

- population: 361 positions (spot 340, bid_ask 21); excluded 48 straddled, 26 re-ranged, 3 without
  geometry, 1 held. Model validity: median |err| 0.02 pp, p90 0.26 → valid.
- primary (N = 15, bid-ask re-add): 201 positions flipped, 334 flips.
  Σ capital ◎+0.8451, Σ fees ◎−0.5947, gas ◎−0.0334, extra exit swap ◎−0.0339 → **Σ Δ ◎+0.1831**
  (bootstrap 90 % CI −0.07 … +0.46; +0.09 % of the flipped positions' capital).
  1. n ≥ 30: PASS (201)
  2. Σ Δ > 0: PASS (+0.1831)
  3. without the largest Δ: PASS (+0.0574; the largest is HIGGS-SOL 10-06, +0.1257)
  4. better ≥ 2 × worse: **FAIL** (67 / 90, 44 ties)
  5. both halves > 0: **FAIL** (−0.0373 / +0.2204)
  6. fee-robust: **FAIL** (−1.2308)
  7. exit interaction: **FAIL** (−1.8855; 81 earlier trailing closes)
- secondary (cannot rescue): N = 10 Σ ◎+0.0722 (84 / 113); N = 20 Σ ◎+0.0054 (41 / 89); spot
  re-add ◎−0.0272 (a no-op on spot deploys except gas); flip once at the bottom ◎+0.2241 on 7
  positions (2 / 1).
- by exit family (primary Σ Δ): harvest ◎+0.168 (44 flipped), manual ◎+0.099, trailing TP ◎+0.024
  (107), stop loss ◎−0.075 (27), young stop ◎−0.023, rug ◎−0.011.
- data caveats found after the run, none of which changes the verdict:
  - `was_held` does not exist on records before 2026-10-11, so held positions pass the filter.
    CRAWL-SOL 69F2FsPS (held, +66.42 %) alone is −1.8755 of check 7 and ◎+0.0889 of Σ Δ.
  - 11 positions were re-ranged without a counter on the record (first tick 33–44 bins under
    `bin_range.max`; the aborted-straddle cases of 10-03/04 among them).
  - Without those, the held CRAWL and any position with |model err| > 2 pp (16 removed, 186
    flipped): Σ Δ ◎+0.0838, without the largest ◎−0.0419, 60 / 83, halves +0.1025 / −0.0187,
    fee-robust −0.5225, exit interaction +0.0271 — checks 3, 4, 5 and 6 fail.
  - fee attribution was checked afterwards against the recorded PnL path (recorded PnL − modelled
    capital = fees accrued): crossing-weighted is closer than time-linear on 266 of 292 positions
    (median mean deviation 0.06 of the final fees).
- reading: with the close time unchanged the flip moves ≈ ◎0.85 of capital gain against ≈ ◎0.6 of
  fee income lost near the price; what is left is not distinguishable from zero. The exits close a
  position soon after a partial recovery (trailing at +2 %), before the price climbs back into the
  top-heavy asks. The stop-loss, rug and young-stop closes pay the fee loss and gas for no gain.
- **decision:** do not build the flip on the current exit stack. Rejected list updated. The full
  method (flip AND hold for a +10 % target with a late stop) changes the close time and is a
  different hypothesis; it needs its own registration and a post-close price path.
