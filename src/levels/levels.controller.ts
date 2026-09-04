import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { LevelsService } from './levels.service';
import {
  CreateLevelDto,
  ReorderLevelsDto,
  UpdateLevelDto,
} from './dto/level.dto';

/**
 * Membership levels are user-domain configuration, so management gates on
 * USERS.VIEW / USERS.EDIT rather than a permission module of their own
 * (book-categories precedent: a LEVELS module would be four more checkboxes
 * on the roles matrix that nobody would ever set differently).
 *
 * Route order is load-bearing: 'all' and 'reorder' are declared before the
 * ':id' routes so ParseUUIDPipe never 400s them.
 */
@Controller('levels')
export class LevelsController {
  constructor(private readonly service: LevelsService) {}

  /** The public ladder — any authenticated user (global JwtAuthGuard). */
  @Get()
  findEnabled() {
    return this.service.findEnabled();
  }

  @Get('all')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('USERS.VIEW')
  findAll() {
    return this.service.findAll();
  }

  @Put('reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('USERS.EDIT')
  reorder(@Body() dto: ReorderLevelsDto) {
    return this.service.reorder(dto);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('USERS.EDIT')
  create(@Body() dto: CreateLevelDto) {
    return this.service.create(dto);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('USERS.EDIT')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLevelDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('USERS.EDIT')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(id);
  }
}
