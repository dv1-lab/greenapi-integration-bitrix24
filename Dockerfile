FROM node:20-alpine

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
RUN pnpm prisma generate && pnpm run build

EXPOSE 3000

# Prisma migrate deploy + production start
CMD pnpm prisma migrate deploy && pnpm run start:prod
