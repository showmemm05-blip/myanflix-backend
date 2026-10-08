import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../generated/prisma/client';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { SmsDeviceBindingService } from './sms-device-binding.service';
import { SmsGatewayService } from './sms-gateway.service';

export const SMS_BINDING_RESET_SUPER_ADMIN_ONLY =
  'Only a super admin can reset the SMS gateway device';

/**
 * The admin's "SMS gateway" card. Staff only: SETTINGS.VIEW, which the
 * system roles grant to SUPER_ADMIN alone (the owner can grant it to other
 * roles from the roles matrix). A read — no audit row.
 *
 * DELETE /sms-gateway/binding clears the device pin of the gateway token
 * (H-5 / H-7) so a reinstalled or replaced phone can register. Super admin
 * only — SETTINGS.MANAGE and the SUPER_ADMIN role itself, whatever the
 * roles matrix says — and it writes an audit row.
 */
@Controller('sms-gateway')
export class SmsGatewayStatusController {
  constructor(
    private readonly gateway: SmsGatewayService,
    private readonly binding: SmsDeviceBindingService,
  ) {}

  @Get('status')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('SETTINGS.VIEW')
  status() {
    return this.gateway.status();
  }

  @Delete('binding')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('SETTINGS.MANAGE')
  resetBinding(@CurrentUser() actor: AuthenticatedUser) {
    if (actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(SMS_BINDING_RESET_SUPER_ADMIN_ONLY);
    }
    return this.binding.reset(actor);
  }
}
