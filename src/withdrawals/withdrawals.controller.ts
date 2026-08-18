import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { RejectWithdrawalDto } from './dto/reject-withdrawal.dto';
import { UpdateTransferAccountDto } from './dto/update-transfer-account.dto';
import { WithdrawalQueryDto } from './dto/withdrawal-query.dto';
import { WithdrawalsService } from './withdrawals.service';

/**
 * No class-level guard here — `create`/`findMine` are self-service (any
 * authenticated role, ownership-scoped by @CurrentUser()), while the admin
 * routes below need WITHDRAWAL_MANAGE. Same per-route pattern as
 * DepositsController.
 */
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWithdrawalDto,
  ) {
    return this.withdrawalsService.create(user.id, dto);
  }

  @Get('me')
  findMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WithdrawalQueryDto,
  ) {
    return this.withdrawalsService.findAllForUser(user.id, query);
  }

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.WITHDRAWAL_MANAGE)
  findAll(@Query() query: WithdrawalQueryDto) {
    return this.withdrawalsService.findAllAdmin(query);
  }

  @Patch(':id/approve')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.WITHDRAWAL_MANAGE)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.withdrawalsService.approve(id, admin);
  }

  @Patch(':id/reject')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.WITHDRAWAL_MANAGE)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectWithdrawalDto,
  ) {
    return this.withdrawalsService.reject(id, admin, dto);
  }

  @Patch(':id/transfer-account')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.WITHDRAWAL_MANAGE)
  updateTransferAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTransferAccountDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.withdrawalsService.updateTransferAccount(id, dto, admin);
  }
}
