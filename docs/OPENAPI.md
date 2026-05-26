# OpenAPI / Swagger UI — adapter

Adapter генерирует OpenAPI 3.1 spec автоматически через `@nestjs/swagger`.
Swagger UI запускается на `/api`, machine-readable JSON — на `/api-json`.

Last updated: 2026-05-26 (task #52).

---

## 🚀 Включение

Swagger UI **выключен по умолчанию** (security-safe default). Чтобы включить —
выставить env-переменные:

```bash
# /home/dv/greenapi-b24/.env
SWAGGER_USER=admin
SWAGGER_PASSWORD=<сильный-пароль-из-Bitwarden>
```

Без обеих переменных setupSwagger() возвращается тихо, эндпоинты не
регистрируются — никакого attack surface. **Это критично для prod**.

После добавления → перезапустить adapter:

```bash
ssh my-server
cd /home/dv/greenapi-b24
docker compose up -d adapter --force-recreate
```

## 🔐 Доступ

- **URL Swagger UI**: `https://social.9wb.ru/api`
- **URL JSON spec**: `https://social.9wb.ru/api-json`
- **Auth**: HTTP Basic с креденшелами из env (выше)

Пароль хранится **только** в:
1. `/home/dv/greenapi-b24/.env` (chmod 600 + gitignored)
2. Bitwarden (под item `social.9wb.ru Swagger`)

Никогда — в git, REGRESSIONS.md, vault. См. правило [[feedback-mask-secrets-in-debug-output]].

## 📋 Что в Swagger UI

| Tag | Что |
|---|---|
| **webhooks** | Все webhook-endpoints: green-api, i2crm, telegram-bot, bitrix24, internal/* |
| **oauth** | B24 OAuth install (Social + Customer-360 apps) |
| **widget** | Placement widget — `/widget/send`, instances, entity-phone |
| **media** | `/media/:file` — прокси для B24 |
| **health** | TODO: `/health` healthcheck (gap) |

Каждый endpoint имеет:
- HTTP method + path
- Summary + description (для главных endpoints)
- Body schema (через class-validator DTO декораторы)
- Параметры query/path
- Возможные status codes

## 🎯 Что НЕ задокументировано

Минимальное покрытие реализовано в этой итерации (P2). **Gap'ы:**

1. **`internal/*` endpoints** — описаны общим class-level @ApiTags, но без
   индивидуальных `@ApiOperation`. Используются wa-tg-bridge'ем и cron'ами,
   не партнёрами. Можно дополнить если станет actionable.
2. **DTO без `@ApiProperty`** — на полях DTO не выставлены декораторы для
   detail schema. Swagger показывает тип из TypeScript, но не описание
   полей и examples. Дополнить при #56 Public API.
3. **Response schemas** — пока только status codes, без полной типизации
   response body. Можно добавить через `@ApiResponse({ type })`.
4. **Authentication schemes** — Bitrix24WebhookGuard не задокументирован
   как security scheme. Можно добавить `@ApiBearerAuth` / `@ApiSecurity`.

Эти gap'ы — кандидаты на #56 (Public API / Developer portal).

## 📥 Скачать spec

После запуска adapter с Swagger включённым:

```bash
curl -u admin:$SWAGGER_PASSWORD https://social.9wb.ru/api-json > openapi.json
```

Spec файл можно импортировать в:
- **Postman**: File → Import → Upload Files → openapi.json
- **Insomnia**: Application → Preferences → Data → Import Data
- **VS Code REST Client**: расширение REST Client + сниппеты
- **Code generators**: openapi-generator-cli для Python/Go/TS/Java клиента

## 🧪 Try it out

В Swagger UI у каждого endpoint есть кнопка **«Try it out»**:

1. Открыть endpoint
2. Click «Try it out»
3. Заполнить параметры/body
4. Click «Execute»
5. Получить реальный response

**Внимание**: «Try it out» делает **реальные** запросы к adapter. Если
дёрнуть `/webhooks/i2crm` с тестовым payload — реально создастся
лид/контакт в B24. **Не использовать на prod**, только в dev-копии (когда
будет).

## ⚙️ Технические детали

- **Пакет**: `@nestjs/swagger@11.4.4`
- **Setup**: `src/main.ts` → `setupSwagger(app)`
- **Декораторы**: `@ApiTags`, `@ApiOperation`, `@ApiResponse`,
  `@ApiExcludeEndpoint`, `@ApiExcludeController`
- **Spec version**: OpenAPI 3.1
- **Безопасность**: Basic Auth middleware на `/api` + `/api-json`

## 📚 Связано

- [`DATA_MODEL.md`](./DATA_MODEL.md) — типы данных в request/response
- [`SEQUENCES.md`](./SEQUENCES.md) — flow какие endpoint вызывают друг друга
- [`SECURITY/THREAT_MODEL.md`](./SECURITY/THREAT_MODEL.md) — почему basic_auth обязателен
- `@nestjs/swagger` docs: https://docs.nestjs.com/openapi/introduction
