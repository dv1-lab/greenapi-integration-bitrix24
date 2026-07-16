# ADR 2026-07-17: Резолв TG/MAX-лидов в Customer-360 по chat id, не по b24_lead

## Контекст

`handleB24CrmEvent` (ONCRMLEADADD) резолвил клиента каскадом
phone → email → ig_client → **b24_lead**. TG/MAX-лиды от open-line
(Wappi/SC-коннектор) телефона и email не имеют → падали на `b24_lead`-alias,
и customer-service создавал НОВОГО клиента с единственным алиасом
`b24_lead=<id>`. Переписка того же человека при этом живёт на клиенте с
алиасом `tg_user`/`max_chat` (пишет wa-tg-bridge) → в Customer-360 два
клиента-двойника: у одного лид без переписки, у другого переписка без лида.
Кейс: лид #364682 (Telegram-клиент open-line, лид и переписка оказались на
двух разных клиентах Customer-360), разбор 16.07.2026.

Для Instagram эта связка уже существовала (резолв по `UF_CRM_IG_CHAT_ID` →
`ig_client`) — TG/MAX были пропущены.

## Решение

1. Каскад резолва расширен: `phone → email → ig_client → tg_user → max_chat
   → b24_lead/b24_contact`. Источники chat id:
   - `snap.UF_CRM_TG_CHAT_ID` / `snap.UF_CRM_MAX_CHAT_ID` (если проставлены);
   - иначе — chat id, распарсенный `_maybeLinkOrphanLead` из TITLE либо
     activity (`IMOPENLINES_SESSION`): linker теперь возвращает
     `chatChannel`/`chatId` во всех ветках, где парс удался (в т.ч.
     `no existing contact` — кейс нового клиента).
2. Значения alias'ов — те же, что использует wa-tg-bridge
   (`tg_user=<user_id>`, `max_chat=<chat_id>`), поэтому лид садится на того
   же клиента, что и переписка.

## Последствия

- Новые TG/MAX-лиды больше не плодят двойников; в карточке клиента дашборда
  блок B24 сразу показывает лид.
- Существующие двойники (лид-огрызки с одним `b24_lead`-алиасом) остаются в
  данных — чистятся отдельно (merge в customer-service).
- Порядок каскада сохраняет прежние приоритеты: телефон/почта, если есть,
  выигрывают (стабильнее чат-идентификаторов).
