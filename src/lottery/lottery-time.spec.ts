import {
  dateOnly,
  drawAtFor,
  isCalendarDate,
  minutesBefore,
  myanmarYymmdd,
  toDateString,
} from './lottery-time';
import { purchaseRef, ticketNo, nextPurchaseRefSeq } from './lottery-refs';
import { heldCounts, leftToBuy, offSaleNumbers } from './lottery-holdings';

describe('lottery time', () => {
  it('accepts only real calendar dates written YYYY-MM-DD', () => {
    expect(isCalendarDate('2026-11-01')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-1-1')).toBe(false);
    expect(isCalendarDate('2026-11-01T00:00:00Z')).toBe(false);
    expect(isCalendarDate(20261101)).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
  });

  it('puts the Thai draw at 14:30 Bangkok = 07:30 UTC on the draw date', () => {
    expect(drawAtFor('2026-11-01').toISOString()).toBe(
      '2026-11-01T07:30:00.000Z',
    );
    expect(drawAtFor('2026-12-16').toISOString()).toBe(
      '2026-12-16T07:30:00.000Z',
    );
  });

  it('round-trips a date-only column through midnight UTC', () => {
    const stored = dateOnly('2026-11-01');
    expect(stored.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(toDateString(stored)).toBe('2026-11-01');
  });

  it('subtracts whole minutes', () => {
    expect(
      minutesBefore(new Date('2026-11-01T07:30:00Z'), 60).toISOString(),
    ).toBe('2026-11-01T06:30:00.000Z');
    expect(
      minutesBefore(new Date('2026-11-01T07:30:00Z'), 0).toISOString(),
    ).toBe('2026-11-01T07:30:00.000Z');
  });

  it('dates a purchase ref in Myanmar time (UTC+6:30), not UTC', () => {
    // 17:29:59 UTC is still the 19th in Yangon; 17:30 UTC is the 20th.
    expect(myanmarYymmdd(new Date('2026-10-19T17:29:59Z'))).toBe('261019');
    expect(myanmarYymmdd(new Date('2026-10-19T17:30:00Z'))).toBe('261020');
    expect(myanmarYymmdd(new Date('2026-01-05T00:00:00Z'))).toBe('260105');
  });
});

describe('lottery refs', () => {
  it('builds a purchase ref from the Myanmar date and a 4+ digit sequence value', () => {
    const at = new Date('2026-10-19T17:30:00Z');
    expect(purchaseRef(42, at)).toBe('LP-261020-0042');
    expect(purchaseRef(BigInt(7), at)).toBe('LP-261020-0007');
    expect(purchaseRef(12345, at)).toBe('LP-261020-12345');
  });

  it('builds a ticket number from the draw number and a 6-digit seq', () => {
    expect(ticketNo(24, 468)).toBe('MFL-24-000468');
    expect(ticketNo(3, 1)).toBe('MFL-3-000001');
    expect(ticketNo(120, 1234567)).toBe('MFL-120-1234567');
  });

  it("reads the next sequence value through the caller's transaction client", async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ seq: BigInt(9) }]) };
    await expect(nextPurchaseRefSeq(tx)).resolves.toBe(9);
    const [strings] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join('')).toContain("nextval('lottery_purchase_ref_seq')");
  });
});

describe('lottery holdings', () => {
  it("counts the caller's tickets per number, leaving unheld numbers out", async () => {
    const client = {
      lotteryTicket: {
        groupBy: jest.fn().mockResolvedValue([
          { number: '123456', _count: { _all: 3 } },
          { number: '000001', _count: { _all: 20 } },
        ]),
      },
    };
    const held = await heldCounts(client as never, 'user-1', 'draw-1', [
      '123456',
      '000001',
      '999999',
    ]);
    expect([...held.entries()]).toEqual([
      ['123456', 3],
      ['000001', 20],
    ]);
    expect(client.lotteryTicket.groupBy).toHaveBeenCalledWith({
      by: ['number'],
      where: {
        userId: 'user-1',
        drawId: 'draw-1',
        number: { in: ['123456', '000001', '999999'] },
      },
      _count: { _all: true },
    });
  });

  it('asks nothing for an empty list', async () => {
    const client = { lotteryTicket: { groupBy: jest.fn() } };
    expect(
      (await heldCounts(client as never, 'user-1', 'draw-1', [])).size,
    ).toBe(0);
    expect(client.lotteryTicket.groupBy).not.toHaveBeenCalled();
    const offSale = { lotteryOffSaleNumber: { findMany: jest.fn() } };
    expect((await offSaleNumbers(offSale as never, 'draw-1', [])).size).toBe(0);
    expect(offSale.lotteryOffSaleNumber.findMany).not.toHaveBeenCalled();
  });

  it('computes what is left to buy: limit minus held, never negative, 0 when off sale', () => {
    expect(leftToBuy(20, 0, false)).toBe(20);
    expect(leftToBuy(20, 17, false)).toBe(3);
    expect(leftToBuy(20, 20, false)).toBe(0);
    expect(leftToBuy(20, 25, false)).toBe(0);
    expect(leftToBuy(20, 0, true)).toBe(0);
  });
});
