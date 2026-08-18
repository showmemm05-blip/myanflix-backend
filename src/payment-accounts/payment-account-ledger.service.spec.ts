import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PaymentAccountTransactionType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentAccountLedgerService } from './payment-account-ledger.service';

function makeAccount(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'acct-1',
    balance: new Prisma.Decimal(1000),
    totalIn: new Prisma.Decimal(1000),
    totalOut: new Prisma.Decimal(0),
    ...overrides,
  };
}

describe('PaymentAccountLedgerService', () => {
  let service: PaymentAccountLedgerService;
  let prisma: {
    paymentAccount: { findUnique: jest.Mock; update: jest.Mock };
    paymentAccountTransaction: { create: jest.Mock };
    deposit: { updateMany: jest.Mock };
    withdrawal: { updateMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      paymentAccount: { findUnique: jest.fn(), update: jest.fn() },
      paymentAccountTransaction: { create: jest.fn() },
      deposit: { updateMany: jest.fn() },
      withdrawal: { updateMany: jest.fn() },
      // Every mocked prisma method above lives directly on `prisma`, so — same
      // convention as deposits/withdrawals specs — the tx client passed into
      // the callback is just `prisma` itself.
      $transaction: jest.fn((callback: (tx: unknown) => unknown) => callback(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentAccountLedgerService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(PaymentAccountLedgerService);
  });

  describe('recordManualEntry (via applyMovement)', () => {
    it('throws NotFoundException for an unknown account, without writing a ledger row', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValue(null);

      await expect(
        service.recordManualEntry(
          'nope',
          { type: PaymentAccountTransactionType.MANUAL_CREDIT, amount: 500 },
          'admin-1',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.paymentAccountTransaction.create).not.toHaveBeenCalled();
    });

    it('credits: increments balance and totalIn, derives balanceBefore/After correctly', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValue(makeAccount());
      prisma.paymentAccount.update.mockResolvedValue(
        makeAccount({ balance: new Prisma.Decimal(1500), totalIn: new Prisma.Decimal(1500) }),
      );
      prisma.paymentAccountTransaction.create.mockImplementation(({ data }) => data);

      const { entry } = await service.recordManualEntry(
        'acct-1',
        { type: PaymentAccountTransactionType.MANUAL_CREDIT, amount: 500, note: 'top-up' },
        'admin-1',
      );

      expect(prisma.paymentAccount.update).toHaveBeenCalledWith({
        where: { id: 'acct-1' },
        data: {
          balance: { increment: expect.any(Prisma.Decimal) },
          totalIn: { increment: expect.any(Prisma.Decimal) },
        },
      });
      expect((entry.balanceBefore as Prisma.Decimal).toNumber()).toBe(1000);
      expect((entry.balanceAfter as Prisma.Decimal).toNumber()).toBe(1500);
      expect(entry.type).toBe(PaymentAccountTransactionType.MANUAL_CREDIT);
      expect(entry.performedByUserId).toBe('admin-1');
      expect(entry.note).toBe('top-up');
    });

    it('debits: increments totalOut, never guards against going negative (internal ledger, not a user-facing spend limit)', async () => {
      prisma.paymentAccount.findUnique.mockResolvedValue(makeAccount({ balance: new Prisma.Decimal(100) }));
      prisma.paymentAccount.update.mockResolvedValue(
        makeAccount({ balance: new Prisma.Decimal(-400), totalOut: new Prisma.Decimal(500) }),
      );
      prisma.paymentAccountTransaction.create.mockImplementation(({ data }) => data);

      const { entry } = await service.recordManualEntry(
        'acct-1',
        { type: PaymentAccountTransactionType.MANUAL_DEBIT, amount: 500 },
        'admin-1',
      );

      expect(prisma.paymentAccount.update).toHaveBeenCalledWith({
        where: { id: 'acct-1' },
        data: {
          balance: { increment: expect.any(Prisma.Decimal) },
          totalOut: { increment: expect.any(Prisma.Decimal) },
        },
      });
      expect((entry.balanceAfter as Prisma.Decimal).toNumber()).toBe(-400);
      // The balance increment passed to Prisma is negative for a debit.
      const call = prisma.paymentAccount.update.mock.calls[0][0];
      expect((call.data.balance.increment as Prisma.Decimal).toNumber()).toBe(-500);
    });
  });

  describe('syncDepositLink', () => {
    const deposit = { id: 'dep-1', amount: new Prisma.Decimal(2000), receivingPaymentAccountId: null };

    it('no-ops when the payment account is unchanged', async () => {
      await service.syncDepositLink(prisma as never, deposit, null, null, 'admin-1');

      expect(prisma.deposit.updateMany).not.toHaveBeenCalled();
      expect(prisma.paymentAccount.update).not.toHaveBeenCalled();
    });

    it('links a fresh account: claims the FK and posts a DEPOSIT_IN entry, no reversal (nothing to reverse)', async () => {
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.paymentAccount.update.mockResolvedValue(makeAccount({ balance: new Prisma.Decimal(3000) }));
      prisma.paymentAccountTransaction.create.mockImplementation(({ data }) => data);

      await service.syncDepositLink(prisma as never, deposit, 'acct-1', 'REF001', 'admin-1');

      expect(prisma.deposit.updateMany).toHaveBeenCalledWith({
        where: { id: 'dep-1', receivingPaymentAccountId: null },
        data: { receivingPaymentAccountId: 'acct-1' },
      });
      expect(prisma.paymentAccount.update).toHaveBeenCalledTimes(1);
      expect(prisma.paymentAccountTransaction.create).toHaveBeenCalledTimes(1);
      const created = prisma.paymentAccountTransaction.create.mock.calls[0][0].data;
      expect(created.type).toBe(PaymentAccountTransactionType.DEPOSIT_IN);
      expect(created.relatedDepositId).toBe('dep-1');
      expect(created.referenceCode).toBe('REF001');
    });

    it('re-linking: reverses the old account (ADJUSTMENT_DEBIT) then posts DEPOSIT_IN on the new one', async () => {
      const linked = { ...deposit, receivingPaymentAccountId: 'acct-old' };
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.paymentAccount.update.mockResolvedValue(makeAccount());
      prisma.paymentAccountTransaction.create.mockImplementation(({ data }) => data);

      await service.syncDepositLink(prisma as never, linked, 'acct-new', 'REF002', 'admin-1');

      expect(prisma.paymentAccount.update).toHaveBeenCalledTimes(2);
      expect(prisma.paymentAccount.update.mock.calls[0][0].where).toEqual({ id: 'acct-old' });
      expect(prisma.paymentAccount.update.mock.calls[1][0].where).toEqual({ id: 'acct-new' });
      const [reversalCall, forwardCall] = prisma.paymentAccountTransaction.create.mock.calls;
      expect(reversalCall[0].data.type).toBe(PaymentAccountTransactionType.ADJUSTMENT_DEBIT);
      expect(forwardCall[0].data.type).toBe(PaymentAccountTransactionType.DEPOSIT_IN);
    });

    it('clearing the link (new id null): only reverses, posts no new entry', async () => {
      const linked = { ...deposit, receivingPaymentAccountId: 'acct-old' };
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.paymentAccount.update.mockResolvedValue(makeAccount());
      prisma.paymentAccountTransaction.create.mockImplementation(({ data }) => data);

      await service.syncDepositLink(prisma as never, linked, null, null, 'admin-1');

      expect(prisma.paymentAccount.update).toHaveBeenCalledTimes(1);
      expect(prisma.paymentAccountTransaction.create).toHaveBeenCalledTimes(1);
      expect(prisma.paymentAccountTransaction.create.mock.calls[0][0].data.type).toBe(
        PaymentAccountTransactionType.ADJUSTMENT_DEBIT,
      );
    });

    it('links a hidden (isActive: false) account exactly like an active one — hidden means hidden from users, not unreceivable', async () => {
      prisma.deposit.updateMany.mockResolvedValue({ count: 1 });
      prisma.paymentAccount.update.mockResolvedValue(
        makeAccount({ id: 'acct-hidden', isActive: false, balance: new Prisma.Decimal(3000) }),
      );
      prisma.paymentAccountTransaction.create.mockImplementation(({ data }) => data);

      await expect(
        service.syncDepositLink(prisma as never, deposit, 'acct-hidden', 'REF003', 'admin-1'),
      ).resolves.toBeUndefined();

      expect(prisma.deposit.updateMany).toHaveBeenCalledWith({
        where: { id: 'dep-1', receivingPaymentAccountId: null },
        data: { receivingPaymentAccountId: 'acct-hidden' },
      });
      const created = prisma.paymentAccountTransaction.create.mock.calls[0][0].data;
      expect(created.type).toBe(PaymentAccountTransactionType.DEPOSIT_IN);
      expect(created.relatedDepositId).toBe('dep-1');
      expect(created.referenceCode).toBe('REF003');
    });

    it('throws ConflictException when the claim fails (concurrent change to receivingPaymentAccountId)', async () => {
      prisma.deposit.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.syncDepositLink(prisma as never, deposit, 'acct-1', null, 'admin-1'),
      ).rejects.toThrow(ConflictException);
      expect(prisma.paymentAccount.update).not.toHaveBeenCalled();
    });
  });

  describe('syncWithdrawalLink', () => {
    const withdrawal = { id: 'wd-1', amount: new Prisma.Decimal(1500), transferPaymentAccountId: null };

    it('no-ops when the payment account is unchanged', async () => {
      await service.syncWithdrawalLink(prisma as never, withdrawal, null, null, 'admin-1');

      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
      expect(prisma.paymentAccount.update).not.toHaveBeenCalled();
    });

    it('links a fresh account: claims the FK and posts a WITHDRAWAL_OUT entry', async () => {
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
      prisma.paymentAccount.update.mockResolvedValue(makeAccount());
      prisma.paymentAccountTransaction.create.mockImplementation(({ data }) => data);

      await service.syncWithdrawalLink(prisma as never, withdrawal, 'acct-1', 'REF010', 'admin-1');

      expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
        where: { id: 'wd-1', transferPaymentAccountId: null },
        data: { transferPaymentAccountId: 'acct-1' },
      });
      const created = prisma.paymentAccountTransaction.create.mock.calls[0][0].data;
      expect(created.type).toBe(PaymentAccountTransactionType.WITHDRAWAL_OUT);
      expect(created.relatedWithdrawalId).toBe('wd-1');
    });

    it('re-linking: reverses the old account with ADJUSTMENT_CREDIT (opposite direction from deposits\' ADJUSTMENT_DEBIT)', async () => {
      const linked = { ...withdrawal, transferPaymentAccountId: 'acct-old' };
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
      prisma.paymentAccount.update.mockResolvedValue(makeAccount());
      prisma.paymentAccountTransaction.create.mockImplementation(({ data }) => data);

      await service.syncWithdrawalLink(prisma as never, linked, 'acct-new', 'REF011', 'admin-1');

      const [reversalCall, forwardCall] = prisma.paymentAccountTransaction.create.mock.calls;
      expect(reversalCall[0].data.type).toBe(PaymentAccountTransactionType.ADJUSTMENT_CREDIT);
      expect(forwardCall[0].data.type).toBe(PaymentAccountTransactionType.WITHDRAWAL_OUT);
    });

    it('throws ConflictException when the claim fails', async () => {
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.syncWithdrawalLink(prisma as never, withdrawal, 'acct-1', null, 'admin-1'),
      ).rejects.toThrow(ConflictException);
      expect(prisma.paymentAccount.update).not.toHaveBeenCalled();
    });
  });
});
