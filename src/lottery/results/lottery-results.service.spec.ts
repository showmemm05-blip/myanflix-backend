import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import {
  LotteryDrawStatus,
  LotteryResultSource,
  LotteryResultStatus,
  Prisma,
  Role,
} from '../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import { CodedHttpException } from '../../common/errors/coded-http.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DRAW_ID,
  makeDraw,
  makeResult,
  makeSheet,
  RESULT_ID,
  sheetInputs,
} from '../../../test/lottery-fixtures';
import { LOTTERY_ERRORS } from '../lottery-errors';
import { LotterySettingsService } from '../lottery-settings.service';
import { LotteryResultsSourceFactory } from './lottery-results-source.factory';
import {
  bangkokDate,
  LotteryResultsService,
  resultSourceToWire,
  resultStatusToWire,
} from './lottery-results.service';
import type { ResultsFetchOutcome } from './results-source';

type RawCall = [TemplateStringsArray, ...unknown[]];

const admin = {
  id: 'admin-1',
  username: 'admin.blake',
  role: Role.ADMIN,
  appRoleId: null,
};

const NOW = new Date('2026-11-01T07:40:00Z');

const SETTINGS = {
  id: 'settings-1',
  ticketPrice: new Prisma.Decimal(1000),
  maxPerNumber: 20,
  exchangeRate: new Prisma.Decimal('75'),
  salesCloseMinutesBefore: 60,
  frameUrl: null,
  resultsUrl: 'https://lotto.example/latest',
  resultsSourceKind: 'thai_lotto_json',
  updatedByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
  updatedBy: null,
};

const fetched = (overrides: Partial<ResultsFetchOutcome> = {}) =>
  ({
    ok: true,
    sourceDate: '2026-11-01',
    matches: true,
    raw: { status: 'success' },
    groups: makeSheet(),
    warnings: [],
    ...overrides,
  }) as ResultsFetchOutcome;

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CodedHttpException
        ? { status: error.getStatus(), code: error.code, extra: error.extra }
        : error,
  );

describe('LotteryResultsService', () => {
  let service: LotteryResultsService;
  let prisma: {
    lotteryDraw: Record<'findUnique' | 'findUniqueOrThrow', jest.Mock>;
    lotteryResult: Record<'upsert' | 'update' | 'findUniqueOrThrow', jest.Mock>;
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let settings: { getOrCreate: jest.Mock };
  let source: { fetch: jest.Mock };
  let sources: { create: jest.Mock };

  /** The draw's row lock, as a fetch write and a manual entry take it before re-reading. */
  const expectDrawLocked = () => {
    const [call] = prisma.$queryRaw.mock.calls as RawCall[];
    expect(call[0].join('?')).toContain(
      'SELECT "id" FROM "lottery_draws" WHERE "id" = ? FOR UPDATE',
    );
    expect(call[1]).toBe(DRAW_ID);
  };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma = {
      lotteryDraw: {
        findUnique: jest
          .fn()
          .mockResolvedValue(makeDraw({ status: LotteryDrawStatus.CLOSED })),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue(makeDraw({ status: LotteryDrawStatus.CLOSED })),
      },
      lotteryResult: {
        upsert: jest
          .fn()
          .mockResolvedValue({ ...makeResult(), enteredBy: null }),
        update: jest.fn().mockResolvedValue(makeResult()),
        // The row as it is under the lock: the row handed in, unless a case says it changed meanwhile.
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeResult()),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    settings = { getOrCreate: jest.fn().mockResolvedValue(SETTINGS) };
    source = { fetch: jest.fn().mockResolvedValue(fetched()) };
    sources = { create: jest.fn().mockReturnValue(source) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryResultsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: LotterySettingsService, useValue: settings },
        { provide: LotteryResultsSourceFactory, useValue: sources },
      ],
    }).compile();
    service = module.get(LotteryResultsService);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('get', () => {
    it('makes the row on first read (PENDING, empty sheet) and prices nothing', async () => {
      const view = await service.get(DRAW_ID);
      expect(prisma.lotteryResult.upsert).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID },
        create: { drawId: DRAW_ID },
        update: {},
        include: {
          enteredBy: {
            select: { id: true, username: true, displayName: true },
          },
        },
      });
      expect(view).toEqual({
        drawId: DRAW_ID,
        drawNo: 24,
        thaiDrawDate: '2026-11-01',
        status: 'pending',
        source: null,
        fetchedAt: null,
        sourceDate: null,
        lastError: null,
        attempts: 0,
        enteredBy: null,
        rate: 75,
        groups: [],
        complete: false,
        publishedAt: null,
        updatedAt: makeResult().updatedAt,
      });
    });

    it('404s an unknown draw', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(null);
      await expect(codeOf(service.get(DRAW_ID))).resolves.toEqual(
        expect.objectContaining({
          status: 404,
          code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
        }),
      );
    });

    it('shows a fetched sheet with every group priced at the settings rate, and the draw rate once published', async () => {
      prisma.lotteryResult.upsert.mockResolvedValue({
        ...makeResult({
          status: LotteryResultStatus.FETCHED,
          source: LotteryResultSource.API,
          groups: makeSheet() as unknown as Prisma.JsonValue,
          sourceDate: '2026-11-01',
          fetchedAt: NOW,
          attempts: 2,
        }),
        enteredBy: null,
      });
      const view = await service.get(DRAW_ID);
      expect(view).toEqual(
        expect.objectContaining({
          status: 'fetched',
          source: 'api',
          complete: true,
          rate: 75,
          attempts: 2,
        }),
      );
      expect(view.groups[0]).toEqual({
        ...makeSheet()[0],
        ks: 450_000_000,
      });
      expect(view.groups).toHaveLength(9);

      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({
          status: LotteryDrawStatus.PUBLISHED,
          exchangeRate: new Prisma.Decimal('80'),
          publishedAt: NOW,
        }),
      );
      const published = await service.get(DRAW_ID);
      expect(published.rate).toBe(80);
      expect(published.groups[8].ks).toBe(160_000);
      expect(published.publishedAt).toEqual(NOW);
    });

    it('names the staff member who entered a sheet by hand', async () => {
      prisma.lotteryResult.upsert.mockResolvedValue({
        ...makeResult({
          status: LotteryResultStatus.FETCHED,
          source: LotteryResultSource.MANUAL,
          groups: makeSheet() as unknown as Prisma.JsonValue,
          enteredByUserId: admin.id,
        }),
        enteredBy: {
          id: admin.id,
          username: admin.username,
          displayName: 'Blake',
        },
      });
      const view = await service.get(DRAW_ID);
      expect(view.source).toBe('manual');
      expect(view.enteredBy).toEqual({ id: admin.id, label: 'Blake' });
    });
  });

  describe('applyOutcome', () => {
    const draw = makeDraw({ status: LotteryDrawStatus.CLOSED });

    it('stores a matching sheet as FETCHED from the API with one audit row, actor as given', async () => {
      const row = makeResult({
        status: LotteryResultStatus.FAILED,
        attempts: 2,
        lastError: 'old',
      });
      const after = makeResult({
        status: LotteryResultStatus.FETCHED,
        source: LotteryResultSource.API,
        attempts: 3,
      });
      prisma.lotteryResult.findUniqueOrThrow.mockResolvedValue(row);
      prisma.lotteryResult.update.mockResolvedValue(after);

      const outcome = fetched({ warnings: ['near first off'] });
      await expect(
        service.applyOutcome(draw, row, outcome, {
          actor: null,
          trigger: 'cron',
          now: NOW,
        }),
      ).resolves.toEqual({ row: after, applied: 'fetched' });

      // One transaction: the draw's row lock, the row re-read under it, the write, the audit row.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expectDrawLocked();
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryResult.findUniqueOrThrow.mock.invocationCallOrder[0],
      );
      expect(prisma.lotteryResult.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: RESULT_ID },
      });
      expect(prisma.lotteryResult.update).toHaveBeenCalledWith({
        where: { id: RESULT_ID },
        data: {
          status: 'FETCHED',
          source: 'API',
          groups: makeSheet(),
          raw: { status: 'success' },
          sourceDate: '2026-11-01',
          fetchedAt: NOW,
          enteredByUserId: null,
          lastError: null,
          attempts: { increment: 1 },
        },
      });
      expect(audit.record).toHaveBeenCalledWith({
        action: 'lottery_results.fetch',
        actor: null,
        target: {
          type: 'lottery_results',
          id: RESULT_ID,
          label: 'Draw 24 (2026-11-01)',
        },
        before: expect.objectContaining({ status: 'FAILED', lastError: 'old' }),
        after: expect.objectContaining({ status: 'FETCHED', source: 'API' }),
        metadata: {
          trigger: 'cron',
          sourceDate: '2026-11-01',
          warnings: ['near first off'],
        },
        tx: prisma,
      });
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        'Results for Draw 24 (2026-11-01): near first off',
      );
    });

    it('leaves a PENDING row pending when the source still shows another date, counting the try', async () => {
      const row = makeResult();
      const after = makeResult({ attempts: 1, lastError: 'x' });
      prisma.lotteryResult.update.mockResolvedValue(after);

      await expect(
        service.applyOutcome(
          draw,
          row,
          fetched({ sourceDate: '2026-10-16', matches: false }),
          { actor: null, trigger: 'cron', now: NOW },
        ),
      ).resolves.toEqual({ row: after, applied: 'not_yet' });

      expect(prisma.lotteryResult.update).toHaveBeenCalledWith({
        where: { id: RESULT_ID },
        data: {
          status: 'PENDING',
          attempts: { increment: 1 },
          lastError: 'The source still shows 2026-10-16',
        },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expectDrawLocked();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('marks an error FAILED with the error text and the raw answer when there is one', async () => {
      await service.applyOutcome(
        draw,
        makeResult(),
        { ok: false, error: 'The results source answered 503', raw: 'down' },
        { actor: admin, trigger: 'manual', now: NOW },
      );
      expect(prisma.lotteryResult.update).toHaveBeenCalledWith({
        where: { id: RESULT_ID },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: 'The results source answered 503',
          raw: 'down',
        },
      });

      prisma.lotteryResult.update.mockClear();
      await service.applyOutcome(
        draw,
        makeResult(),
        { ok: false, error: 'Could not reach the results source: ENOTFOUND' },
        { actor: admin, trigger: 'manual', now: NOW },
      );
      expect(prisma.lotteryResult.update).toHaveBeenCalledWith({
        where: { id: RESULT_ID },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: 'Could not reach the results source: ENOTFOUND',
        },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('keeps a sheet already in (FETCHED) when a later fetch fails or shows another date', async () => {
      const row = makeResult({
        status: LotteryResultStatus.FETCHED,
        source: LotteryResultSource.MANUAL,
      });
      prisma.lotteryResult.findUniqueOrThrow.mockResolvedValue(row);
      await service.applyOutcome(
        draw,
        row,
        { ok: false, error: 'boom', raw: 'junk' },
        { actor: admin, trigger: 'manual', now: NOW },
      );
      expect(prisma.lotteryResult.update).toHaveBeenLastCalledWith({
        where: { id: RESULT_ID },
        data: {
          status: 'FETCHED',
          attempts: { increment: 1 },
          lastError: 'boom',
        },
      });
      await service.applyOutcome(
        draw,
        row,
        fetched({ sourceDate: '2026-10-16', matches: false }),
        { actor: admin, trigger: 'manual', now: NOW },
      );
      expect(prisma.lotteryResult.update).toHaveBeenLastCalledWith({
        where: { id: RESULT_ID },
        data: {
          status: 'FETCHED',
          attempts: { increment: 1 },
          lastError: 'The source still shows 2026-10-16',
        },
      });
    });

    it('never touches a PUBLISHED row', async () => {
      const row = makeResult({ status: LotteryResultStatus.PUBLISHED });
      prisma.lotteryResult.findUniqueOrThrow.mockResolvedValue(row);
      await expect(
        service.applyOutcome(draw, row, fetched(), {
          actor: admin,
          trigger: 'manual',
          now: NOW,
        }),
      ).resolves.toEqual({ row, applied: 'locked' });
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
    });

    it('never overwrites a row that was published while the source was being fetched', async () => {
      // The caller read the row PENDING, then waited on the source; a
      // staff member entered the sheet and published meanwhile. Under
      // the lock the row says PUBLISHED: the late answer is dropped.
      const stale = makeResult();
      const published = makeResult({
        status: LotteryResultStatus.PUBLISHED,
        source: LotteryResultSource.MANUAL,
        groups: makeSheet({
          first: { numbers: ['000001'] },
        }) as unknown as Prisma.JsonValue,
        enteredByUserId: admin.id,
      });
      prisma.lotteryResult.findUniqueOrThrow.mockResolvedValue(published);

      await expect(
        service.applyOutcome(draw, stale, fetched(), {
          actor: null,
          trigger: 'cron',
          now: NOW,
        }),
      ).resolves.toEqual({ row: published, applied: 'locked' });

      expectDrawLocked();
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409s LOTTERY_DRAW_STATE under the lock when a staff fetch finds the draw reopened, writing nothing', async () => {
      // Staff pressed "Fetch now" on a closed draw; another staff member
      // reopened sales while the source was slow. Under the lock the draw
      // says OPEN: no sheet goes onto a draw that is selling.
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.OPEN }),
      );
      await expect(
        codeOf(
          service.applyOutcome(draw, makeResult(), fetched(), {
            actor: admin,
            trigger: 'manual',
            now: NOW,
          }),
        ),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.DRAW_STATE,
        extra: { status: 'open' },
      });
      expectDrawLocked();
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryDraw.findUniqueOrThrow.mock.invocationCallOrder[0],
      );
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('reports "locked" and writes nothing when the cron finds the draw not closed under the lock', async () => {
      const row = makeResult();
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.PAUSED }),
      );
      await expect(
        service.applyOutcome(draw, row, fetched(), {
          actor: null,
          trigger: 'cron',
          now: NOW,
        }),
      ).resolves.toEqual({ row, applied: 'locked' });
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('fetchNow', () => {
    it('asks the configured source for the draw date and stores the answer under the staff member', async () => {
      prisma.lotteryResult.upsert
        .mockResolvedValueOnce({ ...makeResult(), enteredBy: null })
        .mockResolvedValueOnce({
          ...makeResult({
            status: LotteryResultStatus.FETCHED,
            source: LotteryResultSource.API,
            groups: makeSheet() as unknown as Prisma.JsonValue,
          }),
          enteredBy: null,
        });
      prisma.lotteryResult.update.mockResolvedValue(
        makeResult({ status: LotteryResultStatus.FETCHED }),
      );

      const view = await service.fetchNow(DRAW_ID, admin, NOW);

      expect(sources.create).toHaveBeenCalledWith(
        'https://lotto.example/latest',
        'thai_lotto_json',
      );
      expect(source.fetch).toHaveBeenCalledWith('2026-11-01');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_results.fetch',
          actor: admin,
          metadata: expect.objectContaining({ trigger: 'manual' }),
        }),
      );
      expect(view.status).toBe('fetched');
      expect(view.complete).toBe(true);
    });

    it('answers 200 with the error on the row when the source fails (no throw)', async () => {
      source.fetch.mockResolvedValue({ ok: false, error: 'boom' });
      prisma.lotteryResult.upsert
        .mockResolvedValueOnce({ ...makeResult(), enteredBy: null })
        .mockResolvedValueOnce({
          ...makeResult({
            status: LotteryResultStatus.FAILED,
            lastError: 'boom',
            attempts: 1,
          }),
          enteredBy: null,
        });
      const view = await service.fetchNow(DRAW_ID, admin, NOW);
      expect(view).toEqual(
        expect.objectContaining({
          status: 'failed',
          lastError: 'boom',
          attempts: 1,
        }),
      );
    });

    it('409s when no results source is set', async () => {
      settings.getOrCreate.mockResolvedValue({ ...SETTINGS, resultsUrl: null });
      await expect(
        codeOf(service.fetchNow(DRAW_ID, admin, NOW)),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 409,
          code: LOTTERY_ERRORS.RESULTS_SOURCE_NOT_SET,
        }),
      );
      expect(source.fetch).not.toHaveBeenCalled();
    });

    it('409s once the draw is published', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.PUBLISHED }),
      );
      await expect(
        codeOf(service.fetchNow(DRAW_ID, admin, NOW)),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 409,
          code: LOTTERY_ERRORS.RESULTS_LOCKED,
        }),
      );
      expect(source.fetch).not.toHaveBeenCalled();
    });

    it('409s LOTTERY_DRAW_STATE while sales are not closed (an open, paused or scheduled draw), asking nothing', async () => {
      for (const status of [
        LotteryDrawStatus.OPEN,
        LotteryDrawStatus.PAUSED,
        LotteryDrawStatus.SCHEDULED,
      ]) {
        prisma.lotteryDraw.findUnique.mockResolvedValue(makeDraw({ status }));
        await expect(
          codeOf(service.fetchNow(DRAW_ID, admin, NOW)),
        ).resolves.toEqual({
          status: 409,
          code: LOTTERY_ERRORS.DRAW_STATE,
          extra: { status: status.toLowerCase() },
        });
      }
      expect(source.fetch).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('enter', () => {
    it('stores a full sheet as FETCHED / MANUAL under the staff member, audited before/after with the note', async () => {
      const before = makeResult({
        status: LotteryResultStatus.FETCHED,
        source: LotteryResultSource.API,
        groups: makeSheet({
          first: { numbers: ['000001'] },
        }) as unknown as Prisma.JsonValue,
        raw: { status: 'success' },
      });
      const after = makeResult({
        status: LotteryResultStatus.FETCHED,
        source: LotteryResultSource.MANUAL,
        groups: makeSheet() as unknown as Prisma.JsonValue,
        enteredByUserId: admin.id,
      });
      prisma.lotteryResult.upsert
        .mockResolvedValueOnce({ ...before, enteredBy: null })
        .mockResolvedValueOnce({
          ...after,
          enteredBy: {
            id: admin.id,
            username: admin.username,
            displayName: null,
          },
        });
      prisma.lotteryResult.update.mockResolvedValue(after);

      const view = await service.enter(
        DRAW_ID,
        {
          groups: sheetInputs().map((g) => ({ ...g, numbers: [...g.numbers] })),
          note: 'source was down',
        },
        admin,
        NOW,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.lotteryResult.update).toHaveBeenCalledWith({
        where: { id: RESULT_ID },
        data: {
          status: 'FETCHED',
          source: 'MANUAL',
          groups: makeSheet(),
          raw: Prisma.DbNull,
          sourceDate: '2026-11-01',
          fetchedAt: NOW,
          enteredByUserId: admin.id,
          lastError: null,
        },
      });
      expect(audit.record).toHaveBeenCalledWith({
        action: 'lottery_results.enter',
        actor: admin,
        target: {
          type: 'lottery_results',
          id: RESULT_ID,
          label: 'Draw 24 (2026-11-01)',
        },
        before: expect.objectContaining({
          source: 'API',
          groups: expect.arrayContaining([
            expect.objectContaining({ key: 'first', numbers: ['000001'] }),
          ]),
        }),
        after: expect.objectContaining({
          source: 'MANUAL',
          groups: expect.arrayContaining([
            expect.objectContaining({ key: 'first', numbers: ['123456'] }),
          ]),
        }),
        metadata: { note: 'source was down', warnings: [] },
        tx: prisma,
      });
      expect(view).toEqual(
        expect.objectContaining({
          status: 'fetched',
          source: 'manual',
          enteredBy: { id: admin.id, label: admin.username },
          complete: true,
        }),
      );
    });

    it('400s an incomplete sheet with every problem listed, writing nothing', async () => {
      const groups = sheetInputs({
        third: { numbers: ['300100'] },
        back2: { numbers: ['5'] },
      }).map((g) => ({ ...g, numbers: [...g.numbers] }));
      await expect(
        codeOf(service.enter(DRAW_ID, { groups }, admin, NOW)),
      ).resolves.toEqual({
        status: 400,
        code: LOTTERY_ERRORS.RESULTS_INVALID,
        extra: {
          details: {
            errors: [
              'Third prize: expected 10 numbers, got 1',
              'Back 2 digits: every number must be exactly 2 digits (5)',
            ],
          },
        },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409s once the draw is published, and inside the transaction when the row says so', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.PUBLISHED }),
      );
      const groups = sheetInputs().map((g) => ({
        ...g,
        numbers: [...g.numbers],
      }));
      await expect(
        codeOf(service.enter(DRAW_ID, { groups }, admin, NOW)),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 409,
          code: LOTTERY_ERRORS.RESULTS_LOCKED,
        }),
      );

      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.CLOSED }),
      );
      prisma.lotteryResult.upsert.mockResolvedValue({
        ...makeResult({ status: LotteryResultStatus.PUBLISHED }),
        enteredBy: null,
      });
      await expect(
        codeOf(service.enter(DRAW_ID, { groups }, admin, NOW)),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 409,
          code: LOTTERY_ERRORS.RESULTS_LOCKED,
        }),
      );
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
    });

    it('409s when the draw was published between the check and the write (the re-read under the lock)', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.CLOSED }),
      );
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.PUBLISHED }),
      );
      const groups = sheetInputs().map((g) => ({
        ...g,
        numbers: [...g.numbers],
      }));
      await expect(
        codeOf(service.enter(DRAW_ID, { groups }, admin, NOW)),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 409,
          code: LOTTERY_ERRORS.RESULTS_LOCKED,
        }),
      );
      expectDrawLocked();
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryDraw.findUniqueOrThrow.mock.invocationCallOrder[0],
      );
      expect(prisma.lotteryResult.upsert).not.toHaveBeenCalled();
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409s LOTTERY_DRAW_STATE while sales are not closed, before the sheet is even checked', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.OPEN }),
      );
      const groups = sheetInputs({ third: { numbers: ['300100'] } }).map(
        (g) => ({ ...g, numbers: [...g.numbers] }),
      );
      await expect(
        codeOf(service.enter(DRAW_ID, { groups }, admin, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.DRAW_STATE,
        extra: { status: 'open' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409s LOTTERY_DRAW_STATE when the draw reopened between the check and the write (the re-read under the lock)', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.CLOSED }),
      );
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(
        makeDraw({ status: LotteryDrawStatus.OPEN }),
      );
      const groups = sheetInputs().map((g) => ({
        ...g,
        numbers: [...g.numbers],
      }));
      await expect(
        codeOf(service.enter(DRAW_ID, { groups }, admin, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.DRAW_STATE,
        extra: { status: 'open' },
      });
      expectDrawLocked();
      expect(prisma.lotteryResult.upsert).not.toHaveBeenCalled();
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('testSource', () => {
    it('asks the source for today in Bangkok and shows the sheet it answered', async () => {
      source.fetch.mockResolvedValue(
        fetched({ sourceDate: '2026-11-01', matches: false }),
      );
      // 17:30 UTC on 31 Oct is already 1 Nov in Bangkok.
      const view = await service.testSource(new Date('2026-10-31T17:30:00Z'));
      expect(source.fetch).toHaveBeenCalledWith('2026-11-01');
      expect(view).toEqual({
        ok: true,
        url: 'https://lotto.example/latest',
        askedDate: '2026-11-01',
        sourceDate: '2026-11-01',
        matches: false,
        groupsSummary: makeSheet().map((group) => ({
          key: group.key,
          name: group.name,
          baht: group.baht,
          count: group.numbers.length,
          numbers: group.numbers,
        })),
        warnings: [],
        error: null,
      });
    });

    it('shows the resolved per-date URL and the error when the source fails', async () => {
      settings.getOrCreate.mockResolvedValue({
        ...SETTINGS,
        resultsUrl: 'https://lotto.example/{date}',
      });
      source.fetch.mockResolvedValue({ ok: false, error: 'answered 404' });
      await expect(
        service.testSource(new Date('2026-11-01T02:00:00Z')),
      ).resolves.toEqual({
        ok: false,
        url: 'https://lotto.example/20261101',
        askedDate: '2026-11-01',
        sourceDate: null,
        matches: null,
        groupsSummary: null,
        warnings: [],
        error: 'answered 404',
      });
    });

    it('says so — 200, not an error — when no source is set', async () => {
      settings.getOrCreate.mockResolvedValue({ ...SETTINGS, resultsUrl: null });
      await expect(service.testSource(NOW)).resolves.toEqual(
        expect.objectContaining({
          ok: false,
          url: null,
          error: 'No results source is set',
        }),
      );
      expect(sources.create).not.toHaveBeenCalled();
    });
  });

  it('maps the statuses and sources to the wire', () => {
    expect(resultStatusToWire(LotteryResultStatus.PENDING)).toBe('pending');
    expect(resultStatusToWire(LotteryResultStatus.FETCHED)).toBe('fetched');
    expect(resultStatusToWire(LotteryResultStatus.FAILED)).toBe('failed');
    expect(resultSourceToWire(null)).toBeNull();
    expect(resultSourceToWire(LotteryResultSource.MANUAL)).toBe('manual');
    expect(bangkokDate(new Date('2026-11-01T16:59:59Z'))).toBe('2026-11-01');
    expect(bangkokDate(new Date('2026-11-01T17:00:00Z'))).toBe('2026-11-02');
  });
});
