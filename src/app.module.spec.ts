import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * DI smoke test. MinioService has no shared module — each module that needs
 * it lists it in its own providers (the pattern VideosModule/FinanceModule
 * established). Re-hosting persisted image URLs pulled that dependency into
 * several more modules, and a missing provider is the exact kind of mistake
 * that type-checks and unit-tests clean, then fails at boot with
 * "Nest can't resolve dependencies of X". Compiling the real AppModule is
 * what actually catches it.
 *
 * compile() wires every provider without running lifecycle hooks, so
 * nothing here connects to Postgres or MinIO.
 */
describe('AppModule', () => {
  // Only what env validation demands; nothing is contacted at compile time.
  const requiredEnv: Record<string, string> = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_SECRET: 'test-jwt-secret-value',
    JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-value',
    MINIO_ENDPOINT: 'http://localhost:9000',
    MINIO_ACCESS_KEY: 'test-access-key',
    MINIO_SECRET_KEY: 'test-secret-key',
    STREAM_PUBLIC_BASE_URL: 'http://localhost:8080',
  };

  let saved: Record<string, string | undefined>;

  beforeAll(() => {
    saved = Object.fromEntries(
      Object.keys(requiredEnv).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(requiredEnv)) {
      process.env[key] ??= value;
    }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('resolves every provider in every module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    await moduleRef.close();
  });
});
