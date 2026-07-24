# Running the backend in Docker

Builds the NestJS API into an image and runs it alongside its own Postgres
container — everything the Flokinet VPS needs for the `backend` role.

## Run it

```bash
cd backend
cp .env.example .env
# edit .env: set real JWT_SECRET / JWT_REFRESH_SECRET (16+ chars each),
# change POSTGRES_PASSWORD from the placeholder, and set MINIO_ACCESS_KEY /
# MINIO_SECRET_KEY to match ../storage-server/.env
docker compose up -d --build
```

Requires `../storage-server` (MinIO) and `../cacheserver` running too — this
starts:
- `postgres` — Postgres 17, data persisted in a named volume
- `backend` — the API, built from `Dockerfile`, on `http://localhost:3001/api`

Pending Prisma migrations run automatically every time the container starts
(`prisma migrate deploy`, safe to repeat — it only applies what hasn't run
yet). Seeding is **not** automatic; run it manually when you actually want
sample data:

```bash
docker compose exec backend npx prisma db seed
```

## Where video actually lives now

ffmpeg only ever writes to local disk (`/app/storage`, the `backend-storage`
volume) as scratch space — it can't write directly to S3. Once a rendition
finishes transcoding, `ProcessingService` pushes it to MinIO
(`../storage-server`) and deletes the local copy; `backend-storage` only ever
holds in-flight uploads and the current transcode job now, not what's
actually streamed. Playback URLs point at `STREAM_PUBLIC_BASE_URL`
(`../cacheserver`), never at this backend or MinIO directly.

## Moving to the real VPS

Same image, same compose file — just:
- point `DATABASE_URL`/`POSTGRES_*` at whatever you actually want in
  production (this bundled Postgres container, or a managed one),
- point `MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` at the real
  Movie Storage Server VPS, and `STREAM_PUBLIC_BASE_URL` at the real cache
  server VPS's domain,
- set real secrets in `.env` (never commit it — already gitignored),
- deploy `backend/` to the Flokinet VPS and run the same `docker compose up
  -d --build`.
