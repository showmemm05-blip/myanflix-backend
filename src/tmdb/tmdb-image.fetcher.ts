import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConversionSlots } from '../common/concurrency/slots';
import {
  describeFetchError,
  discardBody,
  readBodyCapped,
  type TmdbFetch,
} from './tmdb-fetch';
import {
  TMDB_IMAGE_HOST,
  TMDB_IMAGE_SIZES,
  isTmdbImagePath,
  tmdbImageUrl,
  type TmdbImageKind,
} from './tmdb-image-url';

/** The whole download — connect, headers and body — must finish within this. */
export const TMDB_IMAGE_TIMEOUT_MS = 20_000;

/** The most picture downloads in flight at once, across the whole process. */
export const TMDB_IMAGE_MAX_IN_FLIGHT = 4;

export type TmdbImageFailure =
  'invalid_path' | 'not_found' | 'too_large' | 'unreachable';

export type TmdbImageResult =
  | { ok: true; buffer: Buffer; size: string }
  | { ok: false; reason: TmdbImageFailure };

/** The token the specs provide TmdbImageFetcherOptions under; production provides nothing. */
export const TMDB_IMAGE_FETCHER_OPTIONS = Symbol('TMDB_IMAGE_FETCHER_OPTIONS');

export interface TmdbImageFetcherOptions {
  /** Injected by the specs; the real one is globalThis.fetch. */
  fetchImpl?: TmdbFetch;
}

/**
 * Downloads one TMDB picture into memory (PLAN.md 2.11 of
 * docs/movie-details-tmdb-2026-11-06). It only fetches: checking that the
 * bytes really are an image, resizing and storing them is
 * ImageStoreService.save, the same code a staff upload goes through.
 *
 * The request can only go to https://image.tmdb.org/t/p/<size><path>: the
 * address is built here from a checked path, the host is verified once
 * more just before the call, and a redirect is an error rather than
 * followed — so nothing TMDB (or anyone answering in its place) sends can
 * point the server at another host. The body is read under `maxBytes` and
 * dropped the moment it passes it. Never throws.
 */
@Injectable()
export class TmdbImageFetcher {
  private readonly logger = new Logger(TmdbImageFetcher.name);
  private readonly fetchImpl: TmdbFetch;
  private readonly slots = new ConversionSlots(() => TMDB_IMAGE_MAX_IN_FLIGHT);

  constructor(
    @Optional()
    @Inject(TMDB_IMAGE_FETCHER_OPTIONS)
    options?: TmdbImageFetcherOptions,
  ) {
    this.fetchImpl =
      options?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * The picture at `path`, at the first size of its kind that fits under
   * `maxBytes`. Only "too large" moves on to the next size; a picture that
   * is missing or cannot be reached is not retried smaller.
   */
  async fetch(
    kind: TmdbImageKind,
    path: string | null | undefined,
    maxBytes: number,
  ): Promise<TmdbImageResult> {
    if (!isTmdbImagePath(path)) return { ok: false, reason: 'invalid_path' };
    let last: TmdbImageResult = { ok: false, reason: 'too_large' };
    for (const size of TMDB_IMAGE_SIZES[kind]) {
      last = await this.fetchSize(size, path, maxBytes);
      if (last.ok || last.reason !== 'too_large') return last;
    }
    return last;
  }

  private async fetchSize(
    size: string,
    path: string,
    maxBytes: number,
  ): Promise<TmdbImageResult> {
    const url = tmdbImageUrl(size, path);
    if (url === null || !isTmdbImageAddress(url)) {
      return { ok: false, reason: 'invalid_path' };
    }
    await this.slots.acquire();
    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(TMDB_IMAGE_TIMEOUT_MS),
        headers: { accept: 'image/*' },
        redirect: 'error',
      });
      if (response.status < 200 || response.status >= 300) {
        await discardBody(response);
        this.logger.warn(
          `TMDB image ${size}${path}: answered ${response.status}`,
        );
        return {
          ok: false,
          reason: response.status === 404 ? 'not_found' : 'unreachable',
        };
      }
      const buffer = await readBodyCapped(response, maxBytes);
      if (buffer === null) return { ok: false, reason: 'too_large' };
      return { ok: true, buffer, size };
    } catch (error) {
      this.logger.warn(
        `TMDB image ${size}${path}: ${describeFetchError(error)}`,
      );
      return { ok: false, reason: 'unreachable' };
    } finally {
      this.slots.release();
    }
  }
}

/** True only for an https address on TMDB's image host — checked on the parsed URL, not on its text. */
function isTmdbImageAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === TMDB_IMAGE_HOST &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}
