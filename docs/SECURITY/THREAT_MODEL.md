# Threat Model — Social Connector ecosystem

Систематический анализ угроз и attack surfaces по методологии **STRIDE**
(Spoofing, Tampering, Repudiation, Information disclosure, Denial of
service, Elevation of privilege).

Цель — выявить атак-векторы, оценить риск, зафиксировать митигации (что
уже сделано) и gap'ы (что нужно). Документ — input для compliance #54,
incident response, audit.

Last reviewed: 2026-05-26 (task #50). **TODO: пересматривать раз в 6 месяцев.**

---

## 🎯 Scope

Сервисы:
- **adapter** (`social.9wb.ru`, NestJS на my-server)
- **customer-service** (`127.0.0.1:3002`, NestJS)
- **wa-tg-bridge** (Python, my-server)
- **dv-dashboard** (`dashboard.9wb.ru`, Next.js)
- **MySQL adapter** + **Postgres customer-service** + **ClickHouse customer360**

Out of scope:
- Bitrix24 portal (управляется Битрикс24, мы потребители)
- Green API SaaS (управляется Green API)
- i2crm Public API (управляется i2crm)
- Telegram, Instagram (платформы)

---

## 🏗 Trust boundaries

```
┌──────────────────────────────────────────────────────────────────┐
│ Internet (untrusted)                                             │
│                                                                  │
│  - Green API webhooks (HTTPS)                                    │
│  - B24 webhooks (HTTPS, OAuth)                                   │
│  - i2crm webhooks (HTTPS)                                        │
│  - Operator browsers (Bitrix24 UI, dashboard.9wb.ru)             │
└──────────────────────────────────────────────────────────────────┘
                           ↓ Caddy (TLS termination, basic_auth для dashboard)
┌──────────────────────────────────────────────────────────────────┐
│ my-server (trusted bastion)                                      │
│ Tailscale: 100.76.30.25                                          │
│                                                                  │
│  ┌──────────────────────────────────────────────┐                │
│  │ adapter (Docker source-adapter-1) :3000      │                │
│  │ customer-service (host) :3002                │                │
│  │ wa-tg-bridge (systemd) — outbound only       │                │
│  │ dv-dashboard (host) :3001                    │                │
│  └──────────────────────────────────────────────┘                │
│                ↓ TCP localhost                                   │
│  ┌──────────────────────────────────────────────┐                │
│  │ MySQL :3306 (Docker source-db-1, named vol)  │                │
│  │ Postgres :5432 (Docker)                      │                │
│  │ ClickHouse :8123 (host)                      │                │
│  └──────────────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────────┘
                           ↓ Tailscale (encrypted overlay)
┌──────────────────────────────────────────────────────────────────┐
│ Mac (Дмитрий, trusted operator console)                          │
│                                                                  │
│  - VS Code + Claude Code                                         │
│  - SSH ключи в Keychain                                          │
│  - Bitwarden (vault для secrets)                                 │
│  - Obsidian Vault                                                │
└──────────────────────────────────────────────────────────────────┘
```

**Главные trust boundaries:**
1. **Internet → Caddy** — TLS termination + rate-limiting (basic)
2. **Caddy → adapter/customer-service** — внутренний 127.0.0.1, secrets
   через `.env` файлы (не в git)
3. **adapter → MySQL** — DATABASE_URL в .env, MySQL не слушает наружу
4. **adapter → customer-service** — `X-Service-Secret` HMAC
5. **wa-tg-bridge → adapter** — `X-Hint-Secret` HMAC на `/webhooks/internal/*`

---

## 🎭 STRIDE Analysis

### S — Spoofing identity (выдача себя за другого)

| # | Угроза | Сейчас | Риск | Митигация / Gap |
|---|---|---|---|---|
| S1 | Подделанный Green API webhook | Нет HMAC-проверки signature | 🟠 Medium | **Gap**: Green API не предоставляет HMAC. Митигация: rate-limit + структурная валидация payload + IP allowlist (TODO) |
| S2 | Подделанный B24 webhook | `applicationToken` validation | 🟢 Low | OK: каждый webhook проверяет `auth.application_token` |
| S3 | Подделанный i2crm webhook | Нет signature | 🟠 Medium | **Gap**: i2crm не предоставляет HMAC. Spoofing → fake messages в B24. Митигация: payload validation + IP allowlist (TODO) |
| S4 | Spoofing wa-tg-bridge → adapter | `X-Hint-Secret` HMAC | 🟢 Low | OK |
| S5 | Spoofing pretending to be operator в TG-зеркале | TG handle + manual check | 🟠 Medium | Любой в TG-группе может ответить через bridge. **Gap**: проверка `from_user.id ∈ allowed_operators` (TODO) |
| S6 | OAuth-токен B24 утечёт → spoof B24 portal | Локально в БД | 🟠 Medium | Митигация: refresh_token rotation B24-side. **Gap**: если accessToken прочитают (см. ниже I1) — могут изобразить наш app |
| S7 | Подделка customer_uuid в request к customer-service | Header `X-Service-Secret` | 🟢 Low | OK: secret в .env |

### T — Tampering (модификация данных)

| # | Угроза | Сейчас | Риск | Митигация / Gap |
|---|---|---|---|---|
| T1 | Прямая модификация MySQL adapter | Docker localhost only | 🟢 Low | OK: MySQL не слушает 0.0.0.0 |
| T2 | Прямая модификация Postgres customer-service | Docker localhost | 🟢 Low | OK |
| T3 | Modify `customer_aliases` (вручную перепривязать клиента) | Только через SSH к my-server | 🟠 Medium | Дмитрий может через psql. **Gap**: нет audit log изменений в БД (только в коде через `CustomerMerge`) |
| T4 | TamperWith `oc_theme` через ClickHouse | Out of scope (не наш) | n/a | — |
| T5 | Modify webhook payload in flight | TLS защищает | 🟢 Low | OK: HTTPS всех webhook'ов |
| T6 | Tamper Prisma migrations | Git репо, нужны write rights | 🟠 Medium | Митигация: GitHub branch protection не настроена. **Gap**: один push в main может сломать миграции |
| T7 | Reorder/replay i2crm events | I2crmEventLog.messageId UNIQUE | 🟢 Low | OK: upsert prevents replay |
| T8 | Replay outgoing-status webhook | `lastStatusSeen` dedup | 🟢 Low | OK (см. tests #58) |

### R — Repudiation (отказ от действий)

| # | Угроза | Сейчас | Риск | Митигация / Gap |
|---|---|---|---|---|
| R1 | Оператор отправил спорное сообщение, отрицает | TG-зеркало хранит ID оператора | 🟢 Low | OK: B24 chat history + TG mirror logs |
| R2 | Кто сделал merge UUID | `CustomerMerge.byUser` | 🟢 Low | OK: записывается user |
| R3 | Кто изменил OAuth-токен в БД | Нет audit log | 🟠 Medium | **Gap**: ручные UPDATE в БД не аудируются |
| R4 | Action в dashboard | Basic_auth, single user | 🟡 Medium | Только Дмитрий → недвоюзначность. Через #51 backup-person — может стать вопрос |
| R5 | OAuth refresh — кто вызвал | Logs в adapter | 🟢 Low | OK: logs с request_id |

### I — Information disclosure (утечка данных)

| # | Угроза | Сейчас | Риск | Митигация / Gap |
|---|---|---|---|---|
| **I1** | **`.env` файл утечёт** | `chmod 600`, gitignored | 🔴 **High** | OAuth token + Green API tokens + MySQL pwd + i2crm key. **Утечка = полный compromise.** Митигация: ротация (см. SECRETS.md), Bitwarden master copy |
| I2 | Логи с PII (имя клиента, ФИО, телефон) | Docker logs `docker logs --tail` | 🟠 Medium | adapter логи содержат `chatId, customer_uuid`. **Gap**: нет log rotation policy, нет PII redaction (только masking токенов) |
| I3 | DB dump compromise | Backup на Я.Диск (restic encrypted) | 🟢 Low | OK: restic шифрует с master pw в Bitwarden |
| I4 | ClickHouse query unauthorized | reader/writer users + password | 🟢 Low | OK |
| I5 | Postgres exposed | Docker localhost only | 🟢 Low | OK |
| I6 | Adapter response leaks (error stack traces в production) | NestJS default error filter | 🟠 Medium | **Gap**: prod NODE_ENV не выставлен → stack traces в HTTP 500 ответах |
| I7 | Public dv-dashboard scrape | Caddy basic_auth | 🟢 Low | OK: один user/pass |
| I8 | Telegram bot token leak | `.env` GREEN_*_TOKEN | 🔴 High | См. I1 |
| I9 | Customer data в transcript Claude Code | Дмитрий явно избегает (memory rules) | 🟡 Low-Medium | Митигация: pbpaste/ssh-pipe для секретов, маскирование |
| I10 | Customer phone в logs adapter | Логируется как `chatId` (telephone)  | 🟠 Medium | **Gap**: GDPR/152-ФЗ — это PII. Нужно log retention policy |
| I11 | Git history содержит секреты | Сейчас вряд ли, но был факап 25.05 | 🟠 Medium | **Gap**: периодический scan через trufflehog (TODO) |

### D — Denial of Service

| # | Угроза | Сейчас | Риск | Митигация / Gap |
|---|---|---|---|---|
| D1 | Flood webhooks на adapter | Caddy без rate-limit для `/webhooks/*` | 🟠 Medium | **Gap**: rate-limit per IP в Caddy (TODO) |
| D2 | B24 OVERLOAD_LIMIT (обратное DoS) | OAuth retry с backoff | 🟢 Low | OK: I2crmEventLog journal + replay |
| D3 | MySQL connection pool exhaustion | Prisma default pool (~10) | 🟡 Medium | **Gap**: при пике flood — Prisma queue полная, новые запросы 500 |
| D4 | Disk fill from logs | Нет log rotation | 🟠 Medium | **Gap**: monitor-bot daily disk check (есть), но >85% алерт не настроен (см. MONITORING gap) |
| D5 | ClickHouse fill from events | partition'ы по месяцам, ручной cleanup | 🟡 Medium | **Gap**: нет автоматического `DROP PARTITION` policy |
| D6 | Slowloris-style attack on Caddy | Caddy timeouts default | 🟢 Low | OK |
| D7 | DoS через тяжёлые dashboard queries | Caddy single user | 🟢 Low | OK: за basic_auth |
| D8 | i2crm flood (одна Insta-кампания) | I2crmEventLog без rate-limit | 🟠 Medium | Cathedral attack: бот спам в Direct → много incoming events. Митигация: бот-фильтр в B24 (TODO) |

### E — Elevation of privilege

| # | Угроза | Сейчас | Риск | Митигация / Gap |
|---|---|---|---|---|
| E1 | RCE через webhook deserialization | NestJS validates DTO | 🟢 Low | OK: class-validator |
| E2 | SQL injection через Prisma | Prisma parameterizes | 🟢 Low | OK |
| E3 | SSH-bastion compromise (взлом my-server) | passwordless ed25519, no root login | 🟡 Medium | Митигация: Tailscale + key-only. **Gap**: fail2ban не настроен |
| E4 | Docker escape (adapter контейнер → host) | Не запускаем `--privileged` | 🟢 Low | OK |
| E5 | OAuth-token к B24 → spoof Customer-360 app | Per-appKind lock | 🟢 Low | OK (см. SEQUENCES #5) |
| E6 | Container с CVE | apt-update во время `docker compose up --build` | 🟡 Medium | **Gap**: автоматический CVE scan (Trivy/Snyk) не настроен |
| E7 | npm supply chain | pnpm@10 pinned (см. memory `[[feedback_pnpm_supply_chain_policy]]`) | 🟢 Low | OK |
| E8 | Compromised Claude Code → автоматическая публикация в B24 | Дмитрий контролирует Bash approvals | 🟢 Low | OK |

---

## 🔥 Топ-5 рисков

По приоритету = (risk × impact):

| # | Что | Митигация now |
|---|---|---|
| 1 | **I1: `.env` утечка** = compromise всего | Bitwarden + ротация, Pro Premium (#51) |
| 2 | **I10: Customer PII в logs** = GDPR/152-ФЗ риск | Pending log retention policy + redaction |
| 3 | **D1+D8: webhook flood** = downtime adapter | Pending: Caddy rate-limit + IP allowlist для GA/i2crm |
| 4 | **S1+S3: подделанный webhook** = false messages в B24 | Pending: IP allowlist + payload-fingerprint |
| 5 | **E3: my-server compromise** = full game over | Tailscale + key-only OK, **fail2ban TODO** |

---

## 📋 Действия (приоритизированный TODO)

### P0 (этот квартал)

- [ ] **Caddy rate-limit для `/webhooks/*`** — 100 req/sec per IP, 429 при превышении
- [ ] **IP allowlist для i2crm + Green API webhooks** — из их публичных доках known IPs
- [ ] **fail2ban на my-server** — SSH brute force защита
- [ ] **Log retention + PII redaction** для adapter logs (152-ФЗ)
- [ ] **NODE_ENV=production set** в Docker .env, чтобы NestJS не отдавал stack traces

### P1 (следующий квартал)

- [ ] **Trufflehog scan repo раз в неделю** — поиск утёкших секретов в git history
- [ ] **Trivy/Snyk scan Docker images** — CVE alerts
- [ ] **DB audit log** для customer_aliases / customer_merges (триггеры PG)
- [ ] **ClickHouse partition rotation** — автоматический DROP старше 12 мес
- [ ] **GitHub branch protection** для main (review требуется) — opt-out пока есть PR-flow

### P2 (когда дойдут руки)

- [ ] **Postgres connection pool monitoring** + алерт > 80% utilisation
- [ ] **MySQL connection pool monitoring**
- [ ] **HMAC-проверка для B24 webhook** (доп. layer поверх applicationToken)
- [ ] **DDoS-protection Cloudflare** (но не Tunnel, см. memory)

### P3 (когда придут партнёры)

- [ ] **WAF (Web Application Firewall)** — actual Cloudflare WAF
- [ ] **SSO для backup-person** через Bitwarden Emergency Access (см. #51)
- [ ] **Disaster recovery test** (#46)

---

## 🎯 Использование документа

- **Incident response**: после инцидента — сверять с этой таблицей, какие
  митигации сработали/не сработали → обновлять
- **Compliance #54**: PII handling, log retention — отсюда
- **Onboarding backup-person**: что бы они должны знать про угрозы
- **Регулярный аудит**: раз в 6 мес пройти по STRIDE заново, отметить
  изменения (новые сервисы → новые угрозы)

## 📚 Связано

- [`ACCESS.md`](./ACCESS.md) — access control matrix (S/R)
- [`DATA_MODEL.md`](../DATA_MODEL.md) — что атаковать (PII в каких таблицах)
- [`MONITORING.md`](../MONITORING.md) — какие угрозы детектим
- [`SLO.md`](../SLO.md) — какие SLO под угрозой при инциденте
- `RUNBOOKS/secret-leak-recovery.md` — реакция на I1/I8
- `RUNBOOKS/incident-response.md` — общий incident response
