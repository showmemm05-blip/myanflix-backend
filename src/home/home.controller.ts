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
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalAuth } from '../common/decorators/optional-auth.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import {
  CreateHomePromoDto,
  HomePromoQueryDto,
  ReorderHomePromosDto,
  UpdateHomePromoDto,
} from './dto/home-promo.dto';
import { UpdateHomeSettingsDto } from './dto/home-settings.dto';
import { HomePromosService } from './home-promos.service';
import { HomeShowcaseService } from './home-showcase.service';

/**
 * The home page's promos ("Home promos" admin page, 2026-10-08).
 *
 * GET /home/showcase is the public read every app makes on its home screen
 * — open to guests (@OptionalAuth); a token only decides whether linked
 * BOOKS may appear. Everything else is staff-only: HOME.VIEW to read,
 * HOME.MANAGE to change, every change audited.
 *
 * Route order is load-bearing: 'reorder' is declared before ':id' so
 * ParseUUIDPipe never 400s it.
 */
@Controller('home')
export class HomeController {
  constructor(
    private readonly showcase: HomeShowcaseService,
    private readonly promos: HomePromosService,
  ) {}

  @Get('showcase')
  @OptionalAuth()
  getShowcase(@CurrentUser() user?: AuthenticatedUser) {
    return this.showcase.getShowcase(!!user);
  }

  @Get('promos')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('HOME.VIEW')
  list(@Query() query: HomePromoQueryDto) {
    return this.promos.list(query.kind);
  }

  @Get('promos/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('HOME.VIEW')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.promos.findOne(id);
  }

  @Post('promos')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('HOME.MANAGE')
  create(
    @Body() dto: CreateHomePromoDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.promos.create(dto, actor);
  }

  @Patch('promos/reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('HOME.MANAGE')
  reorder(
    @Body() dto: ReorderHomePromosDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.promos.reorder(dto, actor);
  }

  @Patch('promos/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('HOME.MANAGE')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateHomePromoDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.promos.update(id, dto, actor);
  }

  @Delete('promos/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('HOME.MANAGE')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.promos.remove(id, actor);
  }

  @Get('settings')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('HOME.VIEW')
  getSettings() {
    return this.promos.getSettings();
  }

  @Put('settings')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('HOME.MANAGE')
  updateSettings(
    @Body() dto: UpdateHomeSettingsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.promos.updateSettings(dto, actor);
  }
}
