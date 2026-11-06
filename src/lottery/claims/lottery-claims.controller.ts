import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { MyClaimsQueryDto, RequestClaimDto } from '../dto/lottery-claim.dto';
import { LotteryClaimsService } from './lottery-claims.service';

/**
 * A customer's prize claims (2026-10-24). Signed-in only (the global
 * JwtAuthGuard, no permission), ownership scoped by @CurrentUser() like
 * /lottery/tickets: what I won in a draw and where its claim stands, my
 * claims, and "Request payment" (201 with the draw's claim view; a repeat
 * answers 409 LOTTERY_CLAIM_ALREADY_REQUESTED).
 */
@Controller('lottery/claims')
export class LotteryClaimsController {
  constructor(private readonly claims: LotteryClaimsService) {}

  @Get()
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MyClaimsQueryDto,
  ) {
    return this.claims.listMine(user.id, query);
  }

  @Get('draws/:drawNo')
  drawView(
    @CurrentUser() user: AuthenticatedUser,
    @Param('drawNo', ParseIntPipe) drawNo: number,
  ) {
    return this.claims.drawView(user.id, drawNo);
  }

  @Post()
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestClaimDto,
  ) {
    return this.claims.request(user, dto);
  }
}
