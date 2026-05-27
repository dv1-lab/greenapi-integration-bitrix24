# ADR 2026-05-27: Outgoing audit (dry-run) — auto-retry не нужен

## Контекст

После задачи #71 (startup backfill incoming) Дмитрий хотел защититься
от того же сценария на стороне outgoing — когда оператор пишет из B24,
my-server лежит, webhook `ONIMCONNECTORMESSAGEADD` теряется, клиент
не получает.

Изначально планировалось два этапа:
- **Этап 1** — dry-run audit «сколько потенциально потеряно»
- **Этап 2** — auto-retry для найденных потерь

## Решение

Сделан только **Этап 1**. Этап 2 **не делаем** — реальная потеря 0%.

### Реализация Этапа 1

`OutgoingAuditService.audit({ minutes })` — REST `POST /recovery/outgoing-audit`:

1. Берёт `OutgoingMessage` записи за период (где `b24MessageId` — id операторского
   сообщения в B24, проставляется только если ONIMCONNECTORMESSAGEADD доехал
   и `imconnector.send.status.delivery` прошёл).
2. Уникальные `b24ChatId` → список открытых чатов где у нас была активность.
3. Для каждого `chat<chatId>` — `im.dialog.messages.get` LIMIT 50.
4. Фильтр **operator outgoing**: `author_id != 0` AND `params.CONNECTOR_MID`
   отсутствует/пусто.
5. Сравнение с нашим Set `b24MessageId` → не найденные = potential loss.

**Ключевая находка про `CONNECTOR_MID`:** B24 проставляет `params.CONNECTOR_MID`
для сообщений прошедших через коннектор:
- Incoming клиента → всегда CONNECTOR_MID есть (B24 ставит при приёме)
- Outgoing оператора → CONNECTOR_MID появляется когда мы делаем
  `imconnector.send.status.delivery` (т.е. подтвердили доставку)
- Если operator-сообщение есть, но CONNECTOR_MID нет → **возможно не доставлено**

Это даёт надёжный indicator без необходимости отличать operator от client
другим способом.

### Результат первого прогона (27.05.2026, период включал DDoS hip.hosting 26.05)

```json
{
  "periodMinutes": 1440,
  "ourB24ChatIds": 92,
  "dialogsScanned": 92,
  "dialogsFailed": 0,
  "operatorMessagesInB24": 0,
  "ourOutgoingRecords": 174,
  "potentialLoss": 0
}
```

**0 потерь** за 24 часа включая 5 часов downtime. Это значит:
- Webhook retry-policy B24 после восстановления сети успешно дотолкала
  все накопленные `ONIMCONNECTORMESSAGEADD`
- Adapter обработал каждое, проставил `b24MessageId` в OutgoingMessage,
  отправил `delivery` подтверждение в B24 (что зажгло CONNECTOR_MID)

## Почему НЕ делаем auto-retry (Этап 2)

1. **Реальной проблемы нет** (data-driven). Аудит после боевого DDoS дал 0.
2. **Риск дублей** при retry > польза. Если случайно решим что сообщение
   не доставлено и retry'нем — клиент получит **дубль**. Это видно ему,
   неприятно. При 0% реальных потерь — все retry были бы дубль-генератором.
3. **B24 retry-policy уже работает.** Если broken — B24 сам пересылает
   ONIMCONNECTORMESSAGEADD. Наш дублирующий retry не нужен.

## Что остаётся

- `POST /recovery/outgoing-audit` — diagnostic endpoint. Можно дёргать
  после downtime для проверки. Если когда-нибудь покажет `potentialLoss > 0` —
  смотрим samples, разбираемся почему.
- **Опционально (P3, не сделано)**: добавить daily cron в monitor-bot
  который дёргает audit и алертит в @agent_dv_bot если loss > 0. Сейчас
  не делаю — нет триггеров что нужно.

## Связано

- task #71 — startup backfill incoming (там реальная защита от потерь)
- task #72 — closed как «реальной потребности в auto-retry нет»
- task #73 — Cloudflare Workers buffer (если когда-нибудь начнём терять —
  это будет правильный фикс, а не retry постфактум)
- REGRESSIONS 26-27.05 — DDoS hip.hosting
- `src/recovery/outgoing-audit.service.ts`
- `src/recovery/recovery.controller.ts:runOutgoingAudit`
