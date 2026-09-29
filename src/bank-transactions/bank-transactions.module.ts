import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { RolesModule } from '../roles/roles.module';
import { BankTransactionsController } from './bank-transactions.controller';
import { BankTransactionsService } from './bank-transactions.service';

/**
 * The staff read side of bank_transactions. The WRITE side lives in
 * bank-transaction-store.ts as plain functions that BankEventsModule,
 * DepositsModule and WithdrawalsModule import directly — none of them
 * imports this module, so there is no Nest cycle. RolesModule for the
 * PermissionsGuard; MinioService per-module like everywhere else.
 */
@Module({
  imports: [RolesModule],
  controllers: [BankTransactionsController],
  providers: [BankTransactionsService, MinioService],
})
export class BankTransactionsModule {}
