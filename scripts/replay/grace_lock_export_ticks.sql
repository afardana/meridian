-- grace_lock_replay.js --ticks (read-only: one COPY of a SELECT), piped over stdin to psql on the VM, gzip on the VM side:
--   ssh root@oraclevm.fardana.com 'cd /tmp && sudo -u postgres psql -X -q -d meridian | gzip -c' \
--     < scripts/replay/grace_lock_export_ticks.sql > ticks.csv.gz
-- Output: gzip CSV, no header: position_address,t_ms(epoch ms),active_bin,pnl_pct (pnl_pct may be empty).
-- RAW poller rows (NOT deduplicated — the replay needs the real cadence for its 3-min gap rule), for every
-- position that was adopted or straddled (an adopt or straddle event since 2026-09-20), from 2026-09-25.
copy (
 select t.position_address, round(extract(epoch from t.ts) * 1000)::bigint as t_ms, t.active_bin, t.pnl_pct
 from price_ticks t
 where t.source = 'poller' and t.ts >= '2026-09-25'
   and t.position_address in (select distinct position_address from position_events
                              where kind in ('adopt', 'straddle') and created_at >= '2026-09-20')
 order by t.position_address, t.ts
) to stdout with csv;
