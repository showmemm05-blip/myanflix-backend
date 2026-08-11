import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceSettingsService } from './finance-settings.service';

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
  };

  beforeEach(async () => {
    prisma = {
      financeSettings: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinanceSettingsService,
        { provide: PrismaService, useValue: prisma },
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
          'admin-1',
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
          'admin-1',
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
      const result = await service.update(dto, 'admin-1');

      expect(prisma.financeSettings.update).toHaveBeenCalledWith({
        where: { id: 'settings-1' },
        data: { ...dto, updatedByUserId: 'admin-1' },
        include: { updatedBy: { select: { id: true, username: true } } },
      });
      expect(result.updatedByUserId).toBe('admin-1');
    });
  });
});
