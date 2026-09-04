import { PartialType } from '@nestjs/mapped-types';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateBookChapterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  /**
   * The TipTap/ProseMirror JSON document — WRITTEN chapters only, and
   * therefore optional: a PDF chapter's content is the file it carries and
   * the pages converted from it.
   *
   * Validated only as "an object" here; the schema that gives it meaning
   * lives in the editor and the reader, and both only ever materialise nodes
   * they know, so unknown content is inert rather than dangerous.
   */
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  /** Optional cover for the chapter — available to both book types. */
  @IsOptional()
  @IsUrl({ require_tld: false })
  imageUrl?: string;

  /**
   * The part this chapter belongs to, or nothing. @IsOptional lets `null`
   * through on purpose: on update, `undefined` leaves the assignment alone
   * while `null` unassigns the chapter (it then reads before the first
   * part). The service checks the part belongs to the same edition.
   */
  @IsOptional()
  @IsUUID('4')
  partId?: string | null;
}

export class UpdateBookChapterDto extends PartialType(CreateBookChapterDto) {}

export class ReorderChaptersDto {
  /** Every chapter of the book, in its new reading order. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  chapterIds!: string[];
}
