import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Role, UserStatus } from '../../generated/prisma/client';
import type { UsersService } from '../../users/users.service';
import type { TrackingService } from '../../tracking/tracking.service';
import { JwtStrategy } from './jwt.strategy';

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    username: 'blake',
    role: Role.USER,
    appRoleId: null,
    status: UserStatus.ACTIVE,
    ...overrides,
  };
}

describe('JwtStrategy — presence touch', () => {
  let strategy: JwtStrategy;
  let usersService: { findAuthSubject: jest.Mock };
  let trackingService: { touchLastSeen: jest.Mock; fireAndForget: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    usersService = { findAuthSubject: jest.fn().mockResolvedValue(makeUser()) };
    trackingService = {
      touchLastSeen: jest.fn().mockResolvedValue(undefined),
      // Matches the real helper: run it, swallow failures into a log.
      fireAndForget: jest.fn((_what: string, run: Promise<void>) => {
        void run.catch(() => undefined);
      }),
    };

    strategy = new JwtStrategy(
      {
        get: jest.fn().mockReturnValue('test-secret'),
      } as unknown as ConfigService,
      usersService as unknown as UsersService,
      trackingService as unknown as TrackingService,
    );
  });

  it('returns the authenticated user exactly as before', async () => {
    await expect(strategy.validate({ sub: 'user-1' })).resolves.toEqual({
      id: 'user-1',
      username: 'blake',
      role: Role.USER,
      appRoleId: null,
    });
  });

  it('refreshes presence for the caller on every authenticated request', async () => {
    await strategy.validate({ sub: 'user-1' });

    expect(trackingService.touchLastSeen).toHaveBeenCalledWith('user-1');
  });

  it('does not await the touch — presence must add no latency to a request', async () => {
    let settled = false;
    trackingService.touchLastSeen.mockReturnValue(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          settled = true;
          resolve();
        }, 0),
      ),
    );

    await strategy.validate({ sub: 'user-1' });

    expect(settled).toBe(false);
  });

  it('authenticates normally when the presence write fails', async () => {
    trackingService.touchLastSeen.mockRejectedValue(new Error('db down'));

    await expect(strategy.validate({ sub: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ id: 'user-1' }),
    );
    // Let the rejected promise's .catch handler run.
    await new Promise(process.nextTick);
  });

  it('rejects a suspended account without recording it as present', async () => {
    usersService.findAuthSubject.mockResolvedValue(
      makeUser({ status: UserStatus.SUSPENDED }),
    );

    await expect(strategy.validate({ sub: 'user-1' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(trackingService.touchLastSeen).not.toHaveBeenCalled();
  });

  it('H-16: rejects a closed (self-deleted) account', async () => {
    usersService.findAuthSubject.mockResolvedValue(
      makeUser({ status: UserStatus.CLOSED }),
    );

    await expect(strategy.validate({ sub: 'user-1' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  describe('H-21: access tokens die with a session revoke', () => {
    const revokedAt = new Date('2026-09-28T10:00:00.400Z');
    const revokedSecond = Math.floor(revokedAt.getTime() / 1000);

    beforeEach(() => {
      usersService.findAuthSubject.mockResolvedValue(
        makeUser({ sessionsRevokedAt: revokedAt }),
      );
    });

    it('refuses a token issued before the revoke, without recording presence', async () => {
      await expect(
        strategy.validate({
          sub: 'user-1',
          iat: revokedSecond - 60,
          ims: revokedAt.getTime() - 60_000,
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(trackingService.touchLastSeen).not.toHaveBeenCalled();
    });

    it('refuses a token minted earlier in the very same second as the revoke', async () => {
      await expect(
        strategy.validate({
          sub: 'user-1',
          iat: revokedSecond,
          ims: revokedAt.getTime() - 100,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('accepts the fresh token a refresh mints after the revoke — even within the same second', async () => {
      await expect(
        strategy.validate({
          sub: 'user-1',
          iat: revokedSecond,
          ims: revokedAt.getTime() + 5,
        }),
      ).resolves.toEqual(expect.objectContaining({ id: 'user-1' }));
    });

    it('accepts any token when the account was never revoked', async () => {
      usersService.findAuthSubject.mockResolvedValue(
        makeUser({ sessionsRevokedAt: null }),
      );
      await expect(
        strategy.validate({ sub: 'user-1', iat: revokedSecond - 60 }),
      ).resolves.toEqual(expect.objectContaining({ id: 'user-1' }));
    });
  });

  it('carries the refresh session id (sid) as sessionId, so a self-service password change can keep it', async () => {
    await expect(
      strategy.validate({ sub: 'user-1', sid: 'rt-1' }),
    ).resolves.toEqual({
      id: 'user-1',
      username: 'blake',
      role: Role.USER,
      appRoleId: null,
      sessionId: 'rt-1',
    });
  });

  it('rejects a token for an account that no longer exists with 401, not 404', async () => {
    usersService.findAuthSubject.mockResolvedValue(null);

    await expect(strategy.validate({ sub: 'gone' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(trackingService.touchLastSeen).not.toHaveBeenCalled();
  });
});
