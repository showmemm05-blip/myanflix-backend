import { Controller, Get, Param, Query } from '@nestjs/common';
import { OptionalAuth } from '../common/decorators/optional-auth.decorator';
import { DreamQueryDto } from './dto/lottery-dream.dto';
import { LotteryDreamsService } from './lottery-dreams.service';

/**
 * The dream books as the apps read them (lottery backend phase 1,
 * 2026-10-19). Open to guests like the catalogue reads (@OptionalAuth, the
 * way GET /home/showcase is): only switched-on, named dreams come back,
 * and nothing here depends on who is asking. The staff routes live in
 * LotteryDreamsAdminController.
 */
@Controller('lottery/dreams')
export class LotteryDreamsController {
  constructor(private readonly dreams: LotteryDreamsService) {}

  @Get()
  @OptionalAuth()
  list(@Query() query: DreamQueryDto) {
    return this.dreams.listPublic(query);
  }

  /** `number` may come unpadded ("27" finds 027 in the 1000 book). */
  @Get(':book/:number')
  @OptionalAuth()
  findOne(@Param('book') book: string, @Param('number') number: string) {
    return this.dreams.findPublic(book, number);
  }
}
