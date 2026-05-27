# ADR 2026-05-27: Resource limits Docker сервисов на my-server (Этап 1)

## Контекст

26.05.2026 DDoS на hip.hosting + параллельный `docker build` adapter
конкурировал с GitHub Actions build ms-b24-sync → SSH banner timeout,
сетевой stack пробуксовывал. После DDoS-инцидента ясно: **без
ресурсных лимитов** один процесс может задеть всю VM, SSH/Caddy/прод
страдают одновременно.

Сервер: 8 CPU, 16 GB RAM, 8 GB swap. 43 контейнера. Swap usage 3.9 GB
(старые страницы, vm.swappiness уже 10).

## Решение (Этап 1 — минимальный безопасный)

### 1. `mem_limit` + `oom_score_adj` для критичных контейнеров

В `docker-compose.override.yml` greenapi-b24:
```yaml
adapter:
  mem_limit: 1g
  mem_reservation: 256m
  oom_score_adj: -500
db:
  mem_limit: 1500m
  mem_reservation: 400m
  oom_score_adj: -500
```

- `mem_limit` — hard limit (защита от memory leak: если adapter раздуется,
  его прибьёт OOM, **не** Caddy/dv-dashboard)
- `mem_reservation` — soft reservation для приоритета планировщика
- `oom_score_adj=-500` — OOM killer пропустит при глобальной нехватке памяти,
  убьёт что-то другое (например, тяжёлый clipmind-worker)

Применяется при следующем `docker compose up -d --force-recreate adapter db`.
**Не делаем сейчас** чтобы не прерывать прод в деловое время.

### 2. Build wrapper `~/build-low.sh`

```bash
#!/usr/bin/env bash
( echo 500 > /proc/self/oom_score_adj || true
  exec nice -n 19 ionice -c3 docker compose "$@" )
```

Использовать для всех ручных билдов вместо `docker compose ...`:
```
cd /home/dv/greenapi-b24
~/build-low.sh up -d adapter --build --force-recreate
```

- `nice -n 19` — низкий CPU приоритет
- `ionice -c3` — IDLE класс disk IO
- `oom_score_adj=+500` — build умирает первым при OOM, не прод

**Ограничение**: docker compose CLI имеет приоритет, но реальный build
работает в dockerd (root, high priority). Этот wrapper защищает orchestration
CLI и побочные stages. Полный buildkit cgroup limit — следующий этап.

## Что НЕ сделано (backlog следующих сессий)

1. **Лимиты для остальных сервисов** — paperclip, clipmind, customer-service,
   dv-dashboard, antiplagius, ms-b24-sync, monitor-bot и др. Применить
   тот же паттерн в их docker-compose файлах.
2. **systemd builds.slice** — отдельный cgroup для всех ручных build процессов
   с глобальным limit (CPU 30%, MEM 4G). `systemd-run --scope --slice=builds.slice ...`.
3. **buildkit daemon.json limits** — `"default-runtime"`/`"runtime-args"`
   ограничивают резурсы builder процесса dockerd.
4. **Алерт в monitor-bot/agent-dv-bot** при load > 1.5×CPU дольше 5 мин.
5. **clickhouse mem_limit** — сейчас 1.3 GB, потенциально может вырасти.

Этап 2 (#70 продолжение): пройти по остальным сервисам когда будет естественный
повод для редеплоя.

## Risks

- **Force-recreate adapter+db** — короткий downtime 5-10 сек. Не делать
  в час пик. Запланировать на 04:00-06:00 МСК или вместе с очередным
  natural deploy.
- **mem_limit=1G** для adapter — если реально вырастет до 1+GB (memory leak)
  → OOM kill → restart. Это **лучше** чем OOM kill случайно прибил Caddy
  или MySQL и системного оператора. Но желательно увидеть алерт.

## Verify (после применения)

```bash
ssh my-server "docker inspect source-adapter-1 --format '{{.HostConfig.Memory}} {{.HostConfig.OomScoreAdj}}'"
# Должен показать: 1073741824 (=1GB) -500
```

## Связано

- task #70 (P1, in_progress, этап 1)
- REGRESSIONS 26-27.05 (DDoS hip.hosting, SSH banner timeout)
- ADR `2026-05-26-orphan-lead-linker.md` (контекст того дня)
