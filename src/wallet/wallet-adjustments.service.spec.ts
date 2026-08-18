import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  NotificationType,
  Prisma,
  TransactionType,
  WalletAdjustmentDirection,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { WalletService } from './wallet.service';
import { WalletAdjustmentsService } from './wallet-adjustments.service';

const KEY = 'a3f1c9de-1234-4abc-9def-0123456789ab';

function makeAdjustment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'adj-1',
    userId: 'user-1',
    direction: WalletAdjustmentDirection.CREDIT,
    amount: new Prisma.Decimal(5000),
    balanceBefore: new Prisma.Decimal(1000),
    balanceAfter: new Prisma.Decimal(6000),
    reason: 'Manual correction after support ticket #42',
    idempotencyKey: KEY,
    performedByUserId: 'admin-1',
    transactionId: 'txn-1',
    createdAt: new Date(),
    performedBy: { id: 'admin-1', username: 'superadmin' },
    ...overrides,
  };
}

function makeP2002() {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`idempotencyKey`)',
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['idempotencyKey'] },
    },
  );
}

describe('WalletAdjustmentsService', () => {
  let service: WalletAdjustmentsService;
  let prisma: {
    walletAdjustment: {
      findUnique: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    transaction: { create: jest.Mock };
    notification: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let walletService: {
    creditWithinTransaction: jest.Mock;
    debitWithinTransaction: jest.Mock;
  };
  let gateway: {
    notifyUserNotificationCreated: jest.Mock;
    notifyUserBalanceUpdated: jest.Mock;
  };

  const admin = {
    id: 'admin-1',
    username: 'superadmin',
    role: 'SUPER_ADMIN',
  } as never;

  beforeEach(async () => {
    prisma = {
      walletAdjustment: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      transaction: { create: jest.fn() },
      notification: { create: jest.fn() },
      // Same convention as the deposits/ledger specs: callback form runs
      // with `prisma` itself as the tx client; array form (used by list())
      // just awaits the already-started promises.
      $transaction: jest.fn(
        async (arg: ((tx: unknown) => unknown) | Promise<unknown>[]) =>
          typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
      ),
    };
    walletService = {
      creditWithinTransaction: jest.fn(),
      debitWithinTransaction: jest.fn(),
    };
    gateway = {
      notifyUserNotificationCreated: jest.fn(),
      notifyUserBalanceUpdated: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletAdjustmentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: RealtimeGateway, useValue: gateway },
      ],
    }).compile();

    service = module.get(WalletAdjustmentsService);
  });

  /** Wires the happy-path mocks for a fresh (non-replay) adjustment. */
  function primeFreshAdjustment(balanceAfter: number) {
    prisma.walletAdjustment.findUnique.mockResolvedValue(null);
    prisma.transaction.create.mockResolvedValue({ id: 'txn-1' });
    prisma.walletAdjustment.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 'adj-1',
        ...data,
        createdAt: new Date(),
        performedBy: { id: 'admin-1', username: 'superadmin' },
      }),
    );
    prisma.notification.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 'notif-1',
        ...data,
        isRead: false,
        createdAt: new Date(),
      }),
    );
    const wallet = { balance: new Prisma.Decimal(balanceAfter) };
    walletService.creditWithinTransaction.mockResolvedValue(wallet);
    walletService.debitWithinTransaction.mockResolvedValue(wallet);
  }

  describe('adjust — CREDIT', () => {
    it('credits via WalletService and derives balanceBefore/After from the just-written balance', async () => {
      primeFreshAdjustment(6000);

      const result = await service.adjust(
        'user-1',
        {
          direction: WalletAdjustmentDirection.CREDIT,
          amount: 5000,
          reason: 'Manual correction',
          idempotencyKey: KEY,
        },
        admin,
      );

      expect(walletService.creditWithinTransaction).toHaveBeenCalledTimes(1);
      expect(walletService.creditWithinTransaction).toHaveBeenCalledWith(
        prisma,
        'user-1',
        5000,
      );
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      // balanceBefore = balanceAfter - amount for a credit.
      expect(result.balanceBefore).toBe(1000);
      expect(result.balanceAfter).toBe(6000);
      expect(result.amount).toBe(5000);
      expect(result.direction).toBe(WalletAdjustmentDirection.CREDIT);
      expect(result.replayed).toBe(false);
      expect(result.performedBy).toEqual({
        id: 'admin-1',
        username: 'superadmin',
      });
    });

    it('creates the Transaction row, the WalletAdjustment audit row, and the notification together in one $transaction', async () => {
      primeFreshAdjustment(6000);

      await service.adjust(
        'user-1',
        {
          direction: WalletAdjustmentDirection.CREDIT,
          amount: 5000,
          reason: 'Manual correction',
          idempotencyKey: KEY,
        },
        admin,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          type: TransactionType.ADJUSTMENT_CREDIT,
          amount: expect.any(Prisma.Decimal),
          status: 'COMPLETED',
        },
      });
      expect(prisma.walletAdjustment.create).toHaveBeenCalledTimes(1);
      const adjustmentData =
        prisma.walletAdjustment.create.mock.calls[0][0].data;
      expect(adjustmentData).toMatchObject({
        userId: 'user-1',
        direction: WalletAdjustmentDirection.CREDIT,
        reason: 'Manual correction',
        idempotencyKey: KEY,
        performedByUserId: 'admin-1',
        transactionId: 'txn-1',
      });
      expect((adjustmentData.amount as Prisma.Decimal).toNumber()).toBe(5000);
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it('notifies the user without leaking the internal reason, and emits realtime events after commit', async () => {
      primeFreshAdjustment(6000);

      await service.adjust(
        'user-1',
        {
          direction: WalletAdjustmentDirection.CREDIT,
          amount: 5000,
          reason: 'Internal note: comped after billing bug MYAN-123',
          idempotencyKey: KEY,
        },
        admin,
      );

      const notificationData = prisma.notification.create.mock.calls[0][0].data;
      expect(notificationData.type).toBe(NotificationType.BALANCE_ADJUSTED);
      expect(notificationData.title).toBe('Balance adjusted');
      expect(notificationData.message).toContain('increased');
      // The reason can carry internal admin notes — it must never reach the user.
      expect(notificationData.message).not.toContain('MYAN-123');
      expect(notificationData.payload).toEqual({
        adjustmentId: 'adj-1',
        direction: WalletAdjustmentDirection.CREDIT,
        amount: 5000,
      });

      expect(gateway.notifyUserNotificationCreated).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          id: 'notif-1',
          type: NotificationType.BALANCE_ADJUSTED,
        }),
      );
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith(
        'user-1',
        6000,
      );
    });
  });

  describe('adjust — DEBIT', () => {
    it('debits via WalletService (gte guard intact) and derives balanceBefore by adding the amount back', async () => {
      primeFreshAdjustment(1000);

      const result = await service.adjust(
        'user-1',
        {
          direction: WalletAdjustmentDirection.DEBIT,
          amount: 5000,
          reason: 'Chargeback',
          idempotencyKey: KEY,
        },
        admin,
      );

      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        prisma,
        'user-1',
        5000,
      );
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      // balanceBefore = balanceAfter + amount for a debit.
      expect(result.balanceBefore).toBe(6000);
      expect(result.balanceAfter).toBe(1000);
      expect(result.replayed).toBe(false);
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: TransactionType.ADJUSTMENT_DEBIT,
        }),
      });
      expect(prisma.notification.create.mock.calls[0][0].data.message).toContain(
        'decreased',
      );
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith(
        'user-1',
        1000,
      );
    });

    it('propagates the insufficient-balance guard and writes no rows and emits nothing', async () => {
      prisma.walletAdjustment.findUnique.mockResolvedValue(null);
      walletService.debitWithinTransaction.mockRejectedValue(
        new BadRequestException('Insufficient wallet balance'),
      );

      await expect(
        service.adjust(
          'user-1',
          {
            direction: WalletAdjustmentDirection.DEBIT,
            amount: 999999,
            reason: 'Chargeback',
            idempotencyKey: KEY,
          },
          admin,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.walletAdjustment.create).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(gateway.notifyUserNotificationCreated).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });
  });

  describe('adjust — idempotency', () => {
    it('replays an already-used key: returns the original row with replayed: true and touches nothing', async () => {
      prisma.walletAdjustment.findUnique.mockResolvedValue(makeAdjustment());

      const result = await service.adjust(
        'user-1',
        {
          direction: WalletAdjustmentDirection.CREDIT,
          amount: 5000,
          reason: 'Manual correction after support ticket #42',
          idempotencyKey: KEY,
        },
        admin,
      );

      expect(result.replayed).toBe(true);
      expect(result.id).toBe('adj-1');
      expect(result.amount).toBe(5000);
      expect(result.balanceBefore).toBe(1000);
      expect(result.balanceAfter).toBe(6000);
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.walletAdjustment.create).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
      // A replay moved no money — no realtime emits either.
      expect(gateway.notifyUserNotificationCreated).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('rejects with ConflictException when the key is replayed with an edited payload, without writing anything', async () => {
      // The dialog keeps one key per open — if a commit's response was lost
      // and the admin edits the amount before retrying, silently replaying
      // the ORIGINAL row would report success while the edit never applies.
      prisma.walletAdjustment.findUnique.mockResolvedValue(makeAdjustment());

      await expect(
        service.adjust(
          'user-1',
          {
            direction: WalletAdjustmentDirection.CREDIT,
            amount: 6000,
            reason: 'Manual correction after support ticket #42',
            idempotencyKey: KEY,
          },
          admin,
        ),
      ).rejects.toThrow(ConflictException);

      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.walletAdjustment.create).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('rejects with ConflictException when the key was already used for a different user, without writing anything', async () => {
      prisma.walletAdjustment.findUnique.mockResolvedValue(
        makeAdjustment({ userId: 'user-2' }),
      );

      await expect(
        service.adjust(
          'user-1',
          {
            direction: WalletAdjustmentDirection.CREDIT,
            amount: 5000,
            reason: 'Manual correction',
            idempotencyKey: KEY,
          },
          admin,
        ),
      ).rejects.toThrow(ConflictException);

      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.walletAdjustment.create).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('P2002 race: when a concurrent duplicate wins the unique constraint, refetches the winner and replays it', async () => {
      // Both requests pass the findUnique probe before either commits — the
      // loser's create hits the unique constraint, and the catch refetches.
      prisma.walletAdjustment.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeAdjustment());
      walletService.creditWithinTransaction.mockResolvedValue({
        balance: new Prisma.Decimal(6000),
      });
      prisma.transaction.create.mockResolvedValue({ id: 'txn-loser' });
      prisma.walletAdjustment.create.mockRejectedValue(makeP2002());

      const result = await service.adjust(
        'user-1',
        {
          direction: WalletAdjustmentDirection.CREDIT,
          amount: 5000,
          reason: 'Manual correction after support ticket #42',
          idempotencyKey: KEY,
        },
        admin,
      );

      expect(result.replayed).toBe(true);
      expect(result.id).toBe('adj-1');
      expect(prisma.walletAdjustment.findUnique).toHaveBeenCalledTimes(2);
      // The loser's transaction rolled back and moved no money — no emits.
      expect(gateway.notifyUserNotificationCreated).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('P2002 race for a key belonging to a different user still rejects with ConflictException', async () => {
      prisma.walletAdjustment.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeAdjustment({ userId: 'user-2' }));
      walletService.creditWithinTransaction.mockResolvedValue({
        balance: new Prisma.Decimal(6000),
      });
      prisma.transaction.create.mockResolvedValue({ id: 'txn-loser' });
      prisma.walletAdjustment.create.mockRejectedValue(makeP2002());

      await expect(
        service.adjust(
          'user-1',
          {
            direction: WalletAdjustmentDirection.CREDIT,
            amount: 5000,
            reason: 'Manual correction',
            idempotencyKey: KEY,
          },
          admin,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('rethrows a non-P2002 transaction failure untouched', async () => {
      prisma.walletAdjustment.findUnique.mockResolvedValue(null);
      walletService.creditWithinTransaction.mockResolvedValue({
        balance: new Prisma.Decimal(6000),
      });
      prisma.transaction.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.adjust(
          'user-1',
          {
            direction: WalletAdjustmentDirection.CREDIT,
            amount: 5000,
            reason: 'Manual correction',
            idempotencyKey: KEY,
          },
          admin,
        ),
      ).rejects.toThrow('db down');
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('returns the pinned { items, total, page, limit } shape, createdAt desc, Decimals mapped to numbers', async () => {
      prisma.walletAdjustment.findMany.mockResolvedValue([makeAdjustment()]);
      prisma.walletAdjustment.count.mockResolvedValue(1);

      const result = await service.list('user-1', { page: 2, limit: 10 });

      expect(prisma.walletAdjustment.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
        skip: 10,
        take: 10,
        include: { performedBy: { select: { id: true, username: true } } },
      });
      expect(result.total).toBe(1);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'adj-1',
        direction: WalletAdjustmentDirection.CREDIT,
        amount: 5000,
        balanceBefore: 1000,
        balanceAfter: 6000,
        performedBy: { id: 'admin-1', username: 'superadmin' },
      });
      // list items carry no `replayed` flag — that's a POST-response concern.
      expect(result.items[0]).not.toHaveProperty('replayed');
    });
  });
});
