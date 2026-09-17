import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Global (like RolesModule) so any feature service can inject AuditService
 * without its module importing this one. Depends only on the global
 * PrismaModule; the controller is read-only and pulls in nothing that could
 * form a cycle with the modules that write to the log.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
