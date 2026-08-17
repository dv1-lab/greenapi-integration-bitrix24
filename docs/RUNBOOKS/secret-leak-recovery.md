# Runbook: восстановление после утечки секрета

## Триггер

- Случайно закоммитил `.env` или файл с токеном в git → запушил в GitHub
- Засветил пароль в bash-команде (`--password=X` в args)
- Скопировал секрет в chat-transcript (Claude conversation / Telegram)
- Скопировал секрет в README/docs/комментарий кода
- `cat .env` вывел значение в terminal/screenshot

## Принципы

1. **Считать секрет компрометированным** в момент утечки — независимо
   от того успели ли удалить
2. **Не откатывать git history** через force-push без явного согласия
   Дмитрия (это destructive)
3. **Ротация быстрее очистки** — лучше сразу выпустить новый токен
   чем долго чистить historical traces

## Шаги

### 1. Идентифицировать что именно утекло

| Тип секрета | Где обычно лежит | Master в Bitwarden |
|---|---|---|
| Green API instance token | `/home/dv/{greenapi-b24,wa-tg-bridge}/.env` | «Green API <instance>» |
| B24 webhook URL | `/home/dv/.secrets/backfill-webhook.url` | «B24 webhook backfill» |
| B24 OAuth tokens (bridge) | `/home/dv/wa-tg-bridge/data/bitrix-tokens.json` | (не нужно — auto-refresh) |
| MySQL adapter password | `/home/dv/greenapi-b24/.env` (`MYSQL_ROOT_PASSWORD`) | «MySQL adapter» |
| Customer-service SERVICE_SECRET | `/home/dv/customer-service/.env` | «customer-service secret» |
| i2crm API key | `/home/dv/greenapi-b24/.env` (`I2CRM_TARGET_KEY_PUBLICAPI`) | «i2crm API» |
| TG bot tokens | `/home/dv/wa-tg-bridge/.env`, agent-dv-bot, etc | «@<bot> token» |
| Bitwarden master password | в голове Дмитрия | (никуда) |
| Cloudflare DNS token | `~/claude_code/.../.vault/cloudflare-dns.local.env` | «Cloudflare DNS» |

### 2. Ротация (немедленно)

Для каждого утёкшего секрета:

**Green API**: см. `RUNBOOKS/rotate-greenapi-token.md`

**B24 webhook**: B24 UI → Контакт-центр → Веб-хуки → Edit → Сохранить
(B24 не имеет «regenerate», но можно удалить webhook и создать заново)

**B24 OAuth (App secret)**: B24 → Приложения → наш App → «Сгенерировать
новый CLIENT_SECRET». Обновить `BITRIX_CLIENT_SECRET` на сервере.

**MySQL adapter password**:
```bash
ssh my-server "
  cd /home/dv/greenapi-b24 &&
  docker exec source-db-1 mysql -u root -p\$(grep MYSQL_ROOT_PASSWORD .env | cut -d= -f2) -e \"
    ALTER USER 'root'@'%' IDENTIFIED BY '<NEW_PASSWORD>';
    ALTER USER 'adapter'@'%' IDENTIFIED BY '<NEW_PASSWORD>';
    FLUSH PRIVILEGES;
  \"
"
```
Затем обновить `.env` через pbpaste-pipe (не Write!) и `docker compose up -d`.

**customer-service SERVICE_SECRET**: сгенерировать новый
(`openssl rand -hex 32`), обновить во **всех** сервисах которые его
используют (adapter, bridge, monitor-bot, cron-скрипты) + customer-service.
Затем `restart`.

**i2crm API key**: i2crm console → settings → regenerate target key.

**TG bot tokens**: BotFather → /revoke + /newbot.

### 3. Обновить Bitwarden

Master-копия должна **всегда** соответствовать тому что на сервере.
После ротации **сразу** обновить запись в Bitwarden.

### 4. Запись в SECRETS.md

```bash
ssh my-server "
  echo \"\$(date '+%Y-%m-%d %H:%M'): ротация <secret_name> — причина: <утечка в X>\" \
    >> /home/dv/server-ubuntu-setup/SECRETS.md
"
```

Без значений, только факт.

### 5. Если утёк в git → решение

**НЕ делать `git filter-repo` или `git push --force` без согласия Дмитрия.**

Если секрет **уже ротирован** — историческое значение в git
**бесполезно** для атакующего. Можно оставить как есть (но в публичных
репо лучше всё-таки почистить).

Если секрет нельзя ротировать (например, Bitwarden master pwd, ssh
private key Дмитрия) — обсудить с Дмитрием:
- Создать новый ключ
- Перевыпустить
- Force-push после согласия

Для приватных репо `dv1-lab/*` — обычно достаточно просто **ротировать**
без чистки history (репо приватный, доступ только у Дмитрия).

### 6. Verify

Старый секрет больше не работает:
```bash
# Green API
curl "<url>/waInstance<id>/getStateInstance/<OLD_TOKEN>"
# Должно вернуть 401 Unauthorized

# B24 webhook URL
curl "<OLD_WEBHOOK_URL>crm.lead.list" -d "filter[]=1"
# Должно вернуть error "Application not found"
```

Если старый секрет **всё ещё работает** — ротация не сработала, повторить.

## Превентивные меры (для меня как агента)

См. memory:
- `[[feedback_secrets_no_mac_slot]]` — не читать .env через Read tool
- `[[feedback_secrets_no_write_to_disk]]` — не создавать слот-файлы
- `[[feedback_secrets_in_proc_args]]` — не вытаскивать args через ps
- `[[feedback_awk_mask_fs_required]]` — awk -F= для маскировки
- `[[feedback_mask_secrets_in_debug_output]]` — sed-маска в выводах
- `[[feedback_journalctl_secrets_leak]]` — grep -A8 захватывает значения

## Связано

- `RUNBOOKS/rotate-greenapi-token.md`
- `RUNBOOKS/incident-response.md`
- `~/claude_code/infra/server-ubuntu-setup/SECRETS.md` — авторитетный список
- Глобальный `~/.claude/CLAUDE.md §7. Секреты` — правила
