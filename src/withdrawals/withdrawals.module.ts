import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { FinanceSettingsModule } from '../finance-settings/finance-settings.module';
import { PaymentAccountsModule } from '../payment-accounts/payment-accounts.module';
import { MinioService } from '../common/storage/minio.service';
import { WithdrawalsController } from './withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';

@Module({
  imports: [
    RolesModule,
    WalletModule,
    RealtimeModule,
    FinanceSettingsModule,
    PaymentAccountsModule,
  ],
  controllers: [WithdrawalsController],
  // MinioService provided per-module (the codebase pattern): the
  // bank-screenshot stream and the unlink delete need it.
  providers: [WithdrawalsService, MinioService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
