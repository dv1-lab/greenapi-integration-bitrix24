# SLA Template — Social Connector для партнёров

Шаблон соглашения об уровне сервиса (Service Level Agreement) для
коммерческих клиентов / партнёров Social Connector. Базируется на
технических SLO из `SLO.md`.

**Статус**: шаблон. Применяется когда появятся первые партнёры (сейчас
single-tenant, наш бизнес).

Last updated: 2026-05-26 (task #55).

---

## 1. Параметры

| Параметр | Базовый план | Pro план | Enterprise |
|---|---|---|---|
| **Uptime SLA** | 99.0% | 99.5% | 99.9% |
| **Allowed downtime / месяц** | 7ч 18м | 3ч 39м | 43м 49с |
| **First response time (рабочие часы)** | 4ч | 1ч | 15м |
| **Bug fix time (critical, P0)** | 2 раб. дня | 8 раб. часов | 4 раб. часа |
| **Bug fix time (high, P1)** | 5 раб. дней | 2 раб. дня | 1 раб. день |
| **API rate limit** | 1000 req/час | 10000 req/час | unlimited |
| **Backup retention** | 7 дней | 30 дней | 90 дней |
| **DR-test rehearsal** | annually | quarterly | monthly |
| **Compensation (service credit)** | до 10% MRR | до 25% MRR | до 50% MRR |

**Базовое окно расчёта**: календарный месяц МСК.

---

## 2. Что включается в Uptime / Downtime

### Downtime считается:
- HTTP 5xx error rate > 5% за период ≥ 5 мин на основных endpoints
- HTTP timeout > 30 сек на основных endpoints
- Adapter container не запускается > 5 мин подряд
- Customer-service /healthz не отвечает > 5 мин подряд

### Downtime НЕ считается:
- Запланированные maintenance windows (объявляются за 72 ч)
- Force majeure (DDoS, ЧС, природные бедствия)
- Внешние сервисы (B24 portal, Green API, i2crm) — это их SLA, не наш
- Клиентские ошибки (4xx коды)
- Бесплатные периоды (trials)

### Измерение
- **Источник**: Uptime Kuma (`up.9wb.ru`) + Healthchecks.io + adapter logs
- **Аудит**: партнёр получает access к dashboard за свои инстансы
- **Дисспу**: 7 дней на оспаривание measurement, разрешается через ticket

---

## 3. Response Time (FRT — first response time)

Час, когда инцидент задокументирован партнёром через ticket / email:

| Severity | Описание | Базовый | Pro | Enterprise |
|---|---|---|---|---|
| **P0 Critical** | Сервис полностью недоступен, есть business impact | 1ч | 30м | 15м |
| **P1 High** | Major feature broken, есть workaround | 4ч | 1ч | 30м |
| **P2 Medium** | Minor issue, не блокирует main flow | 1 раб. день | 4ч | 1ч |
| **P3 Low** | Feature request / cosmetic | 3 раб. дня | 1 раб. день | 4ч |

**Рабочие часы**: 10:00–19:00 МСК пн-пт. P0/P1 — 24/7 в Pro+ планах.

---

## 4. Bug fix SLA (resolution time)

| Severity | Базовый | Pro | Enterprise |
|---|---|---|---|
| P0 Critical | 2 раб. дня | 8 раб. часов | 4 раб. часа |
| P1 High | 5 раб. дней | 2 раб. дня | 1 раб. день |
| P2 Medium | 30 дней | 14 дней | 7 дней |
| P3 Low | best effort | 90 дней | 30 дней |

«Resolution» = фикс деплоен в prod, верифицирован партнёром.

**Исключения**:
- Issues требующие изменений у processor'ов (B24 / Green API / i2crm) —
  ETA определяется их сроками + 1 раб. день на наш integration
- Issues в данных партнёра (corrupted backup, человеческая ошибка) —
  T&M (time & materials), не SLA

---

## 5. Compensation (service credits)

Если downtime превышает allowed:

| % сверх SLA | Service credit (% от MRR) |
|---|---|
| < 0.1% | 5% |
| 0.1% – 1.0% | 10% |
| 1.0% – 5.0% | 25% |
| > 5.0% | 50% |
| **Catastrophic (>50% месяца)** | **100% + право на расторжение** |

Service credit = скидка на следующий счёт. **Не возмещение в деньгах** —
держит партнёра в сервисе, не оплачивает их business impact.

**Maximum credit per month** = 50% MRR (кроме catastrophic).

Запрос на compensation — в течение 30 дней после окончания месяца.

---

## 6. Excluded events (форс-мажор)

Не учитываются в uptime calculation:

1. **Force majeure**: природные бедствия, военные действия, эпидемии,
   государственные акты ограничивающие интернет (например, блокировки
   Роскомнадзора если не наша вина)
2. **DDoS attacks** требующие >24ч митigации на стороне Cloudflare/инфраструктуры
3. **Внешние сервисы** (B24, Green API, i2crm, MoySklad) — их SLA
4. **Партнёрская ошибка**: неверные API calls, неправильные настройки,
   credential leak с их стороны
5. **Запланированный maintenance**: объявлен за 72ч в status page

---

## 7. Responsibilities

### Со стороны провайдера (мы):
- Поддерживать 99.X% uptime
- Backup ежедневно + tested restore раз в N (см. таблицу планов)
- Threat model review раз в 6 мес
- Incident notifications: status page + email в течение 1ч после detect

### Со стороны партнёра:
- Не reverse-engineer-ить, не parse-ить HTML вместо API
- Использовать только документированные endpoints (см. `OPENAPI.md`)
- Не превышать rate limits (HTTP 429 → backoff)
- Хранить API ключи в безопасности; ротация раз в год обязательна
- Reporter ответственный за accurate severity ticket'ов

---

## 8. Уведомления и status page

| Канал | Что | Кому |
|---|---|---|
| **status.9wb.ru** (TODO #57) | Текущий incident statuses + history 90 дней | Public |
| **Email** | Major incidents > 30 мин | All admin contacts партнёра |
| **Telegram bot** (TODO) | All incidents + recovery | Designated channel партнёра |
| **Monthly report** | Uptime stats + service credits | Account contact |

Notification timing: in первые 15 мин после detect (через automated monitor).

---

## 9. Termination

- Партнёр может расторгнуть в любой момент после 30-дневного notice
- Провайдер расторгает: после 3 consecutive months catastrophic SLA breach
  OR нарушение партнёром §7 responsibilities
- **Data export** при расторжении — 30 дней на download через
  `/admin/export/*` endpoint
- **Data deletion** — 90 дней после расторжения, согласно 152-ФЗ retention

---

## 10. Изменения SLA

- Изменения параметров (uptime %, response time) — за **90 дней notice**
- Уменьшение SLA — даёт право партнёру расторгнуть без штрафа
- Улучшение SLA (новый план) — auto-upgrade или партнёр выбирает

---

## 📋 Checklist для активации (TODO когда придёт первый партнёр)

- [ ] Юридическая проверка (СПб юрист по IT-договорам)
- [ ] Договор поручения обработки (152-ФЗ ст. 6 п. 3) — см. `legal/152-FZ.md` §6
- [ ] Status page (status.9wb.ru) запущен — `#57`
- [ ] Automated uptime measurement доказуем (логи Uptime Kuma + Healthchecks)
- [ ] Service credit calc автоматически в monthly billing
- [ ] Severity triage runbook для партнёрских ticket'ов
- [ ] On-call rotation (если только Дмитрий — single point of failure, см.
      `SECURITY/ACCESS.md` backup-person)
- [ ] Compensation pool reserved в финансах (~20% MRR на случай breach)

---

## 📚 Связано

- [`../SLO.md`](../SLO.md) — технические SLO (источник для uptime %)
- [`../MONITORING.md`](../MONITORING.md) — как мериме uptime
- [`152-FZ.md`](./152-FZ.md) — обработка PII (передача партнёрам — отдельная глава)
- [`../RUNBOOKS/incident-response.md`](../RUNBOOKS/incident-response.md)
- ADR — конкретные изменения SLA (создавать при изменении планов)

---

**⚠️ Disclaimer**: шаблон, не финальный договор. Перед подписанием с
реальным партнёром — обязательная проверка юристом + adapt'ация под
конкретные business требования.
