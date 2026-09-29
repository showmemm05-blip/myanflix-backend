import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActorsService } from './actors.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { AuditService } from '../audit/audit.service';
import { MovieStatus, Role, SeriesStatus } from '../generated/prisma/client';
import { CATALOG_INCLUDE } from '../movies/movies.service';

const ACTOR_ID = 'actor-1';

/** A staff actor for the audit calls — the mocked AuditService records nothing. */
const STAFF = {
  id: 'admin-1',
  username: 'boss',
  role: Role.ADMIN,
  appRoleId: null,
} as const;

describe('ActorsService', () => {
  let service: ActorsService;
  let prisma: {
    actor: {
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    movie: { findMany: jest.Mock };
    series: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let minioService: {
    canonicalImageUrl: jest.Mock;
    keyFromPublicUrl: jest.Mock;
    deleteObject: jest.Mock;
  };

  const actor = (overrides: Record<string, unknown> = {}) => ({
    id: ACTOR_ID,
    name: 'Kyaw Kyaw',
    imageUrl: null,
    _count: { movies: 3 },
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      actor: {
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      series: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    };
    minioService = {
      canonicalImageUrl: jest.fn((url: string | null) => url),
      keyFromPublicUrl: jest.fn(() => 'images/actor/headshot.jpg'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActorsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(ActorsService);
  });

  describe('findAll', () => {
    beforeEach(() => prisma.$transaction.mockResolvedValue([[], 0]));

    const argsOf = () =>
      prisma.actor.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        orderBy: unknown;
        include: unknown;
      };

    it('orders by name — a cast list is browsed alphabetically, not by recency', async () => {
      await service.findAll({});
      expect(argsOf().orderBy).toEqual({ name: 'asc' });
    });

    it('searches names case-insensitively', async () => {
      await service.findAll({ search: 'kyaw' });
      expect(argsOf().where).toEqual({
        name: { contains: 'kyaw', mode: 'insensitive' },
      });
    });

    it('counts STANDALONE movies only — an episode is a Movie row but GET /movies never lists it', async () => {
      await service.findAll({});
      expect(argsOf().include).toEqual({
        _count: { select: { movies: { where: { seriesId: null } } } },
      });
    });

    it('skips the series query entirely for an empty page', async () => {
      await service.findAll({});
      expect(prisma.series.findMany).not.toHaveBeenCalled();
    });

    it('narrows the film count to PUBLISHED titles for a regular viewer — the People list must never promise more than the page can show', async () => {
      await service.findAll({}, Role.USER);
      expect(argsOf().include).toEqual({
        _count: {
          select: {
            movies: {
              where: { seriesId: null, status: MovieStatus.PUBLISHED },
            },
          },
        },
      });
    });

    it('counts every standalone film for staff, published or not', async () => {
      await service.findAll({}, Role.ADMIN);
      expect(argsOf().include).toEqual({
        _count: { select: { movies: { where: { seriesId: null } } } },
      });
    });
  });

  /**
   * The People list said "2 movies" for a person with one film and one
   * EPISODE, and the person's page then showed one. Episode credits now
   * roll up into seriesCount instead — by the same show-OR-episode rule the
   * series catalogue's actorIds filter uses, so the number promised equals
   * the rows the page can list.
   */
  describe('seriesCount', () => {
    const page = [
      actor({ id: 'jackie', name: 'Jackie Chan', _count: { movies: 1 } }),
      actor({ id: 'newcomer', name: 'Newcomer', _count: { movies: 0 } }),
      actor({ id: 'lead', name: 'Lead', _count: { movies: 2 } }),
    ];

    beforeEach(() => {
      prisma.$transaction.mockResolvedValue([page, page.length]);
      prisma.series.findMany.mockResolvedValue([
        // Jackie only on an episode; Lead on the show itself.
        {
          id: 'show-a',
          actors: [{ id: 'lead' }],
          episodes: [{ actors: [{ id: 'jackie' }] }],
        },
        // Lead on the show AND on two episodes — still one series.
        {
          id: 'show-b',
          actors: [{ id: 'lead' }],
          episodes: [
            { actors: [{ id: 'lead' }] },
            { actors: [{ id: 'lead' }] },
          ],
        },
      ]);
    });

    it('is one extra query for the whole page, scoped to the page ids, never one per actor', async () => {
      await service.findAll({});

      expect(prisma.series.findMany).toHaveBeenCalledTimes(1);
      const ids = ['jackie', 'newcomer', 'lead'];
      expect(prisma.series.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { actors: { some: { id: { in: ids } } } },
            { episodes: { some: { actors: { some: { id: { in: ids } } } } } },
          ],
        },
        select: {
          id: true,
          actors: { where: { id: { in: ids } }, select: { id: true } },
          episodes: {
            where: { actors: { some: { id: { in: ids } } } },
            select: {
              actors: { where: { id: { in: ids } }, select: { id: true } },
            },
          },
        },
      });
    });

    it('for a regular viewer only PUBLISHED shows are counted — the rule GET /series applies to them', async () => {
      await service.findAll({}, Role.USER);
      const ids = ['jackie', 'newcomer', 'lead'];
      const cast = {
        OR: [
          { actors: { some: { id: { in: ids } } } },
          { episodes: { some: { actors: { some: { id: { in: ids } } } } } },
        ],
      };
      expect(prisma.series.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { AND: [cast, { status: SeriesStatus.PUBLISHED }] },
        }),
      );
    });

    it('counts DISTINCT series: episode-only credits count, show+episode credits count once, none is 0', async () => {
      const { items } = await service.findAll({});

      expect(items.map((a) => [a.id, a._count.movies, a.seriesCount])).toEqual([
        ['jackie', 1, 1],
        ['newcomer', 0, 0],
        ['lead', 2, 2],
      ]);
    });

    it('GET /actors/:id carries the same seriesCount', async () => {
      prisma.actor.findUnique.mockResolvedValue(page[0]);

      const result = await service.findByIdOrThrow('jackie');

      expect(result.seriesCount).toBe(1);
      expect(result._count.movies).toBe(1);
    });

    it('a freshly created actor reports seriesCount 0 without a query', async () => {
      prisma.actor.findUnique.mockResolvedValue(null);
      prisma.actor.create.mockResolvedValue(actor({ _count: { movies: 0 } }));

      const created = await service.create({ name: 'New Person' }, STAFF);

      expect(created.seriesCount).toBe(0);
      expect(prisma.series.findMany).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('refuses a duplicate name — that is what a row per person prevents', async () => {
      prisma.actor.findUnique.mockResolvedValue(actor());

      await expect(
        service.create({ name: 'Kyaw Kyaw' }, STAFF),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.actor.create).not.toHaveBeenCalled();
    });

    it('canonicalises the headshot URL before storing it', async () => {
      prisma.actor.findUnique.mockResolvedValue(null);
      prisma.actor.create.mockResolvedValue(actor());

      await service.create(
        { name: 'New Person', imageUrl: 'http://x/i.jpg' },
        STAFF,
      );

      expect(minioService.canonicalImageUrl).toHaveBeenCalledWith(
        'http://x/i.jpg',
      );
    });
  });

  describe('update', () => {
    it('404s an unknown actor', async () => {
      prisma.actor.findUnique.mockResolvedValue(null);

      await expect(
        service.update('nope', { name: 'X' }, STAFF),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets an actor keep their own name', async () => {
      prisma.actor.findUnique
        .mockResolvedValueOnce(actor())
        .mockResolvedValueOnce(actor());
      prisma.actor.update.mockResolvedValue(actor());

      await expect(
        service.update(ACTOR_ID, { name: 'Kyaw Kyaw' }, STAFF),
      ).resolves.toBeDefined();
    });

    it('refuses a name another actor already holds', async () => {
      prisma.actor.findUnique
        .mockResolvedValueOnce(actor())
        .mockResolvedValueOnce(actor({ id: 'someone-else' }));

      await expect(
        service.update(ACTOR_ID, { name: 'Taken' }, STAFF),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('deletes the old headshot when it is replaced', async () => {
      prisma.actor.findUnique.mockResolvedValue(
        actor({ imageUrl: 'http://x/old.jpg' }),
      );
      prisma.actor.update.mockResolvedValue(
        actor({ imageUrl: 'http://x/new.jpg' }),
      );

      await service.update(ACTOR_ID, { imageUrl: 'http://x/new.jpg' }, STAFF);

      expect(minioService.deleteObject).toHaveBeenCalledWith(
        'images/actor/headshot.jpg',
      );
    });

    it(
      'does NOT delete the image when the same URL is re-submitted — the ' +
        'admin form echoes the current value back on every unrelated save',
      async () => {
        prisma.actor.findUnique.mockResolvedValue(
          actor({ imageUrl: 'http://x/same.jpg' }),
        );
        prisma.actor.update.mockResolvedValue(
          actor({ imageUrl: 'http://x/same.jpg' }),
        );

        await service.update(
          ACTOR_ID,
          { imageUrl: 'http://x/same.jpg' },
          STAFF,
        );

        expect(minioService.deleteObject).not.toHaveBeenCalled();
      },
    );

    it('leaves the image alone when the edit does not mention it', async () => {
      prisma.actor.findUnique.mockResolvedValue(
        actor({ imageUrl: 'http://x/kept.jpg' }),
      );
      prisma.actor.update.mockResolvedValue(
        actor({ imageUrl: 'http://x/kept.jpg' }),
      );

      await service.update(ACTOR_ID, { name: 'Renamed' }, STAFF);

      expect(minioService.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('audits how many standalone films and series lost this person, counted before the delete', async () => {
      prisma.actor.findUnique.mockResolvedValue(
        actor({ _count: { movies: 3 } }),
      );
      prisma.series.findMany.mockResolvedValue([
        { id: 's1', actors: [{ id: ACTOR_ID }], episodes: [] },
        { id: 's2', actors: [], episodes: [{ actors: [{ id: ACTOR_ID }] }] },
      ]);
      const audit = service['audit'] as unknown as { record: jest.Mock };

      await service.remove(ACTOR_ID, STAFF);

      expect(prisma.series.findMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.actor.delete.mock.invocationCallOrder[0],
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'actor.delete',
          metadata: { unlinkedMovies: 3, unlinkedSeries: 2 },
        }),
      );
    });

    it('deletes the row and then the headshot', async () => {
      prisma.actor.findUnique.mockResolvedValue(
        actor({ imageUrl: 'http://x/i.jpg' }),
      );

      await service.remove(ACTOR_ID, STAFF);

      expect(prisma.actor.delete).toHaveBeenCalledWith({
        where: { id: ACTOR_ID },
      });
      expect(minioService.deleteObject).toHaveBeenCalled();
    });

    it('still succeeds when storage cleanup fails — a leaked object must not block the delete', async () => {
      prisma.actor.findUnique.mockResolvedValue(
        actor({ imageUrl: 'http://x/i.jpg' }),
      );
      minioService.deleteObject.mockRejectedValue(new Error('storage down'));

      await expect(service.remove(ACTOR_ID, STAFF)).resolves.toBeUndefined();
      expect(prisma.actor.delete).toHaveBeenCalled();
    });

    it('404s an unknown actor instead of silently succeeding', async () => {
      prisma.actor.findUnique.mockResolvedValue(null);
      await expect(service.remove('nope', STAFF)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getMovies', () => {
    it('returns everything the actor appears in to staff, newest first', async () => {
      prisma.actor.findUnique.mockResolvedValue({ id: ACTOR_ID });

      await service.getMovies(ACTOR_ID, Role.ADMIN);

      expect(prisma.movie.findMany).toHaveBeenCalledWith({
        where: { actors: { some: { id: ACTOR_ID } } },
        include: CATALOG_INCLUDE,
        orderBy: { releaseYear: 'desc' },
      });
    });

    /**
     * H-7: this route is open to every signed-in user, so it must not hand
     * out the ids of DRAFT, ARCHIVED or READY_TO_PUBLISH titles, nor of
     * episodes (GET /movies never lists an episode) — the same catalogue
     * rule the People counts use.
     */
    it('narrows a regular viewer to PUBLISHED standalone films', async () => {
      prisma.actor.findUnique.mockResolvedValue({ id: ACTOR_ID });

      await service.getMovies(ACTOR_ID, Role.USER);

      expect(prisma.movie.findMany).toHaveBeenCalledWith({
        where: {
          actors: { some: { id: ACTOR_ID } },
          seriesId: null,
          status: MovieStatus.PUBLISHED,
        },
        include: CATALOG_INCLUDE,
        orderBy: { releaseYear: 'desc' },
      });
    });

    it('404s an unknown actor', async () => {
      prisma.actor.findUnique.mockResolvedValue(null);
      await expect(service.getMovies('nope', Role.USER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
