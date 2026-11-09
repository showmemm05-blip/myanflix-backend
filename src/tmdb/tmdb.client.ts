import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversionSlots } from '../common/concurrency/slots';
import type { TmdbFailureReason } from './tmdb-errors';
import {
  describeFetchError,
  discardBody,
  readBodyCapped,
  type TmdbFetch,
} from './tmdb-fetch';
import {
  appendedBlock,
  readCredits,
  readMovieCore,
  readSearchRows,
  readTvCore,
  readUsCertifications,
  type TmdbMovieDetails,
  type TmdbSearchRow,
  type TmdbTvDetails,
} from './tmdb-payload';

/** Every call goes to this one host and path prefix; nothing else is ever contacted for data. */
export const TMDB_API_BASE = 'https://api.themoviedb.org/3';

/** One request — connect, headers and body — must finish within this. */
export const TMDB_REQUEST_TIMEOUT_MS = 10_000;

/** The connection check behind GET /tmdb/status gives up sooner: staff are looking at a spinner. */
export const TMDB_STATUS_TIMEOUT_MS = 5_000;

/** A search page is tens of KB, a details answer with full credits a few hundred. */
export const TMDB_SEARCH_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const TMDB_DETAILS_BODY_MAX_BYTES = 8 * 1024 * 1024;

/** The most TMDB requests in flight at once, across the whole process. */
export const TMDB_MAX_IN_FLIGHT = 4;

/** A 429 without a readable Retry-After waits this long. */
export const TMDB_RETRY_AFTER_DEFAULT_SECONDS = 2;
/** However long TMDB asks for, one wait is never longer than this. */
export const TMDB_RETRY_AFTER_MAX_SECONDS = 10;
/** A request is repeated at most this many times, and only after a 429. */
export const TMDB_MAX_RETRIES = 2;

/** The v3 "API Key": 32 hex characters. Anything else is the "API Read Access Token". */
const V3_KEY_PATTERN = /^[0-9a-f]{32}$/i;

/** The language every text is asked in (owner: English description only). */
const TMDB_LANGUAGE = 'en-US';

/** Data, or the reason there is none. The client never throws. */
export type TmdbResult<T> =
  { ok: true; data: T } | { ok: false; reason: TmdbFailureReason };

/** The token the specs provide TmdbClientOptions under; production provides nothing. */
export const TMDB_CLIENT_OPTIONS = Symbol('TMDB_CLIENT_OPTIONS');

export interface TmdbClientOptions {
  /** Injected by the specs; the real one is globalThis.fetch. */
  fetchImpl?: TmdbFetch;
  /** The wait between 429 retries; the specs pass one that does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  maxBytes: number;
  timeoutMs?: number;
  /** How many times a 429 is retried; the connection check passes 0. */
  retries?: number;
}

/**
 * How long a 429 asks us to wait, in ms: the Retry-After header as seconds
 * (or as an HTTP date), 2 s when it is missing or unreadable, never more
 * than 10 s and never negative.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  let seconds = TMDB_RETRY_AFTER_DEFAULT_SECONDS;
  const text = header?.trim() ?? '';
  if (text !== '') {
    const asNumber = Number(text);
    if (Number.isFinite(asNumber)) {
      seconds = asNumber;
    } else {
      const at = Date.parse(text);
      if (Number.isFinite(at)) seconds = (at - now) / 1000;
    }
  }
  return Math.round(
    Math.min(TMDB_RETRY_AFTER_MAX_SECONDS, Math.max(0, seconds)) * 1000,
  );
}

/**
 * The only code that talks to TMDB's API (PLAN.md 5.1 and 5.4 of
 * docs/movie-details-tmdb-2026-11-06).
 *
 * - TMDB_API_KEY may hold either TMDB credential: 32 hex characters is the
 *   v3 key and travels as the `api_key` query parameter, anything else is
 *   the read access token and travels as `Authorization: Bearer`. Missing
 *   or empty = the feature is off (`isEnabled`), and every call answers
 *   `not_configured` without touching the network.
 * - GET only, 10 s per request, no redirects followed, the body read under
 *   a cap, at most 4 requests in flight in the whole process.
 * - A 429 is the one thing retried: wait what Retry-After says (2 s when it
 *   says nothing, never more than 10 s), at most twice per request.
 * - Nothing here ever throws. Every method resolves to data or to a reason
 *   the caller turns into a status (`FAILED / unreachable`) or a coded
 *   error (502 TMDB_UNREACHABLE).
 *
 * The key is never logged and never part of a returned value: a log line
 * names the path only — never the query string, which carries the key (v3)
 * and the film name staff searched for — and a failure is one word.
 */
@Injectable()
export class TmdbClient {
  private readonly logger = new Logger(TmdbClient.name);
  private readonly key: string;
  private readonly fetchImpl: TmdbFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly slots = new ConversionSlots(() => TMDB_MAX_IN_FLIGHT);

  constructor(
    configService: ConfigService,
    @Optional()
    @Inject(TMDB_CLIENT_OPTIONS)
    options?: TmdbClientOptions,
  ) {
    // Not trimmed by env validation (it has no format rule on purpose), so
    // a pasted trailing newline is removed here.
    this.key = (configService.get<string>('TMDB_API_KEY') ?? '').trim();
    this.fetchImpl =
      options?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep =
      options?.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** False when TMDB_API_KEY is unset or blank — the feature is then off. */
  get isEnabled(): boolean {
    return this.key !== '';
  }

  /**
   * Page 1 of /search/movie. `year` is TMDB's own filter and is sent only
   * when given; an empty query asks nothing and finds nothing.
   */
  searchMovies(
    query: string,
    year: number | null,
  ): Promise<TmdbResult<TmdbSearchRow[]>> {
    return this.search('movie', query, year === null ? null : ['year', year]);
  }

  /** Page 1 of /search/tv; the year filter of a show is `first_air_date_year`. */
  searchTv(
    query: string,
    year: number | null,
  ): Promise<TmdbResult<TmdbSearchRow[]>> {
    return this.search(
      'tv',
      query,
      year === null ? null : ['first_air_date_year', year],
    );
  }

  /**
   * A film with its credits and US certifications. Both are asked for in
   * the same request (`append_to_response`); whichever is missing from the
   * answer is fetched with its own call, so the result is the same either
   * way TMDB behaves.
   */
  movieDetails(tmdbId: number): Promise<TmdbResult<TmdbMovieDetails>> {
    const path = `/movie/${tmdbId}`;
    return this.safely(path, async () => {
      const main = await this.getJson(
        path,
        {
          language: TMDB_LANGUAGE,
          append_to_response: 'credits,release_dates',
        },
        { maxBytes: TMDB_DETAILS_BODY_MAX_BYTES },
      );
      if (!main.ok) return main;
      const core = readMovieCore(main.data);
      if (!core) return this.unreadable(path);

      let credits = readCredits(appendedBlock(main.data, 'credits'));
      if (!credits) {
        const separate = await this.getOptional(`${path}/credits`);
        if (!separate.ok) return separate;
        credits = readCredits(separate.data);
      }
      let certifications = readUsCertifications(
        appendedBlock(main.data, 'release_dates'),
      );
      if (!certifications) {
        const separate = await this.getOptional(`${path}/release_dates`);
        if (!separate.ok) return separate;
        certifications = readUsCertifications(separate.data);
      }
      return {
        ok: true,
        data: {
          ...core,
          cast: credits?.cast ?? [],
          crew: credits?.crew ?? [],
          usCertifications: certifications ?? [],
        },
      };
    });
  }

  /**
   * A show with its cast: the aggregate credits (everyone across all
   * seasons) appended to the details, fetched separately when the answer
   * does not carry them, and the plain /credits (the latest season) when
   * the aggregate list is empty.
   */
  tvDetails(tmdbId: number): Promise<TmdbResult<TmdbTvDetails>> {
    const path = `/tv/${tmdbId}`;
    return this.safely(path, async () => {
      const main = await this.getJson(
        path,
        { language: TMDB_LANGUAGE, append_to_response: 'aggregate_credits' },
        { maxBytes: TMDB_DETAILS_BODY_MAX_BYTES },
      );
      if (!main.ok) return main;
      const core = readTvCore(main.data);
      if (!core) return this.unreadable(path);

      let credits = readCredits(appendedBlock(main.data, 'aggregate_credits'));
      if (!credits) {
        const separate = await this.getOptional(`${path}/aggregate_credits`);
        if (!separate.ok) return separate;
        credits = readCredits(separate.data);
      }
      if (!credits || credits.cast.length === 0) {
        const plain = await this.getOptional(`${path}/credits`);
        if (!plain.ok) return plain;
        credits = readCredits(plain.data) ?? credits;
      }
      return { ok: true, data: { ...core, cast: credits?.cast ?? [] } };
    });
  }

  /**
   * Is TMDB answering, and does it accept the key? One GET /configuration
   * with a 5 s deadline and no retry — the answer behind GET /tmdb/status.
   */
  checkConnection(): Promise<TmdbResult<true>> {
    const path = '/configuration';
    return this.safely(path, async () => {
      const answer = await this.getJson(
        path,
        {},
        {
          maxBytes: TMDB_SEARCH_BODY_MAX_BYTES,
          timeoutMs: TMDB_STATUS_TIMEOUT_MS,
          retries: 0,
        },
      );
      return answer.ok ? { ok: true, data: true } : answer;
    });
  }

  private search(
    kind: 'movie' | 'tv',
    query: string,
    yearFilter: [name: string, year: number] | null,
  ): Promise<TmdbResult<TmdbSearchRow[]>> {
    const path = `/search/${kind}`;
    return this.safely(path, async () => {
      const text = query.trim();
      if (!this.isEnabled) return { ok: false, reason: 'not_configured' };
      if (text === '') return { ok: true, data: [] };
      const answer = await this.getJson(
        path,
        {
          query: text,
          language: TMDB_LANGUAGE,
          include_adult: 'false',
          page: '1',
          ...(yearFilter ? { [yearFilter[0]]: String(yearFilter[1]) } : {}),
        },
        { maxBytes: TMDB_SEARCH_BODY_MAX_BYTES },
      );
      if (!answer.ok) return answer;
      const rows = readSearchRows(answer.data, kind);
      return rows ? { ok: true, data: rows } : this.unreadable(path);
    });
  }

  /**
   * A sub-resource fetched on its own because the details answer did not
   * carry it. TMDB not having it (404) is "nothing there", not a failure —
   * the caller reads `null` as an empty block; anything else fails the
   * whole details call, so a fill never runs on half an answer.
   */
  private async getOptional(path: string): Promise<TmdbResult<unknown>> {
    const answer = await this.getJson(
      path,
      { language: TMDB_LANGUAGE },
      { maxBytes: TMDB_DETAILS_BODY_MAX_BYTES },
    );
    if (!answer.ok && answer.reason === 'not_found') {
      return { ok: true, data: null };
    }
    return answer;
  }

  /** The last line of defence behind "never throws": a bug in here is an unreadable answer, not a crash. */
  private async safely<T>(
    path: string,
    run: () => Promise<TmdbResult<T>>,
  ): Promise<TmdbResult<T>> {
    try {
      return await run();
    } catch (error) {
      this.logger.error(
        `TMDB ${path}: unexpected error (${describeFetchError(error)})`,
      );
      return { ok: false, reason: 'bad_response' };
    }
  }

  private unreadable(path: string): { ok: false; reason: TmdbFailureReason } {
    this.logger.warn(`TMDB ${path}: the answer could not be read`);
    return { ok: false, reason: 'bad_response' };
  }

  /** One GET with the 429 rule around it. */
  private async getJson(
    path: string,
    params: Record<string, string>,
    options: RequestOptions,
  ): Promise<TmdbResult<unknown>> {
    if (!this.isEnabled) return { ok: false, reason: 'not_configured' };
    const retries = options.retries ?? TMDB_MAX_RETRIES;
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.getOnce(path, params, options);
      if (!('retryAfterMs' in outcome)) return outcome;
      if (attempt >= retries) {
        this.logger.warn(`TMDB ${path}: still rate limited, giving up`);
        return { ok: false, reason: 'rate_limited' };
      }
      await this.sleep(outcome.retryAfterMs);
    }
  }

  /**
   * One request. The slot is held only while the request is in flight — a
   * call waiting out a 429 does not keep the other callers from TMDB.
   */
  private async getOnce(
    path: string,
    params: Record<string, string>,
    options: RequestOptions,
  ): Promise<TmdbResult<unknown> | { retryAfterMs: number }> {
    const url = new URL(`${TMDB_API_BASE}${path}`);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (V3_KEY_PATTERN.test(this.key)) {
      url.searchParams.set('api_key', this.key);
    } else {
      headers.authorization = `Bearer ${this.key}`;
    }

    await this.slots.acquire();
    try {
      const response = await this.fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(
          options.timeoutMs ?? TMDB_REQUEST_TIMEOUT_MS,
        ),
        headers,
        redirect: 'error',
      });
      const status = response.status;
      if (status === 429) {
        await discardBody(response);
        return {
          retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
        };
      }
      if (status < 200 || status >= 300) {
        await discardBody(response);
        return this.failed(path, status);
      }
      const body = await readBodyCapped(response, options.maxBytes);
      if (body === null) {
        this.logger.warn(`TMDB ${path}: the answer is too large`);
        return { ok: false, reason: 'bad_response' };
      }
      try {
        return { ok: true, data: JSON.parse(body.toString('utf8')) as unknown };
      } catch {
        this.logger.warn(`TMDB ${path}: the answer is not JSON`);
        return { ok: false, reason: 'bad_response' };
      }
    } catch (error) {
      this.logger.warn(`TMDB ${path}: ${describeFetchError(error)}`);
      return { ok: false, reason: 'unreachable' };
    } finally {
      this.slots.release();
    }
  }

  /** A non-2xx answer as a reason: 401 = the key, 404 = no such entry, the rest = TMDB is not well. */
  private failed(
    path: string,
    status: number,
  ): { ok: false; reason: TmdbFailureReason } {
    const reason: TmdbFailureReason =
      status === 401
        ? 'key_rejected'
        : status === 404
          ? 'not_found'
          : 'unreachable';
    this.logger.warn(`TMDB ${path}: answered ${status}`);
    return { ok: false, reason };
  }
}
