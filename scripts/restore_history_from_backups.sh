#!/usr/bin/env bash
# Restore history that the old retention deleted, from the daily pg_dump files and the
# leftover copies inside the live database (2026-09-26, operator: "restore the old history").
#
# INSERT-only and idempotent: rows are added only where the live table has nothing for
# that time (ticks / balance samples older than the live minimum, liquidity ticks absent
# by (position, captured_at)), and document items only when neither the live document nor
# history_archive already holds them (md5 of the jsonb item). Nothing live is updated or
# deleted. Takes a fresh pg_dump first. Run on the VM as root:
#   bash /opt/meridian/scripts/restore_history_from_backups.sh
set -euo pipefail

cd /opt/meridian
export PGPASSWORD="$(grep -E '^PGPASSWORD=' .env | cut -d= -f2-)"
LIVE=(psql -h 127.0.0.1 -U meridian -d meridian -v ON_ERROR_STOP=1 -q)
LIVE_AT=(psql -h 127.0.0.1 -U meridian -d meridian -At -v ON_ERROR_STOP=1)
SCRATCH_DB=meridian_restore
SU=(sudo -u postgres psql -v ON_ERROR_STOP=1 -q)
BACKUP_DIR=/opt/meridian-backups
STAMP=$(date +%Y%m%d-%H%M%S)

echo "== 1. safety dump of the live database"
sudo -u angga env PGPASSWORD="$PGPASSWORD" pg_dump -h 127.0.0.1 -U meridian -d meridian -Fc -f "$BACKUP_DIR/meridian-pre-restore-$STAMP.dump"
ls -la "$BACKUP_DIR/meridian-pre-restore-$STAMP.dump" | awk '{print "   ", $5, "bytes"}'

LIVE_TICK_MIN=$("${LIVE_AT[@]}" -c "select min(ts) from price_ticks")
LIVE_BAL_MIN=$("${LIVE_AT[@]}" -c "select min(created_at) from balance_history")
echo "   live price_ticks from $LIVE_TICK_MIN, balance_history from $LIVE_BAL_MIN"

echo "== 2. staging schema in the live database"
"${LIVE[@]}" <<'SQL'
drop schema if exists restore_stage cascade;
create schema restore_stage;
create table restore_stage.stage_price_ticks (pool_address text, position_address text, ts timestamptz, active_bin int, pnl_pct double precision, price double precision, source text);
create table restore_stage.stage_balance (total_usd text, snapshot jsonb, created_at timestamptz);
create table restore_stage.stage_liq (position_address text, pool_address text, pair text, captured_at timestamptz, liquidity_usd double precision, liquidity_sol double precision, liq_x_usd double precision, liq_y_usd double precision, valuation_quality text, value_valid boolean);
create table restore_stage.stage_kv (dump text, key text, doc jsonb);
create function restore_stage.safe_ts(t text) returns timestamptz language plpgsql immutable as $$
begin return t::timestamptz; exception when others then return null; end $$;
SQL

echo "== 3. unpack each dump into a scratch database and stage what it holds"
OLDEST=$(ls "$BACKUP_DIR"/meridian-2026*.dump | sort | head -1)
for DUMP in $(ls "$BACKUP_DIR"/meridian-2026*.dump | sort); do
  NAME=$(basename "$DUMP" .dump)
  "${SU[@]}" -d postgres -c "drop database if exists $SCRATCH_DB" -c "create database $SCRATCH_DB"
  TABLES=(-t kv_store -t position_liquidity_ticks)
  if [ "$DUMP" = "$OLDEST" ]; then TABLES+=(-t price_ticks -t balance_history); fi
  sudo -u postgres pg_restore -d "$SCRATCH_DB" --no-owner --no-privileges "${TABLES[@]}" "$DUMP" 2>/dev/null || true
  sudo -u postgres psql -d "$SCRATCH_DB" -At -c "\copy (select '$NAME', key, doc from kv_store where key in ('pool-memory','rejected-candidates','decision-log','error-telemetry','lessons')) to stdout" \
    | "${LIVE[@]}" -c "\copy restore_stage.stage_kv from stdin"
  sudo -u postgres psql -d "$SCRATCH_DB" -At -c "\copy (select position_address, pool_address, pair, captured_at, liquidity_usd, liquidity_sol, liq_x_usd, liq_y_usd, valuation_quality, value_valid from position_liquidity_ticks) to stdout" 2>/dev/null \
    | "${LIVE[@]}" -c "\copy restore_stage.stage_liq from stdin" || true
  if [ "$DUMP" = "$OLDEST" ]; then
    sudo -u postgres psql -d "$SCRATCH_DB" -At -c "\copy (select pool_address, position_address, ts, active_bin, pnl_pct, price, source from price_ticks where ts < '$LIVE_TICK_MIN') to stdout" \
      | "${LIVE[@]}" -c "\copy restore_stage.stage_price_ticks from stdin"
    sudo -u postgres psql -d "$SCRATCH_DB" -At -c "\copy (select total_usd::text, snapshot, created_at from balance_history where created_at < '$LIVE_BAL_MIN') to stdout" \
      | "${LIVE[@]}" -c "\copy restore_stage.stage_balance from stdin"
  fi
  echo "   $NAME staged"
done
"${SU[@]}" -d postgres -c "drop database if exists $SCRATCH_DB"
"${LIVE_AT[@]}" -F' ' -c "select 'staged:', (select count(*) from restore_stage.stage_price_ticks) ticks, (select count(*) from restore_stage.stage_balance) balance, (select count(*) from restore_stage.stage_liq) liq, (select count(*) from restore_stage.stage_kv) kv_docs"

echo "== 4. insert into the live tables (one transaction)"
"${LIVE[@]}" <<'SQL'
begin;

-- price ticks older than anything live (oldest dump only)
insert into price_ticks (pool_address, position_address, ts, active_bin, pnl_pct, price, source)
select distinct pool_address, position_address, ts, active_bin, pnl_pct, price, source
from restore_stage.stage_price_ticks
where ts < (select min(ts) from price_ticks);

-- balance samples older than anything live: oldest dump + the 09-06 backup table +
-- the pre-normalisation kv document (June)
insert into balance_history (total_usd, snapshot, created_at)
select distinct on (created_at) nullif(total_usd, '')::numeric, snapshot, created_at from (
  select total_usd, snapshot, created_at from restore_stage.stage_balance
  union all
  select total_usd::text, snapshot, created_at from public.balance_history_backup_20260906
  union all
  select e->>'totalUsd', e, restore_stage.safe_ts(e->>'ts')
  from kv_store, jsonb_array_elements(case when jsonb_typeof(doc) = 'array' then doc else '[]'::jsonb end) e
  where key = 'balance-history'
) x
where created_at is not null and created_at < (select min(created_at) from balance_history)
order by created_at;

-- liquidity ticks absent from the live table
insert into position_liquidity_ticks (position_address, pool_address, pair, captured_at, liquidity_usd, liquidity_sol, liq_x_usd, liq_y_usd, valuation_quality, value_valid)
select distinct on (s.position_address, s.captured_at) s.position_address, s.pool_address, s.pair, s.captured_at, s.liquidity_usd, s.liquidity_sol, s.liq_x_usd, s.liq_y_usd, s.valuation_quality, coalesce(s.value_valid, true)
from restore_stage.stage_liq s
where not exists (select 1 from position_liquidity_ticks l where l.position_address = s.position_address and l.captured_at = s.captured_at);

-- document items that left the hot window before archiving existed → history_archive
create temp table cand (store text, key text, item_ts timestamptz, item jsonb, h text) on commit drop;

insert into cand
select 'pool-snapshots', p.key, restore_stage.safe_ts(s->>'ts'), s, md5(s::text)
from restore_stage.stage_kv r, jsonb_each(r.doc) p,
     jsonb_array_elements(case when jsonb_typeof(p.value->'snapshots') = 'array' then p.value->'snapshots' else '[]'::jsonb end) s
where r.key = 'pool-memory';

insert into cand
select 'rejected-reasons', p.key, restore_stage.safe_ts(s->>'ts'), s, md5(s::text)
from restore_stage.stage_kv r, jsonb_each(r.doc) p,
     jsonb_array_elements(case when jsonb_typeof(p.value->'reasons') = 'array' then p.value->'reasons' else '[]'::jsonb end) s
where r.key = 'rejected-candidates';

insert into cand
select 'rejected-snaps', p.key, restore_stage.safe_ts(s->>'ts'), s, md5(s::text)
from restore_stage.stage_kv r, jsonb_each(r.doc) p,
     jsonb_array_elements(case when jsonb_typeof(p.value->'snaps') = 'array' then p.value->'snaps' else '[]'::jsonb end) s
where r.key = 'rejected-candidates';

insert into cand
select 'decision-log', null, restore_stage.safe_ts(s->>'ts'), s, md5(s::text)
from restore_stage.stage_kv r,
     jsonb_array_elements(case when jsonb_typeof(r.doc->'decisions') = 'array' then r.doc->'decisions' else '[]'::jsonb end) s
where r.key = 'decision-log';

insert into cand
select 'error-telemetry', null, restore_stage.safe_ts(s->>'ts'), s, md5(s::text)
from restore_stage.stage_kv r,
     jsonb_array_elements(case when jsonb_typeof(r.doc) = 'array' then r.doc else '[]'::jsonb end) s
where r.key = 'error-telemetry';

insert into cand
select 'lessons-evolutions', null, restore_stage.safe_ts(s->>'ts'), s, md5(s::text)
from restore_stage.stage_kv r,
     jsonb_array_elements(case when jsonb_typeof(r.doc->'evolutions') = 'array' then r.doc->'evolutions' else '[]'::jsonb end) s
where r.key = 'lessons';

insert into cand
select 'lessons-auto', null, restore_stage.safe_ts(s->>'created_at'), s, md5(s::text)
from restore_stage.stage_kv r,
     jsonb_array_elements(case when jsonb_typeof(r.doc->'lessons') = 'array' then r.doc->'lessons' else '[]'::jsonb end) s
where r.key = 'lessons' and s->>'sourceType' = 'performance';

-- what the live documents still hold (not archived — already present)
create temp table cur (store text, h text) on commit drop;
insert into cur
select 'pool-snapshots', md5(s::text) from kv_store k, jsonb_each(k.doc) p,
  jsonb_array_elements(case when jsonb_typeof(p.value->'snapshots') = 'array' then p.value->'snapshots' else '[]'::jsonb end) s where k.key = 'pool-memory'
union all
select 'rejected-reasons', md5(s::text) from kv_store k, jsonb_each(k.doc) p,
  jsonb_array_elements(case when jsonb_typeof(p.value->'reasons') = 'array' then p.value->'reasons' else '[]'::jsonb end) s where k.key = 'rejected-candidates'
union all
select 'rejected-snaps', md5(s::text) from kv_store k, jsonb_each(k.doc) p,
  jsonb_array_elements(case when jsonb_typeof(p.value->'snaps') = 'array' then p.value->'snaps' else '[]'::jsonb end) s where k.key = 'rejected-candidates'
union all
select 'decision-log', md5(s::text) from kv_store k,
  jsonb_array_elements(case when jsonb_typeof(k.doc->'decisions') = 'array' then k.doc->'decisions' else '[]'::jsonb end) s where k.key = 'decision-log'
union all
select 'error-telemetry', md5(s::text) from kv_store k,
  jsonb_array_elements(case when jsonb_typeof(k.doc) = 'array' then k.doc else '[]'::jsonb end) s where k.key = 'error-telemetry'
union all
select 'lessons-evolutions', md5(s::text) from kv_store k,
  jsonb_array_elements(case when jsonb_typeof(k.doc->'evolutions') = 'array' then k.doc->'evolutions' else '[]'::jsonb end) s where k.key = 'lessons'
union all
select 'lessons-auto', md5(s::text) from kv_store k,
  jsonb_array_elements(case when jsonb_typeof(k.doc->'lessons') = 'array' then k.doc->'lessons' else '[]'::jsonb end) s where k.key = 'lessons';
create index on cur (store, h);

insert into history_archive (store, key, item_ts, item)
select distinct on (c.store, c.key, c.h) c.store, c.key, c.item_ts, c.item
from cand c
where not exists (select 1 from cur where cur.store = c.store and cur.h = c.h)
  and not exists (select 1 from history_archive a where a.store = c.store and md5(a.item::text) = c.h)
order by c.store, c.key, c.h, c.item_ts;

commit;
SQL

echo "== 5. result"
"${LIVE_AT[@]}" -F' | ' -c "select 'price_ticks', min(ts), count(*) from price_ticks union all select 'balance_history', min(created_at), count(*) from balance_history union all select 'position_liquidity_ticks', min(captured_at), count(*) from position_liquidity_ticks"
"${LIVE_AT[@]}" -F' | ' -c "select store, count(*), min(item_ts), max(item_ts) from history_archive group by 1 order by 1"
"${LIVE[@]}" -c "drop schema restore_stage cascade"
echo "== done (safety dump: $BACKUP_DIR/meridian-pre-restore-$STAMP.dump)"
