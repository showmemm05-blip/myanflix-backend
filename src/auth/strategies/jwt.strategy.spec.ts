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
  let usersService: { findByIdOrThrow: jest.Mock };
  let trackingService: { touchLastSeen: jest.Mock; fireAndForget: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    usersService = { findByIdOrThrow: jest.fn().mockResolvedValue(makeUser()) };
    trackingService = {
      touchLastSeen: jest.fn().mockResolvedValue(undefined),
      // Matches the real helper: run it, swallow failures into a log.
      fireAndForget: jest.fn((_what: string, run: Promise<void>) => {
        void run.catch(() => undefined);
      }),
    };

    strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('test-secret') } as unknown as ConfigService,
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
    usersService.findByIdOrThrow.mockResolvedValue(
      makeUser({ status: UserStatus.SUSPENDED }),
    );

    await expect(strategy.validate({ sub: 'user-1' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(trackingService.touchLastSeen).not.toHaveBeenCalled();
  });
});
