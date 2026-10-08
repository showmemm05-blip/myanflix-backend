import type { JwtService } from '@nestjs/jwt';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Request body limits (M-18).
 *
 * Express's default is 100 kb. Two things here need more:
 *  - the transcoder-bundle routes under /api/uploads/:movieId — finalize
 *    and finalize-replace — whose JSON body lists every
 *    file of a pre-transcoded bundle (every HLS segment of every rendition;
 *    a multi-hour title at several renditions is thousands of paths). They
 *    get BUNDLE_BODY_LIMIT, and only they, and only for a caller whose
 *    bearer token verifies (see below);
 *  - everything else — a book chapter document is the largest ordinary
 *    body — gets DEFAULT_BODY_LIMIT.
 *
 * The limit used to be 20 MB on every route, which let a guest make the
 * server read and parse 20 MB of JSON per request on /api/auth/login or any
 * unknown path (parsing happens before any guard runs). Now a 20 MB body on
 * an ordinary route is refused at 1 MB with a 413 (AllExceptionsFilter), and
 * a declared Content-Length over the limit is refused before a byte is read.
 *
 * Body parsing runs before JwtAuthGuard / PermissionsGuard, so confining the
 * big limit to two paths alone would still let a guest POST 20 MB to
 * /api/uploads/anything/finalize and have it parsed before the 401. The
 * bundle parser therefore only runs when the request carries an
 * `Authorization: Bearer` token whose SIGNATURE verifies against JWT_SECRET
 * (`signedAccessTokenCheck`, an HMAC check — microseconds, no database).
 * Without one the request falls to the 1 MB parser like any other route: the
 * guard would have refused it anyway, and now the body is never read past
 * 1 MB. The guards still decide WHO may finalize; this only decides how much
 * the server is willing to read before they get the chance.
 *
 * Expiry is deliberately NOT checked here. A token that was genuinely signed
 * by this server but has run past its 15 minutes still proves the caller is
 * staff, not a guest, so it keeps the 20 MB limit; JwtAuthGuard then answers
 * the 401 it always did and the admin client refreshes and retries. Checking
 * expiry here instead would turn that 401 into a 413 "Request body too
 * large" for a big listing posted just after the token ran out, and the
 * client never retries a 413 — the job would fail with a misleading message.
 *
 * Order matters: the bundle parser is mounted first so it owns those paths;
 * body-parser marks a request it parsed (`req._body`) and the general parser
 * then skips it, so no request is ever parsed twice.
 */
export const DEFAULT_BODY_LIMIT = '1mb';
export const BUNDLE_BODY_LIMIT = '20mb';

/** The two bundle routes, with the `api` global prefix. */
export const BUNDLE_BODY_PATH =
  /^\/api\/uploads\/[^/]+\/(finalize|finalize-replace)\/?$/;

/** Decides, before any byte of the body is read, whether a request may use BUNDLE_BODY_LIMIT. */
export type BundleCallerCheck = (req: Request) => boolean;

/** The bearer token of `Authorization: Bearer <token>`, or null when the header is not exactly that. */
export function bearerTokenOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

/**
 * A check that passes only when `verify` accepts the bearer token — it is
 * expected to THROW for a token it rejects (JwtService.verify does). No token,
 * no 20 MB. Whether expiry counts is `verify`'s choice; main.ts wires
 * `signedAccessTokenCheck` below, which ignores it on purpose.
 */
export function bearerVerifiedBy(
  verify: (token: string) => unknown,
): BundleCallerCheck {
  return (req) => {
    const token = bearerTokenOf(req);
    if (token === null) return false;
    try {
      verify(token);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * The check main.ts wires: the token's signature must verify against
 * JWT_SECRET (a forged, garbage or other-secret token fails) but an EXPIRED
 * token still passes — see the note on expiry at the top of this file.
 */
export function signedAccessTokenCheck(
  accessTokens: Pick<JwtService, 'verify'>,
): BundleCallerCheck {
  return bearerVerifiedBy((token) =>
    accessTokens.verify(token, { ignoreExpiration: true }),
  );
}

/** Installs the parsers in the right order; the one call main.ts makes. */
export function registerBodyParsers(
  app: { use: (...args: unknown[]) => unknown },
  isBundleCaller: BundleCallerCheck,
): void {
  const bundleJson = json({ limit: BUNDLE_BODY_LIMIT });
  app.use(
    BUNDLE_BODY_PATH,
    (req: Request, res: Response, next: NextFunction) =>
      isBundleCaller(req) ? bundleJson(req, res, next) : next(),
  );
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT }));
}
