-- Short-retention mark-to-market liquidity samples for dashboard movement views.
-- This is display telemetry only; it is never used by exit decisions.
CREATE TABLE IF NOT EXISTS position_liquidity_ticks (
  id                 bigserial PRIMARY KEY,
  position_address   text NOT NULL,
  pool_address       text,
  pair               text,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  liquidity_usd      double precision,
  liquidity_sol      double precision,
  liq_x_usd          double precision,
  liq_y_usd          double precision,
  valuation_quality  text,
  value_valid        boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_position_liquidity_ticks_position_time
  ON position_liquidity_ticks (position_address, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_position_liquidity_ticks_time
  ON position_liquidity_ticks (captured_at DESC);
