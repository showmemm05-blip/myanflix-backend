import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserStatus } from '../../generated/prisma/client';
import { UsersService } from '../../users/users.service';
import { TrackingService } from '../../tracking/tracking.service';
import type { AuthenticatedUser } from '../types/authenticated-user.type';
import type { JwtPayload } from '../types/jwt-payload.type';

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
    const user = await this.usersService.findByIdOrThrow(payload.sub);

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('This account is no longer active');
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
    };
  }
}
