import { Controller, Get, UseGuards } from '@nestjs/common';
import { Role } from '../generated/prisma/client';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { RolesService } from './roles.service';

@Controller('roles')
@UseGuards(RolesGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN)
  findAll() {
    return this.rolesService.getRolePermissionMatrix();
  }
}
