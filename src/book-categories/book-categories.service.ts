import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { bookCategorySnapshot } from '../audit/audit-snapshots';
import { AuditService } from '../audit/audit.service';
import type {
  CreateBookCategoryDto,
  UpdateBookCategoryDto,
} from './dto/book-category.dto';

/**
 * The books' own shelves — CategoriesService's twin, against the separate
 * BookCategory table.
 *
 * Deliberately a second service rather than a `type` column on the shared
 * one: a book catalogue's vocabulary (Manga, Manhwa, Light Novel) has nothing
 * to say about films, and folding them together put every genre invented for
 * a book into the movie picker.
 */
@Injectable()
export class BookCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll() {
    const categories = await this.prisma.bookCategory.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { books: true } } },
    });
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      bookCount: c._count.books,
    }));
  }

  async findByIdOrThrow(id: string) {
    const category = await this.prisma.bookCategory.findUnique({
      where: { id },
      include: { _count: { select: { books: true } } },
    });
    if (!category) throw new NotFoundException('Book category not found');
    return {
      id: category.id,
      name: category.name,
      description: category.description,
      bookCount: category._count.books,
    };
  }

  async create(dto: CreateBookCategoryDto, actor: AuthenticatedUser) {
    await this.assertNameAvailable(dto.name);
    const created = await this.prisma.bookCategory.create({ data: dto });
    await this.audit.record({
      action: 'book_category.create',
      actor,
      target: { type: 'book_category', id: created.id, label: created.name },
      after: bookCategorySnapshot(created),
    });
    return created;
  }

  async update(
    id: string,
    dto: UpdateBookCategoryDto,
    actor: AuthenticatedUser,
  ) {
    const before = await this.rowOrThrow(id);
    if (dto.name) await this.assertNameAvailable(dto.name, id);
    const after = await this.prisma.bookCategory.update({
      where: { id },
      data: dto,
    });
    await this.audit.record({
      action: 'book_category.update',
      actor,
      target: { type: 'book_category', id, label: after.name },
      before: bookCategorySnapshot(before),
      after: bookCategorySnapshot(after),
    });
    return after;
  }

  /**
   * The join rows go with it (schema cascade), so the books survive and
   * simply lose that shelf — the same semantics as deleting a movie category.
   */
  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const category = await this.rowOrThrow(id);
    await this.prisma.bookCategory.delete({ where: { id } });
    await this.audit.record({
      action: 'book_category.delete',
      actor,
      target: { type: 'book_category', id, label: category.name },
      before: bookCategorySnapshot(category),
      metadata: { unlinkedBooks: category._count.books },
    });
  }

  /** The row itself (not just its id): the audit snapshot wants the old values. */
  private async rowOrThrow(id: string) {
    const category = await this.prisma.bookCategory.findUnique({
      where: { id },
      include: { _count: { select: { books: true } } },
    });
    if (!category) throw new NotFoundException('Book category not found');
    return category;
  }

  private async assertNameAvailable(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.bookCategory.findUnique({
      where: { name },
    });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException(
        'A book category with this name already exists',
      );
    }
  }
}
