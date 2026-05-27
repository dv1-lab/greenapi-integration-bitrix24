# ADR 2026-05-27: Startup backfill incoming (Green API)

## Контекст

26-27.05.2026 DDoS на hip.hosting положил my-server на 5+ часов. Все
incoming-сообщения клиентов в WA/MAX/TG-номер магазина за период простоя
**не доставлены в B24** — Green API webhook'и не доходили до недоступного
endpoint'а. Часть Green API ретраит несколько раз, потом сдаётся и
сохраняет в журнал (`lastIncomingMessages`, archive ~24ч), но мы это
журнал не использовали.

Дмитрий: «как сделать чтобы сообщения не терялись в случае сбоев на
my-server». Это task #71.

## Решение

При старте adapter после downtime — догнать пропущенные сообщения через
Green API `lastIncomingMessages` за последние 24 часа (или
`BACKFILL_STARTUP_MINUTES`), не дублируя то что уже обработали.

### Архитектура

1. **Новая таблица `IncomingMessage`** (Prisma + миграция
   `20260527100000_incoming_message_log`):
   - `idMessage` (PK) — Green API gloablly-unique ID
   - `idInstance`, `chatId`, `timestamp` — для аудита и индекса
   - `source` (`webhook` / `backfill_startup`) — отличить обычный поток
     от backfill в логах
2. **Запись при `incomingMessageReceived`** в
   `webhooks.controller.ts:handleGreenApiWebhook` (`createMany` +
   `skipDuplicates: true`, фоном).
3. **`StartupBackfillService`** в новом модуле `src/recovery/`:
   - `OnApplicationBootstrap` через 30 сек (даём системе прогреться) →
     `runBackfill()`
   - Для каждого `Instance.stateInstance === "authorized"`:
     - POST `/lastIncomingMessages?minutes=N` (default 1440)
     - Прочитать `IncomingMessage.findMany` по idMessage → отделить
       уже-обработанные
     - Для новых — синтезировать `MessageWebhook` (из плоского формата
       `lastIncomingMessages` в формат webhook'а), подать в
       `bitrix24Service.handleGreenApiWebhook` — путь идентичный realtime
     - После успешной обработки — `INSERT IncomingMessage` с `source =
       "backfill_startup"`
   - Rate-limit: 200ms между сообщениями, 500ms между инстансами.
4. **REST endpoint** `POST /recovery/run-backfill` с
   `X-Hint-Secret` — ручной запуск (например после очередного downtime,
   не дожидаясь рестарта adapter).
5. **Отключение через env**: `BACKFILL_STARTUP_DISABLED=1`.

### Что покрывает

- WA, MAX, TG-номер магазина — все Green API инстансы.
- Downtime до 24ч — Green API хранит archive.

### Что НЕ покрывает (вне scope #71)

- **Instagram** (i2crm) — отдельная подзадача, нужен другой API
  (i2crm не `lastIncomingMessages`, у них свои методы).
- **TG-боты** (`@begovoy_bot`, `@begovoy1support_bot`) — у Telegram
  long-polling, после восстановления adapter сам делает `getUpdates`
  с offset и догоняет.
- **Downtime > 24ч** — Green API archive протух. Тогда нужен Cloudflare
  Workers webhook buffer (task #73).
- **Outgoing** (B24 → клиент) — отдельная задача #72.

## Идемпотентность

Главная защита от дублей — в `B24` стороне: `imconnector.send.messages`
дедуплицирует через `external_message_id`. Даже если backfill подаст то
же сообщение дважды, B24 не создаст второй timeline-comment в сессии.

**TG-зеркало** (wa-tg-bridge) — у него своя дедупликация по `idMessage`
в `bridge.sqlite`. Тоже идемпотентно.

Дополнительный буфер — наша `IncomingMessage` таблица. Перед обработкой
проверяем что `idMessage` не в БД. Это защищает от лишней нагрузки на B24
при следующем рестарте (не делаем впустую `imconnector.send.messages`).

## Risks / failure modes

- **Race с realtime webhook'ом**: при старте adapter одновременно идёт
  и backfill, и приходят свежие webhook'и. Обе стороны делают `createMany
  skipDuplicates` — второй проигрывает silently, никакой ошибки. ОК.
- **Структура `lastIncomingMessages` не идентична `MessageWebhook`** —
  `synthesizeWebhook` поднимает плоский формат в иерархический. Если у
  Green API меняется формат — backfill «увидит» ошибку в `handleGreenApiWebhook`,
  залогирует и пропустит сообщение (не упадёт целиком).
- **Сообщения старше archive Green API**: они просто не вернутся —
  ничего страшного, в B24 их и так не дождутся.
- **Перекос таймера**: если timestamp в `lastIncomingMessages` сильно в
  прошлом, B24 принимает (там нет «time-window»), просто timeline-комментарий
  будет с прошлой датой.

## Verify

После деплоя:
1. `docker logs source-adapter-1 | grep startup-backfill` через 1 минуту
   после старта — должен быть `starting (period=1440 min)` и итог.
2. На реальном инциденте: убить adapter на 10 минут (специально), потом
   восстановить — проверить логи backfill, посмотреть в B24 что пришли
   все пропущенные сообщения.
3. Реальный smoke-тест возможен только при следующем downtime hip.hosting.

## Связано

- task #71 (P1, in_progress)
- task #72 — outgoing backfill (зависит от паттерна разработанного здесь)
- task #73 — Cloudflare Workers buffer (комплементарный)
- REGRESSIONS 26-27.05 — инцидент-триггер
- `prisma/migrations/20260527100000_incoming_message_log/`
- `src/recovery/startup-backfill.service.ts`
- `src/recovery/recovery.controller.ts`
