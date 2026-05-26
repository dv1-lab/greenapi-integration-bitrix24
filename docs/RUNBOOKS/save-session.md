# Runbook: закрыть сессию работы (`/save` протокол)

## Когда применять

- Дмитрий говорит «сохрани» / «закрепим итоги» / «давай зафиксируем»
- Перед `/compact` (context windowing)
- Когда закончили крупную фичу
- Просто `/save` slash-command

## Что должно быть зафиксировано

В **каждом** из этих мест (см. полный chek-list):

1. **Code** — git commits во всех затронутых репо
2. **REGRESSIONS** — если был фикс бага
3. **PRODUCT_RULES** — если появилась/изменилась продуктовая логика
4. **decisions/ADR** — если приняли архитектурное решение
5. **Архитектурные docs** (`*_FLOW.md`, `SERVICE_BLUEPRINT.md`)
6. **CHANGELOG.md** — если есть что-то заметное оператору/клиенту
7. **Memory** (`~/.claude/.../memory/`) — feedback / новые факты
8. **Vault daily** — блок «Сессия HH:MM» с итогами
9. **Task tracker** — статусы задач обновлены

## Шаги для Дмитрия (если делает руками без меня)

Обычно я делаю через `/save` slash-command. Но если нужно
самостоятельно — вот процедура:

### 1. Git status во всех репо

```bash
for d in ~/claude_code/*/; do
  cd "$d"
  changes=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$changes" != "0" ]; then
    echo "=== $d ($changes uncommitted) ==="
    git status -s
  fi
done
```

Закоммитить логические группы:
```bash
git add <files> && git commit -m "<тип>(<scope>): <что>" && git push origin main
```

### 2. REGRESSIONS — если был фикс

`bots/greenapi-b24/docs/REGRESSIONS.md` сверху добавить запись:

```markdown
## YYYY-MM-DD · <короткий симптом>

- **Симптом**: <что увидели/жаловались>
- **Корень**: <реальная причина, не «было плохо стало хорошо»>
- **Фикс sha `<sha>`**: <что в коде поменялось + почему>
- **Verify**: <как подтверждено>
- **Что НЕ делать**: <грабли>
```

### 3. Memory — feedback или project memo

Если Дмитрий сказал «впредь делай так» / «не делай Х» — создать
`~/.claude/projects/-Users-Dmitry-claude-code/memory/feedback_<topic>.md`:

```markdown
---
name: feedback-<topic>
description: "<one-line summary>"
metadata:
  type: feedback
---

**Why:** <причина>
**How to apply:** <конкретные действия>
```

Если новый архитектурный факт — `project_<topic>.md`.

В `MEMORY.md` добавить pointer-строку.

### 4. Vault daily

```bash
TZ=Europe/Moscow date '+%H:%M'  # текущее МСК
```

Допиши в **конец** `~/Documents/Obsidian Vault/daily/YYYY-MM-DD.md`:

```markdown
## Сессия HH:MM — <короткое название>

**Что сделано:**
- ✅ <bullet> (sha xxx)

**Backlog после сессии:**
- <pending #N — что осталось>

**Memory обновлено:** [[file1]], [[file2]]
**Регрессии:** sha xxx
**Sha:** repo1 `xxx` · repo2 `yyy`
```

Vault синкается через плагин Git каждые 10 мин — `git push` вручную
не нужен.

### 5. Tasks

Через TaskUpdate (если делает агент) или через TG @1begovoy-tasks-bot
(если делает Дмитрий руками):
- Все задачи которые **выполнены** → status=completed
- **Новые pending** для следующей сессии — TaskCreate
- Не оставляй задачу `in_progress` если она не выполняется в фоне

## Verify

После save протокола:

```bash
# Все репо чистые?
for d in ~/claude_code/*/; do
  cd "$d"
  s=$(git status -s 2>/dev/null | wc -l | tr -d ' ')
  [ "$s" != "0" ] && echo "DIRTY: $d ($s files)"
done
# Должно быть пусто (либо известный intentional WIP)

# Vault daily обновлён?
tail -20 "~/Documents/Obsidian Vault/daily/$(date +%Y-%m-%d).md"
# Должен видеть блок Сессия HH:MM

# Все sha запушены?
for d in ~/claude_code/*/; do
  cd "$d"
  unp=$(git log @{u}.. --oneline 2>/dev/null | wc -l | tr -d ' ')
  [ "$unp" != "0" ] && echo "UNPUSHED in $d: $unp commits"
done
```

## Сигнал успешного save

В чате прозвучало: **«Сохранено по протоколу save_protocol»** + sha
коммитов из всех репо.

Если этой фразы нет — что-то пропустил, проверь чеклист.

## Связано

- Memory `[[save_protocol]]` — детальный чеклист агента
- `~/.claude/skills/save/SKILL.md` — slash-command definition
- Memory `[[feedback_close_session_sync]]` — batch git sync при закрытии
