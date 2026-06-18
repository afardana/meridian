-- 003_kv_store — generic single-document store for the remaining JSON files.
--
-- The non-state stores (lessons, pool-memory, decision-log, error-telemetry,
-- signal-weights, strategy-library, smart-wallets, token-blacklist,
-- dev-blocklist, balance-history) are append/read-mostly and were each a single
-- JSON file rewritten whole on every change. They migrate as one jsonb document
-- per store keyed by name — same semantics as before, now transactional and
-- crash-safe. Normalization into the typed tables from 001 can layer on later.

CREATE TABLE IF NOT EXISTS kv_store (
  key        text PRIMARY KEY,
  doc        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
