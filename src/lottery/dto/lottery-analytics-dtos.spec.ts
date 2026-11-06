import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ANALYTICS_DRAWS_PAGE_SIZE_DEFAULT,
  ANALYTICS_DRAWS_PAGE_SIZE_MAX,
  ANALYTICS_PAGE_MAX,
  ANALYTICS_PAGE_SIZE_DEFAULT,
  ANALYTICS_PAGE_SIZE_MAX,
  AnalyticsActivityQueryDto,
  AnalyticsBeforeCloseQueryDto,
  AnalyticsDrawsQueryDto,
  AnalyticsHeatmapQueryDto,
  AnalyticsNumbersAcrossQueryDto,
  AnalyticsNumbersQueryDto,
  AnalyticsPeriodQueryDto,
} from './lottery-analytics.dto';

/** The same options as the global ValidationPipe in app.module.ts. */
const TRANSFORM = { enableImplicitConversion: true } as const;

async function errorsOf<T extends object>(
  Dto: new () => T,
  query: Record<string, unknown>,
) {
  const instance = plainToInstance(Dto, query, TRANSFORM);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, fields: errors.map((e) => e.property).sort() };
}

const DRAW_ID = '33333333-3333-4333-8333-333333333333';

describe('AnalyticsPeriodQueryDto', () => {
  it('accepts nothing at all, a from/to pair and a draw id', async () => {
    expect((await errorsOf(AnalyticsPeriodQueryDto, {})).fields).toEqual([]);
    const { instance, fields } = await errorsOf(AnalyticsPeriodQueryDto, {
      from: '2026-10-16',
      to: '2026-10-22',
      drawId: DRAW_ID,
    });
    expect(fields).toEqual([]);
    expect(instance).toEqual({
      from: '2026-10-16',
      to: '2026-10-22',
      drawId: DRAW_ID,
    });
  });

  it('reads an empty from/to as absent (the admin sends nothing for "all time")', async () => {
    const { instance, fields } = await errorsOf(AnalyticsPeriodQueryDto, {
      from: '',
      to: ' ',
    });
    expect(fields).toEqual([]);
    expect(instance.from).toBeUndefined();
    expect(instance.to).toBeUndefined();
  });

  it('refuses a date that is not a calendar day, a wrong format and a non-uuid draw id', async () => {
    expect(
      (
        await errorsOf(AnalyticsPeriodQueryDto, {
          from: '2026-02-30',
          to: '2026-03-01',
        })
      ).fields,
    ).toEqual(['from']);
    expect(
      (
        await errorsOf(AnalyticsPeriodQueryDto, {
          from: '16/10/2026',
          to: '2026-10-22',
        })
      ).fields,
    ).toEqual(['from']);
    expect(
      (await errorsOf(AnalyticsPeriodQueryDto, { drawId: 'draw-1' })).fields,
    ).toEqual(['drawId']);
  });

  it('refuses an unknown field', async () => {
    expect(
      (await errorsOf(AnalyticsPeriodQueryDto, { since: '2026-10-16' })).fields,
    ).toEqual(['since']);
  });
});

describe('AnalyticsActivityQueryDto', () => {
  it('defaults the view to hourly and accepts the four views', async () => {
    expect((await errorsOf(AnalyticsActivityQueryDto, {})).instance.view).toBe(
      'hourly',
    );
    for (const view of ['hourly', 'daily', 'weekly', 'weekday']) {
      const { instance, fields } = await errorsOf(AnalyticsActivityQueryDto, {
        view,
      });
      expect(fields).toEqual([]);
      expect(instance.view).toBe(view);
    }
  });

  it('refuses any other view', async () => {
    expect(
      (await errorsOf(AnalyticsActivityQueryDto, { view: 'monthly' })).fields,
    ).toEqual(['view']);
  });
});

describe('AnalyticsNumbersQueryDto', () => {
  it('defaults to tickets desc, page 1 of 10', async () => {
    const { instance, fields } = await errorsOf(AnalyticsNumbersQueryDto, {});
    expect(fields).toEqual([]);
    expect(instance).toMatchObject({
      sort: 'tickets',
      order: 'desc',
      page: 1,
      pageSize: ANALYTICS_PAGE_SIZE_DEFAULT,
    });
  });

  it('accepts the three sorts, both orders and a page size up to 1000 (the CSV export)', async () => {
    for (const sort of ['tickets', 'buyers', 'repeat']) {
      expect(
        (await errorsOf(AnalyticsNumbersQueryDto, { sort, order: 'asc' }))
          .fields,
      ).toEqual([]);
    }
    const { instance, fields } = await errorsOf(AnalyticsNumbersQueryDto, {
      page: '3',
      pageSize: String(ANALYTICS_PAGE_SIZE_MAX),
      drawId: DRAW_ID,
    });
    expect(fields).toEqual([]);
    expect(instance).toMatchObject({
      page: 3,
      pageSize: 1000,
      drawId: DRAW_ID,
    });
  });

  it('refuses a page size over 1000, page 0, an across-only sort and a wrong order', async () => {
    expect(
      (await errorsOf(AnalyticsNumbersQueryDto, { pageSize: 1001 })).fields,
    ).toEqual(['pageSize']);
    expect(
      (await errorsOf(AnalyticsNumbersQueryDto, { page: 0 })).fields,
    ).toEqual(['page']);
    expect(
      (await errorsOf(AnalyticsNumbersQueryDto, { sort: 'draws' })).fields,
    ).toEqual(['sort']);
    expect(
      (await errorsOf(AnalyticsNumbersQueryDto, { order: 'up' })).fields,
    ).toEqual(['order']);
  });

  it('caps the page so the SQL OFFSET can never leave int4 (a 400, not a 500)', async () => {
    expect(
      (await errorsOf(AnalyticsNumbersQueryDto, { page: ANALYTICS_PAGE_MAX }))
        .fields,
    ).toEqual([]);
    expect(
      (
        await errorsOf(AnalyticsNumbersQueryDto, {
          page: ANALYTICS_PAGE_MAX + 1,
          pageSize: ANALYTICS_PAGE_SIZE_MAX,
        })
      ).fields,
    ).toEqual(['page']);
    // The largest accepted offset stays far below 2^31 − 1.
    expect(ANALYTICS_PAGE_MAX * ANALYTICS_PAGE_SIZE_MAX).toBeLessThan(2 ** 31);
  });
});

describe('AnalyticsNumbersAcrossQueryDto', () => {
  it('accepts the draws sort and the usual paging, with the same defaults', async () => {
    const { instance, fields } = await errorsOf(
      AnalyticsNumbersAcrossQueryDto,
      {
        sort: 'draws',
        order: 'asc',
        from: '2026-10-01',
        to: '2026-10-31',
      },
    );
    expect(fields).toEqual([]);
    expect(instance).toMatchObject({
      sort: 'draws',
      order: 'asc',
      page: 1,
      pageSize: ANALYTICS_PAGE_SIZE_DEFAULT,
    });
  });

  it('is never limited by a draw: drawId is refused, and so is the numbers-only sort', async () => {
    expect(
      (await errorsOf(AnalyticsNumbersAcrossQueryDto, { drawId: DRAW_ID }))
        .fields,
    ).toEqual(['drawId']);
    expect(
      (await errorsOf(AnalyticsNumbersAcrossQueryDto, { sort: 'repeat' }))
        .fields,
    ).toEqual(['sort']);
  });

  it('caps the page like the numbers table', async () => {
    expect(
      (
        await errorsOf(AnalyticsNumbersAcrossQueryDto, {
          page: ANALYTICS_PAGE_MAX + 1,
        })
      ).fields,
    ).toEqual(['page']);
  });
});

describe('AnalyticsHeatmapQueryDto', () => {
  it('accepts no measure or one of the two, and refuses another', async () => {
    expect((await errorsOf(AnalyticsHeatmapQueryDto, {})).fields).toEqual([]);
    expect(
      (await errorsOf(AnalyticsHeatmapQueryDto, { measure: 'tickets' })).fields,
    ).toEqual([]);
    expect(
      (await errorsOf(AnalyticsHeatmapQueryDto, { measure: 'purchasingUsers' }))
        .fields,
    ).toEqual([]);
    expect(
      (await errorsOf(AnalyticsHeatmapQueryDto, { measure: 'activeUsers' }))
        .fields,
    ).toEqual(['measure']);
  });
});

describe('AnalyticsBeforeCloseQueryDto', () => {
  it('accepts no draw or a uuid, refuses anything else', async () => {
    expect((await errorsOf(AnalyticsBeforeCloseQueryDto, {})).fields).toEqual(
      [],
    );
    expect(
      (await errorsOf(AnalyticsBeforeCloseQueryDto, { drawId: DRAW_ID }))
        .fields,
    ).toEqual([]);
    expect(
      (await errorsOf(AnalyticsBeforeCloseQueryDto, { drawId: '24' })).fields,
    ).toEqual(['drawId']);
    expect(
      (await errorsOf(AnalyticsBeforeCloseQueryDto, { from: '2026-10-01' }))
        .fields,
    ).toEqual(['from']);
  });
});

describe('AnalyticsDrawsQueryDto', () => {
  it('defaults to page 1 of 25 and allows up to 100', async () => {
    const { instance, fields } = await errorsOf(AnalyticsDrawsQueryDto, {});
    expect(fields).toEqual([]);
    expect(instance).toEqual({
      page: 1,
      pageSize: ANALYTICS_DRAWS_PAGE_SIZE_DEFAULT,
    });
    expect(
      (
        await errorsOf(AnalyticsDrawsQueryDto, {
          pageSize: ANALYTICS_DRAWS_PAGE_SIZE_MAX,
        })
      ).fields,
    ).toEqual([]);
    expect(
      (await errorsOf(AnalyticsDrawsQueryDto, { pageSize: 101 })).fields,
    ).toEqual(['pageSize']);
    expect(
      (await errorsOf(AnalyticsDrawsQueryDto, { page: ANALYTICS_PAGE_MAX + 1 }))
        .fields,
    ).toEqual(['page']);
  });
});
