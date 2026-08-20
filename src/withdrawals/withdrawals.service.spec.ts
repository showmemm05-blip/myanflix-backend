import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { WithdrawalStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FinanceSettingsService } from '../finance-settings/finance-settings.service';
import { PaymentAccountLedgerService } from '../payment-accounts/payment-account-ledger.service';
import { WithdrawalsService } from './withdrawals.service';

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
    transaction: { create: jest.Mock };
    notification: { create: jest.Mock };
    user: { findUniqueOrThrow: jest.Mock };
    $transaction: jest.Mock;
  };
  let walletService: {
    getByUserId: jest.Mock;
    debitWithinTransaction: jest.Mock;
  };
  let gateway: {
    notifyAdminsWithdrawalCreated: jest.Mock;
    notifyUserWithdrawalUpdated: jest.Mock;
    notifyUserNotificationCreated: jest.Mock;
    notifyUserBalanceUpdated: jest.Mock;
    notifyAdminsPaymentAccountUpdated: jest.Mock;
  };
  let financeSettingsService: { getLimits: jest.Mock };
  let paymentAccountLedgerService: { syncWithdrawalLink: jest.Mock };

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
      transaction: { create: jest.fn() },
      notification: { create: jest.fn() },
      user: { findUniqueOrThrow: jest.fn() },
      // Both call styles are in use: the callback form for the write paths —
      // where `tx` is just `prisma` itself, since every mocked method lives
      // directly on this object (mirrors deposits.service.spec.ts) — and the
      // array form for the list queries' findMany+count pair.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    walletService = { getByUserId: jest.fn(), debitWithinTransaction: jest.fn() };
    gateway = {
      notifyAdminsWithdrawalCreated: jest.fn(),
      notifyUserWithdrawalUpdated: jest.fn(),
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
    // tests stay focused on WithdrawalsService's own orchestration.
    paymentAccountLedgerService = { syncWithdrawalLink: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WithdrawalsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: FinanceSettingsService, useValue: financeSettingsService },
        { provide: PaymentAccountLedgerService, useValue: paymentAccountLedgerService },
      ],
    }).compile();

    service = module.get(WithdrawalsService);
  });

  describe('create', () => {
    it('creates a PENDING withdrawal without touching the wallet, when balance is sufficient', async () => {
      walletService.getByUserId.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
      const withdrawal = makeWithdrawal();
      prisma.withdrawal.create.mockResolvedValue(withdrawal);
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      const result = await service.create('user-1', {
        amount: 5000,
        accountType: 'KBZPay',
        accountName: 'Ko Ko',
        accountNumber: '09123456789',
      });

      expect(result.status).toBe(WithdrawalStatus.PENDING);
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.withdrawal.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          amount: 5000,
          accountType: 'KBZPay',
          accountName: 'Ko Ko',
          accountNumber: '09123456789',
          bankName: null,
        },
      });
    });

    it('stores the payout details from the request itself, never from the requester\'s profile', async () => {
      walletService.getByUserId.mockResolvedValue({ balance: new Prisma.Decimal(100000) });
      prisma.withdrawal.create.mockResolvedValue(makeWithdrawal());
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      await service.create('user-1', {
        amount: 5000,
        accountType: 'Bank Account',
        accountName: 'Daw Mya',
        accountNumber: '09999999999',
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
        },
      });
      // The only profile read in create() is for the username on the realtime
      // notification — it must never be selecting payout details.
      expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { username: true, displayName: true },
      });
    });

    it('announces the withdrawal to admins with the display name next to the raw username', async () => {
      walletService.getByUserId.mockResolvedValue({ balance: new Prisma.Decimal(100000) });
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
      walletService.getByUserId.mockResolvedValue({ balance: new Prisma.Decimal(100000) });
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
      });

      expect(gateway.notifyAdminsWithdrawalCreated).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'john', displayName: null }),
      );
    });

    it('rejects a request for more than the available wallet balance, without creating anything', async () => {
      walletService.getByUserId.mockResolvedValue({ balance: new Prisma.Decimal(1000) });

      await expect(
        service.create('user-1', {
          amount: 5000,
          accountType: 'KBZPay',
          accountName: 'Ko Ko',
          accountNumber: '09123456789',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.withdrawal.create).not.toHaveBeenCalled();
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
      walletService.getByUserId.mockResolvedValue({ balance: new Prisma.Decimal(10000) });
      prisma.withdrawal.create.mockResolvedValue(makeWithdrawal());
      prisma.user.findUniqueOrThrow.mockResolvedValue({ username: 'john' });

      await expect(
        service.create('user-1', {
          amount: 5000,
          accountType: 'KBZPay',
          accountName: 'Ko Ko',
          accountNumber: '09123456789',
        }),
      ).resolves.toBeDefined();
      expect(prisma.withdrawal.create).toHaveBeenCalled();
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
      expect(prisma.withdrawal.count).toHaveBeenCalledWith({ where: expectedWhere });
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

    it('throws ConflictException when the withdrawal is no longer PENDING (double-processing guard)', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(makeWithdrawal());
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approve('withdrawal-1', { id: 'admin-1' } as never),
      ).rejects.toThrow(ConflictException);
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
    });

    it('atomically claims, debits the wallet, and records a WITHDRAWAL transaction', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(makeWithdrawal());
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
      walletService.debitWithinTransaction.mockResolvedValue({ balance: new Prisma.Decimal(5000) });
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
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({ balance: new Prisma.Decimal(5000) });

      const result = await service.approve('withdrawal-1', { id: 'admin-1' } as never);

      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        prisma,
        'user-1',
        5000,
      );
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'user-1', type: 'WITHDRAWAL', status: 'COMPLETED' }),
      });
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith('user-1', 5000);
      expect(result.status).toBe(WithdrawalStatus.APPROVED);
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

    it('throws ConflictException when the withdrawal is no longer PENDING', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(makeWithdrawal());
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reject('withdrawal-1', { id: 'admin-1' } as never, { reason: 'bad' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects without ever touching the wallet or the transaction ledger', async () => {
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
        ...makeWithdrawal({ status: WithdrawalStatus.REJECTED, rejectionReason: 'bad' }),
        user: { id: 'user-1', username: 'john' },
      });

      const result = await service.reject('withdrawal-1', { id: 'admin-1' } as never, {
        reason: 'bad',
      });

      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(result.status).toBe(WithdrawalStatus.REJECTED);
      expect(result.rejectionReason).toBe('bad');
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

    it('records our transfer account (incl. subname), transaction code, and transaction time without touching the user\'s own withdrawal account fields, status, wallet, or ledger', async () => {
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
            },
          },
        },
      });
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
      expect(gateway.notifyUserWithdrawalUpdated).toHaveBeenCalledWith('user-1', {
        id: 'withdrawal-1',
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
