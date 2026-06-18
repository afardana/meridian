-- 004_state_meta — singleton key/value rows for state.js top-level fields that
-- aren't positions or events (baseline, cumulative_gas_sol, _lastBriefingDate).
--
-- Completes the state normalization: state.js under pg now writes real rows to
-- positions (one per position, full object in data jsonb + promoted query
-- columns), position_events (append-only audit), and state_meta (singletons),
-- instead of the single state_doc jsonb document. state_doc is retained as the
-- pre-normalization snapshot for rollback.

CREATE TABLE IF NOT EXISTS state_meta (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
