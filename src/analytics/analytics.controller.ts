import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { AnalyticsService } from './analytics.service';

/**
 * The admin dashboard's non-money stats (counts, views, user growth). Gated
 * on DASHBOARD.VIEW, the permission that opens the dashboard page itself, so
 * every role that can land there can load it (H-26: the seeded Admin holds
 * DASHBOARD.VIEW but not FINANCE.VIEW and used to get a 403 page). The one
 * money figure in the overview, `revenue`, is still FINANCE.VIEW-only: it is
 * null for anyone else. /finance/* stays FINANCE.VIEW as before.
 */
@Controller('analytics')
@UseGuards(PermissionsGuard)
@RequirePermissions('DASHBOARD.VIEW')
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly resolver: PermissionResolverService,
  ) {}

  @Get('overview')
  async getOverview(@CurrentUser() actor: AuthenticatedUser) {
    return this.analyticsService.getOverview({
      includeRevenue: await this.resolver.can(actor, 'FINANCE.VIEW'),
    });
  }

  @Get('user-growth')
  getUserGrowth() {
    return this.analyticsService.getUserGrowthTrend();
  }
}
