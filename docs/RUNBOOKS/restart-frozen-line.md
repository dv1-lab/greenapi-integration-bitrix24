# Runbook: восстановить «зависшую» open-line линию

## Когда применять

- Анастасия/Кирилл жалуются что в B24-чате конкретной линии **не приходят** новые сообщения
- Клиент пишет в WA/IG/TG, но в B24 ничего нет
- В TG-зеркале не появляется тема для нового клиента

## Диагностика

### 1. Какая линия проблемная?

Спросить у оператора **из какого канала** не приходят (WA номер, IG, TG).
Соответствие канал → линия:

| Канал | CONFIG_ID | Коннектор |
|---|---|---|
| WA 84566 | 174 | wa_tg_bridge |
| WA 79240778566 | 148 | wa_tg_bridge |
| MAX 79584983354 | 182 | wa_tg_bridge |
| TG 79584983354 | 178 | wa_tg_bridge |
| TG 79240778566 | 204 | wa_tg_bridge |
| IG Direct | 18 | i2crm |
| IG Comments | 22 | i2crm |

### 2. Проверить health adapter / bridge

```bash
ssh my-server "
  systemctl is-active wa-tg-bridge
  docker ps --filter name=source-adapter --format '{{.Status}}'
"
```

Если bridge `inactive` или контейнер `Exited` — перезапустить:
```bash
ssh my-server "
  sudo systemctl restart wa-tg-bridge
  cd /home/dv/greenapi-b24 && docker compose up -d adapter --force-recreate
"
```

### 3. Проверить логи на ошибки

```bash
# Adapter
ssh my-server "docker logs source-adapter-1 --tail 100 | grep -iE 'error|failed|exception'"

# Bridge
ssh my-server "journalctl -u wa-tg-bridge --since '15 min ago' --no-pager | grep -iE 'error|failed|exception'"
```

### 4. Проверить состояние Green API instance (если канал WA/MAX/TG)

```bash
ssh my-server "
  cat > /tmp/check_gapi.py <<'PY'
import os, httpx, asyncio
async def main():
    inst = os.environ.get('GREEN_<KEY>_ID_INSTANCE')
    token = os.environ.get('GREEN_<KEY>_API_TOKEN_INSTANCE')
    url = os.environ.get('GREEN_<KEY>_API_URL')
    r = await httpx.AsyncClient(timeout=10).get(f'{url}/waInstance{inst}/getStateInstance/{token}')
    print(r.json())
asyncio.run(main())
PY
  cd /home/dv/wa-tg-bridge && set -a && source .env && set +a && python3 /tmp/check_gapi.py
"
```

Состояние должно быть `authorized`. Если `not_authorized`, `starting`,
`disabled` — клиенту нужно зайти в WA Web → подключить устройство
(перечитать QR), или для MAX/TG-shard — обратиться в Green API support.

### 5. Проверить коннектор B24

Открытая линия → Контакт-центр → линия → проверить что коннектор
**активен** (зелёная галочка). Если нет — переподключить через UI.

### 6. Тест end-to-end

Отправить тестовое сообщение от себя клиенту → проверить:
- Доставка через Green API (success в логах)
- Зеркалирование в TG (по polling 45с)
- Создание лида в B24 (если первый раз)

## Эскалация

Если **ничего из этого не помогает** в течение 15 минут:

1. Уведомить Дмитрия (Telegram)
2. Проверить **статус Bitrix24** портала (бывают перебои у самого B24)
3. Перезапустить **обе** службы:
   ```bash
   ssh my-server "
     sudo systemctl restart wa-tg-bridge
     cd /home/dv/greenapi-b24 && docker compose restart
   "
   ```
4. Подождать 2-3 минуты — клиенты, которые писали во время простоя,
   должны догнать через polling 45с (для IG) или через webhook re-delivery

## Verify recovered

1. Свежее тестовое сообщение → дошло до клиента и обратно
2. Анастасия подтвердила что видит в B24
3. В dashboard `/customer-360/waiting` нет накопленных incoming за время простоя

## Связано

- Memory `[[wa_tg_bridge]]`, `[[social_connector]]`
- `SERVICE_BLUEPRINT.md` — полная архитектура с пинами
- Tech-monitor бот @agent_dv_bot — алертит автоматически если bridge `inactive` > 5 мин
