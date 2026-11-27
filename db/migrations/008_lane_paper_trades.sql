-- 008_lane_paper_trades — fresh top-performer lane paper trades (plan 16, Phase 1; CAPTURE ONLY).
--
-- One row per paper entry the lane would have made (lane 'paper') and per operator position the
-- bot adopted in the lane's class (lane 'operator'), plus the pool's path every lane poll for the
-- tracking window. Written by fresh-lane-paper.js through db/lane-paper-store.js; read only by
-- scripts/experiments/fresh_lane_sim.js and scripts/experiments/publish.js (count of paper
-- entries). NOTHING on the money path reads these tables. No retention (keep all history).

CREATE TABLE IF NOT EXISTS lane_paper_trades (
  id           text PRIMARY KEY,                 -- <lane>-<pool[0:8]>-<entered_at ms>
  pool         text        NOT NULL,
  base_mint    text,
  pair         text,
  lane         text        NOT NULL,             -- 'paper' | 'operator'
  position     text,                             -- operator lane: the adopted position address
  entered_at   timestamptz NOT NULL,
  track_hours  real        NOT NULL,
  entry        jsonb       NOT NULL,             -- full API row + safety reads + creation times + rank + quotes
  status       text        NOT NULL DEFAULT 'open', -- 'open' | 'ended'
  ended_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lane_paper_trades_lane_entered ON lane_paper_trades (lane, entered_at);
CREATE INDEX IF NOT EXISTS idx_lane_paper_trades_pool_entered ON lane_paper_trades (pool, entered_at);

CREATE TABLE IF NOT EXISTS lane_paper_ticks (
  id              bigserial PRIMARY KEY,
  trade_id        text        NOT NULL,
  at              timestamptz NOT NULL,
  seen            boolean     NOT NULL DEFAULT true, -- false: the pool was missing from the batch answer
  active_bin      int,                               -- derived from price (fresh-lane.js priceToBin)
  price           double precision,                  -- pool_price, SOL per whole token
  tvl             double precision,
  active_tvl      double precision,
  fee_usd         double precision,                  -- raw API `fee` at timeframe=5m: fees so far in the CURRENT
                                                     -- clock-aligned 5-min bucket (resets at each bucket start)
  fee_window_min  real,                              -- 5 (the bucket length)
  fee_bucket_start timestamptz,                      -- bucket the reading belongs to (fresh-lane.js feeBucketStart)
  fee_time_source text,                              -- 'server' (response Date header) | 'local'
  fee_1h_usd      double precision,                  -- API `fee` at timeframe=1h, once per bucket (gap fallback), else null
  volume_usd      double precision,                  -- raw API `volume` at timeframe=5m (same bucket semantics)
  market_cap      double precision,
  holders         int,
  rank            int,                               -- place on the 2h list at this poll, null = off the list
  sol_price_usd   double precision,
  sell_quote      jsonb                              -- read-only Jupiter sell quote taken at this poll, or null
);
CREATE INDEX IF NOT EXISTS idx_lane_paper_ticks_trade_at ON lane_paper_ticks (trade_id, at);
