import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentAccountsService } from './payment-accounts.service';
import { PaymentAccountLedgerService } from './payment-account-ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { Prisma, Role } from '../generated/prisma/client';
import type { CreateManualPaymentAccountTransactionDto } from './dto/create-manual-payment-account-transaction.dto';

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
    paymentAccountTransaction: {
      count: jest.Mock;
      findMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let paymentAccountLedgerService: { recordManualEntry: jest.Mock };
  let realtimeGateway: { notifyAdminsPaymentAccountUpdated: jest.Mock };

  const adminRow = {
    id: 'acct-1',
    type: 'KBZPay',
    subname: 'Main Account',
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
      paymentAccountTransaction: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
      // Both call styles are in use: the callback form for the write paths, and
      // the array form for queryTransactions' findMany+count pair.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    paymentAccountLedgerService = { recordManualEntry: jest.fn() };
    realtimeGateway = { notifyAdminsPaymentAccountUpdated: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentAccountsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentAccountLedgerService, useValue: paymentAccountLedgerService },
        { provide: RealtimeGateway, useValue: realtimeGateway },
        {
          provide: MinioService,
          useValue: {
            playbackUrl: jest.fn((key: string) => `http://cache.test:8080/movies/${key}`),
            // Mirrors the real imageUrl(): re-hosts a URL under our bucket,
            // passes anything external through untouched.
            imageUrl: jest.fn((url: string | null | undefined) => {
              if (!url) return url ?? null;
              const match = /\/movies\/(.+)$/.exec(url);
              return match ? `http://cache.test:8080/movies/${match[1]}` : url;
            }),
          },
        },
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
        expect.objectContaining({ isActive: true, createdBy: adminRow.createdBy, subname: 'Main Account' }),
      );
    });

    it('regular users only see active accounts, and never audit metadata or the internal subname label', async () => {
      prisma.paymentAccount.findMany.mockResolvedValue([
        { id: 'acct-1', type: 'KBZPay', subname: 'Main Account', accountName: 'MyanFlix', accountNumber: '09123456789', bankName: null, note: null },
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
      expect(result[0]).not.toHaveProperty('subname');
    });

    it('ADMIN gets the admin shape (incl. subname) via WITHDRAWAL_MANAGE, despite lacking PAYMENT_ACCOUNT_MANAGE — needed to record which of our accounts sent a payout', async () => {
      prisma.paymentAccount.findMany.mockResolvedValue([adminRow]);

      const result = await service.findAll(Role.ADMIN);

      expect(prisma.paymentAccount.findMany.mock.calls[0][0].where).toBeUndefined();
      expect(result[0]).toEqual(expect.objectContaining({ subname: 'Main Account' }));
    });

    it('CONTENT_UPLOADER (neither PAYMENT_ACCOUNT_MANAGE nor WITHDRAWAL_MANAGE) is treated as a regular viewer', async () => {
      prisma.paymentAccount.findMany.mockResolvedValue([]);

      await service.findAll(Role.CONTENT_UPLOADER);

      expect(prisma.paymentAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });
  });

  describe('getTypes', () => {
    it('returns the catalog with value mirroring label', async () => {
      prisma.paymentMethodType.findMany.mockResolvedValue([
        { id: 't1', label: 'KBZPay', requiresBankName: false, logoUrl: null },
        { id: 't2', label: 'Bank Account', requiresBankName: true, logoUrl: null },
      ]);

      const types = await service.getTypes();

      expect(types).toEqual([
        { id: 't1', value: 'KBZPay', label: 'KBZPay', requiresBankName: false, logoUrl: null },
        { id: 't2', value: 'Bank Account', label: 'Bank Account', requiresBankName: true, logoUrl: null },
      ]);
    });
  });

  describe('createType', () => {
    it('creates a new method and returns it with a `value` field the client Select relies on', async () => {
      prisma.paymentMethodType.findUnique.mockResolvedValue(null);
      prisma.paymentMethodType.create.mockResolvedValue({ id: 't3', label: 'Wave Pay', requiresBankName: false, logoUrl: null });

      const result = await service.createType({ label: 'Wave Pay', requiresBankName: false });

      expect(prisma.paymentMethodType.create).toHaveBeenCalledWith({
        data: { label: 'Wave Pay', requiresBankName: false },
      });
      // Regression guard: a raw Prisma row has no `value` field, which
      // silently made the freshly created method unselectable in the
      // admin UI until the next page refresh.
      expect(result).toEqual({ id: 't3', value: 'Wave Pay', label: 'Wave Pay', requiresBankName: false, logoUrl: null });
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
      prisma.paymentMethodType.update.mockResolvedValue({ id: 't1', label: 'Wave Pay', requiresBankName: true, logoUrl: null });

      const result = await service.updateType('t1', { requiresBankName: true });

      expect(prisma.paymentAccount.updateMany).not.toHaveBeenCalled();
      expect(prisma.paymentMethodType.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { requiresBankName: true },
      });
      expect(result).toEqual({ id: 't1', value: 'Wave Pay', label: 'Wave Pay', requiresBankName: true, logoUrl: null });
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
      expect(result).toEqual({ id: 't1', value: 'Wave Money', label: 'Wave Money', requiresBankName: false, logoUrl: null });
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

    it('passes subname through to Prisma and back out in the response', async () => {
      prisma.paymentAccount.create.mockResolvedValue(adminRow);

      const result = await service.create(
        { type: 'KBZPay', subname: 'Backup Account', accountName: 'MyanFlix', accountNumber: '09123456789' },
        'user-1',
      );

      expect(prisma.paymentAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ subname: 'Backup Account' }),
        }),
      );
      expect(result.subname).toBe(adminRow.subname);
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

    it('deletes a known account with no transaction history', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValue({ id: 'acct-1' });
      prisma.paymentAccountTransaction.count.mockResolvedValue(0);
      prisma.paymentAccount.delete.mockResolvedValue(adminRow);

      const result = await service.remove('acct-1');

      expect(prisma.paymentAccountTransaction.count).toHaveBeenCalledWith({
        where: { paymentAccountId: 'acct-1' },
      });
      expect(prisma.paymentAccount.delete).toHaveBeenCalledWith({ where: { id: 'acct-1' } });
      expect(result).toEqual({ deleted: true });
    });

    it('blocks deletion (and never deletes) when the account has ledger history, mirroring removeType()\'s in-use guard', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValue({ id: 'acct-1' });
      prisma.paymentAccountTransaction.count.mockResolvedValue(3);

      await expect(service.remove('acct-1')).rejects.toThrow(ConflictException);
      expect(prisma.paymentAccount.delete).not.toHaveBeenCalled();
    });
  });

  describe('getAllTransactions', () => {
    it('joins the related deposit (with its user) so the details panel needs no second request', async () => {
      const depositCreatedAt = new Date('2026-08-01T10:00:00Z');
      prisma.paymentAccountTransaction.findMany.mockResolvedValue([
        {
          id: 'entry-1',
          paymentAccountId: 'acct-1',
          type: 'DEPOSIT_IN',
          amount: new Prisma.Decimal(5000),
          balanceBefore: new Prisma.Decimal(1000),
          balanceAfter: new Prisma.Decimal(6000),
          referenceCode: 'AB12CD',
          note: null,
          relatedDepositId: 'dep-1',
          relatedWithdrawalId: null,
          performedByUserId: 'admin-1',
          createdAt: new Date('2026-08-01T12:00:00Z'),
          paymentAccount: { id: 'acct-1', type: 'KBZPay', subname: 'K1', accountName: 'MyanFlix' },
          performedBy: { id: 'admin-1', username: 'superadmin' },
          relatedDeposit: {
            id: 'dep-1',
            userId: 'user-1',
            amount: new Prisma.Decimal(5000),
            paymentMethod: 'KBZ Pay',
            reference: '000123',
            status: 'APPROVED',
            createdAt: depositCreatedAt,
            user: { id: 'user-1', username: 'john', phone: '0912345678', avatar: null },
            approvedBy: { id: 'admin-1', username: 'superadmin' },
          },
          relatedWithdrawal: null,
        },
      ]);
      prisma.paymentAccountTransaction.count.mockResolvedValue(1);

      const result = await service.getAllTransactions({});

      // The join itself — without these the panel would have to hit the
      // deposits endpoint separately just to name the customer.
      expect(prisma.paymentAccountTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            relatedDeposit: expect.anything(),
            relatedWithdrawal: expect.anything(),
          }),
        }),
      );

      const entry = result.items[0];
      expect(entry.amount).toBe(5000);
      expect(entry.balanceBefore).toBe(1000);
      expect(entry.balanceAfter).toBe(6000);
      // Nested Decimals serialize as strings unless converted — a money field
      // arriving as "5000" would quietly break every downstream format call.
      expect(entry.relatedDeposit?.amount).toBe(5000);
      expect(entry.relatedDeposit?.user.username).toBe('john');
      expect(entry.relatedDeposit?.reference).toBe('000123');
      expect(entry.relatedWithdrawal).toBeNull();
      expect(result.total).toBe(1);
    });

    it('leaves both related records null for a manual entry, which has neither', async () => {
      prisma.paymentAccountTransaction.findMany.mockResolvedValue([
        {
          id: 'entry-2',
          paymentAccountId: 'acct-1',
          type: 'MANUAL_CREDIT',
          amount: new Prisma.Decimal(2000),
          balanceBefore: new Prisma.Decimal(0),
          balanceAfter: new Prisma.Decimal(2000),
          referenceCode: null,
          note: 'Cash top-up',
          relatedDepositId: null,
          relatedWithdrawalId: null,
          performedByUserId: 'admin-1',
          createdAt: new Date('2026-08-02T09:00:00Z'),
          paymentAccount: { id: 'acct-1', type: 'KBZPay', subname: 'K1', accountName: 'MyanFlix' },
          performedBy: { id: 'admin-1', username: 'superadmin' },
          relatedDeposit: null,
          relatedWithdrawal: null,
        },
      ]);
      prisma.paymentAccountTransaction.count.mockResolvedValue(1);

      const result = await service.getAllTransactions({});

      expect(result.items[0].relatedDeposit).toBeNull();
      expect(result.items[0].relatedWithdrawal).toBeNull();
      expect(result.items[0].note).toBe('Cash top-up');
    });
  });

  describe('recordTransaction', () => {
    it('notifies admins after the ledger entry is committed', async () => {
      paymentAccountLedgerService.recordManualEntry.mockResolvedValue({
        account: {
          ...adminRow,
          balance: new Prisma.Decimal(1000),
          totalIn: new Prisma.Decimal(1000),
          totalOut: new Prisma.Decimal(0),
        },
        entry: {
          id: 'entry-1',
          paymentAccountId: 'acct-1',
          type: 'MANUAL_CREDIT',
          amount: new Prisma.Decimal(1000),
          balanceBefore: new Prisma.Decimal(0),
          balanceAfter: new Prisma.Decimal(1000),
          referenceCode: null,
          note: null,
          relatedDepositId: null,
          relatedWithdrawalId: null,
          performedByUserId: 'user-1',
          createdAt: new Date('2026-01-01'),
        },
      });

      await service.recordTransaction(
        'acct-1',
        { type: 'MANUAL_CREDIT', amount: 1000 } as CreateManualPaymentAccountTransactionDto,
        'user-1',
      );

      expect(paymentAccountLedgerService.recordManualEntry).toHaveBeenCalled();
      expect(realtimeGateway.notifyAdminsPaymentAccountUpdated).toHaveBeenCalledWith({
        paymentAccountId: 'acct-1',
      });
    });
  });
});
