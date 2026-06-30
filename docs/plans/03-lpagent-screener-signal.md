# Plan 03 — LPAgent winning-LPer signal in the autonomous screener

**Edge copied:** yunus's *"30k wallet dianalyze buat nentuin … playstyle, apakah tight atau
wide."* He built wallet-behavior infra from scratch. We mostly **already have it** — the
LPAgent API behind `study.js` returns winning-LPer playstyle, range width, hold time, and win
rate per pool. The gap is purely **wiring**: that data is only reachable via manual/GENERAL
tool calls and never reaches the autonomous screener.

This is the cheap version of the dataset edge. (The heavy version — polling hundreds of
wallets ourselves into a new store — is Tier 2 and only worth it if this proves out.)

---

## Current state (verified)

- `studyTopLPers({ pool_address, limit })` ([study.js:7](../../tools/study.js)) hits LPAgent's
  `/top-lp/{pool}` + `/study-top-lp/{pool}` and returns:
  - `patterns.suggested_style` (server's recommendation), `patterns.preferred_range_styles`
    (count map, e.g. `{tight: 3, wide: 1}`), `patterns.preferred_strategies`,
    `patterns.avg_hold_hours`, `patterns.scalper_count`, `patterns.holder_count`,
    `patterns.avg_open_pnl_pct`, `patterns.avg_roi_pct`.
  - `lpers[].summary` per top LPer: `preferred_range_style`, `win_rate`, `avg_hold_hours`,
    `avg_open_pnl_pct`, `fee_pct_of_capital`.
  - `lpers[].positions[].range_width_pct` (= LPAgent `widthBins`) — concrete tight/wide data.
- It's wired as a tool only in the **`study` intent set** ([agent.js:48](../../agent.js)) and
  the executor map ([executor.js:367-368](../../tools/executor.js)). It is **NOT** in
  `SCREENER_TOOLS` ([agent.js:11](../../agent.js)), so the autonomous screening cycle never
  calls it.
- The screener already does deterministic per-candidate enrichment in the recon loop
  ([index.js:730-745](../../index.js)) — smart-wallets (`sw`), narrative (`n`), token-info
  (`ti`), pool-memory (`mem`) — and renders one line each into the candidate block
  ([index.js:856-932](../../index.js)), using `formatX(...)` helpers (e.g. `formatPoolSimLine`,
  `formatOrganicMomentum`).
- **Rate limit:** both LPAgent endpoints return **429** with a "wait 60s" error
  ([study.js:15](../../tools/study.js), [study.js:22](../../tools/study.js)); the server caches
  owner aggregates ~30m.

---

## Design — deterministic enrichment (preferred over giving the LLM a new tool)

Mirror exactly how `sw/n/ti/mem` are fetched and rendered. No new SCREENER tool, no extra
LLM round-trips, no tool-reliability risk.

### 1. Fetch (in the recon loop, [index.js:730](../../index.js))

The loop currently runs over **all 10** candidates. LPAgent is rate-limited, so **do not**
study all 10. Study only the candidates that survive the hard + gas filters (the `passing`
set, [index.js:771](../../index.js)/[index.js:789](../../index.js)) — typically 1–4 pools —
and cap at `lpStudyMaxPools` (default 4). Add a small client-side cache keyed by pool with a
~30m TTL (matches the server cache) so repeated cycles don't re-hit the API; reuse the
caching shape already in `smart-wallets.js`.

```js
// after `passing` is finalized, before building candidateBlocks:
const lpStudies = {};
if (config.screening.lpStudyEnabled) {
  for (const { pool } of passing.slice(0, config.screening.lpStudyMaxPools ?? 4)) {
    lpStudies[pool.pool] = await studyTopLPers({ pool_address: pool.pool, limit: 4 })
      .catch(() => null);                 // 429 / no-data → just omit the line
    await new Promise(r => setTimeout(r, 250)); // gentler than the 150ms recon spacing
  }
}
```

### 2. Render (a `formatTopLperStyle` helper + one line in the block)

Add to the candidate block at [index.js:892-906](../../index.js) (and the gmgn branch),
alongside `simLine`/`momentumLine`:

```
top_lpers: 4 winners — style=tight (3/4), ~42 bins, hold 5.1h, win 71%, open_pnl +6.3% [suggested: tight]
```

Helper returns `null` when the study is missing/empty so `.filter(Boolean)` drops it cleanly.
Mark it `*_untrusted` if it ever interpolates server free-text; the numeric fields here are
safe, but keep style labels to a known enum.

### 3. Stage it for learning (optional, recommended)

In the Darwinian `stageSignals(...)` call ([index.js:912](../../index.js)), add
`lper_suggested_style`, `lper_avg_win_rate`, `lper_style_consensus` so we can later validate
"did matching the winning style improve our outcome?" the same way `analyzeFeeEfficiencyOutcomes`
validates fee-efficiency rank → PnL.

---

## Config keys (defaults in [config.js](../../config.js), `screening` section)

| Key | Default | Meaning |
|---|---|---|
| `lpStudyEnabled` | `true` | fetch LPAgent study for passing candidates |
| `lpStudyMaxPools` | `4` | cap API calls per cycle (rate-limit guard) |
| `lpStudyMinWinnersForStyle` | `3` | need ≥N winners agreeing before treating `suggested_style` as actionable |

---

## Pairing with #2 (playstyle)

Once the line is in front of the screener, the next step (Phase 2 of #2) is to let
`suggested_style` actually steer width:
- If `preferred_range_styles` shows a confident consensus (≥ `lpStudyMinWinnersForStyle`) and
  it disagrees with the global `playstyle`, the prompt can instruct the agent to compute
  `bins_below` from the LPAgent style for *that* deploy (tight → near `minBinsBelow`, wide →
  near `maxBinsBelow`). `deploy_position` already accepts an explicit `bins_below`, so no tool
  change is needed — only prompt wording + the safety clamp (still ≥ 35).
- Keep it **advisory** until staged-signal validation shows style-matching lifts the
  `classifyOutcome` success-rate.

---

## Risks / caveats

- **Rate limits are the main hazard.** Studying only `passing` (post-filter) + a per-cycle cap
  + client cache keeps us well under the limit. Never study the raw 10. A 429 must degrade
  silently (omit the line), never fail the cycle — hence the `.catch(() => null)`.
- **Latency:** ~250ms × up to 4 pools = ~1s added to a screening cycle that already runs
  sequential recon. Acceptable for a 30-min cadence; if it bites, fetch the studies in a
  bounded `Promise.allSettled` instead of the serial loop.
- **Data sparsity:** new/thin pools return `"No LPAgent top LPer data found"` — common for the
  fresh memecoins we target. The line simply won't render; that absence is itself a mild
  signal (no established winners yet).
- **Untrusted text:** treat any LPAgent string fields as untrusted (same rule as narratives) —
  prefer numeric/enum fields in the rendered line.

---

## Validation

- Dry-run a screening cycle (`DRY_RUN=1`) and confirm the `top_lpers:` line renders for pools
  with data and is absent (no error) for pools without.
- Confirm total LPAgent calls per cycle ≤ `lpStudyMaxPools` via logs.
- After a few weeks, run a staged-signal analysis: deploys where we matched `suggested_style`
  vs. where we didn't → success-rate delta. That number decides whether #2-Phase-2 (auto style
  selection) is worth turning on.

## Effort

~half a day (fetch loop + `formatTopLperStyle` helper + 2 block edits + config keys + cache).
Phase 2 auto-style-selection rides on Plan 02 and is a separate, later increment.
