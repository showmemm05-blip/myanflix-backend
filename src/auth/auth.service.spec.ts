import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { OtpService } from '../otp/otp.service';
import { TrackingService } from '../tracking/tracking.service';
import { AuditService } from '../audit/audit.service';
import { SessionRevocationService } from './session-revocation.service';
import {
  OtpPurpose,
  Prisma,
  Role,
  UserStatus,
} from '../generated/prisma/client';

const CORRECT_PASSWORD = 'correct-horse-battery';

/** What Prisma throws when users.username (or any unique column) is already taken. */
function makeUniqueViolation(target = 'username') {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`${target}\`)`,
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: [target] },
    },
  );
}

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    username: 'user_959123456789',
    password: bcrypt.hashSync(CORRECT_PASSWORD, 10),
    phone: '+959123456789',
    avatar: null,
    role: Role.USER,
    appRoleId: null,
    status: UserStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Real-looking config: the phone OTP block signs real JWTs (step tokens). */
const TEST_CONFIG: Record<string, string> = {
  JWT_SECRET: 'unit-test-access-secret',
  JWT_REFRESH_SECRET: 'unit-test-refresh-secret',
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
};

describe('AuthService — phone OTP', () => {
  let service: AuthService;
  let jwtService: JwtService;
  let usersService: { findByPhone: jest.Mock; create: jest.Mock };
  let otpService: { requestOtp: jest.Mock; verifyOtp: jest.Mock };
  let prisma: {
    refreshToken: { create: jest.Mock };
    user: { update: jest.Mock };
    $transaction: jest.Mock;
  };
  let trackingService: { startSession: jest.Mock; fireAndForget: jest.Mock };
  let audit: { record: jest.Mock };
  let sessions: { revokeAll: jest.Mock; disconnectUser: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    usersService = { findByPhone: jest.fn(), create: jest.fn() };
    otpService = {
      requestOtp: jest.fn().mockResolvedValue(undefined),
      verifyOtp: jest.fn().mockResolvedValue(undefined),
    };
    prisma = {
      refreshToken: { create: jest.fn().mockResolvedValue({}) },
      user: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
    );
    trackingService = {
      startSession: jest.fn().mockResolvedValue(undefined),
      // Matches the real helper: run it, swallow failures into a log.
      fireAndForget: jest.fn((_what: string, run: Promise<void>) => {
        void run.catch(() => undefined);
      }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    sessions = {
      revokeAll: jest.fn().mockResolvedValue(undefined),
      disconnectUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: new JwtService({}) },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => TEST_CONFIG[key]) },
        },
        { provide: OtpService, useValue: otpService },
        { provide: TrackingService, useValue: trackingService },
        { provide: AuditService, useValue: audit },
        { provide: SessionRevocationService, useValue: sessions },
      ],
    }).compile();

    service = module.get(AuthService);
    jwtService = module.get(JwtService);
  });

  /**
   * The one stored row for the phone. makeUser() re-hashes on every call
   * (a fresh bcrypt salt), and the step token is bound to the stored hash,
   * so each flow must keep reading the SAME row — as the database would.
   */
  let account: ReturnType<typeof makeUser>;
  beforeAll(() => {
    account = makeUser();
  });

  /** Step 2 of the returning-phone flow, as the clients run it. */
  async function passwordStep(user = account): Promise<string> {
    usersService.findByPhone.mockResolvedValueOnce(user);
    const { stepToken } = await service.verifyPhonePassword(
      '+959123456789',
      CORRECT_PASSWORD,
    );
    return stepToken;
  }

  describe('requestPhoneOtp', () => {
    it('a sign-in code by default: delegates straight to OtpService, no account lookup', async () => {
      await service.requestPhoneOtp('+959123456789');
      expect(otpService.requestOtp).toHaveBeenCalledWith(
        '+959123456789',
        OtpPurpose.LOGIN,
      );
      expect(usersService.findByPhone).not.toHaveBeenCalled();
    });

    it("purpose 'login' is the same sign-in code", async () => {
      await service.requestPhoneOtp('+959123456789', 'login');
      expect(otpService.requestOtp).toHaveBeenCalledWith(
        '+959123456789',
        OtpPurpose.LOGIN,
      );
    });

    describe("purpose 'password_reset' (B1)", () => {
      it('requests a PASSWORD_RESET code for a customer account', async () => {
        usersService.findByPhone.mockResolvedValue(makeUser());

        await service.requestPhoneOtp('+959123456789', 'password_reset');

        expect(otpService.requestOtp).toHaveBeenCalledWith(
          '+959123456789',
          OtpPurpose.PASSWORD_RESET,
        );
      });

      it("refuses a phone with no account BEFORE any code is created, with the reset endpoint's own message", async () => {
        usersService.findByPhone.mockResolvedValue(null);

        await expect(
          service.requestPhoneOtp('+959123456789', 'password_reset'),
        ).rejects.toThrow(
          new BadRequestException(
            'No account was found for this phone number.',
          ),
        );
        expect(otpService.requestOtp).not.toHaveBeenCalled();
      });

      it("refuses a staff account's phone the same way — a code never starts a staff reset", async () => {
        for (const role of [
          Role.ADMIN,
          Role.SUPER_ADMIN,
          Role.CONTENT_UPLOADER,
        ]) {
          usersService.findByPhone.mockResolvedValueOnce(makeUser({ role }));

          await expect(
            service.requestPhoneOtp('+959123456789', 'password_reset'),
          ).rejects.toThrow(
            new BadRequestException(
              'No account was found for this phone number.',
            ),
          );
        }
        expect(otpService.requestOtp).not.toHaveBeenCalled();
      });

      it("refuses a suspended, banned or closed account BEFORE any code is created (no cooldown, no hourly cap), with the reset endpoint's own 401", async () => {
        const PHONE = '+959123456789';
        const INACTIVE = 'This account is no longer active';
        const inactive = [
          UserStatus.SUSPENDED,
          UserStatus.BANNED,
          UserStatus.CLOSED,
        ];
        for (const status of inactive) {
          usersService.findByPhone.mockResolvedValueOnce(makeUser({ status }));

          const attempt = service.requestPhoneOtp(PHONE, 'password_reset');
          await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
          await expect(attempt).rejects.toThrow(INACTIVE);
        }
        // OtpService owns the cooldown and the hourly cap: never reached.
        expect(otpService.requestOtp).not.toHaveBeenCalled();
      });
    });
  });

  describe('checkPhoneExists', () => {
    it('reports true for a registered phone', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser());
      await expect(service.checkPhoneExists('+959123456789')).resolves.toEqual({
        exists: true,
      });
    });

    it('reports false for an unregistered phone', async () => {
      usersService.findByPhone.mockResolvedValue(null);
      await expect(service.checkPhoneExists('+959123456789')).resolves.toEqual({
        exists: false,
      });
    });
  });

  describe('verifyPhonePassword', () => {
    it('succeeds for the correct password and hands back a short-lived step token (H-6)', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser());
      await expect(
        service.verifyPhonePassword('+959123456789', CORRECT_PASSWORD),
      ).resolves.toEqual({
        valid: true,
        stepToken: expect.any(String),
      });
    });

    it('the step token is never an access token: it does not verify with JWT_SECRET', async () => {
      const stepToken = await passwordStep();
      await expect(
        jwtService.verifyAsync(stepToken, { secret: TEST_CONFIG.JWT_SECRET }),
      ).rejects.toThrow();
      await expect(
        jwtService.verifyAsync(stepToken, {
          secret: TEST_CONFIG.JWT_REFRESH_SECRET,
        }),
      ).rejects.toThrow();
    });

    it('rejects a wrong password', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser());
      await expect(
        service.verifyPhonePassword('+959123456789', 'wrong-password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unregistered phone with the same generic message as a wrong password (no enumeration)', async () => {
      usersService.findByPhone.mockResolvedValue(null);
      await expect(
        service.verifyPhonePassword('+959123456789', CORRECT_PASSWORD),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a suspended account even with the correct password', async () => {
      usersService.findByPhone.mockResolvedValue(
        makeUser({ status: UserStatus.SUSPENDED }),
      );
      await expect(
        service.verifyPhonePassword('+959123456789', CORRECT_PASSWORD),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('verifyPhoneOtp', () => {
    it('logs in the existing account with the code AND the step token from the password step', async () => {
      const stepToken = await passwordStep();
      usersService.findByPhone.mockResolvedValue(account);

      const result = await service.verifyPhoneOtp(
        '+959123456789',
        '123456',
        undefined,
        stepToken,
      );

      // B1: only a code requested for sign-in opens the account.
      expect(otpService.verifyOtp).toHaveBeenCalledWith(
        '+959123456789',
        '123456',
        OtpPurpose.LOGIN,
      );
      expect(usersService.create).not.toHaveBeenCalled();
      expect(result.user.id).toBe('user-1');
      expect(typeof result.accessToken).toBe('string');
    });

    describe('H-6: the code alone never opens an existing account', () => {
      it('refuses a correct code without the step token — before the code is even checked', async () => {
        usersService.findByPhone.mockResolvedValue(makeUser());

        await expect(
          service.verifyPhoneOtp('+959123456789', '123456'),
        ).rejects.toThrow(
          new UnauthorizedException('Please enter your password again.'),
        );
        expect(otpService.verifyOtp).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });

      it('refuses a password sent instead of the step token (the password is not re-checked here)', async () => {
        usersService.findByPhone.mockResolvedValue(makeUser());

        await expect(
          service.verifyPhoneOtp('+959123456789', '123456', CORRECT_PASSWORD),
        ).rejects.toThrow(UnauthorizedException);
        expect(otpService.verifyOtp).not.toHaveBeenCalled();
      });

      it('refuses a forged or garbled step token', async () => {
        usersService.findByPhone.mockResolvedValue(makeUser());
        const forged = await jwtService.signAsync(
          { sub: 'user-1', pur: 'phone-login' },
          { secret: 'not-the-server-secret', expiresIn: '10m' },
        );

        await expect(
          service.verifyPhoneOtp('+959123456789', '123456', undefined, forged),
        ).rejects.toThrow(UnauthorizedException);
        await expect(
          service.verifyPhoneOtp(
            '+959123456789',
            '123456',
            undefined,
            'garbage',
          ),
        ).rejects.toThrow(UnauthorizedException);
        expect(otpService.verifyOtp).not.toHaveBeenCalled();
      });

      it("refuses a step token issued for another account's phone", async () => {
        const stepToken = await passwordStep({
          ...account,
          id: 'someone-else',
        });
        usersService.findByPhone.mockResolvedValue(account);

        await expect(
          service.verifyPhoneOtp(
            '+959123456789',
            '123456',
            undefined,
            stepToken,
          ),
        ).rejects.toThrow(UnauthorizedException);
      });

      it('refuses a step token once the password it proved has changed (e.g. a reset in between)', async () => {
        const stepToken = await passwordStep();
        usersService.findByPhone.mockResolvedValue(
          makeUser({ password: bcrypt.hashSync('a-brand-new-password', 4) }),
        );

        await expect(
          service.verifyPhoneOtp(
            '+959123456789',
            '123456',
            undefined,
            stepToken,
          ),
        ).rejects.toThrow(UnauthorizedException);
      });

      it('refuses an expired step token (10 minutes)', async () => {
        const stepToken = await passwordStep();
        usersService.findByPhone.mockResolvedValue(account);
        // jsonwebtoken reads its clock from Date.now(); only the clock moves.
        const issuedAt = Date.now();
        const clock = jest
          .spyOn(Date, 'now')
          .mockReturnValue(issuedAt + 11 * 60 * 1000);
        try {
          await expect(
            service.verifyPhoneOtp(
              '+959123456789',
              '123456',
              undefined,
              stepToken,
            ),
          ).rejects.toThrow(
            new UnauthorizedException('Please enter your password again.'),
          );
        } finally {
          clock.mockRestore();
        }
        expect(otpService.verifyOtp).not.toHaveBeenCalled();
      });
    });

    it('creates a new account using the chosen password when the phone is unregistered', async () => {
      usersService.findByPhone.mockResolvedValue(null);
      usersService.create.mockResolvedValue(makeUser({ id: 'user-2' }));

      const result = await service.verifyPhoneOtp(
        '+959123456789',
        '123456',
        'a-new-password',
      );

      // B1: sign-up is a sign-in too — a reset code never creates an account.
      expect(otpService.verifyOtp).toHaveBeenCalledWith(
        '+959123456789',
        '123456',
        OtpPurpose.LOGIN,
      );
      expect(usersService.create).toHaveBeenCalledWith({
        phone: '+959123456789',
        username: expect.stringContaining('959123456789'),
        password: expect.any(String),
      });
      // The stored password must actually be the chosen one, hashed — not a random placeholder.
      const storedHash = usersService.create.mock.calls[0][0].password;
      await expect(bcrypt.compare('a-new-password', storedHash)).resolves.toBe(
        true,
      );
      expect(result.user.id).toBe('user-2');
    });

    it('throws BadRequestException when creating a new account without a password', async () => {
      usersService.findByPhone.mockResolvedValue(null);

      await expect(
        service.verifyPhoneOtp('+959123456789', '123456'),
      ).rejects.toThrow(BadRequestException);
      expect(usersService.create).not.toHaveBeenCalled();
    });

    describe('M-20: a squatted user_<digits> name never blocks the phone sign-up', () => {
      it('falls back to user_<digits>_<random> when the plain name is already taken, and signs in', async () => {
        usersService.findByPhone.mockResolvedValue(null);
        usersService.create
          .mockRejectedValueOnce(makeUniqueViolation())
          .mockResolvedValueOnce(
            makeUser({ id: 'user-2', username: 'user_959123456789_ab12cd' }),
          );

        const result = await service.verifyPhoneOtp(
          '+959123456789',
          '123456',
          'a-new-password',
        );

        expect(usersService.create).toHaveBeenCalledTimes(2);
        expect(usersService.create.mock.calls[0][0].username).toBe(
          'user_959123456789',
        );
        expect(usersService.create.mock.calls[1][0].username).toMatch(
          /^user_959123456789_[0-9a-f]{6}$/,
        );
        // Same phone and same chosen password on every attempt.
        for (const [input] of usersService.create.mock.calls) {
          expect(input.phone).toBe('+959123456789');
          await expect(
            bcrypt.compare('a-new-password', input.password),
          ).resolves.toBe(true);
        }
        expect(result.user.id).toBe('user-2');
        expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      });

      it('answers 409 Conflict (never a 500) when every candidate name is taken', async () => {
        usersService.findByPhone.mockResolvedValue(null);
        usersService.create.mockRejectedValue(makeUniqueViolation());

        await expect(
          service.verifyPhoneOtp('+959123456789', '123456', 'a-new-password'),
        ).rejects.toThrow(ConflictException);
        expect(usersService.create).toHaveBeenCalledTimes(3);
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });

      it('rethrows any other database failure untouched, without retrying', async () => {
        usersService.findByPhone.mockResolvedValue(null);
        usersService.create.mockRejectedValue(new Error('connection lost'));

        await expect(
          service.verifyPhoneOtp('+959123456789', '123456', 'a-new-password'),
        ).rejects.toThrow('connection lost');
        expect(usersService.create).toHaveBeenCalledTimes(1);
      });
    });

    it('rejects a suspended account even with a correct code and step token', async () => {
      // A step token minted while the account was still active.
      const stepToken = await passwordStep();
      usersService.findByPhone.mockResolvedValue({
        ...account,
        status: UserStatus.SUSPENDED,
      });

      await expect(
        service.verifyPhoneOtp('+959123456789', '123456', undefined, stepToken),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('propagates OtpService rejection (wrong/expired code) without creating an account or a session', async () => {
      usersService.findByPhone.mockResolvedValue(null);
      otpService.verifyOtp.mockRejectedValue(
        new UnauthorizedException('Invalid or expired code'),
      );

      await expect(
        service.verifyPhoneOtp('+959123456789', '000000', 'a-new-password'),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersService.create).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('resetPasswordWithOtp (H-8: phone -> code -> new password)', () => {
    it('checks the code, stores the new hash, revokes every session and records user.password_reset', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser());

      await expect(
        service.resetPasswordWithOtp(
          '+959123456789',
          '123456',
          'my-new-password',
        ),
      ).resolves.toEqual({ reset: true });

      // B1: only a code requested for a reset resets the password.
      expect(otpService.verifyOtp).toHaveBeenCalledWith(
        '+959123456789',
        '123456',
        OtpPurpose.PASSWORD_RESET,
      );
      const [{ where, data }] = prisma.user.update.mock.calls[0] as [
        { where: { id: string }; data: { password: string } },
      ];
      expect(where).toEqual({ id: 'user-1' });
      await expect(
        bcrypt.compare('my-new-password', data.password),
      ).resolves.toBe(true);
      expect(sessions.revokeAll).toHaveBeenCalledWith('user-1', {
        client: prisma,
      });
      expect(sessions.disconnectUser).toHaveBeenCalledWith('user-1');
      expect(audit.record).toHaveBeenCalledWith({
        action: 'user.password_reset',
        actor: {
          id: 'user-1',
          username: 'user_959123456789',
          role: Role.USER,
          appRoleId: null,
        },
        target: { type: 'user', id: 'user-1', label: '@user_959123456789' },
        force: true,
      });
    });

    it('opens no session: the new password is used through the normal sign-in', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser());

      const result = await service.resetPasswordWithOtp(
        '+959123456789',
        '123456',
        'my-new-password',
      );

      expect(result).not.toHaveProperty('accessToken');
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(trackingService.startSession).not.toHaveBeenCalled();
    });

    it('a wrong code changes nothing', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser());
      otpService.verifyOtp.mockRejectedValue(
        new UnauthorizedException('Invalid or expired code'),
      );

      await expect(
        service.resetPasswordWithOtp(
          '+959123456789',
          '000000',
          'my-new-password',
        ),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses an unknown phone without spending a code', async () => {
      usersService.findByPhone.mockResolvedValue(null);

      await expect(
        service.resetPasswordWithOtp(
          '+959123456789',
          '123456',
          'my-new-password',
        ),
      ).rejects.toThrow(
        new BadRequestException('No account was found for this phone number.'),
      );
      expect(otpService.verifyOtp).not.toHaveBeenCalled();
    });

    it('never resets a staff account by SMS code alone — staff passwords are reset by staff', async () => {
      usersService.findByPhone.mockResolvedValue(
        makeUser({ role: Role.ADMIN }),
      );

      await expect(
        service.resetPasswordWithOtp(
          '+959123456789',
          '123456',
          'my-new-password',
        ),
      ).rejects.toThrow(
        new BadRequestException('No account was found for this phone number.'),
      );
      expect(otpService.verifyOtp).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses an inactive account without spending a code', async () => {
      usersService.findByPhone.mockResolvedValue(
        makeUser({ status: UserStatus.SUSPENDED }),
      );

      await expect(
        service.resetPasswordWithOtp(
          '+959123456789',
          '123456',
          'my-new-password',
        ),
      ).rejects.toThrow(UnauthorizedException);
      expect(otpService.verifyOtp).not.toHaveBeenCalled();
    });

    it('a step token from before the reset no longer opens the account', async () => {
      const stepToken = await passwordStep();
      usersService.findByPhone.mockResolvedValue(account);
      await service.resetPasswordWithOtp(
        '+959123456789',
        '123456',
        'my-new-password',
      );
      const [{ data }] = prisma.user.update.mock.calls[0] as [
        { data: { password: string } },
      ];
      usersService.findByPhone.mockResolvedValue({
        ...account,
        password: data.password,
      });

      await expect(
        service.verifyPhoneOtp('+959123456789', '654321', undefined, stepToken),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});

describe('AuthService — session tracking on sign-in', () => {
  let service: AuthService;
  let usersService: {
    findByPhone: jest.Mock;
    findByUsername: jest.Mock;
    create: jest.Mock;
    updateLastLogin: jest.Mock;
  };
  let otpService: { verifyOtp: jest.Mock };
  let trackingService: { startSession: jest.Mock; fireAndForget: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    usersService = {
      findByPhone: jest.fn(),
      findByUsername: jest.fn(),
      create: jest.fn(),
      updateLastLogin: jest.fn().mockResolvedValue(undefined),
    };
    otpService = { verifyOtp: jest.fn().mockResolvedValue(undefined) };
    trackingService = {
      startSession: jest.fn().mockResolvedValue(undefined),
      fireAndForget: jest.fn((_what: string, run: Promise<void>) => {
        void run.catch(() => undefined);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        {
          provide: PrismaService,
          useValue: {
            refreshToken: { create: jest.fn().mockResolvedValue({}) },
          },
        },
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
        { provide: OtpService, useValue: otpService },
        { provide: TrackingService, useValue: trackingService },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: SessionRevocationService,
          useValue: { revokeAll: jest.fn(), disconnectUser: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  /** /auth/login is the staff door (the admin app); see H-6 below. */
  const staffUser = () => makeUser({ username: 'blake', role: Role.ADMIN });

  it('opens a session on password login', async () => {
    usersService.findByUsername.mockResolvedValue(staffUser());

    await service.login({ username: 'blake', password: CORRECT_PASSWORD });

    expect(trackingService.startSession).toHaveBeenCalledWith('user-1');
  });

  it('opens a session on OTP verify for a new phone — the sign-in path both clients actually use', async () => {
    usersService.findByPhone.mockResolvedValue(null);
    usersService.create.mockResolvedValue(makeUser());

    await service.verifyPhoneOtp('+959123456789', '123456', 'a-new-password');

    expect(trackingService.startSession).toHaveBeenCalledWith('user-1');
  });

  it('opens no session when the credentials are wrong', async () => {
    usersService.findByUsername.mockResolvedValue(staffUser());

    await expect(
      service.login({ username: 'blake', password: 'wrong-password' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(trackingService.startSession).not.toHaveBeenCalled();
  });

  it('H-6: refuses a customer account on /auth/login even with the right password — the password alone never opens one', async () => {
    usersService.findByUsername.mockResolvedValue(makeUser());

    await expect(
      service.login({
        username: 'user_959123456789',
        password: CORRECT_PASSWORD,
      }),
    ).rejects.toThrow(
      new UnauthorizedException('Invalid username or password'),
    );
    expect(trackingService.startSession).not.toHaveBeenCalled();
    expect(usersService.updateLastLogin).not.toHaveBeenCalled();
  });

  it('H-6: answers a customer account exactly like a wrong password, so /auth/login is no password oracle', async () => {
    usersService.findByUsername.mockResolvedValue(makeUser());
    const right = await service
      .login({ username: 'user_959123456789', password: CORRECT_PASSWORD })
      .catch((error: Error) => error.message);
    const wrong = await service
      .login({ username: 'user_959123456789', password: 'wrong-password' })
      .catch((error: Error) => error.message);

    expect(right).toBe(wrong);
  });

  it('still signs the user in when session tracking fails', async () => {
    usersService.findByUsername.mockResolvedValue(staffUser());
    trackingService.startSession.mockRejectedValue(new Error('db down'));

    await expect(
      service.login({ username: 'blake', password: CORRECT_PASSWORD }),
    ).resolves.toEqual(expect.objectContaining({ accessToken: 'token' }));
    // Let the rejected promise's .catch handler run.
    await new Promise(process.nextTick);
  });
});

describe('AuthService — refresh rotation', () => {
  const REFRESH_TOKEN = 'refresh-token-1';
  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  /** The account row the share-lock reads (B2): only what a token needs. */
  function accountRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'user-1',
      username: 'user_959123456789',
      role: Role.USER,
      appRoleId: null,
      status: UserStatus.ACTIVE,
      ...overrides,
    };
  }

  let service: AuthService;
  let usersService: { findByIdOrThrow: jest.Mock };
  let jwtService: { verifyAsync: jest.Mock; signAsync: jest.Mock };
  /** The interactive transaction's client — every refresh write goes here. */
  let tx: {
    $queryRaw: jest.Mock;
    refreshToken: { updateMany: jest.Mock; create: jest.Mock };
  };
  /** The root client: its model delegates must never be used by refresh(). */
  let prisma: {
    $queryRaw: jest.Mock;
    refreshToken: { updateMany: jest.Mock; create: jest.Mock };
    $transaction: jest.Mock;
  };
  /** How each mocked transaction ended, in call order. */
  let outcomes: ('committed' | 'rolled back')[];

  beforeEach(async () => {
    jest.clearAllMocks();

    usersService = { findByIdOrThrow: jest.fn() };
    jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-1', jti: 'jti-1' }),
      signAsync: jest.fn().mockResolvedValue('token'),
    };
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([accountRow()]),
      refreshToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    outcomes = [];
    prisma = {
      $queryRaw: jest.fn(),
      refreshToken: { updateMany: jest.fn(), create: jest.fn() },
      $transaction: jest.fn(
        async (run: (client: typeof tx) => Promise<unknown>) => {
          try {
            const result = await run(tx);
            outcomes.push('committed');
            return result;
          } catch (error) {
            outcomes.push('rolled back');
            throw error;
          }
        },
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'JWT_REFRESH_EXPIRES_IN' ? '7d' : 'secret',
            ),
          },
        },
        { provide: OtpService, useValue: { verifyOtp: jest.fn() } },
        {
          provide: TrackingService,
          useValue: { startSession: jest.fn(), fireAndForget: jest.fn() },
        },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: SessionRevocationService,
          useValue: { revokeAll: jest.fn(), disconnectUser: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('H-21: refuses to mint a new pair for an account that is no longer active — and the token stays used up', async () => {
    for (const status of [
      UserStatus.SUSPENDED,
      UserStatus.BANNED,
      UserStatus.CLOSED,
    ]) {
      tx.$queryRaw.mockResolvedValueOnce([accountRow({ status })]);

      await expect(service.refresh(REFRESH_TOKEN)).rejects.toThrow(
        new UnauthorizedException('This account is no longer active'),
      );
    }
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
    // The consume commits: a token that slipped past the revoke must not
    // spring back to life if the account is reactivated later.
    expect(tx.refreshToken.updateMany).toHaveBeenCalledTimes(3);
    expect(outcomes).toEqual(['committed', 'committed', 'committed']);
  });

  it('H-21: the access token carries its refresh session id (sid)', async () => {
    await service.refresh(REFRESH_TOKEN);

    const before = Date.now();
    const [accessPayload] = jwtService.signAsync.mock.calls[0] as [
      { sub: string; sid: string; ims: number },
    ];
    const [refreshPayload] = jwtService.signAsync.mock.calls[1] as [
      { sub: string; jti: string },
    ];
    expect(accessPayload).toEqual({
      sub: 'user-1',
      sid: refreshPayload.jti,
      ims: expect.any(Number),
    });
    // The millisecond issue time the revoke cutoff compares against.
    expect(accessPayload.ims).toBeLessThanOrEqual(Date.now());
    expect(accessPayload.ims).toBeGreaterThan(before - 60_000);
    const [{ data }] = tx.refreshToken.create.mock.calls[0] as [
      { data: { id: string } },
    ];
    expect(data.id).toBe(refreshPayload.jti);
  });

  it('consumes the token with one conditional updateMany', async () => {
    await expect(service.refresh(REFRESH_TOKEN)).resolves.toEqual({
      accessToken: 'token',
      refreshToken: 'token',
    });

    expect(tx.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'jti-1',
        userId: 'user-1',
        tokenHash: sha256(REFRESH_TOKEN),
        revoked: false,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { revoked: true },
    });
    expect(tx.refreshToken.create).toHaveBeenCalledTimes(1);
  });

  it('rejects when the row was already consumed', async () => {
    tx.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toThrow(
      new UnauthorizedException('Invalid or expired refresh token'),
    );
    expect(jwtService.signAsync).not.toHaveBeenCalled();
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects a bad signature before touching the database', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('invalid signature'));

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('two racing calls yield exactly one token pair', async () => {
    tx.refreshToken.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const results = await Promise.allSettled([
      service.refresh(REFRESH_TOKEN),
      service.refresh(REFRESH_TOKEN),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(tx.refreshToken.create).toHaveBeenCalledTimes(1);
  });

  describe('B2: a revoke racing the refresh (review minor H-21)', () => {
    it('runs in ONE transaction: share-locks the account row first, then consumes the old token, signs the pair and writes the new row', async () => {
      await service.refresh(REFRESH_TOKEN);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual(['committed']);
      const [lockCall] = tx.$queryRaw.mock.calls as unknown[][];
      expect((lockCall[0] as TemplateStringsArray).join('?')).toMatch(
        /FROM "users" WHERE "id" = \? FOR SHARE/,
      );
      expect(lockCall.slice(1)).toEqual(['user-1']);

      const order = [
        tx.$queryRaw.mock.invocationCallOrder[0],
        tx.refreshToken.updateMany.mock.invocationCallOrder[0],
        jwtService.signAsync.mock.invocationCallOrder[0],
        tx.refreshToken.create.mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // Nothing goes around the transaction.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('mints the pair from the locked row itself (no second read on another connection)', async () => {
      tx.$queryRaw.mockResolvedValueOnce([
        accountRow({
          username: 'blake',
          role: Role.ADMIN,
          appRoleId: 'role-admin',
        }),
      ]);

      await service.refresh(REFRESH_TOKEN);

      // A second read would borrow another pool connection while this
      // transaction holds one, and could see a different row version.
      expect(usersService.findByIdOrThrow).not.toHaveBeenCalled();
      const [accessPayload] = jwtService.signAsync.mock.calls[0] as [
        { sub: string },
      ];
      expect(accessPayload.sub).toBe('user-1');
    });

    it('an account row that is gone: the same 401 as a bad token, nothing consumed', async () => {
      tx.$queryRaw.mockResolvedValueOnce([]);

      await expect(service.refresh(REFRESH_TOKEN)).rejects.toThrow(
        new UnauthorizedException('Invalid or expired refresh token'),
      );
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(tx.refreshToken.create).not.toHaveBeenCalled();
    });
  });
});
