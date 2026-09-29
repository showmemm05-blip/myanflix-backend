import 'reflect-metadata';
import { validateEnv } from './env.validation';

/**
 * H-4: the production stream settings. MinioService builds every playback
 * and re-hosted image URL from the host the client used to reach the API
 * unless STREAM_PUBLIC_BASE_URL_IS_PUBLIC is "true" — right on a dev machine
 * that hops networks, and wrong on a split deployment, where the API host is
 * the one machine with no cache server on it. So a production process whose
 * cache base names a public address must say which of the two it is, or it
 * refuses to boot instead of handing out URLs nobody can load.
 */
describe('validateEnv', () => {
  /** Everything the class requires, as a development machine would have it. */
  const base: Record<string, string> = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/myanflix?schema=public',
    JWT_SECRET: 'unit-test-jwt-secret-0123456789',
    JWT_REFRESH_SECRET: 'unit-test-jwt-refresh-secret-0123',
    MINIO_ENDPOINT: 'http://localhost:9000',
    MINIO_ACCESS_KEY: 'key',
    MINIO_SECRET_KEY: 'secret',
    STREAM_PUBLIC_BASE_URL: 'http://localhost:8080',
    STREAM_SIGNING_SECRET: 'unit-test-stream-signing-secret-0123456789',
  };

  /** A split production deployment done right. */
  const production: Record<string, string> = {
    ...base,
    NODE_ENV: 'production',
    STREAM_PUBLIC_BASE_URL: 'https://cache.example.com',
    STREAM_PUBLIC_BASE_URL_IS_PUBLIC: 'true',
    MINIO_PUBLIC_ENDPOINT: 'https://upload.example.com',
  };

  const without = (env: Record<string, string>, key: string) => {
    const copy = { ...env };
    delete copy[key];
    return copy;
  };

  describe('STREAM_PUBLIC_BASE_URL_IS_PUBLIC', () => {
    it.each(['true', 'false', 'TRUE', ''])('accepts %p', (value) => {
      expect(() =>
        validateEnv({ ...base, STREAM_PUBLIC_BASE_URL_IS_PUBLIC: value }),
      ).not.toThrow();
    });

    it('is optional outside production', () => {
      expect(() => validateEnv(base)).not.toThrow();
    });

    it('refuses anything but true/false — "yes" would silently mean false', () => {
      expect(() =>
        validateEnv({ ...base, STREAM_PUBLIC_BASE_URL_IS_PUBLIC: 'yes' }),
      ).toThrow(/STREAM_PUBLIC_BASE_URL_IS_PUBLIC must be "true" or "false"/);
    });
  });

  describe('production', () => {
    it('boots a correctly configured split deployment', () => {
      expect(() => validateEnv(production)).not.toThrow();
    });

    it('also accepts an explicit "false" (cache on the host the clients reach the API on)', () => {
      expect(() =>
        validateEnv({
          ...production,
          STREAM_PUBLIC_BASE_URL_IS_PUBLIC: 'false',
        }),
      ).not.toThrow();
    });

    it.each([undefined, ''])(
      'refuses to boot with a public cache base and STREAM_PUBLIC_BASE_URL_IS_PUBLIC=%p',
      (value) => {
        const env =
          value === undefined
            ? without(production, 'STREAM_PUBLIC_BASE_URL_IS_PUBLIC')
            : { ...production, STREAM_PUBLIC_BASE_URL_IS_PUBLIC: value };
        expect(() => validateEnv(env)).toThrow(
          /STREAM_PUBLIC_BASE_URL_IS_PUBLIC must be set/,
        );
      },
    );

    it('refuses to boot when the browser upload address is missing', () => {
      expect(() =>
        validateEnv(without(production, 'MINIO_PUBLIC_ENDPOINT')),
      ).toThrow(/MINIO_PUBLIC_ENDPOINT must be set/);
    });

    it.each([
      'http://localhost:8443',
      'http://127.0.0.1:8443',
      'http://host.docker.internal:8443',
    ])(
      'refuses to boot when the browser upload address is %s — no staff browser can reach it',
      (endpoint) => {
        expect(() =>
          validateEnv({ ...production, MINIO_PUBLIC_ENDPOINT: endpoint }),
        ).toThrow(/MINIO_PUBLIC_ENDPOINT must be set/);
      },
    );

    it.each(['cache.example.com', 'ftp://cache.example.com', 'not a url'])(
      'refuses a STREAM_PUBLIC_BASE_URL that is not an http(s) URL: %p',
      (value) => {
        expect(() =>
          validateEnv({ ...production, STREAM_PUBLIC_BASE_URL: value }),
        ).toThrow(/STREAM_PUBLIC_BASE_URL must be an http\(s\) URL/);
      },
    );

    it('lists every problem at once, so one deploy attempt shows them all', () => {
      let message = '';
      try {
        validateEnv(
          without(
            without(production, 'STREAM_PUBLIC_BASE_URL_IS_PUBLIC'),
            'MINIO_PUBLIC_ENDPOINT',
          ),
        );
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/STREAM_PUBLIC_BASE_URL_IS_PUBLIC/);
      expect(message).toMatch(/MINIO_PUBLIC_ENDPOINT/);
    });

    /**
     * The owner's own machine runs the compose file (NODE_ENV=production)
     * with the cache on the same computer and a LAN or loopback base: the
     * request-derived host is exactly right there, so nothing new is needed.
     */
    it.each([
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://192.168.10.122:8080',
      'http://10.0.0.5:8080',
      'http://172.20.1.2:8080',
      'http://myanflix.local:8080',
    ])(
      'keeps booting a same-machine / LAN setup (%s) with the flag and upload address left as they are',
      (value) => {
        expect(() =>
          validateEnv({
            ...without(production, 'STREAM_PUBLIC_BASE_URL_IS_PUBLIC'),
            STREAM_PUBLIC_BASE_URL: value,
            MINIO_PUBLIC_ENDPOINT: 'http://localhost:8443',
          }),
        ).not.toThrow();
      },
    );

    it('treats 172.32.x.x as public — only 172.16-31 is private', () => {
      expect(() =>
        validateEnv({
          ...without(production, 'STREAM_PUBLIC_BASE_URL_IS_PUBLIC'),
          STREAM_PUBLIC_BASE_URL: 'http://172.32.0.1:8080',
        }),
      ).toThrow(/STREAM_PUBLIC_BASE_URL_IS_PUBLIC must be set/);
    });
  });

  it('never applies the production rules to development or test', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(() =>
        validateEnv({
          ...without(
            without(production, 'STREAM_PUBLIC_BASE_URL_IS_PUBLIC'),
            'MINIO_PUBLIC_ENDPOINT',
          ),
          NODE_ENV,
        }),
      ).not.toThrow();
    }
  });
});
