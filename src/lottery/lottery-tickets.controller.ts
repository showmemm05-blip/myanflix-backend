import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { TicketPageQueryDto } from './dto/lottery-purchase.dto';
import { LotteryTicketsService } from './lottery-tickets.service';

/**
 * A customer's own tickets (lottery backend phase 2). Signed-in only (the
 * global JwtAuthGuard), ownership scoped by @CurrentUser(): the list may
 * be narrowed to one draw, and one ticket is read by its number.
 */
@Controller('lottery/tickets')
export class LotteryTicketsController {
  constructor(private readonly tickets: LotteryTicketsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TicketPageQueryDto,
  ) {
    return this.tickets.list(user.id, query);
  }

  @Get(':ticketNo')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ticketNo') ticketNo: string,
  ) {
    return this.tickets.findOne(user.id, ticketNo);
  }
}
