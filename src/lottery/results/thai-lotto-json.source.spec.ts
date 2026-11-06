import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSheet } from '../../../test/lottery-fixtures';
import {
  parseThaiLottoJson,
  RESULTS_BODY_MAX_BYTES,
  resultsUrlFor,
  ThaiLottoJsonSource,
  type FetchLike,
} from './thai-lotto-json.source';

/** The contract-shaped answer: draw of 16 สิงหาคม 2568 (= 2025-08-16). */
const FIXTURE_PATH = join(
  __dirname,
  '../../../test/fixtures/thai-lotto-results.json',
);
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const fixture = () =>
  JSON.parse(FIXTURE_TEXT) as {
    status: string;
    response: {
      date: string;
      prizes: Array<{ id: string; reward: unknown; number: unknown }>;
      runningNumbers: Array<{ id: string; reward: unknown; number: unknown }>;
    };
  };

const DRAW_DATE = '2025-08-16';

/** A text body, optionally with a Content-Length header, or the body as chunks of a stream, or a thrown error. */
function fakeFetch(
  reply:
    | {
        status?: number;
        text?: string;
        contentLength?: number;
        chunks?: string[];
      }
    | Error,
): jest.MockedFunction<FetchLike> {
  return jest.fn(async () => {
    if (reply instanceof Error) throw reply;
    const chunks = reply.chunks;
    let cursor = 0;
    return {
      ok: (reply.status ?? 200) < 300,
      status: reply.status ?? 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-length' &&
          reply.contentLength !== undefined
            ? String(reply.contentLength)
            : null,
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
              cancel: () => Promise.resolve(),
            }),
          }
        : null,
      text: jest.fn(() => Promise.resolve(reply.text ?? '')),
    };
  });
}

describe('ThaiLottoJsonSource', () => {
  it('fetches the URL with a 10 s timeout and an Accept header, and parses the fixture into the full sheet', async () => {
    const fetchImpl = fakeFetch({ text: FIXTURE_TEXT });
    const source = new ThaiLottoJsonSource('https://lotto.example/latest', {
      fetchImpl,
    });

    const outcome = await source.fetch(DRAW_DATE);

    expect(fetchImpl).toHaveBeenCalledWith('https://lotto.example/latest', {
      signal: expect.any(AbortSignal),
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    expect(outcome).toEqual({
      ok: true,
      sourceDate: DRAW_DATE,
      matches: true,
      raw: fixture(),
      groups: makeSheet(),
      warnings: [],
    });
  });

  it('replaces {date} in the URL with the draw date as YYYYMMDD', async () => {
    const fetchImpl = fakeFetch({ text: FIXTURE_TEXT });
    await new ThaiLottoJsonSource('https://lotto.example/draw/{date}.json', {
      fetchImpl,
    }).fetch(DRAW_DATE);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://lotto.example/draw/20250816.json',
    );
    expect(resultsUrlFor('https://x/{date}/{date}', '2026-11-01')).toBe(
      'https://x/20261101/20261101',
    );
    expect(resultsUrlFor('https://x/latest', '2026-11-01')).toBe(
      'https://x/latest',
    );
  });

  it('answers matches: false — still ok — when the source shows another date', async () => {
    const outcome = await new ThaiLottoJsonSource('https://lotto.example', {
      fetchImpl: fakeFetch({ text: FIXTURE_TEXT }),
    }).fetch('2025-09-01');
    expect(outcome).toEqual(
      expect.objectContaining({
        ok: true,
        matches: false,
        sourceDate: DRAW_DATE,
      }),
    );
  });

  it('turns a network error into { ok: false } with the message, never a throw', async () => {
    const outcome = await new ThaiLottoJsonSource('https://lotto.example', {
      fetchImpl: fakeFetch(new Error('getaddrinfo ENOTFOUND lotto.example')),
    }).fetch(DRAW_DATE);
    expect(outcome).toEqual({
      ok: false,
      error:
        'Could not reach the results source: getaddrinfo ENOTFOUND lotto.example',
    });
  });

  it('names a timeout as such', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const outcome = await new ThaiLottoJsonSource('https://lotto.example', {
      fetchImpl: fakeFetch(timeout),
    }).fetch(DRAW_DATE);
    expect(outcome).toEqual({
      ok: false,
      error: 'Could not reach the results source: timed out after 10 s',
    });
  });

  it('refuses a non-2xx answer, a non-JSON body and an oversized body', async () => {
    await expect(
      new ThaiLottoJsonSource('https://lotto.example', {
        fetchImpl: fakeFetch({ status: 503, text: 'down' }),
      }).fetch(DRAW_DATE),
    ).resolves.toEqual({
      ok: false,
      error: 'The results source answered 503',
      raw: 'down',
    });
    await expect(
      new ThaiLottoJsonSource('https://lotto.example', {
        fetchImpl: fakeFetch({ text: '<html>' }),
      }).fetch(DRAW_DATE),
    ).resolves.toEqual({
      ok: false,
      error: 'The results source did not answer with JSON',
      raw: '<html>',
    });
    await expect(
      new ThaiLottoJsonSource('https://lotto.example', {
        fetchImpl: fakeFetch({ text: 'x'.repeat(RESULTS_BODY_MAX_BYTES + 1) }),
      }).fetch(DRAW_DATE),
    ).resolves.toEqual({
      ok: false,
      error: 'The results source answered with too much data',
    });
  });

  it('refuses an oversized body by its Content-Length without reading it, and stops a stream at the cap', async () => {
    const declared = fakeFetch({
      text: FIXTURE_TEXT,
      contentLength: 2_000_000,
    });
    await expect(
      new ThaiLottoJsonSource('https://lotto.example', {
        fetchImpl: declared,
      }).fetch(DRAW_DATE),
    ).resolves.toEqual({
      ok: false,
      error: 'The results source answered with too much data',
    });
    const response = await declared.mock.results[0].value;
    expect(response.text).not.toHaveBeenCalled();

    // A stream with no Content-Length: dropped as soon as the cap is passed.
    await expect(
      new ThaiLottoJsonSource('https://lotto.example', {
        fetchImpl: fakeFetch({
          chunks: ['x'.repeat(600_000), 'x'.repeat(600_000), 'never read'],
        }),
      }).fetch(DRAW_DATE),
    ).resolves.toEqual({
      ok: false,
      error: 'The results source answered with too much data',
    });

    // A stream within the cap is read whole and parsed like a text body.
    const half = Math.floor(FIXTURE_TEXT.length / 2);
    await expect(
      new ThaiLottoJsonSource('https://lotto.example', {
        fetchImpl: fakeFetch({
          chunks: [FIXTURE_TEXT.slice(0, half), FIXTURE_TEXT.slice(half)],
        }),
      }).fetch(DRAW_DATE),
    ).resolves.toEqual(
      expect.objectContaining({ ok: true, groups: makeSheet() }),
    );
  });

  it('never follows a redirect: the fetch is told not to, and its refusal is one failed fetch', async () => {
    const fetchImpl = fakeFetch(
      new TypeError('fetch failed', {
        cause: new Error('unexpected redirect'),
      }),
    );
    await expect(
      new ThaiLottoJsonSource('https://lotto.example', { fetchImpl }).fetch(
        DRAW_DATE,
      ),
    ).resolves.toEqual({
      ok: false,
      error:
        'Could not reach the results source: fetch failed (unexpected redirect)',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
  });
});

describe('parseThaiLottoJson', () => {
  it('reads ids case-insensitively, rewards as numbers or strings with separators, and the correct "prizeFourth" spelling', () => {
    const body = fixture();
    body.response.prizes = body.response.prizes.map((prize) => ({
      ...prize,
      id: prize.id === 'prizeForth' ? 'PRIZEFOURTH' : prize.id.toUpperCase(),
      reward:
        prize.id === 'prizeFirst'
          ? 6000000
          : prize.id === 'prizeSecond'
            ? '200,000'
            : prize.reward,
    }));
    const outcome = parseThaiLottoJson(body, DRAW_DATE);
    expect(outcome).toEqual(
      expect.objectContaining({ ok: true, groups: makeSheet() }),
    );
  });

  it('reads an answer without the response wrapper, with every group in one list, and a single number as a string', () => {
    const { response } = fixture();
    const flat = {
      date: '2025-08-16',
      prizes: [...response.prizes, ...response.runningNumbers].map((entry) =>
        entry.id === 'runningNumberBackTwo'
          ? { ...entry, number: '56' }
          : entry,
      ),
    };
    expect(parseThaiLottoJson(flat, DRAW_DATE)).toEqual(
      expect.objectContaining({ ok: true, matches: true, groups: makeSheet() }),
    );
  });

  it('refuses a sheet with a wrong count, naming the group', () => {
    const body = fixture();
    const fifth = body.response.prizes.find((p) => p.id === 'prizeFifth');
    (fifth!.number as string[]).pop();
    expect(parseThaiLottoJson(body, DRAW_DATE)).toEqual({
      ok: false,
      error:
        'The results answer is not a full sheet: Fifth prize: expected 100 numbers, got 99',
      raw: body,
    });
  });

  it('refuses a sheet with a wrong digit length or a missing group', () => {
    const body = fixture();
    const back2 = body.response.runningNumbers.find(
      (p) => p.id === 'runningNumberBackTwo',
    );
    back2!.number = ['056'];
    expect(parseThaiLottoJson(body, DRAW_DATE)).toEqual(
      expect.objectContaining({
        ok: false,
        error:
          'The results answer is not a full sheet: Back 2 digits: every number must be exactly 2 digits (056)',
      }),
    );

    const missing = fixture();
    missing.response.runningNumbers = missing.response.runningNumbers.filter(
      (p) => p.id !== 'runningNumberFrontThree',
    );
    expect(parseThaiLottoJson(missing, DRAW_DATE)).toEqual(
      expect.objectContaining({
        ok: false,
        error:
          'The results answer is not a full sheet: Missing prize group "front3"',
      }),
    );
  });

  it('refuses an unreadable reward or number list, a failed status, a missing date and a non-object', () => {
    const body = fixture();
    body.response.prizes[0].reward = 'six million';
    body.response.prizes[1].number = [{ n: 1 }];
    expect(parseThaiLottoJson(body, DRAW_DATE)).toEqual(
      expect.objectContaining({
        ok: false,
        error:
          'The results answer could not be read: first: unreadable reward "six million"; nearFirst: unreadable numbers',
      }),
    );
    expect(
      parseThaiLottoJson({ status: 'error', response: {} }, DRAW_DATE),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        error: 'The results source reports status "error"',
      }),
    );
    const undated = fixture();
    undated.response.date = 'soon';
    expect(parseThaiLottoJson(undated, DRAW_DATE)).toEqual(
      expect.objectContaining({
        ok: false,
        error: 'The results answer has no readable draw date ("soon")',
      }),
    );
    expect(parseThaiLottoJson([], DRAW_DATE)).toEqual({
      ok: false,
      error: 'The results answer is not an object',
      raw: [],
    });
    expect(parseThaiLottoJson(null, DRAW_DATE).ok).toBe(false);
  });

  it('refuses a reward past the Baht ceiling, and cuts a long status or date before echoing it', () => {
    const body = fixture();
    body.response.prizes = body.response.prizes.map((prize) =>
      prize.id === 'prizeFirst'
        ? { ...prize, reward: '99999999999999' }
        : prize,
    );
    expect(parseThaiLottoJson(body, DRAW_DATE)).toEqual(
      expect.objectContaining({
        ok: false,
        error:
          'The results answer is not a full sheet: First prize: the Baht prize must be at most 9999999999.99',
      }),
    );

    const status = parseThaiLottoJson(
      { status: 'x'.repeat(500), response: {} },
      DRAW_DATE,
    );
    expect(status.ok).toBe(false);
    expect(!status.ok && status.error).toBe(
      `The results source reports status "${'x'.repeat(40)}"`,
    );
    const undated = fixture();
    undated.response.date = 'y'.repeat(500);
    const date = parseThaiLottoJson(undated, DRAW_DATE);
    expect(!date.ok && date.error).toBe(
      `The results answer has no readable draw date ("${'y'.repeat(39)})`,
    );
  });

  it('passes the near-first warning through without failing', () => {
    const body = fixture();
    body.response.prizes[1].number = ['111111', '222222'];
    expect(parseThaiLottoJson(body, DRAW_DATE)).toEqual(
      expect.objectContaining({
        ok: true,
        warnings: [
          'Near first prize numbers 111111 / 222222 are not the first prize ± 1 (123455 / 123457)',
        ],
      }),
    );
  });

  it('ignores entries it does not know and keeps the ones it does', () => {
    const body = fixture();
    body.response.prizes.push({ id: 'prizeBonus', reward: '1', number: ['1'] });
    body.response.runningNumbers.push({ id: 'x', reward: 1, number: ['1'] });
    expect(parseThaiLottoJson(body, DRAW_DATE)).toEqual(
      expect.objectContaining({ ok: true, groups: makeSheet() }),
    );
  });
});
