# Sequence Diagrams — критичные flow платформы

Sequence-диаграммы 5 самых критичных flow Social Connector ecosystem'а.
Цель — за 5 минут понять «что происходит когда клиент пишет в WA/IG»
без чтения 6000-строчного `bitrix24.service.ts`.

Last updated: 2026-05-26 (task #48).

См. также: [`DATA_MODEL.md`](./DATA_MODEL.md) для понимания таблиц,
[`OPEN_LINE_LIFECYCLE.md`](./OPEN_LINE_LIFECYCLE.md) для жизненного цикла
сессии, [`INSTAGRAM_FLOW.md`](./INSTAGRAM_FLOW.md) для деталей IG.

---

## 1. Incoming WA-сообщение → B24 + Customer-360

Клиент пишет в WhatsApp на привязанный номер. Сообщение приходит
через Green API webhook, проходит через adapter, попадает в B24
OpenLine как сообщение чата, и параллельно событие летит в
Customer-360 customer_events.

```mermaid
sequenceDiagram
    actor Client as 📱 Клиент
    participant GA as Green API<br/>(WA-инстанс)
    participant Adapter as adapter<br/>(social.9wb.ru)
    participant CS as customer-service<br/>(127.0.0.1:3002)
    participant CH as ClickHouse<br/>customer360
    participant B24 as Bitrix24<br/>(open-line)

    Client->>GA: «Привет, есть кроссовки 42?»
    GA->>+Adapter: POST /webhooks/green-api<br/>{instanceData, senderData, messageData}
    Adapter->>Adapter: BaseAdapter.handleWebhook(webhook)
    Note over Adapter: Authentication: instance.bitrixLine лежит<br/>в Instance таблице (Prisma)

    Adapter->>Adapter: bitrix24Transformer.toPlatformMessage()
    Note over Adapter: chat.id = "wa_+79991234567"<br/>user.name = senderData.senderName

    par Customer-360 sync (best-effort)
        Adapter->>+CS: POST /aliases/lookup<br/>{type: "phone", value: "+79991234567"}
        CS-->>-Adapter: {customer_uuid: "..." | null}
        alt UUID не найден
            Adapter->>+CS: POST /customers/by-alias<br/>(создать customer + alias)
            CS-->>-Adapter: {customer_uuid, customer_no}
        end
        Adapter->>+CS: POST /events/ingest<br/>{customer_uuid, source: "bridge_wa",<br/>event_type: "message_in", channel: "WA"}
        CS->>CH: INSERT customer_events
        CS-->>-Adapter: 200 OK
    end

    Adapter->>+B24: imconnector.send.messages<br/>{CONNECTOR: "social_connector",<br/>LINE: bitrixLine, MESSAGES: [...]}
    B24-->>-Adapter: {DATA.RESULT[0].session.{ID, CHAT_ID}}

    alt isOffHoursMsk() && WA/TG/MAX
        Adapter->>Adapter: claimOffHoursReply(chatKey)
        Note over Adapter: OffHoursReply таблица — дедуп<br/>«один автоответ за ночь»
        Adapter->>GA: sendMessage<br/>«Здравствуйте! Спасибо…»
    end

    Note over B24: B24 создаёт chat-user если нет,<br/>сессию (с CRM_CREATE=lead),<br/>лид с UF_CRM_TG_CHAT_ID=phone

    B24-->>Adapter: ONIMCONNECTORMESSAGEADD (async webhook)
    Note over Adapter: Этот callback нужен для outgoing<br/>(оператор → клиент). Для incoming<br/>уже всё сделано.

    Adapter-->>-GA: 200 OK
```

### Грабли в этом flow

- **`outHistory` хранится в-памяти** в Green API — при рестарте теряется.
  Используем `OutgoingMessage` Prisma как persistent mapping.
- **`CRM_CREATE_SECOND=N`** обязательно для линии (#26 ADR), иначе плодятся
  «Повторные лиды» при втором сообщении того же клиента.
- **Customer-360 sync — best-effort** (try/catch). Если customer-service лёг —
  основной B24-flow продолжает работать. Events добиваются после восстановления
  через replay (TODO #58 nextiter).

---

## 2. Outgoing IG-comment из B24 (Reply на конкретный коммент)

Оператор в B24 чате IG-Comment отвечает с цитатой на конкретный коммент
клиента. Adapter должен передать в i2crm `reply_to_comment_id`, чтобы
ответ повис именно под этим комментарием в Instagram (а не общий ответ).

```mermaid
sequenceDiagram
    actor Op as 👤 Оператор
    participant B24 as Bitrix24<br/>(open-line IG-Comment)
    participant Adapter as adapter
    participant Prisma as MySQL<br/>(adapter)
    participant I2crm as i2crm Public API
    participant IG as 📷 Instagram

    Op->>B24: Reply (цитирование) на коммент<br/>«Конечно, есть размер 42!»
    B24->>+Adapter: POST /webhooks/bitrix24<br/>(event=ONIMCONNECTORMESSAGEADD)
    Note over Adapter: webhook.data.MESSAGES[0]:<br/>chat.id="i2crm_ig_<client>_c<media>"<br/>message.message="Конечно…"<br/>quote.message_id=<b24_msg_id>

    Adapter->>Adapter: handleI2crmOutgoing(webhook)
    Adapter->>Adapter: parse chat.id<br/>regex i2crm_ig_<num>(_c<num>)?

    Note over Adapter: A2: clientId + mediaId из chat.id<br/>(пост-уровневая сессия)

    Adapter->>Prisma: IgInboundB24Link.findUnique<br/>where (b24ChatId, b24MessageId)<br/>= quote
    Prisma-->>Adapter: {clientId, mediaId, commentId, commentText}

    Adapter->>Prisma: IgCommentContext.findUnique<br/>where (clientId, mediaId)
    Prisma-->>Adapter: {commentId} (последний коммент в треде)

    Note over Adapter: Если quote есть → reply_to_comment_id<br/>= IgInboundB24Link.commentId<br/>(на конкретный коммент клиента)<br/>Иначе → commentId из IgCommentContext

    Adapter->>+I2crm: POST /target/feedback<br/>{type:"comment", media_id, comment_id,<br/>client_id, text, reply_to_comment_id}
    I2crm->>IG: Instagram Graph API reply
    IG-->>I2crm: comment_id (новый ответ)
    I2crm-->>-Adapter: {success: true}

    Note over Adapter: i2crm возвращает SUCCESS даже если поля<br/>лишние/неверные (silent acceptance, см. memory<br/>feedback_no_real_probes_to_clients)

    Adapter->>Prisma: I2crmEventLog.create<br/>{incoming: false, status: "sent"}

    Adapter-->>-B24: 200 OK (success)

    IG-->>Op: Реальный коммент с ⤴️ reply<br/>в Instagram появляется через <30 сек
```

### Грабли в этом flow

- **chat.id regex отстал от incoming формата** — историческая регрессия
  (см. REGRESSIONS.md 25.05). После A2 incoming chat.id может быть
  `i2crm_ig_<c>_c<media>`, outgoing должен парсить тот же формат.
- **`reply_to_comment_id` обязателен** — без него ответ идёт под пост
  как новый коммент, а не reply. Требование i2crm Public API.
- **`IgInboundB24Link`** даёт **точный** comment для reply (по quote),
  но если оператор написал без quote → используется **последний** из
  `IgCommentContext`.
- **i2crm молча принимает неверные поля** — НЕ probe'ить на реальных
  клиентах (см. memory `[[feedback_no_real_probes_to_clients]]`).

---

## 3. Incoming Instagram Direct (через i2crm)

Клиент пишет в Instagram Direct. i2crm подписан на бизнес-аккаунт через
Meta Graph API, отправляет webhook нам, мы доставляем в B24 как сообщение
IG-линии с особой обработкой quoted_message (если ответ на сторис).

```mermaid
sequenceDiagram
    actor Client as 📱 Клиент
    participant IG as 📷 Instagram
    participant I2crm as i2crm Public API
    participant Adapter as adapter
    participant Prisma as MySQL adapter
    participant CS as customer-service
    participant B24 as Bitrix24<br/>(open-line IG-Direct)
    participant TG as TG-зеркало<br/>(wa-tg-bridge IgBridge)

    Client->>IG: Direct «Когда привезёте Garmin?»
    IG->>I2crm: Webhook (Meta Graph API)
    I2crm->>+Adapter: POST /webhooks/i2crm<br/>{channel: "instdir", client_id, message_id,<br/>text, type, quoted_message?, ...}

    Adapter->>Adapter: validateI2crmIncoming(payload)
    Note over Adapter: ✅ есть client_id+message_id+channel<br/>(см. src/common/i2crm-payload.ts)

    Adapter->>Prisma: I2crmEventLog.upsert<br/>messageId UNIQUE, status="pending"
    Note over Adapter: Если B24 в OVERLOAD_LIMIT —<br/>replay'им позже через /i2crm-replay

    Adapter->>Adapter: envKeyForI2crmLine("instdir")<br/>→ "I2CRM_LINE_ID_IG_DIRECT"
    Adapter->>Adapter: configService.get(...) → lineId
    Adapter->>Prisma: user.findMany take:1<br/>→ portalDomain

    alt off-hours и Direct
        Adapter->>Adapter: claimOffHoursReply("ig:<clientId>")
        Adapter->>I2crm: sendOffHoursReplyIg<br/>(автоответ один за ночь)
    end

    Adapter->>Adapter: buildI2crmUserKey("instdir", clientId)<br/>→ "i2crm_ig_<clientId>"
    Adapter->>Adapter: formatI2crmQuoted(quoted_message)<br/>→ «↩️ В ответ на сторис: ...»<br/>(если quoted есть)
    Adapter->>Adapter: buildI2crmFinalText(...)<br/>→ финальный текст для B24

    Adapter->>+B24: imconnector.send.messages<br/>{LINE: lineId, user, chat, message}
    B24-->>-Adapter: {session.ID, session.CHAT_ID}

    par TG-зеркало (если есть)
        Adapter->>+TG: i2crmTgMirror.mirrorIncoming(payload)
        TG->>TG: send_message в TG-группу<br/>с карточкой клиента (CLIENT_CARD_STANDARD)
        TG-->>-Adapter: 200 OK (best-effort)
    end

    par IG-Direct link для reply через quote
        Adapter->>Prisma: IgDirectInboundB24Link.create<br/>(b24ChatId, b24MessageId,<br/>externalMessageId, messageText)
        Note over Prisma: Получаем b24_message_id через<br/>im.dialog.messages.get последнего
    end

    par Customer-360
        Adapter->>+CS: POST /aliases/lookup<br/>{type: "ig_user", value: clientId}
        CS-->>-Adapter: customer_uuid
        Adapter->>CS: POST /events/ingest<br/>(source: bridge_ig, event_type: message_in)
    end

    Adapter->>Prisma: I2crmEventLog.update<br/>status="sent", sentAt=now()

    Adapter->>Adapter: backfillIgUfFields<br/>(UF_CRM_IG_CHAT_ID, USERNAME)
    Note over Adapter: B24 создаёт лид/контакт async,<br/>UF backfill идёт с retry

    Adapter-->>-I2crm: 200 OK
```

### Грабли в этом flow

- **i2crm не шлёт `reply_to_message_id`** для Direct (запрос #32 в support).
  Без этого ответ на конкретное сообщение в треде невозможен.
- **`UF_CRM_IG_USERNAME`** заполняется async (B24 создаёт лид с задержкой
  1-3 сек). Backfill идёт с retry, может занять до 30 сек до появления в UI.
- **`quoted_message`** — может быть string (старый формат) или object
  (новый, для сторис). `formatI2crmQuoted` обрабатывает оба.

---

## 4. Merge UUID (rule-scan + AI evaluator + apply)

Customer-360 сам сканит дубли (rule-based), делает shortlist, ai_evaluator
оценивает через Claude API, оператор в KBD-Admin TG-чате принимает/отклоняет.

```mermaid
sequenceDiagram
    actor Op as 👤 Оператор<br/>(KBD-Admin)
    participant Cron as cron */30
    participant CS as customer-service
    participant PG as Postgres<br/>customer_service
    participant LLM as Claude API<br/>(via OAuth subscription)
    participant TG as @agent_dv_bot<br/>(KBD-Admin)
    participant CH as ClickHouse<br/>customer360

    Note over Cron,CS: Этап 1: rule-based shortlist

    Cron->>+CS: POST /merge/scan-candidates
    CS->>PG: SELECT pairs с близкими alias'ами<br/>(phone normalize, FIO Levenshtein,<br/>tg_user + b24_lead pair, ...)
    PG-->>CS: ~50-200 pairs/scan
    CS->>PG: INSERT merge_suggestions<br/>(status="pending", reason_rule)
    CS-->>-Cron: count

    Note over Cron,CS: Этап 2: AI evaluator (cron */30 отдельный)

    Cron->>+CS: POST /merge/ai-evaluate-pending
    loop По каждой pending suggestion
        CS->>PG: SELECT contexts (customers, aliases,<br/>events за 30 дней) для source+target
        CS->>+LLM: Claude prompt: «Это один клиент?»<br/>(features → confidence + reasoning)
        LLM-->>-CS: {confidence: 0.92, reasoning: "..."}
        CS->>PG: UPDATE merge_suggestions<br/>SET confidence, reason_ai, status<br/>= confidence>0.85? "evaluating" : "rejected"
    end

    CS->>TG: send_message в KBD-Admin<br/>«Найдено 12 высоковероятных merge»<br/>с inline-кнопками
    CS-->>-Cron: count

    Note over Op,TG: Оператор решает

    Op->>TG: Click "Accept #123"
    TG->>+CS: POST /merge/apply<br/>{suggestion_id, by_user}

    CS->>PG: BEGIN TRANSACTION
    CS->>PG: SELECT * FROM customer_aliases<br/>WHERE customer_uuid = source
    Note over CS,PG: aliasSnapshot для undo
    CS->>PG: UPDATE customer_aliases<br/>SET customer_uuid = target<br/>WHERE customer_uuid = source
    CS->>PG: UPDATE customers<br/>SET status='merged', merged_into=target<br/>WHERE uuid = source
    CS->>PG: INSERT customer_merges<br/>(source, target, confidence, alias_snapshot)
    CS->>PG: UPDATE merge_suggestions<br/>SET status="accepted", decided_by, decided_at
    CS->>PG: COMMIT

    CS->>CH: INSERT merge_map<br/>(source, target, merged_at)
    Note over CH: View customer_events_effective<br/>теперь резолвит source → target

    CS->>TG: edit_message_text<br/>«✅ Merged by @username at HH:MM»
    CS-->>-Op: 200 OK
```

### Грабли в этом flow

- **`customer_no`** target не меняется — остаётся исходный (если был).
  Если у source был customer_no, а у target нет → потенциально нужно
  передать (TODO в reason_ai).
- **CH replication через приложение** — если customer-service лёг между
  PG transaction и CH INSERT → разъедутся. Reconcile cron — gap (#).
- **LLM может ошибиться на close call'ах** (двое братьев в семье с разными
  ФИО, общий телефон) — confidence threshold 0.85, ниже = manual review.
- **Undo через `aliasSnapshot`** — JSON массив строк, для восстановления
  оригинальных alias'ов и `reverted_at`.

---

## 5. OAuth refresh token (concurrent-safe mutex)

B24 OAuth токены живут 1 час. При получении 401 от B24 — refresh через
`refreshAccessToken`. Защита от race: два параллельных 401 могут оба
запустить refresh, перезатереть друг друга в БД и пойти retry с разными
токенами.

```mermaid
sequenceDiagram
    participant ReqA as Request A<br/>(imconnector.send)
    participant ReqB as Request B<br/>(crm.lead.add)
    participant Lock as _refreshLocks Map<br/>(in-memory)
    participant B24 as Bitrix24<br/>OAuth /oauth/token/
    participant Prisma as MySQL adapter

    Note over ReqA,ReqB: Оба запроса ловят 401 одновременно

    par
        ReqA->>ReqA: callBitrix24Method() throws 401
        ReqA->>Lock: existing = _refreshLocks.get("portal:social")
        Note over Lock: undefined (никто не рефрешит)
        ReqA->>Lock: SET "portal:social" → Promise (in-progress)
        ReqA->>+Prisma: findUser(portalDomain)
        Note over ReqA,Prisma: Double-check: другой инстанс<br/>мог уже обновить токен
        Prisma-->>-ReqA: User (tokenExpiresAt < now)
        ReqA->>+B24: POST /oauth/token/<br/>grant_type=refresh_token
        B24-->>-ReqA: {access_token, refresh_token, expires_in}
        ReqA->>Prisma: UPDATE user SET tokens, expiresAt
        ReqA->>Lock: DELETE "portal:social"
        ReqA->>ReqA: retry callBitrix24Method ✅
    and
        ReqB->>ReqB: callBitrix24Method() throws 401
        ReqB->>Lock: existing = _refreshLocks.get("portal:social")
        Note over Lock: Promise from Request A!
        ReqB->>ReqB: await existing
        Note over ReqB: Ждёт пока ReqA завершит refresh<br/>(НЕ запускает свой refresh)
        ReqB->>ReqB: получил accessToken от ReqA
        ReqB->>ReqB: retry callBitrix24Method ✅
    end
```

### Грабли в этом flow

- **`_refreshLocks` — in-memory Map**, не персистится. При рестарте
  adapter'а — clear. Это нормально: после рестарта токен в БД уже
  обновлён (через Prisma).
- **Per-portal-per-appKind ключ** (`"portal:social"`, `"portal:customer360"`):
  Customer-360 app и Social app — разные OAuth, не должны блокировать
  друг друга.
- **Если B24 oauth.bitrix.info лёг** (был факап 2025-03) — Promise
  висит на timeout (axios default 30s), все pending requests блокируются.
  TODO: добавить explicit timeout 10s на refresh + clear на error.
- **`tokenExpiresAt`** проверяется проактивно cron'ом (15 мин), чтобы
  не ждать 401: если осталось < 30 сек — pre-refresh.

---

## 🧭 Когда обновлять эти диаграммы

- **Любое изменение в `handleI2crmIncoming/Outgoing`** → проверь #2 и #3
- **Любое изменение customer-service `/merge/*`** → проверь #4
- **Любое изменение OAuth refresh logic** → проверь #5
- **Новый канал** (например, MAX-comment когда появится) → новый раздел

Все диаграммы — **GitHub Mermaid native** (рендерятся в .md). Не нужны
внешние tools.

## 📚 Связано

- `DATA_MODEL.md` — таблицы которые упомянуты в диаграммах
- `OPEN_LINE_LIFECYCLE.md` — что происходит в B24 при `imconnector.send`
- `INSTAGRAM_FLOW.md` — детали Instagram-flow (A2, поля, edge cases)
- `RUNBOOKS/incident-response.md` — что делать при сбое в любом flow
- `REGRESSIONS.md` — что уже ломалось в этих flow
