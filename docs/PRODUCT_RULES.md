# Продуктовые правила — Social Connector + B24

Single source of truth для **продуктовых** решений Дмитрия по работе
платформы. Раньше эти правила существовали устно — сессии повторяли
один и тот же вопрос «а почему так?» и не находили ответа. Этот файл
закрывает gap.

**Перед любой работой** с настройками open-lines / коннекторов / лид-flow
— читать сюда.

Если правило не покрыто — спросить Дмитрия, добавить в этот файл
(с датой и контекстом), и только потом применять. Не догадываться.

Последнее обновление: 2026-05-26.

---

## 1. CRM-flow: лиды, сделки, контакты

### 1.1. Создание лидов при обращении клиента

**Фиксировано 26.05.2026** (раньше повторяли в каждой сессии устно).

Когда клиент пишет в **любой** open-line канал (WA / MAX / TG / IG):

| Состояние контакта в B24 | Что делает open-line |
|---|---|
| Есть **открытая сделка** | Переписка идёт в неё. **Лид НЕ создавать** |
| Есть **открытый лид** (нет сделки) | Добавить переписку в текущий лид. **Новый лид НЕ создавать** |
| Нет ни открытой сделки, ни открытого лида | Создать **новый лид** для квалификации |

**Why**: дубли «Повторный лид» для одного клиента ломали CRM-метрики
и плодили шум для операторов. Один лид на одно намерение.

**Настройка B24** для каждой open-line (через `imopenlines.config.update`):

```
PARAMS[CRM]              = Y
PARAMS[CRM_CREATE]       = lead
PARAMS[CRM_CREATE_SECOND] = N          # ВАЖНО: строго "N", не "0"
PARAMS[CRM_FORWARD]      = Y
```

**Подвох:** `CRM_CREATE_SECOND="0"` (строка) B24 трактует как **truthy**.
Использовать строго `"N"`.

**При создании новой линии** обязательно применить эту настройку сразу:

```bash
WH=$(cat /home/dv/.secrets/backfill-webhook.url)
curl -sG "${WH}imopenlines.config.update.json" \
  --data-urlencode "CONFIG_ID=<новая_линия>" \
  --data-urlencode "PARAMS[CRM_CREATE_SECOND]=N" \
  --data-urlencode "PARAMS[CRM_FORWARD]=Y"
```

См. `decisions/2026-05-26-crm-create-second-disabled.md`.

### 1.2. Дубли клиентов и слияние UUID

Customer-360 (customer-service) хранит **один UUID на клиента**
независимо от каналов. Если у клиента **несколько UUID** в БД
(например, sole-TG UUID и B24-side UUID) — это дубль.

**Сигналы для merge:**
- Общий `phone`
- Общий `email`
- B24 `lead.UF_CRM_TG_CHAT_ID` совпадает с `tg_user` alias другого UUID
- B24 `lead.UF_CRM_IG_CHAT_ID` совпадает с `ig_client` alias
- AI-evaluator высокой confidence (см. merge_engine)

**Merge engine** работает в фоне (cron */30) и предлагает кандидатов
в KBD-Admin TG-чате. Дмитрий вручную approve/reject в чате.

**Backfill** разовой операцией раз в неделю — для случаев когда
merge engine не нашёл (новые правила matching).

См. memory `[[merge_rule_tg_chat_id]]`.

---

## 2. Каналы

### 2.1. Instagram Direct vs Comments

**Direct** (line 18) — личные сообщения. Один клиент → одна сессия →
один лид (со-conversion в сделку).

**Comments** (line 22) — комментарии под постами. A2-формат:
**один пост = одна сессия = один лид** (см. `INSTAGRAM_FLOW.md`).
Если клиент комментирует 5 разных постов → 5 разных лидов, но все
привязаны к одному контакту.

`chat.id` форматы:
- Direct: `i2crm_ig_<client_id>`
- Comment A2: `i2crm_ig_<client_id>_c<media_id>_<account_id>`

### 2.2. WhatsApp / MAX / Telegram (Green API)

Один номер/чат = одна сессия = один лид (стандарт). Inbound через
Green API webhook → adapter → imconnector.send.messages → B24 создаёт
лид (или продолжает существующий, см. §1.1).

Telegram-бот @begovoy_bot — переведён на Social Connector (см.
memory `[[telegram_bot_connector]]`).

### 2.3. Связь каналов через контакт

UF_CRM_*_CHAT_ID на контакте — клей между каналами:
- `UF_CRM_TG_CHAT_ID` — TG chat_id (для Green API TG + @begovoy_bot)
- `UF_CRM_MAX_CHAT_ID` — MAX chat_id
- `UF_CRM_IG_CHAT_ID` — IG client_id (i2crm)
- `UF_CRM_PB_CUSTOMER_UUID` — UUID из customer-service

Это позволяет находить **тот же контакт** даже если клиент пишет с
другого канала (по phone был известен, потом написал с того же IG).

---

## 3. Операторы

### 3.1. Auto-take при первом ответе

Когда оператор отвечает в open-line чате впервые в сессии — B24
автоматически:
- Меняет статус сессии «в работе у <ФИО>»
- Снимает badge «Не отвечено» в виджете
- Запускает SLA-таймер «время ответа»

См. виджет MAX (`#widget47` series).

### 3.2. Внутренняя заметка `/nnn`

Префикс `/nnn ` в начале сообщения в TG-зеркале / B24-чате:
- Создаёт timeline-comment в карточке лида (видно в CRM, не в чате
  с клиентом)
- Не отправляется в Green API / i2crm
- Используется для меток типа «PVH», «ждёт перезвон», «сложный case»

### 3.3. Reply на конкретный коммент IG

В B24 → меню «˅» на комменте клиента → **«Цитировать сообщение»** →
писать ответ. Adapter парсит BB-цитату → находит `IgInboundB24Link`
по `commentText LIKE «…»` → отвечает на конкретный `comment_id+media_id`.

`«Ответить»` (правое меню → стрелка) **не работает** — B24 не передаёт
`parent_message_id` в outgoing webhook. Только «Цитировать».

См. memory `[[ig_operator_reply_cheatsheet]]`.

### 3.4. Префикс `!` для переключения коммент → Direct

Префикс `!` (с пробелом или без) в IG-Comment-чате → ответ уйдёт
клиенту в **Direct** (приватно), не публичным комментом. Adapter
переключает `type=direct`, плюс создаёт зеркальную Direct open-line.

---

## 4. Customer-360 и аналитика

### 4.1. UUID — стабильный идентификатор клиента

Customer-service хранит мастер-UUID. Aliases (phone, ig_client,
tg_user, b24_lead, b24_contact, b24_deal) ссылаются на uuid. При
merge все aliases объединяются под primary UUID.

### 4.2. Источник имени клиента для UI

Не `customer_aliases` (там только value-идентификаторы), а
**`bitrix1begovoy.contacts.name + last_name`** в CH (mp-analytics
sync, ~15 мин лаг). См. memory `[[customer_360_name_source]]`.

### 4.3. Технические уведомления — только в B24

В TG-зеркало для IG-Comments **НЕ отправлять** информационные
сообщения «Начат новый диалог», «Создан лид», «Переданы доп. данные».
Они остаются в B24 + в `customer_events` (видно через
`dashboard.9wb.ru/customer/<uuid>`). В TG только сообщения клиента
и оператора.

Также наши служебные SYSTEM=Y от adapter («🖼 Пост клиента»,
«📤 Ответил из TG») — не зеркалить в TG.

См. sha `9944369` в wa-tg-bridge (фильтр в `_format_message`).

---

## 5. Что добавить дальше

Это **первая версия**. Дописываем сюда **каждый раз** когда возникает
повторяющийся вопрос или появляется новая договорённость:

- [ ] SLA-метрики: пороги «ждёт ответа» — какие времена badge/alert
- [ ] Blacklist логика и UI
- [ ] Когда удалять / архивировать клиента
- [ ] Что в B24 timeline-комменте от AI-консультанта
- [ ] Правила для multi-instance каналов
- [ ] Что считается «лидом готовым к сделке»

---

## Связано

- `decisions/` — ADR с обоснованием каждого решения
- `ARCHITECTURE.md` — техническая структура (ссылается на этот файл)
- `INSTAGRAM_FLOW.md` — детали IG-flow
- `OPERATOR_GUIDE.md` — операторская UX-инструкция
- memory `[[b24_lead_creation_rules]]`, `[[merge_rule_tg_chat_id]]`,
  `[[ig_operator_reply_cheatsheet]]`
