# Чек-лист: правка виджета / outgoing-flow

> **Применять перед каждым merge'ем правок** в:
> - `src/widget/widget.controller.ts`
> - `src/bitrix24/bitrix24.service.ts` — методы `handleI2crmIncoming/Outgoing`,
>   `handleOutgoing*`, `mirrorToBitrix`, `ensureOpenLeadForPhone`
> - `src/bitrix24/tg-bot-mirror.service.ts`
> - `src/bitrix24/i2crm-tg-mirror.service.ts`

## 0. Перед любой строкой кода

- [ ] Прочитал [`OPEN_LINE_LIFECYCLE.md`](./OPEN_LINE_LIFECYCLE.md)
      (нужен текущий контекст, не из памяти).
- [ ] Прочитал [`REGRESSIONS.md`](./REGRESSIONS.md) — нашёл записи по
      тому каналу, который трогаю.
- [ ] `git log --grep="<provider>\|widget"` за последние 90 дней — нет ли
      недавнего фикса той же области.

## 1. Симметрия 4 канала × 2 направления × 2 точки входа

|        | WA | TG (Green API) | MAX | IG (i2crm) |
|---|---|---|---|---|
| Incoming (клиент → B24) | `handleOutgoingFromDevice`/`handleI2crmIncoming` (для IG) | то же | то же | `handleI2crmIncoming` |
| Outgoing-widget (B24 виджет → клиент) | `widget.send` provider=whatsapp | `widget.send` provider=telegram | `widget.send` provider=max | `widget.sendInstagramDirect` |
| Outgoing-mobile (оператор пишет с телефона) | `handleOutgoingFromMobile` | `handleOutgoingFromDevice` (для TG/MAX) | то же | n/a (IG нет mobile-зеркала) |
| Outgoing-B24 (оператор пишет из Контакт-центра) | `handleBitrix24Webhook ONIMCONNECTORMESSAGEADD` | то же | то же | `handleI2crmOutgoing` |

- [ ] Изменения **симметричны** для всех 4 каналов. Если меняю формат
      `chat.id` для MAX — проверил TG и WA. Если для IG — проверил comments/direct.
- [ ] Если асимметрия осознанная — это **записал в комментарий к коду** + в
      `REGRESSIONS.md` (превентивно).

## 2. chat.id префиксы — обязательная проверка

Для каждого канала **incoming и outgoing должны давать ОДИНАКОВЫЙ** `chat.id` в
`imconnector.send.messages`. Иначе B24 заведёт второго chat-user и второй
session.

- [ ] WA incoming/outgoing: `wa_<phone>` (или `sc_<phone>` для прокси)
- [ ] TG incoming/outgoing (Green API shard): `<chat_id>` без префикса
- [ ] MAX incoming/outgoing: `<chat_id>` без префикса
- [ ] TG-bot incoming/outgoing (наши боты): `tgbot_<chat>` / `tgsupport_<chat>`
- [ ] IG Direct: `i2crm_ig_<client_id>`
- [ ] IG Comment: `i2crm_ig_<client_id>_c<media_id>`
- [ ] Прогнал в B24: `SELECT user_code FROM imopenlines_user_messenger WHERE chat_id=<NN>`
      → виден только один user_code на клиента на канал.

## 3. Smoke-тест перед коммитом (минимум)

Для **затронутых** каналов:

```bash
# 1. Отправка
curl -sS https://social.9wb.ru/widget/send \
  -H 'Content-Type: application/json' \
  -d '{"provider":"<p>","phone":"...","text":"smoke <дата>","authId":"<token>","domain":"1begovoy.bitrix24.ru"}' \
  | jq

# 2. Должен быть idMessage в ответе
# 3. В B24: открыть сделку клиента → справа в карточке должен появиться чат
#    (refresh может потребоваться один раз)
# 4. В adapter logs: grep "<chatId>" — один session_id, не два
docker logs source-adapter-1 --since 5m 2>&1 | grep '<chatId>'

# 5. Через 1-2 минуты: клиент отвечает в мессенджере →
#    incoming должен попасть в ТУ ЖЕ session (а не открыть новую)
```

- [ ] Smoke прошёл для каждого затронутого канала.
- [ ] `imconnector.status?LINE=<NN>` для каждой задействованной линии = `STATUS_LAST="connected"` или аналог.

## 4. Известные quirks по каналам — проверять обязательно

### WA (Green API)
- `chat.id` всегда `wa_<digits>` (или `sc_<digits>` если идёт через wa-tg-bridge mirror).
- `outgoingAPIMessageReceived` — это outgoing-from-API, не trigger session.
- Нельзя слать чистый `<digits>@c.us` если есть префикс — будет дубль.

### TG (Green API shard)
- Telegram shard в Green API использует chatId **БЕЗ** `@c.us`.
  В коде проверять `provider === "telegram"` и не подставлять `@c.us`.
- В B24 user_code: `telegrambot|<line>|<bot_id>|<chat>`.

### MAX
- chatId — digits без префикса.
- Phone у MAX-клиента отсутствует — резолв через `UF_CRM_MAX_CHAT_ID`.
- `outgoingMessageReceived` (без `APIMessage`) = «с устройства» (мобильное приложение).

### IG (i2crm)
- Direct: `chat.id = i2crm_ig_<client_id>`.
- Comment: `chat.id = i2crm_ig_<client_id>_c<media_id>` — **разные сессии на разные посты** (A2).
- Reply на конкретный коммент в треде — через `IgInboundB24Link` (новая таблица 2026-05-24).
- Виджет «писать первым» в Direct требует resolve username → client_id через
  `crm.lead.list?filter[UF_CRM_IG_USERNAME]=` (см. `7c00742`).

### TG-bot (наши боты @begovoy_bot, @begovoy1support_bot)
- Это **не виджет**. Outgoing через `handleTelegramBotOutgoing` →
  api.telegram.org/sendMessage. chat.id префикс зависит от инстанса:
  `tgbot_<chat>` для begovoy, `tgsupport_<chat>` для support.
- Зеркало → отдельная TG-супергруппа. /nnn → `internal/tg-bot-note`.

## 5. После merge — мониторинг 24ч

- [ ] Через 24ч после деплоя — пройти 5 последних исходящих от операторов в
      каждом канале и проверить что они **в карточке** клиента, а не «висят отдельно».
- [ ] Если что-то — записать в [`REGRESSIONS.md`](./REGRESSIONS.md) и откатить.

## 6. Если что-то сломалось, чего НЕ делать

- ❌ Менять формат `chat.id` без обновления **всех** мест (incoming + outgoing-widget + outgoing-mobile + outgoing-B24).
- ❌ Переключать с `imconnector.send.messages` на `crm.message.send` (это уже
      ломали 2 раза, см. REGRESSIONS).
- ❌ Удалять префикс `sc_`/`wa_`/`i2crm_ig_` без полного аудита incoming
      обработчиков.
- ❌ «Чинить» одну регрессию без проверки симметрии — это значит, что через
      неделю всплывёт в другом канале.
