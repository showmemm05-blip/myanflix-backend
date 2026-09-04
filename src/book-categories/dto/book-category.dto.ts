import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateBookCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateBookCategoryDto extends PartialType(CreateBookCategoryDto) {}
