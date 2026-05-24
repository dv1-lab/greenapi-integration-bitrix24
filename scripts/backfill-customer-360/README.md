# Customer-360 historical backfill

Разовый скрипт исторического импорта из B24 в `customer-service` + `customer_events`.

5 стадий:
1. `contacts` — `crm.contact.list` → find-or-create + aliases (phone/email/UF chats) + `contact_added` event
2. `leads` — `crm.lead.list` → resolveAlias → `lead_added` (+ `lead_updated` для CONVERTED/JUNK)
3. `deals` — `crm.deal.list` → `deal_added` / `deal_won` / `deal_lost`
4. `calls` — `voximplant.statistic.get` → `call_in` / `call_out` / `call_missed*`
5. `openlines` — `crm.activity.list?PROVIDER_ID=IMOPENLINES_SESSION` + B24 `batch` для `imopenlines.session.history.get` → `session_opened` + per-message `message_in/out/session_event`

Особенности:
- Resumable: `state.json` checkpoint каждые 50 entity, atomic rename.
- `skipKbd=true` — не пушим события в KBD-bridge при массовом импорте.
- B24 token bucket: 5 req/s (concurrent через semaphore=5).
- customer-service local concurrency=32.
- Permanent errors (`ACCESS_DENIED`, `INVALID_SESSION_ID`, …) не retry'им.
- Логи маскируют B24 webhook-token через `SecretRedactor`.

## Запуск

На my-server:
```bash
cd /home/dv/customer-360-backfill   # или куда переехало после копирования
.venv/bin/pip install httpx          # один раз
.venv/bin/python backfill.py all     # или один стейдж: contacts|leads|deals|calls|openlines
```

В tmux для ночного прогона:
```bash
tmux new-session -d -s c360-backfill \
  "cd /home/dv/customer-360-backfill && .venv/bin/python backfill.py openlines 2>&1 | tee -a backfill.log"
```

## Секреты

- `/home/dv/.secrets/backfill-webhook.url` — inbound webhook B24 со scope
  `crm + voximplant + im + imopenlines + user + telephony`.
- `/home/dv/customer-service/.env` `SERVICE_SECRET` — для customer-service API.

## Прогон 2026-05-23/24

Contacts/leads/deals/calls — ночью (7ч 47мин), 523k событий, 162.5k customers.
Openlines — днём 2026-05-24, ~10-12 часов, прогноз ~1.5-2M событий.
