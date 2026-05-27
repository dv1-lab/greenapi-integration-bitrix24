# WhatsApp / MAX / Telegram — техническая документация

Как Social Connector обрабатывает каналы, идущие через **Green API**:
WhatsApp, MAX, Telegram. Документ — источник истины по этим трём каналам и
их различиям. Меняешь код — правь и этот файл.

Общая документация по сервису — [`SOCIAL_CONNECTOR.md`](./SOCIAL_CONNECTOR.md).
Instagram — отдельный канал (i2crm, не Green API) — [`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md).

Последнее обновление: 2026-05-22.

---

## 1. Общая модель

Все три канала подключены через сервис **Green API**: на каждый
номер/аккаунт — свой Green API «инстанс» (`idInstance` + `apiTokenInstance`).
Путь одинаковый, различия — в деталях идентификации клиента.

```
Клиент → мессенджер → Green API ──webhook──► wa-tg-bridge
                                                  │
                          ┌───────────────────────┤
                          ▼                       ▼
              TG-зеркало (топик в           forward всего webhook'а →
              группе канала)                adapter POST /webhooks/green-api
                                                  │
                                                  ▼
                                  adapter → imconnector.send.messages
                                            → открытая линия B24
```

bridge — единая точка приёма Green API webhook'ов. Он:
1. зеркалит сообщение в TG-топик группы канала (для оперативного просмотра);
2. **форвардит весь webhook** в adapter (`FORWARD_WEBHOOK_URL`);
3. пишет событие в Customer-360 (`customer_events`).

adapter превращает webhook в сообщение открытой линии B24.

---

## 2. Инстансы и линии

| Канал | Аккаунт | idInstance | Green API shard | Линия B24 | `provider` |
|---|---|---|---|---|---|
| WhatsApp | 79584983354 | 1103487233 | `1103.api.green-api.com` | 174 | `wa` |
| WhatsApp | 79240778566 (офис) | 1101948511 | `api.green-api.com` | 148 | `wa` |
| MAX | 79584983354 | 3100621187 | `3100.api.green-api.com` | 182 | `max` |
| Telegram | 79584983354 | 4100621194 | `4100.api.green-api.com` | 178 | `telegram` |
| Telegram | 79240778566 (офис) | 4100624465 | `4100.api.green-api.com` | 204 | `telegram` |

`provider` хранится в `Instance.settings.provider` (БД adapter) и определяет
логику: префикс chat-user'а, передачу phone, поведение CheckAccount, UI виджета.

---

## 3. Типы webhook'ов Green API

| typeWebhook | Когда | Кто обрабатывает |
|---|---|---|
| `incomingMessageReceived` | клиент написал | adapter SDK → imconnector |
| `outgoingMessageReceived` | сообщение отправлено **с устройства** (менеджер набрал в приложении мессенджера) | adapter `handleOutgoingFromDevice` (только MAX/Telegram) |
| `outgoingAPIMessageReceived` | отправлено через API мимо B24 | adapter `handleOutgoingFromMobile` (WA → timeline-комментарий) |
| `outgoingMessageStatus` | статус доставки | adapter `handleOutgoingMessageStatus` → галочки в B24 |
| `stateInstanceChanged` | сменилось состояние инстанса | bridge — алерт при `notAuthorized`/`blocked` |

Настройки инстанса (`getSettings`/`setSettings`): bridge выставляет
`incomingWebhook: yes`, `outgoingMessageWebhook: yes` и т.п.

---

## 4. Идентификация клиента и префиксы chat-user'а

Это ключевое различие между каналами и источник дублей при ошибке.

| Канал | Идентификатор клиента | Префикс `user.id`/`chat.id` в B24 | phone в payload |
|---|---|---|---|
| WhatsApp | телефон | `wa_<phone>` | да (E.164) |
| MAX | внутренний chatId | `sc_<chatId>` | нет (privacy) |
| Telegram | внутренний chatId | `sc_<chatId>` | нет (privacy) |

**Префикс должен совпадать для входящих и исходящих** — иначе B24 видит
разных chat-user'ов и заводит дубль лида.

- WhatsApp: идентификатор реально телефон → `wa_`, в payload передаётся
  `user.phone` (E.164).
- MAX / Telegram: телефон клиента недоступен (privacy мессенджеров), только
  внутренний chatId → `sc_`. **До 2026-05-16 Telegram использовал `wa_`**
  (legacy: 10-значные TG chatId принимались за телефон) — перешли на `sc_`,
  виджет синхронизирован. Старые `wa_`-привязки не трогать.

`name` в payload — **без пробелов**: B24 режет по пробелу (NAME / LAST_NAME).

---

## 5. Различия по каналам

### 5.1. WhatsApp

**Конфигурация каналов** (2 номера, 2 инстанса, 2 линии):

| Назначение | Инстанс | Линия B24 | Номер магазина |
|---|---|---|---|
| Basic / основной | `1101948511` | **148** | (см. `.env` adapter) |
| Доп. инстанс | `1103487233` | **174** | (см. `.env` adapter) |

| Параметр | Значение |
|---|---|
| UF клиента | **нет** — клиент идентифицируется по phone (стандартное поле B24) |
| Префикс `chat.id` | `wa_<phone>` (наш формат) / `<phone>@c.us` (Green API формат) |

**Идентификация:** Самый простой канал — клиент = телефон. `chatId` =
`<phone>@c.us`. `CheckAccount` для phone в WhatsApp работает без ограничений
(в отличие от TG/MAX, см. §5.2-5.3).

**Правила создания лидов** (применено к обеим линиям):
открытая сделка → forward; открытый лид → продолжение; иначе → новый лид.
См. [`PRODUCT_RULES.md §1.1`](./PRODUCT_RULES.md).

**Распределение операторов** (применено 26.05.2026 на 148 + 174):
`QUEUE_TYPE=all` + `CRM_TRANSFER_CHANGE=N`. См. ADR
[`2026-05-26-openlines-queue-type-evenly`](./decisions/2026-05-26-openlines-queue-type-evenly.md).

**Outgoing-пути для оператора:**
1. Из чата open-line в B24 → Green API `sendMessage`
2. Через виджет «Social Connector» (`POST /widget/send`) → `<phone>@c.us` →
   `sendMessage` (без CheckAccount-резолва — phone и есть идентификатор)
3. **С мобильного WhatsApp** того же аккаунта магазина → Green API шлёт
   `outgoingAPIMessageReceived` → `handleOutgoingFromMobile` оставляет
   **timeline-комментарий** в карточке (открытую линию не создаёт)
4. Через native B24 OpenLine UI без нашего widget'а → orphan-link (см. ниже)

**Orphan-link при native B24 UI** (фикс #68, sha `afe5316`, 26.05.2026):
аналогично MAX/TG/IG. TITLE pattern `<chat_id> - WhatsApp <phone>`, поиск
контакта **по phone из TITLE** (UF_CRM_WA_CHAT_ID на портале не существует).
См. ADR
[`2026-05-26-orphan-lead-linker`](./decisions/2026-05-26-orphan-lead-linker.md).

**Конверсия лида → контакт:** для WhatsApp **спецлогика не нужна** — phone
это стандартное поле B24, наследуется при конверсии автоматически. Фикс #69
(`_propagateChatIdsOnConvert`) затрагивает только TG/MAX/IG-каналы с
кастомными UF.

**Зеркало в TG-группе:**
Каждый WA-инстанс — своя TG-админ-группа, топик на клиента. Маппинг
в `bridge.sqlite` wa-tg-bridge. См. §7.

### 5.2. MAX

**Конфигурация канала:**

| Параметр | Значение |
|---|---|
| Номер аккаунта магазина | `79584983354` (тот же что для TG-канала магазина) |
| Green API инстанс | `3100621187` |
| Линия B24 | **182** «MAX» |
| UF клиента | `UF_CRM_MAX_CHAT_ID` |
| Префикс `chat.id` | без префикса (внутренний chatId MAX) |

**Идентификация и резолв phone→chatId:**

- Клиент = внутренний chatId, телефона нет.
- Green API метод **CheckAccount** резолвит phone → chatId, **только если**
  номер есть в адресной книге MAX-аккаунта. `phoneNumber` принимается строкой.
- Кеш phone→chatId — таблица `MaxContact` в БД adapter (исторически имя одно
  на оба провайдера TG/MAX).
- Полный flow резолва 4 приоритета (B24 → @username → кеш → CheckAccount):
  см. §6.1.
- **Изображения приходят в формате webp** — Telegram принимает их через
  `send_photo` загруженными байтами (не по ссылке).

**Правила создания лидов** (применено к линии 182):
открытая сделка → forward; открытый лид → продолжение; иначе → новый лид
(`CRM_CREATE=lead`, `CRM_CREATE_SECOND=N`, `CRM_FORWARD=Y`). См.
[`PRODUCT_RULES.md §1.1`](./PRODUCT_RULES.md).

**Распределение операторов** (применено 26.05.2026 на линии 182):
`QUEUE_TYPE=all` (уведомление всем сразу, первый забрал — ведёт) +
`CRM_TRANSFER_CHANGE=N` (новое обращение не наследует ответственного
из исторического лида). См. ADR
[`2026-05-26-openlines-queue-type-evenly`](./decisions/2026-05-26-openlines-queue-type-evenly.md).

**Outgoing-пути для оператора** (4 способа, см. §6):
1. Из чата open-line в B24 (`ONIMCONNECTORMESSAGEADD` → `sendMessage`)
2. Через виджет «Social Connector» в карточке (`POST /widget/send` →
   резолв 4 приоритета → `sendMessage`)
3. С физического устройства MAX (или MAX Web) того же аккаунта магазина —
   `outgoingMessageReceived` → `handleOutgoingFromDevice` зеркалит в open-line
4. Через native B24 OpenLine UI (без нашего widget'а) — см. ниже про orphan-link

**Orphan-link при native B24 UI** (фикс #68, sha `afe5316`, 26.05.2026):
если оператор пишет через стандартный B24 OpenLine UI без нашего виджета,
B24 создаёт лид без `CONTACT_ID` и `UF_CRM_MAX_CHAT_ID`. Listener
`_maybeLinkOrphanLead` в `ONCRMLEADADD` парсит TITLE pattern
`<chat_id> - MAX <phone>`, ищет контакт по UF/phone, привязывает; если
у клиента есть открытая сделка — закрывает orphan как «Дубликат → deal N».
Постфактум: `POST /webhooks/internal/relink-orphan-lead {leadId}`.
См. ADR
[`2026-05-26-orphan-lead-linker`](./decisions/2026-05-26-orphan-lead-linker.md).

**Конверсия лида → контакт** (фикс #69, sha `e883832`, 27.05.2026):
B24 при конверсии не наследует UF на новый контакт — `UF_CRM_MAX_CHAT_ID`
терялся. Listener `_propagateChatIdsOnConvert` детектирует конверсию
через `ONCRMLEADUPDATE + STATUS_ID=CONVERTED` и копирует UF на привязанный
контакт. Постфактум: `POST /webhooks/internal/propagate-chat-ids {leadId}`.
См. ADR
[`2026-05-26-convert-propagate-chat-ids`](./decisions/2026-05-26-convert-propagate-chat-ids.md).

**Текущие ограничения:**

- **Массовый bulk-импорт номеров** в адресную книгу MAX-аккаунта магазина
  через API невозможен: Green API `addContact` для MAX возвращает 404.
  Зарегистрировано как issue #29 в `green-api/max-issues`. Workaround —
  ручное добавление через приложение MAX на физическом телефоне магазина.
  См. memory `[[greenapi-addcontact-pending]]`, task #64.

**Зеркало в TG-группе:**

Каждое incoming/outgoing сообщение зеркалится в TG-админ-группу
(`TELEGRAM_GROUP_CHAT_ID` для инстанса `3100621187`), отдельный топик
на клиента. Маппинг `instance ↔ chat ↔ topic` — SQLite `bridge.sqlite`
в wa-tg-bridge. См. §7.

### 5.3. Telegram (номер магазина — НЕ бот)

> ⚠️ **Не путать с TG-ботами** (`@begovoy_bot`, `@begovoy1support_bot`).
> Это совсем другой канал — см. [`TELEGRAM_BOT_FLOW.md`](./TELEGRAM_BOT_FLOW.md).
> Здесь — про **TG-аккаунт магазина по номеру**, подключённый через Green API
> как обычный пользовательский Telegram.

**Конфигурация каналов** (2 номера, 2 инстанса, 2 линии):

| Назначение | Инстанс | Линия B24 | Номер аккаунта |
|---|---|---|---|
| Basic «TG begovoy» | `4100621194` | **178** | `79584983354` (тот же что MAX) |
| Офисный «Office TG» | `4100624465` | **204** | `79240778566` (тот же что WA-148) |

| Параметр | Значение |
|---|---|
| UF клиента | `UF_CRM_TG_CHAT_ID` |
| Префикс `chat.id` | без префикса (внутренний chatId Telegram, например `396522892`) |

Офисная линия 204 имеет специфику запуска и общую очередь операторов с WA-148 —
см. §8.

**Идентификация и резолв phone→chatId:**

- Клиент = внутренний chatId, телефона нет.
- **CheckAccount** на TG-shard'е: `phoneNumber` обязан быть **integer**
  (строка → `Validation failed`).
- **AddContact возвращает 404 на TG-shard'е** — пополнить адресную книгу
  Telegram-аккаунта через API нельзя. Для холодных номеров остаётся резолв
  по `@username`.
- Резолв по username: Green API принимает `chatId` в формате `<username>@c.us`
  в `sendMessage`.
- Полный flow резолва 4 приоритета (B24 → @username → кеш → CheckAccount):
  см. §6.1.
- **КРИТИЧНО: silent-fail `@c.us` для chatId.** Если в `sendMessage` передать
  `chatId: "<numeric_id>@c.us"` — Green API возвращает `idMessage` (как будто
  успех), но сообщение **не доставляется**. Без суффикса (`chatId: "<id>"`) —
  доставляется. Поэтому в `bitrix24.transformer.ts` для chat.id с префиксом
  `sc_` формируется chatId БЕЗ `@c.us`. Префикс `wa_*` остаётся `<phone>@c.us`.

**Правила создания лидов** (применено к 178 + 204):
открытая сделка → forward; открытый лид → продолжение; иначе → новый лид.
См. [`PRODUCT_RULES.md §1.1`](./PRODUCT_RULES.md).

**Распределение операторов** (применено 26.05.2026):
`QUEUE_TYPE=all` + `CRM_TRANSFER_CHANGE=N`. См. ADR
[`2026-05-26-openlines-queue-type-evenly`](./decisions/2026-05-26-openlines-queue-type-evenly.md).

**Outgoing-пути для оператора** (4 способа, см. §6):
1. Из чата open-line в B24 → Green API `sendMessage`
2. Через виджет «Social Connector» в карточке (`POST /widget/send` →
   резолв 4 приоритета → `sendMessage`)
3. С физического устройства Telegram-аккаунта магазина (или Telegram Web) —
   `outgoingMessageReceived` → `handleOutgoingFromDevice` зеркалит в
   open-line как `is_self_message`
4. Через native B24 OpenLine UI — см. ниже про orphan-link

**Orphan-link при native B24 UI** (фикс #68, sha `afe5316`, 26.05.2026):
TITLE pattern `<chat_id> - Telegram <phone>` или `<chat_id> - TG <phone>`,
поиск контакта по UF/phone, привязка + закрытие как «Дубликат» при openEntity.
См. ADR
[`2026-05-26-orphan-lead-linker`](./decisions/2026-05-26-orphan-lead-linker.md).

**Конверсия лида → контакт** (фикс #69, sha `e883832`, 27.05.2026):
`_propagateChatIdsOnConvert` копирует `UF_CRM_TG_CHAT_ID` с лида на
привязанный контакт после конверсии. См. ADR
[`2026-05-26-convert-propagate-chat-ids`](./decisions/2026-05-26-convert-propagate-chat-ids.md).

**Текущие ограничения:**

- **Bulk-импорт номеров** в адресную книгу TG-аккаунта магазина через API
  невозможен (`addContact` 404). Issue #21 в `green-api/telegram-issues`.
  Workaround — ручное добавление через приложение / Telegram Web на телефоне
  магазина. См. memory `[[greenapi-addcontact-pending]]`, task #64.
- **Каналы/группы отсекаются.** Наш Telegram-аккаунт подписан на сторонние
  каналы — их посты-рассылки прилетают входящими webhook'ами. У Telegram
  личные чаты имеют положительный `chatId`, а каналы / супергруппы / группы —
  отрицательный (`-100…` / `-…`). bridge в `handle_ga_webhook`
  (`_is_telegram_group_or_channel`) отбрасывает такие webhook'и до форварда в
  adapter и до TG-зеркала — иначе пост канала превращался в лид B24.

**Зеркало в TG-админ-группе:**
На каждый инстанс — своя группа, топик на клиента. `bridge.sqlite`
wa-tg-bridge хранит маппинг. См. §7.

---

## 6. Исходящий поток

Четыре пути (общесервисные, см. `SOCIAL_CONNECTOR.md` §6), для Green API-каналов:

1. **Чат открытой линии B24** — оператор пишет → `ONIMCONNECTORMESSAGEADD` →
   adapter → Green API `sendMessage`.
2. **Виджет «написать первым»** — `POST /widget/send` → Green API + зеркало
   в открытую линию через `mirrorToBitrix`.
3. **С устройства (телефон)** — менеджер набрал в приложении мессенджера →
   `outgoingMessageReceived` → `handleOutgoingFromDevice` → зеркало в линию
   `is_self_message`. **Только MAX/Telegram** (WA — путь `outgoingAPIMessage…`).
4. **Статусы** — `outgoingMessageStatus` → `imconnector.send.status.delivery`.

### 6.1. Резолв `phone → chatId` в `widget/send` для TG/MAX

WA шлёт по `<phone>@c.us` напрямую — phone и есть идентификатор. Для **TG/MAX**
адаптер не знает chatId заранее (мессенджеры скрывают phone клиента). В
`widget.controller.ts` четыре приоритета резолва — берётся первый что сработал:

| # | Источник | Когда используется | Что делает |
|---|---|---|---|
| 1 | `chatId` от фронта | Виджет нашёл chatId в B24 open-line привязке (повторная отправка тому же клиенту, у которого уже была переписка) | Используем напрямую, плюс `UPSERT` в локальный кеш `maxContact` (для будущих отправок этого же phone) |
| 2 | `@username` от оператора | Оператор знает Telegram/MAX-ник клиента, ввёл в виджет | `chatId = <username>@c.us` — Green API принимает оба shard'а. Обходит phone-privacy клиента |
| 3 | Локальный кеш `maxContact` | Phone уже резолвился раньше (приоритет 1 или 4) | `SELECT chatId FROM maxContact WHERE idInstance=? AND phone=?` |
| 4 | `CheckAccount` у Green API | Холодный phone, никогда не отправляли, нет username | `POST /CheckAccount` с phoneNumber. Резолвит **только** если phone в адресной книге аккаунта магазина ИЛИ клиент в privacy «Кто может найти меня по номеру» = Все. Если ОК → сохраняем в `maxContact` и шлём. Если 404 → пользователю hint «добавь номер в адресную книгу аккаунта <number>» |

После успешной отправки `mirrorToBitrix` дописывает `UF_CRM_TG_CHAT_ID` /
`UF_CRM_MAX_CHAT_ID` в **B24-карточку контакта** клиента — следующая отправка
с фронта уже подхватит chatId по приоритету 1 (виджет читает UF из B24).

**Типовые сценарии:**

- **Был входящий → отвечаем через виджет**: приоритет 1, chatId уже в B24.
- **Холодный лид с сайта, phone есть, клиент в нашей адресной книге**: приоритет 4, CheckAccount резолвит, кешируется.
- **Холодный лид, phone не в адресной книге, без username**: приоритет 4 даёт 404 — оператор видит hint про добавление номера в аккаунт магазина либо вводит `@username`.
- **Massовая загрузка контактов при подключении нового инстанса** — отдельная задача (#64): нужен `addContact` от Green API, сейчас он 404. Workaround — ручной импорт через телефон/Telegram Web. См. memory `[[greenapi-addcontact-pending]]`.

`maxContact` (название историческое, таблица одна на оба провайдера) — таблица
в Prisma schema adapter'а, ключ `(idInstance, phone)` → `chatId`. Сбрасывается
только при ротации MySQL volume.

---

## 7. wa-tg-bridge

- Принимает Green API webhook'и на свой endpoint, форвардит всё в adapter.
- `BITRIX_INSTANCE_TO_LINE` в `.env` — соответствие `idInstance:line`
  (`1103487233:174,1101948511:148,3100621187:182,4100621194:178,4100624465:204`).
- TG-зеркало: на каждый инстанс — своя TG-группа, топик на клиента
  (`GREENAPI_ID_INSTANCE_N` + `TELEGRAM_GROUP_CHAT_ID_N`).
- Маппинг `instance ↔ chat ↔ topic` — SQLite `data/bridge.sqlite`.
- Новый инстанс: добавить секцию `GREENAPI_*_N` в `.env`, прописать в
  `BITRIX_INSTANCE_TO_LINE`, создать TG-группу-зеркало.

---

## 8. Офисный Telegram (линия 204) — добавлен 2026-05-20

Telegram-канал на офисном номере 79240778566 (тот же номер, что WhatsApp
линии 148). Инстанс `4100624465`, открытая линия B24 `204`, TG-зеркало
группа `-1003789598773`.

При добавлении инстанса коннектор на линии 204 **не был активирован** —
B24 делает это только при настройке через SETTING_CONNECTOR. Сообщения
не доходили (`NOT_ACTIVE_LINE`). Активировали вручную
(`imconnector.activate` + `connector.data.set`); на будущее — health-check
теперь активирует неактивные линии сам (`SOCIAL_CONNECTOR.md` §11).

Очередь операторов линии 204 заполнена операторами офисного WhatsApp 148.
`imopenlines.config.update` не принимает `QUEUE` — операторов добавляют
через UI Контакт-центра.

---

## 8a. Входящие медиа — прокси через social.9wb.ru

B24 (`imconnector.send.messages` с `files[]`) скачивает файл по ссылке сам,
со своих серверов. Тут разница по каналам:

- **WhatsApp**: `downloadUrl` ведёт на публичное хранилище
  `sw-media-<shard>.storage.yandexcloud.net` — B24 скачивает без проблем.
- **Telegram / MAX**: `downloadUrl` ведёт на эндпоинт Green API
  `<shard>.api.green-api.com/download/...`. **B24 со своих серверов скачать
  его НЕ может** — висит ~20 c и отвечает `SUCCESS:false, ERRORS:["Переданы
  не все необходимые данные"]`. Файл сам по себе валиден (curl извне даёт
  200/jpeg) — проблема именно в фетче со стороны B24.

**Решение (2026-05-22):** adapter в `bitrix24.service.ts` при сборке `files[]`
для входящего сообщения проверяет URL — если это `*.api.green-api.com/...`,
скачивает файл сам, кладёт в `MediaCacheService` (in-memory, TTL 30 мин) и
отдаёт B24 ссылку `https://social.9wb.ru/media/<id>.<ext>` (`MediaController`,
`GET /media/:file`). social.9wb.ru B24 тянет без проблем. WhatsApp-URL
(yandexcloud) проксирование не трогает — идёт напрямую.

---

## 9. Грабли (сводка)

- **Входящие фото/файлы Telegram/MAX** B24 не может скачать с
  `api.green-api.com` напрямую — идут через медиа-прокси (см. §8a).
- **Префикс chat-user'а** (`wa_`/`sc_`) для входящих и исходящих обязан
  совпадать — иначе дубль лида.
- **Telegram `@c.us` silent-fail** — для `sc_` chatId передаётся без `@c.us`.
- **CheckAccount**: TG-shard требует integer phoneNumber, MAX — string.
- **AddContact** не работает на TG-shard'е (404).
- `name` в payload — без пробелов.
- `user.phone` передаётся только для WA.
- При добавлении номера — проверить активацию коннектора на линии
  (`imconnector.status`), либо дождаться авто-починки health-check'ом.

---

## 10. Карта кода

| Где | Что |
|---|---|
| `src/webhooks/webhooks.controller.ts` | роутинг webhook-типов Green API |
| `src/bitrix24/bitrix24.service.ts` | приём/отправка, `handleOutgoingFromDevice`, `handleOutgoingFromMobile`, `handleOutgoingMessageStatus` |
| `src/bitrix24/bitrix24.transformer.ts` | webhook ↔ сообщение, формирование chatId |
| `src/bitrix24/media-cache.service.ts` + `media.controller.ts` | медиа-прокси входящих Telegram/MAX-файлов → B24 (§8a) |
| `src/widget/widget.controller.ts` | виджет «написать первым», `mirrorToBitrix` |
| wa-tg-bridge `bridge.py` | приём webhook'ов, TG-зеркало, форвард |
| wa-tg-bridge `greenapi.py` | Green API клиент, настройки инстансов |

---

## 11. Известные ограничения Green API per канал

Уточнено support Green API 2026-05-26 (Petr) на запрос про addContact.

| Endpoint | WhatsApp | Telegram | MAX |
|---|---|---|---|
| `/sendMessage` | ✅ | ✅ | ✅ |
| `/checkAccount` (есть ли регистрация) | ✅ полный | ⚠️ ограничен — без addContact знает не всех | ⚠️ ограничен |
| `/addContact` (добавить номер в адресную книгу инстанса) | ✅ работает | ❌ **404 Not Found** | ❌ **404 Not Found** |
| `/getContacts` (получить адресную книгу) | ✅ | ✅ читает | ✅ читает |

**Что это значит для виджета «написать первым»:**

- В **WhatsApp** — индикация «номер в WA / не в WA» работает корректно.
- В **Telegram** через Green API — `checkAccount` иногда возвращает «не
  знаю», даже если у клиента есть TG. Поэтому в виджете для TG индикатор
  менее надёжный.
- В **MAX** — то же самое.

**Workaround сейчас**: вручную добавлять номера через телефон, где запущен
Green API instance (физическое устройство). Не масштабируется для тысяч
контактов из B24.

**Запрос зафиксирован у Green API** (отслеживание — задача #64):
- TG: https://github.com/green-api/telegram-issues/issues/21
- MAX: https://github.com/green-api/max-issues/issues/29

ETA нет. Готовы тестировать на инстансах 4100621194 (TG) и 3100621187 (MAX)
когда выкатят. После реализации:
1. Прогнать все B24-контакты через addContact (одноразовая миграция)
2. В Bitrix24Service.createInstance добавить hook «import contacts after
   instance setup»
