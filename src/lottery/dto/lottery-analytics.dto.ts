import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { OptionalCalendarDate } from './lottery-draw.dto';

/** The activity chart's bucketing (GET /lottery/admin/analytics/activity?view=). */
export const ANALYTICS_VIEWS = [
  'hourly',
  'daily',
  'weekly',
  'weekday',
] as const;
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

/** Sort keys of the popular-numbers table (one draw / the period). */
export const NUMBERS_SORTS = ['tickets', 'buyers', 'repeat'] as const;
export type NumbersSort = (typeof NUMBERS_SORTS)[number];

/** Sort keys of the across-all-draws table. */
export const ACROSS_SORTS = ['tickets', 'buyers', 'draws'] as const;
export type AcrossSort = (typeof ACROSS_SORTS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** The heatmap's measure toggle; both values come back per cell whatever is asked. */
export const HEATMAP_MEASURES = ['tickets', 'purchasingUsers'] as const;
export type HeatmapMeasure = (typeof HEATMAP_MEASURES)[number];

export const ANALYTICS_PAGE_SIZE_DEFAULT = 10;
/** The CSV export fetches up to 1000 numbers in one page. */
export const ANALYTICS_PAGE_SIZE_MAX = 1000;
export const ANALYTICS_DRAWS_PAGE_SIZE_DEFAULT = 25;
export const ANALYTICS_DRAWS_PAGE_SIZE_MAX = 100;
/**
 * The highest page any analytics list accepts. There are at most a million
 * six-digit numbers, so 100,000 pages of 10 already reach past every row;
 * the cap keeps `(page − 1) × pageSize` (the SQL OFFSET, an int4) well
 * under 2^31 — a hand-typed page beyond it was a 500 from Postgres
 * ("integer out of range") instead of a 400.
 */
export const ANALYTICS_PAGE_MAX = 100_000;

/**
 * `from` / `to`: MMT calendar dates (YYYY-MM-DD, inclusive), both or
 * neither — the service refuses one without the other, `from` after `to`
 * and a span over 366 days (LotteryAnalyticsService.resolvePeriod). Both
 * absent = the endpoint's default (the dashboard: the last 7 full MMT days;
 * the reports: all time). `drawId` narrows purchases and tickets to one
 * draw; the activity series is never draw-scoped (a ping has no draw).
 */
export class AnalyticsPeriodQueryDto {
  @OptionalCalendarDate()
  from?: string;

  @OptionalCalendarDate()
  to?: string;

  @IsOptional()
  @IsUUID()
  drawId?: string;
}

/** GET /lottery/admin/analytics/activity?view= — hourly unless asked otherwise. */
export class AnalyticsActivityQueryDto extends AnalyticsPeriodQueryDto {
  @IsOptional()
  @IsIn(ANALYTICS_VIEWS)
  view?: AnalyticsView = 'hourly';
}

/** GET /lottery/admin/analytics/numbers — tickets desc, 10 a page, up to 1000. */
export class AnalyticsNumbersQueryDto extends AnalyticsPeriodQueryDto {
  @IsOptional()
  @IsIn(NUMBERS_SORTS)
  sort?: NumbersSort = 'tickets';

  @IsOptional()
  @IsIn(SORT_ORDERS)
  order?: SortOrder = 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ANALYTICS_PAGE_MAX)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ANALYTICS_PAGE_SIZE_MAX)
  pageSize?: number = ANALYTICS_PAGE_SIZE_DEFAULT;
}

/**
 * GET /lottery/admin/analytics/numbers/across — the same page shape with
 * no drawId ("never limited by the draw select": the global ValidationPipe
 * refuses one) and `draws` as the third sort key.
 */
export class AnalyticsNumbersAcrossQueryDto {
  @OptionalCalendarDate()
  from?: string;

  @OptionalCalendarDate()
  to?: string;

  @IsOptional()
  @IsIn(ACROSS_SORTS)
  sort?: AcrossSort = 'tickets';

  @IsOptional()
  @IsIn(SORT_ORDERS)
  order?: SortOrder = 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ANALYTICS_PAGE_MAX)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ANALYTICS_PAGE_SIZE_MAX)
  pageSize?: number = ANALYTICS_PAGE_SIZE_DEFAULT;
}

/** GET /lottery/admin/analytics/heatmap?measure= — accepted for symmetry with the admin's toggle; both measures are always returned. */
export class AnalyticsHeatmapQueryDto extends AnalyticsPeriodQueryDto {
  @IsOptional()
  @IsIn(HEATMAP_MEASURES)
  measure?: HeatmapMeasure;
}

/** GET /lottery/admin/analytics/before-close?drawId= — absent = the most recent closed or published draw. */
export class AnalyticsBeforeCloseQueryDto {
  @IsOptional()
  @IsUUID()
  drawId?: string;
}

/** GET /lottery/admin/analytics/draws — newest first, 25 a page, up to 100. */
export class AnalyticsDrawsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ANALYTICS_PAGE_MAX)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ANALYTICS_DRAWS_PAGE_SIZE_MAX)
  pageSize?: number = ANALYTICS_DRAWS_PAGE_SIZE_DEFAULT;
}
