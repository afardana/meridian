-- 005_price_ticks — temporary real-time price/bin tick ring (DATA CAPTURE ONLY).
--
-- Persists the per-tick price/bin data the agent already computes but currently
-- discards: the fast PnL poller (pnl_pct + active_bin per position, ~every 3s)
-- and the WebSocket bin-change handler (active_bin per subscribed pool, on each
-- account change). Ground truth for the replay harness's snapshot density,
-- crash/trailing-TP calibration, and anomaly cross-checks. NOTHING reads this
-- table for live decisions yet — this phase is capture only.
--
-- Temporary ring by design: db/tick-store.js prunes rows older than 72h on each
-- flush cycle (at most hourly). ~90k rows/day at 3 positions — trivial.

CREATE TABLE IF NOT EXISTS price_ticks (
  id               bigserial PRIMARY KEY,
  pool_address     text NOT NULL,
  position_address text,
  ts               timestamptz NOT NULL DEFAULT now(),
  active_bin       int,
  pnl_pct          double precision,
  price            double precision,
  source           text NOT NULL          -- 'poller' | 'socket'
);
CREATE INDEX IF NOT EXISTS idx_price_ticks_pool ON price_ticks (pool_address, ts DESC);
CREATE INDEX IF NOT EXISTS idx_price_ticks_position ON price_ticks (position_address, ts DESC);
