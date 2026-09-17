import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_AUTH_OPTIONAL_KEY } from '../../common/decorators/optional-auth.decorator';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

/**
 * Applied globally in AppModule. Every route requires a valid access token
 * unless it (or its controller) is annotated with @Public(), or with
 * @OptionalAuth() and the request carries no Authorization header — in
 * which case it passes as a guest with `req.user` left undefined. A header
 * on an @OptionalAuth() route goes through the normal passport flow, so a
 * bad token is still a 401 there.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(), context.getClass()];

    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      targets,
    );
    if (isPublic) return true;

    const isAuthOptional = this.reflector.getAllAndOverride<boolean>(
      IS_AUTH_OPTIONAL_KEY,
      targets,
    );
    if (isAuthOptional && !this.hasAuthorizationHeader(context)) return true;

    return super.canActivate(context);
  }

  private hasAuthorizationHeader(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers?: Record<string, unknown> }>();
    const header = request.headers?.authorization;
    return typeof header === 'string' && header.trim() !== '';
  }
}
