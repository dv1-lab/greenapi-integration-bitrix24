# SLO + Error Budget — Social Connector ecosystem

Технические целевые показатели сервисов. Отличается от
[`SLA_RULES.md`](./SLA_RULES.md):

- **SLA** = бизнес-обязательство к **клиенту** («ответим за 30 мин»)
- **SLO** = технический целевой показатель к **сервису** («adapter
  доступен ≥ 99.5%»)
- **SLI** = метрика которой меряем («HTTP 2xx rate за 30 дней»)
- **Error budget** = 100% − SLO («1 час downtime в неделю»)

Last reviewed: 2026-05-26 (task #49).

---

## 📈 Baseline (первый seed-снимок 2026-05-26 11:29 UTC, 19 мин uptime)

**Источник:** `/health/metrics` после `f254590` deploy + 19 мин нормальной нагрузки.
174 запроса, **0 errors (0.00% error rate)** глобально.

| Endpoint | Req | p50 | p95 | p99 | err |
|---|---:|---:|---:|---:|---:|
| `POST /webhooks/b24-event` | 80 | 266 ms | **635 ms** | 852 ms | 0% |
| `GET /` (B24 placement landing) | 38 | 2 ms | 7 ms | 12 ms | 0% |
| `POST /webhooks/green-api` | 13 | 232 ms | **1192 ms** | 1238 ms | 0% |
| `POST /webhooks/bitrix24` | 8 | 601 ms | **6293 ms** ⚠️ | 8311 ms | 0% |
| `POST /webhooks/internal/contact-name` | 7 | 274 ms | 1297 ms | 1562 ms | 0% |
| `POST /webhooks/i2crm` | 5 | 1441 ms | 1865 ms | 1877 ms | 0% |
| `POST /widget/send-first` | 3 | 3 ms | 3 ms | 3 ms | 0% |
| `GET /widget/instances` | 3 | 4 ms | 4 ms | 4 ms | 0% |
| `POST /webhooks/telegram-bot` | 3 | 944 ms | 3824 ms | 4080 ms | 0% |

**Наблюдения для action:**
- 🟢 `GET /` (placement landing) — 7 ms p95: отлично
- 🟡 `POST /webhooks/b24-event` (635 ms p95) и `green-api` (1192 ms p95) —
  доминируются B24 imconnector.send round-trip. SLO «<2 сек» соблюдается, но
  редкие outliers >1 сек видно (см. p99).
- 🔴 `POST /webhooks/bitrix24` (6293 ms p95, 8311 ms p99) — серьёзно медленно.
  Этот endpoint handle'ит ONIMCONNECTORMESSAGEADD от B24, делает chain
  i2crm /target/feedback или Green API /sendMessage + customer-360 update.
  Нужен deeper analysis: hotpath profiling, возможна оптимизация (parallel
  Customer-360 + outgoing).
- 🔴 `POST /webhooks/i2crm` (1441 ms p50) — даже медиан выше 1 сек.
  Внутри: I2crmEventLog upsert + ensureLead + imconnector.send.messages +
  tg-mirror. Каждый шаг — сетевой round-trip.

Следующий snapshot — 03:00 UTC ежедневно через cron
`/usr/local/bin/perf-baseline-snapshot.sh` → `/home/dv/perf-baseline/`.
Retention 30 дней.

---

## 📊 Главные SLO

| Сервис | SLI | SLO | Error budget / месяц |
|---|---|---|---|
| **adapter** (social.9wb.ru) | HTTP availability | **99.5%** | 3.6ч downtime |
| **adapter** webhook ingest p95 | latency на `/webhooks/*` | **< 2 сек** | — |
| **customer-service** (`:3002`) | HTTP availability | **99.5%** | 3.6ч |
| **customer-service** `/events/ingest` p95 | latency | **< 500 мс** | — |
| **wa-tg-bridge** | systemd active uptime | **99.0%** | 7.2ч |
| **dv-dashboard** (dashboard.9wb.ru) | HTTP availability | **99.0%** | 7.2ч |
| **ClickHouse** (customer360) | query success rate | **99.9%** | 0.7ч |
| **Postgres** (customer-service) | query success rate | **99.9%** | 0.7ч |
| **MySQL** (adapter) | query success rate | **99.9%** | 0.7ч |
| **Green API ingress** | webhook delivery (3rd party) | **99% from GA side** | 7.2ч (не наш) |
| **Bitrix24 REST API** | uptime (3rd party) | **99%** | 7.2ч (не наш) |
| **B24 outgoing → клиент** | end-to-end delivery (read status) | **95%** за 1 час | 5% |

---

## 🎯 Детально по сервисам

### 1. adapter (Social Connector REST API)

**Что**: NestJS на `social.9wb.ru:443` (Caddy → 127.0.0.1:3000),
обрабатывает webhooks от Green API, B24, i2crm, наших ботов.

| SLI | Цель | Текущее | Как меряем |
|---|---|---|---|
| HTTP availability | 99.5% (3.6ч/мес) | ~99.9% (subjective) | Uptime Kuma probe `/health`, Caddy access log 5xx rate |
| `/webhooks/*` latency p95 | < 2 сек | unknown | TODO: nginx/Caddy log percentiles |
| `/webhooks/*` error rate (5xx) | < 0.1% | unknown | TODO: tech-monitor alert на > 1% |
| imconnector.send.messages latency p95 | < 5 сек (включая B24) | unknown | TODO: log timer вокруг B24 calls |
| OAuth refresh success rate | 99.9% | unknown | TODO: log counter |

**Чтобы заполнить gap'ы** — см. [`PERFORMANCE.md`](./PERFORMANCE.md):
с 2026-05-26 (#53) подключен `PerformanceInterceptor` (мерит latency
каждого endpoint) + `/health/metrics` endpoint. После недели baseline-сбора
сюда впишем реальные p50/p95/p99/error rate.

### 2. customer-service (Master DB клиентов)

**Что**: NestJS на `127.0.0.1:3002` (только из my-server, не публичный),
Postgres + ClickHouse писатель.

| SLI | Цель | Как меряем |
|---|---|---|
| HTTP availability | 99.5% | Uptime Kuma probe `/health` (TODO: monitor добавить) |
| `/events/ingest` p95 | < 500 мс | TODO: NestJS interceptor + log |
| `/aliases/lookup` p95 | < 100 мс | TODO |
| `/customers/by-alias` p95 | < 200 мс | TODO |
| CH INSERT success rate | 99.9% | adapter logs «CH ingest failed» |
| PG transaction success rate | 99.9% | NestJS errors logs |

### 3. wa-tg-bridge

**Что**: Python aiogram на my-server (`/home/dv/wa-tg-bridge/`),
systemd unit `wa-tg-bridge.service`, polls Green API instances каждые 45s.

| SLI | Цель | Как меряем |
|---|---|---|
| systemd active | 99.0% (7.2ч/мес) | systemd watchdog + monitor-bot daily check |
| TG-зеркало message lag p95 | < 60 сек | TODO |
| Green API state=authorized | 100% инстансов | TODO: alert если state≠authorized |
| `/internal/*` endpoint латентность | < 500 мс | в логах adapter |

### 4. dv-dashboard

**Что**: Next.js 16 на `dashboard.9wb.ru` за Caddy basic_auth,
читает CH + Postgres + SQLite (wa-tg-bridge), не пишет.

| SLI | Цель | Как меряем |
|---|---|---|
| HTTP availability | 99.0% | Uptime Kuma (TODO добавить) |
| page render p95 | < 3 сек | client-side perf (не меряем сейчас) |
| `/customer-360/*` p95 (CH query) | < 2 сек | server logs |

### 5. ClickHouse customer360

**Что**: BD на 127.0.0.1:8123, главное хранилище customer_events.

| SLI | Цель | Как меряем |
|---|---|---|
| query success rate | 99.9% | Healthcheck cron 5 мин (есть!) |
| INSERT latency p95 | < 200 мс | TODO |
| Disk usage (data/ partition) | < 80% | monitor-bot daily |
| Replication lag (нет replication, gap) | n/a | n/a |

### 6. Postgres customer-service

**Что**: PG16 в Docker на my-server, customer_service БД.

| SLI | Цель | Как меряем |
|---|---|---|
| query success rate | 99.9% | NestJS errors |
| connection pool exhaustion | 0 events/неделя | TODO: Prisma log |
| Disk usage | < 70% | monitor-bot daily |

### 7. MySQL adapter

**Что**: MySQL 8 в Docker, adapter БД (~13 таблиц).

| SLI | Цель | Как меряем |
|---|---|---|
| query success rate | 99.9% | adapter logs |
| Connection pool | < 80% utilisation | TODO |
| Disk usage | < 70% | monitor-bot daily |

---

## 🔥 Бизнес-критичные end-to-end SLO

Не отдельные сервисы, а сквозные пути.

### E2E-1: Incoming WA → видно в B24 ≤ 30 сек p95

**SLI**: время от Green API webhook receipt до появления message в B24
open-line (видно оператору). Меряем через ingestion timestamp в
`I2crmEventLog`/`OutgoingMessage` + `crm.timeline.add.complete` callback.

| SLO | Текущее |
|---|---|
| p95 < 30 сек | unknown (TODO: instrument) |
| p99 < 60 сек | unknown |

**Если ломается**: оператор видит «висит» сообщение, клиент не получает
ответ. SLA `FRT ≤ 30 мин` под угрозой.

### E2E-2: Outgoing operator B24 → доставлено клиенту ≤ 5 мин p95

**SLI**: от ONIMCONNECTORMESSAGEADD до Green API `delivery_status='delivered'`
(или `read`). Меряем через `OutgoingMessage.lastStatusSeen`.

| SLO | Текущее |
|---|---|
| p95 < 5 мин | ~normal в логах, но не measured |
| p99 < 30 мин | — |

**Если ломается**: клиент не получает ответ, оператор переотправляет, dual-delivery.

### E2E-3: Customer-360 event ingestion ≤ 10 сек p95

**SLI**: время от incoming/outgoing в adapter до появления event в
ClickHouse customer_events.

| SLO | Текущее |
|---|---|
| p95 < 10 сек | unknown |
| Lost events rate < 0.1% | unknown (нет dead-letter queue) |

**Если ломается**: KBD-лента в TG отстаёт, customer-360 dashboard
показывает stale данные.

---

## 💸 Error budget — как тратим

Error budget = 100% − SLO. Например, 99.5% availability = 3.6ч downtime в месяц.

### Когда сжигаем

- **Запланированные**: deploy с restart (~30 сек × ~5 раз/месяц = 2.5 мин)
- **Незапланированные**: bugs, hardware, network — всё остальное

### Когда тревога

- **50% бюджета сожжено за < 50% месяца** → review, ставить hold на новые фичи
- **80% бюджета сожжено** → freeze deploys, только хотфиксы
- **100% бюджета** → откат к последнему стабильному, post-mortem обязательно

### Сейчас (subjective, нет measurement)

Адаптер деплоится ~5 раз/неделю, обычно без даунтайма (docker compose
up --build делает rolling). Реальный downtime — это инциденты:
- 18.05.26 — Lightning Wab/Wax race на 1begovoy.ru (но это не наш adapter)
- 19.05.26 — IgBridge молча отключен 9 дней (silent failure)
- 25.05.26 — MySQL ротация heredoc literal (~30 мин down)
- 26.05.26 — нет инцидентов

С 2026-05-01 по сегодня: ~30 мин down → ~99.93% uptime adapter (estimate).

---

## 📈 План измерения (gap'ы)

Сейчас цифры в этом документе — **в основном цели и subjective оценки**.
Реальное measurement требует инструментирования:

| Gap | Решение |
|---|---|
| Latency p95 для всех endpoints | NestJS interceptor → log → парсинг → CH таблица `latency_events` |
| Error rate per endpoint | Caddy access log → parse → агрегация |
| End-to-end timing (E2E-1, 2, 3) | Trace ID в webhook → log timestamp на каждом шаге → diff в CH |
| Uptime по сервисам | Uptime Kuma monitors для каждого + Healthchecks ping |
| Burn rate alerting | Cron-скрипт: «за последний час > X errors → alert» |

Когда инструментировано — обновить эту таблицу с реальными числами,
поставить хитрые алерты в `MONITORING.md`.

---

## 🎯 Приоритеты для инструментирования

1. **P0**: `/webhooks/*` latency + error rate (adapter) — самые
   критичные endpoints
2. **P0**: E2E-1 (Incoming → B24) — это и есть FRT основной
3. **P1**: `/events/ingest` latency (customer-service) — KBD-лента lag
4. **P1**: wa-tg-bridge instance state monitor
5. **P2**: dv-dashboard performance
6. **P2**: остальные CH/PG/MySQL метрики

---

## 📚 Связано

- [`SLA_RULES.md`](./SLA_RULES.md) — бизнес-SLA для операторов
- [`MONITORING.md`](./MONITORING.md) — что-кому-куда алертит
- [`SERVICE_BLUEPRINT.md`](./SERVICE_BLUEPRINT.md) — все сервисы экосистемы
- `RUNBOOKS/incident-response.md` — что делать при превышении SLO
- ADR с пересмотром SLO (TODO создать при пересмотре)
