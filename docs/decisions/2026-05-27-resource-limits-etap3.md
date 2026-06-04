# ADR 2026-05-27: Resource limits — Этап 3 (persist в compose)

## Контекст

Завершение #76. Этапы 1-2 (#70, #75) применили runtime лимиты через
`docker update --memory --memory-swap --memory-reservation` к 41
контейнеру. Это работает «сейчас», но **`docker compose up -d
--force-recreate` пересоздаёт контейнер и сбрасывает лимиты** на дефолт
(unlimited). Через неделю без apply-runtime-limits.sh защита бы пропала.

Также `oom_score_adj` вообще не меняется через `docker update` — только
at-creation через compose. Без compose-persist нет полного контроля
над OOM kill порядком.

## Что сделано

### 1. mem_limit/memswap_limit/mem_reservation/oom_score_adj в compose

Patch'нуты 12 compose-файлов 28 сервисов. Тиерование `oom_score_adj`:

| Tier | oom_adj | Сервисы |
|------|---------|---------|
| 0 critical | **−500** | caddy-public, customer-service+db, dv-dashboard, clickhouse, cloudflared, source-adapter+db (greenapi-b24, override уже был) |
| 1 user-facing | **−100** | clipmind-dv-bot (7 svc: api/bot/postgres/redis/telegram-bot-api/worker/worker-beat/nginx), ms-b24-sync+db+redis |
| 2 best-effort | **0** | bugsink (app+postgres), searxng (×2), uptime-kuma, mtproxy-bot |
| 3 expendable | runtime +500 | upload_data×6, mtg-×12 (без compose, через apply-runtime-limits.sh) |

`memswap_limit == mem_limit` → запрет swap для контейнера. Это **главный
фикс инцидента 25.05** когда SSH banner exchange лагал из-за swap IO
голодающих контейнеров.

### 2. builds.slice — резерв ресурсов для буилдов

`/etc/systemd/system/builds.slice`:
```ini
[Slice]
CPUWeight=20
IOWeight=20
MemoryHigh=4G
MemoryMax=6G
TasksMax=infinity
```

Запуск buildkit/compose build через `systemd-run --slice=builds.slice
docker compose build` (или существующий `/home/dv/build-low.sh` который
делает nice+ionice+oom_score_adj=+500 поверх).

### 3. docker-runtime-limits.service — boot-time apply страховка

Oneshot at boot, sleep 60s, потом `apply-runtime-limits.sh`. Гарантирует
что **upload_data×6** и **mtg-×12** (без compose, запускаются `docker
run` где-то в чужих скриптах) тоже получат лимиты после ребута.

Idempotent — compose-managed контейнеры уже имеют лимиты и `docker
update` это no-op для них.

## Артефакты

| Файл | sha |
|------|-----|
| `dv1-lab/customer-service:docker-compose.yml` | `dbf3e8d` |
| `dv1-lab/dv-dashboard:docker-compose.yml` | `05489e8` (после pull rebase) |
| `dv1-lab/clipmind-dv-bot:docker-compose.yml` | `4d004dd` |
| `dv1-lab/server-ubuntu-setup:*/docker-compose.yml` (6 файлов) | `710aa94` |
| `dv1-lab/server-ubuntu-setup:dotfiles-server/compose-snapshots/` (6 файлов) | `b4d5a03` |
| `dv1-lab/server-ubuntu-setup:dotfiles-server/etc/systemd/system/builds.slice` | `b4d5a03` |
| `dv1-lab/server-ubuntu-setup:dotfiles-server/etc/systemd/system/docker-runtime-limits.service` | `b4d5a03` |

### Финальная верификация

`docker compose config -q` прошёл на всех 12 compose. `docker stats`
показал что все 41 running контейнера имеют свои LIMIT (а не tot хоста).

## Что НЕ делаем

- **buildkit daemon.json limits** — не нужно. builds.slice + build-low.sh
  закрывает use case (один билд за раз, в slice'е). Daemon-level лимиты
  ограничили бы вообще всю build-pipeline даже когда хост свободен.
- **`docker compose up -d --force-recreate`** — не делал. Лимиты в YAML
  применятся при следующем естественном recreate (deploy / restart).
  Runtime лимиты держат защиту до тех пор. Boot-script — страховка.

## Связано

- `bots/greenapi-b24/docs/decisions/2026-05-27-resource-limits-etap1.md` (#70)
- task #75 — Этап 2 (alert при high load)
- task #76 ✅ done (этот ADR)
- memory `[[feedback-docker-update-not-persistent]]` — обновить статусом
- `/home/dv/apply-runtime-limits.sh` — wrapper для drift recovery
- `/home/dv/build-low.sh` — обёртка для билдов
