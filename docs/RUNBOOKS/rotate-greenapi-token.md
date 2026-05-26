# Runbook: ротация Green API instance token

## Когда применять

- Плановая ротация (раз в N месяцев)
- Утечка токена в transcript/код/log
- Подозрение на компрометацию инстанса

## Prerequisites

- Доступ к Green API console (`https://console.green-api.com`) — Дмитрий
- SSH на my-server
- Bitwarden запись «Green API <instance_id>» (после ротации обновить)

## Шаги

### 1. Сгенерировать новый токен

1. console.green-api.com → выбрать инстанс
2. Settings → API → «Regenerate token»
3. **Скопировать новый токен** в clipboard (не сохранять в файлы!)

### 2. Обновить .env на сервере (через `pbpaste|ssh`)

⚠️ **НЕ через Write/Read** — utечёт в transcript. Только через
pbpaste-pipe:

```bash
# На маке: токен уже в clipboard после шага 1
pbpaste | ssh my-server "cat > /tmp/new-token"
ssh my-server "
  cd /home/dv/greenapi-b24 &&
  cp .env .env.bak-\$(date +%Y%m%d-%H%M%S) &&
  sed -i \"s|^GREEN_<INSTANCE_KEY>_API_TOKEN_INSTANCE=.*|GREEN_<INSTANCE_KEY>_API_TOKEN_INSTANCE=\$(cat /tmp/new-token)|\" .env &&
  rm /tmp/new-token
"
```

Замените `<INSTANCE_KEY>` на ID инстанса.

То же для bridge:
```bash
pbpaste | ssh my-server "cat > /tmp/new-token"
ssh my-server "
  cd /home/dv/wa-tg-bridge &&
  cp .env .env.bak-\$(date +%Y%m%d-%H%M%S) &&
  sed -i \"s|^GREEN_<INSTANCE_KEY>_API_TOKEN_INSTANCE=.*|GREEN_<INSTANCE_KEY>_API_TOKEN_INSTANCE=\$(cat /tmp/new-token)|\" .env &&
  rm /tmp/new-token
"
```

### 3. Рестарт сервисов

```bash
ssh my-server "
  cd /home/dv/greenapi-b24 && docker compose up -d adapter --build --force-recreate
  sudo systemctl restart wa-tg-bridge
"
```

### 4. Verify

1. Отправить тестовое сообщение клиенту через этот инстанс
2. Проверить в логах adapter: `journalctl/docker logs` без `401 Unauthorized`
3. Проверить bridge: `journalctl -u wa-tg-bridge --since '1 minute ago' | grep -i auth` — без ошибок
4. Дождаться incoming от клиента → должен прийти в TG-зеркало + B24

### 5. Обновить Bitwarden

Зайти в Bitwarden запись «Green API <instance>» → обновить поле «API Token».

### 6. Записать в SECRETS.md

```bash
ssh my-server "
  echo \"$(date '+%Y-%m-%d'): rotated Green API <instance> token\" >> /home/dv/server-ubuntu-setup/SECRETS.md
"
```

(в SECRETS.md **только факт ротации с датой**, не сам токен)

## Rollback

Если новый токен не работает:
```bash
ssh my-server "
  cd /home/dv/greenapi-b24 && cp .env.bak-YYYYMMDD-HHMMSS .env
  docker compose up -d adapter --build --force-recreate
"
```

И таким же образом для bridge. В console.green-api.com можно
сгенерировать токен снова и повторить.

## Связано

- Memory `[[feedback_secrets_no_write_to_disk]]` — почему через pbpaste
- `SECRETS.md` на my-server — журнал ротаций
- ADR `decisions/2026-05-25-greenapi-mysql-leak.md` (TODO когда сделаем
  ротацию #26 — напишем ADR)
