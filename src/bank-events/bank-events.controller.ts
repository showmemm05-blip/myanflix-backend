import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { THROTTLER_DEFAULT } from '../common/throttling/throttling.config';
import {
  BankEventsService,
  MAX_BANK_SCREENSHOT_BYTES,
} from './bank-events.service';
import { BankEventBatchDto } from './dto/bank-event-batch.dto';
import { BankScreenshotDto } from './dto/bank-screenshot.dto';
import { RequireMachinePermission } from './machine-permissions';
import { MachineTokenGuard } from './machine-token.guard';

/**
 * The phone-monitor's routes — and the ONLY routes a machine token opens.
 * `@Public()` makes the global JwtAuthGuard step aside (it would otherwise
 * try to parse the bearer as a JWT and 401); MachineTokenGuard then does the
 * real check on every route here. Nothing under /deposits, /withdrawals,
 * /payment-accounts or /users is reachable with this token: those stay JWT
 * routes where a machine bearer fails passport as a bad JWT.
 *
 * Per-route throttles sit on top of the site-wide 300/min/IP backstop: two
 * phones times a burst of retries is well under 120 batches a minute; a
 * runaway loop is not.
 */
@Public()
@UseGuards(MachineTokenGuard)
@RequireMachinePermission('BANK_EVENTS.INGEST')
@Controller('bank-events')
export class BankEventsController {
  constructor(private readonly bankEventsService: BankEventsService) {}

  /** One batch per phone-monitor tick, JSON only — never image bytes. */
  @Post('match')
  @Throttle({ [THROTTLER_DEFAULT]: { limit: 120, ttl: 60_000 } })
  match(@Body() dto: BankEventBatchDto) {
    return this.bankEventsService.processBatch(dto);
  }

  /** Multipart, ONLY after a match, idempotent per event key. */
  @Post('deposits/:id/screenshot')
  @Throttle({ [THROTTLER_DEFAULT]: { limit: 60, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BANK_SCREENSHOT_BYTES },
    }),
  )
  attachDepositScreenshot(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BankScreenshotDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.bankEventsService.attachScreenshot('deposits', id, dto, file);
  }

  @Post('withdrawals/:id/screenshot')
  @Throttle({ [THROTTLER_DEFAULT]: { limit: 60, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BANK_SCREENSHOT_BYTES },
    }),
  )
  attachWithdrawalScreenshot(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BankScreenshotDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.bankEventsService.attachScreenshot(
      'withdrawals',
      id,
      dto,
      file,
    );
  }

  /** Active accounts — id and labels only — for the phone-monitor's settings dropdown. */
  @Get('accounts')
  @Throttle({ [THROTTLER_DEFAULT]: { limit: 60, ttl: 60_000 } })
  accounts() {
    return this.bankEventsService.listActiveAccounts();
  }
}
