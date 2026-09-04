import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActorsService } from './actors.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';

const ACTOR_ID = 'actor-1';

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
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    };
    minioService = {
      canonicalImageUrl: jest.fn((url: string | null) => url),
      keyFromPublicUrl: jest.fn(() => 'images/headshot.jpg'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActorsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
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

    it('always counts movies from the join rather than a stored column', async () => {
      await service.findAll({});
      expect(argsOf().include).toEqual({ _count: { select: { movies: true } } });
    });
  });

  describe('create', () => {
    it('refuses a duplicate name — that is what a row per person prevents', async () => {
      prisma.actor.findUnique.mockResolvedValue(actor());

      await expect(
        service.create({ name: 'Kyaw Kyaw' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.actor.create).not.toHaveBeenCalled();
    });

    it('canonicalises the headshot URL before storing it', async () => {
      prisma.actor.findUnique.mockResolvedValue(null);
      prisma.actor.create.mockResolvedValue(actor());

      await service.create({ name: 'New Person', imageUrl: 'http://x/i.jpg' });

      expect(minioService.canonicalImageUrl).toHaveBeenCalledWith(
        'http://x/i.jpg',
      );
    });
  });

  describe('update', () => {
    it('404s an unknown actor', async () => {
      prisma.actor.findUnique.mockResolvedValue(null);

      await expect(
        service.update('nope', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets an actor keep their own name', async () => {
      prisma.actor.findUnique
        .mockResolvedValueOnce(actor())
        .mockResolvedValueOnce(actor());
      prisma.actor.update.mockResolvedValue(actor());

      await expect(
        service.update(ACTOR_ID, { name: 'Kyaw Kyaw' }),
      ).resolves.toBeDefined();
    });

    it('refuses a name another actor already holds', async () => {
      prisma.actor.findUnique
        .mockResolvedValueOnce(actor())
        .mockResolvedValueOnce(actor({ id: 'someone-else' }));

      await expect(
        service.update(ACTOR_ID, { name: 'Taken' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('deletes the old headshot when it is replaced', async () => {
      prisma.actor.findUnique.mockResolvedValue(
        actor({ imageUrl: 'http://x/old.jpg' }),
      );
      prisma.actor.update.mockResolvedValue(
        actor({ imageUrl: 'http://x/new.jpg' }),
      );

      await service.update(ACTOR_ID, { imageUrl: 'http://x/new.jpg' });

      expect(minioService.deleteObject).toHaveBeenCalledWith(
        'images/headshot.jpg',
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

        await service.update(ACTOR_ID, { imageUrl: 'http://x/same.jpg' });

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

      await service.update(ACTOR_ID, { name: 'Renamed' });

      expect(minioService.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes the row and then the headshot', async () => {
      prisma.actor.findUnique.mockResolvedValue(
        actor({ imageUrl: 'http://x/i.jpg' }),
      );

      await service.remove(ACTOR_ID);

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

      await expect(service.remove(ACTOR_ID)).resolves.toBeUndefined();
      expect(prisma.actor.delete).toHaveBeenCalled();
    });

    it('404s an unknown actor instead of silently succeeding', async () => {
      prisma.actor.findUnique.mockResolvedValue(null);
      await expect(service.remove('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getMovies', () => {
    it('returns everything the actor appears in, newest first', async () => {
      prisma.actor.findUnique.mockResolvedValue({ id: ACTOR_ID });

      await service.getMovies(ACTOR_ID);

      expect(prisma.movie.findMany).toHaveBeenCalledWith({
        where: { actors: { some: { id: ACTOR_ID } } },
        orderBy: { releaseYear: 'desc' },
      });
    });

    it('404s an unknown actor', async () => {
      prisma.actor.findUnique.mockResolvedValue(null);
      await expect(service.getMovies('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
