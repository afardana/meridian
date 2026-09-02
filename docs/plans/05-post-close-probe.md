# Plan 05 — Post-Close Outcome Probe

**Status:** IMPLEMENTED 2026-07-05, shipped ON (read-only — see §8 justification). Scoring
verified against 7 edge cases (good/early/flat/marginal/anchor-fallback/delisted/no-data).
Landed alongside: MFE/MAE + bin-excursion path features on closed positions (P1) and the
bin-drift line in the MANAGER LLM context (P5). §4.2 evolution wiring remains deferred.
**Author:** design pass, 2026-07-05.
**Scope:** one scan-based amender wired into the existing management cycle; reuses the
existing `getPoolDetail` pool-discovery call and the existing `recordExitSwapOutcome`
"amend-a-perf-record-after-the-fact" pattern. **No new tool, no new persistence store, no
new timer, no new external API.**

---

## 1. Problem statement — what we can't currently see, and what data answers it

Meridian closes positions on a handful of exit rules but has **zero ground truth on whether
any of them exit at the right moment**. Every exit-timing knob today is tuned by intuition:

| Exit rule | Knob | Current value (prod) | The nagging question |
|-----------|------|----------------------|----------------------|
| Time-based OOR-below close | `outOfRangeWaitMinutesBelow` | 60m | Do we hold too long (token keeps dumping → we should exit faster) or bail too early (token wicks back → we sold the bottom)? |
| Price-crash fast-path (plan #04) | `crashBinsPerMin`, `crashConfirmTicks`, … | OFF/shadow | When the detector *would* fire, does the token actually keep falling (fast exit justified) or bounce (false rug, we'd have realized a loss for nothing)? |
| Trailing take-profit / peak-drop | `trailingStop*` | — | After a TP close, does price keep ripping (we left money on the table) or roll over (good exit)? |
| OOR-above / anti-LVR close | `outOfRangeWaitMinutesAbove` | — | After an up-and-out close, does the token continue up (early) or mean-revert (correct)? |

The one piece of information that answers **all** of these is the same: **what did the token
price do in the minutes *after* we closed?** We already capture the exit price proxy at close
(`exit_mcap`, from `token_x.market_cap` — fixed supply ⇒ mcap ∝ price). We just never look at
the price *again*. This plan samples it at **~30 / ~60 / ~180 min post-close** and records the
% change vs the exit point on the closed-position performance record.

### The core scoring intuition

- Token keeps **falling** after we close → **good exit** (we "saved" that downside). Especially
  validating for a stop-loss or an OOR-below close: the thing was genuinely dying.
- Token **rips back up** after we close → **early exit** (we "missed" that upside). Especially
  damning for an OOR-below close: we sold the bottom on a wick.

Directionality is close-reason-dependent (see §3 for the sign convention) — a rip-back is *bad*
after a downside stop, but merely *neutral* after a deliberate TP.

### Why now / why cheap

- The pool-discovery API call is **already made** every management cycle for open-position pool
  health (`getPoolDetail`, index.js ~423). The probe reuses the exact same call for closed pools.
- The amend pattern already exists and is proven: `recordExitSwapOutcome` (lessons.js ~263)
  finds a perf record by `position` and writes a sub-object additively.
- Read-only + bounded (§2) ⇒ safe to ship **ON** (argued in §8).

---

## 2. Design — scan-based scheduler, probe function, record shape

**Design steer honored:** the agent restarts constantly (PM2, deploys), so `setTimeout`-based
scheduling would drop probes across every restart. Instead the probe is **scan-based and
idempotent**: on each management cycle, scan the recent perf records for closes whose age has
crossed a probe threshold *and* which lack that probe field, fetch once, amend. Restart-safe by
construction — a probe missed during a restart is simply picked up on the next cycle whose scan
window still covers it.

### 2.1 Where it runs

Inside `runManagementCycle`, in the `try` block, **after** the exit/close logic and **before**
the post-management screening trigger (index.js ~620, right after the `hadOorAboveClose`
computation). This placement:
- Runs every management cycle (prod 3m cadence — fine granularity for 30/60/180 targets).
- Is inside the single-writer context (the mgmt cycle is the sole writer of perf records; see
  CLAUDE.md "Race Condition"). No cross-process write race.
- Is wrapped in its own try/catch so a probe failure never touches the close/screening path (§6).

### 2.2 The scan (bounded)

```
recent = getAllPerformance()                    // full list, but we filter hard:
for each perf in recent, newest-first:
  age_min = (now - Date.parse(perf.recorded_at)) / 60000
  if age_min > SCAN_MAX_AGE_MIN (= max(probeMinutes) + 60, ≈ 240)   → stop scanning (list is
                                                                       append-ordered; older
                                                                       records are all done)
  if perf.post_close?.complete                                        → skip (all probes done)
  if perf.exit_mcap == null                                          → mark unprobeable, skip (§3)
  for each M in postCloseProbeMinutes (= [30,60,180]):
    key = "m"+M
    if perf.post_close?.[key] != null                                → skip (idempotent)
    if age_min >= M and age_min < M + PROBE_GRACE_MIN (= 20):         → DUE now → probe this M
```

Bounds keep the scan O(a-few-records): the `SCAN_MAX_AGE_MIN` early-stop means we only ever
touch closes from the last ~4h, and the per-probe `complete` flag + grace window mean each
(record, M) pair is fetched **at most once** (a probe whose grace window elapsed without a
successful fetch is recorded as `stale`, not retried forever — see §3 edge cases). At most one
pool-discovery fetch per due (record, M) pair per cycle; in steady state that's 0–2 fetches/cycle.

### 2.3 The probe function (new, in lessons.js or a tiny `post-close-probe.js`)

Placed alongside the amend machinery. Reuses `getPoolDetail` (throws on 404 → caught):

```js
// probePostClose(perf, minute, poolDetailFn) → amends perf.post_close[`m${minute}`]
//   poolDetailFn injected for testability; in prod = getPoolDetail from tools/screening.js
const detail = await poolDetailFn({ pool_address: perf.pool, timeframe: "5m" });
const mcapNow = parseFloat(detail?.token_x?.market_cap) || null;
```

Then the amend goes through the module's `load()`/`save()` (never raw fs — CLAUDE.md store
rule), find-by-position exactly like `recordExitSwapOutcome`.

### 2.4 Record shape

`perf.post_close` sub-object, additive (canonical `pnl_pct`/`pnl_usd` untouched — already
consumed by lessons/evolve at record time):

```jsonc
"post_close": {
  "exit_mcap": 412000,          // copy of the baseline for self-containment
  "m30":  { "mcap": 388000, "pct": -5.8, "at": "2026-07-05T12:31:04Z" },
  "m60":  { "mcap": 350000, "pct": -15.0, "at": "..." },
  "m180": { "mcap": 190000, "pct": -53.9, "at": "..." },
  "complete": true,             // set once every M is filled OR marked stale
  "exit_quality": { ... },      // derived once complete — see §3
  "exit_review_notified_at": "...", // Telegram review emitted at its anchor write
  "exit_review_anchor": "m60"   // m60 normally; m180 fallback when m60 is stale
}
```

The Telegram `Exit review` is intentionally decoupled from `complete`: it is
emitted when the primary m60 slot is written (or the m180 fallback is written
after m60 was missed). Longer configured slots such as m720/m1440 remain
analytics-only and cannot replay an older m60 result when they complete.

- `pct` = `(mcap / exit_mcap - 1) * 100`, rounded to 0.1. Positive = price rose after close.
- `at` = ISO timestamp of the probe (so a probe that fired late, e.g. after a restart at m=48
  for the m30 slot, is auditable — the `pct` is still keyed under `m30` but `at` shows when).
- A slot that could not be resolved is written as `{ "mcap": null, "pct": null, "status": "stale"|"delisted" }` (§3).

---

## 3. Exit-quality scoring — the derived metric

Computed **once**, when `post_close.complete` flips true (all probe slots resolved or stale),
by a pure function `scoreExitQuality(perf)`. Written to `perf.post_close.exit_quality`.
The Telegram review uses the same scoring semantics but is emitted at the
anchor probe write, rather than waiting for every configured long-horizon slot.

### 3.1 Sign convention (close-reason-aware)

Define the **anchor horizon** as m60 if present-and-valid, else m180, else m30 (first valid,
longest-preferred). Let `p = post_close[anchor].pct` (the post-close price move, % ).

A close is either a **downside exit** (we got out of something falling) or a **profit-taking /
upside exit**. Classify from `close_reason`:

```
downsideExit = reason matches /stop loss|oor|out of range|below|crash|volume|yield/i
             (i.e. the same failure-ish family classifyOutcome already keys on)
```

Then:

| Case | Metric | Meaning |
|------|--------|---------|
| downsideExit, `p < 0` | `saved_pct = -p` (positive) | Good exit — token kept dumping, we dodged it |
| downsideExit, `p > 0` | `missed_pct = p` (positive) | Early exit — token bounced, we sold the bottom |
| upsideExit (TP/above), `p > 0` | `missed_pct = p` | Left money on the table — kept ripping |
| upsideExit, `p < 0` | `saved_pct = -p` | Good exit — took profit before the rollover |

Plus a single categorical verdict for at-a-glance rollups:

```
verdict =
  |p| < FLAT_PCT (=3)          → "flat"        (nothing to learn — mean noise)
  saved_pct >= GOOD_PCT (=8)   → "good_exit"
  missed_pct >= MISS_PCT (=8)  → "early_exit"
  else                          → "marginal"
```

`exit_quality = { anchor: "m60", move_pct: p, saved_pct, missed_pct, verdict }`
(only one of `saved_pct`/`missed_pct` is set; the other is 0/null).

### 3.2 Edge cases (defined precisely)

| Situation | Detection | Handling |
|-----------|-----------|----------|
| `exit_mcap` null/0 at close | already on perf record | Set `post_close = { complete: true, exit_quality: { verdict: "unprobeable" } }` immediately in the scan; never fetch. Can't compute a ratio without a baseline. |
| Pool delisted / 404 from API | `getPoolDetail` throws | Slot → `{ status: "delisted", pct: null }`. A delisting *is itself signal* (token likely dead) but we do NOT synthesize a price — we record the fact. If the anchor slot is delisted, verdict = `"delisted"` (treated as a strong good_exit qualitatively in §4 rollups but kept distinct). |
| `market_cap` present but 0/null in payload | `parseFloat(...) || null` | Same as delisted: `{ mcap: null, pct: null, status: "delisted" }` for that slot (a 0 mcap is effectively a dead pool). |
| Token migrated (new pool, mcap on a different pair) | pool_address 404s on the *old* pool | Falls into delisted handling — acceptable; we track the pool we held, not the token's afterlife. Documented limitation, not a bug. |
| Probe slot missed its grace window (restart gap > `M + PROBE_GRACE_MIN`) | `age_min >= M + PROBE_GRACE_MIN` and slot still empty | Write `{ status: "stale", pct: null }`, count it as resolved so `complete` can flip. Prevents indefinite re-scanning of ancient records. |
| All slots stale/delisted | in `scoreExitQuality` | verdict = `"delisted"` if any delisted, else `"no_data"`. |
| Mcap feed noise (thin pool, mcap jumps on one wick) | inherent | m60/m180 anchoring (not m30) damps single-tick noise; `FLAT_PCT` floor discards small moves. Accepted as advisory-grade. |

---

## 4. How consumers use it

### 4.1 Telegram `/exits` command + briefing line (this plan)

New `/exits` command (index.js, alongside `/timing` ~3009) — a pure read over
`getAllPerformance()` filtered to records with `post_close.exit_quality`. Summarizes recent exit
quality **by `close_reason` family**, e.g.:

```
Exit quality (last 30 closes with probes)

stop_loss    n=8   good 5 / early 1 / flat 2   avg saved +18.4%
oor_below    n=11  good 3 / early 6 / flat 2   avg missed +12.1%   ⚠ selling bottoms
trailing_tp  n=4   good 1 / early 3           avg missed +9.8%
```

The `⚠ selling bottoms` heuristic fires when, within a reason family, `early_exit` count >
`good_exit` count AND n ≥ 6 — the exact fingerprint that says a wait-minutes knob is too tight.
A one-line condensed version (worst-offending family) goes into the daily briefing
(briefing.js ~56, next to `getPerformanceSummary()`), rendered via the existing solMode-safe
formatting (these are percentages, not `$`/SOL amounts, so no unit landmine).

A `getExitQualitySummary()` getter in lessons.js (mirroring `getPerformanceSummary`) does the
grouping so both `/exits` and the briefing share one code path.

### 4.2 Future: `evolveThresholds` input (advisory only in THIS plan)

**Not wired into evolution in this plan** — explicitly advisory. The intended future use, noted
here so the record shape is forward-compatible: within the OOR-below reason family, a persistent
`avg missed_pct` well above `avg saved_pct` over a recency window is direct evidence that
`outOfRangeWaitMinutesBelow` (and/or the plan #04 crash thresholds) is too aggressive and should
*rise*; the inverse (persistent `saved_pct`) argues it should *fall*. That would slot into
`evolveThresholds` (lessons.js ~405) as a new signal-consumer alongside
`analyzeOrganicMomentumOutcomes`, gated on ≥ N decisive probed closes. Deferred deliberately:
we want a week+ of `exit_quality` data (and a human read of `/exits`) before letting it move a
capital-critical knob autonomously. This plan only *produces and surfaces* the metric.

---

## 5. Patch sketch (file:line anchored — do NOT apply)

Five touch points, ~85 lines total.

**(a) config.js** — after the crash-fast-path block (~281), add to `management`:
```js
// ── Post-close outcome probe (plan #05) — read-only, samples token price after close.
postCloseProbeEnabled:  u.postCloseProbeEnabled  ?? true,   // safe ON: read-only + bounded (§8)
postCloseProbeMinutes:  u.postCloseProbeMinutes  ?? [30, 60, 180],
```

**(b) tools/executor.js** — in `CONFIG_MAP` (~500, after the crash keys):
```js
postCloseProbeEnabled: ["management", "postCloseProbeEnabled"],
// postCloseProbeMinutes intentionally NOT tunable via update_config (array value); edit user-config.json.
```

**(c) lessons.js** — new exports near `recordExitSwapOutcome` (~288). Constants at top with the
other tunables (`SCAN_MAX_AGE_MIN`, `PROBE_GRACE_MIN=20`, `FLAT_PCT=3`, `GOOD_PCT=8`, `MISS_PCT=8`).
```js
// Idempotent single-slot amend — mirrors recordExitSwapOutcome's find-by-position + save().
export function recordPostCloseProbe(position, minute, { mcap = null, status = null } = {}) {
  const data = load();
  let rec = null;
  for (let i = data.performance.length - 1; i >= 0; i--) {
    if (data.performance[i].position === position) { rec = data.performance[i]; break; }
  }
  if (!rec) return false;
  rec.post_close ||= { exit_mcap: rec.exit_mcap ?? null };
  const key = `m${minute}`;
  if (rec.post_close[key] != null) return false; // idempotent
  const base = rec.post_close.exit_mcap;
  const pct = (mcap != null && base > 0) ? Math.round((mcap / base - 1) * 1000) / 10 : null;
  rec.post_close[key] = status ? { mcap, pct: null, status } : { mcap, pct, at: new Date().toISOString() };
  // complete when every configured slot is resolved (value or status)
  const mins = (config?.management?.postCloseProbeMinutes) || [30, 60, 180]; // import lazily or pass in
  if (mins.every((m) => rec.post_close[`m${m}`] != null)) {
    rec.post_close.complete = true;
    rec.post_close.exit_quality = scoreExitQuality(rec);
  }
  save(data);
  return true;
}

export function markPostCloseUnprobeable(position) { /* set post_close.complete + verdict:"unprobeable" */ }
export function scoreExitQuality(perf) { /* §3 pure function */ }
export function getExitQualitySummary({ limit = 30 } = {}) { /* §4.1 grouping by reason family */ }
```
> Note: `recordPostCloseProbe` needs `config.management.postCloseProbeMinutes`. lessons.js already
> lazily `await import("./config.js")` inside `recordPerformance`; here the value is read
> synchronously, so either import `config` at module top (it's already a live singleton object,
> safe) or pass `minutes` in from the caller. Prefer passing `minutes` in to keep lessons.js's
> current import shape.

**(d) index.js** — `runManagementCycle`, inside the `try`, after `hadOorAboveClose` (~621),
before the screening trigger. The whole block in its own try/catch (§6):
```js
if (config.management.postCloseProbeEnabled) {
  try { await runPostCloseProbes(); }
  catch (e) { log("probe_warn", `Post-close probe pass failed (non-fatal): ${e.message}`); }
}
```
And a module-scope async helper (near the other cycle helpers) implementing the §2.2 scan:
```js
async function runPostCloseProbes() {
  const mins = config.management.postCloseProbeMinutes || [30, 60, 180];
  const maxAge = Math.max(...mins) + 60, grace = 20;
  const now = Date.now();
  for (const perf of [...getAllPerformance()].reverse()) {   // newest-first
    const age = (now - Date.parse(perf.recorded_at)) / 60000;
    if (!Number.isFinite(age)) continue;
    if (age > maxAge) break;                                  // early-stop (append-ordered)
    if (perf.post_close?.complete) continue;
    if (perf.exit_mcap == null) { markPostCloseUnprobeable(perf.position); continue; }
    for (const m of mins) {
      if (perf.post_close?.[`m${m}`] != null) continue;
      if (age < m) continue;
      if (age >= m + grace) { recordPostCloseProbe(perf.position, m, { status: "stale" }); continue; }
      try {
        const d = await getPoolDetail({ pool_address: perf.pool, timeframe: "5m" });
        recordPostCloseProbe(perf.position, m, { mcap: parseFloat(d?.token_x?.market_cap) || null });
      } catch { recordPostCloseProbe(perf.position, m, { status: "delisted" }); }
    }
  }
}
```

**(e) index.js** — `/exits` Telegram command (~3009, next to `/timing`) + one briefing line in
briefing.js (~56), both reading `getExitQualitySummary()`. ~15 lines.

---

## 6. Failure containment

- The entire probe pass is wrapped in try/catch at the call site (patch d) — a throw is logged
  as `probe_warn` and the management cycle continues to the screening trigger untouched. The
  probe runs **after** all close/claim/exit actions, so even a synchronous bug can't delay an exit.
- Per-fetch failures (`getPoolDetail` throws on 404 / network) are caught individually and turned
  into a `delisted` slot — one dead pool never aborts the scan for other records.
- `save()` goes through the doc-store's ordered write-through (same as `recordExitSwapOutcome`);
  a crash mid-scan loses at most the in-flight slot, which the next cycle re-probes (idempotent).
- No unbounded work: `SCAN_MAX_AGE_MIN` early-stop + per-slot `complete`/grace bound the fetch
  count to 0–2/cycle in steady state; a backlog after a long outage drains a few records/cycle.
- Read-only: the probe issues GETs and writes only the additive `post_close` field. It cannot
  close, claim, swap, or deploy.

---

## 7. Regression-risk table (per touched block)

| Block | Change | Risk | Mitigation |
|-------|--------|------|------------|
| config.js `management` | +2 keys, defaults | none — additive, `??`-guarded | `postCloseProbeEnabled` default true is the only behavioral default; §8 argues it |
| executor.js `CONFIG_MAP` | +1 tunable key | none | array key deliberately excluded from update_config |
| lessons.js new exports | +4 pure/amend fns | low — additive; touches perf records only via existing load/save + find-by-position | mirrors proven `recordExitSwapOutcome`; canonical `pnl_*` never rewritten |
| lessons.js record shape | new `post_close` field | low — consumers use `?.` optional-chaining; older records simply lack it | `getExitQualitySummary` filters to records that have it |
| index.js probe pass | +1 awaited call in mgmt try-block | **medium** (money path) | own try/catch; runs after all exit actions; read-only; bounded fetch count |
| index.js `runPostCloseProbes` | new async helper | low | pure scan + guarded fetches; no writes to on-chain state |
| index.js `/exits` + briefing.js | read-only surfaces | none | pure reads; solMode-safe (percentages, no `$`) |

The only medium-risk item is the added `await` inside the management cycle: it adds up to a few
serial `getPoolDetail` calls (network) before the screening trigger. Cap the pass with the §2.2
bounds; if latency ever matters, the `await` could be fire-and-forget (`void runPostCloseProbes()`)
since nothing downstream depends on it — but the awaited form keeps it inside the cycle's single-
writer window, which is preferable for correctness. Ship awaited.

---

## 8. Rollout

**Ships ON** (`postCloseProbeEnabled: true`). Justification vs. plan #04's ship-OFF stance: #04
adds an **autonomous close** (capital action) so it earned a shadow period; this plan is
**read-only** (GETs + an additive analytics field), bounded, and fully contained (§6). There is
nothing to shadow — the metric it produces IS the calibration data, and it can't misfire into a
trade. Instant disable via `update_config postCloseProbeEnabled=false` (no restart).

### What to grep (first week)

- `probe_warn` in the daily logs → any fetch-pass failures (expect ~none; a burst means the
  pool-discovery API is flaky).
- `post_close` presence: `getAllPerformance()` records closed >180m ago should have
  `post_close.complete=true`. A record stuck incomplete past ~4h ⇒ scan early-stop is dropping it
  (tune `SCAN_MAX_AGE_MIN`) or every probe went `stale` (mgmt cycle wasn't running — check PM2).
- `/exits` output after ~15–20 closes accumulate probes.

### Interpreting the first week

1. **Per-reason verdict split** is the headline. For `oor_below`: if `early_exit` ≫ `good_exit`,
   `outOfRangeWaitMinutesBelow=60` is **too tight** — we're selling bottoms; that's the case for
   raising it (or, conversely, for *enabling* the plan #04 fast-path only on genuine crashes so
   ordinary wicks stop triggering slow closes). If `good_exit` ≫ `early_exit`, the wait is well-
   tuned or could even shorten.
2. **`stale`/`delisted` rate.** A high `delisted` share within downside closes is *itself*
   validation — those tokens died, so our exits were correct even without a price ratio.
3. **Cross-check against plan #04 `crash_shadow` lines.** For closes where the crash detector
   *would* have fired, the `post_close` trajectory (kept dumping vs. bounced) is the ground truth
   on whether enabling the fast-path would have helped or hurt — the two datasets combine into
   the enable/tune decision for #04.
4. Only after this human read is comfortable do we consider §4.2 (wiring `exit_quality` into
   `evolveThresholds`) in a follow-up plan.
