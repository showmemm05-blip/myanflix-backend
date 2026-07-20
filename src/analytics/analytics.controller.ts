import { Controller, Get, UseGuards } from '@nestjs/common';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
@UseGuards(PermissionsGuard)
@RequirePermissions(Permission.FINANCE_VIEW)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  getOverview() {
    return this.analyticsService.getOverview();
  }

  @Get('user-growth')
  getUserGrowth() {
    return this.analyticsService.getUserGrowthTrend();
  }
}
