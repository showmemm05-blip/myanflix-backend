import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  LevelsService,
  resolveLevelStatus,
  type LevelDto,
} from './levels.service';

function makeLevel(overrides: Partial<LevelDto> = {}): LevelDto {
  return {
    id: 'level-1',
    name: 'Starter',
    threshold: 0,
    icon: 'shield',
    color: '#8B909A',
    order: 1,
    enabled: true,
    createdAt: new Date('2026-08-31T00:00:00Z'),
    updatedAt: new Date('2026-08-31T00:00:00Z'),
    ...overrides,
  };
}

/** The six seeded rungs, in display order. */
const LADDER: LevelDto[] = [
  makeLevel({ id: 'l1', name: 'Starter', threshold: 0, order: 1 }),
  makeLevel({ id: 'l2', name: 'Bronze', threshold: 100, order: 2 }),
  makeLevel({ id: 'l3', name: 'Silver', threshold: 500, order: 3 }),
  makeLevel({ id: 'l4', name: 'Gold', threshold: 1000, order: 4 }),
  makeLevel({ id: 'l5', name: 'Platinum', threshold: 5000, order: 5 }),
  makeLevel({ id: 'l6', name: 'Diamond', threshold: 10000, order: 6 }),
];

describe('resolveLevelStatus (pure math)', () => {
  it('resolves a zero qualifying total to the zero-threshold level', () => {
    const status = resolveLevelStatus(0, LADDER);
    expect(status.level?.name).toBe('Starter');
    expect(status.nextLevel?.name).toBe('Bronze');
    expect(status.remaining).toBe(100);
    expect(status.progressPercent).toBe(0);
    expect(status.qualifyingTotal).toBe(0);
  });

  it('exactly at a threshold holds that level, not the one below', () => {
    const status = resolveLevelStatus(100, LADDER);
    expect(status.level?.name).toBe('Bronze');
    expect(status.nextLevel?.name).toBe('Silver');
    expect(status.remaining).toBe(400);
    expect(status.progressPercent).toBe(20); // 100 / 500
  });

  it("resolves between thresholds (the owner's Gold example)", () => {
    const status = resolveLevelStatus(1350, LADDER);
    expect(status.level?.name).toBe('Gold');
    expect(status.nextLevel?.name).toBe('Platinum');
    expect(status.remaining).toBe(3650);
    expect(status.progressPercent).toBe(27); // 1350 / 5000
  });

  it('at the top level: nextLevel null, remaining null, progress 100', () => {
    for (const total of [10000, 25000]) {
      const status = resolveLevelStatus(total, LADDER);
      expect(status.level?.name).toBe('Diamond');
      expect(status.nextLevel).toBeNull();
      expect(status.remaining).toBeNull();
      expect(status.progressPercent).toBe(100);
    }
  });

  it('zero levels enabled: all nulls, progress 0, empty ladder', () => {
    const status = resolveLevelStatus(1350, []);
    expect(status).toEqual({
      qualifyingTotal: 1350,
      level: null,
      nextLevel: null,
      remaining: null,
      progressPercent: 0,
      ladder: [],
    });
  });

  it('below the lowest enabled threshold: level null, nextLevel = lowest enabled', () => {
    // Starter disabled -> not in the enabled list at all.
    const withoutStarter = LADDER.slice(1);
    const status = resolveLevelStatus(50, withoutStarter);
    expect(status.level).toBeNull();
    expect(status.nextLevel?.name).toBe('Bronze');
    expect(status.remaining).toBe(50);
    expect(status.progressPercent).toBe(50); // 50 / 100
  });

  it('disabled levels are excluded from resolution and ladder (caller passes enabled only)', () => {
    // Gold missing from the enabled set: 1350 falls back to Silver and the
    // next rung becomes Platinum.
    const goldDisabled = LADDER.filter((l) => l.name !== 'Gold');
    const status = resolveLevelStatus(1350, goldDisabled);
    expect(status.level?.name).toBe('Silver');
    expect(status.nextLevel?.name).toBe('Platinum');
    expect(status.ladder.map((l) => l.name)).toEqual([
      'Starter',
      'Bronze',
      'Silver',
      'Platinum',
      'Diamond',
    ]);
  });

  it('resolution sorts by threshold regardless of input order', () => {
    const shuffled = [LADDER[4], LADDER[0], LADDER[5], LADDER[2], LADDER[1], LADDER[3]];
    const status = resolveLevelStatus(1350, shuffled);
    expect(status.level?.name).toBe('Gold');
    expect(status.nextLevel?.name).toBe('Platinum');
    expect(status.ladder.map((l) => l.name)).toEqual([
      'Starter',
      'Bronze',
      'Silver',
      'Gold',
      'Platinum',
      'Diamond',
    ]);
  });

  it('clamps progress into 0..100 even with odd inputs', () => {
    // A negative total cannot come from the qualifying-sum aggregate, but
    // the clamp guarantees the bar never renders outside its track anyway.
    expect(resolveLevelStatus(-50, LADDER).progressPercent).toBe(0);
    // 99.99 of 100 rounds to 100 but must not exceed it while still Starter.
    const almost = resolveLevelStatus(99.99, LADDER);
    expect(almost.level?.name).toBe('Starter');
    expect(almost.progressPercent).toBe(100);
  });
});

describe('LevelsService', () => {
  let service: LevelsService;
  let prisma: {
    userLevel: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      aggregate: jest.Mock;
    };
    transaction: { aggregate: jest.Mock; groupBy: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      userLevel: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        aggregate: jest.fn(),
      },
      transaction: { aggregate: jest.fn(), groupBy: jest.fn() },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LevelsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(LevelsService);
  });

  function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'level-1',
      name: 'Starter',
      threshold: new Prisma.Decimal(0),
      icon: 'shield',
      color: '#8B909A',
      order: 1,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  describe('getUserLevelStatus', () => {
    it('sums COMPLETED subscription transactions and maps Decimal to plain numbers', async () => {
      prisma.transaction.aggregate.mockResolvedValue({
        _sum: { amount: new Prisma.Decimal(1350) },
      });
      prisma.userLevel.findMany.mockResolvedValue([
        makeRow({ id: 'l1', name: 'Gold', threshold: new Prisma.Decimal(1000), order: 1 }),
        makeRow({ id: 'l2', name: 'Platinum', threshold: new Prisma.Decimal(5000), order: 2 }),
      ]);

      const status = await service.getUserLevelStatus('user-1');

      expect(prisma.transaction.aggregate).toHaveBeenCalledWith({
        where: { userId: 'user-1', type: 'SUBSCRIPTION', status: 'COMPLETED' },
        _sum: { amount: true },
      });
      expect(status.qualifyingTotal).toBe(1350);
      expect(status.level?.name).toBe('Gold');
      expect(typeof status.level?.threshold).toBe('number');
      expect(status.nextLevel?.threshold).toBe(5000);
      expect(status.remaining).toBe(3650);
      expect(status.progressPercent).toBe(27);
    });

    it('maps a null aggregate (no qualifying rows) to zero', async () => {
      prisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: null } });
      prisma.userLevel.findMany.mockResolvedValue([]);

      const status = await service.getUserLevelStatus('user-1');
      expect(status.qualifyingTotal).toBe(0);
      expect(status.level).toBeNull();
      expect(status.progressPercent).toBe(0);
      expect(status.ladder).toEqual([]);
    });
  });

  describe('getLevelsForUsers (batched list resolution)', () => {
    it('returns an empty map for an empty id list without touching the database', async () => {
      const result = await service.getLevelsForUsers([]);

      expect(result.size).toBe(0);
      expect(prisma.transaction.groupBy).not.toHaveBeenCalled();
      expect(prisma.userLevel.findMany).not.toHaveBeenCalled();
    });

    it('resolves a user with zero subscription spend to the zero-threshold rung', async () => {
      // No groupBy row at all for the user — total defaults to 0.
      prisma.transaction.groupBy.mockResolvedValue([]);
      prisma.userLevel.findMany.mockResolvedValue([
        makeRow({ id: 'l1', name: 'Starter', threshold: new Prisma.Decimal(0), order: 1 }),
        makeRow({ id: 'l2', name: 'Bronze', threshold: new Prisma.Decimal(100), order: 2 }),
      ]);

      const result = await service.getLevelsForUsers(['user-1']);

      expect(result.get('user-1')?.name).toBe('Starter');
      expect(typeof result.get('user-1')?.threshold).toBe('number');
    });

    it('resolves mixed users from ONE groupBy + ONE levels fetch, null when nothing qualifies', async () => {
      prisma.transaction.groupBy.mockResolvedValue([
        { userId: 'gold-user', _sum: { amount: new Prisma.Decimal(1350) } },
        { userId: 'small-user', _sum: { amount: new Prisma.Decimal(50) } },
      ]);
      // No zero-threshold rung enabled — a total below 100 qualifies for nothing.
      prisma.userLevel.findMany.mockResolvedValue([
        makeRow({ id: 'l2', name: 'Bronze', threshold: new Prisma.Decimal(100), order: 2 }),
        makeRow({ id: 'l4', name: 'Gold', threshold: new Prisma.Decimal(1000), order: 4 }),
      ]);

      const result = await service.getLevelsForUsers([
        'gold-user',
        'small-user',
        'no-spend-user',
      ]);

      expect(prisma.transaction.groupBy).toHaveBeenCalledTimes(1);
      expect(prisma.transaction.groupBy).toHaveBeenCalledWith({
        by: ['userId'],
        where: {
          userId: { in: ['gold-user', 'small-user', 'no-spend-user'] },
          type: 'SUBSCRIPTION',
          status: 'COMPLETED',
        },
        _sum: { amount: true },
      });
      expect(prisma.userLevel.findMany).toHaveBeenCalledTimes(1);

      expect(result.get('gold-user')?.name).toBe('Gold');
      expect(result.get('gold-user')?.icon).toBe('shield');
      expect(result.get('gold-user')?.threshold).toBe(1000); // plain number
      expect(result.get('small-user')).toBeNull();
      expect(result.get('no-spend-user')).toBeNull();
      expect(result.size).toBe(3);
    });
  });

  describe('create', () => {
    it('rejects a duplicate name with 409', async () => {
      prisma.userLevel.findFirst.mockResolvedValueOnce({ id: 'other' });

      await expect(
        service.create({ name: 'Gold', threshold: 2000, icon: 'shield', color: '#F0B90B' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.userLevel.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate threshold with 409', async () => {
      prisma.userLevel.findFirst
        .mockResolvedValueOnce(null) // name check
        .mockResolvedValueOnce({ id: 'other' }); // threshold check

      await expect(
        service.create({ name: 'Ruby', threshold: 1000, icon: 'shield', color: '#FF0000' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.userLevel.create).not.toHaveBeenCalled();
    });

    it('appends with max order + 1 when order is omitted', async () => {
      prisma.userLevel.findFirst.mockResolvedValue(null);
      prisma.userLevel.aggregate.mockResolvedValue({ _max: { order: 6 } });
      prisma.userLevel.create.mockResolvedValue(
        makeRow({ name: 'Ruby', threshold: new Prisma.Decimal(20000), order: 7 }),
      );

      const created = await service.create({
        name: 'Ruby',
        threshold: 20000,
        icon: 'shield',
        color: '#FF0000',
      });

      expect(prisma.userLevel.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ order: 7 }),
      });
      expect(created.threshold).toBe(20000); // plain number, not Decimal
    });
  });

  describe('update', () => {
    it('404s on an unknown id', async () => {
      prisma.userLevel.findUnique.mockResolvedValue(null);
      await expect(service.update('missing', { name: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('excludes self from the duplicate-threshold check', async () => {
      prisma.userLevel.findUnique.mockResolvedValue({ id: 'level-1' });
      prisma.userLevel.findFirst.mockResolvedValue({ id: 'level-1' }); // same row
      prisma.userLevel.update.mockResolvedValue(makeRow());

      await expect(service.update('level-1', { threshold: 0 })).resolves.toBeDefined();
    });
  });

  describe('reorder', () => {
    it('applies every update inside one transaction', async () => {
      prisma.userLevel.findMany
        .mockResolvedValueOnce([{ id: 'l1' }, { id: 'l2' }]) // existence check
        .mockResolvedValueOnce([
          makeRow({ id: 'l2', name: 'Bronze', order: 1 }),
          makeRow({ id: 'l1', name: 'Starter', order: 2 }),
        ]); // findAll after
      prisma.$transaction.mockResolvedValue([]);
      prisma.userLevel.update.mockImplementation((args: unknown) => args);

      const result = await service.reorder({
        items: [
          { id: 'l2', order: 1 },
          { id: 'l1', order: 2 },
        ],
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect((prisma.$transaction.mock.calls[0][0] as unknown[]).length).toBe(2);
      expect(result.map((l) => l.id)).toEqual(['l2', 'l1']);
    });

    it('404s when any id is unknown and writes nothing', async () => {
      prisma.userLevel.findMany.mockResolvedValueOnce([{ id: 'l1' }]);

      await expect(
        service.reorder({
          items: [
            { id: 'l1', order: 1 },
            { id: 'ghost', order: 2 },
          ],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
