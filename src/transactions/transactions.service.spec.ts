import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService } from './transactions.service';

function makeTransaction(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'txn-1',
    userId: 'user-1',
    type: 'PURCHASE',
    status: 'COMPLETED',
    amount: new Prisma.Decimal(5000),
    movieId: null,
    createdAt: new Date('2026-08-01T12:00:00Z'),
    user: {
      id: 'user-1',
      username: 'user_95950495369',
      displayName: 'Blake',
    },
    ...overrides,
  };
}

describe('TransactionsService', () => {
  let service: TransactionsService;
  let prisma: {
    transaction: { findMany: jest.Mock; count: jest.Mock };
    movie: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      transaction: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      // The list path uses the array form (findMany + count).
      $transaction: jest.fn((arg: unknown) =>
        Promise.all(arg as Promise<unknown>[]),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(TransactionsService);
  });

  describe('findAll', () => {
    it('joins the transacting user with their display name next to the raw username', async () => {
      prisma.transaction.findMany.mockResolvedValue([makeTransaction()]);
      prisma.transaction.count.mockResolvedValue(1);

      const result = await service.findAll({});

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            user: { select: { id: true, username: true, displayName: true } },
          },
        }),
      );
      // The row is spread through verbatim, so the label reaches the admin
      // finance table without the login identity being replaced.
      expect(result.items[0].user).toEqual({
        id: 'user-1',
        username: 'user_95950495369',
        displayName: 'Blake',
      });
    });

    it('keeps displayName as null for a user who never set one, rather than dropping the field', async () => {
      prisma.transaction.findMany.mockResolvedValue([
        makeTransaction({
          user: { id: 'user-2', username: 'john', displayName: null },
        }),
      ]);
      prisma.transaction.count.mockResolvedValue(1);

      const result = await service.findAll({});

      expect(result.items[0].user).toEqual({
        id: 'user-2',
        username: 'john',
        displayName: null,
      });
    });

    it('maps the Decimal amount to a number and pins the pagination shape', async () => {
      prisma.transaction.findMany.mockResolvedValue([makeTransaction()]);
      prisma.transaction.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 2, limit: 10 });

      expect(result.items[0].amount).toBe(5000);
      expect(result.total).toBe(1);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
    });

    it('scopes the query to one user when userId is given, and applies it to the count too', async () => {
      await service.findAll({ userId: 'user-1' });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } }),
      );
      expect(prisma.transaction.count).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
    });
  });
});
