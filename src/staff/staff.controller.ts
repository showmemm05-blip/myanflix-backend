import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { ResetStaffPasswordDto } from './dto/reset-staff-password.dto';
import { UpdateStaffStatusDto } from './dto/update-staff-status.dto';
import { StaffResponseDto } from './dto/staff-response.dto';
import { StaffService } from './staff.service';

/**
 * Every route states the STAFF action it performs; the class-level rule is
 * only the fail-safe floor for a route that forgets to.
 */
@Controller('staff')
@UseGuards(PermissionsGuard)
@RequirePermissions('STAFF.VIEW')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  @RequirePermissions('STAFF.VIEW')
  async findAll() {
    const items = await this.staffService.findAll();
    return { items: items.map((user) => StaffResponseDto.fromEntity(user)) };
  }

  @Post()
  @RequirePermissions('STAFF.CREATE')
  async create(
    @Body() dto: CreateStaffDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ) {
    const user = await this.staffService.create(dto, currentUser);
    return StaffResponseDto.fromEntity(user);
  }

  @Patch(':id')
  @RequirePermissions('STAFF.EDIT')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ) {
    const user = await this.staffService.updateStaffFields(
      id,
      dto,
      currentUser,
    );
    return StaffResponseDto.fromEntity(user);
  }

  @Patch(':id/password')
  @RequirePermissions('STAFF.EDIT')
  async resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetStaffPasswordDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ) {
    await this.staffService.resetPassword(id, dto, currentUser);
    return { reset: true };
  }

  @Patch(':id/status')
  @RequirePermissions('STAFF.EDIT')
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffStatusDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ) {
    const user = await this.staffService.updateStatus(id, dto, currentUser);
    return StaffResponseDto.fromEntity(user);
  }

  @Delete(':id')
  @RequirePermissions('STAFF.DELETE')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
  ) {
    await this.staffService.remove(id, currentUser);
    return { deleted: true };
  }
}
