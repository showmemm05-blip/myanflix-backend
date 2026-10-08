import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../generated/prisma/client';
import {
  SmsGatewayService,
  type SmsSendMeta,
} from '../sms-gateway/sms-gateway.service';
import { maskPhoneNumber } from '../tracking/pii.util';
import { readSmsSettings, type SmsSettings } from './sms.config';

export type { SmsSendMeta } from '../sms-gateway/sms-gateway.service';

/** Run once the caller's transaction has committed (see sendWithin). */
export type AfterCommit = () => void;

const NOTHING_TO_DO: AfterCommit = () => undefined;

/**
 * The one door every outgoing SMS goes through (today: OTP codes from
 * OtpService). SMS_PROVIDER picks what happens behind it — see sms.config.ts:
 *
 *  - `phone-gateway`: queued for the company Android phone, which sends it
 *    from its own SIM (SmsGatewayService). Throws 503
 *    (SMS_UNAVAILABLE_MESSAGE) when the phone is offline or today's cap is
 *    reached, 409 when the number had its SMS for the day, 400 for a
 *    number that is not a Myanmar mobile — OtpService's transaction then
 *    rolls its code back.
 *  - `log` (default, development only): nothing is sent. One masked line
 *    per call, and a loud warning at startup.
 *
 * Neither path ever logs the message body: it carries the code.
 */
@Injectable()
export class SmsService implements OnModuleInit {
  private readonly logger = new Logger(SmsService.name);
  private readonly settings: SmsSettings;

  constructor(
    configService: ConfigService,
    private readonly gateway: SmsGatewayService,
  ) {
    this.settings = readSmsSettings(configService);
  }

  onModuleInit(): void {
    if (this.settings.provider === 'log') {
      this.logger.warn(
        [
          '*****************************************************************',
          'SMS_PROVIDER=log — NO SMS IS SENT. Development only.',
          'OTP codes never leave this server; users cannot sign in by phone.',
          'Set SMS_PROVIDER=phone-gateway (+ SMS_GATEWAY_TOKEN) to send',
          'codes through the company gateway phone.',
          '*****************************************************************',
        ].join('\n'),
      );
      return;
    }
    this.logger.log(
      `SMS_PROVIDER=phone-gateway: codes are sent by the company gateway phone (daily cap ${this.settings.dailyCap}, ${this.settings.dailyCapPerPhone} per number, offline after ${this.settings.offlineAfterSeconds} s without a heartbeat)`,
    );
  }

  async send(
    phone: string,
    message: string,
    meta?: SmsSendMeta,
  ): Promise<void> {
    if (this.settings.provider === 'phone-gateway') {
      await this.gateway.enqueue(phone, message, meta);
      return;
    }
    this.logNotSent(phone);
  }

  /**
   * send(), inside the caller's transaction: the SMS row commits or rolls
   * back with the caller's own writes (OtpService's code row), and any
   * refusal throws out of that transaction. Resolves to a function the
   * caller MUST run after the transaction commits — it wakes the gateway
   * phone's waiting long-poll, which cannot see the row before then.
   */
  async sendWithin(
    tx: Prisma.TransactionClient,
    phone: string,
    message: string,
    meta?: SmsSendMeta,
  ): Promise<AfterCommit> {
    if (this.settings.provider === 'phone-gateway') {
      const queued = await this.gateway.enqueueWithin(tx, phone, message, meta);
      return queued ? () => this.gateway.notifyJobQueued() : NOTHING_TO_DO;
    }
    this.logNotSent(phone);
    return NOTHING_TO_DO;
  }

  private logNotSent(phone: string): void {
    this.logger.warn(
      `[SMS_PROVIDER=log] NOT sent to ${maskPhoneNumber(phone)} — nothing leaves this server (message withheld from the log)`,
    );
  }
}
