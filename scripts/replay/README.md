# Shadow-Replay Harness (`scripts/replay/`)

An **offline, read-only** analysis tool that answers one question:

> **Would different exit-knob settings have changed PnL on positions we actually held?**

The live learning loop (`lessons.evolveThresholds`, post-close probes) sees only
~1–2 closes/day. This harness multiplies the effective sample rate by *replaying
recorded position history against counterfactual exit-rule settings* — so an
operator can calibrate `outOfRangeWaitMinutesBelow`, trailing-TP, stop-loss, and
the crash fast-path from the paths positions actually walked, instead of waiting
weeks for enough live closes.

**Zero runtime footprint.** Nothing here runs in the live agent. Both scripts are
pure *consumers* of the existing stores (`lessons.getAllPerformance`,
`pool-memory.getPoolSnapshots`) — they never call any store's `.set()`/`save()`.

---

## Two steps

```
node scripts/replay/extract.js --summary   # 1. build the dataset from the stores
node scripts/replay/replay.js  --verbose    # 2. replay counterfactual rules
```

Or via npm:

```
npm run replay:extract     # extract.js --summary
npm run replay:run         # replay.js
```

### 1. `extract.js` — build `dataset.json`

Loads `.env` via `envcrypt.js` **first** (critical — see "Backend selection"
below), primes the persistence caches exactly like `cli.js`, then joins:

- **closed-position performance records** (`lessons.getAllPerformance()`) — the
  realized outcome + path features (`mfe_pnl_pct`, `mae_pnl_pct`, `max_bins_below/above`,
  `peak_pnl_pct`) + post-close probes (`post_close`);
- **per-position pool snapshot series** (`pool-memory.getPoolSnapshots(pool)`,
  filtered to the position's own `position` field; fallback for position-less
  snapshots: ts inside the hold window ±10 m, `join_method: "time_window"`) —
  the ~3–10 min-cadence time series of `pnl_pct` / `active_bin` / `lower_bin` /
  `in_range` / `minutes_out_of_range` / …

…into a normalized `scripts/replay/dataset.json`. `--summary` prints coverage
(n positions, n with a snapshot series, n with bin-era fields, n with path
features, n with post-close probes, n dense-enough for the crash rule, date
range, join-outcome counts, and the **resolved persistence backend**).
`--diagnose` prints a per-position row with the join/exclusion reason
(`ok | no_pool_addr | no_pool_entry | no_matching_position_snaps | too_few_snaps`),
join method, snapshot/bins counts and cadence — run this first whenever coverage
looks wrong.

#### Backend selection (a real bug this README exists to prevent)

`db/pool.js usePg()` reads `process.env.PERSIST_BACKEND`, which is only set by
`envcrypt.js`'s import-time `loadEnv()` (it reads the repo `.env`). `index.js`
and `cli.js` import `envcrypt.js` as their first module; a script that doesn't
**silently falls back to the legacy JSON files** — which on the VM are a stale
cold copy frozen at the 2026-06-18 pg cutover (this produced an 82-record
dataset ending 2026-06-18 instead of the full pg history). `extract.js` now
imports `envcrypt.js` first and prints the *resolved* backend in the summary
with a loud warning when it resolves to `json`.

#### Snapshot field eras (git-dated)

| Fields | Present since | Commit |
|--------|---------------|--------|
| `ts`, `position`, `pnl_pct`, `in_range`, `minutes_out_of_range` | 2026-03-20 | `621c687` |
| `active_bin`, `lower_bin`, `upper_bin` | 2026-06-16 | `486a832` |
| `pool_tvl`, `pool_volume` enrichment | later June | — |
| perf-record path features (`mfe/mae/max_bins_*`) | ~2026-07-05 closes | — |

The join and the replay rules tolerate all eras (see the `oor` row below); the
per-position `has_bins_fields` / `n_snaps_with_bins` fields say which era a
series belongs to.

### 2. `replay.js` — the counterfactual engine

For every position with a usable path series (`n_snapshots >= 2`), simulates
alternative exit rules over the recorded path and reports the PnL delta versus
what actually happened:

```
Δ = counterfactual_pnl_pct − actual_pnl_pct     (positive ⇒ the variant beats reality)
```

Flags: `--rule oor|trailing|stop|crash|all` (default `all`), `--verbose`
(per-position detail rows), `--in <path>` (default `dataset.json`).

---

## Rule families & replay semantics

Each mirrors the **live** implementation (read those before changing semantics):

| Family | Live source | Variants | Semantics in the replay |
|--------|-------------|----------|-------------------------|
| `oor` (OOR-below wait) | `state.js updatePnlAndCheckExits` OOR-below branch (side-agnostic `minutesOOR ≥ limit`, gated on the current tick being below) | `outOfRangeWaitMinutesBelow` ∈ {15,30,45,63,90} | Fires at the first snapshot that is below range with OOR duration ≥ limit. Side: `active_bin < lower_bin` when bin fields exist (high conf); for pre-06-16 snapshots, `in_range=false` + an OOR-below-family `close_reason` (side inferred, **low** conf). Duration: the snapshot's own `minutes_out_of_range` (the live timer's value) when present, else streak reconstruction. Exit PnL = that snapshot's mark. |
| `trailing` (trailing TP) | `state.js` peak/trailing branch | (trigger, drop) pairs | Track running peak; arm once peak ≥ trigger; fire when `peak − current ≥ drop`. Exit PnL = firing snapshot's mark. |
| `stop` (stop loss) | `state.js` stop-loss branch | `stopLossPct` ∈ {−15,−25,−35,−50,−70} | Fires at the first snapshot with `pnl_pct ≤ threshold` (the live 15 s confirmation is sub-cadence, so a breaching snapshot ⇒ confirmed close). |
| `crash` (crash fast-path) | `index.js detectPriceCrash` | `crashBinsPerMin` ∈ {8,12,20} | Approximate: OOR-below AND ≥ `crashMinBinDistance` below AND adjacent-snapshot velocity `(bins dropped)/(gap min) ≥ crashBinsPerMin`. **Dense series only** (median gap ≤ 5 m). |

---

## Confidence tiers (why some numbers are trustworthy and some are not)

At ~3–10 min snapshot cadence you **cannot** faithfully replay a 15 s crash
detector or the exact instant a trailing-TP fires between two far-apart snapshots.
So every per-position evaluation is bucketed:

- **high** — the rule's decision boundary is a *level/duration* test the snapshot
  series resolves without sub-cadence timing (OOR-below duration, stop-loss level,
  a trailing fire on a tight inter-snapshot gap). The `hi*` columns aggregate only
  these.
- **low** — sub-cadence timing materially affects the result (every crash eval;
  a trailing fire across a >12 min gap where the true peak/trough is unobserved;
  a stop-loss dip that recovers by the next snapshot). Reported, but **never mixed
  into the `hi*` columns**.

**Trust the `hi*` columns.** Treat the raw columns as a directional upper bound on
sample size. Prefer `n=12 evaluable, 8 high-confidence` honesty over fake precision.

---

## Running on the VM (where pg + real data live)

The dev Mac has empty stores, so extract reports `n=0` (by design — it proves the
tool runs and reports coverage honestly). Real history lives on the Oracle VM under
`PERSIST_BACKEND=pg` (from `/opt/meridian/.env`):

```bash
ssh angga@oraclevm.fardana.com     # or root@10.100.0.10 over WireGuard
cd /opt/meridian
node scripts/replay/extract.js --summary
node scripts/replay/replay.js --verbose | less
# focus one family:
node scripts/replay/replay.js --rule oor --verbose
```

Read-only: nothing writes to the DB or the JSON stores. Safe to run while the
`meridian` PM2 process is live (it only reads through the same cache-primed getters).
`dataset.json` is gitignored, so the hourly `meridian-syncer` pull won't fight it.

---

## How to interpret the output

- A rule family's table has one row per variant. **`meanΔ`/`medΔ`/`win%`** = delta
  stats across all evaluable positions; **`hiMeanΔ`/`hiMedΔ`/`hiWin%`** = the
  high-confidence subset. A variant with a positive `hiMeanΔ` and high `hiWin%`
  over a decent `nHi` is a genuine candidate for a config change.
- `n` = positions where the variant fired (a wider OOR limit fires on fewer
  positions). A variant that never fires shows `n=0` — it means that limit was
  never reached on any held position's path, not that it's good.
- Cross-check any promising variant against `/exits` (post-close probe verdicts)
  and the live `crash_shadow` log lines before flipping a knob.

---

## What this tool CANNOT answer (honest limits)

1. **Pool-selection counterfactuals** — "should we have deployed into pool X
   instead?" Needs the new `rejected-candidates` store (`pool-memory.getRejectedCandidates()`)
   to accrue forward-looking price data first; it has none yet.
2. **Sub-cadence timing** — exact crash-detector / trailing-TP fills. See tiers.
3. **Realized fills** — counterfactual exit PnL is the recorded *mark*, not a
   slippage-simulated exit. Illiquid downside exits realize worse (see `exit_swap`
   slippage in `CLAUDE.md`), so downside deltas are modestly overstated.
4. **Survivorship** — only positions we *held* are replayable; says nothing about
   the population we screened out.
5. **Fee timing** — fees are treated via the snapshot's fee-inclusive mark;
   any pro-rata fallback assumes linear fee accrual (optimistic — fees are
   front-loaded while in-range).

---

## Structural coverage limit (needs a WRITER-side change to fix)

`pool-memory.js recordPositionSnapshot()` keeps **one flat `snapshots` array per
POOL, capped at the last 48 entries** (~4 h at 5 min cadence):

```js
// pool-memory.js (current writer)
if (db[poolAddress].snapshots.length > 48) {
  db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
}
```

Consequences for replay coverage (visible in `--diagnose`):

- A **later position in the same pool evicts the earlier position's series**
  (the ring is shared; extract can only recover what survives, filtered by
  `snapshot.position`).
- A position **held longer than ~4 h loses its earliest ticks** (including,
  often, the OOR-onset ticks the `oor` family needs).
- Snapshots are **never archived at close** — whatever the ring holds at close
  is all history that will ever exist for that position.

This harness deliberately does NOT touch the writer. If fuller coverage is
wanted, the minimal writer change (in `recordPositionSnapshot`, replacing the
flat cap) is a **per-position cap** so a new position stops evicting its
predecessor's series:

```js
// Keep the last 48 snapshots PER POSITION instead of per pool:
const byPos = new Map();
for (const s of db[poolAddress].snapshots) {
  const k = s.position || "_none";
  if (!byPos.has(k)) byPos.set(k, []);
  byPos.get(k).push(s);
}
db[poolAddress].snapshots = [...byPos.values()].flatMap((arr) => arr.slice(-48));
```

(Optionally also: archive `snapshots.filter(s => s.position === closedPos)` onto
the perf record at close, then prune — that would make replay coverage complete
and bound the doc size. Route as a separate change; `pool-memory.js` is outside
this tool's file set.)

---

## Note on units

`pnl_pct` here is unit-agnostic (a percentage); `*_usd` fields may be
SOL-denominated under `management.solMode=true` (see the unit landmine in
`CLAUDE.md`). The engine only ever compares `Δ = cf_pnl_pct − actual_pnl_pct` —
both the same field — so units cancel and no `$` is ever printed.
