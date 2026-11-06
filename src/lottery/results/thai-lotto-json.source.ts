import {
  checkPrizeGroups,
  normalizePrizeGroups,
  type PrizeGroupInput,
  type PrizeGroupKey,
} from './prize-groups';
import type { ResultsFetchOutcome, ResultsSource } from './results-source';
import { compactDate, parseThaiDate } from './thai-date';

/** The whole fetch — connect, headers and body — must finish within this. */
export const RESULTS_FETCH_TIMEOUT_MS = 10_000;

/** A sheet is a few KB; anything past this is not a results answer. */
export const RESULTS_BODY_MAX_BYTES = 1_000_000;

/** The placeholder a per-date URL carries; replaced with the draw date as YYYYMMDD. */
export const RESULTS_URL_DATE_PLACEHOLDER = '{date}';

/**
 * The source's ids (case-insensitive) → our group keys. Both the common
 * spelling "prizeForth" and the correct "prizeFourth" are read.
 */
const ID_TO_KEY: ReadonlyMap<string, PrizeGroupKey> = new Map([
  ['prizefirst', 'first'],
  ['prizefirstnear', 'nearFirst'],
  ['prizenearfirst', 'nearFirst'],
  ['prizesecond', 'second'],
  ['prizethird', 'third'],
  ['prizeforth', 'fourth'],
  ['prizefourth', 'fourth'],
  ['prizefifth', 'fifth'],
  ['runningnumberfrontthree', 'front3'],
  ['runningnumberbackthree', 'back3'],
  ['runningnumberbacktwo', 'back2'],
]);

/** The part of a fetch Response the source reads (the specs hand in a plain object). */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  /** The body as a stream when the runtime offers one (Node's fetch does); read under the size cap. */
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
  text(): Promise<string>;
}

export type FetchLike = (
  input: string,
  init: {
    signal: AbortSignal;
    headers: Record<string, string>;
    /** Never followed: a public URL must not be able to bounce the fetcher to an internal one. */
    redirect: 'error';
  },
) => Promise<FetchResponseLike>;

export interface ThaiLottoJsonSourceOptions {
  /** Injected by the specs; the real one is globalThis.fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** The URL the source will be asked, for one draw date. */
export function resultsUrlFor(template: string, thaiDrawDate: string): string {
  return template.includes(RESULTS_URL_DATE_PLACEHOLDER)
    ? template
        .split(RESULTS_URL_DATE_PLACEHOLDER)
        .join(compactDate(thaiDrawDate))
    : template;
}

/** Reads "6000000", "6,000,000", 6000000 or " 6000000 " as 6000000; anything else as null. */
function parseReward(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** The listed numbers as trimmed strings; a bare string or number is one entry. */
function parseNumbers(value: unknown): string[] | null {
  const list = Array.isArray(value) ? value : [value];
  const numbers: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') numbers.push(item.trim());
    else if (typeof item === 'number' && Number.isInteger(item))
      numbers.push(String(item));
    else return null;
  }
  return numbers;
}

/** An unknown value as a list: an array as is, anything else as nothing. */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `timed out after ${RESULTS_FETCH_TIMEOUT_MS / 1000} s`;
    }
    // Node's fetch says "fetch failed" and keeps the reason (ENOTFOUND, an
    // unexpected redirect …) in `cause`.
    const cause = (error as { cause?: unknown }).cause;
    const reason =
      cause instanceof Error && cause.message ? ` (${cause.message})` : '';
    return `${error.message || error.name}${reason}`;
  }
  return String(error);
}

/**
 * The body as text, or null when it is past `max` bytes: refused on the
 * Content-Length when one is sent, else read as a stream and dropped the
 * moment the cap is passed — a hostile source cannot hand the server
 * hundreds of MB before the check. A response without a stream (the
 * specs' fakes) is read whole and measured.
 */
async function readBody(
  response: FetchResponseLike,
  max: number,
): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const stream = response.body;
  if (!stream || typeof stream.getReader !== 'function') {
    const text = await response.text();
    return text.length > max ? null : text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Text from a source, cut before it goes into an error message (lastError, the results-test answer). */
const ERROR_TEXT_MAX = 40;

/**
 * Reads the common Thai lotto JSON answer (the rayriffy/thai-lotto-api
 * shape, lottery backend phase 3):
 *
 *   { status: "success", response: { date: "16 สิงหาคม 2568",
 *     prizes: [{ id: "prizeFirst", reward: "6000000", number: ["123456"] }, …],
 *     runningNumbers: [{ id: "runningNumberFrontThree", reward, number: [..] }, …] } }
 *
 * Tolerant on purpose: ids are matched case-insensitively, `reward` may be
 * a string (with thousands separators) or a number, the date may be Thai
 * with a Buddhist year or plain ISO, `response` may be missing (the body
 * itself is then the answer), and the groups may sit in either list. Not
 * tolerant where it matters: every group must be there with the right
 * count and digit length, or the answer is refused as a whole.
 *
 * GET only, one request, 10 s in all, no redirects followed, at most 1 MB
 * read, no retries (the cron retries); nothing here ever throws — see
 * ResultsSource.
 */
export class ThaiLottoJsonSource implements ResultsSource {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly url: string,
    options: ThaiLottoJsonSourceOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? RESULTS_FETCH_TIMEOUT_MS;
  }

  async fetch(thaiDrawDate: string): Promise<ResultsFetchOutcome> {
    const url = resultsUrlFor(this.url, thaiDrawDate);
    let text: string;
    let status: number;
    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json' },
        redirect: 'error',
      });
      status = response.status;
      const body = await readBody(response, RESULTS_BODY_MAX_BYTES);
      if (body === null) {
        return {
          ok: false,
          error: 'The results source answered with too much data',
        };
      }
      text = body;
    } catch (error) {
      return {
        ok: false,
        error: `Could not reach the results source: ${describeError(error)}`,
      };
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: `The results source answered ${status}`,
        raw: text.slice(0, 2000),
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return {
        ok: false,
        error: 'The results source did not answer with JSON',
        raw: text.slice(0, 2000),
      };
    }
    return parseThaiLottoJson(raw, thaiDrawDate);
  }
}

/**
 * The parser on its own, for an answer already in hand (the specs, and a
 * later "paste the JSON" entry if one is ever wanted).
 */
export function parseThaiLottoJson(
  raw: unknown,
  thaiDrawDate: string,
): ResultsFetchOutcome {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'The results answer is not an object', raw };
  }
  const root = raw as Record<string, unknown>;
  if (
    typeof root.status === 'string' &&
    root.status.toLowerCase() !== 'success'
  ) {
    return {
      ok: false,
      error: `The results source reports status "${root.status.slice(0, ERROR_TEXT_MAX)}"`,
      raw,
    };
  }
  const body = (
    typeof root.response === 'object' && root.response !== null
      ? root.response
      : root
  ) as Record<string, unknown>;

  const sourceDate = parseThaiDate(body.date);
  if (sourceDate === null) {
    return {
      ok: false,
      error: `The results answer has no readable draw date (${JSON.stringify(
        body.date ?? null,
      ).slice(0, ERROR_TEXT_MAX)})`,
      raw,
    };
  }

  const entries: unknown[] = [
    ...listOf(body.prizes),
    ...listOf(body.runningNumbers),
  ];
  const groups: PrizeGroupInput[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const key =
      typeof item.id === 'string'
        ? ID_TO_KEY.get(item.id.toLowerCase())
        : undefined;
    if (!key) continue;
    const baht = parseReward(item.reward);
    const numbers = parseNumbers(item.number);
    if (baht === null)
      problems.push(
        `${key}: unreadable reward ${JSON.stringify(item.reward ?? null)}`,
      );
    if (numbers === null) problems.push(`${key}: unreadable numbers`);
    if (baht === null || numbers === null) continue;
    groups.push({ key, baht, numbers });
  }
  if (problems.length > 0) {
    return {
      ok: false,
      error: `The results answer could not be read: ${problems.join('; ')}`,
      raw,
    };
  }
  const check = checkPrizeGroups(groups);
  if (check.errors.length > 0) {
    return {
      ok: false,
      error: `The results answer is not a full sheet: ${check.errors.join('; ')}`,
      raw,
    };
  }
  return {
    ok: true,
    sourceDate,
    matches: sourceDate === thaiDrawDate,
    raw,
    groups: normalizePrizeGroups(groups),
    warnings: check.warnings,
  };
}
