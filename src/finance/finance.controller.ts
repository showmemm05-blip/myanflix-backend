import { Controller, Get, UseGuards } from '@nestjs/common';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { FinanceService } from './finance.service';

@Controller('finance')
@UseGuards(PermissionsGuard)
@RequirePermissions(Permission.FINANCE_VIEW)
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  @Get('dashboard')
  getDashboard() {
    return this.financeService.getDashboard();
  }

  @Get('revenue-trend')
  getRevenueTrend() {
    return this.financeService.getRevenueTrend();
  }
}
