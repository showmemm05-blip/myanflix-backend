import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsGuard } from './guards/permissions.guard';

@Module({
  controllers: [RolesController],
  providers: [RolesService, RolesGuard, PermissionsGuard],
  exports: [RolesService, RolesGuard, PermissionsGuard],
})
export class RolesModule {}
