import { Test, TestingModule } from '@nestjs/testing';
import { CodedHttpException } from '../../common/errors/coded-http.exception';
import { LotteryDrawStatus, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DRAW_ID, makeDraw } from '../../../test/lottery-fixtures';
import { LOTTERY_ERRORS } from '../lottery-errors';
import { LotteryActivityService } from './lottery-activity.service';
import { LotteryAnalyticsService } from './lottery-analytics.service';

/** 11:30 MMT on Friday 23 October 2026 — the dashboard default is then 16–22 Oct. */
const NOW = new Date('2026-10-23T05:00:00.000Z');
const START = new Date('2026-10-15T17:30:00.000Z');
const END = new Date('2026-10-22T17:30:00.000Z');
const PREVIOUS_START = new Date('2026-10-08T17:30:00.000Z');
const PREVIOUS_END = START;

type Rows = Record<string, unknown>[];
/** A canned answer per query marker; a function sees the bound parameters. */
type Answer = Rows | ((values: unknown[], sql: string) => Rows);

/** The marker every analytics query starts with. */
const nameOf = (query: Prisma.Sql): string =>
  /lottery-analytics:([a-z-]+)/.exec(query.strings.join('?'))?.[1] ?? '?';

describe('LotteryAnalyticsService', () => {
  let service: LotteryAnalyticsService;
  let answers: Record<string, Answer>;
  let queries: Prisma.Sql[];
  let prisma: {
    $queryRaw: jest.Mock;
    lotteryActivity: Record<'findFirst', jest.Mock>;
    lotteryDraw: Record<
      'findUnique' | 'findFirst' | 'findMany' | 'count',
      jest.Mock
    >;
  };
  let presence: { firstActivityAt: jest.Mock };

  /** Every query that carried this marker, with its SQL text and bound values. */
  const sent = (name: string) =>
    queries
      .filter((query) => nameOf(query) === name)
      .map((query) => ({ sql: query.strings.join('?'), values: query.values }));

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    answers = {};
    queries = [];
    prisma = {
      $queryRaw: jest.fn((query: Prisma.Sql) => {
        queries.push(query);
        const answer = answers[nameOf(query)];
        const sql = query.strings.join('?');
        return Promise.resolve(
          typeof answer === 'function'
            ? answer(query.values, sql)
            : (answer ?? []),
        );
      }),
      lotteryActivity: { findFirst: jest.fn().mockResolvedValue(null) },
      lotteryDraw: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    presence = { firstActivityAt: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryAnalyticsService,
        { provide: PrismaService, useValue: prisma },
        { provide: LotteryActivityService, useValue: presence },
      ],
    }).compile();
    service = module.get(LotteryAnalyticsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('overview', () => {
    it('defaults to the last 7 full MMT days, answers zeros / nulls / "0.00" before any sale, and never asks for active users when nothing is tracked', async () => {
      const overview = await service.overview({});

      expect(overview).toEqual({
        range: {
          from: '2026-10-16',
          to: '2026-10-22',
          previousFrom: '2026-10-09',
          previousTo: '2026-10-15',
        },
        current: {
          ticketsSold: 0,
          purchases: 0,
          buyers: 0,
          revenueKs: '0.00',
          popularNumber: null,
          peakHour: null,
          avgTicketsPerPurchase: null,
        },
        previous: {
          ticketsSold: 0,
          purchases: 0,
          buyers: 0,
          revenueKs: '0.00',
          popularNumber: null,
          peakHour: null,
          avgTicketsPerPurchase: null,
        },
        firstPurchaseAt: null,
        activity: { trackedSince: null, trackedInRange: false },
      });
      expect(sent('active-users-hour')).toHaveLength(0);
      // Current and previous windows each get their own counts, bound as instants.
      expect(sent('counts').map((q) => q.values.slice(0, 2))).toEqual(
        expect.arrayContaining([
          [START, END],
          [PREVIOUS_START, PREVIOUS_END],
        ]),
      );
      expect(prisma.lotteryActivity.findFirst).toHaveBeenCalledWith({
        where: { hourStart: { gte: START, lt: END } },
        select: { id: true },
      });
    });

    it('maps the figures, works out the average, and adds the peak hour’s active users once tracking is on', async () => {
      prisma.lotteryActivity.findFirst.mockResolvedValue({ id: 'a-1' });
      presence.firstActivityAt.mockResolvedValue(
        new Date('2026-10-20T03:00:00.000Z'),
      );
      answers = {
        counts: (values) =>
          (values[0] as Date).getTime() === START.getTime()
            ? [
                {
                  ticketsSold: 12,
                  purchases: 5,
                  buyers: 4,
                  revenueKs: '12000.00',
                },
              ]
            : [
                {
                  ticketsSold: 10,
                  purchases: 4,
                  buyers: 4,
                  revenueKs: '10000.00',
                },
              ],
        'popular-number': [{ number: '000777', tickets: 3 }],
        'peak-hour': [{ hour: 14, ticketsSold: 7, purchasingUsers: 3 }],
        'active-users-hour': [{ activeUsers: 9 }],
        'first-purchase': [{ firstAt: new Date('2026-10-01T04:00:00.000Z') }],
      };

      const overview = await service.overview({
        from: '2026-10-16',
        to: '2026-10-22',
        drawId: DRAW_ID,
      });

      expect(overview.current).toEqual({
        ticketsSold: 12,
        purchases: 5,
        buyers: 4,
        revenueKs: '12000.00',
        popularNumber: { number: '000777', tickets: 3 },
        peakHour: {
          hour: 14,
          ticketsSold: 7,
          purchasingUsers: 3,
          activeUsers: 9,
        },
        avgTicketsPerPurchase: 2.4,
      });
      expect(overview.previous).toMatchObject({
        ticketsSold: 10,
        avgTicketsPerPurchase: 2.5,
      });
      expect(overview.firstPurchaseAt).toEqual(
        new Date('2026-10-01T04:00:00.000Z'),
      );
      expect(overview.activity).toEqual({
        trackedSince: new Date('2026-10-20T03:00:00.000Z'),
        trackedInRange: true,
      });
      // The draw filter reaches tickets and purchases, never the activity.
      for (const q of [
        ...sent('counts'),
        ...sent('peak-hour'),
        ...sent('first-purchase'),
      ]) {
        expect(q.sql).toContain('"drawId" = ?');
        expect(q.values).toContain(DRAW_ID);
      }
      const activeHour = sent('active-users-hour')[0];
      expect(activeHour.sql).not.toContain('drawId');
      expect(activeHour.values).toEqual([START, END, 390, 14]);
    });
  });

  describe('activity', () => {
    it('hourly: 24 zero-filled buckets with null active users while nothing is tracked, and no activity query', async () => {
      answers = {
        'activity-tickets': [{ key: '14', ticketsSold: 7 }],
        'activity-purchases': [{ key: '14', purchases: 3, purchasingUsers: 2 }],
      };

      const result = await service.activity({});

      expect(result.view).toBe('hourly');
      expect(result.activeUsersTracked).toBe(false);
      expect(result.buckets).toHaveLength(24);
      expect(result.buckets.map((b) => b.key)).toEqual(
        Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')),
      );
      expect(result.buckets[14]).toEqual({
        key: '14',
        ticketsSold: 7,
        purchases: 3,
        purchasingUsers: 2,
        activeUsers: null,
      });
      expect(result.buckets[0]).toEqual({
        key: '00',
        ticketsSold: 0,
        purchases: 0,
        purchasingUsers: 0,
        activeUsers: null,
      });
      expect(sent('activity-active')).toHaveLength(0);
      expect(sent('activity-tickets')[0].sql).toContain(
        'lpad(extract(hour FROM',
      );
      expect(sent('activity-tickets')[0].values).toEqual([390, START, END]);
    });

    it('daily: one bucket per MMT day of the range, merged by date key, with active users once tracked', async () => {
      prisma.lotteryActivity.findFirst.mockResolvedValue({ id: 'a-1' });
      answers = {
        'activity-tickets': [{ key: '2026-10-18', ticketsSold: 5 }],
        'activity-purchases': [
          { key: '2026-10-18', purchases: 2, purchasingUsers: 2 },
        ],
        'activity-active': [{ key: '2026-10-18', activeUsers: 11 }],
      };

      const result = await service.activity({
        from: '2026-10-16',
        to: '2026-10-22',
        view: 'daily',
        drawId: DRAW_ID,
      });

      expect(result.activeUsersTracked).toBe(true);
      expect(result.buckets.map((b) => b.key)).toEqual([
        '2026-10-16',
        '2026-10-17',
        '2026-10-18',
        '2026-10-19',
        '2026-10-20',
        '2026-10-21',
        '2026-10-22',
      ]);
      expect(result.buckets[2]).toEqual({
        key: '2026-10-18',
        ticketsSold: 5,
        purchases: 2,
        purchasingUsers: 2,
        activeUsers: 11,
      });
      expect(result.buckets[3].activeUsers).toBe(0);
      expect(sent('activity-tickets')[0].sql).toContain('to_char(');
      expect(sent('activity-tickets')[0].values).toContain(DRAW_ID);
      // Activity is the period's, never the draw's.
      expect(sent('activity-active')[0].sql).not.toContain('drawId');
      expect(sent('activity-active')[0].values).toEqual([390, START, END]);
    });

    it('weekly: one bucket per Monday the range touches', async () => {
      const result = await service.activity({
        from: '2026-10-01',
        to: '2026-10-31',
        view: 'weekly',
      });

      expect(result.buckets.map((b) => b.key)).toEqual([
        '2026-09-28',
        '2026-10-05',
        '2026-10-12',
        '2026-10-19',
        '2026-10-26',
      ]);
      expect(sent('activity-purchases')[0].sql).toContain("date_trunc('week'");
    });

    it('weekday: mon..sun', async () => {
      answers = { 'activity-tickets': [{ key: 'sat', ticketsSold: 40 }] };

      const result = await service.activity({ view: 'weekday' });

      expect(result.buckets.map((b) => [b.key, b.ticketsSold])).toEqual([
        ['mon', 0],
        ['tue', 0],
        ['wed', 0],
        ['thu', 0],
        ['fri', 0],
        ['sat', 40],
        ['sun', 0],
      ]);
      expect(sent('activity-tickets')[0].sql).toContain('isodow');
    });
  });

  describe('numbers', () => {
    const PAGE = [
      { rank: 1, number: '333333', tickets: 120, buyers: 80, repeatBuyers: 12 },
      { rank: 7, number: '000001', tickets: 20, buyers: 20, repeatBuyers: 0 },
      { rank: 9, number: '555555', tickets: 10, buyers: 9, repeatBuyers: 1 },
    ];

    it('pages the ranked numbers with their share and trend (change / new / no earlier data)', async () => {
      answers = {
        'numbers-page': PAGE,
        'numbers-totals': [{ total: 1964, totalTickets: 1970 }],
        'numbers-previous': [{ number: '333333', tickets: 100 }],
        'first-purchase': [{ firstAt: new Date('2026-10-01T04:00:00.000Z') }],
      };

      const page = await service.numbers({
        from: '2026-10-16',
        to: '2026-10-22',
        sort: 'repeat',
        order: 'asc',
        page: 2,
        pageSize: 10,
      });

      expect(page).toMatchObject({
        total: 1964,
        totalTickets: 1970,
        page: 2,
        pageSize: 10,
      });
      expect(page.items).toEqual([
        {
          rank: 1,
          number: '333333',
          tickets: 120,
          buyers: 80,
          share: 0.0609,
          repeatBuyers: 12,
          trend: { previousTickets: 100, changePct: 0.2, isNew: false },
        },
        {
          rank: 7,
          number: '000001',
          tickets: 20,
          buyers: 20,
          share: 0.0102,
          repeatBuyers: 0,
          trend: { previousTickets: 0, changePct: null, isNew: true },
        },
        {
          rank: 9,
          number: '555555',
          tickets: 10,
          buyers: 9,
          share: 0.0051,
          repeatBuyers: 1,
          trend: { previousTickets: 0, changePct: null, isNew: true },
        },
      ]);
      const pageQuery = sent('numbers-page')[0];
      expect(pageQuery.sql).toContain(
        'ORDER BY "repeatBuyers" ASC, "number" ASC',
      );
      expect(pageQuery.sql).toContain(
        'ROW_NUMBER() OVER (ORDER BY "tickets" DESC, "number" ASC)',
      );
      expect(pageQuery.values).toEqual([START, END, 10, 10]);
      const previous = sent('numbers-previous')[0];
      expect(previous.values).toEqual([
        PREVIOUS_START,
        PREVIOUS_END,
        '333333',
        '000001',
        '555555',
      ]);
    });

    it('says "no earlier data" (null trend) when history does not cover the comparison period', async () => {
      answers = {
        'numbers-page': PAGE.slice(1, 2),
        'numbers-totals': [{ total: 1, totalTickets: 20 }],
        'first-purchase': [{ firstAt: new Date('2026-10-12T04:00:00.000Z') }],
      };

      const page = await service.numbers({
        from: '2026-10-16',
        to: '2026-10-22',
      });

      expect(page.items[0].trend).toEqual({
        previousTickets: null,
        changePct: null,
        isNew: false,
      });
      expect(page.items[0].share).toBe(1);
    });

    it('all time (no from/to): no comparison, no trend query, defaults tickets desc page 1 of 10', async () => {
      answers = {
        'numbers-page': PAGE.slice(0, 1),
        'numbers-totals': [{ total: 1, totalTickets: 120 }],
      };

      const page = await service.numbers({ drawId: DRAW_ID });

      expect(page.items[0].trend).toEqual({
        previousTickets: null,
        changePct: null,
        isNew: false,
      });
      expect(page).toMatchObject({ page: 1, pageSize: 10 });
      expect(sent('numbers-previous')).toHaveLength(0);
      expect(sent('first-purchase')).toHaveLength(0);
      const pageQuery = sent('numbers-page')[0];
      expect(pageQuery.sql).not.toContain('"createdAt" >=');
      expect(pageQuery.sql).toContain('ORDER BY "tickets" DESC, "number" ASC');
      expect(pageQuery.values).toEqual([DRAW_ID, 10, 0]);
    });

    it('an empty page asks for no trends', async () => {
      const page = await service.numbers({
        from: '2026-10-16',
        to: '2026-10-22',
      });

      expect(page).toEqual({
        items: [],
        total: 0,
        totalTickets: 0,
        page: 1,
        pageSize: 10,
      });
      expect(sent('numbers-previous')).toHaveLength(0);
    });
  });

  describe('numbersAcross', () => {
    it('ranks across every draw with draws played and the best rank, never draw-scoped', async () => {
      answers = {
        'across-page': [
          {
            rank: 1,
            number: '333333',
            tickets: 300,
            buyers: 150,
            drawsPlayed: 3,
            bestRank: 1,
            bestDrawNo: 3,
          },
          {
            rank: 2,
            number: '777777',
            tickets: 250,
            buyers: 200,
            drawsPlayed: 2,
            bestRank: null,
            bestDrawNo: null,
          },
        ],
        'across-totals': [{ total: 5000, totalTickets: 30000 }],
      };

      const page = await service.numbersAcross({
        from: '2026-10-01',
        to: '2026-10-31',
        sort: 'draws',
        order: 'desc',
        page: 1,
        pageSize: 25,
      });

      expect(page).toEqual({
        items: [
          {
            rank: 1,
            number: '333333',
            tickets: 300,
            buyers: 150,
            share: 0.01,
            drawsPlayed: 3,
            bestRank: { rank: 1, drawNo: 3 },
          },
          {
            rank: 2,
            number: '777777',
            tickets: 250,
            buyers: 200,
            share: 0.0083,
            drawsPlayed: 2,
            bestRank: null,
          },
        ],
        total: 5000,
        totalTickets: 30000,
        page: 1,
        pageSize: 25,
      });
      const query = sent('across-page')[0];
      expect(query.sql).toContain('ORDER BY "drawsPlayed" DESC, "number" ASC');
      expect(query.sql).toContain('PARTITION BY "drawId"');
      expect(query.sql).not.toContain('"drawId" = ?');
      expect(query.values).toEqual([
        new Date('2026-09-30T17:30:00.000Z'),
        new Date('2026-10-31T17:30:00.000Z'),
        25,
        0,
      ]);
    });
  });

  describe('frequency', () => {
    it('answers the four zero bins with no buyers', async () => {
      await expect(service.frequency({})).resolves.toEqual({
        bins: [
          { key: '1', users: 0, share: 0 },
          { key: '2-3', users: 0, share: 0 },
          { key: '4-9', users: 0, share: 0 },
          { key: '10+', users: 0, share: 0 },
        ],
        totalBuyers: 0,
        firstTime: 0,
        returning: 0,
        definition: 'draws-played',
      });
    });

    it('all time · all draws: returning = bought in two or more draws (the earliest-purchase rule would call everyone first-time)', async () => {
      answers = {
        'frequency-bins': [
          { totalBuyers: 200, one: 120, twoToThree: 50, fourToNine: 25, tenPlus: 5 },
        ],
        'frequency-draws-played': [{ buyers: 200, returning: 76 }],
      };

      const result = await service.frequency({});

      expect(result).toMatchObject({
        totalBuyers: 200,
        returning: 76,
        firstTime: 124,
        definition: 'draws-played',
      });
      expect(sent('frequency-first-time')).toHaveLength(0);
      const played = sent('frequency-draws-played')[0];
      expect(played.sql).toContain('COUNT(DISTINCT p."drawId")::int AS "draws"');
      expect(played.sql).toContain('FILTER (WHERE "draws" >= 2)');
      expect(played.sql).not.toContain('"createdAt" >=');
      expect(played.sql).not.toContain('"drawId" = ?');
    });

    it('a draw with no window still uses the earliest-purchase rule (first purchase was in that draw)', async () => {
      answers = {
        'frequency-bins': [
          { totalBuyers: 40, one: 40, twoToThree: 0, fourToNine: 0, tenPlus: 0 },
        ],
        'frequency-first-time': [{ buyers: 40, firstTime: 30 }],
      };

      const result = await service.frequency({ drawId: DRAW_ID });

      expect(result).toMatchObject({
        totalBuyers: 40,
        firstTime: 30,
        returning: 10,
        definition: 'earliest-purchase',
      });
      expect(sent('frequency-draws-played')).toHaveLength(0);
      const firstTime = sent('frequency-first-time')[0];
      expect(firstTime.sql).toContain('FILTER (WHERE "drawId" = ?)');
    });

    it('bins buyers by purchases made, with shares, and splits first-time from returning', async () => {
      answers = {
        'frequency-bins': [
          {
            totalBuyers: 200,
            one: 120,
            twoToThree: 50,
            fourToNine: 25,
            tenPlus: 5,
          },
        ],
        'frequency-first-time': [{ buyers: 200, firstTime: 140 }],
      };

      const result = await service.frequency({
        from: '2026-10-16',
        to: '2026-10-22',
        drawId: DRAW_ID,
      });

      expect(result).toEqual({
        bins: [
          { key: '1', users: 120, share: 0.6 },
          { key: '2-3', users: 50, share: 0.25 },
          { key: '4-9', users: 25, share: 0.125 },
          { key: '10+', users: 5, share: 0.025 },
        ],
        totalBuyers: 200,
        firstTime: 140,
        returning: 60,
        definition: 'earliest-purchase',
      });
      const firstTime = sent('frequency-first-time')[0];
      expect(firstTime.sql).toContain('DISTINCT ON (p."userId")');
      expect(firstTime.sql).toContain(
        '"createdAt" >= ? AND "createdAt" < ? AND "drawId" = ?',
      );
      expect(firstTime.values).toEqual([
        START,
        END,
        DRAW_ID,
        START,
        END,
        DRAW_ID,
      ]);
    });
  });

  describe('heatmap', () => {
    it('always answers 168 zero-filled cells, weekday-major, with both measures merged in', async () => {
      answers = {
        heatmap: [
          { weekday: 5, hour: 20, ticketsSold: 33, purchasingUsers: 12 },
        ],
      };

      const { cells } = await service.heatmap({ drawId: DRAW_ID });

      expect(cells).toHaveLength(168);
      expect(cells[0]).toEqual({
        weekday: 0,
        hour: 0,
        ticketsSold: 0,
        purchasingUsers: 0,
      });
      expect(cells[23]).toMatchObject({ weekday: 0, hour: 23 });
      expect(cells[24]).toMatchObject({ weekday: 1, hour: 0 });
      expect(cells[5 * 24 + 20]).toEqual({
        weekday: 5,
        hour: 20,
        ticketsSold: 33,
        purchasingUsers: 12,
      });
      expect(cells[167]).toMatchObject({ weekday: 6, hour: 23 });
      expect(sent('heatmap')[0].sql).toContain('extract(isodow FROM');
      expect(sent('heatmap')[0].values).toContain(DRAW_ID);
    });
  });

  describe('beforeClose', () => {
    const CLOSE = new Date('2026-11-01T06:30:00.000Z');

    it('404s LOTTERY_DRAW_NOT_FOUND when there is no closed or published draw yet', async () => {
      await expect(service.beforeClose({})).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
        status: 404,
      });
      await expect(service.beforeClose({})).rejects.toBeInstanceOf(
        CodedHttpException,
      );
      expect(prisma.lotteryDraw.findFirst).toHaveBeenCalledWith({
        where: { status: { in: ['CLOSED', 'PUBLISHED'] } },
        orderBy: [{ drawAt: 'desc' }, { drawNo: 'desc' }],
      });
    });

    it('404s an unknown draw id', async () => {
      await expect(
        service.beforeClose({ drawId: DRAW_ID }),
      ).rejects.toMatchObject({ code: LOTTERY_ERRORS.DRAW_NOT_FOUND });
      expect(prisma.lotteryDraw.findUnique).toHaveBeenCalledWith({
        where: { id: DRAW_ID },
      });
      expect(prisma.lotteryDraw.findFirst).not.toHaveBeenCalled();
    });

    it('bins a closed draw’s tickets against its sales close, binding the seven edges', async () => {
      prisma.lotteryDraw.findFirst.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.PUBLISHED, salesCloseAt: CLOSE }),
      );
      answers = {
        'before-close': [
          {
            total: 13855,
            earlier: 5265,
            b0: 1100,
            b1: 1800,
            b2: 1600,
            b3: 1300,
            b4: 1990,
            b5: 800,
          },
        ],
      };

      const result = await service.beforeClose({});

      expect(result).toEqual({
        draw: {
          id: DRAW_ID,
          drawNo: 24,
          thaiDrawDate: '2026-11-01',
          status: 'published',
          salesCloseAt: CLOSE,
        },
        closed: true,
        bins: [
          { key: '72-48h', tickets: 1100, hours: 24 },
          { key: '48-24h', tickets: 1800, hours: 24 },
          { key: '24-12h', tickets: 1600, hours: 12 },
          { key: '12-6h', tickets: 1300, hours: 6 },
          { key: '6-1h', tickets: 1990, hours: 5 },
          { key: 'last-1h', tickets: 800, hours: 1 },
        ],
        earlier: 5265,
        total: 13855,
      });
      const query = sent('before-close')[0];
      const edges = [72, 48, 24, 12, 6, 1].map(
        (h) => new Date(CLOSE.getTime() - h * 3_600_000),
      );
      // earlier (< e0), five closed bins (e_i <= x < e_i+1), the open last bin (>= e5), then the draw.
      expect(query.values).toEqual([
        edges[0],
        edges[0],
        edges[1],
        edges[1],
        edges[2],
        edges[2],
        edges[3],
        edges[3],
        edges[4],
        edges[4],
        edges[5],
        edges[5],
        DRAW_ID,
      ]);
      expect(query.sql).toContain('AS "b5"');
      expect(query.sql).not.toContain('"createdAt" < ?))::int AS "b5"');
    });

    it('still answers for an open draw, flagged closed=false, with zero bins before any sale', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.OPEN, salesCloseAt: CLOSE }),
      );

      const result = await service.beforeClose({ drawId: DRAW_ID });

      expect(result.closed).toBe(false);
      expect(result.draw.status).toBe('open');
      expect(result.bins.map((bin) => bin.tickets)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(result).toMatchObject({ earlier: 0, total: 0 });
    });
  });

  describe('draws', () => {
    it('pages every draw newest first with its figures from one stats query', async () => {
      const published = makeDraw({
        status: LotteryDrawStatus.PUBLISHED,
        openedAt: new Date('2026-10-20T03:00:00.000Z'),
        winnersCount: 31,
        prizesPaidKs: new Prisma.Decimal('2750000'),
      });
      const open = makeDraw({
        id: 'draw-25',
        drawNo: 25,
        status: LotteryDrawStatus.OPEN,
        thaiDrawDate: new Date('2026-11-16T00:00:00Z'),
      });
      prisma.lotteryDraw.findMany.mockResolvedValue([open, published]);
      prisma.lotteryDraw.count.mockResolvedValue(2);
      answers = {
        'draw-stats': [
          {
            drawId: DRAW_ID,
            tickets: 13855,
            buyers: 2140,
            revenueKs: '13855000.00',
            peakHour: 20,
          },
        ],
      };

      const page = await service.draws({ page: 1, pageSize: 25 });

      expect(prisma.lotteryDraw.findMany).toHaveBeenCalledWith({
        orderBy: [{ drawAt: 'desc' }, { drawNo: 'desc' }],
        skip: 0,
        take: 25,
      });
      expect(page).toEqual({
        items: [
          {
            id: 'draw-25',
            drawNo: 25,
            thaiDrawDate: '2026-11-16',
            status: 'open',
            openedAt: null,
            salesCloseAt: open.salesCloseAt,
            tickets: 0,
            buyers: 0,
            revenueKs: '0.00',
            peakHour: null,
            winnersCount: null,
            prizesPaidKs: null,
          },
          {
            id: DRAW_ID,
            drawNo: 24,
            thaiDrawDate: '2026-11-01',
            status: 'published',
            openedAt: new Date('2026-10-20T03:00:00.000Z'),
            salesCloseAt: published.salesCloseAt,
            tickets: 13855,
            buyers: 2140,
            revenueKs: '13855000.00',
            peakHour: 20,
            winnersCount: 31,
            prizesPaidKs: '2750000.00',
          },
        ],
        total: 2,
        page: 1,
        pageSize: 25,
      });
      expect(sent('draw-stats')[0].values).toEqual(
        expect.arrayContaining(['draw-25', DRAW_ID]),
      );
    });

    it('skips the stats query for an empty page and applies the defaults', async () => {
      const page = await service.draws({});

      expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
      expect(sent('draw-stats')).toHaveLength(0);
    });
  });
});
