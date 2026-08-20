import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PeakUsersModule } from '../peak-users/peak-users.module';
import { UsersModule } from '../users/users.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [
    UsersModule,
    // One-way dependency: the gateway reports concurrent counts into
    // PeakUsersModule; PeakUsersModule never imports RealtimeModule back.
    PeakUsersModule,
    // Verify-only usage here (secret passed explicitly per-call, matching
    // JwtStrategy) — this registration just makes JwtService injectable.
    JwtModule.register({}),
  ],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
