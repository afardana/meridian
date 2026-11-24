-- grace_lock_replay.js — position rows (read-only: one COPY of a SELECT), piped over stdin to psql on the VM.
-- Output: CSV, no header: position_address,closed_at(epoch ms),json — json = the grace/hold/adoption/straddle keys of positions.data.
-- Covers every position closed on or after 2026-09-25 (the replay filters further against the perf records).
copy (
 select position_address,
   round(extract(epoch from closed_at) * 1000)::bigint as closed_ms,
   coalesce((select jsonb_object_agg(k, v) from jsonb_each(data) e(k, v)
             where k ~ '(grace|hold|held|adopt|stradd|deployed|closed|rebalance_count)'), '{}'::jsonb)::text as j
 from positions
 where closed_at >= '2026-09-25' or (closed = false)
 order by position_address
) to stdout with csv;
