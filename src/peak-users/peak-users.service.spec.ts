import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PeakUsersService } from './peak-users.service';

function makeStats(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'stats-1',
    actualPeak: 0,
    actualPeakAt: null,
    additionalPeak: 0,
    updatedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('PeakUsersService', () => {
  let service: PeakUsersService;
  let prisma: {
    peakUserStats: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      peakUserStats: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PeakUsersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(PeakUsersService);
  });

  describe('getOrCreate', () => {
    it('returns the existing row without creating a new one', async () => {
      const existing = makeStats();
      prisma.peakUserStats.findFirst.mockResolvedValue(existing);

      const result = await service.getOrCreate();

      expect(result).toBe(existing);
      expect(prisma.peakUserStats.create).not.toHaveBeenCalled();
    });

    it('lazily creates the singleton row with defaults when none exists', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(null);
      const created = makeStats();
      prisma.peakUserStats.create.mockResolvedValue(created);

      const result = await service.getOrCreate();

      expect(prisma.peakUserStats.create).toHaveBeenCalledWith({ data: {} });
      expect(result).toBe(created);
    });
  });

  describe('getPublicTotal', () => {
    it('returns actual + additional as a single peakUsers field', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 137, additionalPeak: 900 }),
      );

      const result = await service.getPublicTotal();

      expect(result).toEqual({ peakUsers: 1037 });
    });

    it('never exposes the actual/additional split', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 5, additionalPeak: 10 }),
      );

      const result = await service.getPublicTotal();

      expect(Object.keys(result)).toEqual(['peakUsers']);
    });
  });

  describe('getAdminView', () => {
    it('returns the split plus the computed displayedPeak', async () => {
      const peakAt = new Date('2026-08-01T12:00:00Z');
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 42, actualPeakAt: peakAt, additionalPeak: 8 }),
      );

      const result = await service.getAdminView();

      expect(result).toEqual({
        actualPeak: 42,
        actualPeakAt: peakAt,
        additionalPeak: 8,
        displayedPeak: 50,
      });
    });
  });

  describe('setAdditional', () => {
    it('updates additionalPeak and records who set it', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 42 }),
      );
      prisma.peakUserStats.update.mockResolvedValue(
        makeStats({
          actualPeak: 42,
          additionalPeak: 900,
          updatedByUserId: 'admin-1',
        }),
      );

      const result = await service.setAdditional(
        { additionalPeak: 900 },
        'admin-1',
      );

      expect(prisma.peakUserStats.update).toHaveBeenCalledWith({
        where: { id: 'stats-1' },
        data: { additionalPeak: 900, updatedByUserId: 'admin-1' },
      });
      expect(result).toEqual({
        actualPeak: 42,
        actualPeakAt: null,
        additionalPeak: 900,
        displayedPeak: 942,
      });
    });

    it('allows resetting to 0', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 42, additionalPeak: 900 }),
      );
      prisma.peakUserStats.update.mockResolvedValue(
        makeStats({
          actualPeak: 42,
          additionalPeak: 0,
          updatedByUserId: 'admin-1',
        }),
      );

      const result = await service.setAdditional(
        { additionalPeak: 0 },
        'admin-1',
      );

      expect(prisma.peakUserStats.update).toHaveBeenCalledWith({
        where: { id: 'stats-1' },
        data: { additionalPeak: 0, updatedByUserId: 'admin-1' },
      });
      expect(result.displayedPeak).toBe(42);
    });
  });

  describe('recordConcurrent', () => {
    it('persists a new high-water mark with a timestamp', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 3 }),
      );
      prisma.peakUserStats.update.mockResolvedValue(makeStats());

      await service.recordConcurrent(4);

      expect(prisma.peakUserStats.update).toHaveBeenCalledWith({
        where: { id: 'stats-1' },
        data: { actualPeak: 4, actualPeakAt: expect.any(Date) },
      });
    });

    it('does not write when the count equals the current peak', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 4 }),
      );

      await service.recordConcurrent(4);

      expect(prisma.peakUserStats.update).not.toHaveBeenCalled();
    });

    it('does not write when the count is below the current peak', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 10 }),
      );

      await service.recordConcurrent(2);

      expect(prisma.peakUserStats.update).not.toHaveBeenCalled();
    });

    it('never mutates additionalPeak', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 0, additionalPeak: 900 }),
      );
      prisma.peakUserStats.update.mockResolvedValue(makeStats());

      await service.recordConcurrent(1);

      const updateArg = prisma.peakUserStats.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateArg.data).not.toHaveProperty('additionalPeak');
    });
  });
});
