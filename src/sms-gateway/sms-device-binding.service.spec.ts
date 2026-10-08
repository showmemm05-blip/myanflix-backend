import { Logger } from '@nestjs/common';
import { Role } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  EMPTY_BINDING,
  SmsDeviceBindingService,
} from './sms-device-binding.service';

const DEVICE = '3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f38';
const OTHER_DEVICE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type RawCall = [TemplateStringsArray, ...unknown[]];
const sqlOf = (call: unknown[]) => (call as RawCall)[0].join('?');

const superAdmin: AuthenticatedUser = {
  id: 'owner-id',
  username: 'owner',
  role: Role.SUPER_ADMIN,
  appRoleId: null,
};

/**
 * H-5 / H-7: the shared token is bound to ONE device. The database is
 * faked; the real INSERT ... ON CONFLICT race is covered end to end by
 * test/sms-gateway.e2e-spec.ts.
 */
describe('SmsDeviceBindingService', () => {
  let prisma: {
    $queryRaw: jest.Mock;
    smsGatewayBinding: {
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      upsert: jest.Mock;
    };
  };
  let audit: { record: jest.Mock };
  let service: SmsDeviceBindingService;
  let logError: jest.SpyInstance;
  let logLog: jest.SpyInstance;

  /** What the single row holds right now (null = no row yet). */
  let row: { deviceId: string | null } | null;

  beforeEach(() => {
    row = null;
    prisma = {
      // The atomic pin: lands only while nothing is pinned.
      $queryRaw: jest.fn().mockImplementation((_sql, _id, deviceId) => {
        if (row === null || row.deviceId === null) {
          row = { deviceId: deviceId as string };
          return Promise.resolve([{ deviceId }]);
        }
        return Promise.resolve([]);
      }),
      smsGatewayBinding: {
        findUnique: jest.fn().mockImplementation(() =>
          Promise.resolve(
            row === null
              ? null
              : {
                  deviceId: row.deviceId,
                  pinnedAt: row.deviceId ? new Date() : null,
                  lastRejectedDeviceId: null,
                  lastRejectedAt: null,
                  rejectedCount: 0,
                  resetAt: null,
                },
          ),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn().mockImplementation(() => {
          row = { deviceId: null };
          return Promise.resolve({});
        }),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new SmsDeviceBindingService(
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
    it('pins the first device that presents the token, atomically, and lets it in', async () => {
      await expect(service.admit(DEVICE)).resolves.toBe(true);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const sql = sqlOf(prisma.$queryRaw.mock.calls[0] as unknown[]);
      expect(sql).toContain('INSERT INTO "sms_gateway_binding"');
      expect(sql).toContain('ON CONFLICT ("id") DO UPDATE');
      expect(sql).toContain('WHERE "sms_gateway_binding"."deviceId" IS NULL');
      expect(row).toEqual({ deviceId: DEVICE });
      expect(logLog).toHaveBeenCalledWith(
        expect.stringContaining(`pinned to device ${DEVICE}`),
      );
      expect(prisma.smsGatewayBinding.updateMany).not.toHaveBeenCalled();
    });

    it('lets the pinned device in again without writing anything', async () => {
      row = { deviceId: DEVICE };

      await expect(service.admit(DEVICE)).resolves.toBe(true);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.smsGatewayBinding.updateMany).not.toHaveBeenCalled();
    });

    it('refuses every other device, notes it for the admin card and shouts in the log', async () => {
      row = { deviceId: DEVICE };

      await expect(service.admit(OTHER_DEVICE)).resolves.toBe(false);

      expect(row).toEqual({ deviceId: DEVICE });
      expect(prisma.smsGatewayBinding.updateMany).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          lastRejectedDeviceId: OTHER_DEVICE,
          lastRejectedAt: expect.any(Date),
          rejectedCount: { increment: 1 },
        },
      });
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(
          `refused for device ${OTHER_DEVICE}: the token is pinned to device ${DEVICE}`,
        ),
      );
    });

    it('two first-comers: the one whose INSERT lands wins, the other is refused', async () => {
      // The loser read "nothing pinned", then lost the INSERT race.
      prisma.smsGatewayBinding.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ deviceId: DEVICE });
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(service.admit(OTHER_DEVICE)).resolves.toBe(false);

      expect(prisma.smsGatewayBinding.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastRejectedDeviceId: OTHER_DEVICE }),
        }),
      );
    });

    it('still refuses when the refusal note cannot be written', async () => {
      row = { deviceId: DEVICE };
      prisma.smsGatewayBinding.updateMany.mockRejectedValue(
        new Error('db down'),
      );

      await expect(service.admit(OTHER_DEVICE)).resolves.toBe(false);
    });
  });

  describe('view', () => {
    it('is empty until a device has been pinned', async () => {
      await expect(service.view()).resolves.toEqual(EMPTY_BINDING);
    });

    it('shows the pinned device', async () => {
      row = { deviceId: DEVICE };

      await expect(service.view()).resolves.toMatchObject({
        deviceId: DEVICE,
        pinnedAt: expect.any(Date),
      });
    });
  });

  describe('reset (super admin)', () => {
    it('clears the pin and the refusal note, remembers who reset it, and writes an audit row', async () => {
      row = { deviceId: DEVICE };

      const after = await service.reset(superAdmin);

      expect(prisma.smsGatewayBinding.upsert).toHaveBeenCalledWith({
        where: { id: 1 },
        create: expect.objectContaining({
          id: 1,
          deviceId: null,
          resetById: 'owner-id',
        }),
        update: {
          deviceId: null,
          pinnedAt: null,
          lastRejectedDeviceId: null,
          lastRejectedAt: null,
          rejectedCount: 0,
          resetAt: expect.any(Date),
          resetById: 'owner-id',
        },
      });
      expect(after.deviceId).toBeNull();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sms_gateway.binding_reset',
          actor: superAdmin,
          target: { type: 'sms_gateway', id: null, label: 'SMS gateway' },
          before: expect.objectContaining({ deviceId: DEVICE }),
          after: expect.objectContaining({ deviceId: null }),
        }),
      );
    });

    it('after a reset the next device to present the token is pinned', async () => {
      row = { deviceId: DEVICE };
      await service.reset(superAdmin);

      await expect(service.admit(OTHER_DEVICE)).resolves.toBe(true);
      expect(row).toEqual({ deviceId: OTHER_DEVICE });
      await expect(service.admit(DEVICE)).resolves.toBe(false);
    });
  });
});
