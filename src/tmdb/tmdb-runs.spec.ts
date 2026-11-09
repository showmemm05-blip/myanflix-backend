import { HttpStatus } from '@nestjs/common';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import {
  TMDB_ERRORS,
  tmdbBusy,
  tmdbFailureException,
  tmdbNotConfigured,
  type TmdbFailureReason,
} from './tmdb-errors';
import {
  TmdbRunRegistry,
  movieRunKey,
  seriesRunKey,
  tvCreateRunKey,
} from './tmdb-runs';

describe('TmdbRunRegistry — one TMDB run per title at a time', () => {
  let runs: TmdbRunRegistry;

  beforeEach(() => {
    runs = new TmdbRunRegistry();
  });

  it('keeps a movie, a series and a show being created apart, even with the same id', () => {
    expect(movieRunKey('x')).toBe('movie:x');
    expect(seriesRunKey('x')).toBe('series:x');
    expect(tvCreateRunKey(66732)).toBe('tv:66732');
    expect(runs.tryStart(movieRunKey('x'))).toBe(true);
    expect(runs.tryStart(seriesRunKey('x'))).toBe(true);
  });

  it('gives a key to one caller only, until it is finished', () => {
    expect(runs.isRunning('movie:1')).toBe(false);
    expect(runs.tryStart('movie:1')).toBe(true);
    expect(runs.isRunning('movie:1')).toBe(true);
    expect(runs.tryStart('movie:1')).toBe(false);
    expect(runs.tryStart('movie:2')).toBe(true);

    runs.finish('movie:1');

    expect(runs.isRunning('movie:1')).toBe(false);
    expect(runs.tryStart('movie:1')).toBe(true);
  });

  it('exclusive runs the work holding the key and lets go when it is over', async () => {
    const seen: boolean[] = [];

    await expect(
      runs.exclusive('movie:1', async () => {
        seen.push(runs.isRunning('movie:1'));
        return 'done';
      }),
    ).resolves.toBe('done');

    expect(seen).toEqual([true]);
    expect(runs.isRunning('movie:1')).toBe(false);
  });

  it('exclusive lets go when the work fails, and passes the failure on', async () => {
    const failure = new Error('boom');

    await expect(
      runs.exclusive('movie:1', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(runs.isRunning('movie:1')).toBe(false);
  });

  it('exclusive answers 409 TMDB_BUSY while the key is taken — and does not take it from its holder', async () => {
    runs.tryStart('movie:1');
    const work = jest.fn();

    const error: unknown = await runs.exclusive('movie:1', work).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(CodedHttpException);
    expect((error as CodedHttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((error as CodedHttpException).code).toBe('TMDB_BUSY');
    expect(work).not.toHaveBeenCalled();
    expect(runs.isRunning('movie:1')).toBe(true);
  });
});

describe('the coded errors of the /tmdb routes', () => {
  it('are the nine codes the admin branches on', () => {
    expect(Object.values(TMDB_ERRORS).sort()).toEqual(
      [
        'TMDB_NOT_CONFIGURED',
        'TMDB_UNREACHABLE',
        'TMDB_KEY_REJECTED',
        'TMDB_RATE_LIMITED',
        'TMDB_TITLE_NOT_FOUND',
        'TMDB_BUSY',
        'TMDB_ALREADY_MATCHED',
        'TMDB_SERIES_EXISTS',
        'TMDB_NOT_A_MOVIE',
      ].sort(),
    );
  });

  it('503 TMDB_NOT_CONFIGURED tells staff what to do', () => {
    const error = tmdbNotConfigured();

    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(error.getResponse()).toEqual({
      code: 'TMDB_NOT_CONFIGURED',
      message:
        'TMDB is not connected. Add TMDB_API_KEY to the server settings.',
    });
  });

  it('409 TMDB_BUSY', () => {
    expect(tmdbBusy().getStatus()).toBe(HttpStatus.CONFLICT);
    expect(tmdbBusy().getResponse()).toEqual({
      code: 'TMDB_BUSY',
      message: 'Details are being fetched for this title',
    });
  });

  it.each<[TmdbFailureReason, number, string]>([
    ['not_configured', HttpStatus.SERVICE_UNAVAILABLE, 'TMDB_NOT_CONFIGURED'],
    ['key_rejected', HttpStatus.BAD_GATEWAY, 'TMDB_KEY_REJECTED'],
    ['rate_limited', HttpStatus.SERVICE_UNAVAILABLE, 'TMDB_RATE_LIMITED'],
    ['not_found', HttpStatus.NOT_FOUND, 'TMDB_TITLE_NOT_FOUND'],
    ['unreachable', HttpStatus.BAD_GATEWAY, 'TMDB_UNREACHABLE'],
    ['bad_response', HttpStatus.BAD_GATEWAY, 'TMDB_UNREACHABLE'],
  ])('a TMDB failure "%s" is answered %i %s', (reason, status, code) => {
    const error = tmdbFailureException(reason);

    expect(error.getStatus()).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).not.toBe('');
  });
});
