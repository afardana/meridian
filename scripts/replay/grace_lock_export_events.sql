-- grace_lock_replay.js — position_events (read-only: one COPY of a SELECT), piped over stdin to psql on the VM.
-- Output: CSV, no header: position_address,kind,created_at(epoch ms),payload json. Every event since 2026-09-20.
copy (
 select position_address, kind, round(extract(epoch from created_at) * 1000)::bigint as t_ms, payload::text
 from position_events
 where created_at >= '2026-09-20' and position_address is not null
 order by position_address, created_at, id
) to stdout with csv;
