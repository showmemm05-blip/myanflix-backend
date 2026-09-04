import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

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

  async create(dto: CreateBookCategoryDto) {
    await this.assertNameAvailable(dto.name);
    return this.prisma.bookCategory.create({ data: dto });
  }

  async update(id: string, dto: UpdateBookCategoryDto) {
    await this.assertExists(id);
    if (dto.name) await this.assertNameAvailable(dto.name, id);
    return this.prisma.bookCategory.update({ where: { id }, data: dto });
  }

  /**
   * The join rows go with it (schema cascade), so the books survive and
   * simply lose that shelf — the same semantics as deleting a movie category.
   */
  async remove(id: string): Promise<void> {
    await this.assertExists(id);
    await this.prisma.bookCategory.delete({ where: { id } });
  }

  private async assertExists(id: string): Promise<void> {
    const exists = await this.prisma.bookCategory.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Book category not found');
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
