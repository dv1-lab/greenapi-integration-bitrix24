# RUNBOOKS — пошаговые инструкции на типичные операции

Когда нужно выполнить рутинную операцию (ротация токенов, добавление
нового номера, восстановление after-incident) — берём готовый runbook,
проходим по чеклисту. Это **не** документация архитектуры — это
**пошаговые рецепты** «как сделать X».

Каждый runbook должен включать:
1. **Когда применять** — триггеры (плановая ротация, инцидент, новый клиент)
2. **Prerequisites** — что должно быть на месте (доступы, креды)
3. **Шаги** — нумерованные, копипастные команды
4. **Verify** — как проверить что всё ок
5. **Rollback** — если пошло не так
6. **Связано** — ADR / PRODUCT_RULES которые это применяет

## Текущий список runbooks

- [`add-new-open-line.md`](./add-new-open-line.md) — Добавить новую
  open-line линию (новый WA-номер, TG-shard и т.д.)
- [`rotate-greenapi-token.md`](./rotate-greenapi-token.md) — Ротация
  Green API instance token
- [`backfill-tg-customer360.md`](./backfill-tg-customer360.md) — Backfill
  слияния sole-TG UUIDs с B24-side
- [`deploy-adapter.md`](./deploy-adapter.md) — Деплой adapter'а с pull+build
- [`deploy-bridge.md`](./deploy-bridge.md) — Деплой wa-tg-bridge
- [`deploy-dashboard.md`](./deploy-dashboard.md) — Деплой dv-dashboard
- [`restart-frozen-line.md`](./restart-frozen-line.md) — Что делать
  если open-line не отвечает на incoming
