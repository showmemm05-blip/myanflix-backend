import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { categorySnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { CreateCategoryDto } from './dto/create-category.dto';
import type { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll() {
    const categories = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { movies: true } } },
    });
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      movieCount: c._count.movies,
    }));
  }

  async findByIdOrThrow(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { movies: true } } },
    });
    if (!category) throw new NotFoundException('Category not found');
    return {
      id: category.id,
      name: category.name,
      description: category.description,
      movieCount: category._count.movies,
    };
  }

  async create(dto: CreateCategoryDto, actor: AuthenticatedUser) {
    await this.assertNameAvailable(dto.name);
    const created = await this.prisma.category.create({ data: dto });

    await this.audit.record({
      action: 'category.create',
      actor,
      target: { type: 'category', id: created.id, label: created.name },
      after: categorySnapshot(created),
    });

    return created;
  }

  async update(id: string, dto: UpdateCategoryDto, actor: AuthenticatedUser) {
    const before = await this.findOrThrow(id);
    if (dto.name) await this.assertNameAvailable(dto.name, id);
    const updated = await this.prisma.category.update({
      where: { id },
      data: dto,
    });

    await this.audit.record({
      action: 'category.update',
      actor,
      target: { type: 'category', id, label: updated.name },
      before: categorySnapshot(before),
      after: categorySnapshot(updated),
    });

    return updated;
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const category = await this.findOrThrow(id);
    await this.prisma.category.delete({ where: { id } });

    await this.audit.record({
      action: 'category.delete',
      actor,
      target: { type: 'category', id, label: category.name },
      before: categorySnapshot(category),
      metadata: { unlinkedMovies: category._count.movies },
    });
  }

  /** The full row (plus how many movies carry it) — the audit `before`, and the existence check. */
  private async findOrThrow(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { movies: true } } },
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  private async assertNameAvailable(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.category.findUnique({ where: { name } });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException('A category with this name already exists');
    }
  }
}
