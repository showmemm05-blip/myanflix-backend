import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { OtpPurpose } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { OtpService } from './otp.service';

function makeOtp(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'otp-1',
    phone: '+959123456789',
    code: '123456',
    purpose: OtpPurpose.LOGIN,
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
    otpCode: {
      findFirst: jest.Mock;
      create: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
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
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

    it('stores a sign-in (LOGIN) code when no purpose is given', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);

      await service.requestOtp('+959123456789');

      expect(prisma.otpCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ purpose: OtpPurpose.LOGIN }),
      });
    });

    it('stores the purpose it was asked for with the code (B1)', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);

      await service.requestOtp('+959123456789', OtpPurpose.PASSWORD_RESET);

      expect(prisma.otpCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          phone: '+959123456789',
          purpose: OtpPurpose.PASSWORD_RESET,
        }),
      });
    });

    it('the resend cooldown counts only codes of the purpose asked for; the hourly cap counts every code for the phone', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);

      await service.requestOtp('+959123456789', OtpPurpose.PASSWORD_RESET);

      expect(prisma.otpCode.findFirst).toHaveBeenCalledWith({
        where: { phone: '+959123456789', purpose: OtpPurpose.PASSWORD_RESET },
        orderBy: { createdAt: 'desc' },
      });
      expect(prisma.otpCode.count).toHaveBeenCalledWith({
        where: { phone: '+959123456789', createdAt: { gte: expect.any(Date) } },
      });
    });

    describe('cooldown per purpose, hourly cap per phone (review minor 20)', () => {
      type Row = ReturnType<typeof makeOtp>;
      type Where = {
        phone: string;
        purpose?: OtpPurpose;
        createdAt?: { gte: Date };
      };
      let rows: Row[];

      const PHONE = '+959123456789';
      const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);
      const code = (purpose: OtpPurpose, createdAt: Date) =>
        makeOtp({ purpose, createdAt });
      const createdPurpose = () =>
        (prisma.otpCode.create.mock.calls[0] as [{ data: Row }])[0].data
          .purpose;

      // requestOtp's two reads, answered from `rows` as the database would.
      beforeEach(() => {
        rows = [];
        const matches = (row: Row, where: Where) =>
          row.phone === where.phone &&
          (where.purpose === undefined || row.purpose === where.purpose) &&
          (where.createdAt === undefined ||
            row.createdAt >= where.createdAt.gte);
        const matching = (where: Where) =>
          rows
            .filter((row) => matches(row, where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        prisma.otpCode.findFirst.mockImplementation((args: { where: Where }) =>
          Promise.resolve(matching(args.where)[0] ?? null),
        );
        prisma.otpCode.count.mockImplementation((args: { where: Where }) =>
          Promise.resolve(matching(args.where).length),
        );
      });

      it('a sign-in code requested seconds ago does not block a reset code', async () => {
        rows.push(code(OtpPurpose.LOGIN, secondsAgo(5)));

        await service.requestOtp(PHONE, OtpPurpose.PASSWORD_RESET);

        expect(createdPurpose()).toBe(OtpPurpose.PASSWORD_RESET);
      });

      it('a reset code requested seconds ago does not block a sign-in code', async () => {
        rows.push(code(OtpPurpose.PASSWORD_RESET, secondsAgo(5)));

        await service.requestOtp(PHONE, OtpPurpose.LOGIN);

        expect(createdPurpose()).toBe(OtpPurpose.LOGIN);
      });

      it('a second code of the SAME purpose inside 60 s is still refused, whichever purpose', async () => {
        for (const purpose of [OtpPurpose.LOGIN, OtpPurpose.PASSWORD_RESET]) {
          rows = [code(purpose, secondsAgo(5))];

          await expect(service.requestOtp(PHONE, purpose)).rejects.toThrow(
            new ConflictException('Please wait before requesting another code'),
          );
        }
        expect(prisma.otpCode.create).not.toHaveBeenCalled();
      });

      it('the 8-per-hour cap is shared by both purposes', async () => {
        // Eight codes this hour, none inside its own purpose's cooldown.
        rows.push(
          code(OtpPurpose.LOGIN, secondsAgo(55 * 60)),
          code(OtpPurpose.LOGIN, secondsAgo(50 * 60)),
          code(OtpPurpose.LOGIN, secondsAgo(40 * 60)),
          code(OtpPurpose.LOGIN, secondsAgo(30 * 60)),
          code(OtpPurpose.PASSWORD_RESET, secondsAgo(25 * 60)),
          code(OtpPurpose.PASSWORD_RESET, secondsAgo(20 * 60)),
          code(OtpPurpose.PASSWORD_RESET, secondsAgo(15 * 60)),
          code(OtpPurpose.PASSWORD_RESET, secondsAgo(10 * 60)),
        );

        for (const purpose of [OtpPurpose.LOGIN, OtpPurpose.PASSWORD_RESET]) {
          await expect(service.requestOtp(PHONE, purpose)).rejects.toThrow(
            new ConflictException(
              'Too many code requests — please try again later',
            ),
          );
        }
        expect(prisma.otpCode.create).not.toHaveBeenCalled();
      });
    });

    it('rejects once the hourly request cap (8) is hit', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ createdAt: new Date(Date.now() - 61 * 1000) }));
      prisma.otpCode.count.mockResolvedValue(8);

      await expect(service.requestOtp('+959123456789')).rejects.toThrow(ConflictException);
      expect(prisma.otpCode.create).not.toHaveBeenCalled();
    });

    it('still allows the 8th code of the hour (7 already sent)', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ createdAt: new Date(Date.now() - 61 * 1000) }));
      prisma.otpCode.count.mockResolvedValue(7);

      await expect(service.requestOtp('+959123456789')).resolves.toBeUndefined();
      expect(prisma.otpCode.create).toHaveBeenCalled();
    });
  });

  describe('verifyOtp', () => {
    it('only ever looks at codes requested for the purpose it expects (B1)', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(
        makeOtp({ purpose: OtpPurpose.PASSWORD_RESET }),
      );

      await service.verifyOtp('+959123456789', '123456', OtpPurpose.PASSWORD_RESET);

      expect(prisma.otpCode.findFirst).toHaveBeenCalledWith({
        where: {
          phone: '+959123456789',
          purpose: OtpPurpose.PASSWORD_RESET,
          consumedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('a code of the other purpose is no code at all: same 401, nothing counted or consumed', async () => {
      // The purpose filter leaves only the sign-in code out of reach.
      prisma.otpCode.findFirst.mockResolvedValue(null);

      await expect(
        service.verifyOtp('+959123456789', '123456', OtpPurpose.PASSWORD_RESET),
      ).rejects.toThrow(new UnauthorizedException('Invalid or expired code'));
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
      expect(prisma.otpCode.updateMany).not.toHaveBeenCalled();
    });

    it('throws when no code exists for the phone', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);
      await expect(service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN)).rejects.toThrow(UnauthorizedException);
    });

    it('throws and does not consume on an expired code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ expiresAt: new Date(Date.now() - 1000) }));

      await expect(service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN)).rejects.toThrow(UnauthorizedException);
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
      expect(prisma.otpCode.updateMany).not.toHaveBeenCalled();
    });

    it('increments attemptCount on a wrong code without consuming it', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp());

      await expect(service.verifyOtp('+959123456789', '000000', OtpPurpose.LOGIN)).rejects.toThrow(UnauthorizedException);

      expect(prisma.otpCode.update).toHaveBeenCalledWith({
        where: { id: 'otp-1' },
        data: { attemptCount: { increment: 1 } },
      });
      expect(prisma.otpCode.updateMany).not.toHaveBeenCalled();
    });

    it('locks out further attempts once the attempt cap is reached, even with the right code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ attemptCount: 5 }));

      await expect(service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN)).rejects.toThrow(UnauthorizedException);
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
      expect(prisma.otpCode.updateMany).not.toHaveBeenCalled();
    });

    it('marks the code consumed on a correct match', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp());

      await service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN);

      expect(prisma.otpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp-1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('rejects when a concurrent verify already consumed the code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp());
      prisma.otpCode.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN)).rejects.toThrow(
        new UnauthorizedException('Invalid or expired code'),
      );
    });

    it('ignores an already-consumed code (findFirst filters consumedAt: null, so a stale row falling through means no valid code)', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);
      await expect(service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN)).rejects.toThrow(UnauthorizedException);
    });
  });
});
