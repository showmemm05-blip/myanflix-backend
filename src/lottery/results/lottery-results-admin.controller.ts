import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { RequirePermissions } from '../../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../../roles/guards/permissions.guard';
import { EnterResultsDto } from '../dto/lottery-results.dto';
import { LotteryResultsService } from './lottery-results.service';

/**
 * The "Results" card of the admin draw page and the "Test the source"
 * button of Lottery > Settings (lottery backend phase 3). LOTTERY.VIEW
 * reads a draw's sheet; LOTTERY.RESULTS_PUBLISH fetches it, enters it by
 * hand and tests the source — the same permission that will publish and
 * pay (engineer B's routes under /draws/:id/publish*). Every write is
 * audited by the service.
 */
@Controller('lottery/admin')
@UseGuards(PermissionsGuard)
export class LotteryResultsAdminController {
  constructor(private readonly results: LotteryResultsService) {}

  @Get('draws/:id/results')
  @RequirePermissions('LOTTERY.VIEW')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.results.get(id);
  }

  /** Replaces the whole sheet with the one typed in; answers 200 with the results, like every other read-back. */
  @Put('draws/:id/results')
  @RequirePermissions('LOTTERY.RESULTS_PUBLISH')
  enter(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EnterResultsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.results.enter(id, dto, actor);
  }

  /** Asks the source now; 200 with the results either way (lastError says what went wrong). */
  @Post('draws/:id/results/fetch')
  @RequirePermissions('LOTTERY.RESULTS_PUBLISH')
  @HttpCode(HttpStatus.OK)
  fetchNow(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.results.fetchNow(id, actor);
  }

  /** Calls the source for today's draw and shows what it answered; stores nothing. */
  @Get('settings/results-test')
  @RequirePermissions('LOTTERY.RESULTS_PUBLISH')
  testSource() {
    return this.results.testSource();
  }
}
