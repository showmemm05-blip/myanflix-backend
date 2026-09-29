import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { RealtimeModule } from '../realtime/realtime.module';
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
  imports: [RealtimeModule],
  controllers: [BankEventsController],
  providers: [
    BankEventsService,
    MachineTokenGuard,
    MinioService,
    StorageService,
  ],
})
export class BankEventsModule {}
