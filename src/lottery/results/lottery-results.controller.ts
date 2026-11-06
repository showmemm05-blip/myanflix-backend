import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { OptionalAuth } from '../../common/decorators/optional-auth.decorator';
import { DrawPageQueryDto } from '../dto/lottery-draw.dto';
import {
  PUBLIC_WINNERS_LIMIT_DEFAULT,
  PublicWinnersQueryDto,
} from '../dto/lottery-publish.dto';
import { LotteryPublicResultsService } from './lottery-public-results.service';

/**
 * The results as the apps read them (lottery backend phase 3). Open to
 * guests like the draws (@OptionalAuth): a published sheet is public,
 * and the winners list carries ticket numbers only. The two draw-scoped
 * routes sit under /lottery/draws/:drawNo like the draw itself.
 */
@Controller('lottery')
export class LotteryResultsController {
  constructor(private readonly results: LotteryPublicResultsService) {}

  @Get('results')
  @OptionalAuth()
  list(@Query() query: DrawPageQueryDto) {
    return this.results.list(query);
  }

  @Get('draws/:drawNo/results')
  @OptionalAuth()
  findOne(@Param('drawNo', ParseIntPipe) drawNo: number) {
    return this.results.findByDrawNo(drawNo);
  }

  @Get('draws/:drawNo/winners')
  @OptionalAuth()
  winners(
    @Param('drawNo', ParseIntPipe) drawNo: number,
    @Query() query: PublicWinnersQueryDto,
  ) {
    return this.results.winners(
      drawNo,
      query.limit ?? PUBLIC_WINNERS_LIMIT_DEFAULT,
    );
  }
}
