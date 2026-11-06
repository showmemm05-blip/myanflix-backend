import { Logger } from '@nestjs/common';
import { Role } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  BankEventsDeviceBindingService,
  EMPTY_BANK_EVENTS_BINDING,
  isDeviceSerial,
} from './bank-events-device-binding.service';

const SERIAL = '3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f38';
const OTHER_SERIAL = 'OTHER-PC-0001';

type RawCall = [TemplateStringsArray, ...unknown[]];
const sqlOf = (call: unknown[]) => (call as RawCall)[0].join('?');

const superAdmin: AuthenticatedUser = {
  id: 'owner-id',
  username: 'owner',
  role: Role.SUPER_ADMIN,
  appRoleId: null,
};

/**
 * SEC-004 / DB-015: the shared BANK_EVENTS_TOKEN is bound to ONE
 * phone-monitor, exactly like SmsDeviceBindingService pins the SMS phone.
 * The database is faked; the real INSERT ... ON CONFLICT race and the HTTP
 * 401s are covered end to end by test/deposits.e2e-spec.ts.
 */
describe('BankEventsDeviceBindingService', () => {
  let prisma: {
    $queryRaw: jest.Mock;
    bankEventsBinding: {
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      upsert: jest.Mock;
    };
  };
  let audit: { record: jest.Mock };
  let service: BankEventsDeviceBindingService;
  let logError: jest.SpyInstance;
  let logLog: jest.SpyInstance;

  /** What the single row holds right now (null = no row yet). */
  let row: {
    deviceSerial: string | null;
    lastRejectedDeviceSerial?: string | null;
    lastRejectedAt?: Date | null;
  } | null;

  beforeEach(() => {
    row = null;
    prisma = {
      // The atomic pin: lands only while nothing is pinned.
      $queryRaw: jest.fn().mockImplementation((_sql, _id, deviceSerial) => {
        if (row === null || row.deviceSerial === null) {
          row = { deviceSerial: deviceSerial as string };
          return Promise.resolve([{ deviceSerial }]);
        }
        return Promise.resolve([]);
      }),
      bankEventsBinding: {
        findUnique: jest.fn().mockImplementation(() =>
          Promise.resolve(
            row === null
              ? null
              : {
                  deviceSerial: row.deviceSerial,
                  pinnedAt: row.deviceSerial ? new Date() : null,
                  lastRejectedDeviceSerial:
                    row.lastRejectedDeviceSerial ?? null,
                  lastRejectedAt: row.lastRejectedAt ?? null,
                  rejectedCount: 0,
                  resetAt: null,
                },
          ),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn().mockImplementation(() => {
          row = { deviceSerial: null };
          return Promise.resolve({});
        }),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new BankEventsDeviceBindingService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
    logLog = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('admit', () => {
    it('pins the first monitor that presents the token, atomically, and lets it in', async () => {
      await expect(service.admit(SERIAL)).resolves.toBe(true);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const sql = sqlOf(prisma.$queryRaw.mock.calls[0] as unknown[]);
      expect(sql).toContain('INSERT INTO "bank_events_binding"');
      expect(sql).toContain('ON CONFLICT ("id") DO UPDATE');
      expect(sql).toContain(
        'WHERE "bank_events_binding"."deviceSerial" IS NULL',
      );
      expect(row).toEqual({ deviceSerial: SERIAL });
      expect(logLog).toHaveBeenCalledWith(
        expect.stringContaining(`pinned to phone-monitor ${SERIAL}`),
      );
      expect(prisma.bankEventsBinding.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('lets the pinned monitor in again without writing anything', async () => {
      row = { deviceSerial: SERIAL };

      await expect(service.admit(SERIAL)).resolves.toBe(true);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.bankEventsBinding.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses every other monitor, notes it for the admin card, writes a bank_events.rejected_device audit row and shouts in the log', async () => {
      row = { deviceSerial: SERIAL };

      await expect(service.admit(OTHER_SERIAL)).resolves.toBe(false);

      expect(row).toEqual({ deviceSerial: SERIAL });
      expect(prisma.bankEventsBinding.updateMany).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          lastRejectedDeviceSerial: OTHER_SERIAL,
          lastRejectedAt: expect.any(Date),
          rejectedCount: { increment: 1 },
        },
      });
      expect(audit.record).toHaveBeenCalledWith({
        action: 'bank_events.rejected_device',
        actor: null,
        target: { type: 'bank_events', id: null, label: 'Bank events' },
        metadata: {
          deviceSerial: OTHER_SERIAL,
          pinnedDeviceSerial: SERIAL,
          rejectedAt: expect.any(Date),
        },
      });
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(
          `refused for phone-monitor ${OTHER_SERIAL}: the token is pinned to monitor ${SERIAL}`,
        ),
      );
    });

    it('two first-comers: the one whose INSERT lands wins, the other is refused and audited', async () => {
      // The loser read "nothing pinned", then lost the INSERT race.
      prisma.bankEventsBinding.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ deviceSerial: SERIAL });
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(service.admit(OTHER_SERIAL)).resolves.toBe(false);

      expect(prisma.bankEventsBinding.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastRejectedDeviceSerial: OTHER_SERIAL,
          }),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_events.rejected_device',
          metadata: expect.objectContaining({
            deviceSerial: OTHER_SERIAL,
            pinnedDeviceSerial: SERIAL,
          }),
        }),
      );
    });

    it('still refuses when neither the note nor the audit row can be written', async () => {
      row = { deviceSerial: SERIAL };
      prisma.bankEventsBinding.updateMany.mockRejectedValue(
        new Error('db down'),
      );
      audit.record.mockRejectedValue(new Error('db down'));

      await expect(service.admit(OTHER_SERIAL)).resolves.toBe(false);
    });

    // Review of SEC-004 (2026-10-09): nothing throttles the socket handshake,
    // and a second copy of the monitor left running reconnects every 30 s —
    // one audit row per refusal would grow audit_logs without bound.
    it('a repeat from the same serial within a minute is counted but NOT audited again', async () => {
      row = {
        deviceSerial: SERIAL,
        lastRejectedDeviceSerial: OTHER_SERIAL,
        lastRejectedAt: new Date(Date.now() - 30_000),
      };

      await expect(service.admit(OTHER_SERIAL)).resolves.toBe(false);

      expect(prisma.bankEventsBinding.updateMany).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          lastRejectedDeviceSerial: OTHER_SERIAL,
          lastRejectedAt: expect.any(Date),
          rejectedCount: { increment: 1 },
        },
      });
      expect(audit.record).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(`refused for phone-monitor ${OTHER_SERIAL}`),
      );
    });

    it('audits again once the previous refusal is older than a minute, or came from another serial', async () => {
      row = {
        deviceSerial: SERIAL,
        lastRejectedDeviceSerial: OTHER_SERIAL,
        lastRejectedAt: new Date(Date.now() - 90_000),
      };
      await expect(service.admit(OTHER_SERIAL)).resolves.toBe(false);
      expect(audit.record).toHaveBeenCalledTimes(1);

      row = {
        deviceSerial: SERIAL,
        lastRejectedDeviceSerial: 'THIRD-PC-0002',
        lastRejectedAt: new Date(Date.now() - 1_000),
      };
      await expect(service.admit(OTHER_SERIAL)).resolves.toBe(false);
      expect(audit.record).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'bank_events.rejected_device',
          metadata: expect.objectContaining({ deviceSerial: OTHER_SERIAL }),
        }),
      );
    });

    it('writes the audit row when the previous refusal cannot be read (one row too many is the safe side)', async () => {
      prisma.bankEventsBinding.findUnique
        .mockResolvedValueOnce({ deviceSerial: SERIAL })
        .mockRejectedValueOnce(new Error('db down'));

      await expect(service.admit(OTHER_SERIAL)).resolves.toBe(false);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'bank_events.rejected_device' }),
      );
    });
  });

  describe('view', () => {
    it('is empty until a monitor has been pinned', async () => {
      await expect(service.view()).resolves.toEqual(EMPTY_BANK_EVENTS_BINDING);
    });

    it('shows the pinned monitor', async () => {
      row = { deviceSerial: SERIAL };

      await expect(service.view()).resolves.toMatchObject({
        deviceSerial: SERIAL,
        pinnedAt: expect.any(Date),
      });
    });
  });

  describe('reset (super admin)', () => {
    it('clears the pin and the refusal note, remembers who reset it, and writes an audit row', async () => {
      row = { deviceSerial: SERIAL };

      const after = await service.reset(superAdmin);

      expect(prisma.bankEventsBinding.upsert).toHaveBeenCalledWith({
        where: { id: 1 },
        create: expect.objectContaining({
          id: 1,
          deviceSerial: null,
          resetById: 'owner-id',
        }),
        update: {
          deviceSerial: null,
          pinnedAt: null,
          lastRejectedDeviceSerial: null,
          lastRejectedAt: null,
          rejectedCount: 0,
          resetAt: expect.any(Date),
          resetById: 'owner-id',
        },
      });
      expect(after.deviceSerial).toBeNull();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_events.binding_reset',
          actor: superAdmin,
          target: { type: 'bank_events', id: null, label: 'Bank events' },
          before: expect.objectContaining({ deviceSerial: SERIAL }),
          after: expect.objectContaining({ deviceSerial: null }),
        }),
      );
    });

    it('after a reset the next monitor to present the token is pinned', async () => {
      row = { deviceSerial: SERIAL };
      await service.reset(superAdmin);

      await expect(service.admit(OTHER_SERIAL)).resolves.toBe(true);
      expect(row).toEqual({ deviceSerial: OTHER_SERIAL });
      await expect(service.admit(SERIAL)).resolves.toBe(false);
    });
  });
});

describe('isDeviceSerial', () => {
  it('accepts a uuid, a machine id or a hand-made name of 8–64 safe characters', () => {
    expect(isDeviceSerial(SERIAL)).toBe(true);
    expect(isDeviceSerial(OTHER_SERIAL)).toBe(true);
    expect(isDeviceSerial('pc01.home_1')).toBe(true);
    expect(isDeviceSerial(` ${SERIAL} `)).toBe(true);
    expect(isDeviceSerial('a'.repeat(64))).toBe(true);
  });

  it('refuses anything short, long, empty, non-string or with other characters', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      '   ',
      'abcdefg',
      'a'.repeat(65),
      '-leading',
      '.leading',
      'has space',
      'semi;colon',
      'new\nline',
    ]) {
      expect(isDeviceSerial(bad)).toBe(false);
    }
  });
});
