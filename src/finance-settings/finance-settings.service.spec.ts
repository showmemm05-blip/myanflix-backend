import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Prisma, Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  FINANCE_SETTINGS_LOCK_NAMESPACE,
  FinanceSettingsService,
} from './finance-settings.service';

type RawCall = [TemplateStringsArray, ...unknown[]];

/** The staff member saving the settings — `id` is what the updatedByUserId stamp checks. */
const admin = {
  id: 'admin-1',
  username: 'admin.blake',
  role: Role.SUPER_ADMIN,
  appRoleId: null,
};

function makeSettings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'settings-1',
    minDepositAmount: new Prisma.Decimal(1000),
    maxDepositAmount: new Prisma.Decimal(5000000),
    minWithdrawalAmount: new Prisma.Decimal(1000),
    maxWithdrawalAmount: new Prisma.Decimal(5000000),
    updatedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('FinanceSettingsService', () => {
  let service: FinanceSettingsService;
  let prisma: {
    financeSettings: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      financeSettings: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      // The interactive transaction hands the same mock back as `tx`, so
      // every assertion below sees the writes whichever client made them.
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinanceSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(FinanceSettingsService);
  });

  describe('getOrCreate', () => {
    it('returns the existing row when one already exists, without creating a new one', async () => {
      const existing = makeSettings();
      prisma.financeSettings.findFirst.mockResolvedValue(existing);

      const result = await service.getOrCreate();

      expect(result).toBe(existing);
      expect(prisma.financeSettings.create).not.toHaveBeenCalled();
    });

    it('the fast path (row exists) never opens a transaction or takes the lock', async () => {
      prisma.financeSettings.findFirst.mockResolvedValue(makeSettings());

      await service.getOrCreate();

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('lazily creates the row with sensible defaults on first read', async () => {
      prisma.financeSettings.findFirst.mockResolvedValue(null);
      prisma.financeSettings.create.mockResolvedValue(makeSettings());

      await service.getOrCreate();

      expect(prisma.financeSettings.create).toHaveBeenCalledWith({
        data: {
          minDepositAmount: 1000,
          maxDepositAmount: 5_000_000,
          minWithdrawalAmount: 1000,
          maxWithdrawalAmount: 5_000_000,
        },
      });
    });

    // L-38: findFirst-then-create with no unique column let two concurrent
    // first requests create two rows. The create now runs inside a
    // transaction that first takes a global advisory lock and re-checks.
    it('on an empty table takes the singleton advisory lock inside the transaction, before re-checking and creating', async () => {
      prisma.financeSettings.findFirst.mockResolvedValue(null);
      prisma.financeSettings.create.mockResolvedValue(makeSettings());

      await service.getOrCreate();

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const lock = prisma.$executeRaw.mock.calls[0] as RawCall;
      expect(lock[0].join('?')).toContain(
        'SELECT pg_advisory_xact_lock(hashtext(?))',
      );
      expect(lock.slice(1)).toEqual([FINANCE_SETTINGS_LOCK_NAMESPACE]);

      const locked = prisma.$executeRaw.mock.invocationCallOrder[0];
      expect(locked).toBeGreaterThan(
        prisma.$transaction.mock.invocationCallOrder[0],
      );
      // First findFirst is the fast path (before the lock); the second is
      // the locked re-check; the create comes after both.
      expect(prisma.financeSettings.findFirst).toHaveBeenCalledTimes(2);
      expect(
        prisma.financeSettings.findFirst.mock.invocationCallOrder[0],
      ).toBeLessThan(locked);
      expect(
        prisma.financeSettings.findFirst.mock.invocationCallOrder[1],
      ).toBeGreaterThan(locked);
      expect(
        prisma.financeSettings.create.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        prisma.financeSettings.findFirst.mock.invocationCallOrder[1],
      );
      expect(prisma.financeSettings.create).toHaveBeenCalledTimes(1);
    });

    it('returns the row another request created while we waited for the lock, instead of creating a second one', async () => {
      const racedIn = makeSettings({ id: 'settings-raced' });
      prisma.financeSettings.findFirst
        .mockResolvedValueOnce(null) // fast path: empty
        .mockResolvedValueOnce(racedIn); // locked re-check: someone beat us

      const result = await service.getOrCreate();

      expect(result).toBe(racedIn);
      expect(prisma.financeSettings.create).not.toHaveBeenCalled();
    });
  });

  describe('getLimits', () => {
    it('returns the current limits as plain numbers', async () => {
      prisma.financeSettings.findFirst.mockResolvedValue(makeSettings());

      const limits = await service.getLimits();

      expect(limits).toEqual({
        minDepositAmount: 1000,
        maxDepositAmount: 5000000,
        minWithdrawalAmount: 1000,
        maxWithdrawalAmount: 5000000,
      });
    });
  });

  describe('update', () => {
    it('rejects when minDepositAmount is greater than maxDepositAmount', async () => {
      await expect(
        service.update(
          {
            minDepositAmount: 6000,
            maxDepositAmount: 5000,
            minWithdrawalAmount: 1000,
            maxWithdrawalAmount: 100000,
          },
          admin,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.financeSettings.update).not.toHaveBeenCalled();
    });

    it('rejects when minWithdrawalAmount is greater than maxWithdrawalAmount, independently of the deposit pair', async () => {
      await expect(
        service.update(
          {
            minDepositAmount: 1000,
            maxDepositAmount: 100000,
            minWithdrawalAmount: 60000,
            maxWithdrawalAmount: 50000,
          },
          admin,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.financeSettings.update).not.toHaveBeenCalled();
    });

    it('updates the row and sets updatedByUserId on a valid range', async () => {
      prisma.financeSettings.findFirst.mockResolvedValue(makeSettings());
      prisma.financeSettings.update.mockResolvedValue(
        makeSettings({ updatedByUserId: 'admin-1' }),
      );

      const dto = {
        minDepositAmount: 2000,
        maxDepositAmount: 200000,
        minWithdrawalAmount: 2000,
        maxWithdrawalAmount: 200000,
      };
      const result = await service.update(dto, admin);

      expect(prisma.financeSettings.update).toHaveBeenCalledWith({
        where: { id: 'settings-1' },
        data: { ...dto, updatedByUserId: 'admin-1' },
        include: {
          updatedBy: {
            select: { id: true, username: true, displayName: true },
          },
        },
      });
      expect(result.updatedByUserId).toBe('admin-1');
    });

    // L-38: the audit row is written inside the same transaction as the
    // limits, so a change that cannot be logged is not saved.
    it('writes the row and its audit entry inside one transaction (audit gets the tx)', async () => {
      const current = makeSettings();
      const updated = makeSettings({
        maxDepositAmount: new Prisma.Decimal(200000),
        updatedByUserId: 'admin-1',
      });
      prisma.financeSettings.findFirst.mockResolvedValue(current);
      prisma.financeSettings.update.mockResolvedValue(updated);

      const result = await service.update(
        {
          minDepositAmount: 1000,
          maxDepositAmount: 200000,
          minWithdrawalAmount: 1000,
          maxWithdrawalAmount: 5000000,
        },
        admin,
      );

      expect(result).toBe(updated);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'finance_settings.update',
          actor: admin,
          target: expect.objectContaining({
            type: 'finance_settings',
            id: 'settings-1',
          }),
          tx: prisma,
        }),
      );
      const txStarted = prisma.$transaction.mock.invocationCallOrder[0];
      expect(
        prisma.financeSettings.update.mock.invocationCallOrder[0],
      ).toBeGreaterThan(txStarted);
      expect(audit.record.mock.invocationCallOrder[0]).toBeGreaterThan(
        prisma.financeSettings.update.mock.invocationCallOrder[0],
      );
    });

    it('fails the save when the audit write fails, so the transaction rolls the limits back', async () => {
      prisma.financeSettings.findFirst.mockResolvedValue(makeSettings());
      prisma.financeSettings.update.mockResolvedValue(makeSettings());
      audit.record.mockRejectedValueOnce(new Error('audit table unavailable'));

      await expect(
        service.update(
          {
            minDepositAmount: 1000,
            maxDepositAmount: 200000,
            minWithdrawalAmount: 1000,
            maxWithdrawalAmount: 5000000,
          },
          admin,
        ),
      ).rejects.toThrow('audit table unavailable');
    });

    it('joins the updating staff member with their display name, so "Last updated by" can name them', async () => {
      prisma.financeSettings.findFirst.mockResolvedValue(makeSettings());
      prisma.financeSettings.update.mockResolvedValue(
        makeSettings({
          updatedByUserId: 'admin-1',
          updatedBy: {
            id: 'admin-1',
            username: 'admin.blake',
            displayName: 'Blake',
          },
        }),
      );

      const result = await service.update(
        {
          minDepositAmount: 2000,
          maxDepositAmount: 200000,
          minWithdrawalAmount: 2000,
          maxWithdrawalAmount: 200000,
        },
        admin,
      );

      expect(result.updatedBy).toEqual({
        id: 'admin-1',
        username: 'admin.blake',
        displayName: 'Blake',
      });
    });
  });
});
