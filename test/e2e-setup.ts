/**
 * Runs before any e2e test file, before the AppModule (and its ConfigModule)
 * is ever imported. @nestjs/config's default .env loading never overwrites
 * a key already present in process.env, so setting DATABASE_URL here points
 * every e2e test at an isolated test database instead of the real dev
 * database in `.env` — e2e tests create/mutate real rows (users, deposits,
 * wallets) and must never touch dev data.
 *
 * WHICH DATABASE: the connection string comes from the shell, never from
 * this file (a committed URL leaked the real Postgres password — F-012):
 *
 *   E2E_DATABASE_URL=postgresql://<user>:<password>@localhost:5432/myanflix_test?schema=public \
 *     npm run test:e2e
 *
 * E2E_DATABASE_URL wins; DATABASE_URL is the fallback. Either way the
 * database name must end in `_test`, so a shell that still exports the dev
 * DATABASE_URL can never point these specs at real data. Neither set = the
 * run stops here with this explanation instead of guessing.
 *
 * MinIO/stream vars are required by env.validation.ts (AppModule imports
 * every module, including ones that construct an S3 client eagerly) but are
 * never actually exercised by the deposit/notification/realtime e2e specs,
 * so placeholder-but-valid values are enough.
 *
 * THROTTLE_DISABLED: the e2e specs hammer the API from one address; the
 * production rate limits are covered by their own supertest spec instead.
 *
 * The test database must be built with `prisma migrate deploy` (DATABASE_URL
 * pointed at it) and never used as a Prisma shadow database — a shadow run
 * drops and recreates it, wiping _prisma_migrations (F-106).
 */
process.env.NODE_ENV = 'test';
process.env.THROTTLE_DISABLED = 'true';
process.env.DATABASE_URL = e2eDatabaseUrl(
  process.env.E2E_DATABASE_URL || process.env.DATABASE_URL,
);
process.env.JWT_SECRET = 'e2e-test-jwt-secret-not-for-production';
process.env.JWT_REFRESH_SECRET = 'e2e-test-jwt-refresh-secret-not-for-prod';
process.env.MINIO_ENDPOINT = 'http://localhost:9000';
process.env.MINIO_ACCESS_KEY = 'test';
process.env.MINIO_SECRET_KEY = 'test';
process.env.STREAM_PUBLIC_BASE_URL = 'http://localhost:8080';
process.env.STREAM_SIGNING_SECRET =
  'e2e-test-stream-signing-secret-not-for-production';

function e2eDatabaseUrl(url: string | undefined): string {
  if (!url) {
    throw new Error(
      'e2e: set E2E_DATABASE_URL (or DATABASE_URL) to the test database, e.g. ' +
        'postgresql://<user>:<password>@localhost:5432/myanflix_test?schema=public',
    );
  }
  let database: string;
  try {
    database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(
      'e2e: E2E_DATABASE_URL / DATABASE_URL is not a valid postgresql:// URL',
    );
  }
  if (!database.endsWith('_test')) {
    throw new Error(
      `e2e: refusing database "${database}" — e2e specs write real rows, so ` +
        'the database name must end in "_test" (e.g. myanflix_test)',
    );
  }
  return url;
}
