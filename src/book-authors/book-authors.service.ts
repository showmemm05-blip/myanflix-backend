import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { bookAuthorSnapshot } from '../audit/audit-snapshots';
import { AuditService } from '../audit/audit.service';
import type {
  BookAuthorQueryDto,
  CreateBookAuthorDto,
  UpdateBookAuthorDto,
} from './dto/book-author.dto';

const WITH_BOOK_COUNT = {
  _count: { select: { books: true } },
} satisfies Prisma.BookAuthorInclude;

/** Prisma's unique-constraint violation code. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * The books' twin of ActorsService, with one extra responsibility: every
 * book carries a denormalised copy of its author's name (`Book.author`, the
 * string every client reads), so a rename here fans out to those rows.
 */
@Injectable()
export class BookAuthorsService {
  private readonly logger = new Logger(BookAuthorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly audit: AuditService,
  ) {}

  /** Browsed and searched, so alphabetical is the useful order. */
  async findAll(query: BookAuthorQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.BookAuthorWhereInput = {};
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.bookAuthor.findMany({
        where,
        include: WITH_BOOK_COUNT,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.bookAuthor.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async findByIdOrThrow(id: string) {
    const author = await this.prisma.bookAuthor.findUnique({
      where: { id },
      include: WITH_BOOK_COUNT,
    });
    if (!author) throw new NotFoundException('Book author not found');
    return author;
  }

  async create(dto: CreateBookAuthorDto, actor: AuthenticatedUser) {
    const name = dto.name.trim();
    await this.assertNameAvailable(name);
    const created = await this.prisma.bookAuthor.create({
      data: {
        name,
        imageUrl: this.minioService.canonicalImageUrl(dto.imageUrl),
        bio: dto.bio ?? null,
      },
      include: WITH_BOOK_COUNT,
    });
    await this.audit.record({
      action: 'book_author.create',
      actor,
      target: { type: 'book_author', id: created.id, label: created.name },
      after: bookAuthorSnapshot(created),
    });
    return created;
  }

  /**
   * A rename is written together with the fan-out to every credited book's
   * display string, in one transaction — the invariant `book.author ===
   * authorRef.name` must never be observable as broken.
   */
  async update(id: string, dto: UpdateBookAuthorDto, actor: AuthenticatedUser) {
    const current = await this.prisma.bookAuthor.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Book author not found');

    const name = dto.name !== undefined ? dto.name.trim() : undefined;
    if (name !== undefined) await this.assertNameAvailable(name, id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.bookAuthor.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(dto.imageUrl !== undefined
            ? { imageUrl: this.minioService.canonicalImageUrl(dto.imageUrl) }
            : {}),
          ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
        },
        include: WITH_BOOK_COUNT,
      });
      // How many books the rename reached — only a rename fans out at all.
      let affectedBooks = 0;
      if (name !== undefined && name !== current.name) {
        const fanOut = await tx.book.updateMany({
          where: { authorId: id },
          data: { author: name },
        });
        affectedBooks = fanOut.count;
      }
      // Inside the transaction, so the audit row commits — or rolls back —
      // together with the rename and its fan-out.
      await this.audit.record({
        action: 'book_author.update',
        actor,
        target: { type: 'book_author', id, label: row.name },
        before: bookAuthorSnapshot(current),
        after: bookAuthorSnapshot(row),
        metadata: { affectedBooks },
        tx,
      });
      return row;
    });

    // A replaced portrait's object would otherwise sit in the bucket forever
    // with nothing pointing at it. Best-effort, and only when the URL really
    // changed — re-saving the same author must not delete the live image.
    if (
      dto.imageUrl !== undefined &&
      current.imageUrl &&
      current.imageUrl !== updated.imageUrl
    ) {
      await this.deleteImage(current.imageUrl, id);
    }

    return updated;
  }

  /**
   * An author still credited on a book is refused (409) rather than cascaded
   * or nulled out from under the book — the FK is RESTRICT, so a bypass
   * would fail at the database too. DB row first, then the portrait, the
   * same order and reasoning as ActorsService.remove.
   */
  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const author = await this.prisma.bookAuthor.findUnique({
      where: { id },
      include: WITH_BOOK_COUNT,
    });
    if (!author) throw new NotFoundException('Book author not found');

    const n = author._count.books;
    if (n > 0) {
      throw new ConflictException(
        `"${author.name}" is still credited on ${n} book${n === 1 ? '' : 's'}. Reassign or delete those books first.`,
      );
    }

    await this.prisma.bookAuthor.delete({ where: { id } });
    await this.audit.record({
      action: 'book_author.delete',
      actor,
      target: { type: 'book_author', id, label: author.name },
      before: bookAuthorSnapshot(author),
    });
    if (author.imageUrl) await this.deleteImage(author.imageUrl, id);
  }

  /**
   * The legacy/bulk path: a bare name from POST/PUT /books. Matched
   * case-insensitively on the trimmed name so 'blake' never becomes a second
   * row beside 'Blake'; created when nothing matches. A concurrent create of
   * the same name loses the unique race and simply re-reads the winner.
   *
   * `actor` is the staff member whose book form typed the name: a row born
   * here is still an author they created, and is audited as such.
   */
  async findOrCreateByName(rawName: string, actor?: AuthenticatedUser) {
    const name = rawName.trim();
    const existing = await this.findByNameInsensitive(name);
    if (existing) return existing;

    try {
      const created = await this.prisma.bookAuthor.create({ data: { name } });
      if (actor) {
        await this.audit.record({
          action: 'book_author.create',
          actor,
          target: { type: 'book_author', id: created.id, label: created.name },
          after: bookAuthorSnapshot(created),
          metadata: { via: 'book_form' },
        });
      }
      return created;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        const winner = await this.findByNameInsensitive(name);
        if (winner) return winner;
      }
      throw error;
    }
  }

  private findByNameInsensitive(name: string) {
    return this.prisma.bookAuthor.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
  }

  private async deleteImage(url: string, authorId: string): Promise<void> {
    try {
      const key = this.minioService.keyFromPublicUrl(url);
      if (key) await this.minioService.deleteObject(key);
    } catch (error) {
      this.logger.warn(
        `Failed to clean up the portrait for book author ${authorId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Uniqueness is case-insensitive here even though the DB index is exact:
   * 'Blake' and 'blake' are one person, and the whole point of a row per
   * author is that they cannot end up in the catalogue twice.
   */
  private async assertNameAvailable(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.findByNameInsensitive(name);
    if (existing && existing.id !== excludeId) {
      throw new ConflictException(
        'A book author with this name already exists',
      );
    }
  }
}
