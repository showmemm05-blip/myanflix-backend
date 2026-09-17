import { SetMetadata } from '@nestjs/common';

export const IS_AUTH_OPTIONAL_KEY = 'isAuthOptional';

/**
 * Marks a route as readable WITHOUT a token, while still honouring one when
 * it is sent — the middle ground between @Public() (never authenticates)
 * and the default (always requires a valid token).
 *
 * How JwtAuthGuard treats it:
 *  - no Authorization header  -> the request passes as a guest and
 *    `req.user` stays undefined, so `@CurrentUser()` yields undefined;
 *  - Authorization header set -> the normal passport flow runs, so a valid
 *    token attaches the real user (staff keep their full view on the same
 *    route) and an invalid/expired one is still a 401, which is what the
 *    clients rely on to refresh their session.
 *
 * Meant for the read-only catalogue (movies, series, actors) where guests
 * may browse but the response carries no stream/HLS/object-key data. Never
 * put it on a route that returns a playlist, watch history or purchases —
 * those keep the global guard as-is. Handlers under it MUST derive the
 * visibility role themselves: `const viewerRole = user?.role ?? Role.USER`,
 * because every service scopes to PUBLISHED content only for Role.USER.
 */
export const OptionalAuth = () => SetMetadata(IS_AUTH_OPTIONAL_KEY, true);
