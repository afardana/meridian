---
id: dip-entry-retracement
config_key: none (records only; entry_off_high_pct + entry_runup_from_low_pct on the perf record)
status: not_met
mode: none (records only)
registered_at: 2026-11-27
enforce_built: false
---

# Dip entry — deploys made after a retracement into the Fibonacci zone of the recent up-leg

## Claim
An X post ("The Dip Hunter Strategy") says: place a narrow range and collect fees when price dips
to "significant Fibonacci levels" and bounces; don't chase the pump, let the price come into the
range; thin TVL is fine because a narrow range concentrates fees; spot shape; hit-and-run.
The one part our records can test is ENTRY TIMING: do deploys made after the token has retraced
into the Fibonacci zone (38.2 % – 78.6 %) of its recent up-leg do better than the rest?

## Not tested here (stated up front)
- The post's narrow width (our ladders are 35–69 bins wide, single-sided SOL directly under the
  active bin) and a range pre-placed BELOW the price that waits to be reached (ours never waits:
  it is under the active bin at deploy).
- Thin-TVL claim (see the entry-TVL band evidence in CLAUDE.md; the cliff is a step at $100k).

## Field conventions (checked in `pump-gate.js` `entryRangeStatsFromCandles`, read 2026-11-27, before any grading)
- `p0` = close of the LAST candle; `entry_off_high_pct` = round((p0 / max(high) − 1) × 100, 1 dp)
  → **stored NEGATIVE or 0** (price is at or under the high). `entry_runup_from_low_pct` =
  round((p0 / min(low) − 1) × 100) → **stored ≥ 0**.
- **High and low are taken over the candles with timestamp ≥ now − 24 h** (`win`), not over the
  48 candles fetched (48 is only the fetch limit; it feeds the pool-age and 24h-change fields).
  So the "recent leg" is the last 24 hours, not 48.
- Consequently, with P = 1: H = 1 / (1 + off_high/100) (the spec's `1 − off/100` assumes a
  positive field; adapted because the field is negative) and L = 1 / (1 + runup/100).
  r = (H − P) / (H − L); leg size = (H − L) / L × 100.
- `r` = 0 means the entry is at the high, 1 at the low. A record with H = L (flat 24 h) has an
  undefined r and is excluded.

## Related evidence already on file (read before registering)
- Rejected list: "Downtrend (falling-token) entry gate" 2026-09-29 — 24h ≤ −30 %: +0.04 SOL,
  12 winners lost, noise. "Pump gate extended to young pools (≤ 24 h run-up)" 2026-10-02 —
  run-up ≥ +300 %: 40 deploys, +1.92 %, 78 % wins, 0 disasters. `pump-gate` itself: dropped
  2026-11-23. Neither covers retracement of the up-leg; no rejected or graded entry covers
  "enter on a dip / retracement" as such.
- CLAUDE.md "entry-range capture (2026-10-02, capture-only)": the fields were added to grade a
  "fading young pool" idea (below the first open and ≥ 50 % off the high: 9 deploys, 2 disasters
  in the backtest — too thin to act on). No rule reads them.

## Pass rule
Registered 2026-11-27, fixed by the session before any data was looked at.

- Population: bot deploys only (not `adopted`, not a rebalance leg, `owner` bot where the field
  exists) closed since 2026-10-02 whose record carries finite `entry_off_high_pct` and
  `entry_runup_from_low_pct` (hourly candles before entry) and `amount_sol` > 0. Result per
  record: `pnl_sol_net / amount_sol × 100` (net % on capital); disaster = `pnl_pct` ≤ −10.
- Retracement of the recent leg from the two fields: with entry price P = 1, high
  H = 1 / (1 − off_high/100) and low L = 1 / (1 + runup/100); r = (H − P) / (H − L). Leg size =
  (H − L) / L × 100. (Sign convention checked above: `entry_off_high_pct` is stored negative, so
  H = 1 / (1 + off_high/100) is used.)
- Dip zone ("Fibonacci zone"): 0.382 ≤ r ≤ 0.786 AND leg size ≥ 50 %. Rest: every other record of
  the population.
- Pass rule: n(zone) ≥ 30 and n(rest) ≥ 30, else `insufficient`. `met` only if ALL hold:
  (1) mean net % of the zone exceeds the rest by ≥ 1.0 pp; (2) the 90 % bootstrap CI (5,000
  resamples, fixed seed) of that difference lies above 0; (3) the zone's disaster rate ≤ the
  rest's; (4) the difference has the same sign in both halves of the period (split at the median
  close time of the population). Otherwise `not_met`.
- `met` leads to a proposal in the session (a screening tag in shadow), never to a build.
  `not_met` → the idea joins the rejected list.
- Known limits: the two fields do not say whether the low came before the high (the "leg" may
  be a down-leg); the window is 24 hourly-candle hours, not 48; it tests entry timing, not the
  post's narrow width (ours is ≥ 35 bins) and not a range pre-placed below the price that waits
  to be reached.

## Revert rule
None — no behaviour is built.

## Grading log

### 2026-11-27 — **registered**, then graded the same day: **not_met** (checks 1–4 all fail)
Run: `/private/tmp/claude-501/-Users-Angga-Repos-meridian/761265a4-8137-446b-83fe-2f68da13e683/scratchpad/dipentry/grade.js`
on `.experiments/status/performance.json` (export of 2026-11-27, 1,492 records). The rule above was
written before this script was run; the only thing looked at beforehand was the field list and one
record's keys (no outcomes).

- Exclusions: 478 adopted / non-bot, 0 rebalance legs, 654 closed before 2026-10-02, 7 missing
  `entry_off_high_pct` or `entry_runup_from_low_pct`, 0 with `amount_sol` ≤ 0 or no net, 0 flat
  (H = L). **Population 353** (2026-10-02 … 2026-11-13; bot closes stop at 11-13).
- Median close time 2026-10-10T14:26Z; bootstrap 5,000 resamples, seed 12345.

| group | n | mean net % | median | Σ net ◎ | win (net > 0) | disasters (pnl_pct ≤ −10) |
|---|---|---|---|---|---|---|
| zone (0.382 ≤ r ≤ 0.786, leg ≥ 50 %) | 134 | −0.21 | +0.71 | +0.779 | 70.9 % | 15 (11.2 %) |
| rest | 219 | −0.03 | +0.64 | +1.704 | 70.8 % | 22 (10.0 %) |

Difference zone − rest: **−0.18 pp**, 90 % CI [−1.65, +1.25]. Halves: first +0.72 pp (79 / 98),
second −1.52 pp (55 / 121).

| check | result |
|---|---|
| n(zone) ≥ 30 and n(rest) ≥ 30 | pass (134 / 219) |
| 1. zone exceeds rest by ≥ 1.0 pp | **FAIL** (−0.18) |
| 2. CI lower bound > 0 | **FAIL** (−1.65) |
| 3. zone disaster rate ≤ rest's | **FAIL** (11.2 % vs 10.0 %) |
| 4. same sign in both halves | **FAIL** (+0.72 / −1.52) |

**Verdict: not_met → rejected list.**

Descriptive only (not part of the rule; all 353 records):

| r band | n | mean net % | median | Σ net ◎ | win | disasters |
|---|---|---|---|---|---|---|
| < 0.236 | 66 | +1.13 | +0.91 | +2.306 | 76 % | 7 (10.6 %) |
| 0.236–0.382 | 80 | −0.31 | +1.17 | −0.252 | 74 % | 8 (10.0 %) |
| 0.382–0.5 | 57 | +0.31 | +1.06 | +0.476 | 72 % | 5 (8.8 %) |
| 0.5–0.618 | 42 | −0.07 | +0.32 | +0.508 | 62 % | 2 (4.8 %) |
| 0.618–0.786 | 42 | −0.72 | +0.62 | +0.006 | 74 % | 8 (19.0 %) |
| > 0.786 | 66 | −1.07 | +0.20 | −0.561 | 65 % | 7 (10.6 %) |

No monotone pattern in r; the shallowest band (entry near the high, r < 0.236) is the best, the
deepest retracement (> 0.786, near the low) the worst — the opposite of "buy the dip". The
0.618–0.786 band carries the highest disaster rate (19 %).

`range_width_bins` is populated on all 353: ≤ 40 bins n = 0 (the bot never deploys that narrow),
41–55 n = 71 mean −0.99 % (8 disasters), > 55 n = 282 mean +0.12 % (29 disasters). Inside the zone:
41–55 n = 25 mean −2.54 % (5 disasters), > 55 n = 109 mean +0.32 % (10).
Inside the zone by entry TVL: < $100k n = 7 (mean −0.04 %, 0 disasters), ≥ $100k n = 127 (mean
−0.22 %, 15 disasters). Rest: < $100k n = 3, ≥ $100k n = 216.

Caveats:
- The "leg ≥ 50 %" condition is nearly always true: only 16 of 353 records have a 24 h leg under
  50 %, so the zone is effectively just 0.382 ≤ r ≤ 0.786 (n = 141 without the leg condition,
  mean −0.11 %).
- Both fields look at the last 24 h only (see field conventions); whether the low preceded the
  high is unknown, so some "retracements" are bounces off a down-leg.
- The population is frozen (no bot close after 2026-11-13), mean net % is dominated by a few
  outliers (rest holds CRAWL-SOL +65.5 %, +◎1.86), and the rule has no robust re-run clause; the
  zone's largest records are +12 % / +11 % / +14 %. Medians are close (+0.71 vs +0.64).
- Entry timing only: the post's narrow range and pre-placed waiting range are untested.
