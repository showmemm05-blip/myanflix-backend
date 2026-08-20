import { Global, Module } from '@nestjs/common';
import { AuthorityService } from './authority.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { PermissionsGuard } from './guards/permissions.guard';
import { PermissionResolverService } from './permission-resolver.service';

/**
 * Global so every controller that hangs @UseGuards(PermissionsGuard) off a
 * route gets the guard's PermissionResolverService dependency resolved
 * without each feature module having to import this one (several already
 * did; subtitles/videos never needed to while the guard was dependency-free).
 */
@Global()
@Module({
  controllers: [RolesController],
  providers: [
    RolesService,
    PermissionsGuard,
    PermissionResolverService,
    AuthorityService,
  ],
  exports: [
    RolesService,
    PermissionsGuard,
    PermissionResolverService,
    AuthorityService,
  ],
})
export class RolesModule {}
