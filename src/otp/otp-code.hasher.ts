import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';

/** The env var that keys the OTP hash. Optional; see resolveOtpCodePepper. */
export const OTP_CODE_PEPPER_ENV = 'OTP_CODE_PEPPER';

export interface OtpCodePepper {
  /** The HMAC key. Never logged, never stored. */
  secret: string;
  /** True when OTP_CODE_PEPPER is unset and the key came from JWT_SECRET. */
  derivedFromJwtSecret: boolean;
}

function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * M-1: the server secret that keys every stored OTP hash. OTP_CODE_PEPPER
 * when set (a public production deployment must set it — env.validation.ts
 * refuses to boot without it there); otherwise a key DERIVED from
 * JWT_SECRET (an HMAC of a fixed label, never JWT_SECRET itself), so a
 * development or LAN setup keeps working with nothing new in its .env.
 * Either way a database read alone no longer gives a code away; with the
 * fallback, a leak of JWT_SECRET would (which already means the server is
 * lost), hence the production requirement.
 */
export function resolveOtpCodePepper(
  config: Pick<ConfigService, 'get'>,
): OtpCodePepper {
  const own = config.get<string>(OTP_CODE_PEPPER_ENV) || undefined;
  if (own) return { secret: own, derivedFromJwtSecret: false };
  const jwtSecret = config.get<string>('JWT_SECRET') ?? '';
  return {
    secret: hmacHex(jwtSecret, 'myanflix:otp-code:pepper-from-jwt-secret'),
    derivedFromJwtSecret: true,
  };
}

/**
 * Hashes and checks 6-digit one-time codes (OtpService). A 6-digit code has
 * only 1,000,000 values, so an unkeyed hash would be reversed in seconds
 * from a leaked database; HMAC-SHA256 under a server secret that never
 * lives in the database is what keeps the stored value useless on its own.
 * The phone is mixed in too, so two phones that happen to get the same
 * digits store different values. Fast on purpose: a code is checked at most
 * 5 times and lives 5 minutes, so there is nothing to slow down.
 *
 * Stored form: 64 lowercase hex characters (the raw HMAC).
 */
export class OtpCodeHasher {
  constructor(private readonly secret: string) {}

  static fromConfig(config: Pick<ConfigService, 'get'>): OtpCodeHasher {
    return new OtpCodeHasher(resolveOtpCodePepper(config).secret);
  }

  hash(phone: string, code: string): string {
    return hmacHex(this.secret, `myanflix:otp-code:v1:${phone}:${code}`);
  }

  /** Constant-time; a stored value of the wrong shape is simply "no match". */
  matches(phone: string, code: string, storedHash: string): boolean {
    const expected = Buffer.from(this.hash(phone, code), 'utf8');
    const stored = Buffer.from(storedHash, 'utf8');
    if (expected.length !== stored.length) return false;
    return timingSafeEqual(expected, stored);
  }
}
