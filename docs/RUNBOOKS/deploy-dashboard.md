# Runbook: деплой dv-dashboard

## Когда применять

- После push в `dv1-lab/dv-dashboard`
- После изменения `.env` или Caddy конфига

## Шаги

```bash
ssh my-server "
  cd /home/dv/dv-dashboard && git pull --rebase
  docker compose up -d --build
"
```

Docker image билдится автоматически (Next.js build внутри Dockerfile).
Билд занимает ~2-3 минуты.

## Verify

```bash
ssh my-server "docker logs dv-dashboard --tail 30 | grep -iE 'ready|error|warn'"
```

Должно быть:
- `✓ Ready in <время>` — Next.js поднялся
- **Без** error/warn

Открыть https://dashboard.9wb.ru (basic_auth через Caddy) — должен
отдать главную страницу.

## Smoke-test

1. `dashboard.9wb.ru/` → главная c метриками
2. `dashboard.9wb.ru/customer-360` → список клиентов
3. `dashboard.9wb.ru/customer-360/waiting` → очередь ждущих ответа
4. `dashboard.9wb.ru/customer-360/outgoing-pending` → зависшие исходящие
5. Открыть произвольную карточку клиента → данные подтянулись

## Rollback

```bash
ssh my-server "
  cd /home/dv/dv-dashboard && git reset --hard <prev_sha>
  docker compose up -d --build
"
```

## Связано

- `dv-dashboard/docs/SERVICE_BLUEPRINT.md`
- Memory `[[dv_dashboard]]`
- Caddyfile (basic_auth + Let's Encrypt)
