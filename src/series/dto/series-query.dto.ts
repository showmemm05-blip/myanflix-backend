import { IsEnum, IsOptional } from 'class-validator';
import { AccessType } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class SeriesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType;
}
