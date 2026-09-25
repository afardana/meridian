#!/usr/bin/env bash
# Read-only snapshot of ONE tracked position from the production VM (Meridian, PERSIST_BACKEND=pg).
# Prints: the positions row, the last N poller ticks (pnl/active_bin/price), the live pool tick rate,
# and the last agent log lines mentioning the position/pair. NO writes, NO restarts, NO config edits.
#
# usage: scripts/watch/position_snapshot.sh <position_address> [ticks=40] [loglines=25]
set -euo pipefail
POS="${1:?position_address required}"
TICKS="${2:-40}"
LOGN="${3:-25}"
HOST="${MERIDIAN_VM:-root@oraclevm.fardana.com}"

ssh -o ConnectTimeout=15 -o BatchMode=yes "$HOST" "cd /opt/meridian && export PGPASSWORD=\$(grep -E '^PGPASSWORD=' .env | cut -d= -f2-) && \
echo '### position' && \
psql -h 127.0.0.1 -U meridian -d meridian -At -F'|' -c \"select pair, lower_bin, upper_bin, deployed_at, data->>'pool' as pool, data->>'base_mint' as base_mint, data->>'strategy' as strategy, data->>'amount_sol' as amount_sol, data->>'amount_x' as amount_x, data->>'peak_pnl_pct' as peak_pnl, data->>'trailing_active' as trailing, data->>'lane' as lane, data->>'adopted_at' as adopted_at, data->>'profit_grace_until' as grace_until, data->>'out_of_range_since' as oor_since, data->>'straddle_count' as straddles, data->>'rebalance_count' as rebalances from positions where position_address='$POS'\" && \
echo '### ticks (newest first): ts|active_bin|pnl_pct|price|source' && \
psql -h 127.0.0.1 -U meridian -d meridian -At -F'|' -c \"select to_char(ts,'HH24:MI:SS'), active_bin, pnl_pct, price, source from price_ticks where position_address='$POS' and pnl_pct is not null order by ts desc limit $TICKS\" && \
echo '### bin transitions last 15 min (socket rows): count, min_bin, max_bin' && \
psql -h 127.0.0.1 -U meridian -d meridian -At -F'|' -c \"select count(*), min(active_bin), max(active_bin) from price_ticks where position_address='$POS' and ts > now() - interval '15 minutes'\" && \
echo '### agent log (last $LOGN lines mentioning the position or its pair)' && \
PAIR=\$(psql -h 127.0.0.1 -U meridian -d meridian -At -c \"select pair from positions where position_address='$POS'\") && \
(sudo -u angga pm2 logs meridian --nostream --lines 4000 2>/dev/null | grep -E \"\$PAIR|${POS:0:8}\" | tail -n $LOGN || true)"
