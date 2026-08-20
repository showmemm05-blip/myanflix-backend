import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { FinanceService } from './finance.service';

describe('FinanceService', () => {
  let service: FinanceService;
  let prisma: {
    transaction: { aggregate: jest.Mock; groupBy: jest.Mock };
    purchase: { groupBy: jest.Mock };
    movie: { findMany: jest.Mock };
    user: { findMany: jest.Mock };
  };
  let minioService: { imageUrl: jest.Mock; playbackUrl: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      transaction: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      purchase: { groupBy: jest.fn().mockResolvedValue([]) },
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    minioService = {
      imageUrl: jest.fn((key: string | null) => key),
      playbackUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
      ],
    }).compile();

    service = module.get(FinanceService);
  });

  describe('getDashboard — topUsers', () => {
    it('names each top spender with their display name next to the raw username', async () => {
      prisma.purchase.groupBy.mockResolvedValue([
        {
          userId: 'user-1',
          _sum: { amount: new Prisma.Decimal(50000) },
          _count: { _all: 4 },
        },
      ]);
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'user-1',
          username: 'user_95950495369',
          displayName: 'Blake',
          avatar: 'images/avatars/user-1.png',
        },
      ]);

      const result = await service.getDashboard();

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['user-1'] } },
        select: { id: true, username: true, displayName: true, avatar: true },
      });
      // The raw row is discarded — only this mapped object reaches the client,
      // so displayName has to be carried through it explicitly. Without it the
      // Top Spenders chart prints a machine username on its axis.
      expect(result.topUsers[0]).toEqual({
        user: {
          id: 'user-1',
          username: 'user_95950495369',
          displayName: 'Blake',
          avatarUrl: 'https://cdn.test/images/avatars/user-1.png',
        },
        totalSpent: 50000,
        purchaseCount: 4,
      });
    });

    it('carries displayName as null for a top spender who never set one', async () => {
      prisma.purchase.groupBy.mockResolvedValue([
        {
          userId: 'user-2',
          _sum: { amount: new Prisma.Decimal(1000) },
          _count: { _all: 1 },
        },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'user-2', username: 'john', displayName: null, avatar: null },
      ]);

      const result = await service.getDashboard();

      expect(result.topUsers[0].user).toEqual({
        id: 'user-2',
        username: 'john',
        displayName: null,
        avatarUrl: null,
      });
    });

    it('leaves the user null when the grouped spender row has no matching account', async () => {
      prisma.purchase.groupBy.mockResolvedValue([
        {
          userId: 'ghost',
          _sum: { amount: new Prisma.Decimal(1000) },
          _count: { _all: 1 },
        },
      ]);
      prisma.user.findMany.mockResolvedValue([]);

      const result = await service.getDashboard();

      expect(result.topUsers[0].user).toBeNull();
      expect(result.topUsers[0].totalSpent).toBe(1000);
    });
  });
});
