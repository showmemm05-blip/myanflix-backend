import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '../generated/prisma/client';
import {
  MONEY_RECORD_MODELS,
  findMoneyRecordKinds,
} from './user-money-records';

/** One model's block from schema.prisma, `model X {` to its closing brace. */
function modelBlock(schema: string, model: string): string {
  const start = schema.search(new RegExp(`^model ${model} \\{`, 'm'));
  if (start < 0) throw new Error(`model ${model} not found in schema.prisma`);
  const end = schema.indexOf('\n}', start);
  return schema.slice(start, end);
}

/** The relation line that owns `userId` — the customer the money belongs to. */
function userRelationLine(block: string): string {
  const line = block
    .split('\n')
    .find((l) => /\bUser\b/.test(l) && l.includes('fields: [userId]'));
  if (!line) throw new Error('no User relation on userId');
  return line;
}

describe('user money records (H-22)', () => {
  const schema = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
    'utf8',
  );

  /**
   * Deleting a user row used to CASCADE away their wallet, ledger, deposits,
   * withdrawals, adjustments, subscriptions and purchases. Every one of
   * these foreign keys must now refuse the delete instead.
   */
  it.each(MONEY_RECORD_MODELS)(
    '%s -> users is ON DELETE RESTRICT, never Cascade',
    (model) => {
      const line = userRelationLine(modelBlock(schema, model));
      expect(line).toContain('onDelete: Restrict');
      expect(line).not.toContain('Cascade');
    },
  );

  it('covers exactly the money tables that point at a customer', () => {
    expect([...MONEY_RECORD_MODELS].sort()).toEqual(
      [
        'Deposit',
        'Purchase',
        'SeriesPurchase',
        'Transaction',
        'UserSubscription',
        'Wallet',
        'WalletAdjustment',
        'Withdrawal',
      ].sort(),
    );
  });

  describe('findMoneyRecordKinds', () => {
    function makeTx(overrides: Record<string, unknown> = {}) {
      const none = () => ({ findFirst: jest.fn().mockResolvedValue(null) });
      return {
        wallet: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ balance: new Prisma.Decimal(0) }),
        },
        transaction: none(),
        deposit: none(),
        withdrawal: none(),
        walletAdjustment: none(),
        userSubscription: none(),
        purchase: none(),
        seriesPurchase: none(),
        ...overrides,
      };
    }

    it('an empty wallet and no history: nothing to keep', async () => {
      const tx = makeTx();
      await expect(
        findMoneyRecordKinds(tx as never, 'user-1'),
      ).resolves.toEqual([]);
      expect(tx.deposit.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { id: true },
      });
    });

    it('no wallet row at all (an old staff account): nothing to keep', async () => {
      const tx = makeTx({
        wallet: { findUnique: jest.fn().mockResolvedValue(null) },
      });
      await expect(
        findMoneyRecordKinds(tx as never, 'user-1'),
      ).resolves.toEqual([]);
    });

    it('names every kind that exists — a balance and any money row', async () => {
      const tx = makeTx({
        wallet: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ balance: new Prisma.Decimal('0.50') }),
        },
        withdrawal: { findFirst: jest.fn().mockResolvedValue({ id: 'w-1' }) },
        seriesPurchase: {
          findFirst: jest.fn().mockResolvedValue({ id: 'sp-1' }),
        },
      });
      await expect(
        findMoneyRecordKinds(tx as never, 'user-1'),
      ).resolves.toEqual(['wallet_balance', 'withdrawals', 'series_purchases']);
    });
  });
});
