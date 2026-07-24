# ---- Build stage -----------------------------------------------------------
FROM node:26-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Prisma's generated client (src/generated/prisma) isn't checked into git —
# it has to exist before `nest build` compiles anything that imports it.
RUN npx prisma generate
RUN npm run build

# ---- Runtime stage ----------------------------------------------------------
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# fluent-ffmpeg shells out to a real ffmpeg binary at runtime — it has to
# exist in the image; npm doesn't install it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# node_modules copied whole (not a fresh --omit=dev install) so the Prisma
# CLI is available for `npx prisma migrate deploy` — see DOCKER.md. The
# image-size savings from dropping devDependencies isn't worth needing a
# second, different way to run migrations.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
COPY package.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN useradd --system --uid 1001 nestjs \
    && mkdir -p /app/storage \
    && chown -R nestjs:nestjs /app
USER nestjs

EXPOSE 3001

# Applying pending migrations on every start is safe — `migrate deploy` only
# ever applies migrations that haven't run yet, it's a no-op otherwise.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
