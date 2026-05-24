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

## 7. Связанные документы

- [`SOCIAL_CONNECTOR.md §6.2`](./SOCIAL_CONNECTOR.md) — общий обзор виджета
- [`SOCIAL_CONNECTOR.md §13 «Грабли»](./SOCIAL_CONNECTOR.md) — список известных quirks
- [`GREENAPI_CHANNELS.md §3-4`](./GREENAPI_CHANNELS.md) — детали WA/MAX/TG shard'ов
- [`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md) — IG-специфика через i2crm
- [`REGRESSIONS.md`](./REGRESSIONS.md) — журнал прошлых регрессий
- [`CHECKLIST_WIDGET.md`](./CHECKLIST_WIDGET.md) — чек-лист перед merge widget-правки
