import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { UpdateAdditionalPeakDto } from './dto/update-additional-peak.dto';
import { PeakUsersService } from './peak-users.service';

/**
 * No class-level guard — GET / is public (the userwebsite home page is
 * unauthenticated), while the admin view and the PATCH are restricted to
 * PEAK_USERS_MANAGE below.
 */
@Controller('peak-users')
export class PeakUsersController {
  constructor(private readonly peakUsersService: PeakUsersService) {}

  /** Public total only — never exposes the actual/additional split. */
  @Public()
  @Get()
  getPublicTotal() {
    return this.peakUsersService.getPublicTotal();
  }

  @Get('admin')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('PEAK_USERS.VIEW')
  getAdminView() {
    return this.peakUsersService.getAdminView();
  }

  @Patch('additional')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('PEAK_USERS.MANAGE')
  updateAdditional(
    @Body() dto: UpdateAdditionalPeakDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.peakUsersService.setAdditional(dto, admin.id);
  }
}
