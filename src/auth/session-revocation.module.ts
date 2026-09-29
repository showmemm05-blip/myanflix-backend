import { Global, Module } from '@nestjs/common';
import { SessionRevocationService } from './session-revocation.service';

/**
 * Global (like AuditModule) so users, staff, roles, auth and the realtime
 * gateway can all inject SessionRevocationService without importing each
 * other. Depends only on the global PrismaModule, so it can never close a
 * module cycle.
 */
@Global()
@Module({
  providers: [SessionRevocationService],
  exports: [SessionRevocationService],
})
export class SessionRevocationModule {}
