# WhatsApp / MAX / Telegram — техническая документация

Как Social Connector обрабатывает каналы, идущие через **Green API**:
WhatsApp, MAX, Telegram. Документ — источник истины по этим трём каналам и
их различиям. Меняешь код — правь и этот файл.

Общая документация по сервису — [`SOCIAL_CONNECTOR.md`](./SOCIAL_CONNECTOR.md).
Instagram — отдельный канал (i2crm, не Green API) — [`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md).

Последнее обновление: 2026-05-20.

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

- Самый простой: клиент = телефон. `chatId` = `<phone>@c.us`.
- Исходящие с мобильного WhatsApp (менеджер ответил в приложении) приходят
  как `outgoingAPIMessageReceived` → `handleOutgoingFromMobile` оставляет
  **timeline-комментарий** в карточке (открытую линию не создаёт).

### 5.2. MAX

- Клиент = внутренний chatId, телефона нет.
- Green API метод **CheckAccount** резолвит phone → chatId, **только если**
  номер есть в адресной книге MAX-аккаунта. `phoneNumber` принимается строкой.
- Кеш phone→chatId — таблица `MaxContact` в БД adapter.
- **Изображения приходят в формате webp** — Telegram принимает их через
  `send_photo` загруженными байтами (не по ссылке).

### 5.3. Telegram

- Клиент = внутренний chatId, телефона нет.
- **CheckAccount** на TG-shard'е: `phoneNumber` обязан быть **integer**
  (строка → `Validation failed`).
- **AddContact возвращает 404 на TG-shard'е** — пополнить адресную книгу
  Telegram-аккаунта через API нельзя. Для холодных номеров остаётся резолв
  по `@username`.
- Резолв по username: Green API принимает `chatId` в формате `<username>@c.us`
  в `sendMessage`.
- **КРИТИЧНО: silent-fail `@c.us` для chatId.** Если в `sendMessage` передать
  `chatId: "<numeric_id>@c.us"` — Green API возвращает `idMessage` (как будто
  успех), но сообщение **не доставляется**. Без суффикса (`chatId: "<id>"`) —
  доставляется. Поэтому в `bitrix24.transformer.ts` для chat.id с префиксом
  `sc_` формируется chatId БЕЗ `@c.us`. Префикс `wa_*` остаётся `<phone>@c.us`.
- Исходящие с устройства (менеджер набрал в Telegram-приложении нашего
  аккаунта) приходят как `outgoingMessageReceived` → `handleOutgoingFromDevice`
  зеркалит в открытую линию как `is_self_message` (см. §6).

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

## 9. Грабли (сводка)

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
| `src/widget/widget.controller.ts` | виджет «написать первым», `mirrorToBitrix` |
| wa-tg-bridge `bridge.py` | приём webhook'ов, TG-зеркало, форвард |
| wa-tg-bridge `greenapi.py` | Green API клиент, настройки инстансов |
