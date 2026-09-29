import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService.getOverview', () => {
  let service: AnalyticsService;
  let prisma: {
    watchHistory: {
      count: jest.Mock;
      aggregate: jest.Mock;
      groupBy: jest.Mock;
    };
    user: { count: jest.Mock };
    transaction: { aggregate: jest.Mock };
    movie: { count: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      watchHistory: {
        count: jest.fn().mockResolvedValue(3),
        aggregate: jest
          .fn()
          .mockResolvedValue({ _avg: { progress: 0.5, lastPosition: 60 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      user: { count: jest.fn().mockResolvedValue(2) },
      transaction: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { amount: new Prisma.Decimal(4500) } }),
      },
      movie: {
        count: jest.fn().mockResolvedValue(7),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: { imageUrl: jest.fn() } },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  });

  it('reports revenue to a caller allowed to see it', async () => {
    const overview = await service.getOverview({ includeRevenue: true });
    expect(overview.revenue).toBe(4500);
    expect(overview.totalMovies).toBe(7);
  });

  it('never reads or returns revenue for a dashboard-only caller (H-26)', async () => {
    const overview = await service.getOverview({ includeRevenue: false });
    expect(overview.revenue).toBeNull();
    expect(prisma.transaction.aggregate).not.toHaveBeenCalled();
    // The non-money stats the dashboard cards need are all still there.
    expect(overview).toMatchObject({
      totalViews: 3,
      totalMovies: 7,
      totalUsers: 2,
      activeUsers: 2,
    });
  });
});
