import { IsEnum, IsOptional } from 'class-validator';
import { AccessType, SeriesStatus } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class SeriesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType;

  /** Staff-only filter — ignored for regular users, whose listing is always forced to PUBLISHED. */
  @IsOptional()
  @IsEnum(SeriesStatus)
  status?: SeriesStatus;
}
