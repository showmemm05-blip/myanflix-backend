import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { UserStatus, WithdrawalStatus } from '../generated/prisma/client';
import { lockAccountStatus } from '../users/account-status-lock';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FinanceSettingsService } from '../finance-settings/finance-settings.service';
import { PaymentAccountLedgerService } from '../payment-accounts/payment-account-ledger.service';
import { AuditService } from '../audit/audit.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { CLOCK_SKEW_MS } from '../bank-events/risk-rules';
import { WithdrawalCodeService } from '../withdrawal-code/withdrawal-code.service';
import {
  withdrawalCodeLocked,
  withdrawalCodeNotSet,
  withdrawalCodeRequired,
  withdrawalCodeWrong,
} from '../withdrawal-code/withdrawal-code.errors';
import { WithdrawalsService } from './withdrawals.service';

/** The account's withdrawal code every create() now carries (2026-10-05). */
const WITHDRAWAL_CODE = '582904';

// The account-row lock answers ACTIVE unless a test says otherwise — see
// deposits.service.spec.ts (its SQL is account-status-lock.spec.ts's).
jest.mock('../users/account-status-lock', () => ({
  ...jest.requireActual<object>('../users/account-status-lock'),
  lockAccountStatus: jest.fn(),
}));
const lockAccountStatusMock = jest.mocked(lockAccountStatus);
beforeEach(() => {
  lockAccountStatusMock.mockReset().mockResolvedValue(UserStatus.ACTIVE);
});

/** Only the key-ownership check the unlink path uses — see deposits.service.spec.ts. */
const storageStub = {
  ownsBankScreenshot: (kind: string, rowId: string, key: string) =>
    key.startsWith(`documents/bank-screenshots/${kind}/${rowId}/`),
};

function makeWithdrawal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'withdrawal-1',
    userId: 'user-1',
    amount: new Prisma.Decimal(5000),
    accountType: 'KBZPay',
    accountName: 'Ko Ko',
    accountNumber: '09123456789',
    status: WithdrawalStatus.PENDING,
    rejectionReason: null,
    approvedByUserId: null,
    approvedAt: null,
    transferAccountType: null,
    transferAccountName: null,
    transferAccountNumber: null,
    transferTransactionCode: null,
    // The bank side, as a fresh row has it (bank_verification migration).
    transferAmount: null,
    transferTransactionAt: null,
    transferScreenshotKey: null,
    transferEventKey: null,
    bankCheckedAt: null,
    matchStatus: 'UNVERIFIED',
    riskLevel: null,
    riskReasons: [],
    // C-4: null = a request filed before funds were held at request time
    // (approve still debits it); a held row carries its ledger row's id.
    holdTransactionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('WithdrawalsService', () => {
  let service: WithdrawalsService;
  let prisma: {
    withdrawal: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    wallet: { findUniqueOrThrow: jest.Mock };
    transaction: { create: jest.Mock; update: jest.Mock };
    notification: { create: jest.Mock };
    user: { findUniqueOrThrow: jest.Mock };
    bankTransaction: Record<string, jest.Mock>;
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let minio: { deleteObject: jest.Mock; getObjectStream: jest.Mock };
  let walletService: {
    getByUserId: jest.Mock;
    debitWithinTransaction: jest.Mock;
    creditWithinTransaction: jest.Mock;
  };
  let gateway: {
    notifyAdminsWithdrawalCreated: jest.Mock;
    notifyUserWithdrawalUpdated: jest.Mock;
    notifyAdminsWithdrawalUpdated: jest.Mock;
    notifyUserNotificationCreated: jest.Mock;
    notifyUserBalanceUpdated: jest.Mock;
    notifyAdminsPaymentAccountUpdated: jest.Mock;
    notifyAdminsWithdrawalVerificationUpdated: jest.Mock;
    notifyAdminsBankTransactionUpdated: jest.Mock;
  };
  let financeSettingsService: { getLimits: jest.Mock };
  let paymentAccountLedgerService: { syncWithdrawalLink: jest.Mock };
  let audit: { record: jest.Mock };
  let withdrawalCode: { assertValidForWithdrawal: jest.Mock };

  beforeEach(async () => {
    prisma = {
      withdrawal: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      wallet: { findUniqueOrThrow: jest.fn() },
      // create() writes the hold's ledger row (C-4); tests that care about
      // the id override it.
      transaction: {
        create: jest.fn().mockResolvedValue({ id: 'txn-hold-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      notification: { create: jest.fn() },
      user: { findUniqueOrThrow: jest.fn() },
      // The stored phone notifications (bank_transactions): unlink, and the
      // parked-record look-backs of approve / the typed code (none parked
      // unless a test says so).
      bankTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // Both call styles are in use: the callback form for the write paths —
      // where `tx` is just `prisma` itself, since every mocked method lives
      // directly on this object (mirrors deposits.service.spec.ts) — and the
      // array form for the list queries' findMany+count pair.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    // updateTransferAccount() runs the payout-code twin lookup (Q8) through
    // findMany inside its transaction; no twins is the default.
    prisma.withdrawal.findMany.mockResolvedValue([]);
    minio = {
      deleteObject: jest.fn().mockResolvedValue(undefined),
      getObjectStream: jest.fn(),
    };
    // The real debit/credit return the POST-change Wallet — create() and
    // reject() push its balance to the user.
    walletService = {
      getByUserId: jest.fn(),
      debitWithinTransaction: jest
        .fn()
        .mockResolvedValue({ balance: new Prisma.Decimal(5000) }),
      creditWithinTransaction: jest
        .fn()
        .mockResolvedValue({ balance: new Prisma.Decimal(10000) }),
    };
    gateway = {
      notifyAdminsWithdrawalCreated: jest.fn(),
      notifyUserWithdrawalUpdated: jest.fn(),
      notifyAdminsWithdrawalUpdated: jest.fn(),
      notifyUserNotificationCreated: jest.fn(),
      notifyUserBalanceUpdated: jest.fn(),
      notifyAdminsPaymentAccountUpdated: jest.fn(),
      notifyAdminsWithdrawalVerificationUpdated: jest.fn(),
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
    // tests stay focused on WithdrawalsService's own orchestration.
    paymentAccountLedgerService = {
      syncWithdrawalLink: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    // The code is right unless a test says otherwise — the code's own rules
    // (lock, tries, too easy) are withdrawal-code.service.spec.ts's.
    withdrawalCode = {
      assertValidForWithdrawal: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WithdrawalsService,
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
        { provide: WithdrawalCodeService, useValue: withdrawalCode },
      ],
    }).compile();

    service = module.get(WithdrawalsService);
  });

  describe('create', () => {
    it('holds the money at request time: one transaction debits the wallet, writes a PENDING WITHDRAWAL ledger row and links it to the request (C-4)', async () => {
      walletService.getByUserId.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      const withdrawal = makeWithdrawal({ holdTransactionId: 'txn-hold-1' });
      prisma.withdrawal.create.mockResolvedValue(withdrawal);
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      const result = await service.create('user-1', {
        amount: 5000,
        accountType: 'KBZPay',
        accountName: 'Ko Ko',
        accountNumber: '09123456789',
        withdrawalCode: WITHDRAWAL_CODE,
      });

      expect(result.status).toBe(WithdrawalStatus.PENDING);
      // All three writes share ONE transaction (tx is `prisma` in this mock).
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // The conditional `balance >= amount` debit is the guarantee — two
      // full-balance requests can never both be held.
      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        prisma,
        'user-1',
        5000,
      );
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          type: 'WITHDRAWAL',
          amount: 5000,
          status: 'PENDING',
        },
      });
      expect(prisma.withdrawal.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          amount: 5000,
          accountType: 'KBZPay',
          accountName: 'Ko Ko',
          accountNumber: '09123456789',
          bankName: null,
          holdTransactionId: 'txn-hold-1',
        },
      });
      expect(
        walletService.debitWithinTransaction.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.withdrawal.create.mock.invocationCallOrder[0]);
      // The user's open wallet screens show the lower balance at once.
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith(
        'user-1',
        5000,
      );
      // The hold's ledger id is internal bookkeeping, never in the user shape.
      expect(result).not.toHaveProperty('holdTransactionId');
    });

    describe('H-16: an account closed while the request was in flight', () => {
      const request = {
        amount: 5000,
        accountType: 'KBZPay',
        accountName: 'Ko Ko',
        accountNumber: '09123456789',
        withdrawalCode: WITHDRAWAL_CODE,
      };

      it('share-locks the account row inside the hold transaction, before any money moves', async () => {
        walletService.getByUserId.mockResolvedValue({
          balance: new Prisma.Decimal(10000),
        });
        prisma.withdrawal.create.mockResolvedValue(makeWithdrawal());
        prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

        await service.create('user-1', request);

        // tx is `prisma` itself in this mock.
        expect(lockAccountStatusMock).toHaveBeenCalledWith(prisma, 'user-1');
        expect(lockAccountStatusMock.mock.invocationCallOrder[0]).toBeLessThan(
          walletService.debitWithinTransaction.mock.invocationCallOrder[0],
        );
      });

      it.each([
        UserStatus.CLOSED,
        UserStatus.SUSPENDED,
        UserStatus.BANNED,
        null,
      ])(
        'refuses an account that is %p by the time the lock is granted — no hold, no row, nobody told',
        async (status) => {
          walletService.getByUserId.mockResolvedValue({
            balance: new Prisma.Decimal(10000),
          });
          lockAccountStatusMock.mockResolvedValue(status);

          await expect(service.create('user-1', request)).rejects.toThrow(
            new UnauthorizedException('This account is no longer active'),
          );
          expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
          expect(prisma.transaction.create).not.toHaveBeenCalled();
          expect(prisma.withdrawal.create).not.toHaveBeenCalled();
          expect(gateway.notifyAdminsWithdrawalCreated).not.toHaveBeenCalled();
          expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
        },
      );
    });

    it('a spend that lands between the balance check and the hold: the atomic debit refuses, nothing is written and nobody is told', async () => {
      walletService.getByUserId.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      walletService.debitWithinTransaction.mockRejectedValue(
        new BadRequestException('Insufficient wallet balance'),
      );

      await expect(
        service.create('user-1', {
          amount: 5000,
          accountType: 'KBZPay',
          accountName: 'Ko Ko',
          accountNumber: '09123456789',
          withdrawalCode: WITHDRAWAL_CODE,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.withdrawal.create).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsWithdrawalCreated).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it("stores the payout details from the request itself, never from the requester's profile", async () => {
      walletService.getByUserId.mockResolvedValue({
        balance: new Prisma.Decimal(100000),
      });
      prisma.withdrawal.create.mockResolvedValue(makeWithdrawal());
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      await service.create('user-1', {
        amount: 5000,
        accountType: 'Bank Account',
        accountName: 'Daw Mya',
        accountNumber: '09999999999',
        withdrawalCode: WITHDRAWAL_CODE,
        bankName: 'AYA Bank',
      });

      // Every payout field comes straight off the DTO. A withdrawal is a
      // snapshot of what was asked for on the day, so a later profile edit —
      // or a profile that never matched in the first place — must not change
      // where this payout goes.
      expect(prisma.withdrawal.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          amount: 5000,
          accountType: 'Bank Account',
          accountName: 'Daw Mya',
          accountNumber: '09999999999',
          bankName: 'AYA Bank',
          holdTransactionId: 'txn-hold-1',
        },
      });
      // The only profile read in create() is for the username on the realtime
      // notification — it must never be selecting payout details.
      expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { username: true, displayName: true, phone: true, email: true },
      });
    });

    it('announces the withdrawal to admins with the display name next to the raw username', async () => {
      walletService.getByUserId.mockResolvedValue({
        balance: new Prisma.Decimal(100000),
      });
      prisma.withdrawal.create.mockResolvedValue(makeWithdrawal());
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        username: 'user_95950495369',
        displayName: 'Blake',
      });

      await service.create('user-1', {
        amount: 5000,
        accountType: 'KBZPay',
        accountName: 'Ko Ko',
        accountNumber: '09123456789',
        withdrawalCode: WITHDRAWAL_CODE,
      });

      // The raw username is the login identity and must survive alongside the
      // label — the admin still has to be able to tell which account this is.
      expect(gateway.notifyAdminsWithdrawalCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'user_95950495369',
          displayName: 'Blake',
        }),
      );
    });

    it('emits displayName as null on the realtime event when the user never set a name', async () => {
      walletService.getByUserId.mockResolvedValue({
        balance: new Prisma.Decimal(100000),
      });
      prisma.withdrawal.create.mockResolvedValue(makeWithdrawal());
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        username: 'john',
        displayName: null,
      });

      await service.create('user-1', {
        amount: 5000,
        accountType: 'KBZPay',
        accountName: 'Ko Ko',
        accountNumber: '09123456789',
        withdrawalCode: WITHDRAWAL_CODE,
      });

      expect(gateway.notifyAdminsWithdrawalCreated).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'john', displayName: null }),
      );
    });

    it('rejects a request for more than the available wallet balance, without creating anything', async () => {
      walletService.getByUserId.mockResolvedValue({
        balance: new Prisma.Decimal(1000),
      });

      await expect(
        service.create('user-1', {
          amount: 5000,
          accountType: 'KBZPay',
          accountName: 'Ko Ko',
          accountNumber: '09123456789',
          withdrawalCode: WITHDRAWAL_CODE,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.withdrawal.create).not.toHaveBeenCalled();
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
    });

    it('rejects an amount below the configured minimum withdrawal, before even checking the balance', async () => {
      financeSettingsService.getLimits.mockResolvedValue({
        minDepositAmount: 0,
        maxDepositAmount: Number.MAX_SAFE_INTEGER,
        minWithdrawalAmount: 10000,
        maxWithdrawalAmount: 5000000,
      });

      await expect(
        service.create('user-1', {
          amount: 5000,
          accountType: 'KBZPay',
          accountName: 'Ko Ko',
          accountNumber: '09123456789',
          withdrawalCode: WITHDRAWAL_CODE,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(walletService.getByUserId).not.toHaveBeenCalled();
      expect(prisma.withdrawal.create).not.toHaveBeenCalled();
    });

    it('rejects an amount above the configured maximum withdrawal', async () => {
      financeSettingsService.getLimits.mockResolvedValue({
        minDepositAmount: 0,
        maxDepositAmount: Number.MAX_SAFE_INTEGER,
        minWithdrawalAmount: 1000,
        maxWithdrawalAmount: 100000,
      });

      await expect(
        service.create('user-1', {
          amount: 200000,
          accountType: 'KBZPay',
          accountName: 'Ko Ko',
          accountNumber: '09123456789',
          withdrawalCode: WITHDRAWAL_CODE,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.withdrawal.create).not.toHaveBeenCalled();
    });

    it('accepts an amount within the configured withdrawal range', async () => {
      financeSettingsService.getLimits.mockResolvedValue({
        minDepositAmount: 0,
        maxDepositAmount: Number.MAX_SAFE_INTEGER,
        minWithdrawalAmount: 1000,
        maxWithdrawalAmount: 100000,
      });
      walletService.getByUserId.mockResolvedValue({
        balance: new Prisma.Decimal(10000),
      });
      prisma.withdrawal.create.mockResolvedValue(makeWithdrawal());
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      await expect(
        service.create('user-1', {
          amount: 5000,
          accountType: 'KBZPay',
          accountName: 'Ko Ko',
          accountNumber: '09123456789',
          withdrawalCode: WITHDRAWAL_CODE,
        }),
      ).resolves.toBeDefined();
      expect(prisma.withdrawal.create).toHaveBeenCalled();
    });

    describe('withdrawal code (2026-10-05)', () => {
      const request = {
        amount: 5000,
        accountType: 'KBZPay',
        accountName: 'Ko Ko',
        accountNumber: '09123456789',
        withdrawalCode: WITHDRAWAL_CODE,
      };

      beforeEach(() => {
        walletService.getByUserId.mockResolvedValue({
          balance: new Prisma.Decimal(10000),
        });
        prisma.withdrawal.create.mockResolvedValue(makeWithdrawal());
        prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });
      });

      /** Nothing held, written or announced. */
      function expectNoMoneySideEffects() {
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(lockAccountStatusMock).not.toHaveBeenCalled();
        expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
        expect(prisma.transaction.create).not.toHaveBeenCalled();
        expect(prisma.withdrawal.create).not.toHaveBeenCalled();
        expect(gateway.notifyAdminsWithdrawalCreated).not.toHaveBeenCalled();
        expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
      }

      it('checks the code with the server-side service BEFORE the hold transaction, and proceeds exactly as before when it is right', async () => {
        const result = await service.create('user-1', request);

        expect(withdrawalCode.assertValidForWithdrawal).toHaveBeenCalledWith(
          'user-1',
          WITHDRAWAL_CODE,
        );
        expect(
          withdrawalCode.assertValidForWithdrawal.mock.invocationCallOrder[0],
        ).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
        expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
          prisma,
          'user-1',
          5000,
        );
        expect(gateway.notifyAdminsWithdrawalCreated).toHaveBeenCalled();
        expect(result.status).toBe(WithdrawalStatus.PENDING);
      });

      it('never stores the code on the withdrawal row nor sends it to admins', async () => {
        await service.create('user-1', request);

        const [{ data }] = prisma.withdrawal.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ];
        expect(data).not.toHaveProperty('withdrawalCode');
        expect(JSON.stringify(data)).not.toContain(WITHDRAWAL_CODE);
        expect(
          JSON.stringify(gateway.notifyAdminsWithdrawalCreated.mock.calls),
        ).not.toContain(WITHDRAWAL_CODE);
      });

      it.each([
        ['no code yet (409 NOT_SET)', withdrawalCodeNotSet()],
        ['no code sent (400 REQUIRED)', withdrawalCodeRequired()],
        ['a wrong code (400 WRONG)', withdrawalCodeWrong(3)],
        [
          'a locked code (423 LOCKED)',
          withdrawalCodeLocked(new Date(Date.now() + 15 * 60 * 1000)),
        ],
      ])(
        '%s: refused with the coded error and no money moves',
        async (_label, error) => {
          withdrawalCode.assertValidForWithdrawal.mockRejectedValue(error);

          await expect(service.create('user-1', request)).rejects.toBe(error);
          expectNoMoneySideEffects();
        },
      );

      it('passes a missing code through to the service (which answers NOT_SET or REQUIRED)', async () => {
        const { withdrawalCode: _omitted, ...withoutCode } = request;
        const notSet = withdrawalCodeNotSet();
        withdrawalCode.assertValidForWithdrawal.mockRejectedValue(notSet);

        await expect(
          service.create('user-1', withoutCode),
        ).rejects.toMatchObject({ code: 'WITHDRAWAL_CODE_NOT_SET' });
        expect(notSet.getStatus()).toBe(409);
        expect(withdrawalCode.assertValidForWithdrawal).toHaveBeenCalledWith(
          'user-1',
          undefined,
        );
        expectNoMoneySideEffects();
      });

      it('a bad amount is refused before the code is checked, so it never uses up a try', async () => {
        walletService.getByUserId.mockResolvedValue({
          balance: new Prisma.Decimal(1000),
        });

        await expect(service.create('user-1', request)).rejects.toThrow(
          new BadRequestException(
            'Withdrawal amount exceeds your available wallet balance',
          ),
        );
        expect(withdrawalCode.assertValidForWithdrawal).not.toHaveBeenCalled();
        expectNoMoneySideEffects();
      });
    });
  });

  describe('findAllAdmin', () => {
    beforeEach(() => {
      prisma.withdrawal.findMany.mockResolvedValue([]);
      prisma.withdrawal.count.mockResolvedValue(0);
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
      expect(prisma.withdrawal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
      expect(prisma.withdrawal.count).toHaveBeenCalledWith({
        where: expectedWhere,
      });
    });

    it('projects the requesting user with their display name next to the raw username', async () => {
      prisma.withdrawal.findMany.mockResolvedValue([
        makeWithdrawal({
          user: {
            id: 'user-1',
            username: 'user_95950495369',
            displayName: 'Blake',
            phone: '+959123456',
          },
        }),
      ]);
      prisma.withdrawal.count.mockResolvedValue(1);

      const result = await service.findAllAdmin({});

      expect(prisma.withdrawal.findMany).toHaveBeenCalledWith(
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

    it('leaves createdAt undefined when no date range is given, so existing queries are untouched', async () => {
      await service.findAllAdmin({});

      expect(prisma.withdrawal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: undefined, userId: undefined, createdAt: undefined },
        }),
      );
    });

    it('composes the status filter with the date range', async () => {
      await service.findAllAdmin({
        status: WithdrawalStatus.PENDING,
        dateFrom: '2026-08-13T17:30:00.000Z',
        dateTo: '2026-08-14T17:29:59.999Z',
      });

      expect(prisma.withdrawal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: WithdrawalStatus.PENDING,
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
      prisma.withdrawal.findMany.mockResolvedValue([]);
      prisma.withdrawal.count.mockResolvedValue(0);
    });

    it("applies the createdAt range on top of the caller's own userId scope", async () => {
      await service.findAllForUser('user-1', {
        dateFrom: '2026-08-13T17:30:00.000Z',
        dateTo: '2026-08-14T17:29:59.999Z',
      });

      expect(prisma.withdrawal.findMany).toHaveBeenCalledWith(
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

      expect(prisma.withdrawal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', status: undefined, createdAt: undefined },
        }),
      );
    });
  });

  describe('approve', () => {
    it('throws NotFoundException for an unknown withdrawal, without writing anything', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(null);

      await expect(
        service.approve('nope', { id: 'admin-1' } as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    });

    it("M-11/M-14: a staff member's own withdrawal cannot be approved by them (403), nothing written or settled", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ userId: 'admin-1', holdTransactionId: 'txn-hold-1' }),
      );

      await expect(
        service.approve('withdrawal-1', { id: 'admin-1' } as never),
      ).rejects.toThrow(
        new ForbiddenException(
          'You cannot approve a withdrawal from your own account',
        ),
      );
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
      expect(prisma.transaction.update).not.toHaveBeenCalled();
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the withdrawal is no longer PENDING (double-processing guard)', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(makeWithdrawal());
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approve('withdrawal-1', { id: 'admin-1' } as never),
      ).rejects.toThrow(ConflictException);
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.update).not.toHaveBeenCalled();
    });

    it('a held request (C-4): approve only finalises the hold — no second debit, no new ledger row, the PENDING hold row turns COMPLETED', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ holdTransactionId: 'txn-hold-1' }),
      );
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
      prisma.notification.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'notif-1',
            isRead: false,
            createdAt: new Date(),
            ...data,
          }),
      );
      prisma.withdrawal.findUniqueOrThrow.mockResolvedValue({
        ...makeWithdrawal({
          status: WithdrawalStatus.APPROVED,
          holdTransactionId: 'txn-hold-1',
        }),
        user: { id: 'user-1', username: 'john' },
      });
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(5000),
      });

      const result = await service.approve('withdrawal-1', {
        id: 'admin-1',
      } as never);

      expect(result.status).toBe(WithdrawalStatus.APPROVED);
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.transaction.update).toHaveBeenCalledWith({
        where: { id: 'txn-hold-1' },
        data: { status: 'COMPLETED' },
      });
      // The claim comes first, so a lost race never touches the ledger row.
      expect(
        prisma.withdrawal.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.transaction.update.mock.invocationCallOrder[0]);
      // The money left the balance when it was requested.
      const message = (
        prisma.notification.create.mock.calls[0][0] as {
          data: { message: string };
        }
      ).data.message;
      expect(message).not.toContain('deducted');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'withdrawal.approve',
          before: expect.objectContaining({
            holdTransactionId: 'txn-hold-1',
          }),
          tx: prisma,
        }),
      );
    });

    it('a request filed before funds were held (no hold row): approve still debits and records the WITHDRAWAL ledger row, as before', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(makeWithdrawal());
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
      walletService.debitWithinTransaction.mockResolvedValue({
        balance: new Prisma.Decimal(5000),
      });
      prisma.transaction.create.mockResolvedValue({});
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'WITHDRAWAL_APPROVED',
        title: 'Withdrawal approved',
        message: 'ok',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });
      prisma.withdrawal.findUniqueOrThrow.mockResolvedValue({
        ...makeWithdrawal({ status: WithdrawalStatus.APPROVED }),
        user: { id: 'user-1', username: 'john' },
      });
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(5000),
      });

      const result = await service.approve('withdrawal-1', {
        id: 'admin-1',
      } as never);

      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        prisma,
        'user-1',
        5000,
      );
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          type: 'WITHDRAWAL',
          status: 'COMPLETED',
        }),
      });
      expect(prisma.transaction.update).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith(
        'user-1',
        5000,
      );
      expect(result.status).toBe(WithdrawalStatus.APPROVED);
      expect(gateway.notifyUserWithdrawalUpdated).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          status: WithdrawalStatus.APPROVED,
          change: 'status',
        }),
      );
      expect(gateway.notifyAdminsWithdrawalUpdated).not.toHaveBeenCalled();
    });

    it('propagates an insufficient-balance failure from debitWithinTransaction (rolling back the claim)', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(makeWithdrawal());
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
      walletService.debitWithinTransaction.mockRejectedValue(
        new BadRequestException('Insufficient wallet balance'),
      );

      await expect(
        service.approve('withdrawal-1', { id: 'admin-1' } as never),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(gateway.notifyUserWithdrawalUpdated).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('throws NotFoundException for an unknown withdrawal, without writing anything', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(null);

      await expect(
        service.reject('nope', { id: 'admin-1' } as never, { reason: 'bad' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    });

    it("M-11/M-14: a staff member's own withdrawal cannot be rejected by them (403), no refund, nothing written", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ userId: 'admin-1', holdTransactionId: 'txn-hold-1' }),
      );

      await expect(
        service.reject('withdrawal-1', { id: 'admin-1' } as never, {
          reason: 'bad',
        }),
      ).rejects.toThrow(
        new ForbiddenException(
          'You cannot reject a withdrawal from your own account',
        ),
      );
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the withdrawal is no longer PENDING', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ holdTransactionId: 'txn-hold-1' }),
      );
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reject('withdrawal-1', { id: 'admin-1' } as never, {
          reason: 'bad',
        }),
      ).rejects.toThrow(ConflictException);
      // A lost race (already approved/rejected) never refunds twice.
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.transaction.update).not.toHaveBeenCalled();
    });

    it('a held request (C-4): reject gives the money back in the same transaction — wallet credited, hold row FAILED, a REFUND ledger row, the new balance pushed', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ holdTransactionId: 'txn-hold-1' }),
      );
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
      prisma.transaction.create.mockResolvedValue({ id: 'txn-refund-1' });
      prisma.notification.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'notif-1',
            isRead: false,
            createdAt: new Date(),
            ...data,
          }),
      );
      prisma.withdrawal.findUniqueOrThrow.mockResolvedValue({
        ...makeWithdrawal({
          status: WithdrawalStatus.REJECTED,
          rejectionReason: 'bad',
          holdTransactionId: 'txn-hold-1',
        }),
        user: { id: 'user-1', username: 'john' },
      });

      const result = await service.reject(
        'withdrawal-1',
        { id: 'admin-1' } as never,
        { reason: 'bad' },
      );

      expect(result.status).toBe(WithdrawalStatus.REJECTED);
      expect(walletService.creditWithinTransaction).toHaveBeenCalledWith(
        prisma,
        'user-1',
        5000,
      );
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      // Claim first: only the call that flipped PENDING -> REJECTED refunds.
      expect(
        prisma.withdrawal.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(
        walletService.creditWithinTransaction.mock.invocationCallOrder[0],
      );
      expect(prisma.transaction.update).toHaveBeenCalledWith({
        where: { id: 'txn-hold-1' },
        data: { status: 'FAILED' },
      });
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          type: 'REFUND',
          amount: new Prisma.Decimal(5000),
          status: 'COMPLETED',
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'withdrawal.reject',
          metadata: { reason: 'bad', refundTransactionId: 'txn-refund-1' },
          tx: prisma,
        }),
      );
      const message = (
        prisma.notification.create.mock.calls[0][0] as {
          data: { message: string };
        }
      ).data.message;
      expect(message).toContain('returned to your wallet');
      expect(message).toContain('bad');
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith(
        'user-1',
        10000,
      );
    });

    it('a request filed before funds were held: reject moves no money — nothing was taken', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(makeWithdrawal());
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'WITHDRAWAL_REJECTED',
        title: 'Withdrawal rejected',
        message: 'ok',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });
      prisma.withdrawal.findUniqueOrThrow.mockResolvedValue({
        ...makeWithdrawal({
          status: WithdrawalStatus.REJECTED,
          rejectionReason: 'bad',
        }),
        user: { id: 'user-1', username: 'john' },
      });

      const result = await service.reject(
        'withdrawal-1',
        { id: 'admin-1' } as never,
        {
          reason: 'bad',
        },
      );

      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.transaction.update).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
      expect(result.status).toBe(WithdrawalStatus.REJECTED);
      expect(result.rejectionReason).toBe('bad');
      expect(gateway.notifyUserWithdrawalUpdated).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          status: WithdrawalStatus.REJECTED,
          change: 'status',
        }),
      );
    });
  });

  describe('updateTransferAccount', () => {
    const admin = { id: 'admin-1', username: 'admin', role: 'ADMIN' } as never;

    it('throws NotFoundException for an unknown withdrawal, without writing anything', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(null);

      await expect(
        service.updateTransferAccount(
          'nope',
          {
            transferAccountType: 'KBZPay',
            transferAccountName: 'MyanFlix',
            transferAccountNumber: '09999999999',
            transferTransactionCode: '123456',
            transferTransactionTime: 'Jan 1, 2026 10:00 AM',
          },
          admin,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the withdrawal is not APPROVED', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ status: WithdrawalStatus.PENDING }),
      );

      await expect(
        service.updateTransferAccount(
          'withdrawal-1',
          {
            transferAccountType: 'KBZPay',
            transferAccountName: 'MyanFlix',
            transferAccountNumber: '09999999999',
            transferTransactionCode: '123456',
            transferTransactionTime: 'Jan 1, 2026 10:00 AM',
          },
          admin,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    });

    it("records our transfer account (incl. subname), transaction code, and transaction time without touching the user's own withdrawal account fields, status, wallet, or ledger", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ status: WithdrawalStatus.APPROVED }),
      );
      prisma.withdrawal.update.mockResolvedValue({
        ...makeWithdrawal({
          status: WithdrawalStatus.APPROVED,
          transferAccountType: 'KBZPay',
          transferAccountSubname: 'K1',
          transferAccountName: 'MyanFlix',
          transferAccountNumber: '09999999999',
          transferTransactionCode: '123456',
          transferTransactionTime: 'Jan 1, 2026 10:00 AM',
        }),
        user: { id: 'user-1', username: 'john', phone: null },
      });

      const result = await service.updateTransferAccount(
        'withdrawal-1',
        {
          transferAccountType: 'KBZPay',
          transferAccountSubname: 'K1',
          transferAccountName: 'MyanFlix',
          transferAccountNumber: '09999999999',
          transferTransactionCode: '123456',
          transferTransactionTime: 'Jan 1, 2026 10:00 AM',
        },
        admin,
      );

      expect(prisma.withdrawal.update).toHaveBeenCalledWith({
        where: { id: 'withdrawal-1' },
        data: {
          transferAccountType: 'KBZPay',
          transferAccountSubname: 'K1',
          transferAccountName: 'MyanFlix',
          transferAccountNumber: '09999999999',
          transferTransactionCode: '123456',
          transferTransactionTime: 'Jan 1, 2026 10:00 AM',
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
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
      // Admin bookkeeping: other admin sessions get the same-named event so
      // their table stays in sync, but the user's room is never pinged —
      // their client would toast "Withdrawal approved" again for a payout
      // that was approved long ago.
      expect(gateway.notifyAdminsWithdrawalUpdated).toHaveBeenCalledWith({
        id: 'withdrawal-1',
        change: 'transfer_account',
        status: WithdrawalStatus.APPROVED,
        amount: 5000,
        accountType: 'KBZPay',
        accountName: 'Ko Ko',
        accountNumber: '09123456789',
        approvedAt: null,
        transferAccountType: 'KBZPay',
        transferAccountSubname: 'K1',
        transferAccountName: 'MyanFlix',
        transferAccountNumber: '09999999999',
        transferTransactionCode: '123456',
        transferTransactionTime: 'Jan 1, 2026 10:00 AM',
      });
      expect(gateway.notifyUserWithdrawalUpdated).not.toHaveBeenCalled();
      // The user's own withdrawal account (what they submitted) is untouched.
      expect(result.accountName).toBe('Ko Ko');
      expect(result.transferAccountName).toBe('MyanFlix');
      expect(result.transferAccountSubname).toBe('K1');
      expect(result.transferTransactionCode).toBe('123456');
      expect(result.status).toBe(WithdrawalStatus.APPROVED);
    });

    it('nulls out subname (not leaving it undefined) when the admin types the account in manually instead of picking from the catalog', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ status: WithdrawalStatus.APPROVED }),
      );
      prisma.withdrawal.update.mockResolvedValue(
        makeWithdrawal({ status: WithdrawalStatus.APPROVED }),
      );

      await service.updateTransferAccount(
        'withdrawal-1',
        {
          transferAccountType: 'KBZPay',
          transferAccountName: 'MyanFlix',
          transferAccountNumber: '09999999999',
          transferTransactionCode: '123456',
          transferTransactionTime: 'Jan 1, 2026 10:00 AM',
        },
        admin,
      );

      expect(prisma.withdrawal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ transferAccountSubname: null }),
        }),
      );
    });
  });
});

/** Bank transfer verification — the withdrawal half (see deposits.service.spec.ts). */
describe('WithdrawalsService — bank verification', () => {
  let service: WithdrawalsService;
  let prisma: {
    withdrawal: {
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
    user: { findUniqueOrThrow: jest.Mock };
    bankTransaction: Record<string, jest.Mock>;
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let gateway: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let minio: { deleteObject: jest.Mock; getObjectStream: jest.Mock };
  const admin = { id: 'admin-1', username: 'admin', role: 'ADMIN' } as never;

  beforeEach(async () => {
    prisma = {
      withdrawal: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      wallet: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ balance: new Prisma.Decimal(1000) }),
      },
      transaction: { create: jest.fn() },
      notification: {
        create: jest.fn().mockResolvedValue({
          id: 'n1',
          type: 'WITHDRAWAL_APPROVED',
          title: 't',
          message: 'm',
          payload: {},
          isRead: false,
          createdAt: new Date(),
        }),
      },
      user: { findUniqueOrThrow: jest.fn() },
      // The stored phone notifications (bank_transactions): unlink, and the
      // parked-record look-backs of approve / the typed code (none parked
      // unless a test says so).
      bankTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
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
      notifyAdminsWithdrawalCreated: jest.fn(),
      notifyUserWithdrawalUpdated: jest.fn(),
      notifyAdminsWithdrawalUpdated: jest.fn(),
      notifyUserNotificationCreated: jest.fn(),
      notifyUserBalanceUpdated: jest.fn(),
      notifyAdminsPaymentAccountUpdated: jest.fn(),
      notifyAdminsWithdrawalVerificationUpdated: jest.fn(),
      notifyAdminsBankTransactionUpdated: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    minio = {
      deleteObject: jest.fn().mockResolvedValue(undefined),
      getObjectStream: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WithdrawalsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: WalletService,
          useValue: {
            getByUserId: jest.fn(),
            debitWithinTransaction: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: RealtimeGateway, useValue: gateway },
        {
          provide: FinanceSettingsService,
          useValue: { getLimits: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: PaymentAccountLedgerService,
          useValue: {
            syncWithdrawalLink: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: MinioService, useValue: minio },
        { provide: StorageService, useValue: storageStub },
        // Not reached: these suites never create a withdrawal.
        {
          provide: WithdrawalCodeService,
          useValue: { assertValidForWithdrawal: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(WithdrawalsService);
  });

  it('approve never nudges the phone-monitor; with no parked "sent" record in its window it looks once and links nothing', async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(makeWithdrawal());
    prisma.withdrawal.findUniqueOrThrow.mockResolvedValue({
      ...makeWithdrawal({
        status: WithdrawalStatus.APPROVED,
        approvedAt: new Date(),
      }),
      user: { id: 'user-1', username: 'john' },
    });

    const result = await service.approve('withdrawal-1', admin);

    // The look-back into the parked records (W2) ran once and found none.
    expect(prisma.bankTransaction.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.bankTransaction.updateMany).not.toHaveBeenCalled();
    expect(gateway).not.toHaveProperty('notifyBankMonitorsNudge');
    expect(result).toMatchObject({
      matchStatus: 'UNVERIFIED',
      hasBankScreenshot: false,
      bankTransactionId: null,
    });
  });

  describe('updateTransferAccount — DUPLICATE_PAYOUT_CODE', () => {
    const dto = {
      transferAccountType: 'KBZPay',
      transferAccountName: 'MyanFlix',
      transferAccountNumber: '09999999999',
      transferTransactionCode: 'AB12CD',
      transferTransactionTime: '06:56:28',
    };

    it('flags this row and the other withdrawal already carrying the same code — flagged, never blocked', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ status: WithdrawalStatus.APPROVED }),
      );
      const updated = {
        ...makeWithdrawal({
          status: WithdrawalStatus.APPROVED,
          transferTransactionCode: 'AB12CD',
        }),
        user: { id: 'user-1', username: 'john' },
      };
      prisma.withdrawal.update.mockResolvedValue(updated);
      prisma.withdrawal.findMany.mockImplementation(
        (args: { where: { transferTransactionCode?: string } }) =>
          Promise.resolve(
            args.where.transferTransactionCode === 'AB12CD'
              ? [
                  {
                    id: 'withdrawal-0',
                    userId: 'user-9',
                    amount: new Prisma.Decimal(5000),
                    status: WithdrawalStatus.APPROVED,
                    bankCheckedAt: null,
                    matchStatus: 'UNVERIFIED',
                    riskLevel: null,
                    riskReasons: [],
                  },
                ]
              : [],
          ),
      );

      const result = await service.updateTransferAccount(
        'withdrawal-1',
        dto,
        admin,
      );

      expect(result.status).toBe(WithdrawalStatus.APPROVED);
      expect(prisma.withdrawal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'withdrawal-1' },
          data: {
            matchStatus: 'SUSPICIOUS',
            riskLevel: 'MEDIUM',
            riskReasons: ['DUPLICATE_PAYOUT_CODE'],
          },
        }),
      );
      expect(prisma.withdrawal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'withdrawal-0' },
          data: {
            matchStatus: 'SUSPICIOUS',
            riskLevel: 'MEDIUM',
            riskReasons: ['DUPLICATE_PAYOUT_CODE'],
          },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'withdrawal.risk_update',
          actor: null,
          metadata: {
            trigger: 'transfer_account_update',
            anchorWithdrawalId: 'withdrawal-1',
          },
        }),
      );
    });

    it('writes no risk update when the code is unique', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ status: WithdrawalStatus.APPROVED }),
      );
      prisma.withdrawal.update.mockResolvedValue({
        ...makeWithdrawal({
          status: WithdrawalStatus.APPROVED,
          transferTransactionCode: 'AB12CD',
        }),
        user: { id: 'user-1', username: 'john' },
      });

      await service.updateTransferAccount('withdrawal-1', dto, admin);

      // Exactly one update: the transfer-account save itself.
      expect(prisma.withdrawal.update).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'withdrawal.transfer_account_update',
        }),
      );
    });
  });

  describe('findAllAdmin — verification tabs', () => {
    it('awaiting_bank spells the open payout set as literal SQL and pages by primary key', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'w1' }])
        .mockResolvedValueOnce([{ n: 1 }]);
      prisma.withdrawal.findMany.mockResolvedValue([
        {
          ...makeWithdrawal({
            id: 'w1',
            status: WithdrawalStatus.APPROVED,
            approvedAt: new Date(),
          }),
          user: { id: 'user-1' },
        },
      ]);

      const page = await service.findAllAdmin({
        verification: 'awaiting_bank',
      });

      const text = (
        prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql
      ).strings.join('?');
      expect(text).toContain(`status = 'APPROVED'::"WithdrawalStatus"`);
      expect(text).toContain(`"bankCheckedAt" IS NULL`);
      expect(text).toContain(`"transferTransactionCode" IS NULL`);
      expect(text).toContain(`"approvedAt" >= ?`);
      expect(page.items[0]).toMatchObject({
        id: 'w1',
        matchStatus: 'UNVERIFIED',
      });
      expect(page.total).toBe(1);
    });

    it('derives NO_BANK_TRANSACTION for an approved payout older than the window with no bank confirmation', async () => {
      prisma.withdrawal.findMany.mockResolvedValue([
        {
          ...makeWithdrawal({
            status: WithdrawalStatus.APPROVED,
            approvedAt: new Date(Date.now() - 30 * 3_600_000),
          }),
          user: { id: 'user-1' },
        },
      ]);
      const { items } = await service.findAllAdmin({});
      expect(items[0].matchStatus).toBe('NO_BANK_TRANSACTION');
      expect(items[0].riskLevel).toBe('MEDIUM');
    });

    it('verified filters on matchStatus with the ordinary index', async () => {
      await service.findAllAdmin({ verification: 'verified' });
      expect(prisma.withdrawal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ matchStatus: 'MATCHED' }),
        }),
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  it('findAllForUser strips the bank-verification columns', async () => {
    prisma.withdrawal.findMany.mockResolvedValue([
      makeWithdrawal({
        matchStatus: 'SUSPICIOUS',
        riskReasons: ['DUPLICATE_PAYOUT_CODE'],
        transferScreenshotKey: 'x',
      }),
    ]);
    const { items } = await service.findAllForUser('user-1', {});
    for (const key of [
      'matchStatus',
      'riskLevel',
      'riskReasons',
      'transferScreenshotKey',
      'transferEventKey',
      'bankCheckedAt',
      'transferAmount',
    ]) {
      expect(items[0]).not.toHaveProperty(key);
    }
  });

  describe('reviewVerification', () => {
    it('unlink wipes the transfer* bank values and deletes the screenshot; a row without a bank event is refused', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({
          status: WithdrawalStatus.APPROVED,
          bankCheckedAt: new Date(),
          transferEventKey: 'k'.repeat(64),
          transferScreenshotKey:
            'documents/bank-screenshots/withdrawals/withdrawal-1/k.png',
          matchStatus: 'PENDING_REVIEW',
          riskReasons: ['AMBIGUOUS_MATCH', 'DUPLICATE_PAYOUT_CODE'],
        }),
      );
      prisma.withdrawal.update.mockResolvedValue({
        ...makeWithdrawal({ status: WithdrawalStatus.APPROVED }),
        user: { id: 'user-1', username: 'john' },
      });

      await service.reviewVerification(
        'withdrawal-1',
        { action: 'unlink' },
        admin,
      );

      expect(prisma.withdrawal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            transferAmount: null,
            transferTransactionCode: null,
            transferTransactionTime: null,
            transferTransactionAt: null,
            transferEventKey: null,
            transferScreenshotKey: null,
            bankCheckedAt: null,
            matchStatus: 'SUSPICIOUS',
            riskLevel: 'MEDIUM',
            riskReasons: ['DUPLICATE_PAYOUT_CODE'],
          },
        }),
      );
      expect(minio.deleteObject).toHaveBeenCalledWith(
        'documents/bank-screenshots/withdrawals/withdrawal-1/k.png',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'withdrawal.verification_review',
          actor: admin,
        }),
      );
      expect(
        gateway.notifyAdminsWithdrawalVerificationUpdated,
      ).toHaveBeenCalled();

      prisma.withdrawal.findUnique.mockResolvedValue(makeWithdrawal());
      await expect(
        service.reviewVerification('withdrawal-1', { action: 'unlink' }, admin),
      ).rejects.toThrow(BadRequestException);
    });

    it("unlink releases the linked bank transaction (Q-BT3, audited as the admin's act) and never deletes the transaction's own screenshot", async () => {
      const key = `documents/bank-screenshots/transactions/tx-9/${'k'.repeat(64)}.png`;
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({
          status: WithdrawalStatus.APPROVED,
          bankCheckedAt: new Date(),
          transferEventKey: 'k'.repeat(64),
          transferScreenshotKey: key,
          matchStatus: 'MATCHED',
          riskLevel: 'LOW',
        }),
      );
      prisma.withdrawal.update.mockResolvedValue({
        ...makeWithdrawal({ status: WithdrawalStatus.APPROVED }),
        user: { id: 'user-1', username: 'john' },
      });
      prisma.bankTransaction.findUnique
        .mockResolvedValueOnce({ id: 'tx-9', state: 'MATCHED' })
        .mockResolvedValueOnce({
          id: 'tx-9',
          idempotencyKey: 'k'.repeat(64),
          deviceSerial: 'PIXEL10',
          paymentAccountId: 'acct-1',
          direction: 'SENT',
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
        'withdrawal-1',
        { action: 'unlink' },
        admin,
      );

      expect(prisma.bankTransaction.findUnique).toHaveBeenCalledWith({
        where: { linkedWithdrawalId: 'withdrawal-1' },
        select: { id: true, state: true },
      });
      expect(prisma.bankTransaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-9' },
        data: {
          state: 'UNMATCHED',
          linkedWithdrawalId: null,
          matchedAt: null,
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_transaction.unlink',
          actor: admin,
          metadata: { withdrawalId: 'withdrawal-1' },
        }),
      );
      expect(minio.deleteObject).not.toHaveBeenCalled();
      expect(gateway.notifyAdminsBankTransactionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-9', view: 'WAITING' }),
      );
    });
  });
});

/**
 * The ORDER of the three events — money sent (the phone posts the record),
 * approve, the code typed in "Our Transfer Account" — no longer decides
 * whether a payout is verified (owner decision 2026-09-28). These scenarios
 * run the REAL matcher functions against a small in-memory stand-in for the
 * withdrawals / bank_transactions tables (findMany/updateMany evaluate the
 * where clauses the code actually sends, and Q7's literal SQL is answered
 * from its bound values), so each one exercises the rules end to end.
 */
describe('WithdrawalsService — order-independent bank matching', () => {
  const ADMIN = { id: 'admin-1', username: 'admin', role: 'ADMIN' } as never;
  const ACCOUNT = '33333333-3333-4333-8333-333333333333';
  const EVENT_KEY = 'a'.repeat(64);
  // 27 Sep 2026, Asia/Yangon (UTC+6:30): requested 01:36:13, money sent
  // 01:37:01 by the bank's clock, phone posted 01:37:27, approved 01:38:13.
  const REQUESTED_AT = new Date('2026-09-26T19:06:13.000Z');
  const BANK_AT = new Date('2026-09-26T19:07:01.000Z');
  const POSTED_AT = new Date('2026-09-26T19:07:27.000Z');
  const SECOND = 1_000;
  const MINUTE = 60_000;
  const dto = {
    transferAccountType: 'KBZPay',
    transferAccountSubname: 'K1',
    transferAccountName: 'MyanFlix',
    transferAccountNumber: '09999999999',
    transferTransactionCode: 'AB12CD',
    transferTransactionTime: '01:37:30',
    paymentAccountId: ACCOUNT,
  };

  /** A row of the stand-in tables — Prisma's own row shapes, loosely typed. */
  type Row = Record<string, unknown>;
  type Where = Record<string, unknown>;
  interface Filter {
    in?: unknown[];
    not?: unknown;
    equals?: string;
    mode?: string;
    gte?: Date;
    lte?: Date;
  }
  interface FindArgs {
    where?: Where;
    take?: number;
    orderBy?: { occurredAt?: 'asc' | 'desc' };
  }
  interface WriteArgs {
    where: Where;
    data: Row;
  }
  interface FakePrisma {
    withdrawal: Record<
      'findUnique' | 'findUniqueOrThrow' | 'findMany' | 'updateMany' | 'update',
      jest.Mock
    > & { count: jest.Mock };
    bankTransaction: Record<
      'findUnique' | 'findMany' | 'updateMany' | 'update',
      jest.Mock
    >;
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
    wallet: { findUniqueOrThrow: jest.Mock };
    transaction: { create: jest.Mock };
    notification: { create: jest.Mock };
    paymentAccount: { update: jest.Mock };
    paymentAccountTransaction: { create: jest.Mock };
  }

  let withdrawals: Map<string, Row>;
  let records: Row[];
  let prisma: FakePrisma;
  let gateway: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let ledger: { syncWithdrawalLink: jest.Mock };
  let service: WithdrawalsService;

  function withdrawalRow(overrides: Row = {}): Row {
    return makeWithdrawal({
      id: 'wd-27',
      userId: 'user-27',
      amount: new Prisma.Decimal(50000),
      transferAccountSubname: null,
      transferTransactionTime: null,
      transferPaymentAccountId: null,
      createdAt: REQUESTED_AT,
      updatedAt: REQUESTED_AT,
      ...overrides,
    });
  }

  function sentRecord(overrides: Row = {}): Row {
    return {
      id: 'tx-27',
      idempotencyKey: EVENT_KEY,
      deviceSerial: 'PIXEL10',
      paymentAccountId: ACCOUNT,
      direction: 'SENT',
      amount: new Prisma.Decimal(50000),
      currency: 'MMK',
      txCode: '01003959270000AB12CD',
      txCodeLast6: 'AB12CD',
      occurredAt: BANK_AT,
      postedAt: POSTED_AT,
      counterparty: null,
      screenshotKey: null,
      detailStatus: null,
      // Parked: nothing was approved when the phone posted it.
      state: 'UNMATCHED',
      linkedDepositId: null,
      linkedWithdrawalId: null,
      matchedAt: null,
      createdAt: POSTED_AT,
      updatedAt: POSTED_AT,
      ...overrides,
    };
  }

  const time = (value: unknown): number =>
    value instanceof Date ? value.getTime() : Number.NaN;

  function matchesFilter(value: unknown, c: Filter): boolean {
    if (c.in && !c.in.includes(value)) return false;
    if ('not' in c && (c.not === null ? value == null : value === c.not)) {
      return false;
    }
    if (c.equals !== undefined) {
      if (typeof value !== 'string') return false;
      const equal =
        c.mode === 'insensitive'
          ? value.toUpperCase() === c.equals.toUpperCase()
          : value === c.equals;
      if (!equal) return false;
    }
    if (c.gte && !(time(value) >= c.gte.getTime())) return false;
    if (c.lte && !(time(value) <= c.lte.getTime())) return false;
    return true;
  }

  /** The subset of Prisma's where semantics the matching paths use. */
  function matches(row: Row, where: Where = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      if (key === 'OR') {
        return (cond as Where[]).some((c) => matches(row, c));
      }
      const value = row[key];
      if (cond === null) return value === null || value === undefined;
      if (cond instanceof Prisma.Decimal) {
        return value instanceof Prisma.Decimal && value.equals(cond);
      }
      if (cond instanceof Date) return time(value) === cond.getTime();
      if (typeof cond === 'object') return matchesFilter(value, cond);
      return value === cond;
    });
  }

  /** A withdrawal as Prisma returns it with the admin include. */
  function view(row: Row): Row {
    const linked = records.find((r) => r.linkedWithdrawalId === row.id);
    return {
      ...row,
      user: { id: row.userId, username: 'blake' },
      bankTransaction: linked ? { id: linked.id } : null,
    };
  }

  function withdrawal(id: string): Row {
    const row = withdrawals.get(id);
    if (!row) throw new Error(`no withdrawal ${id}`);
    return row;
  }

  function at(now: Date) {
    jest.useFakeTimers({
      now,
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });
  }

  beforeEach(async () => {
    withdrawals = new Map();
    records = [];
    const all = () => [...withdrawals.values()];
    const fake: FakePrisma = {
      withdrawal: {
        findUnique: jest.fn(({ where }: FindArgs) => {
          const row = all().find((w) => matches(w, where));
          return Promise.resolve(row ? view(row) : null);
        }),
        findUniqueOrThrow: jest.fn(({ where }: FindArgs) => {
          const row = all().find((w) => matches(w, where));
          if (!row) return Promise.reject(new Error('not found'));
          return Promise.resolve(view(row));
        }),
        findMany: jest.fn(({ where, take }: FindArgs) => {
          const rows = all().filter((w) => matches(w, where));
          return Promise.resolve(rows.slice(0, take).map((w) => view(w)));
        }),
        updateMany: jest.fn(({ where, data }: WriteArgs) => {
          const rows = all().filter((w) => matches(w, where));
          for (const row of rows) Object.assign(row, data);
          return Promise.resolve({ count: rows.length });
        }),
        update: jest.fn(({ where, data }: WriteArgs) => {
          const row = withdrawal(String(where.id));
          Object.assign(row, data);
          return Promise.resolve(view(row));
        }),
        count: jest.fn().mockResolvedValue(0),
      },
      bankTransaction: {
        findUnique: jest.fn(({ where }: FindArgs) =>
          Promise.resolve(records.find((r) => matches(r, where)) ?? null),
        ),
        findMany: jest.fn(({ where, orderBy, take }: FindArgs) => {
          const sign = orderBy?.occurredAt === 'desc' ? -1 : 1;
          const rows = records
            .filter((r) => matches(r, where))
            .sort((a, b) => sign * (time(a.occurredAt) - time(b.occurredAt)));
          return Promise.resolve(rows.slice(0, take));
        }),
        updateMany: jest.fn(({ where, data }: WriteArgs) => {
          const rows = records.filter((r) => matches(r, where));
          for (const row of rows) Object.assign(row, data);
          return Promise.resolve({ count: rows.length });
        }),
        update: jest.fn(({ where, data }: WriteArgs) => {
          const row = records.find((r) => r.id === where.id);
          if (!row) return Promise.reject(new Error('not found'));
          Object.assign(row, data);
          return Promise.resolve(row);
        }),
      },
      // Q7 — the open payout set by amount + approvedAt window, answered
      // from the literal query's bound values [amount, from, to, account, limit].
      $queryRaw: jest.fn((sql: Prisma.Sql) => {
        const [amount, from, to, account, limit] = sql.values as [
          string,
          Date,
          Date,
          string,
          number,
        ];
        const open = all().filter(
          (w) =>
            w.status === WithdrawalStatus.APPROVED &&
            w.bankCheckedAt === null &&
            w.transferTransactionCode === null &&
            time(w.approvedAt) >= from.getTime() &&
            time(w.approvedAt) <= to.getTime() &&
            w.amount instanceof Prisma.Decimal &&
            w.amount.toFixed(2) === amount &&
            (w.transferPaymentAccountId === null ||
              w.transferPaymentAccountId === account),
        );
        return Promise.resolve(open.slice(0, limit).map((w) => ({ ...w })));
      }),
      wallet: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ balance: new Prisma.Decimal(0) }),
      },
      transaction: { create: jest.fn().mockResolvedValue({}) },
      notification: {
        create: jest.fn().mockResolvedValue({
          id: 'n-27',
          type: 'WITHDRAWAL_APPROVED',
          title: 'Withdrawal approved',
          message: 'm',
          payload: {},
          isRead: false,
          createdAt: new Date(),
        }),
      },
      // Present only so a test can prove nothing here ever writes the
      // payment-account ledger directly.
      paymentAccount: { update: jest.fn() },
      paymentAccountTransaction: { create: jest.fn() },
      $transaction: jest.fn((arg: unknown): Promise<unknown> =>
        typeof arg === 'function'
          ? Promise.resolve((arg as (tx: unknown) => unknown)(fake))
          : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    prisma = fake;
    gateway = {
      notifyAdminsWithdrawalCreated: jest.fn(),
      notifyUserWithdrawalUpdated: jest.fn(),
      notifyAdminsWithdrawalUpdated: jest.fn(),
      notifyUserNotificationCreated: jest.fn(),
      notifyUserBalanceUpdated: jest.fn(),
      notifyAdminsPaymentAccountUpdated: jest.fn(),
      notifyAdminsWithdrawalVerificationUpdated: jest.fn(),
      notifyAdminsBankTransactionUpdated: jest.fn(),
      notifyAdminsBankTransactionCreated: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    // The real sync claims transferPaymentAccountId when the pick changes
    // and no-ops otherwise (payment-account-ledger.service.spec.ts); the
    // column write is mirrored here, the ledger rows are not.
    ledger = {
      syncWithdrawalLink: jest.fn(
        (_tx: unknown, row: { id: string }, accountId: string | null) => {
          withdrawal(row.id).transferPaymentAccountId = accountId;
          return Promise.resolve();
        },
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WithdrawalsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: WalletService,
          useValue: {
            getByUserId: jest.fn(),
            debitWithinTransaction: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: RealtimeGateway, useValue: gateway },
        {
          provide: FinanceSettingsService,
          useValue: { getLimits: jest.fn().mockResolvedValue({}) },
        },
        { provide: PaymentAccountLedgerService, useValue: ledger },
        { provide: AuditService, useValue: audit },
        {
          provide: MinioService,
          useValue: { deleteObject: jest.fn(), getObjectStream: jest.fn() },
        },
        { provide: StorageService, useValue: storageStub },
        // Not reached: these suites never create a withdrawal.
        {
          provide: WithdrawalCodeService,
          useValue: { assertValidForWithdrawal: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(WithdrawalsService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const bankMatchAudits = () =>
    (audit.record.mock.calls as [{ action: string }][])
      .map(([input]) => input)
      .filter((input) => input.action === 'withdrawal.bank_match');

  /** (9) — no user message, no ledger write, beyond what approve itself sends. */
  function expectNoUserOrLedgerSideEffects(approvals: number) {
    expect(gateway.notifyUserWithdrawalUpdated).toHaveBeenCalledTimes(
      approvals,
    );
    expect(gateway.notifyUserNotificationCreated).toHaveBeenCalledTimes(
      approvals,
    );
    expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledTimes(approvals);
    expect(prisma.notification.create).toHaveBeenCalledTimes(approvals);
    expect(prisma.paymentAccount.update).not.toHaveBeenCalled();
    expect(prisma.paymentAccountTransaction.create).not.toHaveBeenCalled();
    for (const [input] of prisma.withdrawal.updateMany.mock
      .calls as WriteArgs[][]) {
      expect(input.data).not.toHaveProperty('transferPaymentAccountId');
      expect(input.data).not.toHaveProperty('status', 'REJECTED');
    }
  }

  it('27 Sep order — sent, posted (parked UNMATCHED), approved 73 s after the bank time: the approval claims the parked record', async () => {
    records.push(sentRecord());
    withdrawals.set('wd-27', withdrawalRow());
    const approvedAt = new Date(BANK_AT.getTime() + 73 * SECOND);
    at(approvedAt);

    const result = await service.approve('wd-27', ADMIN);

    // Exactly the parked records whose ingestion window now holds this approval.
    expect(prisma.bankTransaction.findMany).toHaveBeenCalledWith({
      where: {
        direction: 'SENT',
        state: { in: ['UNMATCHED', 'AMBIGUOUS'] },
        linkedWithdrawalId: null,
        linkedDepositId: null,
        amount: new Prisma.Decimal(50000),
        occurredAt: {
          gte: new Date(approvedAt.getTime() - CLOCK_SKEW_MS),
          lte: approvedAt,
        },
      },
      orderBy: { occurredAt: 'asc' },
      take: 5,
    });
    expect(records[0]).toMatchObject({
      state: 'MATCHED',
      linkedWithdrawalId: 'wd-27',
    });
    expect(withdrawal('wd-27')).toMatchObject({
      status: WithdrawalStatus.APPROVED,
      matchStatus: 'MATCHED',
      riskLevel: 'LOW',
      riskReasons: [],
      transferAmount: new Prisma.Decimal(50000),
      transferTransactionCode: 'AB12CD',
      transferTransactionTime: '01:37:01',
      transferTransactionAt: BANK_AT,
      transferEventKey: EVENT_KEY,
      transferPaymentAccountId: null,
    });
    expect(withdrawal('wd-27').bankCheckedAt).toBeInstanceOf(Date);
    // The response and the admin realtime reflect the match.
    expect(result).toMatchObject({
      status: WithdrawalStatus.APPROVED,
      matchStatus: 'MATCHED',
      bankTransactionId: 'tx-27',
    });
    expect(
      gateway.notifyAdminsWithdrawalVerificationUpdated,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'wd-27',
        matchStatus: 'MATCHED',
        bankTransactionId: 'tx-27',
      }),
    );
    expect(gateway.notifyAdminsBankTransactionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tx-27',
        state: 'MATCHED',
        view: 'MATCHED',
        linkedWithdrawalId: 'wd-27',
      }),
    );
    expect(bankMatchAudits()).toEqual([
      expect.objectContaining({
        actor: ADMIN,
        metadata: expect.objectContaining({
          trigger: 'withdrawal_approve',
          matchKey: 'amount_window',
          bankTransactionId: 'tx-27',
        }),
      }),
    ]);
    expectNoUserOrLedgerSideEffects(1);
    expect(ledger.syncWithdrawalLink).not.toHaveBeenCalled();
  });

  it('same order but approved 6 min after the bank time: the approval leaves the record parked; typing the correct code (any case) then claims it', async () => {
    records.push(sentRecord());
    withdrawals.set('wd-27', withdrawalRow());
    at(new Date(BANK_AT.getTime() + 6 * MINUTE));

    const approved = await service.approve('wd-27', ADMIN);

    expect(approved.matchStatus).toBe('UNVERIFIED');
    expect(records[0]).toMatchObject({
      state: 'UNMATCHED',
      linkedWithdrawalId: null,
    });
    expect(withdrawal('wd-27').bankCheckedAt).toBeNull();
    expect(bankMatchAudits()).toHaveLength(0);

    at(new Date(BANK_AT.getTime() + 10 * MINUTE));
    const saved = await service.updateTransferAccount(
      'wd-27',
      { ...dto, transferTransactionCode: 'ab12cd' },
      ADMIN,
    );

    expect(records[0]).toMatchObject({
      state: 'MATCHED',
      linkedWithdrawalId: 'wd-27',
    });
    // The typed code is kept as typed; the time and amount are the bank's.
    expect(withdrawal('wd-27')).toMatchObject({
      matchStatus: 'MATCHED',
      transferTransactionCode: 'ab12cd',
      transferTransactionTime: '01:37:01',
      transferEventKey: EVENT_KEY,
      transferPaymentAccountId: ACCOUNT,
    });
    expect(saved).toMatchObject({
      matchStatus: 'MATCHED',
      transferTransactionCode: 'ab12cd',
      transferTransactionTime: '01:37:01',
      bankTransactionId: 'tx-27',
      hasBankScreenshot: false,
    });
    expect(bankMatchAudits()).toEqual([
      expect.objectContaining({
        actor: ADMIN,
        metadata: expect.objectContaining({
          trigger: 'transfer_account_update',
          matchKey: 'transaction_code',
          bankTransactionId: 'tx-27',
        }),
      }),
    ]);
    expect(
      gateway.notifyAdminsWithdrawalVerificationUpdated,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wd-27', matchStatus: 'MATCHED' }),
    );
    expect(gateway.notifyAdminsBankTransactionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tx-27', view: 'MATCHED' }),
    );
    // Other admin sessions get the row as it now stands (bank time).
    expect(gateway.notifyAdminsWithdrawalUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'wd-27',
        change: 'transfer_account',
        transferTransactionCode: 'ab12cd',
        transferTransactionTime: '01:37:01',
      }),
    );
    // The ledger sync ran once, for the save itself — never for the match.
    expect(ledger.syncWithdrawalLink).toHaveBeenCalledTimes(1);
    expect(ledger.syncWithdrawalLink).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ id: 'wd-27' }),
      ACCOUNT,
      'ab12cd',
      'admin-1',
    );
    expectNoUserOrLedgerSideEffects(1);
  });

  it('the stuck 27 Sep row after deploy: re-saving the UNCHANGED form re-runs the look-back and claims the parked record', async () => {
    records.push(sentRecord());
    withdrawals.set(
      'wd-27',
      withdrawalRow({
        status: WithdrawalStatus.APPROVED,
        approvedAt: new Date(BANK_AT.getTime() + 72 * SECOND),
        transferAccountType: 'KBZPay',
        transferAccountSubname: 'K1',
        transferAccountName: 'MyanFlix',
        transferAccountNumber: '09999999999',
        transferTransactionCode: 'AB12CD',
        transferTransactionTime: '01:37:30',
        transferPaymentAccountId: ACCOUNT,
      }),
    );
    at(new Date('2026-09-28T09:00:00.000Z'));

    const saved = await service.updateTransferAccount('wd-27', dto, ADMIN);

    expect(saved.matchStatus).toBe('MATCHED');
    expect(records[0]).toMatchObject({
      state: 'MATCHED',
      linkedWithdrawalId: 'wd-27',
    });
    // Same account → the real sync is a no-op; the column is unchanged.
    expect(ledger.syncWithdrawalLink).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ transferPaymentAccountId: ACCOUNT }),
      ACCOUNT,
      'AB12CD',
      'admin-1',
    );
    expect(withdrawal('wd-27').transferPaymentAccountId).toBe(ACCOUNT);
    expectNoUserOrLedgerSideEffects(0);

    // A second unchanged save is harmless: already bank-checked, nothing re-claimed.
    audit.record.mockClear();
    const again = await service.updateTransferAccount('wd-27', dto, ADMIN);
    expect(again.matchStatus).toBe('MATCHED');
    expect(bankMatchAudits()).toHaveLength(0);
  });

  it('a typed code that names a parked record of a DIFFERENT amount: AMOUNT_MISMATCH (SUSPICIOUS), no link — the save itself succeeds', async () => {
    records.push(sentRecord({ amount: new Prisma.Decimal(45000) }));
    withdrawals.set(
      'wd-27',
      withdrawalRow({
        status: WithdrawalStatus.APPROVED,
        approvedAt: new Date(BANK_AT.getTime() + 6 * MINUTE),
      }),
    );

    const saved = await service.updateTransferAccount('wd-27', dto, ADMIN);

    expect(saved).toMatchObject({
      transferTransactionCode: 'AB12CD',
      matchStatus: 'SUSPICIOUS',
      riskLevel: 'HIGH',
      riskReasons: ['AMOUNT_MISMATCH'],
      bankCheckedAt: null,
    });
    expect(records[0]).toMatchObject({
      state: 'UNMATCHED',
      linkedWithdrawalId: null,
    });
    expect(bankMatchAudits()).toHaveLength(0);
    expect(
      gateway.notifyAdminsWithdrawalVerificationUpdated,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wd-27', matchStatus: 'SUSPICIOUS' }),
    );
  });

  it('two parked records share the last 6: the typed code claims nothing and logs counts only', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    records.push(
      sentRecord(),
      sentRecord({
        id: 'tx-28',
        idempotencyKey: 'f'.repeat(64),
        txCode: '01003959279999AB12CD',
        occurredAt: new Date(BANK_AT.getTime() + 2 * MINUTE),
      }),
    );
    withdrawals.set(
      'wd-27',
      withdrawalRow({
        status: WithdrawalStatus.APPROVED,
        approvedAt: new Date(BANK_AT.getTime() + 6 * MINUTE),
      }),
    );

    const saved = await service.updateTransferAccount('wd-27', dto, ADMIN);

    expect(saved.matchStatus).toBe('UNVERIFIED');
    expect(records.map((r) => r.state)).toEqual(['UNMATCHED', 'UNMATCHED']);
    expect(bankMatchAudits()).toHaveLength(0);
    const lines = log.mock.calls.map(([message]) => String(message));
    const line = lines.find((message) => message.includes('share'));
    expect(line).toBeDefined();
    expect(line).toContain('2');
    expect(line).not.toContain('AB12CD');
    expect(line).not.toContain('50000');
  });

  it('two approved same-amount payouts + one parked record: the approval leaves it AMBIGUOUS and claims nothing', async () => {
    // Parked AMBIGUOUS at ingestion; wd-28 is still an open candidate.
    records.push(sentRecord({ state: 'AMBIGUOUS' }));
    withdrawals.set(
      'wd-28',
      withdrawalRow({
        id: 'wd-28',
        userId: 'user-28',
        status: WithdrawalStatus.APPROVED,
        approvedAt: new Date(BANK_AT.getTime() - 3_600_000),
        matchStatus: 'PENDING_REVIEW',
        riskLevel: 'MEDIUM',
        riskReasons: ['AMBIGUOUS_MATCH'],
      }),
    );
    withdrawals.set('wd-27', withdrawalRow());
    at(new Date(BANK_AT.getTime() + 73 * SECOND));

    const result = await service.approve('wd-27', ADMIN);

    expect(records[0]).toMatchObject({
      state: 'AMBIGUOUS',
      linkedWithdrawalId: null,
    });
    expect(bankMatchAudits()).toHaveLength(0);
    expect(withdrawal('wd-27')).toMatchObject({
      bankCheckedAt: null,
      matchStatus: 'PENDING_REVIEW',
      riskReasons: ['AMBIGUOUS_MATCH'],
    });
    expect(withdrawal('wd-28').bankCheckedAt).toBeNull();
    expect(result.matchStatus).toBe('PENDING_REVIEW');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.risk_update',
        target: { type: 'withdrawal', id: 'wd-27' },
        metadata: expect.objectContaining({
          trigger: 'ambiguous_match',
          cause: 'withdrawal_approve',
          candidateIds: expect.arrayContaining(['wd-27', 'wd-28']),
        }),
      }),
    );
    expectNoUserOrLedgerSideEffects(1);
  });

  describe('a failure inside the look-back never fails the approval or the save', () => {
    let error: jest.SpyInstance;
    beforeEach(() => {
      error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
    });

    it('approve: the parked-record lookup throws', async () => {
      records.push(sentRecord());
      withdrawals.set('wd-27', withdrawalRow());
      at(new Date(BANK_AT.getTime() + 73 * SECOND));
      prisma.bankTransaction.findMany.mockRejectedValueOnce(
        new Error('connection reset'),
      );

      const result = await service.approve('wd-27', ADMIN);

      expect(result).toMatchObject({
        status: WithdrawalStatus.APPROVED,
        matchStatus: 'UNVERIFIED',
      });
      expect(records[0].state).toBe('UNMATCHED');
      expect(error).toHaveBeenCalled();
      expect(gateway.notifyUserWithdrawalUpdated).toHaveBeenCalledTimes(1);
    });

    it('approve: the per-record re-run throws', async () => {
      records.push(sentRecord());
      withdrawals.set('wd-27', withdrawalRow());
      at(new Date(BANK_AT.getTime() + 73 * SECOND));
      prisma.$transaction
        .mockImplementationOnce((fn: (tx: unknown) => unknown) => fn(prisma))
        .mockImplementationOnce(() => Promise.reject(new Error('deadlock')));

      const result = await service.approve('wd-27', ADMIN);

      expect(result.status).toBe(WithdrawalStatus.APPROVED);
      expect(error).toHaveBeenCalled();
    });

    it('updateTransferAccount: the typed-code look-back throws', async () => {
      records.push(sentRecord());
      withdrawals.set(
        'wd-27',
        withdrawalRow({
          status: WithdrawalStatus.APPROVED,
          approvedAt: new Date(BANK_AT.getTime() + 6 * MINUTE),
        }),
      );
      prisma.$transaction
        .mockImplementationOnce((fn: (tx: unknown) => unknown) => fn(prisma))
        .mockImplementationOnce(() => Promise.reject(new Error('deadlock')));

      const saved = await service.updateTransferAccount('wd-27', dto, ADMIN);

      expect(saved).toMatchObject({
        transferTransactionCode: 'AB12CD',
        matchStatus: 'UNVERIFIED',
      });
      expect(records[0].state).toBe('UNMATCHED');
      expect(error).toHaveBeenCalled();
      expect(gateway.notifyAdminsWithdrawalUpdated).toHaveBeenCalled();
    });
  });

  it('W4 — on a bank-checked row, a typed code that differs from the bank record adds CODE_MISMATCH (flag, never block); typing the bank code again removes it', async () => {
    records.push(
      sentRecord({
        state: 'MATCHED',
        linkedWithdrawalId: 'wd-27',
        matchedAt: POSTED_AT,
      }),
    );
    withdrawals.set(
      'wd-27',
      withdrawalRow({
        status: WithdrawalStatus.APPROVED,
        approvedAt: new Date(BANK_AT.getTime() - 2 * MINUTE),
        bankCheckedAt: POSTED_AT,
        transferAmount: new Prisma.Decimal(50000),
        transferTransactionCode: 'AB12CD',
        transferTransactionTime: '01:37:01',
        transferTransactionAt: BANK_AT,
        transferEventKey: EVENT_KEY,
        matchStatus: 'MATCHED',
        riskLevel: 'LOW',
      }),
    );

    const wrong = await service.updateTransferAccount(
      'wd-27',
      { ...dto, transferTransactionCode: 'XY34ZW' },
      ADMIN,
    );

    // Saved as typed, flagged, still bank-checked and linked.
    expect(wrong).toMatchObject({
      transferTransactionCode: 'XY34ZW',
      matchStatus: 'SUSPICIOUS',
      riskLevel: 'MEDIUM',
      riskReasons: ['CODE_MISMATCH'],
      bankTransactionId: 'tx-27',
    });
    expect(withdrawal('wd-27')).toMatchObject({
      transferTransactionCode: 'XY34ZW',
      riskReasons: ['CODE_MISMATCH'],
      bankCheckedAt: POSTED_AT,
    });
    expect(records[0]).toMatchObject({
      state: 'MATCHED',
      linkedWithdrawalId: 'wd-27',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.risk_update',
        target: { type: 'withdrawal', id: 'wd-27' },
        metadata: expect.objectContaining({
          trigger: 'transfer_account_update',
          bankTransactionId: 'tx-27',
        }),
      }),
    );
    expect(
      gateway.notifyAdminsWithdrawalVerificationUpdated,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wd-27', matchStatus: 'SUSPICIOUS' }),
    );

    const fixed = await service.updateTransferAccount(
      'wd-27',
      { ...dto, transferTransactionCode: 'ab12cd' },
      ADMIN,
    );

    expect(fixed).toMatchObject({
      transferTransactionCode: 'ab12cd',
      matchStatus: 'MATCHED',
      riskLevel: 'LOW',
      riskReasons: [],
    });
    expect(bankMatchAudits()).toHaveLength(0);
    expectNoUserOrLedgerSideEffects(0);
  });
});
