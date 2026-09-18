import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { VerificationReviewDto } from '../deposits/dto/verification-review.dto';
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
  @RequirePermissions('WITHDRAWALS.VIEW')
  findAll(@Query() query: WithdrawalQueryDto) {
    return this.withdrawalsService.findAllAdmin(query);
  }

  @Patch(':id/approve')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('WITHDRAWALS.APPROVE')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.withdrawalsService.approve(id, admin);
  }

  @Patch(':id/reject')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('WITHDRAWALS.REJECT')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectWithdrawalDto,
  ) {
    return this.withdrawalsService.reject(id, admin, dto);
  }

  @Patch(':id/transfer-account')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('WITHDRAWALS.EDIT')
  updateTransferAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTransferAccountDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.withdrawalsService.updateTransferAccount(id, dto, admin);
  }

  /** Staff review of the bank-verification flags — reuses WITHDRAWALS.EDIT. */
  @Patch(':id/verification')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('WITHDRAWALS.EDIT')
  reviewVerification(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerificationReviewDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.withdrawalsService.reviewVerification(id, dto, admin);
  }

  /** Mirrors DepositsController.bankScreenshot — see its doc comment. */
  @Get(':id/bank-screenshot')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('WITHDRAWALS.BANK_EVIDENCE')
  async bankScreenshot(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'private, no-store');
    return this.withdrawalsService.getBankScreenshot(id);
  }
}
