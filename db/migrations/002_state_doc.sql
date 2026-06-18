-- 002_state_doc — single-row document store for agent state.
--
-- The state.js cutover uses an in-process cache + ordered write-through. The
-- whole state object (positions map + singletons: recentEvents, baseline,
-- cumulative_gas_sol, _lastBriefingDate, lastUpdated) is persisted as one jsonb
-- document. This is the safe first cutover; normalization into the positions/
-- position_events tables (already defined in 001) can layer on later by
-- projecting from this document on write.

CREATE TABLE IF NOT EXISTS state_doc (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  doc        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the single row so UPDATEs always have a target.
INSERT INTO state_doc (id, doc) VALUES (1, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;
