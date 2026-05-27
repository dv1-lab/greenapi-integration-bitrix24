# Регрессии — журнал

> **Цель**: каждый раз когда выскакивает «эта же проблема была!» — записать
> сюда. Иначе через месяц повторим ту же ошибку.
>
> **Формат записи**: дата · симптом · причина · фикс (sha) · затронутые файлы ·
> что **пере**сломать рискованно.

---

## 2026-05-26 · Build залип на 5+ часов — DDoS-атака на hip.hosting

- **Симптом**: `docker compose up -d adapter --build --force-recreate` падает на
  `FROM node:20-alpine` с `dial tcp: lookup registry-1.docker.io ... i/o timeout`
  / `TLS handshake timeout`, и/или `pnpm prisma generate` падает с
  `Error: aborted ECONNRESET`. Build пытался деплоить sha `ea77d2d` (task #69),
  множественные ретраи дали одну и ту же ошибку. Затем SSH к my-server тоже
  начал давать banner timeout, потом `social.9wb.ru` (наш публичный URL)
  стал отдавать HTTP 000 (curl timeout), ЛК hip.hosting тоже лёг.
- **Корень**: **DDoS-атака на hip.hosting** (объявили в TG канале @hiphosting
  26.05.2026 в 22:47 МСК: «Может наблюдаться недоступность, предположительно
  связано с DDoS атакой. Работаем над исправлением.»). Атака деградировала
  сеть провайдера в Стокгольме — пакеты к/от my-server терялись, DNS
  resolver на сервере не отвечал, SSH banner timeout, входящий трафик к
  публичным сайтам не доходил. Это **не наш код**, **не Docker Hub**,
  **не Prisma CDN**, **не маршрутизация Cloudflare** — это атака на
  провайдера. Изначально я думал на сетевую деградацию маршрутизации,
  оказалось хуже.
- **Фикс** (sha TBD):
  - `Dockerfile`: `FROM node:20-alpine` → `FROM mirror.gcr.io/library/node:20-alpine`
    (Google публичный pull-through cache Docker Hub — стабильнее)
  - `Dockerfile`: retry-loop на `pnpm prisma generate` (3 попытки с backoff
    15/30/45 сек) — закрывает transient ECONNRESET
- **Регламент**: `docs/DEPLOY.md` создан с разделом «при недоступности CDN» —
  список альтернативных зеркал (Amazon ECR Public, Alibaba), что НЕ делать
  (не restart docker daemon — убьёт 10+ контейнеров на сервере).
- **Memory**: `[[feedback-cdn-mirrors-default]]` — правило применять зеркала
  по умолчанию во всех новых Dockerfile (расширить на остальные сервисы на
  my-server отдельной задачей).
- **Что НЕ делать**:
  - НЕ менять `/etc/docker/daemon.json` `"registry-mirrors"` глобально —
    требует `systemctl restart docker` → 502 у всех клиентов на 30-60 сек.
  - НЕ ждать пока CDN оживёт — Дмитрий явно сказал «ждать когда что-то не
    работает мне не нравится». Зеркала с первой минуты.
- **Что зафиксы НЕ решали**: mirror.gcr.io и retry-loop полезны для нормальных
  сетевых деградаций (transient ECONNRESET), но **не для DDoS** — когда сам
  канал к серверу не работает, обходные пути снаружи не помогают. Эти
  инфра-улучшения остаются в коде как **defense in depth** для будущих
  обычных проблем с CDN.
- **Что НЕ делать**: НЕ паниковать и НЕ переезжать на новый VPS при первом
  же ECONNRESET. Проверять: (а) status hip.hosting (`@hiphosting` Telegram),
  (б) `curl -m 5 https://hip.hosting/` снаружи — если их сайт жив и ЛК нет,
  скорее всего DDoS. Ждать восстановления.
- **Verify**: deploy не успел пройти — сеть лежит до сих пор (на момент
  записи). Wakeup автоматически перепробует через ~1 час.
- **Связано**: `docs/DEPLOY.md`, memory `[[feedback-cdn-mirrors-default]]`,
  memory `[[remote_server]]`

---

## 2026-05-27 · `event.bind ONCRMLEADCONVERT` не существует в B24 (HTTP 400)

- **Симптом**: после деплоя task #69, `POST /internal/register-b24-events` вернул для всех events `bound`, кроме `ONCRMLEADCONVERT` — `failed, Bitrix24 API call failed: Request failed with status code 400`.
- **Корень**: я угадал имя события. В реальности B24 REST такое событие не предоставляет для `event.bind`. Конверсия лида ловится через `ONCRMLEADUPDATE` + детект `STATUS_ID="CONVERTED"`.
- **Фикс** (sha TBD): убрал `ONCRMLEADCONVERT` из `events[]` в `registerB24CrmEvents`, заменил early-return на условие внутри `handleB24CrmEvent`: `if (entity === "lead" && action === "updated" && snap.STATUS_ID === "CONVERTED") { _propagateChatIdsOnConvert(...) }`. Логика propagate осталась идентичной.
- **Что НЕ повторять**: не угадывать имена событий B24 — сначала проверять `event.get` / документацию. Список доступных events для подписки можно получить через `events.get` REST-метод.
- **Verify**: после redeploy register-b24-events вернёт все 6 events `bound`. Первая реальная конверсия лида с непустым UF будет видна в логах `convert lead=... → contact=...: propagated`.
- **Связано**: ADR `decisions/2026-05-26-convert-propagate-chat-ids.md` (поправка в начале файла), task #69.

---

## 2026-05-26 · Конверсия лида теряет `UF_CRM_*_CHAT_ID` — chatId на контакт не переносится

- **Симптом (потенциальный)**: после ручной конверсии лида в контакт в B24,
  на новом контакте `UF_CRM_TG_CHAT_ID` / `UF_CRM_MAX_CHAT_ID` /
  `UF_CRM_IG_CHAT_ID` пусты, хотя на лиде они были заполнены. Следующее
  входящее в TG/MAX/IG не находит контакт по UF → создаётся дубль контакта
  или новый orphan-лид.
- **Корень**: B24 при конверсии лида в контакт **не наследует** кастомные
  UF поля — стандарт платформы. `backfillSendLead` и `_maybeLinkOrphanLead`
  ставят UF на лиде, не на контакте (контакт обновляется только в
  `ensureLeadForPhone` если контакт уже существовал до отправки).
- **Фикс** (sha TBD): listener на `ONCRMLEADCONVERT` через `event.bind`.
  В `handleB24CrmEvent` отдельная ветка для `ev === "ONCRMLEADCONVERT"` →
  `_propagateChatIdsOnConvert`:
  - `crm.lead.get` → читаем CONTACT_ID + UF лида
  - `crm.contact.get` → читаем какие UF уже стоят на контакте
  - Для каждого UF: если на лиде есть И на контакте пусто → дописываем
  - Идемпотентно (повторный CONVERT не перетирает существующее)
- **Постфактум-починка**: `POST /webhooks/internal/propagate-chat-ids` с
  `{"leadId": N}` + `X-Hint-Secret`.
- **Затронутые файлы**:
  - `src/bitrix24/bitrix24.service.ts` — методы `_propagateChatIdsOnConvert`,
    `propagateChatIdsByLeadId`, новая ветка в `handleB24CrmEvent`, добавлен
    `ONCRMLEADCONVERT` в `registerB24CrmEvents` events list
  - `src/webhooks/webhooks.controller.ts` — `POST /internal/propagate-chat-ids`
- **Что пересломать рискованно**:
  - **Не перетирать** значение на контакте если оно уже стоит — наш фикс
    не авторитетнее ручного merge.
  - **Не подписываться на ONCRMCONTACTADD** как альтернатива — контакт
    может быть создан без конверсии (вручную операторами), нечего переносить.
  - После деплоя обязательно вызвать `POST /internal/register-b24-events`
    чтобы новый `ONCRMLEADCONVERT` забиндился на портале.
- **Verify**: ловим первую реальную конверсию в логах adapter (`convert
  lead=... → contact=...: propagated UF_CRM_*_CHAT_ID=...`).
- **Затрагивает каналы**: TG (4100621194, 4100624465), MAX (3100621187),
  Instagram (i2crm), оба TG-бота. WhatsApp **не затронут** — phone B24
  наследует автоматически.
- **Связано**: ADR `decisions/2026-05-26-convert-propagate-chat-ids.md`,
  ADR `decisions/2026-05-26-orphan-lead-linker.md` (родственный listener
  для ONCRMLEADADD).

---

## 2026-05-26 · Orphan-лиды от native B24 OpenLine UI — `backfillSendLead` не дёргается

- **Симптом**: менеджер пишет клиенту через native B24 OpenLine UI (например,
  кнопкой в карточке клиента или из Контакт-Центра, не из нашего widget'а
  Social Connector) → B24 создаёт лид с `TITLE = "<chat_id> - <CHANNEL>
  <phone>"`, `CONTACT_ID = null`, `UF_CRM_*_CHAT_ID` пусто. Лид не привязан
  к существующему контакту клиента, открытые сделки/лиды не учитываются.
  Пример: лид [#361428](https://1begovoy.bitrix24.ru/crm/lead/details/361428/)
  для Орлова Владислава, MAX-чат `32656502`.
- **Корень**: `backfillSendLead` решает ту же задачу (CONTACT_ID +
  UF_CRM_*_CHAT_ID + закрытие как «Дубликат» при openEntity), но вызывается
  **только** из widget/send-пути в `bitrix24.service.ts:2454`. Для native
  B24 UI наш adapter widget не дёргается — в логах ни одной строки
  `[widget]`, `backfillSendLead`, `ensureOpenLeadForPhone`.
- **Фикс** (sha TBD после деплоя): подписаться на `ONCRMLEADADD` (уже
  подписан для Customer-360 sync) и в начале `handleB24CrmEvent` для
  `entity=lead, action=added` запускать `_maybeLinkOrphanLead`:
  - Проверка orphan-ности (нет CONTACT_ID + нет UF_CRM_*_CHAT_ID)
  - Парс TITLE → chat.id + канал + phone
  - Поиск контакта по UF_CRM_*_CHAT_ID, fallback по phone
  - Если контакт найден → `crm.lead.update` с CONTACT_ID + UF + закрытие
    как «Дубликат» если есть openEntity (симметрично backfillSendLead)
  - Если контакт не найден → лог + оставить orphan (это реально новый клиент)
- **Постфактум-починка**: `POST /webhooks/internal/relink-orphan-lead` с
  `{"leadId": <ID>}` + `X-Hint-Secret`.
- **Затронутые файлы**:
  - `src/bitrix24/bitrix24.service.ts` — методы `_parseOrphanLeadTitle`,
    `_findOpenEntityForContact`, `_maybeLinkOrphanLead`, `relinkOrphanLeadById`,
    вызов в `handleB24CrmEvent`
  - `src/webhooks/webhooks.controller.ts` — `POST /internal/relink-orphan-lead`
- **Что пересломать рискованно**:
  - Этот блок выполняется **до** Customer-360 sync — если внутри упадёт
    с throw, sync не пройдёт. Поэтому весь вызов в try/catch с warn.
  - Если `crm.lead.update` не идёмпотентен (повторный ONCRMLEADADD за тот же
    лид) — фильтр `hasContact + hasChatIdUf` обрывает на «уже залинкован».
- **Verify**: после деплоя — `POST /webhooks/internal/relink-orphan-lead`
  с `{"leadId": 361428}` → ожидаем `linked: true`. Сутки наблюдения логов
  `orphan-link lead`.
- **Связано**: ADR `decisions/2026-05-26-orphan-lead-linker.md`,
  PRODUCT_RULES.md §1.1, regression «IG Comments user.id == chat.id»
  (симметрия — incoming side).

---

## 2026-05-26 · IG Comments плодили лиды — `user.id == chat.id` в imconnector.send.messages

- **Симптом**: каждый IG-коммент клиента под новым постом создавал
  **новый лид** в B24, даже если у клиента уже был открытый лид. Дмитрий
  пересмотрел правило (ADR `2026-05-26-ig-comments-attach-to-open-entity`):
  открытая сущность — приоритет, лишних лидов не плодить.
- **Корень**: в `bitrix24.service.ts:handleI2crmIncoming` `user.id` и
  `chat.id` были равны (`i2crm_ig_<c>_c<media>`). При каждом новом посте
  user.id менялся → B24 считал что это **новый клиент** → создавал лид
  через `CRM_CREATE=lead`. `CRM_FORWARD=Y` для повторных обращений
  работал только когда совпадал и user.id и chat.id (т.е. для повторных
  сообщений в той же сессии того же поста).
- **Фикс** (sha c171402): разделить user.id и chat.id:
  - `user.id = buildI2crmUserId(channel, clientId)` = `i2crm_ig_<c>`
    (одинаковый для всех постов и каналов IG одного клиента)
  - `chat.id = buildI2crmChatId(channel, clientId, mediaId)` =
    `i2crm_ig_<c>_c<media>` для instcom, `i2crm_ig_<c>` для instdir
- **Verify**: 201 тестов pass, build OK. На бою через
  `imconnector.send.messages` с разделёнными id'шками B24 узнаёт того
  же клиента по user.id, через `CRM_FORWARD=Y` находит открытый лид/сделку,
  прикрепляет к нему новую сессию (без создания нового лида).
- **Что НЕ повторять**:
  - Не делать `user.id === chat.id` в `imconnector.send.messages`. Это
    спрятанный edge case B24 OpenLines — `CRM_FORWARD=Y` срабатывает
    только если user.id уже виден B24 в другой сессии того же клиента
  - Не пытаться отключить `CRM_CREATE=lead` через `imopenlines.config.update`
    — стандартное поведение Битрикса работает правильно при правильном
    payload. Изначально я ошибочно предложил это в ADR черновике.
  - При добавлении новых каналов с возможностью нескольких сессий per
    клиент — сразу проектировать с разделением user.id/chat.id.

---

## 2026-05-26 · Docker build падает после миграции на pnpm (axios/express не явные deps + Buffer/Blob TS error)

- **Симптом**: при деплое #52 (Swagger UI) docker build падает с:
  - `Cannot find module 'axios'` в 5 файлах (oauth-callback, oauth, widget, webhooks, bitrix24.service)
  - `Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BlobPart'` в `bitrix24.service.ts:2825`
- **Корень**:
  1. Pnpm strict mode не hoist'ит transitive deps. NPM (старый Dockerfile)
     hoist'ил `axios` и `express` как side-effect от `@green-api/...` →
     импорты работали без явной dep в `package.json`. После миграции на
     pnpm — раскрыто.
  2. `@types/node` v22 сделал `Buffer<ArrayBufferLike>` (может быть
     SharedArrayBuffer), Blob constructor требует `ArrayBufferView<ArrayBuffer>`.
     Прошлые prod builds проходили на старых types — после `pnpm install` свежие.
- **Фикс** (sha `dc82a8b`, `f6619aa`):
  - Добавлены явные `axios@^1.16.1`, `express@^5.2.1` в dependencies
  - `new Blob([buffer])` → `new Blob([new Uint8Array(buffer)])` (1 строка)
    — Uint8Array шарит underlying memory, не копирует
- **Verify**: `pnpm run build` локально без ошибок, docker build на сервере
  прошёл, adapter работает с Swagger UI на `https://social.9wb.ru/api`.
- **Что НЕ повторять**:
  - При миграции `npm → pnpm` **всегда** аудит `node_modules` vs `package.json`:
    `grep -rhoE 'from "[a-z@][^.][^"]*"' src/ | sort -u` → сверить.
  - **Один lockfile** в репо. Если есть и `package-lock.json` и
    `pnpm-lock.yaml` — один из них устаревает молча.
  - При апгрейде `@types/node` major version — проверять Blob/Buffer и
    другие nodeJS-Web типы.

---

## 2026-05-26 · MySQL ротация: heredoc `<<'BASH'` не интерполирует переменные

- **Симптом**: при ротации MySQL adapter password (task #26) — после
  ALTER USER + restart adapter Prisma не подключается:
  `Authentication failed against database server, the provided database
  credentials for adapter are not valid`. При этом `mysql -u adapter`
  напрямую с новым pwd **работает**.
- **Корень**: heredoc с одинарными кавычками `<<'BASH'` сохраняет
  переменные **литерально**, не интерполирует. В скрипте:
  ```bash
  cat > /tmp/rotate.sh <<'BASH'
  NEW_PWD=$(openssl rand -hex 24)
  docker exec mysql -u root -e "ALTER USER root IDENTIFIED BY '$NEW_PWD'"
  BASH
  ```
  Когда **bash на сервере** выполняет скрипт — `$NEW_PWD` интерполируется
  bash'ем. Но **в Python heredoc inside**:
  ```python
  content = re.sub(r"...", lambda m: m.group(1) + '$NEW_PWD' + ...)
  ```
  `'$NEW_PWD'` в Python — это **литеральная строка** «$NEW_PWD».
  В .env записалось `mysql://adapter:$NEW_PWD@db:3306/adapter` (буквально
  с долларом). Prisma НЕ парсит URL с `$` → fails.
- **Восстановление**: новый MySQL pwd (поскольку openssl уже сгенерировал
  и **значение потеряно**) — невозможно восстановить через ALTER USER
  (требует знание текущего pwd). Решение: **temporary mysqld container
  с `--init-file`** который ALTER USER root и adapter на **новый известный**
  pwd. Сохранён в `/home/dv/.mysql-adapter-pwd` (chmod 600).
- **Фикс sha** — task #26 завершён, ротация выполнена через temp-mysqld:
  ```bash
  docker run -d --name mysql-reset-temp --rm \
    -v $MYSQL_VOLUME:/var/lib/mysql \
    -v $INIT_FILE:/init.sql:ro \
    -e MYSQL_ROOT_PASSWORD=will-be-overridden \
    mysql:8.0 mysqld --init-file=/init.sql
  ```
- **Что НЕ делать**:
  - **Никогда** не использовать `<<'TAG'` (с кавычками) для скриптов
    с интерполяцией переменных. Использовать `<<TAG` (без кавычек).
  - **Или** делать инлайн bash блоки вместо heredoc на сервере.
  - **Сохранять** сгенерированные секреты в файл **сразу** перед использованием
    (`/home/dv/.mysql-adapter-pwd`) — на случай если в env что-то сломается.
  - **MySQL Docker** имеет специфику: `MYSQL_ROOT_PASSWORD` env при
    re-create контейнера **игнорируется** если volume не пустой. Только
    `--init-file` способ обновить, или `--skip-grant-tables`.
  - **Prisma URL-encoding** ломается на спецсимволах в pwd: `+`, `/`, `=`, `$`.
    Использовать только `openssl rand -hex N` (alphanumeric) или явно
    URL-encode при записи в DATABASE_URL.

См. memory `[[feedback_heredoc_var_interpolation]]`.

---

## 2026-05-26 · dv-dashboard customer page: merged UUID показывал пустую страницу

- **Симптом**: открываешь `/customer/<source_uuid>` для merged-клиента →
  Badge «merged → <target_uuid>» висит, но **на странице** «Нет алиасов»,
  «Нет связанных сущностей в B24», «Нет документов МойСклад». Оператор
  думает что клиент пустой, хотя у target_uuid все данные есть.
- **Корень**: после merge в customer-service все aliases переезжают на
  target. source_uuid остаётся как «redirect-метка» (поле `merged_into` в
  customers PG). Страница рендерила данные source — у которого aliases=0,
  events=0 (через `effective_uuid` они доступны, но не через
  `customer_uuid`). Видимый Badge `merged → <target>` ничего не делал,
  кроме информации.
- **Фикс sha `16d0e63`** в dv-dashboard:
  - В `customer/[uuid]/page.tsx` после `customerByUuid` — `if
    customer.merged_into && != uuid → redirect("/customer/" +
    merged_into + "?from=<short>")`.
  - Server-side redirect через `next/navigation`, перехват query
    `from=<short>` сохраняет след откуда пришёл оператор.
- **Verify**: проверено вживую 26.05 на UUID `fdc19b32-bc05-46a3-947f-bb5fd76c2876`
  (Евгения, sole-TG UUID merged в `db9818fd-...`) — открытие → автоматический
  redirect на target → видны 3 лида + контакт + сделка + заказ МойСклад
  52940₽.
- **Что НЕ делать**:
  - **Не показывать «merged» badge без redirect'а** — это hint без действия,
    оператор путается. Если merged_into есть — редирект, точка.
  - Возможно стоит расширить на другие merged-сценарии (наследование
    переходов через customer_merges цепочку), но пока двух-уровневая
    хватит.

---

## 2026-05-26 · TG-клиенты Customer-360: нет связи с B24-лидом (Евгения и 6 других)

- **Симптом**: на странице `/customer/<uuid>` для TG-клиентов «Нет
  связанных сущностей B24», «Нет документов МойСклад», даже если в B24
  есть лид с тем же TG_CHAT_ID и сделка через CONTACT_ID.
- **Корень**: для TG-канала (через @begovoy_bot Green API TG-shard) у нас
  было **два UUID одного клиента**:
  1. UUID-A — создан bridge.py при first incoming message_in (только
     `tg_user` alias)
  2. UUID-B — создан adapter-sync при создании B24-лида (`phone`,
     `b24_lead`, потом `b24_contact`)

  Merge engine **не предлагал** слияние — нет общего alias (phone vs tg_user
  ничем не пересекаются). Сигнал `B24 lead.UF_CRM_TG_CHAT_ID = tg_user` не
  использовался merge engine.
- **Фикс (разовый backfill 26.05)**: скрипт `/tmp/backfill_tg_merge.sh`
  прошёлся по всем sole-TG UUID:
  1. SELECT customer_uuid из customer_aliases WHERE tg_user-only (без
     phone/b24_*)
  2. Для каждого: B24 `crm.lead.list filter[UF_CRM_TG_CHAT_ID]=<tg_user>` →
     найден lead → найден b24-side UUID
  3. POST `/customers/merge` source=tg-only target=b24-side
  4. Результат: 19 sole-TG UUID → 7 merge (Евгения + 6 других), 2 TG-группы
     скип, 10 без B24-лида.
- **Системный фикс не сделан** (запись `bridge` → adapter event.bind
  `lead_added` для TG-канала). Без него gap будет повторяться: каждый
  новый TG-клиент получит sole-TG UUID на 1-й day, потом adapter создаст
  второй UUID для B24-лида. Workaround — повторный прогон backfill раз в
  неделю.
- **Что НЕ делать**:
  - **Не делать прямой INSERT в `customer_aliases`** для дублирующего
    b24_lead — там UNIQUE PK `(alias_type, alias_value)` и владеть им
    должен один UUID. Только через `/customers/merge`.
  - **Не пересоздавать tg_user alias после merge** — пройдёт следующее
    сообщение, bridge снова сделает resolveAlias и упсертит на правильный
    UUID (тот, в который смержили).

---

## 2026-05-26 · Customer page: имя клиента отсутствует в заголовке

- **Симптом**: heading показывает phone `+7 926 916-66-79` для клиента
  Евгения — хотя её имя известно (B24 contact NAME='Евгения'), AI-summary
  её называет «Евгения». Оператор не сразу понимает кто это.
- **Корень**: `customerDisplay()` использует только PG `customer_aliases` —
  там имени никогда не было. Имена хранятся в `bitrix1begovoy.contacts`
  (CH через mp-analytics sync) и не использовались.
- **Фикс sha `d7f8112`** в dv-dashboard:
  - Новый query `customerB24Name(uuid)`:
    1. SELECT alias_type, alias_value FROM customer_aliases WHERE
       customer_uuid=$1 AND alias_type IN ('b24_contact','b24_lead')
    2. CH: `SELECT name, last_name FROM bitrix1begovoy.contacts WHERE id IN
       (...) ORDER BY date_modify DESC LIMIT 1`
    3. Fallback на `bitrix1begovoy.leads` если в contacts пусто
    4. Returns склеенное `name + last_name`
  - В `customer/[uuid]/page.tsx` — `b24Name` в Promise.all,
    `d.primary = b24Name ?? customerDisplay(...).primary`.
- **Verify**: страница Евгении 26.05 показывает «Евгения» вверху, telephone
  ушёл в Идентификаторы блок (где и должно быть).
- **Что НЕ делать**:
  - **Не fetch'ить B24 API напрямую** — `crm.contact.get` per page-render =
    лишняя нагрузка. Используем CH sync который и так есть.
  - **Не закладывать имя в `customers.display_name`** PG — там нет колонки,
    добавление потребует sync с CH/B24. Запрос «на лету» из CH дешевле.

---

## 2026-05-25 · TG-зеркало IG-Comments: pinned-пост в начале темы (3 итерации)

- **Запрос** Дмитрия: «когда комментарий в IG, чтобы в TG-зеркале **прямо
  пост прикреплялся** — картинка / Reels с подписью, а не голая ссылка
  «🖼 К посту» в каждом сообщении».
- **Архитектура**: при создании новой темы IG-Comments в `_onboard_lead`
  (`ig_bridge.py`) → парсим из истории первый `instagram.com/p/<id>` URL →
  `fetch_instagram_post_media` (og:image / og:video с публичной страницы) →
  `bot.send_photo` / `send_video` в начало темы. Сохраняем URL в
  `ig_leads.pinned_post_url` (новая колонка, миграция). В `_format_message`
  при post_url == pinned_post_url шапка «🖼 К посту» **не** ставится.
- **3 итерации фикса**:
  1. **`cbe8bdf`** — основная фича + миграция `pinned_post_url TEXT`. Отправка
     упала с `TelegramBadRequest` для всех URL: Chrome UA отдавал login-wall
     (og:image=none), а потом и без login-wall URL не принимался Telegram.
  2. **`5276e41`** — два корня. Первый: **User-Agent** `Mozilla/5.0 Chrome`
     получает от Instagram login-wall (страница 898 KB JS без og-тегов).
     Меняем на `facebookexternalhit/1.1` — IG whitelist'ит OG-ботов соцсетей
     и отдаёт нормальный og:image. Второй: og:image в HTML-meta приходит
     с **HTML-entities** (`&amp;` вместо `&`), Telegram не парсит такой
     query string и возвращает `BadRequest`. Добавлен `html.unescape()`
     перед отдачей URL. Smoke-тест: `HEAD https://scontent…&amp;…` → 403,
     после unescape → 200 image/jpeg 27 KB ✓.
  3. **`96b68c9`** — bonus-фикс параллельной проблемы: outgoing TG→IG идёт
     в B24-чате от «Пользователь Технический» (OAuth-app), не видно кто
     ответил. Добавлен `send_chat_system_message(chat_id, text)` с
     `SYSTEM=Y` — после основного `send_chat_message` отправляет ℹ️
     «📤 Ответил из TG: @<username>». Verify-тест: один outgoing webhook
     на коннектор (только основной text), system НЕ форвардится → клиент
     в IG получил `👍` без префикса, оператор в B24 видит автора.
- **Backfill** для существующих тем: 111 IG-Comment тем без
  pinned_post_url → 73 покрыты (1.5s + retry-проход с adaptive sleep
  на `TelegramRetryAfter`). 37 без URL поста в preview (старые темы,
  не покрываются). 1 удалённый пост (og:image=none).
- **Verify**: `kinzhalov.yuriy` (lead 361252), `dima_kuznetsov`
  (lead 361254) — pinned-картинка/Reels в начале темы, сообщения ниже
  без шапки «К посту». ℹ️-пометка автора видна в B24.
- **Что НЕ делать**:
  - **Не использовать Chrome UA для `instagram.com/p/<id>`** — будет
    login-wall. Только `facebookexternalhit` (или `Twitterbot`,
    `TelegramBot` — оба тоже в whitelist).
  - **Не отдавать og:image без `html.unescape`** — Telegram не парсит
    `&amp;` в query string CDN-URL. Любой `httpx.get`-парсинг HTML
    должен сразу декодировать entities.
  - **SYSTEM=Y action в open-line** — подтверждено: НЕ форвардится на
    коннектор. Можно использовать для bookkeeping в чате op-line без
    риска что клиент в WA/IG/TG получит дубль.

---

## 2026-05-25 · TG-зеркало IG: ответ оператора как нативный Telegram reply (4 итерации)

- **Запрос** Дмитрия: «можно сделать чтобы это сообщение было прям ответом
  не в таком вот формате (BB-разделители), а именно как ответ на сообщение,
  которое прокомментировано — со ссылкой на него, как в Telegram нативный
  reply с серой полоской».
- **Архитектура**: bridge `ig_bridge.py` через polling видит outgoing
  оператора в B24 OpenLine chat. Если оператор использовал «Цитировать
  сообщение» в B24 — text начинается с BB-блока (`-{20,}\nавтор [дата]\n
  [Instagram комментарий…]\n<тело>\n-{20,}\n<ответ>`). По телу цитаты можно
  найти соответствующий incoming `tg_message_id` в `ig_msg_map` и передать
  Telegram'у через `reply_parameters` для нативного reply.
- **4 итерации фикса** (всё на серверe + локально через rsync):
  1. **`cf14832`** — добавлен `_find_reply_to_for_quote` + `reply_to_message_id`
     в `bot.send_message`. Не сработало — Telegram игнорировал.
  2. **`bdd05da`** — fix typo `self.db._conn` → `self.db.conn` (отдельная
     ошибка attribute access).
  3. **`1bfd8bc`** + **`bdd05da`** — universal regex для парсинга цитаты
     (raw text приходит с `<br />` от B24, не `\n`). Lookup стал HIT'ить,
     но Telegram всё равно показывал плоский текст без полоски.
  4. **`1e2318d`** — `reply_to_message_id` deprecated в aiogram 3.13+.
     Заменён на `reply_parameters=ReplyParameters(message_id=N,
     allow_sending_without_reply=True)`. Сработало — native reply preview
     появился.
  5. **`b74f0bb`** — финальный штрих: вырезать BB-цитату из text когда
     reply установлен (Telegram уже даёт preview, дубль в теле избыточен).
- **Verify**: Дмитрий протестировал 25.05 22:36 МСК — сообщение `8-)`
  пришло как чистый native reply со серой полоской и preview исходного
  коммента «🔥👏🔥👏».
- **Что НЕ делать**: не использовать `reply_to_message_id` напрямую как
  kwarg в aiogram 3.13+. Только `reply_parameters=ReplyParameters(...)`.
  Telegram молча примет deprecated kwarg, но **не отрисует** reply preview.

---

## 2026-05-25 · TG-зеркало IG: B24-смайлики `<img>` прилетают сырыми

- **Симптом**: оператор отвечает из B24 со смайликом (`:)` через emoji-picker).
  В IG клиенту приходит `:)` корректно (B24 сам конвертирует). А в TG-зеркало
  bridge присылает сырой HTML вида
  `<img src="https://1begovoy.bitrix24.ru/upload/main/smiles/3/bx_smile_smile.png"
  data-code=":)" alt=":)" ... />` — оператор видит мусор вместо смайла.
- **Корень**: bridge `_clean_bitrix_text` в `ig_bridge.py` чистил Instagram-эмодзи
  `[icon=...]`, `<br>`, `<a href="/online/">`, BB-теги — но **НЕ B24 `<img>` смайлы**.
  B24 хранит эмодзи как HTML `<img data-code="..." />`, при `im.dialog.messages.get`
  они приходят сырыми.
- **Фикс**: добавлены regex'ы в `_clean_bitrix_text` (пункт 1.7):
  ```
  <img ... data-code="X" ... />  →  X
  <img ... alt="X" ... class="bx-smile" ... />  →  X  (fallback)
  ```
  Заменяет на data-code (`:)`, `:smile:`, и т.д.). Если нужны **реальные unicode-emoji**
  вместо строковых кодов — отдельный маппинг (B24 `:)` → 😊 и т.п.), пока не делаем.
- **Verify**: рестарт wa-tg-bridge 25.05 22:03 МСК. Новые сообщения с смайлами
  должны быть чистыми. Старые сообщения в TG не редактируются.
- **Что НЕ делать**: не пытаться парсить `<img src="...bx_smile_NAME.png" />`
  по имени файла — B24 хранит мап имени → эмодзи в портале, у нас его нет.
  `data-code`/`alt` всегда содержат текстовый код — это надёжнее.

---

## 2026-05-25 · TG-зеркало IG — ДВА механизма параллельно (adapter+bridge), дубль-топики

- **sha**: `aa602ff` (REGRESSIONS), env-фикс на сервере 25.05 ~21:53 МСК
- **Симптом**: каждый IG-коммент создаёт **2 топика** в группе `1begovoy.ru_insta_comments`:
  - «IG-Comments · пост · dima_kuznetsov dima_kuznetsov» (40 сообщений, не работает outgoing — bridge не знает что писать)
  - «dima_kuznetsov - Instagram Comment - 1begovoy.ru» (14 сообщений, outgoing работает)
- **Корень**: ОБА механизма зеркала активны одновременно:
  1. `adapter src/bitrix24/i2crm-tg-mirror.service.ts` — старый прямой mirror IG-incoming → TG через `TG_MIRROR_BOT_TOKEN` (формат заголовка «IG-Comments · пост · client_id»)
  2. `bridge wa-tg-bridge/src/wa_tg_bridge/ig_bridge.py` — polling B24 OpenLines → TG (формат «<client> - Instagram Comment - 1begovoy.ru» из лида TITLE)
  17.05 рефакторинг должен был отключить adapter-mirror в пользу bridge, но `i2crm-tg-mirror.service` оставлен active. ig_bridge тогда же случайно disable'нут (4 env'а удалены), parallel-зеркало некоторое время не доминировало. После моего restore IgBridge 25.05 — оба mirror'а заработали вместе.
- **Фикс**: очистил `I2CRM_TG_MIRROR_GROUP_ID*` (3 переменные) в `/home/dv/greenapi-b24/.env` + `source/.env`. `I2crmTgMirrorService.enabled = false` (см. геттер — без groupId сервис skip'нет). Restart adapter. Bridge остался единственным mirror'ом.
- **Verify**: новые IG-comments создают только bridge-формат топиков; outgoing TG → IG работает в bridge-топиках (см. «Вы 👍 21:51 ✓✓✓» на скрине от Дмитрия).
- **Старые топики**: оба остаются в TG (40 + 14 сообщений). В adapter-mirror топики больше не пишутся. cleanup — отдельная manual задача (или просто `unpinAllForumTopicMessages` бесшумно skip когда topic_id потерян).
- **Что НЕ делать**: при включении одного полу-mirror'а — обязательно проверять что **второй** не активен. Параллельные mirror'ы умножают confusion операторам.

---

## 2026-05-25 · wa-tg-bridge IgBridge — отключен с 17.05 (TG-зеркало IG не работало 9 дней)

- **Симптом**: 25.05 жалоба Дмитрия «из TG IG-Direct группы не уходят сообщения,
  и из B24 в TG не приходят». Проверил: bridge получает `ONOPENLINEMESSAGEADD`
  от B24 (через `/bitrix/event`), но не зеркалит. `handle_tg_outgoing` для
  IG-группы не срабатывает.
- **Корень**: 17.05 кто-то (вероятно я в прошлой сессии) сделал бэкап
  `.env.bak-2026-05-17-disable-igbridge` и **удалил** из текущего `.env`
  4 переменные: `BITRIX_IG_DIRECT_LINE`, `BITRIX_IG_DIRECT_GROUP`,
  `BITRIX_IG_COMMENTS_LINE`, `BITRIX_IG_COMMENTS_GROUP`. Без них
  `config.bitrix.ig_lines` пустой → в `__main__.py:402` блок инициализации
  `IgBridge` пропускается → `bridge.ig = None` → `handle_tg_outgoing` для
  IG-group молча выходит. Polling `_scan_new_sessions` тоже не запускался,
  baseline `last_activity_updated` застрял на 16.05 23:32.
- **Накоплено**: 1058 `IMOPENLINES_SESSION`-активностей с 17.05 не обработаны
  (через B24 `crm.activity.list filter[>LAST_UPDATED]=2026-05-16T23:32:57+03:00`).
- **Почему оригинальная регрессия**: причина disable не задокументирована.
  Возможно был баг с дублированием или TG-rate-limit, но эпизод не записан.
  При восстановлении баг не воспроизвёлся.
- **Фикс**: 25.05 19:23 МСК — восстановил 4 env-переменные из `.env.bak` через
  `grep + >>` (значения не печатались в transcript). Сдвинул baseline
  `last_activity_updated` с 16.05 на сегодня 12:00 МСК — чтобы bridge не
  флудил TG 1058 старыми лидами, а обработал только сегодняшние (~50 шт).
  Старые лиды до 17.05 если понадобятся → manual onboard через
  `/internal/refresh-ig-topics` endpoint.
- **Verify**: после `systemctl restart wa-tg-bridge` логи `ig-bridge: 2 линий,
  бот-poll каждые 45 сек` + `last_activity_updated` начал двигаться (12:00 →
  13:53 за 90 сек). Throttle Telegram (4с/topic) — норма при первом проходе.
- **Что НЕ делать**: при disable какой-то фичи через удаление env — **обязательно**
  записывать в REGRESSIONS.md почему и до какого момента отключена. Без этого
  через неделю никто (включая меня) не помнит «зачем мы это сделали» и
  фича медленно деградирует. Backup-файл `.env.bak-disable-X` сам по себе
  не достаточен.

---

## 2026-05-25 · IG comment outgoing — chat.id regex отстал от incoming формата

- **sha**: `c6ea78d`
- **Симптом**: Дмитрий пишет «!!!» / «=)» в IG-comment лиде dima_kuznetsov →
  красная плашка «не доставлено» в B24, клиент в Instagram сообщение не получает.
- **Корень**: `handleI2crmOutgoing` парсил `chat.id` regex'ом
  `^i2crm_ig_(\d+)_c(\d+)$` (2 сегмента после `i2crm_ig_`). Но incoming pipeline
  с sha `cacfa1f` (A2: один пост = одна сессия) стал писать `chat.id` вида
  `i2crm_ig_<clientId>_c<mediaId>_<accountId>` (3 сегмента). Все comment outgoing
  падали в fallback `rawChatId.replace(/\D/g, "")` → склейка всех цифр →
  гигантский client_id (49 cifr) → i2crm возвращал «Некорректные данные».
- **Фикс**: добавлен regex `^i2crm_ig_(\d+)_c(\d+)_(\d+)$` (3-segment), сохранили
  совместимость со старым 2-segment форматом. Fallback `\D` убран — при
  необычном chat.id логируем error и возвращаем `success: false`, чтобы не
  плодить мусорные запросы в i2crm.
- **Verify**: 25.05 12:10:25 Дмитрий написал «! проверка» в comment-лид
  → лог `i2crm: ответ в чате комментария с пометкой «!» → Директ` +
  `type:"direct"` + `OK`. Клиент в Instagram просмотрел сообщение.
- **Что НЕ повторять**: при добавлении нового сегмента в chat.id (или userKey)
  для **incoming** — **обязательно** обновлять regex в `handleI2crmOutgoing`
  и аналогах. Класс «outgoing parser отстал от incoming writer».

---

## 2026-05-25 · IG outgoing «сообщение не доставлено» — i2crm timeout 15s мало

- **sha**: `60468b4`
- **Симптом**: Анастасия пишет клиенту в IG Direct из B24 → в UI красная плашка
  «сообщение не доставлено». При этом клиент в Instagram сообщение **получает**.
  Часть отправок проходит (10-30% по моим оценкам по логам), большинство — нет.
- **Корень**: `axios.post` к `https://app.i2crm.ru/api_v1/target/feedback` с
  timeout=15000ms. i2crm обрабатывает запрос **синхронно** — сначала принимает,
  потом ждёт ответ Instagram Graph API. При тормозах Meta запрос реально может
  занять 30-40 секунд. Замеры на проде 25.05: kambol__92 — 34с, 1august9w — 36с,
  vitaliy_ivanov — 1с. На 15s падает с `i2crm outgoing transport error: timeout of 15000ms exceeded`.
  Клиент **уже** получил сообщение (i2crm успел дойти до Meta), но adapter
  перестал ждать → не шлёт `imconnector.send.status.delivery` → B24 UI через
  минуту падает в «не доставлено».
- **Фикс**: timeout 15s → 60s в трёх местах `bitrix24.service.ts`:
  1. `handleI2crmOutgoing` JSON POST (line 4631)
  2. `handleI2crmOutgoing` multipart POST с фото (`_postI2crmFeedbackMultipart`)
  3. off-hours auto-reply (line 2341)
- **Тест**: 25.05 после deploy — 4 свежих outgoing прошли (включая 34s и 36s),
  всем отправлен delivery confirmation. Плашка «не доставлено» исчезла.
- **Что НЕ делать**:
  - Не повышать timeout до бесконечности — adapter висит на блокирующих
    HTTP-вызовах в event loop. 60s — компромисс.
  - Не пытаться чинить через `String()` cast externalMessageId в
    `send.status.delivery` — это было гипотезой 25.05, но корень другой.
    Если будет похожий симптом «плашка „не доставлено“ + i2crm OK в логах» —
    смотри не на формат delivery payload, а на сам i2crm POST: успел ли он
    дойти до log-точки `i2crm outgoing OK` или упал в `transport error`.

---

## 2026-05-24 · Класс «карточка/тема клиента не унифицирована» — 10-й инцидент

- **Симптом** (повторяющийся 10+ раз): жалоба «в одном канале есть X, в другом
  нет», «нет фото клиента», «не понятно через какой бот пишет», «нет ФИО
  оператора», «заголовок темы только `TG · Имя` без источника».
- **Корень**: 5 каналов (WA / TG-shard / MAX / TG-боты / IG i2crm) развивались
  отдельно. Под каждый — свой mirror code (bridge.py для WA/TG-shard/MAX,
  tg-bot-mirror.service.ts для наших ботов, i2crm-tg-mirror.service.ts для IG).
  Каждый фикс «по требованию» применялся к одному каналу, остальные
  отставали. Не было единого spec — был размазан по комментариям/чатам.
- **Фикс (2026-05-24)**: создан [`CLIENT_CARD_STANDARD.md`](./CLIENT_CARD_STANDARD.md)
  — единый spec для всех 5 каналов (заголовок темы, pinned карточка, фото,
  подпись оператора с ФИО, подпись клиента, системные сообщения, чек-лист
  перед merge). Любая новая правка зеркал — через этот spec. В CLAUDE.md
  добавлено обязательное чтение spec'а перед правкой mirror-кода.
- **НЕ повторять**: вводить новый канал или менять mirror-карточку **только
  в одном канале**. Если что-то меняется в карточке/теме — применять ко всем 5
  параллельно. См. checklist §7 в CLIENT_CARD_STANDARD.md.

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

## 2026-05-24/25 · #47 «не подтягивается открытая линия когда пишешь в MAX клиентам» — **ЗАКРЫТО**

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
- **Реальный корень 2026-05-24/25 (часть 2)**: префикс `sc_` в `imconnector.send.messages`
  (user.id=`sc_77109671`) не матчится с UF_CRM_MAX_CHAT_ID=`77109671` (без префикса) →
  B24 заводит **новый** chat-user → новая open-line сессия → новый «свободный»
  лид-дубликат в очереди «Неотвеченные». Подтверждено логами `ensureLead[lm25qw]` +
  visual reproduce. Подробности — memory `widget_max_47_root_cause.md`.
- **Фикс A.v2** — три итерации до рабочего состояния:
  1. `2f27713` (24.05 вечер) — autoTakeSession + retry-loop по `im.recent.list`.
     Fail: app-context не видит свежесозданный chat-user → `chat not found`.
  2. `f040d41` (25.05 утро) — fast-path: chatId извлекается из ответа
     `imconnector.send.messages` (`DATA.RESULT[0].session.CHAT_ID`), retry-loop
     остался fallback'ом. Стало находить chat. Fail: `operator.answer` через
     app-OAuth attachит сессию к bot-user'у adapter'а («Технический Пользователь»),
     не к фактически отправляющему оператору.
  3. `ea3d1dd` (25.05 утро) — `operator.answer` через **user-auth** оператора
     (прямой `axios.post` с `?auth=<operatorAuthId>`, не через app-OAuth).
     **Verified by user 25.05 13:40 МСК**: «сейчас все ок».
- **Hot-fix sleep(2000) в ensureOpenLeadForPhone**: бесполезен (корень — префикс,
  не race-condition), откачен `git checkout` 2026-05-24 22:00 МСК.
- **Фикс B (sha `a7ec9f5` + `ea3d1dd`, 2026-05-25)**: `imopenlines.crm.chat.attach`
  в B24 REST **нет** (research'ил 25.05 — все имена `imopenlines.crm.chat.*`
  возвращают `ERROR_METHOD_NOT_FOUND`). Реализовано через **системное сообщение**
  в начало open-line диалога: `Bitrix24Service.postContextMessage` шлёт
  `im.message.add SYSTEM=Y DIALOG_ID=chat<num>` с BB-кодами [URL=...] на
  контакт/сделку/лид/customer-360. Оператор видит ссылки и одним кликом прыгает
  на нужную CRM-сущность. In-memory Set дедуп — не повторяем второй раз.
  `EnsureLeadResult.customerUuid` читается из `UF_CRM_PB_CUSTOMER_UUID` контакта.
  Поправка `ea3d1dd`: customer-360 URL → `/customer/<uuid>` (не `/customer-360/<uuid>`,
  тот 404).
- **НЕ повторять**: написание фикса без полной проверки 4 каналов (WA/TG/MAX/IG)
  × 2 направлений (in/out) × 2 сценариев (виджет / с мобильного). Не пытаться
  чинить через `sleep` («race condition») когда реальный корень — несовпадение
  идентификаторов.

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
