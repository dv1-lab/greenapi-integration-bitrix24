# Тесты — Social Connector adapter

## Запуск

```bash
pnpm test              # один прогон, все тесты
pnpm test:watch        # watch-mode (re-run при изменении файла)
pnpm test:cov          # с coverage report
pnpm test:smoke        # только smoke (по pattern названия)
pnpm test path/to/file # отдельный файл/директория
```

Текущее состояние (26.05.2026):
- 66 тестов, 3 suite, ~0.7 сек локально
- Покрытие: pure-функции в `src/common/` (Instagram OG fetcher,
  mask, greenApiUrl)

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

- **handleI2crmIncoming** — главный flow, но требует MyNestModule с DI
  (Prisma mock, ConfigService mock, и т.д.). Большая инвестиция.
- **handleOutgoingMessageStatus** — то же.
- **Webhook controller endpoints** — нужен supertest + Nest app.
- **End-to-end** flow (B24 webhook → adapter → Green API → B24
  outgoing) — это integration testing с реальной БД.

Эти gap'ы — кандидаты для следующих P0-итераций тестового покрытия.

## CI/CD

Сейчас тесты **не** интегрированы в CI (нет GitHub Actions). Запуск
вручную перед commit.

TODO (отдельная задача):
- GitHub Actions `.github/workflows/test.yml` который запускает
  `pnpm test` на каждый PR/push
- Pre-commit hook через husky (опционально)

## Связано

- `PRODUCT_RULES.md` — что тесты должны защищать
- `REGRESSIONS.md` — каждая регрессия = новый тест
- `decisions/` — ADR с тестируемыми решениями
