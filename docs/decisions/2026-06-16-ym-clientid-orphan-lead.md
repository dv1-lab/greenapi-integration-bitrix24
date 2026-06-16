# ADR 2026-06-16: ClientID органического первого обращения → дозапись в orphan-лид

## Контекст

Продолжение [`2026-06-13-ym-clientid-to-ya-cid.md`](./2026-06-13-ym-clientid-to-ya-cid.md).
После того фикса Дмитрий открыл свежий лид (362976, Telegram, Юрий Фомин,
15.06) и увидел, что `UF_CRM_YA_CID` всё равно **пуст**, хотя метка
`(номер обращения: 1781547537199768487)` в сообщении была.

### Расследование (по боевым логам `source-adapter-1`)

Фикс 13.06 задеплоен и работает (контейнер собран 13.06 01:00 МСК). Регекс
метку распознаёт. Но запись ClientID шла **только если у клиента уже есть
контакт в B24**. Для Фомина в логах:

```
ensureLead: enter phone=- chat=553546236 channel=Telegram line=178 skipLead=false
crm.contact.list filter UF_CRM_TG_CHAT_ID=553546236  → []
ensureLead: no existing contact for /553546236, leaving creation to B24   ← выход
...через ~20с (ONCRMLEADADD)...
orphan-link lead=362976 chatId=553546236: no existing contact, leaving as new client  ← выход
```

**Корень — порядок операций для нового клиента:**

1. Клиент пишет впервые в Telegram/MAX. Телефона в webhook нет
   (`senderPhoneNumber=0`).
2. `ensureOpenLeadForPhone` ищет контакт по phone (нет) и по `UF_CRM_TG_CHAT_ID`
   (нет — клиент новый). Контакт не найден → **выходит, ClientID отбрасывает**.
   Обе ветки записи YA_CID внутри `ensureOpenLeadForPhone` требуют найденного
   контакта.
3. Лид создаёт сама открытая линия B24 (а не наш `(auto)`-лид). Контакт B24
   создаёт без нашего `UF_CRM_TG_CHAT_ID` — это наше поле, B24 его не знает.
4. Событие `ONCRMLEADADD` → `_maybeLinkOrphanLead`: лид (362976) и chatId
   (553546236) **резолвятся корректно**, но функция упирается в «контакта нет»
   и тоже выходит, ничего не записав. ClientID она вообще не видела (читает
   только привязки контакта, не текст сообщения).
5. `backfillSendLead` (который умеет находить свежий лид) — вызывается **только
   из widget-пути** «написать первым», к органическому входящему не подключён.

Итог: органическое первое обращение проваливается мимо **всех трёх** механизмов
записи YA_CID. И `UF_CRM_TG_CHAT_ID` на контакте тоже никогда не появляется
(его пишем только найдя контакт — замкнутый круг), поэтому и на повторных
сообщениях контакт не находится.

### Масштаб (логи с 13.06)

Меток `номер обращения` через мессенджеры: **4 клиента**. ClientID записан: **1**
(у него уже был контакт). Потеряно: **3**, включая Фомина. То есть по своему
основному назначению — поймать ClientID у нового человека, нажавшего «спросить
о товаре» на сайте, — фикс 13.06 почти никогда не срабатывал: такие люди по
определению пишут впервые.

## Решение

Дозаписывать ClientID **прямо в лид, без контакта**, через уже работающий
orphan-linker (`ONCRMLEADADD`), который и так знает leadId + chatId.

1. **Стэш по chatId.** В `sendToPlatform` (входящий Green API), когда метка
   распознана, ClientID кладётся в in-memory `_pendingYmClientId` (ключ —
   chatId, TTL 10 мин). Окно до `ONCRMLEADADD` — ~20с, in-memory достаточно;
   потеря после рестарта допустима (best-effort, как `_ensureLeadLocks`).
2. **Дозапись в orphan-linker.** В `_maybeLinkOrphanLead`, сразу после резолва
   chatId (шаг 0, до поиска контакта), забираем стэш и, если `UF_CRM_YA_CID`
   лида пуст, пишем `UF_CRM_YA_CID` + `UF_CRM_YA_COUNTER_ID` (45469563) в лид.
   Контакт для этого не нужен. Идемпотентно: пусто → пишем один раз, заполнено
   → не трогаем.

### Почему не `backfillSendLead`

`backfillSendLead` находит лид по подстроке в TITLE (chatId / userKey / имя).
У органического входящего B24 называет лид по имени клиента («Fomin Yury»),
а не по chatId, и порядок имени отличается от `senderName` («Yury Fomin») →
поиск по заголовку промахивается. Orphan-linker резолвит chatId надёжно (из
TITLE **или** из `USER_CODE` активности сессии), поэтому хук там.

### Нагрузка на B24 (правило OVERLOAD)

Лишний `crm.lead.update` — только когда в стэше реально лежит ClientID (метка
`номер обращения` присутствовала), т.е. на единичных лидах. Через appKind
`customer360` (фоновый, throttled). Поток обычных сообщений не затрагивается.

## Ограничения / scope

- Покрыты **Telegram и MAX** (chatId = user_id, совпадает со стэш-ключом). Это
  и есть сломанный кейс (все 4 потерянных — Telegram).
- **WhatsApp** первого обращения формально тоже теряет ClientID, но: (а) у WA
  обычно есть телефон → контакт находится со 2-го сообщения; (б) маппинг WA
  chatId ↔ стэш-ключа неоднозначен. Вынесено в backlog, не в этот фикс.
- **Старые лиды** (Фомин и ещё 2) — ClientID не восстановить: текст метки лежит
  только в чате открытой линии, не в карточке (как и в ADR 13.06). Фикс — только
  «вперёд».

## Файлы

- `src/bitrix24/bitrix24.service.ts` — `_pendingYmClientId` + `stashPendingYmClientId`
  / `takePendingYmClientId`; стэш в `sendToPlatform`; дозапись в `_maybeLinkOrphanLead`.
- `src/bitrix24/bitrix24.service.spec.ts` — тесты стэша и дозаписи.

## Backfill за июнь (2026-06-16)

Эндпоинт `/webhooks/internal/backfill-ya-cid` (X-Hint-Secret; body `{lineIds,
sinceIso, dryRun, limit, delayMs}`). Для лидов открытых линий с пустым
`UF_CRM_YA_CID` достаёт ClientID из истории чата и пишет в лид (+сделку, если
поле есть). Цепочка чтения чата: лид → `crm.activity.list` (IMOPENLINES_SESSION)
→ `PROVIDER_PARAMS.USER_CODE` → **`im.chat.get(ENTITY_TYPE=LINES, ENTITY_ID=USER_CODE)`
= CHAT_ID** → `im.dialog.messages.get(chat<CHAT_ID>)` → `extractYmClientId`.
CHAT_ID нет ни в activity (там `ASSOCIATED_ENTITY_ID` = id сессии), ни в session-id.
im-методы — через social-app (customer360 без scope `im`/`imopenlines`).

Результат: восстановлено **7 лидов** (WA линия 174 + TG линия 178) + сделка 108238
(6 автосканом + 1 точечно `362936` через `/webhooks/internal/set-ya-cid` — эндпоинт
точечной записи `{items:[{clientId, leadId?, chatId?, channelLabel?}]}` для случаев,
не пойманных сканером). **Не дописаны** (по CH видны, но мапинг недёшев/неоднозначен):
2 new-client лида без контакта (chatId 786215038, 959973450 — лид не локализуется
ни по контактному UF, ни в CH), повторный клиент 49085552 (3 разных ClientID на
старых лидах — неоднозначно), 79261705590 (валидный ClientID, но 4 лида — guard
не пишет вслепую при >3), 1044603298 (метка без ClientID — `источник: yandex`).
Перекрёстно сверено с ClickHouse `customer360.customer_events.summary` (там лежит
**текст** входящих — в `summary`, не в `payload`; метку `номер обращения`/`(ID )`/`ym-`
видно SQL). **За май меток не было** — восстанавливать нечего.

Грабли backfill:
- **`docker compose up --force-recreate` стирает логи адаптера** — историческую
  выборку из `docker logs` потеряли; источник метки — только чат B24 (или CH.summary).
- **Немодерированный проход выбивает лимит B24** (≈6k запросов за 13 мин →
  ECONNRESET + задержки операторов). Обязателен `delayMs` (≈250мс) и запуск
  по узкому окну (июнь, не «с мая» — лидов на линиях меньше).
- **Контакты**: поля `UF_CRM_YA_CID` на них НЕТ (только лиды/сделки). В контакт
  ClientID писать некуда — и семантически он per-визит, а не per-человек.

## Связанные

- ADR `2026-06-13-ym-clientid-to-ya-cid` — предыдущий слой (регекс + поле).
- ADR `2026-05-26-orphan-lead-linker` — механизм `_maybeLinkOrphanLead`.
- memory `b24_ya_metrika_clientid_fields`, `b24_overload_pattern`.
