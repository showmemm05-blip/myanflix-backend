import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { SmsMessageStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  SMS_REDACTED,
  readSmsSettings,
  type SmsSettings,
} from '../sms/sms.config';
import { SmsGatewayService } from './sms-gateway.service';
import { redactFinalSmsBodies } from './sms-redaction';

export const SMS_SWEEP_INTERVAL_MS = 30 * 1000;

export interface SmsSweepResult {
  expired: number;
  unknown: number;
  redacted: number;
}

/**
 * Every 30 s, closes out gateway rows nobody will ever finish:
 *
 *  - QUEUED past its expiresAt -> EXPIRED. The phone never took it in
 *    time; the code it carries is dead anyway.
 *  - LEASED past its leaseExpiresAt with no result -> UNKNOWN. The phone
 *    took it and went quiet: it may or may not have sent it.
 *
 * Nothing is ever put back in the queue (at-most-once: a second SMS for a
 * code the user may already hold would be worse than none — they press
 * "resend" for a fresh code). A late result still lands: UNKNOWN and
 * EXPIRED accept SENT/FAILED (sms-transitions.ts). Both updates are
 * conditional on the old status, so a result recorded in between wins.
 *
 * Both moves blank the body (the code) at once — nobody will send it —
 * and then the privacy pass redacts whatever other final row still holds
 * one (a CANCELLED resend, rows from before this rule): sms-redaction.ts.
 *
 * The same tick is also the gateway's only watchdog (M-28, partly): with
 * SMS_PROVIDER=phone-gateway it logs ONE error line when the gateway goes
 * from accepting codes to refusing them (no phone able to send seen within
 * the offline window — the phone is off, has no internet, says it cannot
 * send, or someone holding the token is keeping it that way) and one plain
 * line when it comes back. Nothing pushes a notification: the backend log
 * and the admin SMS card are where staff see it.
 */
@Injectable()
export class SmsSweeperService {
  private readonly logger = new Logger(SmsSweeperService.name);
  private readonly settings: SmsSettings;
  /** The gateway as the last tick saw it; null until the first tick. */
  private wasOnline: boolean | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: SmsGatewayService,
    configService: ConfigService,
  ) {
    this.settings = readSmsSettings(configService);
  }

  @Interval('sms-gateway-sweeper', SMS_SWEEP_INTERVAL_MS)
  async sweep(now = new Date()): Promise<SmsSweepResult> {
    await this.watchGateway(now);
    try {
      const expired = await this.prisma.smsMessage.updateMany({
        where: { status: SmsMessageStatus.QUEUED, expiresAt: { lte: now } },
        data: {
          status: SmsMessageStatus.EXPIRED,
          body: SMS_REDACTED,
          redactedAt: now,
        },
      });
      const unknown = await this.prisma.smsMessage.updateMany({
        where: {
          status: SmsMessageStatus.LEASED,
          leaseExpiresAt: { lte: now },
        },
        data: {
          status: SmsMessageStatus.UNKNOWN,
          body: SMS_REDACTED,
          redactedAt: now,
        },
      });
      const redacted = await redactFinalSmsBodies(this.prisma, now);
      if (expired.count > 0 || unknown.count > 0) {
        this.logger.warn(
          `Swept ${expired.count} never-leased SMS to EXPIRED and ${unknown.count} unreported leased SMS to UNKNOWN`,
        );
      }
      if (redacted.count > 0) {
        this.logger.log(`Redacted the body of ${redacted.count} finished SMS`);
      }
      return {
        expired: expired.count,
        unknown: unknown.count,
        redacted: redacted.count,
      };
    } catch (error) {
      this.logger.error(
        `SMS sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { expired: 0, unknown: 0, redacted: 0 };
    }
  }

  /**
   * Logs the gateway's online/offline transitions (see the class note).
   * The first tick only records the state; a failed check is logged and
   * tried again next tick, and never stops the sweep itself.
   */
  private async watchGateway(now: Date): Promise<void> {
    if (this.settings.provider !== 'phone-gateway') return;
    let online: boolean;
    try {
      online = await this.gateway.isOnline(now);
    } catch (error) {
      this.logger.error(
        `SMS gateway online check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (this.wasOnline === true && !online) {
      this.logger.error(
        `SMS gateway is OFFLINE: no phone able to send has checked in within ${this.settings.offlineAfterSeconds} s (the phone is off or without internet, or its last heartbeat said it cannot send). Sign-in codes are refused (503) until it is back. Check the company phone; if it looks fine, see the SMS card in the admin dashboard — someone holding SMS_GATEWAY_TOKEN may be interfering.`,
      );
    } else if (this.wasOnline === false && online) {
      this.logger.log('SMS gateway is back online: codes are accepted again');
    }
    this.wasOnline = online;
  }
}
