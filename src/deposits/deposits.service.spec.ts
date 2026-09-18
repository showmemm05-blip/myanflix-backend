import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  DepositStatus,
  NotificationType,
  TransactionType,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FinanceSettingsService } from '../finance-settings/finance-settings.service';
import { PaymentAccountLedgerService } from '../payment-accounts/payment-account-ledger.service';
import { AuditService } from '../audit/audit.service';
import { MinioService } from '../common/storage/minio.service';
import { DepositsService } from './deposits.service';

function makeDeposit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'deposit-1',
    userId: 'user-1',
    amount: new Prisma.Decimal(5000),
    paymentMethod: 'KBZ Pay',
    reference: '000123',
    status: DepositStatus.PENDING,
    rejectionReason: null,
    approvedByUserId: null,
    approvedAt: null,
    // The bank side, as a fresh row has it (bank_verification migration).
    receivingAmount: null,
    receivingTransactionAt: null,
    receivingScreenshotKey: null,
    receivingEventKey: null,
    bankCheckedAt: null,
    matchStatus: 'UNVERIFIED',
    riskLevel: null,
    riskReasons: [],
    declaredTransferAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** What Prisma throws when an insert trips deposits_reference_active_key. */
function makeP2002() {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`reference`)',
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['reference'] },
    },
  );
}

describe('DepositsService', () => {
  let service: DepositsService;
  let prisma: {
    deposit: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    wallet: { findUniqueOrThrow: jest.Mock };
    transaction: { create: jest.Mock };
    notification: { create: jest.Mock };
    user: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    paymentAccount: { findUnique: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let minio: { deleteObject: jest.Mock; getObjectStream: jest.Mock };
  let walletService: { creditWithinTransaction: jest.Mock };
  let gateway: {
    notifyAdminsDepositCreated: jest.Mock;
    notifyUserDepositUpdated: jest.Mock;
    notifyUserNotificationCreated: jest.Mock;
    notifyUserBalanceUpdated: jest.Mock;
    notifyAdminsPaymentAccountUpdated: jest.Mock;
    notifyAdminsDepositVerificationUpdated: jest.Mock;
    notifyBankMonitorsNudge: jest.Mock;
  };
  let financeSettingsService: { getLimits: jest.Mock };
  let paymentAccountLedgerService: { syncDepositLink: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      deposit: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      wallet: { findUniqueOrThrow: jest.fn() },
      transaction: { create: jest.fn() },
      notification: { create: jest.fn() },
      user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      paymentAccount: { findUnique: jest.fn() },
      // Both call styles are in use: the callback form for the write paths —
      // where `tx` is just `prisma` itself, since every mocked method lives
      // directly on this object (mirrors how the real PrismaService's tx
      // client exposes the same model delegates) — and the array form for
      // the list queries' findMany+count pair.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    // create()/approve()/createManual() run the reference-twin (Q4) and
    // velocity (Q5) lookups through findMany inside their transaction; a
    // row with no twins and no burst is the default every test starts from.
    prisma.deposit.findMany.mockResolvedValue([]);
    minio = {
      deleteObject: jest.fn().mockResolvedValue(undefined),
      getObjectStream: jest.fn(),
    };
    // The real creditWithinTransaction returns the POST-credit Wallet —
    // approve()/createManual() read .balance off it for the snapshot columns,
    // so a bare jest.fn() (resolving undefined) would crash them.
    walletService = {
      creditWithinTransaction: jest
        .fn()
        .mockResolvedValue({ balance: new Prisma.Decimal(10000) }),
    };
    gateway = {
      notifyAdminsDepositCreated: jest.fn(),
      notifyUserDepositUpdated: jest.fn(),
      notifyUserNotificationCreated: jest.fn(),
      notifyUserBalanceUpdated: jest.fn(),
      notifyAdminsPaymentAccountUpdated: jest.fn(),
      notifyAdminsDepositVerificationUpdated: jest.fn(),
      notifyBankMonitorsNudge: jest.fn(),
    };
    financeSettingsService = {
      getLimits: jest.fn().mockResolvedValue({
        minDepositAmount: 0,
        maxDepositAmount: Number.MAX_SAFE_INTEGER,
        minWithdrawalAmount: 0,
        maxWithdrawalAmount: Number.MAX_SAFE_INTEGER,
      }),
    };
    // Real linking/reversal behavior is covered by
    // payment-account-ledger.service.spec.ts — here it's a no-op so these
    // tests stay focused on DepositsService's own orchestration.
    paymentAccountLedgerService = {
      syncDepositLink: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepositsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: FinanceSettingsService, useValue: financeSettingsService },
        {
          provide: PaymentAccountLedgerService,
          useValue: paymentAccountLedgerService,
        },
        { provide: AuditService, useValue: audit },
        { provide: MinioService, useValue: minio },
      ],
    }).compile();

    service = module.get(DepositsService);
  });

  describe('create', () => {
    it('creates a PENDING deposit and never touches the wallet', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      const deposit = makeDeposit();
      prisma.deposit.create.mockResolvedValue(deposit);
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      const result = await service.create('user-1', {
        amount: 5000,
        paymentMethod: 'KBZ Pay',
        reference: '000123',
      });

      expect(result.status).toBe(DepositStatus.PENDING);
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.deposit.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          amount: 5000,
          paymentMethod: 'KBZ Pay',
          reference: '000123',
        },
      });
    });

    it('persists the selected payment account name and forwards it to the admin realtime notification', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockResolvedValue(
        makeDeposit({ accountName: 'MyanFlix Co., Ltd.' }),
      );
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      await service.create('user-1', {
        amount: 5000,
        paymentMethod: 'KBZPay',
        accountName: 'MyanFlix Co., Ltd.',
        reference: '000123',
      });

      expect(prisma.deposit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ accountName: 'MyanFlix Co., Ltd.' }),
      });
      expect(gateway.notifyAdminsDepositCreated).toHaveBeenCalledWith(
        expect.objectContaining({ accountName: 'MyanFlix Co., Ltd.' }),
      );
    });

    it('stores the reference as the exact string passed in, leading zeros intact', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockResolvedValue(
        makeDeposit({ reference: '000123' }),
      );
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      const result = await service.create('user-1', {
        amount: 5000,
        paymentMethod: 'KBZ Pay',
        reference: '000123',
      });

      expect(result.reference).toBe('000123');
    });

    it('rejects a reference already used by a PENDING or APPROVED deposit', async () => {
      prisma.deposit.findFirst.mockResolvedValue(
        makeDeposit({ status: DepositStatus.PENDING }),
      );

      await expect(
        service.create('user-1', {
          amount: 5000,
          paymentMethod: 'KBZ Pay',
          reference: '000123',
        }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.deposit.create).not.toHaveBeenCalled();
    });

    it('allows reusing a reference that only belongs to a REJECTED deposit', async () => {
      // findFirst is scoped to PENDING/APPROVED in the real query — a
      // REJECTED-only match means the where clause finds nothing.
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockResolvedValue(makeDeposit());
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      await expect(
        service.create('user-1', {
          amount: 5000,
          paymentMethod: 'KBZ Pay',
          reference: '000123',
        }),
      ).resolves.toBeDefined();
      expect(prisma.deposit.findFirst).toHaveBeenCalledWith({
        where: {
          reference: '000123',
          status: { in: [DepositStatus.PENDING, DepositStatus.APPROVED] },
        },
      });
    });

    it('maps a P2002 from deposit.create to ConflictException', async () => {
      // Concurrent race: the pre-check passed (nothing committed yet) but
      // the partial unique index rejected the insert — the loser gets the
      // same 409 a sequential duplicate gets, and nothing downstream runs.
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockRejectedValue(makeP2002());

      await expect(
        service.create('user-1', {
          amount: 5000,
          paymentMethod: 'KBZ Pay',
          reference: '000123',
        }),
      ).rejects.toThrow(
        new ConflictException(
          'A deposit with this transaction reference already exists',
        ),
      );
      expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsDepositCreated).not.toHaveBeenCalled();
    });

    it('rethrows a non-P2002 create failure untouched', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockRejectedValue(new Error('db down'));

      const attempt = service.create('user-1', {
        amount: 5000,
        paymentMethod: 'KBZ Pay',
        reference: '000123',
      });
      await expect(attempt).rejects.toThrow('db down');
      await expect(attempt).rejects.not.toBeInstanceOf(ConflictException);
      expect(gateway.notifyAdminsDepositCreated).not.toHaveBeenCalled();
    });

    it('notifies admins in real time after a successful create', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockResolvedValue(makeDeposit());
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      await service.create('user-1', {
        amount: 5000,
        paymentMethod: 'KBZ Pay',
        reference: '000123',
      });

      expect(gateway.notifyAdminsDepositCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'deposit-1',
          username: 'john',
          amount: 5000,
          status: DepositStatus.PENDING,
        }),
      );
    });

    it('carries the display name next to the raw username on the admin realtime event, so a phone signup is announced by the name they chose', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockResolvedValue(makeDeposit());
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        username: 'user_95950495369',
        displayName: 'Blake',
      });

      await service.create('user-1', {
        amount: 5000,
        paymentMethod: 'KBZ Pay',
        reference: '000123',
      });

      expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { username: true, displayName: true, phone: true, email: true },
      });
      expect(gateway.notifyAdminsDepositCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'user_95950495369',
          displayName: 'Blake',
        }),
      );
    });

    it('still emits the raw username with displayName null when the user never set a name', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockResolvedValue(makeDeposit());
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        username: 'john',
        displayName: null,
      });

      await service.create('user-1', {
        amount: 5000,
        paymentMethod: 'KBZ Pay',
        reference: '000123',
      });

      expect(gateway.notifyAdminsDepositCreated).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'john', displayName: null }),
      );
    });

    it('rejects an amount below the configured minimum deposit', async () => {
      financeSettingsService.getLimits.mockResolvedValue({
        minDepositAmount: 10000,
        maxDepositAmount: 5000000,
        minWithdrawalAmount: 0,
        maxWithdrawalAmount: Number.MAX_SAFE_INTEGER,
      });

      await expect(
        service.create('user-1', {
          amount: 5000,
          paymentMethod: 'KBZ Pay',
          reference: '000123',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.deposit.findFirst).not.toHaveBeenCalled();
      expect(prisma.deposit.create).not.toHaveBeenCalled();
    });

    it('rejects an amount above the configured maximum deposit', async () => {
      financeSettingsService.getLimits.mockResolvedValue({
        minDepositAmount: 1000,
        maxDepositAmount: 100000,
        minWithdrawalAmount: 0,
        maxWithdrawalAmount: Number.MAX_SAFE_INTEGER,
      });

      await expect(
        service.create('user-1', {
          amount: 200000,
          paymentMethod: 'KBZ Pay',
          reference: '000123',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.deposit.create).not.toHaveBeenCalled();
    });

    it('accepts an amount within the configured deposit range', async () => {
      financeSettingsService.getLimits.mockResolvedValue({
        minDepositAmount: 1000,
        maxDepositAmount: 100000,
        minWithdrawalAmount: 0,
        maxWithdrawalAmount: Number.MAX_SAFE_INTEGER,
      });
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockResolvedValue(
        makeDeposit({ amount: new Prisma.Decimal(5000) }),
      );
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      await expect(
        service.create('user-1', {
          amount: 5000,
          paymentMethod: 'KBZ Pay',
          reference: '000123',
        }),
      ).resolves.toBeDefined();
      expect(prisma.deposit.create).toHaveBeenCalled();
    });
  });

  describe('findAllAdmin', () => {
    beforeEach(() => {
      prisma.deposit.findMany.mockResolvedValue([]);
      prisma.deposit.count.mockResolvedValue(0);
    });

    it('filters findMany and count by the createdAt range (as real Dates) when dateFrom/dateTo are set', async () => {
      await service.findAllAdmin({
        dateFrom: '2026-08-13T17:30:00.000Z',
        dateTo: '2026-08-14T17:29:59.999Z',
      });

      const expectedWhere = {
        status: undefined,
        userId: undefined,
        createdAt: {
          gte: new Date('2026-08-13T17:30:00.000Z'),
          lte: new Date('2026-08-14T17:29:59.999Z'),
        },
      };
      expect(prisma.deposit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
      expect(prisma.deposit.count).toHaveBeenCalledWith({
        where: expectedWhere,
      });
    });

    it('leaves createdAt undefined when no date range is given, so existing queries are untouched', async () => {
      await service.findAllAdmin({});

      expect(prisma.deposit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: undefined, userId: undefined, createdAt: undefined },
        }),
      );
    });

    it('projects the depositing user with their display name next to the raw username, so the admin list can label the row by name', async () => {
      prisma.deposit.findMany.mockResolvedValue([
        makeDeposit({
          user: {
            id: 'user-1',
            username: 'user_95950495369',
            displayName: 'Blake',
            phone: '+959123456',
          },
        }),
      ]);
      prisma.deposit.count.mockResolvedValue(1);

      const result = await service.findAllAdmin({});

      expect(prisma.deposit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                phone: true,
                email: true,
              },
            },
          },
        }),
      );
      expect(result.items[0].user).toEqual({
        id: 'user-1',
        username: 'user_95950495369',
        displayName: 'Blake',
        phone: '+959123456',
      });
    });

    it('composes the status filter with the date range', async () => {
      await service.findAllAdmin({
        status: DepositStatus.PENDING,
        dateFrom: '2026-08-13T17:30:00.000Z',
        dateTo: '2026-08-14T17:29:59.999Z',
      });

      expect(prisma.deposit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: DepositStatus.PENDING,
            userId: undefined,
            createdAt: {
              gte: new Date('2026-08-13T17:30:00.000Z'),
              lte: new Date('2026-08-14T17:29:59.999Z'),
            },
          },
        }),
      );
    });
  });

  describe('findAllForUser', () => {
    beforeEach(() => {
      prisma.deposit.findMany.mockResolvedValue([]);
      prisma.deposit.count.mockResolvedValue(0);
    });

    it("applies the createdAt range on top of the caller's own userId scope", async () => {
      await service.findAllForUser('user-1', {
        dateFrom: '2026-08-13T17:30:00.000Z',
        dateTo: '2026-08-14T17:29:59.999Z',
      });

      expect(prisma.deposit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            status: undefined,
            createdAt: {
              gte: new Date('2026-08-13T17:30:00.000Z'),
              lte: new Date('2026-08-14T17:29:59.999Z'),
            },
          },
        }),
      );
    });

    it('leaves createdAt undefined when no date range is given', async () => {
      await service.findAllForUser('user-1', {});

      expect(prisma.deposit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', status: undefined, createdAt: undefined },
        }),
      );
    });
  });

  describe('approve', () => {
    const admin = { id: 'admin-1', username: 'admin', role: 'ADMIN' } as never;

    it('credits the wallet exactly once, creates a Transaction, and creates a Notification', async () => {
      const pending = makeDeposit();
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({
          status: DepositStatus.APPROVED,
          approvedByUserId: 'admin-1',
          approvedAt: new Date(),
        }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      const result = await service.approve('deposit-1', admin);

      expect(walletService.creditWithinTransaction).toHaveBeenCalledTimes(1);
      expect(walletService.creditWithinTransaction).toHaveBeenCalledWith(
        prisma,
        'user-1',
        5000,
      );
      expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(DepositStatus.APPROVED);
      expect(gateway.notifyUserDepositUpdated).toHaveBeenCalledTimes(1);
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith(
        'user-1',
        10000,
      );
    });

    it('persists wallet balance snapshots on the deposit row, derived from the post-credit wallet (before = after - amount)', async () => {
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit());
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(12500),
      });
      // Wallet held 7,500 before this 5,000 deposit credited it.
      walletService.creditWithinTransaction.mockResolvedValue({
        balance: new Prisma.Decimal(12500),
      });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      await service.approve('deposit-1', admin);

      expect(prisma.deposit.update).toHaveBeenCalledWith({
        where: { id: 'deposit-1' },
        data: {
          walletBalanceBefore: new Prisma.Decimal(7500),
          walletBalanceAfter: new Prisma.Decimal(12500),
        },
      });
    });

    it('includes the depositing user on the response, so the admin table never shows "Unknown user" right after approving', async () => {
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit());
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({
          status: DepositStatus.APPROVED,
          user: { id: 'user-1', username: 'john', phone: '+959123456' },
        }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      const result = await service.approve('deposit-1', admin);

      expect(prisma.deposit.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                phone: true,
                email: true,
              },
            },
          },
        }),
      );
      expect(result.user).toEqual({
        id: 'user-1',
        username: 'john',
        phone: '+959123456',
      });
    });

    it('throws ConflictException and never credits the wallet when the deposit is no longer PENDING', async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED }),
      );
      // The atomic updateMany's WHERE clause (status: PENDING) matches 0
      // rows once the deposit has already moved past PENDING — this is the
      // core guard against a concurrent double-approval race.
      prisma.deposit.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approve('deposit-1', admin)).rejects.toThrow(
        ConflictException,
      );
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a nonexistent deposit', async () => {
      prisma.deposit.findUnique.mockResolvedValue(null);

      await expect(service.approve('missing', admin)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
    });

    it('credits the depositor-declared payment account automatically, without a separate admin step', async () => {
      const pending = makeDeposit({
        declaredPaymentAccountId: 'acct-1',
        receivingPaymentAccountId: null,
      });
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({
          status: DepositStatus.APPROVED,
          declaredPaymentAccountId: 'acct-1',
          receivingPaymentAccountId: 'acct-1',
        }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      await service.approve('deposit-1', admin);

      expect(paymentAccountLedgerService.syncDepositLink).toHaveBeenCalledWith(
        prisma,
        pending,
        'acct-1',
        pending.reference,
        'admin-1',
      );
    });

    it('still calls syncDepositLink (as a no-op) when the depositor never picked a catalog account', async () => {
      const pending = makeDeposit({
        declaredPaymentAccountId: null,
        receivingPaymentAccountId: null,
      });
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      await service.approve('deposit-1', admin);

      expect(paymentAccountLedgerService.syncDepositLink).toHaveBeenCalledWith(
        prisma,
        pending,
        null,
        pending.reference,
        'admin-1',
      );
    });

    it('lets the admin override the declared account by passing paymentAccountId at approval time', async () => {
      const pending = makeDeposit({
        declaredPaymentAccountId: 'acct-declared',
        receivingPaymentAccountId: null,
      });
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({
          status: DepositStatus.APPROVED,
          receivingPaymentAccountId: 'acct-override',
        }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      await service.approve('deposit-1', admin, {
        paymentAccountId: 'acct-override',
      });

      expect(paymentAccountLedgerService.syncDepositLink).toHaveBeenCalledWith(
        prisma,
        pending,
        'acct-override',
        pending.reference,
        'admin-1',
      );
    });

    it('lets the admin explicitly skip crediting any account, even when one was declared', async () => {
      const pending = makeDeposit({
        declaredPaymentAccountId: 'acct-declared',
        receivingPaymentAccountId: null,
      });
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      await service.approve('deposit-1', admin, { paymentAccountId: null });

      expect(paymentAccountLedgerService.syncDepositLink).toHaveBeenCalledWith(
        prisma,
        pending,
        null,
        pending.reference,
        'admin-1',
      );
    });
  });

  describe('reject', () => {
    const admin = { id: 'admin-1', username: 'admin', role: 'ADMIN' } as never;

    it('stores the rejection reason, creates a Notification, and never touches the wallet or ledger', async () => {
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit());
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({
          status: DepositStatus.REJECTED,
          rejectionReason: 'Reference does not match',
        }),
      );
      prisma.notification.create.mockResolvedValue({
        id: 'notif-2',
        type: 'DEPOSIT_REJECTED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      const result = await service.reject('deposit-1', admin, {
        reason: 'Reference does not match',
      });

      expect(result.status).toBe(DepositStatus.REJECTED);
      expect(result.rejectionReason).toBe('Reference does not match');
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it('throws ConflictException on double-rejection (or reject-after-approve)', async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({ status: DepositStatus.REJECTED }),
      );
      prisma.deposit.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reject('deposit-1', admin, { reason: 'x' }),
      ).rejects.toThrow(ConflictException);
    });

    it('includes the depositing user on the response, so the admin table never shows "Unknown user" right after rejecting', async () => {
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit());
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({
          status: DepositStatus.REJECTED,
          user: { id: 'user-1', username: 'john', phone: '+959123456' },
        }),
      );
      prisma.notification.create.mockResolvedValue({
        id: 'notif-2',
        type: 'DEPOSIT_REJECTED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      const result = await service.reject('deposit-1', admin, { reason: 'x' });

      expect(prisma.deposit.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                phone: true,
                email: true,
              },
            },
          },
        }),
      );
      expect(result.user).toEqual({
        id: 'user-1',
        username: 'john',
        phone: '+959123456',
      });
    });
  });

  describe('updateReceivingAccount', () => {
    const admin = { id: 'admin-1', username: 'admin', role: 'ADMIN' } as never;

    it('throws NotFoundException for an unknown deposit, without writing anything', async () => {
      prisma.deposit.findUnique.mockResolvedValue(null);

      await expect(
        service.updateReceivingAccount(
          'nope',
          {
            receivingAccountType: 'KBZ Pay',
            receivingAccountName: 'MyanFlix',
            receivingAccountNumber: '09999999999',
            receivingTransactionCode: '123456',
            receivingTransactionTime: '06:56:28',
          },
          admin,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.deposit.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the deposit is not APPROVED', async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({ status: DepositStatus.PENDING }),
      );

      await expect(
        service.updateReceivingAccount(
          'deposit-1',
          {
            receivingAccountType: 'KBZ Pay',
            receivingAccountName: 'MyanFlix',
            receivingAccountNumber: '09999999999',
            receivingTransactionCode: '123456',
            receivingTransactionTime: '06:56:28',
          },
          admin,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.deposit.update).not.toHaveBeenCalled();
    });

    it("records our receiving account (incl. subname), transaction code, and transaction time without touching the user's own deposit info, status, wallet, or ledger", async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED }),
      );
      prisma.deposit.update.mockResolvedValue({
        ...makeDeposit({
          status: DepositStatus.APPROVED,
          receivingAccountType: 'KBZ Pay',
          receivingAccountSubname: 'K1',
          receivingAccountName: 'MyanFlix',
          receivingAccountNumber: '09999999999',
          receivingTransactionCode: '123456',
          receivingTransactionTime: '06:56:28',
        }),
        user: { id: 'user-1', username: 'john', phone: null },
      });

      const result = await service.updateReceivingAccount(
        'deposit-1',
        {
          receivingAccountType: 'KBZ Pay',
          receivingAccountSubname: 'K1',
          receivingAccountName: 'MyanFlix',
          receivingAccountNumber: '09999999999',
          receivingTransactionCode: '123456',
          receivingTransactionTime: '06:56:28',
        },
        admin,
      );

      expect(prisma.deposit.update).toHaveBeenCalledWith({
        where: { id: 'deposit-1' },
        data: {
          receivingAccountType: 'KBZ Pay',
          receivingAccountSubname: 'K1',
          receivingAccountName: 'MyanFlix',
          receivingAccountNumber: '09999999999',
          receivingTransactionCode: '123456',
          receivingTransactionTime: '06:56:28',
        },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              phone: true,
              email: true,
            },
          },
        },
      });
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
      expect(gateway.notifyUserDepositUpdated).toHaveBeenCalledWith('user-1', {
        id: 'deposit-1',
        status: DepositStatus.APPROVED,
        amount: 5000,
        paymentMethod: 'KBZ Pay',
        reference: '000123',
        approvedAt: null,
        receivingAccountType: 'KBZ Pay',
        receivingAccountSubname: 'K1',
        receivingAccountName: 'MyanFlix',
        receivingAccountNumber: '09999999999',
        receivingTransactionCode: '123456',
        receivingTransactionTime: '06:56:28',
      });
      // The user's own deposit info (what they submitted) is untouched.
      expect(result.paymentMethod).toBe('KBZ Pay');
      expect(result.receivingAccountName).toBe('MyanFlix');
      expect(result.receivingAccountSubname).toBe('K1');
      expect(result.receivingTransactionCode).toBe('123456');
      expect(result.status).toBe(DepositStatus.APPROVED);
    });

    it('nulls out subname on an explicit null (the manual-typing flow), leaving omitted fields out of the update entirely', async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED }),
      );
      prisma.deposit.update.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED }),
      );

      await service.updateReceivingAccount(
        'deposit-1',
        {
          receivingAccountType: 'KBZ Pay',
          // Typed manually — the client clears the stale catalog subname
          // explicitly (PATCH semantics: omitted fields stay untouched).
          receivingAccountSubname: null,
          receivingAccountName: 'MyanFlix',
          receivingAccountNumber: '09999999999',
          receivingTransactionCode: '123456',
          receivingTransactionTime: '06:56:28',
        },
        admin,
      );

      expect(prisma.deposit.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ receivingAccountSubname: null }),
        }),
      );
    });

    it('links a catalog account from a paymentAccountId-only payload, leaving every stored free-text field untouched', async () => {
      // The state every freshly approved deposit is in: FROM-record fields
      // empty, but a stored transaction code from an older flow must survive.
      const stored = makeDeposit({
        status: DepositStatus.APPROVED,
        receivingPaymentAccountId: null,
        receivingTransactionCode: 'ABC123',
      });
      prisma.deposit.findUnique.mockResolvedValue(stored);
      prisma.deposit.update.mockResolvedValue({
        ...stored,
        user: { id: 'user-1', username: 'john', phone: null },
      });

      await service.updateReceivingAccount(
        'deposit-1',
        { paymentAccountId: 'acct-9' },
        admin,
      );

      // The ledger link is posted with the STORED reference, and the update
      // writes no free-text keys at all.
      expect(paymentAccountLedgerService.syncDepositLink).toHaveBeenCalledWith(
        prisma,
        stored,
        'acct-9',
        'ABC123',
        'admin-1',
      );
      expect(prisma.deposit.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: {} }),
      );
    });

    it('keeps the stored catalog link when the payload omits paymentAccountId entirely', async () => {
      const stored = makeDeposit({
        status: DepositStatus.APPROVED,
        receivingPaymentAccountId: 'acct-1',
        receivingTransactionCode: null,
      });
      prisma.deposit.findUnique.mockResolvedValue(stored);
      prisma.deposit.update.mockResolvedValue({
        ...stored,
        user: { id: 'user-1', username: 'john', phone: null },
      });

      await service.updateReceivingAccount(
        'deposit-1',
        {
          receivingAccountType: 'KBZ Pay',
          receivingAccountSubname: null,
          receivingAccountName: 'MyanFlix',
          receivingAccountNumber: '09999999999',
          receivingTransactionTime: '06:56:28',
        },
        admin,
      );

      // syncDepositLink sees the SAME account id it already had — a no-op
      // re-link — so editing the free-text record can never unlink/reverse.
      expect(paymentAccountLedgerService.syncDepositLink).toHaveBeenCalledWith(
        prisma,
        stored,
        'acct-1',
        null,
        'admin-1',
      );
      // And the stored transaction code was not clobbered by omission.
      expect(prisma.deposit.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({
            receivingTransactionCode: expect.anything(),
          }),
        }),
      );
    });
  });

  describe('createManual', () => {
    const admin = { id: 'admin-1', username: 'admin', role: 'ADMIN' } as never;

    const dto = {
      userId: 'user-1',
      amount: 5000,
      paymentMethod: 'KBZ Pay',
      reference: '000123',
      destinationPaymentAccountId: 'acct-dest',
    };

    beforeEach(() => {
      // The two pre-create guards pass by default; individual tests override.
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.paymentAccount.findUnique.mockResolvedValue({ id: 'acct-dest' });
    });

    it('rejects a reference already used by a PENDING or APPROVED deposit, writing nothing', async () => {
      // The exact double-credit scenario: the user already submitted this
      // transfer through the app, and an admin records it manually too.
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.deposit.findFirst.mockResolvedValue(
        makeDeposit({ status: DepositStatus.PENDING }),
      );

      await expect(service.createManual(dto, admin)).rejects.toThrow(
        ConflictException,
      );

      expect(prisma.deposit.create).not.toHaveBeenCalled();
      expect(
        paymentAccountLedgerService.syncDepositLink,
      ).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('rejects an unknown destination account with NotFound, writing nothing', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.paymentAccount.findUnique.mockResolvedValue(null);

      await expect(service.createManual(dto, admin)).rejects.toThrow(
        NotFoundException,
      );

      expect(prisma.deposit.create).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
    });

    it('maps a P2002 from tx.deposit.create to ConflictException and moves no money', async () => {
      // Both pre-create guards pass (the race: nothing committed yet when
      // the pre-check ran), then the partial unique index rejects the
      // insert. The transaction is rolled back before the ledger credit,
      // wallet credit, Transaction row, notification and audit row.
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.deposit.create.mockRejectedValue(makeP2002());

      await expect(service.createManual(dto, admin)).rejects.toThrow(
        new ConflictException(
          'A deposit with this transaction reference already exists',
        ),
      );

      expect(
        paymentAccountLedgerService.syncDepositLink,
      ).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsPaymentAccountUpdated).not.toHaveBeenCalled();
      expect(gateway.notifyUserDepositUpdated).not.toHaveBeenCalled();
      expect(gateway.notifyUserNotificationCreated).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('rethrows a non-P2002 transaction failure untouched', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.deposit.create.mockRejectedValue(new Error('db down'));

      const attempt = service.createManual(dto, admin);
      await expect(attempt).rejects.toThrow('db down');
      await expect(attempt).rejects.not.toBeInstanceOf(ConflictException);
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('creates the deposit directly APPROVED, credits the destination ledger and wallet, and records Transaction + Notification', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      const created = makeDeposit({
        status: DepositStatus.APPROVED,
        approvedByUserId: 'admin-1',
        approvedAt: new Date(),
        accountName: 'John Doe',
        receivingTransactionCode: 'ABC123',
        receivingTransactionTime: '06:56:28',
      });
      prisma.deposit.create.mockResolvedValue(created);
      prisma.deposit.findUniqueOrThrow.mockResolvedValue({
        ...created,
        user: { id: 'user-1', username: 'john', phone: '+959123456' },
      });
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      const result = await service.createManual(
        {
          ...dto,
          accountName: 'John Doe',
          receivingTransactionCode: 'ABC123',
          receivingTransactionTime: '06:56:28',
        },
        admin,
      );

      expect(prisma.deposit.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          amount: 5000,
          paymentMethod: 'KBZ Pay',
          accountName: 'John Doe',
          reference: '000123',
          status: DepositStatus.APPROVED,
          approvedByUserId: 'admin-1',
          approvedAt: expect.any(Date),
          receivingTransactionCode: 'ABC123',
          receivingTransactionTime: '06:56:28',
        },
      });
      // The transaction code, when present, is the ledger reference.
      expect(paymentAccountLedgerService.syncDepositLink).toHaveBeenCalledWith(
        prisma,
        created,
        'acct-dest',
        'ABC123',
        'admin-1',
      );
      expect(walletService.creditWithinTransaction).toHaveBeenCalledTimes(1);
      expect(walletService.creditWithinTransaction).toHaveBeenCalledWith(
        prisma,
        'user-1',
        5000,
      );
      expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          type: TransactionType.DEPOSIT,
          amount: created.amount,
          status: 'COMPLETED',
        },
      });
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      // Same notification type + message template approve() uses — the user
      // can't tell a manual deposit apart from an approved submission.
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          type: NotificationType.DEPOSIT_APPROVED,
          title: 'Deposit approved',
          message:
            'Your deposit of 5000 Ks has been approved and your balance has been updated.',
        }),
      });
      expect(result.status).toBe(DepositStatus.APPROVED);
      expect(result.approvedByUserId).toBe('admin-1');
      expect(result.user).toEqual({
        id: 'user-1',
        username: 'john',
        phone: '+959123456',
      });
    });

    it('persists wallet balance snapshots on the created deposit row, derived from the post-credit wallet (before = after - amount)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      const created = makeDeposit({
        status: DepositStatus.APPROVED,
        approvedByUserId: 'admin-1',
        approvedAt: new Date(),
      });
      prisma.deposit.create.mockResolvedValue(created);
      prisma.deposit.findUniqueOrThrow.mockResolvedValue({
        ...created,
        user: { id: 'user-1', username: 'john', phone: null },
      });
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(5000),
      });
      // First credit into an empty wallet: 0 → 5,000.
      walletService.creditWithinTransaction.mockResolvedValue({
        balance: new Prisma.Decimal(5000),
      });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      await service.createManual(dto, admin);

      expect(prisma.deposit.update).toHaveBeenCalledWith({
        where: { id: 'deposit-1' },
        data: {
          walletBalanceBefore: new Prisma.Decimal(0),
          walletBalanceAfter: new Prisma.Decimal(5000),
        },
      });
    });

    it('emits the same post-commit realtime events approve() does, including the destination-account update', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      const approvedAt = new Date();
      const created = makeDeposit({
        status: DepositStatus.APPROVED,
        approvedByUserId: 'admin-1',
        approvedAt,
      });
      prisma.deposit.create.mockResolvedValue(created);
      prisma.deposit.findUniqueOrThrow.mockResolvedValue({
        ...created,
        user: { id: 'user-1', username: 'john', phone: null },
      });
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      const notification = {
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 'Deposit approved',
        message: 'm',
        payload: { depositId: 'deposit-1', amount: 5000 },
        isRead: false,
        createdAt: new Date(),
      };
      prisma.notification.create.mockResolvedValue(notification);

      await service.createManual(dto, admin);

      expect(gateway.notifyAdminsPaymentAccountUpdated).toHaveBeenCalledWith({
        paymentAccountId: 'acct-dest',
      });
      expect(gateway.notifyUserDepositUpdated).toHaveBeenCalledWith('user-1', {
        id: 'deposit-1',
        status: DepositStatus.APPROVED,
        amount: 5000,
        paymentMethod: 'KBZ Pay',
        reference: '000123',
        approvedAt,
      });
      expect(gateway.notifyUserNotificationCreated).toHaveBeenCalledWith(
        'user-1',
        {
          id: notification.id,
          type: notification.type,
          title: notification.title,
          message: notification.message,
          payload: notification.payload,
          isRead: notification.isRead,
          createdAt: notification.createdAt,
        },
      );
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith(
        'user-1',
        10000,
      );
    });

    it('falls back to the reference as the ledger reference when no transaction code was given, and stores null optionals', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      const created = makeDeposit({
        status: DepositStatus.APPROVED,
        approvedByUserId: 'admin-1',
        approvedAt: new Date(),
      });
      prisma.deposit.create.mockResolvedValue(created);
      prisma.deposit.findUniqueOrThrow.mockResolvedValue({
        ...created,
        user: { id: 'user-1', username: 'john', phone: null },
      });
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      await service.createManual(dto, admin);

      expect(paymentAccountLedgerService.syncDepositLink).toHaveBeenCalledWith(
        prisma,
        created,
        'acct-dest',
        '000123',
        'admin-1',
      );
      // The FROM record stays empty for the existing table cell to fill later.
      expect(prisma.deposit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountName: null,
          receivingTransactionCode: null,
          receivingTransactionTime: null,
        }),
      });
    });

    it('throws NotFoundException for an unknown user without creating or crediting anything', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.createManual(dto, admin)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.deposit.create).not.toHaveBeenCalled();
      expect(
        paymentAccountLedgerService.syncDepositLink,
      ).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('propagates a ledger NotFound (bogus destination account) before any wallet credit, and emits nothing', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.deposit.create.mockResolvedValue(
        makeDeposit({
          status: DepositStatus.APPROVED,
          approvedByUserId: 'admin-1',
          approvedAt: new Date(),
        }),
      );
      paymentAccountLedgerService.syncDepositLink.mockRejectedValue(
        new NotFoundException('Payment account not found'),
      );

      await expect(service.createManual(dto, admin)).rejects.toThrow(
        NotFoundException,
      );
      // syncDepositLink runs BEFORE the wallet credit — the whole $transaction
      // rolls back and no money ever moved.
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsPaymentAccountUpdated).not.toHaveBeenCalled();
      expect(gateway.notifyUserDepositUpdated).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });
  });
});

/**
 * Bank transfer verification (bank_verification migration): the create-time
 * risk flags, the phone-monitor nudge, the five admin filters, the
 * user-safe vs staff response split, the staff review actions and the
 * screenshot stream. Same Prisma-mock style as the suite above.
 */
describe('DepositsService — bank verification', () => {
  let service: DepositsService;
  let prisma: {
    deposit: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    wallet: { findUniqueOrThrow: jest.Mock };
    transaction: { create: jest.Mock };
    notification: { create: jest.Mock };
    user: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    paymentAccount: { findUnique: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let gateway: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let minio: { deleteObject: jest.Mock; getObjectStream: jest.Mock };
  const admin = { id: 'admin-1', username: 'admin', role: 'ADMIN' } as never;
  const HOURS = 3_600_000;

  beforeEach(async () => {
    prisma = {
      deposit: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      wallet: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          balance: new Prisma.Decimal(10000),
        }),
      },
      transaction: { create: jest.fn() },
      notification: {
        create: jest.fn().mockResolvedValue({
          id: 'notif-1',
          type: 'DEPOSIT_APPROVED',
          title: 't',
          message: 'm',
          payload: {},
          isRead: false,
          createdAt: new Date(),
        }),
      },
      user: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ username: 'john' }),
      },
      paymentAccount: { findUnique: jest.fn() },
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    gateway = {
      notifyAdminsDepositCreated: jest.fn(),
      notifyUserDepositUpdated: jest.fn(),
      notifyUserNotificationCreated: jest.fn(),
      notifyUserBalanceUpdated: jest.fn(),
      notifyAdminsPaymentAccountUpdated: jest.fn(),
      notifyAdminsDepositVerificationUpdated: jest.fn(),
      notifyBankMonitorsNudge: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    minio = {
      deleteObject: jest.fn().mockResolvedValue(undefined),
      getObjectStream: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepositsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: WalletService,
          useValue: {
            creditWithinTransaction: jest
              .fn()
              .mockResolvedValue({ balance: new Prisma.Decimal(10000) }),
          },
        },
        { provide: RealtimeGateway, useValue: gateway },
        {
          provide: FinanceSettingsService,
          useValue: {
            getLimits: jest.fn().mockResolvedValue({
              minDepositAmount: 0,
              maxDepositAmount: Number.MAX_SAFE_INTEGER,
            }),
          },
        },
        {
          provide: PaymentAccountLedgerService,
          useValue: { syncDepositLink: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: AuditService, useValue: audit },
        { provide: MinioService, useValue: minio },
      ],
    }).compile();
    service = module.get(DepositsService);
  });

  /** Q4 answers `twins`, Q5 answers `recent` rows, the push fetch answers `pushed`. */
  function mockLookups(twins: unknown[], recent = 1, pushed: unknown[] = []) {
    prisma.deposit.findMany.mockImplementation(
      (args: {
        where: { reference?: string; userId?: string; id?: unknown };
      }) =>
        Promise.resolve(
          args.where.reference !== undefined
            ? twins
            : args.where.userId !== undefined
              ? Array.from({ length: recent }, (_, i) => ({ id: `r${i}` }))
              : pushed,
        ),
    );
  }

  const dto = { amount: 5000, paymentMethod: 'KBZ Pay', reference: '000123' };

  describe('create — create-time rules and the nudge', () => {
    it('nudges the phone-monitor for the declared account and reports UNVERIFIED with no reasons on a clean row', async () => {
      prisma.deposit.create.mockResolvedValue(
        makeDeposit({ declaredPaymentAccountId: 'acct-1' }),
      );
      mockLookups([]);

      await service.create('user-1', { ...dto, paymentAccountId: 'acct-1' });

      expect(prisma.deposit.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(gateway.notifyBankMonitorsNudge).toHaveBeenCalledWith({
        kind: 'deposit',
        paymentAccountId: 'acct-1',
      });
      expect(gateway.notifyAdminsDepositCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          matchStatus: 'UNVERIFIED',
          riskLevel: null,
          riskReasons: [],
        }),
      );
    });

    it('flags the new row DUPLICATE_REFERENCE + SHARED_REFERENCE_ACROSS_USERS from a rejected twin of another user, and flags the twin back', async () => {
      prisma.deposit.create.mockResolvedValue(makeDeposit());
      mockLookups([
        {
          id: 'deposit-old',
          userId: 'user-2',
          amount: new Prisma.Decimal(5000),
          status: DepositStatus.REJECTED,
          bankCheckedAt: null,
          matchStatus: 'UNVERIFIED',
          riskLevel: null,
          riskReasons: [],
        },
      ]);

      await service.create('user-1', dto);

      // The new row (system audit row — the create itself is self-service).
      expect(prisma.deposit.update).toHaveBeenCalledWith({
        where: { id: 'deposit-1' },
        data: {
          matchStatus: 'SUSPICIOUS',
          riskLevel: 'HIGH',
          riskReasons: ['DUPLICATE_REFERENCE', 'SHARED_REFERENCE_ACROSS_USERS'],
        },
      });
      // The twin.
      expect(prisma.deposit.update).toHaveBeenCalledWith({
        where: { id: 'deposit-old' },
        data: {
          matchStatus: 'SUSPICIOUS',
          riskLevel: 'HIGH',
          riskReasons: ['DUPLICATE_REFERENCE', 'SHARED_REFERENCE_ACROSS_USERS'],
        },
      });
      expect(audit.record).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deposit.risk_update',
          actor: null,
          metadata: { trigger: 'deposit_create', anchorDepositId: 'deposit-1' },
          tx: prisma,
        }),
      );
      expect(gateway.notifyAdminsDepositCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          matchStatus: 'SUSPICIOUS',
          riskLevel: 'HIGH',
        }),
      );
    });

    it('flags VELOCITY (PENDING_REVIEW) at three rows by one user inside ten minutes', async () => {
      prisma.deposit.create.mockResolvedValue(makeDeposit());
      mockLookups([], 3);

      await service.create('user-1', dto);

      expect(prisma.deposit.update).toHaveBeenCalledWith({
        where: { id: 'deposit-1' },
        data: {
          matchStatus: 'PENDING_REVIEW',
          riskLevel: 'LOW',
          riskReasons: ['VELOCITY'],
        },
      });
    });

    it('never exposes the verification fields on the user-facing create response', async () => {
      prisma.deposit.create.mockResolvedValue(
        makeDeposit({ matchStatus: 'SUSPICIOUS', riskReasons: ['VELOCITY'] }),
      );
      mockLookups([]);

      const result = await service.create('user-1', dto);

      expect(result).not.toHaveProperty('matchStatus');
      expect(result).not.toHaveProperty('riskReasons');
      expect(result).not.toHaveProperty('riskLevel');
      expect(result).not.toHaveProperty('bankCheckedAt');
      expect(result).not.toHaveProperty('receivingScreenshotKey');
    });
  });

  describe('findAllForUser — the self-service shape', () => {
    it('strips every bank-verification column', async () => {
      prisma.deposit.findMany.mockResolvedValue([
        makeDeposit({
          matchStatus: 'SUSPICIOUS',
          riskLevel: 'HIGH',
          riskReasons: ['AMOUNT_MISMATCH'],
          receivingScreenshotKey:
            'documents/bank-screenshots/deposits/deposit-1/k.png',
          bankCheckedAt: new Date(),
        }),
      ]);
      const { items } = await service.findAllForUser('user-1', {});
      for (const key of [
        'matchStatus',
        'riskLevel',
        'riskReasons',
        'receivingScreenshotKey',
        'receivingEventKey',
        'bankCheckedAt',
        'receivingAmount',
        'receivingTransactionAt',
        'hasBankScreenshot',
      ]) {
        expect(items[0]).not.toHaveProperty(key);
      }
    });
  });

  describe('findAllAdmin — the five verification tabs', () => {
    it('all: the where clause is unchanged from before the feature', async () => {
      await service.findAllAdmin({ verification: 'all' });
      expect(prisma.deposit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: undefined, userId: undefined, createdAt: undefined },
        }),
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('verified / needs_review filter on matchStatus through the ordinary (full) index', async () => {
      await service.findAllAdmin({ verification: 'verified' });
      expect(prisma.deposit.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ matchStatus: 'MATCHED' }),
        }),
      );
      await service.findAllAdmin({ verification: 'needs_review' });
      expect(prisma.deposit.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            matchStatus: { in: ['PENDING_REVIEW', 'SUSPICIOUS'] },
          }),
        }),
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('awaiting_bank / no_bank_transaction spell the open-set predicate as literal SQL, page ids from the partial index, then fetch by primary key', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'b' }, { id: 'a' }])
        .mockResolvedValueOnce([{ n: 2 }]);
      const old = new Date(Date.now() - 30 * HOURS);
      prisma.deposit.findMany.mockResolvedValue([
        { ...makeDeposit({ id: 'a', createdAt: old }), user: { id: 'user-1' } },
        { ...makeDeposit({ id: 'b', createdAt: old }), user: { id: 'user-1' } },
      ]);

      const page = await service.findAllAdmin({
        verification: 'no_bank_transaction',
        userId: 'user-1',
        page: 2,
        limit: 10,
      });

      const [idsQuery, countQuery] = prisma.$queryRaw.mock.calls.map(
        (call) => call[0] as Prisma.Sql,
      );
      const text = idsQuery.strings.join('?');
      expect(text).toContain(`status = 'PENDING'::"DepositStatus"`);
      expect(text).toContain(`"bankCheckedAt" IS NULL`);
      expect(text).toContain(`"createdAt" < ?`);
      expect(text).toContain(`"userId" = ?`);
      expect(text).toContain('ORDER BY "createdAt" DESC');
      expect(idsQuery.values.slice(-2)).toEqual([10, 10]); // LIMIT 10 OFFSET 10
      expect(countQuery.strings.join('?')).toContain('count(*)::int');
      expect(prisma.deposit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['b', 'a'] } } }),
      );
      // Order comes from the index page, not from the pk fetch.
      expect(page.items.map((d) => d.id)).toEqual(['b', 'a']);
      expect(page.total).toBe(2);
      // Older than 24 h and still open: derived at read time, never stored.
      expect(page.items[0].matchStatus).toBe('NO_BANK_TRANSACTION');
      expect(page.items[0].riskReasons).toEqual(['NO_BANK_TRANSACTION']);
      expect(page.items[0].riskLevel).toBe('MEDIUM');
    });

    it('awaiting_bank uses the >= cutoff and short-circuits without a query for a non-PENDING status filter', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ n: 0 }]);
      await service.findAllAdmin({ verification: 'awaiting_bank' });
      expect(
        (prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).strings.join('?'),
      ).toContain(`"createdAt" >= ?`);

      prisma.$queryRaw.mockClear();
      const empty = await service.findAllAdmin({
        verification: 'awaiting_bank',
        status: DepositStatus.APPROVED,
      });
      expect(empty).toEqual({ items: [], total: 0, page: 1, limit: 20 });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('exposes hasBankScreenshot but never the object key, and the view status for a young pending row is the stored one', async () => {
      prisma.deposit.findMany.mockResolvedValue([
        {
          ...makeDeposit({
            receivingScreenshotKey:
              'documents/bank-screenshots/deposits/deposit-1/k.png',
            receivingAmount: new Prisma.Decimal(5000),
            bankCheckedAt: new Date(),
            matchStatus: 'MATCHED',
            riskLevel: 'LOW',
          }),
          user: { id: 'user-1' },
        },
      ]);
      const { items } = await service.findAllAdmin({});
      expect(items[0]).toMatchObject({
        hasBankScreenshot: true,
        receivingAmount: 5000,
        matchStatus: 'MATCHED',
        riskLevel: 'LOW',
        riskReasons: [],
      });
      expect(items[0]).not.toHaveProperty('receivingScreenshotKey');
      expect(items[0]).not.toHaveProperty('receivingEventKey');
    });
  });

  describe('approve — verification state in the audit row and the twin recompute', () => {
    it('records matchStatus/riskLevel/riskReasons at approval time and recomputes the twins', async () => {
      const pending = makeDeposit({
        matchStatus: 'SUSPICIOUS',
        riskLevel: 'HIGH',
        riskReasons: ['AMOUNT_MISMATCH'],
      });
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.findUniqueOrThrow.mockResolvedValue({
        ...pending,
        status: DepositStatus.APPROVED,
        user: { id: 'user-1', username: 'john' },
      });
      mockLookups([
        {
          id: 'deposit-2',
          userId: 'user-1',
          amount: new Prisma.Decimal(5000),
          status: DepositStatus.REJECTED,
          bankCheckedAt: null,
          matchStatus: 'UNVERIFIED',
          riskLevel: null,
          riskReasons: [],
        },
      ]);

      const result = await service.approve('deposit-1', admin);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deposit.approve',
          metadata: {
            creditedPaymentAccountId: undefined,
            matchStatus: 'SUSPICIOUS',
            riskLevel: 'HIGH',
            riskReasons: ['AMOUNT_MISMATCH'],
          },
        }),
      );
      // The twin gains DUPLICATE_REFERENCE (same user, so not SHARED).
      expect(prisma.deposit.update).toHaveBeenCalledWith({
        where: { id: 'deposit-2' },
        data: {
          matchStatus: 'PENDING_REVIEW',
          riskLevel: 'MEDIUM',
          riskReasons: ['DUPLICATE_REFERENCE'],
        },
      });
      expect(result.matchStatus).toBe('SUSPICIOUS');
    });
  });

  describe('reviewVerification', () => {
    const withUser = (row: Record<string, unknown>) => ({
      ...row,
      user: { id: 'user-1', username: 'john' },
    });

    it('clear → MATCHED when bank values are present and nothing hard disagrees, reasons emptied, level unscored', async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({
          bankCheckedAt: new Date(),
          matchStatus: 'PENDING_REVIEW',
          riskLevel: 'MEDIUM',
          riskReasons: ['DUPLICATE_REFERENCE'],
        }),
      );
      prisma.deposit.update.mockResolvedValue(
        withUser(
          makeDeposit({ bankCheckedAt: new Date(), matchStatus: 'MATCHED' }),
        ),
      );

      await service.reviewVerification(
        'deposit-1',
        { action: 'clear', note: 'checked statement' },
        admin,
      );

      expect(prisma.deposit.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { matchStatus: 'MATCHED', riskLevel: null, riskReasons: [] },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deposit.verification_review',
          actor: admin,
          metadata: { action: 'clear', note: 'checked statement' },
          tx: prisma,
        }),
      );
      expect(
        gateway.notifyAdminsDepositVerificationUpdated,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'deposit-1', matchStatus: 'MATCHED' }),
      );
    });

    it('clear → UNVERIFIED when a hard mismatch was on the row (an admin cannot make a differing amount "match")', async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({
          bankCheckedAt: new Date(),
          matchStatus: 'SUSPICIOUS',
          riskReasons: ['AMOUNT_MISMATCH'],
        }),
      );
      prisma.deposit.update.mockResolvedValue(withUser(makeDeposit()));
      await service.reviewVerification('deposit-1', { action: 'clear' }, admin);
      expect(prisma.deposit.update.mock.calls[0][0].data.matchStatus).toBe(
        'UNVERIFIED',
      );
    });

    it('confirm_suspicious → SUSPICIOUS / HIGH with the reasons kept', async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({ riskReasons: ['VELOCITY'] }),
      );
      prisma.deposit.update.mockResolvedValue(withUser(makeDeposit()));
      await service.reviewVerification(
        'deposit-1',
        { action: 'confirm_suspicious' },
        admin,
      );
      expect(prisma.deposit.update.mock.calls[0][0].data).toEqual({
        matchStatus: 'SUSPICIOUS',
        riskLevel: 'HIGH',
      });
    });

    it('unlink wipes every bank column and the screenshot, keeps the submission reasons, and deletes the object after commit', async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({
          bankCheckedAt: new Date(),
          receivingEventKey: 'k'.repeat(64),
          receivingScreenshotKey:
            'documents/bank-screenshots/deposits/deposit-1/k.png',
          matchStatus: 'SUSPICIOUS',
          riskLevel: 'HIGH',
          riskReasons: ['CODE_MISMATCH', 'DUPLICATE_REFERENCE'],
        }),
      );
      prisma.deposit.update.mockResolvedValue(withUser(makeDeposit()));

      await service.reviewVerification(
        'deposit-1',
        { action: 'unlink' },
        admin,
      );

      expect(prisma.deposit.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            receivingAmount: null,
            receivingTransactionCode: null,
            receivingTransactionTime: null,
            receivingTransactionAt: null,
            receivingEventKey: null,
            receivingScreenshotKey: null,
            bankCheckedAt: null,
            matchStatus: 'PENDING_REVIEW',
            riskLevel: 'MEDIUM',
            riskReasons: ['DUPLICATE_REFERENCE'],
          },
        }),
      );
      expect(minio.deleteObject).toHaveBeenCalledWith(
        'documents/bank-screenshots/deposits/deposit-1/k.png',
      );
    });

    it('refuses to unlink a row with no bank event, or one that is no longer PENDING', async () => {
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit());
      await expect(
        service.reviewVerification('deposit-1', { action: 'unlink' }, admin),
      ).rejects.toThrow(BadRequestException);
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({
          bankCheckedAt: new Date(),
          status: DepositStatus.APPROVED,
        }),
      );
      await expect(
        service.reviewVerification('deposit-1', { action: 'unlink' }, admin),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.deposit.update).not.toHaveBeenCalled();
      expect(minio.deleteObject).not.toHaveBeenCalled();
    });

    it('404s an unknown deposit', async () => {
      prisma.deposit.findUnique.mockResolvedValue(null);
      await expect(
        service.reviewVerification('nope', { action: 'clear' }, admin),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getBankScreenshot', () => {
    it('404s when the row has no screenshot or the object is gone', async () => {
      prisma.deposit.findUnique.mockResolvedValue({
        receivingScreenshotKey: null,
      });
      await expect(service.getBankScreenshot('deposit-1')).rejects.toThrow(
        NotFoundException,
      );
      prisma.deposit.findUnique.mockResolvedValue({
        receivingScreenshotKey: 'documents/x.png',
      });
      minio.getObjectStream.mockResolvedValue(null);
      await expect(service.getBankScreenshot('deposit-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('streams the private object as an inline PNG', async () => {
      prisma.deposit.findUnique.mockResolvedValue({
        receivingScreenshotKey:
          'documents/bank-screenshots/deposits/deposit-1/k.png',
      });
      minio.getObjectStream.mockResolvedValue({
        stream: Readable.from([Buffer.from('png')]),
        contentType: 'image/png',
        contentLength: 3,
      });

      const file = await service.getBankScreenshot('deposit-1');

      expect(minio.getObjectStream).toHaveBeenCalledWith(
        'documents/bank-screenshots/deposits/deposit-1/k.png',
      );
      expect(file.getHeaders()).toEqual({
        type: 'image/png',
        disposition: 'inline; filename="bank-deposit-1.png"',
        length: 3,
      });
    });
  });
});
