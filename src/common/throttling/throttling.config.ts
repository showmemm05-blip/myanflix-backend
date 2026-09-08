import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import {
  Throttle,
  hours,
  minutes,
  seconds,
  type ThrottlerGetTrackerFunction,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
} from '@nestjs/throttler';
import { normalizeIp, resolveClientIp } from '../storage/request-host.context';
import { normalizePhone } from '../utils/phone.util';

/**
 * Rate limiting is one in-memory @nestjs/throttler installation with three
 * named throttlers, applied everywhere by AppThrottlerGuard (an APP_GUARD):
 *
 *  - `default` — the site-wide backstop: 300 hits per minute per client IP
 *    on any one route. Applies to every HTTP route unless the route opts
 *    out with @SkipThrottle() (health, peak-users, the streaming/status
 *    polls). Keyed per route rather than per whole-API so that many users
 *    behind one carrier NAT (the norm on Myanmar mobile networks) sharing an
 *    address cannot lock each other out of the catalogue.
 *  - `ip` and `target` — OPT-IN: they do nothing on a route unless the route
 *    carries @ThrottleAuth(), which sets a tighter per-IP bucket and/or a
 *    per-credential bucket (phone or username from the body, IP when absent)
 *    so one attacker cannot spray one account from many addresses, nor many
 *    accounts from one address.
 *
 * Every ttl is in milliseconds (the v5+ convention). A bucket that overflows
 * blocks for its own ttl (blockDuration defaults to ttl).
 */
export const THROTTLER_DEFAULT = 'default';
export const THROTTLER_IP = 'ip';
export const THROTTLER_TARGET = 'target';

/** Metadata key listing which opt-in throttlers a route enabled. */
export const THROTTLE_OPT_IN_KEY = 'throttle:optIn';

/**
 * Trusted reverse proxies, from TRUSTED_PROXIES (comma-separated IPs). Only
 * when the CONNECTING PEER is one of these is X-Forwarded-For believed —
 * otherwise the header is whatever the client typed, and every per-IP limit
 * could be dodged by varying it per request. Empty (the default) means the
 * API is reached directly and the socket peer is the truth.
 */
let trustedCache: { raw: string | undefined; set: Set<string> } | null = null;
function trustedProxies(): Set<string> {
  const raw = process.env.TRUSTED_PROXIES;
  if (trustedCache && trustedCache.raw === raw) return trustedCache.set;
  const set = new Set(
    (raw ?? '')
      .split(',')
      .map((v) => normalizeIp(v.trim()))
      .filter((v): v is string => v !== null),
  );
  trustedCache = { raw, set };
  return set;
}

/**
 * The client's IP for rate-limit keys. The socket peer, unless that peer is
 * a trusted proxy — then the first X-Forwarded-For hop it relayed (the same
 * resolution the tracking rows use). Never a client-controlled header on
 * its own.
 */
export function clientIpOf(req: Record<string, unknown>): string {
  const headers = req.headers as
    Record<string, string | string[] | undefined> | undefined;
  const socket = req.socket as { remoteAddress?: string } | undefined;
  const peer = normalizeIp(socket?.remoteAddress);
  if (peer && trustedProxies().has(peer)) {
    return resolveClientIp(headers?.['x-forwarded-for'], peer) ?? peer;
  }
  return peer ?? 'unknown';
}

/**
 * The credential a request is aimed at: the normalized phone (`phone`), else
 * the username (`username`, case-folded), else the client IP.
 *
 * Guards run BEFORE pipes, so `req.body` here is the raw parsed JSON — the
 * DTO's @Transform(normalizePhone) has not happened yet. Normalizing here
 * keeps "09..." and "+959..." in one bucket exactly as the DTO will. A body
 * that is missing the field or is not an object falls back to the IP so a
 * malformed request still counts against someone.
 */
export const credentialTargetTracker: ThrottlerGetTrackerFunction = (req) => {
  const body = req.body as unknown;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { phone, username } = body as {
      phone?: unknown;
      username?: unknown;
    };
    if (typeof phone === 'string' && phone.trim()) {
      return `phone:${normalizePhone(phone)}`;
    }
    if (typeof username === 'string' && username.trim()) {
      return `user:${username.trim().toLowerCase()}`;
    }
  }
  return `ip:${clientIpOf(req)}`;
};

/** True when the route did NOT opt into the named throttler. */
function notOptedIn(name: string) {
  return (context: ExecutionContext): boolean => {
    const enabled = (Reflect.getMetadata(
      THROTTLE_OPT_IN_KEY,
      context.getHandler(),
    ) ??
      Reflect.getMetadata(THROTTLE_OPT_IN_KEY, context.getClass()) ??
      []) as string[];
    return !enabled.includes(name);
  };
}

export function throttleErrorMessage(detail: ThrottlerLimitDetail): string {
  const wait = Math.max(1, Math.ceil(detail.timeToBlockExpire));
  return `Too many requests. Try again in ${wait} seconds.`;
}

/**
 * Module options — shared by AppModule and the specs so tests exercise the
 * production keying/limits rather than a look-alike.
 *
 * The `ip`/`target` limit+ttl below are placeholders: they are only ever
 * reached through @ThrottleAuth(), which overrides both per route.
 */
export function buildThrottlerOptions(): ThrottlerModuleOptions {
  return {
    getTracker: clientIpOf,
    errorMessage: (_context, detail) => throttleErrorMessage(detail),
    throttlers: [
      { name: THROTTLER_DEFAULT, ttl: seconds(60), limit: 300 },
      {
        name: THROTTLER_IP,
        ttl: minutes(1),
        limit: 60,
        skipIf: notOptedIn(THROTTLER_IP),
      },
      {
        name: THROTTLER_TARGET,
        ttl: minutes(1),
        limit: 10,
        getTracker: credentialTargetTracker,
        skipIf: notOptedIn(THROTTLER_TARGET),
      },
    ],
  };
}

interface Bucket {
  ttl: number;
  limit: number;
}

/**
 * The per-route auth limits, by intent:
 *  - otpRequest: each SMS costs money — 3 codes per phone per 10 min, and
 *    20 per IP per hour so one address cannot burn codes across many phones.
 *  - credential: anything that answers "is this password/code right?" —
 *    10 tries per phone/username per minute, 60 per IP per minute.
 *  - session: token/identity exchanges with no guessable secret in the body
 *    (google, refresh, register, logout) — 30 per IP per minute.
 */
export const AUTH_THROTTLE_LIMITS = {
  otpRequest: {
    [THROTTLER_TARGET]: { ttl: minutes(10), limit: 3 },
    [THROTTLER_IP]: { ttl: hours(1), limit: 20 },
  },
  credential: {
    [THROTTLER_TARGET]: { ttl: minutes(1), limit: 10 },
    [THROTTLER_IP]: { ttl: minutes(1), limit: 60 },
  },
  session: {
    [THROTTLER_IP]: { ttl: minutes(1), limit: 30 },
  },
} satisfies Record<string, Partial<Record<string, Bucket>>>;

export type AuthThrottleKind = keyof typeof AUTH_THROTTLE_LIMITS;

/**
 * Enables the opt-in throttlers on one auth route with the limits for
 * `kind`. The site-wide `default` bucket still applies on top.
 */
export function ThrottleAuth(kind: AuthThrottleKind) {
  const buckets = AUTH_THROTTLE_LIMITS[kind];
  return applyDecorators(
    Throttle(buckets),
    SetMetadata(THROTTLE_OPT_IN_KEY, Object.keys(buckets)),
  );
}
