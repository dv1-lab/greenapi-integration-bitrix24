# Monitoring Plan — что-кому-куда алертит

Формальный документ всех систем мониторинга платформы. Цель — видеть
**на одной странице** что мониторим, какие gap'ы есть, кому идут
алерты. Без этого silent failures остаются незамеченными часами/днями.

Last reviewed: 2026-05-26 (task #45).

---

## 🏗 Системы мониторинга

### 1. Healthchecks.io — dead-man-switch для cron jobs

Project: `kuznetsovd88@gmail.com` (UUID `4c3e5ff6-cbf6-4087-8492-211eef9f88ca`).
**Все cron-чеки в этом одном проекте** — иначе Telegram-интеграция не
применится автоматически.

Канал доставки алертов: **личка Дмитрия в Telegram** (через
Healthchecks-Email-bridge или integration).

| Чек | UUID | Schedule | Grace | Пингует |
|---|---|---|---|---|
| `dv-server-backup` | `3ada9866` | 04:00 UTC (07:00 МСК) ежедневно | 2ч | `~/server-ubuntu-setup/backup.sh run` |
| `мониторинг кликхауса` | `c0d41431` | каждые 5 мин | 5 мин | `clickhouse/healthcheck.sh` (curl 127.0.0.1:8123/ping) |
| `dv-server-digest` | `409ae4a2` | 07:00 UTC (10:00 МСК) ежедневно | 1ч | `monitor-bot/daily_digest.py` |
| `pervyi-begovoy-bitrix-sync` | `c370076d` | 04:30 UTC (07:30 МСК) ежедневно | 1ч | inline curl в crontab вокруг `sync_main.py` |

**Backup grace 2ч** — потому что restic при большом repo может занять ~30 мин;
buffer на случай тормозов Я.Диска или CH-мерджей.

**Backup false-positive trap**: restic exit code 3 (some files unreadable)
обычно для CH parts при merge. Считаем как success — иначе ежедневные
ложные алерты (см. memory `[[healthchecks_setup]]`).

### 2. monitor-bot @server_ubuntu_dv_bot

Telegram бот в личке Дмитрия (user_id=49085552). Read-only —
никаких kill/restart.

**Daily digest** ежедневно 10:00 МСК (пингает `dv-server-digest`):
- Disk / RAM / CPU
- Docker containers status
- ClickHouse health
- Backup last status
- Yandex.Disk usage
- Recent changes (mtime секретов, последние коммиты, рестарты)
- Healthchecks все статусы (через HC_API_RO_TOKEN read-only)

**Интерактивные команды**: `/status`, `/disk`, `/mem`, `/cpu`,
`/docker`, `/ch`, `/backup`, `/yandex`, `/changes`, `/projects`,
`/help`.

### 3. Uptime Kuma (self-hosted) — параллельный мониторинг к SaaS

| Инстанс | URL | Где |
|---|---|---|
| primary | `https://up.9wb.ru/` | my-server (Docker `louislam/uptime-kuma:1`) |
| spb | `https://up-spb.9wb.ru/` | server-spb (Docker + nginx + certbot) |

Mirror к Healthchecks.io. Если SaaS заблокируют (вдруг Cloudflare/152-ФЗ) —
self-hosted продолжает.

**TODO**: список конкретных monitor'ов в Uptime Kuma не зафиксирован — нужно
заинвентарить через UI.

### 4. tech-monitor → @agent_dv_bot

TG-чат для **silent failures** — когда сервис «вроде работает» (systemd
active), но реально что-то сломано (запросы падают молча).

Triggers (из task #19, #20):
- adapter docker container `Exited` > 5 мин → алерт
- adapter Nest application start failure → алерт
- wa-tg-bridge systemd inactive > 5 мин → алерт
- Сайт 1begovoy.ru недоступен > 10 мин → алерт
- Bitrix24 portal недоступен > 10 мин → алерт

Канал: TG-чат «tech-monitor» (агент @agent_dv_bot).

### 5. Bridge GreenAPI state monitoring

wa-tg-bridge при каждом старте логирует state каждого instance:
```
INFO root: instance 1103487233 → state=authorized
INFO root: instance 1101948511 → state=authorized
...
```

Если state=error → запись в watchdog log. **Сейчас не алертит** в Telegram —
только в logs. **Gap** (см. ниже).

### 6. adapter B24HealthCheckService

Внутренний health-check в adapter (логи):
```
health-check: connector=true, 1 portals with 5 instances total
```

Запускается каждые ~30 сек. Если `connector=false` или instances < 5 —
**сейчас не алертит**, только в логи. **Gap**.

---

## 🚨 Что мониторим сейчас (cheat sheet)

| Что | Чем | Канал |
|---|---|---|
| my-server uptime | Uptime Kuma + monitor-bot daily | up.9wb.ru + личка |
| Backup ежедневный | Healthchecks dv-server-backup | личка |
| ClickHouse health | Healthchecks (5 мин), monitor-bot | личка |
| Backup success rate | digest 10:00 МСК | личка |
| Bitrix24 sync | Healthchecks bitrix-sync | личка |
| Сервис running | monitor-bot `/docker` команда | по запросу |
| Adapter Nest startup | tech-monitor | @agent_dv_bot |
| Bridge systemd active | tech-monitor | @agent_dv_bot |
| Сайт 1begovoy.ru | tech-monitor (HTTP 200) | @agent_dv_bot |

## ⚠️ Gap'ы — что **не** мониторится сейчас

Эти места могут сломаться, мы узнаем по жалобе оператора:

| Что | Почему важно | Как мониторить (предложение) |
|---|---|---|
| **GreenAPI instance state=authorized** | Если WA-устройство deauth — все WA outgoing падают | adapter or bridge watchdog → push в @agent_dv_bot |
| **B24 OAuth refresh_token валидность** | Истекает раз в год, без рефреша adapter теряет access | check через cron, алерт за 14 дней до expire |
| **Adapter REST API latency** | Если медленный — клиенты в B24 видят «не доставлено» | prometheus / простой curl с timer |
| **Adapter error rate** | Если >5% запросов с error — что-то ломается | log-aggregation + threshold |
| **Customer-service /events/ingest** | Если падает — Customer-360 без событий | Healthchecks ping из cron-проверки |
| **dv-dashboard reachable** | https://dashboard.9wb.ru недоступен | Uptime Kuma monitor (TODO) |
| **MoySklad sync** | moy-sklad cron 04:35 — если падает, заказы не попадают в B24 | Healthchecks ping |
| **whisper-server (transcribe)** | Если падает — звонки без транскриптов | systemd watchdog + алерт |
| **Disk usage my-server** | При заполнении — все Docker контейнеры падают | monitor-bot daily, threshold > 85% → алерт |
| **Bitwarden Premium subscription** | Без Premium Emergency Access не работает | manual reminder за 14 дней |
| **GreenAPI instance подписка** | Каждый instance оплачен до конкретной даты, без оплаты — отключается | manual reminder за 14 дней |
| **Bitrix24 webhook delivery** | Если webhook'и от B24 не приходят — adapter не знает о новых сообщениях | adapter measures lag между OL message и обработкой; alert >5 мин |
| **IG outgoing failure rate** | Через #30 (`/customer-360/outgoing-pending`) — видно но не алертит | cron на dashboard query → если > 5 повисших → push |
| **Merge suggestions queue** | Если много pending merge — Customer-360 fragmented | cron + threshold |
| **SSL сертификаты** (Caddy auto-renew) | Если renew падает — сайты отваливаются | Uptime Kuma cert expiry check |
| **DNS Cloudflare zone integrity** | Случайное удаление записи = downtime | weekly export в backup.sh (есть!) + Uptime Kuma external checks |

---

## 🎯 Reaction matrix — кто реагирует

| Severity | Канал | Кто реагирует | Reaction time |
|---|---|---|---|
| 🔥 Critical (бизнес стоит) | tech-monitor @agent_dv_bot + личка | Дмитрий немедленно | < 30 мин |
| 🟠 High (один сервис лёг) | tech-monitor | Дмитрий в течение часа | < 4ч |
| 🟡 Medium (warning) | daily digest личка | Дмитрий вечером того же дня | < 24ч |
| 🟢 Low (info) | daily digest | посмотреть когда удобно | дни |

**Сейчас**: всё валится в личку Дмитрия. После #51 (Backup-person)
critical-алерты должны дублироваться backup-person через Bitwarden
Emergency Access notification.

---

## 📋 План реализации (TODO задачи)

| # | Что добавить | Приоритет |
|---|---|---|
| TODO | GreenAPI instance state alert (5 инстансов) → @agent_dv_bot | P0 |
| TODO | Customer-service /events/ingest healthcheck cron | P0 |
| TODO | MoySklad sync healthcheck ping | P0 |
| TODO | whisper-server watchdog → @agent_dv_bot | P1 |
| TODO | Disk usage threshold алерт > 85% | P1 |
| TODO | Adapter error rate dashboard panel + alert | P1 |
| TODO | Подписки Green API/Bitwarden — manual reminder calendar | P2 |
| TODO | dv-dashboard в Uptime Kuma | P2 |
| TODO | SSL cert expiry monitoring | P2 |
| TODO | Custom dashboard health-page (one URL) | P3 |

После добавления каждого алерта — обновлять этот файл в разделе
«🚨 Что мониторим сейчас», убирать из «⚠️ Gap'ы».

---

## 🔧 Как добавить новый алерт

### Через Healthchecks.io (для cron jobs)

1. https://healthchecks.io → project `kuznetsovd88@gmail.com` → New Check
2. Schedule + Grace (для крон) или Period (для постоянных)
3. Copy ping URL → embed в cron/script
4. Test: ручной `curl <ping-url>` → должно прийти в Telegram

### Через @agent_dv_bot (для silent failures)

См. memory `[[feedback_silent_failure_alerts]]`. В коде сервиса при
detected silent failure:
```python
# wa-tg-bridge alerts.py
await self.alerts.send(f"⚠️ {service} silent failure: {reason}")
```

Канал — env `ALERT_CHAT_ID`.

### Через Uptime Kuma

1. https://up.9wb.ru/ → New Monitor → HTTP(s) / Ping / Keyword
2. URL + interval + notification (Telegram setup)

---

## 📚 Связано

- `~/.claude/projects/-Users-Dmitry-claude-code/memory/healthchecks_setup.md` — детали HC проекта
- `~/.claude/projects/-Users-Dmitry-claude-code/memory/monitor_bot.md` — monitor-bot
- `~/.claude/projects/-Users-Dmitry-claude-code/memory/uptime_kuma_setup.md` — Uptime Kuma
- `~/.claude/projects/-Users-Dmitry-claude-code/memory/feedback_silent_failure_alerts.md` — правило про silent failures
- `SLA_RULES.md` — пороги для алертов SLA
- `RUNBOOKS/incident-response.md` — что делать после алерта
