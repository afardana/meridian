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
default thresholds (sell pressure with a falling price, a liquidity pull, or a holder exodus;
three qualifying readings over ≥ 6 min with a second source agreeing) goes on to close lower
than it stood at that moment. Closing at the first would-fire would therefore have saved SOL.

## What was known at registration (2026-11-27)
- The operator holds fresh, very volatile tokens on purpose and does not want price- or TVL-
  threshold rules to cut them; the previous such position fell to −25 % and was closed by hand
  at +18 %. They asked for a stop "when the activities … show it as unfavorable" and approved an
  operator-armed, per-position flow guard (`flow-guard.js`, `POST /command/set-flow-guard`).
- The thresholds are judgement, not replayed: no historical buy/sell flow data exists. From this
  date every usable reading is stored (`flow_readings` table, migration `009_flow_readings.sql`;
  JSONL fallback) so a later replay is possible.
- The only reading at registration: WINSTON-SOL (7Y2CVbnq…pump) 2026-11-27 15:51 UTC — 5m
  sell/buy 1.31×, 1h 1.01×, 1h price −4.6 %, liquidity $22.7k, 1,794 holders; 16:07 UTC — 5m
  0.67×, 1h 0.94×, 1h +117.8 %. Neither qualifies under the defaults.

## Shadow capture (ships with this registration)
`flowGuardShadowMode` off | **shadow** (no enforce: arming a position is the live path). Once
per management cycle, on every open position the operator has NOT armed, the default thresholds
run on the same Jupiter datapi reading (one read per distinct base mint; skipped when > 8 mints),
with the pool's active bin from the cycle's scan row and Meteora's holder count from the pool row
as the second sources. Nothing is closed. The first would-fire per position is kept as
`flow_guard_shadow` = { first_would_fire_at, condition, confirmed_by, pnl_pct_at_fire (trusted
reading only, else null), amount_sol_at_fire, liquidity_usd, holders, sell_buy_5m, sell_buy_1h,
price_change_1h_pct, readings, last_at, count } → perf record; one log line
`[FLOW_GUARD_SHADOW] would-close …`.

## Pass rule
Registered 2026-11-27, before any capture. Population `bot_and_operator` (rebalance legs out).
1. ≥ 15 would-fires with a finite `pnl_pct_at_fire`, capital and `pnl_sol_net` — else
   `insufficient`. 90 days without 15 (2027-02-25) → **closed insufficient**.
2. `met` only if all three hold:
   (a) at least two thirds of the would-fire positions closed at a PnL lower than `pnl_pct_at_fire`;
   (b) Σ over them of (final `pnl_sol_net` − `pnl_pct_at_fire` / 100 × their capital) < 0;
   (c) (a) and (b) still hold without the single largest contributor (the record with the most
       negative difference).

`met` → a proposal to the operator to make default arming available as a mode — never automatic.
`not_met` → the shadow stays capture-only; the guard remains an operator tool.

## Revert rule
None — no automatic path exists.

## Grading log
