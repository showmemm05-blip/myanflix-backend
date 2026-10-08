import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'node:crypto';
import { clientIpOf } from '../common/throttling/throttling.config';
import { readSmsSettings } from '../sms/sms.config';
import { SmsDeviceBindingService } from './sms-device-binding.service';

/** The header carrying the gateway phone's stable uuid. */
export const SMS_DEVICE_ID_HEADER = 'x-device-id';

const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Headers = Record<string, string | string[] | undefined>;

/** What DeviceTokenGuard attaches to the request once both headers check out. */
export interface SmsDevicePrincipal {
  /** The device uuid from X-Device-Id, lower-cased. */
  id: string;
}

export interface SmsDeviceRequest {
  headers: Headers;
  smsDevice?: SmsDevicePrincipal;
}

/**
 * Constant-time comparison of a presented token with the configured one.
 * Both sides are SHA-256 digested first, so timingSafeEqual always compares
 * two 32-byte buffers and the token's length leaks nothing either.
 */
export function gatewayTokenMatches(
  presented: string,
  expected: string,
): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerOf(headers: Headers | undefined): string {
  const header = headers?.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : '';
}

/** The X-Device-Id uuid, lower-cased; null when missing or not a uuid. */
export function deviceIdOf(headers: Headers | undefined): string | null {
  const raw = headers?.[SMS_DEVICE_ID_HEADER];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return DEVICE_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/** True when the request carries the gateway token AND a device uuid. */
function isGatewayDevice(
  headers: Headers | undefined,
  expected: string | undefined,
): boolean {
  const presented = bearerOf(headers);
  return (
    !!expected &&
    !!presented &&
    deviceIdOf(headers) !== null &&
    gatewayTokenMatches(presented, expected)
  );
}

/**
 * Auth for the SMS gateway phone. Mounted ONLY on
 * SmsGatewayDeviceController (whose class is @Public(), so the global
 * JwtAuthGuard steps aside instead of parsing the bearer as a JWT): the
 * gateway token opens nothing else, and no JWT opens these routes.
 *
 * Both headers are the device's credentials — `Authorization: Bearer
 * <SMS_GATEWAY_TOKEN>` and `X-Device-Id: <uuid>` — and anything wrong with
 * either (missing, malformed, wrong token, or no SMS_GATEWAY_TOKEN
 * configured at all) is the same 401 "Unauthorized", so a caller learns
 * nothing about which part failed.
 *
 * Then the token is bound to ONE device (H-5 / H-7): the first uuid that
 * presents the right token is pinned, and every other uuid gets the same
 * 401 — after the token check, so a wrong token never pins anything and is
 * never recorded as a rejected device (SmsDeviceBindingService).
 */
@Injectable()
export class DeviceTokenGuard implements CanActivate {
  private readonly expected: string | undefined;

  constructor(
    configService: ConfigService,
    private readonly binding: SmsDeviceBindingService,
  ) {
    this.expected = readSmsSettings(configService).gatewayToken;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SmsDeviceRequest>();
    if (!isGatewayDevice(request.headers, this.expected)) {
      throw new UnauthorizedException();
    }
    const id = deviceIdOf(request.headers)!;
    if (!(await this.binding.admit(id))) {
      throw new UnauthorizedException();
    }
    request.smsDevice = { id };
    return true;
  }
}

/**
 * Rate-limit key for the device routes (runs in the global
 * AppThrottlerGuard, i.e. BEFORE DeviceTokenGuard — before the device pin
 * is checked, so it must not trust X-Device-Id). A request that carries the
 * right token is counted per CLIENT ADDRESS under its own prefix, never per
 * the caller-chosen device id (M-28, 2026-10-06): keyed per id, anyone
 * holding the token could burn the real phone's 120/min bucket by spraying
 * requests under the phone's id — pushing its genuine polls to 429 and the
 * gateway offline — or get a fresh bucket for every made-up id (and so an
 * unbounded stream of refusals to log and record). Keyed per address, a
 * token holder spends only their own budget however many ids they invent;
 * the phone's bucket is shared only with someone sending the right token
 * from the phone's own address. Anything without the right token is
 * counted per client IP exactly like the rest of the API (a different key,
 * so a stranger on the phone's carrier NAT poking these routes never
 * touches the phone's budget).
 *
 * Reads the token from process.env: a tracker is a plain function with no
 * DI access, and ConfigModule copies every validated variable there.
 */
export const smsDeviceTracker: ThrottlerGetTrackerFunction = (req) => {
  const headers = (req as { headers?: Headers }).headers;
  const expected = process.env.SMS_GATEWAY_TOKEN || undefined;
  const ip = clientIpOf(req);
  return isGatewayDevice(headers, expected) ? `sms-gateway:${ip}` : ip;
};
