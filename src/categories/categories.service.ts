import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateCategoryDto } from './dto/create-category.dto';
import type { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

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

  async create(dto: CreateCategoryDto) {
    await this.assertNameAvailable(dto.name);
    return this.prisma.category.create({ data: dto });
  }

  async update(id: string, dto: UpdateCategoryDto) {
    await this.assertExists(id);
    if (dto.name) await this.assertNameAvailable(dto.name, id);
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async remove(id: string): Promise<void> {
    await this.assertExists(id);
    await this.prisma.category.delete({ where: { id } });
  }

  private async assertExists(id: string): Promise<void> {
    const exists = await this.prisma.category.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Category not found');
  }

  private async assertNameAvailable(name: string, excludeId?: string): Promise<void> {
    const existing = await this.prisma.category.findUnique({ where: { name } });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException('A category with this name already exists');
    }
  }
}
