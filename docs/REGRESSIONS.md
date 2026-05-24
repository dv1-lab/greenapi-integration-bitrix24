# Регрессии — журнал

> **Цель**: каждый раз когда выскакивает «эта же проблема была!» — записать
> сюда. Иначе через месяц повторим ту же ошибку.
>
> **Формат записи**: дата · симптом · причина · фикс (sha) · затронутые файлы ·
> что **пере**сломать рискованно.

---

## 2026-05-24 · scanCandidates b24-cross — false positives через value-equality JOIN

- **sha**: `c6ae152` (dv1-lab/customer-service, init с уже-fix'нутой версией) /
  обнаружено в этой же сессии 2026-05-24
- **Симптом**: `POST /suggestions/scan` создал 500 b24-cross suggestions, все
  оказались мусором при ручной проверке.
- **Причина**: SQL в `suggestions.service.ts` делал
  `JOIN b24 a ... b24 b ON a.alias_value = b.alias_value AND a.alias_type != b.alias_type`
  — матчил случаи когда `b24_lead.value == b24_contact.value`. Это бессмысленно:
  в B24 lead.ID и contact.ID — разные namespace, могут случайно совпасть.
- **Фикс**: переписан на JOIN через CH `customer_events`:
  `SELECT customer_uuid, b24_lead_id, b24_contact_id FROM customer_events
   WHERE source IN (...) AND b24_lead_id IS NOT NULL AND b24_contact_id IS NOT NULL`
  → для каждой row lookup в PG `customer_aliases` по `b24_contact=contact_id`.
- **НЕ повторять**: писать «находим дубли» SQL внутри customer-service без
  проверки на реальных данных + без явного смысла (что значит matching).
- **Также**: customer-service repo создан 2026-05-24 (раньше не было git'а вовсе),
  теперь все правки через git → меньше шансов «потерять» fix.

---

## 2026-05-24 · #47 «не подтягивается открытая линия когда пишешь в MAX клиентам»

- **Симптом**: оператор открыл сделку 108126 → виджет «Social Connector» →
  написал в MAX. В правой панели B24 диалог не появился. Диалог подтянулся
  только когда клиент сам ответил.
- **Класс**: `widget outgoing → chat-user mismatch by UF_CRM_*_CHAT_ID`.
- **Диагностика 2026-05-24 (часть 1)**:
  - У `contact 11022` (привязан к deal 108126) **UF_CRM_MAX_CHAT_ID пуст**.
  - В коде `ensureOpenLeadForPhone` (`bitrix24.service.ts:503-510`) — логика
    корректная: после widget /send adapter должен сохранять UF_CRM_MAX_CHAT_ID
    на контакте, если поле пустое. Не сработало.
  - Возможные причины: `crm.duplicate.findbycomm` не нашёл contact по phone
    (формат phone в B24 отличается от того, что шлёт widget); app=`social`
    не имел прав на `crm.contact.update`; widget /send упал на этапе до
    `ensureOpenLeadForPhone`.
- **Статус**: документация написана (`OPEN_LINE_LIFECYCLE.md`, `CHECKLIST_WIDGET.md`).
  Фикс — отдельная сессия #21 с timestamps adapter-логов конкретного отправления +
  reproduce. По итогам — patch widget с явным sanity-check «UF записался?».
- **НЕ повторять**: написание фикса без полной проверки 4 каналов (WA/TG/MAX/IG)
  × 2 направлений (in/out) × 2 сценариев (виджет / с мобильного).

---

## 2026-05-23 (вечер) · IG-комменты: дубль `(auto)` лида при ответе оператора

- **sha**: `66c3c05` (fix: Instagram — убрать дубль '(auto)' лида, привязывать контакт к лиду сессии)
- **Симптом**: на каждый ответ оператора на IG-коммент создавался отдельный лид
  с суффиксом `(auto)` плюс «обычный» лид сессии. У клиента в B24 — два лида
  вместо одного.
- **Причина**: `ensureOpenLeadForPhone` без `skipLeadCreation=true` создавал свой
  лид параллельно с тем, что B24 создаёт через imconnector.send.messages.
- **Фикс**: `skipLeadCreation=true` + backfill контакта в созданный B24-лид.
- **НЕ повторять**: добавлять `ensureOpenLeadForPhone` где-то рядом с
  imconnector.send.messages без флага.

---

## 2026-05-23 · Telegram-бот: дубль message_out из ветки outgoing-from-mobile

- **sha**: `b849470`
- **Симптом**: оператор с мобильного Telegram пишет клиенту → сообщение
  зеркалится дважды: один раз через handleOutgoingFromDevice, второй раз через
  outgoing-from-mobile pipeline.
- **Причина**: оба обработчика срабатывали для одного `outgoingMessageReceived`
  webhook'а Green API.
- **Фикс**: ранний return в outgoing-from-mobile если уже обработали в device.
- **НЕ повторять**: расширять `handleOutgoingFromMobile` без проверки источника.

---

## 2026-05-23 · TG-бот: привязка лида сессии к существующему контакту

- **sha**: `d97adf8`
- **Симптом**: TG-бот создавал новый лид без CONTACT_ID, даже если контакт уже
  есть в B24 с UF_CRM_TG_CHAT_ID.
- **Причина**: `backfillTgBotContactLink` после старта сессии не находил контакт
  по UF_CRM_TG_CHAT_ID (поле проставляется не сразу).
- **Фикс**: ретраи + резолв контакта по UF_CRM_TG_CHAT_ID и привязка к
  свежесозданному лиду.

---

## 2026-05-22 · `e448010` — outgoing-from-mobile MAX/TG не тегировал созданный B24-лид

- **Симптом**: оператор с моба пишет → B24 создаёт «свободный» лид без связи
  с контактом, контактом резолвлся отдельно — потеря трекинга канала.
- **Фикс**: после createLead — backfill UF_CRM_*_CHAT_ID + tag в сессию.

---

## 2026-05-19 · `7fb6b16` — widget: вернуть создание Direct-линии

- **Симптом**: после регрессии `21a2605e` widget перестал создавать Direct-линию
  для IG. Виджет работал, сообщение уходило в i2crm, но в B24 не было open-line
  чата.
- **Фикс**: откат логики создания Direct-линии через `imconnector.send.messages`.
- **НЕ повторять**: переключать widget с `imconnector.send.messages` на
  альтернативные API без полного теста 4 каналов.

---

## 2026-05-16 · `71e8b3e` — widget: приоритет UF_CRM_*_CHAT_ID над history-chatId

- **Симптом**: если у клиента в карточке UF_CRM_TG_CHAT_ID и история чатов —
  виджет брал не тот chatId (старый из history) и шёл «не тому» клиенту, если
  кто-то перехватил освобождённый @username.
- **Фикс**: приоритет UF_CRM_*_CHAT_ID, fallback на history, fallback на phone.
- **НЕ повторять**: писать «достаём chatId из X» без явного приоритета по
  стабильности источников.

---

## Шаблон записи (копировать сверху)

```
## YYYY-MM-DD · <короткий заголовок>

- **sha**: `<commit-hash>` (или PR/issue ссылка)
- **Симптом**: что увидел оператор / клиент
- **Причина**: что в коде / B24 / Green API сломалось
- **Фикс**: что поменяли
- **НЕ повторять**: какие классы изменений приведут к той же регрессии
```
