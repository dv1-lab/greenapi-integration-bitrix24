# Stage 1: Donor для node_modules (включая Prisma engines из pnpm-store).
# Когда binaries.prisma.sh + registry.npmjs.org недоступны с my-server
# (см. REGRESSIONS 26.05.2026) — берём весь готовый `/app/node_modules`
# из последнего успешно собранного image. Валидно пока не менялись
# `package.json` + `pnpm-lock.yaml` (deps не добавлялись).
# Если donor отсутствует (первый build на новом сервере) — Docker откатится
# на пересборку с нуля через `pnpm install` (требует доступ к npm + Prisma CDN).
FROM source-adapter:latest AS deps-donor

# Stage 2: Основной build.
# Используем Google зеркало Docker Hub вместо прямого `node:20-alpine`.
# Причина (26.05.2026, см. REGRESSIONS): прямые запросы к registry-1.docker.io
# с my-server (Стокгольм) периодически дают TLS handshake timeout / ECONNRESET —
# либо у hip.hosting проблемы с маршрутизацией к Cloudflare CDN, либо
# transient проблема Docker Hub. mirror.gcr.io — Google public pull-through
# cache, тянет тот же образ что и Docker Hub, работает стабильнее.
# Если когда-нибудь будет нужен оригинал — заменить на `node:20-alpine`.
FROM mirror.gcr.io/library/node:20-alpine

# pnpm@10 — pinned через packageManager в package.json.
# pnpm 11+ имеет minimum-release-age=24h по умолчанию, ломает Docker builds
# (см. memory feedback_pnpm_supply_chain_policy).
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

# Layer 1: manifest + lockfile (нужны для prisma migrate deploy в runtime).
COPY package.json pnpm-lock.yaml ./

# Layer 2: весь node_modules из donor (включая Prisma engines в pnpm-store).
# Это обходит и npm registry, и Prisma CDN. Если в `package.json` / lock
# добавились новые deps — donor неактуальный, нужно fallback на `pnpm install`
# (см. ниже комментарий про восстановление полноценной сборки).
COPY --from=deps-donor /app/node_modules /app/node_modules

# Layer 3: код
COPY . .

# Сборка TS → JS. Prisma generate не нужен — клиент уже сгенерирован в donor
# `node_modules/.pnpm/@prisma+client@.../node_modules/.prisma/client/`.
RUN pnpm run build

EXPOSE 3000

# Prisma migrate deploy + production start
CMD pnpm prisma migrate deploy && pnpm run start:prod
