import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  DepositStatus,
  NotificationType,
  TransactionType,
  UserStatus,
} from '../generated/prisma/client';
import { lockAccountStatus } from '../users/account-status-lock';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FinanceSettingsService } from '../finance-settings/finance-settings.service';
import { PaymentAccountLedgerService } from '../payment-accounts/payment-account-ledger.service';
import { AuditService } from '../audit/audit.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { DepositsService } from './deposits.service';

// The account-row lock is raw SQL of its own (account-status-lock.spec.ts);
// here it only answers the status, so the $queryRaw mock stays the
// waiting-transfer lookup's alone. ACTIVE unless a test says otherwise.
jest.mock('../users/account-status-lock', () => ({
  ...jest.requireActual<object>('../users/account-status-lock'),
  lockAccountStatus: jest.fn(),
}));
const lockAccountStatusMock = jest.mocked(lockAccountStatus);
beforeEach(() => {
  lockAccountStatusMock.mockReset().mockResolvedValue(UserStatus.ACTIVE);
});

/** Only the key-ownership check the unlink path uses — the real thing needs ConfigService. */
const storageStub = {
  ownsBankScreenshot: (kind: string, rowId: string, key: string) =>
    key.startsWith(`documents/bank-screenshots/${kind}/${rowId}/`),
};

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

/** What Prisma throws when an insert trips deposits_user_reference_active_key. */
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
    user: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
    };
    paymentAccount: { findUnique: jest.Mock };
    bankTransaction: Record<string, jest.Mock>;
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let minio: { deleteObject: jest.Mock; getObjectStream: jest.Mock };
  let walletService: { creditWithinTransaction: jest.Mock };
  let gateway: {
    notifyAdminsDepositCreated: jest.Mock;
    notifyUserDepositUpdated: jest.Mock;
    notifyAdminsDepositUpdated: jest.Mock;
    notifyUserNotificationCreated: jest.Mock;
    notifyUserBalanceUpdated: jest.Mock;
    notifyAdminsPaymentAccountUpdated: jest.Mock;
    notifyAdminsDepositVerificationUpdated: jest.Mock;
    notifyAdminsBankTransactionUpdated: jest.Mock;
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
      user: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
      },
      // create() now checks the declared account is still active; tests
      // about a specific account override this per test.
      paymentAccount: {
        findUnique: jest.fn().mockResolvedValue({ isActive: true }),
      },
      // The stored phone notifications (bank_transactions): create() looks
      // for a waiting transfer through $queryRaw (Q-BT1, default: none) and
      // links by updateMany; unlink reads the link by findUnique.
      bankTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
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
      notifyAdminsDepositUpdated: jest.fn(),
      notifyUserNotificationCreated: jest.fn(),
      notifyUserBalanceUpdated: jest.fn(),
      notifyAdminsPaymentAccountUpdated: jest.fn(),
      notifyAdminsDepositVerificationUpdated: jest.fn(),
      notifyAdminsBankTransactionUpdated: jest.fn(),
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
        { provide: StorageService, useValue: storageStub },
      ],
    }).compile();

    service = module.get(DepositsService);
  });

  describe('create', () => {
    describe('H-16: an account closed while the request was in flight', () => {
      const request = {
        amount: 5000,
        paymentMethod: 'KBZ Pay',
        reference: '000123',
      };

      it('share-locks the account row inside the insert transaction, before the insert', async () => {
        prisma.deposit.findFirst.mockResolvedValue(null);
        prisma.deposit.create.mockResolvedValue(makeDeposit());
        prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

        await service.create('user-1', request);

        // tx is `prisma` itself in this mock.
        expect(lockAccountStatusMock).toHaveBeenCalledWith(prisma, 'user-1');
        expect(lockAccountStatusMock.mock.invocationCallOrder[0]).toBeLessThan(
          prisma.deposit.create.mock.invocationCallOrder[0],
        );
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      });

      it.each([
        UserStatus.CLOSED,
        UserStatus.SUSPENDED,
        UserStatus.BANNED,
        null,
      ])(
        'refuses an account that is %p by the time the lock is granted — nothing inserted, nobody told',
        async (status) => {
          prisma.deposit.findFirst.mockResolvedValue(null);
          lockAccountStatusMock.mockResolvedValue(status);

          await expect(service.create('user-1', request)).rejects.toThrow(
            new UnauthorizedException('This account is no longer active'),
          );
          expect(prisma.deposit.create).not.toHaveBeenCalled();
          expect(gateway.notifyAdminsDepositCreated).not.toHaveBeenCalled();
        },
      );
    });

    it('refuses a deposit declared against a DEACTIVATED account, whatever the client had cached', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.paymentAccount.findUnique.mockResolvedValue({ isActive: false });

      await expect(
        service.create('user-1', {
          amount: 5000,
          paymentMethod: 'KBZPay',
          reference: '000123',
          paymentAccountId: 'acct-off',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.paymentAccount.findUnique).toHaveBeenCalledWith({
        where: { id: 'acct-off' },
        select: { isActive: true },
      });
      expect(prisma.deposit.create).not.toHaveBeenCalled();
    });

    it('refuses a deposit declared against an account that no longer exists', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.paymentAccount.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user-1', {
          amount: 5000,
          paymentMethod: 'KBZPay',
          reference: '000123',
          paymentAccountId: 'acct-gone',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.deposit.create).not.toHaveBeenCalled();
    });

    it('accepts a deposit declared against an ACTIVE account', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.paymentAccount.findUnique.mockResolvedValue({ isActive: true });
      prisma.deposit.create.mockResolvedValue(makeDeposit());
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      const result = await service.create('user-1', {
        amount: 5000,
        paymentMethod: 'KBZPay',
        reference: '000123',
        paymentAccountId: 'acct-on',
      });

      expect(result.status).toBe(DepositStatus.PENDING);
      expect(prisma.deposit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ declaredPaymentAccountId: 'acct-on' }),
      });
    });

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

    it('rejects a reference the SAME user already has on a PENDING or APPROVED deposit (a double submit)', async () => {
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
          userId: 'user-1',
          reference: '000123',
          status: { in: [DepositStatus.PENDING, DepositStatus.APPROVED] },
        },
      });
    });

    it("H-11: another user's live deposit with the same reference never refuses this one — the pre-check only looks at the caller's own rows", async () => {
      // The real payer must always get a row into the queue; the twin rules
      // (DUPLICATE_REFERENCE / SHARED_REFERENCE_ACROSS_USERS) send both rows
      // to staff review instead — see the twin tests below.
      prisma.deposit.findFirst.mockImplementation(
        (args: { where: { userId?: string } }) =>
          Promise.resolve(
            args.where.userId === undefined
              ? makeDeposit({ id: 'deposit-other', userId: 'user-2' })
              : null,
          ),
      );
      prisma.deposit.create.mockResolvedValue(makeDeposit());
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
            bankTransaction: {
              select: { id: true, counterparty: true, deviceSerial: true },
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

    /** The approved row + the notification every happy path reads back. */
    function primeApprove(pending: Record<string, unknown>) {
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({
          ...pending,
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
    }

    describe("M-11/M-14: a staff member's own deposit", () => {
      it('is refused with 403 before the claim, and nothing moves', async () => {
        prisma.deposit.findUnique.mockResolvedValue(
          makeDeposit({ userId: 'admin-1' }),
        );

        await expect(service.approve('deposit-1', admin)).rejects.toThrow(
          new ForbiddenException(
            'You cannot approve a deposit into your own account',
          ),
        );
        expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
        expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });
    });

    describe('M-15/M-7: the bank saw a different amount than the user typed', () => {
      const mismatched = () =>
        makeDeposit({
          amount: new Prisma.Decimal(9000),
          receivingAmount: new Prisma.Decimal(1000),
          bankCheckedAt: new Date(),
          matchStatus: 'SUSPICIOUS',
          riskLevel: 'HIGH',
          riskReasons: ['AMOUNT_MISMATCH'],
        });

      it('a plain approve is refused (409) before the claim — the row stays PENDING, no money moves', async () => {
        prisma.deposit.findUnique.mockResolvedValue(mismatched());

        await expect(service.approve('deposit-1', admin, {})).rejects.toThrow(
          ConflictException,
        );
        expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
        expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      });

      it('the flag without a reason is refused (400)', async () => {
        prisma.deposit.findUnique.mockResolvedValue(mismatched());

        await expect(
          service.approve('deposit-1', admin, {
            creditBankAmount: true,
            overrideReason: '   ',
          }),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
      });

      it('with the flag and a reason: credits the BANK amount, writes it on the row, the ledger row and the notification, and audits the override', async () => {
        primeApprove(mismatched());
        walletService.creditWithinTransaction.mockResolvedValue({
          balance: new Prisma.Decimal(1500),
        });

        await service.approve('deposit-1', admin, {
          creditBankAmount: true,
          overrideReason: 'Receipt shows 1,000',
        });

        expect(walletService.creditWithinTransaction).toHaveBeenCalledWith(
          prisma,
          'user-1',
          1000,
        );
        expect(prisma.deposit.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: DepositStatus.APPROVED,
              amount: new Prisma.Decimal(1000),
            }),
          }),
        );
        expect(prisma.deposit.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: {
              walletBalanceBefore: new Prisma.Decimal(500),
              walletBalanceAfter: new Prisma.Decimal(1500),
            },
          }),
        );
        expect(prisma.transaction.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            amount: new Prisma.Decimal(1000),
            type: TransactionType.DEPOSIT,
          }),
        });
        expect(prisma.notification.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            message: expect.stringContaining('1000 Ks'),
            payload: expect.objectContaining({ amount: 1000 }),
          }),
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'deposit.approve',
            metadata: expect.objectContaining({
              creditedAmount: 1000,
              amountOverride: true,
              declaredAmount: 9000,
              bankAmount: 1000,
              overrideReason: 'Receipt shows 1,000',
            }),
          }),
        );
      });

      it('when the amounts agree the flag is not needed and the typed amount is credited, as before', async () => {
        primeApprove(
          makeDeposit({
            receivingAmount: new Prisma.Decimal(5000),
            bankCheckedAt: new Date(),
          }),
        );

        await service.approve('deposit-1', admin);

        expect(walletService.creditWithinTransaction).toHaveBeenCalledWith(
          prisma,
          'user-1',
          5000,
        );
        expect(prisma.deposit.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.not.objectContaining({ amount: expect.anything() }),
          }),
        );
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.not.objectContaining({ amountOverride: true }),
          }),
        );
      });
    });

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
      expect(gateway.notifyUserDepositUpdated).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          status: DepositStatus.APPROVED,
          change: 'status',
        }),
      );
      expect(gateway.notifyAdminsDepositUpdated).not.toHaveBeenCalled();
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
            bankTransaction: {
              select: { id: true, counterparty: true, deviceSerial: true },
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
        new ConflictException(
          'This deposit has already been approved or rejected',
        ),
      );
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    describe('DB-003: the claim is keyed on the bank-checked state read inside the transaction', () => {
      it('a row the bank never checked claims with bankCheckedAt IS NULL', async () => {
        primeApprove(makeDeposit({ bankCheckedAt: null }));

        await service.approve('deposit-1', admin);

        expect(prisma.deposit.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: 'deposit-1',
              status: DepositStatus.PENDING,
              bankCheckedAt: null,
            },
          }),
        );
      });

      it('a bank-checked row claims with the exact bankCheckedAt it read', async () => {
        const checkedAt = new Date('2026-10-09T03:00:00.000Z');
        primeApprove(
          makeDeposit({
            receivingAmount: new Prisma.Decimal(5000),
            bankCheckedAt: checkedAt,
            matchStatus: 'MATCHED',
          }),
        );

        await service.approve('deposit-1', admin);

        expect(prisma.deposit.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: 'deposit-1',
              status: DepositStatus.PENDING,
              bankCheckedAt: checkedAt,
            },
          }),
        );
      });

      it("the phone's event landed between the read and the claim: count 0 on a row that is still PENDING → 409 'reload', nothing credited, no audit row", async () => {
        // Read: no bank values yet. Re-read after the failed claim: still
        // PENDING (the matcher only set the bank columns), so the message
        // must not claim the deposit was approved or rejected.
        prisma.deposit.findUnique
          .mockResolvedValueOnce(makeDeposit({ bankCheckedAt: null }))
          .mockResolvedValueOnce({ status: DepositStatus.PENDING });
        prisma.deposit.updateMany.mockResolvedValue({ count: 0 });

        await expect(service.approve('deposit-1', admin)).rejects.toThrow(
          new ConflictException(
            'The deposit changed while you were approving — reload and try again',
          ),
        );
        expect(prisma.deposit.updateMany).toHaveBeenCalledTimes(1);
        expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
        expect(
          paymentAccountLedgerService.syncDepositLink,
        ).not.toHaveBeenCalled();
        expect(prisma.transaction.create).not.toHaveBeenCalled();
        expect(prisma.notification.create).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
        expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
      });
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
      expect(gateway.notifyUserDepositUpdated).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          status: DepositStatus.REJECTED,
          change: 'status',
        }),
      );
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

    it("M-11/M-14: a staff member's own deposit cannot be rejected by them (403), nothing written", async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({ userId: 'admin-1' }),
      );

      await expect(
        service.reject('deposit-1', admin, { reason: 'x' }),
      ).rejects.toThrow(
        new ForbiddenException(
          'You cannot reject a deposit into your own account',
        ),
      );
      expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    describe('M-17: the bank transfer is given back', () => {
      const rejectedNotification = {
        id: 'notif-2',
        type: 'DEPOSIT_REJECTED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      };

      it('a bank-checked row: the claim clears every bank column (event key included) and re-scores without the bank reasons; the transaction goes back to UNMATCHED in the same transaction; admins are told after commit', async () => {
        prisma.deposit.findUnique.mockResolvedValue(
          makeDeposit({
            bankCheckedAt: new Date(),
            receivingAmount: new Prisma.Decimal(1000),
            receivingTransactionCode: '000123',
            receivingTransactionAt: new Date(),
            receivingEventKey: 'k'.repeat(64),
            receivingScreenshotKey:
              'documents/bank-screenshots/transactions/tx-1/x.png',
            matchStatus: 'SUSPICIOUS',
            riskLevel: 'HIGH',
            riskReasons: ['AMOUNT_MISMATCH', 'DUPLICATE_REFERENCE'],
          }),
        );
        prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
        prisma.deposit.findUniqueOrThrow.mockResolvedValue(
          makeDeposit({ status: DepositStatus.REJECTED }),
        );
        prisma.notification.create.mockResolvedValue(rejectedNotification);
        prisma.bankTransaction.findUnique
          .mockResolvedValueOnce({ id: 'tx-1', state: 'MATCHED' })
          .mockResolvedValueOnce({
            id: 'tx-1',
            state: 'UNMATCHED',
            direction: 'RECEIVED',
            amount: new Prisma.Decimal(1000),
            occurredAt: new Date(),
            postedAt: new Date(),
            createdAt: new Date(),
            linkedDepositId: null,
            linkedWithdrawalId: null,
            matchedAt: null,
            screenshotKey: null,
            counterparty: null,
            txCode: 'X000123',
            txCodeLast6: '000123',
            paymentAccountId: 'acct-1',
            deviceSerial: 'PIXEL10',
            idempotencyKey: 'k'.repeat(64),
            currency: 'MMK',
            detailStatus: null,
            updatedAt: new Date(),
          });

        await service.reject('deposit-1', admin, { reason: 'wrong row' });

        expect(prisma.deposit.updateMany).toHaveBeenCalledWith({
          where: { id: 'deposit-1', status: DepositStatus.PENDING },
          data: expect.objectContaining({
            status: DepositStatus.REJECTED,
            rejectionReason: 'wrong row',
            receivingAmount: null,
            receivingTransactionCode: null,
            receivingTransactionTime: null,
            receivingTransactionAt: null,
            receivingEventKey: null,
            receivingScreenshotKey: null,
            bankCheckedAt: null,
            matchStatus: 'PENDING_REVIEW',
            riskReasons: ['DUPLICATE_REFERENCE'],
          }),
        });
        // Q-BT3, by the unique link column, inside the same transaction.
        expect(prisma.bankTransaction.update).toHaveBeenCalledWith({
          where: { id: 'tx-1' },
          data: { state: 'UNMATCHED', linkedDepositId: null, matchedAt: null },
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'bank_transaction.unlink',
            actor: admin,
          }),
        );
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'deposit.reject',
            metadata: { reason: 'wrong row', unlinkedTransactionId: 'tx-1' },
          }),
        );
        expect(
          gateway.notifyAdminsDepositVerificationUpdated,
        ).toHaveBeenCalledTimes(1);
        expect(gateway.notifyAdminsBankTransactionUpdated).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'tx-1', state: 'UNMATCHED' }),
        );
        // The transaction's own screenshot is evidence — never deleted here.
        expect(minio.deleteObject).not.toHaveBeenCalled();
      });

      it("M-16/M-17: rejecting also drops COUNTERPARTY_MISMATCH with the other bank-derived reasons — the sender name belonged to the transfer that is being given back; the submission's own reasons stay", async () => {
        prisma.deposit.findUnique.mockResolvedValue(
          makeDeposit({
            bankCheckedAt: new Date(),
            receivingAmount: new Prisma.Decimal(1000),
            receivingTransactionCode: '000123',
            matchStatus: 'PENDING_REVIEW',
            riskLevel: 'MEDIUM',
            riskReasons: ['COUNTERPARTY_MISMATCH', 'VELOCITY'],
          }),
        );
        prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
        prisma.deposit.findUniqueOrThrow.mockResolvedValue(
          makeDeposit({ status: DepositStatus.REJECTED }),
        );
        prisma.notification.create.mockResolvedValue(rejectedNotification);

        await service.reject('deposit-1', admin, { reason: 'not this one' });

        expect(prisma.deposit.updateMany).toHaveBeenCalledWith({
          where: { id: 'deposit-1', status: DepositStatus.PENDING },
          data: expect.objectContaining({
            status: DepositStatus.REJECTED,
            receivingAmount: null,
            bankCheckedAt: null,
            riskReasons: ['VELOCITY'],
          }),
        });
        const written = prisma.deposit.updateMany.mock.calls[0][0].data;
        expect(written.riskReasons).not.toContain('COUNTERPARTY_MISMATCH');
      });

      it('a legacy bank-checked row with no bank_transactions link: the bank columns are still cleared AND admins are still told after commit (no transaction push — there is none to give back)', async () => {
        prisma.deposit.findUnique.mockResolvedValue(
          makeDeposit({
            bankCheckedAt: new Date(),
            receivingAmount: new Prisma.Decimal(1000),
            receivingTransactionCode: '000123',
            receivingEventKey: 'k'.repeat(64),
            matchStatus: 'SUSPICIOUS',
            riskLevel: 'HIGH',
            riskReasons: ['AMOUNT_MISMATCH'],
          }),
        );
        prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
        prisma.deposit.findUniqueOrThrow.mockResolvedValue(
          makeDeposit({ status: DepositStatus.REJECTED }),
        );
        prisma.notification.create.mockResolvedValue(rejectedNotification);
        // Pre-table data: nothing in bank_transactions points at this row.
        prisma.bankTransaction.findUnique.mockResolvedValue(null);

        await service.reject('deposit-1', admin, { reason: 'legacy' });

        expect(prisma.deposit.updateMany).toHaveBeenCalledWith({
          where: { id: 'deposit-1', status: DepositStatus.PENDING },
          data: expect.objectContaining({
            status: DepositStatus.REJECTED,
            receivingAmount: null,
            receivingEventKey: null,
            bankCheckedAt: null,
            riskReasons: [],
          }),
        });
        expect(prisma.bankTransaction.update).not.toHaveBeenCalled();
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'deposit.reject',
            metadata: { reason: 'legacy', unlinkedTransactionId: null },
          }),
        );
        expect(
          gateway.notifyAdminsDepositVerificationUpdated,
        ).toHaveBeenCalledTimes(1);
        expect(
          gateway.notifyAdminsDepositVerificationUpdated,
        ).toHaveBeenCalledWith(expect.objectContaining({ id: 'deposit-1' }));
        expect(
          gateway.notifyAdminsBankTransactionUpdated,
        ).not.toHaveBeenCalled();
      });

      it('a row the bank never checked: rejected exactly as before — no bank columns touched, no unlink, no admin push', async () => {
        prisma.deposit.findUnique.mockResolvedValue(makeDeposit());
        prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
        prisma.deposit.findUniqueOrThrow.mockResolvedValue(
          makeDeposit({ status: DepositStatus.REJECTED }),
        );
        prisma.notification.create.mockResolvedValue(rejectedNotification);

        await service.reject('deposit-1', admin, { reason: 'x' });

        expect(prisma.deposit.updateMany).toHaveBeenCalledWith({
          where: { id: 'deposit-1', status: DepositStatus.PENDING },
          data: {
            status: DepositStatus.REJECTED,
            rejectionReason: 'x',
            approvedByUserId: 'admin-1',
            approvedAt: expect.any(Date),
          },
        });
        expect(prisma.bankTransaction.findUnique).not.toHaveBeenCalled();
        expect(prisma.bankTransaction.update).not.toHaveBeenCalled();
        expect(
          gateway.notifyAdminsDepositVerificationUpdated,
        ).not.toHaveBeenCalled();
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'deposit.reject',
            metadata: { reason: 'x' },
          }),
        );
      });
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
            bankTransaction: {
              select: { id: true, counterparty: true, deviceSerial: true },
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
          bankTransaction: {
            select: { id: true, counterparty: true, deviceSerial: true },
          },
        },
      });
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
      // Admin bookkeeping: other admin sessions get the same-named event so
      // their table stays in sync, but the user's room is never pinged —
      // their client would toast "Deposit approved" again for a deposit
      // that was approved long ago.
      expect(gateway.notifyAdminsDepositUpdated).toHaveBeenCalledWith({
        id: 'deposit-1',
        change: 'receiving_account',
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
      expect(gateway.notifyUserDepositUpdated).not.toHaveBeenCalled();
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

  /**
   * H-15 — the manual-deposit picker's own lookup, so a role with
   * DEPOSITS.CREATE (the seeded Admin) can find the customer without the
   * whole USERS.VIEW surface: customers only, a handful of rows, and only
   * the four fields the picker renders.
   */
  describe('lookupUsersForManualDeposit', () => {
    it('matches the trimmed term on username, display name and phone — customer accounts only, minimal fields', async () => {
      const rows = [
        {
          id: 'user-1',
          username: 'kokoo',
          displayName: 'Ko Ko',
          phone: '+959123456789',
        },
      ];
      prisma.user.findMany.mockResolvedValue(rows);

      const result = await service.lookupUsersForManualDeposit({
        search: '  ko ',
        limit: 8,
      });

      expect(result).toEqual({ items: rows });
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          role: 'USER',
          // H-16: a closed account can take no money — never offered.
          status: { not: 'CLOSED' },
          OR: [
            { username: { contains: 'ko', mode: 'insensitive' } },
            { displayName: { contains: 'ko', mode: 'insensitive' } },
            { phone: { contains: 'ko' } },
          ],
        },
        select: { id: true, username: true, displayName: true, phone: true },
        orderBy: { createdAt: 'desc' },
        take: 8,
      });
    });

    it('defaults to 8 rows', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await service.lookupUsersForManualDeposit({ search: 'ko' });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 8 }),
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

    describe('M-11/M-14: whose account a manual deposit may go into', () => {
      it("the recording admin's own account: 403 before anything is read or locked", async () => {
        await expect(
          service.createManual({ ...dto, userId: 'admin-1' }, admin),
        ).rejects.toThrow(
          new ForbiddenException(
            'You cannot record a deposit into your own account',
          ),
        );
        expect(lockAccountStatusMock).not.toHaveBeenCalled();
        expect(prisma.deposit.create).not.toHaveBeenCalled();
        expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      });

      it('a staff account (any non-USER role): 403, nothing written', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: 'user-1',
          role: 'ADMIN',
        });

        await expect(service.createManual(dto, admin)).rejects.toThrow(
          new ForbiddenException(
            'Manual deposits can only be recorded for customer accounts',
          ),
        );
        expect(prisma.user.findUnique).toHaveBeenCalledWith({
          where: { id: 'user-1' },
          select: { role: true },
        });
        expect(prisma.deposit.create).not.toHaveBeenCalled();
        expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });
    });

    it('rejects a reference the same user already has on a PENDING or APPROVED deposit, writing nothing', async () => {
      // The exact double-credit scenario: the user already submitted this
      // transfer through the app, and an admin records it manually too.
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
      prisma.deposit.findFirst.mockResolvedValue(
        makeDeposit({ status: DepositStatus.PENDING }),
      );

      await expect(service.createManual(dto, admin)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.deposit.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          reference: '000123',
          status: { in: [DepositStatus.PENDING, DepositStatus.APPROVED] },
        },
      });

      expect(prisma.deposit.create).not.toHaveBeenCalled();
      expect(
        paymentAccountLedgerService.syncDepositLink,
      ).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('rejects an unknown destination account with NotFound, writing nothing', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
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
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
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
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
      prisma.deposit.create.mockRejectedValue(new Error('db down'));

      const attempt = service.createManual(dto, admin);
      await expect(attempt).rejects.toThrow('db down');
      await expect(attempt).rejects.not.toBeInstanceOf(ConflictException);
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('creates the deposit directly APPROVED, credits the destination ledger and wallet, and records Transaction + Notification', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
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
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
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
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
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
        change: 'status',
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
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
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

    it('share-locks the customer row before anything is written', async () => {
      // Stop right at the insert: only the order up to it matters here.
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
      prisma.deposit.create.mockRejectedValue(new Error('stop here'));

      await expect(service.createManual(dto, admin)).rejects.toThrow(
        'stop here',
      );

      expect(lockAccountStatusMock).toHaveBeenCalledWith(prisma, 'user-1');
      expect(lockAccountStatusMock.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.deposit.create.mock.invocationCallOrder[0],
      );
    });

    it('H-16: refuses a CLOSED account with the closed-account 409 — no deposit, no credit, no audit row', async () => {
      lockAccountStatusMock.mockResolvedValue(UserStatus.CLOSED);

      await expect(service.createManual(dto, admin)).rejects.toThrow(
        new ConflictException(
          'This account was closed by its owner and cannot be changed.',
        ),
      );
      expect(prisma.deposit.create).not.toHaveBeenCalled();
      expect(
        paymentAccountLedgerService.syncDepositLink,
      ).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown user without creating or crediting anything', async () => {
      lockAccountStatusMock.mockResolvedValue(null);

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
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
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
    bankTransaction: Record<string, jest.Mock>;
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
      // create() now checks the declared account is still active; tests
      // about a specific account override this per test.
      paymentAccount: {
        findUnique: jest.fn().mockResolvedValue({ isActive: true }),
      },
      // The stored phone notifications (bank_transactions): create() looks
      // for a waiting transfer through $queryRaw (Q-BT1, default: none) and
      // links by updateMany; unlink reads the link by findUnique.
      bankTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
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
      notifyAdminsDepositUpdated: jest.fn(),
      notifyUserNotificationCreated: jest.fn(),
      notifyUserBalanceUpdated: jest.fn(),
      notifyAdminsPaymentAccountUpdated: jest.fn(),
      notifyAdminsDepositVerificationUpdated: jest.fn(),
      notifyAdminsBankTransactionUpdated: jest.fn(),
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
        { provide: StorageService, useValue: storageStub },
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

  /** A stored "You received …" row as Q-BT1 returns it (raw column shapes). */
  function waitingTransaction(overrides: Record<string, unknown> = {}) {
    return {
      id: 'tx-1',
      idempotencyKey: 'a'.repeat(64),
      deviceSerial: 'PIXEL10',
      paymentAccountId: 'acct-1',
      amount: '5000.00',
      txCode: 'KBZ20260922000123',
      txCodeLast6: '000123',
      occurredAt: new Date(Date.now() - 60_000),
      screenshotKey: null,
      ...overrides,
    };
  }

  describe('create — create-time rules and the waiting-transaction claim', () => {
    it('looks up the open bank transactions for the declared account + reference (literal open-set predicate), and with none reports UNVERIFIED with no reasons', async () => {
      prisma.deposit.create.mockResolvedValue(
        makeDeposit({ declaredPaymentAccountId: 'acct-1' }),
      );
      mockLookups([]);

      await service.create('user-1', { ...dto, paymentAccountId: 'acct-1' });

      const q = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      const text = q.strings.join('?');
      expect(text).toContain('FROM bank_transactions');
      expect(text).toContain(`state = 'UNMATCHED'::"BankTransactionState"`);
      expect(text).toContain(
        `direction = 'RECEIVED'::"BankTransactionDirection"`,
      );
      expect(q.values).toEqual(['acct-1', '000123']);
      expect(prisma.deposit.update).not.toHaveBeenCalled();
      expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsBankTransactionUpdated).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsDepositCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          matchStatus: 'UNVERIFIED',
          riskLevel: null,
          riskReasons: [],
        }),
      );
    });

    it('never looks for a transaction when the depositor declared no account (no key to look up by)', async () => {
      prisma.deposit.create.mockResolvedValue(makeDeposit());
      mockLookups([]);
      await service.create('user-1', dto);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('exactly one waiting transaction: claims it in the same transaction — bank values on the deposit, the link, both audit rows, the admin pushes with POST-claim values', async () => {
      const created = makeDeposit({
        declaredPaymentAccountId: 'acct-1',
        createdAt: new Date(),
      });
      prisma.deposit.create.mockResolvedValue(created);
      prisma.$queryRaw.mockResolvedValueOnce([
        waitingTransaction({
          screenshotKey: `documents/bank-screenshots/transactions/tx-1/${'a'.repeat(64)}.png`,
        }),
      ]);
      const claimed = makeDeposit({
        ...created,
        bankCheckedAt: new Date(),
        matchStatus: 'MATCHED',
        riskLevel: 'LOW',
        receivingAmount: new Prisma.Decimal(5000),
        receivingTransactionCode: '000123',
        receivingEventKey: 'a'.repeat(64),
      });
      prisma.deposit.findUniqueOrThrow
        .mockResolvedValueOnce(created)
        .mockResolvedValueOnce(claimed);
      mockLookups([], 1, [{ ...claimed, bankTransaction: { id: 'tx-1' } }]);
      prisma.bankTransaction.findUnique.mockResolvedValue({
        ...waitingTransaction(),
        direction: 'RECEIVED',
        currency: 'MMK',
        postedAt: new Date(),
        counterparty: null,
        detailStatus: 'ok',
        state: 'MATCHED',
        linkedDepositId: 'deposit-1',
        linkedWithdrawalId: null,
        matchedAt: new Date(),
        createdAt: new Date(),
        amount: new Prisma.Decimal(5000),
      });

      const result = await service.create('user-1', {
        ...dto,
        paymentAccountId: 'acct-1',
      });

      // The claim: the same guarded write ingestion does, plus the
      // screenshot pointer because the transaction already holds one.
      expect(prisma.deposit.updateMany).toHaveBeenCalledWith({
        where: { id: 'deposit-1', status: 'PENDING', bankCheckedAt: null },
        data: expect.objectContaining({
          receivingAmount: new Prisma.Decimal('5000.00'),
          receivingTransactionCode: '000123',
          receivingEventKey: 'a'.repeat(64),
          receivingScreenshotKey: `documents/bank-screenshots/transactions/tx-1/${'a'.repeat(64)}.png`,
          matchStatus: 'MATCHED',
          riskLevel: 'LOW',
          riskReasons: [],
        }),
      });
      // The link, guarded on "not already MATCHED".
      expect(prisma.bankTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: 'tx-1', state: { in: ['UNMATCHED', 'AMBIGUOUS'] } },
        data: expect.objectContaining({
          state: 'MATCHED',
          linkedDepositId: 'deposit-1',
        }),
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deposit.bank_match',
          actor: null,
          metadata: expect.objectContaining({
            trigger: 'deposit_create',
            bankTransactionId: 'tx-1',
          }),
          tx: prisma,
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_transaction.link',
          actor: null,
          target: expect.objectContaining({ id: 'tx-1' }),
          metadata: expect.objectContaining({
            trigger: 'deposit_create',
            depositId: 'deposit-1',
          }),
        }),
      );
      // After commit: the created event carries the POST-claim state, the
      // verification push goes out for the deposit, the transaction row is
      // pushed as updated.
      expect(gateway.notifyAdminsDepositCreated).toHaveBeenCalledWith(
        expect.objectContaining({ matchStatus: 'MATCHED', riskLevel: 'LOW' }),
      );
      expect(
        gateway.notifyAdminsDepositVerificationUpdated,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'deposit-1', bankTransactionId: 'tx-1' }),
      );
      expect(gateway.notifyAdminsBankTransactionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'tx-1',
          state: 'MATCHED',
          view: 'MATCHED',
          linkedDepositId: 'deposit-1',
        }),
      );
      // The user-facing response still never shows the bank side.
      expect(result).not.toHaveProperty('matchStatus');
      expect(result).not.toHaveProperty('receivingEventKey');
    });

    it('several waiting transactions: AMBIGUOUS_MATCH on the new deposit only — no claim, no link, the transactions untouched', async () => {
      prisma.deposit.create.mockResolvedValue(
        makeDeposit({ declaredPaymentAccountId: 'acct-1' }),
      );
      prisma.$queryRaw.mockResolvedValueOnce([
        waitingTransaction({ id: 'tx-1' }),
        waitingTransaction({ id: 'tx-2', idempotencyKey: 'b'.repeat(64) }),
      ]);
      mockLookups([]);

      await service.create('user-1', { ...dto, paymentAccountId: 'acct-1' });

      expect(prisma.deposit.update).toHaveBeenCalledWith({
        where: { id: 'deposit-1' },
        data: {
          matchStatus: 'PENDING_REVIEW',
          riskLevel: 'MEDIUM',
          riskReasons: ['AMBIGUOUS_MATCH'],
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deposit.risk_update',
          metadata: expect.objectContaining({
            trigger: 'deposit_create',
            reason: 'AMBIGUOUS_BANK_TRANSACTIONS',
            candidateTransactionIds: ['tx-1', 'tx-2'],
          }),
        }),
      );
      expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
      expect(prisma.bankTransaction.updateMany).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsBankTransactionUpdated).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsDepositCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          matchStatus: 'PENDING_REVIEW',
          riskReasons: ['AMBIGUOUS_MATCH'],
        }),
      );
    });

    it('a duplicate reference (P2002) still rolls the whole transaction back to the same 409 — the claim included', async () => {
      prisma.deposit.create.mockRejectedValue(makeP2002());
      await expect(
        service.create('user-1', { ...dto, paymentAccountId: 'acct-1' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
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

    it('H-11: a PENDING twin of ANOTHER user is stored, not refused — both rows go to staff review (SUSPICIOUS), nothing is guessed', async () => {
      prisma.deposit.create.mockResolvedValue(makeDeposit());
      mockLookups([
        {
          id: 'deposit-first',
          userId: 'user-2',
          amount: new Prisma.Decimal(5000),
          status: DepositStatus.PENDING,
          bankCheckedAt: null,
          matchStatus: 'UNVERIFIED',
          riskLevel: null,
          riskReasons: [],
        },
      ]);

      await expect(service.create('user-1', dto)).resolves.toMatchObject({
        id: 'deposit-1',
        status: DepositStatus.PENDING,
      });

      for (const id of ['deposit-1', 'deposit-first']) {
        expect(prisma.deposit.update).toHaveBeenCalledWith({
          where: { id },
          data: {
            matchStatus: 'SUSPICIOUS',
            riskLevel: 'HIGH',
            riskReasons: [
              'DUPLICATE_REFERENCE',
              'SHARED_REFERENCE_ACROSS_USERS',
            ],
          },
        });
      }
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
            creditedAmount: 5000,
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

    it('unlink wipes every bank column and the screenshot pointer, keeps the submission reasons, and deletes a LEGACY object after commit', async () => {
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
      // A row from before bank_transactions: nothing to unlink, no push.
      expect(prisma.bankTransaction.findUnique).toHaveBeenCalledWith({
        where: { linkedDepositId: 'deposit-1' },
        select: { id: true, state: true },
      });
      expect(prisma.bankTransaction.update).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsBankTransactionUpdated).not.toHaveBeenCalled();
    });

    it("unlink puts the linked bank transaction back to UNMATCHED (audited as the admin's act, pushed after commit) and NEVER deletes the transaction's own screenshot object", async () => {
      const key = `documents/bank-screenshots/transactions/tx-1/${'k'.repeat(64)}.png`;
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({
          bankCheckedAt: new Date(),
          receivingEventKey: 'k'.repeat(64),
          receivingScreenshotKey: key,
          matchStatus: 'MATCHED',
          riskLevel: 'LOW',
        }),
      );
      prisma.deposit.update.mockResolvedValue(withUser(makeDeposit()));
      prisma.bankTransaction.findUnique
        .mockResolvedValueOnce({ id: 'tx-1', state: 'MATCHED' })
        .mockResolvedValueOnce({
          id: 'tx-1',
          idempotencyKey: 'k'.repeat(64),
          deviceSerial: 'PIXEL10',
          paymentAccountId: 'acct-1',
          direction: 'RECEIVED',
          amount: new Prisma.Decimal(5000),
          currency: 'MMK',
          txCode: 'KBZ000123',
          txCodeLast6: '000123',
          occurredAt: new Date(),
          postedAt: new Date(),
          counterparty: null,
          screenshotKey: key,
          detailStatus: null,
          state: 'UNMATCHED',
          linkedDepositId: null,
          linkedWithdrawalId: null,
          matchedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      await service.reviewVerification(
        'deposit-1',
        { action: 'unlink' },
        admin,
      );

      expect(prisma.bankTransaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-1' },
        data: { state: 'UNMATCHED', linkedDepositId: null, matchedAt: null },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_transaction.unlink',
          actor: admin,
          target: expect.objectContaining({ id: 'tx-1' }),
          metadata: { depositId: 'deposit-1' },
          tx: prisma,
        }),
      );
      expect(minio.deleteObject).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsBankTransactionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'tx-1',
          state: 'UNMATCHED',
          view: 'WAITING',
          hasScreenshot: true,
        }),
      );
    });

    it("M-16/M-17: unlink also drops COUNTERPARTY_MISMATCH — it came from the released transfer's sender name, so the row goes back to UNVERIFIED instead of a stale 'Needs review'", async () => {
      prisma.deposit.findUnique.mockResolvedValue(
        makeDeposit({
          bankCheckedAt: new Date(),
          receivingAmount: new Prisma.Decimal(1000),
          receivingTransactionCode: '000123',
          matchStatus: 'PENDING_REVIEW',
          riskLevel: 'LOW',
          riskReasons: ['COUNTERPARTY_MISMATCH'],
        }),
      );
      prisma.deposit.update.mockResolvedValue(withUser(makeDeposit()));

      await service.reviewVerification(
        'deposit-1',
        { action: 'unlink' },
        admin,
      );

      expect(prisma.deposit.update.mock.calls[0][0].data).toEqual(
        expect.objectContaining({
          receivingAmount: null,
          bankCheckedAt: null,
          matchStatus: 'UNVERIFIED',
          riskLevel: null,
          riskReasons: [],
        }),
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
