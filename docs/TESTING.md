# Тесты — Social Connector adapter

## Запуск

```bash
pnpm test              # один прогон, все тесты
pnpm test:watch        # watch-mode (re-run при изменении файла)
pnpm test:cov          # с coverage report
pnpm test:smoke        # только smoke (по pattern названия)
pnpm test path/to/file # отдельный файл/директория
```

Текущее состояние (26.05.2026, после #58):
- **175 тестов, 6 suite, ~5 сек локально**
- Покрытие:
  - pure-функции в `src/common/`: Instagram OG fetcher, mask, greenApiUrl,
    **i2crm-payload** (валидация payload, A2 userKey, финальный текст,
    quoted, off-hours, phone E164), **outgoing-status** (dedup ordering,
    expiry, source mapping)
  - **Bitrix24Service** через NestJS DI mock: `handleI2crmIncoming`
    и `handleOutgoingMessageStatus` — early-return paths
    (`src/bitrix24/bitrix24.service.spec.ts`)

## Структура

```
src/
  common/
    instagram-og.ts        ← код
    instagram-og.spec.ts   ← рядом с кодом
    mask.ts
    mask.spec.ts
    green-api-url.ts
    green-api-url.spec.ts
```

**Правило**: `*.spec.ts` рядом с `*.ts`, не в отдельной `test/` папке.
Jest сам найдёт по pattern `*.spec.ts` / `*.test.ts`.

## Когда писать тест

- **При фиксе бага** — добавить test-case который воспроизводит баг.
  Если тест провалится без фикса — это доказательство что баг был.
  Каждая запись в REGRESSIONS.md должна иметь соответствующий тест.

- **При добавлении pure-функции** — сразу тест. Без него pure-функция
  имеет цену кода + тестируется только вручную.

- **При смене product-правила** в PRODUCT_RULES.md — тест что новое
  поведение работает.

## Когда НЕ писать тест

- Boilerplate NestJS code (DI wiring, module imports)
- DTO без логики
- Конфигурация (.env loading)
- HTTP-клиенты к третьим API (моки vs реальные — это integration)

## Pattern для smoke-тестов

### 1. Pure functions — без mock

```typescript
import { sourceFromConnector } from "./instagram-og";

describe("sourceFromConnector", () => {
  it("whatsapp → bridge_wa", () => {
    expect(sourceFromConnector("whatsapp")).toEqual({
      source: "bridge_wa", channel: "WA"
    });
  });
});
```

### 2. С мокированием axios / fetch / Prisma

```typescript
import axios from "axios";
import { fetchInstagramPostMedia } from "./instagram-og";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("fetchInstagramPostMedia", () => {
  beforeEach(() => mockedAxios.get.mockReset());

  it("happy path", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: '<meta property="og:image" content="https://cdn/x.jpg">',
    });
    expect(await fetchInstagramPostMedia("https://ig/p/1/")).toEqual({
      kind: "photo", url: "https://cdn/x.jpg",
    });
  });
});
```

### 3. Регрессия — тест каждого инцидента

```typescript
it("декодирует &amp; → & (грабля sha 5276e41)", () => {
  expect(htmlUnescape("a&amp;b")).toBe("a&b");
});
```

Связь с REGRESSIONS.md — обязательная (комментарий с sha).

## Что **не** покрыто (известный gap)

- **handleI2crmIncoming happy path** — есть только early-returns + журнал.
  Orchestrator-логика (B24 imconnector.send, mirror, backfill, customer-360)
  не покрыта unit-тестами. Альтернатива — integration test с реальным B24
  sandbox (требует setup).
- **handleOutgoingMessageStatus happy path** — есть только early-returns + dedup.
- **Webhook controller endpoints** — нужен supertest + Nest app.
- **End-to-end** flow (B24 webhook → adapter → Green API → B24
  outgoing) — это integration testing с реальной БД.

Эти gap'ы — кандидаты для следующих P0-итераций тестового покрытия.

## CI/CD

С 2026-05-26 — GitHub Actions `.github/workflows/test.yml` запускает
`pnpm test` на каждый push в main и PR. CI прошёл — зелёный значок в
README репозитория, регрессии ловятся до merge.

TODO (опциональное):
- Pre-commit hook через husky
- Coverage threshold (% lines) как failure condition

## DI mock pattern (для handleI2crmIncoming / handleOutgoingMessageStatus)

```typescript
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Bitrix24Service } from "./bitrix24.service";

const moduleRef = await Test.createTestingModule({
  providers: [
    Bitrix24Service,
    { provide: Bitrix24Transformer, useValue: mockTransformer() },
    { provide: PrismaService, useValue: mockPrisma() },
    { provide: ConfigService, useValue: mockConfig() },
    // ... остальные DI
  ],
}).compile();

const service = moduleRef.get<Bitrix24Service>(Bitrix24Service);
```

**Важно:**
- В `Bitrix24Service` constructor пропускает фоновые таймеры если
  `NODE_ENV=test` (jest выставляет это по умолчанию).
- В `afterEach` вызывать `service.onModuleDestroy()` чтобы остановить
  оставшиеся интервалы (для прода — это корректный cleanup).
- mockPrisma должен возвращать `null`/пустые массивы по умолчанию,
  чтобы тесты прерывались на ранних return'ах service.
- В каждом тесте — переопределять только нужные методы через
  `prisma.X.mock.findUnique.mockResolvedValueOnce(...)`.

## Связано

- `PRODUCT_RULES.md` — что тесты должны защищать
- `REGRESSIONS.md` — каждая регрессия = новый тест
- `decisions/` — ADR с тестируемыми решениями
