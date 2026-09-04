import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { BookAuthorsService } from './book-authors.service';
import {
  BookAuthorQueryDto,
  CreateBookAuthorDto,
  UpdateBookAuthorDto,
} from './dto/book-author.dto';
import { BookAuthorResponseDto } from './dto/book-author-response.dto';
import type { ImageUrlResolver } from '../books/dto/book-response.dto';

/**
 * Reads are open to any authenticated caller — who wrote a book is public
 * catalog metadata, exactly like its categories. Mutations are gated on the
 * BOOKS.* permissions rather than a family of their own, for the same reason
 * book categories are: whoever may edit the catalogue may name its authors.
 */
@Controller('book-authors')
export class BookAuthorsController {
  constructor(
    private readonly bookAuthorsService: BookAuthorsService,
    private readonly minioService: MinioService,
  ) {}

  /** Portraits are persisted absolute and re-hosted per request — see MinioService.imageUrl. */
  private readonly resolveImageUrl: ImageUrlResolver = (url) =>
    this.minioService.imageUrl(url);

  @Get()
  async findAll(@Query() query: BookAuthorQueryDto) {
    const { items, total, page, limit } =
      await this.bookAuthorsService.findAll(query);
    return {
      items: items.map((a) =>
        BookAuthorResponseDto.fromEntity(a, this.resolveImageUrl),
      ),
      total,
      page,
      limit,
    };
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const author = await this.bookAuthorsService.findByIdOrThrow(id);
    return BookAuthorResponseDto.fromEntity(author, this.resolveImageUrl);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.CREATE')
  async create(@Body() dto: CreateBookAuthorDto) {
    const author = await this.bookAuthorsService.create(dto);
    return BookAuthorResponseDto.fromEntity(author, this.resolveImageUrl);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBookAuthorDto,
  ) {
    const author = await this.bookAuthorsService.update(id, dto);
    return BookAuthorResponseDto.fromEntity(author, this.resolveImageUrl);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.DELETE')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.bookAuthorsService.remove(id);
  }
}
