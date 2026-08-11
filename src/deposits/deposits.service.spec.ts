import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { DepositStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FinanceSettingsService } from '../finance-settings/finance-settings.service';
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
    };
    wallet: { findUniqueOrThrow: jest.Mock };
    transaction: { create: jest.Mock };
    notification: { create: jest.Mock };
    user: { findUniqueOrThrow: jest.Mock };
    $transaction: jest.Mock;
  };
  let walletService: { creditWithinTransaction: jest.Mock };
  let gateway: {
    notifyAdminsDepositCreated: jest.Mock;
    notifyUserDepositUpdated: jest.Mock;
    notifyUserNotificationCreated: jest.Mock;
    notifyUserBalanceUpdated: jest.Mock;
  };
  let financeSettingsService: { getLimits: jest.Mock };

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
      },
      wallet: { findUniqueOrThrow: jest.fn() },
      transaction: { create: jest.fn() },
      notification: { create: jest.fn() },
      user: { findUniqueOrThrow: jest.fn() },
      // The real prisma.$transaction(callback) runs the callback with a tx
      // client — here `tx` is just `prisma` itself, since every mocked
      // method lives directly on this object (mirrors how the real
      // PrismaService's tx client exposes the same model delegates).
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
    };
    walletService = { creditWithinTransaction: jest.fn() };
    gateway = {
      notifyAdminsDepositCreated: jest.fn(),
      notifyUserDepositUpdated: jest.fn(),
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
        DepositsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: FinanceSettingsService, useValue: financeSettingsService },
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

  describe('approve', () => {
    const admin = { id: 'admin-1', email: 'a@a.com', username: 'admin', role: 'ADMIN' } as never;

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

    it('includes the depositing user on the response, so the admin table never shows "Unknown user" right after approving', async () => {
      prisma.deposit.findUnique.mockResolvedValue(makeDeposit());
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.deposit.findUniqueOrThrow.mockResolvedValue(
        makeDeposit({
          status: DepositStatus.APPROVED,
          user: { id: 'user-1', username: 'john', email: 'john@example.com', phone: '+959123456' },
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
          include: { user: { select: { id: true, username: true, email: true, phone: true } } },
        }),
      );
      expect(result.user).toEqual({ id: 'user-1', username: 'john', email: 'john@example.com', phone: '+959123456' });
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
  });

  describe('reject', () => {
    const admin = { id: 'admin-1', email: 'a@a.com', username: 'admin', role: 'ADMIN' } as never;

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
          user: { id: 'user-1', username: 'john', email: 'john@example.com', phone: '+959123456' },
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
          include: { user: { select: { id: true, username: true, email: true, phone: true } } },
        }),
      );
      expect(result.user).toEqual({ id: 'user-1', username: 'john', email: 'john@example.com', phone: '+959123456' });
    });
  });
});
