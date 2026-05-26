# Контекст для Claude: greenapi-b24 (Social Connector adapter)

## TL;DR

NestJS-адаптер B24 ↔ Green API / i2crm / наши Telegram-боты. На my-server
`/home/dv/greenapi-b24/` (Docker compose). Публичный URL — `https://social.9wb.ru`
(Caddy proxy). MySQL adapter в контейнере, Prisma schema.

## ⚠️ Обязательное чтение перед любой правкой

**ПЕРВЫМ ДЕЛОМ** — всегда [`docs/PRODUCT_RULES.md`](./docs/PRODUCT_RULES.md).
Это single source of truth для **продуктовых** правил Дмитрия (когда
создавать лид, что в TG-зеркале, как обрабатывать дубли). Раньше
эти правила существовали устно и каждая сессия повторяла «почему так?» —
теперь нет, читай файл, не догадывайся.

**Прежде чем менять настройки B24 / open-lines / Green API инстансов** —
обязательно посмотри [`docs/PRODUCT_RULES.md`](./docs/PRODUCT_RULES.md)
соответствующий раздел. Если правила нет — спросить Дмитрия, добавить
в PRODUCT_RULES + создать ADR в `docs/decisions/`, и только тогда
применить настройку. **Не догадываться.**

| Что трогаешь | Что обязательно прочитать |
|---|---|
| **Любые продуктовые решения** (лиды, сделки, поведение open-lines, что в зеркало шлём) | [`docs/PRODUCT_RULES.md`](./docs/PRODUCT_RULES.md) — **single source of truth** |
| `widget.controller.ts`, `handleI2crmIncoming/Outgoing`, `handleOutgoing*`, `mirrorToBitrix` | [`docs/OPEN_LINE_LIFECYCLE.md`](./docs/OPEN_LINE_LIFECYCLE.md) + [`docs/REGRESSIONS.md`](./docs/REGRESSIONS.md) + [`docs/CHECKLIST_WIDGET.md`](./docs/CHECKLIST_WIDGET.md) |
| **Зеркала клиента** (TG-bot mirror, i2crm-tg-mirror, wa-tg-bridge bridge.py) — карточки, заголовки тем, подписи | [`docs/CLIENT_CARD_STANDARD.md`](./docs/CLIENT_CARD_STANDARD.md) — **обязательный единый стандарт**, любое отклонение = регрессия |
| Любые `chat.id` / префиксы / каналы | те же 3 файла |
| TG-боты | [`docs/TELEGRAM_BOT_FLOW.md`](./docs/TELEGRAM_BOT_FLOW.md) |
| Instagram (i2crm) | [`docs/INSTAGRAM_FLOW.md`](./docs/INSTAGRAM_FLOW.md) |
| Customer-360, KBD, event log | [`docs/CUSTOMER360.md`](./docs/CUSTOMER360.md) |
| Зеркала клиентов (карточки) | [`docs/ARCHITECTURE.md §7.5`](./docs/ARCHITECTURE.md) |
| Общая картина | [`docs/SOCIAL_CONNECTOR.md`](./docs/SOCIAL_CONNECTOR.md) |
| **Почему так?** на любое архитектурное решение | [`docs/decisions/`](./docs/decisions/) — ADR с обоснованием |

**Если правишь widget или открытые линии — не пропусти REGRESSIONS.md.** Класс
проблемы «не подтягивается open-line / дубль chat-user» повторялся 5+ раз за
полгода. Каждый раз тратили часы. Чек-лист в `CHECKLIST_WIDGET.md` отсекает
80% этих регрессий.

## Жёсткие правила

1. **chat.id префикс**: incoming и outgoing **должны совпадать** для одного клиента.
   - WA: `wa_<phone>` / `sc_<phone>`
   - TG (Green API): `<chat_id>` без префикса
   - MAX: `<chat_id>` без префикса
   - TG-bot (наши): `tgbot_<chat>` / `tgsupport_<chat>`
   - IG Direct: `i2crm_ig_<client_id>`
   - IG Comment: `i2crm_ig_<client_id>_c<media_id>`

   Несовпадение → B24 заведёт второго chat-user, оператор увидит два диалога.

2. **Имена методов B24**:
   - `imconnector.send.messages` создаёт session (то что нам нужно для виджета).
   - `crm.timeline.comment.add` — только запись в CRM, **не создаёт session**.
   - Не переключать между ними без аудита 4 каналов.

3. **`ensureOpenLeadForPhone(..., skipLeadCreation=true)`** — обязательно,
   если в той же области уже вызывается `imconnector.send.messages`. Иначе будет
   дубль лида `(auto)`.

4. **OAuth-токен**: для customer-360 операций — `appKind=customer360`, для
   социал-flow — `appKind=social`. Не смешивать.

5. **Inbound webhook B24** (`BITRIX_WEBHOOK_URL` в `.env`) — **legacy**, кодом
   не используется. Не добавлять новые вызовы через него.

6. **PNPM**, не npm. `package-lock.json` удалён 2026-05-26, lockfile = `pnpm-lock.yaml`.
   `packageManager` pinned на `pnpm@10.33.2`. Dockerfile использует pnpm
   `--frozen-lockfile`. **Любые transitive imports должны быть в `dependencies`**
   — pnpm strict mode не hoist'ит. См. REGRESSIONS 2026-05-26.

7. **Swagger UI** на `/api`: env `SWAGGER_USER` + `SWAGGER_PASSWORD` →
   login-форма + cookie-сессия 30 дней. **Без env Swagger выключен**
   (security-safe default). См. `docs/OPENAPI.md`.

8. **Performance metrics** на `/health/metrics`: env `METRICS_TOKEN` →
   header `X-Metrics-Token`. Возвращает p50/p95/p99/error rate per endpoint.
   См. `docs/PERFORMANCE.md`.

## Деплой

```bash
# pull изменения (репо живёт в source/, compose — в корне)
cd /home/dv/greenapi-b24/source && git pull

# build + up — из корня, не из source/
cd /home/dv/greenapi-b24 && docker compose up -d adapter --build --force-recreate

# проверка
docker compose logs adapter --tail 30 | grep -iE "Nest application|error"
```

`docker compose restart` НЕ перечитывает `.env` и НЕ пересобирает образ — для
изменений кода нужно `up -d --build`.

**Почему deploy из корня, а не из source/** (выяснено 2026-05-25):
В `/home/dv/greenapi-b24/` есть `docker-compose.yml` + `docker-compose.override.yml`
+ `.env`. В `source/` лежит **репо** (Dockerfile, package.json, src/). Корневой
compose имеет `build: source` (точка входа build-контекста), а override
переопределяет `ports`/`env_file`/`volumes` (bind mount на `/home/dv/greenapi-b24/mysql-data/`,
а не named volume). Запуск из source/ игнорирует override → port 3000 коллизия
и пустой mysql named volume.

`COMPOSE_PROJECT_NAME=source` в `.env` фиксирует имена контейнеров
`source-adapter-1`/`source-db-1` — на них завязаны `backup.sh`, monitor-bot,
healthchecks. Менять имя проекта = ломать инфраструктуру.

## Безопасность

- Никаких `grep .env | cut` — пароли утекают в transcript. Использовать
  `awk -F= '/^KEY=/ {printf "%s=<set,%d>\n",$1,length($0)-length($1)-1}'`.
  **ОБЯЗАТЕЛЬНО `-F=`** — без него `$1` это вся строка, printf напечатает пароль
  целиком (инцидент 2026-05-25, [[feedback-awk-mask-fs-required]]).
- Пароли для DATABASE_URL — alphanumeric only (без `+/=`), Prisma URL-encoding
  ломается.
- Webhook URL B24 не выводить `cat`/`echo` целиком — заменять `/rest/<num>/<token>/`
  на `/rest/<num>/<masked>/`.

## Связь с другими сервисами

- **wa-tg-bridge** (`/home/dv/wa-tg-bridge/`) — Python aiogram, слушает TG-группы
  зеркал, форвардит `/nnn`, `/reply` в adapter через `/webhooks/internal/*`
  (`X-Hint-Secret` header).
- **customer-service** (`/home/dv/customer-service/`) — NestJS+Postgres, master
  DB customers/aliases. Adapter ходит в `CUSTOMER_SERVICE_URL` с
  `X-Service-Secret`.
- **clickhouse** — adapter не пишет в CH напрямую, всё через customer-service
  `/events/ingest`.
- **DV Dashboard** (`/home/dv/dv-dashboard/`) — BI на dashboard.9wb.ru, читает
  CH/PG/SQLite. Не пишет в adapter — только читает.

## История проекта (для контекста)

- Изначально форк `greenapi-integration-bitrix24` (vendor checkout).
- С 2026-05 — наш репо `dv1-lab/greenapi-integration-bitrix24` с большими
  расширениями (Customer-360, i2crm IG, multi-instance TG-боты, обратный путь
  зеркала, и т.п.).
- Multi-instance TG-боты с 2026-05-23. До этого был один @begovoy_bot.
- IG A2 (один пост = один лид) с 2026-05-23.

## Что НЕ делать в этом репо

- ❌ Коммитить в `bots/greenapi-b24/` локальный checkout pervyi-begovoy —
  он vendored, реальный репо отдельный. См. [`bots/CLAUDE.md`](../CLAUDE.md).
- ❌ Менять Prisma schema без миграции (`pnpm prisma migrate dev`).
- ❌ Использовать `--password=X` в bash-командах — utечёт в transcript.
- ❌ Откатывать без чтения REGRESSIONS.md — высокий шанс повторить старую регрессию.
