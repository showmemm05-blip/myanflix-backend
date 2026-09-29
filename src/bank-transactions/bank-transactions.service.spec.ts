import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { UNCLAIMED_AFTER_MS } from '../bank-events/risk-rules';
import {
  BankTransactionsService,
  DEVICE_TOTAL_CAP,
  LIST_COUNT_CAP,
  MAX_DEVICES,
} from './bank-transactions.service';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    idempotencyKey: 'c'.repeat(64),
    deviceSerial: 'PIXEL10',
    paymentAccountId: ACCOUNT,
    direction: 'RECEIVED',
    amount: new Prisma.Decimal(50000),
    currency: 'MMK',
    txCode: 'KBZ20260922AB12CD',
    txCodeLast6: 'AB12CD',
    occurredAt: new Date(),
    postedAt: new Date(),
    counterparty: null,
    screenshotKey: null,
    detailStatus: 'ok',
    state: 'UNMATCHED',
    linkedDepositId: null,
    linkedWithdrawalId: null,
    matchedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    paymentAccount: { type: 'KBZPay', subname: 'K1', accountName: 'MyanFlix' },
    ...overrides,
  };
}

describe('BankTransactionsService', () => {
  let service: BankTransactionsService;
  let prisma: {
    bankTransaction: { findUnique: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let minio: { getObjectStream: jest.Mock };

  beforeEach(async () => {
    prisma = {
      bankTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      // Array form for the ids+count pair (like the deposits open-set list).
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    minio = { getObjectStream: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankTransactionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minio },
      ],
    }).compile();
    service = module.get(BankTransactionsService);
  });

  /** The two Q-BT4 statements of the last findAll call, as text + bound values. */
  function lastListQueries() {
    const calls = prisma.$queryRaw.mock.calls.slice(-2);
    const [ids, count] = calls.map((call) => call[0] as Prisma.Sql);
    return {
      idsText: ids.strings.join('?'),
      idsValues: ids.values,
      countText: count.strings.join('?'),
      countValues: count.values,
    };
  }

  describe('findAll (Q-BT4) — one predicate, literal state tabs, values bound', () => {
    it('no filter: only the paging clauses, ordered by bank time then id, count capped at LIST_COUNT_CAP + 1', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ n: 0 }]);

      const page = await service.findAll({});

      const { idsText, idsValues, countText, countValues } = lastListQueries();
      expect(idsText).toContain('FROM bank_transactions WHERE 1=1');
      expect(idsText).toContain('ORDER BY "occurredAt" DESC, id DESC');
      expect(idsValues).toEqual([20, 0]);
      expect(countText).toContain('count(*)::int');
      expect(countValues).toEqual([LIST_COUNT_CAP + 1]);
      expect(page).toEqual({
        items: [],
        total: 0,
        totalCapped: false,
        page: 1,
        limit: 20,
      });
      expect(prisma.bankTransaction.findMany).not.toHaveBeenCalled();
    });

    it('deviceSerial / paymentAccountId / direction / date range bind their values with the columns in the text', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ n: 0 }]);
      await service.findAll({
        deviceSerial: 'PIXEL10',
        paymentAccountId: ACCOUNT,
        direction: 'SENT',
        from: '2026-09-22T00:00:00.000Z',
        to: '2026-09-22T23:59:59.999Z',
        page: 3,
        limit: 50,
      });
      const { idsText, idsValues } = lastListQueries();
      expect(idsText).toContain('"deviceSerial" = ?');
      expect(idsText).toContain('"paymentAccountId" = ?');
      expect(idsText).toContain('direction = ?::"BankTransactionDirection"');
      expect(idsText).toContain('"occurredAt" >= ?');
      expect(idsText).toContain('"occurredAt" <= ?');
      expect(idsValues).toEqual([
        'PIXEL10',
        ACCOUNT,
        'SENT',
        new Date('2026-09-22T00:00:00.000Z'),
        new Date('2026-09-22T23:59:59.999Z'),
        50,
        100,
      ]);
    });

    it.each([
      ['matched', `state = 'MATCHED'::"BankTransactionState"`, false],
      ['ambiguous', `state = 'AMBIGUOUS'::"BankTransactionState"`, false],
      [
        'unmatched',
        `state = 'UNMATCHED'::"BankTransactionState" AND "occurredAt" >= ?`,
        true,
      ],
      [
        'unclaimed',
        `state = 'UNMATCHED'::"BankTransactionState" AND "occurredAt" < ?`,
        true,
      ],
    ] as const)(
      'state=%s spells the enum as a literal (the (state, occurredAt) index) and binds the 48 h cutoff only for the UNMATCHED band',
      async (state, fragment, bindsCutoff) => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ n: 0 }]);
        const before = Date.now();
        await service.findAll({ state });
        const { idsText, idsValues } = lastListQueries();
        expect(idsText).toContain(fragment);
        if (bindsCutoff) {
          const cutoff = idsValues[0] as Date;
          expect(cutoff).toBeInstanceOf(Date);
          expect(
            Math.abs(before - UNCLAIMED_AFTER_MS - cutoff.getTime()),
          ).toBeLessThan(5000);
        } else {
          expect(idsValues).toEqual([20, 0]);
        }
      },
    );

    it('state=all adds no state clause', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ n: 0 }]);
      await service.findAll({ state: 'all' });
      expect(lastListQueries().idsText).not.toContain('state =');
    });

    it('fetches the page rows by primary key with the account label, keeps the index order, and derives the view', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'b' }, { id: 'a' }])
        .mockResolvedValueOnce([{ n: 2 }]);
      const old = new Date(Date.now() - UNCLAIMED_AFTER_MS - 60_000);
      prisma.bankTransaction.findMany.mockResolvedValue([
        row({ id: 'a', occurredAt: old }),
        row({ id: 'b', state: 'MATCHED', linkedDepositId: 'dep-1' }),
      ]);

      const page = await service.findAll({ limit: 10 });

      expect(prisma.bankTransaction.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['b', 'a'] } },
        include: {
          paymentAccount: {
            select: { type: true, subname: true, accountName: true },
          },
        },
      });
      expect(page.items.map((item) => item.id)).toEqual(['b', 'a']);
      expect(page.items[0]).toMatchObject({
        view: 'MATCHED',
        amount: 50000,
        hasScreenshot: false,
        paymentAccount: {
          type: 'KBZPay',
          subname: 'K1',
          accountName: 'MyanFlix',
        },
      });
      expect(page.items[1].view).toBe('UNCLAIMED');
      expect(page.items[0]).not.toHaveProperty('screenshotKey');
      expect(page.total).toBe(2);
      expect(page.totalCapped).toBe(false);
    });

    it('reports a capped total instead of counting an unbounded set', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'a' }])
        .mockResolvedValueOnce([{ n: LIST_COUNT_CAP + 1 }]);
      prisma.bankTransaction.findMany.mockResolvedValue([row({ id: 'a' })]);
      const page = await service.findAll({});
      expect(page.total).toBe(LIST_COUNT_CAP);
      expect(page.totalCapped).toBe(true);
    });
  });

  describe('findOne / getScreenshot', () => {
    it('findOne is a primary-key read with the account label; 404 otherwise', async () => {
      prisma.bankTransaction.findUnique.mockResolvedValueOnce(row());
      const item = await service.findOne('tx-1');
      expect(item).toMatchObject({ id: 'tx-1', view: 'WAITING' });
      expect(prisma.bankTransaction.findUnique).toHaveBeenCalledWith({
        where: { id: 'tx-1' },
        include: {
          paymentAccount: {
            select: { type: true, subname: true, accountName: true },
          },
        },
      });
      await expect(service.findOne('nope')).rejects.toThrow(NotFoundException);
    });

    it('streams the private object inline as PNG, 404 when the row has none or the object is gone', async () => {
      prisma.bankTransaction.findUnique.mockResolvedValueOnce({
        screenshotKey: null,
      });
      await expect(service.getScreenshot('tx-1')).rejects.toThrow(
        NotFoundException,
      );

      prisma.bankTransaction.findUnique.mockResolvedValue({
        screenshotKey: 'documents/bank-screenshots/transactions/tx-1/k.png',
      });
      minio.getObjectStream.mockResolvedValueOnce(null);
      await expect(service.getScreenshot('tx-1')).rejects.toThrow(
        NotFoundException,
      );

      minio.getObjectStream.mockResolvedValueOnce({
        stream: Readable.from([Buffer.from('png')]),
        contentType: 'image/png',
        contentLength: 3,
      });
      const file = await service.getScreenshot('tx-1');
      expect(file).toBeInstanceOf(StreamableFile);
      expect(file.getHeaders()).toMatchObject({
        type: 'image/png',
        disposition: 'inline; filename="bank-transaction-tx-1.png"',
        length: 3,
      });
      expect(minio.getObjectStream).toHaveBeenCalledWith(
        'documents/bank-screenshots/transactions/tx-1/k.png',
      );
    });
  });

  describe('listDevices (Q-BT6)', () => {
    it('walks distinct serials with a recursive loose index scan capped at MAX_DEVICES, then three bounded reads per serial', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { deviceSerial: 'PIXEL10' },
          { deviceSerial: 'S24' },
        ])
        .mockResolvedValueOnce([
          {
            lastSeenAt: new Date('2026-09-22T10:00:00.000Z'),
            last24hCount: 7,
            total: 120,
          },
        ])
        .mockResolvedValueOnce([
          { lastSeenAt: null, last24hCount: 0, total: DEVICE_TOTAL_CAP + 1 },
        ]);

      const { items } = await service.listDevices();

      const serials = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      const text = serials.strings.join('?');
      expect(text).toContain('WITH RECURSIVE');
      expect(text).toContain('t."deviceSerial" > d."deviceSerial"');
      expect(serials.values).toEqual([MAX_DEVICES]);

      const perSerial = prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql;
      const perText = perSerial.strings.join('?');
      expect(perText).toContain('ORDER BY "occurredAt" DESC LIMIT 1');
      expect(perText).toContain('"occurredAt" >= ?');
      expect(perSerial.values).toEqual([
        'PIXEL10',
        'PIXEL10',
        expect.any(Date),
        'PIXEL10',
        DEVICE_TOTAL_CAP + 1,
      ]);

      expect(items).toEqual([
        {
          deviceSerial: 'PIXEL10',
          lastSeenAt: new Date('2026-09-22T10:00:00.000Z'),
          last24hCount: 7,
          total: 120,
          totalCapped: false,
        },
        {
          deviceSerial: 'S24',
          lastSeenAt: null,
          last24hCount: 0,
          total: DEVICE_TOTAL_CAP,
          totalCapped: true,
        },
      ]);
    });

    it('answers an empty list with a single query on an empty table', async () => {
      expect(await service.listDevices()).toEqual({ items: [] });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });
});
