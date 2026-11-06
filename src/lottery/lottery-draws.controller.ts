import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalAuth } from '../common/decorators/optional-auth.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { DrawAvailabilityDto, DrawPageQueryDto } from './dto/lottery-draw.dto';
import { LotteryDrawsService } from './lottery-draws.service';

/**
 * The draws as the apps read them (lottery backend phase 2). Open to
 * guests like the dream books (@OptionalAuth): a draw carries nothing
 * private, and the availability check simply counts nothing held for a
 * guest. 'current' is declared before ':drawNo' so the word never reads
 * as a number. Purchases and tickets live in their own controllers.
 */
@Controller('lottery/draws')
export class LotteryDrawsController {
  constructor(private readonly draws: LotteryDrawsService) {}

  @Get('current')
  @OptionalAuth()
  current() {
    return this.draws.current();
  }

  @Get()
  @OptionalAuth()
  list(@Query() query: DrawPageQueryDto) {
    return this.draws.listPublic(query);
  }

  @Get(':drawNo')
  @OptionalAuth()
  findOne(@Param('drawNo', ParseIntPipe) drawNo: number) {
    return this.draws.findPublic(drawNo);
  }

  /** A read with a body (up to 50 numbers), so a POST that answers 200. */
  @Post(':drawNo/availability')
  @OptionalAuth()
  @HttpCode(HttpStatus.OK)
  availability(
    @Param('drawNo', ParseIntPipe) drawNo: number,
    @Body() dto: DrawAvailabilityDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.draws.availability(drawNo, dto.numbers, user);
  }
}
