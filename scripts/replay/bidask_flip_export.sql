-- Piped over stdin to psql on the VM (read-only: a single COPY of a SELECT), e.g. gzip-compressed for scripts/replay/bidask_flip_replay.js --ticks.
-- Output: gzip CSV, no header: position_address,t(epoch s),active_bin,pnl_pct (pnl_pct may be empty); poller ticks only.
-- Rows are deduplicated on unchanged (active_bin, pnl_pct) per position, ordered by position then time.
copy (
 select position_address, round(extract(epoch from ts))::bigint as t, active_bin, pnl_pct
 from (
   select position_address, ts, active_bin, pnl_pct,
     lag(active_bin) over w as pb, lag(pnl_pct) over w as pp
   from price_ticks
   where position_address is not null and source='poller' and ts >= '2026-09-25'
   window w as (partition by position_address order by ts)
 ) s
 where pb is null or pb is distinct from active_bin or pp is distinct from pnl_pct
 order by position_address, ts
) to stdout with csv;
