# Runbook: деплой wa-tg-bridge

## Когда применять

- После изменений в `pervyi-begovoy/bots/wa-tg-bridge/src/`
- После изменения `.env`

## Особенность: bridge НЕ в git на сервере

Сервер `/home/dv/wa-tg-bridge/` — это просто **синкнутая копия** с мака
через rsync (через автоматический LaunchAgent `com.dv.sync-to-server`,
каждые 15 минут, см. `~/sync-to-server.sh`). Деплой через `scp` файлов
или ждать sync.

## Шаги (быстрый деплой через scp)

```bash
# С мака — нужный файл
scp /Users/Dmitry/claude_code/1begovoy/pervyi-begovoy/bots/wa-tg-bridge/src/wa_tg_bridge/<file>.py \
    my-server:/home/dv/wa-tg-bridge/src/wa_tg_bridge/<file>.py

ssh my-server "sudo systemctl restart wa-tg-bridge"
```

Или весь модуль:
```bash
rsync -avz /Users/Dmitry/claude_code/1begovoy/pervyi-begovoy/bots/wa-tg-bridge/src/ \
  my-server:/home/dv/wa-tg-bridge/src/
ssh my-server "sudo systemctl restart wa-tg-bridge"
```

## Verify

```bash
ssh my-server "
  systemctl is-active wa-tg-bridge
  journalctl -u wa-tg-bridge --since '30 seconds ago' --no-pager \
    | grep -iE 'bot started|error|polling|ig-bridge'
"
```

Должно быть:
- `bot started: @begovoyconnect_bot`
- `instance ... → group=... state=authorized` (для каждого инстанса)
- `bitrix connector configured`
- `ig-bridge: N линий, бот-poll каждые 45 сек`
- `Start polling`

## Smoke-test

1. Отправить сообщение в WA/MAX/TG-shard от клиента → пришло в TG-зеркало
2. Ответить в TG-зеркале → дошло клиенту
3. Прокомментировать IG-пост от клиента → новая тема в IG-Comments TG-группе

## Rollback

Если bridge не стартует — bash-syntax error?

```bash
ssh my-server "cd /home/dv/wa-tg-bridge && .venv/bin/python -m py_compile src/wa_tg_bridge/*.py"
```

Если есть прексистинговый бэкап:
```bash
# .env.bak-YYYYMMDD-HHMMSS обычно есть после каждой ротации
ssh my-server "cd /home/dv/wa-tg-bridge && cp .env.bak-YYYYMMDD-HHMMSS .env"
```

Для кода — pull `git checkout <prev_sha> -- bots/wa-tg-bridge/src/` и
повторить rsync.

## Связано

- `bots/wa-tg-bridge/docs/SERVICE_BLUEPRINT.md` — полная DR-спека
- LaunchAgent `~/Library/LaunchAgents/com.dv.sync-to-server.plist`
- Memory `[[wa_tg_bridge]]`
