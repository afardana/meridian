# Plan 01 — Deploy-timing intelligence ("best hours to deploy")

**Edge copied:** yunus's *"jam terbaik buat deploy banyak / minimalize loss"* — when to size
up vs. when to sit out, learned from history. He mined it from 30k external wallets; we
bootstrap it from **our own closed-position history**, which is higher fidelity (it's our
exact strategy, fees, and gas) and already stored.

**Status when shipped (Phase 1):** advisory only — zero behavior change. We look before we gate.

---

## Current state (verified)

- Deploys run on a **fixed cron** with **no time awareness**: screening every
  `screeningIntervalMin` ([index.js:1142](../../index.js)), management every
  `managementIntervalMin` ([index.js:1134](../../index.js)). Nothing anywhere reads
  hour-of-day or day-of-week for deploy decisions.
- Every closed position is recorded by `recordPerformance()`
  ([lessons.js:103](../../lessons.js)). The stored entry is `{ ...perf, recorded_at: <ISO
  close time>, pnl_pct, pnl_usd, range_efficiency, ... }` and `...perf` carries
  `minutes_held`, `initial_value_usd`, `fees_earned_usd`, `close_reason`, `strategy`.
- `getAllPerformance()` ([lessons.js:937](../../lessons.js)) returns the full array.
- `classifyOutcome(perf)` ([lessons.js:630](../../lessons.js)) is exported and is the
  canonical success/failure/neutral objective (fee-death-aware).
- The single chokepoint all deploys pass through is `runSafetyChecks("deploy_position",
  args)` ([executor.js:966](../../tools/executor.js)), called from `executeTool`
  ([executor.js:831](../../tools/executor.js)). This is where a future gate hooks in.

**Key derivation:** performance records store the *close* time (`recorded_at`), not the
deploy time. Deploy time ≈ `Date.parse(recorded_at) - minutes_held * 60_000`. This is exact
enough for hour bucketing. (Optionally cross-check against `pool-memory` `deploys[].deployed_at`
([pool-memory.js:132](../../pool-memory.js)), which stores the real deploy timestamp, but the
lessons store is the better source because it lets us reuse `classifyOutcome` verbatim.)

---

## Sample-size reality

At the last evolution overhaul there were ~118 closes. That supports **coarse buckets**
(e.g. 6 × 4h blocks, or 4 × 6h blocks, optionally split weekday/weekend), **not** 24
individual UTC hours (~5 samples each — noise). The analyzer must:

- Require a per-bucket minimum N (default 8) before reporting a verdict for that bucket.
- Compute a Wilson lower bound (or at least flag low-N buckets) so a 3/4 bucket doesn't read
  as "75% — best hour." Reuse the spirit of the evolution engine's significance gate.

---

## Design

New module `deploy-timing.js` (sibling of `lessons.js`), pure analytics, no writes:

```
analyzeDeployTiming({ window = 120, minBucketN = 8, bucketHours = 4 }) -> {
  buckets: [ { label, hourStart, hourEnd, n, successRate, avgPnlPct, oorRate, wilsonLow } ],
  baselineSuccessRate,
  bestBucket, worstBucket,
  currentBucket,            // bucket the wall-clock falls into right now
  verdict: { hourBucketLabel, n, successRate, vsBaseline, recommendation }  // advisory string
  enoughData: boolean       // false until total decisive closes >= ~40
}
```

Algorithm:
1. `getAllPerformance()` → keep records with finite `recorded_at` and `minutes_held`.
2. `deployAt = recorded_at - minutes_held*60_000`; `bucket = floor(getUTCHours(deployAt)/bucketHours)`.
3. `outcome = classifyOutcome(record)`; success-rate = successes / (successes+failures) per
   bucket (drop neutrals from the denominator, exactly like `successRate()` in lessons.js).
4. Wilson lower bound per bucket; mark buckets with n < minBucketN as `low_confidence`.
5. `currentBucket` from `new Date().getUTCHours()`.

> Note: `Date.now()` / argless `new Date()` are fine in app/runtime code — the ban only
> applies inside Workflow scripts. This module runs in the normal Node process.

---

## Surfacing (Phase 1 — advisory)

The screener goal is assembled at [index.js:938](../../index.js) with a header block
(`Positions: … | SOL: … | Deploy: …`). Add one advisory line right after it, e.g.:

```
DEPLOY TIMING (advisory): current 4h block 04–08 UTC historically 31% success over 11 closes
  (baseline 36%) — below average, deploy only on strong conviction.
```

- Build the verdict once per screening cycle (cheap; it's an in-memory reduce over the perf
  array) near where `weightsSummary` is computed ([index.js:934](../../index.js)).
- Gate the whole line behind `enoughData` so it never shows misleading stats early.
- Mirror the same one-liner into the daily briefing ([briefing.js](../../briefing.js)) so the
  hour-of-day profile is visible without reading logs.

Also expose a REPL/Telegram read-only command `/timing` (pattern after `/candidates` in
[index.js:2049](../../index.js)) that prints the full bucket table.

---

## Phase 2 — soft gate (only after Phase 1 confirms a real, stable edge)

Add a config block (defaults in [config.js](../../config.js), under a new `timing` section):

| Key | Default | Meaning |
|---|---|---|
| `timingGateEnabled` | `false` | master switch |
| `timingMinBucketN` | `8` | min closes before a bucket can gate |
| `timingDeadHourSuccessFloor` | `0.20` | buckets below this success-rate are "dead" |
| `timingDeadHourAction` | `"size_down"` | `"size_down"` \| `"skip"` |
| `timingSizeDownPct` | `0.5` | multiplier applied to deploy size in weak buckets |

Two enforcement options:
- **size-down (preferred):** in `computeDeployAmount()` consumers, scale the deploy by
  `timingSizeDownPct` when the current bucket is below the floor. Keeps participation, cuts
  risk — matches yunus's "minimalize loss," not "stop trading."
- **hard skip:** add a `validateDeployTiming(args)` check inside `runSafetyChecks`
  ([executor.js:966](../../tools/executor.js)) returning `{ pass:false, reason }` during dead
  hours. Simpler, blunter; log the rejection to the decision log so it's auditable.

Start with size-down + `timingGateEnabled=false`, flip on after a week of advisory data.

---

## Risks / caveats

- **Survivorship / confounding:** a "bad hour" may really be a "bad regime" we happened to
  trade in. Mitigate by also bucketing avg `volatility_at_deploy` per hour-block (from
  pool-memory deploys) so we can tell "bad hour" from "we only deploy junk at that hour."
- **Timezone:** bucket in **UTC** consistently (Solana memecoin flow is global; US/Asia
  sessions matter more than local time). Label blocks with UTC explicitly.
- **Small N forever:** if throughput stays low, Phase 2 may never have enough per-bucket data
  — that's fine, the gate stays disabled and Phase 1 advisory still informs the LLM.

---

## Validation

- Backtest in-sample: print the bucket table from current history; sanity-check that
  best/worst spread is meaningful (> ~10pp) and not driven by 1–2 buckets with n<minBucketN.
- After Phase 2 enable: compare success-rate of deploys in gated vs. ungated buckets over the
  next ~40 closes; auto-revert mindset like `evolveThresholds` if it regresses.

## Effort

- Phase 1 (module + advisory line + `/timing` + briefing): ~half a day.
- Phase 2 (config + size-down/gate + validation): ~half a day.
