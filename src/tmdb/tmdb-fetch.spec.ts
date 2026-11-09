import {
  describeFetchError,
  discardBody,
  readBodyCapped,
  type TmdbFetchResponse,
} from './tmdb-fetch';

/** A response whose body is a stream of chunks of the given sizes. */
function streamed(
  sizes: number[],
  contentLength?: number,
): TmdbFetchResponse & { cancelled: number; reads: number } {
  let cursor = 0;
  const answer = {
    cancelled: 0,
    reads: 0,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' && contentLength !== undefined
          ? String(contentLength)
          : null,
    },
    body: {
      getReader: () => ({
        read: () => {
          answer.reads += 1;
          return Promise.resolve(
            cursor < sizes.length
              ? { done: false, value: Buffer.alloc(sizes[cursor++], 1) }
              : { done: true },
          );
        },
        cancel: () => {
          answer.cancelled += 1;
          return Promise.resolve();
        },
      }),
    },
    arrayBuffer: () => Promise.reject(new Error('the stream is read instead')),
  };
  return answer;
}

/** A response with no stream (what the specs' simpler fakes hand in). */
const whole = (bytes: number, contentLength?: number): TmdbFetchResponse => ({
  status: 200,
  headers: {
    get: (name: string) =>
      name.toLowerCase() === 'content-length' && contentLength !== undefined
        ? String(contentLength)
        : null,
  },
  body: null,
  arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
});

describe('readBodyCapped', () => {
  it('reads a stream that fits, chunk by chunk', async () => {
    const body = await readBodyCapped(streamed([300, 300, 400]), 1000);

    expect(body).toHaveLength(1000);
  });

  it('drops a stream the moment it passes the cap, and reads no further', async () => {
    const response = streamed([400, 400, 400, 400, 400]);

    await expect(readBodyCapped(response, 1000)).resolves.toBeNull();
    expect(response.cancelled).toBe(1);
    // Three chunks were enough to know.
    expect(response.reads).toBe(3);
  });

  it('refuses on the Content-Length alone, reading nothing', async () => {
    const response = streamed([10], 1001);

    await expect(readBodyCapped(response, 1000)).resolves.toBeNull();
    expect(response.reads).toBe(0);
    expect(response.cancelled).toBe(1);
  });

  it('does not trust a Content-Length that says the body is small', async () => {
    const response = streamed([600, 600], 10);

    await expect(readBodyCapped(response, 1000)).resolves.toBeNull();
  });

  it('ignores a Content-Length it cannot read', async () => {
    const odd: TmdbFetchResponse = {
      ...whole(5),
      headers: { get: () => 'many' },
    };

    await expect(readBodyCapped(odd, 1000)).resolves.toHaveLength(5);
  });

  it('measures a body that has no stream', async () => {
    await expect(readBodyCapped(whole(1000), 1000)).resolves.toHaveLength(1000);
    await expect(readBodyCapped(whole(1001), 1000)).resolves.toBeNull();
    await expect(readBodyCapped(whole(0), 1000)).resolves.toHaveLength(0);
  });
});

describe('discardBody', () => {
  it('lets go of a body nobody will read', async () => {
    const response = streamed([10]);

    await discardBody(response);

    expect(response.cancelled).toBe(1);
  });

  it('never throws — not for a missing body, nor for one that is already locked', async () => {
    await expect(discardBody(whole(1))).resolves.toBeUndefined();
    await expect(
      discardBody({
        ...whole(1),
        body: {
          getReader: () => {
            throw new TypeError('ReadableStream is locked');
          },
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('describeFetchError — what a log line may say about a failed fetch', () => {
  it('names a timeout', () => {
    expect(
      describeFetchError(
        Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
      ),
    ).toBe('timed out');
    expect(
      describeFetchError(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      ),
    ).toBe('timed out');
  });

  it('gives the error class and the system code behind it', () => {
    expect(
      describeFetchError(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ENOTFOUND' },
        }),
      ),
    ).toBe('TypeError ENOTFOUND');
    expect(describeFetchError(new RangeError('x'))).toBe('RangeError');
  });

  it('never repeats the message — Node puts the request URL, with the key, into some', () => {
    const leaky = Object.assign(
      new TypeError(
        'fetch failed https://api.themoviedb.org/3/search/movie?api_key=SECRET&query=Film',
      ),
      { cause: { code: 'https://x/?api_key=SECRET', message: 'SECRET' } },
    );

    expect(describeFetchError(leaky)).toBe('TypeError');
  });

  it('says "unknown error" for something that is not an Error', () => {
    expect(describeFetchError('api_key=SECRET')).toBe('unknown error');
    expect(describeFetchError(undefined)).toBe('unknown error');
  });
});
