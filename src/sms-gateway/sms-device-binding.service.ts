import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/** The one row of sms_gateway_binding. */
const BINDING_ID = 1;

/** What the staff status card shows about the pin. */
export interface SmsGatewayBindingView {
  /** The pinned phone's uuid; null while no phone is pinned. */
  deviceId: string | null;
  pinnedAt: Date | null;
  /** The last device that presented the right token under another uuid. */
  lastRejectedDeviceId: string | null;
  lastRejectedAt: Date | null;
  /** Refusals since the pin was set. */
  rejectedCount: number;
  resetAt: Date | null;
}

export const EMPTY_BINDING: SmsGatewayBindingView = {
  deviceId: null,
  pinnedAt: null,
  lastRejectedDeviceId: null,
  lastRejectedAt: null,
  rejectedCount: 0,
  resetAt: null,
};

/**
 * Binds the shared SMS_GATEWAY_TOKEN to ONE phone (security audit
 * 2026-10-06, H-5 / H-7). The token used to open the device routes for any
 * well-formed X-Device-Id, so whoever held it could run a second "phone"
 * and lease every login code before the real one.
 *
 *  - The first device uuid that presents the right token is pinned
 *    (sms_gateway_binding, one row). Two devices racing for an empty pin
 *    are serialised by the row: exactly one wins.
 *  - Every other uuid is refused (DeviceTokenGuard answers 401), logged at
 *    error level, and noted in lastRejected* / rejectedCount so the admin
 *    SMS card can say "another device tried to use the token at <time>".
 *  - A super admin clears the pin (reset) after a phone reinstall or a
 *    new phone; the next device to present the token is pinned.
 *
 * The check runs AFTER the token check, so a wrong token never pins
 * anything and is never counted as a rejection.
 *
 * Two limits, both told to the owner (admin card copy, DOCKER.md):
 *  - After a reset the pin is empty until the next device presents the
 *    token, and whoever presents it first wins — the company phone (its
 *    next poll or heartbeat, within 30 s) or someone holding the token who
 *    keeps polling (a refused poll costs them nothing). Nothing here can
 *    tell them apart, so: if the "another device" warning comes back right
 *    after a reset, rotate SMS_GATEWAY_TOKEN first, then reset again.
 *  - The pin has no per-device secret (M-28, still open): someone holding
 *    the token AND the pinned phone's device id (both travel in the phone's
 *    requests; the id is also on the admin card) is admitted as the phone
 *    for everything it can do — lease codes in its name (so H-5 / H-7 are
 *    closed for a token-only holder, not for someone who read the phone's
 *    plain-http traffic) and send a "cannot send" heartbeat in its name.
 *    The flip is logged at ERROR (SmsGatewayService.heartbeat) and the
 *    throttle no longer lets them burn the phone's bucket
 *    (smsDeviceTracker); only a per-device secret (an Android app change)
 *    or TLS on the gateway path (H-1) closes it.
 */
@Injectable()
export class SmsDeviceBindingService {
  private readonly logger = new Logger(SmsDeviceBindingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * True when `deviceId` is the pinned phone — or just became it, because
   * nothing was pinned. False (refuse the request) for any other device.
   */
  async admit(deviceId: string): Promise<boolean> {
    const pinned = await this.pinnedDeviceId();
    if (pinned === deviceId) return true;
    if (pinned === null) {
      const winner = await this.pinIfEmpty(deviceId);
      if (winner === deviceId) {
        this.logger.log(
          `SMS gateway token is now pinned to device ${deviceId}: no other device may use it until a super admin resets the pin`,
        );
        return true;
      }
      return this.reject(deviceId, winner);
    }
    return this.reject(deviceId, pinned);
  }

  /** The pinned uuid, or null while nothing is pinned. */
  async pinnedDeviceId(): Promise<string | null> {
    const row = await this.prisma.smsGatewayBinding.findUnique({
      where: { id: BINDING_ID },
      select: { deviceId: true },
    });
    return row?.deviceId ?? null;
  }

  /**
   * Pins `deviceId` unless something is already pinned, in ONE statement:
   * the INSERT ... ON CONFLICT ... WHERE "deviceId" IS NULL is atomic, so of
   * two first-comers exactly one lands. Resolves to whatever is pinned
   * afterwards (this device, or the one that got there first).
   */
  private async pinIfEmpty(deviceId: string): Promise<string | null> {
    const now = new Date();
    const rows = await this.prisma.$queryRaw<{ deviceId: string }[]>`
      INSERT INTO "sms_gateway_binding"
        ("id", "deviceId", "pinnedAt", "rejectedCount", "createdAt", "updatedAt")
      VALUES (${BINDING_ID}, ${deviceId}, ${now}::timestamp(3), 0, ${now}::timestamp(3), ${now}::timestamp(3))
      ON CONFLICT ("id") DO UPDATE
        SET "deviceId" = EXCLUDED."deviceId",
            "pinnedAt" = EXCLUDED."pinnedAt",
            "rejectedCount" = 0,
            "lastRejectedDeviceId" = NULL,
            "lastRejectedAt" = NULL,
            "updatedAt" = EXCLUDED."updatedAt"
        WHERE "sms_gateway_binding"."deviceId" IS NULL
      RETURNING "deviceId"`;
    if (rows.length === 1) return rows[0].deviceId;
    return this.pinnedDeviceId();
  }

  /** Notes the refusal for the admin card and the log; always false. */
  private async reject(
    deviceId: string,
    pinned: string | null,
  ): Promise<false> {
    const now = new Date();
    this.logger.error(
      `SMS gateway token refused for device ${deviceId}: the token is pinned to device ${pinned ?? '(none)'}. Another phone — or someone holding the token — tried to use it. If the company phone was reinstalled, reset the pin from the admin SMS card; otherwise rotate SMS_GATEWAY_TOKEN.`,
    );
    try {
      await this.prisma.smsGatewayBinding.updateMany({
        where: { id: BINDING_ID },
        data: {
          lastRejectedDeviceId: deviceId,
          lastRejectedAt: now,
          rejectedCount: { increment: 1 },
        },
      });
    } catch (error) {
      // The refusal stands whether or not the note could be written.
      this.logger.error(
        `could not record the refused SMS gateway device: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return false;
  }

  /** For the staff status card. */
  async view(): Promise<SmsGatewayBindingView> {
    const row = await this.prisma.smsGatewayBinding.findUnique({
      where: { id: BINDING_ID },
      select: {
        deviceId: true,
        pinnedAt: true,
        lastRejectedDeviceId: true,
        lastRejectedAt: true,
        rejectedCount: true,
        resetAt: true,
      },
    });
    return row ?? EMPTY_BINDING;
  }

  /**
   * Clears the pin (and the rejection note) so the next device that
   * presents the token is pinned — for a reinstalled or replaced phone.
   * Super admin only (the controller checks); writes an audit row. The
   * window until the next device arrives is a race a token holder can win
   * (class note): the only answer is rotating the token first.
   */
  async reset(actor: AuthenticatedUser): Promise<SmsGatewayBindingView> {
    const before = await this.view();
    const now = new Date();
    const cleared = {
      deviceId: null,
      pinnedAt: null,
      lastRejectedDeviceId: null,
      lastRejectedAt: null,
      rejectedCount: 0,
      resetAt: now,
      resetById: actor.id,
    };
    await this.prisma.smsGatewayBinding.upsert({
      where: { id: BINDING_ID },
      create: { id: BINDING_ID, ...cleared },
      update: cleared,
    });
    this.logger.warn(
      `SMS gateway device pin cleared by ${actor.username} (was device ${before.deviceId ?? '(none)'}): the next device to present the token will be pinned`,
    );
    await this.audit.record({
      action: 'sms_gateway.binding_reset',
      actor,
      target: { type: 'sms_gateway', id: null, label: 'SMS gateway' },
      before: {
        deviceId: before.deviceId,
        pinnedAt: before.pinnedAt,
        lastRejectedDeviceId: before.lastRejectedDeviceId,
        lastRejectedAt: before.lastRejectedAt,
        rejectedCount: before.rejectedCount,
      },
      after: {
        deviceId: null,
        pinnedAt: null,
        lastRejectedDeviceId: null,
        lastRejectedAt: null,
        rejectedCount: 0,
      },
    });
    return this.view();
  }
}
