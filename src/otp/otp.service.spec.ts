import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpPurpose, SmsMessageStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TOO_MANY_CODE_REQUESTS_MESSAGE } from '../sms/sms.config';
import { SmsService } from '../sms/sms.service';
import { OtpCodeHasher, resolveOtpCodePepper } from './otp-code.hasher';
import { OTP_DEV_CODE_WARNING } from './otp-dev-code';
import { OTP_ROW_RETENTION_MS, OtpService } from './otp.service';

type RawCall = [TemplateStringsArray, ...unknown[]];

const PEPPER = 'unit-test-otp-code-pepper-0123456789abcdef';
const JWT_SECRET = 'unit-test-jwt-secret-0123456789';
/** Hashes exactly as the service under test does (same pepper). */
const hasher = new OtpCodeHasher(PEPPER);
const PHONE = '+959123456789';

function makeOtp(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'otp-1',
    phone: PHONE,
    // M-1: the row holds only the keyed hash of 123456 — never the digits.
    codeHash: hasher.hash(PHONE, '123456'),
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
  /**
   * requestOtp runs inside prisma.$transaction; the mock hands the callback
   * this same object as `tx` (and records when the transaction "commits"),
   * so every read and write below is one on the transaction.
   */
  let prisma: {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    otpCode: {
      findFirst: jest.Mock;
      create: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    smsMessage: { updateMany: jest.Mock };
  };
  let smsService: { send: jest.Mock; sendWithin: jest.Mock };
  /** What sendWithin hands back: wakes the gateway after the commit. */
  let afterCommit: jest.Mock;
  let committed: boolean;
  let env: Record<string, string | undefined>;

  /** Boots a service against `env` (the default one has the pepper set). */
  async function serviceWith(
    overrides: Record<string, string | undefined>,
  ): Promise<OtpService> {
    const vars = { ...env, ...overrides };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: prisma },
        { provide: SmsService, useValue: smsService },
        { provide: ConfigService, useValue: { get: (k: string) => vars[k] } },
      ],
    }).compile();
    return module.get(OtpService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    env = { OTP_CODE_PEPPER: PEPPER, JWT_SECRET, NODE_ENV: 'test' };

    committed = false;
    prisma = {
      $transaction: jest.fn(),
      $executeRaw: jest.fn().mockResolvedValue(1),
      otpCode: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue(makeOtp()),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      smsMessage: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma.$transaction.mockImplementation(
      async (run: (tx: typeof prisma) => Promise<unknown>) => {
        const result = await run(prisma);
        committed = true;
        return result;
      },
    );
    afterCommit = jest.fn();
    smsService = {
      send: jest.fn().mockResolvedValue(undefined),
      sendWithin: jest.fn().mockResolvedValue(afterCommit),
    };

    service = await serviceWith({});
  });

  describe('requestOtp', () => {
    it('generates a code, stores only its keyed hash, and hands the code to SmsService', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);

      await service.requestOtp('+959123456789');

      expect(prisma.otpCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          phone: '+959123456789',
          codeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      });
      expect(smsService.sendWithin).toHaveBeenCalledWith(
        prisma,
        '+959123456789',
        expect.stringMatching(/^MyanFlix: \d{3} \d{3}$/),
        { otpCodeId: 'otp-1', expiresAt: expect.any(Date) },
      );
      expect(smsService.send).not.toHaveBeenCalled();
    });

    it('hands SmsService the code whose hash it stored, its row id and its expiry (so the gateway queues it once and never sends it late)', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);
      const stored = makeOtp({ id: 'otp-77' });
      prisma.otpCode.create.mockResolvedValue(stored);

      await service.requestOtp('+959123456789');

      const created = (
        prisma.otpCode.create.mock.calls[0] as [{ data: { codeHash: string } }]
      )[0].data;
      const [, , message, meta] = smsService.sendWithin.mock.calls[0] as [
        unknown,
        string,
        string,
        { otpCodeId: string; expiresAt: Date },
      ];
      const sent = /^MyanFlix: (\d{3}) (\d{3})$/.exec(message);
      expect(sent).not.toBeNull();
      const code = `${sent![1]}${sent![2]}`;
      // The SMS carries the digits; the row carries their hash — the two
      // agree, so verifyOtp accepts exactly what the phone received.
      expect(created.codeHash).toBe(hasher.hash('+959123456789', code));
      expect(meta).toEqual({
        otpCodeId: 'otp-77',
        expiresAt: stored.expiresAt,
      });
    });

    describe('M-1: the plain code never reaches the database', () => {
      it('writes no `code` field at all, only a 64-hex HMAC that is not the digits', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(null);

        await service.requestOtp('+959123456789');

        const [{ data }] = prisma.otpCode.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ];
        const [, , message] = smsService.sendWithin.mock.calls[0] as [
          unknown,
          string,
          string,
        ];
        const digits = message.replace(/\D/g, '');
        expect(digits).toMatch(/^\d{6}$/);
        expect(data).not.toHaveProperty('code');
        expect(data.codeHash).toMatch(/^[0-9a-f]{64}$/);
        expect(data.codeHash).not.toContain(digits);
        expect(JSON.stringify(data)).not.toContain(digits);
      });

      it('the hash is keyed: a different OTP_CODE_PEPPER stores a different value for the same code', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(null);
        const other = await serviceWith({
          OTP_CODE_PEPPER: 'another-otp-code-pepper-9876543210zyxwvu',
        });

        await other.requestOtp('+959123456789');

        const [{ data }] = prisma.otpCode.create.mock.calls[0] as [
          { data: { codeHash: string } },
        ];
        const [, , message] = smsService.sendWithin.mock.calls[0] as [
          unknown,
          string,
          string,
        ];
        const code = message.replace(/\D/g, '');
        expect(data.codeHash).not.toBe(hasher.hash('+959123456789', code));
        expect(data.codeHash).toBe(
          new OtpCodeHasher('another-otp-code-pepper-9876543210zyxwvu').hash(
            '+959123456789',
            code,
          ),
        );
      });

      it('without OTP_CODE_PEPPER the key is derived from JWT_SECRET (never JWT_SECRET itself), so local keeps working', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(null);
        const derived = await serviceWith({ OTP_CODE_PEPPER: undefined });

        await derived.requestOtp('+959123456789');

        const [{ data }] = prisma.otpCode.create.mock.calls[0] as [
          { data: { codeHash: string } },
        ];
        const [, , message] = smsService.sendWithin.mock.calls[0] as [
          unknown,
          string,
          string,
        ];
        const code = message.replace(/\D/g, '');
        const pepper = resolveOtpCodePepper({
          get: (k: string) => ({ JWT_SECRET })[k],
        });
        expect(pepper.derivedFromJwtSecret).toBe(true);
        expect(pepper.secret).not.toBe(JWT_SECRET);
        expect(data.codeHash).toBe(
          new OtpCodeHasher(pepper.secret).hash('+959123456789', code),
        );
        expect(data.codeHash).not.toBe(
          new OtpCodeHasher(JWT_SECRET).hash('+959123456789', code),
        );
      });

      it('warns at boot in production when OTP_CODE_PEPPER is unset — and stays quiet elsewhere or when it is set', async () => {
        const warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        await serviceWith({
          NODE_ENV: 'production',
          OTP_CODE_PEPPER: undefined,
        });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('OTP_CODE_PEPPER is not set'),
        );
        for (const line of warn.mock.calls.map(([l]) => String(l))) {
          expect(line).not.toContain(JWT_SECRET);
        }

        warn.mockClear();
        await serviceWith({ NODE_ENV: 'production' });
        await serviceWith({
          NODE_ENV: 'development',
          OTP_CODE_PEPPER: undefined,
        });
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
      });
    });

    describe('B2: one transaction, one phone at a time', () => {
      it('takes the per-phone advisory lock first, inside the transaction, before any check', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(null);

        await service.requestOtp('+959123456789');

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        const lock = prisma.$executeRaw.mock.calls[0] as RawCall;
        expect(lock[0].join('?')).toContain(
          "pg_advisory_xact_lock(hashtext('otp_codes.request'), hashtext(?))",
        );
        expect(lock.slice(1)).toEqual(['+959123456789']);
        const locked = prisma.$executeRaw.mock.invocationCallOrder[0];
        expect(locked).toBeLessThan(
          prisma.otpCode.findFirst.mock.invocationCallOrder[0],
        );
        expect(locked).toBeLessThan(
          prisma.otpCode.count.mock.invocationCallOrder[0],
        );
        expect(locked).toBeLessThan(
          prisma.otpCode.create.mock.invocationCallOrder[0],
        );
      });

      it('locks on the phone alone, so both purposes share it (the hourly cap spans both)', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(null);

        await service.requestOtp('+959123456789', OtpPurpose.LOGIN);
        await service.requestOtp('+959123456789', OtpPurpose.PASSWORD_RESET);

        const [login, reset] = prisma.$executeRaw.mock.calls as RawCall[];
        expect(login.slice(1)).toEqual(reset.slice(1));
      });

      it('a refusal inside the lock (cooldown) writes nothing and queues nothing', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(
          makeOtp({ createdAt: new Date() }),
        );

        await expect(service.requestOtp('+959123456789')).rejects.toThrow(
          new ConflictException('Please wait before requesting another code'),
        );

        expect(prisma.otpCode.create).not.toHaveBeenCalled();
        expect(smsService.sendWithin).not.toHaveBeenCalled();
        expect(prisma.smsMessage.updateMany).not.toHaveBeenCalled();
      });
    });

    describe('B1: the new code replaces the older ones', () => {
      it('cancels the QUEUED SMS of older codes of the same phone and purpose — after queueing the new one', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(null);
        prisma.otpCode.create.mockResolvedValue(makeOtp({ id: 'otp-new' }));

        await service.requestOtp('+959123456789', OtpPurpose.PASSWORD_RESET);

        expect(prisma.smsMessage.updateMany).toHaveBeenCalledWith({
          where: {
            phone: '+959123456789',
            status: SmsMessageStatus.QUEUED,
            otpCodeId: { not: 'otp-new' },
            otpCode: {
              is: {
                phone: '+959123456789',
                purpose: OtpPurpose.PASSWORD_RESET,
              },
            },
          },
          data: { status: SmsMessageStatus.CANCELLED },
        });
        expect(smsService.sendWithin.mock.invocationCallOrder[0]).toBeLessThan(
          prisma.smsMessage.updateMany.mock.invocationCallOrder[0],
        );
      });

      it('only QUEUED rows: a LEASED one (the phone may be sending it) is never touched', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(null);

        await service.requestOtp('+959123456789');

        const [{ where }] = prisma.smsMessage.updateMany.mock.calls[0] as [
          { where: { status: SmsMessageStatus } },
        ];
        expect(where.status).toBe(SmsMessageStatus.QUEUED);
      });

      it('logs how many it cancelled with the phone masked — never the code', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(null);
        prisma.smsMessage.updateMany.mockResolvedValue({ count: 1 });
        const log = jest
          .spyOn(Logger.prototype, 'log')
          .mockImplementation(() => undefined);

        await service.requestOtp('+959123456789');

        const [, , message] = smsService.sendWithin.mock.calls[0] as [
          unknown,
          string,
          string,
        ];
        const code = message.replace(/\D/g, '');
        const lines = log.mock.calls.map(([line]) => String(line));
        expect(lines.join('\n')).toContain('Cancelled 1 queued SMS');
        for (const line of lines) {
          expect(line).not.toContain(code);
          expect(line).not.toContain('+959123456789');
        }
        log.mockRestore();
      });
    });

    it('wakes the gateway phone only after the transaction committed', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);
      afterCommit.mockImplementation(() => {
        expect(committed).toBe(true);
      });

      await service.requestOtp('+959123456789');

      expect(afterCommit).toHaveBeenCalledTimes(1);
    });

    describe('when the SMS cannot be queued (gateway offline, a cap, not a mobile)', () => {
      const unavailable = () =>
        new ServiceUnavailableException(
          'SMS service is temporarily unavailable. Please try again shortly.',
        );

      beforeEach(() => {
        prisma.otpCode.findFirst.mockResolvedValue(null);
        prisma.otpCode.create.mockResolvedValue(makeOtp({ id: 'otp-9' }));
        smsService.sendWithin.mockRejectedValue(unavailable());
      });

      it('the refusal throws out of the transaction, so the code row rolls back with it', async () => {
        await expect(service.requestOtp('+959123456789')).rejects.toThrow(
          unavailable(),
        );

        expect(committed).toBe(false);
        // The rollback takes the code row: no compensating delete needed.
        expect(prisma.otpCode.deleteMany).not.toHaveBeenCalled();
      });

      it('cancels no older SMS and wakes nobody', async () => {
        await expect(service.requestOtp('+959123456789')).rejects.toThrow(
          ServiceUnavailableException,
        );

        expect(prisma.smsMessage.updateMany).not.toHaveBeenCalled();
        expect(afterCommit).not.toHaveBeenCalled();
      });

      it("passes the per-phone cap's 409 through word for word", async () => {
        smsService.sendWithin.mockRejectedValue(
          new ConflictException(TOO_MANY_CODE_REQUESTS_MESSAGE),
        );

        await expect(service.requestOtp('+959123456789')).rejects.toThrow(
          new ConflictException(
            'Too many code requests — please try again later',
          ),
        );
      });
    });

    it('rejects a resend within the cooldown window', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(
        makeOtp({ createdAt: new Date() }),
      );

      await expect(service.requestOtp('+959123456789')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.otpCode.create).not.toHaveBeenCalled();
    });

    it('allows a resend once the cooldown has passed', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(
        makeOtp({ createdAt: new Date(Date.now() - 61 * 1000) }),
      );

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
      prisma.otpCode.findFirst.mockResolvedValue(
        makeOtp({ createdAt: new Date(Date.now() - 61 * 1000) }),
      );
      prisma.otpCode.count.mockResolvedValue(8);

      await expect(service.requestOtp('+959123456789')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.otpCode.create).not.toHaveBeenCalled();
    });

    it('still allows the 8th code of the hour (7 already sent)', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(
        makeOtp({ createdAt: new Date(Date.now() - 61 * 1000) }),
      );
      prisma.otpCode.count.mockResolvedValue(7);

      await expect(
        service.requestOtp('+959123456789'),
      ).resolves.toBeUndefined();
      expect(prisma.otpCode.create).toHaveBeenCalled();
    });
  });

  describe('verifyOtp', () => {
    it('only ever looks at codes requested for the purpose it expects (B1)', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(
        makeOtp({ purpose: OtpPurpose.PASSWORD_RESET }),
      );

      await service.verifyOtp(
        '+959123456789',
        '123456',
        OtpPurpose.PASSWORD_RESET,
      );

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
      await expect(
        service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws and does not consume on an expired code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(
        makeOtp({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
      expect(prisma.otpCode.updateMany).not.toHaveBeenCalled();
    });

    it('a wrong code spends one try (claimed only while tries are left) and is not consumed', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp());

      await expect(
        service.verifyOtp('+959123456789', '000000', OtpPurpose.LOGIN),
      ).rejects.toThrow(new UnauthorizedException('Invalid or expired code'));

      expect(prisma.otpCode.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.otpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp-1', attemptCount: { lt: 5 } },
        data: { attemptCount: { increment: 1 } },
      });
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
    });

    it('claims the try BEFORE judging: a guess that finds every try taken by parallel guesses is refused unjudged — even the right code', async () => {
      // findFirst read attemptCount 4, but parallel guesses spent the last
      // try before this one's conditional claim ran.
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ attemptCount: 4 }));
      prisma.otpCode.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN),
      ).rejects.toThrow(
        new UnauthorizedException(
          'Too many incorrect attempts — request a new code',
        ),
      );
      // Only the failed claim ran: nothing consumed.
      expect(prisma.otpCode.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.otpCode.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { consumedAt: expect.any(Date) } }),
      );
    });

    it('parallel guesses on one code: at most 5 are judged, the rest are refused as too many', async () => {
      // A shared row whose conditional claim behaves like Postgres would.
      const row = makeOtp();
      prisma.otpCode.findFirst.mockResolvedValue({ ...row });
      prisma.otpCode.updateMany.mockImplementation(
        ({
          where,
          data,
        }: {
          where: { attemptCount?: { lt: number } };
          data: { attemptCount?: unknown; consumedAt?: Date };
        }) => {
          if (where.attemptCount) {
            if (row.attemptCount >= where.attemptCount.lt) {
              return Promise.resolve({ count: 0 });
            }
            row.attemptCount += 1;
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: data.consumedAt ? 1 : 0 });
        },
      );

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          service.verifyOtp(
            '+959123456789',
            String(100000 + i),
            OtpPurpose.LOGIN,
          ),
        ),
      );

      const messages = results.map((r) =>
        r.status === 'rejected' ? (r.reason as Error).message : 'ok',
      );
      expect(
        messages.filter((m) => m === 'Invalid or expired code'),
      ).toHaveLength(5);
      expect(
        messages.filter(
          (m) => m === 'Too many incorrect attempts — request a new code',
        ),
      ).toHaveLength(5);
      expect(row.attemptCount).toBe(5);
    });

    it('4 wrong codes, then the right one, still works (the 5th try)', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ attemptCount: 4 }));

      await service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN);

      expect(prisma.otpCode.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'otp-1', attemptCount: { lt: 5 } },
        data: { attemptCount: { increment: 1 } },
      });
      expect(prisma.otpCode.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'otp-1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('locks out further attempts once the attempt cap is reached, even with the right code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(makeOtp({ attemptCount: 5 }));

      await expect(
        service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.otpCode.update).not.toHaveBeenCalled();
      expect(prisma.otpCode.updateMany).not.toHaveBeenCalled();
    });

    describe('M-1: judged against the stored hash', () => {
      it('the right digits match the stored hash and consume the code', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(makeOtp());

        await expect(
          service.verifyOtp(PHONE, '123456', OtpPurpose.LOGIN),
        ).resolves.toBeUndefined();
        expect(prisma.otpCode.updateMany).toHaveBeenLastCalledWith({
          where: { id: 'otp-1', consumedAt: null },
          data: { consumedAt: expect.any(Date) },
        });
      });

      it('the stored hash itself, pasted as the code, is refused (reading the database gives nothing usable)', async () => {
        const row = makeOtp();
        prisma.otpCode.findFirst.mockResolvedValue(row);

        await expect(
          service.verifyOtp(PHONE, row.codeHash, OtpPurpose.LOGIN),
        ).rejects.toThrow(new UnauthorizedException('Invalid or expired code'));
        expect(prisma.otpCode.updateMany).toHaveBeenCalledTimes(1);
      });

      it('a hash made under another pepper never matches (a changed pepper only voids codes in flight)', async () => {
        const other = new OtpCodeHasher(
          'another-otp-code-pepper-9876543210zyxwvu',
        );
        prisma.otpCode.findFirst.mockResolvedValue(
          makeOtp({ codeHash: other.hash(PHONE, '123456') }),
        );

        await expect(
          service.verifyOtp(PHONE, '123456', OtpPurpose.LOGIN),
        ).rejects.toThrow(new UnauthorizedException('Invalid or expired code'));
      });

      it('a hash of the same digits for ANOTHER phone never matches (the phone is part of the hash)', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(
          makeOtp({ codeHash: hasher.hash('+959999999999', '123456') }),
        );

        await expect(
          service.verifyOtp(PHONE, '123456', OtpPurpose.LOGIN),
        ).rejects.toThrow(new UnauthorizedException('Invalid or expired code'));
      });

      it('a legacy plain-text row (the digits in codeHash) is refused rather than compared as text', async () => {
        prisma.otpCode.findFirst.mockResolvedValue(
          makeOtp({ codeHash: '123456' }),
        );

        await expect(
          service.verifyOtp(PHONE, '123456', OtpPurpose.LOGIN),
        ).rejects.toThrow(new UnauthorizedException('Invalid or expired code'));
      });
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
      // The try is claimed; the consume then matches no row.
      prisma.otpCode.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await expect(
        service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN),
      ).rejects.toThrow(new UnauthorizedException('Invalid or expired code'));
    });

    it('ignores an already-consumed code (findFirst filters consumedAt: null, so a stale row falling through means no valid code)', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);
      await expect(
        service.verifyOtp('+959123456789', '123456', OtpPurpose.LOGIN),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('sweepOldCodes (M-1: the nightly cleanup)', () => {
    it('deletes every row older than a day — consumed or not — and nothing newer', async () => {
      prisma.otpCode.deleteMany.mockResolvedValue({ count: 3 });
      const before = Date.now();

      await expect(service.sweepOldCodes()).resolves.toBe(3);

      const [{ where }] = prisma.otpCode.deleteMany.mock.calls[0] as [
        { where: { createdAt: { lt: Date }; consumedAt?: unknown } },
      ];
      expect(where.consumedAt).toBeUndefined();
      const cutoff = where.createdAt.lt.getTime();
      expect(cutoff).toBeGreaterThanOrEqual(before - OTP_ROW_RETENTION_MS);
      expect(cutoff).toBeLessThanOrEqual(Date.now() - OTP_ROW_RETENTION_MS);
      expect(OTP_ROW_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
    });

    it('is scheduled once a day with @nestjs/schedule, like the upload sweeps', () => {
      // The decorator leaves the cron metadata on the method; the explorer
      // ScheduleModule.forRoot() runs in AppModule picks it up at boot.
      const meta = Reflect.getMetadataKeys(
        Object.getPrototypeOf(service).sweepOldCodes as object,
      ).map(String);
      expect(meta.some((k) => k.toLowerCase().includes('cron'))).toBe(true);
    });

    it('logs the count (never a phone) only when something was deleted', async () => {
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      prisma.otpCode.deleteMany.mockResolvedValueOnce({ count: 0 });
      await service.sweepOldCodes();
      expect(log).not.toHaveBeenCalled();

      prisma.otpCode.deleteMany.mockResolvedValueOnce({ count: 2 });
      await service.sweepOldCodes();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Deleted 2 one-time code row(s)'),
      );
      log.mockRestore();
    });
  });
  describe('OTP_DEV_CODE (fixed local-development code)', () => {
    const DEV = '246810';
    /** A development machine: the cache base is localhost. */
    const devEnv = {
      OTP_DEV_CODE: DEV,
      STREAM_PUBLIC_BASE_URL: 'http://localhost:8080',
    };
    let warn: jest.SpyInstance;
    let log: jest.SpyInstance;

    beforeEach(() => {
      warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
    });
    afterEach(() => {
      warn.mockRestore();
      log.mockRestore();
    });

    /** Every string any Logger method was called with in this test. */
    function everyLogLine(): string {
      return [...warn.mock.calls, ...log.mock.calls]
        .flat()
        .map((v) => String(v))
        .join('\n');
    }

    describe('unset or empty: nothing changes', () => {
      it.each([
        ['unset', undefined],
        ['empty', ''],
      ])(
        '%s: a random code goes to SmsService as before, no dev warning',
        async (_, value) => {
          const svc = await serviceWith({
            OTP_DEV_CODE: value,
            STREAM_PUBLIC_BASE_URL: 'http://localhost:8080',
          });
          prisma.otpCode.findFirst.mockResolvedValue(null);

          await svc.requestOtp(PHONE);

          expect(smsService.sendWithin).toHaveBeenCalledTimes(1);
          expect(afterCommit).toHaveBeenCalledTimes(1);
          expect(warn).not.toHaveBeenCalledWith(OTP_DEV_CODE_WARNING);
        },
      );

      it('unset never needs STREAM_PUBLIC_BASE_URL (a public base boots as before)', async () => {
        await expect(
          serviceWith({
            OTP_DEV_CODE: undefined,
            STREAM_PUBLIC_BASE_URL: 'https://cache.example.com',
          }),
        ).resolves.toBeInstanceOf(OtpService);
      });
    });

    describe('set', () => {
      it('logs ONE loud warning at startup — without the code', async () => {
        await serviceWith(devEnv);

        const devWarnings = warn.mock.calls.filter(
          ([m]) => m === OTP_DEV_CODE_WARNING,
        );
        expect(devWarnings).toHaveLength(1);
        expect(OTP_DEV_CODE_WARNING).toMatch(/OTP_DEV_CODE is ON/);
        expect(OTP_DEV_CODE_WARNING).toMatch(/no SMS is sent/);
        expect(everyLogLine()).not.toContain(DEV);
      });

      it.each([
        OtpPurpose.LOGIN,
        OtpPurpose.PASSWORD_RESET,
        OtpPurpose.WITHDRAWAL_CODE_RESET,
      ])(
        '%s: stores the keyed hash of the dev code (never the digits) and sends/queues no SMS',
        async (purpose) => {
          const svc = await serviceWith(devEnv);
          prisma.otpCode.findFirst.mockResolvedValue(null);

          await expect(svc.requestOtp(PHONE, purpose)).resolves.toBeUndefined();

          const [{ data }] = prisma.otpCode.create.mock.calls[0] as [
            { data: Record<string, unknown> },
          ];
          expect(data).toEqual({
            phone: PHONE,
            codeHash: hasher.hash(PHONE, DEV),
            purpose,
            expiresAt: expect.any(Date),
          });
          expect(JSON.stringify(data)).not.toContain(DEV);
          // Same 5-minute life as a real code.
          const ttl = (data.expiresAt as Date).getTime() - Date.now();
          expect(ttl).toBeGreaterThan(5 * 60 * 1000 - 5000);
          expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000);

          // SmsService (and through it the gateway queue: no sms_messages
          // row, no daily-cap count, no wake-up) is never touched.
          expect(smsService.sendWithin).not.toHaveBeenCalled();
          expect(smsService.send).not.toHaveBeenCalled();
          expect(afterCommit).not.toHaveBeenCalled();
          expect(committed).toBe(true);
        },
      );

      it('logs the request with the phone masked — never the code, never the full number', async () => {
        const svc = await serviceWith(devEnv);
        prisma.otpCode.findFirst.mockResolvedValue(null);

        await svc.requestOtp(PHONE);

        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(/OTP_DEV_CODE: LOGIN code for \+9\*{5}789/),
        );
        const lines = everyLogLine();
        expect(lines).not.toContain(DEV);
        expect(lines).not.toContain(PHONE);
      });

      it('takes the same per-phone lock and still cancels older QUEUED SMS (B1)', async () => {
        const svc = await serviceWith(devEnv);
        prisma.otpCode.findFirst.mockResolvedValue(null);

        await svc.requestOtp(PHONE, OtpPurpose.PASSWORD_RESET);

        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
        expect(prisma.smsMessage.updateMany).toHaveBeenCalledWith({
          where: {
            phone: PHONE,
            status: SmsMessageStatus.QUEUED,
            otpCodeId: { not: 'otp-1' },
            otpCode: {
              is: { phone: PHONE, purpose: OtpPurpose.PASSWORD_RESET },
            },
          },
          data: { status: SmsMessageStatus.CANCELLED },
        });
      });

      it('the resend cooldown still applies (409, nothing stored)', async () => {
        const svc = await serviceWith(devEnv);
        prisma.otpCode.findFirst.mockResolvedValue(
          makeOtp({ createdAt: new Date(Date.now() - 10_000) }),
        );

        await expect(svc.requestOtp(PHONE)).rejects.toThrow(
          new ConflictException('Please wait before requesting another code'),
        );
        expect(prisma.otpCode.create).not.toHaveBeenCalled();
      });

      it('the hourly cap still applies (409, nothing stored)', async () => {
        const svc = await serviceWith(devEnv);
        prisma.otpCode.findFirst.mockResolvedValue(null);
        prisma.otpCode.count.mockResolvedValue(8);

        await expect(svc.requestOtp(PHONE)).rejects.toThrow(
          new ConflictException(TOO_MANY_CODE_REQUESTS_MESSAGE),
        );
        expect(prisma.otpCode.create).not.toHaveBeenCalled();
      });

      describe('verify: the normal path, unchanged', () => {
        /** The row requestOtp stored, as verifyOtp will find it. */
        async function storedDevRow(svc: OtpService, purpose: OtpPurpose) {
          prisma.otpCode.findFirst.mockResolvedValueOnce(null);
          await svc.requestOtp(PHONE, purpose);
          const [{ data }] = prisma.otpCode.create.mock.calls[0] as [
            { data: { codeHash: string; expiresAt: Date } },
          ];
          return makeOtp({
            purpose,
            codeHash: data.codeHash,
            expiresAt: data.expiresAt,
          });
        }

        it.each([
          OtpPurpose.LOGIN,
          OtpPurpose.PASSWORD_RESET,
          OtpPurpose.WITHDRAWAL_CODE_RESET,
        ])('%s: the dev code verifies and is consumed', async (purpose) => {
          const svc = await serviceWith(devEnv);
          const row = await storedDevRow(svc, purpose);
          prisma.otpCode.findFirst.mockResolvedValue(row);
          prisma.otpCode.updateMany.mockClear();

          await expect(
            svc.verifyOtp(PHONE, DEV, purpose),
          ).resolves.toBeUndefined();

          expect(prisma.otpCode.updateMany).toHaveBeenNthCalledWith(1, {
            where: { id: 'otp-1', attemptCount: { lt: 5 } },
            data: { attemptCount: { increment: 1 } },
          });
          expect(prisma.otpCode.updateMany).toHaveBeenNthCalledWith(2, {
            where: { id: 'otp-1', consumedAt: null },
            data: { consumedAt: expect.any(Date) },
          });
        });

        it('a different code is refused (401), spends one try and consumes nothing', async () => {
          const svc = await serviceWith(devEnv);
          const row = await storedDevRow(svc, OtpPurpose.LOGIN);
          prisma.otpCode.findFirst.mockResolvedValue(row);
          prisma.otpCode.updateMany.mockClear();

          await expect(
            svc.verifyOtp(PHONE, '135790', OtpPurpose.LOGIN),
          ).rejects.toThrow(
            new UnauthorizedException('Invalid or expired code'),
          );

          expect(prisma.otpCode.updateMany).toHaveBeenCalledTimes(1);
          expect(prisma.otpCode.updateMany).toHaveBeenCalledWith({
            where: { id: 'otp-1', attemptCount: { lt: 5 } },
            data: { attemptCount: { increment: 1 } },
          });
        });

        it('expired, used-up and locked-out rules are unchanged', async () => {
          const svc = await serviceWith(devEnv);
          const row = await storedDevRow(svc, OtpPurpose.LOGIN);

          prisma.otpCode.findFirst.mockResolvedValueOnce({
            ...row,
            expiresAt: new Date(Date.now() - 1000),
          });
          await expect(
            svc.verifyOtp(PHONE, DEV, OtpPurpose.LOGIN),
          ).rejects.toThrow(
            new UnauthorizedException('Invalid or expired code'),
          );

          prisma.otpCode.findFirst.mockResolvedValueOnce({
            ...row,
            attemptCount: 5,
          });
          await expect(
            svc.verifyOtp(PHONE, DEV, OtpPurpose.LOGIN),
          ).rejects.toThrow(
            new UnauthorizedException(
              'Too many incorrect attempts — request a new code',
            ),
          );

          // Single use: a second verify finds no unconsumed row.
          prisma.otpCode.findFirst.mockResolvedValueOnce(null);
          await expect(
            svc.verifyOtp(PHONE, DEV, OtpPurpose.LOGIN),
          ).rejects.toThrow(UnauthorizedException);
        });

        it('a dev code of one purpose never passes for another (B1 unchanged)', async () => {
          const svc = await serviceWith(devEnv);
          await storedDevRow(svc, OtpPurpose.PASSWORD_RESET);
          // verifyOtp filters by purpose: no LOGIN row exists.
          prisma.otpCode.findFirst.mockResolvedValue(null);

          await expect(
            svc.verifyOtp(PHONE, DEV, OtpPurpose.LOGIN),
          ).rejects.toThrow(
            new UnauthorizedException('Invalid or expired code'),
          );
          expect(prisma.otpCode.findFirst).toHaveBeenLastCalledWith({
            where: {
              phone: PHONE,
              purpose: OtpPurpose.LOGIN,
              consumedAt: null,
            },
            orderBy: { createdAt: 'desc' },
          });
        });
      });
    });

    describe('the service repeats the boot guard (defence in depth)', () => {
      it.each([
        ['a public cache base', 'https://cache.example.com'],
        ['no cache base at all', undefined],
        ['an unparsable cache base', 'not-a-url'],
      ])('refuses to start with %s', async (_, url) => {
        await expect(
          serviceWith({ OTP_DEV_CODE: DEV, STREAM_PUBLIC_BASE_URL: url }),
        ).rejects.toThrow(
          /OTP_DEV_CODE must not be set on a public deployment/,
        );
      });

      it.each([
        [
          'STREAM_PUBLIC_BASE_URL_IS_PUBLIC=true',
          { STREAM_PUBLIC_BASE_URL_IS_PUBLIC: 'true' },
        ],
        [
          'a public upload address',
          { MINIO_PUBLIC_ENDPOINT: 'https://upload.example.com' },
        ],
        [
          'a public CORS origin',
          { CORS_ORIGINS: 'https://myanflix.example.com' },
        ],
        ['a reverse proxy', { TRUSTED_PROXIES: '10.0.0.2' }],
      ])(
        'refuses to start on a localhost cache base with %s',
        async (_, extra: Record<string, string>) => {
          await expect(
            serviceWith({
              ...devEnv,
              STREAM_PUBLIC_BASE_URL: 'http://localhost:8080',
              ...extra,
            }),
          ).rejects.toThrow(
            /OTP_DEV_CODE must not be set on a public deployment/,
          );
        },
      );

      it.each(['12345', 'abcdef', '1234567'])(
        'refuses to start with the malformed value %p',
        async (value) => {
          await expect(
            serviceWith({ ...devEnv, OTP_DEV_CODE: value }),
          ).rejects.toThrow(/OTP_DEV_CODE must be exactly 6 digits/);
        },
      );
    });
  });
});
