import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { RequirePermissions } from '../../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../../roles/guards/permissions.guard';
import {
  AdminWinnersQueryDto,
  PublishDrawDto,
  PublishPreviewQueryDto,
} from '../dto/lottery-publish.dto';
import { LotteryPublishService } from './lottery-publish.service';

/**
 * "Publish and pay winners" on the admin draw page (lottery backend phase
 * 3): the dry run and the winners table read with LOTTERY.VIEW, the
 * publish itself — which moves money — with LOTTERY.RESULTS_PUBLISH, the
 * permission that also fetches and enters the sheet. The publish is
 * audited by the service.
 */
@Controller('lottery/admin/draws')
@UseGuards(PermissionsGuard)
export class LotteryPublishAdminController {
  constructor(private readonly publish: LotteryPublishService) {}

  /** What a publish would pay, counted at the asked rate (else the draw's, else the settings'); writes nothing. */
  @Get(':id/publish-preview')
  @RequirePermissions('LOTTERY.VIEW')
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PublishPreviewQueryDto,
  ) {
    return this.publish.preview(id, query.exchangeRate);
  }

  /** Marks every ticket and pays the winners inside this one request; answers 200 with the admin draw, like the other status changes. */
  @Post(':id/publish')
  @RequirePermissions('LOTTERY.RESULTS_PUBLISH')
  @HttpCode(HttpStatus.OK)
  publishDraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishDrawDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.publish.publish(id, dto, actor);
  }

  @Get(':id/winners')
  @RequirePermissions('LOTTERY.VIEW')
  listWinners(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminWinnersQueryDto,
  ) {
    return this.publish.listWinners(id, query);
  }
}
