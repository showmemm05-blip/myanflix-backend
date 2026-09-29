import {
  BankMatchStatus,
  BankRiskLevel,
  Prisma,
} from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { StoredBankTransaction } from '../bank-transactions/bank-transaction-store';
import { CLOCK_SKEW_MS, WITHDRAWAL_PAYOUT_WINDOW_MS } from './risk-rules';
import {
  applySentEvent,
  matchTypedCode,
  rematchParkedSentTransaction,
} from './withdrawal-matcher';

const KEY = 'b'.repeat(64);
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const BANK_AT = new Date('2026-09-18T10:00:00.000Z');
const NOW = new Date('2026-09-18T10:00:20.000Z');

function makeTransaction(
  overrides: Partial<StoredBankTransaction> = {},
): StoredBankTransaction {
  return {
    id: 'tx-2',
    idempotencyKey: KEY,
    deviceSerial: 'PIXEL10',
    paymentAccountId: ACCOUNT,
    direction: 'SENT',
    amount: new Prisma.Decimal(30000),
    txCode: 'KBZ20260918ZZ99YY',
    txCodeLast6: 'ZZ99YY',
    occurredAt: BANK_AT,
    screenshotKey: null,
    state: 'UNMATCHED',
    ...overrides,
  };
}

function openRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wd-1',
    userId: 'user-1',
    amount: new Prisma.Decimal(30000),
    approvedAt: new Date(BANK_AT.getTime() - 10 * 60_000),
    transferPaymentAccountId: null,
    matchStatus: 'UNVERIFIED',
    riskLevel: null,
    riskReasons: [],
    ...overrides,
  };
}

describe('applySentEvent', () => {
  let tx: {
    $queryRaw: jest.Mock;
    withdrawal: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    bankTransaction: { updateMany: jest.Mock };
  };
  let audit: { record: jest.Mock };

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      withdrawal: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          ...openRow(),
          status: 'APPROVED',
          bankCheckedAt: null,
          transferTransactionCode: null,
        }),
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
    applySentEvent(
      tx as never,
      audit as unknown as AuditService,
      transaction,
      NOW,
    );

  it('legacy backfill: a withdrawal already carrying transferEventKey is linked and answered already_stored', async () => {
    tx.withdrawal.findUnique.mockResolvedValue({
      id: 'wd-1',
      matchStatus: 'MATCHED',
      bankCheckedAt: null,
    });
    expect((await run()).result).toEqual({
      idempotencyKey: KEY,
      outcome: 'already_stored',
      transactionId: 'tx-2',
      state: 'MATCHED',
      withdrawalId: 'wd-1',
      matchStatus: 'MATCHED',
      screenshotWanted: true,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'MATCHED', linkedWithdrawalId: 'wd-1', matchedAt: NOW },
      }),
    );
  });

  it('confirms the single open payout by amount + approvedAt window, writes the transfer* values and links the row', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);

    const outcome = await run();

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'matched',
      transactionId: 'tx-2',
      state: 'MATCHED',
      withdrawalId: 'wd-1',
      matchStatus: BankMatchStatus.MATCHED,
      screenshotWanted: true,
    });
    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'wd-1',
        status: 'APPROVED',
        bankCheckedAt: null,
        transferTransactionCode: null,
      },
      data: {
        transferAmount: new Prisma.Decimal(30000),
        transferTransactionCode: 'ZZ99YY',
        transferTransactionTime: '16:30:00',
        transferTransactionAt: BANK_AT,
        transferEventKey: KEY,
        bankCheckedAt: NOW,
        matchStatus: BankMatchStatus.MATCHED,
        riskLevel: BankRiskLevel.LOW,
        riskReasons: [],
      },
    });
    const data = tx.withdrawal.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('transferPaymentAccountId');
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-2', state: { in: ['UNMATCHED', 'AMBIGUOUS'] } },
      data: { state: 'MATCHED', linkedWithdrawalId: 'wd-1', matchedAt: NOW },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.bank_match',
        actor: null,
        metadata: expect.objectContaining({
          direction: 'sent',
          outcome: 'matched',
          bankTransactionId: 'tx-2',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bank_transaction.link',
        metadata: expect.objectContaining({ withdrawalId: 'wd-1' }),
      }),
    );
    expect(outcome.transactionChanged).toBe(true);
  });

  it('binds the payout window (occurredAt - window .. occurredAt + skew), the amount and the account', async () => {
    await run();
    const q7 = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    const text = q7.strings.join('?');
    expect(text).toContain(`status = 'APPROVED'::"WithdrawalStatus"`);
    expect(text).toContain(`"transferTransactionCode" IS NULL`);
    expect(q7.values).toEqual([
      '30000.00',
      new Date(BANK_AT.getTime() - WITHDRAWAL_PAYOUT_WINDOW_MS),
      new Date(BANK_AT.getTime() + CLOCK_SKEW_MS),
      ACCOUNT,
      3,
    ]);
  });

  it('flags DUPLICATE_PAYOUT_CODE (never blocks) when another withdrawal already carries the code, and flags that twin too', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);
    tx.withdrawal.findMany.mockResolvedValue([
      {
        id: 'wd-0',
        userId: 'user-9',
        amount: new Prisma.Decimal(30000),
        status: 'APPROVED',
        bankCheckedAt: null,
        matchStatus: 'UNVERIFIED',
        riskLevel: null,
        riskReasons: [],
      },
    ]);

    const outcome = await run();

    expect(outcome.result.matchStatus).toBe(BankMatchStatus.SUSPICIOUS);
    expect(tx.withdrawal.updateMany.mock.calls[0][0].data.riskReasons).toEqual([
      'DUPLICATE_PAYOUT_CODE',
    ]);
    expect(tx.withdrawal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { transferTransactionCode: 'ZZ99YY', id: { not: 'wd-1' } },
      }),
    );
    expect(tx.withdrawal.update).toHaveBeenCalledWith({
      where: { id: 'wd-0' },
      data: {
        matchStatus: BankMatchStatus.SUSPICIOUS,
        riskLevel: BankRiskLevel.MEDIUM,
        riskReasons: ['DUPLICATE_PAYOUT_CODE'],
      },
    });
    expect(outcome.touchedWithdrawalIds).toEqual(['wd-1', 'wd-0']);
  });

  it('answers stored_unmatched with nothing written when no approved payout fits', async () => {
    tx.bankTransaction.updateMany.mockResolvedValue({ count: 0 });
    const outcome = await run();
    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'stored_unmatched',
      transactionId: 'tx-2',
      state: 'UNMATCHED',
      reason: 'NO_OPEN_CANDIDATE',
      screenshotWanted: true,
    });
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(outcome.transactionChanged).toBe(false);
  });

  it('answers ambiguous, only flags the candidates and marks the row AMBIGUOUS when two same-amount payouts fit', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      openRow({ id: 'wd-1' }),
      openRow({ id: 'wd-2' }),
    ]);

    const outcome = await run();

    expect(outcome.result.outcome).toBe('ambiguous');
    expect(outcome.result.state).toBe('AMBIGUOUS');
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(tx.withdrawal.update).toHaveBeenCalledTimes(2);
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-2', state: 'UNMATCHED' },
      data: { state: 'AMBIGUOUS' },
    });
    // Two risk_update rows + one state_change.
    expect(audit.record).toHaveBeenCalledTimes(3);
  });

  it('throws when the row was claimed between lookup and write (the transaction rolls back, the phone retries)', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);
    tx.withdrawal.updateMany.mockResolvedValue({ count: 0 });
    await expect(run()).rejects.toThrow('WITHDRAWAL_CLAIMED_CONCURRENTLY');
    expect(audit.record).not.toHaveBeenCalled();
    expect(tx.bankTransaction.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Order-independent matching (owner decision 2026-09-28): the typed code is a
// key at ingestion (W3), a typed code looks back at the parked records (W1),
// and an approval re-runs the parked records whose window now contains it
// (W2, per record). The tests above are the unchanged ingestion contract.
// ---------------------------------------------------------------------------

const ADMIN = { id: 'admin-1', username: 'admin', role: 'ADMIN' } as never;

/** An APPROVED withdrawal whose code staff typed by hand (lower case on purpose). */
function codedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wd-7',
    userId: 'user-7',
    amount: new Prisma.Decimal(30000),
    approvedAt: new Date(BANK_AT.getTime() + 73_000),
    transferPaymentAccountId: null,
    transferTransactionCode: 'zz99yy',
    matchStatus: 'UNVERIFIED',
    riskLevel: null,
    riskReasons: [],
    ...overrides,
  };
}

/** The W3 probe is the only withdrawal findMany with a case-insensitive code filter. */
function isCodeProbe(args: {
  where?: { transferTransactionCode?: unknown };
}): boolean {
  const code = args.where?.transferTransactionCode;
  return (
    typeof code === 'object' &&
    code !== null &&
    (code as { mode?: string }).mode === 'insensitive'
  );
}

function makeTx() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    withdrawal: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        ...codedRow(),
        status: 'APPROVED',
        bankCheckedAt: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    bankTransaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe('applySentEvent — a code typed by hand is the key (W3)', () => {
  let tx: ReturnType<typeof makeTx>;
  let audit: { record: jest.Mock };
  let coded: Record<string, unknown>[];

  beforeEach(() => {
    tx = makeTx();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    coded = [codedRow()];
    tx.withdrawal.findMany.mockImplementation((args: never) =>
      Promise.resolve(isCodeProbe(args) ? coded : []),
    );
  });

  const run = (
    transaction = makeTransaction(),
    context?: Parameters<typeof applySentEvent>[4],
  ) =>
    applySentEvent(
      tx as never,
      audit as unknown as AuditService,
      transaction,
      NOW,
      context,
    );

  it('staff typed the code first, the record arrives after: claims that withdrawal, keeps the typed code, never runs the amount-only search', async () => {
    const outcome = await run();

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'matched',
      transactionId: 'tx-2',
      state: 'MATCHED',
      withdrawalId: 'wd-7',
      matchStatus: BankMatchStatus.MATCHED,
      screenshotWanted: true,
    });
    // The guard is "still carrying exactly what staff typed", not "no code".
    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'wd-7',
        status: 'APPROVED',
        bankCheckedAt: null,
        transferTransactionCode: 'zz99yy',
      },
      data: {
        transferAmount: new Prisma.Decimal(30000),
        transferTransactionTime: '16:30:00',
        transferTransactionAt: BANK_AT,
        transferEventKey: KEY,
        bankCheckedAt: NOW,
        matchStatus: BankMatchStatus.MATCHED,
        riskLevel: BankRiskLevel.LOW,
        riskReasons: [],
      },
    });
    const data = tx.withdrawal.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('transferTransactionCode');
    expect(data).not.toHaveProperty('transferPaymentAccountId');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    // The twin check runs on the code the row carries.
    expect(tx.withdrawal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { transferTransactionCode: 'zz99yy', id: { not: 'wd-7' } },
      }),
    );
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-2', state: { in: ['UNMATCHED', 'AMBIGUOUS'] } },
      data: { state: 'MATCHED', linkedWithdrawalId: 'wd-7', matchedAt: NOW },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.bank_match',
        actor: null,
        metadata: expect.objectContaining({
          trigger: 'ingestion_code',
          matchKey: 'transaction_code',
          bankTransactionId: 'tx-2',
          outcome: 'matched',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bank_transaction.link',
        actor: null,
        metadata: expect.objectContaining({
          trigger: 'ingestion',
          withdrawalId: 'wd-7',
        }),
      }),
    );
    expect(outcome.touchedWithdrawalIds).toEqual(['wd-7']);
  });

  it('binds the code lookup: approved, not bank-checked, the code ignoring case, approvedAt within ±24 h of the bank time, account open or this one, LIMIT 2', async () => {
    await run();
    expect(tx.withdrawal.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        status: 'APPROVED',
        bankCheckedAt: null,
        transferTransactionCode: {
          not: null,
          equals: 'ZZ99YY',
          mode: 'insensitive',
        },
        approvedAt: {
          gte: new Date(BANK_AT.getTime() - WITHDRAWAL_PAYOUT_WINDOW_MS),
          lte: new Date(BANK_AT.getTime() + WITHDRAWAL_PAYOUT_WINDOW_MS),
        },
        OR: [
          { transferPaymentAccountId: null },
          { transferPaymentAccountId: ACCOUNT },
        ],
      },
      select: expect.objectContaining({
        id: true,
        amount: true,
        transferTransactionCode: true,
      }),
      orderBy: { approvedAt: 'desc' },
      take: 2,
    });
  });

  it('typed code on a withdrawal of a DIFFERENT amount: AMOUNT_MISMATCH (SUSPICIOUS) on it, no link, the record stays UNMATCHED and no other row is guessed', async () => {
    coded = [codedRow({ amount: new Prisma.Decimal(25000) })];
    // An UNMATCHED record: markUnmatched's AMBIGUOUS guard writes nothing.
    tx.bankTransaction.updateMany.mockResolvedValue({ count: 0 });

    const outcome = await run();

    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'stored_unmatched',
      transactionId: 'tx-2',
      state: 'UNMATCHED',
      reason: 'CODE_AMOUNT_MISMATCH',
      screenshotWanted: true,
    });
    expect(tx.withdrawal.update).toHaveBeenCalledWith({
      where: { id: 'wd-7' },
      data: {
        matchStatus: BankMatchStatus.SUSPICIOUS,
        riskLevel: BankRiskLevel.HIGH,
        riskReasons: ['AMOUNT_MISMATCH'],
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.risk_update',
        actor: null,
        metadata: expect.objectContaining({
          trigger: 'ingestion_code',
          bankTransactionId: 'tx-2',
          reason: 'CODE_AMOUNT_MISMATCH',
        }),
      }),
    );
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    // The amount-only search is NOT run for a record that names a code.
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    // Only markUnmatched's guarded write — never a link.
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-2', state: 'AMBIGUOUS' },
      data: { state: 'UNMATCHED' },
    });
    expect(outcome.touchedWithdrawalIds).toEqual(['wd-7']);
    expect(outcome.transactionChanged).toBe(false);
  });

  it('a re-posted AMBIGUOUS record whose code names a different-amount withdrawal goes back to UNMATCHED (and a repeat costs no second risk write)', async () => {
    coded = [
      codedRow({
        amount: new Prisma.Decimal(25000),
        matchStatus: 'SUSPICIOUS',
        riskLevel: 'HIGH',
        riskReasons: ['AMOUNT_MISMATCH'],
      }),
    ];

    const outcome = await run(makeTransaction({ state: 'AMBIGUOUS' }));

    expect(outcome.result.state).toBe('UNMATCHED');
    expect(outcome.transactionChanged).toBe(true);
    expect(tx.withdrawal.update).not.toHaveBeenCalled();
    expect(outcome.touchedWithdrawalIds).toEqual([]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('two withdrawals carry the same typed code: no code claim — the unchanged amount-only search decides', async () => {
    coded = [codedRow({ id: 'wd-7' }), codedRow({ id: 'wd-8' })];
    tx.bankTransaction.updateMany.mockResolvedValue({ count: 0 });

    const outcome = await run();

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(tx.withdrawal.update).not.toHaveBeenCalled();
    expect(outcome.result.outcome).toBe('stored_unmatched');
  });

  it('a staff-triggered re-run (the approval) audits the claim and the link as that admin, with its trigger', async () => {
    coded = [];
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);

    const outcome = await run(makeTransaction(), {
      trigger: 'withdrawal_approve',
      actor: ADMIN,
    });

    expect(outcome.result.outcome).toBe('matched');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.bank_match',
        actor: ADMIN,
        metadata: expect.objectContaining({
          trigger: 'withdrawal_approve',
          matchKey: 'amount_window',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bank_transaction.link',
        actor: ADMIN,
        metadata: expect.objectContaining({ trigger: 'withdrawal_approve' }),
      }),
    );
  });
});

describe('matchTypedCode — a typed code looks back at the parked records (W1)', () => {
  let tx: ReturnType<typeof makeTx>;
  let audit: { record: jest.Mock };
  const context = { trigger: 'transfer_account_update' as const, actor: ADMIN };

  /** The withdrawal as the save left it: approved, code typed, not bank-checked. */
  function savedRow(overrides: Record<string, unknown> = {}) {
    return {
      ...codedRow({ transferTransactionCode: 'ZZ99YY' }),
      status: 'APPROVED',
      bankCheckedAt: null,
      ...overrides,
    };
  }

  /** A parked "You sent …" record (Prisma row shape). */
  function parked(overrides: Record<string, unknown> = {}) {
    return {
      ...makeTransaction({ id: 'tx-9', txCodeLast6: 'zz99yy' }),
      currency: 'MMK',
      postedAt: new Date(BANK_AT.getTime() + 26_000),
      counterparty: null,
      detailStatus: null,
      linkedDepositId: null,
      linkedWithdrawalId: null,
      matchedAt: null,
      createdAt: BANK_AT,
      updatedAt: BANK_AT,
      ...overrides,
    };
  }

  beforeEach(() => {
    tx = makeTx();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    tx.withdrawal.findUnique.mockResolvedValue(savedRow());
  });

  const check = () =>
    matchTypedCode(
      tx as never,
      audit as unknown as AuditService,
      'wd-7',
      NOW,
      context,
    );

  it('claims the one parked record with the same code (any case), amount and account — even an AMBIGUOUS one — as the admin', async () => {
    tx.bankTransaction.findMany.mockResolvedValue([
      parked({ state: 'AMBIGUOUS' }),
    ]);

    const outcome = await check();

    expect(outcome).toEqual({
      outcome: 'matched',
      candidates: 1,
      touchedWithdrawalIds: ['wd-7'],
      changedTransactionId: 'tx-9',
    });
    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'wd-7',
          status: 'APPROVED',
          bankCheckedAt: null,
          transferTransactionCode: 'ZZ99YY',
        },
      }),
    );
    const data = tx.withdrawal.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('transferTransactionCode');
    expect(data).not.toHaveProperty('transferPaymentAccountId');
    expect(data).toMatchObject({
      bankCheckedAt: NOW,
      matchStatus: BankMatchStatus.MATCHED,
      transferEventKey: KEY,
    });
    // linkToWithdrawal's guard accepts AMBIGUOUS → MATCHED.
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-9', state: { in: ['UNMATCHED', 'AMBIGUOUS'] } },
      data: { state: 'MATCHED', linkedWithdrawalId: 'wd-7', matchedAt: NOW },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.bank_match',
        actor: ADMIN,
        metadata: expect.objectContaining({
          trigger: 'transfer_account_update',
          matchKey: 'transaction_code',
          bankTransactionId: 'tx-9',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bank_transaction.link',
        actor: ADMIN,
        before: { state: 'AMBIGUOUS', linkedWithdrawalId: null },
      }),
    );
  });

  it("binds the lookup: SENT, UNMATCHED/AMBIGUOUS, unlinked both ways, the code ignoring case, the withdrawal's account, bank time within ±24 h of approval, LIMIT 2", async () => {
    tx.withdrawal.findUnique.mockResolvedValue(
      savedRow({ transferPaymentAccountId: ACCOUNT }),
    );
    await check();
    const approvedAt = codedRow().approvedAt;
    expect(tx.bankTransaction.findMany).toHaveBeenCalledWith({
      where: {
        direction: 'SENT',
        state: { in: ['UNMATCHED', 'AMBIGUOUS'] },
        linkedWithdrawalId: null,
        linkedDepositId: null,
        txCodeLast6: { equals: 'ZZ99YY', mode: 'insensitive' },
        occurredAt: {
          gte: new Date(approvedAt.getTime() - WITHDRAWAL_PAYOUT_WINDOW_MS),
          lte: new Date(approvedAt.getTime() + WITHDRAWAL_PAYOUT_WINDOW_MS),
        },
        paymentAccountId: ACCOUNT,
      },
      orderBy: { occurredAt: 'asc' },
      take: 2,
    });

    tx.withdrawal.findUnique.mockResolvedValue(savedRow());
    await check();
    expect(
      tx.bankTransaction.findMany.mock.calls[1][0].where,
    ).not.toHaveProperty('paymentAccountId');
  });

  it('one parked record with a DIFFERENT amount: AMOUNT_MISMATCH (SUSPICIOUS) on the withdrawal, no claim, the bank row untouched', async () => {
    tx.bankTransaction.findMany.mockResolvedValue([
      parked({ amount: new Prisma.Decimal(25000) }),
    ]);

    const outcome = await check();

    expect(outcome).toEqual({
      outcome: 'amount_mismatch',
      candidates: 1,
      touchedWithdrawalIds: ['wd-7'],
      changedTransactionId: null,
    });
    expect(tx.withdrawal.update).toHaveBeenCalledWith({
      where: { id: 'wd-7' },
      data: {
        matchStatus: BankMatchStatus.SUSPICIOUS,
        riskLevel: BankRiskLevel.HIGH,
        riskReasons: ['AMOUNT_MISMATCH'],
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.risk_update',
        metadata: expect.objectContaining({
          trigger: 'transfer_account_update',
          bankTransactionId: 'tx-9',
        }),
      }),
    );
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(tx.bankTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('two parked records share the last 6: nothing is written', async () => {
    tx.bankTransaction.findMany.mockResolvedValue([
      parked({ id: 'tx-9' }),
      parked({ id: 'tx-10', idempotencyKey: 'e'.repeat(64) }),
    ]);

    const outcome = await check();

    expect(outcome).toEqual({
      outcome: 'ambiguous',
      candidates: 2,
      touchedWithdrawalIds: [],
      changedTransactionId: null,
    });
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(tx.withdrawal.update).not.toHaveBeenCalled();
    expect(tx.bankTransaction.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('no parked record: nothing is written', async () => {
    expect(await check()).toEqual({
      outcome: 'no_record',
      candidates: 0,
      touchedWithdrawalIds: [],
      changedTransactionId: null,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['already bank-checked', { bankCheckedAt: NOW }],
    ['no typed code', { transferTransactionCode: null }],
    ['not approved', { status: 'PENDING' }],
  ])('does not look at all when the withdrawal is %s', async (_label, row) => {
    tx.withdrawal.findUnique.mockResolvedValue(savedRow(row));
    expect((await check()).outcome).toBe('not_applicable');
    expect(tx.bankTransaction.findMany).not.toHaveBeenCalled();
  });
});

describe('rematchParkedSentTransaction — one parked record re-run after an approval (W2)', () => {
  let tx: ReturnType<typeof makeTx>;
  let audit: { record: jest.Mock };
  const context = { trigger: 'withdrawal_approve' as const, actor: ADMIN };

  beforeEach(() => {
    tx = makeTx();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
  });

  const rerun = () =>
    rematchParkedSentTransaction(
      tx as never,
      audit as unknown as AuditService,
      'tx-2',
      NOW,
      context,
    );

  it('re-reads the record and runs the same applySentEvent the Resend runs (1 candidate → claimed, as the admin)', async () => {
    tx.bankTransaction.findUnique.mockResolvedValue({
      ...makeTransaction(),
      linkedDepositId: null,
      linkedWithdrawalId: null,
    });
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);

    const outcome = await rerun();

    expect(tx.bankTransaction.findUnique).toHaveBeenCalledWith({
      where: { id: 'tx-2' },
    });
    expect(outcome?.result).toMatchObject({
      outcome: 'matched',
      withdrawalId: 'wd-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.bank_match',
        actor: ADMIN,
        metadata: expect.objectContaining({ trigger: 'withdrawal_approve' }),
      }),
    );
  });

  it.each([
    ['gone', null],
    [
      'already MATCHED',
      { ...makeTransaction({ state: 'MATCHED' }), linkedWithdrawalId: 'wd-0' },
    ],
    [
      'linked to a deposit',
      {
        ...makeTransaction(),
        linkedDepositId: 'dep-1',
        linkedWithdrawalId: null,
      },
    ],
    [
      'a "received" record',
      {
        ...makeTransaction({ direction: 'RECEIVED' }),
        linkedDepositId: null,
        linkedWithdrawalId: null,
      },
    ],
  ])('skips a record that is %s by now', async (_label, row) => {
    tx.bankTransaction.findUnique.mockResolvedValue(row);
    expect(await rerun()).toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.withdrawal.findMany).not.toHaveBeenCalled();
  });
});
