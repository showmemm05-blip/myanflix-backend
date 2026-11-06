import {
  LotteryClaimStatus,
  LotteryDrawStatus,
  LotteryPayoutStatus,
  LotteryResultStatus,
  Prisma,
  type LotteryClaim,
  type LotteryDraw,
  type LotteryPayout,
  type LotteryResult,
} from '../src/generated/prisma/client';
import {
  normalizePrizeGroups,
  type PrizeGroup,
  type PrizeGroupInput,
} from '../src/lottery/results/prize-groups';

/** A stable uuid for the one draw most lottery specs talk about. */
export const DRAW_ID = '33333333-3333-4333-8333-333333333333';

/** A stable uuid for that draw's results row. */
export const RESULT_ID = '55555555-5555-4555-8555-555555555555';

/**
 * One stored draw as the specs need it: draw 24 on 2026-11-01 (Thai draw
 * 07:30 UTC), sales closing an hour before, scheduled, 1000 Ks a ticket,
 * 20 per number. Override what a case cares about.
 */
export function makeDraw(overrides: Partial<LotteryDraw> = {}): LotteryDraw {
  return {
    id: DRAW_ID,
    drawNo: 24,
    thaiDrawDate: new Date('2026-11-01T00:00:00Z'),
    drawAt: new Date('2026-11-01T07:30:00Z'),
    salesCloseAt: new Date('2026-11-01T06:30:00Z'),
    status: LotteryDrawStatus.SCHEDULED,
    ticketPrice: new Prisma.Decimal(1000),
    maxPerNumber: 20,
    exchangeRate: null,
    pictureUrl: null,
    frameUrl: null,
    nextTicketSeq: 1,
    openedAt: null,
    closedAt: null,
    publishedAt: null,
    winnersCount: null,
    prizesPaidKs: null,
    prizeTotalKs: null,
    claimDeadlineAt: null,
    publishedByUserId: null,
    createdByUserId: null,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    updatedAt: new Date('2026-10-19T00:00:00Z'),
    ...overrides,
  };
}

/** A stable uuid for the one claim most claim specs talk about. */
export const CLAIM_ID = '77777777-7777-4777-8777-777777777777';

/**
 * One stored prize claim as the specs need it: user-1's three winning
 * tickets of DRAW_ID, 6,000 Baht = 450,000 Ks at 75, REQUESTED on
 * 2026-11-01 09:42 UTC. Override what a case cares about.
 */
export function makeClaim(overrides: Partial<LotteryClaim> = {}): LotteryClaim {
  return {
    id: CLAIM_ID,
    drawId: DRAW_ID,
    userId: 'user-1',
    status: LotteryClaimStatus.REQUESTED,
    ticketsCount: 3,
    baht: new Prisma.Decimal('6000.00'),
    ks: new Prisma.Decimal('450000.00'),
    rate: new Prisma.Decimal('75.0000'),
    requestedAt: new Date('2026-11-01T09:42:00Z'),
    decidedAt: null,
    decidedByUserId: null,
    rejectReason: null,
    rejectNote: null,
    transactionId: null,
    paidAtPublish: false,
    createdAt: new Date('2026-11-01T09:42:00Z'),
    updatedAt: new Date('2026-11-01T09:42:00Z'),
    ...overrides,
  };
}

/**
 * One stored payout as the specs need it: ticket t1 of DRAW_ID, user-1's,
 * back3 (4,000 Baht = 300,000 Ks at 75), awarded at publish and UNCLAIMED.
 */
export function makePayout(
  overrides: Partial<LotteryPayout> = {},
): LotteryPayout {
  return {
    id: 'payout-1',
    drawId: DRAW_ID,
    ticketId: 't1',
    userId: 'user-1',
    groups: [{ key: 'back3', name: 'Back 3 digits', baht: 4000, ks: 300_000 }],
    baht: new Prisma.Decimal('4000.00'),
    ks: new Prisma.Decimal('300000.00'),
    rate: new Prisma.Decimal('75.0000'),
    transactionId: null,
    status: LotteryPayoutStatus.UNCLAIMED,
    claimId: null,
    createdAt: new Date('2026-11-01T09:00:05Z'),
    ...overrides,
  };
}

/** `count` distinct six-digit numbers that never collide across the groups below. */
function sixDigit(base: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    String(base + i * 7919)
      .padStart(6, '0')
      .slice(-6),
  );
}

/**
 * The groups of a full sheet, with the numbers of
 * test/fixtures/thai-lotto-results.json: first prize 123456 (near
 * 123455 / 123457), front3 123 / 987, back3 456 / 001, back2 56 — so
 * ticket 123456 wins first, front3, back3 and back2 at once. Override one
 * group to build a case.
 */
export function sheetInputs(
  overrides: Partial<Record<string, Partial<PrizeGroupInput>>> = {},
): PrizeGroupInput[] {
  const base: PrizeGroupInput[] = [
    { key: 'first', baht: 6_000_000, numbers: ['123456'] },
    { key: 'nearFirst', baht: 100_000, numbers: ['123455', '123457'] },
    { key: 'second', baht: 200_000, numbers: sixDigit(200_100, 5) },
    { key: 'third', baht: 80_000, numbers: sixDigit(300_100, 10) },
    { key: 'fourth', baht: 40_000, numbers: sixDigit(400_100, 50) },
    { key: 'fifth', baht: 20_000, numbers: sixDigit(500_100, 100) },
    { key: 'front3', baht: 4_000, numbers: ['123', '987'] },
    { key: 'back3', baht: 4_000, numbers: ['456', '001'] },
    { key: 'back2', baht: 2_000, numbers: ['56'] },
  ];
  return base.map((group) => ({ ...group, ...overrides[group.key] }));
}

/** The same sheet as stored in lottery_results.groups. */
export function makeSheet(
  overrides: Partial<Record<string, Partial<PrizeGroupInput>>> = {},
): PrizeGroup[] {
  return normalizePrizeGroups(sheetInputs(overrides));
}

/** One stored results row: PENDING and empty unless a case says otherwise. */
export function makeResult(
  overrides: Partial<LotteryResult> = {},
): LotteryResult {
  return {
    id: RESULT_ID,
    drawId: DRAW_ID,
    status: LotteryResultStatus.PENDING,
    source: null,
    fetchedAt: null,
    enteredByUserId: null,
    raw: null,
    groups: [],
    sourceDate: null,
    lastError: null,
    attempts: 0,
    createdAt: new Date('2026-11-01T07:35:00Z'),
    updatedAt: new Date('2026-11-01T07:35:00Z'),
    ...overrides,
  };
}
