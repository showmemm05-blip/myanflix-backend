import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { AuditService } from '../audit/audit.service';
import { actorSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type {
  ActorQueryDto,
  CreateActorDto,
  UpdateActorDto,
} from './dto/actor.dto';

const WITH_MOVIE_COUNT = {
  _count: { select: { movies: true } },
} satisfies Prisma.ActorInclude;

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
  async findAll(query: ActorQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ActorWhereInput = {};
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.actor.findMany({
        where,
        include: WITH_MOVIE_COUNT,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.actor.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async findByIdOrThrow(id: string) {
    const actor = await this.prisma.actor.findUnique({
      where: { id },
      include: WITH_MOVIE_COUNT,
    });
    if (!actor) throw new NotFoundException('Actor not found');
    return actor;
  }

  /** The movies this person is in — the payoff of a row per actor. */
  async getMovies(id: string) {
    await this.assertExists(id);
    return this.prisma.movie.findMany({
      where: { actors: { some: { id } } },
      orderBy: { releaseYear: 'desc' },
    });
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

    return created;
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

    return updated;
  }

  /**
   * Deleting an actor removes them from every film's cast (the implicit
   * join cascades) but touches no movie itself. DB row first, then the
   * headshot — the same order and reasoning as MoviesService.remove.
   */
  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const person = await this.prisma.actor.findUnique({
      where: { id },
      include: WITH_MOVIE_COUNT,
    });
    if (!person) throw new NotFoundException('Actor not found');

    await this.prisma.actor.delete({ where: { id } });

    await this.audit.record({
      action: 'actor.delete',
      actor,
      target: { type: 'actor', id, label: person.name },
      before: actorSnapshot(person),
      metadata: { unlinkedMovies: person._count?.movies ?? 0 },
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

  private async assertExists(id: string): Promise<void> {
    const exists = await this.prisma.actor.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Actor not found');
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
