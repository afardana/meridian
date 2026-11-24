-- Context export for scripts/replay/drop_guard_study.js (--context): one JSON document on one line.
-- Piped over stdin to psql on the VM (read-only: a single SELECT):
--   ssh root@oraclevm.fardana.com 'cd /tmp && sudo -u postgres psql -X -q -d meridian -At' \
--     < scripts/replay/drop_guard_export_context.sql > context.json
-- positions: the registry row fields the study needs (exclusion timestamps, owner, capital, held state at the end).
-- events: position_events rows of the kinds that open an exclusion window (straddle, rebalance_external,
--   capital_change_external) or define the held intervals (hold, resume), plus adopt/deploy/close/grace_release
--   for context. No secrets are read.
select json_build_object(
  'exported_at', now(),
  'positions', (
    select coalesce(json_agg(json_build_object(
      'position', p.position_address,
      'pool', p.pool_address,
      'pair', p.pair,
      'deployed_at', p.deployed_at,
      'closed', p.closed,
      'closed_at', p.closed_at,
      'adopted', coalesce((p.data->>'adopted')::boolean, false),
      'adopted_at', p.data->>'adopted_at',
      'amount_sol', p.data->'amount_sol',
      'straddled_at', p.data->>'straddled_at',
      'straddle_count', p.data->'straddle_count',
      'last_capital_rebase', p.data->'last_capital_rebase',
      'rebalance_event_times', (select json_agg(e->>'at') from jsonb_array_elements(case when jsonb_typeof(p.data->'rebalance_events') = 'array' then p.data->'rebalance_events' else '[]'::jsonb end) e),
      'last_rebalanced_at', p.data->>'last_rebalanced_at',
      'last_claim_at', p.data->>'last_claim_at',
      'ever_held', p.data->'ever_held',
      'hold_mode', p.data->'hold_mode',
      'hold_set_at', p.data->>'hold_set_at'
    )), '[]'::json)
    from positions p
    where p.closed_at is null or p.closed_at >= '2026-10-04T00:00:00Z'
  ),
  'events', (
    select coalesce(json_agg(json_build_object(
      'position', e.position_address,
      'kind', e.kind,
      'at', e.created_at,
      'pool_name', e.payload->>'pool_name',
      'reason', left(e.payload->>'reason', 200)
    ) order by e.created_at), '[]'::json)
    from position_events e
    where e.created_at >= '2026-09-01T00:00:00Z'
      and e.kind in ('straddle', 'rebalance_external', 'capital_change_external', 'hold', 'resume', 'adopt', 'deploy', 'close', 'grace_release')
  )
);
