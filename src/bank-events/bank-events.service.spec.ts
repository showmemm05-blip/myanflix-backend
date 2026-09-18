import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { BankEventsService } from './bank-events.service';
import type { BankEventDto } from './dto/bank-event-batch.dto';

const KEY = 'd'.repeat(64);
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

function event(overrides: Partial<BankEventDto> = {}): BankEventDto {
  return {
    idempotencyKey: KEY,
    deviceSerial: 'PIXEL10',
    paymentAccountId: ACCOUNT,
    direction: 'received',
    amount: 50000,
    currency: 'MMK',
    txCode: 'KBZ20260918AB12CD',
    txCodeLast6: 'AB12CD',
    occurredAt: '2026-09-18T09:00:00.000Z',
    ...overrides,
  };
}

describe('BankEventsService', () => {
  let service: BankEventsService;
  let prisma: {
    paymentAccount: { findUnique: jest.Mock; findMany: jest.Mock };
    deposit: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
    withdrawal: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let gateway: {
    notifyAdminsDepositVerificationUpdated: jest.Mock;
    notifyAdminsWithdrawalVerificationUpdated: jest.Mock;
  };
  let minio: { uploadBuffer: jest.Mock };

  beforeEach(async () => {
    prisma = {
      paymentAccount: {
        findUnique: jest.fn().mockResolvedValue({ isActive: true }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      deposit: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      withdrawal: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // Callback form only: the matcher runs inside one transaction per
      // event and `tx` is this same object (same convention as the
      // deposits/withdrawals specs).
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    gateway = {
      notifyAdminsDepositVerificationUpdated: jest.fn(),
      notifyAdminsWithdrawalVerificationUpdated: jest.fn(),
    };
    minio = { uploadBuffer: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankEventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: MinioService, useValue: minio },
        {
          provide: StorageService,
          useValue: {
            bankScreenshotKey: (kind: string, id: string, key: string) =>
              `documents/bank-screenshots/${kind}/${id}/${key}.png`,
          },
        },
      ],
    }).compile();

    service = module.get(BankEventsService);
  });

  describe('processBatch — permanent rejections happen before any transaction', () => {
    it.each([
      ['UNSUPPORTED_CURRENCY', { currency: 'USD' }],
      ['LAST6_MISMATCH', { txCodeLast6: 'AB12CE' }],
    ])('rejects %s', async (reason, overrides) => {
      const { results } = await service.processBatch({
        events: [event(overrides)],
      });
      expect(results).toEqual([
        { idempotencyKey: KEY, outcome: 'rejected', reason },
      ]);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects an unknown or inactive payment account', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValueOnce(null);
      expect(
        (await service.processBatch({ events: [event()] })).results[0].reason,
      ).toBe('UNKNOWN_PAYMENT_ACCOUNT');
      service.invalidateAccountCache();
      prisma.paymentAccount.findUnique.mockResolvedValueOnce({
        isActive: false,
      });
      expect(
        (await service.processBatch({ events: [event()] })).results[0].reason,
      ).toBe('INACTIVE_PAYMENT_ACCOUNT');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('caches the account lookup so a batch from one phone costs one query', async () => {
      await service.processBatch({
        events: [event(), event({ idempotencyKey: 'e'.repeat(64) })],
      });
      expect(prisma.paymentAccount.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('processBatch — per-event transactions', () => {
    it('runs every event in its own transaction, in order, and keeps the neighbours of a failing one', async () => {
      prisma.$transaction
        .mockImplementationOnce((fn: (tx: unknown) => unknown) => fn(prisma))
        .mockImplementationOnce(() => Promise.reject(new Error('deadlock')))
        .mockImplementationOnce((fn: (tx: unknown) => unknown) => fn(prisma));

      const { results } = await service.processBatch({
        events: [
          event(),
          event({ idempotencyKey: 'e'.repeat(64) }),
          event({ idempotencyKey: 'f'.repeat(64), direction: 'sent' }),
        ],
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
      expect(results.map((r) => r.outcome)).toEqual([
        'no_match',
        'no_match',
        'no_match',
      ]);
      expect(results[1].reason).toBe('INTERNAL_ERROR');
      expect(results[0].reason).toBe('NO_OPEN_CANDIDATE');
    });

    it('pushes admin realtime updates for touched deposits only after the transaction', async () => {
      prisma.deposit.findUnique.mockResolvedValueOnce(null);
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'dep-1',
          userId: 'user-1',
          amount: '50000.00',
          reference: 'AB12CD',
          createdAt: '2026-09-18T09:01:00.000Z',
          declaredTransferAt: null,
          matchStatus: 'UNVERIFIED',
          riskLevel: null,
          riskReasons: [],
        },
      ]);
      const full = {
        id: 'dep-1',
        status: 'PENDING',
        createdAt: new Date('2026-09-18T09:01:00.000Z'),
        bankCheckedAt: new Date(),
        matchStatus: 'MATCHED',
        riskLevel: 'LOW',
        riskReasons: [],
        // A real Prisma row carries Decimals; the audit snapshot reads them.
        amount: new Prisma.Decimal(50000),
        receivingAmount: new Prisma.Decimal(50000),
        receivingTransactionCode: 'AB12CD',
        receivingTransactionAt: new Date('2026-09-18T09:00:00.000Z'),
        receivingScreenshotKey: null,
      };
      (prisma.deposit as Record<string, jest.Mock>).findUniqueOrThrow = jest
        .fn()
        .mockResolvedValue(full);
      // Q4 (twins: `id: { not }`) and Q5 (velocity) find nothing; the
      // after-commit push fetch (`id: { in }`) returns the matched row.
      prisma.deposit.findMany.mockImplementation(
        (args: { where: { id?: unknown } }) =>
          Promise.resolve(
            typeof args.where.id === 'object' &&
              args.where.id !== null &&
              'in' in args.where.id
              ? [full]
              : [],
          ),
      );

      const { results } = await service.processBatch({ events: [event()] });

      expect(results[0]).toMatchObject({
        outcome: 'matched',
        depositId: 'dep-1',
      });
      expect(
        gateway.notifyAdminsDepositVerificationUpdated,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'dep-1',
          matchStatus: 'MATCHED',
          hasBankScreenshot: false,
          receivingTransactionCode: 'AB12CD',
        }),
      );
    });
  });

  describe('attachScreenshot', () => {
    const dto = { idempotencyKey: KEY, deviceSerial: 'PIXEL10' };
    const file = (buffer: Buffer) =>
      ({ buffer }) as unknown as Express.Multer.File;

    it('requires a PNG (sniffed by signature), not just any bytes', async () => {
      prisma.deposit.findUnique.mockResolvedValue({
        id: 'dep-1',
        receivingEventKey: KEY,
        receivingScreenshotKey: null,
      });
      await expect(
        service.attachScreenshot(
          'deposits',
          'dep-1',
          dto,
          file(Buffer.from('GIF89a…')),
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.attachScreenshot('deposits', 'dep-1', dto, undefined),
      ).rejects.toThrow(BadRequestException);
      expect(minio.uploadBuffer).not.toHaveBeenCalled();
    });

    it('404s an unknown row and 409s a row the event did not match', async () => {
      prisma.deposit.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.attachScreenshot('deposits', 'dep-x', dto, file(PNG)),
      ).rejects.toThrow(NotFoundException);

      prisma.deposit.findUnique.mockResolvedValueOnce({
        id: 'dep-1',
        receivingEventKey: 'z'.repeat(64),
        receivingScreenshotKey: null,
      });
      await expect(
        service.attachScreenshot('deposits', 'dep-1', dto, file(PNG)),
      ).rejects.toThrow(ConflictException);
      expect(minio.uploadBuffer).not.toHaveBeenCalled();
    });

    it('is retry-safe: a row that already has a screenshot uploads nothing', async () => {
      prisma.deposit.findUnique.mockResolvedValue({
        id: 'dep-1',
        receivingEventKey: KEY,
        receivingScreenshotKey:
          'documents/bank-screenshots/deposits/dep-1/x.png',
      });
      await expect(
        service.attachScreenshot('deposits', 'dep-1', dto, file(PNG)),
      ).resolves.toEqual({ uploaded: false, alreadyUploaded: true });
      expect(minio.uploadBuffer).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('uploads to the private per-row key, sets the column with a guard, audits as a system row and pushes to admins', async () => {
      prisma.deposit.findUnique.mockResolvedValue({
        id: 'dep-1',
        receivingEventKey: KEY,
        receivingScreenshotKey: null,
      });
      prisma.deposit.findMany.mockResolvedValue([
        {
          id: 'dep-1',
          status: 'PENDING',
          createdAt: new Date(),
          bankCheckedAt: new Date(),
          matchStatus: 'MATCHED',
          riskLevel: 'LOW',
          riskReasons: [],
          receivingAmount: null,
          receivingTransactionCode: 'AB12CD',
          receivingTransactionAt: new Date(),
          receivingScreenshotKey: `documents/bank-screenshots/deposits/dep-1/${KEY}.png`,
        },
      ]);

      await expect(
        service.attachScreenshot('deposits', 'dep-1', dto, file(PNG)),
      ).resolves.toEqual({ uploaded: true });

      expect(minio.uploadBuffer).toHaveBeenCalledWith(
        `documents/bank-screenshots/deposits/dep-1/${KEY}.png`,
        PNG,
      );
      expect(prisma.deposit.updateMany).toHaveBeenCalledWith({
        where: { id: 'dep-1', receivingScreenshotKey: null },
        data: {
          receivingScreenshotKey: `documents/bank-screenshots/deposits/dep-1/${KEY}.png`,
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deposit.bank_screenshot_attach',
          actor: null,
          metadata: expect.objectContaining({
            source: 'phone-monitor',
            idempotencyKey: KEY,
            deviceSerial: 'PIXEL10',
            bytes: PNG.length,
          }),
        }),
      );
      expect(
        gateway.notifyAdminsDepositVerificationUpdated,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'dep-1', hasBankScreenshot: true }),
      );
    });

    it('mirrors for withdrawals with the transfer* columns', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({
        id: 'wd-1',
        transferEventKey: KEY,
        transferScreenshotKey: null,
      });
      await expect(
        service.attachScreenshot('withdrawals', 'wd-1', dto, file(PNG)),
      ).resolves.toEqual({ uploaded: true });
      expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
        where: { id: 'wd-1', transferScreenshotKey: null },
        data: {
          transferScreenshotKey: `documents/bank-screenshots/withdrawals/wd-1/${KEY}.png`,
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'withdrawal.bank_screenshot_attach',
        }),
      );
    });
  });

  it('lists active accounts with labels only — no balances', async () => {
    prisma.paymentAccount.findMany.mockResolvedValue([
      {
        id: ACCOUNT,
        type: 'KBZPay',
        subname: 'K1',
        accountName: 'MyanFlix',
        accountNumber: '09',
      },
    ]);
    const accounts = await service.listActiveAccounts();
    expect(accounts[0]).not.toHaveProperty('balance');
    expect(prisma.paymentAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });
});
