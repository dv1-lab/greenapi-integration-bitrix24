# Runbook: добавить новую open-line линию

## Когда применять

- Подключаем **новый номер** WhatsApp / MAX / Telegram (Green API)
- Открываем **новый канал** (например, дополнительный IG-аккаунт)
- Создаём отдельную линию для VIP-клиентов / отдельной команды

## Prerequisites

- Доступ к B24 портал → Контакт-центр → Открытые линии (UI создание)
- `WH=$(cat /home/dv/.secrets/backfill-webhook.url)` на my-server
- Для Green API канала: `instance_id` + `api_token` в Green API console

## Шаги

### 1. Создать линию в B24 UI

1. Bitrix24 → Контакт-центр → Открытые линии → «Создать»
2. Имя линии: `<Channel> <number>` (например, `WhatsApp 79991234567`)
3. Очередь: добавить операторов (Анастасия / Кирилл / Олег / Дмитрий)
4. Сохранить → получили `CONFIG_ID` (число, видно в URL)

### 2. Применить продуктовое правило (PRODUCT_RULES §1.1)

**ОБЯЗАТЕЛЬНО** иначе будут плодиться повторные лиды:

```bash
WH=$(cat /home/dv/.secrets/backfill-webhook.url)
LINE=<новый_CONFIG_ID>

curl -sG "${WH}imopenlines.config.update.json" \
  --data-urlencode "CONFIG_ID=$LINE" \
  --data-urlencode "PARAMS[CRM_CREATE_SECOND]=N" \
  --data-urlencode "PARAMS[CRM_FORWARD]=Y"
```

Проверка:
```bash
curl -sG "${WH}imopenlines.config.get.json" \
  --data-urlencode "CONFIG_ID=$LINE" \
  | python3 -m json.tool | grep -iE 'CRM_CREATE|CRM_FORWARD'
```

Должно быть `CRM_CREATE: lead`, `CRM_CREATE_SECOND: N`, `CRM_FORWARD: Y`.

### 3. Подключить коннектор к линии

Для **WA / MAX / TG (Green API)**:
1. Контакт-центр → Открытые линии → выбрать линию → Коннекторы
2. Активировать `wa_tg_bridge` (наш) или `social_connector`
3. Привязать `instance_id` через UI (если требуется)

Для **Instagram (i2crm)** новая линия — обычно не нужна, есть 18 и 22.

### 4. Добавить инстанс в adapter (если Green API)

Отредактировать `/home/dv/greenapi-b24/.env` на сервере:

```
GREEN_<NEW>_ID_INSTANCE=<id>
GREEN_<NEW>_API_TOKEN_INSTANCE=<token>
GREEN_<NEW>_API_URL=<api_url>
GREEN_<NEW>_MEDIA_URL=<media_url>
BITRIX_INSTANCE_TO_LINE_<NEW>=<CONFIG_ID>
```

(точные имена env — смотреть как сделаны существующие инстансы 1103487233/1101948511)

Деплой:
```bash
cd /home/dv/greenapi-b24 && docker compose up -d adapter --build --force-recreate
```

### 5. Добавить инстанс в wa-tg-bridge (для зеркала)

Отредактировать `/home/dv/wa-tg-bridge/.env`:

```
GREEN_<NEW>_ID_INSTANCE=<id>
GREEN_<NEW>_API_TOKEN_INSTANCE=<token>
GREEN_<NEW>_API_URL=<api_url>
GREEN_<NEW>_MEDIA_URL=<media_url>
GREEN_<NEW>_TG_GROUP_CHAT_ID=<tg_group>  # супергруппа-зеркало
GREEN_<NEW>_KIND=WA|MAX|TG
BITRIX_INSTANCE_TO_LINE_<NEW>=<CONFIG_ID>
```

Создать TG-супергруппу-зеркало:
1. Создать новую TG-группу, включить «Темы» (forum mode)
2. Добавить @begovoyconnect_bot как admin (с правами Manage Topics)
3. Скопировать chat_id группы → в env

Рестарт bridge:
```bash
sudo systemctl restart wa-tg-bridge
```

### 6. Webhook'и Green API → adapter

В Green API console → Settings → Webhooks:
- URL: `https://social.9wb.ru/webhooks/green-api`
- Включить `incomingMessageReceived`, `outgoingMessageReceived`,
  `outgoingAPIMessageReceived`, `outgoingMessageStatus`, `stateInstance`

(пути webhook'ов — смотреть как сделаны для существующих инстансов)

## Verify

1. Отправить тестовое сообщение **в** этот номер с другого WA/IG
2. В B24 должен появиться **лид** с правильным CHAT_ID
3. В TG-зеркале — новая тема с карточкой клиента + первое сообщение
4. Ответить из B24 → клиент получит на WA/IG
5. Ответить из TG-зеркала → клиент получит на WA/IG
6. Проверить: повторное сообщение клиента (когда у него есть открытый
   лид) → новый «Повторный лид» **НЕ создаётся**, переписка идёт в
   текущий лид (это PRODUCT_RULES §1.1 в действии)

## Rollback

Если что-то пошло не так:
1. Отключить webhook'и в Green API console
2. Удалить env-переменные инстанса
3. Рестартанул adapter и bridge
4. Линию в B24 можно оставить (она не вредит без коннектора)

## Связано

- `PRODUCT_RULES.md §1.1` — почему CRM_CREATE_SECOND=N
- `decisions/2026-05-26-crm-create-second-disabled.md`
- `GLOSSARY.md` — термины (линия, коннектор, инстанс)
- `ARCHITECTURE.md` — где живут .env и сервисы
