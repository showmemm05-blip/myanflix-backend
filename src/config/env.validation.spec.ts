import 'reflect-metadata';
import { Logger } from '@nestjs/common';
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
  // A public production fixture logs the M-30 warning; keep it out of the
  // test output and let the M-30 block assert on it.
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  /** Everything the class requires, as a development machine would have it. */
  const base: Record<string, string> = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/myanflix?schema=public',
    JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef',
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
    WITHDRAWAL_CODE_PEPPER: 'unit-test-withdrawal-code-pepper-0123456789',
    OTP_CODE_PEPPER: 'unit-test-otp-code-pepper-0123456789abcdef',
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

    it.each([undefined, ''])(
      'refuses to boot a public deployment with WITHDRAWAL_CODE_PEPPER=%p — a leaked database would give the 6-digit codes away',
      (value) => {
        const env =
          value === undefined
            ? without(production, 'WITHDRAWAL_CODE_PEPPER')
            : { ...production, WITHDRAWAL_CODE_PEPPER: value };
        expect(() => validateEnv(env)).toThrow(
          /WITHDRAWAL_CODE_PEPPER must be set/,
        );
      },
    );

    it("keeps booting the owner's own computer (LAN cache base) without a pepper — the service logs a warning instead", () => {
      expect(() =>
        validateEnv({
          ...without(production, 'WITHDRAWAL_CODE_PEPPER'),
          STREAM_PUBLIC_BASE_URL: 'http://192.168.10.122:8080',
        }),
      ).not.toThrow();
    });

    it('treats 172.32.x.x as public — only 172.16-31 is private', () => {
      expect(() =>
        validateEnv({
          ...without(production, 'STREAM_PUBLIC_BASE_URL_IS_PUBLIC'),
          STREAM_PUBLIC_BASE_URL: 'http://172.32.0.1:8080',
        }),
      ).toThrow(/STREAM_PUBLIC_BASE_URL_IS_PUBLIC must be set/);
    });
  });

  describe('OTP_CODE_PEPPER (M-1)', () => {
    it('is optional in development, and an empty value counts as unset (OtpService then derives a key from JWT_SECRET)', () => {
      expect(validateEnv(base).OTP_CODE_PEPPER).toBeUndefined();
      expect(
        validateEnv({ ...base, OTP_CODE_PEPPER: '' }).OTP_CODE_PEPPER,
      ).toBeUndefined();
    });

    it('refuses a value shorter than 32 characters', () => {
      expect(() =>
        validateEnv({ ...base, OTP_CODE_PEPPER: 'too-short' }),
      ).toThrow(/OTP_CODE_PEPPER must be at least 32 characters/);
    });

    it.each([undefined, ''])(
      'refuses to boot a public deployment with OTP_CODE_PEPPER=%p',
      (value) => {
        const env =
          value === undefined
            ? without(production, 'OTP_CODE_PEPPER')
            : { ...production, OTP_CODE_PEPPER: value };
        expect(() => validateEnv(env)).toThrow(/OTP_CODE_PEPPER must be set/);
      },
    );

    it("keeps booting the owner's own computer (LAN cache base) without it", () => {
      expect(() =>
        validateEnv({
          ...without(production, 'OTP_CODE_PEPPER'),
          STREAM_PUBLIC_BASE_URL: 'http://192.168.10.122:8080',
        }),
      ).not.toThrow();
    });

    it('names BOTH missing peppers in one refusal, so the owner fixes them in one go', () => {
      expect(() =>
        validateEnv(
          without(
            without(production, 'OTP_CODE_PEPPER'),
            'WITHDRAWAL_CODE_PEPPER',
          ),
        ),
      ).toThrow(
        /WITHDRAWAL_CODE_PEPPER must be set.*OTP_CODE_PEPPER must be set/,
      );
    });
  });

  describe('OTP_DEV_CODE (fixed local-development code)', () => {
    const DEV = '246810';
    /** The owner's own computer: compose runs NODE_ENV=production on a LAN base. */
    const ownersComputer: Record<string, string> = {
      ...base,
      NODE_ENV: 'production',
      STREAM_PUBLIC_BASE_URL: 'http://192.168.10.122:8080',
    };

    it('is off when unset, and an empty value counts as unset (compose default `${OTP_DEV_CODE:-}`)', () => {
      expect(validateEnv(base).OTP_DEV_CODE).toBeUndefined();
      expect(
        validateEnv({ ...base, OTP_DEV_CODE: '' }).OTP_DEV_CODE,
      ).toBeUndefined();
      // Empty also never trips the public-deployment refusal.
      expect(() =>
        validateEnv({ ...production, OTP_DEV_CODE: '' }),
      ).not.toThrow();
    });

    it.each([
      ['localhost', 'http://localhost:8080'],
      ['127.0.0.1', 'http://127.0.0.1:8080'],
      ['a LAN address', 'http://192.168.10.122:8080'],
      ['a 10.x LAN address', 'http://10.0.0.5:8080'],
      ['an mDNS .local name', 'http://macbook.local:8080'],
    ])('boots a development machine whose cache base is %s', (_, url) => {
      expect(
        validateEnv({ ...base, STREAM_PUBLIC_BASE_URL: url, OTP_DEV_CODE: DEV })
          .OTP_DEV_CODE,
      ).toBe(DEV);
    });

    it("boots the owner's own computer (NODE_ENV=production, LAN cache base)", () => {
      expect(
        validateEnv({ ...ownersComputer, OTP_DEV_CODE: DEV }).OTP_DEV_CODE,
      ).toBe(DEV);
    });

    it("boots the owner's computer with every compose default filled in", () => {
      expect(
        validateEnv({
          ...ownersComputer,
          STREAM_PUBLIC_BASE_URL: 'http://localhost:8080',
          STREAM_PUBLIC_BASE_URL_IS_PUBLIC: '',
          MINIO_PUBLIC_ENDPOINT: 'http://localhost:8443',
          CORS_ORIGINS: '',
          TRUSTED_PROXIES: '',
          OTP_DEV_CODE: DEV,
        }).OTP_DEV_CODE,
      ).toBe(DEV);
    });

    it('boots with local-only CORS origins and a LAN upload address', () => {
      expect(
        validateEnv({
          ...ownersComputer,
          MINIO_PUBLIC_ENDPOINT: 'http://192.168.10.122:8443',
          CORS_ORIGINS: 'http://localhost:3003, http://192.168.10.122:3001',
          OTP_DEV_CODE: DEV,
        }).OTP_DEV_CODE,
      ).toBe(DEV);
    });

    // The cache base alone can look local on a real server: compose fills
    // in http://localhost:8080 when STREAM_PUBLIC_BASE_URL is left out, and
    // a single-box deployment still works that way. Any other public sign
    // must refuse the dev code too.
    it.each([
      [
        'STREAM_PUBLIC_BASE_URL_IS_PUBLIC=true',
        { STREAM_PUBLIC_BASE_URL_IS_PUBLIC: 'true' },
        /STREAM_PUBLIC_BASE_URL_IS_PUBLIC is "true"/,
      ],
      [
        'STREAM_PUBLIC_BASE_URL_IS_PUBLIC=TRUE (any case)',
        { STREAM_PUBLIC_BASE_URL_IS_PUBLIC: 'TRUE' },
        /STREAM_PUBLIC_BASE_URL_IS_PUBLIC is "true"/,
      ],
      [
        'a public MINIO_PUBLIC_ENDPOINT',
        { MINIO_PUBLIC_ENDPOINT: 'https://upload.example.com' },
        /MINIO_PUBLIC_ENDPOINT .* is not a local address/,
      ],
      [
        'an unparsable MINIO_PUBLIC_ENDPOINT',
        { MINIO_PUBLIC_ENDPOINT: 'upload.example.com' },
        /MINIO_PUBLIC_ENDPOINT .* is not a local address/,
      ],
      [
        'a public CORS origin among local ones',
        { CORS_ORIGINS: 'http://localhost:3003,https://myanflix.example.com' },
        /CORS_ORIGINS allows non-local website\(s\): https:\/\/myanflix\.example\.com/,
      ],
      [
        'TRUSTED_PROXIES set (a reverse proxy in front)',
        { TRUSTED_PROXIES: '127.0.0.1' },
        /TRUSTED_PROXIES is set/,
      ],
    ])(
      'refuses a localhost cache base when %s',
      (_, extra: Record<string, string>, reason) => {
        for (const nodeEnv of ['production', 'development']) {
          expect(() =>
            validateEnv({
              ...ownersComputer,
              NODE_ENV: nodeEnv,
              STREAM_PUBLIC_BASE_URL: 'http://localhost:8080',
              ...extra,
              OTP_DEV_CODE: DEV,
            }),
          ).toThrow(/OTP_DEV_CODE must not be set on a public deployment/);
          expect(() =>
            validateEnv({
              ...ownersComputer,
              NODE_ENV: nodeEnv,
              STREAM_PUBLIC_BASE_URL: 'http://localhost:8080',
              ...extra,
              OTP_DEV_CODE: DEV,
            }),
          ).toThrow(reason);
        }
      },
    );

    it('keeps a leading zero (the value stays text, never a number)', () => {
      expect(
        validateEnv({ ...base, OTP_DEV_CODE: '012345' }).OTP_DEV_CODE,
      ).toBe('012345');
    });

    it.each(['production', 'development', 'test'])(
      'refuses to boot with a public cache base whatever NODE_ENV is (%s)',
      (nodeEnv) => {
        expect(() =>
          validateEnv({
            ...production,
            NODE_ENV: nodeEnv,
            OTP_DEV_CODE: DEV,
          }),
        ).toThrow(/OTP_DEV_CODE must not be set on a public deployment/);
      },
    );

    it('refuses a public IP cache base too', () => {
      expect(() =>
        validateEnv({
          ...base,
          STREAM_PUBLIC_BASE_URL: 'http://203.0.113.7:8080',
          OTP_DEV_CODE: DEV,
        }),
      ).toThrow(/OTP_DEV_CODE must not be set on a public deployment/);
    });

    it.each(['not-a-url', 'ftp://localhost:8080', '   '])(
      'refuses when the cache base %p cannot prove this is a local machine',
      (url) => {
        expect(() =>
          validateEnv({
            ...base,
            STREAM_PUBLIC_BASE_URL: url,
            OTP_DEV_CODE: DEV,
          }),
        ).toThrow(
          /OTP_DEV_CODE must not be set on a public deployment.*missing or not an http\(s\) URL/,
        );
        // Without the dev code the same development config still boots.
        expect(() =>
          validateEnv({ ...base, STREAM_PUBLIC_BASE_URL: url }),
        ).not.toThrow();
      },
    );

    it.each([
      '12345',
      '1234567',
      'abcdef',
      '12345a',
      ' 123456',
      '123 456',
      '-12345',
    ])('refuses the malformed value %p (exactly 6 digits only)', (value) => {
      expect(() => validateEnv({ ...base, OTP_DEV_CODE: value })).toThrow(
        /OTP_DEV_CODE must be exactly 6 digits/,
      );
    });

    it('never echoes the code in a refusal', () => {
      let message = '';
      try {
        validateEnv({ ...production, OTP_DEV_CODE: DEV });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/OTP_DEV_CODE/);
      expect(message).not.toContain(DEV);

      try {
        validateEnv({ ...base, OTP_DEV_CODE: '98765' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/OTP_DEV_CODE must be exactly 6 digits/);
      expect(message).not.toContain('98765');
    });
  });

  describe('TMDB_API_KEY (movie details from TMDB)', () => {
    it('is optional everywhere, and an empty value counts as unset (compose default `${TMDB_API_KEY:-}`) — the feature is then simply off', () => {
      expect(validateEnv(base).TMDB_API_KEY).toBeUndefined();
      expect(
        validateEnv({ ...base, TMDB_API_KEY: '' }).TMDB_API_KEY,
      ).toBeUndefined();
      // A real deployment boots without it too.
      expect(validateEnv(production).TMDB_API_KEY).toBeUndefined();
      expect(
        validateEnv({ ...production, TMDB_API_KEY: '' }).TMDB_API_KEY,
      ).toBeUndefined();
    });

    it.each([
      ['a v3 API key (32 hex characters)', '0123456789abcdef0123456789abcdef'],
      [
        'an API Read Access Token',
        'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ1bml0LXRlc3QifQ.c2lnbmF0dXJl',
      ],
      // No format rule on purpose: a mistyped value must show up as "key
      // not accepted" in the admin, never stop the backend from booting.
      ['anything else, even a mistyped value', 'not-a-real-key'],
    ])('keeps %s exactly as given', (_what, value) => {
      expect(validateEnv({ ...base, TMDB_API_KEY: value }).TMDB_API_KEY).toBe(
        value,
      );
      expect(
        validateEnv({ ...production, TMDB_API_KEY: value }).TMDB_API_KEY,
      ).toBe(value);
    });

    it('a 32-digit key stays text — it is never read as a number', () => {
      const digits = '01234567890123456789012345678901';
      expect(validateEnv({ ...base, TMDB_API_KEY: digits }).TMDB_API_KEY).toBe(
        digits,
      );
    });
  });

  describe('WITHDRAWAL_CODE_PEPPER', () => {
    it('is optional in development, and an empty value counts as unset', () => {
      expect(validateEnv(base).WITHDRAWAL_CODE_PEPPER).toBeUndefined();
      expect(
        validateEnv({ ...base, WITHDRAWAL_CODE_PEPPER: '' })
          .WITHDRAWAL_CODE_PEPPER,
      ).toBeUndefined();
    });

    it('refuses a value shorter than 32 characters', () => {
      expect(() =>
        validateEnv({ ...base, WITHDRAWAL_CODE_PEPPER: 'too-short' }),
      ).toThrow(/WITHDRAWAL_CODE_PEPPER must be at least 32 characters/);
    });
  });

  describe('SMS settings', () => {
    const token = 'gateway-token-0123456789abcdef-0123456789';

    it('defaults to the log provider, a 1000/day cap, 10/day per number and a 90 s offline window — in production too', () => {
      for (const env of [base, production]) {
        const validated = validateEnv(env);
        expect(validated.SMS_PROVIDER).toBe('log');
        expect(validated.SMS_GATEWAY_TOKEN).toBeUndefined();
        expect(validated.SMS_DAILY_CAP).toBe(1000);
        expect(validated.SMS_DAILY_CAP_PER_PHONE).toBe(10);
        expect(validated.SMS_GATEWAY_OFFLINE_AFTER_SECONDS).toBe(90);
      }
    });

    it('treats the empty compose defaults as unset', () => {
      const validated = validateEnv({
        ...production,
        SMS_PROVIDER: '',
        SMS_GATEWAY_TOKEN: '',
        SMS_DAILY_CAP: '',
        SMS_DAILY_CAP_PER_PHONE: '',
        SMS_GATEWAY_OFFLINE_AFTER_SECONDS: '',
      });
      expect(validated.SMS_PROVIDER).toBe('log');
      expect(validated.SMS_GATEWAY_TOKEN).toBeUndefined();
      expect(validated.SMS_DAILY_CAP).toBe(1000);
      expect(validated.SMS_DAILY_CAP_PER_PHONE).toBe(10);
      expect(validated.SMS_GATEWAY_OFFLINE_AFTER_SECONDS).toBe(90);
    });

    it('boots the phone gateway with a 32+ character token and reads the numbers', () => {
      const validated = validateEnv({
        ...production,
        SMS_PROVIDER: 'phone-gateway',
        SMS_GATEWAY_TOKEN: token,
        SMS_DAILY_CAP: '250',
        SMS_DAILY_CAP_PER_PHONE: '4',
        SMS_GATEWAY_OFFLINE_AFTER_SECONDS: '120',
      });
      expect(validated.SMS_PROVIDER).toBe('phone-gateway');
      expect(validated.SMS_GATEWAY_TOKEN).toBe(token);
      expect(validated.SMS_DAILY_CAP).toBe(250);
      expect(validated.SMS_DAILY_CAP_PER_PHONE).toBe(4);
      expect(validated.SMS_GATEWAY_OFFLINE_AFTER_SECONDS).toBe(120);
    });

    it.each([undefined, ''])(
      'refuses the phone gateway without a token (%p), in every environment',
      (value) => {
        for (const env of [base, production]) {
          const input: Record<string, string> = {
            ...env,
            SMS_PROVIDER: 'phone-gateway',
          };
          if (value !== undefined) input.SMS_GATEWAY_TOKEN = value;
          expect(() => validateEnv(input)).toThrow(
            /SMS_GATEWAY_TOKEN must be set .*SMS_PROVIDER=phone-gateway/,
          );
        }
      },
    );

    it('refuses a token shorter than 32 characters', () => {
      expect(() =>
        validateEnv({
          ...base,
          SMS_PROVIDER: 'phone-gateway',
          SMS_GATEWAY_TOKEN: 'short',
        }),
      ).toThrow(/SMS_GATEWAY_TOKEN must be at least 32 characters/);
    });

    it('refuses an unknown provider instead of silently not sending', () => {
      expect(() => validateEnv({ ...base, SMS_PROVIDER: 'twilio' })).toThrow(
        /SMS_PROVIDER must be one of: log, phone-gateway/,
      );
    });

    it.each([
      ['SMS_DAILY_CAP', '0', /SMS_DAILY_CAP must be at least 1/],
      ['SMS_DAILY_CAP', 'lots', /SMS_DAILY_CAP must be a whole number/],
      [
        'SMS_DAILY_CAP_PER_PHONE',
        '0',
        /SMS_DAILY_CAP_PER_PHONE must be at least 1/,
      ],
      [
        'SMS_DAILY_CAP_PER_PHONE',
        '2.5',
        /SMS_DAILY_CAP_PER_PHONE must be a whole number/,
      ],
      [
        'SMS_GATEWAY_OFFLINE_AFTER_SECONDS',
        '10',
        /SMS_GATEWAY_OFFLINE_AFTER_SECONDS must be at least 30/,
      ],
    ])('refuses %s=%p', (key, value, message) => {
      expect(() => validateEnv({ ...base, [key]: value })).toThrow(message);
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

  describe('JWT secrets (M-33)', () => {
    it('refuses the .env.example placeholders in every environment', () => {
      expect(() =>
        validateEnv({
          ...base,
          JWT_SECRET: 'replace-with-a-long-random-string',
        }),
      ).toThrow(/JWT_SECRET is a placeholder/);
      expect(() =>
        validateEnv({
          ...base,
          JWT_REFRESH_SECRET: 'replace-with-a-different-long-random-string',
        }),
      ).toThrow(/JWT_REFRESH_SECRET is a placeholder/);
      expect(() =>
        validateEnv({ ...base, JWT_SECRET: 'change-me-locally-0123456789' }),
      ).toThrow(/JWT_SECRET is a placeholder/);
    });

    it('still allows a short-but-real secret outside production', () => {
      expect(() =>
        validateEnv({ ...base, JWT_SECRET: 'sixteen-chars-ok' }),
      ).not.toThrow();
    });

    it('requires 32+ characters in production', () => {
      expect(() =>
        validateEnv({ ...production, JWT_SECRET: 'sixteen-chars-ok' }),
      ).toThrow(
        /JWT_SECRET must be at least 32 characters when NODE_ENV=production/,
      );
      expect(() =>
        validateEnv({ ...production, JWT_REFRESH_SECRET: 'sixteen-chars-ok' }),
      ).toThrow(
        /JWT_REFRESH_SECRET must be at least 32 characters when NODE_ENV=production/,
      );
    });

    it('requires the two secrets to differ in production', () => {
      const same = 'one-secret-used-twice-0123456789abcdef';
      expect(() =>
        validateEnv({
          ...production,
          JWT_SECRET: same,
          JWT_REFRESH_SECRET: same,
        }),
      ).toThrow(/JWT_SECRET and JWT_REFRESH_SECRET must differ/);
      expect(() =>
        validateEnv({ ...base, JWT_SECRET: same, JWT_REFRESH_SECRET: same }),
      ).not.toThrow();
    });

    it("a LAN production setup (the owner's own machine) gets the same rules", () => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          JWT_SECRET: 'sixteen-chars-ok',
        }),
      ).toThrow(/at least 32 characters/);
      expect(() =>
        validateEnv({ ...base, NODE_ENV: 'production' }),
      ).not.toThrow();
    });
  });

  describe('CORS_ORIGINS (M-31)', () => {
    it('is optional and empty means unset', () => {
      expect(validateEnv(base).CORS_ORIGINS).toBeUndefined();
      expect(
        validateEnv({ ...base, CORS_ORIGINS: '' }).CORS_ORIGINS,
      ).toBeUndefined();
    });

    it('accepts a list of http(s) origins', () => {
      expect(
        validateEnv({
          ...base,
          CORS_ORIGINS: 'https://admin.example.com, http://localhost:3002',
        }).CORS_ORIGINS,
      ).toBe('https://admin.example.com, http://localhost:3002');
    });

    it('refuses an entry that is not a plain origin, naming it', () => {
      expect(() =>
        validateEnv({
          ...base,
          CORS_ORIGINS: 'https://admin.example.com,admin.example.com',
        }),
      ).toThrow(
        /CORS_ORIGINS entries must be http\(s\) origins .*: admin\.example\.com/,
      );
    });
  });

  describe('STREAM_URL_TTL_SECONDS (M-21)', () => {
    it('defaults to 4 hours', () => {
      expect(validateEnv(base).STREAM_URL_TTL_SECONDS).toBe(14400);
    });

    it('still honours an explicit value and the 1 h floor', () => {
      expect(
        validateEnv({ ...base, STREAM_URL_TTL_SECONDS: '43200' })
          .STREAM_URL_TTL_SECONDS,
      ).toBe(43200);
      expect(() =>
        validateEnv({ ...base, STREAM_URL_TTL_SECONDS: '600' }),
      ).toThrow(/at least 3600/);
    });
  });

  describe.each([
    ['DATABASE_POOL_MAX', 50],
    ['VIDEO_TRANSCODE_CONCURRENCY', 8],
  ] as const)('%s', (name, max) => {
    it('is optional, and an empty value counts as unset (not 0)', () => {
      expect(validateEnv(base)[name]).toBeUndefined();
      expect(validateEnv({ ...base, [name]: '' })[name]).toBeUndefined();
    });

    it('reads a whole number between 1 and the ceiling', () => {
      expect(validateEnv({ ...base, [name]: '1' })[name]).toBe(1);
      expect(validateEnv({ ...base, [name]: String(max) })[name]).toBe(max);
    });

    it.each(['0', String(max + 1), '2.5', 'lots'])('refuses %p', (value) => {
      expect(() => validateEnv({ ...base, [name]: value })).toThrow(
        new RegExp(name),
      );
    });
  });

  describe('TRUSTED_PROXIES startup warning (M-30)', () => {
    it('warns loudly, without failing the boot, for a public production deployment with no trusted proxies', () => {
      expect(() => validateEnv(production)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(
        /WARNING: TRUSTED_PROXIES is empty while STREAM_PUBLIC_BASE_URL \(https:\/\/cache\.example\.com\) is a public address/,
      );
      warn.mockClear();
      expect(() =>
        validateEnv({ ...production, TRUSTED_PROXIES: '' }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('stays quiet once TRUSTED_PROXIES is set', () => {
      validateEnv({ ...production, TRUSTED_PROXIES: '172.18.0.5' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('stays quiet on a LAN / same-machine production setup and outside production', () => {
      validateEnv({ ...base, NODE_ENV: 'production' });
      validateEnv({
        ...base,
        STREAM_PUBLIC_BASE_URL: 'https://cache.example.com',
      });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
