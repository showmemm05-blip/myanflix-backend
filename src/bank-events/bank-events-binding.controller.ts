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
import { BankEventsDeviceBindingService } from './bank-events-device-binding.service';

export const BANK_EVENTS_BINDING_RESET_SUPER_ADMIN_ONLY =
  'Only a super admin can reset the bank-events phone-monitor';

/**
 * The admin's "Bank monitor" card — the STAFF side of the device pin, a
 * JWT controller like SmsGatewayStatusController (never @Public(), never
 * MachineTokenGuard: the machine token opens nothing here, and no JWT
 * opens the ingestion routes on BankEventsController).
 *
 * GET /bank-events/binding: SETTINGS.VIEW, which the system roles grant to
 * SUPER_ADMIN alone (the owner can grant it from the roles matrix). A read
 * — no audit row.
 *
 * DELETE /bank-events/binding clears the device pin of BANK_EVENTS_TOKEN
 * (SEC-004) so a reinstalled or moved phone-monitor can register. Super
 * admin only — SETTINGS.MANAGE and the SUPER_ADMIN role itself, whatever
 * the roles matrix says, exactly like the SMS reset — and it writes an
 * audit row.
 */
@Controller('bank-events')
export class BankEventsBindingController {
  constructor(private readonly binding: BankEventsDeviceBindingService) {}

  @Get('binding')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('SETTINGS.VIEW')
  view() {
    return this.binding.view();
  }

  @Delete('binding')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('SETTINGS.MANAGE')
  resetBinding(@CurrentUser() actor: AuthenticatedUser) {
    if (actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(BANK_EVENTS_BINDING_RESET_SUPER_ADMIN_ONLY);
    }
    return this.binding.reset(actor);
  }
}
