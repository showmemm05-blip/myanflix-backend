import { Test, TestingModule } from '@nestjs/testing';
import {
  LotteryClaimRejectReason,
  LotteryClaimStatus,
  LotteryDrawStatus,
  LotteryPayoutStatus,
  Prisma,
  Role,
} from '../../generated/prisma/client';
import { CodedHttpException } from '../../common/errors/coded-http.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CLAIM_ID,
  DRAW_ID,
  makeClaim,
  makeDraw,
  makePayout,
} from '../../../test/lottery-fixtures';
import { LOTTERY_ERRORS } from '../lottery-errors';
import {
  PUBLISH_TRANSACTION_MAX_WAIT_MS,
  PUBLISH_TRANSACTION_TIMEOUT_MS,
} from '../results/lottery-publish.service';
import { LotteryClaimsService } from './lottery-claims.service';

type RawCall = [TemplateStringsArray, ...unknown[]];

const user = {
  id: 'user-1',
  username: 'mya',
  role: Role.USER,
  appRoleId: null,
};

const NOW = new Date('2026-11-02T03:42:00Z');

/** Draw 24, published on 1 Nov with its counters in and 90 days to claim. */
const publishedDraw = (overrides: Parameters<typeof makeDraw>[0] = {}) =>
  makeDraw({
    status: LotteryDrawStatus.PUBLISHED,
    openedAt: new Date('2026-10-19T08:00:00Z'),
    closedAt: new Date('2026-11-01T06:30:00Z'),
    publishedAt: new Date('2026-11-01T09:00:00Z'),
    publishedByUserId: 'admin-1',
    exchangeRate: new Prisma.Decimal('75.0000'),
    winnersCount: 12,
    prizeTotalKs: new Prisma.Decimal('1250000.00'),
    prizesPaidKs: new Prisma.Decimal(0),
    claimDeadlineAt: new Date('2027-01-30T09:00:00Z'),
    ...overrides,
  });

/** user-1's two winning tickets of draw 24, as the view query reads them (with the ticket). */
const storedPayouts = (status = LotteryPayoutStatus.UNCLAIMED) => [
  {
    ...makePayout({
      id: 'payout-1',
      ticketId: 't1',
      status,
      groups: [
        { key: 'first', name: 'First prize', baht: 6_000_000, ks: 450_000_000 },
        { key: 'back3', name: 'Back 3 digits', baht: 4000, ks: 300_000 },
      ],
      baht: new Prisma.Decimal('6004000.00'),
      ks: new Prisma.Decimal('450300000.00'),
    }),
    ticket: { ticketNo: 'MFL-24-000001', number: '123456' },
  },
  {
    ...makePayout({ id: 'payout-2', ticketId: 't2', status }),
    ticket: { ticketNo: 'MFL-24-000002', number: '000001' },
  },
];

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CodedHttpException
        ? { status: error.getStatus(), code: error.code, extra: error.extra }
        : error,
  );

describe('LotteryClaimsService', () => {
  let service: LotteryClaimsService;
  let prisma: {
    lotteryDraw: Record<'findUnique' | 'findUniqueOrThrow', jest.Mock>;
    lotteryPayout: Record<'findMany' | 'updateMany', jest.Mock>;
    lotteryClaim: Record<
      'findUnique' | 'findMany' | 'count' | 'create',
      jest.Mock
    >;
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      lotteryDraw: {
        findUnique: jest.fn().mockResolvedValue(publishedDraw()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(publishedDraw()),
      },
      lotteryPayout: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      lotteryClaim: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue(makeClaim()),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryClaimsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(LotteryClaimsService);
  });

  describe('drawView', () => {
    it('is "none" with no winning ticket, carrying the draw and its deadline', async () => {
      const view = await service.drawView(user.id, 24);

      expect(prisma.lotteryDraw.findUnique).toHaveBeenCalledWith({
        where: { drawNo: 24 },
      });
      expect(prisma.lotteryPayout.findMany).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID, userId: user.id },
        orderBy: [{ ks: 'desc' }, { ticket: { ticketNo: 'asc' } }],
        include: { ticket: { select: { ticketNo: true, number: true } } },
      });
      expect(prisma.lotteryClaim.findUnique).toHaveBeenCalledWith({
        where: { drawId_userId: { drawId: DRAW_ID, userId: user.id } },
      });
      expect(view).toEqual({
        drawNo: 24,
        thaiDrawDate: '2026-11-01',
        drawStatus: 'published',
        wonTickets: 0,
        prizeKs: 0,
        status: 'none',
        claimId: null,
        requestedAt: null,
        decidedAt: null,
        paidKs: null,
        rejectReason: null,
        rejectNote: null,
        claimDeadlineAt: new Date('2027-01-30T09:00:00Z'),
        tickets: [],
      });
    });

    it('is "not_requested" with UNCLAIMED prizes: the tickets biggest first with their groups, the sums as numbers', async () => {
      prisma.lotteryPayout.findMany.mockResolvedValue(storedPayouts());

      const view = await service.drawView(user.id, 24);

      expect(view).toMatchObject({
        wonTickets: 2,
        prizeKs: 450_600_000,
        status: 'not_requested',
        claimId: null,
        tickets: [
          {
            ticketNo: 'MFL-24-000001',
            number: '123456',
            ks: 450_300_000,
            wonGroups: [
              { key: 'first', name: 'First prize', ks: 450_000_000 },
              { key: 'back3', name: 'Back 3 digits', ks: 300_000 },
            ],
          },
          {
            ticketNo: 'MFL-24-000002',
            number: '000001',
            ks: 300_000,
            wonGroups: [{ key: 'back3', name: 'Back 3 digits', ks: 300_000 }],
          },
        ],
      });
    });

    it('takes its status from the claim once one exists: requested, paid (with paidKs), rejected (with the reason the customer sees)', async () => {
      prisma.lotteryPayout.findMany.mockResolvedValue(
        storedPayouts(LotteryPayoutStatus.REQUESTED),
      );
      prisma.lotteryClaim.findUnique.mockResolvedValue(makeClaim());
      expect(await service.drawView(user.id, 24)).toMatchObject({
        status: 'requested',
        claimId: CLAIM_ID,
        requestedAt: new Date('2026-11-01T09:42:00Z'),
        decidedAt: null,
        paidKs: null,
        rejectReason: null,
      });

      prisma.lotteryClaim.findUnique.mockResolvedValue(
        makeClaim({
          status: LotteryClaimStatus.PAID,
          decidedAt: new Date('2026-11-02T04:10:00Z'),
          decidedByUserId: 'admin-1',
          transactionId: 'txn-1',
        }),
      );
      expect(await service.drawView(user.id, 24)).toMatchObject({
        status: 'paid',
        decidedAt: new Date('2026-11-02T04:10:00Z'),
        paidKs: 450_000,
      });

      prisma.lotteryClaim.findUnique.mockResolvedValue(
        makeClaim({
          status: LotteryClaimStatus.REJECTED,
          decidedAt: new Date('2026-11-02T04:10:00Z'),
          decidedByUserId: 'admin-1',
          rejectReason: LotteryClaimRejectReason.TICKET_UNDER_REVIEW,
          rejectNote: 'Checking the photo',
        }),
      );
      expect(await service.drawView(user.id, 24)).toMatchObject({
        status: 'rejected',
        paidKs: null,
        rejectReason: 'ticket_under_review',
        rejectNote: 'Checking the photo',
      });
    });

    it('is "expired" only when every prize expired — one still UNCLAIMED keeps it requestable', async () => {
      prisma.lotteryPayout.findMany.mockResolvedValue(
        storedPayouts(LotteryPayoutStatus.EXPIRED),
      );
      expect((await service.drawView(user.id, 24)).status).toBe('expired');

      const [expired, unclaimed] = storedPayouts();
      prisma.lotteryPayout.findMany.mockResolvedValue([
        { ...expired, status: LotteryPayoutStatus.EXPIRED },
        unclaimed,
      ]);
      expect((await service.drawView(user.id, 24)).status).toBe(
        'not_requested',
      );
    });

    it('is "expired" the moment the claim deadline passes with no claim of mine — before the hourly sweep flips the prizes — and "not_requested" while the deadline is ahead', async () => {
      // The view must agree with the refusal POST gives from that instant
      // (409 CLAIM_EXPIRED), not wait up to an hour for the expiry cron.
      prisma.lotteryPayout.findMany.mockResolvedValue(storedPayouts());
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        publishedDraw({ claimDeadlineAt: new Date('2026-11-02T03:42:00Z') }),
      );
      expect((await service.drawView(user.id, 24, NOW)).status).toBe(
        'expired',
      );

      prisma.lotteryDraw.findUnique.mockResolvedValue(
        publishedDraw({
          claimDeadlineAt: new Date('2026-11-02T03:42:00.001Z'),
        }),
      );
      expect((await service.drawView(user.id, 24, NOW)).status).toBe(
        'not_requested',
      );

      // A claim of mine speaks for itself whatever the deadline says.
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        publishedDraw({ claimDeadlineAt: new Date('2026-11-02T03:42:00Z') }),
      );
      prisma.lotteryPayout.findMany.mockResolvedValue(
        storedPayouts(LotteryPayoutStatus.REQUESTED),
      );
      prisma.lotteryClaim.findUnique.mockResolvedValue(makeClaim());
      expect((await service.drawView(user.id, 24, NOW)).status).toBe(
        'requested',
      );
    });

    it('404s an unknown draw', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(null);
      await expect(
        codeOf(service.drawView(user.id, 99)),
      ).resolves.toMatchObject({
        status: 404,
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
      });
      expect(prisma.lotteryPayout.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listMine', () => {
    it('pages the caller’s claims newest request first with the draw', async () => {
      prisma.lotteryClaim.findMany.mockResolvedValue([
        {
          ...makeClaim({
            status: LotteryClaimStatus.PAID,
            decidedAt: new Date('2026-11-02T04:10:00Z'),
          }),
          draw: {
            drawNo: 24,
            thaiDrawDate: new Date('2026-11-01T00:00:00Z'),
          },
        },
      ]);
      prisma.lotteryClaim.count.mockResolvedValue(7);

      const page = await service.listMine(user.id, { page: 2, pageSize: 5 });

      expect(prisma.lotteryClaim.findMany).toHaveBeenCalledWith({
        where: { userId: user.id },
        orderBy: { requestedAt: 'desc' },
        skip: 5,
        take: 5,
        include: { draw: { select: { drawNo: true, thaiDrawDate: true } } },
      });
      expect(prisma.lotteryClaim.count).toHaveBeenCalledWith({
        where: { userId: user.id },
      });
      expect(page).toEqual({
        items: [
          {
            claimId: CLAIM_ID,
            drawNo: 24,
            thaiDrawDate: '2026-11-01',
            status: 'paid',
            ks: 450_000,
            ticketsCount: 3,
            requestedAt: new Date('2026-11-01T09:42:00Z'),
            decidedAt: new Date('2026-11-02T04:10:00Z'),
          },
        ],
        total: 7,
        page: 2,
        pageSize: 5,
      });
    });

    it('defaults to page 1 of 20', async () => {
      await service.listMine(user.id, {});
      expect(prisma.lotteryClaim.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });
  });

  describe('request', () => {
    const unclaimed = [
      {
        id: 'payout-1',
        baht: new Prisma.Decimal('6004000.00'),
        ks: new Prisma.Decimal('450300000.00'),
        rate: new Prisma.Decimal('75.0000'),
      },
      {
        id: 'payout-2',
        baht: new Prisma.Decimal('4000.00'),
        ks: new Prisma.Decimal('300000.00'),
        rate: new Prisma.Decimal('75.0000'),
      },
    ];

    it('creates ONE claim for every UNCLAIMED prize of the draw under the draw’s row lock, moves no money, and answers the refreshed view', async () => {
      // Inside the transaction: the UNCLAIMED prizes; after it, the view's read of every payout.
      prisma.lotteryPayout.findMany
        .mockResolvedValueOnce(unclaimed)
        .mockResolvedValueOnce(storedPayouts(LotteryPayoutStatus.REQUESTED));
      prisma.lotteryClaim.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeClaim({ ticketsCount: 2 }));
      prisma.lotteryClaim.create.mockResolvedValue(
        makeClaim({ ticketsCount: 2 }),
      );
      prisma.lotteryPayout.updateMany.mockResolvedValue({ count: 2 });

      const view = await service.request(user, { drawNo: 24 }, NOW);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][1]).toEqual({
        maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS,
        timeout: PUBLISH_TRANSACTION_TIMEOUT_MS,
      });
      // The draw's row lock first, then the re-read under it.
      const lockCall = prisma.$queryRaw.mock.calls[0] as RawCall;
      expect(lockCall[0].join('?')).toContain(
        'SELECT "id" FROM "lottery_draws" WHERE "id" = ? FOR UPDATE',
      );
      expect(lockCall[1]).toBe(DRAW_ID);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryDraw.findUniqueOrThrow.mock.invocationCallOrder[0],
      );
      expect(prisma.lotteryClaim.findUnique).toHaveBeenNthCalledWith(1, {
        where: { drawId_userId: { drawId: DRAW_ID, userId: user.id } },
      });
      expect(prisma.lotteryPayout.findMany).toHaveBeenNthCalledWith(1, {
        where: {
          drawId: DRAW_ID,
          userId: user.id,
          status: LotteryPayoutStatus.UNCLAIMED,
        },
        select: { id: true, baht: true, ks: true, rate: true },
      });
      // The claim: the sums, the draw's rate, the count, requested now.
      expect(prisma.lotteryClaim.create).toHaveBeenCalledTimes(1);
      const created = prisma.lotteryClaim.create.mock.calls[0][0] as {
        data: Record<string, unknown> & {
          baht: Prisma.Decimal;
          ks: Prisma.Decimal;
          rate: Prisma.Decimal;
        };
      };
      expect(created.data).toMatchObject({
        drawId: DRAW_ID,
        userId: user.id,
        status: LotteryClaimStatus.REQUESTED,
        ticketsCount: 2,
        requestedAt: NOW,
      });
      expect(created.data.baht.toFixed(2)).toBe('6008000.00');
      expect(created.data.ks.toFixed(2)).toBe('450600000.00');
      expect(created.data.rate.toFixed(4)).toBe('75.0000');
      // Those payouts, and only those, now REQUESTED under the claim.
      expect(prisma.lotteryPayout.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['payout-1', 'payout-2'] },
          status: LotteryPayoutStatus.UNCLAIMED,
        },
        data: { status: LotteryPayoutStatus.REQUESTED, claimId: CLAIM_ID },
      });
      expect(view).toMatchObject({
        drawNo: 24,
        status: 'requested',
        claimId: CLAIM_ID,
        wonTickets: 2,
      });
    });

    it('409s LOTTERY_DRAW_STATE for a draw that is not published, and for one whose publish has not finished', async () => {
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(
        publishedDraw({
          status: LotteryDrawStatus.CLOSED,
          publishedAt: null,
          winnersCount: null,
          claimDeadlineAt: null,
        }),
      );
      await expect(
        codeOf(service.request(user, { drawNo: 24 }, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.DRAW_STATE,
        extra: { status: 'closed' },
      });

      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(
        publishedDraw({ winnersCount: null, claimDeadlineAt: null }),
      );
      await expect(
        codeOf(service.request(user, { drawNo: 24 }, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.DRAW_STATE,
        extra: { status: 'published' },
      });
      expect(prisma.lotteryClaim.create).not.toHaveBeenCalled();
      expect(prisma.lotteryPayout.updateMany).not.toHaveBeenCalled();
    });

    it('409s CLAIM_ALREADY_REQUESTED for a waiting or paid claim of mine, and CLAIM_REJECTED for a rejected one', async () => {
      prisma.lotteryClaim.findUnique.mockResolvedValue(makeClaim());
      await expect(
        codeOf(service.request(user, { drawNo: 24 }, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.CLAIM_ALREADY_REQUESTED,
        extra: { status: 'requested', claimId: CLAIM_ID },
      });

      prisma.lotteryClaim.findUnique.mockResolvedValue(
        makeClaim({ status: LotteryClaimStatus.PAID }),
      );
      await expect(
        codeOf(service.request(user, { drawNo: 24 }, NOW)),
      ).resolves.toMatchObject({
        code: LOTTERY_ERRORS.CLAIM_ALREADY_REQUESTED,
        extra: { status: 'paid', claimId: CLAIM_ID },
      });

      prisma.lotteryClaim.findUnique.mockResolvedValue(
        makeClaim({ status: LotteryClaimStatus.REJECTED }),
      );
      await expect(
        codeOf(service.request(user, { drawNo: 24 }, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.CLAIM_REJECTED,
        extra: { claimId: CLAIM_ID },
      });
      expect(prisma.lotteryPayout.findMany).not.toHaveBeenCalled();
      expect(prisma.lotteryClaim.create).not.toHaveBeenCalled();
    });

    it('409s CLAIM_EXPIRED once the draw’s claim deadline has passed, before looking at the prizes', async () => {
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(
        publishedDraw({ claimDeadlineAt: new Date('2026-11-02T03:42:00Z') }),
      );
      await expect(
        codeOf(service.request(user, { drawNo: 24 }, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.CLAIM_EXPIRED,
        extra: { claimDeadlineAt: '2026-11-02T03:42:00.000Z' },
      });
      expect(prisma.lotteryPayout.findMany).not.toHaveBeenCalled();
      expect(prisma.lotteryClaim.create).not.toHaveBeenCalled();
    });

    it('409s CLAIM_NOTHING_TO_CLAIM when no UNCLAIMED prize of the draw is mine', async () => {
      prisma.lotteryPayout.findMany.mockResolvedValueOnce([]);
      await expect(
        codeOf(service.request(user, { drawNo: 24 }, NOW)),
      ).resolves.toMatchObject({
        status: 409,
        code: LOTTERY_ERRORS.CLAIM_NOTHING_TO_CLAIM,
      });
      expect(prisma.lotteryClaim.create).not.toHaveBeenCalled();
      expect(prisma.lotteryPayout.updateMany).not.toHaveBeenCalled();
    });

    it('409s CLAIM_NOTHING_TO_CLAIM and rolls the claim back when fewer prizes than it read could be linked (the expiry sweep flipped one meanwhile)', async () => {
      prisma.lotteryPayout.findMany.mockResolvedValueOnce(unclaimed);
      prisma.lotteryClaim.create.mockResolvedValue(
        makeClaim({ ticketsCount: 2 }),
      );
      // Two prizes read, one still UNCLAIMED when the UPDATE re-checked.
      prisma.lotteryPayout.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        codeOf(service.request(user, { drawNo: 24 }, NOW)),
      ).resolves.toMatchObject({
        status: 409,
        code: LOTTERY_ERRORS.CLAIM_NOTHING_TO_CLAIM,
      });
      // The transaction callback threw, so the (mocked) transaction rejected:
      // the claim row created inside it is never committed.
      expect(prisma.lotteryClaim.create).toHaveBeenCalledTimes(1);
      await expect(
        prisma.$transaction.mock.results[0].value as Promise<unknown>,
      ).rejects.toMatchObject({ code: LOTTERY_ERRORS.CLAIM_NOTHING_TO_CLAIM });
      // No refreshed view is read after a failed request.
      expect(prisma.lotteryPayout.findMany).toHaveBeenCalledTimes(1);
    });

    it('answers CLAIM_ALREADY_REQUESTED when the unique (draw, customer) says a second tap lost the race', async () => {
      prisma.lotteryPayout.findMany.mockResolvedValueOnce(unclaimed);
      prisma.lotteryClaim.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(
        codeOf(service.request(user, { drawNo: 24 }, NOW)),
      ).resolves.toMatchObject({
        status: 409,
        code: LOTTERY_ERRORS.CLAIM_ALREADY_REQUESTED,
        extra: { status: 'requested' },
      });
      expect(prisma.lotteryPayout.updateMany).not.toHaveBeenCalled();
    });

    it('404s an unknown draw before taking any lock', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(null);
      await expect(
        codeOf(service.request(user, { drawNo: 99 }, NOW)),
      ).resolves.toMatchObject({
        status: 404,
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
