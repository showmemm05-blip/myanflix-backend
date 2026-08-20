import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { UpdateFinanceSettingsDto } from './dto/update-finance-settings.dto';
import { FinanceSettingsService } from './finance-settings.service';

/**
 * No class-level guard — GET is readable by any authenticated user (deposit/
 * withdrawal forms need the current limits to validate/hint client-side),
 * while PATCH is restricted to FINANCE_SETTINGS_MANAGE below.
 */
@Controller('finance-settings')
export class FinanceSettingsController {
  constructor(
    private readonly financeSettingsService: FinanceSettingsService,
  ) {}

  @Get()
  get() {
    return this.financeSettingsService.getOrCreate();
  }

  @Patch()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('FINANCE.SETTINGS_MANAGE')
  update(
    @Body() dto: UpdateFinanceSettingsDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.financeSettingsService.update(dto, admin.id);
  }
}
