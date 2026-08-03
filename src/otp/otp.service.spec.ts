import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { OtpService } from './otp.service';

function makeOtp(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'otp-1',
    phone: '+959123456789',
    code: '123456',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    consumedAt: null,
    attemptCount: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('OtpService', () => {
  let service: OtpService;
  let prisma: {
    otpCode: { findFirst: jest.Mock; create: jest.Mock; count: jest.Mock; update: jest.Mock };
  };
  let smsService: { send: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      otpCode: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue(makeOtp()),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn(),
      },
    };
    smsService = { send: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: prisma },
        { provide: SmsService, useValue: smsService },
      ],
    }).compile();

    service = module.get(OtpService);
  });

  describe('requestOtp', () => {
    it('generates a code, stores it, and hands it to SmsService', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);

      await service.requestOtp('+959123456789');

      expect(prisma.otpCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ phone: '+959123456789', code: expect.stringMatching(/^\d{6}$/) }),
      });
      expect(smsService.send).toHaveBeenCalledWith('+959123456789', expect.stringContaining('code is'));
    });

    it('rejects a resend within the cooldown window', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ createdAt: new Date() }));

      await expect(service.requestOtp('+959123456789')).rejects.toThrow(ConflictException);
      expect(prisma.otpCode.create).not.toHaveBeenCalled();
    });

    it('allows a resend once the cooldown has passed', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ createdAt: new Date(Date.now() - 61 * 1000) }));

      await service.requestOtp('+959123456789');

      expect(prisma.otpCode.create).toHaveBeenCalled();
    });

    it('rejects once the hourly request cap is hit', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ createdAt: new Date(Date.now() - 61 * 1000) }));
      prisma.otpCode.count.mockResolvedValue(5);

      await expect(service.requestOtp('+959123456789')).rejects.toThrow(ConflictException);
      expect(prisma.otpCode.create).not.toHaveBeenCalled();
    });
  });

  describe('verifyOtp', () => {
    it('throws when no code exists for the phone', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);
      await expect(service.verifyOtp('+959123456789', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('throws and does not consume on an expired code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ expiresAt: new Date(Date.now() - 1000) }));

      await expect(service.verifyOtp('+959123456789', '123456')).rejects.toThrow(UnauthorizedException);
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
    });

    it('increments attemptCount on a wrong code without consuming it', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp());

      await expect(service.verifyOtp('+959123456789', '000000')).rejects.toThrow(UnauthorizedException);

      expect(prisma.otpCode.update).toHaveBeenCalledWith({
        where: { id: 'otp-1' },
        data: { attemptCount: { increment: 1 } },
      });
    });

    it('locks out further attempts once the attempt cap is reached, even with the right code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ attemptCount: 5 }));

      await expect(service.verifyOtp('+959123456789', '123456')).rejects.toThrow(UnauthorizedException);
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
    });

    it('marks the code consumed on a correct match', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp());

      await service.verifyOtp('+959123456789', '123456');

      expect(prisma.otpCode.update).toHaveBeenCalledWith({
        where: { id: 'otp-1' },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('ignores an already-consumed code (findFirst filters consumedAt: null, so a stale row falling through means no valid code)', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);
      await expect(service.verifyOtp('+959123456789', '123456')).rejects.toThrow(UnauthorizedException);
    });
  });
});
