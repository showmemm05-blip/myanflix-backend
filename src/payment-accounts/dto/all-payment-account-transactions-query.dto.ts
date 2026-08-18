import { IsOptional, IsUUID } from 'class-validator';
import { PaymentAccountTransactionQueryDto } from './payment-account-transaction-query.dto';

/** Backs GET /payment-accounts/transactions (central cross-account view). */
export class AllPaymentAccountTransactionsQueryDto extends PaymentAccountTransactionQueryDto {
  @IsOptional()
  @IsUUID('4')
  paymentAccountId?: string;
}
