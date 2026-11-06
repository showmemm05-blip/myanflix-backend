import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BankEventsBindingModule } from '../bank-events/bank-events-binding.module';
import { PeakUsersModule } from '../peak-users/peak-users.module';
import { UsersModule } from '../users/users.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [
    UsersModule,
    // One-way dependency: the gateway reports concurrent counts into
    // PeakUsersModule; PeakUsersModule never imports RealtimeModule back.
    PeakUsersModule,
    // The phone-monitor's device pin (SEC-004), checked on its socket
    // handshake exactly as MachineTokenGuard checks it over HTTP. A leaf
    // module (no imports of its own), so no cycle with BankEventsModule.
    BankEventsBindingModule,
    // Verify-only usage here (secret passed explicitly per-call, matching
    // JwtStrategy) — this registration just makes JwtService injectable.
    JwtModule.register({}),
  ],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
