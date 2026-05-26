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

# Layer 2: код
COPY . .
# `prisma generate` качает engine binaries с binaries.prisma.sh. Иногда
# CDN флапает — добавляем retry-loop (3 попытки с экспоненциальным backoff).
# Build идёт чуть дольше если первая попытка падает, но не валится по
# transient-ошибке (ECONNRESET, TLS timeout).
RUN for i in 1 2 3; do \
        pnpm prisma generate && break || { \
            echo "prisma generate attempt $i failed, retry in $((i*15))s..."; \
            sleep $((i*15)); \
        }; \
    done && pnpm run build

EXPOSE 3000

# Prisma migrate deploy + production start
CMD pnpm prisma migrate deploy && pnpm run start:prod
