# Deploy adapter — обычная процедура + регламент при сбоях CDN

## Обычный деплой

Из корня репозитория adapter'а после коммита и push в `dv1-lab/greenapi-integration-bitrix24`:

```bash
ssh my-server "cd /home/dv/greenapi-b24/source && git pull --ff-only origin main && cd /home/dv/greenapi-b24 && docker compose up -d adapter --build --force-recreate"
```

После build проверка:

```bash
ssh my-server "docker logs source-adapter-1 --tail 30 | grep -E 'Nest application|error'"
```

Ожидаемая строка: `Nest application successfully started`.

Если меняли `event.bind`-list (`registerB24CrmEvents`) — обязательно вызвать:

```bash
ssh my-server '
  SECRET=$(grep "^BRIDGE_HINT_SECRET=" /home/dv/greenapi-b24/.env | cut -d= -f2-)
  curl -sS -X POST https://social.9wb.ru/webhooks/internal/register-b24-events \
    -H "X-Hint-Secret: $SECRET" -H "Content-Type: application/json" \
    -d "{\"handlerBaseUrl\": \"https://social.9wb.ru\"}"
'
```

---

## Регламент при недоступности CDN

### Симптомы

- `docker pull` / `docker build` падает на `FROM node:20-alpine` с
  `dial tcp: lookup registry-1.docker.io ... i/o timeout` или
  `TLS handshake timeout`
- `pnpm prisma generate` падает с `Error: aborted ECONNRESET` (качает
  с `binaries.prisma.sh`)

Происходило 26.05.2026 — длительные таймауты к Docker Hub и Prisma CDN
с my-server (Стокгольм). У hip.hosting кратковременная деградация
маршрутизации к Cloudflare CDN.

### Action Plan

**1. Базовый образ Docker Hub → mirror.gcr.io**

Уже сделано в Dockerfile: `FROM mirror.gcr.io/library/node:20-alpine`.
mirror.gcr.io — Google публичный pull-through cache Docker Hub, тянет
те же образы, но через инфраструктуру Google (стабильно из EU).

**Если когда-нибудь mirror.gcr.io тоже ляжет** — альтернативы:
- `public.ecr.aws/docker/library/node:20-alpine` — Amazon ECR Public,
  тоже зеркало Docker Hub
- `registry.cn-hangzhou.aliyuncs.com/library/node:20-alpine` — Alibaba

Меняем одну строчку в Dockerfile, коммитим, redeploy.

**2. Prisma CDN флапает**

В Dockerfile retry-loop на `pnpm prisma generate` (3 попытки с
backoff 15/30/45 сек). Закрывает transient-ошибки.

**Если binaries.prisma.sh лёг надолго** (>30 минут) — план B:
- Pre-bundle engine binaries в Docker image через отдельный
  build-stage. Скачать с GitHub Releases (`https://github.com/prisma/
  prisma-engines/releases/`) и COPY в `node_modules/.prisma/`.
- Реализация — отдельная задача в backlog (P2). Сейчас retry-loop
  достаточен.

**3. npm registry лежит**

`pnpm install --frozen-lockfile` качает с `registry.npmjs.org`.
Если лежит — настроить через `.npmrc`:
```
registry=https://registry.npmmirror.com/
```

Это китайский mirror npm. Не дефолт, потому что синхронизация с npm
с задержкой ~10 мин и редкие случаи battling-пакетов. Включать только
если основной npm недоступен >30 мин.

### Когда применять регламент

- Build на сервере упал 3+ раз подряд с одинаковой сетевой ошибкой
- Diagnostic из самого my-server подтверждает что CDN недоступен
  (`curl -I https://registry-1.docker.io`, `curl -I https://binaries.prisma.sh`)
- Локально build проходит, на сервере — нет (значит проблема в
  маршрутизации hip.hosting → CDN, не в коде)

### Не делать

- ❌ **Не перезапускать docker daemon** для добавления registry-mirrors
  в `/etc/docker/daemon.json`. Это убьёт все 10+ контейнеров на my-server
  (mysql, adapter, monitor-bot, customer-service, dv-dashboard, paperclip,
  clipmind, antiplagius, и т.п.) на 30-60 секунд — у клиентов 502.
  Меняем Dockerfile, restart docker не нужен.
- ❌ **Не bypass'ить retries**. Если CDN флапает раз в час 5 секунд —
  retry это закроет. Pre-bundle engines надо только если CDN лежит
  устойчиво.
- ❌ **Не лезть на сторонние npm-зеркала** без необходимости. У них
  бывают supply-chain риски.

### Связанные документы

- `Dockerfile` — текущий setup (mirror.gcr.io + prisma retry)
- `docs/REGRESSIONS.md` — запись от 26.05.2026 про инцидент
- Memory `[[feedback-cdn-mirrors-default]]` — правило для будущих сессий

---

## Полная процедура «новый сервер с нуля»

См. `SERVICE_BLUEPRINT.md` (раздел про bootstrap) — там пошагово:
docker install, compose pull, env setup, mysql init, OAuth bootstrap.
