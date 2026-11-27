---
id: flow-guard
config_key: flowGuardShadowMode
status: registered
mode: shadow (capture from the ship date)
registered_at: 2026-11-27
enforce_built: false
---

# Flow guard (unfavourable market flow predicts a worse close than closing now)

## Claim
On an open position — bot or operator — a token whose market flow turns unfavourable under the
default thresholds (sell pressure with a falling price, a market-liquidity pull, or a holder
exodus — ONE of them on three distinct Jupiter snapshots over ≥ 6 min, corroborated) goes on to
close lower than it stood at that moment. Closing at the first would-fire would have saved SOL.

## What was known at registration (2026-11-27)
- The operator holds fresh, very volatile tokens on purpose and does not want price- or TVL-
  threshold rules to cut them; the previous such position fell to −25 % and was closed by hand
  at +18 %. They asked for a stop "when the activities … show it as unfavorable" and approved an
  operator-armed, per-position flow guard (`flow-guard.js`, `POST /command/set-flow-guard`).
- The thresholds are judgement, not replayed: no historical buy/sell flow data exists. From this
  date every counted reading is stored (`flow_readings` table, migration `009_flow_readings.sql`;
  JSONL fallback) so a later replay is possible.
- Independent review the same evening (live sampling, 10 tokens × 15 fetches): Jupiter's
  `liquidity` for WINSTON read $32.6k → $17.6k (−46 %) on one fetch with the price flat, then
  $32k again; `holderCount` equals Meteora's `base_token_holders` within 0.3 % on 10/10 tokens
  (same upstream, not a second source); snapshots repeat (`updatedAt` unchanged across fetches)
  and can be minutes old; `stats1h.priceChange` swung 35 → 19 % in 40 s. The rule below was
  hardened for these before any capture (one condition per streak, distinct fresh snapshots,
  own-value-adjusted liquidity, corroboration, on-chain price from the guard's own ring).
- Readings at registration: WINSTON-SOL 2026-11-27 15:51 UTC — 5m sell/buy 1.31×, 1h 1.01×, 1h
  −4.6 %; 16:07 UTC — 0.67×, 0.94×, +117.8 %. Neither qualifies.

## Shadow capture (ships with this registration)
`flowGuardShadowMode` off | **shadow** (no enforce: arming a position is the live path). Once
per management cycle, detached from the cycle, the default thresholds run on every open position
the operator has NOT armed (one Jupiter read per distinct base mint; skipped when > 8 mints; the
on-chain price ring is fed from the cycle's scan-row active bin). Nothing is closed. The first
would-fire per position is kept as `flow_guard_shadow` = { first_would_fire_at, condition,
corroborated_by, pnl_pct_at_fire (GROSS pnl %, trusted reading only, else null),
amount_sol_at_fire (the capital it is on), liquidity_usd, liquidity_mkt_usd, holders,
sell_buy_5m, sell_buy_1h, price_change_1h_pct, ring_change_pct, readings, last_at, count } →
perf record; one log line `[FLOW_GUARD_SHADOW] would-close …`.

## Pass rule
Registered 2026-11-27, before any capture (amended the same evening after the review, still
before any capture; frozen from here). Population `bot_and_operator` (rebalance legs out).
1. ≥ 15 would-fires with a finite `pnl_pct_at_fire`, capital and final `pnl_pct` — else
   `insufficient`. 90 days without 15 (2027-02-25) → **closed insufficient**.
2. `met` only if all three hold (like for like: gross final vs gross at the would-fire):
   (a) at least two thirds of the would-fire positions closed at a `pnl_pct` lower than
       `pnl_pct_at_fire`;
   (b) Σ over them of (`pnl_pct` − `pnl_pct_at_fire`) / 100 × `amount_sol_at_fire` < 0;
   (c) (a) and (b) still hold without the single largest contributor (the record with the most
       negative difference).

`met` → a proposal to the operator to make default arming available as a mode — never automatic.
`not_met` → the shadow stays capture-only; the guard remains an operator tool.

## Revert rule
None — no automatic path exists.

## Grading log
