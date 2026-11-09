import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { actorSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { isUniqueViolation } from '../auth/unique-violation.util';
import { MinioService } from '../common/storage/minio.service';
import {
  ImageStoreService,
  imageUploadByteLimit,
} from '../images/image-store.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { nameKey } from './tmdb-keys';
import { TmdbImageFetcher } from './tmdb-image.fetcher';
import type { TmdbCastPerson } from './tmdb-mapping';
import type { TmdbCastAction } from './tmdb.types';

/** What the cast rules need to know about an actor of ours. */
export interface KnownActor {
  id: string;
  name: string;
  tmdbPersonId: number | null;
  imageUrl: string | null;
  createdAt: Date;
}

const KNOWN_ACTOR_SELECT = {
  id: true,
  name: true,
  tmdbPersonId: true,
  imageUrl: true,
  createdAt: true,
} as const;

/** What would happen to one person of a TMDB cast. */
export interface TmdbCastPlanEntry {
  person: TmdbCastPerson;
  action: TmdbCastAction;
  /** The actor to attach — null for a person to create or to skip. */
  actor: KnownActor | null;
  /** True when the actor was found by name and must still be given the TMDB person id. */
  link: boolean;
}

/** What attaching a TMDB cast really did. */
export interface TmdbCastOutcome {
  /** The actors to put on the title, in TMDB's billing order. */
  actorIds: string[];
  reused: number;
  created: number;
  skipped: Array<{ name: string; reason: 'same_name' | 'no_permission' }>;
}

/** How many photos are downloaded and stored at the same time. */
const PHOTO_CONCURRENCY = 4;

/**
 * Who each person of a TMDB cast is among our actors (PLAN.md 2.10), with
 * nothing written. In order, per person:
 *
 *  1. an actor already carrying this TMDB person id: use it;
 *  2. else an actor with the same name key and no person id yet (the oldest
 *     first): use it, and it gets the person id. When every actor of that
 *     name already belongs to ANOTHER TMDB person, this is a second person
 *     with the same name — actor names are unique, so they are skipped and
 *     reported;
 *  3. else create them, which needs ACTORS.CREATE.
 *
 * A decision made for one person counts for the next: an actor claimed by
 * the first of two same-named people is not offered to the second.
 */
export function planCast(
  people: readonly TmdbCastPerson[],
  actors: readonly KnownActor[],
  canCreate: boolean,
): TmdbCastPlanEntry[] {
  const working = actors
    .map((actor) => ({ ...actor }))
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  const byPersonId = new Map<number, KnownActor>();
  const byNameKey = new Map<string, KnownActor[]>();
  const remember = (actor: KnownActor) => {
    if (actor.tmdbPersonId !== null) {
      byPersonId.set(actor.tmdbPersonId, actor);
    }
    const key = nameKey(actor.name);
    // A name with no letter or digit in it has no key to be found by.
    if (key === '') return;
    const list = byNameKey.get(key);
    if (list) list.push(actor);
    else byNameKey.set(key, [actor]);
  };
  working.forEach(remember);

  return people.map((person): TmdbCastPlanEntry => {
    const linked = byPersonId.get(person.tmdbPersonId);
    if (linked) {
      // An empty id is the stand-in for someone this same cast is about to
      // create (the person listed twice): still a creation, not a row to
      // reuse — the second one finds the first one's row when it runs.
      return linked.id === ''
        ? { person, action: 'create', actor: null, link: false }
        : { person, action: 'reuse', actor: linked, link: false };
    }
    const sameName = byNameKey.get(nameKey(person.name)) ?? [];
    const free = sameName.find((actor) => actor.tmdbPersonId === null);
    if (free) {
      free.tmdbPersonId = person.tmdbPersonId;
      byPersonId.set(person.tmdbPersonId, free);
      return { person, action: 'reuse', actor: free, link: true };
    }
    if (sameName.length > 0) {
      return { person, action: 'skip_same_name', actor: null, link: false };
    }
    if (!canCreate) {
      return { person, action: 'skip_no_permission', actor: null, link: false };
    }
    // Not a row yet, but the name is now spoken for within this cast.
    remember({
      id: '',
      name: person.name,
      tmdbPersonId: person.tmdbPersonId,
      imageUrl: null,
      createdAt: new Date(0),
    });
    return { person, action: 'create', actor: null, link: false };
  });
}

/** An actor this run attached, with what it changed on the row. */
interface AttachedActor {
  person: TmdbCastPerson;
  /** The row as it was before this run; null for one this run created. */
  before: KnownActor | null;
  /** The row as it is now. */
  row: KnownActor;
}

/**
 * The cast of a TMDB fill (PLAN.md 2.10 of
 * docs/movie-details-tmdb-2026-11-06): reuse the actor we have, create the
 * one we do not, give a photo to the one who has none.
 *
 * It writes actors through Prisma itself rather than through ActorsService
 * — that service refuses a name that exists, which is exactly the case
 * this one must resolve (reuse) — and so records the audit rows itself:
 * `actor.create` for a new person, `actor.update` for an existing one that
 * received a person id or a photo, both with `via: 'tmdb'`. An existing
 * name is never changed and an existing photo never replaced.
 */
@Injectable()
export class TmdbCastService {
  private readonly logger = new Logger(TmdbCastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolverService,
    private readonly images: TmdbImageFetcher,
    private readonly imageStore: ImageStoreService,
    private readonly minioService: MinioService,
    private readonly audit: AuditService,
  ) {}

  /** What attaching this cast would do — for the review. Writes nothing. */
  async plan(
    people: readonly TmdbCastPerson[],
    user: AuthenticatedUser,
  ): Promise<TmdbCastPlanEntry[]> {
    if (people.length === 0) return [];
    const [actors, canCreate] = await Promise.all([
      this.loadActors(),
      this.resolver.can(user, 'ACTORS.CREATE'),
    ]);
    return planCast(people, actors, canCreate);
  }

  /**
   * Resolves every person to an actor of ours — linking, creating and
   * fetching photos as the plan says — and returns the ids to put on the
   * title. `user` is the staff member the fill runs for: new actors need
   * their ACTORS.CREATE, and every audit row is in their name.
   */
  async attach(
    people: readonly TmdbCastPerson[],
    user: AuthenticatedUser,
  ): Promise<TmdbCastOutcome> {
    const outcome: TmdbCastOutcome = {
      actorIds: [],
      reused: 0,
      created: 0,
      skipped: [],
    };
    const attached: AttachedActor[] = [];

    for (const entry of await this.plan(people, user)) {
      const { person } = entry;
      if (entry.action === 'skip_no_permission') {
        outcome.skipped.push({ name: person.name, reason: 'no_permission' });
        continue;
      }
      let result: AttachedActor | null = null;
      if (entry.action === 'create') {
        result = await this.create(person);
      } else if (entry.action === 'reuse' && entry.actor) {
        result = entry.link
          ? await this.link(entry.actor, person)
          : { person, before: entry.actor, row: entry.actor };
      }
      if (!result) {
        outcome.skipped.push({ name: person.name, reason: 'same_name' });
        continue;
      }
      if (outcome.actorIds.includes(result.row.id)) continue;
      outcome.actorIds.push(result.row.id);
      if (result.before === null) outcome.created += 1;
      else outcome.reused += 1;
      attached.push(result);
    }

    await this.addPhotos(attached, user);
    for (const entry of attached) await this.record(entry, user);
    return outcome;
  }

  /** Every actor of the catalogue, read once per fill and compared in memory — no name column to keep in step. */
  private loadActors(): Promise<KnownActor[]> {
    return this.prisma.actor.findMany({ select: KNOWN_ACTOR_SELECT });
  }

  /**
   * Gives an actor found by name its TMDB person id. Guarded on the id
   * still being empty; when it is not, or the unique index says another
   * row took this person a moment ago, the row that now carries the person
   * is used instead — and when there is none, the person is skipped.
   */
  private async link(
    actor: KnownActor,
    person: TmdbCastPerson,
  ): Promise<AttachedActor | null> {
    try {
      const { count } = await this.prisma.actor.updateMany({
        where: { id: actor.id, tmdbPersonId: null },
        data: { tmdbPersonId: person.tmdbPersonId },
      });
      if (count === 1) {
        return {
          person,
          before: { ...actor, tmdbPersonId: null },
          row: { ...actor, tmdbPersonId: person.tmdbPersonId },
        };
      }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return this.findByPerson(person);
  }

  /**
   * Creates the actor. A unique clash (on the name or on the person id)
   * means someone else just created the same person: that row is read and
   * used, never a second one made.
   */
  private async create(person: TmdbCastPerson): Promise<AttachedActor | null> {
    try {
      const row = await this.prisma.actor.create({
        data: { name: person.name, tmdbPersonId: person.tmdbPersonId },
        select: KNOWN_ACTOR_SELECT,
      });
      return { person, before: null, row };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const byPerson = await this.findByPerson(person);
    if (byPerson) return byPerson;
    const byName = await this.prisma.actor.findUnique({
      where: { name: person.name },
      select: KNOWN_ACTOR_SELECT,
    });
    // The same name already linked to another TMDB person: a namesake.
    if (!byName || byName.tmdbPersonId !== null) return null;
    return this.link(byName, person);
  }

  private async findByPerson(
    person: TmdbCastPerson,
  ): Promise<AttachedActor | null> {
    const row = await this.prisma.actor.findUnique({
      where: { tmdbPersonId: person.tmdbPersonId },
      select: KNOWN_ACTOR_SELECT,
    });
    return row ? { person, before: row, row } : null;
  }

  /**
   * A photo for every attached actor that has none and whose TMDB person
   * has one — a new actor, or an old one whose headshot was never added.
   * A few at a time; a photo that cannot be fetched or stored is simply
   * not there, the actor is attached all the same.
   */
  private async addPhotos(
    attached: AttachedActor[],
    user: AuthenticatedUser,
  ): Promise<void> {
    const waiting = attached.filter(
      (entry) => !entry.row.imageUrl && entry.person.profilePath !== null,
    );
    const worker = async () => {
      for (;;) {
        const entry = waiting.shift();
        if (!entry) return;
        const url = await this.addPhoto(entry, user);
        if (url) entry.row = { ...entry.row, imageUrl: url };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PHOTO_CONCURRENCY, waiting.length) }, () =>
        worker(),
      ),
    );
  }

  private async addPhoto(
    entry: AttachedActor,
    user: AuthenticatedUser,
  ): Promise<string | null> {
    const path = entry.person.profilePath;
    if (path === null) return null;
    const actorId = entry.row.id;
    let url: string;
    try {
      const fetched = await this.images.fetch(
        'profile',
        path,
        imageUploadByteLimit('actor'),
      );
      if (!fetched.ok) return null;
      // The same checks, resize and audit row a staff upload gets; only the
      // file name (tmdb-<uuid>) says where it came from.
      url = await this.imageStore.save(
        'actor',
        path.slice(1),
        fetched.buffer,
        user,
        { source: 'tmdb', sourceRef: path },
      );
    } catch (error) {
      this.logger.warn(
        `Could not store the TMDB photo of actor ${actorId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    try {
      // Only while the actor still has no photo: one staff added meanwhile
      // is never replaced.
      const { count } = await this.prisma.actor.updateMany({
        where: { id: actorId, OR: [{ imageUrl: null }, { imageUrl: '' }] },
        data: { imageUrl: url },
      });
      if (count === 1) return url;
    } catch (error) {
      this.logger.warn(
        `Could not set the TMDB photo on actor ${actorId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.deleteStored(url, actorId);
    return null;
  }

  /** A stored photo nothing points at (the actor got one meanwhile, or is gone) is removed again. */
  private async deleteStored(url: string, actorId: string): Promise<void> {
    try {
      const key = this.minioService.keyFromPublicUrl(url);
      if (key) await this.minioService.deleteObject(key);
    } catch (error) {
      this.logger.warn(
        `Failed to delete the unused TMDB photo of actor ${actorId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** `actor.create` for a new person; `actor.update` for an existing one this run changed (AuditService drops an empty diff). */
  private async record(
    entry: AttachedActor,
    user: AuthenticatedUser,
  ): Promise<void> {
    const metadata = {
      via: 'tmdb',
      tmdbPersonId: entry.person.tmdbPersonId,
    };
    const target = {
      type: 'actor' as const,
      id: entry.row.id,
      label: entry.row.name,
    };
    if (entry.before === null) {
      await this.audit.record({
        action: 'actor.create',
        actor: user,
        target,
        after: actorSnapshot(entry.row),
        metadata,
      });
      return;
    }
    await this.audit.record({
      action: 'actor.update',
      actor: user,
      target,
      before: actorSnapshot(entry.before),
      after: actorSnapshot(entry.row),
      metadata,
    });
  }
}
