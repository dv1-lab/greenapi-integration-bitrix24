# ADR 2026-05-26: Перенос UF_CRM_*_CHAT_ID с лида на контакт при конверсии

> ⚠️ **Поправка 27.05.2026**: Изначально я думал подписаться на отдельное
> событие `ONCRMLEADCONVERT`. При попытке `event.bind` B24 вернул **HTTP 400**
> — этого события **не существует** в их REST API. Реальный механизм:
> детектировать конверсию внутри `ONCRMLEADUPDATE` через
> `snap.STATUS_ID === "CONVERTED"`. Раздел «Решение» ниже актуализирован.

## Контекст

При конверсии лида в контакт B24 **не наследует** кастомные UF поля автоматически.
Поэтому после конверсии:

- На **лиде** остаются `UF_CRM_TG_CHAT_ID` / `UF_CRM_MAX_CHAT_ID` / `UF_CRM_IG_CHAT_ID`,
  проставленные `backfillSendLead` или `_maybeLinkOrphanLead`
- На **новом контакте** эти поля **пусты**

Следствие — при следующем входящем от того же клиента (в TG/MAX/IG):
- `ensureLeadForPhone` не найдёт контакт через `crm.contact.list filter[UF_CRM_*_CHAT_ID]`
- `_maybeLinkOrphanLead` для outgoing-side тоже промахнётся
- B24 создаст **дубль контакта** или **новый orphan-лид**, или клиент потеряется

Затронуты все каналы с собственным UF: TG (номер магазина 4100621194, 4100624465),
MAX (3100621187), Instagram (i2crm), оба TG-бота (`@begovoy_bot` line 8,
`@begovoy1support_bot` line 206). WhatsApp **не затронут** — там идентификатор
phone, B24 наследует стандартное поле при конверсии.

## Решение (актуально на 27.05.2026)

Детектировать конверсию внутри уже-подписанного `ONCRMLEADUPDATE`:
B24 при конверсии лида ставит `STATUS_ID="CONVERTED"`. В `handleB24CrmEvent`
после `crm.lead.get` снимка:

```ts
if (entity === "lead" && action === "updated" && snap.STATUS_ID === "CONVERTED") {
  await this._propagateChatIdsOnConvert(portalDomain, leadId);
}
```

Это идёт **рядом** с orphan-link для ONCRMLEADADD, до Customer-360 sync.
Try/catch внутри чтобы ошибка не сорвала остальную обработку.

**Почему не отдельным event'ом:** при попытке `event.bind` для `ONCRMLEADCONVERT`
B24 REST вернул `HTTP 400`. Документация B24 не описывает этот event как
доступный для подписки.

`_propagateChatIdsOnConvert`:
1. `crm.lead.get` — текущий снапшот лида (B24 уже проставил CONTACT_ID)
2. Если `CONTACT_ID = 0` → no-op (лид сконвертился в сделку/компанию без контакта)
3. Для каждого из 3 UF — собираем то что стоит на лиде
4. Если ни один UF не стоит → no-op (нечего переносить)
5. `crm.contact.get` — читаем что **уже** на контакте
6. Для каждого UF: если на лиде есть И на контакте пусто → добавляем в
   `fieldsToUpdate`
7. Если есть что апдейтить → `crm.contact.update`

Идемпотентность: повторный `ONCRMLEADCONVERT` (B24 может ретраить или дублировать)
не перетирает существующее значение на контакте.

## Постфактум-починка

`POST /webhooks/internal/propagate-chat-ids`:
```json
{"leadId": 12345}
```
Header `X-Hint-Secret: $BRIDGE_HINT_SECRET`. Вызывает ту же логику —
для лидов сконвертированных **до** деплоя этого listener'а.

## Что НЕ делаем

- **Не переносим в сделку**. У сделки нет UF_CRM_*_CHAT_ID (по дизайну портала),
  чат-привязка идёт через CONTACT_ID сделки → UF контакта.
- **Не перетираем** значение на контакте если оно уже стоит. Это могло быть
  установлено ранее `ensureLeadForPhone` или ручным merge — нашему фиксу
  доверять больше чем существующему значению нет оснований.
- **Не подписываемся на `ONCRMCONTACTADD`** как альтернативу. Контакт может
  быть создан без конверсии лида (например, B24 операторами вручную) —
  тогда у нас вообще нет UF которые надо переносить.

## Связь с другими листенерами

| Событие | Триггер | Что делает |
|---|---|---|
| `ONCRMLEADADD` | Создан новый лид | `_maybeLinkOrphanLead` — если orphan от native UI, ищет существующий контакт по UF/phone и привязывает |
| `ONCRMLEADUPDATE` | Изменение полей лида | Customer-360 sync (diff snapshot → KBD-лента) |
| **`ONCRMLEADCONVERT`** | **Лид сконвертирован** | **`_propagateChatIdsOnConvert` — переносит UF с лида на контакт** |
| `ONCRMCONTACTADD` | Создан новый контакт | Customer-360 auto-promote (выдача `customer_no`) |
| `ONCRMCONTACTUPDATE` | Изменение полей контакта | Customer-360 sync |

## Risks / failure modes

- **B24 шлёт ONCRMLEADCONVERT с другим payload форматом** (не `data.FIELDS.ID`)
  → handler промахнётся, лог `no entity id`. Решение: после деплоя поймать
  пример payload из лога B24-event при первой реальной конверсии, если поле
  не `FIELDS.ID` — поправить.
- **Конверсия в компанию** → CONTACT_ID лида может остаться 0, перенос
  не сработает. Это допустимо — корпоративный клиент, UF чат-привязки
  смысла не имеют.
- **Race с другим update**: B24 в момент конверсии иногда шлёт несколько
  событий подряд (CONVERT + UPDATE + CONTACTADD). Если CONVERT пришёл
  раньше чем B24 успел проставить CONTACT_ID — `crm.lead.get` вернёт
  `CONTACT_ID=0`, перенос не пройдёт. Защита: после деплоя если ловим
  такой паттерн в логах — добавить ретрай через 2-3 секунды (пока не нужно).

## Verify

После деплоя:
1. Перерегистрировать b24-events: `POST /webhooks/internal/register-b24-events`
   (новый ONCRMLEADCONVERT должен забиндиться)
2. Найти любой свежий сконвертированный лид с непустым `UF_CRM_TG_CHAT_ID`
   (через `crm.lead.list filter[!UF_CRM_TG_CHAT_ID]=` + `filter[STATUS_ID]=CONVERTED`)
3. Сравнить с контактом которому он был привязан — если на контакте поле
   пусто, можно вызвать `POST /internal/propagate-chat-ids` чтобы поправить
4. После первой реальной конверсии — посмотреть лог `convert lead=... →
   contact=...: propagated UF_CRM_*_CHAT_ID=...`

## Связано

- задача #69 (P1, in_progress)
- ADR `2026-05-26-orphan-lead-linker.md` — родственный listener (ONCRMLEADADD)
- `bitrix24.service.ts:_propagateChatIdsOnConvert` — реализация
- `bitrix24.service.ts:propagateChatIdsByLeadId` — REST-обёртка
- PRODUCT_RULES.md §1.1 — общее правило про лидогенерацию
