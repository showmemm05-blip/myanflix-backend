import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { BookStatus, BookType } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class BookQueryDto extends PaginationQueryDto {
  /**
   * Matches books having AT LEAST ONE edition in this status. Staff-only —
   * regular users always get published books, whatever they send.
   */
  @IsOptional()
  @IsEnum(BookStatus)
  status?: BookStatus;

  /**
   * The admin's review queue: books with a language that is not live yet but
   * already has a chapter a reader could open. Not expressible as a `status`
   * filter, because an edition is never put in READY — that vocabulary moved
   * to chapters.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  readyToPublish?: boolean;

  /** Matches books available in this language. */
  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsEnum(BookType)
  type?: BookType;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
