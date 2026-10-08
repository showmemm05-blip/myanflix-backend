import {
  normalizeIp,
  resolveClientIp,
} from '../common/storage/request-host.context';

/**
 * The ONE rule for "which address did this request really come from".
 *
 * `X-Forwarded-For` is a header any client can type. It is believed only when
 * the CONNECTING PEER (the socket's own remote address) is one of the proxies
 * listed in TRUSTED_PROXIES (comma-separated IPs) — the nginx/HTTPS box in
 * front of the API, nothing else. Otherwise the socket peer is the truth and
 * the header is ignored, however it reads.
 *
 * Empty TRUSTED_PROXIES (the default) means the API is reached directly, so
 * the header is never believed. Every consumer — the rate limiter's per-IP
 * keys (throttling.config.ts), the per-request tracking context (main.ts)
 * and the socket gateway's live "active users" list — goes through here so
 * none of them can disagree about who a client is (M-5, M-30).
 */
let trustedCache: { raw: string | undefined; set: Set<string> } | null = null;

/** The trusted proxy addresses, normalised; recomputed only when the env changes. */
export function trustedProxies(): Set<string> {
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

/** TRUSTED_PROXIES as the array Express's `trust proxy` setting takes (empty = trust nobody). */
export function trustedProxyList(): string[] {
  return [...trustedProxies()];
}

/**
 * The client's IP as a trusted fact: the first `X-Forwarded-For` hop when —
 * and only when — the peer is a trusted proxy, else the peer itself. Null
 * only when there is no peer address at all (a unit test, a closed socket).
 */
export function trustedClientIp(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | null | undefined,
): string | null {
  const peer = normalizeIp(remoteAddress);
  if (peer && trustedProxies().has(peer)) {
    return resolveClientIp(forwardedFor, peer) ?? peer;
  }
  return peer;
}
