import { IsEnum, IsOptional } from 'class-validator';
import { ClientPlatform } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * No date window: "active" is defined by the live presence window, not by a
 * range an operator picks. `platform` narrows the ROWS only — the summary
 * counts always describe the whole active set, so the three cards above the
 * table do not change when the table is filtered.
 */
export class ActiveUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ClientPlatform)
  platform?: ClientPlatform;
}
