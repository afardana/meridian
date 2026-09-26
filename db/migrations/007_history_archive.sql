-- History archive (2026-09-26, operator: "keep all history"). The document stores
-- (pool-memory snapshots, rejected candidates, decision log, error telemetry,
-- evolution history, auto-lessons) keep a bounded hot window so every write stays
-- cheap; whatever leaves that window is moved here instead of being deleted.
CREATE TABLE IF NOT EXISTS history_archive (
  id           bigserial PRIMARY KEY,
  store        text        NOT NULL,
  key          text,
  item_ts      timestamptz,
  archived_at  timestamptz NOT NULL DEFAULT now(),
  item         jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_archive_store_key_ts ON history_archive (store, key, item_ts);
CREATE INDEX IF NOT EXISTS idx_history_archive_store_ts ON history_archive (store, item_ts);
