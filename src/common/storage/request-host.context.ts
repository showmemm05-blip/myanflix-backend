import { AsyncLocalStorage } from 'node:async_hooks';
import { ClientPlatform } from '../../generated/prisma/client';

/**
 * Everything about the CURRENT HTTP request that code deep in a service may
 * need without every caller in between plumbing `@Req()` through — captured
 * once by the middleware in main.ts and read back through the two accessors
 * below.
 *
 * `hostname` is the original and load-bearing member: playback and image
 * URLs are derived from it (see MinioService.playbackUrl) so streams always
 * point at whatever address the client is already talking to — localhost on
 * the host machine, the LAN IP on phones — instead of a hard-coded IP that
 * goes stale every time the machine hosting this stack changes networks.
 * It is `''` when the request carried no Host header, which every consumer
 * already treats exactly like "no context at all" (`!ctx?.hostname`).
 *
 * The rest is tracking context: who/where/what-client, all derived
 * server-side from transport-level facts (socket address, proxy headers,
 * user agent) and never from anything a client can pass as ordinary payload.
 */
export interface RequestContext {
  /** Host header with the port stripped; `''` when there was no Host header. */
  hostname: string;
  /** Client IP, already normalised (see resolveClientIp). Null if unknown. */
  ip?: string | null;
  /** Raw User-Agent header, or null. */
  userAgent?: string | null;
  /** Which client app this request came from (see resolveClientPlatform). */
  platform?: ClientPlatform;
}

/**
 * The per-request store. Every field except `hostname` is optional so that
 * anything running outside an HTTP request (a cron, a socket handler, a
 * unit test) can enter the context with just a hostname and still typecheck.
 */
export const requestHostContext = new AsyncLocalStorage<RequestContext>();

/** The header both clients send so the server never has to guess. */
export const CLIENT_PLATFORM_HEADER = 'x-client-platform';

/** What a service actually reads — every field present, no optionals. */
export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  platform: ClientPlatform;
}

/**
 * The tracking context of the current request, with defaults applied.
 *
 * Deliberately total: outside a request (a cron sweep, a queue worker) it
 * returns `{ ip: null, userAgent: null, platform: UNKNOWN }` rather than
 * throwing, because UNKNOWN is a legitimate value for a row, not an error.
 * Callers therefore never branch on "was there a request".
 */
export function requestClientContext(): ClientContext {
  const store = requestHostContext.getStore();
  return {
    ip: store?.ip ?? null,
    userAgent: store?.userAgent ?? null,
    platform: store?.platform ?? ClientPlatform.UNKNOWN,
  };
}

/**
 * Collapses an IPv4-mapped IPv6 address to its plain IPv4 form and IPv6
 * loopback to its IPv4 spelling, so the same machine is one value in the
 * database instead of two.
 *
 * Node hands back `::ffff:192.168.1.5` for an IPv4 client on a dual-stack
 * socket, and `::1` for a local connection — storing those verbatim would
 * make "is this IP shared between users" answer wrong for anyone whose two
 * sessions happened to land on different socket families.
 */
export function normalizeIp(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (raw === '::1') return '127.0.0.1';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped) return mapped[1];
  return raw;
}

/**
 * The client's IP: the first hop of `x-forwarded-for` when present, else the
 * socket's own peer address.
 *
 * The first entry is the ORIGINAL client — each proxy appends itself, so the
 * last entry is the nearest proxy, which is never what we want. This stack
 * sits behind nginx/the cache server, so without this every row would record
 * the proxy's address for every user.
 *
 * `x-forwarded-for` is client-spoofable in general; it is trusted here for
 * the same reason `app.set('trust proxy', true)` is, namely that the only
 * route into this API is through our own proxy. The value is used for
 * operational display and shared-IP detection, never for authorization.
 */
export function resolveClientIp(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | null | undefined,
): string | null {
  const header = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const firstHop = header?.split(',')[0];
  return normalizeIp(firstHop) ?? normalizeIp(remoteAddress);
}

/**
 * Which client sent this request.
 *
 * 1. The `X-Client-Platform` header, which both first-party clients set on
 *    every request — authoritative, because we control both of them.
 * 2. Failing that, a user-agent sniff, ordered so it cannot get the common
 *    case backwards: NATIVE-app markers win first (an Expo/OkHttp/CFNetwork
 *    request is the mobile app), then anything browser-shaped is WEB — and
 *    a phone browser is genuinely WEB, since it is the website that is
 *    being used, which is why "Android"/"iPhone" alone must never imply
 *    MOBILE here.
 * 3. UNKNOWN, an expected outcome (curl, a health check, an older client
 *    build), never an error.
 */
export function resolveClientPlatform(
  header: string | string[] | undefined,
  userAgent: string | null | undefined,
): ClientPlatform {
  const declared = (Array.isArray(header) ? header[0] : header)
    ?.trim()
    .toUpperCase();
  if (declared === ClientPlatform.WEB) return ClientPlatform.WEB;
  if (declared === ClientPlatform.MOBILE) return ClientPlatform.MOBILE;

  const ua = userAgent ?? '';
  if (!ua) return ClientPlatform.UNKNOWN;
  if (/\b(Expo|ReactNative|okhttp|CFNetwork|Dalvik)\b/i.test(ua))
    return ClientPlatform.MOBILE;
  if (/Mozilla|Chrome|Safari|Firefox|Edg\//i.test(ua))
    return ClientPlatform.WEB;
  return ClientPlatform.UNKNOWN;
}
