# greenapi-b24 (Social Connector adapter) — disaster-recovery blueprint

Полная спецификация для воспроизведения сервиса с нуля на новом VPS,
если потеряны все локальные файлы. Дополняет тематические доки
(`ARCHITECTURE.md`, `INSTAGRAM_FLOW.md`, `OPEN_LINE_LIFECYCLE.md` и т.д.) —
здесь компактный recipe, без «почему так».

Последнее обновление: 2026-05-25.

---

## 1. Назначение

NestJS adapter, который связывает **Bitrix24 Open Lines** с:
- **Green API** (WhatsApp, MAX, Telegram через @begovoy_bot/@begovoy1support_bot)
- **i2crm Public API** (Instagram Direct + Instagram Comments)
- **customer-service** (запись events в Customer-360 ClickHouse)

Источник истины для Customer-360 и B24 — **этот adapter**. TG-зеркала
(`wa-tg-bridge`) — дополнительный UI, не источник истины.

Публичный URL: **https://social.9wb.ru** (Caddy → 127.0.0.1:3001).

Не зависит от: dv-dashboard, task-tracker. Зависит **от**: B24 портал,
GreenAPI кабинеты, i2crm подключение, customer-service.

---

## 2. Внешние зависимости (где какие credentials брать)

| Что | Где взять | Назначение |
|---|---|---|
| **B24 OAuth app `social`** (Local app, тип «server») | Bitwarden «Bitrix24 social_connector V2» | CLIENT_ID/CLIENT_SECRET, scopes `crm,imopenlines,imconnector,im,user,placement,mobile,telephony,call`, redirect `https://social.9wb.ru/oauth/callback`. Install URL — `https://social.9wb.ru/oauth/install` |
| **B24 OAuth app `customer360`** (отдельный Local app) | Bitwarden «Bitrix24 customer360» | Тот же портал, отдельный CLIENT_ID/SECRET, scopes `crm,im` минимум. Для customer-360 CRUD без рисков от social-app блокировок |
| **GreenAPI инстансы** | console.green-api.com | Один аккаунт, несколько instance_id. Каждый — отдельный канал (WA-номер, MAX-номер, TG-бот через GreenAPI) |
| **i2crm подключение** | app.i2crm.ru, Bitwarden «i2crm publicapi target» | `I2CRM_TARGET_ID_PUBLICAPI=60774`, `I2CRM_TARGET_KEY_PUBLICAPI=<секрет>`, `I2CRM_INSTAGRAM_ACCOUNT_ID=8215238716` (IG бизнес-аккаунт) |
| **TG bot @begovoy_bot** | BotFather, токен в Bitwarden «TG @begovoy_bot» | Webhook на `https://social.9wb.ru/webhooks/telegram` |
| **TG bot @begovoy1support_bot** | то же | Второй TG-канал, отдельная open-line |
| **TG-mirror bot** (для зеркала WA/IG в TG-группы) | Bitwarden «TG @1begovoyconnectbot» | sendMessage в супергруппы-зеркала |
| **customer-service `/events/ingest`** | `/home/dv/customer-service/.env` | URL+X-Service-Secret. Принимает customer_events в CH |

---

## 3. Конфигурация B24 портала

Все настройки в портале `1begovoy.bitrix24.ru`:

**Open Lines** (Контакт-центр → Открытые линии):

| ID | Название | CRM_CREATE | Коннектор активен | Назначение |
|---|---|---|---|---|
| `18` | i2crm (Instagram) | `lead` | social_connector | Instagram **Direct** |
| `22` | i2crm (Instagram Comment) | `lead` | social_connector | Instagram **Comment** |
| `148` | WhatsApp 3354 | `lead` | social_connector | WA через GreenAPI инстанс N1 |
| `174` | WhatsApp 3354 (доп) | `lead` | social_connector | WA через GreenAPI N2 (multi-instance) |
| `182` | MAX 79584983354 | `lead` | social_connector | MAX через GreenAPI |
| `8` | Telegram begovoy_bot | `lead` | social_connector | TG-бот @begovoy_bot |
| `<TG_BOT_SUPPORT_LINE_ID>` | Telegram support_bot | `lead` | social_connector | @begovoy1support_bot |

На каждой: `CRM_CHAT_TRACKER=Y` (B24 переиспользует открытый лид клиента),
`CRM_FORWARD=N`, очередь операторов настроена в админке.

**Custom UF-поля**:

| Сущность | UF имя | Тип | Назначение |
|---|---|---|---|
| Contact, Lead, Deal | `UF_CRM_IG_CHAT_ID` | string(40) | стабильный IG client_id |
| Contact, Lead, Deal | `UF_CRM_IG_USERNAME` | string | @ник IG (косметика) |
| Contact, Lead, Deal | `UF_CRM_INSTAGRAM` | URL | https://instagram.com/<username> |
| Contact, Lead, Deal | `UF_CRM_TG_CHAT_ID` | string(40) | TG numeric user_id |
| Contact, Lead, Deal | `UF_CRM_MAX_CHAT_ID` | string(40) | MAX internal chat_id |
| Contact, Lead, Deal | `UF_CRM_PB_CUSTOMER_UUID` | string(36) | UUID в customer-service |
| Lead | `UF_CRM_NF_YM_CLIENT_ID` | string | Я.Метрика ClientId (с сайта) |
| Lead | `UF_CRM_LEAD_ID` | string | ссылка-связь лид→другая CRM-сущность |
| Lead | `UF_CRM_1637656407829` | URL | «Link0», копия `src` для IG-comment |

**Lead Status**:
- `12` = «Дубликат» с семантикой F (failed). Используется в backfill при наличии открытой сделки/лида клиента.

**Placement.bind** (Embedded apps в карточках):
- На CONTACT/LEAD/DEAL `CRM_CONTACT_DETAIL_TAB`, `CRM_LEAD_DETAIL_TAB`, `CRM_DEAL_DETAIL_TAB` → handler `https://social.9wb.ru/widget/render` (вкладка Social Connector внутри карточки)
- Регистрируется автоматически при install через `BitrixController.onInstall`

---

## 4. env-переменные (имена и назначение, БЕЗ значений)

В `/home/dv/greenapi-b24/.env` (корневой) **и** `/home/dv/greenapi-b24/source/.env`
(внутри репо — для miniorm prisma migrate deploy). Должны быть **синхронны** —
после миграции я несколько раз ловил расхождение паролей (инцидент 25.05).

**Core / B24 OAuth:**
| Имя | Назначение |
|---|---|
| `APP_URL` | `https://social.9wb.ru` — публичный URL для OAuth callback и placement |
| `BITRIX24_CLIENT_ID` | client_id Local app `social` |
| `BITRIX24_CLIENT_SECRET` | client_secret Local app `social` |
| `BITRIX24_CUSTOMER360_CLIENT_ID` | client_id app `customer360` |
| `BITRIX24_CUSTOMER360_CLIENT_SECRET` | client_secret app `customer360` |
| `BITRIX_WEBHOOK_URL` | legacy inbound webhook B24, **не использовать в новом коде** |
| `BITRIX_LINE_ID` | default LINE для widget mirror (обычно 148 WA или 18 Direct) |

**GreenAPI (multi-instance в БД, в .env только default):**
| Имя | Назначение |
|---|---|
| `GREENAPI_API_URL` | base URL Green API |
| `GREENAPI_ID_INSTANCE` | default idInstance |
| `GREENAPI_TOKEN_INSTANCE` | default apiToken |

Реальные инстансы — в таблице `Instance` MySQL adapter. См. §6.

**i2crm (Instagram):**
| Имя | Назначение |
|---|---|
| `I2CRM_API_BASE` | `https://app.i2crm.ru/api_v1` |
| `I2CRM_TARGET_KEY_PUBLICAPI` | секрет для `?key=` |
| `I2CRM_TARGET_ID_PUBLICAPI` | id target'а publicapi (`60774`) |
| `I2CRM_INSTAGRAM_ACCOUNT_ID` | IG account_id (`8215238716`) — это `source` в payload |
| `I2CRM_LINE_ID_IG_DIRECT` | `18` |
| `I2CRM_LINE_ID_IG_COMMENT` | `22` |
| `I2CRM_USER_TOKEN` | для запросов к i2crm Dashboard API (отличается от Public API) |
| `I2CRM_SOURCE_IG_DIRECT` | internal source.id в i2crm (для legacy совместимости) |
| `I2CRM_SOURCE_IG_COMMENT` | то же для comment |
| `I2CRM_TG_MIRROR_GROUP_ID_DIRECT` | TG-группа для зеркала IG-Direct |
| `I2CRM_TG_MIRROR_GROUP_ID_COMMENT` | TG-группа для зеркала IG-Comment |
| `I2CRM_TG_MIRROR_TOPIC_MAP` | JSON-map account_id→topic_id |

**TG боты (наши, через Telegram Bot API напрямую):**
| Имя | Назначение |
|---|---|
| `TG_BOT_TOKEN` | @begovoy_bot |
| `TG_BOT_LINE_ID` | open-line ID для @begovoy_bot (`8`) |
| `TG_BOT_MIRROR_GROUP_ID` | TG-группа-зеркало входящих |
| `TG_BOT_WEBHOOK_SECRET` | secret_token для Telegram setWebhook |
| `TG_BOT_SUPPORT_TOKEN`, `TG_BOT_SUPPORT_LINE_ID`, `TG_BOT_SUPPORT_MIRROR_GROUP_ID`, `TG_BOT_SUPPORT_WEBHOOK_SECRET` | то же для @begovoy1support_bot |
| `TG_MIRROR_BOT_TOKEN` | @1begovoyconnectbot (зеркало для WA/IG) |

**MySQL adapter (Prisma):**
| Имя | Назначение |
|---|---|
| `MYSQL_ROOT_PASSWORD` | root MySQL контейнера |
| `MYSQL_USER` | `adapter` |
| `MYSQL_PASSWORD` | пароль adapter user |
| `MYSQL_DATABASE` | `adapter` |
| `DATABASE_URL` | `mysql://adapter:<MYSQL_PASSWORD>@db:3306/adapter` |
| `COMPOSE_PROJECT_NAME` | `source` — фиксирует имена контейнеров `source-adapter-1`/`source-db-1` (на них завязаны backup.sh + monitor-bot) |

**Customer-service (Customer-360):**
| Имя | Назначение |
|---|---|
| `CUSTOMER_SERVICE_URL` | `http://127.0.0.1:3002` (или Tailscale IP) |
| `CUSTOMER_SERVICE_SECRET` | X-Service-Secret header |

**Бридж wa-tg-bridge ↔ adapter (для KBD-feed и /nnn):**
| Имя | Назначение |
|---|---|
| `BRIDGE_HINT_URL` | endpoint в bridge для /nnn forward |
| `BRIDGE_HINT_SECRET` | X-Hint-Secret header |

**IG media (фото из IG):**
| Имя | Назначение |
|---|---|
| `IG_MEDIA_DIR` | local dir где adapter кеширует фото из IG |
| `IG_MEDIA_PUBLIC_URL` | публичный URL prefix (Caddy serves dir) |

**Уведомления:**
| Имя | Назначение |
|---|---|
| `ALERT_BOT_TOKEN`, `ALERT_CHAT_ID` | @agent_dv_bot для критичных алертов adapter'а |

⚠️ **Пароль для DATABASE_URL** — только alphanumeric (без `+/=`), Prisma URL-encoding ломается. **Не печатать env в transcript** — использовать `awk -F=` маски ([[feedback_awk_mask_fs_required]]).

---

## 5. Хостинг и сеть

- **VPS**: my-server (Стокгольм, hip.hosting), Ubuntu, SSH alias `my-server`
- **Caddy** (`/etc/caddy/Caddyfile`):
  ```
  social.9wb.ru {
      reverse_proxy 127.0.0.1:3001
  }
  ```
  TLS auto-issue (Let's Encrypt). Конфиг Caddy — в `/home/dv/server-ubuntu-setup/`.

- **DNS**: A-запись `social.9wb.ru` → IP my-server (Cloudflare DNS, токен в Bitwarden «Cloudflare DNS Edit»)

- **Docker network**: `source_default` (имя проекта = `source`)

- **Ports**:
  - `adapter` контейнер: 3000 (внутри) → host `127.0.0.1:3001`
  - `db` контейнер: 3306 (внутри), не expose'нут наружу

---

## 6. Docker + Compose

Файлы:
- `/home/dv/greenapi-b24/docker-compose.yml` — основной (build: source)
- `/home/dv/greenapi-b24/docker-compose.override.yml` — production override (env_file, volumes, depends_on healthcheck)
- `/home/dv/greenapi-b24/source/` — git repo `dv1-lab/greenapi-integration-bitrix24` (Dockerfile, src/, prisma/)

**Dockerfile** (в `source/`):
```
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
EXPOSE 3000
CMD npx prisma migrate deploy && npm run start:prod
```

**docker-compose.yml** (корень):
```yaml
version: '3.8'
services:
  adapter:
    build: source            # build context = source/, не корень
    ports: ["3000:3000"]
    environment: ...
    depends_on: [db]
  db:
    image: mysql:8
    environment:
      MYSQL_ROOT_PASSWORD: password
      MYSQL_DATABASE: adapter
      MYSQL_USER: mysqluser
      MYSQL_PASSWORD: mysqlpassword
    volumes: [mysql_data:/var/lib/mysql]
volumes:
  mysql_data:
```

**override.yml** переопределяет:
- `adapter.ports: !override ["127.0.0.1:3001:3000"]` (только localhost)
- `adapter.env_file: /home/dv/greenapi-b24/.env`
- `adapter.volumes: /home/dv/greenapi-b24/data:/app/data`
- `db.volumes: !override [/home/dv/greenapi-b24/mysql-data:/var/lib/mysql]` (bind mount, не named volume)
- `db.healthcheck`: `mysqladmin ping`

**Deploy команда (только из корня /home/dv/greenapi-b24/):**
```bash
cd /home/dv/greenapi-b24/source && git pull
cd /home/dv/greenapi-b24 && docker compose up -d adapter --build --force-recreate
```

`--build` обязательно (иначе старый dist). `--force-recreate` чтобы подхватить новые env.

---

## 7. БД схема (Prisma)

Schema в `source/prisma/schema.prisma`, миграции в `source/prisma/migrations/`. Применяются автоматически в Dockerfile CMD (`prisma migrate deploy`).

Главные таблицы (по `wc -l` около 22 моделей):

| Модель | Назначение |
|---|---|
| `User` | один на B24-портал: accessToken, refreshToken, portalDomain, applicationToken |
| `OAuthApp` | split для customer360: portalDomain + appKind |
| `Instance` | GreenAPI каналы: idInstance, apiToken, provider (wa/max/telegram), bitrixLine, user.portalDomain |
| `MaxContact` | кеш phone→chatId для MAX/Telegram (после CheckAccount) |
| `OutgoingMessage` | mapping idMessage → b24ChatId+messageId для проксирования read-статусов |
| `IgInboundB24Link` | comment incoming: b24Chat/Message → comment_id+media_id+text. Для reply через цитату |
| `IgDirectInboundB24Link` | direct incoming: b24Chat/Message → external_id+text. Для будущего native reply (i2crm пока не поддерживает) |
| `IgCommentContext` | last (media,comment) per client — fallback когда reply без цитаты |
| `I2crmEventLog` | журнал всех incoming i2crm webhook'ов с status=pending → replay при сбоях |
| `OffHoursReplyState` | auto-reply вне рабочих часов: один раз/ночь/клиент |

**Бэкапы**: `mysqldump` в `pre-hook` backup.sh ([[mysqldump_in_backup]]):
```bash
docker exec source-db-1 sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --no-tablespaces --routines --triggers adapter' | gzip > "$HOME/backups/greenapi-b24-mysqldump.sql.gz"
```
Restic → Я.Диск ежедневно 04:00 UTC.

---

## 8. Точки входа (HTTP routes)

| Path | Method | Что |
|---|---|---|
| `/oauth/install` | GET | First-time OAuth handshake B24 ↔ adapter |
| `/oauth/callback` | GET | redirect_uri после auth |
| `/oauth/customer360/install`, `/oauth/customer360/callback` | GET | то же для customer360 app |
| `/webhooks/bitrix24` | POST | events от B24 (ONIMCONNECTORMESSAGEADD, ONOPENLINEMESSAGEADD, и т.д.) |
| `/webhooks/greenapi` | POST | incoming/outgoing webhook'и от GreenAPI |
| `/webhooks/i2crm` | POST | incoming от i2crm Public API (instdir/instcom) |
| `/webhooks/telegram` | POST | TG Bot updates @begovoy_bot |
| `/webhooks/telegram-support` | POST | то же для @begovoy1support_bot |
| `/webhooks/internal/i2crm-replay` | POST | manual replay pending событий из I2crmEventLog |
| `/webhooks/internal/refresh-tg-bot-pinned` | POST | пересоздать pinned-карточку клиента в TG-зеркале |
| `/widget/render` | GET | embedded в карточке B24 (placement) — HTML widget |
| `/widget/send` | POST | send first message (WA/MAX/TG via GreenAPI, IG via i2crm) |
| `/widget/instances` | GET | список authorized GreenAPI инстансов для select-box |
| `/widget/entity-phone` | GET, POST | резолв phone клиента из B24 entity |
| `/widget/check-account` | POST | CheckAccount у GreenAPI (MAX/Telegram) для resolve phone→chatId |
| `/media/*` | GET | прокси для IG media (кешируется в IG_MEDIA_DIR) |

---

## 9. Cron / фоновые процессы

В adapter'е (NestJS @Cron):
- Token refresh для B24 OAuth — авто при 401
- i2crm replay pending — каждые 5 мин (см. I2crmEventLog)
- Connector health check + auto-activate — каждый час (re-проверяет что `imconnector.status` = configured+active)
- Off-hours auto-reply trigger — на incoming, не cron

Кронжобы вне adapter:
- `backup.sh` на my-server 04:00 UTC → restic → Я.Диск
- `customer-uuid-sync` (15m), `ai_evaluator` (30m), `ai_consultant` (10m), `status_report` (11:00 МСК) — customer-360 ([[customer_360_ops]])

---

## 10. Recipe — поднять с нуля на новом VPS

```bash
# 1. Префиксы DNS
# A record: social.9wb.ru → новый_IP (Cloudflare)

# 2. Базовая инфраструктура (Docker, Caddy)
# (предполагается bootstrap.sh из server-ubuntu-setup отработал)

# 3. Структура каталогов
mkdir -p /home/dv/greenapi-b24/{data,mysql-data}
cd /home/dv/greenapi-b24

# 4. Клон репо
git clone git@github.com:dv1-lab/greenapi-integration-bitrix24.git source
ln -s source/Dockerfile Dockerfile  # для compose из корня (build: source делает это автоматически)

# 5. Compose-файлы
# docker-compose.yml — из этого blueprint §6 (build: source)
# docker-compose.override.yml — из git server-ubuntu-setup snapshot

# 6. .env (корневой + source/) — заполнить из Bitwarden
nano /home/dv/greenapi-b24/.env             # все ключи из §4
cp /home/dv/greenapi-b24/.env /home/dv/greenapi-b24/source/.env

# 7. Запуск (миграции применятся автоматически Dockerfile CMD)
docker compose up -d adapter --build --force-recreate

# 8. Восстановить БД из бэкапа (если был):
gunzip -c /home/dv/backups/greenapi-b24-mysqldump.sql.gz | \
  docker exec -i source-db-1 sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" adapter'

# 9. Caddy конфиг → /etc/caddy/Caddyfile (§5)
sudo systemctl reload caddy

# 10. Re-install B24 OAuth app (если БД не восстановили):
# Открыть https://social.9wb.ru/oauth/install в браузере под B24-админом
# OnInstall handler автоматически зарегистрирует placement.bind + scopes

# 11. Smoke test (§11)
```

---

## 11. Smoke-test (как проверить что подняли правильно)

```bash
# 1. Adapter здоров
curl -s https://social.9wb.ru/health || curl -s http://127.0.0.1:3001/health
# Ожидание: 200 OK

# 2. B24 OAuth токен валиден
docker exec source-adapter-1 node -e '
  const {PrismaClient} = require("@prisma/client");
  const p = new PrismaClient();
  p.user.findFirst({where:{portalDomain:"1begovoy.bitrix24.ru"}}).then(u => {
    console.log("token len:", u?.accessToken?.length || 0);
    console.log("expires:", u?.tokenExpiresAt);
  });
'
# Ожидание: token len > 60, expires в будущем

# 3. Connector активен на всех open-lines
docker logs source-adapter-1 --tail 200 | grep -i 'connector-health\|imconnector'
# Ожидание: "connector-health: registered=true" для всех LINE'ов

# 4. Тест incoming IG (если есть тестовый аккаунт):
# Отправить «test» в IG-Direct → должен появиться лид в B24

# 5. Тест outgoing IG:
# В B24 карточке открыть Social Connector → выбрать Instagram Direct → отправить
# Логи: "i2crm outgoing: POST /target/feedback" + "i2crm outgoing OK"
```

---

## 12. Где смотреть логи + что искать

```bash
# Реалтайм
docker logs source-adapter-1 -f --tail 0

# Фильтры по подсистемам
docker logs source-adapter-1 --since 30m 2>&1 | grep -iE 'i2crm|imconnector|widget|ensureLead|autoTake'
docker logs source-adapter-1 --since 30m 2>&1 | grep -iE 'error|warn'

# Webhook B24 → adapter
grep 'Bitrix24 webhook received' (event types: ONIMCONNECTORMESSAGEADD = outgoing от оператора, ONOPENLINEMESSAGEADD = новая сессия, ONIMCONNECTORLINEDELETE = удалили линию)

# Auto-take после ! префикса
grep 'mirror-to-direct\|operator.transfer\|backfillDirectMirror'

# Reply на конкретный коммент через BB-цитату
grep 'i2crm reply: цитата'

# i2crm timeout / ошибки
grep 'transport error\|i2crm outgoing rejected\|не матчит'
```

---

## 13. Карта связей с другими сервисами

| Сервис | Где | Связь | Что критично |
|---|---|---|---|
| `wa-tg-bridge` | `/home/dv/wa-tg-bridge/` | bridge → adapter `/webhooks/internal/*` (KBD/nnn). adapter ←/nothing/← bridge. | bridge **не блокирует** adapter — если bridge упал, adapter продолжает писать в B24 и customer-service |
| `customer-service` | `/home/dv/customer-service/` | adapter → `${CUSTOMER_SERVICE_URL}/events/ingest` с `X-Service-Secret`. И `/customers/find-or-create`, `/customers/<uuid>/aliases` | Если customer-service упал — adapter всё равно пишет в B24, но customer-360 пропускает события. Replay не реализован, потерянные события восстановить можно только через B24-backfill |
| `task-tracker` | `/home/dv/task-tracker/` | независим | — |
| `dv-dashboard` | `/home/dv/dv-dashboard/` | читает CH (через customer-service Postgres) — adapter не знает о нём | — |
| `Caddy` | `/etc/caddy/Caddyfile` | front для `social.9wb.ru` | Без Caddy adapter недоступен снаружи. B24 webhook'и упадут с timeout |
| `Cloudflare DNS` | `9wb.ru` zone | A-запись `social` | Без DNS B24 webhook'и тоже упадут |

---

## 14. Известные грабли (свод)

- `pnpm@10.x` — **pin** в package.json, pnpm 11 default minimum-release-age=24h ломает Docker build ([[feedback_pnpm_supply_chain_policy]])
- Пароли БД — alphanumeric only (Prisma URL-encoding)
- `awk -F=` обязательно при маскировке env ([[feedback_awk_mask_fs_required]])
- Никогда `bash -c "echo $PASS"` — пароль в transcript ([[feedback_secrets_in_proc_args]])
- `COMPOSE_PROJECT_NAME=source` обязателен — backup.sh+monitor завязаны на `source-adapter-1`/`source-db-1`
- `chat.id` префиксы должны совпадать incoming↔outgoing для одного клиента (см. OPEN_LINE_LIFECYCLE.md)
- IG comment chat.id — **3 сегмента** `i2crm_ig_<c>_c<m>_<acc>`, не 2 (regex обновлён 25.05)
- i2crm POST timeout 60s (Meta лагает), не 15s
- i2crm Public API НЕ поддерживает reply_to* для Direct (research 25.05)
- B24 «Ответить» НЕ передаёт parent_id в outgoing webhook — использовать «Цитировать»
- B24 open-lines: STATUS_ID=12 «Дубликат» имеет семантику F → лид пропадает из активной очереди

---

## 15. Связано

- [[social_connector]] — общая архитектура и роли
- [[greenapi_b24_install_flow]] — install/reinstall recipe (3 скрытые ловушки)
- [[ig_operator_reply_cheatsheet]] — операторская шпаргалка по IG
- [[widget_max_47_root_cause]] — регрессия #47 (закрыта 25.05)
- `docs/ARCHITECTURE.md`, `docs/SOCIAL_CONNECTOR.md` — общая картина
- `docs/INSTAGRAM_FLOW.md`, `docs/TELEGRAM_BOT_FLOW.md`, `docs/GREENAPI_CHANNELS.md` — flow по каналам
- `docs/OPEN_LINE_LIFECYCLE.md` — chat.id префиксы, lifecycle
- `docs/CUSTOMER360.md` — связь с customer-service
- `docs/REGRESSIONS.md` — журнал багов
- `docs/CHECKLIST_WIDGET.md` — чек-лист правок widget
- `docs/OPERATOR_GUIDE.md` — UX для операторов
- `docs/CLIENT_CARD_STANDARD.md` — формат карточек/тем
- `docs/TASK_TRACKER.md` — заметки по task-tracker (отдельный сервис)
