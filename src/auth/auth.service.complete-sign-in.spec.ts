import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { OtpService } from '../otp/otp.service';
import { TrackingService } from '../tracking/tracking.service';
import { Role, UserStatus } from '../generated/prisma/client';
import type { User } from '../generated/prisma/client';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    username: 'john.doe',
    password: '$2b$10$placeholder',
    phone: null,
    email: 'john.doe@gmail.com',
    googleId: 'google-sub-1',
    displayName: 'John Doe',
    avatar: null,
    role: Role.USER,
    appRoleId: null,
    status: UserStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    lastSeenAt: null,
    lastIpAddress: null,
    lastPlatform: null,
    ...overrides,
  } as User;
}

// Same provider boilerplate as auth.service.spec.ts, copied rather than
// shared so that spec stays byte-identical.
describe('AuthService — completeSignIn (shared sign-in tail)', () => {
  let service: AuthService;
  let prisma: { refreshToken: { create: jest.Mock } };
  let trackingService: { startSession: jest.Mock; fireAndForget: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = { refreshToken: { create: jest.fn().mockResolvedValue({}) } };
    trackingService = {
      startSession: jest.fn().mockResolvedValue(undefined),
      fireAndForget: jest.fn((_what: string, run: Promise<void>) => {
        void run.catch(() => undefined);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: { signAsync: jest.fn().mockResolvedValue('token') },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'JWT_REFRESH_EXPIRES_IN' ? '7d' : 'secret',
            ),
          },
        },
        { provide: OtpService, useValue: {} },
        { provide: TrackingService, useValue: trackingService },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('issues the token pair, stores the refresh row and opens a session for an ACTIVE user', async () => {
    const result = await service.completeSignIn(makeUser());

    expect(result).toEqual({
      user: {
        id: 'user-1',
        username: 'john.doe',
        role: Role.USER,
        appRoleId: null,
      },
      accessToken: 'token',
      refreshToken: 'token',
    });
    expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    expect(trackingService.startSession).toHaveBeenCalledWith('user-1');
  });

  it.each([UserStatus.SUSPENDED, UserStatus.BANNED])(
    'rejects a %s user with no token row and no session',
    async (status) => {
      await expect(
        service.completeSignIn(makeUser({ status })),
      ).rejects.toThrow(
        new UnauthorizedException('This account is no longer active'),
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(trackingService.startSession).not.toHaveBeenCalled();
    },
  );

  it('still signs the user in when session tracking fails', async () => {
    trackingService.startSession.mockRejectedValue(new Error('db down'));

    await expect(service.completeSignIn(makeUser())).resolves.toEqual(
      expect.objectContaining({ accessToken: 'token' }),
    );
    // Let the rejected promise's .catch handler run.
    await new Promise(process.nextTick);
  });
});
