import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { DepositStatus, NotificationType, TransactionType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FinanceSettingsService } from '../finance-settings/finance-settings.service';
import { PaymentAccountLedgerService } from '../payment-accounts/payment-account-ledger.service';
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
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
  };
  let walletService: { creditWithinTransaction: jest.Mock };
  let gateway: {
    notifyAdminsDepositCreated: jest.Mock;
    notifyUserDepositUpdated: jest.Mock;
    notifyUserNotificationCreated: jest.Mock;
    notifyUserBalanceUpdated: jest.Mock;
    notifyAdminsPaymentAccountUpdated: jest.Mock;
  };
  let financeSettingsService: { getLimits: jest.Mock };
  let paymentAccountLedgerService: { syncDepositLink: jest.Mock };

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
    paymentAccountLedgerService = { syncDepositLink: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepositsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: FinanceSettingsService, useValue: financeSettingsService },
        { provide: PaymentAccountLedgerService, useValue: paymentAccountLedgerService },
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
        data: { userId: 'user-1', amount: 5000, paymentMethod: 'KBZ Pay', reference: '000123' },
      });
    });

    it('persists the selected payment account name and forwards it to the admin realtime notification', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockResolvedValue(makeDeposit({ accountName: 'MyanFlix Co., Ltd.' }));
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
      prisma.deposit.create.mockResolvedValue(makeDeposit({ reference: '000123' }));
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      const result = await service.create('user-1', {
        amount: 5000,
        paymentMethod: 'KBZ Pay',
        reference: '000123',
      });

      expect(result.reference).toBe('000123');
    });

    it('rejects a reference already used by a PENDING or APPROVED deposit', async () => {
      prisma.deposit.findFirst.mockResolvedValue(makeDeposit({ status: DepositStatus.PENDING }));

      await expect(
        service.create('user-1', { amount: 5000, paymentMethod: 'KBZ Pay', reference: '000123' }),
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
        service.create('user-1', { amount: 5000, paymentMethod: 'KBZ Pay', reference: '000123' }),
      ).resolves.toBeDefined();
      expect(prisma.deposit.findFirst).toHaveBeenCalledWith({
        where: { reference: '000123', status: { in: [DepositStatus.PENDING, DepositStatus.APPROVED] } },
      });
    });

    it('notifies admins in real time after a successful create', async () => {
      prisma.deposit.findFirst.mockResolvedValue(null);
      prisma.deposit.create.mockResolvedValue(makeDeposit());
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      await service.create('user-1', { amount: 5000, paymentMethod: 'KBZ Pay', reference: '000123' });

      expect(gateway.notifyAdminsDepositCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'deposit-1', username: 'john', amount: 5000, status: DepositStatus.PENDING }),
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
        service.create('user-1', { amount: 5000, paymentMethod: 'KBZ Pay', reference: '000123' }),
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
        service.create('user-1', { amount: 200000, paymentMethod: 'KBZ Pay', reference: '000123' }),
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
      prisma.deposit.create.mockResolvedValue(makeDeposit({ amount: new Prisma.Decimal(5000) }));
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      await expect(
        service.create('user-1', { amount: 5000, paymentMethod: 'KBZ Pay', reference: '000123' }),
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
      expect(prisma.deposit.count).toHaveBeenCalledWith({ where: expectedWhere });
    });

    it('leaves createdAt undefined when no date range is given, so existing queries are untouched', async () => {
      await service.findAllAdmin({});

      expect(prisma.deposit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: undefined, userId: undefined, createdAt: undefined },
        }),
      );
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
        makeDeposit({ status: DepositStatus.APPROVED, approvedByUserId: 'admin-1', approvedAt: new Date() }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
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
      expect(walletService.creditWithinTransaction).toHaveBeenCalledWith(prisma, 'user-1', 5000);
      expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(DepositStatus.APPROVED);
      expect(gateway.notifyUserDepositUpdated).toHaveBeenCalledTimes(1);
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith('user-1', 10000);
    });

    it('persists wallet balance snapshots on the deposit row, derived from the post-credit wallet (before = after - amount)', async () => {
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit());
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(12500) });
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
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
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
          include: { user: { select: { id: true, username: true, phone: true } } },
        }),
      );
      expect(result.user).toEqual({ id: 'user-1', username: 'john', phone: '+959123456' });
    });

    it('throws ConflictException and never credits the wallet when the deposit is no longer PENDING', async () => {
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit({ status: DepositStatus.APPROVED }));
      // The atomic updateMany's WHERE clause (status: PENDING) matches 0
      // rows once the deposit has already moved past PENDING — this is the
      // core guard against a concurrent double-approval race.
      prisma.deposit.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approve('deposit-1', admin)).rejects.toThrow(ConflictException);
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a nonexistent deposit', async () => {
      prisma.deposit.findUnique.mockResolvedValue(null);

      await expect(service.approve('missing', admin)).rejects.toThrow(NotFoundException);
      expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
    });

    it('credits the depositor-declared payment account automatically, without a separate admin step', async () => {
      const pending = makeDeposit({ declaredPaymentAccountId: 'acct-1', receivingPaymentAccountId: null });
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED, declaredPaymentAccountId: 'acct-1', receivingPaymentAccountId: 'acct-1' }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
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
      const pending = makeDeposit({ declaredPaymentAccountId: null, receivingPaymentAccountId: null });
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
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
      const pending = makeDeposit({ declaredPaymentAccountId: 'acct-declared', receivingPaymentAccountId: null });
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED, receivingPaymentAccountId: 'acct-override' }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        type: 'DEPOSIT_APPROVED',
        title: 't',
        message: 'm',
        payload: {},
        isRead: false,
        createdAt: new Date(),
      });

      await service.approve('deposit-1', admin, { paymentAccountId: 'acct-override' });

      expect(paymentAccountLedgerService.syncDepositLink).toHaveBeenCalledWith(
        prisma,
        pending,
        'acct-override',
        pending.reference,
        'admin-1',
      );
    });

    it('lets the admin explicitly skip crediting any account, even when one was declared', async () => {
      const pending = makeDeposit({ declaredPaymentAccountId: 'acct-declared', receivingPaymentAccountId: null });
      prisma.deposit.findUnique.mockResolvedValue(pending);
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED }),
      );
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
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
        makeDeposit({ status: DepositStatus.REJECTED, rejectionReason: 'Reference does not match' }),
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

      const result = await service.reject('deposit-1', admin, { reason: 'Reference does not match' });

      expect(result.status).toBe(DepositStatus.REJECTED);
      expect(result.rejectionReason).toBe('Reference does not match');
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it('throws ConflictException on double-rejection (or reject-after-approve)', async () => {
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit({ status: DepositStatus.REJECTED }));
      prisma.deposit.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.reject('deposit-1', admin, { reason: 'x' })).rejects.toThrow(ConflictException);
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
          include: { user: { select: { id: true, username: true, phone: true } } },
        }),
      );
      expect(result.user).toEqual({ id: 'user-1', username: 'john', phone: '+959123456' });
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
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit({ status: DepositStatus.PENDING }));

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
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit({ status: DepositStatus.APPROVED }));
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
          user: { select: { id: true, username: true, phone: true } },
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
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit({ status: DepositStatus.APPROVED }));
      prisma.deposit.update.mockResolvedValue(makeDeposit({ status: DepositStatus.APPROVED }));

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

      await service.updateReceivingAccount('deposit-1', { paymentAccountId: 'acct-9' }, admin);

      // The ledger link is posted with the STORED reference, and the update
      // writes no free-text keys at all.
      expect(paymentAccountLedgerService.syncDepositLink).toHaveBeenCalledWith(
        prisma,
        stored,
        'acct-9',
        'ABC123',
        'admin-1',
      );
      expect(prisma.deposit.update).toHaveBeenCalledWith(expect.objectContaining({ data: {} }));
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
          data: expect.not.objectContaining({ receivingTransactionCode: expect.anything() }),
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
      prisma.deposit.findFirst.mockResolvedValue(makeDeposit({ status: DepositStatus.PENDING }));

      await expect(service.createManual(dto, admin)).rejects.toThrow(ConflictException);

      expect(prisma.deposit.create).not.toHaveBeenCalled();
      expect(paymentAccountLedgerService.syncDepositLink).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('rejects an unknown destination account with NotFound, writing nothing', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.paymentAccount.findUnique.mockResolvedValue(null);

      await expect(service.createManual(dto, admin)).rejects.toThrow(NotFoundException);

      expect(prisma.deposit.create).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
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
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
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
      expect(walletService.creditWithinTransaction).toHaveBeenCalledWith(prisma, 'user-1', 5000);
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
          message: 'Your deposit of 5000 Ks has been approved and your balance has been updated.',
        }),
      });
      expect(result.status).toBe(DepositStatus.APPROVED);
      expect(result.approvedByUserId).toBe('admin-1');
      expect(result.user).toEqual({ id: 'user-1', username: 'john', phone: '+959123456' });
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
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(5000) });
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
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
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
      expect(gateway.notifyUserNotificationCreated).toHaveBeenCalledWith('user-1', {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        payload: notification.payload,
        isRead: notification.isRead,
        createdAt: notification.createdAt,
      });
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith('user-1', 10000);
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
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
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

      await expect(service.createManual(dto, admin)).rejects.toThrow(NotFoundException);
      expect(prisma.deposit.create).not.toHaveBeenCalled();
      expect(paymentAccountLedgerService.syncDepositLink).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('propagates a ledger NotFound (bogus destination account) before any wallet credit, and emits nothing', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.deposit.create.mockResolvedValue(
        makeDeposit({ status: DepositStatus.APPROVED, approvedByUserId: 'admin-1', approvedAt: new Date() }),
      );
      paymentAccountLedgerService.syncDepositLink.mockRejectedValue(
        new NotFoundException('Payment account not found'),
      );

      await expect(service.createManual(dto, admin)).rejects.toThrow(NotFoundException);
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
