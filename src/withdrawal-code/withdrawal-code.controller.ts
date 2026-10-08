import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ThrottleAuth } from '../common/throttling/throttling.config';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { ChangeWithdrawalCodeDto } from './dto/change-withdrawal-code.dto';
import { ConfirmWithdrawalCodeResetDto } from './dto/confirm-withdrawal-code-reset.dto';
import { CreateWithdrawalCodeDto } from './dto/create-withdrawal-code.dto';
import { VerifyWithdrawalCodeDto } from './dto/verify-withdrawal-code.dto';
import { VerifyWithdrawalCodeResetDto } from './dto/verify-withdrawal-code-reset.dto';
import { WithdrawalCodeService } from './withdrawal-code.service';

/**
 * The signed-in account's OWN withdrawal code — self-service like the other
 * /users/me routes: any authenticated role, scoped by @CurrentUser(), no
 * permission needed (the global JwtAuthGuard is the gate). Its own
 * controller so UsersController's class-level USERS.VIEW floor never
 * applies. Nothing here returns the code or its hash.
 *
 * Every route that judges a code (or sends an SMS) carries @ThrottleAuth:
 * the per-account bucket keys on the signed-in user. The 5-try / 15-minute
 * lock in WithdrawalCodeService is the real limit on guessing; the HTTP
 * buckets only stop floods.
 */
@Controller('users/me/withdrawal-code')
export class WithdrawalCodeController {
  constructor(private readonly withdrawalCode: WithdrawalCodeService) {}

  @Get()
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.withdrawalCode.getStatus(user.id);
  }

  /** 201 — the first code (409 WITHDRAWAL_CODE_ALREADY_SET if one exists). */
  @Post()
  @ThrottleAuth('credential')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWithdrawalCodeDto,
  ) {
    return this.withdrawalCode.create(user.id, dto.code, dto.confirm);
  }

  /** "Is this my current code?" — counts toward the lock. */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ThrottleAuth('credential')
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyWithdrawalCodeDto,
  ) {
    return this.withdrawalCode.verify(user.id, dto.code);
  }

  @Put()
  @ThrottleAuth('credential')
  change(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangeWithdrawalCodeDto,
  ) {
    return this.withdrawalCode.change(
      user.id,
      dto.currentCode,
      dto.newCode,
      dto.confirm,
    );
  }

  /** "Forgot code?" — texts a code to the account phone. */
  @Post('reset/request')
  @HttpCode(HttpStatus.OK)
  @ThrottleAuth('otpRequest')
  requestReset(@CurrentUser() user: AuthenticatedUser) {
    return this.withdrawalCode.requestReset(user.id);
  }

  @Post('reset/verify')
  @HttpCode(HttpStatus.OK)
  @ThrottleAuth('credential')
  verifyReset(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyWithdrawalCodeResetDto,
  ) {
    return this.withdrawalCode.verifyReset(user.id, dto.otpCode);
  }

  @Post('reset/confirm')
  @HttpCode(HttpStatus.OK)
  @ThrottleAuth('credential')
  confirmReset(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmWithdrawalCodeResetDto,
  ) {
    return this.withdrawalCode.confirmReset(user.id, dto);
  }
}
