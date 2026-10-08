import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MinioService } from '../common/storage/minio.service';
import { PaymentAccountsController } from './payment-accounts.controller';
import { PaymentAccountsService } from './payment-accounts.service';
import { PaymentAccountLedgerService } from './payment-account-ledger.service';
import { PaymentAccountEvents } from './payment-account-events';

@Module({
  imports: [RolesModule, RealtimeModule],
  controllers: [PaymentAccountsController],
  providers: [
    PaymentAccountsService,
    PaymentAccountLedgerService,
    PaymentAccountEvents,
    MinioService,
  ],
  exports: [
    PaymentAccountsService,
    PaymentAccountLedgerService,
    // BankEventsService forgets its account cache on every change (bam-16).
    PaymentAccountEvents,
  ],
})
export class PaymentAccountsModule {}
