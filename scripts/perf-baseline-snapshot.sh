#!/usr/bin/env bash
# Ежедневный snapshot /health/metrics в /home/dv/perf-baseline/YYYY-MM-DD.json
#
# Запускается cron'ом раз в сутки в ~03:00 МСК (до restart adapter'а в
# момент deploy'а — чтобы зафиксировать состояние за сутки).
#
# Также пингает Healthchecks (если HC_PERF_PING_URL задан).
#
# Установка:
#   sudo cp perf-baseline-snapshot.sh /usr/local/bin/
#   sudo chmod +x /usr/local/bin/perf-baseline-snapshot.sh
#   echo "0 3 * * * dv /usr/local/bin/perf-baseline-snapshot.sh" \
#     | sudo tee /etc/cron.d/perf-baseline-snapshot

set -uo pipefail

OUT_DIR="${OUT_DIR:-/home/dv/perf-baseline}"
URL="${ADAPTER_METRICS_URL:-http://127.0.0.1:3001/health/metrics}"
ENV_FILE="${ENV_FILE:-/home/dv/greenapi-b24/.env}"

mkdir -p "$OUT_DIR"

# Достаём METRICS_TOKEN
if [ -f "$ENV_FILE" ]; then
    TOKEN=$(awk -F= '/^METRICS_TOKEN=/{print substr($0, length($1)+2)}' "$ENV_FILE")
else
    TOKEN=""
fi

DATE=$(date -u +%Y-%m-%d)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
OUT="$OUT_DIR/$DATE.json"

# Снимок (timestamp оборачиваем сверху metadata-объектом)
RAW=$(curl -fsS --max-time 10 -H "X-Metrics-Token: $TOKEN" "$URL" 2>/dev/null || echo '{"error":"fetch-failed"}')
python3 -c "
import json, sys
data = json.loads('''$RAW''')
out = {'snapshot_at': '$TS', 'host': 'my-server', 'service': 'greenapi-b24-adapter'}
out.update(data)
print(json.dumps(out, indent=2, ensure_ascii=False))
" > "$OUT"

# Retention: храним 30 дней, старше — удаляем
find "$OUT_DIR" -name "*.json" -mtime +30 -delete 2>/dev/null || true
