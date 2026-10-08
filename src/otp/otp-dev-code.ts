import type { ConfigService } from '@nestjs/config';
import {
  OTP_DEV_CODE_ENV,
  OTP_DEV_CODE_FORMAT_MESSAGE,
  OTP_DEV_CODE_PATTERN,
  otpDevCodeProblems,
} from '../config/env.validation';

export { OTP_DEV_CODE_ENV } from '../config/env.validation';

/**
 * The one line OtpService logs at startup while OTP_DEV_CODE is on. Never
 * carries the code itself.
 */
export const OTP_DEV_CODE_WARNING =
  'OTP_DEV_CODE is ON — every OTP is the fixed dev code and no SMS is sent. Never use this in production.';

/**
 * The fixed local-development OTP code (OTP_DEV_CODE), or undefined when it
 * is unset or empty — normal operation, nothing changes.
 *
 * While it is set, OtpService stores THIS code (as the usual keyed hash)
 * for every request, of every purpose, and sends no SMS; everything else —
 * cooldown, hourly cap, expiry, single use, attempt counting — is the
 * normal code path. env.validation.ts already refuses to boot with a
 * malformed value or on a public deployment; this repeats both checks and
 * throws, so the service can never run with a fixed code on a config that
 * somehow skipped that validation.
 */
export function resolveOtpDevCode(
  config: Pick<ConfigService, 'get'>,
): string | undefined {
  const raw = config.get<unknown>(OTP_DEV_CODE_ENV);
  if (raw === undefined || raw === null || raw === '') return undefined;
  // Anything but text or a number is malformed ('' fails the pattern).
  const code =
    typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  const problems = OTP_DEV_CODE_PATTERN.test(code)
    ? otpDevCodeProblems({
        OTP_DEV_CODE: code,
        STREAM_PUBLIC_BASE_URL: config.get<string>('STREAM_PUBLIC_BASE_URL'),
        STREAM_PUBLIC_BASE_URL_IS_PUBLIC: config.get<string>(
          'STREAM_PUBLIC_BASE_URL_IS_PUBLIC',
        ),
        MINIO_PUBLIC_ENDPOINT: config.get<string>('MINIO_PUBLIC_ENDPOINT'),
        CORS_ORIGINS: config.get<string>('CORS_ORIGINS'),
        TRUSTED_PROXIES: config.get<string>('TRUSTED_PROXIES'),
      })
    : [OTP_DEV_CODE_FORMAT_MESSAGE];
  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration: ${problems.join('; ')}`,
    );
  }
  return code;
}
