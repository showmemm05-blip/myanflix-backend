import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';

/**
 * Pulls the authenticated user (attached by JwtStrategy) off the request.
 * Only valid on routes guarded by JwtAuthGuard. On an @OptionalAuth() route
 * a guest request has no user at all, so declare the parameter as
 * `user?: AuthenticatedUser` there and never dereference it directly.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
