import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { decimalToNumber } from '../common/utils/decimal.util';
import { WalletService } from './wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  async getWallet(@CurrentUser() user: AuthenticatedUser) {
    const wallet = await this.walletService.getByUserId(user.id);
    return { id: wallet.id, balance: decimalToNumber(wallet.balance) };
  }

  @Get('transactions')
  async getTransactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() pagination: PaginationQueryDto,
  ) {
    const { items, total, page, limit } = await this.walletService.getTransactions(
      user.id,
      pagination,
    );
    return {
      items: items.map((t) => ({ ...t, amount: decimalToNumber(t.amount) })),
      total,
      page,
      limit,
    };
  }
}
