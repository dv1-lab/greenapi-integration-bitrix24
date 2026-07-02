# 2026-07-02 — ВК: увод комментария в личку по `!` (surface-канал omnisocial)

> **СТАТУС: ЧЕРНОВИК — ожидает ревью Дмитрия перед деплоем.** Код в git
> полностью env-gated (`VK_COMMENT_LINE_ID`/`VK_PERSONAL_LINE_ID` пусты на
> боевом → ветка не активируется). Активация — на общей сессии деплоя.

## Контекст

omnisocial добавляет канал ВКонтакте (личка + комментарии) через surface-механизм
(этот social_connector, ADR [`2026-06-21-omnisocial-surface-redirect`](./2026-06-21-omnisocial-surface-redirect.md)):
исходящее из B24 на VK-линиях перенаправляется на ядро omnisocial → vk-adapter.

Нужен паритет с нативным `vkgroup`: увод автора комментария **в личку** по
маркеру `!` из Bitrix24 — так же, как для Instagram (PRODUCT_RULES §3.4).
operatorId (кто нажал `!`) доступен ТОЛЬКО здесь, в `handleBitrix24Webhook`
(`MESSAGES[0].message.user_id`) — surface-трансформер его отбрасывает. Значит
`!`-логика обязана жить в этом сервисе, как i2crm-шная.

**Ключевое отличие от Instagram, вскрытое при разборе кода i2crm:** в i2crm
реальная доставка DM идёт **отдельным вызовом собственного API i2crm**
(`/target/feedback` type=direct), а `imconnector.send.messages ... is_self_message`
— это лишь **зеркало для видимости** оператору (флаг `is_self_message` —
антилуп: B24 показывает сообщение как «отправлено бизнесом», но **сам не
доставляет** его). У ВК-surface аналогичного «отдельного канала доставки» нет —
поэтому одним зеркалом личка НЕ отправится. Доставку надо инициировать явно.

## Решение

Ветка `handleVkCommentOutgoing(webhook, lineNumber)` в `handleBitrix24Webhook`,
**до** обычного surface-forward, gated по env:

```
if (VK_COMMENT_LINE_ID && lineNumber === VK_COMMENT_LINE_ID) {
  const handled = await this.handleVkCommentOutgoing(webhook, lineNumber);
  if (handled) return handled;      // ! — обработали (личка), публичный коммент подавлен
  // без ! — падаем в обычный surface-forward → публичный wall.createComment (Этап 2A)
}
```

`handleVkCommentOutgoing`:
1. `text = MESSAGES[0].message.text`; `operatorId = Number(MESSAGES[0].message.user_id)`;
   `chatId = MESSAGES[0].chat.id` (голый VK user_id — тот же ключ, что в личке;
   склейку в один лид делает B24 по одинаковому chatId на обеих линиях +
   `CRM_CHAT_TRACKER=Y`).
2. Нет маркера `/^\s*!\s*/` → `return null` (обычный путь = публичный ответ).
3. Есть маркер → вырезать `!`; и:
   - **Реальная доставка DM:** найти личка surface-инстанс в БД по
     `bitrixLine === VK_PERSONAL_LINE_ID` (`prisma.instance.findFirst`), послать
     через surface green-api client `sendMessage(chatId, text)` → omnisocial →
     vk-adapter личка → `messages.send` → VK. При ответе **409 `messagesBlocked`**
     (ЛС закрыты, гейт `isMessagesFromGroupAllowed` в vk-adapter) → **мостик**:
     вызвать `/vk-bridge/{commentInstance}/{token}` (comment-инстанс по
     `bitrixLine === VK_COMMENT_LINE_ID`) → публичный vk.me-коммент.
   - **Зеркало для оператора:** `imconnector.send.messages` LINE=`VK_PERSONAL_LINE_ID`,
     `user.id == chat.id == chatId`, `extra.is_self_message: true` → B24 создаёт
     личка-сессию, показывает текст как отправленный (без повторной доставки).
   - **auto-transfer:** `mirrorChatId = resp.DATA.RESULT[0].session.CHAT_ID`;
     если есть mirrorChatId и operatorId → `imopenlines.operator.transfer
     {CHAT_ID: mirrorChatId, TRANSFER_ID: operatorId, MODE: "USER"}` (app-OAuth).

Инстансы берутся из БД по `bitrixLine` → новых env только два (line-id).
chat.id ВК везде голый user_id — вход == зеркало (правило CLAUDE.md §1, иначе
дубль chat-user, REGRESSIONS).

## Альтернативы

- **Только `is_self_message`-зеркало (как в первичном плане)** — отвергнуто:
  не доставляет DM (см. Контекст). Личка бы не ушла.
- **Отдельный internal-эндпоинт в omnisocial для доставки** — отвергнуто:
  vk-dm-логика уже есть в кабинете (`/api/conversations/[id]/vk-dm`), но она
  session-авторизована (оператор). Дублировать её server-to-server ради Task 7 —
  лишний скоуп; проще переиспользовать существующий surface green-api client +
  `/vk-bridge` прямым вызовом отсюда.
- **Инстансы через env (VK_*_INSTANCE_ID)** — отвергнуто: `Instance.bitrixLine`
  уже есть, деривация из БД по line-id убирает 2 лишних env и рассинхрон.

## Последствия

- **+** ВК достигает паритета с нативным `vkgroup` (личка из комментария).
- **+** Боевой i2crm/Instagram/surface не тронуты: ветка env-gated, при пустых
  VK-line-id не выполняется (доказать ревью + jest на существующих тестах).
- **−** Ещё одна «умная» ветка в `handleBitrix24Webhook` (сложность). Монитор:
  что публичный ответ (без `!`) по-прежнему идёт обычным surface-путём.
- **Мониторить:** доставку DM (лог 409→мостик), корректность mirrorChatId,
  склейку двух линий в один лид на E2E (как IG 18/22).

## Связано

- omnisocial план 2B: `omnisocial/docs/superpowers/plans/2026-07-02-omnisocial-vk-comments-dm-stage2b.md`
- omnisocial spec 2B: `omnisocial/docs/superpowers/specs/2026-07-02-omnisocial-vk-comments-dm-stage2b-design.md`
- IG-образец: PRODUCT_RULES §2.1/§3.4, ADR `2026-05-26-ig-comments-attach-to-open-entity`
- Surface: ADR `2026-06-21-omnisocial-surface-redirect`
- Код: sha ветки Task 7 — _вписать после коммита_
