import { Logger } from '@nestjs/common';
import { LotteryDrawStatus } from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { LotteryDrawCloserService } from './lottery-draw-closer.service';
import { makeDraw } from '../../test/lottery-fixtures';

describe('LotteryDrawCloserService', () => {
  let prisma: {
    lotteryDraw: Record<
      'findMany' | 'updateMany' | 'findUniqueOrThrow',
      jest.Mock
    >;
    $transaction: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let service: LotteryDrawCloserService;
  const now = new Date('2026-11-01T06:30:00Z');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma = {
      lotteryDraw: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new LotteryDrawCloserService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('closes every open or paused draw whose sales time has passed, one guarded update each, with a system audit row', async () => {
    const open = makeDraw({ status: LotteryDrawStatus.OPEN });
    const paused = makeDraw({
      id: 'draw-2',
      drawNo: 25,
      status: LotteryDrawStatus.PAUSED,
    });
    prisma.lotteryDraw.findMany.mockResolvedValue([open, paused]);
    prisma.lotteryDraw.findUniqueOrThrow
      .mockResolvedValueOnce({ ...open, status: LotteryDrawStatus.CLOSED })
      .mockResolvedValueOnce({ ...paused, status: LotteryDrawStatus.CLOSED });

    await expect(service.closeDueDraws(now)).resolves.toBe(2);

    expect(prisma.lotteryDraw.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['OPEN', 'PAUSED'] }, salesCloseAt: { lte: now } },
      orderBy: { drawNo: 'asc' },
    });
    expect(prisma.lotteryDraw.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.lotteryDraw.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: open.id, status: { in: ['OPEN', 'PAUSED'] } },
      data: { status: 'CLOSED', closedAt: now },
    });
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'lottery_draw.close',
        actor: null,
        target: {
          type: 'lottery_draw',
          id: 'draw-2',
          label: 'Draw 25 (2026-11-01)',
        },
        before: expect.objectContaining({ status: 'PAUSED' }),
        after: expect.objectContaining({ status: 'CLOSED' }),
        metadata: { trigger: 'sales_close' },
        tx: prisma,
      }),
    );
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Closed 2 lottery draw(s) whose sales time passed',
    );
  });

  it('closes a reopened draw again at its close time, stamping a fresh closedAt', async () => {
    const reopened = makeDraw({
      status: LotteryDrawStatus.OPEN,
      openedAt: new Date('2026-10-20T00:00:00Z'),
      closedAt: null,
    });
    prisma.lotteryDraw.findMany.mockResolvedValue([reopened]);
    prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue({
      ...reopened,
      status: LotteryDrawStatus.CLOSED,
      closedAt: now,
    });

    await expect(service.closeDueDraws(now)).resolves.toBe(1);
    expect(prisma.lotteryDraw.updateMany).toHaveBeenCalledWith({
      where: { id: reopened.id, status: { in: ['OPEN', 'PAUSED'] } },
      data: { status: 'CLOSED', closedAt: now },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'lottery_draw.close',
        actor: null,
        before: expect.objectContaining({ status: 'OPEN' }),
        after: expect.objectContaining({ status: 'CLOSED' }),
        metadata: { trigger: 'sales_close' },
      }),
    );
  });

  it('does not count a draw a staff member closed first (the guarded update matched nothing)', async () => {
    prisma.lotteryDraw.findMany.mockResolvedValue([
      makeDraw({ status: LotteryDrawStatus.OPEN }),
    ]);
    prisma.lotteryDraw.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.closeDueDraws(now)).resolves.toBe(0);
    expect(audit.record).not.toHaveBeenCalled();
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('is quiet when nothing is due', async () => {
    await expect(service.closeDueDraws(now)).resolves.toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('never throws: a database error is logged and the count so far returned', async () => {
    prisma.lotteryDraw.findMany.mockRejectedValue(new Error('db down'));
    await expect(service.closeDueDraws(now)).resolves.toBe(0);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Could not close due lottery draws: db down',
    );
  });

  it('the cron tick runs the sweep for the current moment', async () => {
    const sweep = jest.spyOn(service, 'closeDueDraws').mockResolvedValue(0);
    await service.tick();
    expect(sweep).toHaveBeenCalledWith(expect.any(Date));
  });
});
