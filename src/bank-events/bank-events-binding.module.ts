import { Module } from '@nestjs/common';
import { BankEventsDeviceBindingService } from './bank-events-device-binding.service';

/**
 * The bank-events device pin on its own (SEC-004). Both the HTTP side
 * (BankEventsModule → MachineTokenGuard) and the socket side
 * (RealtimeModule → the phone-monitor handshake) check the same pin, and
 * BankEventsModule already imports RealtimeModule — so the service lives
 * here, with no imports of its own (PrismaService and AuditService are
 * global), and never forms a cycle.
 */
@Module({
  providers: [BankEventsDeviceBindingService],
  exports: [BankEventsDeviceBindingService],
})
export class BankEventsBindingModule {}
