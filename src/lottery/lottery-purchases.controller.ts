import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import {
  CreateLotteryPurchaseDto,
  PurchasePageQueryDto,
} from './dto/lottery-purchase.dto';
import { LotteryPurchasesService } from './lottery-purchases.service';

/**
 * Buying tickets and reading one's own receipts (lottery backend phase 2).
 * Signed-in customers only (the global JwtAuthGuard, no @OptionalAuth),
 * ownership scoped by @CurrentUser() like /subscriptions. The POST answers
 * 201 with the receipt and the wallet after it; a retry with the same
 * idempotency key answers 201 with the same receipt and charges nothing.
 */
@Controller('lottery/purchases')
export class LotteryPurchasesController {
  constructor(private readonly purchases: LotteryPurchasesService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLotteryPurchaseDto,
  ) {
    return this.purchases.create(user, dto);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PurchasePageQueryDto,
  ) {
    return this.purchases.list(user.id, query);
  }

  @Get(':ref')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('ref') ref: string) {
    return this.purchases.findOne(user.id, ref);
  }
}
