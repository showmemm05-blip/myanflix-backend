import { HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { Role, TmdbLookupStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TmdbFillService } from './tmdb-fill.service';
import {
  TMDB_LOOKUP_CONCURRENCY,
  TmdbLookupService,
} from './tmdb-lookup.service';
import type { TmdbSearchRow } from './tmdb-payload';
import { TmdbRunRegistry, movieRunKey } from './tmdb-runs';
import { TmdbClient } from './tmdb.client';

type Row = Record<string, any>;

const STAFF = {
  id: 'staff-1',
  username: 'uploader',
  role: Role.CONTENT_UPLOADER,
  appRoleId: null,
} as unknown as AuthenticatedUser;

const MOVIE_ID = '11111111-1111-4111-8111-111111111111';

const searchRow = (
  id: number,
  title: string,
  releaseDate: string,
): TmdbSearchRow => ({
  id,
  title,
  originalTitle: title,
  releaseDate,
  overview: '',
  posterPath: null,
  originalLanguage: 'en',
});

const INCEPTION = searchRow(27205, 'Inception', '2010-07-16');

const found = (...rows: TmdbSearchRow[]) => ({ ok: true as const, data: rows });

const filledReport = {
  filled: ['title', 'description'],
  skipped: [],
  actors: { reused: 0, created: 0, skipped: [] },
  categories: { added: [], unmatched: [] },
};

/** Lets every promise that is ready run, a few rounds deep. */
const settle = async () => {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('TmdbLookupService', () => {
  let service: TmdbLookupService;
  let runs: TmdbRunRegistry;
  let movies: Map<string, Row>;
  let prisma: { movie: { findUnique: jest.Mock; updateMany: jest.Mock } };
  let client: { isEnabled: boolean; searchMovies: jest.Mock };
  let fill: { fillMovieAutomatically: jest.Mock };
  let errorSpy: jest.SpyInstance;

  /** A standalone movie as a finished folder upload leaves it. */
  const haveMovie = (overrides: Row = {}, id = MOVIE_ID) => {
    const row: Row = {
      id,
      title: 'Inception',
      sourceName: 'Inception.2010.1080p.BluRay.x264-YIFY',
      seriesId: null,
      tmdbStatus: TmdbLookupStatus.NONE,
      tmdbError: null,
      tmdbAuto: { v: 1, title: 'Inception', releaseYear: 2010 },
      ...overrides,
    };
    movies.set(id, row);
    return row;
  };
  const movieNow = (id = MOVIE_ID) => movies.get(id) as Row;

  /** Every status write, as [where, data], in order. */
  const statusWrites = () =>
    prisma.movie.updateMany.mock.calls.map(
      ([args]) => [(args as Row).where, (args as Row).data] as const,
    );

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    movies = new Map();

    prisma = {
      movie: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          const row = movies.get(where.id);
          return row ? { ...row } : null;
        }),
        // The compare-and-set every status change goes through.
        updateMany: jest.fn(
          async ({ where, data }: { where: Row; data: Row }) => {
            const wanted = where.tmdbStatus as
              TmdbLookupStatus | { in: TmdbLookupStatus[] };
            const matches = (row: Row) =>
              (where.id === undefined || row.id === where.id) &&
              (typeof wanted === 'string'
                ? row.tmdbStatus === wanted
                : wanted.in.includes(row.tmdbStatus));
            const hit = [...movies.values()].filter(matches);
            for (const row of hit) Object.assign(row, data);
            return { count: hit.length };
          },
        ),
      },
    };
    client = {
      isEnabled: true,
      searchMovies: jest.fn().mockResolvedValue(found(INCEPTION)),
    };
    fill = {
      // The real fill writes MATCHED in the same transaction as the details.
      fillMovieAutomatically: jest.fn(async (movieId: string) => {
        const row = movies.get(movieId);
        if (row) {
          row.tmdbStatus = TmdbLookupStatus.MATCHED;
          row.tmdbError = null;
        }
        return { outcome: 'filled', report: filledReport };
      }),
    };
    runs = new TmdbRunRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TmdbLookupService,
        { provide: PrismaService, useValue: prisma },
        { provide: TmdbClient, useValue: client },
        { provide: TmdbFillService, useValue: fill },
        { provide: TmdbRunRegistry, useValue: runs },
      ],
    }).compile();
    service = module.get(TmdbLookupService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------
  describe('afterUpload — the lookup a finished upload starts', () => {
    describe('does nothing at all', () => {
      it('while TMDB_API_KEY is missing: the database is not even read', async () => {
        haveMovie();
        client.isEnabled = false;

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(prisma.movie.findUnique).not.toHaveBeenCalled();
        expect(prisma.movie.updateMany).not.toHaveBeenCalled();
        expect(client.searchMovies).not.toHaveBeenCalled();
        expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.NONE);
      });

      it('for an episode — episodes are not looked up', async () => {
        haveMovie({ seriesId: 'series-1', title: 'Chapter One' });

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(prisma.movie.updateMany).not.toHaveBeenCalled();
        expect(client.searchMovies).not.toHaveBeenCalled();
        expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.NONE);
      });

      it('for a movie that no longer exists', async () => {
        await service.afterUpload(MOVIE_ID, STAFF);

        expect(prisma.movie.updateMany).not.toHaveBeenCalled();
        expect(client.searchMovies).not.toHaveBeenCalled();
      });

      it.each([
        TmdbLookupStatus.MATCHED,
        TmdbLookupStatus.PENDING,
        TmdbLookupStatus.NEEDS_PICK,
      ])(
        'for a movie that is %s — linked, being looked up, or waiting for staff',
        async (tmdbStatus) => {
          haveMovie({ tmdbStatus });

          await service.afterUpload(MOVIE_ID, STAFF);

          expect(prisma.movie.updateMany).not.toHaveBeenCalled();
          expect(client.searchMovies).not.toHaveBeenCalled();
          expect(movieNow().tmdbStatus).toBe(tmdbStatus);
        },
      );

      it('when another run already holds the movie', async () => {
        haveMovie();
        runs.tryStart(movieRunKey(MOVIE_ID));

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(prisma.movie.updateMany).not.toHaveBeenCalled();
        // And it did not let go of a key that was not its own.
        expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(true);
      });
    });

    describe('the claim', () => {
      it.each([
        TmdbLookupStatus.NONE,
        TmdbLookupStatus.FAILED,
        TmdbLookupStatus.NOT_FOUND,
      ])(
        'takes a movie that is %s: PENDING, the old error cleared',
        async (tmdbStatus) => {
          haveMovie({ tmdbStatus, tmdbError: 'unreachable' });
          const seen: Array<{ status: string; error: unknown }> = [];
          client.searchMovies.mockImplementation(async () => {
            seen.push({
              status: movieNow().tmdbStatus,
              error: movieNow().tmdbError,
            });
            return found(INCEPTION);
          });

          await service.afterUpload(MOVIE_ID, STAFF);

          expect(statusWrites()[0]).toEqual([
            {
              id: MOVIE_ID,
              tmdbStatus: {
                in: [
                  TmdbLookupStatus.NONE,
                  TmdbLookupStatus.FAILED,
                  TmdbLookupStatus.NOT_FOUND,
                ],
              },
            },
            { tmdbStatus: TmdbLookupStatus.PENDING, tmdbError: null },
          ]);
          // The search ran on a movie that already showed "Finding details…".
          expect(seen[0]).toEqual({ status: 'PENDING', error: null });
        },
      );

      it('a claim that loses (the status moved meanwhile) starts nothing', async () => {
        haveMovie();
        prisma.movie.updateMany.mockResolvedValueOnce({ count: 0 });

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(client.searchMovies).not.toHaveBeenCalled();
        expect(prisma.movie.updateMany).toHaveBeenCalledTimes(1);
        expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);
      });

      it('never writes anything but the two TMDB columns — not the status of the upload', async () => {
        haveMovie();
        client.searchMovies.mockResolvedValue(found());

        await service.afterUpload(MOVIE_ID, STAFF);

        for (const [, data] of statusWrites()) {
          expect(Object.keys(data).sort()).toEqual(['tmdbError', 'tmdbStatus']);
        }
      });
    });

    describe('each outcome', () => {
      it("one clear match: the details are filled, in the uploader's name, and the movie ends MATCHED", async () => {
        haveMovie();

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(fill.fillMovieAutomatically).toHaveBeenCalledTimes(1);
        expect(fill.fillMovieAutomatically).toHaveBeenCalledWith(
          MOVIE_ID,
          27205,
          STAFF,
          'upload',
        );
        expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.MATCHED);
        // The fill set MATCHED itself: the lookup wrote only its claim.
        expect(prisma.movie.updateMany).toHaveBeenCalledTimes(1);
      });

      it('searches for what the folder name says: name and year, in the order of the rule', async () => {
        haveMovie();
        client.searchMovies.mockResolvedValue(found());

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(client.searchMovies.mock.calls).toEqual([
          ['Inception', 2010],
          ['Inception', null],
          ['Inception 2010', null],
        ]);
      });

      it('several matches: NEEDS_PICK, and nothing is filled', async () => {
        haveMovie({ sourceName: 'Oldboy.2003.720p', title: 'Oldboy' });
        client.searchMovies.mockResolvedValue(
          found(
            searchRow(1, 'Oldboy', '2003-11-21'),
            searchRow(2, 'Oldboy', '2004-02-01'),
          ),
        );

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(movieNow()).toEqual(
          expect.objectContaining({
            tmdbStatus: TmdbLookupStatus.NEEDS_PICK,
            tmdbError: null,
          }),
        );
        expect(fill.fillMovieAutomatically).not.toHaveBeenCalled();
      });

      it('candidates but none that is clearly it: NEEDS_PICK', async () => {
        haveMovie();
        client.searchMovies.mockResolvedValue(
          found(searchRow(9, 'Inception: The Cobol Job', '2010-12-07')),
        );

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.NEEDS_PICK);
      });

      it('no match: NOT_FOUND — the movie stays exactly as uploaded', async () => {
        haveMovie();
        client.searchMovies.mockResolvedValue(found());

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(movieNow()).toEqual(
          expect.objectContaining({
            title: 'Inception',
            tmdbStatus: TmdbLookupStatus.NOT_FOUND,
            tmdbError: null,
          }),
        );
        expect(fill.fillMovieAutomatically).not.toHaveBeenCalled();
      });

      it.each([
        ['unreachable', 'unreachable'],
        ['bad_response', 'unreachable'],
        ['rate_limited', 'rate_limited'],
        ['key_rejected', 'key_rejected'],
        ['not_found', 'unreachable'],
        ['not_configured', 'internal'],
      ])('the search fails (%s): FAILED / %s', async (reason, tmdbError) => {
        haveMovie();
        client.searchMovies.mockResolvedValue({ ok: false, reason });

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(movieNow()).toEqual(
          expect.objectContaining({
            tmdbStatus: TmdbLookupStatus.FAILED,
            tmdbError,
          }),
        );
        expect(fill.fillMovieAutomatically).not.toHaveBeenCalled();
      });

      it.each([
        ['unreachable', TmdbLookupStatus.FAILED, 'unreachable'],
        ['rate_limited', TmdbLookupStatus.FAILED, 'rate_limited'],
        ['key_rejected', TmdbLookupStatus.FAILED, 'key_rejected'],
        // The entry the search just listed has no details any more.
        ['not_found', TmdbLookupStatus.NOT_FOUND, null],
      ])(
        'the details of the match fail (%s): %s / %s',
        async (reason, tmdbStatus, tmdbError) => {
          haveMovie();
          fill.fillMovieAutomatically.mockResolvedValue({
            outcome: 'failed',
            reason,
          });

          await service.afterUpload(MOVIE_ID, STAFF);

          expect(movieNow()).toEqual(
            expect.objectContaining({ tmdbStatus, tmdbError }),
          );
        },
      );

      it('the movie was deleted during the lookup: it stops quietly', async () => {
        haveMovie();
        fill.fillMovieAutomatically.mockImplementation(async () => {
          movies.delete(MOVIE_ID);
          return { outcome: 'gone' };
        });

        await expect(
          service.afterUpload(MOVIE_ID, STAFF),
        ).resolves.toBeUndefined();

        // Only the claim was written; nothing was set on a row that is gone.
        expect(prisma.movie.updateMany).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
      });

      it('sets its result only while the movie is still PENDING', async () => {
        haveMovie();
        client.searchMovies.mockImplementation(async () => {
          // Staff applied a match by hand while the search was running.
          movieNow().tmdbStatus = TmdbLookupStatus.MATCHED;
          return found();
        });

        await service.afterUpload(MOVIE_ID, STAFF);

        expect(statusWrites()[1][0]).toEqual({
          id: MOVIE_ID,
          tmdbStatus: TmdbLookupStatus.PENDING,
        });
        expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.MATCHED);
      });
    });

    describe('what is searched for (PLAN 2.4)', () => {
      const searchedFor = async (overrides: Row) => {
        haveMovie(overrides);
        client.searchMovies.mockResolvedValue(found());
        await service.afterUpload(MOVIE_ID, STAFF);
        return client.searchMovies.mock.calls;
      };

      it('the folder name, while the title is still the one the upload gave it', async () => {
        await expect(
          searchedFor({
            title: 'The Dark Knight',
            sourceName: 'The_Dark_Knight_2008_720p_BrRip',
            tmdbAuto: { v: 1, title: 'The Dark Knight', releaseYear: 2008 },
          }),
        ).resolves.toEqual([
          ['The Dark Knight', 2008],
          ['The Dark Knight', null],
          ['The Dark Knight 2008', null],
        ]);
      });

      it('the title staff typed, once they renamed it', async () => {
        await expect(
          searchedFor({
            title: 'Batman Begins',
            sourceName: 'The_Dark_Knight_2008_720p_BrRip',
            tmdbAuto: { v: 1, title: 'The Dark Knight', releaseYear: 2008 },
          }),
        ).resolves.toEqual([['Batman Begins', null]]);
      });

      it('the title, for a movie with no folder name', async () => {
        await expect(
          searchedFor({
            title: 'Parasite 2019',
            sourceName: null,
            tmdbAuto: { v: 1, title: 'Parasite 2019', releaseYear: 2026 },
          }),
        ).resolves.toEqual([
          ['Parasite', 2019],
          ['Parasite', null],
          ['Parasite 2019', null],
        ]);
      });

      it('the title, for a row that predates the feature', async () => {
        await expect(
          searchedFor({
            title: 'Oldboy',
            sourceName: null,
            tmdbAuto: null,
            tmdbStatus: TmdbLookupStatus.NONE,
          }),
        ).resolves.toEqual([['Oldboy', null]]);
      });
    });

    describe('can never fail or hold up an upload', () => {
      it('an error nobody expected becomes FAILED / internal, and the promise still resolves', async () => {
        haveMovie();
        fill.fillMovieAutomatically.mockRejectedValue(new Error('bug'));

        await expect(
          service.afterUpload(MOVIE_ID, STAFF),
        ).resolves.toBeUndefined();

        expect(movieNow()).toEqual(
          expect.objectContaining({
            tmdbStatus: TmdbLookupStatus.FAILED,
            tmdbError: 'internal',
          }),
        );
        expect(errorSpy).toHaveBeenCalled();
        expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);
      });

      it('a search that throws (it never should) is FAILED / internal too', async () => {
        haveMovie();
        client.searchMovies.mockRejectedValue(new Error('bug in the client'));

        await expect(
          service.afterUpload(MOVIE_ID, STAFF),
        ).resolves.toBeUndefined();

        expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.FAILED);
        expect(movieNow().tmdbError).toBe('internal');
      });

      it.each([
        [
          'the first read',
          () => prisma.movie.findUnique.mockRejectedValue(new Error('db down')),
        ],
        [
          'the claim',
          () => prisma.movie.updateMany.mockRejectedValue(new Error('db down')),
        ],
        [
          'recording the result',
          () =>
            prisma.movie.updateMany
              .mockResolvedValueOnce({ count: 1 })
              .mockRejectedValue(new Error('db down')),
        ],
        [
          'recording the failure of a failure',
          () => {
            fill.fillMovieAutomatically.mockRejectedValue(new Error('bug'));
            prisma.movie.updateMany
              .mockResolvedValueOnce({ count: 1 })
              .mockRejectedValue(new Error('db down'));
          },
        ],
      ])(
        'never rejects, even when the database fails at %s',
        async (_label, arrange) => {
          haveMovie();
          client.searchMovies.mockResolvedValue(found());
          arrange();

          await expect(
            service.afterUpload(MOVIE_ID, STAFF),
          ).resolves.toBeUndefined();

          expect(errorSpy).toHaveBeenCalled();
          // The movie's key is free again: staff can press "Try again".
          expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);
        },
      );

      it('a synchronous throw inside is caught as well', async () => {
        haveMovie();
        client.searchMovies.mockImplementation(() => {
          throw new Error('sync');
        });

        await expect(
          service.afterUpload(MOVIE_ID, STAFF),
        ).resolves.toBeUndefined();
        expect(movieNow().tmdbError).toBe('internal');
      });
    });

    it(`runs at most ${TMDB_LOOKUP_CONCURRENCY} lookups at a time; the rest wait, already PENDING`, async () => {
      const ids = ['m-1', 'm-2', 'm-3', 'm-4', 'm-5'];
      for (const id of ids) haveMovie({}, id);
      let searching = 0;
      let most = 0;
      const waiting: Array<() => void> = [];
      client.searchMovies.mockImplementation(async () => {
        searching += 1;
        most = Math.max(most, searching);
        await new Promise<void>((resolve) => waiting.push(resolve));
        searching -= 1;
        return { ok: false, reason: 'unreachable' };
      });

      const all = Promise.all(ids.map((id) => service.afterUpload(id, STAFF)));
      await settle();

      expect(searching).toBe(TMDB_LOOKUP_CONCURRENCY);
      // Every one of them is claimed, running or not.
      expect(ids.map((id) => movieNow(id).tmdbStatus)).toEqual(
        ids.map(() => TmdbLookupStatus.PENDING),
      );

      while (waiting.length > 0 || searching > 0) {
        waiting.shift()?.();
        await settle();
      }
      await all;

      expect(most).toBe(TMDB_LOOKUP_CONCURRENCY);
      expect(ids.map((id) => movieNow(id).tmdbStatus)).toEqual(
        ids.map(() => TmdbLookupStatus.FAILED),
      );
    });
  });

  // -------------------------------------------------------------------
  describe('requestLookup — "Find details" / "Try again"', () => {
    const refusal = async (attempt: Promise<unknown>) => {
      const error: unknown = await attempt.then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(CodedHttpException);
      const coded = error as CodedHttpException;
      return { status: coded.getStatus(), code: coded.code };
    };

    it("answers PENDING at once and looks the movie up in the background, in the staff member's name", async () => {
      haveMovie();
      let finishSearch: (value: unknown) => void = () => undefined;
      client.searchMovies.mockReturnValue(
        new Promise((resolve) => {
          finishSearch = resolve;
        }),
      );

      await expect(service.requestLookup(MOVIE_ID, STAFF)).resolves.toEqual({
        status: 'PENDING',
      });

      // Answered while TMDB has not: the movie shows "Finding details…".
      expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.PENDING);
      expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(true);

      finishSearch(found(INCEPTION));
      await settle();

      expect(fill.fillMovieAutomatically).toHaveBeenCalledWith(
        MOVIE_ID,
        27205,
        STAFF,
        'staff',
      );
      expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.MATCHED);
      expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);
    });

    it.each([
      TmdbLookupStatus.NONE,
      TmdbLookupStatus.FAILED,
      TmdbLookupStatus.NOT_FOUND,
      TmdbLookupStatus.NEEDS_PICK,
    ])('may start from %s', async (tmdbStatus) => {
      haveMovie({ tmdbStatus, tmdbError: 'interrupted' });
      client.searchMovies.mockResolvedValue(found());

      await service.requestLookup(MOVIE_ID, STAFF);
      await settle();

      expect(statusWrites()[0]).toEqual([
        {
          id: MOVIE_ID,
          tmdbStatus: {
            in: [
              TmdbLookupStatus.NONE,
              TmdbLookupStatus.FAILED,
              TmdbLookupStatus.NOT_FOUND,
              TmdbLookupStatus.NEEDS_PICK,
              // Only ever a PENDING no run holds: see the tests below.
              TmdbLookupStatus.PENDING,
            ],
          },
        },
        { tmdbStatus: TmdbLookupStatus.PENDING, tmdbError: null },
      ]);
      expect(movieNow()).toEqual(
        expect.objectContaining({
          tmdbStatus: TmdbLookupStatus.NOT_FOUND,
          tmdbError: null,
        }),
      );
    });

    it('503 TMDB_NOT_CONFIGURED while the key is missing', async () => {
      haveMovie();
      client.isEnabled = false;

      await expect(
        refusal(service.requestLookup(MOVIE_ID, STAFF)),
      ).resolves.toEqual({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'TMDB_NOT_CONFIGURED',
      });
      expect(prisma.movie.findUnique).not.toHaveBeenCalled();
    });

    it('404 for a movie that does not exist', async () => {
      await expect(service.requestLookup(MOVIE_ID, STAFF)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('400 TMDB_NOT_A_MOVIE for an episode', async () => {
      haveMovie({ seriesId: 'series-1' });

      await expect(
        refusal(service.requestLookup(MOVIE_ID, STAFF)),
      ).resolves.toEqual({
        status: HttpStatus.BAD_REQUEST,
        code: 'TMDB_NOT_A_MOVIE',
      });
      expect(prisma.movie.updateMany).not.toHaveBeenCalled();
    });

    it('409 TMDB_BUSY while a lookup is PENDING and running', async () => {
      haveMovie({ tmdbStatus: TmdbLookupStatus.PENDING });
      // A lookup that is alive holds the movie's run.
      runs.tryStart(movieRunKey(MOVIE_ID));

      await expect(
        refusal(service.requestLookup(MOVIE_ID, STAFF)),
      ).resolves.toEqual({ status: HttpStatus.CONFLICT, code: 'TMDB_BUSY' });
      expect(prisma.movie.updateMany).not.toHaveBeenCalled();
      expect(client.searchMovies).not.toHaveBeenCalled();
      expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(true);
    });

    it('takes over a movie that is PENDING with no run behind it', async () => {
      haveMovie({ tmdbStatus: TmdbLookupStatus.PENDING });

      await expect(service.requestLookup(MOVIE_ID, STAFF)).resolves.toEqual({
        status: 'PENDING',
      });
      await settle();

      expect(fill.fillMovieAutomatically).toHaveBeenCalledTimes(1);
      expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.MATCHED);
      expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);
    });

    it('a lookup whose result could not be written at all leaves PENDING — and "Try again" works without a restart', async () => {
      haveMovie();
      client.searchMovies.mockResolvedValue(found());
      // The claim is written; then the database refuses the result, and
      // the FAILED / internal that should stand in for it.
      const write = prisma.movie.updateMany.getMockImplementation() as (
        args: Row,
      ) => Promise<{ count: number }>;
      prisma.movie.updateMany
        .mockImplementationOnce(write)
        .mockRejectedValueOnce(new Error('db down'))
        .mockRejectedValueOnce(new Error('db down'));

      await service.afterUpload(MOVIE_ID, STAFF);

      expect(prisma.movie.updateMany).toHaveBeenCalledTimes(3);
      expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.PENDING);
      expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);

      // The database is back. Before the fix this was 409 TMDB_BUSY until
      // the backend restarted.
      client.searchMovies.mockResolvedValue(found(INCEPTION));
      await expect(service.requestLookup(MOVIE_ID, STAFF)).resolves.toEqual({
        status: 'PENDING',
      });
      await settle();

      expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.MATCHED);
    });

    it('409 TMDB_ALREADY_MATCHED for a linked movie — Refill or Change match instead', async () => {
      haveMovie({ tmdbStatus: TmdbLookupStatus.MATCHED });

      await expect(
        refusal(service.requestLookup(MOVIE_ID, STAFF)),
      ).resolves.toEqual({
        status: HttpStatus.CONFLICT,
        code: 'TMDB_ALREADY_MATCHED',
      });
      expect(client.searchMovies).not.toHaveBeenCalled();
    });

    it('409 TMDB_BUSY while an Apply holds the movie', async () => {
      haveMovie({ tmdbStatus: TmdbLookupStatus.NEEDS_PICK });
      runs.tryStart(movieRunKey(MOVIE_ID));

      await expect(
        refusal(service.requestLookup(MOVIE_ID, STAFF)),
      ).resolves.toEqual({ status: HttpStatus.CONFLICT, code: 'TMDB_BUSY' });
      expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.NEEDS_PICK);
      expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(true);
    });

    it('409 TMDB_BUSY when the claim loses, and the movie is let go of', async () => {
      haveMovie();
      prisma.movie.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        refusal(service.requestLookup(MOVIE_ID, STAFF)),
      ).resolves.toEqual({ status: HttpStatus.CONFLICT, code: 'TMDB_BUSY' });
      expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);
      expect(client.searchMovies).not.toHaveBeenCalled();
    });

    it('lets go of the movie when the claim itself fails', async () => {
      haveMovie();
      prisma.movie.updateMany.mockRejectedValueOnce(new Error('db down'));

      await expect(service.requestLookup(MOVIE_ID, STAFF)).rejects.toThrow(
        'db down',
      );
      expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);
    });

    it('two clicks: the second is told it is busy, and one lookup runs', async () => {
      haveMovie();
      let finishSearch: (value: unknown) => void = () => undefined;
      client.searchMovies.mockReturnValue(
        new Promise((resolve) => {
          finishSearch = resolve;
        }),
      );

      await service.requestLookup(MOVIE_ID, STAFF);
      await expect(
        refusal(service.requestLookup(MOVIE_ID, STAFF)),
      ).resolves.toEqual({ status: HttpStatus.CONFLICT, code: 'TMDB_BUSY' });

      finishSearch(found());
      await settle();
      // One claim, so one lookup (its three searches: A1, A2, A3).
      expect(
        statusWrites().filter(
          ([, data]) => data.tmdbStatus === TmdbLookupStatus.PENDING,
        ),
      ).toHaveLength(1);
      expect(client.searchMovies).toHaveBeenCalledTimes(3);
    });

    it('a background failure never becomes an unhandled rejection: FAILED / internal', async () => {
      haveMovie();
      fill.fillMovieAutomatically.mockRejectedValue(new Error('bug'));

      await service.requestLookup(MOVIE_ID, STAFF);
      await settle();

      expect(movieNow()).toEqual(
        expect.objectContaining({
          tmdbStatus: TmdbLookupStatus.FAILED,
          tmdbError: 'internal',
        }),
      );
      expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  describe('onApplicationBootstrap — lookups a restart interrupted', () => {
    it('marks every PENDING movie FAILED / interrupted, and nothing else', async () => {
      haveMovie({ tmdbStatus: TmdbLookupStatus.PENDING }, 'm-pending-1');
      haveMovie({ tmdbStatus: TmdbLookupStatus.PENDING }, 'm-pending-2');
      haveMovie({ tmdbStatus: TmdbLookupStatus.MATCHED }, 'm-matched');
      haveMovie({ tmdbStatus: TmdbLookupStatus.NEEDS_PICK }, 'm-pick');
      haveMovie({ tmdbStatus: TmdbLookupStatus.NONE }, 'm-none');

      await service.onApplicationBootstrap();

      expect(prisma.movie.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.movie.updateMany).toHaveBeenCalledWith({
        where: { tmdbStatus: TmdbLookupStatus.PENDING },
        data: {
          tmdbStatus: TmdbLookupStatus.FAILED,
          tmdbError: 'interrupted',
        },
      });
      expect(
        ['m-pending-1', 'm-pending-2', 'm-matched', 'm-pick', 'm-none'].map(
          (id) => [movieNow(id).tmdbStatus, movieNow(id).tmdbError],
        ),
      ).toEqual([
        ['FAILED', 'interrupted'],
        ['FAILED', 'interrupted'],
        ['MATCHED', null],
        ['NEEDS_PICK', null],
        ['NONE', null],
      ]);
    });

    it('runs with the key missing too — a key removed while a lookup ran must not leave "Finding details…" forever', async () => {
      client.isEnabled = false;
      haveMovie({ tmdbStatus: TmdbLookupStatus.PENDING });

      await service.onApplicationBootstrap();

      expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.FAILED);
    });

    it('never stops the server from starting', async () => {
      prisma.movie.updateMany.mockRejectedValue(new Error('db not ready'));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('after the reset staff can press "Try again"', async () => {
      haveMovie({ tmdbStatus: TmdbLookupStatus.PENDING });
      await service.onApplicationBootstrap();

      await expect(service.requestLookup(MOVIE_ID, STAFF)).resolves.toEqual({
        status: 'PENDING',
      });
      await settle();
      expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.MATCHED);
    });
  });
});
