# Архитектура — как всё устроено и где границы

Документ верхнего уровня: какие у нас сервисы, кто для чего, как они
взаимодействуют между собой и с внешними системами. Читать первым.

Детали — в [`SOCIAL_CONNECTOR.md`](./SOCIAL_CONNECTOR.md),
[`GREENAPI_CHANNELS.md`](./GREENAPI_CHANNELS.md),
[`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md),
[`CUSTOMER360.md`](./CUSTOMER360.md),
[`TASK_TRACKER.md`](./TASK_TRACKER.md),
[`TELEGRAM_BOT_FLOW.md`](./TELEGRAM_BOT_FLOW.md).

Последнее обновление: 2026-05-23.

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
- Telegram-бот `@begovoy_bot` подключён напрямую через Telegram Bot API
  (не Green API, не i2crm) — линия 8, своё зеркало; см. `TELEGRAM_BOT_FLOW.md`;
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
- **Telegram Bot API** — клиентский бот `@begovoy_bot` подключён напрямую:
  вебхуки идут **прямо в adapter** (`/webhooks/telegram-bot`), отправка — через
  `api.telegram.org`. Не через Green API. См. `TELEGRAM_BOT_FLOW.md`.

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

## 8. Сохранность

Код — в GitHub (`dv1-lab/*`). Конфиги/секреты — `.env` на сервере (в git нет).
Базы — в бэкапе (`backup.sh` → restic → Я.Диск). Документация — этот каталог
`docs/`, в репозитории adapter'а.
