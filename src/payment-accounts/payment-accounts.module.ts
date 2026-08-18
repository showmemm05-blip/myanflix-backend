import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MinioService } from '../common/storage/minio.service';
import { PaymentAccountsController } from './payment-accounts.controller';
import { PaymentAccountsService } from './payment-accounts.service';
import { PaymentAccountLedgerService } from './payment-account-ledger.service';

@Module({
  imports: [RolesModule, RealtimeModule],
  controllers: [PaymentAccountsController],
  providers: [PaymentAccountsService, PaymentAccountLedgerService, MinioService],
  exports: [PaymentAccountsService, PaymentAccountLedgerService],
})
export class PaymentAccountsModule {}
