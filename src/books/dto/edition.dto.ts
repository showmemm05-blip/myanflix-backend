import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { BookStatus } from '../../generated/prisma/client';

/**
 * Language codes are validated by SHAPE, not against a list: the admin picks
 * from a curated dropdown, but a new language must never require a backend
 * deploy (the same reasoning as Movie.language being an open string).
 */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export class CreateBookEditionDto {
  @IsString()
  @MaxLength(16)
  @Matches(LANGUAGE_CODE, {
    message: 'language must be a code like "my", "en" or "zh-Hant"',
  })
  language!: string;
}

export class UpdateBookEditionDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(LANGUAGE_CODE, {
    message: 'language must be a code like "my", "en" or "zh-Hant"',
  })
  language?: string;

  /**
   * Publishing is per language — see BookEdition's schema doc. The route
   * asks for BOOKS.PUBLISH/UNPUBLISH only when an edit crosses the
   * PUBLISHED line, exactly as movies do.
   */
  @IsOptional()
  @IsEnum(BookStatus)
  status?: BookStatus;
}
