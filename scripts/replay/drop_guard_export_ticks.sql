-- Tick export for scripts/replay/drop_guard_study.js (docs/experiments/unchanged-bin-drop-guard.md).
-- Piped over stdin to psql on the VM (read-only: a single COPY of a SELECT), gzip-compressed in the pipe:
--   ssh root@oraclevm.fardana.com 'cd /tmp && sudo -u postgres psql -X -q -d meridian' \
--     < scripts/replay/drop_guard_export_ticks.sql | gzip > ticks.csv.gz
-- Output: CSV, no header: position_address,t(epoch ms),active_bin,pnl_pct — POLLER rows only (socket rows carry
-- the bin only), every position (bot and operator, held or not) since 2026-10-05 00:00Z.
-- Rows whose (active_bin, pnl_pct) repeat the previous row of the same position are dropped (window lag), so
-- consecutive rows are distinct valuations; "the reading at time T" is the last row at or before T.
copy (
 select position_address, round(extract(epoch from ts) * 1000)::bigint as t, active_bin, pnl_pct
 from (
   select position_address, ts, active_bin, pnl_pct,
     lag(active_bin) over w as pb, lag(pnl_pct) over w as pp
   from price_ticks
   where position_address is not null and source = 'poller' and ts >= '2026-10-05T00:00:00Z'
   window w as (partition by position_address order by ts)
 ) s
 where pb is null or pb is distinct from active_bin or pp is distinct from pnl_pct
 order by position_address, ts
) to stdout with csv;
