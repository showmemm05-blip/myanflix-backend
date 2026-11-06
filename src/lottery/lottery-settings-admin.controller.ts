import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { UpdateLotterySettingsDto } from './dto/lottery-settings.dto';
import { LotterySettingsService } from './lottery-settings.service';

/**
 * The admin "Lottery > Settings" page. LOTTERY.VIEW reads,
 * LOTTERY.SETTINGS_MANAGE changes; every change is audited by the
 * service. Unlike /finance-settings, the GET is staff-only: the apps never
 * need these values directly (a draw carries its own price and limit).
 */
@Controller('lottery/admin/settings')
@UseGuards(PermissionsGuard)
export class LotterySettingsAdminController {
  constructor(private readonly settings: LotterySettingsService) {}

  @Get()
  @RequirePermissions('LOTTERY.VIEW')
  get() {
    return this.settings.get();
  }

  @Patch()
  @RequirePermissions('LOTTERY.SETTINGS_MANAGE')
  update(
    @Body() dto: UpdateLotterySettingsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.settings.update(dto, actor);
  }
}
