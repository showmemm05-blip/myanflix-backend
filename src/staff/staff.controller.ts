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
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { ResetStaffPasswordDto } from './dto/reset-staff-password.dto';
import { UpdateStaffStatusDto } from './dto/update-staff-status.dto';
import { StaffResponseDto } from './dto/staff-response.dto';
import { StaffService } from './staff.service';

@Controller('staff')
@UseGuards(PermissionsGuard)
@RequirePermissions(Permission.STAFF_MANAGE)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  async findAll() {
    const items = await this.staffService.findAll();
    return { items: items.map((user) => StaffResponseDto.fromEntity(user)) };
  }

  @Post()
  async create(@Body() dto: CreateStaffDto) {
    const user = await this.staffService.create(dto);
    return StaffResponseDto.fromEntity(user);
  }

  @Patch(':id')
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
  async resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetStaffPasswordDto,
  ) {
    await this.staffService.resetPassword(id, dto);
    return { reset: true };
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffStatusDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ) {
    const user = await this.staffService.updateStatus(id, dto, currentUser);
    return StaffResponseDto.fromEntity(user);
  }

  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
  ) {
    await this.staffService.remove(id, currentUser);
    return { deleted: true };
  }
}
