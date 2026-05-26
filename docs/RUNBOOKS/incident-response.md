# Runbook: реагирование на инцидент

## Триггеры

- Оператор жалуется «сообщения не доходят» / «лиды дубль» / «клиент пропал»
- Авто-алерт в @agent_dv_bot tech-monitor чате
- В dashboard `/customer-360/outgoing-pending` накопилось > 20 «> 1ч»
- Healthchecks ping упал

## Принцип

1. **Сначала диагностика, потом фикс**. Не рестартовать «на всякий случай».
2. **Зафиксировать симптом** — скриншот / логи / номер клиента / время
3. **Не паниковать** — обычно это один из ~5 типичных классов проблем

## Триаж — какой класс?

### Класс A: «сервис лежит»

Симптом: 500 на endpoint / контейнер `Exited` / `systemctl is-active` не active.

```bash
ssh my-server "
  docker ps -a --filter status=exited
  systemctl is-active wa-tg-bridge dv-dashboard ig-bridge
"
```

Действие:
1. Логи последних 5 минут → найти exception
2. Если recent code-change → откатить на prev sha (`git reset --hard`)
3. Если нет clear cause → `restart` + monitor

→ См. `RUNBOOKS/restart-frozen-line.md` для конкретики.

### Класс B: «сообщения не доходят клиенту»

Симптом: оператор отвечает в B24/TG-зеркале, клиент в WA/IG ничего не получает.

Диагностика:
```bash
# adapter log на последние outgoing
ssh my-server "docker logs source-adapter-1 --tail 100 | grep -iE 'i2crm outgoing|green api|delivery|outgoing'"
```

Проверить в dashboard `/customer-360/outgoing-pending` — есть ли это
сообщение в очереди (висит без delivery_status).

Действие:
1. Если Green API: проверить `getStateInstance` — может быть `not_authorized`
   → переподключить устройство (Дмитрий через WA Web)
2. Если IG (i2crm): проверить i2crm payload — могут быть rate-limits Meta,
   API token expired (Дмитрий через i2crm console)
3. Если внутренний transport error → adapter restart

### Класс C: «дубли клиентов / лидов»

Симптом: один человек = два UUID / два лида / два контакта.

Проверка:
```bash
ssh my-server "
  PGU=\$(grep POSTGRES_USER /home/dv/customer-service/.env | cut -d= -f2)
  PGD=\$(grep POSTGRES_DB /home/dv/customer-service/.env | cut -d= -f2)
  docker exec customer-service-db-1 psql -U \$PGU -d \$PGD -c \"
    SELECT customer_uuid, alias_type, alias_value
    FROM customer_aliases
    WHERE alias_value = '<phone или chat_id>'
  \"
"
```

Действие:
1. Если найдено 2+ UUID на одного клиента → merge через API:
   ```bash
   curl -X POST http://my-server:3002/customers/merge \
     -H "X-Service-Secret: $SECRET" -H "Content-Type: application/json" \
     -d '{"sourceUuid":"<source>","targetUuid":"<target>","byUser":"incident-<timestamp>"}'
   ```
2. Если в B24 два лида у одного контакта → проверить настройки линии
   (`PRODUCT_RULES.md §1.1`) — должна быть `CRM_CREATE_SECOND=N`
3. Систематика дублей → `RUNBOOKS/backfill-tg-customer360.md`

### Класс D: «зависшая открытая линия»

Симптом: новые сообщения не появляются в B24-чате конкретной линии.

→ См. `RUNBOOKS/restart-frozen-line.md`

### Класс E: «секрет утёк»

Симптом: пароль/токен попал в git/transcript/log.

→ См. `RUNBOOKS/secret-leak-recovery.md`

## Эскалация

Если за **15 минут** не локализовали проблему:

1. Уведомить Дмитрия (Telegram)
2. Создать таск в `internal_tasks` через `/n` команду в task-tracker
3. Скриншот + логи + симптом → собрать в один пост для архива
4. Если **критическое для бизнеса** (клиенты не получают ответы > 30 мин):
   - Временно переключить операторов на ручной WA/IG (без CRM)
   - Параллельно разбираться с фиксом

## Post-incident

После фикса:
1. **Создать запись в REGRESSIONS.md** — что было, корень, фикс
2. Если корень — отсутствие правила/процесса → дописать в **PRODUCT_RULES.md**
3. Если архитектурное решение → ADR в **decisions/**
4. Записать в memory если есть feedback / правило на будущее
5. CHANGELOG.md — если есть что-то заметное оператору

## Связано

- `RUNBOOKS/restart-frozen-line.md` — конкретика по линии
- `RUNBOOKS/secret-leak-recovery.md` — утёкший секрет
- `RUNBOOKS/save-session.md` — после инцидента не забыть зафиксировать
- `REGRESSIONS.md` — журнал прошлых инцидентов
- @agent_dv_bot — tech-monitor алерты
- Memory `[[silent_failure_alerts]]` — про silent failures
