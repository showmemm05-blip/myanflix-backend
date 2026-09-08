import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MinioService } from '../common/storage/minio.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { BookStatus } from '../generated/prisma/client';
import { AuthorityService } from '../roles/authority.service';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { BooksService } from './books.service';
import { BookQueryDto } from './dto/book-query.dto';
import {
  BookEditionResponseDto,
  BookPartResponseDto,
  BookResponseDto,
  toChapterDetail,
  toChapterSummary,
  toContentsResponse,
  toSectionDetail,
} from './dto/book-response.dto';
import type { ImageUrlResolver } from './dto/book-response.dto';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import {
  CreateBookEditionDto,
  UpdateBookEditionDto,
} from './dto/edition.dto';
import {
  CreateBookChapterDto,
  ReorderChaptersDto,
  UpdateBookChapterDto,
} from './dto/chapter.dto';
import { UpdateReadingProgressDto } from './dto/reading-progress.dto';
import {
  CreateBookPartDto,
  ReorderPartsDto,
  UpdateBookPartDto,
} from './dto/part.dto';
import {
  CreateBookSectionDto,
  ReorderSectionsDto,
  UpdateBookSectionDto,
} from './dto/section.dto';

/**
 * Books are multi-language: a book is the work, and every piece of CONTENT
 * hangs off one of its language editions. That is why almost every route
 * below is nested under `/books/:id/editions/:editionId` — the book id alone
 * is never enough to say which chapters or pages are meant.
 */
@Controller('books')
export class BooksController {
  constructor(
    private readonly booksService: BooksService,
    private readonly minioService: MinioService,
    private readonly authority: AuthorityService,
  ) {}

  /** Same arrow-property binding as MoviesController.resolveImageUrl, for the same reason. */
  private readonly resolveImageUrl: ImageUrlResolver = (url) =>
    this.minioService.imageUrl(url);

  @Get()
  async findAll(
    @Query() query: BookQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { items, total, page, limit } = await this.booksService.findAll(
      query,
      user.role,
    );
    return {
      items: items.map((b) =>
        BookResponseDto.fromEntity(b, this.resolveImageUrl),
      ),
      total,
      page,
      limit,
    };
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const book = await this.booksService.findByIdOrThrow(id, user.role);
    return BookResponseDto.fromEntity(book, this.resolveImageUrl);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.CREATE')
  async create(@Body() dto: CreateBookDto) {
    const book = await this.booksService.create(dto);
    return BookResponseDto.fromEntity(book, this.resolveImageUrl);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBookDto,
  ) {
    const book = await this.booksService.update(id, dto);
    return BookResponseDto.fromEntity(book, this.resolveImageUrl);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.DELETE')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.booksService.remove(id);
  }

  // ---------------------------------------------------------------------
  // Editions (languages)
  // ---------------------------------------------------------------------

  @Post(':id/editions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async addEdition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateBookEditionDto,
  ) {
    const edition = await this.booksService.addEdition(id, dto);
    return BookEditionResponseDto.fromEntity(edition);
  }

  /**
   * An edition publishes through this route's `status` field, the way movies
   * publish through PUT /movies/:id — BOOKS.EDIT covers renaming a language,
   * and only an edit that actually crosses the PUBLISHED line asks for the
   * extra permission.
   */
  @Put(':id/editions/:editionId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async updateEdition(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Body() dto: UpdateBookEditionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (dto.status !== undefined) {
      const current = await this.booksService.getEditionStatusOrThrow(
        id,
        editionId,
      );
      const wasPublished = current === BookStatus.PUBLISHED;
      const willBePublished = dto.status === BookStatus.PUBLISHED;

      if (!wasPublished && willBePublished) {
        await this.authority.assertHas(
          user,
          'BOOKS.PUBLISH',
          'You do not have permission to publish books',
        );
      } else if (wasPublished && !willBePublished) {
        await this.authority.assertHas(
          user,
          'BOOKS.UNPUBLISH',
          'You do not have permission to unpublish books',
        );
      }
    }

    const edition = await this.booksService.updateEdition(id, editionId, dto);
    return BookEditionResponseDto.fromEntity(edition);
  }

  @Delete(':id/editions/:editionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.DELETE')
  async removeEdition(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
  ) {
    await this.booksService.removeEdition(id, editionId);
  }

  // ---------------------------------------------------------------------
  // Contents (the numbered Part -> Chapter -> Section tree)
  // ---------------------------------------------------------------------

  /**
   * The whole table of contents of one language, numbered: unparted
   * chapters first, then each part with its chapters, each chapter with its
   * sections. Same visibility rule (and 404) as the chapter list.
   */
  @Get(':id/editions/:editionId/contents')
  async getContents(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { bookType, tree } = await this.booksService.getContents(
      id,
      editionId,
      user.role,
    );
    return toContentsResponse(tree, bookType, editionId, this.resolveImageUrl);
  }

  // ---------------------------------------------------------------------
  // Parts (optional grouping of chapters)
  // ---------------------------------------------------------------------

  @Get(':id/editions/:editionId/parts')
  async getParts(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const parts = await this.booksService.getParts(id, editionId, user.role);
    return parts.map((p) => BookPartResponseDto.fromEntity(p));
  }

  @Post(':id/editions/:editionId/parts')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async createPart(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Body() dto: CreateBookPartDto,
  ) {
    const part = await this.booksService.createPart(id, editionId, dto);
    return BookPartResponseDto.fromEntity(part);
  }

  /** Registered before ':partId' so "reorder" is never parsed as a part UUID. */
  @Patch(':id/editions/:editionId/parts/reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async reorderParts(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Body() dto: ReorderPartsDto,
  ) {
    await this.booksService.reorderParts(id, editionId, dto);
  }

  @Put(':id/editions/:editionId/parts/:partId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async updatePart(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('partId', ParseUUIDPipe) partId: string,
    @Body() dto: UpdateBookPartDto,
  ) {
    const part = await this.booksService.updatePart(id, editionId, partId, dto);
    return BookPartResponseDto.fromEntity(part);
  }

  /** The part goes; its chapters stay, now unparted — the same permission as deleting a chapter. */
  @Delete(':id/editions/:editionId/parts/:partId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async deletePart(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('partId', ParseUUIDPipe) partId: string,
  ) {
    await this.booksService.deletePart(id, editionId, partId);
  }

  // ---------------------------------------------------------------------
  // PDF conversion
  // ---------------------------------------------------------------------

  /** Start — or, after FAILED / an orphaned crash, retry — one language's conversion. */
  @Post(':id/editions/:editionId/chapters/:chapterId/process')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async process(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
  ) {
    await this.booksService.startProcessing(id, editionId, chapterId);
    return { started: true };
  }

  /** Polled by the admin while a language is UPLOADING/PROCESSING — never rate limited. */
  @SkipThrottle()
  @Get(':id/editions/:editionId/chapters/:chapterId/processing-status')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.VIEW')
  getProcessingStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
  ) {
    return this.booksService.getProcessingStatus(id, editionId, chapterId);
  }

  // ---------------------------------------------------------------------
  // Chapters (written books)
  // ---------------------------------------------------------------------

  @Get(':id/editions/:editionId/chapters')
  async getChapters(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const chapters = await this.booksService.getChapters(
      id,
      editionId,
      user.role,
    );
    return chapters.map((c) => toChapterSummary(c, this.resolveImageUrl));
  }

  @Post(':id/editions/:editionId/chapters')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async createChapter(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Body() dto: CreateBookChapterDto,
  ) {
    const chapter = await this.booksService.createChapter(id, editionId, dto);
    return toChapterSummary(chapter, this.resolveImageUrl);
  }

  /** Registered before ':chapterId' so "reorder" is never parsed as a chapter UUID. */
  @Patch(':id/editions/:editionId/chapters/reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async reorderChapters(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Body() dto: ReorderChaptersDto,
  ) {
    await this.booksService.reorderChapters(id, editionId, dto);
  }

  @Get(':id/editions/:editionId/chapters/:chapterId')
  async getChapter(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const chapter = await this.booksService.getChapterOrThrow(
      id,
      editionId,
      chapterId,
      user.role,
    );
    return toChapterDetail(chapter, this.resolveImageUrl);
  }

  @Put(':id/editions/:editionId/chapters/:chapterId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async updateChapter(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: UpdateBookChapterDto,
  ) {
    const chapter = await this.booksService.updateChapter(
      id,
      editionId,
      chapterId,
      dto,
    );
    return toChapterSummary(chapter, this.resolveImageUrl);
  }

  @Delete(':id/editions/:editionId/chapters/:chapterId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async deleteChapter(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
  ) {
    await this.booksService.deleteChapter(id, editionId, chapterId);
  }

  // ---------------------------------------------------------------------
  // Sections (optional subdivisions inside one chapter)
  // ---------------------------------------------------------------------

  /** Every section of one chapter WITH its document, numbered "N.1", "N.2"… */
  @Get(':id/editions/:editionId/chapters/:chapterId/sections')
  async getSections(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const sections = await this.booksService.getSections(
      id,
      editionId,
      chapterId,
      user.role,
    );
    return sections.map(toSectionDetail);
  }

  @Post(':id/editions/:editionId/chapters/:chapterId/sections')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async createSection(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: CreateBookSectionDto,
  ) {
    const section = await this.booksService.createSection(
      id,
      editionId,
      chapterId,
      dto,
    );
    return toSectionDetail(section);
  }

  /** Registered before ':sectionId'; written chapters only (PDF sections follow their pages). */
  @Patch(':id/editions/:editionId/chapters/:chapterId/sections/reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async reorderSections(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: ReorderSectionsDto,
  ) {
    await this.booksService.reorderSections(id, editionId, chapterId, dto);
  }

  @Put(':id/editions/:editionId/chapters/:chapterId/sections/:sectionId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async updateSection(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Body() dto: UpdateBookSectionDto,
  ) {
    const section = await this.booksService.updateSection(
      id,
      editionId,
      chapterId,
      sectionId,
      dto,
    );
    return toSectionDetail(section);
  }

  @Delete(':id/editions/:editionId/chapters/:chapterId/sections/:sectionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  async deleteSection(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
  ) {
    await this.booksService.deleteSection(id, editionId, chapterId, sectionId);
  }

  // ---------------------------------------------------------------------
  // Pages (PDF books)
  // ---------------------------------------------------------------------

  /**
   * Every converted page of one language, in reading order, with per-request
   * URLs derived from the stored keys (the avatar pattern). Width/height let
   * the reader reserve layout space before an image loads, which is what
   * keeps lazy loading from making the page jump.
   */
  @Get(':id/editions/:editionId/chapters/:chapterId/pages')
  async getPages(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const pages = await this.booksService.getPages(
      id,
      editionId,
      chapterId,
      user.role,
    );
    return pages.map((page) => ({
      pageNumber: page.pageNumber,
      url: this.minioService.playbackUrl(page.imageKey),
      width: page.width,
      height: page.height,
    }));
  }

  // ---------------------------------------------------------------------
  // Reading progress
  // ---------------------------------------------------------------------

  @Get(':id/editions/:editionId/reading-progress')
  async getReadingProgress(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const progress = await this.booksService.getReadingProgress(
      user.id,
      id,
      editionId,
      user.role,
    );
    if (!progress) return null;
    return this.readingProgressPayload(progress);
  }

  @Patch(':id/editions/:editionId/reading-progress')
  async updateReadingProgress(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('editionId', ParseUUIDPipe) editionId: string,
    @Body() dto: UpdateReadingProgressDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const progress = await this.booksService.updateReadingProgress(
      user.id,
      id,
      editionId,
      dto,
      user.role,
    );
    return this.readingProgressPayload(progress);
  }

  private readingProgressPayload(progress: {
    editionId: string;
    chapterId: string | null;
    pageNumber: number | null;
    sectionId: string | null;
    progress: number;
    updatedAt: Date;
  }) {
    return {
      editionId: progress.editionId,
      chapterId: progress.chapterId,
      pageNumber: progress.pageNumber,
      // null whenever the reader did not know (every book without sections).
      sectionId: progress.sectionId,
      progress: progress.progress,
      updatedAt: progress.updatedAt,
    };
  }
}
