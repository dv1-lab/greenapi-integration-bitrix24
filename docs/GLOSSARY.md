# Глоссарий — Social Connector + B24

Точное значение терминов **в этом проекте**. Когда в чате/код-ревью
кто-то пишет «лид», «канал», «коннектор» — это значит **строго то что
тут написано**. Не догадываться, проверять.

Последнее обновление: 2026-05-26.

---

## CRM-сущности (B24)

**Лид** — потенциальный клиент в B24. Создаётся при **первом обращении**
(см. `PRODUCT_RULES.md §1.1`). Имеет статус (NEW/IN_PROCESS/CONVERTED/JUNK).
Конвертируется в **Контакт + Сделку** при квалификации. Не имеет суммы,
не считается продажей.

**Контакт** — клиент (физлицо/компания) в B24 CRM. Имеет phone, email,
UF_CRM_*_CHAT_ID (телеграм/инста/макс chat_id). Привязан к 0+ лидам и
0+ сделкам. Один человек = **один** контакт (через merge).

**Сделка** — продажа конкретного товара/услуги. Имеет CONTACT_ID, сумму,
стадию (NEW → ... → WON/LOSE). Может содержать несколько товаров.

**Сделка открытая** — стадия НЕ из {`WON`, `LOSE`}. То есть пока ещё «в работе».

**Открытый лид** — статус НЕ из {`CONVERTED`, `JUNK`}. Ещё не сконвертирован
и не отброшен.

**Повторный лид** — лид у уже известного контакта (когда настройка
`CRM_CREATE_SECOND` включена). У нас **отключено** — см. ADR от 26.05.

---

## Open-lines (открытые линии B24)

**Open-line / Открытая линия** — настройка B24 для обработки внешних
каналов (мессенджеры). Каждая линия имеет:
- `CONFIG_ID` (число — у нас 18, 22, 148, 174, 178, 182, 204)
- `CONNECTOR` (`i2crm` / `social_connector` / `wa_tg_bridge`)
- Привязку к группе операторов (очередь)
- CRM-настройки (`CRM_CREATE`, `CRM_FORWARD` — см. PRODUCT_RULES §1.1)

**Сессия (session)** — конкретный диалог в open-line. Имеет `session_id`,
`chat_id`, статус (open/closed/in-progress). Создаётся когда клиент пишет
впервые после закрытия предыдущей сессии. Активная сессия = «в работе»;
после 24ч без активности автоматически закрывается.

**Connector / Коннектор** — компонент в B24 который принимает webhook'и
с какого-то канала и кладёт сообщения в open-line. У нас:
- `i2crm` — стандартный платный (Instagram Direct + Comments через i2crm.ru)
- `social_connector` — наш собственный (WA / MAX / TG-Green API / TG-бот)
- `wa_tg_bridge` — наш bridge (отдельная регистрация для bridge events)

**Зеркало (Mirror)** — параллельное отображение open-line в TG-группе
для операторов. Не заменяет B24, дублирует UX. Мост — `wa-tg-bridge` (для
WA/MAX/TG/IG-Direct/IG-Comments) или встроенный `i2crm_tg_mirror`
сервис (раньше использовался, отключён 25.05).

**Pinned-сообщение в чате** — закреплённое внутри B24-чата или TG-темы.
В TG-зеркале это «Карточка клиента» (имя, телефон, ссылки на B24).

---

## Каналы

**Канал** — логический источник сообщений. Не путать с **коннектором**.
- `WA` (WhatsApp) — через Green API
- `TG` (Telegram через Green API shard или @begovoy_bot)
- `MAX` — мессенджер MAX (Россия)
- `IG-Direct` — Instagram личка через i2crm
- `IG-Comments` — Instagram комментарии под постами через i2crm

**Инстанс (Green API instance)** — конкретный номер/аккаунт в Green API.
У нас сейчас 5 инстансов (`1103487233` WA 84566, `1101948511` WA 79240778566,
`3100621187` MAX 79584983354, `4100621194` TG 79584983354, `4100624465` TG 79240778566).

**chat.id префикс** — формат идентификатора чата в B24 open-line. Должен
**совпадать** для incoming/outgoing того же клиента, иначе B24 заведёт
второго chat-user. Форматы:
- WA: `wa_<phone>` или `sc_<phone>` (зависит от коннектора)
- TG (Green API): `<chat_id>` без префикса
- MAX: `<chat_id>` без префикса
- TG-bot (наши): `tgbot_<chat>` / `tgsupport_<chat>`
- IG Direct: `i2crm_ig_<client_id>`
- IG Comment A2: `i2crm_ig_<client_id>_c<media_id>_<account_id>`

---

## Customer-360

**Customer-360 / customer-service** — собственная мастер-БД клиентов
(NestJS + Postgres на `/home/dv/customer-service/`). Хранит **UUID**
клиента + **aliases**. Master для всех платформ (B24, MoySklad, dv-dashboard).

**UUID** — стабильный 36-символьный идентификатор клиента. Не меняется
никогда (кроме merge). Используется во всех intern-системах для
ссылки на клиента.

**Alias** — идентификатор-ключ привязанный к UUID. Типы:
- `phone` — `+79991234567`
- `email`
- `ig_client` — числовой Instagram user_id
- `ig_username` — `@nick` (косметический, ненадёжный)
- `tg_user` — числовой TG chat_id
- `max_chat` — MAX chat_id
- `wa_chat` — WA chat_id (`<phone>@c.us`)
- `b24_lead` — Bitrix24 lead.ID
- `b24_contact` — Bitrix24 contact.ID
- `b24_deal` — Bitrix24 deal.ID

Один UUID может иметь много aliases (один клиент = один UUID, несколько
каналов).

**Merge / Слияние UUID** — операция «два UUID = один клиент → объединить».
Все aliases source-UUID переезжают на target-UUID, source помечается
`merged_into=target`. Делается через `POST /customers/merge` или
автоматически через merge engine (cron, AI-evaluator + правила).

**Merge suggestion** — кандидат для слияния, найденный merge engine.
Approve/reject вручную в KBD-Admin TG-чате.

**KBD-лента** — Telegram-супергруппа «Клиенты 1Б» где каждый клиент
имеет свою форум-тему. Customer-360 кросс-канальная лента (видно все
события клиента вне зависимости от канала).

**customer_events** — таблица в ClickHouse `customer360`. Event log
по UUID (message_in/out, lead_added, deal_won, call_in/out, ...).
Главный источник аналитики Customer-360.

**event_tags** — теги категорий событий (для Support KB classifier).
Auto-классификация cron'ом каждые 15 мин.

**Support cases** — структурированные кейсы поддержки извлечённые из
переписки (AI-evaluator). Используются для RAG-assistant операторам.

---

## Adapter и сервисы

**Adapter / Social Connector adapter** — главный сервис в
`/home/dv/greenapi-b24/`, NestJS. Принимает webhook'и от Green API /
i2crm / B24, отправляет outgoing, ведёт MySQL (Prisma). Публичный
URL `https://social.9wb.ru`.

**Bridge / wa-tg-bridge** — Python (aiogram) сервис в
`/home/dv/wa-tg-bridge/`. Зеркалит open-lines в TG-супергруппы
операторов. Команды `/nnn`, `/take`, `/rename` etc.

**dv-dashboard** — Next.js BI на `dashboard.9wb.ru`. Customer-360 UI,
аналитика, /customer-360/outgoing-pending.

**customer-service** — NestJS+Postgres БД клиентов (см. Customer-360).
Port `127.0.0.1:3002`, REST API.

---

## Команды операторов

**`/nnn <текст>`** — внутренняя заметка. Не уходит клиенту, создаёт
timeline-comment в B24-лиде. Видно операторам в TG-зеркале и B24.

**`/n <phone>`** — открыть/создать чат с клиентом по номеру (выводит
карточку клиента).

**`/r <имя>`** — переименовать тему клиента в TG.

**`/t`** — take, взять чат в работу.

**`/f`** — free, освободить чат (отдать в очередь).

**`/d`** (reply) — удалить сообщение в TG и WhatsApp (через reply).

**`/bl`** — blacklist, пометить клиента, переместить в Blacklist-топик.

**`/unbl`** — снять blacklist.

**`/last`** — аудит последних исходящих (admin only).

**`!` префикс** в IG-Comment-чате → ответ уйдёт клиенту в Direct
(приватно), не публичным комментом. См. `ig_operator_reply_cheatsheet`.

**«Цитировать»** в B24 → BB-цитата → adapter парсит → reply на конкретный
коммент IG.

---

## Технические термины

**event.bind** — механизм B24 для подписки на события (`ONOPENLINEMESSAGEADD`,
`ONIMCONNECTORMESSAGEADD`). Bitrix POST'ит на наш URL при наступлении.

**Webhook** — Bitrix24 outgoing webhook (`/rest/<num>/<token>/`) для
адаптера. Раньше использовался, сейчас в основном через event.bind.

**OAuth-app в B24** — наш application с CLIENT_ID/SECRET. Permissions
`crm,im,imopenlines,user,...`. Bridge и adapter — каждый свой OAuth-app.

**imconnector.send.messages** — REST метод B24, отправить сообщение в
open-line через коннектор. Создаёт сессию если её нет.

**im.message.add** — REST B24, отправить сообщение в чат (B24 internal,
не открытая линия). Используется для зеркал, system-сообщений.

**Bitrix24 open-line connector** — наш `social_connector` или
`wa_tg_bridge` зарегистрирован через `imconnector.register` с
PLACEMENT_HANDLER (URL обработчика).

**i2crm Public API** — REST `https://app.i2crm.ru/api_v1/target/feedback`
для отправки в IG Direct/Comments. Аутентификация через
`I2CRM_TARGET_KEY_PUBLICAPI`.

**Green API** — `https://api.green-api.com` (multi-instance), отправка
в WA/MAX/TG-shard. Каждый инстанс свой `idInstance` + `apiTokenInstance`.

---

## A2 формат (Instagram Comments)

**A2** — наша архитектура Instagram-комментариев с 23.05.2026:
**один пост = одна сессия = один лид** (раньше: один клиент = одна сессия
независимо от поста).

- chat.id формат: `i2crm_ig_<client_id>_c<media_id>_<account_id>`
- В одном B24-контакте может быть **много** A2-лидов (по числу постов
  под которыми клиент комментил)
- UI: каждый лид имеет привязку к конкретному посту через
  `UF_CRM_IG_POST_URL`

См. `INSTAGRAM_FLOW.md §A2`.

---

## Связано

- `PRODUCT_RULES.md` — правила использования терминов
- `ARCHITECTURE.md` — где какие сервисы
- `decisions/` — ADR с обоснованием решений
- `INSTAGRAM_FLOW.md` — детали IG-flow
- `OPERATOR_GUIDE.md` — UX для операторов
