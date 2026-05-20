# Social Connector — полная техническая документация

Единый коннектор мессенджеров для Bitrix24 «Первого Бегового». Документ —
источник истины по всему сервису: какие каналы, что куда отправляется, где
что хранится. Меняешь поведение — правь и этот файл.

Последнее обновление: 2026-05-20.

Связанные документы:
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — карта сервисов и границы (читать первым).
- [`GREENAPI_CHANNELS.md`](./GREENAPI_CHANNELS.md) — детально по WhatsApp / MAX / Telegram.
- [`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md) — детально по Instagram (i2crm).
- [`CUSTOMER360.md`](./CUSTOMER360.md) — Customer-360 / KBD-лента.
- [`TASK_TRACKER.md`](./TASK_TRACKER.md) — внутренний трекер техзадач (отдельный сервис).

---

## 1. Что это и зачем

Social Connector сводит все клиентские мессенджеры в открытые линии Bitrix24:
входящие сообщения превращаются в лиды/диалоги CRM, исходящие из B24 уходят
клиенту. Заменяет платные Wappi / i2crm-нативный стек.

Каналы: **WhatsApp, MAX, Telegram** (через Green API) и **Instagram**
(Direct + Comment, через i2crm Public API).

---

## 2. Компоненты

| Компонент | Стек | Где живёт | Роль |
|---|---|---|---|
| **adapter** | NestJS + Prisma + MySQL | `/home/dv/greenapi-b24/source/`, Docker `source-adapter-1` + `source-db-1`; публично `https://social.9wb.ru` | ядро: B24 ↔ мессенджеры |
| **wa-tg-bridge** | Python (aiogram) + SQLite | `/home/dv/wa-tg-bridge/`, systemd `wa-tg-bridge` | приём Green API webhook'ов, TG-зеркало, KBD-лента |
| **customer-service** | NestJS + Prisma + Postgres | `/home/dv/customer-service/`, `127.0.0.1:3002` | мастер-БД клиентов Customer-360 (UUID, aliases) |
| **Green API** | внешний | кабинеты по `idInstance`+`apiToken` | шлюз к WhatsApp/MAX/Telegram |
| **i2crm Public API** | внешний | `app.i2crm.ru/api_v1` | шлюз к Instagram |
| **Bitrix24** | облако | `1begovoy.bitrix24.ru` | CRM, открытые линии |

B24-приложение: **Social Connector V2** (локальное, ID 640). Connector ID
во всех вызовах — **`social_connector`**.

---

## 3. Каналы, инстансы, открытые линии

| Канал | Номер/аккаунт | Green API idInstance | Открытая линия B24 |
|---|---|---|---|
| WhatsApp | 79584983354 | 1103487233 | **174** |
| WhatsApp | 79240778566 (офис) | 1101948511 | **148** |
| MAX | 79584983354 | 3100621187 | **182** |
| Telegram | 79584983354 | 4100621194 | **178** |
| Telegram | 79240778566 (офис) | 4100624465 | **204** |
| Instagram Direct | — | i2crm (виртуальный) | **18** |
| Instagram Comment | — | i2crm (виртуальный) | **22** |

`Instance.settings.provider` в БД adapter хранит тип канала (`wa` / `max` /
`telegram`) — от него зависят префикс chat-user'а, передача phone и UI виджета.

**Конфигурация открытых линий** (одинаково для всех): коннектор
`social_connector` активирован, `CRM_CREATE=lead`, `CRM_CHAT_TRACKER=Y`
(подвязывает новую сессию к уже открытому лиду/сделке клиента),
`CRM_CREATE_SECOND=0`, `CRM_CREATE_THIRD=Y`.

---

## 4. Где что хранится

### adapter — MySQL, БД `adapter` (Docker volume `source-db-1`)

| Таблица | Что |
|---|---|
| `User` | портал B24 + OAuth-токены (access/refresh) + applicationToken |
| `Instance` | Green API инстансы: idInstance, apiToken, bitrixLine, settings.provider |
| `OAuthApp` | два B24 OAuth-приложения (Social Connector + Customer-360) |
| `MaxContact` | кеш phone → chatId для MAX (CheckAccount) |
| `EntityPhonePref` | последний выбранный номер для CRM-сущности (для виджета) |
| `IgCommentContext` | контекст Instagram-комментария (media/comment id) на клиента |
| `I2crmEventLog` | журнал входящих i2crm-webhook'ов + replay при блокировке B24 |
| `OutgoingMessage` | соответствие idMessage ↔ B24 для статусов доставки |
| `B24EntitySnapshot` | снимок CRM-сущности для диф-событий «обновлён» (см. §8) |

Бэкап: `mysqldump` в pre-hook `backup.sh` → restic на Я.Диск.

### wa-tg-bridge — SQLite `data/bridge.sqlite`

Таблица `clients` — маппинг `instance_id ↔ chat ↔ TG-topic` + sticky
`customer_uuid` (Customer-360 UUID клиента). Бэкап через restic.

### customer-service — Postgres

Мастер-БД клиентов: UUID + alias-таблицы (phone / email / b24_lead /
b24_contact / tg_user / wa_chat / max_chat / ig_client) + merge-лог.

### ClickHouse — `customer_events`

Поток всех событий (сообщения, звонки, изменения CRM) для аналитики и
KBD-ленты.

---

## 5. Входящий поток (клиент → B24)

### 5.1. WhatsApp / MAX / Telegram (Green API)

```
Клиент пишет в мессенджер
        │
        ▼
Green API ──webhook──►  wa-tg-bridge  (handle_ga_webhook)
        │                    │
        │                    ├─► TG-зеркало: топик в группе канала
        │                    │   (Max 3354 / TG 3354 / …)
        │                    │
        │                    ├─► forward всего webhook'а →
        │                    │     adapter  POST /webhooks/green-api
        │                    │
        │                    └─► customer_events (ingest_event → CS)
        ▼
adapter (SDK) → imconnector.send.messages → открытая линия B24
        chat.id = wa_<phone> (WA) | sc_<chatId> (MAX/Telegram)
        ▼
B24 создаёт сессию открытой линии + лид (CRM_CREATE=lead)
```

Важно: **bridge форвардит в adapter ВСЕ типы webhook'ов** (не только
входящие). `BITRIX_INSTANCE_TO_LINE` в `.env` bridge задаёт соответствие
`idInstance:line`.

Префикс chat-user'а:
- WhatsApp → `wa_<phone>` (идентификатор реально телефон);
- MAX, Telegram → `sc_<chatId>` (внутренний id мессенджера; до 2026-05-16
  Telegram использовал `wa_` — legacy, больше не применяется).

### 5.2. Instagram

См. [`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md). Кратко: i2crm webhook →
adapter `POST /webhooks/i2crm` → `handleI2crmIncoming` → imconnector в линию
18 (Direct) или 22 (Comment). chat.id = `i2crm_ig_<client_id>`.

---

## 6. Исходящий поток (B24/менеджер → клиент) — ЧЕТЫРЕ пути

### 6.1. Оператор пишет в чате открытой линии B24

```
Оператор печатает в чате открытой линии
        ▼
B24 событие ONIMCONNECTORMESSAGEADD → adapter
        ▼
adapter определяет инстанс по линии → отправка:
   WA/MAX/Telegram → Green API sendMessage
   Instagram       → i2crm /target/feedback (type по линии: 18=direct/22=comment)
```

### 6.2. Виджет «написать первым» (Social Connector в карточке)

Менеджер в карточке лида → кнопка Social Connector → выбор инстанса →
телефон/username/текст → `POST /widget/send` (adapter, `widget.controller.ts`).

- WA/MAX/Telegram → Green API + зеркало в открытую линию через `mirrorToBitrix`.
- Instagram Direct → `sendInstagramDirect` (см. `INSTAGRAM_FLOW.md`).

Резолв получателя: chatId из B24-привязки → `@username` → кеш phone→chatId →
Green API CheckAccount.

### 6.3. Менеджер пишет прямо из приложения мессенджера (с телефона)

Если менеджер отвечает клиенту, печатая **в самом приложении** Telegram/MAX
офисного аккаунта (минуя B24) — Green API шлёт `outgoingMessageReceived`.

```
outgoingMessageReceived → adapter handleOutgoingFromDevice
        ▼
imconnector.send.messages в открытую линию, extra.is_self_message=true
        (chat.id = sc_<chatId> — садится в ту же сессию, без дубля)
```

Только Telegram/MAX. WhatsApp-исходящие с телефона обрабатывает
`handleOutgoingFromMobile` (тип `outgoingAPIMessageReceived`) — там оставляется
timeline-комментарий в карточке.

### 6.4. Статусы доставки

`outgoingMessageStatus` от Green API → `handleOutgoingMessageStatus` →
`imconnector.send.status.delivery` → B24 рисует галочки sent/delivered/read.

---

## 7. KBD-лента (Customer-360, группа «Клиенты 1Б»)

TG-супергруппа, один forum-topic на клиента. В топике:
1. **Pinned-карточка** — displayCode, телефоны, ссылки на B24 и на
   `dashboard.9wb.ru/customer/<uuid>`.
2. **Лента событий** — сообщения, звонки, изменения CRM.

Поток: событие → `customer-service /events/ingest` → CS вызывает
`bridge POST /internal/kbd-emit` → `KbdManager.emit_event` (`kbd.py`).

Медиа: для изображений `bridge._emit_message_event` кладёт `image_url` в
payload; `emit_event` скачивает картинку и шлёт её фото (`send_photo`), а не
строкой. Для звонков с `recording_url` — прикрепляет audio.

Подробнее — [`CUSTOMER360.md`](./CUSTOMER360.md).

---

## 8. События CRM B24 (ONCRM*) и диф «было → стало»

B24 шлёт `ONCRMLEADADD/UPDATE`, `ONCRMCONTACT*`, `ONCRMDEAL*` → adapter
`handleB24CrmEvent` → событие в `customer_events` + KBD-лента.

Проблема: B24 шлёт `*UPDATE` на ЛЮБОЕ касание сущности. Решение —
**таблица `B24EntitySnapshot`**:
- хранит последний снимок (`crm.<entity>.get`) сущности;
- на `updated` adapter сравнивает свежий снимок с сохранённым;
- значимые поля не изменились → **событие не отправляется** (волатильные
  авто-поля времени `DATE_MODIFY`/`TIMESTAMP_X`/`LAST_ACTIVITY_*` игнорируются);
- изменились → в summary пишется диф «Поле: было → стало». Коды
  `STATUS_ID`/`SOURCE_ID`/`STAGE_ID` переводятся через `crm.status.list`,
  `ASSIGNED_BY_ID` — через `user.get` (кешируется).

---

## 9. Конфигурация (env adapter'а, `/home/dv/greenapi-b24/.env`)

| Группа | Переменные |
|---|---|
| B24 | `BITRIX24_CLIENT_ID/SECRET`, `BITRIX_PORTAL_DOMAIN`, `APP_URL` (= `https://social.9wb.ru`) |
| Green API | `GREENAPI_*` (на инстанс), `GREENAPI_API_URL` |
| i2crm | `I2CRM_API_BASE`, `I2CRM_TARGET_KEY_PUBLICAPI`, `I2CRM_INSTAGRAM_ACCOUNT_ID`, `I2CRM_LINE_ID_IG_DIRECT` (18), `I2CRM_LINE_ID_IG_COMMENT` (22) |
| MySQL | `DATABASE_URL`, `MYSQL_*` |
| Customer-360 | `CUSTOMER_SERVICE_URL`, `CUSTOMER_SERVICE_SECRET` |
| Алерты | `ALERT_BOT_TOKEN`, `ALERT_CHAT_ID` |

bridge `.env` (`/home/dv/wa-tg-bridge/.env`): `GREENAPI_*` по инстансам,
`BITRIX_INSTANCE_TO_LINE`, `FORWARD_WEBHOOK_URL`, TG-bot токены, KBD-группа.

---

## 10. Деплой

- **adapter**: `git pull` в `/home/dv/greenapi-b24/source/` →
  `docker compose build adapter && docker compose up -d adapter`. Миграции
  Prisma накатываются автоматически на старте (`CMD npx prisma migrate deploy`).
- **wa-tg-bridge**: `rsync` исходников с мака → `systemctl restart wa-tg-bridge`.
  Код версионируется в репо `dv1-lab/pervyi-begovoy` (`bots/wa-tg-bridge/`).

---

## 11. Мониторинг и само-восстановление

`B24HealthCheckService` в adapter'е — раз в час проверяет:
1. `social_connector` присутствует в `imconnector.list`;
2. на каждой `Instance.bitrixLine` коннектор `CONFIGURED+STATUS=true` —
   если нет, **сам активирует** (`imconnector.activate` + `connector.data.set`)
   и шлёт алерт только если не помогло;
3. у портала есть хотя бы один Instance в БД.

Алерты — в `@agent_dv_bot` (edge-triggered: один раз при сбое, один при
восстановлении).

---

## 12. Ключевые файлы кода (adapter)

| Файл | Что |
|---|---|
| `src/oauth/oauth.controller.ts` | OAuth-install, регистрация коннектора, placement.bind |
| `src/webhooks/webhooks.controller.ts` | приём webhook'ов Green API / i2crm / B24-событий |
| `src/bitrix24/bitrix24.service.ts` | ядро: отправка/приём, i2crm, события CRM, диф |
| `src/bitrix24/bitrix24.transformer.ts` | конвертация webhook ↔ сообщение |
| `src/widget/widget.controller.ts` | виджет «написать первым» |
| `src/health/b24-health-check.service.ts` | мониторинг + само-восстановление линий |
| `prisma/schema.prisma` | модель БД |

wa-tg-bridge: `bridge.py` (приём/зеркало), `kbd.py` (KBD-лента),
`customers.py` (Customer-360 ingest), `greenapi.py` (Green API клиент).

---

## 13. Грабли (сводка)

- **chat.id входящих и исходящих должен совпадать** (`wa_`/`sc_`/`i2crm_ig_`
  префикс) — иначе B24 заводит дубль chat-user'а и дубль лида.
- **applicationToken в БД** не должен оставаться `temp_*` — иначе
  `Bitrix24WebhookGuard` отбивает все события.
- **B24 OAuth для local app даёт `scope=app`** при обычном code-flow; полный
  scope — только через install POST.
- **`imopenlines.config.update` не принимает параметр `QUEUE`** — операторов
  открытой линии можно добавить только через UI Контакт-центра.
- **Green API Telegram-shard**: `sendMessage` с `<id>@c.us` молча не
  доставляет — для MAX/Telegram chatId передаётся БЕЗ `@c.us`.
- **B24 при добавлении нового номера** не активирует коннектор на линии
  автоматически — но health-check (§11) это чинит сам в течение часа.
- Подробности по Instagram (i2crm type/source, лимит Direct, регрессии) —
  в [`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md).

---

## 14. Диагностика

```
# логи adapter
docker logs source-adapter-1 --since 30m 2>&1 | grep -iE "<нужное>"

# логи bridge
journalctl -u wa-tg-bridge --since "30 min ago" --no-pager

# статус линии в B24 (нужен OAuth-токен со scope imconnector)
imconnector.status CONNECTOR=social_connector LINE=<NN>  → CONFIGURED/STATUS

# снимки CRM-сущностей
SELECT entityType, COUNT(*) FROM B24EntitySnapshot GROUP BY entityType;
```
