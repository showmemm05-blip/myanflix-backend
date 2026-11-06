import { Logger } from '@nestjs/common';
import {
  LotteryDrawStatus,
  LotteryResultStatus,
} from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  makeDraw,
  makeResult,
  makeSheet,
} from '../../../test/lottery-fixtures';
import type { LotteryDrawCloserService } from '../lottery-draw-closer.service';
import {
  LotteryResultsFetcherService,
  RESULTS_FETCH_WINDOW_MS,
} from './lottery-results-fetcher.service';
import type { LotteryResultsService } from './lottery-results.service';
import type { ResultsFetchOutcome } from './results-source';

const NOW = new Date('2026-11-01T07:45:00Z');

const matched: ResultsFetchOutcome = {
  ok: true,
  sourceDate: '2026-11-01',
  matches: true,
  raw: {},
  groups: makeSheet(),
  warnings: [],
};

describe('LotteryResultsFetcherService', () => {
  let prisma: {
    lotteryDraw: Record<'findMany' | 'findUnique', jest.Mock>;
  };
  let results: Record<
    'configuredSource' | 'getOrCreateRow' | 'applyOutcome',
    jest.Mock
  >;
  let closer: { closeOne: jest.Mock };
  let source: { fetch: jest.Mock };
  let service: LotteryResultsFetcherService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    source = { fetch: jest.fn().mockResolvedValue(matched) };
    prisma = {
      lotteryDraw: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
      },
    };
    results = {
      configuredSource: jest.fn().mockResolvedValue(source),
      getOrCreateRow: jest.fn().mockResolvedValue(makeResult()),
      applyOutcome: jest
        .fn()
        .mockResolvedValue({ row: makeResult(), applied: 'fetched' }),
    };
    closer = { closeOne: jest.fn().mockResolvedValue(true) };
    service = new LotteryResultsFetcherService(
      prisma as unknown as PrismaService,
      results as unknown as LotteryResultsService,
      closer as unknown as LotteryDrawCloserService,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('does nothing at all when no results source is set', async () => {
    results.configuredSource.mockResolvedValue(null);
    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 0,
      pending: 0,
      failed: 0,
    });
    expect(prisma.lotteryDraw.findMany).not.toHaveBeenCalled();
  });

  it('asks the source for every closed draw past its draw time whose sheet is pending, storing the answer as a system row', async () => {
    const draw = makeDraw({ status: LotteryDrawStatus.CLOSED });
    prisma.lotteryDraw.findMany.mockResolvedValue([draw]);

    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 1,
      pending: 0,
      failed: 0,
    });

    // Only draws of the last seven days: an older one the source never
    // shows is not asked every five minutes for ever ("Fetch now" still can).
    expect(RESULTS_FETCH_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(prisma.lotteryDraw.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['OPEN', 'PAUSED', 'CLOSED'] },
        drawAt: { lte: NOW, gte: new Date('2026-10-25T07:45:00Z') },
      },
      orderBy: { drawAt: 'asc' },
    });
    expect(closer.closeOne).not.toHaveBeenCalled();
    expect(results.getOrCreateRow).toHaveBeenCalledWith(draw.id);
    expect(source.fetch).toHaveBeenCalledWith('2026-11-01');
    expect(results.applyOutcome).toHaveBeenCalledWith(
      draw,
      makeResult(),
      matched,
      { actor: null, trigger: 'cron', now: NOW },
    );
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Results for Draw 24 (2026-11-01) fetched',
    );
  });

  it('closes a draw still selling at its draw time first, then fetches for the closed draw', async () => {
    const open = makeDraw({ status: LotteryDrawStatus.OPEN });
    const closed = { ...open, status: LotteryDrawStatus.CLOSED, closedAt: NOW };
    prisma.lotteryDraw.findMany.mockResolvedValue([open]);
    prisma.lotteryDraw.findUnique.mockResolvedValue(closed);

    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 1,
      fetched: 1,
      pending: 0,
      failed: 0,
    });
    expect(closer.closeOne).toHaveBeenCalledWith(open, NOW, 'draw_time');
    expect(results.applyOutcome).toHaveBeenCalledWith(
      closed,
      expect.anything(),
      matched,
      expect.anything(),
    );
  });

  it('skips a selling draw that a staff member published in between (the re-read is not CLOSED)', async () => {
    prisma.lotteryDraw.findMany.mockResolvedValue([
      makeDraw({ status: LotteryDrawStatus.PAUSED }),
    ]);
    closer.closeOne.mockResolvedValue(false);
    prisma.lotteryDraw.findUnique.mockResolvedValue(
      makeDraw({ status: LotteryDrawStatus.PUBLISHED }),
    );
    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 0,
      pending: 0,
      failed: 0,
    });
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it('leaves a sheet already in (FETCHED) and a published one alone, but retries FAILED', async () => {
    prisma.lotteryDraw.findMany.mockResolvedValue([
      makeDraw({ id: 'd1', status: LotteryDrawStatus.CLOSED }),
      makeDraw({ id: 'd2', drawNo: 25, status: LotteryDrawStatus.CLOSED }),
      makeDraw({ id: 'd3', drawNo: 26, status: LotteryDrawStatus.CLOSED }),
    ]);
    results.getOrCreateRow
      .mockResolvedValueOnce(
        makeResult({ status: LotteryResultStatus.FETCHED }),
      )
      .mockResolvedValueOnce(
        makeResult({ status: LotteryResultStatus.PUBLISHED }),
      )
      .mockResolvedValueOnce(
        makeResult({ status: LotteryResultStatus.FAILED }),
      );

    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 1,
      pending: 0,
      failed: 0,
    });
    expect(source.fetch).toHaveBeenCalledTimes(1);
    expect(results.applyOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd3' }),
      expect.anything(),
      matched,
      expect.anything(),
    );
  });

  it('counts a draw the source does not show yet as pending and a failed fetch as failed, with a warning', async () => {
    prisma.lotteryDraw.findMany.mockResolvedValue([
      makeDraw({ id: 'd1', status: LotteryDrawStatus.CLOSED }),
      makeDraw({ id: 'd2', drawNo: 25, status: LotteryDrawStatus.CLOSED }),
    ]);
    const notYet: ResultsFetchOutcome = {
      ...matched,
      sourceDate: '2026-10-16',
      matches: false,
    };
    const failed: ResultsFetchOutcome = { ok: false, error: 'answered 503' };
    source.fetch.mockResolvedValueOnce(notYet).mockResolvedValueOnce(failed);
    results.applyOutcome
      .mockResolvedValueOnce({ row: makeResult(), applied: 'not_yet' })
      .mockResolvedValueOnce({ row: makeResult(), applied: 'failed' });

    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 0,
      pending: 1,
      failed: 1,
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Results for Draw 25 (2026-11-01) not fetched: answered 503',
    );
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('never throws: one draw blowing up is logged and the next draw is still tried', async () => {
    prisma.lotteryDraw.findMany.mockResolvedValue([
      makeDraw({ id: 'd1', status: LotteryDrawStatus.CLOSED }),
      makeDraw({ id: 'd2', drawNo: 25, status: LotteryDrawStatus.CLOSED }),
    ]);
    results.getOrCreateRow
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(makeResult());

    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 1,
      pending: 0,
      failed: 0,
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Could not fetch results for Draw 24 (2026-11-01): db down',
    );
  });

  it('never throws when the settings or the draw list cannot be read', async () => {
    results.configuredSource.mockRejectedValue(new Error('no settings'));
    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 0,
      pending: 0,
      failed: 0,
    });
    results.configuredSource.mockResolvedValue(source);
    prisma.lotteryDraw.findMany.mockRejectedValue(new Error('db down'));
    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 0,
      pending: 0,
      failed: 0,
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Could not list lottery draws due for results: db down',
    );
  });

  it('runs one sweep at a time: a tick that lands while a sweep is still going does nothing', async () => {
    // The first sweep is held at the source; the second tick returns the
    // zero sweep at once and never touches the source; the first finishes.
    let release: (outcome: ResultsFetchOutcome) => void = () => undefined;
    source.fetch.mockReturnValue(
      new Promise<ResultsFetchOutcome>((resolve) => {
        release = resolve;
      }),
    );
    prisma.lotteryDraw.findMany.mockResolvedValue([
      makeDraw({ status: LotteryDrawStatus.CLOSED }),
    ]);

    const first = service.fetchDueResults(NOW);
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.fetch).toHaveBeenCalledTimes(1);

    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 0,
      pending: 0,
      failed: 0,
    });
    expect(prisma.lotteryDraw.findMany).toHaveBeenCalledTimes(1);
    expect(source.fetch).toHaveBeenCalledTimes(1);

    release(matched);
    await expect(first).resolves.toEqual({
      closed: 0,
      fetched: 1,
      pending: 0,
      failed: 0,
    });
    expect(results.applyOutcome).toHaveBeenCalledTimes(1);

    // Once it is over, the next tick sweeps again.
    source.fetch.mockResolvedValue(matched);
    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 1,
      pending: 0,
      failed: 0,
    });
  });

  it('lets go of the in-flight guard when a sweep blows up', async () => {
    results.configuredSource.mockRejectedValueOnce(new Error('no settings'));
    await service.fetchDueResults(NOW);
    prisma.lotteryDraw.findMany.mockResolvedValue([
      makeDraw({ status: LotteryDrawStatus.CLOSED }),
    ]);
    await expect(service.fetchDueResults(NOW)).resolves.toEqual({
      closed: 0,
      fetched: 1,
      pending: 0,
      failed: 0,
    });
  });

  it('the cron tick runs the sweep for the current moment', async () => {
    const sweep = jest
      .spyOn(service, 'fetchDueResults')
      .mockResolvedValue({ closed: 0, fetched: 0, pending: 0, failed: 0 });
    await service.tick();
    expect(sweep).toHaveBeenCalledWith(expect.any(Date));
  });
});
