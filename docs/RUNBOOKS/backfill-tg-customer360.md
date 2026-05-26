# Runbook: backfill TG-клиентов в Customer-360 (merge с B24)

## Когда применять

- Раз в **неделю** профилактически — собирает дубли которые merge engine не нашёл
- После массового onboarding клиентов (большое количество новых TG-чатов)
- Когда замечаем что в dashboard `/customer/<uuid>` для TG-клиента «Нет связанных сущностей B24» — хотя в B24 он есть

## Проблема которую решает

Bridge.py эмитит `message_in` с `resolve_alias=tg_user`, но без `b24_lead_id`.
Adapter не получает `lead_added` event для TG-канала. Итог: для одного
TG-клиента в Customer-360 могут быть **два UUID**:
- sole-TG UUID (только `tg_user` alias)
- B24-side UUID (`phone`, `b24_lead`, `b24_contact`)

Merge engine не предлагает merge — нет общего alias. Этот backfill
**вручную** связывает через `B24 lead.UF_CRM_TG_CHAT_ID = tg_user`.

См. memory `[[merge_rule_tg_chat_id]]`.

## Prerequisites

- SSH my-server
- `.secrets/backfill-webhook.url` (B24 webhook)
- customer-service .env (SERVICE_SECRET)

## Шаги

### 1. Подготовить скрипт

Скрипт лежит в репо: `/home/dv/customer-360-backfill/backfill_tg_merge.sh`
(если его там нет — скопировать из `decisions/2026-05-26-tg-backfill-script.sh`
или из transcript — он маленький, ~50 строк).

### 2. Dry-run — посмотреть scope

```bash
ssh my-server "
  PGU=\$(grep POSTGRES_USER /home/dv/customer-service/.env | cut -d= -f2)
  PGD=\$(grep POSTGRES_DB /home/dv/customer-service/.env | cut -d= -f2)
  docker exec customer-service-db-1 psql -U \"\$PGU\" -d \"\$PGD\" -c \"
    WITH tg_uuids AS (
      SELECT customer_uuid, alias_value AS tg_user FROM customer_aliases WHERE alias_type='tg_user'
    )
    SELECT count(*) sole_tg_count FROM tg_uuids t
    WHERE NOT EXISTS (
      SELECT 1 FROM customer_aliases a
      WHERE a.customer_uuid=t.customer_uuid
        AND a.alias_type IN ('phone','b24_lead','b24_contact','b24_deal')
    )
  \"
"
```

Если 0 — нечего делать. Если ~10-50 — норма (новые TG-клиенты). Если
сотни — что-то сломалось с adapter, разбираться отдельно.

### 3. Запустить backfill

```bash
ssh my-server "bash /home/dv/customer-360-backfill/backfill_tg_merge.sh"
```

Скрипт логирует каждое действие:
- `MERGE uuid=… tg=… → <target>` — успешно слили
- `SKIP[group] uuid=… tg=-100…` — TG-группа, не клиент
- `NO_B24 uuid=… tg=…` — нет лида в B24 с этим TG_CHAT_ID (нормально для лидов которые не успели создаться)
- `ADD_ALIASES uuid=…` — добавили aliases напрямую (если b24-side UUID не было)

В конце — SUMMARY.

### 4. Verify

```bash
# Случайно выбрать один merged UUID и проверить через API
ssh my-server "
  curl -s 'http://127.0.0.1:3002/customers/<uuid>/aliases' \
    -H \"X-Service-Secret: \$(grep SERVICE_SECRET /home/dv/customer-service/.env | cut -d= -f2)\"
"
```

Должны быть aliases от обоих исходных UUIDs (phone + tg_user + b24_*).

Открыть `dashboard.9wb.ru/customer/<uuid>` — должны быть видны B24
сущности (лиды, контакт, сделки).

## Rollback

`POST /customers/unmerge` для каждого merge id:
```bash
SECRET=$(ssh my-server "grep SERVICE_SECRET /home/dv/customer-service/.env | cut -d= -f2")
curl -X POST http://my-server:3002/customers/unmerge \
  -H "X-Service-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sourceUuid": "<source>", "byUser": "rollback"}'
```

⚠️ Unmerge восстанавливает source UUID, но **не** восстанавливает
исходный набор aliases (всё в target). После unmerge нужно вручную
переписать tg_user обратно в source.

В большинстве случаев лучше **не** откатывать — а **через UI** скорректировать
если что-то не так.

## Связано

- `PRODUCT_RULES.md §1.2` — правила дублей и merge
- Memory `[[merge_rule_tg_chat_id]]`, `[[customer_360_split_b24]]`
- Customer-service code: `src/customers/customers.service.ts` метод `merge`
- ADR от 2026-05-26 (Евгения и 6 других tg-merge'нуты вручную)
