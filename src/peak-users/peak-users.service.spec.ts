import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PeakUsersService } from './peak-users.service';

/** The staff member setting the adjustment — `id` is what the updatedByUserId stamp checks. */
const admin = {
  id: 'admin-1',
  username: 'boss',
  role: Role.SUPER_ADMIN,
  appRoleId: null,
};

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
      updateMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      peakUserStats: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PeakUsersService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
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
        admin,
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

      const result = await service.setAdditional({ additionalPeak: 0 }, admin);

      expect(prisma.peakUserStats.update).toHaveBeenCalledWith({
        where: { id: 'stats-1' },
        data: { additionalPeak: 0, updatedByUserId: 'admin-1' },
      });
      expect(result.displayedPeak).toBe(42);
    });
  });

  describe('recordConcurrent', () => {
    const raiseTo = (count: number, id = 'stats-1') => ({
      where: { id, actualPeak: { lt: count } },
      data: { actualPeak: count, actualPeakAt: expect.any(Date) },
    });

    it('reads the row once, then raises a new high-water mark in one conditional write', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 2 }),
      );
      prisma.peakUserStats.updateMany.mockResolvedValue({ count: 1 });

      await service.recordConcurrent(4); // first call: learns the row
      await service.recordConcurrent(5); // then: one write, no read

      expect(prisma.peakUserStats.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.peakUserStats.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.peakUserStats.updateMany).toHaveBeenNthCalledWith(
        1,
        raiseTo(4),
      );
      expect(prisma.peakUserStats.updateMany).toHaveBeenLastCalledWith(
        raiseTo(5),
      );
      expect(prisma.peakUserStats.update).not.toHaveBeenCalled();
    });

    it('does not change anything when the stored peak already covers the count', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 4 }),
      );

      await service.recordConcurrent(4);

      expect(prisma.peakUserStats.updateMany).not.toHaveBeenCalled();
      expect(prisma.peakUserStats.create).not.toHaveBeenCalled();
      expect(prisma.peakUserStats.update).not.toHaveBeenCalled();
    });

    it('skips the database for a count at or below a peak it already knows', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(
        makeStats({ actualPeak: 10 }),
      );
      await service.recordConcurrent(2); // learns the stored peak (10)
      prisma.peakUserStats.updateMany.mockClear();
      prisma.peakUserStats.findFirst.mockClear();

      await service.recordConcurrent(10);
      await service.recordConcurrent(3);

      expect(prisma.peakUserStats.updateMany).not.toHaveBeenCalled();
      expect(prisma.peakUserStats.findFirst).not.toHaveBeenCalled();
    });

    it('re-reads when another process already raised the peak, then stays quiet', async () => {
      prisma.peakUserStats.findFirst
        .mockResolvedValueOnce(makeStats({ actualPeak: 1 }))
        .mockResolvedValueOnce(makeStats({ actualPeak: 9 }));
      prisma.peakUserStats.updateMany
        .mockResolvedValueOnce({ count: 1 }) // 3 raised
        .mockResolvedValueOnce({ count: 0 }); // 5: stored is already 9

      await service.recordConcurrent(3);
      await service.recordConcurrent(5);
      prisma.peakUserStats.updateMany.mockClear();
      await service.recordConcurrent(8);

      expect(prisma.peakUserStats.findFirst).toHaveBeenCalledTimes(2);
      expect(prisma.peakUserStats.updateMany).not.toHaveBeenCalled();
    });

    it('recovers when the stats row was wiped while running', async () => {
      prisma.peakUserStats.findFirst
        .mockResolvedValueOnce(makeStats({ actualPeak: 0 }))
        .mockResolvedValueOnce(null); // wiped
      prisma.peakUserStats.create.mockResolvedValue(
        makeStats({ id: 'stats-2', actualPeak: 0 }),
      );
      prisma.peakUserStats.updateMany
        .mockResolvedValueOnce({ count: 1 }) // 5 on the old row
        .mockResolvedValueOnce({ count: 0 }) // 6: old row is gone
        .mockResolvedValueOnce({ count: 1 }); // 6 on the new row

      await service.recordConcurrent(5);
      await service.recordConcurrent(6);

      expect(prisma.peakUserStats.create).toHaveBeenCalledWith({ data: {} });
      expect(prisma.peakUserStats.updateMany).toHaveBeenLastCalledWith(
        raiseTo(6, 'stats-2'),
      );
    });

    it('notices a reset peak on the next read of the row', async () => {
      prisma.peakUserStats.findFirst
        .mockResolvedValueOnce(makeStats({ actualPeak: 10 }))
        .mockResolvedValueOnce(makeStats({ actualPeak: 0 })); // reset
      prisma.peakUserStats.updateMany.mockResolvedValue({ count: 1 });

      await service.recordConcurrent(2); // learns 10
      await service.getPublicTotal(); // admin/public read sees 0
      await service.recordConcurrent(3);

      expect(prisma.peakUserStats.updateMany).toHaveBeenLastCalledWith(
        raiseTo(3),
      );
    });

    it('creates the singleton row on the very first record and then raises it', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(null);
      prisma.peakUserStats.create.mockResolvedValue(
        makeStats({ actualPeak: 0 }),
      );
      prisma.peakUserStats.updateMany.mockResolvedValue({ count: 1 });

      await service.recordConcurrent(1);

      expect(prisma.peakUserStats.create).toHaveBeenCalledWith({ data: {} });
      expect(prisma.peakUserStats.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.peakUserStats.updateMany).toHaveBeenLastCalledWith(
        raiseTo(1),
      );
    });

    it('never mutates additionalPeak', async () => {
      prisma.peakUserStats.findFirst.mockResolvedValue(makeStats());
      prisma.peakUserStats.updateMany.mockResolvedValue({ count: 1 });

      await service.recordConcurrent(1);

      const updateArg = prisma.peakUserStats.updateMany.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateArg.data).not.toHaveProperty('additionalPeak');
    });
  });
});
