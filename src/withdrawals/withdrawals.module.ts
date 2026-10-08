import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { FinanceSettingsModule } from '../finance-settings/finance-settings.module';
import { PaymentAccountsModule } from '../payment-accounts/payment-accounts.module';
import { WithdrawalCodeModule } from '../withdrawal-code/withdrawal-code.module';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { WithdrawalsController } from './withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';

@Module({
  imports: [
    RolesModule,
    WalletModule,
    RealtimeModule,
    FinanceSettingsModule,
    PaymentAccountsModule,
    // The withdrawal code every create() checks before money moves.
    WithdrawalCodeModule,
  ],
  controllers: [WithdrawalsController],
  // MinioService / StorageService provided per-module (the codebase
  // pattern) — see DepositsModule for why the unlink needs StorageService.
  providers: [WithdrawalsService, MinioService, StorageService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
