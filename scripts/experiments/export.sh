#!/bin/bash
# Read-only export for the shadow grader: perf records + the rule-mode keys of prod user-config.json.
# No secrets: only keys ending in Mode / Enabled and a short allow-list of numeric rule keys are copied.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/.experiments/status"
mkdir -p "$OUT"
HOST="${MERIDIAN_VM:-root@oraclevm.fardana.com}"
ssh -o ConnectTimeout=15 "$HOST" 'bash -s' > "$OUT/performance.json.tmp" <<'REMOTE'
cd /tmp && sudo -u postgres psql -X -q -d meridian -At -c "select doc->'performance' from kv_store where key='lessons';"
REMOTE
python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,list) and len(d)>1000; print('records',len(d))" "$OUT/performance.json.tmp"
mv "$OUT/performance.json.tmp" "$OUT/performance.json"
ssh -o ConnectTimeout=15 "$HOST" 'bash -s' > "$OUT/modes.json.tmp" <<'REMOTE'
python3 - <<'PY'
import json
c=json.load(open('/opt/meridian/user-config.json'))
allow={'trailStraddleShadowTrigger','graceLockShadowArmPct','graceLockShadowDropPct','maxHoldMinutes','firstEntryProbationPct','firstEntryProbationMin','pumpGateMax24hPct','feeEdgeGateMin','reentryGateMinWinPct','reentryGateMinGapMin','reentryGateMaxGapMin','postStopCooldownHours','deployAmountSol','maxPositions','freshLanePollSec','freshLaneTrackHours'}
print(json.dumps({k:v for k,v in c.items() if k.endswith('Mode') or k.endswith('Enabled') or k in allow}, indent=1, sort_keys=True))
PY
REMOTE
python3 -I -c "import json,sys; json.load(open(sys.argv[1]))" "$OUT/modes.json.tmp" && mv "$OUT/modes.json.tmp" "$OUT/modes.json"
# Fresh top-performer lane (fresh-top-lane): paper trades + ticks for scripts/experiments/fresh_lane_sim.js
# and the scoreboard's paper-entry count. Read-only; tolerated when migration 008 is not applied yet.
for T in trades ticks; do
  ssh -o ConnectTimeout=15 "$HOST" "bash -s $T" > "$OUT/lane-$T.json.tmp" <<'REMOTE' || echo '[]' > "$OUT/lane-$T.json.tmp"
cd /tmp
if [ "$1" = trades ]; then Q="select coalesce(json_agg(t order by entered_at),'[]') from lane_paper_trades t"; else Q="select coalesce(json_agg(k order by trade_id, at),'[]') from lane_paper_ticks k"; fi
sudo -u postgres psql -X -q -d meridian -At -c "$Q" 2>/dev/null || echo '[]'
REMOTE
  python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,list); print('lane',sys.argv[2],len(d))" "$OUT/lane-$T.json.tmp" "$T" && mv "$OUT/lane-$T.json.tmp" "$OUT/lane-$T.json" || echo '[]' > "$OUT/lane-$T.json"
done
echo "exported to $OUT"
