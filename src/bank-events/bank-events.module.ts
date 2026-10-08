import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { PaymentAccountsModule } from '../payment-accounts/payment-accounts.module';
import { BankEventsController } from './bank-events.controller';
import { BankEventsService } from './bank-events.service';
import { MachineTokenGuard } from './machine-token.guard';

/**
 * Bank transfer verification — the phone-monitor's ingestion side. Reads
 * and writes deposits/withdrawals directly through Prisma (the matcher
 * functions in deposit-matcher.ts / withdrawal-matcher.ts) rather than
 * through DepositsService, so this module never forms a cycle with the
 * deposits/withdrawals modules that import the same risk helpers.
 * AuditService is global; MinioService/StorageService are provided
 * per-module like everywhere else.
 */
@Module({
  // PaymentAccountsModule only for PaymentAccountEvents (bam-16): its
  // imports (roles, realtime) never lead back here, so no cycle.
  imports: [RealtimeModule, PaymentAccountsModule],
  controllers: [BankEventsController],
  providers: [
    BankEventsService,
    MachineTokenGuard,
    MinioService,
    StorageService,
  ],
})
export class BankEventsModule {}
