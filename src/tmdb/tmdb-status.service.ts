import { Injectable } from '@nestjs/common';
import type { TmdbFailureReason } from './tmdb-errors';
import { TmdbClient } from './tmdb.client';
import type { TmdbConnectionState, TmdbStatus } from './tmdb.types';

/** How long one connection check is reused before a new one is started. "Check again" (`?fresh=1`) skips it. */
export const TMDB_STATUS_TTL_MS = 60_000;

function stateOf(reason: TmdbFailureReason): TmdbConnectionState {
  switch (reason) {
    case 'key_rejected':
      return 'key_rejected';
    case 'rate_limited':
      return 'rate_limited';
    case 'not_configured':
      return 'off';
    default:
      return 'unreachable';
  }
}

/**
 * Whether TMDB is connected — the one sentence of Settings > Connections
 * and the reason the admin shows or hides its TMDB buttons (GET
 * /tmdb/status, PLAN.md 5.3 of docs/movie-details-tmdb-2026-11-06).
 *
 * Without TMDB_API_KEY the answer is `off` and nothing is asked. With it,
 * TMDB is asked once (GET /configuration, 5 s) and the answer is kept for
 * a minute, so a page of staff opening the admin does not become a page of
 * calls to TMDB; callers that arrive while a check is running share it.
 * Once the minute is over the last answer is still handed out at once and
 * the new check runs behind it: the admin asks this before it draws the
 * Edit movie form, and a slow TMDB must never make staff wait for that.
 * Only the first read after a start and "Check again" wait for TMDB.
 * The key itself is never part of the answer.
 */
@Injectable()
export class TmdbStatusService {
  private cached: { status: TmdbStatus; expiresAt: number } | null = null;
  private inFlight: Promise<TmdbStatus> | null = null;

  constructor(private readonly client: TmdbClient) {}

  async get(fresh = false): Promise<TmdbStatus> {
    if (!this.client.isEnabled) {
      return { configured: false, state: 'off', checkedAt: null };
    }
    if (!fresh && this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.status;
    }
    this.inFlight ??= this.check().finally(() => {
      this.inFlight = null;
    });
    if (!fresh && this.cached) {
      // Nobody waits for this check, so nobody would catch it either.
      this.inFlight.catch(() => undefined);
      return this.cached.status;
    }
    return this.inFlight;
  }

  private async check(): Promise<TmdbStatus> {
    const answer = await this.client.checkConnection();
    const status: TmdbStatus = {
      configured: true,
      state: answer.ok ? 'connected' : stateOf(answer.reason),
      checkedAt: new Date().toISOString(),
    };
    this.cached = { status, expiresAt: Date.now() + TMDB_STATUS_TTL_MS };
    return status;
  }
}
