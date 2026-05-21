# Customer-360 + Social Connector extensions

Документация дополнений adapter'а для проекта Customer-360 «Первого Бегового».
Все добавления — внутренние HTTP-endpoint'ы и методы `Bitrix24Service`,
не задевают upstream GREEN-API SDK.

## Архитектура

Adapter — это NestJS-сервис на my-server (`/home/dv/greenapi-b24/`,
порт `127.0.0.1:3001`, hostname `social.9wb.ru` через Caddy). Один OAuth-app
в Bitrix24 (`social_connector`), scope `crm,imopenlines,imconnector,im,user,placement,mobile,telephony,call`.

Дополнения покрывают:
- **Customer-360 sync**: UF поле `UF_CRM_PB_CUSTOMER_UUID` + backfill +
  event.bind на CRM events → event log в ClickHouse через customer-service.
- **i2crm Instagram pipeline**: Direct и Comments через i2crm Public API.
- **wa-tg-bridge interop**: pinned-cards, B24 photo backfill, operator hints,
  timeline-comment by phone, outgoing-from-mobile.
- **Outgoing status proxy**: галочки sent/delivered/read в B24 OpenLines.

## Внутренние HTTP-endpoint'ы (`/webhooks/internal/*`)

Все требуют header `X-Hint-Secret: <BRIDGE_HINT_SECRET>` (берётся из
`/home/dv/greenapi-b24/.env`).

### Customer-360 sync

| Endpoint | Назначение |
|---|---|
| `POST /internal/init-uf-fields` | Идемпотентно создать `UF_CRM_PB_CUSTOMER_UUID` на lead/contact/deal. Возвращает `{lead, contact, deal}` со статусами `created|exists|skipped`. |
| `POST /internal/sync-customer-uuid` | Один батч бэкфилла UF UUID. Тело: `{entity:"lead"|"contact"|"both", limit:20, rateMsec:2000}`. Возвращает counters `fetched/updated/failed/skipped_no_alias/skipped_no_name`. |
| `POST /internal/register-b24-events` | Регистрирует event.bind на 6 CRM-событий. Идемпотентно (через event.get). |
| `POST /webhooks/b24-event?event=<EVENT>` | Handler для event.bind webhooks (без auth — B24 не шлёт секрет; защищено `event=` whitelist'ом). Резолвит entity в customer-service и пишет event в customer_events. |

### Wa-tg-bridge interop

| Endpoint | Назначение |
|---|---|
| `POST /internal/contact-name` | bridge → adapter: получить имя клиента из B24 по phone/igClientId. |
| `POST /internal/b24-set-photo` | bridge avatar-sync → adapter: установить PHOTO в B24 (не перезатирает не пустое). |
| `POST /internal/backfill-ig-pinned-cards` | Bridge → adapter: backfill pinned-карточек существующих IG-топиков. |
| `POST /internal/refresh-ig-topics` | Массовое переименование IG-тем по новому формату. |
| `POST /internal/i2crm-replay` | Повторная доставка pending i2crm событий (после OVERLOAD_LIMIT). |
| `POST /internal/timeline-comment` | Добавить timeline-comment в открытую сделку/лид клиента по phone. Bridge использует для avatar_changed и outgoing-from-mobile. |

## Customer-360 методы в Bitrix24Service

### `ensureUfField(entity, fieldName, opts)`

Создаёт UF поле через OAuth-токен установленного app. Возвращает `created|exists|skipped`. Inbound webhook B24 не имеет userfield scope, поэтому работа только через OAuth.

### `syncCustomerUuidBatch({entity, limit, rateMsec})`

Берёт N entity без UF_CRM_PB_CUSTOMER_UUID, для каждого: phone → customer-service `/find-or-create` → `crm.lead.update` UF. Между entity sleep(rateMsec).

Особенности:
- Для **contact** проверяет `NAME || LAST_NAME` непусто — иначе skip (B24 валидирует обязательность). Лиды имеют TITLE, валидации нет.
- Fallback на email если нет phone, потом `b24_lead`/`b24_contact` alias.
- После find_or_create добавляет b24_* alias к customer'у.

### `registerB24CrmEvents(handlerBaseUrl)`

Регистрирует event.bind на 6 событий через `event.get` → diff → `event.bind`/`event.unbind`. Идемпотентно даже после смены handler URL.

### `handleB24CrmEvent(rawEvent, payload)`

Принимает B24 webhook (`ONCRM{LEAD,CONTACT,DEAL}{ADD,UPDATE}`) →
`crm.{entity}.get` за свежий snapshot → customer-service resolve → event
в `customer_events`.

**Снимок-диф (дедупликация).** B24 шлёт `ONCRM*UPDATE` на любое касание
сущности — в т.ч. от нашего же cron'а `customer-uuid-sync`. Чтобы не
заваливать KBD-ленту пустыми «lead обновлён»:
- свежий snapshot сравнивается с предыдущим (таблица `B24EntitySnapshot`,
  MySQL adapter'а) через `_diffSnapshots`;
- сравнение **каноническое** — `_canonical()` рекурсивно сортирует ключи
  объектов. B24 возвращает phone/email/IM-массивы с непостоянным порядком
  ключей внутри объекта; без нормализации одинаковые данные ловятся как
  «изменение поля» и порождают поток ложных событий;
- служебные/технические поля исключены из дифа:
  `SNAPSHOT_IGNORE_FIELDS` (DATE_MODIFY, LAST_ACTIVITY_TIME, MODIFY_BY_ID
  и пр. авто-поля времени) + по префиксу — **все `UF_CRM_*`** (кастомные
  поля), **`UTM_*`** (метки), **`IM`** (служебная связка лида с открытыми
  линиями). Их выставляет автоматика при создании/обогащении лида — это
  не бизнес-событие. Без этого сразу после «lead создан» прилетал
  «lead обновлён» со стеной `UF_CRM_…`/`UTM_…`;
- значимых изменений нет → событие в ленту **не шлётся**, обновляется
  только снимок;
- есть → в summary строки `Поле: было → стало`. `_fmtFieldValue`:
  статусы/источники резолвятся в имена (`crm.status.list`), сотрудники —
  через `user.get`, многозначные поля выводятся списком VALUE (не дампом
  JSON-массива).

Снимка ещё нет (первое касание сущности) при `updated` — диф построить не
из чего, событие **не шлётся**, снимок молча фиксируется как baseline;
следующее обновление уже сравнивается по дифу. Это убирает шум от
`customer-uuid-sync`, который касается каждой сущности по разу. Для `added`
событие шлётся всегда (с пометкой `[STATUS=...]`).

### `addTimelineCommentByPhone(phone, text)`

Ищет открытую сделку (через `crm.duplicate.findbycomm` + `crm.deal.list`), потом лид. Добавляет comment. Возвращает `{ok, entity, entityId, reason}`.

### `handleOutgoingFromMobile(webhook)`

Оператор пишет с мобильного WhatsApp (не из B24). Green API шлёт
`outgoingAPIMessageReceived` (sendByApi=true, sender=наш wid). Adapter:
- timeline-comment в открытую сделку/лид с пометкой «📱 Ответ с мобильного WhatsApp»
- event ingest (`source=bridge_wa`, `eventType=message_out`, `payload.sender_by_mobile=true`)

В Bizz-chat OpenLines не виден (B24 не имел своей сессии).

### `handleOutgoingMessageStatus(webhook)`

Proxy sent/delivered/read статусов из Green API в B24 OpenLines (галочки).
Использует in-memory `outgoingStatusMap` (idMessage GreenAPI → B24 chat_id/message_id), заполняется при `sendDeliveryConfirmation` после первой отправки.

## In-memory state

| Variable | Назначение | TTL |
|---|---|---|
| `outgoingStatusMap` | idMessage GreenAPI → (B24 chat_id, message_id, line, connector). Для проксирования delivery status. | 24h |
| `operatorHints` | idMessage → (operator name, expires). Передаются bridge'у для outgoing-зеркала. | 5 min |
| `_ensureLeadLocks` | per-key locks ensureOpenLeadForPhone, чтобы не плодить лиды. | session |

## Детект смены аватарки (wa-tg-bridge)

`AvatarChangeWatcher` в bridge раз в 6 ч обходит активных клиентов, дёргает
Green API `getAvatar`, **скачивает картинку и сравнивает SHA-256 содержимого**
с baseline (`clients.pinned_card_avatar_hash`, SQLite bridge).

URL аватарки WhatsApp подписанный/одноразовый — меняется при каждой проверке,
даже если картинка та же. Сравнение по URL давало ложные «сменил аватарку»
(один клиент — по 10-18 раз в неделю), засорявшие KBD-ленту. Поэтому baseline
держится по хешу байтов, а не по URL.

При реальной смене: уведомление в TG-теме клиента, event `avatar_changed` в
`customer_events` (в `payload.image_url` — новый аватар, KBD-лента рендерит
его фотографией), timeline-comment в B24. Первый проход после деплоя —
бэкфилл хешей, без уведомлений.

## Customer-service interop

Adapter ходит в customer-service через `CUSTOMER_SERVICE_URL` (`.env`) с
заголовком `X-Service-Secret`. Используется в:
- `syncCustomerUuidBatch` → `/customers/find-or-create`, `/customers/:uuid/aliases`
- `handleB24CrmEvent` → `/events/ingest`
- `_eventsIngest()` helper

См. README customer-service для полного REST API.

## Environment variables (Customer-360 specific)

| Variable | Назначение |
|---|---|
| `CUSTOMER_SERVICE_URL` | http://customer-service-customer-service-1:3000 (через shared docker network) |
| `CUSTOMER_SERVICE_SECRET` | X-Service-Secret для customer-service |
| `BRIDGE_HINT_SECRET` | общий с wa-tg-bridge секрет для internal-endpoint'ов |
| `BRIDGE_HINT_URL` | URL bridge для отправки operator hints |
| `B24_EVENTS_HANDLER_BASE` | базовый URL для event.bind (default https://social.9wb.ru) |

## Cron на my-server (`/home/dv/server-ubuntu-setup/customer-360/`)

- `customer-uuid-sync.sh` — `*/15 * * * *` — POST `/internal/sync-customer-uuid`
- `ai_evaluator_wrapper.sh` — `*/30 * * * *` — оценивает merge suggestions
- `ai_consultant_wrapper.sh` — `*/10 * * * *` — AI-подсказки в B24 timeline
- `status_report_wrapper.sh` — `0 8 * * *` — daily health в @agent_dv_bot

См. memory `[[customer_360_ops]]` для деталей.

## Связанные документы

- vault `[[projects/Customer-360]]` — общая архитектура с диаграммой
- memory `[[customer_360_roadmap]]` — статус этапов 0-6
- memory `[[customer_service]]` — master DB сервис
- memory `[[customer_360_split_b24]]` — план разделения OAuth-app
