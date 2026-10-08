import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserStatus } from '../../generated/prisma/client';
import { UsersService } from '../../users/users.service';
import { TrackingService } from '../../tracking/tracking.service';
import type { AuthenticatedUser } from '../types/authenticated-user.type';
import type { JwtPayload } from '../types/jwt-payload.type';
import { isAccessTokenRevoked } from '../session-revocation.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly trackingService: TrackingService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET')!,
    });
  }

  /**
   * Re-fetches the user on every request (instead of trusting the JWT
   * payload) so a role change or suspension takes effect immediately rather
   * than waiting for the access token to expire.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // A well-formed token for an account that no longer exists is just an
    // invalid token — 401 like every other failure here, so clients take
    // their normal refresh/sign-out path instead of seeing a stray 404.
    // Narrow read (no password or withdrawal-code hash), still fresh on every
    // request — never cached, see the doc comment above.
    const user = await this.usersService.findAuthSubject(payload.sub);

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('This account is no longer active');
    }

    // H-21: every session of this account was revoked after this token was
    // issued (password change/reset, suspension, role change...) — refused
    // at once instead of living out its 15 minutes. Same 401 as an expired
    // token, so clients take their normal refresh path: the kept session of
    // a self-service change refreshes fine, every revoked one signs out.
    if (isAccessTokenRevoked(payload, user.sessionsRevokedAt)) {
      throw new UnauthorizedException('This session has been signed out');
    }

    // Presence, refreshed off the traffic the clients already send — no
    // extra round trip, no heartbeat endpoint. Deliberately NOT awaited and
    // internally throttled to one write per user per minute, so it adds
    // neither latency nor a failure mode to an authenticated request: the
    // response is already on its way while this settles.
    this.trackingService.fireAndForget(
      'last-seen',
      this.trackingService.touchLastSeen(user.id),
    );

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      appRoleId: user.appRoleId,
      ...(payload.sid && { sessionId: payload.sid }),
    };
  }
}
