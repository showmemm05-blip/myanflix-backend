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
# Drop the build-only tools (Nest CLI, Jest, ESLint, webpack, ...) before the
# runtime stage copies node_modules. The Prisma CLI and dotenv are regular
# dependencies in package.json, so `npx prisma migrate deploy` (CMD below)
# and prisma.config.ts still work after the prune.
RUN npm prune --omit=dev

# ---- Runtime stage ----------------------------------------------------------
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Two CLI toolchains the app shells out to at runtime, neither installed by
# npm: ffmpeg for fluent-ffmpeg (video transcoding), and poppler-utils for
# pdfinfo/pdftoppm (the books PDF -> WebP page conversion, see
# src/books/pdf.util.ts).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# The non-root user exists BEFORE the files arrive, and every COPY hands its
# files to that user directly. Ownership ends up exactly as a recursive chown
# would leave it, without Docker storing a second full copy of node_modules
# in an extra layer. /app itself and /app/storage (the scratch volume) belong
# to nestjs too.
RUN useradd --system --uid 1001 nestjs \
    && mkdir -p /app/storage \
    && chown nestjs:nestjs /app /app/storage

# node_modules arrives already pruned to production dependencies (see the
# build stage), and still includes the Prisma CLI for `prisma migrate
# deploy`. Only the compiled client in dist/generated is needed at runtime;
# the TypeScript sources in src/generated are not copied.
COPY --from=build --chown=nestjs:nestjs /app/node_modules ./node_modules
COPY --from=build --chown=nestjs:nestjs /app/dist ./dist
COPY --chown=nestjs:nestjs package.json ./
COPY --chown=nestjs:nestjs prisma ./prisma
COPY --chown=nestjs:nestjs prisma.config.ts ./

USER nestjs

EXPOSE 3001

# Applying pending migrations on every start is safe — `migrate deploy` only
# ever applies migrations that haven't run yet, it's a no-op otherwise.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
