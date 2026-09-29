import {
  BankMatchStatus,
  BankRiskLevel,
  Prisma,
} from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { StoredBankTransaction } from '../bank-transactions/bank-transaction-store';
import { applyReceivedEvent } from './deposit-matcher';
import { CLOCK_SKEW_MS, VELOCITY_LIMIT } from './risk-rules';

/**
 * The deposit matcher against a hand-rolled Prisma transaction mock, in the
 * same style as deposits.service.spec.ts. Its input is now a STORED
 * bank_transactions row (store-first ingestion). Q1 is `$queryRaw` and is
 * told apart by call order (Q1 always runs first); Q4 (twins) and Q5
 * (velocity) both go through findMany and are told apart by their `where`;
 * the link (Q-BT2) is `bankTransaction.updateMany`.
 */

const KEY = 'a'.repeat(64);
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const BANK_AT = new Date('2026-09-18T09:00:00.000Z');
const NOW = new Date('2026-09-18T09:00:30.000Z');

function makeTransaction(
  overrides: Partial<StoredBankTransaction> = {},
): StoredBankTransaction {
  return {
    id: 'tx-1',
    idempotencyKey: KEY,
    deviceSerial: 'PIXEL10',
    paymentAccountId: ACCOUNT,
    direction: 'RECEIVED',
    amount: new Prisma.Decimal(50000),
    txCode: 'KBZ20260918AB12CD',
    txCodeLast6: 'AB12CD',
    occurredAt: BANK_AT,
    screenshotKey: null,
    state: 'UNMATCHED',
    ...overrides,
  };
}

/** A row as Q1 returns it (raw column shapes: Decimal + Date). */
function openRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dep-1',
    userId: 'user-1',
    amount: new Prisma.Decimal(50000),
    reference: 'AB12CD',
    createdAt: new Date(BANK_AT.getTime() + 60_000),
    declaredTransferAt: null,
    matchStatus: 'UNVERIFIED',
    riskLevel: null,
    riskReasons: [],
    ...overrides,
  };
}

function fullRow(overrides: Record<string, unknown> = {}) {
  return {
    ...openRow(),
    status: 'PENDING',
    paymentMethod: 'KBZ Pay',
    bankCheckedAt: null,
    receivingAmount: null,
    receivingScreenshotKey: null,
    receivingEventKey: null,
    ...overrides,
  };
}

describe('applyReceivedEvent', () => {
  let tx: {
    $queryRaw: jest.Mock;
    deposit: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    bankTransaction: { updateMany: jest.Mock };
  };
  let audit: { record: jest.Mock };
  let twins: unknown[];
  let recentCount: number;

  beforeEach(() => {
    twins = [];
    recentCount = 1;
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      deposit: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn((args: { where: Record<string, unknown> }) =>
          Promise.resolve(
            'reference' in args.where
              ? twins
              : Array.from({ length: recentCount }, (_, i) => ({
                  id: `r${i}`,
                })),
          ),
        ),
        findUniqueOrThrow: jest.fn().mockResolvedValue(fullRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      bankTransaction: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
  });

  const run = (transaction = makeTransaction()) =>
    applyReceivedEvent(
      tx as never,
      audit as unknown as AuditService,
      transaction,
      NOW,
    );

  it('legacy backfill: a deposit already carrying the key (matched by an older build) is linked and answered already_stored', async () => {
    const checked = new Date('2026-09-18T09:00:10.000Z');
    tx.deposit.findUnique.mockResolvedValue({
      id: 'dep-1',
      matchStatus: 'MATCHED',
      bankCheckedAt: checked,
    });

    const outcome = await run();

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'already_stored',
      transactionId: 'tx-1',
      state: 'MATCHED',
      depositId: 'dep-1',
      matchStatus: 'MATCHED',
      screenshotWanted: true,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.deposit.updateMany).not.toHaveBeenCalled();
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', state: { in: ['UNMATCHED', 'AMBIGUOUS'] } },
      data: { state: 'MATCHED', linkedDepositId: 'dep-1', matchedAt: checked },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bank_transaction.link',
        actor: null,
        metadata: expect.objectContaining({ trigger: 'legacy_backfill' }),
      }),
    );
    expect(outcome.touchedDepositIds).toEqual(['dep-1']);
    expect(outcome.transactionChanged).toBe(true);
  });

  it("matches by the user's own last-6 (Q1), writes the bank values with MATCHED when every check passes, and links the row in the same transaction", async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);

    const outcome = await run();

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'matched',
      transactionId: 'tx-1',
      state: 'MATCHED',
      depositId: 'dep-1',
      matchStatus: BankMatchStatus.MATCHED,
      screenshotWanted: true,
    });
    expect(tx.deposit.updateMany).toHaveBeenCalledWith({
      where: { id: 'dep-1', status: 'PENDING', bankCheckedAt: null },
      data: {
        receivingAmount: new Prisma.Decimal(50000),
        receivingTransactionCode: 'AB12CD',
        receivingTransactionTime: '15:30:00',
        receivingTransactionAt: BANK_AT,
        receivingEventKey: KEY,
        bankCheckedAt: NOW,
        matchStatus: BankMatchStatus.MATCHED,
        riskLevel: BankRiskLevel.LOW,
        riskReasons: [],
      },
    });
    // Never the ledger-driving columns; no screenshot pointer when the
    // transaction holds none yet (the upload sets both later).
    const data = tx.deposit.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('receivingPaymentAccountId');
    expect(data).not.toHaveProperty('receivingAccountType');
    expect(data).not.toHaveProperty('receivingScreenshotKey');
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', state: { in: ['UNMATCHED', 'AMBIGUOUS'] } },
      data: { state: 'MATCHED', linkedDepositId: 'dep-1', matchedAt: NOW },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'deposit.bank_match',
        actor: null,
        target: expect.objectContaining({ type: 'deposit', id: 'dep-1' }),
        metadata: expect.objectContaining({
          source: 'phone-monitor',
          idempotencyKey: KEY,
          deviceSerial: 'PIXEL10',
          trigger: 'ingestion',
          bankTransactionId: 'tx-1',
          outcome: 'matched',
        }),
        tx,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bank_transaction.link',
        metadata: expect.objectContaining({
          trigger: 'ingestion',
          depositId: 'dep-1',
        }),
      }),
    );
    expect(outcome.touchedDepositIds).toEqual(['dep-1']);
    expect(outcome.transactionChanged).toBe(true);
  });

  it('copies the screenshot pointer onto the deposit when the transaction already holds one (screenshot arrived before the deposit)', async () => {
    const key = `documents/bank-screenshots/transactions/tx-1/${KEY}.png`;
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);

    const outcome = await run(makeTransaction({ screenshotKey: key }));

    expect(tx.deposit.updateMany.mock.calls[0][0].data).toMatchObject({
      receivingScreenshotKey: key,
    });
    expect(outcome.result.screenshotWanted).toBe(false);
  });

  it('spells the open-set predicate as literal SQL with only the values bound (what makes the partial index usable)', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);
    await run();
    const q1 = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    const text = q1.strings.join('?');
    expect(text).toContain(`status = 'PENDING'::"DepositStatus"`);
    expect(text).toContain(`"bankCheckedAt" IS NULL`);
    expect(q1.values).toEqual([ACCOUNT, 'AB12CD']);
  });

  it('flags AMOUNT_MISMATCH → SUSPICIOUS/HIGH but still writes the bank values onto the identified row', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      openRow({ amount: new Prisma.Decimal(45000) }),
    ]);

    const outcome = await run();

    expect(outcome.result.matchStatus).toBe(BankMatchStatus.SUSPICIOUS);
    expect(tx.deposit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          receivingAmount: new Prisma.Decimal(50000),
          riskReasons: ['AMOUNT_MISMATCH'],
          riskLevel: BankRiskLevel.HIGH,
        }),
      }),
    );
  });

  it('flags SUBMITTED_BEFORE_TRANSFER when the deposit predates the bank time by more than the skew', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      openRow({
        createdAt: new Date(BANK_AT.getTime() - CLOCK_SKEW_MS - 1000),
      }),
    ]);

    const outcome = await run();

    expect(outcome.result.matchStatus).toBe(BankMatchStatus.SUSPICIOUS);
    expect(tx.deposit.updateMany.mock.calls[0][0].data.riskReasons).toEqual([
      'SUBMITTED_BEFORE_TRANSFER',
    ]);
  });

  it('flags DUPLICATE_REFERENCE + SHARED_REFERENCE_ACROSS_USERS from the twins and recomputes the twins', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);
    twins = [
      {
        id: 'dep-2',
        userId: 'user-2',
        amount: new Prisma.Decimal(50000),
        status: 'REJECTED',
        bankCheckedAt: null,
        matchStatus: 'UNVERIFIED',
        riskLevel: null,
        riskReasons: [],
      },
    ];

    const outcome = await run();

    expect(tx.deposit.updateMany.mock.calls[0][0].data.riskReasons).toEqual([
      'DUPLICATE_REFERENCE',
      'SHARED_REFERENCE_ACROSS_USERS',
    ]);
    expect(outcome.result.matchStatus).toBe(BankMatchStatus.SUSPICIOUS);
    // The twin learns about the anchor: SHARED is hard, so the rejected
    // twin becomes SUSPICIOUS too.
    expect(tx.deposit.update).toHaveBeenCalledWith({
      where: { id: 'dep-2' },
      data: {
        matchStatus: BankMatchStatus.SUSPICIOUS,
        riskLevel: BankRiskLevel.HIGH,
        riskReasons: ['DUPLICATE_REFERENCE', 'SHARED_REFERENCE_ACROSS_USERS'],
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'deposit.risk_update',
        actor: null,
        target: expect.objectContaining({ id: 'dep-2' }),
      }),
    );
    expect(outcome.touchedDepositIds).toEqual(['dep-1', 'dep-2']);
  });

  it('flags VELOCITY when the user has VELOCITY_LIMIT rows in the window', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);
    recentCount = VELOCITY_LIMIT;

    const outcome = await run();

    expect(outcome.result.matchStatus).toBe(BankMatchStatus.PENDING_REVIEW);
    expect(tx.deposit.updateMany.mock.calls[0][0].data.riskReasons).toEqual([
      'VELOCITY',
    ]);
  });

  it('THROWS (so the whole per-event transaction rolls back) when the deposit was claimed between lookup and write — never a half-written pair', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);
    tx.deposit.updateMany.mockResolvedValue({ count: 0 });

    await expect(run()).rejects.toThrow('DEPOSIT_CLAIMED_CONCURRENTLY');
    expect(tx.bankTransaction.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('THROWS when the transaction row itself was linked by a racing event (the deposit claim rolls back with it)', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);
    tx.bankTransaction.updateMany.mockResolvedValue({ count: 0 });

    await expect(run()).rejects.toThrow(
      'BANK_TRANSACTION_CLAIMED_CONCURRENTLY',
    );
  });

  it('answers stored_unmatched and writes nothing when the reference finds no open row — and never looks by amount', async () => {
    // The AMBIGUOUS→UNMATCHED guard matches nothing on an UNMATCHED row.
    tx.bankTransaction.updateMany.mockResolvedValue({ count: 0 });

    const outcome = await run();

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'stored_unmatched',
      transactionId: 'tx-1',
      state: 'UNMATCHED',
      reason: 'NO_OPEN_CANDIDATE',
      screenshotWanted: true,
    });
    // One query only: the user's last-6. A transfer that arrives before its
    // deposit is submitted must stay stored and unmatched, not attach to
    // another pending deposit of the same amount (the 2026-09-22 live-test
    // bug) — the deposit claims it at create time.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.deposit.updateMany).not.toHaveBeenCalled();
    expect(tx.deposit.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', state: 'AMBIGUOUS' },
      data: { state: 'UNMATCHED' },
    });
    expect(outcome.transactionChanged).toBe(false);
  });

  it('a re-posted AMBIGUOUS row whose candidates are all gone goes back to UNMATCHED (audited state_change)', async () => {
    tx.bankTransaction.updateMany.mockResolvedValue({ count: 1 });

    const outcome = await run(makeTransaction({ state: 'AMBIGUOUS' }));

    expect(outcome.result.outcome).toBe('stored_unmatched');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bank_transaction.state_change',
        before: { state: 'AMBIGUOUS' },
        after: { state: 'UNMATCHED' },
      }),
    );
    expect(outcome.transactionChanged).toBe(true);
  });

  it('a re-posted ambiguous event writes zero deposit rows and zero deposit audit rows (the flags are already there) and marks the transaction AMBIGUOUS once', async () => {
    // Ambiguity can only come from Q1 now (two open rows with the same
    // last-6 on one account — two users' twins, allowed since H-11; the
    // matcher refuses to pick). Both already carry the flag.
    tx.$queryRaw.mockResolvedValueOnce([
      openRow({
        id: 'dep-1',
        matchStatus: 'PENDING_REVIEW',
        riskLevel: 'MEDIUM',
        riskReasons: ['AMBIGUOUS_MATCH'],
      }),
      openRow({
        id: 'dep-2',
        userId: 'user-2',
        matchStatus: 'PENDING_REVIEW',
        riskLevel: 'MEDIUM',
        riskReasons: ['AMBIGUOUS_MATCH'],
      }),
    ]);
    // Already AMBIGUOUS: the guarded state write matches nothing.
    tx.bankTransaction.updateMany.mockResolvedValue({ count: 0 });

    const outcome = await run(makeTransaction({ state: 'AMBIGUOUS' }));

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'ambiguous',
      transactionId: 'tx-1',
      state: 'AMBIGUOUS',
      reason: 'MULTIPLE_CANDIDATES',
      screenshotWanted: true,
    });
    expect(tx.deposit.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(outcome.touchedDepositIds).toEqual([]);
    expect(outcome.transactionChanged).toBe(false);
  });

  it("H-11: two users' open deposits with the same reference on one account are ambiguous — never picks one; flags both, marks the row AMBIGUOUS", async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      openRow({ id: 'dep-1' }),
      openRow({ id: 'dep-2', userId: 'user-2' }),
    ]);

    const outcome = await run();

    expect(outcome.result.outcome).toBe('ambiguous');
    expect(tx.deposit.updateMany).not.toHaveBeenCalled();
    expect(tx.deposit.update).toHaveBeenCalledTimes(2);
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', state: 'UNMATCHED' },
      data: { state: 'AMBIGUOUS' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bank_transaction.state_change',
        after: { state: 'AMBIGUOUS' },
        metadata: expect.objectContaining({
          candidateIds: ['dep-1', 'dep-2'],
        }),
      }),
    );
    expect(outcome.touchedDepositIds).toEqual(['dep-1', 'dep-2']);
    expect(outcome.transactionChanged).toBe(true);
  });
});
