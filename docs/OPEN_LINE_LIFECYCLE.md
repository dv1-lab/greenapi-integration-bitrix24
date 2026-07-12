# Open-Line lifecycle (Bitrix24 ↔ Social Connector)

> **Это обязательное чтение перед любой правкой `widget.controller.ts`,
> `bitrix24.service.ts` `handleI2crmIncoming/Outgoing` или `handleOutgoing*`.**
> Без этого фикс высокой вероятностью станет регрессией —
> см. [`REGRESSIONS.md`](./REGRESSIONS.md).

## 1. Что такое «сессия открытой линии» в B24

В Bitrix24 «открытая линия» (`imopenlines`) — это не просто канал, а **именованная
сущность session** с lifecycle:

| Состояние | Что значит | Видно оператору |
|---|---|---|
| **created** | первый incoming пришёл, B24 завёл session_id + lead | да, появляется в Контакт-центре |
| **active** | оператор пишет в чат | да, видна как «активный диалог» |
| **closed** | оператор нажал «Завершить», или таймаут 1ч после последнего incoming | нет, уходит в архив |
| **reopened** | клиент снова пишет после closed | создаётся **новая** session_id (не та же!) |

Session — это **не chat**. Chat живёт всегда (один на клиент-канал), session — это
«отрезок диалога». Один chat может иметь много sessions.

## 2. Когда сессия создаётся

| Action | Создаёт session? | Откуда |
|---|---|---|
| Клиент пишет первым (`incoming`) | **Да** | adapter `handleI2crmIncoming` / `handleOutgoing*` → `imconnector.send.messages` |
| Оператор пишет через виджет «написать первым» | **Да**, при `imconnector.send.messages` ниже | `widget.controller.ts mirrorToBitrix` |
| Оператор пишет с мобильного телефона | **Да**, mirror той же `imconnector.send.messages` | `handleOutgoingFromMobile` (только MAX/TG, WA — другой путь) |
| Timeline-comment в сделке/лиде | **Нет** | `crm.timeline.comment.add` — это только запись в CRM, не диалог |
| Оператор пишет через сам B24 в Контакт-центре | **Да**, B24 сам создаёт → webhook `ONIMCONNECTORMESSAGEADD` → `handleBitrix24Webhook` | B24 — adapter получает и шлёт через shard |

## 3. Почему «канал не подтянулся» после widget /send

Симптом: оператор открыл сделку → нажал «Социал Коннектор» → написал в MAX. В Bitrix
карточке справа **диалог не появился**. Клиент ответил — только тогда диалог
подтянулся.

### Возможные причины (по убыванию вероятности)

1. **chat.id префикс не совпадает с incoming**. Если widget шлёт `imconnector.send.messages`
   с `chat.id = "396522892"`, а incoming для того же клиента приходит как
   `chat.id = "tgbot_396522892"` или `"sc_396522892"` — B24 заводит **два разных
   chat-user'а** и **две разные sessions**. Оператор видит «отправлено», но это
   ушло в _другой_ диалог, который не привязан к карточке.
   - Где смотреть: `widget.controller.ts:362` (`mirrorKey` для MAX/TG)
     и `bitrix24.service.ts` `handleOutgoingFromDevice` / `handleI2crmIncoming`
     (там префиксы).
   - **Регрессия #47 (2026-05-24) скорее всего тут.**

2. **Линия не активирована на этом shard'е** (`imconnector.activate` не вызвана
   для (instance, line)). Виджет вызывает `imconnector.send.messages` —
   B24 принимает, шлёт response с `result: true`, но сообщение «зависает»,
   потому что connector неактивен.
   - Где смотреть: `b24-health-check.service.ts` — он раз в час проверяет/чинит,
     но в моменте может быть дыра.
   - Симптом: в логах adapter «status: OFFLINE» для (line, connector).

3. **`crm.message.send` использован вместо `imconnector.send.messages`**.
   Эти два метода делают разное: первый — без session, второй — с session.
   В прошлых регрессиях (`7fb6b16`, `21a2605e`) мы переключали и обратно.

4. **chatId для MAX содержит лишнее**. MAX shard в Green API использует chatId
   формата `<digits>` (без `@c.us`), а WA — с `@c.us`. Если widget по ошибке
   добавил `@c.us` для MAX → Green API не доставит, ответ 200 OK, диалога нет.
   - Где смотреть: `widget.controller.ts:341-343` (ветка `provider === "max"`).

### 3.1 Write-first из холодного лида — привязка к placement entity (sha `b9e56a9`, 2026-07-12)

Раньше widget `/widget/send` не знал, из какой карточки (lead/deal) его открыли —
`ensureOpenLeadForPhone` матчил только КОНТАКТЫ, и холодный лид без контакта
плодил несвязанный лид-дубль от imconnector.

Сейчас: фронт виджета шлёт `entityType`+`entityId` из placement (карточка, из
которой открыли «написать первым»). `writeChatIdToEntity` пишет резолвнутый
chatId в `UF_CRM_{TG|MAX|IG}_CHAT_ID` исходной сущности. `placementEntity`
становится приоритетным `openEntity` для `backfillSendLead` — он закрывает
imconnector-дубль как «[Дубликат → lead N]» и подтягивает phone/имя/timeline
в исходный лид. Работает без контакта.

**ОТКРЫТО:** это ЧАСТИЧНОЕ решение — сам open-line чат остаётся на
лиде-дубле, а не переезжает в исходный лид (перенос `IMOPENLINES_SESSION` на
исходную сущность — прямых REST-методов в B24 нет, требует research). См.
[`REGRESSIONS.md` 2026-07-12](./REGRESSIONS.md).

## 4. Где каждый канал создаёт session

| Канал | chat.id формат incoming | chat.id формат outgoing-widget | Файл |
|---|---|---|---|
| **WA** | `wa_<phone>` | должен быть тот же `wa_<phone>` | `widget.controller.ts mirrorToBitrix` provider=whatsapp |
| **TG (через Green API)** | `<chat_id>` (digits, без `@`) | должен быть тот же | provider=telegram |
| **MAX** | `<chat_id>` (digits, без `@`) | должен быть тот же | provider=max |
| **TG-bot (наши боты)** | `tgbot_<chat_id>` / `tgsupport_<chat_id>` | **не виджет, отдельный путь** через `handleTelegramBotOutgoing` | `tg-bot-mirror.service.ts` |
| **IG (i2crm)** | `i2crm_ig_<client_id>` (Direct) / `i2crm_ig_<client>_c<media>` (Comment) | тот же | `widget.sendInstagramDirect` |

**Правило**: если в логах видишь «два chat-user для одного клиента» — 100% это
несовпадение префикса. Проверь обе стороны (incoming + widget outgoing).

## 5. Что НЕ делает widget /send (и это by design)

- **НЕ создаёт пустую session «на потом»**. B24 не даёт API создать session без
  message. Виджет шлёт message → session создаётся в момент send.
- **НЕ открывает chat у оператора, если message доставлен**. Оператор может не
  видеть chat в правой панели до тех пор, пока клиент не ответит — это **UI
  B24**, не наша баг. Workaround оператору: открыть Контакт-центр → найти диалог
  вручную.
- **НЕ синхронизирует «онлайн-статус» с реальным**. B24 показывает статус
  «доставлено/прочитано» из своих heuristics, не из реального Green API
  receipt. Чтобы галочки работали — есть `handleOutgoingMessageStatus` +
  `outgoingStatusMap` (proxy).

## 6. Как удостовериться что фикс работает (smoke-тест)

Для каждого канала **до коммита**:

```
# (1) widget /send → клиенту
curl https://social.9wb.ru/widget/send -d '{"provider":"max","phone":"...","text":"тест"}' …

# (2) проверить что сообщение реально ушло (Green API)
curl /waInstance<INSTANCE>/getOutgoingMessages/<token> → видим idMessage в очереди

# (3) проверить что session создалась в B24
imconnector.status?LINE=<NN>&CONNECTOR=social_connector → STATUS_LAST=… (есть)

# (4) проверить что в карточке клиента диалог появился
crm.contact.get?ID=<contact> → HAS_IMOL=Y, и в крякнутом B24 UI после refresh — диалог справа

# (5) клиент отвечает в мессенджере → проверить, что incoming пришёл в ТУ ЖЕ session
adapter logs grep "<chatId>" → один session_id, не два
```

Если **любая из 5 проверок не прошла** — это регрессия,
писать в [`REGRESSIONS.md`](./REGRESSIONS.md) с датой и sha, **не мерджить пока
не нашли причину**.

## 7. Orphan-лиды от native B24 OpenLine UI

Когда оператор пишет клиенту **не через наш widget**, а через native B24
OpenLine UI (форма чата в Контакт-центре / кнопка в карточке клиента не
от нашего placement), B24 сам создаёт open-line чат + лид. **Наш
adapter widget не дёргается**, поэтому `backfillSendLead` не отрабатывает —
лид остаётся orphan: `CONTACT_ID=null`, `UF_CRM_*_CHAT_ID` пусто, имя
клиента = chat_id из мессенджера.

**Фикс (sha 9f8fdf6 + afe5316, 26.05.2026)**: `_maybeLinkOrphanLead` в
начале `handleB24CrmEvent` для `ONCRMLEADADD`:

1. orphan-фильтр (нет CONTACT_ID + нет UF полей)
2. парс TITLE pattern `<chat_id> - <CHANNEL> <phone?>`
2-bis. **fallback на активность сессии (sha c6b11ef, 04.06.2026)**: если из
   TITLE chat_id не извлёкся (`!_isValidChatId`), берём его из
   `IMOPENLINES_SESSION.PROVIDER_PARAMS.USER_CODE`
   (`social_connector|<line>|<prefix><chatId>|<user>` →
   `_parseSessionUserCode` снимает префикс sc_/wa_/i2crm_ig_,
   `_channelLabelForSession` определяет канал по `provider` инстанса линии).
   **Зачем**: Telegram/MAX отдают senderName, и B24 кладёт в TITLE **имя**
   клиента, а не chat_id (regex `\w` ещё и не покрывает кириллицу) → парс п.2
   промахивался мимо существующего контакта. Кейс #362196 «Николай - Telegram
   Office». См. REGRESSIONS 2026-06-04.
3. поиск контакта по `UF_CRM_*_CHAT_ID` (голый chatId), fallback по phone
4. **collision-defense**: если по UF найдено `>1` — переход на phone
   (на портале легaси-коллизии: десятки контактов с одним UF_CRM_MAX_CHAT_ID)
5. при found — `crm.lead.update`: CONTACT_ID + UF + NAME + PHONE;
   если есть открытая сделка/лид у контакта — закрываем orphan как
   «Дубликат → kind id» (STATUS_ID=12)

Постфактум-починка существующих orphan'ов:
```bash
curl -X POST https://social.9wb.ru/webhooks/internal/relink-orphan-lead \
  -H "X-Hint-Secret: $BRIDGE_HINT_SECRET" \
  -d '{"leadId": <N>}'
```

ADR: [`decisions/2026-05-26-orphan-lead-linker.md`](./decisions/2026-05-26-orphan-lead-linker.md)

## 8. Связанные документы

- [`SOCIAL_CONNECTOR.md §6.2`](./SOCIAL_CONNECTOR.md) — общий обзор виджета
- [`SOCIAL_CONNECTOR.md §13 «Грабли»](./SOCIAL_CONNECTOR.md) — список известных quirks
- [`GREENAPI_CHANNELS.md §3-4`](./GREENAPI_CHANNELS.md) — детали WA/MAX/TG shard'ов
- [`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md) — IG-специфика через i2crm
- [`REGRESSIONS.md`](./REGRESSIONS.md) — журнал прошлых регрессий
- [`CHECKLIST_WIDGET.md`](./CHECKLIST_WIDGET.md) — чек-лист перед merge widget-правки
