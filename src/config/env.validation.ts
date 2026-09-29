import { Transform, Type, plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsOptional()
  @IsIn([Environment.Development, Environment.Production, Environment.Test])
  NODE_ENV: Environment = Environment.Development;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  PORT: number = 3001;

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  @IsString()
  @MinLength(16, { message: 'JWT_SECRET must be at least 16 characters' })
  JWT_SECRET!: string;

  @IsString()
  @MinLength(16, {
    message: 'JWT_REFRESH_SECRET must be at least 16 characters',
  })
  JWT_REFRESH_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_EXPIRES_IN: string = '15m';

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN: string = '7d';

  /**
   * OAuth 2.0 *Web* client ID from Google Cloud Console — the `aud` every
   * Google ID token must carry. Empty/unset disables "Continue with Google"
   * (POST /auth/google answers 503); nothing else in the app changes.
   */
  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_ID?: string;

  /**
   * Client secret of that same OAuth Web client. Only the popup auth-code
   * flow (POST /auth/google with `code`) needs it — the backend exchanges
   * the code with Google server-side. Empty/unset leaves the ID-token
   * (`credential`) path working and makes the code path answer 503.
   */
  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_SECRET?: string;

  @IsOptional()
  @IsString()
  STORAGE_PATH: string = './storage';

  @IsString()
  @MinLength(1)
  MINIO_ENDPOINT!: string;

  @IsString()
  @MinLength(1)
  MINIO_ACCESS_KEY!: string;

  @IsString()
  @MinLength(1)
  MINIO_SECRET_KEY!: string;

  /**
   * The storage server's BROWSER-reachable address (the upload proxy), used
   * only to sign the presigned URLs the admin uploads through; falls back to
   * MINIO_ENDPOINT when unset. Required in production once the cache base is
   * public (see productionStreamProblems): the fallback is an internal
   * address and the compose default is localhost, neither of which a staff
   * browser on another machine can reach.
   */
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsOptional()
  @IsString()
  MINIO_PUBLIC_ENDPOINT?: string;

  @IsOptional()
  @IsString()
  MINIO_BUCKET: string = 'movies';

  @IsString()
  @MinLength(1)
  STREAM_PUBLIC_BASE_URL!: string;

  /**
   * "true" when STREAM_PUBLIC_BASE_URL is the cache server's own address
   * (a separate VPS, a CDN hostname): every playback and image URL then uses
   * it verbatim. Unset/"false", MinioService keeps only its protocol and
   * port and takes the host from the request — right on a dev machine that
   * hops networks, wrong on a split deployment, where the host serving the
   * API is the one machine with no cache server on it. Required in
   * production whenever the base names a public host (H-4). Case is
   * ignored; '' counts as unset (the compose default).
   */
  @Transform(({ value }: { value: unknown }) =>
    value === ''
      ? undefined
      : typeof value === 'string'
        ? value.trim().toLowerCase()
        : value,
  )
  @IsOptional()
  @IsIn(['true', 'false'], {
    message: 'STREAM_PUBLIC_BASE_URL_IS_PUBLIC must be "true" or "false"',
  })
  STREAM_PUBLIC_BASE_URL_IS_PUBLIC?: string;

  /**
   * The address THIS PROCESS uses to reach the cache server for server-side
   * checks only (VideoDiagnosisService's `cacheserver_master` probe). Never
   * used to build a URL handed to a client — those keep deriving their host
   * from the request. Needed because inside the backend container the
   * request-derived host is often `localhost`, i.e. the container itself,
   * not nginx; docker-compose defaults it to host.docker.internal:8080.
   * Optional: unset, the probe falls back to the request-derived base.
   */
  @IsOptional()
  @IsString()
  STREAM_INTERNAL_BASE_URL?: string;

  /**
   * Secret behind the `/s/<expires>/<signature>/` token on every playback
   * link (MinioService.signedPlaybackUrl). The cache server's nginx verifies
   * the same token with the same value, so this MUST equal
   * STREAM_SIGNING_SECRET in cacheserver/.env. No default on purpose: a
   * backend that boots without one would mint links nobody can play.
   */
  @IsString()
  @MinLength(32, {
    message: 'STREAM_SIGNING_SECRET must be at least 32 characters',
  })
  STREAM_SIGNING_SECRET!: string;

  /**
   * Lifetime of a signed playback link, in seconds. Hour-quantised at
   * signing time (quantizedExpiry: expiry = floor(now / 1h) * 1h + TTL), so
   * the effective lifetime is between TTL-1h and TTL — a TTL under one
   * hour would mint links that are already expired late in each hour.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3600, {
    message:
      'STREAM_URL_TTL_SECONDS must be at least 3600 (links are minted on hour boundaries)',
  })
  STREAM_URL_TTL_SECONDS: number = 43200;

  /**
   * "true" switches API rate limiting off entirely (AppThrottlerGuard).
   * Meant for the jest/e2e environment only — leave unset in production.
   * Kept a string on purpose: implicit conversion would turn "false" into
   * boolean true.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  THROTTLE_DISABLED?: string;

  /** Comma-separated proxy IPs whose X-Forwarded-For is trusted for rate-limit keys. Empty = none. */
  @IsOptional()
  @IsString()
  TRUSTED_PROXIES?: string;

  /**
   * Shared secret the phone-monitor desktop app presents as a bearer token
   * on POST /bank-events/* and in its socket handshake (MachineTokenGuard,
   * RealtimeGateway). Never a user login, never a JWT. Unset/empty = bank
   * event ingestion disabled: those routes answer 503 and machine socket
   * handshakes are refused; nothing else in the app changes. The compose
   * default is the empty string, which @IsOptional alone would NOT skip —
   * the transform folds '' into undefined so an unset token never fails the
   * MinLength check.
   */
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(32, {
    message: 'BANK_EVENTS_TOKEN must be at least 32 characters',
  })
  BANK_EVENTS_TOKEN?: string;
}

/** The hostname of an http(s) URL, lower-cased and unbracketed; null for anything else. */
function httpHostname(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Only this machine can use the address: loopback, or Docker's alias for the host. */
function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'host.docker.internal' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Not reachable from the internet: loopback, a private or link-local LAN
 * address, or an mDNS `.local` name. A cache base like this is a same-machine
 * or LAN setup (the owner's own computer runs the compose file, and so
 * NODE_ENV=production, with a LAN address), where deriving the host from the
 * request is exactly right.
 */
function isLocalHost(host: string): boolean {
  if (isLoopbackHost(host) || host.endsWith('.local')) return true;
  if (/^(fe80|fc[0-9a-f]{2}|fd[0-9a-f]{2}):/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * H-4: settings a production process must not start without. Every one of
 * them only breaks at request time otherwise — every playback and poster URL
 * pointing at the API host, or admin uploads signed for an address no staff
 * browser can reach — and nothing in the logs says why. All problems are
 * returned together so one failed deploy shows them all.
 */
function productionStreamProblems(env: EnvironmentVariables): string[] {
  const problems: string[] = [];
  const cacheHost = httpHostname(env.STREAM_PUBLIC_BASE_URL);
  if (!cacheHost) {
    return [
      'STREAM_PUBLIC_BASE_URL must be an http(s) URL of the cache server, e.g. https://cache.example.com',
    ];
  }
  // A same-machine or LAN cache keeps today's request-derived URLs.
  if (isLocalHost(cacheHost)) return problems;

  if (env.STREAM_PUBLIC_BASE_URL_IS_PUBLIC === undefined) {
    problems.push(
      `STREAM_PUBLIC_BASE_URL_IS_PUBLIC must be set when NODE_ENV=production and STREAM_PUBLIC_BASE_URL (${env.STREAM_PUBLIC_BASE_URL}) is a public address: ` +
        '"true" when that is the cache server\'s own address (a separate VPS or a CDN — the normal production setup), ' +
        '"false" only when the cache server runs on the same host the apps reach the API on. ' +
        'Left unset, every playback and image URL would point at the API host. See DOCKER.md, "Moving to the real VPS"',
    );
  }

  const uploadHost = httpHostname(env.MINIO_PUBLIC_ENDPOINT);
  if (!uploadHost || isLoopbackHost(uploadHost)) {
    problems.push(
      'MINIO_PUBLIC_ENDPOINT must be set when NODE_ENV=production and STREAM_PUBLIC_BASE_URL is a public address: ' +
        "the http(s) address staff browsers upload through (the storage server's upload proxy, e.g. https://upload.example.com), " +
        `never localhost or the internal MINIO_ENDPOINT (now: ${env.MINIO_PUBLIC_ENDPOINT ?? 'unset'})`,
    );
  }
  return problems;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const messages = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${messages}`);
  }

  if (validated.NODE_ENV === Environment.Production) {
    const problems = productionStreamProblems(validated);
    if (problems.length > 0) {
      throw new Error(
        `Invalid environment configuration for production: ${problems.join('; ')}`,
      );
    }
  }

  return validated;
}
