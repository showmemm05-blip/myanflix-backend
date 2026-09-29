import { Prisma } from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import { UNCLAIMED_AFTER_MS } from '../bank-events/risk-rules';
import {
  bankTransactionPayload,
  directionOf,
  eventDirectionOf,
  eventFromTransaction,
  findOpenReceivedTransactions,
  linkToDeposit,
  linkToWithdrawal,
  markAmbiguous,
  markUnmatched,
  storeTransaction,
  transactionView,
  unlinkByDeposit,
  unlinkByWithdrawal,
  type StoredBankTransaction,
} from './bank-transaction-store';

/**
 * The bank_transactions helpers against a hand-rolled Prisma transaction
 * mock (same style as deposit-matcher.spec.ts): every guard, the literal
 * open-set predicate, and the read-time view derivation.
 */

const KEY = 'c'.repeat(64);
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-22T12:00:00.000Z');
const HOUR = 3_600_000;

function stored(
  overrides: Partial<StoredBankTransaction> = {},
): StoredBankTransaction {
  return {
    id: 'tx-1',
    idempotencyKey: KEY,
    deviceSerial: 'PIXEL10',
    paymentAccountId: ACCOUNT,
    direction: 'RECEIVED',
    amount: new Prisma.Decimal(50000),
    txCode: 'KBZ20260922AB12CD',
    txCodeLast6: 'AB12CD',
    occurredAt: new Date(NOW.getTime() - HOUR),
    screenshotKey: null,
    state: 'UNMATCHED',
    ...overrides,
  };
}

function fullRow(overrides: Record<string, unknown> = {}) {
  return {
    ...stored(),
    currency: 'MMK',
    postedAt: new Date(NOW.getTime() - HOUR + 5000),
    counterparty: 'Ko Ko',
    detailStatus: 'ok',
    linkedDepositId: null,
    linkedWithdrawalId: null,
    matchedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('bank-transaction-store', () => {
  let tx: {
    $queryRaw: jest.Mock;
    bankTransaction: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let audit: { record: jest.Mock };
  const actor = { id: 'admin-1', username: 'admin', role: 'ADMIN' } as never;

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      bankTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(fullRow()),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
  });
  const a = () => audit as unknown as AuditService;

  it('maps the wire direction to the column and back', () => {
    expect(directionOf('received')).toBe('RECEIVED');
    expect(directionOf('sent')).toBe('SENT');
    expect(eventDirectionOf('RECEIVED')).toBe('received');
    expect(eventDirectionOf('SENT')).toBe('sent');
    expect(eventFromTransaction(stored({ direction: 'SENT' }))).toEqual({
      idempotencyKey: KEY,
      deviceSerial: 'PIXEL10',
      paymentAccountId: ACCOUNT,
      direction: 'sent',
      amount: new Prisma.Decimal(50000),
      txCode: 'KBZ20260922AB12CD',
      txCodeLast6: 'AB12CD',
      occurredAt: new Date(NOW.getTime() - HOUR),
    });
  });

  describe('storeTransaction (Q-BT0)', () => {
    const input = {
      ...eventFromTransaction(stored()),
      currency: 'MMK',
      postedAt: null,
      counterparty: null,
      detailStatus: null,
    };

    it('reads by the unique key first and returns an existing row untouched', async () => {
      tx.bankTransaction.findUnique.mockResolvedValue(
        fullRow({ state: 'MATCHED' }),
      );
      const { row, created } = await storeTransaction(tx as never, a(), input);
      expect(created).toBe(false);
      expect(row.state).toBe('MATCHED');
      expect(tx.bankTransaction.findUnique).toHaveBeenCalledWith({
        where: { idempotencyKey: KEY },
      });
      expect(tx.bankTransaction.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('inserts an unseen key (postedAt defaulting to the bank time) and audits it as a system row inside the transaction', async () => {
      const { created } = await storeTransaction(tx as never, a(), input);
      expect(created).toBe(true);
      expect(tx.bankTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          idempotencyKey: KEY,
          direction: 'RECEIVED',
          postedAt: input.occurredAt,
          counterparty: null,
        }),
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_transaction.store',
          actor: null,
          target: {
            type: 'bank_transaction',
            id: 'tx-1',
            label: 'received · PIXEL10',
          },
          after: expect.objectContaining({
            idempotencyKey: KEY,
            hasScreenshot: false,
          }),
          tx,
        }),
      );
    });
  });

  describe('findOpenReceivedTransactions (Q-BT1)', () => {
    it('spells the partial-index predicate as literal SQL, binds only account + last-6, LIMIT 2', async () => {
      tx.$queryRaw.mockResolvedValue([
        {
          id: 'tx-1',
          idempotencyKey: KEY,
          deviceSerial: 'PIXEL10',
          paymentAccountId: ACCOUNT,
          amount: '50000.00',
          txCode: 'KBZ20260922AB12CD',
          txCodeLast6: 'AB12CD',
          occurredAt: '2026-09-22T11:00:00.000Z',
          screenshotKey: null,
        },
      ]);
      const rows = await findOpenReceivedTransactions(
        tx as never,
        ACCOUNT,
        'AB12CD',
      );
      const q = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      const text = q.strings.join('?');
      expect(text).toContain('FROM bank_transactions');
      expect(text).toContain(`state = 'UNMATCHED'::"BankTransactionState"`);
      expect(text).toContain(
        `direction = 'RECEIVED'::"BankTransactionDirection"`,
      );
      expect(text).toContain('LIMIT 2');
      expect(q.values).toEqual([ACCOUNT, 'AB12CD']);
      // Raw shapes coerced: money is a Decimal, time a Date, state known.
      expect(rows[0].amount).toBeInstanceOf(Prisma.Decimal);
      expect(rows[0].occurredAt).toBeInstanceOf(Date);
      expect(rows[0]).toMatchObject({
        direction: 'RECEIVED',
        state: 'UNMATCHED',
        screenshotKey: null,
      });
    });
  });

  describe('link / state guards (Q-BT2, Q-BT2b)', () => {
    it('linkToDeposit writes MATCHED + the link by PK, guarded on not-yet-MATCHED, and audits with the trigger', async () => {
      await linkToDeposit(
        tx as never,
        a(),
        stored({ state: 'AMBIGUOUS' }),
        'dep-1',
        NOW,
        'deposit_create',
      );
      expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: 'tx-1', state: { in: ['UNMATCHED', 'AMBIGUOUS'] } },
        data: { state: 'MATCHED', linkedDepositId: 'dep-1', matchedAt: NOW },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_transaction.link',
          actor: null,
          before: { state: 'AMBIGUOUS', linkedDepositId: null },
          after: { state: 'MATCHED', linkedDepositId: 'dep-1' },
          metadata: expect.objectContaining({
            trigger: 'deposit_create',
            depositId: 'dep-1',
          }),
          tx,
        }),
      );
    });

    it('linkToDeposit / linkToWithdrawal THROW on a lost race so the caller’s transaction rolls back', async () => {
      tx.bankTransaction.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        linkToDeposit(tx as never, a(), stored(), 'dep-1', NOW, 'ingestion'),
      ).rejects.toThrow('BANK_TRANSACTION_CLAIMED_CONCURRENTLY');
      await expect(
        linkToWithdrawal(tx as never, a(), stored(), 'wd-1', NOW, 'ingestion'),
      ).rejects.toThrow('BANK_TRANSACTION_CLAIMED_CONCURRENTLY');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('linkToWithdrawal mirrors on linkedWithdrawalId', async () => {
      await linkToWithdrawal(
        tx as never,
        a(),
        stored({ direction: 'SENT' }),
        'wd-1',
        NOW,
        'ingestion',
      );
      expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            state: 'MATCHED',
            linkedWithdrawalId: 'wd-1',
            matchedAt: NOW,
          },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            withdrawalId: 'wd-1',
            direction: 'sent',
          }),
        }),
      );
    });

    it('markAmbiguous is guarded on UNMATCHED: a re-post costs no write and no audit row', async () => {
      expect(
        await markAmbiguous(tx as never, a(), stored(), ['dep-1', 'dep-2']),
      ).toBe(true);
      expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: 'tx-1', state: 'UNMATCHED' },
        data: { state: 'AMBIGUOUS' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_transaction.state_change',
          before: { state: 'UNMATCHED' },
          after: { state: 'AMBIGUOUS' },
          metadata: expect.objectContaining({
            reason: 'MULTIPLE_CANDIDATES',
            candidateIds: ['dep-1', 'dep-2'],
          }),
        }),
      );

      audit.record.mockClear();
      tx.bankTransaction.updateMany.mockResolvedValue({ count: 0 });
      expect(
        await markAmbiguous(tx as never, a(), stored({ state: 'AMBIGUOUS' }), [
          'dep-1',
        ]),
      ).toBe(false);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('markUnmatched is guarded on AMBIGUOUS', async () => {
      expect(
        await markUnmatched(tx as never, a(), stored({ state: 'AMBIGUOUS' })),
      ).toBe(true);
      expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: 'tx-1', state: 'AMBIGUOUS' },
        data: { state: 'UNMATCHED' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_transaction.state_change',
          before: { state: 'AMBIGUOUS' },
          after: { state: 'UNMATCHED' },
        }),
      );
    });
  });

  describe('unlink (Q-BT3)', () => {
    it('unlinkByDeposit finds the row by the unique link column, releases it, audits the admin, and returns the id', async () => {
      tx.bankTransaction.findUnique.mockResolvedValue({
        id: 'tx-1',
        state: 'MATCHED',
      });
      expect(await unlinkByDeposit(tx as never, a(), actor, 'dep-1')).toBe(
        'tx-1',
      );
      expect(tx.bankTransaction.findUnique).toHaveBeenCalledWith({
        where: { linkedDepositId: 'dep-1' },
        select: { id: true, state: true },
      });
      expect(tx.bankTransaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-1' },
        data: { state: 'UNMATCHED', linkedDepositId: null, matchedAt: null },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'bank_transaction.unlink',
          actor,
          before: { state: 'MATCHED', linkedDepositId: 'dep-1' },
          after: { state: 'UNMATCHED', linkedDepositId: null },
          metadata: { depositId: 'dep-1' },
          tx,
        }),
      );
    });

    it('returns null and writes nothing for a deposit no transaction claimed (matched before this table existed)', async () => {
      expect(await unlinkByDeposit(tx as never, a(), actor, 'dep-1')).toBe(
        null,
      );
      expect(tx.bankTransaction.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('unlinkByWithdrawal mirrors on linkedWithdrawalId', async () => {
      tx.bankTransaction.findUnique.mockResolvedValue({
        id: 'tx-9',
        state: 'MATCHED',
      });
      expect(await unlinkByWithdrawal(tx as never, a(), actor, 'wd-1')).toBe(
        'tx-9',
      );
      expect(tx.bankTransaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-9' },
        data: {
          state: 'UNMATCHED',
          linkedWithdrawalId: null,
          matchedAt: null,
        },
      });
    });
  });

  describe('transactionView — read-time only', () => {
    const base = { linkedDepositId: null, linkedWithdrawalId: null };

    it('UNMATCHED is WAITING inside 48 h of the BANK time and UNCLAIMED after — nothing stored', () => {
      expect(
        transactionView(
          {
            ...base,
            state: 'UNMATCHED',
            occurredAt: new Date(NOW.getTime() - UNCLAIMED_AFTER_MS + 1000),
          },
          NOW,
        ),
      ).toBe('WAITING');
      expect(
        transactionView(
          {
            ...base,
            state: 'UNMATCHED',
            occurredAt: new Date(NOW.getTime() - UNCLAIMED_AFTER_MS - 1000),
          },
          NOW,
        ),
      ).toBe('UNCLAIMED');
    });

    it('AMBIGUOUS is AMBIGUOUS regardless of age; MATCHED with a link is MATCHED', () => {
      const old = new Date(NOW.getTime() - 10 * UNCLAIMED_AFTER_MS);
      expect(
        transactionView({ ...base, state: 'AMBIGUOUS', occurredAt: old }, NOW),
      ).toBe('AMBIGUOUS');
      expect(
        transactionView(
          { ...base, state: 'MATCHED', occurredAt: old, linkedDepositId: 'd' },
          NOW,
        ),
      ).toBe('MATCHED');
      expect(
        transactionView(
          {
            ...base,
            state: 'MATCHED',
            occurredAt: old,
            linkedWithdrawalId: 'w',
          },
          NOW,
        ),
      ).toBe('MATCHED');
    });

    it('MATCHED with both links null (its deposit was hard-deleted, FK SET NULL) reads as WAITING, never as a match nothing backs', () => {
      expect(
        transactionView({ ...base, state: 'MATCHED', occurredAt: NOW }, NOW),
      ).toBe('WAITING');
    });

    it('bankTransactionPayload carries the view, numbers for money, hasScreenshot — never the key', () => {
      const payload = bankTransactionPayload(
        fullRow({
          screenshotKey: 'documents/bank-screenshots/transactions/tx-1/x.png',
        }) as never,
        NOW,
      );
      expect(payload).toEqual({
        id: 'tx-1',
        deviceSerial: 'PIXEL10',
        paymentAccountId: ACCOUNT,
        direction: 'RECEIVED',
        amount: 50000,
        currency: 'MMK',
        txCode: 'KBZ20260922AB12CD',
        txCodeLast6: 'AB12CD',
        occurredAt: new Date(NOW.getTime() - HOUR),
        postedAt: new Date(NOW.getTime() - HOUR + 5000),
        counterparty: 'Ko Ko',
        detailStatus: 'ok',
        state: 'UNMATCHED',
        view: 'WAITING',
        linkedDepositId: null,
        linkedWithdrawalId: null,
        matchedAt: null,
        hasScreenshot: true,
        createdAt: NOW,
      });
      expect(payload).not.toHaveProperty('screenshotKey');
    });
  });
});
