# Telegram-боты — техническая документация (multi-instance)

Клиентские Telegram-боты подключены к Bitrix24 **через Social Connector**,
а не штатным Telegram-коннектором B24. Сделано по образцу Instagram/i2crm:
своя линия, журнал сообщений, зеркало в TG-супергруппу. Каждый бот —
отдельный инстанс со своим набором env.

История: до 2026-05-23 `@begovoy_bot` работал как AI-чат-бот (автоответы).
По решению владельца AI убран — отвечают живые операторы.

## Инстансы

| `name` | Бот | Линия B24 | CRM-источник | Зеркало (группа) | userKey-префикс |
|---|---|---|---|---|---|
| `begovoy` | `@begovoy_bot` (1873464778) | **8** «Telegram begovoy_bot» | `8\|TELEGRAM` «telegram-begovoy_bot-direct» | `-1003988471578` «TG begovoy_bot» | `tgbot_` |
| `support` | `@begovoy1support_bot` (8684300904) | **206** «Telegram support_bot — Техподдержка» | `206\|SOCIAL_CONNECTOR` «Telegram — 1Б Поддержка» | `-1003772436222` «1Б Поддержка» | `tgsupport_` |

Бот зеркала один общий — `@begovoyconnect_bot` (тот же, что для WA/Instagram).

`.env` (на сервере, `/home/dv/greenapi-b24/.env`):
```
# begovoy
TG_BOT_TOKEN, TG_BOT_LINE_ID=8, TG_BOT_WEBHOOK_SECRET,
TG_BOT_MIRROR_GROUP_ID=-1003988471578
# support
TG_BOT_SUPPORT_TOKEN, TG_BOT_SUPPORT_LINE_ID=206, TG_BOT_SUPPORT_WEBHOOK_SECRET,
TG_BOT_SUPPORT_MIRROR_GROUP_ID=-1003772436222
```

## Multi-instance: как добавить нового бота

1. Создать бота в @BotFather, получить токен.
2. Создать открытую линию в B24 (`imopenlines.config.add`).
3. Активировать коннектор `social_connector` на линии
   (`imconnector.activate` + `imconnector.connector.data.set`).
4. Добавить `TG_BOT_<NAME>_*` env-переменные.
5. Добавить ветку в `getTgBotConfig(name)` в `bitrix24.service.ts`.
6. setWebhook на `https://social.9wb.ru/webhooks/telegram-bot/<name>`.
7. Добавить chat_id зеркало-группы в `TG_BOT_MIRROR_GROUPS` env wa-tg-bridge.

## Webhook endpoints

- `POST /webhooks/telegram-bot/:name` — Telegram → adapter (per-instance).
- `POST /webhooks/telegram-bot` — legacy → инстанс begovoy.
- `POST /webhooks/internal/tg-bot-reply` — обратный путь от bridge к клиенту
  (см. ниже).

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
   ├─ парсинг `ym-<id>` из текста — Я.Метрика ClientId (сайт подставляет «код обращения»)
   ├─ imconnector.send.messages в линию 8 (chat.id = tgbot_<chatId>)
   ├─ backfillTgBotContactLink — привязка контакта + UF_CRM_NF_YM_CLIENT_ID
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

## Обратный путь: зеркало → бот → клиент

Оператор отвечает клиенту НЕ через чат открытой линии B24, а напрямую
в супергруппе TG-зеркала (в топике клиента). Поток:

```
Оператор пишет в топик клиента (группа -1003988471578 или -1003772436222)
        ▼
wa-tg-bridge (_is_tg_bot_mirror_group + _forward_to_tg_bot)
        ▼
POST /webhooks/internal/tg-bot-reply (X-Hint-Secret)
        {groupId, topicId, text, operatorName}
        ▼
adapter:
   ├─ getTgBotByGroupId(groupId) → name
   ├─ TgBotMirrorService.findChatIdByTopic(groupId, topicId) → chatId
   └─ sendFromTgBot(name, chatId, text) → api.telegram.org/bot<token>/sendMessage
```

env wa-tg-bridge: `TG_BOT_MIRROR_GROUPS=-1003988471578,-1003772436222`,
`ADAPTER_TG_BOT_REPLY_URL=https://social.9wb.ru/webhooks/internal/tg-bot-reply`.

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
