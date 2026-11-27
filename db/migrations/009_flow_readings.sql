-- 009_flow_readings — the flow guard's market-flow readings (DATA CAPTURE ONLY, 2026-11-27).
--
-- Every usable Jupiter datapi reading the flow guard (flow-guard.js) takes — on a position the
-- operator armed, or for the log-only shadow on the others — at most one row per position per
-- management cycle: 5m / 1h buy and sell volume, price change, liquidity, holders, price, trade
-- counts, and which flow condition(s) qualified. No historical buy/sell flow data exists
-- anywhere else, so this is what the guard's thresholds can be replayed against later.
-- Nothing reads this table for live decisions. Written fire-and-forget by
-- db/flow-reading-store.js, which falls back to flow-readings.jsonl (data dir) while this table
-- does not exist yet.

CREATE TABLE IF NOT EXISTS flow_readings (
  id               bigserial PRIMARY KEY,
  position_address text NOT NULL,
  pool_address     text,
  mint             text NOT NULL,
  ts               timestamptz NOT NULL,          -- time of the Jupiter read
  kind             text NOT NULL,                 -- 'armed' | 'shadow'
  conditions       text[] NOT NULL DEFAULT '{}',  -- conditions that qualified this reading
  data             jsonb NOT NULL                 -- the figures (see db/flow-reading-store.js)
);
CREATE INDEX IF NOT EXISTS idx_flow_readings_position ON flow_readings (position_address, ts DESC);
CREATE INDEX IF NOT EXISTS idx_flow_readings_mint ON flow_readings (mint, ts DESC);
