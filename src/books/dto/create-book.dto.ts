import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { BookType } from '../../generated/prisma/client';

export class CreateBookDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  /**
   * Legacy/bulk path: a bare name. Find-or-created case-insensitively and
   * linked, so every book ends up credited to a BookAuthor row. Ignored when
   * `authorId` is given. One of the two is required on create.
   */
  @ValidateIf((o: CreateBookDto) => o.authorId === undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  author?: string;

  /** The BookAuthor to credit. Wins over `author` when both are sent. */
  @IsOptional()
  @IsUUID('4')
  authorId?: string;

  @IsString()
  @MaxLength(4000)
  description!: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  coverUrl?: string;

  /**
   * Fixed at creation — an EDITOR book can never become a PDF book or vice
   * versa, because everything downstream (chapters vs pages, the admin
   * workflow, the reader) branches on it. UpdateBookDto omits it.
   */
  @IsEnum(BookType)
  type!: BookType;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  /**
   * The language of the first edition. A book is created with one language
   * already in place — there is no useful state between "a book exists" and
   * "it has somewhere to put content". Further languages are added through
   * POST /books/:id/editions.
   */
  @IsString()
  @MaxLength(16)
  @Matches(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, {
    message: 'language must be a code like "my", "en" or "zh-Hant"',
  })
  language!: string;
}
