import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*\.\.)[\w\-./]+$/;

class PresignBatchFileDto {
  @IsString()
  @MinLength(1)
  @Matches(RELATIVE_PATH_PATTERN, {
    message: 'relativePath must be a relative path with no ".." segments',
  })
  relativePath!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  filesize!: number;
}

export class PresignBatchDto {
  @IsString()
  @MinLength(1)
  resourceType!: string;

  @IsString()
  @MinLength(1)
  resourceId!: string;

  // Client paginates (~250/request) for its own throughput reasons — this
  // ceiling is just a sanity backstop against a malformed/pathological request.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PresignBatchFileDto)
  files!: PresignBatchFileDto[];
}
