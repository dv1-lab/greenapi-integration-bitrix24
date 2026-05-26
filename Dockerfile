# Stage 1: Donor для Prisma engines (когда binaries.prisma.sh недоступен с
# my-server — см. REGRESSIONS 26.05.2026). Берём engines из последнего
# успешно собранного image — они уже скомпилированы под linux-musl.
# Валидны пока не менялся `prisma/schema.prisma`. Если donor отсутствует
# (первый build на новом сервере) — fallback на retry с CDN ниже.
FROM source-adapter:latest AS prisma-engines-donor

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

# Layer 1: только manifest + lockfile, лучше cache hit
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Layer 2: pre-bundle Prisma engines из donor (overlay поверх node_modules).
# Если donor доступен — engines уже есть, `prisma generate` будет no-op.
# Если donor недоступен или схема изменилась — retry-loop ниже скачает с CDN.
COPY --from=prisma-engines-donor /app/node_modules/@prisma /app/node_modules/@prisma
COPY --from=prisma-engines-donor /app/node_modules/.prisma /app/node_modules/.prisma

# Layer 3: код
COPY . .

# `prisma generate` качает engine binaries с binaries.prisma.sh. Иногда
# CDN флапает — добавляем retry-loop (3 попытки с экспоненциальным backoff).
# Если engines уже скопированы из donor (Layer 2) и схема не менялась —
# generate отрабатывает быстро без сетевых запросов.
RUN for i in 1 2 3; do \
        pnpm prisma generate && break || { \
            echo "prisma generate attempt $i failed, retry in $((i*15))s..."; \
            sleep $((i*15)); \
        }; \
    done && pnpm run build

EXPOSE 3000

# Prisma migrate deploy + production start
CMD pnpm prisma migrate deploy && pnpm run start:prod
