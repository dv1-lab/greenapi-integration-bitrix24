# Developer Portal — Social Connector API

Документация для внешних разработчиков. Базируется на OpenAPI 3.1 spec
из `/api-json` (см. `OPENAPI.md`), плюс guides, code examples, versioning
policy, changelog.

**Статус**: шаблон + структура. Активируется когда первый партнёр захочет
интегрироваться. Сейчас Swagger UI на `/api` (basic_auth) — достаточно
для тебя и backup-person.

Last updated: 2026-05-26 (task #56).

---

## 🎯 Что предоставляем

| API | Что | Где документировано |
|---|---|---|
| **Webhooks IN** (incoming) | Приём событий от партнёра в наш B24 | OpenAPI `/webhooks/*` |
| **Webhooks OUT** (outgoing) | Доставка наших событий партнёру | Webhooks reference §5 |
| **REST CRUD** | Customer-360 чтение (events, customers, aliases) | OpenAPI `/widget/*`, `/health/*` |
| **OAuth** | B24-style OAuth для multi-tenant | `OPENAPI.md` |

---

## 🚀 Quick Start (5 минут)

### 1. Получить креденшалы

Связаться: `kuznetsovd88@gmail.com`. Партнёру выдаётся:
- `API_KEY` (32 hex chars) — для server-server вызовов
- `WEBHOOK_SECRET` (для HMAC валидации incoming от нас) — TODO
- URL endpoint: `https://api.social-connector.9wb.ru/v1/*` — TODO subdomain

### 2. First call

```bash
curl -H "X-API-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     https://api.social-connector.9wb.ru/v1/health/metrics
```

Должен вернуть JSON с current latency / error rate.

### 3. Импорт в Postman

```bash
curl -H "X-API-Key: $API_KEY" \
     https://api.social-connector.9wb.ru/v1/api-json > openapi.json
```

Postman → Import → openapi.json → готово, все endpoints с типами и примерами.

### 4. Получить SDK (TODO когда будут партнёры)

```bash
# Python (auto-generated через openapi-generator-cli)
pip install social-connector-client  # TODO

# Node.js
npm install @9wb/social-connector  # TODO
```

---

## 📚 Guides

### Guide 1: Отправка outgoing сообщения через Webhook IN

**Use case**: партнёрская CRM хочет отправить сообщение клиенту в WhatsApp
через нашу инфру.

```bash
curl -X POST https://api.social-connector.9wb.ru/v1/widget/send \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "instance_id": 1101948511,
    "to": "+79991234567",
    "text": "Привет! Заказ #1234 готов к выдаче.",
    "channel": "whatsapp"
  }'

# Response:
# {
#   "success": true,
#   "idMessage": "BAE5...",
#   "deliveryStatus": "queued"
# }
```

Тайминги (см. SLO.md):
- p50: ~3 ms внутри adapter
- p95: ~3.8 sec (включая Green API round-trip)
- p99: до 8 sec (B24 backpressure)

### Guide 2: Подписка на webhook OUT

**Use case**: партнёр хочет получать события `message_in` от клиентов в
real-time, обрабатывать своим бэкендом.

```bash
# Регистрация webhook (1 раз)
curl -X POST https://api.social-connector.9wb.ru/v1/webhooks/subscribe \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": ["message_in", "deal_status_change"],
    "url": "https://partner.example.com/social-connector-hook",
    "secret": "your-webhook-secret"
  }'

# Когда событие происходит, мы POST'им к partner.example.com:
# {
#   "event": "message_in",
#   "ts": "2026-05-26T15:00:00Z",
#   "data": { "customer_uuid": "...", "channel": "WA", "text": "..." }
# }
# Header: X-Webhook-Signature: HMAC-SHA256(WEBHOOK_SECRET, body)
```

Партнёр должен:
- Вернуть HTTP 2xx за <2 сек, иначе у нас retry с exponential backoff
- Валидировать HMAC signature header
- Idempotent processing (мы можем повторно прислать тот же event)

### Guide 3: Customer-360 query

```bash
# Все события клиента за последние 30 дней
curl -H "X-API-Key: $API_KEY" \
  "https://api.social-connector.9wb.ru/v1/customer-360/events?customer_uuid=abc&from=2026-04-26T00:00:00Z"
```

См. полную схему в `DATA_MODEL.md` §3 (ClickHouse customer360).

---

## 🔐 Authentication & Authorization

### API Key (server-server)

Header `X-API-Key: <32 hex chars>`. Лежит у партнёра в их vault.
**Не logging** в plaintext.

**Rotation**:
- Recommended: каждый год
- Required: при подозрении на compromise
- Procedure: запрос новый key → grace period 7 дней (оба активны) → старый деактивируется

### OAuth (multi-tenant — для будущего)

OAuth 2.0 Authorization Code flow для случая когда партнёр — мульти-тенантная
платформа (например агентство которое обслуживает 100 клиентов через нас).

```
GET https://api.social-connector.9wb.ru/v1/oauth/authorize?
    client_id=<partner_id>&
    redirect_uri=<partner_callback>&
    scope=read_messages,send_messages&
    response_type=code
```

После consent — redirect с `code` → exchange на `access_token` (TTL 1ч) +
`refresh_token` (TTL год). Аналогично B24 OAuth (см. `SEQUENCES.md` #5).

### Scopes

| Scope | Что разрешает |
|---|---|
| `read_messages` | Чтение customer_events.message_in |
| `send_messages` | POST /widget/send |
| `read_customers` | Чтение customers, aliases |
| `write_customers` | Manual merge / alias add |
| `admin` | Все вышеперечисленное + /admin/* (super-user) |

---

## ⏱ Rate Limits

Per API key, sliding window 1 час:

| План | RPM | RPH |
|---|---|---|
| Free | 60 | 1000 |
| Pro | 600 | 10000 |
| Enterprise | unlimited | unlimited |

Headers в response:
- `X-RateLimit-Limit`: лимит per план
- `X-RateLimit-Remaining`: осталось до reset'а
- `X-RateLimit-Reset`: epoch sec когда reset

При превышении → **HTTP 429** + `Retry-After: <sec>`.

---

## 🔄 Versioning Policy

URL path versioning: `/v1/`, `/v2/`, etc.

| Версия | Статус | Поддержка до |
|---|---|---|
| v1 (current) | active | бессрочно |
| v2 (planned) | preview | TBD |

**Breaking changes** = новая major версия. Поддержка предыдущей версии:
**минимум 12 месяцев** после release следующей.

**Non-breaking changes** (новые поля, новые endpoints, новые опциональные
параметры) — в той же major версии, объявляются в Changelog.

**Deprecation procedure**:
1. Field/endpoint помечается `deprecated: true` в OpenAPI spec
2. Email всем активным API key holders
3. Минимум 90 дней warning перед удалением
4. Removal в следующей major версии

---

## 📝 Changelog

Источник истины: GitHub Releases + auto-generated CHANGELOG.md.

```
v1.5.0 — 2026-05-26
+ Added: /health/metrics endpoint (Performance baseline)
+ Added: cookie-session auth для /api Swagger UI
+ Changed: Dockerfile использует pnpm вместо npm
```

```
v1.4.0 — 2026-05-23
+ Added: A2 формат i2crm_ig_<client>_c<media> для IG Comments
+ Changed: один пост в IG = один лид в B24 (раньше все коммерты в одну сессию)
```

Полный CHANGELOG: TODO link

---

## 🐛 Status Page

См. `status.9wb.ru` (TODO #57) — текущие incidents, history 90 дней,
uptime per service, scheduled maintenance.

Subscribe на email/Telegram alerts.

---

## 💬 Support

- **Документация**: этот файл + OpenAPI (`/api`)
- **Email**: kuznetsovd88@gmail.com
- **Email priority** (Pro+ план): TBD
- **Telegram developer chat** (Enterprise): TBD
- **Response time SLA**: см. `SLA_TEMPLATE.md` §3

---

## 🎓 Examples Repository (TODO)

```
github.com/dv1-lab/social-connector-examples/
├── python/
│   ├── send-message.py
│   ├── subscribe-webhooks.py
│   └── customer-360-query.py
├── nodejs/
│   └── ...
└── README.md
```

Code examples с unit-тестами, ready-to-fork.

---

## 📋 Checklist для активации портала (когда придёт первый партнёр)

- [ ] Subdomain `api.social-connector.9wb.ru` с Caddy reverse_proxy
- [ ] Subdomain `developer.9wb.ru` или `docs.9wb.ru` для статической доки
- [ ] API Key management endpoint (генерация, ротация, отзыв)
- [ ] Webhook subscription управление + HMAC валидация
- [ ] Rate limiter (token bucket) в Caddy или в adapter
- [ ] Examples repo с CI
- [ ] Public OpenAPI без basic_auth для anon viewing
  (только spec, не Try-it-out — Try-it-out требует ключа)
- [ ] Changelog auto-gen из git tags + GitHub Releases
- [ ] SDK (Python+Node) через openapi-generator-cli + CI publishing
- [ ] Подписать SLA контракты (см. `SLA_TEMPLATE.md`)
- [ ] Подписать договор поручения 152-ФЗ (см. `legal/152-FZ.md` §6)

---

## 📚 Связано

- [`OPENAPI.md`](./OPENAPI.md) — текущий Swagger UI (internal)
- [`SLO.md`](./SLO.md) — uptime targets для SLA
- [`SLA_TEMPLATE.md`](./legal/SLA_TEMPLATE.md) — договорной SLA
- [`legal/152-FZ.md`](./legal/152-FZ.md) — обработка PII
- [`DATA_MODEL.md`](./DATA_MODEL.md) — схема данных
- [`SEQUENCES.md`](./SEQUENCES.md) — flow диаграммы

---

**⚠️ Disclaimer**: документ — preview для подготовки. Многие endpoints
(`/v1/widget/send` с API-key, OAuth, /webhooks/subscribe) ещё не
реализованы — текущая платформа single-tenant. Реализация требует:
- Multi-tenant API key middleware (новый guard)
- Webhook subscription engine (Prisma таблица)
- Rate limiter (Redis or in-memory)
- OAuth server (если будет multi-tenant scope)

Готовность по этим компонентам — ~30%, остальное в backlog.
