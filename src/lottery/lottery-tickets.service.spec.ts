import { Test, TestingModule } from '@nestjs/testing';
import {
  LotteryPayoutStatus,
  LotteryTicketStatus,
  Prisma,
} from '../generated/prisma/client';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { PrismaService } from '../prisma/prisma.service';
import { DRAW_ID } from '../../test/lottery-fixtures';
import { LOTTERY_ERRORS } from './lottery-errors';
import {
  LotteryTicketsService,
  ticketClaimStatus,
} from './lottery-tickets.service';

const USER_ID = 'user-1';

function makeStoredTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ticket-1',
    ticketNo: 'MFL-24-000468',
    drawId: DRAW_ID,
    purchaseId: 'purchase-1',
    userId: USER_ID,
    number: '000777',
    seq: 468,
    status: LotteryTicketStatus.WAITING,
    prizeKs: null,
    createdAt: new Date('2026-10-20T10:00:00Z'),
    draw: { drawNo: 24 },
    purchase: { ref: 'LP-261020-0042' },
    payout: null,
    ...overrides,
  };
}

describe('LotteryTicketsService', () => {
  let service: LotteryTicketsService;
  let prisma: {
    lotteryTicket: Record<'findMany' | 'count' | 'findFirst', jest.Mock>;
  };

  beforeEach(async () => {
    prisma = {
      lotteryTicket: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryTicketsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(LotteryTicketsService);
  });

  describe('list', () => {
    it('pages the caller’s own tickets newest first, with the draw number and the purchase ref', async () => {
      prisma.lotteryTicket.findMany.mockResolvedValue([makeStoredTicket()]);
      prisma.lotteryTicket.count.mockResolvedValue(468);

      const page = await service.list(USER_ID, { page: 3, pageSize: 200 });

      expect(prisma.lotteryTicket.findMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
        skip: 400,
        take: 200,
        include: {
          draw: { select: { drawNo: true } },
          purchase: { select: { ref: true } },
          payout: { select: { groups: true, status: true } },
        },
      });
      expect(prisma.lotteryTicket.count).toHaveBeenCalledWith({
        where: { userId: USER_ID },
      });
      expect(page).toEqual({
        items: [
          {
            ticketNo: 'MFL-24-000468',
            drawNo: 24,
            number: '000777',
            status: 'waiting',
            prizeKs: null,
            wonGroups: null,
            claimStatus: null,
            purchaseRef: 'LP-261020-0042',
            boughtAt: new Date('2026-10-20T10:00:00Z'),
          },
        ],
        total: 468,
        page: 3,
        pageSize: 200,
      });
    });

    it('narrows to one draw by draw number and defaults to page 1 of 20', async () => {
      await service.list(USER_ID, { drawNo: 24 });

      expect(prisma.lotteryTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID, draw: { drawNo: 24 } },
          skip: 0,
          take: 20,
        }),
      );
      expect(prisma.lotteryTicket.count).toHaveBeenCalledWith({
        where: { userId: USER_ID, draw: { drawNo: 24 } },
      });
    });

    it('maps a decided ticket: WON with its prize and the groups it won, NOT_WON as "notwon" with no groups', async () => {
      prisma.lotteryTicket.findMany.mockResolvedValue([
        makeStoredTicket({
          status: LotteryTicketStatus.WON,
          prizeKs: new Prisma.Decimal('450000.00'),
          payout: {
            groups: [
              {
                key: 'first',
                name: 'First prize',
                baht: 6_000_000,
                ks: 450_000_000,
              },
              { key: 'back2', name: 'Back 2 digits', baht: 2000, ks: 150_000 },
            ],
          },
        }),
        makeStoredTicket({
          ticketNo: 'MFL-24-000469',
          status: LotteryTicketStatus.NOT_WON,
        }),
      ]);

      const page = await service.list(USER_ID, {});

      expect(page.items.map((t) => [t.status, t.prizeKs, t.wonGroups])).toEqual(
        [
          [
            'won',
            450000,
            [
              { key: 'first', name: 'First prize', ks: 450_000_000 },
              { key: 'back2', name: 'Back 2 digits', ks: 150_000 },
            ],
          ],
          ['notwon', null, []],
        ],
      );
    });

    it('maps a won ticket’s claimStatus from its payout status, and null for a ticket that is waiting or did not win', async () => {
      const won = (status: LotteryPayoutStatus) =>
        makeStoredTicket({
          status: LotteryTicketStatus.WON,
          prizeKs: new Prisma.Decimal('300000.00'),
          payout: { groups: [], status },
        });
      prisma.lotteryTicket.findMany.mockResolvedValue([
        won(LotteryPayoutStatus.UNCLAIMED),
        won(LotteryPayoutStatus.REQUESTED),
        won(LotteryPayoutStatus.PAID),
        won(LotteryPayoutStatus.REJECTED),
        won(LotteryPayoutStatus.EXPIRED),
        makeStoredTicket({ status: LotteryTicketStatus.NOT_WON }),
        makeStoredTicket(),
      ]);

      const page = await service.list(USER_ID, {});

      expect(page.items.map((t) => t.claimStatus)).toEqual([
        'not_requested',
        'requested',
        'paid',
        'rejected',
        'expired',
        null,
        null,
      ]);
      expect(ticketClaimStatus(LotteryTicketStatus.WON, null)).toBeNull();
    });
  });

  describe('findOne', () => {
    it('reads one of the caller’s tickets by number', async () => {
      prisma.lotteryTicket.findFirst.mockResolvedValue(makeStoredTicket());

      await expect(
        service.findOne(USER_ID, 'MFL-24-000468'),
      ).resolves.toMatchObject({
        ticketNo: 'MFL-24-000468',
        drawNo: 24,
        purchaseRef: 'LP-261020-0042',
      });
      expect(prisma.lotteryTicket.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ticketNo: 'MFL-24-000468', userId: USER_ID },
        }),
      );
    });

    it('404s someone else’s ticket exactly like a missing one', async () => {
      prisma.lotteryTicket.findFirst.mockResolvedValue(null);

      await expect(
        service.findOne('user-2', 'MFL-24-000468'),
      ).rejects.toMatchObject({
        code: LOTTERY_ERRORS.TICKET_NOT_FOUND,
        status: 404,
      });
      await expect(
        service.findOne('user-2', 'MFL-24-000468'),
      ).rejects.toBeInstanceOf(CodedHttpException);
      expect(prisma.lotteryTicket.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ticketNo: 'MFL-24-000468', userId: 'user-2' },
        }),
      );
    });
  });
});
