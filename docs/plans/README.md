# Meridian — "Find the Edge" plan set

Three implement-ready plans inspired by yunus's June post on his multi-agent DLMM fleet.
The post named two concrete edges he mined from a 30k-wallet dataset — **best deploy
hours** and **tight-vs-wide playstyle** — plus a 5-agent fleet behind an orchestrator.

This plan set deliberately copies the **cheap, single-wallet, high-leverage** parts first.
The fleet/orchestrator is intentionally *not* planned here yet — it is capital-gated (at
~0.5 SOL positions, splitting across 5 wallets fragments already-small capital and 146
deploys/day would be dominated by gas + exit-swap slippage, which our own PnL already
under-captures). Revisit the fleet only after these three move the success rate.

## What yunus has vs. what we have

| yunus capability | Meridian today | Plan |
|---|---|---|
| Best deploy hours (temporal alpha) | Zero time-of-day awareness; fixed cron only | [01 — deploy timing](01-deploy-timing.md) |
| Tight vs wide playstyle | One hardcoded volatility curve | [02 — playstyle modes](02-playstyle-modes.md) |
| 30k-wallet behavior dataset | `study.js`/LPAgent already serves winning-LPer playstyle, width, hold-time — but only on manual/GENERAL calls, never in the autonomous screener | [03 — LPAgent screener signal](03-lpagent-screener-signal.md) |
| 5-agent fleet + orchestrator | One wallet; `lessons.js evolveThresholds` is a single-strategy orchestrator analog | deferred (capital-gated) |

## Recommended build order

1. **#1 deploy timing — advisory first.** Pure analytics over data we already store
   (`getAllPerformance()`). Ships with **no behavior change** so we can confirm our own
   history even *has* an hour-of-day edge before gating anything on it.
2. **#3 LPAgent screener signal.** Surfaces an existing API into the autonomous screener.
   Pairs with #2 (tells the agent what width is winning *on this pool*).
3. **#2 playstyle modes.** Makes tight/balanced/wide a selectable mode. Most valuable once
   #3 can recommend a style per pool.

Each can ship independently; this order maximizes information before we change deploy behavior.

## Shared conventions (apply to all three)

- **No raw JSON reads under `pg`.** Always go through a module's exports (e.g.
  `getAllPerformance()`, `getPoolMemory()`), never `fs.readFile("*.json")` — see CLAUDE.md
  "Adding a New Persisted Store" gotcha #5.
- **Reuse `classifyOutcome(perf)`** ([lessons.js:630](../../lessons.js)) as the success
  objective everywhere. Never re-derive "win = pnl > 0" — a fee-death is a failure.
- **Hard floor `MIN_SAFE_BINS_BELOW = 35`** ([config.js:22](../../config.js)) is inviolable;
  any new range path must clamp to it.
- **The `bins_below` formula lives in TWO prompt locations** — [prompt.js:154](../../prompt.js)
  and the screener STEPS block at [index.js:951](../../index.js) — plus the `dlmm.js` clamp
  fallback. Any range change must touch all three or the prompt and execution diverge.
- New config keys flow through `config.js` defaults **and** the `update_config` tool
  allow-list so the agent can tune them at runtime.
