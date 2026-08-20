import { Injectable, Logger } from '@nestjs/common';
import { ClientPlatform, Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requestClientContext } from '../common/storage/request-host.context';

/**
 * The ceiling on how many seconds a single watch heartbeat may contribute.
 *
 * The slowest client heartbeat is mobile's 15s, so 90s is 6x the real
 * interval — generous enough that a stalled tab, a slow network or a
 * backgrounded app still gets full credit when it catches up, tight enough
 * that a seek forward across an hour of film cannot be counted as an hour
 * of watching. Anything above it is, by definition, not time spent watching.
 */
export const MAX_WATCH_DELTA_SECONDS = 90;

/**
 * How often one user's presence may be written. Every authenticated request
 * from either client calls touchLastSeen, which on a browsing user is
 * several per second — without this the presence write would be the single
 * busiest query in the system, and it would tell us nothing a once-a-minute
 * write doesn't.
 */
export const LAST_SEEN_THROTTLE_MS = 60 * 1000;

/** Above this many tracked users, the throttle map sheds its stale entries. */
const TOUCH_MAP_PRUNE_THRESHOLD = 5_000;

/**
 * Search terms are grouped by this form, so "Avengers", " avengers " and
 * "AVENGERS   Endgame" do not each look like their own distinct term in the
 * top-searches report. The raw text the user actually typed is kept
 * alongside it — the report shows the most common raw spelling.
 */
export function normalizeSearchTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Top of the UTC hour containing `date` — the WatchActivity bucket key.
 *
 * UTC on purpose: the bucket is a storage fact, so it stays stable if the
 * server's timezone ever changes. The read side (BACKEND 4) is what
 * re-buckets into local hours/weekdays for "peak evening" to mean what an
 * operator expects.
 */
export function hourStartOf(date: Date): Date {
  const bucket = new Date(date.getTime());
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}

/**
 * Seconds actually watched between two heartbeats: `clamp(next - previous,
 * 0, MAX_WATCH_DELTA_SECONDS)`.
 *
 * Both ends come from the server's own stored state, never from a
 * client-supplied duration. Every degenerate case collapses to a number
 * that cannot lie:
 *  - seeking backwards, or replaying from the start -> a negative delta -> 0;
 *  - seeking forward / skipping the recap -> capped at MAX_WATCH_DELTA_SECONDS;
 *  - a duplicate heartbeat at the same position -> 0.
 */
export function watchDeltaSeconds(
  previousPosition: number,
  nextPosition: number,
): number {
  const delta = Math.floor(nextPosition) - Math.floor(previousPosition);
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.min(delta, MAX_WATCH_DELTA_SECONDS);
}

export interface RecordSearchInput {
  /** Raw text the user typed, exactly as it arrived. */
  term: string;
  /** The real total the query returned — not the size of the current page. */
  resultCount: number;
  /** The searcher, or null for an unauthenticated/public search. */
  userId: string | null;
  /** The searcher's account kind; anything but USER is not logged. */
  viewerRole: Role;
}

export interface RecordWatchActivityInput {
  userId: string;
  movieId: string;
  /** The lastPosition ALREADY STORED before this heartbeat was applied. */
  previousPosition: number;
  /** The lastPosition this heartbeat reported. */
  nextPosition: number;
}

/**
 * Everything that WRITES tracking rows.
 *
 * All of it is incidental to the request that triggers it — a search, a
 * watch heartbeat, a login, any authenticated call — so nothing here is
 * allowed to change what that request returns or whether it succeeds. Call
 * sites either fire-and-forget or catch; this service additionally reads its
 * platform/IP straight out of the per-request AsyncLocalStorage
 * (requestClientContext) so no caller has to plumb @Req() down to it.
 *
 * Timestamps are always `new Date()` here. Nothing a client sends is ever
 * treated as a time, a duration or an identity.
 */
@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  /**
   * userId -> epoch ms of the last presence write. In-process on purpose:
   * the throttle only needs to stop THIS instance from writing the same row
   * repeatedly, and a second instance writing once a minute of its own is
   * harmless. Pruned once it grows past TOUCH_MAP_PRUNE_THRESHOLD so a
   * long-lived process cannot accumulate an entry per user forever.
   */
  private readonly lastSeenTouches = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Logs one settled search. Both clients debounce (web 300ms, mobile
   * 400ms), so this is one row per typed phrase rather than per keystroke.
   *
   * Staff searches are deliberately dropped: an admin browsing the catalog
   * through the same endpoint would otherwise show up in "what are users
   * looking for", which is the entire point of the report.
   */
  async recordSearch(input: RecordSearchInput): Promise<void> {
    if (input.viewerRole !== Role.USER) return;

    const term = input.term.trim();
    if (!term) return;

    const { ip, platform } = requestClientContext();

    await this.prisma.searchQuery.create({
      data: {
        userId: input.userId,
        term,
        normalizedTerm: normalizeSearchTerm(term),
        resultCount: input.resultCount,
        platform,
        ipAddress: ip,
      },
    });
  }

  /**
   * Accumulates watched seconds into the (user, movie, platform, hour)
   * bucket — the append-safe log WatchHistory's single upserted row can
   * never be. Re-watching adds instead of overwriting, so "when do people
   * watch" is exact.
   *
   * A zero delta still writes, incrementing `heartbeats` only: the bucket
   * then records that the user had the player open during that hour without
   * inventing seconds they did not watch.
   */
  async recordWatchActivity(input: RecordWatchActivityInput): Promise<void> {
    const { platform } = requestClientContext();
    const seconds = watchDeltaSeconds(
      input.previousPosition,
      input.nextPosition,
    );
    const hourStart = hourStartOf(new Date());

    await this.prisma.watchActivity.upsert({
      where: {
        userId_movieId_platform_hourStart: {
          userId: input.userId,
          movieId: input.movieId,
          platform,
          hourStart,
        },
      },
      create: {
        userId: input.userId,
        movieId: input.movieId,
        platform,
        hourStart,
        seconds,
        heartbeats: 1,
      },
      update: {
        seconds: { increment: seconds },
        heartbeats: { increment: 1 },
      },
    });
  }

  /**
   * Opens a session row for a fresh sign-in (password login and OTP verify
   * alike) and stamps the user's last-seen columns.
   *
   * Also seeds the throttle so the very next authenticated request — which
   * arrives milliseconds later carrying the new token — does not immediately
   * write the same presence again.
   */
  async startSession(userId: string): Promise<void> {
    const { ip, userAgent, platform } = requestClientContext();
    const now = new Date();

    await this.prisma.userSession.create({
      data: {
        userId,
        platform,
        ipAddress: ip,
        userAgent,
        lastSeenAt: now,
      },
    });
    await this.writeUserPresence(userId, now, ip, platform);

    this.lastSeenTouches.set(userId, now.getTime());
  }

  /**
   * Presence heartbeat, called (fire-and-forget) from JwtStrategy.validate
   * on every authenticated request from either client — so "who is active
   * right now" stays true without the clients making an extra round trip.
   *
   * Throttled to once per LAST_SEEN_THROTTLE_MS per user. The stamp is taken
   * BEFORE the awaits so a burst of concurrent requests produces one write,
   * not one per request, and it is kept on failure so a database problem
   * cannot turn into a write storm.
   */
  async touchLastSeen(userId: string): Promise<void> {
    const nowMs = Date.now();
    const previous = this.lastSeenTouches.get(userId);
    if (previous !== undefined && nowMs - previous < LAST_SEEN_THROTTLE_MS) {
      return;
    }
    this.lastSeenTouches.set(userId, nowMs);
    this.pruneTouches(nowMs);

    const { ip, userAgent, platform } = requestClientContext();
    const now = new Date(nowMs);

    // Scoped to this platform so a user reading on their phone does not keep
    // a long-abandoned browser session looking alive — each client's session
    // ages out on its own.
    const open = await this.prisma.userSession.findFirst({
      where: { userId, platform, endedAt: null },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true },
    });

    if (open) {
      await this.prisma.userSession.update({
        where: { id: open.id },
        data: { lastSeenAt: now, ipAddress: ip },
      });
    } else {
      // No session to touch: either this token predates session tracking, or
      // the client reconnected on a platform it had never used. Opening one
      // here is what makes presence correct for tokens issued before this
      // shipped, and the throttle bounds it to one row per minute per user.
      await this.prisma.userSession.create({
        data: { userId, platform, ipAddress: ip, userAgent, lastSeenAt: now },
      });
    }

    await this.writeUserPresence(userId, now, ip, platform);
  }

  /** The denormalized "where was this account last seen" columns on User. */
  private async writeUserPresence(
    userId: string,
    at: Date,
    ip: string | null,
    platform: ClientPlatform,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastSeenAt: at, lastIpAddress: ip, lastPlatform: platform },
    });
  }

  /**
   * Drops entries that are already past the throttle window — they can only
   * ever answer "yes, write again", so keeping them costs memory and buys
   * nothing.
   */
  private pruneTouches(nowMs: number): void {
    if (this.lastSeenTouches.size <= TOUCH_MAP_PRUNE_THRESHOLD) return;
    for (const [userId, touchedAt] of this.lastSeenTouches) {
      if (nowMs - touchedAt >= LAST_SEEN_THROTTLE_MS) {
        this.lastSeenTouches.delete(userId);
      }
    }
  }

  /**
   * The shape every ingest call site uses: run it, swallow whatever it
   * throws into a log line. Tracking is never worth failing a user's search,
   * heartbeat or login over.
   */
  fireAndForget(what: string, run: Promise<void>): void {
    void run.catch((error: unknown) =>
      this.logger.warn(
        `Failed to record ${what}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}
