-- 001_init — initial Meridian schema.
-- Mirrors the flat-JSON stores. `data jsonb` columns absorb evolving/secondary
-- fields so we don't need a migration for every new tracked attribute.

-- Live position registry (replaces state.json "positions").
CREATE TABLE IF NOT EXISTS positions (
  position_address text PRIMARY KEY,
  pool_address     text NOT NULL,
  base_mint        text,
  pair             text,
  lower_bin        int,
  upper_bin        int,
  strategy         text,
  deployed_at      timestamptz NOT NULL,
  out_of_range_at  timestamptz,
  gas_sol          numeric,
  note             text,
  closed           boolean NOT NULL DEFAULT false,
  closed_at        timestamptz,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_positions_open ON positions (closed) WHERE closed = false;
CREATE INDEX IF NOT EXISTS idx_positions_pool ON positions (pool_address);
CREATE INDEX IF NOT EXISTS idx_positions_base_mint ON positions (base_mint);

-- Append-only audit trail (replaces in-memory recentEvents + decision-log.json).
CREATE TABLE IF NOT EXISTS position_events (
  id               bigserial PRIMARY KEY,
  position_address text,
  kind             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_position_events_addr ON position_events (position_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_position_events_kind ON position_events (kind, created_at DESC);

-- Closed-position performance (feeds lessons + Darwin scoring).
CREATE TABLE IF NOT EXISTS closed_positions (
  position_address text PRIMARY KEY,
  pool_address     text,
  base_mint        text,
  pair             text,
  pnl_pct          numeric,
  pnl_usd          numeric,
  hold_minutes     int,
  close_reason     text,
  opened_at        timestamptz,
  closed_at        timestamptz,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_closed_pool ON closed_positions (pool_address);
CREATE INDEX IF NOT EXISTS idx_closed_at ON closed_positions (closed_at DESC);

-- Pool memory (replaces pool-memory.json): one row per pool + child snapshots.
CREATE TABLE IF NOT EXISTS pools (
  pool_address   text PRIMARY KEY,
  base_mint      text,
  cooldown_until timestamptz,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pool_snapshots (
  id           bigserial PRIMARY KEY,
  pool_address text NOT NULL,
  snapshot     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pool_snapshots ON pool_snapshots (pool_address, created_at DESC);

CREATE TABLE IF NOT EXISTS lessons (
  id         bigserial PRIMARY KEY,
  kind       text,
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS smart_wallets (
  address text PRIMARY KEY,
  data    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS token_blacklist (
  mint       text PRIMARY KEY,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dev_blocklist (
  dev        text PRIMARY KEY,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_library (
  name       text PRIMARY KEY,
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_weights (
  key    text PRIMARY KEY,
  weight numeric,
  data   jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS balance_history (
  id         bigserial PRIMARY KEY,
  total_usd  numeric,
  snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_balance_history_at ON balance_history (created_at DESC);

CREATE TABLE IF NOT EXISTS error_telemetry (
  id         bigserial PRIMARY KEY,
  kind       text,
  message    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_error_telemetry_at ON error_telemetry (created_at DESC);
