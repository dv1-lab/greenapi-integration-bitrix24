# 📚 Документация Social Connector + B24

Карта-навигатор по документации. **Найди свою роль ниже** → перейди к
нужному файлу. Не пытайся прочитать всё сразу — это справочник, а не
учебник.

Last updated: 2026-05-26.

---

## 🎯 Я хочу...

### ...понять что вообще за платформа

→ **[`SOCIAL_CONNECTOR.md`](./SOCIAL_CONNECTOR.md)** — обзор сервиса
для нового человека (что такое, зачем нужно, какие компоненты).

→ **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** — техническая карта: какие
сервисы, как взаимодействуют, где живут.

### ...понять «как должно работать» (продуктовые правила)

→ **[`PRODUCT_RULES.md`](./PRODUCT_RULES.md)** ⭐ — **single source of
truth** для всех бизнес-правил. Когда создаётся лид, что показываем
в зеркале, как обрабатываем дубли клиентов. **Читать перед любой
B24-задачей.**

### ...уточнить термин («что такое лид? сессия? коннектор?»)

→ **[`GLOSSARY.md`](./GLOSSARY.md)** — точное значение всех терминов
в проекте.

### ...узнать «почему мы так сделали»

→ **[`decisions/`](./decisions/)** — ADR (Architecture Decision
Records). Каждый файл = одно решение с обоснованием и альтернативами.

### ...сделать рутинную операцию

→ **[`RUNBOOKS/`](./RUNBOOKS/)** — пошаговые рецепты:

| Что | Файл |
|---|---|
| Добавить новую open-line линию (WA/TG/MAX/IG) | [`add-new-open-line.md`](./RUNBOOKS/add-new-open-line.md) |
| Ротация Green API instance token | [`rotate-greenapi-token.md`](./RUNBOOKS/rotate-greenapi-token.md) |
| Backfill TG-клиентов в Customer-360 (раз в неделю) | [`backfill-tg-customer360.md`](./RUNBOOKS/backfill-tg-customer360.md) |
| Деплой adapter / bridge / dashboard | [`deploy-*.md`](./RUNBOOKS/) |
| Зависшая линия — что делать | [`restart-frozen-line.md`](./RUNBOOKS/restart-frozen-line.md) |
| Инцидент — триаж | [`incident-response.md`](./RUNBOOKS/incident-response.md) |
| Утёк секрет в transcript/git | [`secret-leak-recovery.md`](./RUNBOOKS/secret-leak-recovery.md) |
| Закрыть сессию работы (`/save`) | [`save-session.md`](./RUNBOOKS/save-session.md) |

### ...найти что было сломано раньше и как починили

→ **[`REGRESSIONS.md`](./REGRESSIONS.md)** — post-mortem всех багов.
Класс проблемы «не подтягивается open-line / дубль chat-user»
повторялся 5+ раз. Перед фиксом — сюда.

### ...узнать пороги SLA / времени

→ **[`SLA_RULES.md`](./SLA_RULES.md)** — пороги «ждёт ответа», «outgoing
зависло», FRT (время первого ответа), auto-take grace и т.д.

### ...понять конкретный канал (IG/WA/TG)

| Канал | Файл |
|---|---|
| Instagram (Direct + Comments) | [`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md) |
| WA / MAX / TG-shard через Green API | [`GREENAPI_CHANNELS.md`](./GREENAPI_CHANNELS.md) |
| Telegram-бот (@begovoy_bot и т.п.) | [`TELEGRAM_BOT_FLOW.md`](./TELEGRAM_BOT_FLOW.md) |
| Open-line жизненный цикл (общий для всех) | [`OPEN_LINE_LIFECYCLE.md`](./OPEN_LINE_LIFECYCLE.md) |

### ...понять Customer-360

→ **[`CUSTOMER360.md`](./CUSTOMER360.md)** — единая БД клиентов,
UUID, aliases, merge engine.

### ...подправить виджет или зеркало

→ **[`CHECKLIST_WIDGET.md`](./CHECKLIST_WIDGET.md)** — чек-лист правок
виджета (отсекает 80% типичных регрессий).

→ **[`CLIENT_CARD_STANDARD.md`](./CLIENT_CARD_STANDARD.md)** — единый
формат карточки клиента (для всех зеркал).

### ...подготовить восстановление сервиса с нуля

→ **[`SERVICE_BLUEPRINT.md`](./SERVICE_BLUEPRINT.md)** — disaster
recovery spec. Полная процедура «новый VPS → bootstrap → restic
restore» для каждого сервиса.

---

## 👥 По ролям — что читать

### 🧑‍💻 Новый разработчик (присоединился к команде)

**Day 1** — обязательное чтение в этом порядке:

1. [`../CLAUDE.md`](../CLAUDE.md) — правила работы агента (если читаешь
   как разработчик — тоже полезно, там жёсткие правила безопасности)
2. [`SOCIAL_CONNECTOR.md`](./SOCIAL_CONNECTOR.md) — обзор сервиса
3. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — карта компонентов
4. [`GLOSSARY.md`](./GLOSSARY.md) — термины
5. [`PRODUCT_RULES.md`](./PRODUCT_RULES.md) — что должно работать

**Day 2-3** — углубление по нужным каналам:

6. Свой канал интереса: `INSTAGRAM_FLOW.md` / `TELEGRAM_BOT_FLOW.md` /
   `GREENAPI_CHANNELS.md`
7. [`OPEN_LINE_LIFECYCLE.md`](./OPEN_LINE_LIFECYCLE.md)
8. [`CUSTOMER360.md`](./CUSTOMER360.md)

**Перед первой правкой:**

9. [`REGRESSIONS.md`](./REGRESSIONS.md) — что уже ломалось
10. [`CHECKLIST_WIDGET.md`](./CHECKLIST_WIDGET.md) — если трогаешь widget

### 🎧 Оператор (Анастасия / Кирилл / Олег)

→ **[`OPERATOR_GUIDE.md`](./OPERATOR_GUIDE.md)** — главное чтение.
Команды (`/n`, `/r`, `/t`, `/f`, `/d`, `/nnn`, `/bl`), как отвечать
на IG-коммент через «Цитировать», `!` префикс для Direct.

→ **[`SLA_RULES.md`](./SLA_RULES.md)** — какое время ответа целевое.

### 🧑‍💼 Дмитрий (владелец)

→ **[`PRODUCT_RULES.md`](./PRODUCT_RULES.md)** — фиксированные
продуктовые решения (это **твои** правила, читай и дополняй когда
появляется новое)

→ **[`../CHANGELOG.md`](../CHANGELOG.md)** — что недавно сделано
(что заметят операторы/клиенты)

→ **[`decisions/`](./decisions/)** — ADR с обоснованием решений

→ **[`SERVICE_BLUEPRINT.md`](./SERVICE_BLUEPRINT.md)** — disaster
recovery, нужно знать на случай если меня нет

### 🚨 Incident responder (включая Дмитрия в роли on-call)

В порядке вероятности нужности:

1. [`RUNBOOKS/incident-response.md`](./RUNBOOKS/incident-response.md) — триаж
2. [`RUNBOOKS/restart-frozen-line.md`](./RUNBOOKS/restart-frozen-line.md) — линия зависла
3. [`RUNBOOKS/secret-leak-recovery.md`](./RUNBOOKS/secret-leak-recovery.md) — утёк токен
4. [`RUNBOOKS/deploy-*.md`](./RUNBOOKS/) — экстренный rollback
5. [`REGRESSIONS.md`](./REGRESSIONS.md) — было ли такое раньше

### 👨‍🔧 DevOps / SRE

→ [`SERVICE_BLUEPRINT.md`](./SERVICE_BLUEPRINT.md) — полная DR spec

→ [`RUNBOOKS/`](./RUNBOOKS/) — все рецепты

→ [`SLA_RULES.md`](./SLA_RULES.md) — бизнес-SLA

→ [`MONITORING.md`](./MONITORING.md) — что-кому-куда алертит

→ [`DATA_MODEL.md`](./DATA_MODEL.md) — ERD всех таблиц (MySQL/PG/CH)

→ [`SEQUENCES.md`](./SEQUENCES.md) — sequence-диаграммы 5 критичных flow

→ [`SLO.md`](./SLO.md) — технические SLO + error budget

→ [`SECURITY/THREAT_MODEL.md`](./SECURITY/THREAT_MODEL.md) — STRIDE-анализ угроз

→ [`SECURITY/ACCESS.md`](./SECURITY/ACCESS.md) — access control matrix

→ [`TESTING.md`](./TESTING.md) — структура тестов и DI mock pattern

→ TODO: `PERFORMANCE.md` (P2)

---

## 📁 Полная структура

```
docs/
├── 📖 README.md (вы здесь)
├── 🎯 PRODUCT_RULES.md           ⭐ single source of truth
├── 🏗 ARCHITECTURE.md            — что-где-зачем
├── 🔤 GLOSSARY.md                — термины
├── ⏱ SLA_RULES.md                — пороги времени
├── 🚀 SOCIAL_CONNECTOR.md        — обзор сервиса
├── ♻️ SERVICE_BLUEPRINT.md       — disaster recovery
├── 🐞 REGRESSIONS.md             — post-mortem багов
├── 👤 OPERATOR_GUIDE.md          — UX операторов
├── ✓ CHECKLIST_WIDGET.md         — чек-лист виджета
├── 📋 CLIENT_CARD_STANDARD.md    — формат карточки
│
├── 📷 INSTAGRAM_FLOW.md          — IG детально
├── 📞 OPEN_LINE_LIFECYCLE.md     — open-line lifecycle
├── 📱 TELEGRAM_BOT_FLOW.md       — TG-бот
├── 📨 GREENAPI_CHANNELS.md       — Green API каналы
├── 👥 CUSTOMER360.md             — единая БД клиентов
├── 🗄 DATA_MODEL.md              — ERD всех таблиц (MySQL/PG/CH)
├── 🔀 SEQUENCES.md               — sequence-диаграммы 5 критичных flow
├── 🎯 SLO.md                     — технические SLO + error budget
├── 📡 MONITORING.md              — что-кому-куда алертит
├── 🧪 TESTING.md                 — структура тестов
│
├── 💡 decisions/                 — ADR
│   ├── README.md                   формат + правила
│   └── 2026-05-26-*.md             конкретные решения
│
└── 🔧 RUNBOOKS/                  — пошаговые рецепты
    ├── README.md                   индекс
    ├── add-new-open-line.md
    ├── rotate-greenapi-token.md
    ├── backfill-tg-customer360.md
    ├── save-session.md
    ├── deploy-adapter.md
    ├── deploy-bridge.md
    ├── deploy-dashboard.md
    ├── incident-response.md
    ├── restart-frozen-line.md
    └── secret-leak-recovery.md
```

---

## 📝 Что ещё запланировано (backlog)

См. список задач (`/tasks` через task-tracker):

**P0 — критично:**
- #44 Smoke-тесты критичных flow adapter
- #45 Monitoring plan (что-кому-куда алертит)
- #46 DR-test (симуляция падения сервера, замер времени восстановления)

**P1 — этой неделей/месяцем:**
- #47 Data model ERD (Mermaid)
- #48 Sequence diagrams критичных flow
- #49 SLOs для сервисов + error budget

**P2 — квартал:**
- #50 Threat model
- #51 Access control matrix
- #52 OpenAPI для adapter
- #53 Performance baselines

**P3 — когда появятся партнёры:**
- #54 152-ФЗ / GDPR compliance
- #55 SLA contracts
- #56 Public API / Developer portal
- #57 Status page

---

## 🤝 Как обновлять документацию

**Перед изменением кода:**
1. Проверить PRODUCT_RULES — есть ли уже правило
2. Проверить REGRESSIONS — было ли уже сломано

**После изменения кода:**
1. **Code commit** — самоочевидно
2. Если был **баг** → REGRESSIONS.md
3. Если **новое продуктовое правило** → PRODUCT_RULES.md
4. Если **архитектурное решение** → decisions/ADR
5. Если **операторам важно знать** → CHANGELOG.md + OPERATOR_GUIDE.md
6. Если **новая регулярная операция** → RUNBOOKS/
7. Если **меняется flow** → соответствующий *_FLOW.md
8. Если **меняется инфра** → SERVICE_BLUEPRINT.md
9. Если **полезно для агента** → memory `~/.claude/.../memory/`
10. Закрытие сессии — `/save` slash или RUNBOOKS/save-session.md

**Каждое из этих мест обновляется через одно действие — не пропускай.**

---

## 📞 Контакт

- **Владелец:** Дмитрий Кузнецов
- **Bitwarden master:** Дмитрий (single point of failure — см. P2 #51)
- **Tech-monitor alerts:** Telegram @agent_dv_bot
- **Customer-360 admin:** Дмитрий через KBD-Admin TG-чат
- **GitHub repos:** [`dv1-lab`](https://github.com/dv1-lab) (private)
