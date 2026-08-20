import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { RequirePermissions } from './decorators/permissions.decorator';
import { CreateAppRoleDto } from './dto/create-app-role.dto';
import { ReplaceRolePermissionsDto } from './dto/replace-role-permissions.dto';
import { UpdateAppRoleDto } from './dto/update-app-role.dto';
import { PermissionsGuard } from './guards/permissions.guard';
import { RolesService } from './roles.service';

/**
 * Runtime role management. Gated by ROLES.* permissions only — deliberately
 * NOT by the `Role` enum, since hard-gating on role names is exactly what
 * this module exists to replace (a custom role granted ROLES.EDIT must be
 * able to reach these routes).
 */
@Controller('roles')
@UseGuards(PermissionsGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @RequirePermissions('ROLES.VIEW')
  findAll() {
    return this.rolesService.findAll();
  }

  /** Registered before ':id' so "catalogue" is never parsed as a role id. */
  @Get('catalogue')
  @RequirePermissions('ROLES.VIEW')
  getCatalogue() {
    return this.rolesService.getCatalogue();
  }

  @Get(':id')
  @RequirePermissions('ROLES.VIEW')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.findOne(id);
  }

  @Post()
  @RequirePermissions('ROLES.CREATE')
  create(
    @Body() dto: CreateAppRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.rolesService.create(dto, actor);
  }

  @Patch(':id')
  @RequirePermissions('ROLES.EDIT')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAppRoleDto,
  ) {
    return this.rolesService.update(id, dto);
  }

  @Put(':id/permissions')
  @RequirePermissions('ROLES.EDIT')
  replacePermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceRolePermissionsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.rolesService.replacePermissions(id, dto.permissions, actor);
  }

  @Delete(':id')
  @RequirePermissions('ROLES.DELETE')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.rolesService.remove(id);
  }
}
