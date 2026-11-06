import {
  Body,
  Controller,
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
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import {
  AdminDrawQueryDto,
  AdminDrawTicketsQueryDto,
  CreateLotteryDrawDto,
  OffSaleNumbersDto,
  UpdateLotteryDrawDto,
} from './dto/lottery-draw.dto';
import { LotteryDrawsAdminService } from './lottery-draws-admin.service';

/**
 * The admin "Lottery > Draws" page. LOTTERY.VIEW reads (the list, a draw,
 * its tickets), LOTTERY.DRAWS_MANAGE changes (create, edit, open / pause /
 * close / reopen, the off-sale list); every change is audited by the service. A
 * draw's picture goes through the existing POST /uploads/image with
 * purpose "lottery".
 */
@Controller('lottery/admin/draws')
@UseGuards(PermissionsGuard)
export class LotteryDrawsAdminController {
  constructor(private readonly draws: LotteryDrawsAdminService) {}

  @Get()
  @RequirePermissions('LOTTERY.VIEW')
  list(@Query() query: AdminDrawQueryDto) {
    return this.draws.list(query);
  }

  @Post()
  @RequirePermissions('LOTTERY.DRAWS_MANAGE')
  create(
    @Body() dto: CreateLotteryDrawDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.draws.create(dto, actor);
  }

  @Get(':id')
  @RequirePermissions('LOTTERY.VIEW')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.draws.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('LOTTERY.DRAWS_MANAGE')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLotteryDrawDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.draws.update(id, dto, actor);
  }

  /** The four status changes answer 200 with the draw, like every other read-back. */
  @Post(':id/open')
  @RequirePermissions('LOTTERY.DRAWS_MANAGE')
  @HttpCode(HttpStatus.OK)
  open(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.draws.open(id, actor);
  }

  @Post(':id/pause')
  @RequirePermissions('LOTTERY.DRAWS_MANAGE')
  @HttpCode(HttpStatus.OK)
  pause(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.draws.pause(id, actor);
  }

  @Post(':id/close')
  @RequirePermissions('LOTTERY.DRAWS_MANAGE')
  @HttpCode(HttpStatus.OK)
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.draws.close(id, actor);
  }

  /** A closed draw back on sale, while its close time is still ahead and no sheet is in. */
  @Post(':id/reopen')
  @RequirePermissions('LOTTERY.DRAWS_MANAGE')
  @HttpCode(HttpStatus.OK)
  reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.draws.reopen(id, actor);
  }

  /** Replaces the whole off-sale list; an empty list puts every number back on sale. */
  @Put(':id/off-sale')
  @RequirePermissions('LOTTERY.DRAWS_MANAGE')
  setOffSale(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OffSaleNumbersDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.draws.setOffSale(id, dto, actor);
  }

  @Get(':id/tickets')
  @RequirePermissions('LOTTERY.VIEW')
  listTickets(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminDrawTicketsQueryDto,
  ) {
    return this.draws.listTickets(id, query);
  }
}
