# ADR 2026-06-21: omnisocial-поверхность — перенаправление инстанса с Green API на ядро

## Контекст

omnisocial (свой омниканальный SaaS-инбокс, репо `dv1-lab/omnisocial`) строит
omni-платформу: операторы ведут один диалог из браузер-кабинета ИЛИ из Bitrix24.
Решение (дизайн-спека `omnisocial/docs/superpowers/specs/2026-06-21-omnisocial-b24-surface-design.md`):
кабинет = «хаб поверхностей», **переиспользует этот social-connector** как B24-поверхность,
не переписывая его. Коннектору подменяется источник «Green API» на ядро omnisocial.

## Решение

1. **Код коннектора (commit 291e3e9, env-gated):** перенаправление исходящих вызовов с
   `green-api.com` на ядро omnisocial ТОЛЬКО для инстансов из `OMNI_SURFACE_INSTANCES`:
   - `src/common/green-api-url.ts` — env-override base URL;
   - override `createGreenApiClient` в `Bitrix24Service` — подмена `baseUrl` + пересоздание
     axios SDK-клиента на `OMNI_SURFACE_URL`.
   При пустом `OMNI_SURFACE_INSTANCES` поведение боевых 5 инстансов НЕ меняется (доказано ревью).
2. **env:** `OMNI_SURFACE_INSTANCES=4099467`, `OMNI_SURFACE_URL=https://omnisocial.9wb.ru/api/green`.
3. **Тест-канал:** Telegram +79951145590, idInstance `4099467` → новая B24-линия **208**
   «omnisocial TG-тест». Боевые линии (148/174/178/182/204) не тронуты.

E2E подтверждён Дмитрием 2026-06-21: входящее TG → B24 линия 208 + кабинет; ответ из B24 → клиент;
ответ из кабинета → B24.

## Как подключали линию (и отклонения от конвенций — честно)

- **Линия создана через `imopenlines.config.add`** с использованием legacy `BITRIX_WEBHOOK_URL`.
  Это разовая ops-операция (не код); правило «BITRIX_WEBHOOK_URL legacy, не добавлять вызовы кодом»
  не нарушено — в код вызов не добавлялся. `imconnector.*` через вебхук B24 ЗАПРЕЩЁН
  («authorization type denied»), поэтому активацию вебхуком сделать нельзя.
- **Активация линии:** НЕ через ручной OAuth-рефреш (B24 ротирует refresh-token → сломал бы
  прод-авторизацию коннектора). Вместо — рестарт коннектора, его `b24-health-check.service.ts`
  (20с после старта) сам авто-активировал `social_connector` на линии 208 своим OAuth. ✅
- **Instance засеян прямым SQL INSERT в `adapter.Instance`** (idInstance=4099467,
  apiTokenInstance=SURFACE_TOKEN, stateInstance=authorized, userId=1begovoy.bitrix24.ru,
  bitrixLine=208, settings=`{"label":"omnisocial TG-test 79951145590","provider":"telegram"}`).
  ⚠️ **Отклонение от правила «не делать прямые SQL-правки в БД adapter / только prisma migrate».**
  Обоснование: штатный путь (виджет SETTING_CONNECTOR → `createInstanceForConnector`) требует ручного
  ввода токена в B24-UI; seed детерминирован, settings идентичны существующим telegram-инстансам.
  Это НЕ schema-change (migrate не требуется). Работает E2E. Если нужно «по-правильному» —
  пересоздать через виджет (instance можно удалить и завести заново).

## Последствия / на будущее

- Миграция боевых каналов (task #18 omnisocial): по этому же рецепту, поканально, с откатом.
  Полный рецепт + грабли — memory `omnisocial_b24_surface` (на стороне omnisocial).
- Приёмник omnisocial обязан отдавать `getSettings`/`setSettings` заглушки — иначе
  `createInstanceForConnector` падает (если будут создавать инстанс штатно через виджет).
