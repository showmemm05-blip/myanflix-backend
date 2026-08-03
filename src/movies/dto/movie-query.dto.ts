import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { MovieStatus } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class MovieQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(MovieStatus)
  status?: MovieStatus;

  /** Staff-only filter: episodes of one series. Ignored for regular users, whose catalog never contains episodes at all. */
  @IsOptional()
  @IsUUID('4')
  seriesId?: string;

  @IsOptional()
  @IsString()
  genre?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
