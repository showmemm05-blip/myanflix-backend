import {
  BankMatchStatus,
  BankRiskLevel,
  Prisma,
} from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { NormalizedBankEvent } from './bank-event.types';
import { CLOCK_SKEW_MS, WITHDRAWAL_PAYOUT_WINDOW_MS } from './risk-rules';
import { applySentEvent } from './withdrawal-matcher';

const KEY = 'b'.repeat(64);
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const BANK_AT = new Date('2026-09-18T10:00:00.000Z');
const NOW = new Date('2026-09-18T10:00:20.000Z');

function makeEvent(
  overrides: Partial<NormalizedBankEvent> = {},
): NormalizedBankEvent {
  return {
    idempotencyKey: KEY,
    deviceSerial: 'PIXEL10',
    paymentAccountId: ACCOUNT,
    direction: 'sent',
    amount: new Prisma.Decimal(30000),
    txCode: 'KBZ20260918ZZ99YY',
    txCodeLast6: 'ZZ99YY',
    occurredAt: BANK_AT,
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
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
  });

  const run = (event = makeEvent()) =>
    applySentEvent(tx as never, audit as unknown as AuditService, event, NOW);

  it('recognises an already-applied event by transferEventKey', async () => {
    tx.withdrawal.findUnique.mockResolvedValue({
      id: 'wd-1',
      transferScreenshotKey: null,
      matchStatus: 'MATCHED',
    });
    expect((await run()).result).toEqual({
      idempotencyKey: KEY,
      outcome: 'already_applied',
      withdrawalId: 'wd-1',
      matchStatus: 'MATCHED',
      screenshotWanted: true,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('confirms the single open payout by amount + approvedAt window and writes the transfer* values', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);

    const outcome = await run();

    expect(outcome.result).toMatchObject({
      outcome: 'matched',
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
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'withdrawal.bank_match',
        actor: null,
        metadata: expect.objectContaining({
          direction: 'sent',
          outcome: 'matched',
        }),
      }),
    );
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

  it('answers no_match with nothing written when no approved payout fits', async () => {
    const outcome = await run();
    expect(outcome.result).toEqual({
      idempotencyKey: KEY,
      outcome: 'no_match',
      reason: 'NO_OPEN_CANDIDATE',
    });
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers ambiguous and only flags the candidates when two same-amount payouts fit', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      openRow({ id: 'wd-1' }),
      openRow({ id: 'wd-2' }),
    ]);

    const outcome = await run();

    expect(outcome.result.outcome).toBe('ambiguous');
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(tx.withdrawal.update).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('answers no_match when the row was claimed between lookup and write', async () => {
    tx.$queryRaw.mockResolvedValueOnce([openRow()]);
    tx.withdrawal.updateMany.mockResolvedValue({ count: 0 });
    expect((await run()).result.reason).toBe('ROW_CLAIMED_CONCURRENTLY');
    expect(audit.record).not.toHaveBeenCalled();
  });
});
