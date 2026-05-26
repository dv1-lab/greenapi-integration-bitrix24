# Performance baselines — adapter

Инструментирование latency / error rate adapter'а и snapshot baseline
цифр для SLO.md.

Last updated: 2026-05-26 (task #53).

---

## 🧰 Что инструментировано

### `PerformanceInterceptor` (NestJS global interceptor)

`src/common/perf.interceptor.ts` — оборачивает каждый HTTP-handler:

1. Перед handler → запоминает `process.hrtime.bigint()` (наносекунды)
2. После handler (или throw) → diff → ms
3. Записывает в `PerfMetricsService`:
   - endpoint key: `${method} ${route}` (route — pattern, не resolved URL)
   - latency в мс (float)
   - status code (200/4xx/5xx/etc.)

Overhead per request: ~5-15 μs (hrtime + Map lookup + ring buffer write).
Незаметно на фоне даже самых быстрых endpoints.

### `PerfMetricsService` (in-memory storage)

`src/common/perf-metrics.service.ts`:

- Ring buffer на 1000 sample'ов per endpoint
- Абсолютный счётчик `totalCount` per endpoint (не урезается ring'ом)
- Error counter (status >= 500)
- Status code histogram per endpoint
- При запросе `/health/metrics` → сортировка ring buffer → percentile
  (p50/p95/p99/avg/min/max) с linear interpolation
- Hard cap 200 endpoints (защита от cardinality explosion)

### `GET /health/metrics` endpoint

`src/health/metrics.controller.ts`:

- Защищён header `X-Metrics-Token` (env `METRICS_TOKEN`)
- Без env-токена → endpoint открыт (только в dev)
- Возвращает JSON:
  ```json
  {
    "summary": { "uptimeSec", "totalRequests", "totalErrors", "globalErrorRate" },
    "endpoints": [
      { "endpoint": "POST /webhooks/green-api", "count": 1234, "p50": 45, "p95": 320, ... }
    ],
    "generatedAt": "2026-05-26T15:00:00Z"
  }
  ```
- Endpoints отсортированы по count убыванию

---

## 📊 Сбор baseline

### Способ 1: одноразовый snapshot

```bash
# С my-server (или через Tailscale)
ssh my-server 'curl -s -H "X-Metrics-Token: $METRICS_TOKEN" \
  http://127.0.0.1:3001/health/metrics' | jq '.endpoints[] |
  {endpoint, count, p50, p95, p99, errorRate}'
```

### Способ 2: cron-снимок раз в сутки в /home/dv/perf-baseline/

```bash
# /etc/cron.d/adapter-perf-baseline
0 4 * * * dv curl -s -H "X-Metrics-Token: $(cat ~/.adapter-metrics-token)" \
  http://127.0.0.1:3001/health/metrics \
  > /home/dv/perf-baseline/$(date +\%Y-\%m-\%d).json
```

(TODO: создать cron на сервере — пока этого нет.)

---

## 🎯 Baseline цифры (placeholder)

Заполнить **после** деплоя `PerformanceInterceptor` + сбора 24-часового
seed-периода. Сейчас числа в `SLO.md` — subjective оценки.

| Endpoint | Запросов/24ч | p50 (мс) | p95 (мс) | p99 (мс) | Error rate |
|---|---|---|---|---|---|
| `POST /webhooks/green-api` | TBD | TBD | TBD | TBD | TBD |
| `POST /webhooks/i2crm` | TBD | TBD | TBD | TBD | TBD |
| `POST /webhooks/bitrix24` | TBD | TBD | TBD | TBD | TBD |
| `POST /webhooks/telegram-bot/*` | TBD | TBD | TBD | TBD | TBD |
| `POST /widget/send` | TBD | TBD | TBD | TBD | TBD |
| `POST /widget/check-account` | TBD | TBD | TBD | TBD | TBD |
| `GET /widget/instances` | TBD | TBD | TBD | TBD | TBD |
| `GET /media/:file` | TBD | TBD | TBD | TBD | TBD |
| `POST /webhooks/internal/*` | TBD | TBD | TBD | TBD | TBD |

После первой недели deployment Дмитрию (или мне в следующей сессии) —
обновить эту таблицу реальными числами.

---

## ⚠️ Что НЕ покрыто

1. **Memory leaks** — не меряем. `process.memoryUsage()` есть, можно
   добавить в `/health/metrics` summary (TODO).
2. **Event loop lag** — не меряем. Для async heavy кода важно.
   `perf_hooks` от Node.
3. **Database query duration** — не отдельно. Prisma имеет встроенный
   `$on('query')`, можно подключить (TODO P3).
4. **Outbound HTTP** к B24/GreenAPI/i2crm — не меряем латенцию этих
   вызовов. Они часть endpoint p95, но не разделены. Для дебагинга
   полезно отдельно (TODO).
5. **Histogram** — мы делаем percentile из 1000 samples. Это
   достаточно для оценки, но не точно для очень редких outlier'ов
   (нужно > 10000 samples для p99.9). Acceptable для baseline.
6. **Долгосрочное хранение** — данные пропадают при рестарте.
   Для history → нужно flushing в CH/Prometheus. TODO.

---

## 🔧 Запуск в проде

В `/home/dv/greenapi-b24/.env`:

```bash
METRICS_TOKEN=<сгенерировать через openssl rand -hex 24>
```

После deploy `docker compose up -d adapter --build --force-recreate`:

```bash
# Проверка
ssh my-server 'curl -H "X-Metrics-Token: $TOKEN" \
  http://127.0.0.1:3001/health/metrics | jq .summary'
```

Должно вернуть `{ "uptimeSec", "endpointsTracked", "totalRequests", ... }`.

---

## 📈 Что мы получаем

| Раньше (subjective) | Теперь (measured) |
|---|---|
| «adapter работает быстро» | p95 = X мс per endpoint |
| «иногда тормозит» | конкретный endpoint с outlier'ами |
| SLO в SLO.md = «unknown» | реальные числа |
| Performance regression — детектится по жалобе | детектится по росту p95 |

---

## 📚 Связано

- `SLO.md` — формальные SLO, обновляются числами из этой страницы
- `MONITORING.md` — здесь будут alerting rules на /health/metrics
- `src/common/perf-metrics.service.ts` — implementation
- `src/common/perf.interceptor.ts` — interceptor
- `src/health/metrics.controller.ts` — endpoint
