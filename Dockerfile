# Коннектор Битрикс24 (NestJS + Prisma + MySQL) — сборка с нуля.
# Годится для любого сервера, в том числе при восстановлении на новом.
# Быстрый вариант из готового образа на уже работающем сервере — Dockerfile.donor.
#
# Зеркало Google вместо прямого Docker Hub: с наших серверов Docker Hub временами
# отвечает TLS handshake timeout (REGRESSIONS 26.05.2026).
FROM mirror.gcr.io/library/node:20-alpine

# openssl нужен движку Prisma на alpine.
# pnpm@10 закреплён: у pnpm 11+ minimum-release-age=24h ломает сборку.
RUN apk add --no-cache openssl \
    && corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# prisma generate — после COPY кода: нужна свежая schema.prisma.
RUN pnpm prisma generate && pnpm run build

EXPOSE 3000

# Миграции базы при каждом старте (идемпотентно), затем запуск.
CMD pnpm prisma migrate deploy && pnpm run start:prod
