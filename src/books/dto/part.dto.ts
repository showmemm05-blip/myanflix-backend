import { PartialType } from '@nestjs/mapped-types';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * A part is purely structural — a title and a position. It owns no content,
 * so there is nothing else to validate.
 */
export class CreateBookPartDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;
}

export class UpdateBookPartDto extends PartialType(CreateBookPartDto) {}

export class ReorderPartsDto {
  /** Every part of the edition, in its new order — the chapters' complete-set rule. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  partIds!: string[];
}
