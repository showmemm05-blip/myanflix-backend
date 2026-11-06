import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../../roles/guards/permissions.guard';
import {
  AnalyticsActivityQueryDto,
  AnalyticsBeforeCloseQueryDto,
  AnalyticsDrawsQueryDto,
  AnalyticsHeatmapQueryDto,
  AnalyticsNumbersAcrossQueryDto,
  AnalyticsNumbersQueryDto,
  AnalyticsPeriodQueryDto,
} from '../dto/lottery-analytics.dto';
import { LotteryAnalyticsService } from './lottery-analytics.service';

/**
 * The admin "Lottery > Analytics" dashboard and its Reports page. Every
 * route is a LOTTERY.VIEW read; nothing here changes anything. Periods
 * are MMT calendar days (see AnalyticsPeriodQueryDto); the dashboard
 * routes (overview, activity) default to the last 7 full days, the
 * report routes to all time.
 */
@Controller('lottery/admin/analytics')
@UseGuards(PermissionsGuard)
export class LotteryAnalyticsAdminController {
  constructor(private readonly analytics: LotteryAnalyticsService) {}

  @Get('overview')
  @RequirePermissions('LOTTERY.VIEW')
  overview(@Query() query: AnalyticsPeriodQueryDto) {
    return this.analytics.overview(query);
  }

  @Get('activity')
  @RequirePermissions('LOTTERY.VIEW')
  activity(@Query() query: AnalyticsActivityQueryDto) {
    return this.analytics.activity(query);
  }

  @Get('numbers')
  @RequirePermissions('LOTTERY.VIEW')
  numbers(@Query() query: AnalyticsNumbersQueryDto) {
    return this.analytics.numbers(query);
  }

  /** Never limited by the draw select — the DTO has no drawId. */
  @Get('numbers/across')
  @RequirePermissions('LOTTERY.VIEW')
  numbersAcross(@Query() query: AnalyticsNumbersAcrossQueryDto) {
    return this.analytics.numbersAcross(query);
  }

  @Get('frequency')
  @RequirePermissions('LOTTERY.VIEW')
  frequency(@Query() query: AnalyticsPeriodQueryDto) {
    return this.analytics.frequency(query);
  }

  /** `measure` is accepted (the admin's toggle) but both measures always come back per cell. */
  @Get('heatmap')
  @RequirePermissions('LOTTERY.VIEW')
  heatmap(@Query() query: AnalyticsHeatmapQueryDto) {
    return this.analytics.heatmap(query);
  }

  @Get('before-close')
  @RequirePermissions('LOTTERY.VIEW')
  beforeClose(@Query() query: AnalyticsBeforeCloseQueryDto) {
    return this.analytics.beforeClose(query);
  }

  @Get('draws')
  @RequirePermissions('LOTTERY.VIEW')
  draws(@Query() query: AnalyticsDrawsQueryDto) {
    return this.analytics.draws(query);
  }
}
