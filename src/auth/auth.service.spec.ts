import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { OtpService } from '../otp/otp.service';
import { Role, UserStatus } from '../generated/prisma/client';

const CORRECT_PASSWORD = 'correct-horse-battery';

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    username: 'user_959123456789',
    password: bcrypt.hashSync(CORRECT_PASSWORD, 10),
    phone: '+959123456789',
    avatar: null,
    role: Role.USER,
    status: UserStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('AuthService — phone OTP', () => {
  let service: AuthService;
  let usersService: { findByPhone: jest.Mock; create: jest.Mock };
  let otpService: { requestOtp: jest.Mock; verifyOtp: jest.Mock };
  let prisma: { refreshToken: { create: jest.Mock } };

  beforeEach(async () => {
    jest.clearAllMocks();

    usersService = { findByPhone: jest.fn(), create: jest.fn() };
    otpService = { requestOtp: jest.fn().mockResolvedValue(undefined), verifyOtp: jest.fn().mockResolvedValue(undefined) };
    prisma = { refreshToken: { create: jest.fn().mockResolvedValue({}) } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { signAsync: jest.fn().mockResolvedValue('token') } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => (key === 'JWT_REFRESH_EXPIRES_IN' ? '7d' : 'secret')) },
        },
        { provide: OtpService, useValue: otpService },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('requestPhoneOtp', () => {
    it('delegates straight to OtpService', async () => {
      await service.requestPhoneOtp('+959123456789');
      expect(otpService.requestOtp).toHaveBeenCalledWith('+959123456789');
    });
  });

  describe('checkPhoneExists', () => {
    it('reports true for a registered phone', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser());
      await expect(service.checkPhoneExists('+959123456789')).resolves.toEqual({ exists: true });
    });

    it('reports false for an unregistered phone', async () => {
      usersService.findByPhone.mockResolvedValue(null);
      await expect(service.checkPhoneExists('+959123456789')).resolves.toEqual({ exists: false });
    });
  });

  describe('verifyPhonePassword', () => {
    it('succeeds for the correct password', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser());
      await expect(service.verifyPhonePassword('+959123456789', CORRECT_PASSWORD)).resolves.toEqual({
        valid: true,
      });
    });

    it('rejects a wrong password', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser());
      await expect(service.verifyPhonePassword('+959123456789', 'wrong-password')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an unregistered phone with the same generic message as a wrong password (no enumeration)', async () => {
      usersService.findByPhone.mockResolvedValue(null);
      await expect(service.verifyPhonePassword('+959123456789', CORRECT_PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a suspended account even with the correct password', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser({ status: UserStatus.SUSPENDED }));
      await expect(service.verifyPhonePassword('+959123456789', CORRECT_PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('verifyPhoneOtp', () => {
    it('logs in the existing account when the phone is already registered (password not required — already checked in step 2)', async () => {
      const existing = makeUser();
      usersService.findByPhone.mockResolvedValue(existing);

      const result = await service.verifyPhoneOtp('+959123456789', '123456');

      expect(otpService.verifyOtp).toHaveBeenCalledWith('+959123456789', '123456');
      expect(usersService.create).not.toHaveBeenCalled();
      expect(result.user.id).toBe('user-1');
    });

    it('creates a new account using the chosen password when the phone is unregistered', async () => {
      usersService.findByPhone.mockResolvedValue(null);
      usersService.create.mockResolvedValue(makeUser({ id: 'user-2' }));

      const result = await service.verifyPhoneOtp('+959123456789', '123456', 'a-new-password');

      expect(usersService.create).toHaveBeenCalledWith({
        phone: '+959123456789',
        username: expect.stringContaining('959123456789'),
        password: expect.any(String),
      });
      // The stored password must actually be the chosen one, hashed — not a random placeholder.
      const storedHash = usersService.create.mock.calls[0][0].password;
      await expect(bcrypt.compare('a-new-password', storedHash)).resolves.toBe(true);
      expect(result.user.id).toBe('user-2');
    });

    it('throws BadRequestException when creating a new account without a password', async () => {
      usersService.findByPhone.mockResolvedValue(null);

      await expect(service.verifyPhoneOtp('+959123456789', '123456')).rejects.toThrow(BadRequestException);
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it('rejects a suspended account even with a correct code', async () => {
      usersService.findByPhone.mockResolvedValue(makeUser({ status: UserStatus.SUSPENDED }));

      await expect(service.verifyPhoneOtp('+959123456789', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('propagates OtpService rejection (wrong/expired code) without touching UsersService', async () => {
      otpService.verifyOtp.mockRejectedValue(new UnauthorizedException('Invalid or expired code'));

      await expect(service.verifyPhoneOtp('+959123456789', '000000')).rejects.toThrow(UnauthorizedException);
      expect(usersService.findByPhone).not.toHaveBeenCalled();
    });
  });
});
