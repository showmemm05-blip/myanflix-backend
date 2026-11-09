import { HttpStatus, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { PrismaService } from '../prisma/prisma.service';
import type { TmdbSearchRow } from './tmdb-payload';
import {
  TMDB_OVERVIEW_PREVIEW,
  TmdbSearchService,
  overviewPreview,
} from './tmdb-search.service';
import { TmdbClient } from './tmdb.client';

const row = (
  id: number,
  title: string,
  overrides: Partial<TmdbSearchRow> = {},
): TmdbSearchRow => ({
  id,
  title,
  originalTitle: title,
  releaseDate: '2010-07-16',
  overview: 'A story.',
  posterPath: '/poster.jpg',
  originalLanguage: 'en',
  ...overrides,
});

const found = (...rows: TmdbSearchRow[]) => ({ ok: true as const, data: rows });

describe('overviewPreview', () => {
  it('leaves a short story alone and flattens its whitespace', () => {
    expect(overviewPreview('  A thief.\n\nHe  steals. ')).toBe(
      'A thief. He steals.',
    );
    expect(overviewPreview('')).toBe('');
  });

  it('cuts a long one to 300 characters, ending in an ellipsis', () => {
    const cut = overviewPreview('word '.repeat(200));

    expect(cut.length).toBeLessThanOrEqual(TMDB_OVERVIEW_PREVIEW);
    expect(cut.endsWith('…')).toBe(true);
    expect(overviewPreview('x'.repeat(300))).toHaveLength(300);
    expect(overviewPreview('x'.repeat(301))).toHaveLength(300);
  });
});

describe('TmdbSearchService', () => {
  let service: TmdbSearchService;
  let prisma: {
    movie: { findMany: jest.Mock };
    series: { findMany: jest.Mock };
  };
  let client: {
    isEnabled: boolean;
    searchMovies: jest.Mock;
    searchTv: jest.Mock;
  };
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    prisma = {
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      series: { findMany: jest.fn().mockResolvedValue([]) },
    };
    client = {
      isEnabled: true,
      searchMovies: jest.fn().mockResolvedValue(found()),
      searchTv: jest.fn().mockResolvedValue(found()),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TmdbSearchService,
        { provide: PrismaService, useValue: prisma },
        { provide: TmdbClient, useValue: client },
      ],
    }).compile();
    service = module.get(TmdbSearchService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers the list as staff see it: year, short story, small TMDB poster', async () => {
    client.searchMovies.mockResolvedValue(
      found(
        row(27205, 'Inception', { overview: `${'Long story. '.repeat(60)}` }),
        row(496243, 'Parasite', {
          originalTitle: '기생충',
          releaseDate: '2019-05-30',
          originalLanguage: 'ko',
          posterPath: null,
        }),
        row(3, 'Undated', { releaseDate: '', overview: '' }),
      ),
    );

    const answer = await service.searchMovies('  inception ', 2010);

    expect(answer.query).toBe('inception');
    expect(answer.year).toBe(2010);
    expect(answer.yearIgnored).toBe(false);
    expect(answer.results).toEqual([
      {
        tmdbId: 27205,
        title: 'Inception',
        // The same as the title: not repeated.
        originalTitle: null,
        year: 2010,
        overview: expect.stringMatching(/^Long story\. .*…$/),
        posterPreviewUrl: 'https://image.tmdb.org/t/p/w185/poster.jpg',
        originalLanguage: 'en',
        usedBy: null,
      },
      {
        tmdbId: 496243,
        title: 'Parasite',
        originalTitle: '기생충',
        year: 2019,
        overview: 'A story.',
        posterPreviewUrl: null,
        originalLanguage: 'ko',
        usedBy: null,
      },
      {
        tmdbId: 3,
        title: 'Undated',
        originalTitle: null,
        year: null,
        overview: '',
        posterPreviewUrl: 'https://image.tmdb.org/t/p/w185/poster.jpg',
        originalLanguage: 'en',
        usedBy: null,
      },
    ]);
    expect(answer.results[0].overview.length).toBeLessThanOrEqual(300);
    expect(client.searchMovies).toHaveBeenCalledWith('inception', 2010);
  });

  it('never decides: several exact matches are all listed', async () => {
    client.searchMovies.mockResolvedValue(
      found(row(1, 'Oldboy'), row(2, 'Oldboy'), row(3, 'Oldboy')),
    );

    const answer = await service.searchMovies('Oldboy', null);

    expect(answer.results.map((result) => result.tmdbId)).toEqual([1, 2, 3]);
  });

  describe('the year', () => {
    it('without a year the search is made once, with no filter', async () => {
      await service.searchMovies('Inception', null);

      expect(client.searchMovies.mock.calls).toEqual([['Inception', null]]);
    });

    it('a year that finds nothing: repeated once without it, and the answer says so', async () => {
      client.searchMovies
        .mockResolvedValueOnce(found())
        .mockResolvedValueOnce(found(row(27205, 'Inception')));

      const answer = await service.searchMovies('Inception', 2011);

      expect(client.searchMovies.mock.calls).toEqual([
        ['Inception', 2011],
        ['Inception', null],
      ]);
      expect(answer).toEqual(
        expect.objectContaining({ year: 2011, yearIgnored: true }),
      );
      expect(answer.results).toHaveLength(1);
    });

    it('a year that finds something is not repeated', async () => {
      client.searchMovies.mockResolvedValue(found(row(27205, 'Inception')));

      const answer = await service.searchMovies('Inception', 2010);

      expect(client.searchMovies).toHaveBeenCalledTimes(1);
      expect(answer.yearIgnored).toBe(false);
    });

    it('nothing with or without the year: an empty list, still marked', async () => {
      const answer = await service.searchMovies('Zzzz', 1999);

      expect(client.searchMovies).toHaveBeenCalledTimes(2);
      expect(answer).toEqual({
        query: 'Zzzz',
        year: 1999,
        yearIgnored: true,
        results: [],
      });
    });
  });

  describe('"Already used by"', () => {
    it('names our standalone movie that is linked to a candidate — the oldest one', async () => {
      client.searchMovies.mockResolvedValue(
        found(row(27205, 'Inception'), row(2, 'Inception 2')),
      );
      prisma.movie.findMany.mockResolvedValue([
        { id: 'm-old', title: 'Inception', tmdbId: 27205 },
        { id: 'm-dup', title: 'Inception (copy)', tmdbId: 27205 },
      ]);

      const answer = await service.searchMovies('Inception', null);

      expect(prisma.movie.findMany).toHaveBeenCalledWith({
        // Episodes are never linked, so they are never "using" a film.
        where: { tmdbId: { in: [27205, 2] }, seriesId: null },
        select: { id: true, title: true, tmdbId: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(answer.results.map((result) => result.usedBy)).toEqual([
        { id: 'm-old', title: 'Inception' },
        null,
      ]);
      expect(prisma.series.findMany).not.toHaveBeenCalled();
    });

    it('for a show, looks among our series', async () => {
      client.searchTv.mockResolvedValue(found(row(66732, 'Stranger Things')));
      prisma.series.findMany.mockResolvedValue([
        { id: 's-1', title: 'Stranger Things', tmdbId: 66732 },
      ]);

      const answer = await service.searchTv('Stranger Things', 2016);

      expect(client.searchTv).toHaveBeenCalledWith('Stranger Things', 2016);
      expect(prisma.series.findMany).toHaveBeenCalledWith({
        where: { tmdbId: { in: [66732] } },
        select: { id: true, title: true, tmdbId: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(answer.results[0].usedBy).toEqual({
        id: 's-1',
        title: 'Stranger Things',
      });
      expect(prisma.movie.findMany).not.toHaveBeenCalled();
    });

    it('asks the database nothing when TMDB found nothing', async () => {
      await service.searchMovies('Zzzz', null);
      await service.searchTv('Zzzz', null);

      expect(prisma.movie.findMany).not.toHaveBeenCalled();
      expect(prisma.series.findMany).not.toHaveBeenCalled();
    });
  });

  describe('refusals', () => {
    const refusal = async (attempt: Promise<unknown>) => {
      const error: unknown = await attempt.then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(CodedHttpException);
      const coded = error as CodedHttpException;
      return { status: coded.getStatus(), code: coded.code };
    };

    it('503 TMDB_NOT_CONFIGURED while the key is missing — TMDB is not asked', async () => {
      client.isEnabled = false;

      const off = {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'TMDB_NOT_CONFIGURED',
      };
      await expect(
        refusal(service.searchMovies('Inception', null)),
      ).resolves.toEqual(off);
      await expect(refusal(service.searchTv('Dark', null))).resolves.toEqual(
        off,
      );
      expect(client.searchMovies).not.toHaveBeenCalled();
      expect(client.searchTv).not.toHaveBeenCalled();
    });

    it.each([
      ['unreachable', HttpStatus.BAD_GATEWAY, 'TMDB_UNREACHABLE'],
      ['bad_response', HttpStatus.BAD_GATEWAY, 'TMDB_UNREACHABLE'],
      ['key_rejected', HttpStatus.BAD_GATEWAY, 'TMDB_KEY_REJECTED'],
      ['rate_limited', HttpStatus.SERVICE_UNAVAILABLE, 'TMDB_RATE_LIMITED'],
      // A search has no id that could be unknown: TMDB is not being itself.
      ['not_found', HttpStatus.BAD_GATEWAY, 'TMDB_UNREACHABLE'],
    ])('TMDB answers %s: %i %s', async (reason, status, code) => {
      client.searchMovies.mockResolvedValue({ ok: false, reason });
      client.searchTv.mockResolvedValue({ ok: false, reason });

      await expect(
        refusal(service.searchMovies('Inception', 2010)),
      ).resolves.toEqual({ status, code });
      await expect(refusal(service.searchTv('Dark', null))).resolves.toEqual({
        status,
        code,
      });
    });

    it('a failure of the repeat without the year is a failure too', async () => {
      client.searchMovies
        .mockResolvedValueOnce(found())
        .mockResolvedValueOnce({ ok: false, reason: 'rate_limited' });

      await expect(
        refusal(service.searchMovies('Inception', 2010)),
      ).resolves.toEqual({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'TMDB_RATE_LIMITED',
      });
    });
  });

  it('logs that a search ran, never the words searched for', async () => {
    client.searchMovies.mockResolvedValue(found(row(1, 'Secret Film')));

    await service.searchMovies('Secret Film', 2010);

    const lines = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(lines).toContain('1 result(s)');
    expect(lines).not.toMatch(/secret/i);
  });
});
