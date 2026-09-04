import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { Prisma, Role } from '../generated/prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('SubscriptionsService', () => {
  let service: SubscriptionsService;
  let prisma: {
    subscriptionPlan: {
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
    };
    userSubscription: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let walletService: { debitWithinTransaction: jest.Mock };
  let realtimeGateway: { notifyUserBalanceUpdated: jest.Mock };
  let tx: {
    userSubscription: { findFirst: jest.Mock; create: jest.Mock };
    transaction: { create: jest.Mock };
    wallet: { findUniqueOrThrow: jest.Mock };
  };

  const createdExpiresAt = (): Date =>
    tx.userSubscription.create.mock.calls[0][0].data.expiresAt as Date;

  beforeEach(async () => {
    jest.clearAllMocks();

    tx = {
      userSubscription: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'sub-1' }),
      },
      transaction: { create: jest.fn().mockResolvedValue({ id: 'tx-1' }) },
      wallet: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ balance: new Prisma.Decimal(0) }),
      },
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
        typeof arg === 'function'
          ? (arg as (t: unknown) => Promise<unknown>)(tx)
          : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    walletService = {
      debitWithinTransaction: jest.fn().mockResolvedValue(undefined),
    };
    realtimeGateway = { notifyUserBalanceUpdated: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: RealtimeGateway, useValue: realtimeGateway },
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

    it('serializes Decimal price to a plain number and passes durationDays through as an Int', async () => {
      prisma.subscriptionPlan.findMany.mockResolvedValue([
        {
          id: 'plan-1',
          name: 'Basic',
          price: new Prisma.Decimal(5000),
          durationDays: 30,
          isActive: true,
        },
      ]);

      const result = await service.findAllPlans(Role.USER);

      expect(result[0].price).toBe(5000);
      expect(result[0].durationDays).toBe(30);
    });
  });

  describe('createPlan', () => {
    it('defaults durationDays to 30 when the request omits it (API back-compat)', async () => {
      prisma.subscriptionPlan.create.mockResolvedValue({
        id: 'plan-1',
        name: 'Basic',
        price: new Prisma.Decimal(5000),
        durationDays: 30,
        isActive: true,
      });

      const result = await service.createPlan({ name: 'Basic', price: 5000 });

      expect(prisma.subscriptionPlan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Basic',
          price: 5000,
          durationDays: 30,
        }),
      });
      expect(result.durationDays).toBe(30);
      expect(result.price).toBe(5000);
    });

    it('passes an explicit durationDays through unchanged', async () => {
      prisma.subscriptionPlan.create.mockResolvedValue({
        id: 'plan-2',
        name: 'Week',
        price: new Prisma.Decimal(3000),
        durationDays: 7,
        isActive: true,
      });

      const result = await service.createPlan({
        name: 'Week',
        price: 3000,
        durationDays: 7,
      });

      expect(prisma.subscriptionPlan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ durationDays: 7 }),
      });
      expect(result.durationDays).toBe(7);
    });
  });

  describe('updatePlan', () => {
    it('throws NotFoundException for an unknown plan, without writing anything', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(null);

      await expect(service.updatePlan('nope', { name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.subscriptionPlan.update).not.toHaveBeenCalled();
    });

    it('updates the plan and returns the price as a plain number', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue({ id: 'plan-1' });
      prisma.subscriptionPlan.update.mockResolvedValue({
        id: 'plan-1',
        name: 'Premium',
        price: new Prisma.Decimal(9000),
        durationDays: 30,
        isActive: false,
      });

      const result = await service.updatePlan('plan-1', { isActive: false });

      // Only the sent field is written — a toggle must never reset durationDays.
      expect(prisma.subscriptionPlan.update).toHaveBeenCalledWith({
        where: { id: 'plan-1' },
        data: { isActive: false },
      });
      expect(result.price).toBe(9000);
    });

    it('writes only durationDays when that is all the request carries', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue({ id: 'plan-1' });
      prisma.subscriptionPlan.update.mockResolvedValue({
        id: 'plan-1',
        name: 'Premium',
        price: new Prisma.Decimal(9000),
        durationDays: 90,
        isActive: true,
      });

      const result = await service.updatePlan('plan-1', { durationDays: 90 });

      expect(prisma.subscriptionPlan.update).toHaveBeenCalledWith({
        where: { id: 'plan-1' },
        data: { durationDays: 90 },
      });
      expect(result.durationDays).toBe(90);
    });
  });

  describe('getMyStatus', () => {
    it('reports not-active when there is no non-expired subscription row', async () => {
      prisma.userSubscription.findFirst.mockResolvedValue(null);

      const result = await service.getMyStatus('user-1');

      expect(result).toEqual({
        isActive: false,
        expiresAt: null,
        planId: null,
        planName: null,
        durationDays: null,
      });
    });

    it('reports the latest active subscription with its plan id and duration', async () => {
      const expiresAt = new Date('2026-09-01');
      prisma.userSubscription.findFirst.mockResolvedValue({
        expiresAt,
        planId: 'plan-1',
        plan: { name: 'Premium', durationDays: 30 },
      });

      const result = await service.getMyStatus('user-1');

      expect(result).toEqual({
        isActive: true,
        expiresAt,
        planId: 'plan-1',
        planName: 'Premium',
        durationDays: 30,
      });
    });
  });

  describe('subscribe', () => {
    const activePlan = (durationDays: number, price = 5000) => ({
      id: 'plan-1',
      price: new Prisma.Decimal(price),
      durationDays,
      isActive: true,
    });

    it('throws NotFoundException for an unknown plan, without touching the wallet', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(null);

      await expect(service.subscribe('user-1', 'nope')).rejects.toThrow(
        NotFoundException,
      );
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a disabled plan', async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue({
        id: 'plan-1',
        price: new Prisma.Decimal(5000),
        durationDays: 30,
        isActive: false,
      });

      await expect(service.subscribe('user-1', 'plan-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
    });

    it("debits the wallet and records the subscription + ledger transaction atomically, starting a fresh period of the plan's durationDays", async () => {
      const plan = activePlan(30);
      prisma.subscriptionPlan.findUnique.mockResolvedValue(plan);
      tx.userSubscription.findFirst.mockResolvedValue(null);
      tx.wallet.findUniqueOrThrow.mockResolvedValue({
        balance: new Prisma.Decimal(4000),
      });

      const before = Date.now();
      await service.subscribe('user-1', 'plan-1');

      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        tx,
        'user-1',
        5000,
      );
      expect(tx.userSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'user-1', planId: 'plan-1' }),
      });
      const expected = before + plan.durationDays * DAY_MS;
      expect(Math.abs(createdExpiresAt().getTime() - expected)).toBeLessThan(
        1000,
      );
      expect(tx.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          type: 'SUBSCRIPTION',
        }),
      });
      // Real-time audit: a subscription purchase must push the caller's new
      // balance the same way every other debit/credit flow does, or the
      // wallet pill goes stale until a manual reload.
      expect(realtimeGateway.notifyUserBalanceUpdated).toHaveBeenCalledWith(
        'user-1',
        4000,
      );
    });

    it('a 1-day plan with no active subscription expires one day from now', async () => {
      const plan = activePlan(1);
      prisma.subscriptionPlan.findUnique.mockResolvedValue(plan);
      tx.userSubscription.findFirst.mockResolvedValue(null);

      const before = Date.now();
      await service.subscribe('user-1', 'plan-1');

      const expected = before + 1 * DAY_MS;
      expect(Math.abs(createdExpiresAt().getTime() - expected)).toBeLessThan(
        1000,
      );
    });

    it('a 365-day plan with no active subscription expires a year from now', async () => {
      const plan = activePlan(365);
      prisma.subscriptionPlan.findUnique.mockResolvedValue(plan);
      tx.userSubscription.findFirst.mockResolvedValue(null);

      const before = Date.now();
      await service.subscribe('user-1', 'plan-1');

      const expected = before + 365 * DAY_MS;
      expect(Math.abs(createdExpiresAt().getTime() - expected)).toBeLessThan(
        1000,
      );
    });

    it('extends from the current expiry rather than from now, when already subscribed', async () => {
      const plan = activePlan(30);
      prisma.subscriptionPlan.findUnique.mockResolvedValue(plan);
      const currentExpiresAt = new Date(Date.now() + 10 * DAY_MS);
      tx.userSubscription.findFirst.mockResolvedValue({
        expiresAt: currentExpiresAt,
      });

      await service.subscribe('user-1', 'plan-1');

      const expected = new Date(
        currentExpiresAt.getTime() + plan.durationDays * DAY_MS,
      );
      expect(createdExpiresAt().getTime()).toBe(expected.getTime());
    });

    it("renewing onto a different-length plan stacks that plan's days onto the current expiry", async () => {
      // Current subscription came from a 30-day plan and has 10 days left;
      // the user now buys a 90-day plan. Remaining days are never lost.
      const plan = activePlan(90, 12000);
      prisma.subscriptionPlan.findUnique.mockResolvedValue(plan);
      const currentExpiresAt = new Date(Date.now() + 10 * DAY_MS);
      tx.userSubscription.findFirst.mockResolvedValue({
        expiresAt: currentExpiresAt,
      });

      await service.subscribe('user-1', 'plan-1');

      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        tx,
        'user-1',
        12000,
      );
      const expected = currentExpiresAt.getTime() + 90 * DAY_MS;
      expect(createdExpiresAt().getTime()).toBe(expected);
    });
  });
});
