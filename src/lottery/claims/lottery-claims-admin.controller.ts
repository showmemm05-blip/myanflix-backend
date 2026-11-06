import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { RequirePermissions } from '../../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../../roles/guards/permissions.guard';
import {
  AdminClaimsQueryDto,
  AdminClaimsSummaryQueryDto,
  RejectClaimDto,
} from '../dto/lottery-claim.dto';
import { LotteryClaimsAdminService } from './lottery-claims-admin.service';

/**
 * The admin "Lottery > Prize claims" page (2026-10-24): the list, the
 * tiles and one claim read with LOTTERY.VIEW; confirm (the one wallet
 * credit), reject and reopen with LOTTERY.CLAIMS_CONFIRM, the permission
 * that exists because confirming moves money. Every decision is audited
 * by the service. `summary` is declared before `:id` so the word never
 * reaches the uuid pipe.
 */
@Controller('lottery/admin/claims')
@UseGuards(PermissionsGuard)
export class LotteryClaimsAdminController {
  constructor(private readonly claims: LotteryClaimsAdminService) {}

  @Get()
  @RequirePermissions('LOTTERY.VIEW')
  list(@Query() query: AdminClaimsQueryDto) {
    return this.claims.list(query);
  }

  @Get('summary')
  @RequirePermissions('LOTTERY.VIEW')
  summary(@Query() query: AdminClaimsSummaryQueryDto) {
    return this.claims.summary(query.drawId);
  }

  @Get(':id')
  @RequirePermissions('LOTTERY.VIEW')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.claims.detail(id);
  }

  /** Pays the claim once; answers 200 with the detail, like the other staff decisions. */
  @Post(':id/confirm')
  @RequirePermissions('LOTTERY.CLAIMS_CONFIRM')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.claims.confirm(id, actor);
  }

  @Post(':id/reject')
  @RequirePermissions('LOTTERY.CLAIMS_CONFIRM')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectClaimDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.claims.reject(id, dto, actor);
  }

  @Post(':id/reopen')
  @RequirePermissions('LOTTERY.CLAIMS_CONFIRM')
  @HttpCode(HttpStatus.OK)
  reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.claims.reopen(id, actor);
  }
}
