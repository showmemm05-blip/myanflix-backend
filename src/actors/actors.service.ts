import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  MovieStatus,
  Prisma,
  Role,
  SeriesStatus,
  type Actor,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { AuditService } from '../audit/audit.service';
import { actorSnapshot } from '../audit/audit-snapshots';
import { seriesCastWhere } from '../series/series.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type {
  ActorQueryDto,
  CreateActorDto,
  UpdateActorDto,
} from './dto/actor.dto';

/**
 * `movies` counts STANDALONE films only. An episode is a Movie row too
 * (seriesId set), but GET /movies never lists episodes, so counting them
 * here made the People list promise "2 movies" for a person whose page
 * could only show one. Episode credits surface through seriesCount instead.
 */
function movieCountInclude(publishedOnly: boolean) {
  return {
    _count: {
      select: {
        movies: {
          where: publishedOnly
            ? { seriesId: null, status: MovieStatus.PUBLISHED }
            : { seriesId: null },
        },
      },
    },
  } satisfies Prisma.ActorInclude;
}

/**
 * Staff and internal reads count every standalone film. A regular user (or a
 * guest) only ever sees PUBLISHED titles in the catalogue, so their counts
 * are narrowed the same way — otherwise the People list could promise a
 * film or a show that the person's page cannot list, which is exactly the
 * mismatch this counting exists to prevent.
 */
const WITH_MOVIE_COUNT = movieCountInclude(false);

/** True when the caller's catalogue is the published-only one. */
const publishedOnlyFor = (viewerRole: Role | undefined) =>
  viewerRole === Role.USER;

type ActorWithMovieCount = Actor & { _count: { movies: number } };

/** What the controller renders: the row, its standalone-film count, and its series count. */
export type ActorWithCounts = ActorWithMovieCount & { seriesCount: number };

@Injectable()
export class ActorsService {
  private readonly logger = new Logger(ActorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The cast list, ordered by name — this is browsed and searched, not
   * scrolled by recency, so alphabetical is the useful order.
   */
  async findAll(query: ActorQueryDto, viewerRole?: Role) {
    const publishedOnly = publishedOnlyFor(viewerRole);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ActorWhereInput = {};
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.actor.findMany({
        where,
        include: movieCountInclude(publishedOnly),
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.actor.count({ where }),
    ]);

    return {
      items: await this.withSeriesCounts(rows, publishedOnly),
      total,
      page,
      limit,
    };
  }

  async findByIdOrThrow(
    id: string,
    viewerRole?: Role,
  ): Promise<ActorWithCounts> {
    const publishedOnly = publishedOnlyFor(viewerRole);
    const actor = await this.prisma.actor.findUnique({
      where: { id },
      include: movieCountInclude(publishedOnly),
    });
    if (!actor) throw new NotFoundException('Actor not found');
    const [withCounts] = await this.withSeriesCounts([actor], publishedOnly);
    return withCounts;
  }

  /**
   * seriesCount for a page of actors in ONE extra query, never one per
   * actor: fetch every series that features any of them (the same
   * show-OR-episode rule the series catalogue filters by, so the number
   * on the People list equals the rows the person's page will show), with
   * the nested casts narrowed to these ids, then tally distinct series per
   * actor in memory. A series with the actor on the show AND on three
   * episodes still counts once.
   */
  private async withSeriesCounts<T extends ActorWithMovieCount>(
    actors: T[],
    publishedOnly: boolean,
  ): Promise<(T & { seriesCount: number })[]> {
    if (actors.length === 0) return [];
    const ids = actors.map((a) => a.id);
    const onlyThese = { where: { id: { in: ids } }, select: { id: true } };

    // Same narrowing GET /series applies for a regular viewer: the show
    // itself must be PUBLISHED (episode status is not consulted there either).
    const where: Prisma.SeriesWhereInput = publishedOnly
      ? { AND: [seriesCastWhere(ids), { status: SeriesStatus.PUBLISHED }] }
      : seriesCastWhere(ids);

    const series = await this.prisma.series.findMany({
      where,
      select: {
        id: true,
        actors: onlyThese,
        episodes: {
          where: { actors: { some: { id: { in: ids } } } },
          select: { actors: onlyThese },
        },
      },
    });

    const seriesByActor = new Map<string, Set<string>>();
    const credit = (actorId: string, seriesId: string) => {
      let set = seriesByActor.get(actorId);
      if (!set) seriesByActor.set(actorId, (set = new Set()));
      set.add(seriesId);
    };
    for (const show of series) {
      for (const a of show.actors) credit(a.id, show.id);
      for (const episode of show.episodes)
        for (const a of episode.actors) credit(a.id, show.id);
    }

    return actors.map((a) => ({
      ...a,
      seriesCount: seriesByActor.get(a.id)?.size ?? 0,
    }));
  }

  async create(dto: CreateActorDto, actor: AuthenticatedUser) {
    await this.assertNameAvailable(dto.name);
    const created = await this.prisma.actor.create({
      data: {
        name: dto.name,
        imageUrl: this.minioService.canonicalImageUrl(dto.imageUrl),
      },
      include: WITH_MOVIE_COUNT,
    });

    await this.audit.record({
      action: 'actor.create',
      actor,
      target: { type: 'actor', id: created.id, label: created.name },
      after: actorSnapshot(created),
    });

    // A row that did not exist a moment ago cannot be on any series yet.
    return { ...created, seriesCount: 0 } satisfies ActorWithCounts;
  }

  async update(id: string, dto: UpdateActorDto, actor: AuthenticatedUser) {
    const current = await this.prisma.actor.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Actor not found');
    if (dto.name) await this.assertNameAvailable(dto.name, id);

    const updated = await this.prisma.actor.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.imageUrl !== undefined
          ? { imageUrl: this.minioService.canonicalImageUrl(dto.imageUrl) }
          : {}),
      },
      include: WITH_MOVIE_COUNT,
    });

    // A replaced headshot's object would otherwise sit in the bucket forever
    // with nothing pointing at it. Best-effort, and only when the URL really
    // changed — re-saving the same actor must not delete the live image.
    if (
      dto.imageUrl !== undefined &&
      current.imageUrl &&
      current.imageUrl !== updated.imageUrl
    ) {
      await this.deleteImage(current.imageUrl, id);
    }

    await this.audit.record({
      action: 'actor.update',
      actor,
      target: { type: 'actor', id, label: updated.name },
      before: actorSnapshot(current),
      after: actorSnapshot(updated),
    });

    const [withCounts] = await this.withSeriesCounts([updated], false);
    return withCounts;
  }

  /**
   * Deleting an actor removes them from every film's cast (the implicit
   * join cascades) but touches no movie itself. DB row first, then the
   * headshot — the same order and reasoning as MoviesService.remove.
   */
  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const row = await this.prisma.actor.findUnique({
      where: { id },
      include: WITH_MOVIE_COUNT,
    });
    if (!row) throw new NotFoundException('Actor not found');
    // Counted BEFORE the delete — the join rows are gone right after it.
    const [person] = await this.withSeriesCounts([row], false);

    await this.prisma.actor.delete({ where: { id } });

    await this.audit.record({
      action: 'actor.delete',
      actor,
      target: { type: 'actor', id, label: person.name },
      before: actorSnapshot(person),
      metadata: {
        // Standalone films only, same meaning as the movieCount the admin saw.
        unlinkedMovies: person._count?.movies ?? 0,
        unlinkedSeries: person.seriesCount,
      },
    });

    if (person.imageUrl) await this.deleteImage(person.imageUrl, id);
  }

  private async deleteImage(url: string, actorId: string): Promise<void> {
    try {
      const key = this.minioService.keyFromPublicUrl(url);
      if (key) await this.minioService.deleteObject(key);
    } catch (error) {
      this.logger.warn(
        `Failed to clean up the headshot for actor ${actorId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Names are unique so one person cannot end up in the catalogue three
   * times under three spellings — the exact thing a per-person row exists to
   * prevent.
   */
  private async assertNameAvailable(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.actor.findUnique({ where: { name } });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException('An actor with this name already exists');
    }
  }
}
