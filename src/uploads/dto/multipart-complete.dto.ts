import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

class CompletedPartDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  partNumber!: number;

  @IsString()
  @MinLength(1)
  etag!: string;
}

export class MultipartCompleteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts!: CompletedPartDto[];
}
