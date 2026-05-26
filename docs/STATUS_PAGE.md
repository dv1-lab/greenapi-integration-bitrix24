# Status Page — status.9wb.ru

Публичная страница состояния сервисов с current incidents, uptime history,
maintenance schedule.

**Статус**: документ описывает архитектуру + готовую к деплою конфигурацию.
Активация — на момент когда нужен партнёрам (см. `DEVELOPER_PORTAL.md`).
Сейчас single-tenant — служит cheat-sheet'ом для Дмитрия.

Last updated: 2026-05-26 (task #57).

---

## 🎯 Что показывает status page

| Section | Источник |
|---|---|
| **Current services status** (Operational / Degraded / Down) | Uptime Kuma `up.9wb.ru` API |
| **Active incidents** | Manual (через admin UI Uptime Kuma) |
| **90-day uptime per service** | Uptime Kuma history |
| **Scheduled maintenance** | Manual в Uptime Kuma |
| **Subscribe to alerts** | Email + Telegram bot |

---

## 🏗 Архитектура

### Вариант А: Uptime Kuma встроенный (recommended)

Uptime Kuma уже работает на `up.9wb.ru` (см. memory `[[uptime_kuma_setup]]`).
В нём есть **встроенный Status Page** feature — публичная страница без auth,
с UX для клиентов.

```
status.9wb.ru → Caddy reverse_proxy → up.9wb.ru/status/main
                                       (Status Page feature Uptime Kuma)
```

**Плюсы**:
- 0 нового кода, существующая инфра
- Auto-updated из Uptime Kuma checks
- Public API JSON для programmatic access
- Maintenance windows через Uptime Kuma UI
- 90-day history бесплатно

**Минусы**:
- Дизайн ограничен темами Uptime Kuma (хотя приличный)
- Кастомные incidents — только через UI (нет API для создания)

### Вариант Б: Custom static page

Next.js или статическая HTML страница с JS-fetch'ем `up.9wb.ru/api/status-page/main`
(public JSON Uptime Kuma).

**Плюсы**:
- Полный контроль дизайна
- Можно embedded в брендовый стиль (`brandbook_pervyi_begovoy.md`)
- Кастомные incidents через own DB

**Минусы**:
- Поддерживать ещё один сервис
- Дубликат логики которая уже есть в Kuma

**Решение**: начать с Варианта А (быстро), переехать на Б когда нужен брендинг.

---

## 🚀 Активация Варианта А (15 минут)

### 1. Создать Status Page в Uptime Kuma

```
1. Логин в up.9wb.ru
2. Status Pages → New
3. Settings:
   - Name: "Social Connector Status"
   - Slug: "main"  (URL: up.9wb.ru/status/main)
   - Description: "Текущее состояние сервисов Social Connector"
   - Show Tags / Show Powered By: optional
4. Group monitors:
   - "API" → adapter HTTP probe, customer-service /healthz
   - "Web" → 1begovoy.ru, dashboard.9wb.ru
   - "Databases" → ClickHouse, Postgres, MySQL (TCP checks)
   - "External" → Bitrix24, Green API, i2crm (out of scope, but show)
5. Save
```

### 2. Caddy reverse_proxy

В `/home/dv/server-ubuntu-setup/caddy-public/Caddyfile`:

```caddyfile
status.9wb.ru {
    encode gzip
    # Redirect / на /status/main для удобства
    @root path /
    redir @root /status/main 302

    reverse_proxy uptime-kuma:3001 {
        # Uptime Kuma слушает на 3001 внутри Docker
        # Status Pages — public, без auth
    }
}
```

### 3. DNS

Cloudflare:
```
status.9wb.ru → CNAME → 9wb.ru (A-record server-spb IP)
                       или прямой A-record на my-server IP
```

(см. memory `[[cloudflare_dns_token]]` для автоматизации через API)

### 4. Reload Caddy

```bash
sudo systemctl reload caddy
```

### 5. Verify

```bash
curl -I https://status.9wb.ru/status/main
# должен вернуть 200 + HTML с Uptime Kuma Status Page
```

---

## 📊 Что включать в Status Page

### Группы мониторов

**API Services**
- adapter Nest application HTTP probe (POST `/webhooks/green-api` ping)
- customer-service `/healthz`
- whisper-server (если есть HTTP probe)

**Web**
- 1begovoy.ru (магазин)
- dashboard.9wb.ru (BI)
- social.9wb.ru (Swagger UI)
- clipmind.9wb.ru
- 1begovoy-v2.9wb.ru (preview)

**Databases**
- ClickHouse 127.0.0.1:8123/ping (через my-server probe)
- Postgres customer_service (TCP 5432)
- MySQL adapter (TCP 3306, через source-db-1)

**External (informational)**
- 1begovoy.bitrix24.ru
- console.green-api.com
- public.i2crm.ru

**Maintenance window**
- Каждое 1-е число месяца 03:00-04:00 МСК (backup window) — show as "scheduled"

---

## 🔔 Incident notifications

### Manual создание incident в Uptime Kuma

```
1. Uptime Kuma → Status Page → Manage Incidents
2. New Incident:
   - Style: warning / danger
   - Title: "Adapter restart в 14:30 МСК"
   - Content: "Деплой #52 OpenAPI. ETA 5 минут."
   - Affected: API Services
3. Save → авто-показ на status.9wb.ru
```

### Auto-notification (TODO)

Когда монитор переходит в DOWN:
- Email subscribers (через Uptime Kuma Email notification)
- Telegram bot → `@status_9wb_bot` (TODO создать)
- На status page: автоматический "investigating" incident

После RECOVER:
- Auto-update incident: "resolved at HH:MM"
- Email notification

---

## 📈 Метрики на странице

Uptime Kuma встроенно показывает:

- **Up/Down**: green/red badge per monitor
- **Uptime %**: за 24h, 7d, 30d, 90d
- **Response time**: ms (если HTTP monitor)
- **Cert expiry** (для HTTPS): остаток дней
- **Incident timeline**: 90 дней history

Каждый monitor можно раскрыть → детали + ping history graph.

---

## 🎯 Что показывать публично vs не показывать

| Показывать ✅ | НЕ показывать ❌ |
|---|---|
| Service up/down статус | Конкретные IP-адреса серверов |
| HTTP latency p95 (без endpoint paths) | Endpoint paths детально |
| Uptime % | Internal hostnames |
| Incident summary (не детали кода) | Sha коммитов вызвавших инцидент |
| ETA на recovery | Версии софта (CVE attack surface) |
| Public API status (`/v1/health`) | Internal Tailscale IPs |

---

## 🔒 Безопасность

Status page **публичный** — без auth. Это significant attack surface:

- **Information disclosure** (см. THREAT_MODEL I7): какие сервисы у нас есть,
  когда они падают → атакер видит windows of vulnerability
- **DDoS magnet**: если status page стал популярным, его DDoS — отдельный
  вектор. Митigация: Caddy rate-limit + Cloudflare (через CNAME, без Tunnel)

**Митigации**:
- Cache-Control 30 sec (Uptime Kuma по умолчанию делает)
- Не показывать internal IPs / endpoints
- Не делать API public для bot-scraping (rate-limit anonymous = 60 req/min)

---

## 📋 Checklist для активации

- [ ] Создать Status Page в Uptime Kuma (UI шаги выше)
- [ ] Группы монитов настроить (API / Web / DB / External)
- [ ] Caddyfile добавить `status.9wb.ru` блок
- [ ] DNS CNAME / A для `status.9wb.ru`
- [ ] Reload Caddy
- [ ] TLS cert auto-issue (Caddy сам)
- [ ] Test: curl `https://status.9wb.ru` → 200, есть Status Page
- [ ] (Optional) Email subscribers — Uptime Kuma SMTP config
- [ ] (Optional) Custom domain в footer Status Page settings

После активации — добавить ссылку в:
- `DEVELOPER_PORTAL.md` §🐛 Status Page
- `SLA_TEMPLATE.md` §8 Уведомления
- 1begovoy.ru footer (для клиентов)

---

## 🆙 Upgrade path (Вариант А → Б)

Когда понадобится брендированная страница:

1. Next.js app `status-9wb-frontend`
2. Деплой как Docker container на my-server
3. Fetch Uptime Kuma public JSON: `up.9wb.ru/api/status-page/main`
4. Кастомный дизайн (брендбук Первого Бегового)
5. Caddyfile: `status.9wb.ru` → новый контейнер
6. Старый Uptime Kuma Status Page остаётся под `up.9wb.ru/status/main` как
   backup для подписчиков incidents

---

## 📚 Связано

- [`SLA_TEMPLATE.md`](./legal/SLA_TEMPLATE.md) — §8 ссылается на status page
- [`DEVELOPER_PORTAL.md`](./DEVELOPER_PORTAL.md) — §🐛 ссылается
- [`MONITORING.md`](./MONITORING.md) — внутренние мониторы (не публичные)
- [`SECURITY/THREAT_MODEL.md`](./SECURITY/THREAT_MODEL.md) — I7 risk
- Memory `[[uptime_kuma_setup]]` — детали инсталляции Kuma
- Memory `[[cloudflare_vpn_lessons]]` — почему не используем Cloudflare Tunnel
