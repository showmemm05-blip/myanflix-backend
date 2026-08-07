import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { Prisma, Role } from '../generated/prisma/client';

describe('SubscriptionsService', () => {
  let service: SubscriptionsService;
  let prisma: {
    subscriptionPlan: { findMany: jest.Mock; create: jest.Mock; update: jest.Mock; findUnique: jest.Mock };
    userSubscription: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let walletService: { debitWithinTransaction: jest.Mock };
  let tx: {
    userSubscription: { findFirst: jest.Mock; create: jest.Mock };
    transaction: { create: jest.Mock };
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    tx = {
      userSubscription: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'sub-1' }),
      },
      transaction: { create: jest.fn().mockResolvedValue({ id: 'tx-1' }) },
    };
    prisma = {
      subscriptionPlan: {
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      userSubscription: { findFirst: jest.fn() },
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === 'function' ? (arg as (t: unknown) => Promise<unknown>)(tx) : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    walletService = { debitWithinTransaction: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
      ],
    }).compile();

    service = module.get(SubscriptionsService);
  });

  describe('findAllPlans', () => {
    it('staff see every plan, including disabled ones — no filter applied', async () => {
      prisma.subscriptionPlan.findMany.mockResolvedValue([]);

      await service.findAllPlans(Role.ADMIN);

      expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('regular users only see active plans', async () => {
      prisma.subscriptionPlan.findMany.mockResolvedValue([]);

      await service.findAllPlans(Role.USER);

      expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });

    it('serializes Decimal price to a plain number', async () => {
      prisma.subscriptionPlan.findMany.mockResolvedValue([
        { id: 'plan-1', name: 'Basic', price: new Prisma.Decimal(5000), isActive: true },
      ]);

      const result = await service.findAllPlans(Role.USER);

      expect(result[0].price).toBe(5000);
    });
  });

  describe('updatePlan', () => {
    it('throws NotFoundException for an unknown plan, without writing anything', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(null);

      await expect(service.updatePlan('nope', { name: 'X' })).rejects.toThrow(NotFoundException);
      expect(prisma.subscriptionPlan.update).not.toHaveBeenCalled();
    });

    it('updates the plan and returns the price as a plain number', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue({ id: 'plan-1' });
      prisma.subscriptionPlan.update.mockResolvedValue({
        id: 'plan-1',
        name: 'Premium',
        price: new Prisma.Decimal(9000),
        isActive: false,
      });

      const result = await service.updatePlan('plan-1', { isActive: false });

      expect(prisma.subscriptionPlan.update).toHaveBeenCalledWith({
        where: { id: 'plan-1' },
        data: { isActive: false },
      });
      expect(result.price).toBe(9000);
    });
  });

  describe('getMyStatus', () => {
    it('reports not-active when there is no non-expired subscription row', async () => {
      prisma.userSubscription.findFirst.mockResolvedValue(null);

      const result = await service.getMyStatus('user-1');

      expect(result).toEqual({ isActive: false, expiresAt: null, planName: null });
    });

    it('reports the latest active subscription', async () => {
      const expiresAt = new Date('2026-09-01');
      prisma.userSubscription.findFirst.mockResolvedValue({
        expiresAt,
        plan: { name: 'Premium' },
      });

      const result = await service.getMyStatus('user-1');

      expect(result).toEqual({ isActive: true, expiresAt, planName: 'Premium' });
    });
  });

  describe('subscribe', () => {
    it('throws NotFoundException for an unknown plan, without touching the wallet', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(null);

      await expect(service.subscribe('user-1', 'nope')).rejects.toThrow(NotFoundException);
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a disabled plan', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue({
        id: 'plan-1',
        price: new Prisma.Decimal(5000),
        isActive: false,
      });

      await expect(service.subscribe('user-1', 'plan-1')).rejects.toThrow(NotFoundException);
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
    });

    it('debits the wallet and records the subscription + ledger transaction atomically, starting a fresh 30-day period', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue({
        id: 'plan-1',
        price: new Prisma.Decimal(5000),
        isActive: true,
      });
      tx.userSubscription.findFirst.mockResolvedValue(null);

      await service.subscribe('user-1', 'plan-1');

      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(tx, 'user-1', 5000);
      expect(tx.userSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'user-1', planId: 'plan-1' }),
      });
      expect(tx.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'user-1', type: 'SUBSCRIPTION' }),
      });
    });

    it('extends from the current expiry rather than from now, when already subscribed', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue({
        id: 'plan-1',
        price: new Prisma.Decimal(5000),
        isActive: true,
      });
      const currentExpiresAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      tx.userSubscription.findFirst.mockResolvedValue({ expiresAt: currentExpiresAt });

      await service.subscribe('user-1', 'plan-1');

      const createdExpiresAt = tx.userSubscription.create.mock.calls[0][0].data.expiresAt as Date;
      const expected = new Date(currentExpiresAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      expect(createdExpiresAt.getTime()).toBe(expected.getTime());
    });
  });
});
