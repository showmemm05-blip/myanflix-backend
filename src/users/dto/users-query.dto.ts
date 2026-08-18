import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * Query for the admin user list. `search` backs the manual-deposit dialog's
 * user picker (and any future list search) — matched case-insensitively
 * against username and phone.
 */
export class UsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
