import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentAccountsService } from './payment-accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../generated/prisma/client';

describe('PaymentAccountsService', () => {
  let service: PaymentAccountsService;
  let prisma: {
    paymentAccount: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    paymentMethodType: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const adminRow = {
    id: 'acct-1',
    type: 'KBZPay',
    accountName: 'MyanFlix',
    accountNumber: '09123456789',
    bankName: null,
    note: null,
    isActive: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: { id: 'user-1', username: 'superadmin' },
    updatedBy: { id: 'user-1', username: 'superadmin' },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      paymentAccount: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      paymentMethodType: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn((callback: (tx: unknown) => unknown) => callback(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentAccountsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(PaymentAccountsService);
  });

  describe('findAll', () => {
    it('SUPER_ADMIN sees every account (active or not) with full admin fields', async () => {
      prisma.paymentAccount.findMany.mockResolvedValue([adminRow]);

      const result = await service.findAll(Role.SUPER_ADMIN);

      expect(prisma.paymentAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            createdBy: { select: { id: true, username: true } },
            updatedBy: { select: { id: true, username: true } },
          },
        }),
      );
      expect(prisma.paymentAccount.findMany.mock.calls[0][0].where).toBeUndefined();
      expect(result[0]).toEqual(
        expect.objectContaining({ isActive: true, createdBy: adminRow.createdBy }),
      );
    });

    it('regular users only see active accounts, and never audit metadata', async () => {
      prisma.paymentAccount.findMany.mockResolvedValue([
        { id: 'acct-1', type: 'KBZPay', accountName: 'MyanFlix', accountNumber: '09123456789', bankName: null, note: null },
      ]);

      const result = await service.findAll(Role.USER);

      expect(prisma.paymentAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
      expect(result[0]).toEqual({
        id: 'acct-1',
        type: 'KBZPay',
        accountName: 'MyanFlix',
        accountNumber: '09123456789',
        bankName: null,
        note: null,
      });
      expect(result[0]).not.toHaveProperty('isActive');
      expect(result[0]).not.toHaveProperty('createdBy');
    });

    it('ADMIN (not granted PAYMENT_ACCOUNT_MANAGE) is treated as a regular viewer', async () => {
      prisma.paymentAccount.findMany.mockResolvedValue([]);

      await service.findAll(Role.ADMIN);

      expect(prisma.paymentAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });
  });

  describe('getTypes', () => {
    it('returns the catalog with value mirroring label', async () => {
      prisma.paymentMethodType.findMany.mockResolvedValue([
        { id: 't1', label: 'KBZPay', requiresBankName: false },
        { id: 't2', label: 'Bank Account', requiresBankName: true },
      ]);

      const types = await service.getTypes();

      expect(types).toEqual([
        { id: 't1', value: 'KBZPay', label: 'KBZPay', requiresBankName: false },
        { id: 't2', value: 'Bank Account', label: 'Bank Account', requiresBankName: true },
      ]);
    });
  });

  describe('createType', () => {
    it('creates a new method and returns it with a `value` field the client Select relies on', async () => {
      prisma.paymentMethodType.findUnique.mockResolvedValue(null);
      prisma.paymentMethodType.create.mockResolvedValue({ id: 't3', label: 'Wave Pay', requiresBankName: false });

      const result = await service.createType({ label: 'Wave Pay', requiresBankName: false });

      expect(prisma.paymentMethodType.create).toHaveBeenCalledWith({
        data: { label: 'Wave Pay', requiresBankName: false },
      });
      // Regression guard: a raw Prisma row has no `value` field, which
      // silently made the freshly created method unselectable in the
      // admin UI until the next page refresh.
      expect(result).toEqual({ id: 't3', value: 'Wave Pay', label: 'Wave Pay', requiresBankName: false });
    });

    it('rejects a duplicate label', async () => {
      prisma.paymentMethodType.findUnique.mockResolvedValue({ id: 't1', label: 'Wave Pay' });

      await expect(
        service.createType({ label: 'Wave Pay', requiresBankName: false }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.paymentMethodType.create).not.toHaveBeenCalled();
    });

    it('persists and returns the logo URL', async () => {
      prisma.paymentMethodType.findUnique.mockResolvedValue(null);
      prisma.paymentMethodType.create.mockResolvedValue({
        id: 't3',
        label: 'Wave Pay',
        requiresBankName: false,
        logoUrl: 'https://cdn.example.com/wave-pay.png',
      });

      const result = await service.createType({
        label: 'Wave Pay',
        requiresBankName: false,
        logoUrl: 'https://cdn.example.com/wave-pay.png',
      });

      expect(prisma.paymentMethodType.create).toHaveBeenCalledWith({
        data: { label: 'Wave Pay', requiresBankName: false, logoUrl: 'https://cdn.example.com/wave-pay.png' },
      });
      expect(result.logoUrl).toBe('https://cdn.example.com/wave-pay.png');
    });
  });

  describe('updateType', () => {
    it('throws NotFoundException for an unknown method', async () => {
      prisma.paymentMethodType.findUnique.mockResolvedValue(null);

      await expect(
        service.updateType('nope', { requiresBankName: true }),
      ).rejects.toThrow(NotFoundException);
    });

    it('updates requiresBankName without touching existing accounts when the label is unchanged', async () => {
      prisma.paymentMethodType.findUnique.mockResolvedValue({ id: 't1', label: 'Wave Pay', requiresBankName: false });
      prisma.paymentMethodType.update.mockResolvedValue({ id: 't1', label: 'Wave Pay', requiresBankName: true });

      const result = await service.updateType('t1', { requiresBankName: true });

      expect(prisma.paymentAccount.updateMany).not.toHaveBeenCalled();
      expect(prisma.paymentMethodType.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { requiresBankName: true },
      });
      expect(result).toEqual({ id: 't1', value: 'Wave Pay', label: 'Wave Pay', requiresBankName: true });
    });

    it('updates the logo URL without touching the label', async () => {
      prisma.paymentMethodType.findUnique.mockResolvedValue({
        id: 't1',
        label: 'Wave Pay',
        requiresBankName: false,
        logoUrl: null,
      });
      prisma.paymentMethodType.update.mockResolvedValue({
        id: 't1',
        label: 'Wave Pay',
        requiresBankName: false,
        logoUrl: 'https://cdn.example.com/wave-pay.png',
      });

      const result = await service.updateType('t1', { logoUrl: 'https://cdn.example.com/wave-pay.png' });

      expect(prisma.paymentMethodType.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { requiresBankName: undefined, logoUrl: 'https://cdn.example.com/wave-pay.png' },
      });
      expect(result.logoUrl).toBe('https://cdn.example.com/wave-pay.png');
    });

    it('renaming cascades to every account currently on that method', async () => {
      prisma.paymentMethodType.findUnique
        .mockResolvedValueOnce({ id: 't1', label: 'Wave Pay', requiresBankName: false }) // existing lookup
        .mockResolvedValueOnce(null); // clash check for the new label
      prisma.paymentMethodType.update.mockResolvedValue({ id: 't1', label: 'Wave Money', requiresBankName: false });

      const result = await service.updateType('t1', { label: 'Wave Money' });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.paymentAccount.updateMany).toHaveBeenCalledWith({
        where: { type: 'Wave Pay' },
        data: { type: 'Wave Money' },
      });
      expect(prisma.paymentMethodType.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { label: 'Wave Money', requiresBankName: undefined },
      });
      expect(result).toEqual({ id: 't1', value: 'Wave Money', label: 'Wave Money', requiresBankName: false });
    });

    it('rejects renaming into a label another method already uses', async () => {
      prisma.paymentMethodType.findUnique
        .mockResolvedValueOnce({ id: 't1', label: 'Wave Pay', requiresBankName: false })
        .mockResolvedValueOnce({ id: 't2', label: 'AYA Pay' });

      await expect(service.updateType('t1', { label: 'AYA Pay' })).rejects.toThrow(ConflictException);
      expect(prisma.paymentAccount.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('removeType', () => {
    it('throws NotFoundException for an unknown method', async () => {
      prisma.paymentMethodType.findUnique.mockResolvedValue(null);

      await expect(service.removeType('nope')).rejects.toThrow(NotFoundException);
    });

    it('blocks deletion while accounts still use the method', async () => {
      prisma.paymentMethodType.findUnique.mockResolvedValue({ id: 't1', label: 'Wave Pay' });
      prisma.paymentAccount.count.mockResolvedValue(2);

      await expect(service.removeType('t1')).rejects.toThrow(ConflictException);
      expect(prisma.paymentMethodType.delete).not.toHaveBeenCalled();
    });

    it('deletes a method with no accounts using it', async () => {
      prisma.paymentMethodType.findUnique.mockResolvedValue({ id: 't1', label: 'Wave Pay' });
      prisma.paymentAccount.count.mockResolvedValue(0);

      const result = await service.removeType('t1');

      expect(prisma.paymentMethodType.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
      expect(result).toEqual({ deleted: true });
    });
  });

  describe('create', () => {
    it('stamps createdByUserId/updatedByUserId with the acting user', async () => {
      prisma.paymentAccount.create.mockResolvedValue(adminRow);

      await service.create(
        { type: 'KBZPay', accountName: 'MyanFlix', accountNumber: '09123456789' },
        'user-1',
      );

      expect(prisma.paymentAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            createdByUserId: 'user-1',
            updatedByUserId: 'user-1',
          }),
        }),
      );
    });
  });

  describe('update', () => {
    it('throws NotFoundException for an unknown account, without writing anything', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValue(null);

      await expect(
        service.update('nope', { isActive: false }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.paymentAccount.update).not.toHaveBeenCalled();
    });

    it('stamps updatedByUserId on every edit, including a plain activate/deactivate toggle', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValue({ id: 'acct-1' });
      prisma.paymentAccount.update.mockResolvedValue({ ...adminRow, isActive: false });

      const result = await service.update('acct-1', { isActive: false }, 'user-2');

      expect(prisma.paymentAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'acct-1' },
          data: expect.objectContaining({ isActive: false, updatedByUserId: 'user-2' }),
        }),
      );
      expect(result.isActive).toBe(false);
    });
  });

  describe('remove', () => {
    it('throws NotFoundException for an unknown account, without deleting anything', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValue(null);

      await expect(service.remove('nope')).rejects.toThrow(NotFoundException);
      expect(prisma.paymentAccount.delete).not.toHaveBeenCalled();
    });

    it('deletes a known account', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValue({ id: 'acct-1' });
      prisma.paymentAccount.delete.mockResolvedValue(adminRow);

      const result = await service.remove('acct-1');

      expect(prisma.paymentAccount.delete).toHaveBeenCalledWith({ where: { id: 'acct-1' } });
      expect(result).toEqual({ deleted: true });
    });
  });
});
