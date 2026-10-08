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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { THROTTLER_DEFAULT } from '../common/throttling/throttling.config';
import {
  DeviceTokenGuard,
  smsDeviceTracker,
  type SmsDeviceRequest,
} from './device-token.guard';
import { DeviceHeartbeatDto } from './dto/device-heartbeat.dto';
import { JobResultDto } from './dto/job-result.dto';
import {
  DEFAULT_POLL_WAIT_SECONDS,
  PollJobsQueryDto,
} from './dto/poll-jobs-query.dto';
import { SmsGatewayService } from './sms-gateway.service';

/** Requests per minute per device, per route — far above what the phone needs. */
export const SMS_DEVICE_THROTTLE_PER_MINUTE = 120;

/**
 * The company SMS gateway phone's routes — and the ONLY routes its token
 * opens. `@Public()` makes the global JwtAuthGuard step aside (it would
 * otherwise parse the bearer as a JWT and 401); DeviceTokenGuard then
 * checks `Authorization: Bearer <SMS_GATEWAY_TOKEN>` + `X-Device-Id` on
 * every route here. Nothing a user or staff token opens is reachable with
 * the gateway token, and no JWT opens these.
 *
 * Throttled at 120/min/route per client address of a correct-token request
 * (smsDeviceTracker — never per the caller-chosen device id, which would
 * let a token holder burn the phone's bucket or get a fresh one per made-up
 * id) instead of the site-wide bucket: the phone's steady state is ~2 polls
 * + 2 heartbeats a minute, plus about three calls per SMS under its own
 * 20 SMS/min limit — the long-poll is never what trips it.
 *
 * Device calls are not staff mutations: nothing here writes an audit row.
 */
@Public()
@UseGuards(DeviceTokenGuard)
@Throttle({
  [THROTTLER_DEFAULT]: {
    limit: SMS_DEVICE_THROTTLE_PER_MINUTE,
    ttl: 60_000,
    getTracker: smsDeviceTracker,
  },
})
@Controller('sms-gateway/device')
export class SmsGatewayDeviceController {
  constructor(private readonly gateway: SmsGatewayService) {}

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@Req() req: SmsDeviceRequest, @Body() dto: DeviceHeartbeatDto) {
    return this.gateway.heartbeat(req.smsDevice!.id, dto);
  }

  /**
   * Long-poll for at most one job. The request is held up to `wait`
   * seconds (default 25) when nothing is queued. If the phone drops the
   * connection while waiting, the poll stops without leasing anything.
   */
  @Get('jobs')
  async jobs(
    @Req() req: SmsDeviceRequest,
    @Query() query: PollJobsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const gone = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) gone.abort();
    };
    res.on('close', onClose);
    try {
      return await this.gateway.pollJobs(
        req.smsDevice!.id,
        query.wait ?? DEFAULT_POLL_WAIT_SECONDS,
        gone.signal,
      );
    } finally {
      res.off('close', onClose);
    }
  }

  @Post('jobs/:id/result')
  @HttpCode(HttpStatus.OK)
  result(
    @Req() req: SmsDeviceRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: JobResultDto,
  ) {
    return this.gateway.recordResult(req.smsDevice!.id, id, dto);
  }
}
