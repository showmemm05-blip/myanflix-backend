import { Logger } from '@nestjs/common';
import type { TmdbFetch, TmdbFetchResponse } from './tmdb-fetch';
import {
  TMDB_IMAGE_BASE,
  TMDB_IMAGE_HOST,
  TMDB_IMAGE_SIZES,
  isTmdbImagePath,
  tmdbImageUrl,
} from './tmdb-image-url';
import { TMDB_IMAGE_TIMEOUT_MS, TmdbImageFetcher } from './tmdb-image.fetcher';

const MAX = 1000;

interface Reply {
  status?: number;
  /** How many bytes the picture has. */
  bytes?: number;
  contentLength?: number;
  /** The body as a stream of chunks of this many bytes each. */
  chunkSizes?: number[];
}

function response(reply: Reply): TmdbFetchResponse & { cancelled: boolean } {
  const chunkSizes = reply.chunkSizes;
  let cursor = 0;
  const answer = {
    cancelled: false,
    status: reply.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' &&
        reply.contentLength !== undefined
          ? String(reply.contentLength)
          : null,
    },
    body: chunkSizes
      ? {
          getReader: () => ({
            read: () =>
              Promise.resolve(
                cursor < chunkSizes.length
                  ? {
                      done: false,
                      value: Buffer.alloc(chunkSizes[cursor++], 7),
                    }
                  : { done: true },
              ),
            cancel: () => {
              answer.cancelled = true;
              return Promise.resolve();
            },
          }),
        }
      : null,
    arrayBuffer: () =>
      Promise.resolve(new Uint8Array(reply.bytes ?? 10).fill(7).buffer),
  };
  return answer;
}

/** A fake fetch answering by the size asked for (`original`, `w780` ...). Nothing here reaches TMDB. */
function fakeFetch(bySize: Record<string, Reply | Error>) {
  const urls: string[] = [];
  const inits: Array<Parameters<TmdbFetch>[1]> = [];
  const fetchImpl = jest.fn<ReturnType<TmdbFetch>, Parameters<TmdbFetch>>(
    async (input, init) => {
      urls.push(input);
      inits.push(init);
      const size = new URL(input).pathname.split('/')[3];
      const reply = bySize[size];
      if (!reply) throw new Error(`unexpected size ${size}`);
      if (reply instanceof Error) throw reply;
      return response(reply);
    },
  );
  return { fetchImpl, urls, inits };
}

const fetcherWith = (fetchImpl: TmdbFetch) =>
  new TmdbImageFetcher({ fetchImpl });

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the TMDB picture address', () => {
  it('is built from the one fixed host and a checked path', () => {
    expect(TMDB_IMAGE_HOST).toBe('image.tmdb.org');
    expect(TMDB_IMAGE_BASE).toBe('https://image.tmdb.org/t/p');
    expect(tmdbImageUrl('original', '/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg')).toBe(
      'https://image.tmdb.org/t/p/original/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg',
    );
    expect(tmdbImageUrl('w185', '/a_b-C1.png')).toBe(
      'https://image.tmdb.org/t/p/w185/a_b-C1.png',
    );
    expect(tmdbImageUrl('h632', '/x.webp')).toBe(
      'https://image.tmdb.org/t/p/h632/x.webp',
    );
  });

  it.each([
    ['a second path segment', '/a/b.jpg'],
    ['a parent folder', '/../x.jpg'],
    ['a dot folder', '/./x.jpg'],
    ['a full address', 'https://evil.example/x.jpg'],
    ['a protocol-relative address', '//evil.example/x.jpg'],
    ['no leading slash', 'x.jpg'],
    ['a query', '/x.jpg?size=1'],
    ['a fragment', '/x.jpg#y'],
    ['an encoded slash', '/a%2Fb.jpg'],
    ['a backslash', '/a\\b.jpg'],
    ['a space', '/a b.jpg'],
    ['an at sign', '/user@evil.example.jpg'],
    ['an extension we do not store', '/x.gif'],
    ['an svg', '/x.svg'],
    ['no extension', '/x'],
    ['an upper-case extension', '/x.JPG'],
    ['a trailing newline', '/x.jpg\n'],
    ['nothing', ''],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s', (_label, path) => {
    expect(isTmdbImagePath(path)).toBe(false);
    expect(tmdbImageUrl('original', path)).toBeNull();
  });

  it("refuses a size that is not one of TMDB's shapes", () => {
    for (const size of [
      '',
      '../x',
      'w',
      'w1',
      'w99999',
      'original/..',
      'W500',
    ]) {
      expect(tmdbImageUrl(size, '/x.jpg')).toBeNull();
    }
  });

  it('asks for a poster and a backdrop at original first, and a photo at h632 only', () => {
    expect(TMDB_IMAGE_SIZES).toEqual({
      poster: ['original', 'w780'],
      backdrop: ['original', 'w1280'],
      profile: ['h632'],
    });
  });
});

describe('TmdbImageFetcher', () => {
  it('downloads from image.tmdb.org only, with a deadline and redirects refused', async () => {
    const { fetchImpl, urls, inits } = fakeFetch({ original: { bytes: 64 } });

    const result = await fetcherWith(fetchImpl).fetch(
      'poster',
      '/poster.jpg',
      MAX,
    );

    expect(result).toEqual({
      ok: true,
      buffer: expect.any(Buffer),
      size: 'original',
    });
    expect(result.ok && result.buffer.length).toBe(64);
    expect(urls).toEqual(['https://image.tmdb.org/t/p/original/poster.jpg']);
    expect(inits[0].redirect).toBe('error');
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
    expect(inits[0].headers).toEqual({ accept: 'image/*' });
  });

  it('gives each download 20 seconds', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const { fetchImpl } = fakeFetch({ original: { bytes: 64 } });

    await fetcherWith(fetchImpl).fetch('poster', '/poster.jpg', MAX);

    expect(timeout.mock.calls).toEqual([[TMDB_IMAGE_TIMEOUT_MS]]);
    expect(TMDB_IMAGE_TIMEOUT_MS).toBe(20_000);
  });

  it.each([
    '/a/b.jpg',
    '/../etc/passwd.jpg',
    'https://evil.example/x.jpg',
    '//evil.example/x.jpg',
    '/x.jpg?redirect=https://evil.example',
    '/x.gif',
    '',
    null,
    undefined,
  ])('never fetches anything for the path %p', async (path) => {
    const { fetchImpl } = fakeFetch({ original: { bytes: 10 } });

    await expect(
      fetcherWith(fetchImpl).fetch('poster', path, MAX),
    ).resolves.toEqual({ ok: false, reason: 'invalid_path' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('every address it asks is on the one host, whatever the kind', async () => {
    const { fetchImpl, urls } = fakeFetch({
      original: { bytes: MAX + 1 },
      w780: { bytes: 10 },
      w1280: { bytes: 10 },
      h632: { bytes: 10 },
    });
    const fetcher = fetcherWith(fetchImpl);

    await fetcher.fetch('poster', '/p.jpg', MAX);
    await fetcher.fetch('backdrop', '/b.jpg', MAX);
    await fetcher.fetch('profile', '/a.jpg', MAX);

    expect(urls).toEqual([
      'https://image.tmdb.org/t/p/original/p.jpg',
      'https://image.tmdb.org/t/p/w780/p.jpg',
      'https://image.tmdb.org/t/p/original/b.jpg',
      'https://image.tmdb.org/t/p/w1280/b.jpg',
      'https://image.tmdb.org/t/p/h632/a.jpg',
    ]);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.host).toBe('image.tmdb.org');
    }
  });

  describe('the byte cap', () => {
    it('a picture of exactly the cap is taken', async () => {
      const { fetchImpl } = fakeFetch({ original: { bytes: MAX } });

      const result = await fetcherWith(fetchImpl).fetch(
        'poster',
        '/p.jpg',
        MAX,
      );

      expect(result.ok && result.buffer.length).toBe(MAX);
    });

    it('an original over the cap falls back to the next size down', async () => {
      const { fetchImpl, urls } = fakeFetch({
        original: { bytes: MAX + 1 },
        w780: { bytes: 300 },
      });

      const result = await fetcherWith(fetchImpl).fetch(
        'poster',
        '/p.jpg',
        MAX,
      );

      expect(result).toEqual({
        ok: true,
        buffer: expect.any(Buffer),
        size: 'w780',
      });
      expect(urls).toHaveLength(2);
    });

    it('is too_large when every size is over the cap', async () => {
      const { fetchImpl, urls } = fakeFetch({
        original: { bytes: MAX + 1 },
        w1280: { bytes: MAX + 1 },
      });

      await expect(
        fetcherWith(fetchImpl).fetch('backdrop', '/b.jpg', MAX),
      ).resolves.toEqual({ ok: false, reason: 'too_large' });
      expect(urls).toHaveLength(2);
    });

    it('refuses on the Content-Length without reading the body', async () => {
      const arrayBuffer = jest.fn();
      const fetchImpl = jest.fn().mockResolvedValue({
        ...response({ contentLength: MAX + 1 }),
        arrayBuffer,
      });

      await expect(
        fetcherWith(fetchImpl).fetch('profile', '/a.jpg', MAX),
      ).resolves.toEqual({ ok: false, reason: 'too_large' });
      expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it('drops a streamed body the moment it passes the cap, whatever its headers said', async () => {
      const lying = response({
        contentLength: 10,
        chunkSizes: [400, 400, 400, 400, 400],
      });
      const fetchImpl = jest.fn().mockResolvedValue(lying);

      await expect(
        fetcherWith(fetchImpl).fetch('profile', '/a.jpg', MAX),
      ).resolves.toEqual({ ok: false, reason: 'too_large' });
      expect(lying.cancelled).toBe(true);
    });

    it('reads a streamed body that fits', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(response({ chunkSizes: [400, 400, 100] }));

      const result = await fetcherWith(fetchImpl).fetch(
        'profile',
        '/a.jpg',
        MAX,
      );

      expect(result.ok && result.buffer.length).toBe(900);
    });
  });

  describe('a picture that cannot be had', () => {
    it('404 is not_found — and is not retried at a smaller size', async () => {
      const { fetchImpl, urls } = fakeFetch({ original: { status: 404 } });

      await expect(
        fetcherWith(fetchImpl).fetch('poster', '/gone.jpg', MAX),
      ).resolves.toEqual({ ok: false, reason: 'not_found' });
      expect(urls).toHaveLength(1);
    });

    it.each([500, 503, 403])('HTTP %i is unreachable', async (status) => {
      const { fetchImpl } = fakeFetch({ original: { status } });

      await expect(
        fetcherWith(fetchImpl).fetch('poster', '/p.jpg', MAX),
      ).resolves.toEqual({ ok: false, reason: 'unreachable' });
    });

    it.each([301, 302, 307, 308])(
      'a redirect (%i) is refused, never followed',
      async (status) => {
        const { fetchImpl, urls } = fakeFetch({ original: { status } });

        await expect(
          fetcherWith(fetchImpl).fetch('poster', '/p.jpg', MAX),
        ).resolves.toEqual({ ok: false, reason: 'unreachable' });
        // One request, to TMDB; nothing was asked anywhere else.
        expect(urls).toEqual(['https://image.tmdb.org/t/p/original/p.jpg']);
      },
    );

    it('the error fetch raises for a redirect (redirect: "error") is unreachable too', async () => {
      const { fetchImpl } = fakeFetch({
        original: new TypeError('fetch failed: unexpected redirect'),
      });

      await expect(
        fetcherWith(fetchImpl).fetch('poster', '/p.jpg', MAX),
      ).resolves.toEqual({ ok: false, reason: 'unreachable' });
    });

    it('a network error that is not a timeout is not retried at a smaller size', async () => {
      const { fetchImpl, urls } = fakeFetch({
        original: Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ENOTFOUND' },
        }),
        w780: { bytes: 300 },
      });

      await expect(
        fetcherWith(fetchImpl).fetch('poster', '/p.jpg', MAX),
      ).resolves.toEqual({ ok: false, reason: 'unreachable' });
      expect(urls).toHaveLength(1);
    });
  });

  describe('a download that runs out of time (a slow line)', () => {
    // What AbortSignal.timeout() makes fetch, or the read of its body, reject with.
    const timeout = () =>
      Object.assign(new Error('timed out'), { name: 'TimeoutError' });

    it.each([
      ['poster', 'w780'],
      ['backdrop', 'w1280'],
    ] as const)(
      'a %s that times out at original is taken at %s instead',
      async (kind, smaller) => {
        const { fetchImpl, urls } = fakeFetch({
          original: timeout(),
          [smaller]: { bytes: 300 },
        });

        const result = await fetcherWith(fetchImpl).fetch(kind, '/p.jpg', MAX);

        expect(result).toEqual({
          ok: true,
          buffer: expect.any(Buffer),
          size: smaller,
        });
        expect(urls).toEqual([
          'https://image.tmdb.org/t/p/original/p.jpg',
          `https://image.tmdb.org/t/p/${smaller}/p.jpg`,
        ]);
      },
    );

    it('an aborted body read counts as a timeout too', async () => {
      const { fetchImpl } = fakeFetch({
        original: Object.assign(new Error('aborted'), { name: 'AbortError' }),
        w780: { bytes: 300 },
      });

      await expect(
        fetcherWith(fetchImpl).fetch('poster', '/p.jpg', MAX),
      ).resolves.toMatchObject({ ok: true, size: 'w780' });
    });

    it('is unreachable when every size times out — two requests, no more', async () => {
      const { fetchImpl, urls } = fakeFetch({
        original: timeout(),
        w780: timeout(),
      });

      await expect(
        fetcherWith(fetchImpl).fetch('poster', '/p.jpg', MAX),
      ).resolves.toEqual({ ok: false, reason: 'unreachable' });
      expect(urls).toHaveLength(2);
    });

    it('the smaller size answering 404 is not_found', async () => {
      const { fetchImpl } = fakeFetch({
        original: timeout(),
        w780: { status: 404 },
      });

      await expect(
        fetcherWith(fetchImpl).fetch('poster', '/p.jpg', MAX),
      ).resolves.toEqual({ ok: false, reason: 'not_found' });
    });

    it("an actor's photo has one size, so its timeout is unreachable after one request", async () => {
      const { fetchImpl, urls } = fakeFetch({ h632: timeout() });

      await expect(
        fetcherWith(fetchImpl).fetch('profile', '/a.jpg', MAX),
      ).resolves.toEqual({ ok: false, reason: 'unreachable' });
      expect(urls).toHaveLength(1);
    });
  });

  describe('a broken fetch', () => {
    it('never throws, whatever the fetch does', async () => {
      const broken = [
        jest.fn(() => {
          throw new Error('sync throw');
        }),
        jest.fn().mockRejectedValue('a string'),
        jest.fn().mockResolvedValue(undefined),
        jest.fn().mockResolvedValue({ status: 200 }),
      ];

      for (const fetchImpl of broken) {
        await expect(
          fetcherWith(fetchImpl as never).fetch('poster', '/p.jpg', MAX),
        ).resolves.toEqual({ ok: false, reason: 'unreachable' });
      }
    });
  });

  it('uses the real fetch when none is injected (production wiring)', () => {
    expect(() => new TmdbImageFetcher()).not.toThrow();
  });
});
