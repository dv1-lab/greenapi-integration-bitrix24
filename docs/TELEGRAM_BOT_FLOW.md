# Telegram-бот (@begovoy_bot) — техническая документация

Клиентский Telegram-бот **@begovoy_bot** («ПЕРВЫЙ БЕГОВОЙ бот by 1BEGOVOY.RU»,
id 1873464778) подключён к Bitrix24 **через Social Connector**, а не штатным
Telegram-коннектором B24. Сделано по образцу Instagram/i2crm: своя линия,
журнал сообщений, зеркало в TG-супергруппу.

История: до 2026-05-23 бот работал как AI-чат-бот (автоответы клиентам).
По решению владельца переведён на живых операторов B24 — AI убран, отвечают
операторы в открытой линии.

## Каналы и идентификаторы

| Что | Значение |
|---|---|
| Бот | `@begovoy_bot`, id 1873464778 |
| Открытая линия B24 | **8** «Telegram begovoy_bot - 1Begovoy.ru канал» |
| Коннектор | `social_connector` (активирован на линии 8 рядом со штатным) |
| Webhook бота | `https://social.9wb.ru/webhooks/telegram-bot` |
| Зеркало | TG-супергруппа «TG begovoy_bot» `-1003988471578` |
| Бот зеркала | `@begovoyconnect_bot` (тот же, что для WA/Instagram) |

`.env` (на сервере, `/home/dv/greenapi-b24/.env`):
`TG_BOT_TOKEN`, `TG_BOT_LINE_ID=8`, `TG_BOT_WEBHOOK_SECRET`,
`TG_BOT_MIRROR_GROUP_ID=-1003988471578`.

## Входящий поток (клиент → B24)

```
Клиент пишет @begovoy_bot
        ▼
Telegram Bot API → webhook POST /webhooks/telegram-bot
   (защита: secret_token в заголовке X-Telegram-Bot-Api-Secret-Token)
        ▼
handleTelegramBotIncoming (bitrix24.service.ts)
   ├─ журнал в TgBotEventLog (status=pending → sent)
   ├─ медиа: getFile → скачать → MediaCacheService → ссылка social.9wb.ru/media/…
   ├─ ensureOpenLeadForPhone("Telegram", skipLeadCreation) — резолв контакта по UF_CRM_TG_CHAT_ID
   ├─ imconnector.send.messages в линию 8 (chat.id = tgbot_<chatId>)
   ├─ backfillTgBotContactLink — привязка лида сессии к контакту клиента
   └─ зеркало TgBotMirrorService → топик клиента в супергруппе
```

B24 матчит открытые линии с CRM по телефону — у Telegram-бота его нет,
поэтому `backfillTgBotContactLink` после старта сессии сам находит лид по
`USER_CODE` и проставляет `CONTACT_ID` (контакт резолвится по `UF_CRM_TG_CHAT_ID`).

B24 не может скачивать `api.telegram.org/file/...` (в URL токен бота) —
поэтому медиа проксируется через `social.9wb.ru/media/…` (MediaCacheService,
тот же приём, что для Telegram/MAX-шардов Green API).

## Исходящий поток (оператор B24 → клиент)

```
Оператор пишет в чате открытой линии 8
        ▼
B24 webhook ONIMCONNECTORMESSAGEADD → POST /webhooks/bitrix24
        ▼
handleBitrix24Webhook → ветка lineNumber === TG_BOT_LINE_ID
        ▼
handleTelegramBotOutgoing
   ├─ emoji.emojify — B24 хранит эмодзи шорткодами (:trophy:) → Unicode
   ├─ текст: sendMessage (длинный — частями по 4096)
   ├─ файлы: sendPhoto (картинки) / sendDocument; подпись ≤1024 — caption
   ├─ sendDeliveryConfirmation — галочки доставки в B24
   └─ зеркало mirrorOutgoing → топик клиента
```

Эхо нет: Telegram Bot API не шлёт webhook о сообщениях самого бота.

## Журнал и история

Каждое сообщение (in/out) пишется в таблицу `TgBotEventLog` — это и история
переписки, и страховка: при недоступности B24 запись остаётся `status=pending`
(replay-механизм можно добавить по образцу i2crm-replay).

## Откат на штатный коннектор B24

Если нужно вернуть бота на штатную интеграцию B24:
```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  --data-urlencode "url=https://im.bitrix.info/imwebhook/?eh=dca0e0f65a76197790a249c2dd3d765e1758530653"
```
(eh-параметр — исходный, сохранён на момент миграции 2026-05-23.)

## Открытые хвосты

- **`/nnn` в супергруппе** не обрабатывается — нужна доработка wa-tg-bridge
  (он слушает TG-группы и пишет timeline-comment в лид).
- **welcome-текст линии 8** содержит «отправьте "+"» — артефакт старого
  AI-flow (бот раньше был AI-чат-ботом), стоит обновить в настройках линии B24.
- Стикеры Telegram не релеятся (.tgs/webm) — уходят как «[вложение]».
- Совсем новый клиент (контакта в B24 ещё нет) ведётся как лид без контакта —
  это штатно для открытых линий; контакт появится при конвертации лида.
