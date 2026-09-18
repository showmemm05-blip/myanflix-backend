import {
  BankMatchStatus,
  BankRiskLevel,
  Prisma,
} from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { NormalizedBankEvent } from './bank-event.types';
import { applyReceivedEvent } from './deposit-matcher';
import { CLOCK_SKEW_MS, VELOCITY_LIMIT } from './risk-rules';

/**
 * The deposit matcher against a hand-rolled Prisma transaction mock, in the
 * same style as deposits.service.spec.ts. Q1/Q2 are `$queryRaw` and are
 * told apart by call order (Q1 always runs first); Q4 (twins) and Q5
 * (velocity) both go through findMany and are told apart by their `where`.
 */

const KEY = 'a'.repeat(64);
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const BANK_AT = new Date('2026-09-18T09:00:00.000Z');
const NOW = new Date('2026-09-18T09:00:30.000Z');

function makeEvent(
  overrides: Partial<NormalizedBankEvent> = {},
): NormalizedBankEvent {
  return {
    idempotencyKey: KEY,
    deviceSerial: 'PIXEL10',
    paymentAccountId: ACCOUNT,
    direction: 'received',
    amount: new Prisma.Decimal(50000),
    txCode: 'KBZ20260918AB12CD',
    txCodeLast6: 'AB12CD',
    occurredAt: BANK_AT,
    ...overrides,
  };
}

/** A row as Q1/Q2 return it (raw column shapes: Decimal + Date). */
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
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
  });

  const run = (event = makeEvent()) =>
    applyReceivedEvent(
      tx as never,
      audit as unknown as AuditService,
      event,
      NOW,
    );

  it('recognises an already-applied event by its key without touching anything (idempotent re-apply)', async () => {
    tx.deposit.findUnique.mockResolvedValue({
      id: 'dep-1',
      receivingScreenshotKey: null,
      matchStatus: 'MATCHED',
    });

    const outcome = await run();

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'already_applied',
      depositId: 'dep-1',
      matchStatus: 'MATCHED',
      screenshotWanted: true,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.deposit.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('says the screenshot is not wanted when the applied row already has one', async () => {
    tx.deposit.findUnique.mockResolvedValue({
      id: 'dep-1',
      receivingScreenshotKey: 'documents/bank-screenshots/deposits/dep-1/x.png',
      matchStatus: 'MATCHED',
    });
    expect((await run()).result.screenshotWanted).toBe(false);
  });

  it("matches by the user's own last-6 (Q1) and writes the bank values with MATCHED when every check passes", async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);

    const outcome = await run();

    expect(outcome.result).toMatchObject({
      outcome: 'matched',
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
    // Never the ledger-driving columns.
    const data = tx.deposit.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('receivingPaymentAccountId');
    expect(data).not.toHaveProperty('receivingAccountType');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'deposit.bank_match',
        actor: null,
        target: expect.objectContaining({ type: 'deposit', id: 'dep-1' }),
        metadata: expect.objectContaining({
          source: 'phone-monitor',
          idempotencyKey: KEY,
          deviceSerial: 'PIXEL10',
          outcome: 'matched',
        }),
        tx,
      }),
    );
    expect(outcome.touchedDepositIds).toEqual(['dep-1']);
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
    // The twin learns about the anchor: DUPLICATE + SHARED, PENDING… no —
    // SHARED is hard, so the rejected twin becomes SUSPICIOUS too.
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

  it('answers no_match (never guesses) when the row was claimed between the lookup and the write', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);
    tx.deposit.updateMany.mockResolvedValue({ count: 0 });

    const outcome = await run();

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'no_match',
      reason: 'ROW_CLAIMED_CONCURRENTLY',
    });
    expect(audit.record).not.toHaveBeenCalled();
    expect(outcome.touchedDepositIds).toEqual([]);
  });

  it('answers no_match and writes nothing when neither the reference nor the amount finds an open row', async () => {
    const outcome = await run();

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'no_match',
      reason: 'NO_OPEN_CANDIDATE',
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.deposit.updateMany).not.toHaveBeenCalled();
    expect(tx.deposit.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('falls back to the single same-amount candidate (the mistyped last-6 case) and writes it with CODE_MISMATCH → SUSPICIOUS', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([]) // Q1 miss
      .mockResolvedValueOnce([openRow({ reference: '999999' })]); // Q2 one hit

    const outcome = await run();

    expect(outcome.result).toMatchObject({
      outcome: 'matched',
      depositId: 'dep-1',
      matchStatus: BankMatchStatus.SUSPICIOUS,
    });
    const data = tx.deposit.updateMany.mock.calls[0][0].data;
    expect(data.riskReasons).toEqual(['CODE_MISMATCH']);
    expect(data.riskLevel).toBe(BankRiskLevel.MEDIUM);
    // The bank's code is stored as printed so the admin sees both side by side.
    expect(data.receivingTransactionCode).toBe('AB12CD');
  });

  it('binds the Q2 window around the bank time and the amount at two decimals', async () => {
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await run();
    const q2 = tx.$queryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(q2.strings.join('?')).toContain(
      `status = 'PENDING'::"DepositStatus"`,
    );
    expect(q2.values).toEqual([
      ACCOUNT,
      '50000.00',
      new Date(BANK_AT.getTime() - CLOCK_SKEW_MS),
      new Date(BANK_AT.getTime() + 24 * 3_600_000),
      3,
    ]);
  });

  it('NEVER GUESSES between several same-amount candidates: no bank values, AMBIGUOUS_MATCH on each, reply ambiguous', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        openRow({ id: 'dep-1', reference: '111111' }),
        openRow({ id: 'dep-2', reference: '222222', userId: 'user-2' }),
      ]);

    const outcome = await run();

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'ambiguous',
      reason: 'MULTIPLE_CANDIDATES',
    });
    expect(tx.deposit.updateMany).not.toHaveBeenCalled();
    expect(tx.deposit.update).toHaveBeenCalledTimes(2);
    expect(tx.deposit.update).toHaveBeenCalledWith({
      where: { id: 'dep-1' },
      data: {
        matchStatus: BankMatchStatus.PENDING_REVIEW,
        riskLevel: BankRiskLevel.MEDIUM,
        riskReasons: ['AMBIGUOUS_MATCH'],
      },
    });
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'deposit.risk_update',
        metadata: expect.objectContaining({
          trigger: 'ambiguous_match',
          candidateIds: ['dep-1', 'dep-2'],
        }),
      }),
    );
    expect(outcome.touchedDepositIds).toEqual(['dep-1', 'dep-2']);
  });

  it('a retried ambiguous event writes zero rows and zero audit rows (the flags are already there)', async () => {
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
      openRow({
        id: 'dep-1',
        reference: '111111',
        matchStatus: 'PENDING_REVIEW',
        riskLevel: 'MEDIUM',
        riskReasons: ['AMBIGUOUS_MATCH'],
      }),
      openRow({
        id: 'dep-2',
        reference: '222222',
        matchStatus: 'PENDING_REVIEW',
        riskLevel: 'MEDIUM',
        riskReasons: ['AMBIGUOUS_MATCH'],
      }),
    ]);

    const outcome = await run();

    expect(outcome.result.outcome).toBe('ambiguous');
    expect(tx.deposit.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(outcome.touchedDepositIds).toEqual([]);
  });

  it('treats two rows for one reference on Q1 (an impossible state) as ambiguous rather than picking one', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      openRow({ id: 'dep-1' }),
      openRow({ id: 'dep-2' }),
    ]);
    const outcome = await run();
    expect(outcome.result.outcome).toBe('ambiguous');
    expect(tx.deposit.updateMany).not.toHaveBeenCalled();
  });
});
