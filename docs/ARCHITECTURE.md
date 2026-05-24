# Архитектура — как всё устроено и где границы

Документ верхнего уровня: какие у нас сервисы, кто для чего, как они
взаимодействуют между собой и с внешними системами. Читать первым.

Детали — в [`SOCIAL_CONNECTOR.md`](./SOCIAL_CONNECTOR.md),
[`GREENAPI_CHANNELS.md`](./GREENAPI_CHANNELS.md),
[`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md),
[`CUSTOMER360.md`](./CUSTOMER360.md),
[`TASK_TRACKER.md`](./TASK_TRACKER.md),
[`TELEGRAM_BOT_FLOW.md`](./TELEGRAM_BOT_FLOW.md).

Последнее обновление: 2026-05-23 (вечер: tg-bot multi-instance + поддержка
+ IG A2 + reply + обратный путь зеркало→бот).

---

## 1. Главное в двух абзацах

У нас **не один сервис, а четыре отдельных** + внешние системы. Все крутятся
на `my-server` (Стокгольм):

1. **adapter** (Social Connector) — ядро: связывает Bitrix24 с мессенджерами.
2. **wa-tg-bridge** — Telegram-«хаб»: приём вебхуков, зеркало переписки в
   Telegram, лента Customer-360.
3. **customer-service** (Customer-360) — мастер-база клиентов: единая
   идентификация человека по всем каналам.
4. **task-tracker** — трекер техзадач компании в Telegram (отдельный бот).
   К клиентскому коннектору отношения не имеет.

Они **разные кодовые базы и разные репозитории**, общаются по HTTP. Это важно
понимать: «Social Connector» в узком смысле — это только adapter; bridge,
customer-service и task-tracker — соседние самостоятельные сервисы.

---

## 2. Карта сервисов

| Сервис | Репозиторий | Стек | Это отдельный сервис? |
|---|---|---|---|
| **adapter** (Social Connector) | `dv1-lab/greenapi-integration-bitrix24` | NestJS + Prisma + MySQL | да — ядро |
| **wa-tg-bridge** | `dv1-lab/pervyi-begovoy` (`bots/wa-tg-bridge/`) | Python + aiogram + SQLite | да — отдельный |
| **customer-service** | `dv1-lab/pervyi-begovoy` (`services/customer-service/`) | NestJS + Prisma + Postgres | да — отдельный |
| **task-tracker** | `dv1-lab/task-tracker` | Python + aiogram + SQLite | да — отдельный, бот `@tasktrackerdv_bot` |
| dv-dashboard | `dv1-lab/dv-dashboard` | Next.js | да — веб-BI, к коннектору отношения почти не имеет |

Внешние системы (не наши): **Bitrix24** (облако), **Green API**
(шлюз к WhatsApp/MAX/Telegram), **i2crm** (шлюз к Instagram).

---

## 3. Схема взаимодействия

```
        WhatsApp / MAX / Telegram                    Instagram
                  │                                      │
                  ▼                                      ▼
            ┌───────────┐                          ┌──────────┐
            │  Green API│                          │  i2crm   │
            └─────┬─────┘                          └────┬─────┘
                  │ webhook                             │ webhook
                  ▼                                     │
        ┌──────────────────┐                            │
        │   wa-tg-bridge   │                            │
        │  (Telegram-хаб)  │                            │
        └───┬────┬─────┬───┘                            │
            │    │     │ forward                        │
   TG-зеркало│    │     └──────────────┐                │
   (супергр.)│    │ KBD-лента          ▼                ▼
            ▼    ▼            ┌────────────────────────────┐
   [группы   [группа         │          adapter            │
    каналов]  «Клиенты 1Б»]  │     (Social Connector)      │
                             └──────┬──────────────┬───────┘
                                    │ REST          │ HTTP
                                    ▼               ▼
                             ┌────────────┐  ┌──────────────────┐
                             │  Bitrix24  │  │ customer-service │
                             │   (CRM)    │  │  (Customer-360)  │
                             └────────────┘  └──────────────────┘
```

---

## 4. Что делает каждый сервис

### 4.1. adapter (Social Connector) — ядро

Связывает Bitrix24 и мессенджеры в обе стороны:
- **входящие**: webhook от мессенджера → создать сообщение в открытой линии
  B24 (`imconnector.send.messages`) → B24 заводит лид/диалог;
- **исходящие**: оператор пишет в B24 → отправить клиенту через Green API / i2crm;
- виджет «написать первым» в карточке клиента;
- ответ на Instagram-комментарий в Direct по пометке `!` в начале сообщения
  (работает из мобильного B24 и из Telegram-топика — см. `INSTAGRAM_FLOW.md` §6а);
- Telegram-боты (`@begovoy_bot` + `@begovoy1support_bot` и т.п.) подключены
  напрямую через Telegram Bot API (не Green API, не i2crm) — multi-instance:
  каждому свой токен / линия B24 / TG-супергруппа зеркала / userKey-префикс.
  Конфиги через `getTgBotConfig(name)`. См. `TELEGRAM_BOT_FLOW.md`;
- **Обратный путь зеркало → бот → клиент**: оператор отвечает в топике
  клиента в супергруппе TG-зеркала наших ботов; wa-tg-bridge ловит, шлёт
  на `/webhooks/internal/tg-bot-reply` adapter'а; adapter по `(groupId,
  topicId)` находит `chatId` и шлёт через нужный бот-инстанс;
- метка сайта 1begovoy.ru («— код обращения: ym-<id>» или «— с сайта 1begovoy.ru
  (ID <id>)») парсится из текста и пишется в `UF_CRM_NF_YM_CLIENT_ID` лида —
  работает на WhatsApp/Telegram/MAX (через Green API) и на Telegram-боте;
  для повторных обращений с уже открытым лидом метка тоже подхватывается;
- автоответ клиенту в нерабочее время (вне 10:00–19:00 МСК) на всех каналах;
- события CRM B24 (изменение лида/сделки) → в Customer-360;
- мониторинг и само-восстановление открытых линий.

Публичный адрес — `https://social.9wb.ru`. Здесь же зарегистрировано
B24-приложение «Social Connector V2».

### 4.2. wa-tg-bridge — Telegram-хаб

**Многозадачный сервис — 3 роли. Появился раньше adapter'а (изначально —
зеркало переписки в Telegram), поэтому исторически стоит «перед» adapter'ом.**
Что делает:

1. **Приём вебхуков Green API.** Green API-инстансы (WA/MAX/Telegram) шлют
   вебхуки **на bridge**, не на adapter. Bridge **форвардит их в adapter**
   (`/webhooks/green-api`). То есть bridge — входная точка для Green API.
2. **TG-зеркало переписки.** Каждый разговор с клиентом дублируется в
   Telegram-супергруппу канала (топик на чат) — чтобы команда видела
   переписку прямо в Telegram. См. §5.
3. **Лента Customer-360 («Клиенты 1Б»).** Bridge ведёт KBD-группу: топик на
   клиента, карточка + лента событий. См. §5 и [`CUSTOMER360.md`].

Плюс: `/nnn` в TG-зеркале → timeline-комментарий в лид B24; запись событий
в customer-service.

(До 2026-05-20 у bridge была 4-я роль — трекер техзадач; вынесен в
отдельный сервис `task-tracker`, см. §4.5.)

Instagram через bridge **не идёт** — i2crm шлёт вебхуки прямо в adapter.

### 4.3. customer-service — Customer-360

Мастер-база клиентов. Один человек пишет с WhatsApp, потом из Instagram,
потом звонит — это **один клиент**. customer-service хранит единый UUID и
таблицы alias'ов (phone / email / b24_lead / tg_user / ig_client …),
склеивает дубли. adapter и bridge обращаются к нему по HTTP, чтобы
определить/создать клиента. Лента «Клиенты 1Б» — это его «лицо» в Telegram.

### 4.4. task-tracker

Отдельный сервис (репо `dv1-lab/task-tracker`, бот `@tasktrackerdv_bot`) —
трекер техзадач компании в Telegram: группа «Тех. поддержка», задача = тема.
К клиентскому коннектору отношения не имеет, ни с чем не интегрирован.
Вынесен из wa-tg-bridge 2026-05-20. См. [`TASK_TRACKER.md`].

### 4.5. dv-dashboard

Отдельный веб-BI (`dashboard.9wb.ru`). С коннектором связан только тем, что
показывает страницу клиента `/customer/<uuid>` (из той же базы Customer-360).

---

## 5. Telegram-супергруппы — их ТРИ типа

Не путать — назначение разное:

| Тип группы | Сколько | Что в ней | Кто ведёт |
|---|---|---|---|
| **Зеркала каналов** (Max 3354, TG 3354, WA-группы, IG-группы) | по группе на инстанс | живая переписка с клиентами, топик на чат | bridge (`1begovoyconnectbot`), роль «TG-зеркало» |
| **«TG begovoy_bot»** (зеркало Telegram-бота) | одна | переписка `@begovoy_bot`, топик на клиента | **adapter** (`TgBotMirrorService`), бот `1begovoyconnectbot` |
| **«1Б Поддержка»** (зеркало бота поддержки) | одна | переписка `@begovoy1support_bot`, топик на клиента | **adapter** (`TgBotMirrorService`, инстанс support), бот `1begovoyconnectbot` |
| **«Клиенты 1Б»** (Customer-360 / KBD) | одна | топик на клиента: карточка + лента всех событий по нему | bridge (`1begovoyconnectbot`), роль «KBD-лента» |
| **«Тех. поддержка»** (трекер задач) | одна | внутренние техзадачи компании, топик на задачу | **сервис task-tracker** (`@tasktrackerdv_bot`) — отдельный бот |

Зеркала и «Клиенты 1Б» — про клиентов, ведёт bridge; «Тех. поддержка» —
внутренняя кухня, отдельный сервис task-tracker.

---

## 6. Как взаимодействуем с внешними системами

- **Bitrix24 (CRM)** — adapter через REST API (OAuth-приложение). Входящие →
  `imconnector.send.messages` (открытые линии). Исходящие — B24 шлёт событие
  `ONIMCONNECTORMESSAGEADD`. События CRM — webhook'и `ONCRM*`. Виджет —
  placement в карточке.
- **Green API** — шлюз к WhatsApp/MAX/Telegram. Вебхуки идут на **bridge**,
  отправка (`sendMessage`) — из adapter'а. По инстансу на номер.
- **i2crm** — шлюз к Instagram. Вебхуки идут **прямо в adapter**
  (`/webhooks/i2crm`), отправка — `POST /target/feedback`.
- **Telegram Bot API** — клиентские боты `@begovoy_bot` (линия 8) и
  `@begovoy1support_bot` (линия 206, техподдержка) подключены напрямую:
  вебхуки идут **прямо в adapter** (`/webhooks/telegram-bot/:name`), отправка —
  через `api.telegram.org` соответствующего инстанса. Не через Green API.
  Multi-instance: новый бот = новый блок env (`TG_BOT_<NAME>_*`) + новая
  open-line + активация коннектора. См. `TELEGRAM_BOT_FLOW.md`.

---

## 7. Где границы и что переплетено

**Чисто разделено:**
- adapter ↔ customer-service — разные сервисы, общаются по HTTP. Customer-360
  можно развивать/выносить независимо.
- task-tracker — вынесен в отдельный сервис 2026-05-20 (был 4-й ролью bridge).
- dv-dashboard — практически независим.

**Переплетено / на что обратить внимание:**
- **wa-tg-bridge** всё ещё совмещает 3 функции (вебхук-прокси, TG-зеркало,
  лента Customer-360). После выноса трекера задач это уже терпимо — все три
  про Telegram-сторону.
- **bridge стоит «перед» adapter'ом** как вебхук-прокси по историческим
  причинам (bridge появился раньше). Технически Green API мог бы слать вебхуки
  прямо в adapter — bridge в этой цепочке нужен только ради TG-зеркала.
- Хранилище размазано по базам: MySQL (adapter), SQLite (bridge), SQLite
  (task-tracker), Postgres (customer-service), ClickHouse (события). Карта —
  `SOCIAL_CONNECTOR.md` §4.

Это не «сломано» — работает.

---

## 7.5. Карточка клиента в pinned-сообщении

Каждый новый топик в TG-зеркале/IG-зеркале/TG-бот-зеркале начинается с
**pinned-карточки клиента** — pinned message с базовой инфой, чтобы
оператор сразу видел кто это и где о нём данные. Формат **унифицирован
на все каналы** (2026-05-24 второй проход).

> **Полная спецификация — обязательное чтение перед любой правкой mirror-
> кода**: [`CLIENT_CARD_STANDARD.md`](./CLIENT_CARD_STANDARD.md). История
> прошлых регрессий «фикс в одном канале, забыли в других» — в
> [`REGRESSIONS.md`](./REGRESSIONS.md).

### Заголовок форум-темы

```
<CHANNEL> · <SOURCE> · <CLIENT_NAME>
```

| Канал | CHANNEL | SOURCE | Пример |
|---|---|---|---|
| WhatsApp | `WA` | last4 shard | `WA · 3354 · Иван Петров` |
| Telegram (Green API shard) | `TG` | last4 shard | `TG · 3354 · Анна` |
| MAX | `MAX` | last4 shard | `MAX · 3354 · +79055994431` |
| TG-бот `@begovoy_bot` | `TG` | `begovoy` | `TG · begovoy · Olga K` |
| TG-бот `@begovoy1support_bot` | `TG` | `support` | `TG · support · Иван` |
| Instagram Direct | `IG-Direct` | `@<ig_username>` или `IG` | `IG-Direct · @anna_p · Анна П.` |
| Instagram Comments | `IG-Comments` | `пост #<media_id_short>` | `IG-Comments · пост #abc123 · Олег П.` |

`CLIENT_NAME` — резолв в порядке: ФИО из B24 → имя из мессенджера → phone/username
fallback. Лимит TG forum_topic name = 128 символов; обрезается CLIENT_NAME.

### Канонический формат pinned-карточки

```
📋 Карточка клиента (<канал>)

[фотография клиента]                     ← как media-сообщение, если есть

Имя: <ФИО клиента>                       ← пропускается если неизвестно
<Канал>: <идентификатор>
Линия: <человеческое название>
B24 лид: https://…/crm/lead/details/<id>/        ← если открытый
B24 контакт: https://…/crm/contact/details/<id>/  ← если есть
B24 сделка: https://…/crm/deal/details/<id>/     ← если открытая
Customer-360: <uuid>                     ← всегда (find-or-create)
Команды: /nnn <текст> — внутренняя заметка
```

### По каналам

| Канал | Где код | Идентификатор клиента | Группа-зеркало | Источник фото |
|---|---|---|---|---|
| WhatsApp | `wa-tg-bridge/src/wa_tg_bridge/bridge.py` (`_build_client_card`) | `WhatsApp: +<phone>` | per-инстанс (`TELEGRAM_GROUP_CHAT_ID*`) | Green API `GetAvatar` |
| MAX | то же | `MAX: <chat_id>` | per-инстанс | Green API `GetAvatar` |
| Telegram (Green API) | то же | `Telegram: <chat_id>` | per-инстанс | Green API `GetAvatar` |
| TG-боты | `tg-bot-mirror.service.ts` (`postClientCard` + `fetchClientAvatarFileId`) | `Telegram: @username (chat_id …)` | `TG_BOT*_MIRROR_GROUP_ID` | Bot API `getUserProfilePhotos` → `sendPhoto` |
| Instagram Direct/Comments | `i2crm-tg-mirror.service.ts` (`postIgPinnedCard`) | `Instagram Direct: @<username>` или `client_id <id>` | `I2CRM_TG_MIRROR_GROUP_ID_DIRECT` / `_COMMENT` | i2crm payload `profile_pic_url` |

**MAX-канал** ходит через Green API shard'ы префикса `3xxx`. Отдельных зеркал
MAX нет — он внутри wa-tg-bridge с собственным `MAX` channel-tag.

### Резолверы (lookup'ы для обогащения карточки)

- **ФИО клиента из B24**: adapter endpoint `POST /webhooks/internal/contact-name`
  (10-минутный кеш). Принимает `phone` / `tgChatId` / `maxChatId` / `igClientId`.
  Возвращает `{name, source, entityId, link, igUsername}`.
- **Лид + контакт B24 разом**: adapter endpoint `POST /webhooks/internal/b24-entities`.
  Используется `bridge.py` и `tg-bot-mirror.service.ts` для показа обеих ссылок
  («B24 лид» + «B24 контакт»).
- **Customer-360 UUID**: `POST {CUSTOMER_SERVICE_URL}/customers/find-or-create`
  с alias'ом по каналу (`phone`/`tg_user`/`max_chat`/`ig_client`). UUID
  кладётся в карточку как plain text (UI customer-360 пока нет).

Все обогащения — **best-effort**: если adapter/customer-service не ответил
за timeout (3-5 сек), соответствующее поле в карточке просто пропускается.
Базовое содержимое (имя из мессенджера + идентификатор + линия) всегда есть.

### Refresh запиненных карточек и заголовков тем (при изменении формата)

После изменения шаблона — старые pinned-сообщения и заголовки тем нужно
переписать. **Три fire-and-forget endpoint'а**, по одному на каждое из
трёх mirror-семейств:

| Endpoint | Сервис | Каналы | Параметры |
|---|---|---|---|
| `POST /internal/refresh-pinned-cards` | wa-tg-bridge | WA / TG-shard / MAX | `{delay_sec, limit, rename_topics?}` |
| `POST /webhooks/internal/refresh-tg-bot-topics` | adapter | TG-боты (begovoy / support) | `{botName?: "begovoy" \| "support"}` |
| `POST /webhooks/internal/refresh-ig-topics` | adapter | IG Direct + Comments | `{}` |

Все три:
- Авторизация: `X-Hint-Secret: <BRIDGE_HINT_SECRET>`
- Параллельно переименовывают заголовки тем (`editForumTopic`) и обновляют
  pinned-карточки (`editMessageText` / `editMessageMedia`)
- Rate-limit: 1 op/1.5-2 сек между правками (TG Bot API flood control)
- Идемпотентны: повторный вызов даёт `skipped_same`, не ломает state
- Прогресс в логах:
  - bridge: `refresh-cards: updated=N renamed=M skipped=K errors=L`
  - adapter: `refresh-{tg-bot,ig}: progress N/M (renamed=… skipped=… errors=…)`
  - adapter финиш: `refresh-{tg-bot,ig}: finished total=N renamed=… skipped_same=… no_b24=… errors=…`

Один полный refresh (24 мая 2026): WA-bridge 143/143 переименовано,
TG-bot 8/8, IG 289 (3 renamed + 277 skipped_same + 9 no_b24 + 0 errors).

---

## 8. Сохранность

Код — в GitHub (`dv1-lab/*`). Конфиги/секреты — `.env` на сервере (в git нет).
Базы — в бэкапе (`backup.sh` → restic → Я.Диск). Документация — этот каталог
`docs/`, в репозитории adapter'а.
