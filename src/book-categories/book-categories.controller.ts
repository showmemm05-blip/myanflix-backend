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
  UseGuards,
} from '@nestjs/common';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { BookCategoriesService } from './book-categories.service';
import {
  CreateBookCategoryDto,
  UpdateBookCategoryDto,
} from './dto/book-category.dto';

/**
 * Book shelves are part of the books domain, so they are gated on BOOKS.*
 * rather than on a permission module of their own: whoever may edit the
 * catalogue may name its shelves, and a separate BOOK_CATEGORIES module
 * would be four more checkboxes on the roles matrix that nobody would ever
 * set differently.
 */
@Controller('book-categories')
export class BookCategoriesController {
  constructor(private readonly service: BookCategoriesService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findByIdOrThrow(id);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.CREATE')
  create(@Body() dto: CreateBookCategoryDto) {
    return this.service.create(dto);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.EDIT')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBookCategoryDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('BOOKS.DELETE')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(id);
  }
}
