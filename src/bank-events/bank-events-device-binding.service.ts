import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/** The one row of bank_events_binding. */
const BINDING_ID = 1;

/**
 * A monitor that keeps presenting the token after a refusal (a second copy
 * of the app left running reconnects its live link every 30 s, and nothing
 * throttles the socket handshake) is COUNTED every time but audited once
 * per burst: no new bank_events.rejected_device row while the previous
 * refusal was the same serial less than this long ago. The card still
 * shows the count and the last time; the log line is written every time.
 */
const REPEAT_REFUSAL_WINDOW_MS = 60_000;

/**
 * A monitor serial: 8–64 characters of letters, digits, dot, underscore or
 * dash — a uuid, a machine id or a hand-made name; nothing that could be a
 * header injection or an empty string. Shared by the HTTP guard
 * (X-Device-Serial) and the socket handshake (auth.deviceSerial).
 */
export const DEVICE_SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;

/** True for any JSON value that is a well-formed serial (trimmed). */
export function isDeviceSerial(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_SERIAL_PATTERN.test(value.trim());
}

/**
 * The two 401 reasons a phone-monitor can read in the reply body (and in
 * the socket's connect_error). Both are deliberately plain codes, so the
 * monitor's settings panel can say what to do in its own words (README,
 * "Connecting to MyanFlix").
 */
export const DEVICE_SERIAL_REQUIRED = 'DEVICE_SERIAL_REQUIRED';
export const DEVICE_SERIAL_REJECTED = 'DEVICE_SERIAL_REJECTED';

/** The audit target every binding row points at (there is only one). */
const BINDING_TARGET = {
  type: 'bank_events',
  id: null,
  label: 'Bank events',
} as const;

/** What the staff card shows about the pin. */
export interface BankEventsBindingView {
  /** The pinned monitor's serial; null while no monitor is pinned. */
  deviceSerial: string | null;
  pinnedAt: Date | null;
  /** The last monitor that presented the right token under another serial. */
  lastRejectedDeviceSerial: string | null;
  lastRejectedAt: Date | null;
  /** Refusals since the pin was set. */
  rejectedCount: number;
  resetAt: Date | null;
}

export const EMPTY_BANK_EVENTS_BINDING: BankEventsBindingView = {
  deviceSerial: null,
  pinnedAt: null,
  lastRejectedDeviceSerial: null,
  lastRejectedAt: null,
  rejectedCount: 0,
  resetAt: null,
};

/**
 * Binds the shared BANK_EVENTS_TOKEN to ONE phone-monitor (audit
 * 2026-10-09, SEC-004 / DB-015). The token used to open the bank-events
 * routes for anyone who held it, so a forged "You received …" event could
 * make a never-paid deposit look bank-verified. The exact twin of
 * SmsDeviceBindingService, keyed on the monitor's X-Device-Serial:
 *
 *  - The first serial that presents the right token is pinned
 *    (bank_events_binding, one row). Two monitors racing for an empty pin
 *    are serialised by the row: exactly one wins.
 *  - Every other serial is refused (MachineTokenGuard and the socket
 *    handshake answer 401), logged at error level, noted in lastRejected* /
 *    rejectedCount for the admin "Bank monitor" card, AND written to the
 *    audit log as bank_events.rejected_device — the SMS pin only logs, but
 *    a refused bank event is a money signal and the owner wanted a row.
 *    Repeats from the same serial within a minute are counted, not
 *    re-audited (REPEAT_REFUSAL_WINDOW_MS), so a stray monitor cannot grow
 *    audit_logs without bound.
 *  - A super admin clears the pin (reset) after the monitor is reinstalled
 *    or moved to another PC; the next monitor to present the token is
 *    pinned.
 *
 * The check runs AFTER the token check, so a wrong token never pins
 * anything and is never counted as a rejection.
 *
 * The same two limits as the SMS pin apply, and the answer is the same:
 * after a reset whoever presents the token first wins (start the monitor
 * on the owner's PC right away), and someone holding the token AND the
 * pinned serial (both travel in plain http on today's LAN rig) is admitted
 * as the monitor — only TLS on the API (SEC-002) and a token rotation
 * close that.
 */
@Injectable()
export class BankEventsDeviceBindingService {
  private readonly logger = new Logger(BankEventsDeviceBindingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * True when `deviceSerial` is the pinned monitor — or just became it,
   * because nothing was pinned. False (refuse the request) for any other
   * serial.
   */
  async admit(deviceSerial: string): Promise<boolean> {
    const pinned = await this.pinnedDeviceSerial();
    if (pinned === deviceSerial) return true;
    if (pinned === null) {
      const winner = await this.pinIfEmpty(deviceSerial);
      if (winner === deviceSerial) {
        this.logger.log(
          `bank-events token is now pinned to phone-monitor ${deviceSerial}: no other monitor may use it until a super admin resets the pin`,
        );
        return true;
      }
      return this.reject(deviceSerial, winner);
    }
    return this.reject(deviceSerial, pinned);
  }

  /** The pinned serial, or null while nothing is pinned. */
  async pinnedDeviceSerial(): Promise<string | null> {
    const row = await this.prisma.bankEventsBinding.findUnique({
      where: { id: BINDING_ID },
      select: { deviceSerial: true },
    });
    return row?.deviceSerial ?? null;
  }

  /**
   * Pins `deviceSerial` unless something is already pinned, in ONE
   * statement: the INSERT ... ON CONFLICT ... WHERE "deviceSerial" IS NULL
   * is atomic, so of two first-comers exactly one lands. Resolves to
   * whatever is pinned afterwards (this monitor, or the one that got there
   * first).
   */
  private async pinIfEmpty(deviceSerial: string): Promise<string | null> {
    const now = new Date();
    const rows = await this.prisma.$queryRaw<{ deviceSerial: string }[]>`
      INSERT INTO "bank_events_binding"
        ("id", "deviceSerial", "pinnedAt", "rejectedCount", "createdAt", "updatedAt")
      VALUES (${BINDING_ID}, ${deviceSerial}, ${now}::timestamp(3), 0, ${now}::timestamp(3), ${now}::timestamp(3))
      ON CONFLICT ("id") DO UPDATE
        SET "deviceSerial" = EXCLUDED."deviceSerial",
            "pinnedAt" = EXCLUDED."pinnedAt",
            "rejectedCount" = 0,
            "lastRejectedDeviceSerial" = NULL,
            "lastRejectedAt" = NULL,
            "updatedAt" = EXCLUDED."updatedAt"
        WHERE "bank_events_binding"."deviceSerial" IS NULL
      RETURNING "deviceSerial"`;
    if (rows.length === 1) return rows[0].deviceSerial;
    return this.pinnedDeviceSerial();
  }

  /**
   * Notes the refusal for the admin card, the log and the audit trail;
   * always false. The refusal stands whether or not a note could be
   * written. The audit row is skipped for a repeat (same serial, refused
   * less than REPEAT_REFUSAL_WINDOW_MS ago) — the counter still moves; and
   * when the previous refusal cannot be read the row is written (the safe
   * side is one row too many).
   */
  private async reject(
    deviceSerial: string,
    pinned: string | null,
  ): Promise<false> {
    const now = new Date();
    this.logger.error(
      `bank-events token refused for phone-monitor ${deviceSerial}: the token is pinned to monitor ${pinned ?? '(none)'}. Another PC — or someone holding the token — tried to post bank events. If the monitor was reinstalled or moved, reset the pin from the admin Bank monitor card; otherwise rotate BANK_EVENTS_TOKEN.`,
    );
    let repeat = false;
    try {
      const last = await this.prisma.bankEventsBinding.findUnique({
        where: { id: BINDING_ID },
        select: { lastRejectedDeviceSerial: true, lastRejectedAt: true },
      });
      repeat =
        last !== null &&
        last.lastRejectedDeviceSerial === deviceSerial &&
        last.lastRejectedAt !== null &&
        now.getTime() - last.lastRejectedAt.getTime() <
          REPEAT_REFUSAL_WINDOW_MS;
      await this.prisma.bankEventsBinding.updateMany({
        where: { id: BINDING_ID },
        data: {
          lastRejectedDeviceSerial: deviceSerial,
          lastRejectedAt: now,
          rejectedCount: { increment: 1 },
        },
      });
    } catch (error) {
      this.logger.error(
        `could not record the refused phone-monitor: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (repeat) return false;
    try {
      await this.audit.record({
        action: 'bank_events.rejected_device',
        actor: null,
        target: BINDING_TARGET,
        metadata: {
          deviceSerial,
          pinnedDeviceSerial: pinned,
          rejectedAt: now,
        },
      });
    } catch (error) {
      this.logger.error(
        `could not audit the refused phone-monitor: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return false;
  }

  /** For the staff card. */
  async view(): Promise<BankEventsBindingView> {
    const row = await this.prisma.bankEventsBinding.findUnique({
      where: { id: BINDING_ID },
      select: {
        deviceSerial: true,
        pinnedAt: true,
        lastRejectedDeviceSerial: true,
        lastRejectedAt: true,
        rejectedCount: true,
        resetAt: true,
      },
    });
    return row ?? EMPTY_BANK_EVENTS_BINDING;
  }

  /**
   * Clears the pin (and the rejection note) so the next monitor that
   * presents the token is pinned — for a reinstalled or moved monitor.
   * Super admin only (the controller checks); writes an audit row. The
   * window until the next monitor arrives is a race a token holder can win
   * (class note): the only answer is rotating the token first.
   */
  async reset(actor: AuthenticatedUser): Promise<BankEventsBindingView> {
    const before = await this.view();
    const now = new Date();
    const cleared = {
      deviceSerial: null,
      pinnedAt: null,
      lastRejectedDeviceSerial: null,
      lastRejectedAt: null,
      rejectedCount: 0,
      resetAt: now,
      resetById: actor.id,
    };
    await this.prisma.bankEventsBinding.upsert({
      where: { id: BINDING_ID },
      create: { id: BINDING_ID, ...cleared },
      update: cleared,
    });
    this.logger.warn(
      `bank-events device pin cleared by ${actor.username} (was monitor ${before.deviceSerial ?? '(none)'}): the next phone-monitor to present the token will be pinned`,
    );
    await this.audit.record({
      action: 'bank_events.binding_reset',
      actor,
      target: BINDING_TARGET,
      before: {
        deviceSerial: before.deviceSerial,
        pinnedAt: before.pinnedAt,
        lastRejectedDeviceSerial: before.lastRejectedDeviceSerial,
        lastRejectedAt: before.lastRejectedAt,
        rejectedCount: before.rejectedCount,
      },
      after: {
        deviceSerial: null,
        pinnedAt: null,
        lastRejectedDeviceSerial: null,
        lastRejectedAt: null,
        rejectedCount: 0,
      },
    });
    return this.view();
  }
}
