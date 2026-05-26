# Runbook: деплой adapter (Social Connector)

## Когда применять

- После git push изменений в `dv1-lab/greenapi-integration-bitrix24` repo
- После применения Prisma migration
- После изменения `.env` на сервере

## Шаги

```bash
ssh my-server "
  cd /home/dv/greenapi-b24/source && git pull --rebase
  cd /home/dv/greenapi-b24 && docker compose up -d adapter --build --force-recreate
"
```

⚠️ **ВАЖНО**: deploy из **корня** `/home/dv/greenapi-b24/`, не из
`source/`. Корень имеет docker-compose.override.yml с правильными
volumes/ports — без него поломается. См. memory
`[[greenapi_b24_install_flow]]` (если такой есть).

## Verify

```bash
ssh my-server "docker logs source-adapter-1 --tail 30 | grep -iE 'nest application|error|migration'"
```

Должно быть:
- `Applying migration <название>` (если новая миграция)
- `All migrations have been successfully applied.`
- `Nest application successfully started`
- **Без** `error|fatal` записей

## Smoke-test после деплоя

1. Отправить тестовое сообщение клиенту через любой канал
2. Получить incoming от клиента
3. Проверить логи adapter — без exceptions
4. Открыть B24-чат — сообщения проходят туда-обратно
5. Открыть TG-зеркало — сообщения отрисованы

## Rollback

Если новый билд не работает:
```bash
ssh my-server "
  cd /home/dv/greenapi-b24/source && git reset --hard <prev_sha>
  cd /home/dv/greenapi-b24 && docker compose up -d adapter --build --force-recreate
"
```

Если миграция Prisma `migrate deploy` упала и испортила схему — rollback
сложнее, нужно вручную через `prisma migrate resolve`. Это **редкий**
случай, нужно вызвать разработчика.

## Связано

- `SERVICE_BLUEPRINT.md §деплой` — полная процедура
- Memory `[[greenapi_b24_install_flow]]`
- ADR при больших изменениях
