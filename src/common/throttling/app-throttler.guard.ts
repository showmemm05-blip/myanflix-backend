import { ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Response } from 'express';
import { clientIpOf } from './throttling.config';

/**
 * The global rate limiter (registered as APP_GUARD in AppModule).
 *
 * Differences from the stock ThrottlerGuard:
 *  - keys on the REAL client IP (first X-Forwarded-For hop, else the socket
 *    peer) instead of `req.ip`, so the guard is correct behind the
 *    Docker/nginx proxy regardless of `trust proxy`;
 *  - only ever looks at HTTP requests. The socket.io handshake is an HTTP
 *    upgrade that never enters Nest's router, and gateway message handlers
 *    are a `ws` context with no request/response to key on — both pass
 *    untouched;
 *  - THROTTLE_DISABLED=true switches it off entirely (jest/e2e only);
 *  - a blocked request always carries a plain `Retry-After` header in
 *    seconds. The library only sets `Retry-After-<name>` for named
 *    throttlers, which clients never look for.
 *
 * The 429 itself is a ThrottlerException (an HttpException), so it reaches
 * the client through AllExceptionsFilter's `{ success: false, message }`
 * envelope like every other error.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private readonly disabled: boolean;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Optional() configService?: ConfigService,
  ) {
    super(options, storageService, reflector);
    this.disabled = configService?.get<string>('THROTTLE_DISABLED') === 'true';
  }

  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(this.disabled || context.getType() !== 'http');
  }

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(clientIpOf(req));
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader(
      'Retry-After',
      String(Math.max(1, Math.ceil(detail.timeToBlockExpire))),
    );
    return super.throwThrottlingException(context, detail);
  }
}
