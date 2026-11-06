import { Test, TestingModule } from '@nestjs/testing';
import {
  LotteryDrawStatus,
  LotteryPayoutStatus,
  LotteryResultSource,
  LotteryResultStatus,
  Prisma,
  Role,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DRAW_CREATE_LOCK_NAMESPACE,
  drawLabel,
  LotteryDrawsAdminService,
  ticketSearchWhere,
} from './lottery-draws-admin.service';
import { DRAW_ID, makeDraw, makeResult } from '../../test/lottery-fixtures';
import { LotteryDrawsService } from './lottery-draws.service';
import { LOTTERY_ERRORS } from './lottery-errors';
import { LotterySettingsService } from './lottery-settings.service';

type RawCall = [TemplateStringsArray, ...unknown[]];

const admin = {
  id: 'admin-1',
  username: 'admin.blake',
  role: Role.ADMIN,
  appRoleId: null,
};

const SETTINGS = {
  id: 'settings-1',
  ticketPrice: new Prisma.Decimal(1500),
  maxPerNumber: 10,
  exchangeRate: new Prisma.Decimal(75),
  salesCloseMinutesBefore: 90,
  frameUrl: 'http://STORED/movies/images/lottery_frame/setting.png',
  updatedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  updatedBy: null,
};

describe('LotteryDrawsAdminService', () => {
  let service: LotteryDrawsAdminService;
  let prisma: {
    lotteryDraw: Record<
      | 'findMany'
      | 'count'
      | 'findUnique'
      | 'findUniqueOrThrow'
      | 'aggregate'
      | 'create'
      | 'update'
      | 'updateMany',
      jest.Mock
    >;
    lotteryTicket: Record<'count' | 'findMany', jest.Mock>;
    lotteryOffSaleNumber: Record<
      'findMany' | 'deleteMany' | 'createMany',
      jest.Mock
    >;
    lotteryResult: Record<'findUnique', jest.Mock>;
    lotteryPayout: Record<'groupBy', jest.Mock>;
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let settings: { getOrCreate: jest.Mock };

  beforeEach(async () => {
    prisma = {
      lotteryDraw: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue(makeDraw()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeDraw()),
        aggregate: jest.fn().mockResolvedValue({ _max: { drawNo: 23 } }),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      lotteryTicket: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      lotteryOffSaleNumber: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      lotteryResult: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      lotteryPayout: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    settings = { getOrCreate: jest.fn().mockResolvedValue(SETTINGS) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryDrawsAdminService,
        LotteryDrawsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: LotterySettingsService, useValue: settings },
        {
          provide: MinioService,
          useValue: {
            imageUrl: jest.fn((url: string | null) =>
              url ? url.replace('STORED', 'REQUEST') : null,
            ),
            canonicalImageUrl: jest.fn((url: string | null) =>
              url ? url.replace('REQUEST', 'STORED') : url,
            ),
          },
        },
      ],
    }).compile();
    service = module.get(LotteryDrawsAdminService);
  });

  describe('list / findOne', () => {
    it('filters by status, pages newest first and adds the sales figures from one query', async () => {
      prisma.lotteryDraw.findMany.mockResolvedValue([
        makeDraw(),
        makeDraw({ id: 'other', drawNo: 23 }),
      ]);
      prisma.lotteryDraw.count.mockResolvedValue(2);
      prisma.$queryRaw.mockResolvedValue([
        {
          drawId: DRAW_ID,
          ticketsSold: 468,
          revenueKs: '468000.00',
          buyers: 57,
        },
      ]);

      const page = await service.list({
        status: 'open',
        page: 1,
        pageSize: 20,
      });

      expect(prisma.lotteryDraw.findMany).toHaveBeenCalledWith({
        where: { status: 'OPEN' },
        orderBy: { drawNo: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(page.items[0]).toEqual(
        expect.objectContaining({
          drawNo: 24,
          ticketsSold: 468,
          revenueKs: 468000,
          buyers: 57,
          exchangeRate: null,
          prizeTotalKs: null,
          claimDeadlineAt: null,
        }),
      );
      expect(page.items[0]).not.toHaveProperty('offSaleNumbers');
      // The claims strip is detail-only: the list never counts payouts.
      expect(page.items[0]).not.toHaveProperty('claims');
      expect(prisma.lotteryPayout.groupBy).not.toHaveBeenCalled();
      // A draw with no sales is simply absent from the stats rows.
      expect(page.items[1]).toEqual(
        expect.objectContaining({ ticketsSold: 0, revenueKs: 0, buyers: 0 }),
      );
      const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as RawCall;
      expect(strings.join('?')).toContain('COUNT(DISTINCT p."userId")');
      expect(values).toHaveLength(1);
    });

    it('asks for no stats on an empty page', async () => {
      await service.list({});
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('includes the sorted off-sale list on the detail, and no claims strip before publish', async () => {
      prisma.lotteryOffSaleNumber.findMany.mockResolvedValue([
        { number: '000001' },
        { number: '123456' },
      ]);
      const view = await service.findOne(DRAW_ID);
      expect(view.offSaleNumbers).toEqual(['000001', '123456']);
      expect(prisma.lotteryOffSaleNumber.findMany).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID },
        orderBy: { number: 'asc' },
        select: { number: true },
      });
      expect(view.claims).toBeNull();
      expect(prisma.lotteryPayout.groupBy).not.toHaveBeenCalled();
    });

    it('counts a published draw’s prizes per claim status from one GROUP BY for the detail’s claims strip', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({
          status: LotteryDrawStatus.PUBLISHED,
          publishedAt: new Date('2026-11-01T09:00:00Z'),
          exchangeRate: new Prisma.Decimal(75),
          winnersCount: 12,
          prizeTotalKs: new Prisma.Decimal('1250000.00'),
          prizesPaidKs: new Prisma.Decimal('650000.00'),
          claimDeadlineAt: new Date('2027-01-30T09:00:00Z'),
        }),
      );
      prisma.lotteryPayout.groupBy.mockResolvedValue([
        {
          status: LotteryPayoutStatus.REQUESTED,
          _count: { _all: 3 },
          _sum: { ks: new Prisma.Decimal('300000.00') },
        },
        {
          status: LotteryPayoutStatus.PAID,
          _count: { _all: 5 },
          _sum: { ks: new Prisma.Decimal('650000.00') },
        },
        {
          status: LotteryPayoutStatus.UNCLAIMED,
          _count: { _all: 4 },
          _sum: { ks: new Prisma.Decimal('300000.00') },
        },
      ]);

      const view = await service.findOne(DRAW_ID);

      expect(prisma.lotteryPayout.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: { drawId: DRAW_ID },
        _count: { _all: true },
        _sum: { ks: true },
      });
      expect(view.prizeTotalKs).toBe(1_250_000);
      expect(view.claimDeadlineAt).toEqual(new Date('2027-01-30T09:00:00Z'));
      expect(view.claims).toEqual({
        winningTickets: 12,
        prizeTotalKs: 1_250_000,
        waiting: { tickets: 3, ks: 300_000 },
        paid: { tickets: 5, ks: 650_000 },
        notRequested: { tickets: 4, ks: 300_000 },
        rejected: { tickets: 0, ks: 0 },
        expired: { tickets: 0, ks: 0 },
      });
    });

    it('falls back to the payouts’ sum for the strip’s prize total when the draw’s counter is not in yet', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({
          status: LotteryDrawStatus.PUBLISHED,
          exchangeRate: new Prisma.Decimal(75),
        }),
      );
      prisma.lotteryPayout.groupBy.mockResolvedValue([
        {
          status: LotteryPayoutStatus.UNCLAIMED,
          _count: { _all: 2 },
          _sum: { ks: new Prisma.Decimal('450000.00') },
        },
      ]);
      const view = await service.findOne(DRAW_ID);
      expect(view.claims).toEqual(
        expect.objectContaining({ winningTickets: 2, prizeTotalKs: 450_000 }),
      );
    });

    it('404s an unknown id', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(null);
      await expect(service.findOne(DRAW_ID)).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
      });
    });
  });

  describe('create', () => {
    it('takes the next draw number and the settings values under the create lock', async () => {
      prisma.lotteryDraw.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeDraw({ ...data, id: DRAW_ID } as never)),
      );

      const view = await service.create({ thaiDrawDate: '2026-11-01' }, admin);

      const [strings, key] = prisma.$executeRaw.mock.calls[0] as RawCall;
      expect(strings.join('?')).toContain('pg_advisory_xact_lock(hashtext(?))');
      expect(key).toBe(DRAW_CREATE_LOCK_NAMESPACE);
      expect(prisma.lotteryDraw.create).toHaveBeenCalledWith({
        data: {
          drawNo: 24,
          thaiDrawDate: new Date('2026-11-01T00:00:00.000Z'),
          drawAt: new Date('2026-11-01T07:30:00.000Z'),
          // 90 minutes before the Thai draw (the setting), not the 60 default.
          salesCloseAt: new Date('2026-11-01T06:00:00.000Z'),
          ticketPrice: SETTINGS.ticketPrice,
          maxPerNumber: 10,
          pictureUrl: null,
          // The settings' frame, copied as stored (already canonical).
          frameUrl: 'http://STORED/movies/images/lottery_frame/setting.png',
          createdByUserId: admin.id,
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_draw.create',
          actor: admin,
          target: expect.objectContaining({
            type: 'lottery_draw',
            id: DRAW_ID,
          }),
          after: expect.objectContaining({ drawNo: 24, status: 'SCHEDULED' }),
          tx: prisma,
        }),
      );
      expect(view).toEqual(
        expect.objectContaining({
          drawNo: 24,
          status: 'scheduled',
          ticketsSold: 0,
          offSaleNumbers: [],
        }),
      );
    });

    it('starts at 1 on an empty table and stores the picture canonical', async () => {
      prisma.lotteryDraw.aggregate.mockResolvedValue({
        _max: { drawNo: null },
      });
      prisma.lotteryDraw.create.mockResolvedValue(makeDraw({ drawNo: 1 }));
      await service.create(
        {
          thaiDrawDate: '2026-11-01',
          salesCloseAt: '2026-11-01T05:00:00.000Z',
          pictureUrl: 'http://REQUEST/movies/images/lottery/a.webp',
        },
        admin,
      );
      expect(prisma.lotteryDraw.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          drawNo: 1,
          salesCloseAt: new Date('2026-11-01T05:00:00.000Z'),
          pictureUrl: 'http://STORED/movies/images/lottery/a.webp',
        }),
      });
    });

    it('lets the body pick another frame (stored canonical) or the built-in one (null) instead of the setting', async () => {
      prisma.lotteryDraw.create.mockResolvedValue(makeDraw());
      await service.create(
        {
          thaiDrawDate: '2026-11-01',
          frameUrl: 'http://REQUEST/movies/images/lottery_frame/own.png',
        },
        admin,
      );
      expect(prisma.lotteryDraw.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          frameUrl: 'http://STORED/movies/images/lottery_frame/own.png',
        }),
      });

      await service.create(
        { thaiDrawDate: '2026-11-01', frameUrl: null },
        admin,
      );
      expect(prisma.lotteryDraw.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ frameUrl: null }),
      });

      // No frame in the settings and none in the body = the built-in frame.
      settings.getOrCreate.mockResolvedValue({ ...SETTINGS, frameUrl: null });
      await service.create({ thaiDrawDate: '2026-11-01' }, admin);
      expect(prisma.lotteryDraw.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ frameUrl: null }),
      });
    });

    it('409s a draw number that is already taken', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue({ id: 'other' });
      await expect(
        service.create({ drawNo: 24, thaiDrawDate: '2026-11-01' }, admin),
      ).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_NO_TAKEN,
        status: 409,
      });
      expect(prisma.lotteryDraw.create).not.toHaveBeenCalled();
    });

    it('400s a sales close time after the draw, before touching the database', async () => {
      await expect(
        service.create(
          {
            thaiDrawDate: '2026-11-01',
            salesCloseAt: '2026-11-01T07:30:01.000Z',
          },
          admin,
        ),
      ).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_TIME_INVALID,
        status: 400,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('locks the date, price, limit, picture and frame once a ticket is sold', async () => {
      prisma.lotteryTicket.count.mockResolvedValue(1);
      for (const dto of [
        { thaiDrawDate: '2026-11-16' },
        { ticketPrice: 2000 },
        { maxPerNumber: 5 },
        { pictureUrl: null },
        { frameUrl: null },
        { frameUrl: 'http://REQUEST/movies/images/lottery_frame/own.png' },
      ]) {
        await expect(service.update(DRAW_ID, dto, admin)).rejects.toMatchObject(
          {
            code: LOTTERY_ERRORS.DRAW_LOCKED,
            status: 409,
            extra: { ticketsSold: 1 },
          },
        );
      }
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
    });

    it('locks the setup once published, and the close time once closed', async () => {
      const published = makeDraw({ status: LotteryDrawStatus.PUBLISHED });
      prisma.lotteryDraw.findUnique.mockResolvedValue(published);
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(published);
      await expect(
        service.update(DRAW_ID, { ticketPrice: 2000 }, admin),
      ).rejects.toMatchObject({ code: LOTTERY_ERRORS.DRAW_LOCKED });

      const closed = makeDraw({ status: LotteryDrawStatus.CLOSED });
      prisma.lotteryDraw.findUnique.mockResolvedValue(closed);
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(closed);
      await expect(
        service.update(
          DRAW_ID,
          { salesCloseAt: '2026-11-01T05:00:00.000Z' },
          admin,
        ),
      ).rejects.toMatchObject({ code: LOTTERY_ERRORS.DRAW_LOCKED });
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
    });

    it('checks and writes under the draw’s row lock, judging the row read under it', async () => {
      // The row before the lock says SCHEDULED; the one under it says a
      // ticket was sold meanwhile (a checkout held the lock first).
      prisma.lotteryTicket.count.mockResolvedValue(1);
      await expect(
        service.update(DRAW_ID, { thaiDrawDate: '2026-11-16' }, admin),
      ).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_LOCKED,
        status: 409,
        extra: { ticketsSold: 1 },
      });
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();

      // The same lock statement a checkout takes, before the count and the write.
      const [strings, id] = prisma.$queryRaw.mock.calls[0] as RawCall;
      expect(strings.join('?')).toContain(
        'SELECT "id" FROM "lottery_draws" WHERE "id" = ? FOR UPDATE',
      );
      expect(id).toBe(DRAW_ID);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryTicket.count.mock.invocationCallOrder[0],
      );

      // And a status that changed under the lock is the one that counts.
      prisma.lotteryTicket.count.mockResolvedValue(0);
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.PUBLISHED }),
      );
      await expect(
        service.update(DRAW_ID, { ticketPrice: 2000 }, admin),
      ).rejects.toMatchObject({ code: LOTTERY_ERRORS.DRAW_LOCKED });
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
    });

    it('still lets an open draw with sales move its close time and clear nothing else', async () => {
      prisma.lotteryTicket.count.mockResolvedValue(468);
      const open = makeDraw({ status: LotteryDrawStatus.OPEN });
      prisma.lotteryDraw.findUnique.mockResolvedValue(open);
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(open);
      prisma.lotteryDraw.update.mockResolvedValue(makeDraw());
      await service.update(
        DRAW_ID,
        { salesCloseAt: '2026-11-01T05:00:00.000Z' },
        admin,
      );
      expect(prisma.lotteryDraw.update).toHaveBeenCalledWith({
        where: { id: DRAW_ID },
        data: { salesCloseAt: new Date('2026-11-01T05:00:00.000Z') },
      });
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryDraw.update.mock.invocationCallOrder[0],
      );
    });

    it('moving the date alone keeps the same gap to sales close', async () => {
      prisma.lotteryDraw.update.mockResolvedValue(makeDraw());
      await service.update(DRAW_ID, { thaiDrawDate: '2026-11-16' }, admin);
      expect(prisma.lotteryDraw.update).toHaveBeenCalledWith({
        where: { id: DRAW_ID },
        data: {
          thaiDrawDate: new Date('2026-11-16T00:00:00.000Z'),
          drawAt: new Date('2026-11-16T07:30:00.000Z'),
          salesCloseAt: new Date('2026-11-16T06:30:00.000Z'),
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_draw.update',
          before: expect.objectContaining({ drawNo: 24 }),
          tx: prisma,
        }),
      );
    });

    it('400s a close time after the (new) draw time', async () => {
      await expect(
        service.update(
          DRAW_ID,
          { thaiDrawDate: '2026-11-16', salesCloseAt: '2026-11-16T08:00:00Z' },
          admin,
        ),
      ).rejects.toMatchObject({ code: LOTTERY_ERRORS.DRAW_TIME_INVALID });
    });

    it('writes nothing for an empty patch, clears the picture on null, stores a new one canonical', async () => {
      await service.update(DRAW_ID, {}, admin);
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();

      prisma.lotteryDraw.update.mockResolvedValue(makeDraw());
      await service.update(
        DRAW_ID,
        { pictureUrl: null, maxPerNumber: 5 },
        admin,
      );
      expect(prisma.lotteryDraw.update).toHaveBeenCalledWith({
        where: { id: DRAW_ID },
        data: { pictureUrl: null, maxPerNumber: 5 },
      });
      await service.update(
        DRAW_ID,
        { pictureUrl: 'http://REQUEST/movies/images/lottery/b.webp' },
        admin,
      );
      expect(prisma.lotteryDraw.update).toHaveBeenLastCalledWith({
        where: { id: DRAW_ID },
        data: { pictureUrl: 'http://STORED/movies/images/lottery/b.webp' },
      });
    });

    it('changes the frame while nothing is sold — whatever the status short of sold — and null means the built-in frame', async () => {
      // A closed draw that sold nothing may still swap its frame: the
      // lock is "tickets sold", not the status (the picture rule).
      const closed = makeDraw({ status: LotteryDrawStatus.CLOSED });
      prisma.lotteryDraw.findUnique.mockResolvedValue(closed);
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(closed);
      prisma.lotteryDraw.update.mockResolvedValue(closed);

      await service.update(
        DRAW_ID,
        { frameUrl: 'http://REQUEST/movies/images/lottery_frame/own.png' },
        admin,
      );
      expect(prisma.lotteryDraw.update).toHaveBeenCalledWith({
        where: { id: DRAW_ID },
        data: { frameUrl: 'http://STORED/movies/images/lottery_frame/own.png' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_draw.update',
          before: expect.objectContaining({ frameUrl: null }),
          tx: prisma,
        }),
      );

      await service.update(DRAW_ID, { frameUrl: null }, admin);
      expect(prisma.lotteryDraw.update).toHaveBeenLastCalledWith({
        where: { id: DRAW_ID },
        data: { frameUrl: null },
      });
    });
  });

  describe('open / pause / close / reopen', () => {
    it('opens a scheduled draw with one guarded update and stamps openedAt once', async () => {
      // The row before (findUnique), the row after inside the transaction
      // (findUniqueOrThrow), then the read-back for the answer (findUnique).
      prisma.lotteryDraw.findUnique
        .mockResolvedValueOnce(makeDraw())
        .mockResolvedValue(makeDraw({ status: LotteryDrawStatus.OPEN }));
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.OPEN }),
      );
      const before = Date.now();
      const view = await service.open(DRAW_ID, admin);

      const call = prisma.lotteryDraw.updateMany.mock.calls[0][0] as {
        where: { salesCloseAt: { gt: Date } };
        data: { status: string; openedAt: Date };
      };
      expect(call.where).toEqual({
        id: DRAW_ID,
        status: { in: ['SCHEDULED', 'PAUSED'] },
        salesCloseAt: { gt: expect.any(Date) as Date },
      });
      expect(call.where.salesCloseAt.gt.getTime()).toBeGreaterThanOrEqual(
        before,
      );
      expect(call.data.status).toBe('OPEN');
      expect(call.data.openedAt.getTime()).toBeGreaterThanOrEqual(before);
      // Every transition queues on the draw's row lock before its update.
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryDraw.updateMany.mock.invocationCallOrder[0],
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_draw.open',
          before: expect.objectContaining({ status: 'SCHEDULED' }),
          after: expect.objectContaining({ status: 'OPEN' }),
          tx: prisma,
        }),
      );
      expect(view.status).toBe('open');
    });

    it('keeps the first openedAt when a paused draw opens again', async () => {
      const openedAt = new Date('2026-10-20T00:00:00Z');
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.PAUSED, openedAt }),
      );
      await service.open(DRAW_ID, admin);
      expect(prisma.lotteryDraw.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'OPEN', openedAt } }),
      );
    });

    it('409s LOTTERY_DRAW_STATE when the guarded update matches nothing, naming the current status', async () => {
      prisma.lotteryDraw.updateMany.mockResolvedValue({ count: 0 });
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.CLOSED }),
      );
      await expect(service.open(DRAW_ID, admin)).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_STATE,
        status: 409,
        extra: { status: 'closed' },
      });
      await expect(service.pause(DRAW_ID, admin)).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_STATE,
      });
      await expect(service.close(DRAW_ID, admin)).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_STATE,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('pauses only an open draw and closes an open or paused one with a closedAt stamp', async () => {
      await service.pause(DRAW_ID, admin);
      expect(prisma.lotteryDraw.updateMany).toHaveBeenLastCalledWith({
        where: { id: DRAW_ID, status: { in: ['OPEN'] } },
        data: { status: 'PAUSED' },
      });
      await service.close(DRAW_ID, admin);
      expect(prisma.lotteryDraw.updateMany).toHaveBeenLastCalledWith({
        where: { id: DRAW_ID, status: { in: ['OPEN', 'PAUSED'] } },
        data: { status: 'CLOSED', closedAt: expect.any(Date) as Date },
      });
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'lottery_draw.close' }),
      );
    });

    it('reopens a closed draw with one guarded update: close time ahead, no sheet in; clears closedAt, keeps openedAt', async () => {
      const openedAt = new Date('2026-10-20T00:00:00Z');
      const closed = makeDraw({
        status: LotteryDrawStatus.CLOSED,
        openedAt,
        closedAt: new Date('2026-10-20T01:00:00Z'),
      });
      const reopened = makeDraw({
        status: LotteryDrawStatus.OPEN,
        openedAt,
        closedAt: null,
      });
      prisma.lotteryDraw.findUnique
        .mockResolvedValueOnce(closed)
        .mockResolvedValue(reopened);
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(reopened);
      const before = Date.now();
      const view = await service.reopen(DRAW_ID, admin);

      const call = prisma.lotteryDraw.updateMany.mock.calls[0][0] as {
        where: { salesCloseAt: { gt: Date } };
        data: Record<string, unknown>;
      };
      expect(call.where).toEqual({
        id: DRAW_ID,
        status: { in: ['CLOSED'] },
        salesCloseAt: { gt: expect.any(Date) as Date },
        OR: [
          { result: null },
          { result: { status: { notIn: ['FETCHED', 'PUBLISHED'] } } },
        ],
      });
      expect(call.where.salesCloseAt.gt.getTime()).toBeGreaterThanOrEqual(
        before,
      );
      expect(call.data).toEqual({ status: 'OPEN', closedAt: null });
      // The draw's row lock first (the one a results write takes), then
      // the guarded update: a sheet that committed while the lock was
      // waited on is seen by the update.
      const [strings, id] = prisma.$queryRaw.mock.calls[0] as RawCall;
      expect(strings.join('?')).toContain(
        'SELECT "id" FROM "lottery_draws" WHERE "id" = ? FOR UPDATE',
      );
      expect(id).toBe(DRAW_ID);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryDraw.updateMany.mock.invocationCallOrder[0],
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_draw.reopen',
          actor: admin,
          target: {
            type: 'lottery_draw',
            id: DRAW_ID,
            label: 'Draw 24 (2026-11-01)',
          },
          before: expect.objectContaining({ status: 'CLOSED' }),
          after: expect.objectContaining({ status: 'OPEN' }),
          tx: prisma,
        }),
      );
      // The reason is looked up only on a refusal.
      expect(prisma.lotteryResult.findUnique).not.toHaveBeenCalled();
      expect(view.status).toBe('open');
      expect(view.openedAt).toEqual(openedAt);
      expect(view.closedAt).toBeNull();
    });

    it('409s "Results are already in" when the sheet is FETCHED, PUBLISHED, or typed in by hand', async () => {
      prisma.lotteryDraw.updateMany.mockResolvedValue({ count: 0 });
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.CLOSED }),
      );
      const sheets = [
        makeResult({
          status: LotteryResultStatus.FETCHED,
          source: LotteryResultSource.API,
        }),
        makeResult({
          status: LotteryResultStatus.PUBLISHED,
          source: LotteryResultSource.API,
        }),
        makeResult({
          status: LotteryResultStatus.FETCHED,
          source: LotteryResultSource.MANUAL,
        }),
      ];
      for (const sheet of sheets) {
        prisma.lotteryResult.findUnique.mockResolvedValueOnce(sheet);
        await expect(service.reopen(DRAW_ID, admin)).rejects.toMatchObject({
          code: LOTTERY_ERRORS.DRAW_STATE,
          status: 409,
          message: 'Results are already in for this draw',
          extra: { status: 'closed' },
        });
      }
      expect(prisma.lotteryResult.findUnique).toHaveBeenCalledTimes(3);
      expect(prisma.lotteryResult.findUnique).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID },
        select: { status: true },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409s the state reason when the draw is not closed, the close time passed, or the sheet is only PENDING / FAILED', async () => {
      prisma.lotteryDraw.updateMany.mockResolvedValue({ count: 0 });
      const cases: Array<{
        status: LotteryDrawStatus;
        sheet: ReturnType<typeof makeResult> | null;
      }> = [
        { status: LotteryDrawStatus.OPEN, sheet: null },
        { status: LotteryDrawStatus.PUBLISHED, sheet: null },
        {
          status: LotteryDrawStatus.CLOSED,
          sheet: makeResult({ status: LotteryResultStatus.PENDING }),
        },
        {
          status: LotteryDrawStatus.CLOSED,
          sheet: makeResult({ status: LotteryResultStatus.FAILED }),
        },
      ];
      for (const { status, sheet } of cases) {
        prisma.lotteryDraw.findUnique.mockResolvedValue(makeDraw({ status }));
        prisma.lotteryResult.findUnique.mockResolvedValueOnce(sheet);
        await expect(service.reopen(DRAW_ID, admin)).rejects.toMatchObject({
          code: LOTTERY_ERRORS.DRAW_STATE,
          status: 409,
          message:
            'Only a closed draw whose sales close time is still ahead can reopen',
          extra: { status: status.toLowerCase() },
        });
      }
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s a reopen of an unknown draw before touching anything', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(null);
      await expect(service.reopen('missing', admin)).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
      });
      expect(prisma.lotteryDraw.updateMany).not.toHaveBeenCalled();
      expect(prisma.lotteryResult.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('setOffSale', () => {
    it('replaces the list and audits the before / after / added / removed counts', async () => {
      prisma.lotteryOffSaleNumber.findMany
        .mockResolvedValueOnce([{ number: '000001' }, { number: '000009' }])
        .mockResolvedValue([{ number: '000001' }, { number: '000002' }]);

      const view = await service.setOffSale(
        DRAW_ID,
        { numbers: ['000001', '000002'] },
        admin,
      );

      expect(prisma.lotteryOffSaleNumber.deleteMany).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID },
      });
      expect(prisma.lotteryOffSaleNumber.createMany).toHaveBeenCalledWith({
        data: [
          { drawId: DRAW_ID, number: '000001' },
          { drawId: DRAW_ID, number: '000002' },
        ],
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_draw.off_sale',
          metadata: { before: 2, after: 2, added: 1, removed: 1 },
          tx: prisma,
        }),
      );
      expect(view.offSaleNumbers).toEqual(['000001', '000002']);
    });

    it('takes the draw’s row lock before touching the list, so it queues behind a checkout in flight', async () => {
      await service.setOffSale(DRAW_ID, { numbers: ['000001'] }, admin);
      const [strings, id] = prisma.$queryRaw.mock.calls[0] as RawCall;
      expect(strings.join('?')).toContain(
        'SELECT "id" FROM "lottery_draws" WHERE "id" = ? FOR UPDATE',
      );
      expect(id).toBe(DRAW_ID);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryOffSaleNumber.deleteMany.mock.invocationCallOrder[0],
      );
    });

    it('an empty list only deletes', async () => {
      await service.setOffSale(DRAW_ID, { numbers: [] }, admin);
      expect(prisma.lotteryOffSaleNumber.createMany).not.toHaveBeenCalled();
    });
  });

  describe('listTickets', () => {
    it("pages the draw's tickets newest first with the customer and the purchase ref", async () => {
      prisma.lotteryTicket.findMany.mockResolvedValue([
        {
          ticketNo: 'MFL-24-000468',
          number: '123456',
          status: 'WAITING',
          prizeKs: null,
          createdAt: new Date('2026-10-20T01:00:00Z'),
          purchase: { ref: 'LP-261020-0042' },
          payout: null,
          user: {
            id: 'user-1',
            username: 'user_959',
            displayName: 'Mya',
            phone: '09959',
            email: null,
          },
        },
      ]);
      prisma.lotteryTicket.count.mockResolvedValue(1);

      const page = await service.listTickets(DRAW_ID, {
        q: 'mya',
        page: 1,
        pageSize: 50,
      });

      expect(prisma.lotteryTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { drawId: DRAW_ID, ...ticketSearchWhere('mya') },
          orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
          skip: 0,
          take: 50,
        }),
      );
      expect(page.items).toEqual([
        {
          ticketNo: 'MFL-24-000468',
          number: '123456',
          purchaseRef: 'LP-261020-0042',
          boughtAt: new Date('2026-10-20T01:00:00Z'),
          // The wire form, like the draw status — the admin's badge map reads it.
          status: 'waiting',
          prizeKs: null,
          wonGroups: null,
          user: expect.objectContaining({ username: 'user_959' }),
        },
      ]);
    });

    it('carries the prize and the groups won once the draw is published', async () => {
      const row = {
        ticketNo: 'MFL-24-000468',
        number: '123456',
        createdAt: new Date('2026-10-20T01:00:00Z'),
        purchase: { ref: 'LP-261020-0042' },
        user: { id: 'user-1', username: 'user_959' },
      };
      prisma.lotteryTicket.findMany.mockResolvedValue([
        {
          ...row,
          status: 'WON',
          prizeKs: new Prisma.Decimal('450300000.00'),
          payout: {
            groups: [
              {
                key: 'first',
                name: 'First prize',
                baht: 6_000_000,
                ks: 450_000_000,
              },
              { key: 'back3', name: 'Back 3 digits', baht: 4000, ks: 300_000 },
            ],
          },
        },
        {
          ...row,
          ticketNo: 'MFL-24-000469',
          status: 'NOT_WON',
          prizeKs: null,
          payout: null,
        },
      ]);
      prisma.lotteryTicket.count.mockResolvedValue(2);

      const page = await service.listTickets(DRAW_ID, {});

      expect(prisma.lotteryTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            payout: { select: { groups: true } },
          }),
        }),
      );
      expect(page.items.map((t) => [t.status, t.prizeKs, t.wonGroups])).toEqual(
        [
          [
            'won',
            450_300_000,
            [
              { key: 'first', name: 'First prize', ks: 450_000_000 },
              { key: 'back3', name: 'Back 3 digits', ks: 300_000 },
            ],
          ],
          ['notwon', null, []],
        ],
      );
    });

    it('searches ticket numbers, number prefixes, purchase refs and the customer', () => {
      expect(ticketSearchWhere('12').OR).toEqual([
        { ticketNo: { contains: '12', mode: 'insensitive' } },
        { number: { startsWith: '12' } },
        { purchase: { ref: { contains: '12', mode: 'insensitive' } } },
        {
          user: {
            OR: [
              { username: { contains: '12', mode: 'insensitive' } },
              { displayName: { contains: '12', mode: 'insensitive' } },
              { phone: { contains: '12' } },
            ],
          },
        },
      ]);
    });
  });

  it('labels a draw by number and Thai date', () => {
    expect(drawLabel(makeDraw())).toBe('Draw 24 (2026-11-01)');
  });
});
