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
import { PaymentAccountEvents } from '../payment-accounts/payment-account-events';
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

/** A bank_transactions row as Prisma returns it. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    idempotencyKey: KEY,
    deviceSerial: 'PIXEL10',
    paymentAccountId: ACCOUNT,
    direction: 'RECEIVED',
    amount: new Prisma.Decimal(50000),
    currency: 'MMK',
    txCode: 'KBZ20260918AB12CD',
    txCodeLast6: 'AB12CD',
    // Recent by the bank's clock, so the read-time view is WAITING (not
    // UNCLAIMED) whatever day the suite runs on.
    occurredAt: new Date(Date.now() - 60_000),
    postedAt: new Date(Date.now() - 55_000),
    counterparty: null,
    screenshotKey: null,
    detailStatus: null,
    state: 'UNMATCHED',
    linkedDepositId: null,
    linkedWithdrawalId: null,
    matchedAt: null,
    createdAt: new Date(Date.now() - 50_000),
    updatedAt: new Date(Date.now() - 50_000),
    ...overrides,
  };
}

describe('BankEventsService', () => {
  let service: BankEventsService;
  let accountEvents: PaymentAccountEvents;
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
    bankTransaction: {
      findUnique: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let gateway: {
    notifyAdminsDepositVerificationUpdated: jest.Mock;
    notifyAdminsWithdrawalVerificationUpdated: jest.Mock;
    notifyAdminsBankTransactionCreated: jest.Mock;
    notifyAdminsBankTransactionUpdated: jest.Mock;
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
      bankTransaction: {
        // Q-BT0: unknown key by default → create stores it; the after-commit
        // push reads the row back by id.
        findUnique: jest.fn((args: { where: Record<string, unknown> }) =>
          Promise.resolve('id' in args.where ? storedRow() : null),
        ),
        create: jest.fn().mockResolvedValue(storedRow()),
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
      notifyAdminsBankTransactionCreated: jest.fn(),
      notifyAdminsBankTransactionUpdated: jest.fn(),
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
        PaymentAccountEvents,
      ],
    }).compile();
    // Runs onModuleInit, which subscribes to payment-account changes.
    await module.init();

    service = module.get(BankEventsService);
    accountEvents = module.get(PaymentAccountEvents);
  });

  describe('processBatch — permanent rejections happen before any transaction', () => {
    it.each([
      ['UNSUPPORTED_CURRENCY', { currency: 'USD' }],
      ['LAST6_MISMATCH', { txCodeLast6: 'AB12CE' }],
    ])('rejects %s and stores nothing', async (reason, overrides) => {
      const { results } = await service.processBatch({
        events: [event(overrides)],
      });
      expect(results).toEqual([
        { idempotencyKey: KEY, outcome: 'rejected', reason },
      ]);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.bankTransaction.create).not.toHaveBeenCalled();
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

    it('forgets the cached account the moment an admin changes a payment account (bam-16)', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValueOnce({
        isActive: true,
      });
      await service.processBatch({ events: [event()] });
      expect(prisma.paymentAccount.findUnique).toHaveBeenCalledTimes(1);

      // Deactivated and saved: PaymentAccountsService emits the change.
      prisma.paymentAccount.findUnique.mockResolvedValueOnce({
        isActive: false,
      });
      accountEvents.emitChanged();

      const { results } = await service.processBatch({
        events: [event({ idempotencyKey: 'f'.repeat(64) })],
      });
      expect(prisma.paymentAccount.findUnique).toHaveBeenCalledTimes(2);
      expect(results[0].reason).toBe('INACTIVE_PAYMENT_ACCOUNT');
    });

    it('does not cache a lookup that was in flight when a payment account changed', async () => {
      let finishRead!: (value: { isActive: boolean }) => void;
      prisma.paymentAccount.findUnique.mockImplementationOnce(
        () =>
          new Promise<{ isActive: boolean }>((resolve) => {
            finishRead = resolve;
          }),
      );
      const first = service.processBatch({ events: [event()] });
      while (prisma.paymentAccount.findUnique.mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // The admin deactivates the account while that read is still running.
      accountEvents.emitChanged();
      finishRead({ isActive: true });
      await first;

      prisma.paymentAccount.findUnique.mockResolvedValueOnce({
        isActive: false,
      });
      const { results } = await service.processBatch({
        events: [event({ idempotencyKey: 'e'.repeat(64) })],
      });
      expect(prisma.paymentAccount.findUnique).toHaveBeenCalledTimes(2);
      expect(results[0].reason).toBe('INACTIVE_PAYMENT_ACCOUNT');
    });

    it('caches the account lookup so a batch from one phone costs one query', async () => {
      await service.processBatch({
        events: [event(), event({ idempotencyKey: 'e'.repeat(64) })],
      });
      expect(prisma.paymentAccount.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('processBatch — store first, then match, one transaction per event', () => {
    it('stores an unseen event (audited as a system row, new keys included) and answers stored_unmatched with its transactionId when nothing claims it', async () => {
      const { results } = await service.processBatch({
        events: [
          event({
            postedAt: '2026-09-18T09:00:05.000Z',
            counterparty: 'Ko Ko',
            detailStatus: 'ok',
          }),
        ],
      });

      expect(prisma.bankTransaction.create).toHaveBeenCalledWith({
        data: {
          idempotencyKey: KEY,
          deviceSerial: 'PIXEL10',
          paymentAccountId: ACCOUNT,
          direction: 'RECEIVED',
          amount: new Prisma.Decimal(50000),
          currency: 'MMK',
          txCode: 'KBZ20260918AB12CD',
          txCodeLast6: 'AB12CD',
          occurredAt: new Date('2026-09-18T09:00:00.000Z'),
          postedAt: new Date('2026-09-18T09:00:05.000Z'),
          counterparty: 'Ko Ko',
          detailStatus: 'ok',
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_transaction.store',
          actor: null,
          target: expect.objectContaining({
            type: 'bank_transaction',
            id: 'tx-1',
          }),
          metadata: {
            source: 'phone-monitor',
            idempotencyKey: KEY,
            deviceSerial: 'PIXEL10',
            paymentAccountId: ACCOUNT,
            direction: 'received',
          },
          tx: prisma,
        }),
      );
      expect(results).toEqual([
        {
          idempotencyKey: KEY,
          outcome: 'stored_unmatched',
          transactionId: 'tx-1',
          state: 'UNMATCHED',
          reason: 'NO_OPEN_CANDIDATE',
          screenshotWanted: true,
        },
      ]);
      expect(gateway.notifyAdminsBankTransactionCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'tx-1',
          state: 'UNMATCHED',
          view: 'WAITING',
          hasScreenshot: false,
        }),
      );
      expect(gateway.notifyAdminsBankTransactionUpdated).not.toHaveBeenCalled();
    });

    it('defaults postedAt to occurredAt for a phone-monitor that does not send it', async () => {
      await service.processBatch({ events: [event()] });
      expect(prisma.bankTransaction.create.mock.calls[0][0].data).toMatchObject(
        {
          postedAt: new Date('2026-09-18T09:00:00.000Z'),
          counterparty: null,
          detailStatus: null,
        },
      );
    });

    it('a re-post of a MATCHED key answers already_stored with its link and re-runs nothing', async () => {
      prisma.bankTransaction.findUnique.mockResolvedValue(
        storedRow({ state: 'MATCHED', linkedDepositId: 'dep-1' }),
      );
      prisma.deposit.findUnique.mockResolvedValue({ matchStatus: 'MATCHED' });

      const { results } = await service.processBatch({ events: [event()] });

      expect(results[0]).toEqual({
        idempotencyKey: KEY,
        outcome: 'already_stored',
        transactionId: 'tx-1',
        state: 'MATCHED',
        depositId: 'dep-1',
        matchStatus: 'MATCHED',
        screenshotWanted: true,
      });
      expect(prisma.bankTransaction.create).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsBankTransactionCreated).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsBankTransactionUpdated).not.toHaveBeenCalled();
    });

    it('a re-post of a stored UNMATCHED key is not stored twice but IS re-matched (the Resend button)', async () => {
      prisma.bankTransaction.findUnique.mockResolvedValue(storedRow());

      const { results } = await service.processBatch({ events: [event()] });

      expect(prisma.bankTransaction.create).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(results[0]).toMatchObject({
        outcome: 'stored_unmatched',
        transactionId: 'tx-1',
      });
      // Nothing changed → no push at all.
      expect(gateway.notifyAdminsBankTransactionCreated).not.toHaveBeenCalled();
    });

    it('runs every event in its own transaction, in order, answers `error` for the one that threw (rolled back — the phone retries) and keeps its neighbours', async () => {
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
        'stored_unmatched',
        'error',
        'stored_unmatched',
      ]);
      expect(results[1]).toEqual({
        idempotencyKey: 'e'.repeat(64),
        outcome: 'error',
        reason: 'INTERNAL_ERROR',
      });
    });

    it('stores, claims the open deposit by last-6, links both ways, and pushes the deposit + the transaction only after the transaction', async () => {
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
        bankTransaction: { id: 'tx-1' },
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
      prisma.bankTransaction.findUnique.mockImplementation(
        (args: { where: Record<string, unknown> }) =>
          Promise.resolve(
            'id' in args.where
              ? storedRow({
                  state: 'MATCHED',
                  linkedDepositId: 'dep-1',
                  matchedAt: new Date(),
                })
              : null,
          ),
      );

      const { results } = await service.processBatch({ events: [event()] });

      expect(results[0]).toMatchObject({
        outcome: 'matched',
        transactionId: 'tx-1',
        state: 'MATCHED',
        depositId: 'dep-1',
        screenshotWanted: true,
      });
      expect(prisma.bankTransaction.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: 'MATCHED',
            linkedDepositId: 'dep-1',
          }),
        }),
      );
      expect(
        gateway.notifyAdminsDepositVerificationUpdated,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'dep-1',
          matchStatus: 'MATCHED',
          hasBankScreenshot: false,
          receivingTransactionCode: 'AB12CD',
          bankTransactionId: 'tx-1',
        }),
      );
      expect(gateway.notifyAdminsBankTransactionCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'tx-1',
          state: 'MATCHED',
          view: 'MATCHED',
          linkedDepositId: 'dep-1',
        }),
      );
    });

    it('routes a "sent" event through the withdrawal matcher after storing it as SENT', async () => {
      prisma.bankTransaction.create.mockResolvedValue(
        storedRow({ direction: 'SENT' }),
      );
      const { results } = await service.processBatch({
        events: [event({ direction: 'sent' })],
      });
      expect(prisma.bankTransaction.create.mock.calls[0][0].data).toMatchObject(
        { direction: 'SENT' },
      );
      expect(prisma.withdrawal.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { transferEventKey: KEY } }),
      );
      expect(results[0].outcome).toBe('stored_unmatched');
    });
  });

  describe('attachTransactionScreenshot', () => {
    const dto = { idempotencyKey: KEY, deviceSerial: 'PIXEL10' };
    const file = (buffer: Buffer) =>
      ({ buffer }) as unknown as Express.Multer.File;
    const objectKey = `documents/bank-screenshots/transactions/tx-1/${KEY}.png`;

    it('requires a PNG (sniffed by signature), not just any bytes', async () => {
      await expect(
        service.attachTransactionScreenshot(
          'tx-1',
          dto,
          file(Buffer.from('GIF89a…')),
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.attachTransactionScreenshot('tx-1', dto, undefined),
      ).rejects.toThrow(BadRequestException);
      expect(minio.uploadBuffer).not.toHaveBeenCalled();
    });

    it('404s an unknown row and 409s a key that is not the row’s own', async () => {
      prisma.bankTransaction.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.attachTransactionScreenshot('tx-x', dto, file(PNG)),
      ).rejects.toThrow(NotFoundException);

      prisma.bankTransaction.findUnique.mockResolvedValueOnce(
        storedRow({ idempotencyKey: 'z'.repeat(64) }),
      );
      await expect(
        service.attachTransactionScreenshot('tx-1', dto, file(PNG)),
      ).rejects.toThrow(ConflictException);
      expect(minio.uploadBuffer).not.toHaveBeenCalled();
    });

    it('is retry-safe: a row that already has a screenshot uploads nothing', async () => {
      prisma.bankTransaction.findUnique.mockResolvedValue(
        storedRow({ screenshotKey: objectKey }),
      );
      await expect(
        service.attachTransactionScreenshot('tx-1', dto, file(PNG)),
      ).resolves.toEqual({ uploaded: false, alreadyUploaded: true });
      expect(minio.uploadBuffer).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('uploads to the transaction’s private key, sets the column with a guard, audits, and pushes the row — no deposit touched while unlinked', async () => {
      prisma.bankTransaction.findUnique
        .mockResolvedValueOnce(storedRow())
        .mockResolvedValueOnce(storedRow({ screenshotKey: objectKey }));

      await expect(
        service.attachTransactionScreenshot('tx-1', dto, file(PNG)),
      ).resolves.toEqual({ uploaded: true });

      expect(minio.uploadBuffer).toHaveBeenCalledWith(objectKey, PNG);
      expect(prisma.bankTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: 'tx-1', screenshotKey: null },
        data: { screenshotKey: objectKey },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_transaction.screenshot_attach',
          actor: null,
          metadata: expect.objectContaining({
            source: 'phone-monitor',
            idempotencyKey: KEY,
            deviceSerial: 'PIXEL10',
            bytes: PNG.length,
            bankTransactionId: 'tx-1',
          }),
          tx: prisma,
        }),
      );
      expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsBankTransactionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-1', hasScreenshot: true }),
      );
    });

    it('propagates the SAME key onto the linked deposit (guarded, audited) and pushes the deposit too', async () => {
      prisma.bankTransaction.findUnique
        .mockResolvedValueOnce(
          storedRow({ state: 'MATCHED', linkedDepositId: 'dep-1' }),
        )
        .mockResolvedValueOnce(
          storedRow({
            state: 'MATCHED',
            linkedDepositId: 'dep-1',
            screenshotKey: objectKey,
          }),
        );
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
          receivingScreenshotKey: objectKey,
          bankTransaction: { id: 'tx-1' },
        },
      ]);

      await expect(
        service.attachTransactionScreenshot('tx-1', dto, file(PNG)),
      ).resolves.toEqual({ uploaded: true });

      expect(prisma.deposit.updateMany).toHaveBeenCalledWith({
        where: { id: 'dep-1', receivingScreenshotKey: null },
        data: { receivingScreenshotKey: objectKey },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deposit.bank_screenshot_attach',
          target: { type: 'deposit', id: 'dep-1' },
        }),
      );
      expect(
        gateway.notifyAdminsDepositVerificationUpdated,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'dep-1', hasBankScreenshot: true }),
      );
    });

    it('mirrors onto a linked withdrawal with the transfer* column', async () => {
      prisma.bankTransaction.findUnique
        .mockResolvedValueOnce(
          storedRow({
            direction: 'SENT',
            state: 'MATCHED',
            linkedWithdrawalId: 'wd-1',
          }),
        )
        .mockResolvedValueOnce(storedRow({ screenshotKey: objectKey }));
      await expect(
        service.attachTransactionScreenshot('tx-1', dto, file(PNG)),
      ).resolves.toEqual({ uploaded: true });
      expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
        where: { id: 'wd-1', transferScreenshotKey: null },
        data: { transferScreenshotKey: objectKey },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'withdrawal.bank_screenshot_attach',
        }),
      );
    });
  });

  describe('attachScreenshot — the legacy per-row routes (rollout window)', () => {
    const dto = { idempotencyKey: KEY, deviceSerial: 'PIXEL10' };
    const file = (buffer: Buffer) =>
      ({ buffer }) as unknown as Express.Multer.File;

    it('delegates to the transactions path when the key names a stored transaction — one object, both pointers', async () => {
      prisma.bankTransaction.findUnique
        .mockResolvedValueOnce({ id: 'tx-1' })
        .mockResolvedValueOnce(
          storedRow({ state: 'MATCHED', linkedDepositId: 'dep-1' }),
        )
        .mockResolvedValueOnce(storedRow({ screenshotKey: 'x' }));

      await expect(
        service.attachScreenshot('deposits', 'dep-1', dto, file(PNG)),
      ).resolves.toEqual({ uploaded: true });

      expect(minio.uploadBuffer).toHaveBeenCalledWith(
        `documents/bank-screenshots/transactions/tx-1/${KEY}.png`,
        PNG,
      );
      expect(prisma.deposit.findUnique).not.toHaveBeenCalled();
    });

    it('falls back to the pre-bank_transactions behaviour for a key with no stored row: 404 / 409 / per-row key', async () => {
      prisma.bankTransaction.findUnique.mockResolvedValue(null);

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
          bankTransaction: null,
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
        expect.objectContaining({ action: 'deposit.bank_screenshot_attach' }),
      );
      expect(
        gateway.notifyAdminsDepositVerificationUpdated,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'dep-1',
          hasBankScreenshot: true,
          bankTransactionId: null,
        }),
      );
    });

    it('legacy withdrawals route mirrors with the transfer* columns', async () => {
      prisma.bankTransaction.findUnique.mockResolvedValue(null);
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
