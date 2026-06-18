# Meridian → PostgreSQL Migration

Status: **in progress** — Phases 0–2 complete; Phase 3 (repository layer + async refactor) next.

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
