import { Logger } from '@nestjs/common';
import { LotteryPayoutStatus } from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { LotteryClaimExpiryService } from './lottery-claim-expiry.service';

describe('LotteryClaimExpiryService', () => {
  let prisma: { lotteryPayout: Record<'updateMany', jest.Mock> };
  let service: LotteryClaimExpiryService;
  const now = new Date('2027-01-30T10:00:00Z');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma = {
      lotteryPayout: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    service = new LotteryClaimExpiryService(prisma as unknown as PrismaService);
  });
  afterEach(() => jest.restoreAllMocks());

  it('expires only the UNCLAIMED prizes whose draw’s claim deadline has passed, in one update, and logs the count', async () => {
    prisma.lotteryPayout.updateMany.mockResolvedValue({ count: 4 });

    await expect(service.run(now)).resolves.toBe(4);

    expect(prisma.lotteryPayout.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.lotteryPayout.updateMany).toHaveBeenCalledWith({
      where: {
        status: LotteryPayoutStatus.UNCLAIMED,
        draw: { claimDeadlineAt: { lte: now } },
      },
      data: { status: LotteryPayoutStatus.EXPIRED },
    });
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Expired 4 unclaimed lottery prize(s) past their claim deadline',
    );
  });

  it('never touches a REQUESTED, PAID or REJECTED prize — the WHERE names UNCLAIMED alone', async () => {
    await service.run(now);
    const call = prisma.lotteryPayout.updateMany.mock.calls[0][0] as {
      where: { status: unknown };
    };
    expect(call.where.status).toBe(LotteryPayoutStatus.UNCLAIMED);
  });

  it('is quiet when nothing is due', async () => {
    await expect(service.run(now)).resolves.toBe(0);
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('never throws: a database error is logged and 0 returned', async () => {
    prisma.lotteryPayout.updateMany.mockRejectedValue(new Error('db down'));
    await expect(service.run(now)).resolves.toBe(0);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Could not expire unclaimed lottery prizes: db down',
    );
  });

  it('the hourly tick runs the sweep for the current moment', async () => {
    const sweep = jest.spyOn(service, 'run').mockResolvedValue(0);
    await service.tick();
    expect(sweep).toHaveBeenCalledWith(expect.any(Date));
  });
});
