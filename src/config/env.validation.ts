import { Logger } from '@nestjs/common';
import { Transform, Type, plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import {
  DEFAULT_SMS_DAILY_CAP,
  DEFAULT_SMS_DAILY_CAP_PER_PHONE,
  DEFAULT_SMS_GATEWAY_OFFLINE_AFTER_SECONDS,
  DEFAULT_SMS_PROVIDER,
  MIN_SMS_GATEWAY_OFFLINE_AFTER_SECONDS,
  MIN_SMS_GATEWAY_TOKEN_LENGTH,
  SMS_PROVIDERS,
  type SmsProvider,
} from '../sms/sms.config';
import { corsOriginProblems, parseCorsOrigins } from './cors.config';

/** '' (a compose default of `${X:-}`) means "unset", never a value. */
const emptyAsUndefined = ({ value }: { value: unknown }) =>
  value === '' ? undefined : value;

/**
 * '' means "use the default". Reads the RAW value from `obj`, not `value`:
 * with enableImplicitConversion a numeric field's '' has already become 0
 * by the time a custom transform runs (see common/decorators/to-boolean).
 */
const emptyAsDefault =
  (fallback: string | number) =>
  ({ obj, key, value }: { obj: unknown; key: string; value: unknown }) => {
    const raw = (obj as Record<string, unknown>)[key];
    return raw === '' || raw === undefined || raw === null ? fallback : value;
  };

/**
 * '' means "unset" for an optional NUMBER with no default. Reads the RAW
 * value for the same reason as emptyAsDefault: implicit conversion has
 * already turned '' into 0, which would then fail the Min(1) check.
 */
const emptyNumberAsUndefined = ({
  obj,
  key,
  value,
}: {
  obj: unknown;
  key: string;
  value: unknown;
}) => ((obj as Record<string, unknown>)[key] === '' ? undefined : value);

/** The env var that turns the fixed local-development OTP code on. */
export const OTP_DEV_CODE_ENV = 'OTP_DEV_CODE';
/** OTP_DEV_CODE must look exactly like a real code: six digits. */
export const OTP_DEV_CODE_PATTERN = /^\d{6}$/;
export const OTP_DEV_CODE_FORMAT_MESSAGE =
  'OTP_DEV_CODE must be exactly 6 digits (0-9), e.g. 123456 — or leave it empty/unset to send real codes';

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

  /**
   * Most database connections this backend process keeps open at once
   * (PrismaService). Unset or empty = 10, node-postgres' own default and
   * the behaviour before this setting existed. Keep the total across every
   * process that uses the database (backend instances, admin tools, backups)
   * well under Postgres' max_connections (100 by default).
   */
  @Transform(emptyNumberAsUndefined)
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'DATABASE_POOL_MAX must be a whole number' })
  @Min(1, { message: 'DATABASE_POOL_MAX must be at least 1' })
  @Max(50, { message: 'DATABASE_POOL_MAX must be at most 50' })
  DATABASE_POOL_MAX?: number;

  /**
   * How many videos may transcode at the same time (the video processing
   * queue). Unset or empty = that code's own default. 1-8: every transcode
   * runs ffmpeg, which uses all CPU cores it is given.
   */
  @Transform(emptyNumberAsUndefined)
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'VIDEO_TRANSCODE_CONCURRENCY must be a whole number' })
  @Min(1, { message: 'VIDEO_TRANSCODE_CONCURRENCY must be at least 1' })
  @Max(8, { message: 'VIDEO_TRANSCODE_CONCURRENCY must be at most 8' })
  VIDEO_TRANSCODE_CONCURRENCY?: number;

  /**
   * Signs every access token; JWT_REFRESH_SECRET every refresh token. Whoever
   * knows one can mint a token for any account, the super admin included, so
   * (M-33): never a placeholder (`replace-with-...`, `change-me`, ... are
   * refused in every environment, see jwtSecretProblems), at least 32
   * characters and different from each other when NODE_ENV=production.
   * `openssl rand -hex 32` makes a good one.
   */
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

  /**
   * The TMDB credential behind "movie details from TMDB" (src/tmdb), added
   * by the owner. Either of the two TMDB gives out works: the v3 "API Key"
   * (32 hex characters, sent as the `api_key` query parameter) or the "API
   * Read Access Token" (anything else, sent as `Authorization: Bearer`).
   * Unset or '' = the feature is off and nothing else changes: uploads
   * behave exactly as before, no lookup runs, and every /tmdb route except
   * GET /tmdb/status and GET /tmdb/movies/state (which reads only our own
   * rows) answers 503 TMDB_NOT_CONFIGURED. No format rule on
   * purpose — a mistyped value must show up as "key not accepted" in the
   * admin, never stop the backend from booting. Read only by the backend:
   * it never reaches a browser and is never logged.
   */
  @Transform(emptyAsUndefined)
  @IsOptional()
  @IsString()
  TMDB_API_KEY?: string;

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
   * Default 4 h (M-21): a playback link is a bearer URL that anyone holding
   * it can play, so the shorter it lives the less a pasted link is worth;
   * the players fetch a fresh one on 410. Mirrors
   * DEFAULT_STREAM_URL_TTL_SECONDS in common/storage/minio.service.ts.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3600, {
    message:
      'STREAM_URL_TTL_SECONDS must be at least 3600 (links are minted on hour boundaries)',
  })
  STREAM_URL_TTL_SECONDS: number = 14400;

  /**
   * "true" switches API rate limiting off entirely (AppThrottlerGuard).
   * Meant for the jest/e2e environment only — leave unset in production.
   * Kept a string on purpose: implicit conversion would turn "false" into
   * boolean true.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  THROTTLE_DISABLED?: string;

  /**
   * Comma-separated IPs of the reverse proxies in front of the API. Only a
   * connection FROM one of them may set X-Forwarded-For — for the rate-limit
   * keys, the tracking rows and the socket gateway alike
   * (config/trusted-proxies.ts). Empty = the API is reached directly and
   * the socket peer is every client's address. Must be set the day nginx /
   * HTTPS goes in front, or every visitor shares the proxy's rate-limit
   * bucket (M-30: a production boot with a public cache base and an empty
   * list logs a warning, see startupWarnings).
   */
  @IsOptional()
  @IsString()
  TRUSTED_PROXIES?: string;

  /**
   * Comma-separated browser origins allowed to call the API cross-origin,
   * e.g. `https://admin.example.com,https://www.example.com` (M-31). Unset
   * or empty = any origin, exactly as before the variable existed. Requests
   * with no Origin header (the mobile app, the phone-monitor, curl) are
   * never affected. Each entry must be a plain http(s) origin — scheme,
   * host, optional port, nothing after — or the backend refuses to boot
   * (config/cors.config.ts).
   */
  @Transform(emptyAsUndefined)
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

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

  /**
   * Server secret mixed into every 6-digit withdrawal code before it is
   * bcrypt-hashed (WithdrawalCodeHasher). A 6-digit code has only 1,000,000
   * values, so without it a leaked database gives every code away in hours;
   * with it, the database alone is not enough. Generate once with
   * `openssl rand -hex 32` and NEVER change or remove it afterwards: codes
   * saved under it can then no longer be checked (withdrawals answer 503
   * until the old value is back, or the user sets a new code with "Forgot
   * code"). Codes saved before it was first set keep working and are
   * upgraded on their next right entry. Optional on a development machine
   * and on the owner's own computer (a warning is logged); required for a
   * public production deployment (see productionSecretProblems). '' = unset.
   */
  @Transform(emptyAsUndefined)
  @IsOptional()
  @IsString()
  @MinLength(32, {
    message: 'WITHDRAWAL_CODE_PEPPER must be at least 32 characters',
  })
  WITHDRAWAL_CODE_PEPPER?: string;

  /**
   * M-1: server secret that keys the HMAC-SHA256 under which every SMS
   * one-time code is stored (src/otp/otp-code.hasher.ts) — the plain code
   * never reaches the database. Unset = a key derived from JWT_SECRET is
   * used instead (OtpService logs a warning in production), so a
   * development or LAN setup needs nothing new; required for a public
   * production deployment (see productionSecretProblems). Unlike the
   * withdrawal pepper it is safe to change: only codes still in flight (5
   * minutes) stop working. '' = unset.
   */
  @Transform(emptyAsUndefined)
  @IsOptional()
  @IsString()
  @MinLength(32, {
    message: 'OTP_CODE_PEPPER must be at least 32 characters',
  })
  OTP_CODE_PEPPER?: string;

  /**
   * LOCAL DEVELOPMENT ONLY: a fixed 6-digit code that every one-time code
   * becomes (sign-in, password reset, withdrawal-code reset), with NO SMS
   * sent or queued — see src/otp/otp-dev-code.ts. Stored and checked exactly
   * like a real code (keyed hash, 5-minute expiry, single use, 5 tries, the
   * same request limits). Unset or '' = off, behaviour unchanged. The
   * backend refuses to start with it set whenever STREAM_PUBLIC_BASE_URL is
   * not a loopback/LAN address, in EVERY NODE_ENV (otpDevCodeProblems).
   */
  @Transform(emptyAsUndefined)
  @IsOptional()
  @IsString({ message: OTP_DEV_CODE_FORMAT_MESSAGE })
  @Matches(OTP_DEV_CODE_PATTERN, { message: OTP_DEV_CODE_FORMAT_MESSAGE })
  OTP_DEV_CODE?: string;

  /**
   * How OTP codes are sent — see src/sms/sms.config.ts. "log" (default:
   * development only, nothing is sent) or "phone-gateway" (the company
   * Android phone sends them from its own SIM). Unset or empty = "log", so
   * a missing provider never stops the backend from booting.
   */
  @Transform(emptyAsDefault(DEFAULT_SMS_PROVIDER))
  @IsOptional()
  @IsIn(SMS_PROVIDERS, {
    message: `SMS_PROVIDER must be one of: ${SMS_PROVIDERS.join(', ')}`,
  })
  SMS_PROVIDER: SmsProvider = DEFAULT_SMS_PROVIDER;

  /**
   * Shared secret the SMS gateway phone presents as a bearer token on every
   * /sms-gateway/device/* route (DeviceTokenGuard). Never a user login,
   * never a JWT. Required (32+ characters) when SMS_PROVIDER=phone-gateway;
   * unset = every device route answers 401.
   */
  @Transform(emptyAsUndefined)
  @IsOptional()
  @IsString()
  @MinLength(MIN_SMS_GATEWAY_TOKEN_LENGTH, {
    message: `SMS_GATEWAY_TOKEN must be at least ${MIN_SMS_GATEWAY_TOKEN_LENGTH} characters`,
  })
  SMS_GATEWAY_TOKEN?: string;

  /** SMS the gateway may queue per UTC day; beyond it requests get 503. */
  @Transform(emptyAsDefault(DEFAULT_SMS_DAILY_CAP))
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'SMS_DAILY_CAP must be a whole number' })
  @Min(1, { message: 'SMS_DAILY_CAP must be at least 1' })
  SMS_DAILY_CAP: number = DEFAULT_SMS_DAILY_CAP;

  /** SMS one number may be queued per UTC day; beyond it that number gets 409. */
  @Transform(emptyAsDefault(DEFAULT_SMS_DAILY_CAP_PER_PHONE))
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'SMS_DAILY_CAP_PER_PHONE must be a whole number' })
  @Min(1, { message: 'SMS_DAILY_CAP_PER_PHONE must be at least 1' })
  SMS_DAILY_CAP_PER_PHONE: number = DEFAULT_SMS_DAILY_CAP_PER_PHONE;

  /** The gateway is offline once no device was seen for this many seconds. */
  @Transform(emptyAsDefault(DEFAULT_SMS_GATEWAY_OFFLINE_AFTER_SECONDS))
  @IsOptional()
  @Type(() => Number)
  @IsInt({
    message: 'SMS_GATEWAY_OFFLINE_AFTER_SECONDS must be a whole number',
  })
  @Min(MIN_SMS_GATEWAY_OFFLINE_AFTER_SECONDS, {
    message: `SMS_GATEWAY_OFFLINE_AFTER_SECONDS must be at least ${MIN_SMS_GATEWAY_OFFLINE_AFTER_SECONDS} (the phone heartbeats every 30 s)`,
  })
  SMS_GATEWAY_OFFLINE_AFTER_SECONDS: number =
    DEFAULT_SMS_GATEWAY_OFFLINE_AFTER_SECONDS;
}

/**
 * Settings that only make sense together. Checked in every environment:
 * choosing the phone gateway is an explicit opt-in, and a gateway nobody
 * can authenticate to would refuse every code request at runtime instead.
 */
function smsProblems(env: EnvironmentVariables): string[] {
  if (env.SMS_PROVIDER === 'phone-gateway' && !env.SMS_GATEWAY_TOKEN) {
    return [
      `SMS_GATEWAY_TOKEN must be set (at least ${MIN_SMS_GATEWAY_TOKEN_LENGTH} characters, e.g. \`openssl rand -hex 32\`) when SMS_PROVIDER=phone-gateway — the gateway phone authenticates with it`,
    ];
  }
  return [];
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

/**
 * Secrets a public production deployment (the same test as
 * productionStreamProblems: a cache base that is not loopback/LAN) must
 * carry. The owner's own computer, which runs the compose file with
 * NODE_ENV=production and a LAN cache base, keeps booting without them —
 * WithdrawalCodeService logs a warning there instead.
 */
function productionSecretProblems(env: EnvironmentVariables): string[] {
  const cacheHost = httpHostname(env.STREAM_PUBLIC_BASE_URL);
  if (!cacheHost || isLocalHost(cacheHost)) return [];
  const problems: string[] = [];
  if (!env.WITHDRAWAL_CODE_PEPPER) {
    problems.push(
      'WITHDRAWAL_CODE_PEPPER must be set (at least 32 characters, e.g. `openssl rand -hex 32`) when NODE_ENV=production and STREAM_PUBLIC_BASE_URL is a public address: ' +
        'without it a leaked database gives every 6-digit withdrawal code away. Never change it once set',
    );
  }
  if (!env.OTP_CODE_PEPPER) {
    problems.push(
      'OTP_CODE_PEPPER must be set (at least 32 characters, e.g. `openssl rand -hex 32`) when NODE_ENV=production and STREAM_PUBLIC_BASE_URL is a public address: ' +
        'it keys the hash every SMS sign-in and password-reset code is stored under, so a leaked database or JWT_SECRET alone does not give live codes away',
    );
  }
  return problems;
}

/** What otpDevCodeProblems looks at: the dev code and every "this is public" signal. */
export interface OtpDevCodeEnv {
  OTP_DEV_CODE?: string;
  STREAM_PUBLIC_BASE_URL?: string;
  STREAM_PUBLIC_BASE_URL_IS_PUBLIC?: string;
  MINIO_PUBLIC_ENDPOINT?: string;
  CORS_ORIGINS?: string;
  TRUSTED_PROXIES?: string;
}

/** A set (non-blank) value that is not an http(s) URL on a loopback/LAN host. */
function isSetAndNotLocal(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  const host = httpHostname(value.trim());
  return !host || !isLocalHost(host);
}

/**
 * OTP_DEV_CODE must never reach a public deployment: with it, anyone who
 * knows (or guesses) six digits can reset any phone account's password.
 * Checked in EVERY environment, not only NODE_ENV=production (the owner's
 * own computer runs NODE_ENV=production with a localhost/LAN cache base and
 * keeps booting with it).
 *
 * It starts from the same "public" test as productionStreamProblems /
 * productionSecretProblems — a cache base that is not loopback/LAN, where a
 * missing or unparsable base counts as public (it cannot be proven local) —
 * and then fails closed on every other sign of an internet-facing setup,
 * because the cache base alone can look local on a real server: compose
 * fills in http://localhost:8080 when STREAM_PUBLIC_BASE_URL is left out,
 * and a single-box deployment then still works (playback derives its host
 * from the request). So it also refuses when STREAM_PUBLIC_BASE_URL_IS_PUBLIC
 * is "true", MINIO_PUBLIC_ENDPOINT or any CORS_ORIGINS entry is set to a
 * non-local address, or TRUSTED_PROXIES is set (a reverse proxy in front).
 * Every reason found is listed. Exported so OtpService can repeat the check
 * (otp-dev-code.ts).
 */
export function otpDevCodeProblems(env: OtpDevCodeEnv): string[] {
  if (env.OTP_DEV_CODE === undefined || env.OTP_DEV_CODE === '') return [];
  const reasons: string[] = [];
  const cacheHost = httpHostname(env.STREAM_PUBLIC_BASE_URL);
  if (!cacheHost) {
    reasons.push(
      'STREAM_PUBLIC_BASE_URL is missing or not an http(s) URL, so this cannot be shown to be a local machine',
    );
  } else if (!isLocalHost(cacheHost)) {
    reasons.push(
      `STREAM_PUBLIC_BASE_URL (${env.STREAM_PUBLIC_BASE_URL}) is a public address`,
    );
  }
  if (
    (env.STREAM_PUBLIC_BASE_URL_IS_PUBLIC ?? '').trim().toLowerCase() === 'true'
  ) {
    reasons.push(
      'STREAM_PUBLIC_BASE_URL_IS_PUBLIC is "true" (the cache server has a public address of its own)',
    );
  }
  if (isSetAndNotLocal(env.MINIO_PUBLIC_ENDPOINT)) {
    reasons.push(
      `MINIO_PUBLIC_ENDPOINT (${env.MINIO_PUBLIC_ENDPOINT}) is not a local address`,
    );
  }
  const publicOrigins = (parseCorsOrigins(env.CORS_ORIGINS) ?? []).filter(
    isSetAndNotLocal,
  );
  if (publicOrigins.length > 0) {
    reasons.push(
      `CORS_ORIGINS allows non-local website(s): ${publicOrigins.join(', ')}`,
    );
  }
  if ((env.TRUSTED_PROXIES ?? '').trim() !== '') {
    reasons.push(
      'TRUSTED_PROXIES is set (a reverse proxy sits in front of this API)',
    );
  }
  if (reasons.length === 0) return [];
  return [
    `OTP_DEV_CODE must not be set on a public deployment: ${reasons.join('; ')}. ` +
      'With it, every one-time code is the same fixed code and no SMS is sent, so anyone who knows it can reset the password of (and so take over) any phone account. ' +
      'Remove OTP_DEV_CODE (or leave it empty) — it is for a local or LAN development machine only',
  ];
}

/**
 * Words that only ever appear in a secret somebody forgot to replace — the
 * .env.example placeholders, a compose fallback, a "todo". A random
 * `openssl rand -hex 32` value cannot contain any of them.
 */
const PLACEHOLDER_SECRET = /replace|change[-_ ]?me|placeholder|example|todo/i;

/** The length a production signing secret must have (M-33). */
export const MIN_PRODUCTION_JWT_SECRET_LENGTH = 32;

/**
 * M-33: the two JWT secrets. A placeholder is refused everywhere — the
 * .env.example values used to pass the 16-character check, so a copied but
 * unedited file booted a backend whose every token anyone could forge. In
 * production they must also be 32+ characters and differ from each other
 * (one leaked secret must not be both).
 */
function jwtSecretProblems(env: EnvironmentVariables): string[] {
  const problems: string[] = [];
  const secrets: [string, string][] = [
    ['JWT_SECRET', env.JWT_SECRET],
    ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
  ];
  for (const [name, value] of secrets) {
    if (PLACEHOLDER_SECRET.test(value)) {
      problems.push(
        `${name} is a placeholder — set a real random secret (e.g. \`openssl rand -hex 32\`)`,
      );
    } else if (
      env.NODE_ENV === Environment.Production &&
      value.length < MIN_PRODUCTION_JWT_SECRET_LENGTH
    ) {
      problems.push(
        `${name} must be at least ${MIN_PRODUCTION_JWT_SECRET_LENGTH} characters when NODE_ENV=production (e.g. \`openssl rand -hex 32\`)`,
      );
    }
  }
  if (
    env.NODE_ENV === Environment.Production &&
    env.JWT_SECRET === env.JWT_REFRESH_SECRET
  ) {
    problems.push(
      'JWT_SECRET and JWT_REFRESH_SECRET must differ when NODE_ENV=production',
    );
  }
  return problems;
}

/** M-31: every CORS_ORIGINS entry must be a plain http(s) origin. */
function corsProblems(env: EnvironmentVariables): string[] {
  const bad = corsOriginProblems(env.CORS_ORIGINS);
  if (bad.length === 0) return [];
  return [
    `CORS_ORIGINS entries must be http(s) origins such as https://admin.example.com (scheme, host, optional port, nothing after): ${bad.join(', ')}`,
  ];
}

/**
 * M-30: things a production deployment is probably getting wrong but that
 * must not stop it from booting. Logged loudly at startup, returned here
 * so a test can see them.
 *
 * The one case today: a public cache base (so this is a real, internet-
 * facing deployment — the H-5 plan puts nginx/HTTPS in front of it) with
 * an empty TRUSTED_PROXIES. Behind a proxy every request then arrives from
 * the proxy's own address, so all users share one rate-limit bucket per
 * route: 50 OTP requests lock everyone out of sign-in for an hour. If the
 * API really is reached directly, the warning is harmless noise.
 */
export function startupWarnings(env: EnvironmentVariables): string[] {
  if (env.NODE_ENV !== Environment.Production) return [];
  const cacheHost = httpHostname(env.STREAM_PUBLIC_BASE_URL);
  if (!cacheHost || isLocalHost(cacheHost)) return [];
  if ((env.TRUSTED_PROXIES ?? '').trim() === '') {
    return [
      `TRUSTED_PROXIES is empty while STREAM_PUBLIC_BASE_URL (${env.STREAM_PUBLIC_BASE_URL}) is a public address. ` +
        'If a reverse proxy (nginx/HTTPS) sits in front of this API, every visitor currently shares ONE rate-limit bucket per route ' +
        '(50 OTP requests lock everyone out of sign-in for an hour) and every tracking row records the proxy as the client. ' +
        'Set TRUSTED_PROXIES to the proxy\'s IP (see DOCKER.md, "Putting nginx/HTTPS in front"). Ignore this only if the API is reached directly.',
    ];
  }
  return [];
}

const startupLogger = new Logger('EnvValidation');

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

  const always = [
    ...smsProblems(validated),
    ...jwtSecretProblems(validated),
    ...corsProblems(validated),
    ...otpDevCodeProblems(validated),
  ];
  if (always.length > 0) {
    throw new Error(`Invalid environment configuration: ${always.join('; ')}`);
  }

  if (validated.NODE_ENV === Environment.Production) {
    const problems = [
      ...productionStreamProblems(validated),
      ...productionSecretProblems(validated),
    ];
    if (problems.length > 0) {
      throw new Error(
        `Invalid environment configuration for production: ${problems.join('; ')}`,
      );
    }
  }

  for (const warning of startupWarnings(validated)) {
    startupLogger.warn(`WARNING: ${warning}`);
  }

  return validated;
}
