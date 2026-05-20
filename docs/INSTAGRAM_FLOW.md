# Instagram Direct + Comment — техническая документация

Как Social Connector обрабатывает Instagram. Документ — источник истины по
этому потоку: чтобы не реконструировать логику каждый раз. Если меняешь код —
правь и этот файл.

Последнее обновление: 2026-05-20.

---

## 1. Обзор

Instagram у 1begovoy.ru подключён **не напрямую через Meta**, а через сервис
**i2crm Public API**. Подключение у i2crm — **гибридное** (не классический
Meta Business). Практическое следствие: **ограничение Meta «24-часовое окно»
для Direct не действует** — можно инициировать Direct когда угодно, не
дожидаясь входящего от клиента.

Два канала, каждому — своя открытая линия B24:

| Канал | Открытая линия B24 | env с номером линии | i2crm `type` |
|---|---|---|---|
| Instagram **Direct** (личные сообщения) | **18** | `I2CRM_LINE_ID_IG_DIRECT` | `direct` |
| Instagram **Comment** (комментарии под постами) | **22** | `I2CRM_LINE_ID_IG_COMMENT` | `comment` |

На обеих линиях активирован коннектор `social_connector`; нативный коннектор
`i2crm` на них деактивирован — весь трафик идёт через наш adapter.

---

## 2. Конфигурация (env adapter'а, `/home/dv/greenapi-b24/.env`)

| Переменная | Назначение | Значение |
|---|---|---|
| `I2CRM_API_BASE` | базовый URL i2crm Public API | `https://app.i2crm.ru/api_v1` |
| `I2CRM_TARGET_KEY_PUBLICAPI` | ключ target'а для отправки (`?key=`) | секрет, в `.env` |
| `I2CRM_TARGET_ID_PUBLICAPI` | id target'а `publicapi` в i2crm | `60774` |
| `I2CRM_INSTAGRAM_ACCOUNT_ID` | **account_id** IG-бизнес-аккаунта | `8215238716` |
| `I2CRM_LINE_ID_IG_DIRECT` | открытая линия Direct | `18` |
| `I2CRM_LINE_ID_IG_COMMENT` | открытая линия Comment | `22` |

Важно: `source` в запросах к i2crm — это **`account_id`** (`8215238716`),
**не** внутренний `source.id` i2crm (14713/14818). С внутренним id API
отвечает «Нет активного канала для написания ответов в Директ».

---

## 3. Идентификаторы клиента

- **`client_id`** — стабильный числовой Instagram user_id. Главный
  идентификатор. Не меняется.
- **`username`** — @ник в Instagram. Может меняться, ненадёжен. Используется
  только косметически и для cold-start (см. §6б).
- **`chat.id` в B24** = `i2crm_ig_<client_id>` — так adapter формирует
  идентификатор chat-user'а в imconnector. Должен быть одинаков для входящих
  и исходящих, иначе B24 заведёт дубль лида.
- **UF-поля на лиде/контакте/сделке B24:**
  - `UF_CRM_IG_CHAT_ID` — `client_id` (primary, для дедупликации и резолва).
  - `UF_CRM_IG_USERNAME` — @username (косметика).
  Заполняются автоматически: `handleI2crmIncoming` при входящих,
  `backfillNewDirectLead` (widget) — при исходящих.

---

## 4. Входящий поток (клиент → B24)

```
Клиент пишет в Direct / комментирует пост
        │
        ▼
i2crm  ──webhook──►  POST https://social.9wb.ru/webhooks/i2crm
        │            (webhooks.controller.ts, @Post("i2crm"))
        ▼
Bitrix24Service.handleI2crmIncoming
        │  определяет канал (instdir → Direct/18, instcom → Comment/22)
        │  client_id, username, текст, media
        ▼
imconnector.send.messages в линию 18 или 22
   chat.id = i2crm_ig_<client_id>
        ▼
B24 создаёт сессию открытой линии + лид (CRM_CREATE=lead)
        │
        ├─► backfill UF_CRM_IG_CHAT_ID / UF_CRM_IG_USERNAME
        └─► зеркало в TG-группу insta-comments (I2crmTgMirrorService)
```

Формат incoming-webhook от i2crm (эмпирически, Instagram):
```
{ message_id, channel: "instdir"|"instcom", incoming, account_id, account_name,
  client_id, phone_number (обычно null), client_username, client_name,
  datetime, external_id, text, type, caption, thumb, media_id, quoted_message }
```
i2crm, в отличие от Green API, отдаёт `client_username` сразу.

Профилактика: каждый incoming-webhook журналируется в таблицу `I2crmEventLog`
(`status='pending'`). Если B24 заблокирован — после восстановления endpoint
`/webhooks/internal/i2crm-replay` доставляет pending'ы.

---

## 5. Открытые линии 18 и 22 — настройка в B24

Обе линии: `CONNECTOR=social_connector` активирован, `CRM_CREATE=lead`,
`CRM_CHAT_TRACKER=Y`.

`CRM_CHAT_TRACKER=Y` — ключевой момент: при старте новой сессии B24
**подвязывает её к уже открытому лиду/сделке того же клиента**, а не плодит
новый лид. Именно благодаря этому Direct-сессия садится на существующий
Comment-лид (см. §7).

---

## 6. Исходящий поток (B24 → клиент) — ДВА пути

### 6а. Оператор пишет в чате открытой линии B24

```
Оператор печатает в чате открытой линии (18 или 22)
        ▼
B24 шлёт событие ONIMCONNECTORMESSAGEADD
        ▼
Bitrix24Service.handleI2crmOutgoing(webhook, lineNumber)
        │  type определяется ЛИНИЕЙ:
        │    lineNumber === 18 → type:"direct"
        │    lineNumber === 22 → type:"comment"
        │  client_id = из chat.id (i2crm_ig_<client_id>)
        ▼
POST {I2CRM_API_BASE}/target/feedback?key=<TARGET_KEY>
        ▼
i2crm доставляет клиенту
```

То есть: ответ из чата **Comment-линии (22)** уйдёт **комментарием** под
постом. Чтобы написать в Direct — нужен путь 6б либо чат Direct-линии (18).

Pre-flight: Instagram Direct ограничен **1000 символами**. При превышении
adapter заранее шлёт системное сообщение в чат открытой линии и не отправляет.

### 6б. Виджет «написать первым» → Social Connector → Instagram Direct

Это основной сценарий «менеджер инициирует Direct из карточки лида».

```
Менеджер в карточке лида → кнопка «Social Connector» → выбирает
   «Instagram Direct» → вводит текст → «Отправить»
        ▼
POST /widget/send  (widget.controller.ts)
   idInstance = "i2crm:<accountId>"  (виртуальный инстанс, не Green API)
        ▼
WidgetController.sendInstagramDirect({ clientId, text, authId, domain, username })
        │
        │ 1) Резолв идентификатора (см. ниже)
        │ 2) POST i2crm /target/feedback  type:"direct"
        │ 3) mirrorToBitrix → imconnector.send.messages в линию 18
        ▼
B24 создаёт Direct-сессию открытой линии 18 и (через CRM_CHAT_TRACKER)
подвязывает её к уже открытому лиду клиента
        ▼
backfillNewDirectLead → проставляет UF_CRM_IG_CHAT_ID / UF_CRM_IG_USERNAME
```

**Резолв идентификатора в `sendInstagramDirect`:**
1. Если оператор ввёл числовой `client_id` — используем его напрямую.
2. Если ввёл `@username` — пытаемся найти `client_id` в B24: `crm.lead.list`
   по `UF_CRM_IG_USERNAME`. Если у клиента был входящий — `UF_CRM_IG_CHAT_ID`
   уже записан, берём оттуда.
3. Если `client_id` так и не нашёлся — **cold-start**: шлём в i2crm по
   `client_username`. У i2crm нет публичного endpoint resolve username →
   client_id, поэтому это единственный вариант для первого касания. Когда
   клиент ответит — incoming webhook принесёт `client_id`, и он осядет в UF;
   следующие отправки пойдут уже по числовому id.

---

## 7. Главный кейс: «ответить Direct из Comment-лида»

Клиент оставил комментарий под постом → B24 завёл **Instagram Comment лид**
(линия 22). Менеджер открывает этот лид, жмёт Social Connector → Instagram
Direct → пишет сообщение.

**Ожидаемое поведение:**
1. Сообщение уходит клиенту в Direct (через i2crm).
2. В этом же лиде появляется **вторая открытая линия — Direct-диалог**
   (сессия линии 18). B24 подвязывает её к тому же лиду через
   `CRM_CHAT_TRACKER=Y`. Отдельный лид-дубль не создаётся.

Реализация: `sendInstagramDirect` **всегда** вызывает `mirrorToBitrix`
(imconnector.send.messages в линию 18). Никаких проверок «есть ли уже лид» —
B24 сам разруливает привязку.

---

## 8. Регрессия 21a2605e (18.05.2026) — НЕ повторять

**Симптом:** «не создаются линии директ». Менеджер отвечает Direct из
Comment-лида — сообщение клиенту доходит, но в B24 Direct-диалог не
появляется, только timeline-комментарий «📩 Отправлено в Instagram Direct».

**Причина:** коммит `21a2605e` «widget: не плодить лиды если у клиента уже
есть открытый» добавил в `sendInstagramDirect` проверку: если у клиента есть
открытый лид (`crm.lead.list` по `UF_CRM_IG_CHAT_ID`, `!STATUS_SEMANTIC_ID=F`)
— **не** вызывать `imconnector.send.messages`, а только добавить
`crm.timeline.comment`. Предполагалось, что imconnector создал бы лишний
лид-дубль.

**Почему это было неверно:** дубль и так не возникал — B24 через
`CRM_CHAT_TRACKER=Y` подвязывал Direct-сессию к существующему лиду. То есть
«защита» боролась с несуществующей проблемой, а побочно сломала создание
Direct-линии для **всех**, кто пришёл с комментария (а это типовой путь).

**Исправление (откат, 2026-05-20, коммит после 7fb6b16):** убрали блок
`openLeadId` и ветку timeline-comment. `sendInstagramDirect` снова всегда
зеркалит через `mirrorToBitrix`.

**Вывод на будущее:** не добавлять «оптимизацию против дублей» в этот путь
без фактического воспроизведения дубля. B24 сам управляет привязкой сессий.

---

## 9. Грабли (известные тонкости)

- **`domain` в запросе к i2crm** = `"instagram"`. Не `"instagram-direct"`.
  Direct/Comment разделяются полем **`type`** (`"direct"` / `"comment"`).
- **`source`** = `account_id` (`8215238716`), не внутренний source.id i2crm.
- `source`, `client`, `message_id` в payload — **строки**.
- i2crm может вернуть **HTTP 200 с `{"error": "...", "data": {...}}`** —
  обязательно проверять `result.error` truthy, иначе пометишь доставку
  успешной, а клиент ничего не получил. В коде стоит `validateStatus: () => true`.
- **Direct лимит 1000 символов** — pre-flight проверка в `handleI2crmOutgoing`.
- **chat.id** для исходящих и входящих должен совпадать (`i2crm_ig_<client_id>`),
  иначе B24 видит разных chat-user'ов → дубль лида.
- `name`/`displayName` в payload — **без пробелов**: B24 режет по пробелу
  (NAME / LAST_NAME). Для IG передаём `username`, при его отсутствии —
  fallback `IG <client_id>` (без технического префикса `i2crm_ig_`).
- Старый target i2crm `id=6742 "bitrix"` (Wappi-наследие) — **не трогать**,
  не активен.

---

## 10. Карта кода

| Где | Что |
|---|---|
| `src/webhooks/webhooks.controller.ts` `@Post("i2crm")` | приём входящих webhook'ов i2crm |
| `Bitrix24Service.handleI2crmIncoming` | обработка входящего: i2crm → B24 линия 18/22 |
| `Bitrix24Service.handleI2crmOutgoing` | исходящее из чата открытой линии B24 → i2crm (путь 6а) |
| `WidgetController.send` (`/widget/send`) | роутинг; `idInstance="i2crm:*"` → `sendInstagramDirect` |
| `WidgetController.sendInstagramDirect` | виджет → Instagram Direct (путь 6б) |
| `WidgetController.mirrorToBitrix` | imconnector.send.messages — создание сессии открытой линии |
| `WidgetController.backfillNewDirectLead` | проставление UF_CRM_IG_* на лиде после Direct |
| `I2crmTgMirrorService` | зеркало IG-сообщений в TG-группу |
| модель `I2crmEventLog` (Prisma) | журнал входящих webhook'ов + replay |

---

## 11. Диагностика

Логи adapter'а на сервере:
```
docker logs source-adapter-1 --since 30m 2>&1 | grep -iE "i2crm|target/feedback|LINE.?:?.?18|LINE.?:?.?22"
```
Ключевые строки:
- `i2crm outgoing: POST .../target/feedback` + `domain/type/client` — что ушло.
- `i2crm outgoing OK` с `result.error:false` — доставлено.
- `Routing outbound to i2crm pipeline (line=NN)` — путь 6а, выбор линии.
- `[i2crm webhook] payload` — входящий webhook.

Проверка статуса линии в B24 (нужен OAuth-токен с scope `imconnector`):
```
imconnector.status CONNECTOR=social_connector LINE=18   (или 22)
→ должно быть CONFIGURED:true, STATUS:true
```
