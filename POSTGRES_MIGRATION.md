# Meridian → PostgreSQL Migration

Status: ✅ **LIVE ON POSTGRES** (2026-06-18). Dashboard integrated & Circuit Breaker resolved (2026-06-19).
All 11 stores migrated, DRY_RUN-validated, prod on `PERSIST_BACKEND=pg`.

## Dashboard & Circuit Breaker PG Integration (2026-06-19)

*   **Circuit Breaker State in DB**: Added `_circuitBreaker` to `state_meta` keys (`META_KEYS`) and exported `getCircuitBreakerState` / `saveCircuitBreakerState` accessors in `state.js`.
*   **Circuit Breaker Performance reads**: Configured `circuit-breaker.js` to load performance records from `lessons.js` (`getAllPerformance()`) instead of the stale `lessons.json` file.
*   **Dashboard DB Integration**: Refactored the dashboard backend (`index.js`) to dynamically import `/opt/meridian/envcrypt.js` and connection pool `/opt/meridian/db/pool.js`.
*   **Dual Backend with JSON Fallback**: Configured dashboard routes (`/api/status`, `/api/logs/decisions`, `/api/balance-history`) to read from PostgreSQL tables (`positions`, `state_meta`, `kv_store`) when `usePg()` is active, with transparent fallback to local JSON files if disabled or database queries fail.

## Phase 6 — backups (2026-06-18)

- `scripts/db_backup.js` + PM2 cron app `meridian-db-backup` (daily 03:17): `pg_dump -Fc` of
  the `meridian` db → `/opt/meridian-backups` (outside the repo so the git syncer can't touch
  it; dir created `angga`-owned via sudo), retention `PG_BACKUP_KEEP`=14, Telegram notify.
- Restore: `pg_restore -h 127.0.0.1 -U meridian -d meridian --clean --if-exists <file.dump>`.
- Verified: manual run produced a valid 0.18 MB dump; `pg_restore -l` lists 34 table entries;
  PM2 app registered (`cron=17 3 * * *`) and `pm2 save`d. Logical dumps only (no WAL/PITR).

## State normalization + Phase 5 (2026-06-18)

- **state.js normalized** (migration `004_state_meta.sql`): under pg, state persists as
  `positions` (1 row/position, full object in `data` jsonb + promoted query columns,
  upserted by diff), `position_events` (append-only audit via `pushEvent`), and `state_meta`
  (singletons). Cache façade unchanged → 25 sync accessors + call sites untouched.
  `initState()` reconstructs losslessly from the tables (one-time `state_doc` fallback);
  `state_doc` kept as rollback snapshot. `db/import-state-normalized.js` projects the doc → tables.
- **Phase 5:** `status_generator` reads decisions from Postgres (`kv_store`, the
  `decision-log.json` file was stale under pg) and adds `tracked_open` from the `positions`
  table; `balance`/`positions` still via live RPC (`cli.js`) since they're on-chain.
- **Go-live:** pushed `edcb5c3`, `git reset --hard`, migrate 004, `import-state-normalized.js`
  → **83 positions / 20 events / 5 meta** seeded, restarted onto normalized code.
- **Verified:** normalized write/read/reconstruct smoke test PASS; restart read from tables
  (no fallback); `status_generator` produced `monitor-status.json` with `decisions=10`,
  `tracked_open=0`; anomaly sweep since restart clean.
- The 10 doc stores remain `kv_store` documents (see CLAUDE.md Known Issues for which warrant
  later normalization).

## Go-live (2026-06-18)

1. Pushed `experimental` to origin (through commit `706b476`, incl. a `cli.js` fix to init
   caches before any command — `status_generator` shells out to `cli.js positions`).
2. VM aligned via git: `git fetch && git reset --hard origin/experimental` (gitignored data
   survived); `npm install` synced `pg`; migrations 001–003 confirmed applied.
3. Flipped `/opt/meridian/.env` → `PERSIST_BACKEND=pg`. Pre-flight `node cli.js positions`
   ran clean under pg.
4. `pm2 start meridian` (alone first to observe), then watchdog/status-generator/syncer/
   dashboard; `pm2 save`.
5. Verified live: `Mode: LIVE` / `backend: pg`; balance-history written to Postgres within
   35s; management + screening cycles clean; status-generator produced a fresh
   `monitor-status.json`; **anomaly sweep of the whole pg run was empty**; restart counter
   steady (no crash loop). The only log warning is the pre-existing benign
   `bigint: Failed to load bindings, pure JS will be used` (Solana native dep, unrelated).

Rollback: set `PERSIST_BACKEND=json` in `.env` and restart — the legacy JSON files remain a
cold copy.

## DRY_RUN integration validation (2026-06-18) — PASS

Booted the full agent on the VM with `DRY_RUN=true PERSIST_BACKEND=pg` for 75s.
- Note: env must be set in `.env` (the app's `envcrypt.js` calls `dotenv.config({override:true})`,
  so shell exports are clobbered by `.env`). Set in `.env` for the test, restored after.
- Boot logged `Mode: DRY RUN` / `Persistence backend: pg`; `initState()` +
  `initAllDocStores()` succeeded (no "not initialised" errors).
- Screening cycle ran, agent loop executed 3 steps to a final answer; reads from pg worked
  (pool-memory, lessons). Writes verified fresh in Postgres: `kv_store` balance-history and
  decision-log updated < 3 min. (state_doc/lessons/etc. unchanged — correct, 0 positions, no
  deploy in DRY_RUN.)
- SIGTERM shutdown clean ("Open positions at shutdown: 0", flush ran). No unhandled
  rejections / crashes / TypeErrors. Only warning is the pre-existing benign
  "bigint: Failed to load bindings, pure JS will be used".
- `.env` restored to `PERSIST_BACKEND=json` after the test; prod unchanged.

## Remaining 10 stores cut over (2026-06-18)

Same cache + ordered write-through pattern as state.js, factored into a reusable helper
`db/doc-store.js` (`makeDocStore(name, file, emptyValue)` → sync `get()`, ordered async
`set()`, `init()`, `flush()`). Each module kept its synchronous `load()`/`save()` API — the
bodies now delegate to a doc store, so no call sites changed.

- Migrated: lessons, pool-memory, decision-log, signal-weights, strategy-library,
  smart-wallets, token-blacklist, dev-blocklist, error-telemetry, balance-history (the last
  inlined in index.js).
- `pg` backend routes every store through one jsonb row in **`kv_store`** keyed by name
  (migration `003_kv_store.sql`). `json` backend writes the legacy atomic file (unchanged).
- Wiring: `initAllDocStores()` at `index.js` boot (after `initState()`),
  `flushAllDocStores()` on shutdown. cli.js mutating commands flush before exit.
- Fixed one bypass: the `/thresholds` evolve path read `lessons.json` directly via fs;
  now uses the new `getAllPerformance()` export from lessons.js.
- Data imported via `db/import-kv.js` → pool-memory (25 pools), balance-history (695),
  error-telemetry (98), lessons/decision-log/signal-weights/strategy-library seeded.
- **Verified:** pg path PASS through real modules on the VM (reads imported data, mutates,
  flushes, persists to kv_store); json regression PASS locally; full-repo syntax check clean.

## state.js cutover (2026-06-18)

Design chosen over a full async/await rewrite of ~75 call sites: an **in-process cache
with ordered write-through**, so the 25 exported accessors stay synchronous and callers
are untouched.

- `initState()` loads the cache once at startup (wired into `index.js` `isMain` boot via
  top-level await, and into each `cli.js` command that touches state). `flushState()`
  drains pending async writes; wired into `index.js` shutdown and the mutating cli commands.
- Mutations update the cache synchronously, then enqueue an **ordered** async persist
  (`_writeChain`) so concurrent writes can't clobber each other.
- Backend select via `PERSIST_BACKEND`: `json` persists synchronously to the atomic file
  (behaviour identical to before); `pg` writes the whole state object to the single-row
  `state_doc` jsonb document (migration `002_state_doc.sql`).
- **Safety net:** the existing `reconcileStateWithChain()` auto-heals any last write lost to
  a hard crash (SIGKILL) by detecting phantom/orphan positions against on-chain truth.
- **Verified:** pg backend smoke test (track→close→flush→read) PASS on the VM; json backend
  regression PASS locally. Live `state.json` imported into `state_doc` via
  `db/import-state.js` → **83 positions (0 open)** seeded.

### IMPORTANT — mixed-backend caveat
`PERSIST_BACKEND` is global, but only `state.js` consults it so far. Flipping it to `pg`
puts **state in Postgres while the other 10 stores stay on JSON** (they don't check the
flag yet). That is consistent (stores are storage-independent) but is NOT the end goal. Do
not flip production to `pg` until either (a) all stores are migrated, or (b) a `DRY_RUN`
integration run on the VM validates the mixed mode and you accept it. Production currently
remains `PERSIST_BACKEND=json`.

### Still JSON-only (Phase 3 remaining)
lessons.js, pool-memory.js, decision-log.js, error-telemetry.js, balance-history (index.js),
signal-weights.js, strategy-library.js, smart-wallets.js, token-blacklist.js, dev-blocklist.js.

## Live environment provisioned (2026-06-18)

- Meridian PM2 processes (`meridian`, `-watchdog`, `-status-generator`, `-syncer`,
  `-dashboard`) **stopped** on the VM and `pm2 save`d (0 open positions at shutdown;
  103 historical, all closed). NeoTasker left running.
- PostgreSQL 16.14 already active on the VM. Created dedicated **`meridian` database +
  least-privilege role `meridian`** (owns the db). Verified TCP login on `127.0.0.1:5432`.
- Credentials written to `/opt/meridian/.env` (gitignored): `PERSIST_BACKEND=json`
  (default — JSON still authoritative), `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`.
  A `.env.bak.*` backup was made first.
- `pg@^8` installed in `/opt/meridian/node_modules`. `db/` scaffolding synced to the VM.
- **Migration `001_init.sql` applied** → 14 tables live (`positions`, `position_events`,
  `closed_positions`, `pools`, `pool_snapshots`, `lessons`, `smart_wallets`,
  `token_blacklist`, `dev_blocklist`, `strategy_library`, `signal_weights`,
  `balance_history`, `error_telemetry`, `schema_migrations`).
- Live deploy is at **`/opt/meridian`** (branch `experimental`, commit `cc867de`), run by
  PM2 as user `angga`. NOTE: scaffolding was staged via rsync because `meridian-syncer`
  (hourly git pull) is stopped; the new files + `package.json` pg dep must be committed and
  deployed through git before the syncer is re-enabled, or they'll drift.

Goal: replace the flat-JSON persistence layer with PostgreSQL 16 (already running on
the Oracle VM at `localhost:5432`), removing the multi-process race, non-atomic-write,
and unbounded-rewrite gaps.

---

## Target environment

- **DB**: dedicated `meridian` database on the existing VM Postgres 16 instance — **not**
  NeoTasker's `fardana` db. Own role `meridian` with least privilege, own backup schedule.
- **Driver**: `pg` (node-postgres) — pure JS, safe on aarch64 (no native build).
- **Pool**: single small `pg.Pool` (VM RAM is shared with NeoTasker + PG). Cap ~5 conns.
- **Connection**: `localhost:5432` on the VM. Secrets in `.env` (`PG_*`), never committed.

---

## The central refactor cost: sync → async

The current persistence API is **synchronous** (`fs.readFileSync`). `pg` is **async**.
Surface to convert:

| Module | Exported fns | Notes |
|---|---|---|
| state.js | 25 | imported by index, circuit-breaker, agent, executor, pnl, dlmm, socket-monitor |
| lessons.js | 13 | |
| pool-memory.js | 9 | snapshots — heaviest write path |
| dev-blocklist.js | 5 | |
| strategy-library.js | 6 | |
| smart-wallets.js / token-blacklist.js / signal-weights.js | 4 each | |
| decision-log.js / error-telemetry.js / signal-tracker.js | 3 each | |

Every call site must `await`. Highest-risk call sites: the ReAct loop (`agent.js`),
`tools/executor.js` deploy/close hooks, and the cron handlers in `index.js`.

---

## Phasing

- **Phase 0 — Containment (DONE).** `state.js` `save()` is now atomic (temp file +
  `rename`, with a rolling `state.json.bak`). `load()` recovers from `.bak` on corruption
  and **halts instead of returning empty positions** (preserves a `state.json.corrupt-*`
  for forensics). Removes the silent capital-risk bug independent of the DB work.
- **Phase 1 — DB scaffolding (NEXT).** `db/pool.js` (pg.Pool + `PERSIST_BACKEND` flag),
  `db/migrate.js`, numbered SQL migrations. Non-breaking: JSON stays the default backend.
- **Phase 2 — Schema.** See DDL sketch below.
- **Phase 3 — Repository layer.** Per-store modules expose the **same function names** as
  today but `async`; pick JSON vs SQL impl by `PERSIST_BACKEND`. Convert call sites to await.
- **Phase 4 — Importer.** One-shot JSON→SQL loader. Keep JSON files as cold backup.
- **Phase 5 — status_generator read-only.** Point it at the DB as a pure reader, leaving
  the main agent as the sole writer → kills the cross-process write race entirely.
- **Phase 6 — Durability.** `pg_dump` of `meridian` db wired into `meridian-syncer` cron + WAL.

---

## Schema sketch (DDL to refine in Phase 2)

```sql
-- live positions (replaces state.json "positions")
CREATE TABLE positions (
  position_address text PRIMARY KEY,
  pool_address     text NOT NULL,
  base_mint        text NOT NULL,
  pair             text,
  lower_bin        int,
  upper_bin        int,
  deployed_at      timestamptz NOT NULL,
  strategy         text,
  out_of_range_at  timestamptz,
  gas_sol          numeric,
  note             text,
  data             jsonb,           -- overflow for evolving fields, avoids constant migrations
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- append-only audit (replaces in-memory recentEvents + decision-log.json)
CREATE TABLE position_events (
  id          bigserial PRIMARY KEY,
  position_address text,
  kind        text NOT NULL,        -- claim | close | rebalance | oor | note | ...
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- closed-position performance (feeds lessons + Darwin scoring)
CREATE TABLE closed_positions (
  position_address text PRIMARY KEY,
  pool_address text, base_mint text, pair text,
  pnl_pct numeric, pnl_usd numeric, hold_minutes int,
  close_reason text, opened_at timestamptz, closed_at timestamptz,
  data jsonb
);

CREATE TABLE pools          (pool_address text PRIMARY KEY, base_mint text, data jsonb, cooldown_until timestamptz);
CREATE TABLE pool_snapshots (id bigserial PRIMARY KEY, pool_address text, snapshot jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE lessons        (id bigserial PRIMARY KEY, kind text, body jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE smart_wallets  (address text PRIMARY KEY, data jsonb);
CREATE TABLE token_blacklist(mint text PRIMARY KEY, reason text, created_at timestamptz DEFAULT now());
CREATE TABLE dev_blocklist  (dev text PRIMARY KEY, reason text, created_at timestamptz DEFAULT now());
CREATE TABLE signal_weights (key text PRIMARY KEY, weight numeric, data jsonb);
CREATE TABLE balance_history(id bigserial PRIMARY KEY, total_usd numeric, snapshot jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE error_telemetry(id bigserial PRIMARY KEY, kind text, message text, created_at timestamptz DEFAULT now());

CREATE INDEX ON pool_snapshots (pool_address, created_at DESC);
CREATE INDEX ON closed_positions (pool_address);
CREATE INDEX ON position_events (position_address, created_at DESC);
```

**Concurrency rule:** any read-modify-write of a position runs inside a transaction with
`SELECT … FOR UPDATE` on the `positions` row. This is what structurally fixes the race.

**Config stays a file.** `user-config.json` is NOT migrated — keep live runtime config
separate from learning data. (Open item: `evolveThresholds` writing config still races
with `update_config`; address separately, possibly a small `config` table or a lock.)

---

## Open decisions before Phase 3

1. **Dev/test Postgres target** — need a Postgres to develop against (local container or a
   throwaway db on the VM). pg code can't be meaningfully tested without one.
2. **Dual-write shadow period?** — optionally write both JSON and SQL for N days and diff,
   before trusting SQL as source of truth. Safer but doubles the write path temporarily.
3. **Rollback** — `PERSIST_BACKEND=json` must remain a working escape hatch through Phase 5.
