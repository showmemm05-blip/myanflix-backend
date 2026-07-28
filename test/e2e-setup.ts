/**
 * Runs before any e2e test file, before the AppModule (and its ConfigModule)
 * is ever imported. @nestjs/config's default .env loading never overwrites
 * a key already present in process.env, so setting DATABASE_URL here points
 * every e2e test at an isolated `myanflix_test` database instead of the
 * real dev database in `.env` — e2e tests create/mutate real rows (users,
 * deposits, wallets) and must never touch dev data.
 *
 * MinIO/stream vars are required by env.validation.ts (AppModule imports
 * every module, including ones that construct an S3 client eagerly) but are
 * never actually exercised by the deposit/notification/realtime e2e specs,
 * so placeholder-but-valid values are enough.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgresql://myanflix:53bab13f980d57719d8f13b6c3b16602@localhost:5432/myanflix_test?schema=public';
process.env.JWT_SECRET = 'e2e-test-jwt-secret-not-for-production';
process.env.JWT_REFRESH_SECRET = 'e2e-test-jwt-refresh-secret-not-for-prod';
process.env.MINIO_ENDPOINT = 'http://localhost:9000';
process.env.MINIO_ACCESS_KEY = 'test';
process.env.MINIO_SECRET_KEY = 'test';
process.env.STREAM_PUBLIC_BASE_URL = 'http://localhost:8080';
