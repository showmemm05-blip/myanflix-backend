import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  SmsMessageStatus,
  type SmsGatewayDevice,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  INVALID_SMS_PHONE_MESSAGE,
  MYANMAR_MOBILE_PATTERN,
  SMS_REDACTED,
  SMS_UNAVAILABLE_MESSAGE,
  TOO_MANY_CODE_REQUESTS_MESSAGE,
  readSmsSettings,
  type SmsSettings,
} from '../sms/sms.config';
import { maskPhoneNumber } from '../tracking/pii.util';
import { DEFAULT_POLL_WAIT_SECONDS } from './dto/poll-jobs-query.dto';
import type { DeviceHeartbeatDto } from './dto/device-heartbeat.dto';
import type { JobResultDto } from './dto/job-result.dto';
import {
  SmsDeviceBindingService,
  type SmsGatewayBindingView,
} from './sms-device-binding.service';
import { SmsJobWaiter } from './sms-job-waiter';
import { decideTransition, type ReportableSmsStatus } from './sms-transitions';

/** How long the phone holds a job before an unreported one turns UNKNOWN. */
export const SMS_LEASE_MS = 60 * 1000;

/** A queued SMS whose caller gave no expiry lives this long. */
export const DEFAULT_SMS_TTL_MS = 5 * 60 * 1000;

/**
 * A waiting poll re-checks the queue at least this often even without a
 * wake-up — cheap insurance against a missed in-process event (or a second
 * backend process queueing rows this one never hears about).
 */
export const POLL_RECHECK_MS = 5 * 1000;

/** Result-report retries after losing a race to the sweeper or a twin report. */
const RESULT_RACE_RETRIES = 3;

export interface SmsSendMeta {
  /** The otp_codes row this SMS carries — UNIQUE, so one code queues once. */
  otpCodeId?: string;
  /** When the SMS stops being worth sending (the code's own expiry). */
  expiresAt?: Date;
}

/** One job as the phone receives it. */
export interface GatewayJob {
  id: string;
  phone: string;
  body: string;
  expiresAt: string;
}

interface LeasedRow {
  id: string;
  phone: string;
  body: string;
  expiresAt: Date | string;
}

export type SmsGatewayDeviceView = Pick<
  SmsGatewayDevice,
  | 'id'
  | 'lastSeenAt'
  | 'appVersion'
  | 'battery'
  | 'charging'
  | 'signalLevel'
  | 'networkType'
  | 'simOperator'
  | 'pendingResults'
  | 'lastError'
  | 'canSend'
  | 'notReadyReason'
>;

export interface SmsGatewayStatus {
  provider: SmsSettings['provider'];
  /**
   * Codes are being accepted: some device was seen within the offline
   * window AND its last heartbeat did not say canSend=false — exactly the
   * test enqueue() applies.
   */
  online: boolean;
  /**
   * The pinned phone's last heartbeat (null until it has checked in); the
   * most recently seen device while nothing is pinned.
   */
  device: SmsGatewayDeviceView | null;
  /** Which device the token is pinned to, and the last refused device. */
  binding: SmsGatewayBindingView;
  today: {
    queued: number;
    leased: number;
    sent: number;
    delivered: number;
    failed: number;
    deliveryFailed: number;
    expired: number;
    unknown: number;
    cancelled: number;
  };
  dailyCap: number;
  dailyCapPerPhone: number;
}

/**
 * Rows that count toward SMS_DAILY_CAP_PER_PHONE: everything that may have
 * reached the phone. CANCELLED (replaced by a newer code before the phone
 * took it) and EXPIRED (never leased in time) never left the server.
 */
const PER_PHONE_CAP_EXCLUDED: SmsMessageStatus[] = [
  SmsMessageStatus.CANCELLED,
  SmsMessageStatus.EXPIRED,
];

/** 00:00:00.000 UTC of the day `now` falls in. */
export function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * The company-phone SMS gateway: the queue SmsService writes to, and
 * everything the phone's app calls (heartbeat, job long-poll, result).
 *
 * Guarantees, in the order a message meets them:
 *  - only Myanmar mobile numbers (+959...) are queued (400);
 *  - never queued while no device that can send has been seen within
 *    SMS_GATEWAY_OFFLINE_AFTER_SECONDS (a device whose last heartbeat said
 *    canSend=false counts as offline), nor beyond SMS_DAILY_CAP rows per
 *    UTC day (503), nor past SMS_DAILY_CAP_PER_PHONE SMS to one number per
 *    UTC day (409) — the caller's transaction rolls its code back;
 *  - one row per OTP code (UNIQUE otpCodeId, ON CONFLICT DO NOTHING);
 *  - leased to exactly one poll (UPDATE ... FOR UPDATE SKIP LOCKED) and
 *    never leased again — nothing is ever re-queued, so a code is sent at
 *    most once and the user presses "resend" for a new one (which cancels
 *    the old code's SMS if it is still QUEUED — OtpService); never leased
 *    to a device whose last heartbeat said it cannot send;
 *  - only the device that leased a row can report its result, and only
 *    along the transitions in sms-transitions.ts;
 *  - a reported result blanks the body (the code) in the same write: a
 *    code that was sent or failed never sits readable in the database
 *    (a privacy extra of the 2026-10-06 fix round, asked for by no audit
 *    finding; the sweeper does the same for EXPIRED / UNKNOWN).
 *
 * Never logs a code or an SMS body — only the message id, the masked
 * phone, the device id and statuses.
 */
@Injectable()
export class SmsGatewayService {
  private readonly logger = new Logger(SmsGatewayService.name);
  private readonly settings: SmsSettings;

  constructor(
    private readonly prisma: PrismaService,
    private readonly waiter: SmsJobWaiter,
    private readonly binding: SmsDeviceBindingService,
    configService: ConfigService,
  ) {
    this.settings = readSmsSettings(configService);
  }

  // -------------------------------------------------------------------------
  // Queueing (SmsService, SMS_PROVIDER=phone-gateway)
  // -------------------------------------------------------------------------

  /**
   * Queues one SMS for the gateway phone in its own transaction and wakes
   * its long-poll. Refuses exactly as enqueueWithin() does; a second call
   * for the same `otpCodeId` is a no-op.
   */
  async enqueue(
    phone: string,
    body: string,
    meta: SmsSendMeta = {},
  ): Promise<void> {
    const queued = await this.prisma.$transaction((tx) =>
      this.enqueueWithin(tx, phone, body, meta),
    );
    if (queued) this.notifyJobQueued();
  }

  /**
   * Queues one SMS inside the caller's transaction, so the caller's own
   * writes (OtpService's code row) and this row commit or roll back
   * together. Resolves true when a row was inserted (false: this
   * `otpCodeId` is already queued). The row is invisible to the phone until
   * that transaction commits, so the caller must call notifyJobQueued()
   * AFTER the commit, never inside it.
   *
   * Throws, writing nothing:
   *  - 400 INVALID_SMS_PHONE_MESSAGE for anything but a Myanmar mobile
   *    number (+959 and 7-9 digits);
   *  - 503 SMS_UNAVAILABLE_MESSAGE while no device that can send was seen
   *    within the offline window, or once today holds SMS_DAILY_CAP rows;
   *  - 409 TOO_MANY_CODE_REQUESTS_MESSAGE once this number got
   *    SMS_DAILY_CAP_PER_PHONE SMS today (CANCELLED/EXPIRED not counted).
   */
  async enqueueWithin(
    tx: Prisma.TransactionClient,
    phone: string,
    body: string,
    meta: SmsSendMeta = {},
  ): Promise<boolean> {
    const now = new Date();
    const masked = maskPhoneNumber(phone);

    if (!MYANMAR_MOBILE_PATTERN.test(phone)) {
      this.logger.warn(
        `SMS to ${masked} refused: not a Myanmar mobile number (+959...)`,
      );
      throw new BadRequestException(INVALID_SMS_PHONE_MESSAGE);
    }

    if (!(await this.isOnline(now, tx))) {
      this.logger.warn(
        `SMS to ${masked} refused: no gateway device able to send seen in the last ${this.settings.offlineAfterSeconds} s`,
      );
      throw new ServiceUnavailableException(SMS_UNAVAILABLE_MESSAGE);
    }

    const id = randomUUID();
    const expiresAt =
      meta.expiresAt ?? new Date(now.getTime() + DEFAULT_SMS_TTL_MS);
    const otpCodeId = meta.otpCodeId ?? null;
    const dayStart = startOfUtcDay(now);
    const { dailyCap, dailyCapPerPhone } = this.settings;

    // The advisory lock serialises every enqueue until the caller's
    // transaction ends, so both cap checks and the insert are one step: two
    // requests at 999/1000 (or 9/10 for one number) never both pass.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sms_messages.enqueue'))`;
    const toPhoneToday = await tx.smsMessage.count({
      where: {
        phone,
        createdAt: { gte: dayStart },
        status: { notIn: PER_PHONE_CAP_EXCLUDED },
      },
    });
    if (toPhoneToday >= dailyCapPerPhone) {
      this.logger.warn(
        `SMS to ${masked} refused: ${dailyCapPerPhone} SMS to this number today (UTC day) already`,
      );
      throw new ConflictException(TOO_MANY_CODE_REQUESTS_MESSAGE);
    }
    const queuedToday = await tx.smsMessage.count({
      where: { createdAt: { gte: dayStart } },
    });
    if (queuedToday >= dailyCap) {
      this.logger.warn(
        `SMS to ${masked} refused: daily cap of ${dailyCap} SMS (UTC day) reached`,
      );
      throw new ServiceUnavailableException(SMS_UNAVAILABLE_MESSAGE);
    }
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "sms_messages"
        ("id", "otpCodeId", "phone", "body", "status", "expiresAt", "createdAt", "updatedAt")
      VALUES (
        ${id}::uuid, ${otpCodeId}, ${phone}, ${body},
        'QUEUED'::"SmsMessageStatus",
        ${expiresAt}::timestamp(3), ${now}::timestamp(3), ${now}::timestamp(3)
      )
      ON CONFLICT ("otpCodeId") DO NOTHING
      RETURNING "id"`;
    if (inserted.length === 0) {
      this.logger.warn(
        `SMS for otp_codes ${otpCodeId} to ${masked} is already queued; not queued twice`,
      );
      return false;
    }
    this.logger.log(`SMS ${id} queued for ${masked}`);
    return true;
  }

  /** Wakes every waiting long-poll: a newly COMMITTED row is there to lease. */
  notifyJobQueued(): void {
    this.waiter.notifyJobQueued();
  }

  /**
   * True while some gateway device was seen within the offline window and
   * its last heartbeat did not say it cannot send.
   */
  async isOnline(
    now = new Date(),
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const seen = await client.smsGatewayDevice.count({
      where: { lastSeenAt: { gte: this.onlineSince(now) }, canSend: true },
    });
    return seen > 0;
  }

  private onlineSince(now: Date): Date {
    return new Date(now.getTime() - this.settings.offlineAfterSeconds * 1000);
  }

  // -------------------------------------------------------------------------
  // Device routes
  // -------------------------------------------------------------------------

  async heartbeat(
    deviceId: string,
    dto: DeviceHeartbeatDto,
  ): Promise<{ serverTime: string; pollWaitSeconds: number }> {
    const now = new Date();
    // An app that does not report it is taken at its word as able.
    const canSend = dto.canSend ?? true;
    const notReadyReason = dto.notReadyReason ?? null;
    const data = {
      lastSeenAt: now,
      appVersion: dto.appVersion,
      battery: dto.battery,
      charging: dto.charging,
      signalLevel: dto.signalLevel ?? null,
      networkType: dto.networkType ?? null,
      simOperator: dto.simOperator ?? null,
      pendingResults: dto.pendingResults,
      lastError: dto.lastError ?? null,
      canSend,
      notReadyReason,
    };
    // Read the verdict it replaces, so a flip is alerted (below).
    const before = await this.prisma.smsGatewayDevice.findUnique({
      where: { id: deviceId },
      select: { canSend: true },
    });
    await this.prisma.smsGatewayDevice.upsert({
      where: { id: deviceId },
      create: { id: deviceId, ...data },
      update: data,
    });
    this.alertOnCanSendFlip(
      deviceId,
      before?.canSend ?? null,
      canSend,
      notReadyReason,
    );
    return {
      serverTime: now.toISOString(),
      pollWaitSeconds: DEFAULT_POLL_WAIT_SECONDS,
    };
  }

  /**
   * The only alarm for the "cannot send" verdict (M-28, partly: the pin
   * cannot tell the phone from someone who holds the token AND the phone's
   * device id, so a forged canSend=false heartbeat still lands on the
   * phone's row and refuses every code with 503 until the phone's own next
   * heartbeat, 30 s later, or for as long as it is repeated). Logged at
   * ERROR once per flip — never once per heartbeat, so a repeated verdict
   * cannot flood the log — with the one check that tells the two apart:
   * the phone's own screen.
   */
  private alertOnCanSendFlip(
    deviceId: string,
    before: boolean | null,
    after: boolean,
    reason: string | null,
  ): void {
    if (!after && before !== false) {
      this.logger.error(
        `SMS gateway device ${deviceId} says it cannot send SMS (${reason ?? 'no reason given'}): sign-in codes are refused (503) until it can. If the phone's own screen does not say the same, someone holding SMS_GATEWAY_TOKEN may be sending heartbeats as the phone — rotate the token.`,
      );
    } else if (after && before === false) {
      this.logger.log(
        `SMS gateway device ${deviceId} can send SMS again: codes are accepted`,
      );
    }
  }

  /**
   * The phone's long-poll: at most ONE job, leased atomically. With nothing
   * queued it holds the request up to `waitSeconds` and returns as soon as
   * SmsService queues something. Returns `[]` at once when the client has
   * gone (`signal`) or a newer poll from the same device arrived — a job is
   * never leased into a request nobody is reading.
   */
  async pollJobs(
    deviceId: string,
    waitSeconds: number,
    signal?: AbortSignal,
  ): Promise<{ jobs: GatewayJob[] }> {
    const ticket = this.waiter.begin(deviceId);
    try {
      await this.touchDevice(deviceId);
      const deadline = Date.now() + waitSeconds * 1000;
      for (;;) {
        if (signal?.aborted || !this.waiter.isCurrent(deviceId, ticket)) {
          return { jobs: [] };
        }
        const seen = this.waiter.generation;
        const job = await this.leaseNext(deviceId);
        if (job) return { jobs: [job] };

        const remaining = deadline - Date.now();
        if (remaining <= 0) return { jobs: [] };
        const reason = await this.waiter.wait(
          deviceId,
          ticket,
          seen,
          Math.min(remaining, POLL_RECHECK_MS),
          signal,
        );
        if (reason === 'aborted' || reason === 'superseded') {
          return { jobs: [] };
        }
      }
    } finally {
      this.waiter.end(deviceId, ticket);
    }
  }

  /**
   * Leases the oldest live QUEUED row to `deviceId` in ONE statement:
   * SKIP LOCKED means two concurrent polls can never take the same row,
   * and the status flip means it is never offered again. A device whose
   * last heartbeat said canSend=false is leased nothing (its polls just
   * wait): the job stays QUEUED for when it can send again, or expires.
   */
  async leaseNext(deviceId: string): Promise<GatewayJob | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + SMS_LEASE_MS);
    const rows = await this.prisma.$queryRaw<LeasedRow[]>`
      UPDATE "sms_messages"
      SET "status" = 'LEASED'::"SmsMessageStatus",
          "deviceId" = ${deviceId},
          "leasedAt" = ${now}::timestamp(3),
          "leaseExpiresAt" = LEAST(${leaseUntil}::timestamp(3), "expiresAt"),
          "updatedAt" = ${now}::timestamp(3)
      WHERE "id" = (
        SELECT "id" FROM "sms_messages"
        WHERE "status" = 'QUEUED'::"SmsMessageStatus"
          AND "expiresAt" > ${now}::timestamp(3)
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
        AND "status" = 'QUEUED'::"SmsMessageStatus"
        AND NOT EXISTS (
          SELECT 1 FROM "sms_gateway_devices"
          WHERE "id" = ${deviceId} AND "canSend" = false
        )
      RETURNING "id", "phone", "body", "expiresAt"`;
    const row = rows[0];
    if (!row) return null;
    const expiresAt =
      row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
    this.logger.log(
      `SMS ${row.id} to ${maskPhoneNumber(row.phone)} leased to device ${deviceId}`,
    );
    return {
      id: row.id,
      phone: row.phone,
      body: row.body,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * A poll is a heartbeat too: it refreshes lastSeenAt (and creates the
   * device row with placeholder health if the phone polled before its
   * first heartbeat, which replaces them within 30 s).
   */
  private async touchDevice(deviceId: string): Promise<void> {
    const now = new Date();
    await this.prisma.smsGatewayDevice.upsert({
      where: { id: deviceId },
      create: {
        id: deviceId,
        lastSeenAt: now,
        appVersion: 'unknown',
        battery: 0,
        charging: false,
        pendingResults: 0,
      },
      update: { lastSeenAt: now },
    });
  }

  /**
   * Records what the phone reports for a job. 404 unless `deviceId` leased
   * it; 200 for an allowed move or an exact repeat; 409 for anything else
   * (the phone treats 409 as acknowledged).
   */
  async recordResult(
    deviceId: string,
    id: string,
    dto: JobResultDto,
  ): Promise<{ id: string; status: SmsMessageStatus }> {
    const reported: ReportableSmsStatus = dto.status;
    for (let attempt = 0; attempt < RESULT_RACE_RETRIES; attempt++) {
      const row = await this.prisma.smsMessage.findUnique({
        where: { id },
        select: { id: true, status: true, deviceId: true, phone: true },
      });
      if (!row || row.deviceId !== deviceId) {
        throw new NotFoundException('SMS job not found');
      }

      const decision = decideTransition(row.status, reported);
      if (decision === 'repeat') return { id: row.id, status: row.status };
      if (decision === 'conflict') {
        throw new ConflictException(
          `SMS job is ${row.status}; ${reported} cannot be recorded`,
        );
      }

      // Conditional on the status just read: a sweeper run or a twin
      // report that lands in between makes this match 0 rows, and the
      // loop decides again against the new status.
      const updated = await this.prisma.smsMessage.updateMany({
        where: { id, deviceId, status: row.status },
        data: this.resultData(dto),
      });
      if (updated.count === 1) {
        const note = dto.errorCode ? ` (${dto.errorCode})` : '';
        const log = `SMS ${id} to ${maskPhoneNumber(row.phone)}: ${row.status} -> ${reported}${note}`;
        if (
          reported === SmsMessageStatus.FAILED ||
          reported === SmsMessageStatus.DELIVERY_FAILED
        ) {
          this.logger.warn(log);
        } else {
          this.logger.log(log);
        }
        return { id, status: reported };
      }
    }
    throw new ConflictException('SMS job changed while recording; retry');
  }

  /**
   * The status move plus its timestamp — and the body blanked (privacy
   * extra, not an audit finding): once the phone has reported on a job,
   * nobody will send that code again, so it must not stay readable in the
   * database.
   */
  private resultData(
    dto: JobResultDto,
  ): Prisma.SmsMessageUpdateManyMutationInput {
    const now = new Date();
    const reportedAt = new Date(dto.occurredAt);
    // The phone's clock: never store a time in the future.
    const at =
      Number.isNaN(reportedAt.getTime()) || reportedAt > now ? now : reportedAt;
    const redacted = { body: SMS_REDACTED, redactedAt: now };
    const error = {
      errorCode: dto.errorCode ?? null,
      errorMessage: dto.errorMessage ?? null,
    };
    switch (dto.status) {
      case SmsMessageStatus.SENT:
        return { status: SmsMessageStatus.SENT, sentAt: at, ...redacted };
      case SmsMessageStatus.DELIVERED:
        return {
          status: SmsMessageStatus.DELIVERED,
          deliveredAt: at,
          ...redacted,
        };
      case SmsMessageStatus.FAILED:
        return {
          status: SmsMessageStatus.FAILED,
          failedAt: at,
          ...error,
          ...redacted,
        };
      case SmsMessageStatus.DELIVERY_FAILED:
        return {
          status: SmsMessageStatus.DELIVERY_FAILED,
          failedAt: at,
          ...error,
          ...redacted,
        };
    }
  }

  // -------------------------------------------------------------------------
  // Staff status
  // -------------------------------------------------------------------------

  async status(): Promise<SmsGatewayStatus> {
    const now = new Date();
    const [online, binding, groups] = await Promise.all([
      this.isOnline(now),
      this.binding.view(),
      this.prisma.smsMessage.groupBy({
        by: ['status'],
        where: { createdAt: { gte: startOfUtcDay(now) } },
        _count: { _all: true },
      }),
    ]);
    // The pinned phone is THE device; before anything is pinned (first
    // deploy, or right after a reset) the most recently seen one.
    const device = await this.prisma.smsGatewayDevice.findFirst({
      where: binding.deviceId ? { id: binding.deviceId } : undefined,
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        lastSeenAt: true,
        appVersion: true,
        battery: true,
        charging: true,
        signalLevel: true,
        networkType: true,
        simOperator: true,
        pendingResults: true,
        lastError: true,
        canSend: true,
        notReadyReason: true,
      },
    });
    const count = (status: SmsMessageStatus) =>
      groups.find((g) => g.status === status)?._count._all ?? 0;
    return {
      provider: this.settings.provider,
      online,
      device,
      binding,
      today: {
        queued: count(SmsMessageStatus.QUEUED),
        leased: count(SmsMessageStatus.LEASED),
        sent: count(SmsMessageStatus.SENT),
        delivered: count(SmsMessageStatus.DELIVERED),
        failed: count(SmsMessageStatus.FAILED),
        deliveryFailed: count(SmsMessageStatus.DELIVERY_FAILED),
        expired: count(SmsMessageStatus.EXPIRED),
        unknown: count(SmsMessageStatus.UNKNOWN),
        cancelled: count(SmsMessageStatus.CANCELLED),
      },
      dailyCap: this.settings.dailyCap,
      dailyCapPerPhone: this.settings.dailyCapPerPhone,
    };
  }
}
