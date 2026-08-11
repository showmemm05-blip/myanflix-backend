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
  };
  let financeSettingsService: { getLimits: jest.Mock };

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
      // The real prisma.$transaction(callback) runs the callback with a tx
      // client — here `tx` is just `prisma` itself, since every mocked
      // method lives directly on this object (mirrors deposits.service.spec.ts).
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
    };
    walletService = { getByUserId: jest.fn(), debitWithinTransaction: jest.fn() };
    gateway = {
      notifyAdminsWithdrawalCreated: jest.fn(),
      notifyUserWithdrawalUpdated: jest.fn(),
      notifyUserNotificationCreated: jest.fn(),
      notifyUserBalanceUpdated: jest.fn(),
    };
    financeSettingsService = {
      getLimits: jest.fn().mockResolvedValue({
        minDepositAmount: 0,
        maxDepositAmount: Number.MAX_SAFE_INTEGER,
        minWithdrawalAmount: 0,
        maxWithdrawalAmount: Number.MAX_SAFE_INTEGER,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WithdrawalsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: FinanceSettingsService, useValue: financeSettingsService },
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
        },
      });
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
        user: { id: 'user-1', username: 'john', email: 'j@x.com' },
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
        user: { id: 'user-1', username: 'john', email: 'j@x.com' },
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
    it('throws NotFoundException for an unknown withdrawal, without writing anything', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(null);

      await expect(
        service.updateTransferAccount('nope', {
          transferAccountType: 'KBZPay',
          transferAccountName: 'MyanFlix',
          transferAccountNumber: '09999999999',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the withdrawal is not APPROVED', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ status: WithdrawalStatus.PENDING }),
      );

      await expect(
        service.updateTransferAccount('withdrawal-1', {
          transferAccountType: 'KBZPay',
          transferAccountName: 'MyanFlix',
          transferAccountNumber: '09999999999',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    });

    it('records our transfer account without touching the user\'s own withdrawal account fields, status, wallet, or ledger', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(
        makeWithdrawal({ status: WithdrawalStatus.APPROVED }),
      );
      prisma.withdrawal.update.mockResolvedValue({
        ...makeWithdrawal({
          status: WithdrawalStatus.APPROVED,
          transferAccountType: 'KBZPay',
          transferAccountName: 'MyanFlix',
          transferAccountNumber: '09999999999',
        }),
        user: { id: 'user-1', username: 'john', email: 'j@x.com', phone: null },
      });

      const result = await service.updateTransferAccount('withdrawal-1', {
        transferAccountType: 'KBZPay',
        transferAccountName: 'MyanFlix',
        transferAccountNumber: '09999999999',
      });

      expect(prisma.withdrawal.update).toHaveBeenCalledWith({
        where: { id: 'withdrawal-1' },
        data: {
          transferAccountType: 'KBZPay',
          transferAccountName: 'MyanFlix',
          transferAccountNumber: '09999999999',
        },
        include: {
          user: { select: { id: true, username: true, email: true, phone: true } },
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
        transferAccountName: 'MyanFlix',
        transferAccountNumber: '09999999999',
      });
      // The user's own withdrawal account (what they submitted) is untouched.
      expect(result.accountName).toBe('Ko Ko');
      expect(result.transferAccountName).toBe('MyanFlix');
      expect(result.status).toBe(WithdrawalStatus.APPROVED);
    });
  });
});
