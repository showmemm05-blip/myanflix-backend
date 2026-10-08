import type { ConfigService } from '@nestjs/config';

/**
 * How OTP codes leave the building (SMS_PROVIDER):
 *
 *  - `log` (the default): nothing is sent. Development only — SmsService
 *    prints a loud warning at startup and one masked line per "send"
 *    (never the code; read it from otp_codes while developing).
 *  - `phone-gateway`: the company Android phone sends every SMS from its own
 *    SIM. SmsService queues a row in sms_messages; the phone long-polls
 *    GET /sms-gateway/device/jobs and reports each result back. No external
 *    SMS API, no Firebase, no FCM.
 *
 * A missing provider never fails startup (the local stack runs
 * NODE_ENV=production); `phone-gateway` without a 32+ character
 * SMS_GATEWAY_TOKEN does.
 */
export const SMS_PROVIDERS = ['log', 'phone-gateway'] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];

export const DEFAULT_SMS_PROVIDER: SmsProvider = 'log';

/**
 * SMS a gateway may queue per UTC day before SmsService refuses more — the
 * last-resort brake for the company SIM (503 for everyone once reached).
 */
export const DEFAULT_SMS_DAILY_CAP = 1000;

/**
 * SMS one phone number may be queued per UTC day (SMS_DAILY_CAP_PER_PHONE)
 * — the abuse brake: nobody can use the company SIM to flood one number,
 * and filling the global cap takes many numbers. Only SMS that may have
 * reached the phone count: CANCELLED and EXPIRED rows never left the
 * server. Past it the number gets TOO_MANY_CODE_REQUESTS_MESSAGE (409).
 */
export const DEFAULT_SMS_DAILY_CAP_PER_PHONE = 10;

/**
 * The gateway counts as offline once no device heartbeat (or job poll) has
 * arrived for this long. The phone heartbeats every 30 s, so the floor sits
 * at 30 s to keep one late heartbeat from flapping the gateway offline.
 */
export const DEFAULT_SMS_GATEWAY_OFFLINE_AFTER_SECONDS = 90;
export const MIN_SMS_GATEWAY_OFFLINE_AFTER_SECONDS = 30;

export const MIN_SMS_GATEWAY_TOKEN_LENGTH = 32;

/**
 * The exact 503 message every client translates (web, mobile) when a code
 * cannot be queued: the gateway phone is offline or the daily cap is hit.
 */
export const SMS_UNAVAILABLE_MESSAGE =
  'SMS service is temporarily unavailable. Please try again shortly.';

/**
 * The 409 for a number past SMS_DAILY_CAP_PER_PHONE — word for word
 * OtpService's hourly-cap answer, which the web and mobile apps already
 * translate (en + mm), so no client needs a new string.
 */
export const TOO_MANY_CODE_REQUESTS_MESSAGE =
  'Too many code requests — please try again later';

/**
 * The gateway only texts Myanmar mobile numbers: +959 and 7-9 more digits.
 * RequestOtpDto accepts any +95 number (landlines too), so the queue checks
 * again and answers anything else with a 400 carrying the DTO's own
 * sentence.
 */
export const MYANMAR_MOBILE_PATTERN = /^\+959\d{7,9}$/;
export const INVALID_SMS_PHONE_MESSAGE = 'Enter a valid Myanmar phone number';

/**
 * What replaces an SMS body (and, on account close, its phone number) once
 * nobody needs it any more: the sweeper redacts final rows an hour old.
 */
export const SMS_REDACTED = '[redacted]';

export interface SmsSettings {
  provider: SmsProvider;
  /** Undefined when unset/empty — every device route then answers 401. */
  gatewayToken: string | undefined;
  dailyCap: number;
  dailyCapPerPhone: number;
  offlineAfterSeconds: number;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * The validated SMS settings with every default applied. env.validation.ts
 * already refuses bad values at boot; the fallbacks here only cover a key
 * that was present but empty (validation folds '' into undefined).
 */
export function readSmsSettings(config: ConfigService): SmsSettings {
  const provider = config.get<string>('SMS_PROVIDER');
  const token = config.get<string>('SMS_GATEWAY_TOKEN');
  return {
    provider: (SMS_PROVIDERS as readonly string[]).includes(provider ?? '')
      ? (provider as SmsProvider)
      : DEFAULT_SMS_PROVIDER,
    gatewayToken:
      typeof token === 'string' && token.length > 0 ? token : undefined,
    dailyCap: positiveInt(
      config.get<number>('SMS_DAILY_CAP'),
      DEFAULT_SMS_DAILY_CAP,
    ),
    dailyCapPerPhone: positiveInt(
      config.get<number>('SMS_DAILY_CAP_PER_PHONE'),
      DEFAULT_SMS_DAILY_CAP_PER_PHONE,
    ),
    offlineAfterSeconds: Math.max(
      MIN_SMS_GATEWAY_OFFLINE_AFTER_SECONDS,
      positiveInt(
        config.get<number>('SMS_GATEWAY_OFFLINE_AFTER_SECONDS'),
        DEFAULT_SMS_GATEWAY_OFFLINE_AFTER_SECONDS,
      ),
    ),
  };
}
