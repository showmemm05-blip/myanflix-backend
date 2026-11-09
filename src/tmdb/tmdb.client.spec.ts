import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TmdbFetch, TmdbFetchResponse } from './tmdb-fetch';
import {
  TMDB_API_BASE,
  TMDB_DETAILS_BODY_MAX_BYTES,
  TMDB_MAX_IN_FLIGHT,
  TMDB_REQUEST_TIMEOUT_MS,
  TMDB_SEARCH_BODY_MAX_BYTES,
  TMDB_STATUS_TIMEOUT_MS,
  TmdbClient,
  retryAfterMs,
} from './tmdb.client';

/** The two credentials TMDB hands out. Made up: neither opens anything. */
const V3_KEY = '0123456789abcdef0123456789ABCDEF';
const READ_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.made-up-read-access-token.signature';

interface Reply {
  status?: number;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as it is (for a body that is not JSON). */
  text?: string;
  retryAfter?: string;
  contentLength?: number;
  /** The body as a stream of chunks instead of one buffer. */
  chunks?: string[];
}

function response(reply: Reply): TmdbFetchResponse & { cancelled: boolean } {
  const text = reply.text ?? JSON.stringify(reply.json ?? {});
  const chunks = reply.chunks;
  let cursor = 0;
  const answer = {
    cancelled: false,
    status: reply.status ?? 200,
    headers: {
      get: (name: string) => {
        const header = name.toLowerCase();
        if (header === 'retry-after') return reply.retryAfter ?? null;
        if (header === 'content-length') {
          return reply.contentLength === undefined
            ? null
            : String(reply.contentLength);
        }
        return null;
      },
    },
    body: chunks
      ? {
          getReader: () => ({
            read: () =>
              Promise.resolve(
                cursor < chunks.length
                  ? { done: false, value: Buffer.from(chunks[cursor++]) }
                  : { done: true },
              ),
            cancel: () => {
              answer.cancelled = true;
              return Promise.resolve();
            },
          }),
        }
      : null,
    arrayBuffer: () => {
      const bytes = Buffer.from(text, 'utf8');
      return Promise.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
    },
  };
  return answer;
}

type Step = Reply | Error | ((url: URL) => Reply | Error);

/**
 * A fake fetch: answers the calls in order with `steps` (the last one
 * repeats), or by URL when a step is a function. Nothing here reaches TMDB.
 */
function fakeFetch(...steps: Step[]) {
  const calls: Array<{ url: URL; init: Parameters<TmdbFetch>[1] }> = [];
  const fetchImpl = jest.fn<ReturnType<TmdbFetch>, Parameters<TmdbFetch>>(
    async (input, init) => {
      const url = new URL(input);
      const step = steps[Math.min(calls.length, steps.length - 1)];
      calls.push({ url, init });
      const reply = typeof step === 'function' ? step(url) : step;
      if (reply instanceof Error) throw reply;
      return response(reply);
    },
  );
  return { fetchImpl, calls };
}

function makeClient(
  key: string | undefined,
  fetchImpl: TmdbFetch,
  sleep: jest.Mock = jest.fn().mockResolvedValue(undefined),
) {
  const config = {
    get: jest.fn((name: string) => (name === 'TMDB_API_KEY' ? key : undefined)),
  } as unknown as ConfigService;
  return { client: new TmdbClient(config, { fetchImpl, sleep }), sleep };
}

const searchPage = (...titles: string[]) => ({
  page: 1,
  results: titles.map((title, index) => ({
    id: index + 1,
    title,
    original_title: title,
    release_date: '2010-07-16',
    overview: 'Story.',
    poster_path: '/p.jpg',
    original_language: 'en',
  })),
});

const movieJson = (extra: Record<string, unknown> = {}) => ({
  id: 27205,
  title: 'Inception',
  original_title: 'Inception',
  overview: 'A thief.',
  release_date: '2010-07-15',
  runtime: 148,
  genres: [{ id: 28, name: 'Action' }],
  original_language: 'en',
  production_countries: [{ iso_3166_1: 'US', name: 'United States' }],
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  ...extra,
});

const creditsJson = {
  cast: [
    {
      id: 6193,
      name: 'Leonardo DiCaprio',
      character: 'Cobb',
      order: 0,
      profile_path: '/leo.jpg',
    },
  ],
  crew: [{ id: 525, name: 'Christopher Nolan', job: 'Director' }],
};

const releaseDatesJson = {
  results: [
    { iso_3166_1: 'GB', release_dates: [{ certification: '12A', type: 3 }] },
    { iso_3166_1: 'US', release_dates: [{ certification: 'PG-13', type: 3 }] },
  ],
};

/** Everything the three Logger levels were given during a test, as one text. */
function logged(): string {
  return [warnSpy, errorSpy, logSpy]
    .flatMap((spy) => spy.mock.calls)
    .map((args) => args.map(String).join(' '))
    .join('\n');
}

let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('retryAfterMs', () => {
  it('reads seconds, waits 2 s when the header says nothing, and never more than 10 s', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(' 1.5 ')).toBe(1500);
    expect(retryAfterMs(null)).toBe(2000);
    expect(retryAfterMs('')).toBe(2000);
    expect(retryAfterMs('soon')).toBe(2000);
    expect(retryAfterMs('120')).toBe(10_000);
    expect(retryAfterMs('0')).toBe(0);
    expect(retryAfterMs('-5')).toBe(0);
  });

  it('reads an HTTP date as the time left until then', () => {
    const now = Date.parse('2026-11-06T10:00:00Z');
    expect(retryAfterMs('Fri, 06 Nov 2026 10:00:04 GMT', now)).toBe(4000);
    expect(retryAfterMs('Fri, 06 Nov 2026 11:00:00 GMT', now)).toBe(10_000);
    expect(retryAfterMs('Fri, 06 Nov 2026 09:00:00 GMT', now)).toBe(0);
  });
});

describe('TmdbClient', () => {
  describe('the key', () => {
    it.each([undefined, '', '   '])(
      'TMDB_API_KEY %p = the feature is off: nothing is fetched',
      async (key) => {
        const { fetchImpl } = fakeFetch({ json: searchPage('Inception') });
        const { client } = makeClient(key, fetchImpl);

        expect(client.isEnabled).toBe(false);
        const off = { ok: false, reason: 'not_configured' };
        await expect(client.searchMovies('Inception', 2010)).resolves.toEqual(
          off,
        );
        await expect(client.searchTv('Dark', null)).resolves.toEqual(off);
        await expect(client.movieDetails(1)).resolves.toEqual(off);
        await expect(client.tvDetails(1)).resolves.toEqual(off);
        await expect(client.checkConnection()).resolves.toEqual(off);
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );

    it('a 32-hex value is the v3 key: sent as the api_key parameter, no Authorization header', async () => {
      const { fetchImpl, calls } = fakeFetch({ json: searchPage('Inception') });
      const { client } = makeClient(V3_KEY, fetchImpl);

      expect(client.isEnabled).toBe(true);
      await client.searchMovies('Inception', null);

      expect(calls[0].url.searchParams.get('api_key')).toBe(V3_KEY);
      expect(calls[0].init.headers).toEqual({ accept: 'application/json' });
    });

    it('anything else is the read access token: sent as Authorization: Bearer, never in the URL', async () => {
      const { fetchImpl, calls } = fakeFetch({ json: searchPage('Inception') });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await client.searchMovies('Inception', null);

      expect(calls[0].init.headers).toEqual({
        accept: 'application/json',
        authorization: `Bearer ${READ_TOKEN}`,
      });
      expect(calls[0].url.searchParams.has('api_key')).toBe(false);
      expect(calls[0].url.toString()).not.toContain(READ_TOKEN);
    });

    it('drops the blanks a pasted key carries', async () => {
      const { fetchImpl, calls } = fakeFetch({ json: searchPage() });
      const { client } = makeClient(`  ${V3_KEY}\n`, fetchImpl);

      await client.searchMovies('x', null);

      expect(calls[0].url.searchParams.get('api_key')).toBe(V3_KEY);
    });

    it.each([
      ['a v3 key', V3_KEY],
      ['a read access token', READ_TOKEN],
    ])(
      '%s never appears in a result or a log line, whatever goes wrong',
      async (_label, key) => {
        // Node puts the request URL into some fetch errors — with the key
        // and the film name in it.
        const leaky = new TypeError(
          `fetch failed: ${TMDB_API_BASE}/search/movie?api_key=${key}&query=Secret+Film (Bearer ${key})`,
        );
        const steps: Step[] = [
          { json: searchPage('Secret Film') },
          { status: 401 },
          { status: 404 },
          { status: 500 },
          { status: 429 },
          { status: 429 },
          { status: 429 },
          { text: `not json ${key}` },
          { json: { nothing: key } },
          leaky,
          Object.assign(new Error('boom'), { cause: { code: 'ECONNRESET' } }),
          { json: movieJson({ credits: creditsJson }), status: 200 },
          { status: 500 },
        ];
        const { fetchImpl } = fakeFetch(...steps);
        const { client } = makeClient(key, fetchImpl);

        const results = [
          await client.searchMovies('Secret Film', 2010),
          await client.searchMovies('Secret Film', null),
          await client.movieDetails(5),
          await client.tvDetails(5),
          await client.searchTv('Secret Film', 1999),
          await client.searchMovies('Secret Film', null),
          await client.searchMovies('Secret Film', null),
          await client.searchMovies('Secret Film', null),
          await client.searchMovies('Secret Film', null),
          await client.movieDetails(5),
          await client.checkConnection(),
        ];

        expect(JSON.stringify(results)).not.toContain(key);
        expect(warnSpy).toHaveBeenCalled();
        const lines = logged();
        expect(lines).not.toContain(key);
        // Nor the words staff searched for, nor any query string at all.
        expect(lines).not.toMatch(/Secret/i);
        expect(lines).not.toContain('?');
        expect(lines).not.toContain('api_key');
        expect(lines).not.toContain('Bearer');
      },
    );
  });

  describe('a request', () => {
    it('is a GET to api.themoviedb.org/3 with a deadline and redirects refused', async () => {
      const { fetchImpl, calls } = fakeFetch({ json: searchPage('Inception') });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await client.searchMovies('  Inception ', 2010);

      const { url, init } = calls[0];
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://api.themoviedb.org/3/search/movie',
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        query: 'Inception',
        language: 'en-US',
        include_adult: 'false',
        page: '1',
        year: '2010',
      });
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(Object.keys(init)).toEqual(['signal', 'headers', 'redirect']);
    });

    it('gives every request 10 seconds, and the connection check 5', async () => {
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      const { fetchImpl } = fakeFetch({
        json: { ...searchPage('Inception'), ...movieJson() },
      });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await client.searchMovies('Inception', null);
      await client.searchTv('Dark', null);
      await client.movieDetails(27205);
      await client.tvDetails(66732);
      expect(timeout.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(new Set(timeout.mock.calls.map(([ms]) => ms))).toEqual(
        new Set([TMDB_REQUEST_TIMEOUT_MS]),
      );
      expect(TMDB_REQUEST_TIMEOUT_MS).toBe(10_000);

      timeout.mockClear();
      await client.checkConnection();
      expect(timeout.mock.calls).toEqual([[TMDB_STATUS_TIMEOUT_MS]]);
      expect(TMDB_STATUS_TIMEOUT_MS).toBe(5_000);
    });

    it('sends the year filter only when there is a year; a show uses first_air_date_year', async () => {
      const { fetchImpl, calls } = fakeFetch({ json: { results: [] } });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await client.searchMovies('Inception', null);
      await client.searchTv('Dark', 2017);
      await client.searchTv('Dark', null);

      expect(calls[0].url.searchParams.has('year')).toBe(false);
      expect(calls[1].url.pathname).toBe('/3/search/tv');
      expect(calls[1].url.searchParams.get('first_air_date_year')).toBe('2017');
      expect(calls[1].url.searchParams.has('year')).toBe(false);
      expect(calls[2].url.searchParams.has('first_air_date_year')).toBe(false);
    });

    it('an empty name asks nothing and finds nothing', async () => {
      const { fetchImpl } = fakeFetch({ json: searchPage('x') });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.searchMovies('   ', 2010)).resolves.toEqual({
        ok: true,
        data: [],
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reads a search page into rows, movie and show alike', async () => {
      const { fetchImpl } = fakeFetch((url) =>
        url.pathname.endsWith('/tv')
          ? {
              json: {
                results: [
                  {
                    id: 66732,
                    name: 'Stranger Things',
                    original_name: 'Stranger Things',
                    first_air_date: '2016-07-15',
                    overview: 'A boy vanishes.',
                    poster_path: null,
                    original_language: 'en',
                  },
                ],
              },
            }
          : { json: searchPage('Inception') },
      );
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.searchMovies('Inception', null)).resolves.toEqual({
        ok: true,
        data: [
          {
            id: 1,
            title: 'Inception',
            originalTitle: 'Inception',
            releaseDate: '2010-07-16',
            overview: 'Story.',
            posterPath: '/p.jpg',
            originalLanguage: 'en',
          },
        ],
      });
      await expect(client.searchTv('Stranger Things', null)).resolves.toEqual({
        ok: true,
        data: [
          {
            id: 66732,
            title: 'Stranger Things',
            originalTitle: 'Stranger Things',
            releaseDate: '2016-07-15',
            overview: 'A boy vanishes.',
            posterPath: null,
            originalLanguage: 'en',
          },
        ],
      });
    });
  });

  describe('when TMDB lets us down', () => {
    it.each([
      [401, 'key_rejected'],
      [404, 'not_found'],
      [500, 'unreachable'],
      [502, 'unreachable'],
      [503, 'unreachable'],
      [403, 'unreachable'],
      [302, 'unreachable'],
    ])('HTTP %i -> %s, with no retry', async (status, reason) => {
      const { fetchImpl } = fakeFetch({ status });
      const { client, sleep } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.movieDetails(27205)).resolves.toEqual({
        ok: false,
        reason,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('a timeout is unreachable', async () => {
      // What AbortSignal.timeout() makes fetch reject with.
      const timeout = Object.assign(
        new Error('The operation was aborted due to timeout'),
        { name: 'TimeoutError' },
      );
      const { fetchImpl } = fakeFetch(timeout);
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.searchMovies('Inception', null)).resolves.toEqual({
        ok: false,
        reason: 'unreachable',
      });
      expect(logged()).toContain('TMDB /search/movie: timed out');
    });

    it('a network error is unreachable, logged by its class and system code only', async () => {
      const refused = Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      });
      const { fetchImpl } = fakeFetch(refused);
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.tvDetails(1)).resolves.toEqual({
        ok: false,
        reason: 'unreachable',
      });
      expect(logged()).toContain('TMDB /tv/1: TypeError ECONNREFUSED');
    });

    it('a body that says it is over the cap is refused before it is read', async () => {
      const { fetchImpl } = fakeFetch({
        json: searchPage('Inception'),
        contentLength: TMDB_SEARCH_BODY_MAX_BYTES + 1,
      });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.searchMovies('Inception', null)).resolves.toEqual({
        ok: false,
        reason: 'bad_response',
      });
    });

    it('a streamed body is dropped the moment it passes the cap', async () => {
      const chunk = 'x'.repeat(1024 * 1024);
      const oversized = response({
        chunks: Array.from({ length: 5 }, () => chunk),
      });
      const fetchImpl = jest.fn().mockResolvedValue(oversized);
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.searchMovies('Inception', null)).resolves.toEqual({
        ok: false,
        reason: 'bad_response',
      });
      expect(oversized.cancelled).toBe(true);
    });

    it('details may be larger than a search page, but are capped too', async () => {
      expect(TMDB_DETAILS_BODY_MAX_BYTES).toBeGreaterThan(
        TMDB_SEARCH_BODY_MAX_BYTES,
      );
      const { fetchImpl } = fakeFetch({
        json: movieJson(),
        contentLength: TMDB_DETAILS_BODY_MAX_BYTES + 1,
      });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.movieDetails(27205)).resolves.toEqual({
        ok: false,
        reason: 'bad_response',
      });
    });

    it('a body that is not JSON is a bad response', async () => {
      const { fetchImpl } = fakeFetch({ text: '<html>Bad gateway</html>' });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.searchMovies('Inception', null)).resolves.toEqual({
        ok: false,
        reason: 'bad_response',
      });
    });

    it.each([
      ['a search answer without a results list', { page: 1 }],
      ['a list where an object was expected', [1, 2, 3]],
      ['null', null],
    ])('%s is a bad response', async (_label, json) => {
      const { fetchImpl } = fakeFetch({ text: JSON.stringify(json) });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.searchMovies('Inception', null)).resolves.toEqual({
        ok: false,
        reason: 'bad_response',
      });
      await expect(client.movieDetails(1)).resolves.toEqual({
        ok: false,
        reason: 'bad_response',
      });
      await expect(client.tvDetails(1)).resolves.toEqual({
        ok: false,
        reason: 'bad_response',
      });
    });

    it('never throws, whatever the fetch does', async () => {
      const broken = [
        jest.fn(() => {
          throw new Error('sync throw');
        }),
        jest.fn().mockRejectedValue('a string, not an Error'),
        jest.fn().mockResolvedValue(undefined),
        jest.fn().mockResolvedValue({ status: 200 }),
        jest.fn().mockResolvedValue({
          status: 200,
          headers: { get: () => null },
          arrayBuffer: () => Promise.reject(new Error('stream broke')),
        }),
      ];

      for (const fetchImpl of broken) {
        const { client } = makeClient(READ_TOKEN, fetchImpl as never);
        for (const call of [
          () => client.searchMovies('Inception', 2010),
          () => client.searchTv('Dark', null),
          () => client.movieDetails(1),
          () => client.tvDetails(1),
          () => client.checkConnection(),
        ]) {
          const result = await call();
          expect(result.ok).toBe(false);
        }
      }
    });
  });

  describe('429 — the only thing retried', () => {
    it('waits what Retry-After says, then tries again', async () => {
      const { fetchImpl } = fakeFetch(
        { status: 429, retryAfter: '3' },
        { json: searchPage('Inception') },
      );
      const { client, sleep } = makeClient(READ_TOKEN, fetchImpl);

      const result = await client.searchMovies('Inception', null);

      expect(result.ok).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sleep.mock.calls).toEqual([[3000]]);
    });

    it('waits 2 s when there is no Retry-After', async () => {
      const { fetchImpl } = fakeFetch(
        { status: 429 },
        { json: searchPage('Inception') },
      );
      const { client, sleep } = makeClient(READ_TOKEN, fetchImpl);

      await client.searchMovies('Inception', null);

      expect(sleep.mock.calls).toEqual([[2000]]);
    });

    it('never waits more than 10 s, however long TMDB asks for', async () => {
      const { fetchImpl } = fakeFetch(
        { status: 429, retryAfter: '3600' },
        { json: searchPage('Inception') },
      );
      const { client, sleep } = makeClient(READ_TOKEN, fetchImpl);

      await client.searchMovies('Inception', null);

      expect(sleep.mock.calls).toEqual([[10_000]]);
    });

    it('retries twice at most: a third 429 is rate_limited', async () => {
      const { fetchImpl } = fakeFetch({ status: 429, retryAfter: '1' });
      const { client, sleep } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.searchMovies('Inception', null)).resolves.toEqual({
        ok: false,
        reason: 'rate_limited',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('succeeds on the second retry', async () => {
      const { fetchImpl } = fakeFetch(
        { status: 429 },
        { status: 429 },
        { json: searchPage('Inception') },
      );
      const { client, sleep } = makeClient(READ_TOKEN, fetchImpl);

      const result = await client.searchMovies('Inception', null);

      expect(result.ok).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('does not retry anything else after a 429 was waited out', async () => {
      const { fetchImpl } = fakeFetch({ status: 429 }, { status: 500 });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.searchMovies('Inception', null)).resolves.toEqual({
        ok: false,
        reason: 'unreachable',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('movieDetails', () => {
    it('asks for credits and release dates in the same request and merges them', async () => {
      const { fetchImpl, calls } = fakeFetch({
        json: movieJson({
          credits: creditsJson,
          release_dates: releaseDatesJson,
        }),
      });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.movieDetails(27205)).resolves.toEqual({
        ok: true,
        data: {
          id: 27205,
          title: 'Inception',
          originalTitle: 'Inception',
          overview: 'A thief.',
          releaseDate: '2010-07-15',
          runtime: 148,
          genres: [{ id: 28, name: 'Action' }],
          originalLanguage: 'en',
          productionCountries: ['US'],
          posterPath: '/poster.jpg',
          backdropPath: '/backdrop.jpg',
          cast: [
            {
              id: 6193,
              name: 'Leonardo DiCaprio',
              characters: ['Cobb'],
              order: 0,
              profilePath: '/leo.jpg',
            },
          ],
          crew: [{ name: 'Christopher Nolan', job: 'Director' }],
          usCertifications: [{ certification: 'PG-13', type: 3 }],
        },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(calls[0].url.pathname).toBe('/3/movie/27205');
      expect(calls[0].url.searchParams.get('append_to_response')).toBe(
        'credits,release_dates',
      );
      expect(calls[0].url.searchParams.get('language')).toBe('en-US');
    });

    it('fetches the credits separately when the answer does not carry them', async () => {
      const { fetchImpl, calls } = fakeFetch((url) => {
        if (url.pathname === '/3/movie/27205/credits') {
          return { json: creditsJson };
        }
        return { json: movieJson({ release_dates: releaseDatesJson }) };
      });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      const result = await client.movieDetails(27205);

      expect(calls.map((call) => call.url.pathname)).toEqual([
        '/3/movie/27205',
        '/3/movie/27205/credits',
      ]);
      expect(result.ok && result.data.cast.map((row) => row.name)).toEqual([
        'Leonardo DiCaprio',
      ]);
      expect(result.ok && result.data.crew).toEqual([
        { name: 'Christopher Nolan', job: 'Director' },
      ]);
    });

    it('fetches the release dates separately when the answer does not carry them', async () => {
      const { fetchImpl, calls } = fakeFetch((url) => {
        if (url.pathname === '/3/movie/27205/release_dates') {
          return { json: releaseDatesJson };
        }
        return { json: movieJson({ credits: creditsJson }) };
      });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      const result = await client.movieDetails(27205);

      expect(calls.map((call) => call.url.pathname)).toEqual([
        '/3/movie/27205',
        '/3/movie/27205/release_dates',
      ]);
      expect(result.ok && result.data.usCertifications).toEqual([
        { certification: 'PG-13', type: 3 },
      ]);
    });

    it('fetches both when append_to_response was ignored altogether', async () => {
      const { fetchImpl, calls } = fakeFetch((url) => {
        if (url.pathname.endsWith('/credits')) return { json: creditsJson };
        if (url.pathname.endsWith('/release_dates')) {
          return { json: releaseDatesJson };
        }
        return { json: movieJson() };
      });
      const { client } = makeClient(V3_KEY, fetchImpl);

      const result = await client.movieDetails(27205);

      expect(result.ok).toBe(true);
      expect(calls.map((call) => call.url.pathname)).toEqual([
        '/3/movie/27205',
        '/3/movie/27205/credits',
        '/3/movie/27205/release_dates',
      ]);
      // The separate calls carry the key the same way.
      expect(
        calls.every((call) => call.url.searchParams.get('api_key') === V3_KEY),
      ).toBe(true);
    });

    it('a film TMDB has no credits page for (404) simply has no cast', async () => {
      const { fetchImpl } = fakeFetch((url) =>
        url.pathname === '/3/movie/27205'
          ? { json: movieJson() }
          : { status: 404 },
      );
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      const result = await client.movieDetails(27205);

      expect(result).toEqual({
        ok: true,
        data: expect.objectContaining({
          title: 'Inception',
          cast: [],
          crew: [],
          usCertifications: [],
        }),
      });
    });

    it('fails as a whole when a separate call fails — a fill never runs on half an answer', async () => {
      const { fetchImpl } = fakeFetch((url) =>
        url.pathname === '/3/movie/27205'
          ? { json: movieJson() }
          : { status: 500 },
      );
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.movieDetails(27205)).resolves.toEqual({
        ok: false,
        reason: 'unreachable',
      });
    });

    it('an id TMDB does not know is not_found', async () => {
      const { fetchImpl } = fakeFetch({ status: 404 });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.movieDetails(999999999)).resolves.toEqual({
        ok: false,
        reason: 'not_found',
      });
    });
  });

  describe('tvDetails', () => {
    const tvJson = (extra: Record<string, unknown> = {}) => ({
      id: 66732,
      name: 'Stranger Things',
      original_name: 'Stranger Things',
      overview: 'A boy vanishes.',
      first_air_date: '2016-07-15',
      genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }],
      original_language: 'en',
      origin_country: ['US'],
      poster_path: '/st.jpg',
      backdrop_path: '/st-wide.jpg',
      ...extra,
    });
    const aggregate = {
      cast: [
        {
          id: 1,
          name: 'Winona Ryder',
          roles: [{ character: 'Joyce Byers' }, { character: 'Joyce' }],
          order: 0,
          profile_path: '/wr.jpg',
        },
      ],
    };

    it('takes the aggregate credits appended to the details', async () => {
      const { fetchImpl, calls } = fakeFetch({
        json: tvJson({ aggregate_credits: aggregate }),
      });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.tvDetails(66732)).resolves.toEqual({
        ok: true,
        data: {
          id: 66732,
          title: 'Stranger Things',
          originalTitle: 'Stranger Things',
          overview: 'A boy vanishes.',
          firstAirDate: '2016-07-15',
          genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }],
          originalLanguage: 'en',
          originCountries: ['US'],
          posterPath: '/st.jpg',
          backdropPath: '/st-wide.jpg',
          cast: [
            {
              id: 1,
              name: 'Winona Ryder',
              characters: ['Joyce Byers', 'Joyce'],
              order: 0,
              profilePath: '/wr.jpg',
            },
          ],
        },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(calls[0].url.pathname).toBe('/3/tv/66732');
      expect(calls[0].url.searchParams.get('append_to_response')).toBe(
        'aggregate_credits',
      );
    });

    it('fetches the aggregate credits separately when they are missing', async () => {
      const { fetchImpl, calls } = fakeFetch((url) =>
        url.pathname.endsWith('/aggregate_credits')
          ? { json: aggregate }
          : { json: tvJson() },
      );
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      const result = await client.tvDetails(66732);

      expect(calls.map((call) => call.url.pathname)).toEqual([
        '/3/tv/66732',
        '/3/tv/66732/aggregate_credits',
      ]);
      expect(result.ok && result.data.cast).toHaveLength(1);
    });

    it('falls back to the plain credits when the aggregate cast is empty', async () => {
      const { fetchImpl, calls } = fakeFetch((url) =>
        url.pathname.endsWith('/credits')
          ? {
              json: {
                cast: [
                  {
                    id: 2,
                    name: 'David Harbour',
                    character: 'Jim Hopper',
                    order: 1,
                    profile_path: null,
                  },
                ],
              },
            }
          : { json: tvJson({ aggregate_credits: { cast: [] } }) },
      );
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      const result = await client.tvDetails(66732);

      expect(calls.map((call) => call.url.pathname)).toEqual([
        '/3/tv/66732',
        '/3/tv/66732/credits',
      ]);
      expect(result.ok && result.data.cast).toEqual([
        {
          id: 2,
          name: 'David Harbour',
          characters: ['Jim Hopper'],
          order: 1,
          profilePath: null,
        },
      ]);
    });

    it('a show with no credits anywhere has no cast, and is still a show', async () => {
      const { fetchImpl, calls } = fakeFetch((url) =>
        url.pathname === '/3/tv/66732' ? { json: tvJson() } : { status: 404 },
      );
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      const result = await client.tvDetails(66732);

      expect(calls.map((call) => call.url.pathname)).toEqual([
        '/3/tv/66732',
        '/3/tv/66732/aggregate_credits',
        '/3/tv/66732/credits',
      ]);
      expect(result).toEqual({
        ok: true,
        data: expect.objectContaining({ title: 'Stranger Things', cast: [] }),
      });
    });
  });

  describe('checkConnection — behind GET /tmdb/status', () => {
    it('asks /configuration once and says whether TMDB accepts the key', async () => {
      const { fetchImpl, calls } = fakeFetch({ json: { images: {} } });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.checkConnection()).resolves.toEqual({
        ok: true,
        data: true,
      });
      expect(calls[0].url.pathname).toBe('/3/configuration');
      expect([...calls[0].url.searchParams.keys()]).toEqual([]);
    });

    it.each([
      [401, 'key_rejected'],
      [500, 'unreachable'],
    ])('HTTP %i -> %s', async (status, reason) => {
      const { fetchImpl } = fakeFetch({ status });
      const { client } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.checkConnection()).resolves.toEqual({
        ok: false,
        reason,
      });
    });

    it('does not wait out a 429: staff are looking at a spinner', async () => {
      const { fetchImpl } = fakeFetch({ status: 429, retryAfter: '5' });
      const { client, sleep } = makeClient(READ_TOKEN, fetchImpl);

      await expect(client.checkConnection()).resolves.toEqual({
        ok: false,
        reason: 'rate_limited',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  it(`keeps at most ${TMDB_MAX_IN_FLIGHT} requests in flight in the whole process`, async () => {
    let inFlight = 0;
    let most = 0;
    const waiting: Array<() => void> = [];
    const fetchImpl: TmdbFetch = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => waiting.push(resolve));
      inFlight -= 1;
      return response({ json: searchPage('x') });
    };
    const { client } = makeClient(READ_TOKEN, fetchImpl);

    const all = Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        client.searchMovies(`film ${index}`, null),
      ),
    );
    // Let every call that can start, start.
    await new Promise((resolve) => setImmediate(resolve));
    expect(inFlight).toBe(TMDB_MAX_IN_FLIGHT);

    while (waiting.length > 0 || inFlight > 0) {
      waiting.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const results = await all;

    expect(results.every((result) => result.ok)).toBe(true);
    expect(most).toBe(TMDB_MAX_IN_FLIGHT);
  });
});
