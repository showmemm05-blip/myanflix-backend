import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [
    UsersModule,
    // Verify-only usage here (secret passed explicitly per-call, matching
    // JwtStrategy) — this registration just makes JwtService injectable.
    JwtModule.register({}),
  ],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
