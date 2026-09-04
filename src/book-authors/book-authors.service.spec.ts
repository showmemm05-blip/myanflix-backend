import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { BookAuthorsService } from './book-authors.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';

const AUTHOR_ID = 'author-1';

describe('BookAuthorsService', () => {
  let service: BookAuthorsService;
  let prisma: {
    bookAuthor: {
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    book: { updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let minioService: {
    canonicalImageUrl: jest.Mock;
    keyFromPublicUrl: jest.Mock;
    deleteObject: jest.Mock;
  };

  const author = (overrides: Record<string, unknown> = {}) => ({
    id: AUTHOR_ID,
    name: 'Blake',
    imageUrl: null,
    bio: null,
    _count: { books: 0 },
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      bookAuthor: {
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      book: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      // Both shapes the service uses: an array of queries (findAll) and an
      // interactive callback (update), which gets a tx that is this same
      // mock set.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
          : Promise.all(arg as unknown[]),
      ),
    };
    minioService = {
      canonicalImageUrl: jest.fn((url: string | null) => url),
      keyFromPublicUrl: jest.fn(() => 'images/portrait.jpg'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookAuthorsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
      ],
    }).compile();

    service = module.get(BookAuthorsService);
  });

  describe('findAll', () => {
    beforeEach(() => prisma.$transaction.mockResolvedValue([[], 0]));

    const argsOf = () =>
      prisma.bookAuthor.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        orderBy: unknown;
        include: unknown;
      };

    it('orders by name — an author list is browsed alphabetically', async () => {
      await service.findAll({});
      expect(argsOf().orderBy).toEqual({ name: 'asc' });
    });

    it('searches names case-insensitively', async () => {
      await service.findAll({ search: 'bla' });
      expect(argsOf().where).toEqual({
        name: { contains: 'bla', mode: 'insensitive' },
      });
    });

    it('counts books from the relation rather than a stored column', async () => {
      await service.findAll({});
      expect(argsOf().include).toEqual({ _count: { select: { books: true } } });
    });
  });

  describe('create', () => {
    it('trims the name and 409s a case-insensitive duplicate', async () => {
      prisma.bookAuthor.findFirst.mockResolvedValue(author());

      await expect(
        service.create({ name: '  blake ' }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.bookAuthor.findFirst).toHaveBeenCalledWith({
        where: { name: { equals: 'blake', mode: 'insensitive' } },
      });
      expect(prisma.bookAuthor.create).not.toHaveBeenCalled();
    });

    it('stores the trimmed name and the canonicalised portrait URL', async () => {
      prisma.bookAuthor.findFirst.mockResolvedValue(null);
      prisma.bookAuthor.create.mockResolvedValue(author());

      await service.create({ name: ' New Person ', imageUrl: 'http://x/p.jpg' });

      expect(minioService.canonicalImageUrl).toHaveBeenCalledWith(
        'http://x/p.jpg',
      );
      expect(prisma.bookAuthor.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'New Person', bio: null }),
        }),
      );
    });
  });

  describe('update', () => {
    it('404s an unknown author', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(null);

      await expect(
        service.update('nope', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fans a rename out to every credited book\'s display string', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(author());
      prisma.bookAuthor.findFirst.mockResolvedValue(null);
      prisma.bookAuthor.update.mockResolvedValue(author({ name: 'Blake Crouch' }));

      await service.update(AUTHOR_ID, { name: ' Blake Crouch ' });

      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { authorId: AUTHOR_ID },
        data: { author: 'Blake Crouch' },
      });
    });

    it('does NOT touch the books when the name is unchanged', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(author());
      prisma.bookAuthor.findFirst.mockResolvedValue(author());
      prisma.bookAuthor.update.mockResolvedValue(author());

      await service.update(AUTHOR_ID, { name: 'Blake', bio: 'Writes.' });

      expect(prisma.book.updateMany).not.toHaveBeenCalled();
    });

    it('lets an author keep their own name, whatever the casing', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(author());
      prisma.bookAuthor.findFirst.mockResolvedValue(author());
      prisma.bookAuthor.update.mockResolvedValue(author());

      await expect(
        service.update(AUTHOR_ID, { name: 'blake' }),
      ).resolves.toBeDefined();
    });

    it('refuses a name another author already holds', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(author());
      prisma.bookAuthor.findFirst.mockResolvedValue(
        author({ id: 'someone-else', name: 'Taken' }),
      );

      await expect(
        service.update(AUTHOR_ID, { name: 'taken' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.bookAuthor.update).not.toHaveBeenCalled();
    });

    it('deletes the old portrait only when the URL really changed', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(
        author({ imageUrl: 'http://x/old.jpg' }),
      );
      prisma.bookAuthor.update.mockResolvedValue(
        author({ imageUrl: 'http://x/new.jpg' }),
      );

      await service.update(AUTHOR_ID, { imageUrl: 'http://x/new.jpg' });

      expect(minioService.deleteObject).toHaveBeenCalledWith(
        'images/portrait.jpg',
      );
    });

    it('keeps the portrait when the same URL is echoed back', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(
        author({ imageUrl: 'http://x/same.jpg' }),
      );
      prisma.bookAuthor.update.mockResolvedValue(
        author({ imageUrl: 'http://x/same.jpg' }),
      );

      await service.update(AUTHOR_ID, { imageUrl: 'http://x/same.jpg' });

      expect(minioService.deleteObject).not.toHaveBeenCalled();
    });

    it('leaves the portrait alone when the edit does not mention it', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(
        author({ imageUrl: 'http://x/kept.jpg' }),
      );
      prisma.bookAuthor.findFirst.mockResolvedValue(null);
      prisma.bookAuthor.update.mockResolvedValue(
        author({ name: 'Renamed', imageUrl: 'http://x/kept.jpg' }),
      );

      await service.update(AUTHOR_ID, { name: 'Renamed' });

      expect(minioService.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('409s with the count when the author is still credited on books', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(
        author({ _count: { books: 3 } }),
      );

      await expect(service.remove(AUTHOR_ID)).rejects.toMatchObject({
        constructor: ConflictException,
        message: expect.stringContaining('3 books'),
      });
      expect(prisma.bookAuthor.delete).not.toHaveBeenCalled();
    });

    it('singularises the message for one book', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(
        author({ _count: { books: 1 } }),
      );

      await expect(service.remove(AUTHOR_ID)).rejects.toMatchObject({
        message: expect.stringContaining('on 1 book.'),
      });
    });

    it('deletes the row and then the portrait when unreferenced', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(
        author({ imageUrl: 'http://x/p.jpg' }),
      );

      await service.remove(AUTHOR_ID);

      expect(prisma.bookAuthor.delete).toHaveBeenCalledWith({
        where: { id: AUTHOR_ID },
      });
      expect(minioService.deleteObject).toHaveBeenCalled();
    });

    it('still succeeds when storage cleanup fails', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(
        author({ imageUrl: 'http://x/p.jpg' }),
      );
      minioService.deleteObject.mockRejectedValue(new Error('storage down'));

      await expect(service.remove(AUTHOR_ID)).resolves.toBeUndefined();
      expect(prisma.bookAuthor.delete).toHaveBeenCalled();
    });

    it('404s an unknown author instead of silently succeeding', async () => {
      prisma.bookAuthor.findUnique.mockResolvedValue(null);
      await expect(service.remove('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findOrCreateByName', () => {
    it('returns the existing row for " blake " when "Blake" exists', async () => {
      prisma.bookAuthor.findFirst.mockResolvedValue(author());

      const row = await service.findOrCreateByName(' blake ');

      expect(row).toEqual(author());
      expect(prisma.bookAuthor.findFirst).toHaveBeenCalledWith({
        where: { name: { equals: 'blake', mode: 'insensitive' } },
      });
      expect(prisma.bookAuthor.create).not.toHaveBeenCalled();
    });

    it('creates the row with the trimmed name when nothing matches', async () => {
      prisma.bookAuthor.findFirst.mockResolvedValue(null);
      prisma.bookAuthor.create.mockResolvedValue(author({ name: 'New' }));

      const row = await service.findOrCreateByName(' New ');

      expect(prisma.bookAuthor.create).toHaveBeenCalledWith({
        data: { name: 'New' },
      });
      expect(row.name).toBe('New');
    });
  });
});
