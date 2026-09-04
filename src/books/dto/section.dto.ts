import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * A section is one of two things depending on the book type, and the service
 * enforces which: a WRITTEN section carries its own TipTap document in
 * `content`; a PDF section is a page anchor whose range starts at
 * `startPage` (1-based within the chapter) and ends where the next one
 * starts. Sending the wrong field for the type is a 400, not silently
 * ignored.
 */
export class CreateBookSectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  /** WRITTEN chapters only — validated as "an object", like a chapter's. */
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  /** PDF chapters only — bounded by the chapter's pageCount in the service. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  startPage?: number;
}

export class UpdateBookSectionDto extends PartialType(CreateBookSectionDto) {}

export class ReorderSectionsDto {
  /** Every section of the chapter, in its new order — written chapters only. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  sectionIds!: string[];
}
