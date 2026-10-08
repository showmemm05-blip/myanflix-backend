import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Browser cross-origin policy for the HTTP API and the socket.io handshake
 * (M-31). Driven by CORS_ORIGINS, a comma-separated list of origins such as
 * `https://admin.example.com,https://www.example.com`.
 *
 *  - Unset or empty: TODAY'S behaviour, unchanged — any origin is allowed
 *    (`Access-Control-Allow-Origin: *`). Nothing breaks on a machine that
 *    has not set it.
 *  - Set: only the listed origins get CORS headers; a browser page on any
 *    other site is refused by the browser. Scheme, host and port must match
 *    exactly (case and a trailing slash are ignored).
 *
 * A request that carries NO Origin header is never a browser cross-origin
 * request — it is the mobile app, the phone-monitor, curl or a server — and
 * is always allowed, whatever the list says.
 *
 * The preflight cache (`maxAge`, seconds) lets the browser reuse one OPTIONS
 * answer for a day instead of repeating it on every request.
 *
 * What this does NOT do, in plain words: CORS is a rule the BROWSER follows.
 * It stops a web page on an unlisted site from reading this API's answers
 * from a visitor's browser. It does nothing against curl, a script or an
 * attacker's own machine — those send whatever Origin they like, or none —
 * so on its own it cannot stop someone who already stole a token from
 * refreshing it elsewhere. That needs the admin-side hardening (CSP,
 * security headers, an httpOnly refresh cookie), which is separate work.
 * And a request from a disallowed origin is still executed server-side;
 * only the CORS headers are withheld, so the browser discards the answer.
 * That is how the `cors` package works everywhere, not a gap here.
 */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 86400;

/** `https://Admin.Example.com/` and `https://admin.example.com` are one origin. */
export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * The configured allowlist, or null when CORS_ORIGINS is unset/empty (allow
 * everyone, exactly as before the variable existed).
 */
export function parseCorsOrigins(raw: string | undefined): string[] | null {
  const origins = (raw ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : null;
}

/**
 * Entries that are not an http(s) origin (`scheme://host[:port]`, nothing
 * after it). Checked at boot (env.validation.ts) so a typo such as a missing
 * scheme or a trailing path fails the start instead of silently blocking
 * every browser.
 */
export function corsOriginProblems(raw: string | undefined): string[] {
  const problems: string[] = [];
  for (const entry of parseCorsOrigins(raw) ?? []) {
    let ok = false;
    try {
      const url = new URL(entry);
      ok =
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' &&
        url.password === '' &&
        url.pathname === '/' &&
        url.search === '' &&
        url.hash === '' &&
        normalizeOrigin(url.origin) === entry;
    } catch {
      ok = false;
    }
    if (!ok) problems.push(entry);
  }
  return problems;
}

/** Whether a request from `origin` (the Origin header, if any) may use the API from a browser. */
export function isOriginAllowed(
  origin: string | undefined,
  allowed: string[] | null,
): boolean {
  if (!origin) return true; // not a browser cross-origin request
  if (allowed === null) return true; // CORS_ORIGINS unset: today's behaviour
  return allowed.includes(normalizeOrigin(origin));
}

/**
 * Options for Nest's `app.enableCors()` and for socket.io's `cors` setting
 * (both use the `cors` package underneath). With no allowlist the result is
 * exactly the pre-M-31 `{ maxAge: 86400 }` — origin `*`.
 */
export function buildCorsOptions(raw: string | undefined): CorsOptions {
  const allowed = parseCorsOrigins(raw);
  if (allowed === null) return { maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS };
  return {
    origin: (origin, callback) =>
      callback(null, isOriginAllowed(origin, allowed)),
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  };
}
