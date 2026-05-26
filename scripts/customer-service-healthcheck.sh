#!/usr/bin/env bash
# customer-service healthcheck — раз в 5 минут через cron.
# Проверяет http://127.0.0.1:3002/healthz, ждёт ответ {"ok": true, "db": true}.
# При 2+ consecutive failures → алерт в @agent_dv_bot. При recovery — тоже.
#
# Дедуп через state-файл (last_state + fail_count).
#
# Используется для P0 #61 (silent failure customer-service = Customer-360
# без событий, KBD-лента отстаёт, merge-engine не запускается).
#
# Установка:
#   sudo cp customer-service-healthcheck.sh /usr/local/bin/
#   sudo chmod +x /usr/local/bin/customer-service-healthcheck.sh
#   echo "*/5 * * * * dv /usr/local/bin/customer-service-healthcheck.sh" \
#     | sudo tee /etc/cron.d/customer-service-healthcheck

set -uo pipefail

URL="${CS_HEALTHZ_URL:-http://127.0.0.1:3002/healthz}"
STATE_FILE="${STATE_FILE:-/tmp/cs-healthcheck.state}"
FAIL_THRESHOLD=2   # после 2 подряд failures (10 минут) — алерт
TIMEOUT_SEC=5

# Загружаем token + chat из agent-dv-bot/.env
AGENT_ENV=/home/dv/agent-dv-bot/.env
TOKEN=""
CHAT=""
if [ -f "$AGENT_ENV" ]; then
    TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$AGENT_ENV" 2>/dev/null | cut -d= -f2-)
    CHAT=$(grep '^TELEGRAM_ALLOWED_USER_IDS=' "$AGENT_ENV" 2>/dev/null | cut -d= -f2- | cut -d, -f1)
fi

send_alert() {
    local text="$1"
    if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
        # Без креденшалов — в stderr, чтобы systemd/cron поймал в логе
        echo "ALERT (no channel): $text" >&2
        return
    fi
    curl -sf -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${CHAT}" \
        --data-urlencode "text=${text}" \
        --data-urlencode "disable_web_page_preview=true" >/dev/null 2>&1 || true
}

# Загружаем prev state
last_state="ok"
fail_count=0
if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE" 2>/dev/null || true
fi

# Проверка
response=$(curl -fsS --max-time "$TIMEOUT_SEC" "$URL" 2>/dev/null || echo "")
ok=0
if [ -n "$response" ]; then
    # Проверяем {"ok":true,"db":true}
    if echo "$response" | grep -q '"ok"[[:space:]]*:[[:space:]]*true' && \
       echo "$response" | grep -q '"db"[[:space:]]*:[[:space:]]*true'; then
        ok=1
    fi
fi

if [ "$ok" -eq 1 ]; then
    # Success
    if [ "$last_state" = "fail" ]; then
        # Recovery
        send_alert "✅ customer-service /healthz восстановлен (был ${fail_count} failed check'ов подряд)"
    fi
    cat > "$STATE_FILE" <<EOF
last_state="ok"
fail_count=0
EOF
else
    # Failure
    fail_count=$((fail_count + 1))
    if [ "$last_state" = "ok" ] && [ "$fail_count" -ge "$FAIL_THRESHOLD" ]; then
        # Edge-trigger: первый раз перешли в failing после FAIL_THRESHOLD подряд
        send_alert "🚨 customer-service /healthz НЕ отвечает (${fail_count} проверок подряд за $((fail_count * 5)) мин). URL=${URL}. Runbook: ssh my-server → docker ps customer-service / journalctl или curl напрямую. Customer-360 events ingestion остановлен."
        cat > "$STATE_FILE" <<EOF
last_state="fail"
fail_count=${fail_count}
EOF
    else
        cat > "$STATE_FILE" <<EOF
last_state="${last_state}"
fail_count=${fail_count}
EOF
    fi
fi
