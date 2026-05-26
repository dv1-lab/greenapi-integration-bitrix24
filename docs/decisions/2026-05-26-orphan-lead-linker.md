# ADR 2026-05-26: Orphan-lead linker через ONCRMLEADADD

## Контекст

Симметричная половинка к ADR `2026-05-26-ig-comments-attach-to-open-entity`
и правилу 1.1 PRODUCT_RULES.md. Там зафиксировано: «новый лид только
если у клиента нет открытых сущностей». Здесь — как заставить это
работать для outgoing-side, когда менеджер пишет клиенту первым.

### Триггер

Лид [#361428](https://1begovoy.bitrix24.ru/crm/lead/details/361428/),
26.05.2026, MAX-чат `32656502` (Орлов Владислав):

- Менеджер открыл карточку клиента в B24, нажал кнопку Social Connector
  во вкладке клиента, ввёл сообщение, отправил.
- B24 создал **новый orphan-лид**:
  - `TITLE`: `32656502 - MAX 79584983354`
  - `NAME`: `32656502` (chat_id, не имя клиента)
  - `CONTACT_ID`: **None**
  - `UF_CRM_MAX_CHAT_ID`: пусто
  - `STATUS_ID`: NEW
- В логах adapter (`source-adapter-1`) **нет** строк `[widget]`,
  `backfillSendLead`, `ensureOpenLeadForPhone` за этот период.

Менеджер написал через **native B24 OpenLine UI**, наш widget/send
endpoint не дёргался. `backfillSendLead` правит ровно эту проблему,
но только для widget-пути — для native UI он не вызывается.

## Решение

Использовать уже подписанное событие **ONCRMLEADADD** (адаптер слушает
его для Customer-360 sync) как триггер для orphan-link. Внутри
`handleB24CrmEvent` после `crm.lead.get` снимка — проверяем orphan-ность,
если orphan и TITLE парсится — пробуем достроить связи.

### Что считается orphan

1. `CONTACT_ID` пуст ИЛИ
2. все UF_CRM_*_CHAT_ID (`TG`, `MAX`, `IG`) пусты

И TITLE матчит pattern `<chat_id> - <CHANNEL> <phone?>` (native B24
кладёт такой формат при создании лида из OpenLine UI).

### Алгоритм linkOrphanLead

1. Парс TITLE → `chatId`, `channelLabel`, `phoneFromTitle`
2. Поиск контакта в B24:
   - По `UF_CRM_*_CHAT_ID` = `chatId` для каналов с собственным UF
     (Telegram/MAX/Instagram)
   - Fallback по PHONE если есть phone в TITLE (единственный путь для WA —
     UF_CRM_WA_CHAT_ID на портале 1begovoy.bitrix24.ru не используется)
3. Если контакт **не найден** → лог + оставить orphan (это реально новый
   клиент, обычное поведение)
4. Если контакт найден → поиск открытой сущности у контакта:
   - `crm.deal.list filter[CONTACT_ID]=X filter[CLOSED]=N` (приоритет)
   - Если сделок нет → `crm.lead.list filter[CONTACT_ID]=X filter[!STATUS_ID]=[CONVERTED,JUNK,12]`
5. `crm.lead.update`:
   - `CONTACT_ID = contactId`
   - `UF_CRM_*_CHAT_ID = chatId` (если был пуст)
   - `UF_CRM_NF_YM_CLIENT_ID = "-"` (если был пуст)
   - `PHONE` (если был пуст и phone из TITLE есть)
   - `NAME` / `LAST_NAME` если у контакта есть реальное имя, а в лиде
     стоит chat.id или цифры
   - Если есть `openEntity`: `STATUS_ID="12"` (Дубликат), `UF_CRM_LEAD_ID`
     (для lead-эквивалента), `TITLE` префиксован `[Дубликат → kind id]`

Симметрично `backfillSendLead` — переиспользуем тот же паттерн
обновления полей.

## Безопасность от двойной работы

В начале `_maybeLinkOrphanLead`:
- Если уже стоит `CONTACT_ID` + любой `UF_CRM_*_CHAT_ID` — лид залинкован
  (вероятно через widget+backfillSendLead). Возвращаем `linked: false,
  reason: "lead already linked"`.
- Если `CONTACT_ID` стоит, но UF пуст — это widget-creation в процессе,
  backfillSendLead закончит. Возвращаем `linked: false, reason: "contact
  set, not orphan"`.

Только реально orphan-лиды (без CONTACT_ID и без UF) проходят линковку.

## Постфактум-починка через REST

`POST /webhooks/internal/relink-orphan-lead`:
```json
{"leadId": 361428}
```
Header `X-Hint-Secret: $BRIDGE_HINT_SECRET`. Вызывает ту же логику —
для починки лидов созданных **до** деплоя этого фикса, а также
для troubleshooting в будущем.

## Что НЕ делаем

- Не создаём контакт автоматически если не нашли. Это требует
  human-judgement (имя клиента, реальный ли клиент, или спам).
- Не двигаем сообщения orphan-лида в openEntity timeline. Связь через
  `UF_CRM_LEAD_ID` + STATUS_ID=12 достаточна — оператор видит, что
  есть и переходит на оригинал.
- Не подписываемся на `ONIMOPENLINESSESSIONSTART`. Этот вариант был
  рассмотрен (memory `[[b24-orphan-lead-from-native-openline]]` упоминал
  его как «надёжный chat.id через session.CHAT_ID») — отложен потому
  что ONCRMLEADADD уже подписан, REST через TITLE regex работает, и
  один путь проще двух.

## Risks / failure modes

- **TITLE pattern не матчит** → orphan остаётся, лог `title pattern not
  matched`. Менеджер ловит вручную, как сейчас. Не регрессия.
- **Коллизия по `UF_CRM_*_CHAT_ID`** (на портале 1begovoy.bitrix24.ru
  обнаружены legacy-кейсы где десятки контактов делят одно значение
  `UF_CRM_MAX_CHAT_ID`). Защита: если по UF найдено `>1` — это коллизия,
  не доверяем UF, переходим к phone-fallback. Лог WARN.
- **Коллизия по phone** (двух клиентов завели на один номер) →
  аналогично, если `>1` — оставляем orphan. WARN.
- **Множественные открытые сделки** у контакта → берём самую свежую
  (DATE_CREATE DESC). Соответствует backfillSendLead.
- **Race-condition** при ONCRMLEADADD: B24 может не до конца проставить
  поля к моменту event. Если так — orphan не залинкуется, нужен повтор
  через `/internal/relink-orphan-lead`. Не сложно автоматизировать через
  cron-fallback (на будущее, не сейчас).

## Verify

После деплоя:
1. Поправить лид #361428: `curl -X POST .../internal/relink-orphan-lead` с
   `{"leadId": 361428}` → ожидаем `linked: true, contactId: <X>`.
2. Через сутки SQL по логам adapter `grep "orphan-link lead"` — посмотреть
   сколько orphan'ов отловили, сколько `no existing contact` (новые
   клиенты), сколько `marked as duplicate`.
3. Если процент `marked as duplicate` высокий — значит проблема системная
   и стоит закрыть на UI-уровне (open-line CRM_FORWARD должен это ловить
   до создания, разобраться почему не ловит).

## Связано

- задача #68 (P0, in_progress)
- Memory [[b24-orphan-lead-from-native-openline]] — investigation notes
- `bitrix24.service.ts:backfillSendLead` — симметричный механизм для widget-пути
- `bitrix24.service.ts:_maybeLinkOrphanLead` — новый код
- ADR `2026-05-26-ig-comments-attach-to-open-entity.md` — incoming-сторона
  того же правила («открытая сущность — приоритет»)
- PRODUCT_RULES.md §1.1 — правило создания лидов
