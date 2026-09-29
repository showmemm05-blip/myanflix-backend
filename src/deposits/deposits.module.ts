import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { FinanceSettingsModule } from '../finance-settings/finance-settings.module';
import { PaymentAccountsModule } from '../payment-accounts/payment-accounts.module';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';

@Module({
  imports: [
    RolesModule,
    WalletModule,
    RealtimeModule,
    FinanceSettingsModule,
    PaymentAccountsModule,
  ],
  controllers: [DepositsController],
  // MinioService / StorageService provided per-module (the codebase
  // pattern): the bank-screenshot stream and the unlink delete need them —
  // StorageService to tell a legacy per-deposit screenshot key (deletable)
  // from a bank transaction's (never deleted here).
  providers: [DepositsService, MinioService, StorageService],
  exports: [DepositsService],
})
export class DepositsModule {}
