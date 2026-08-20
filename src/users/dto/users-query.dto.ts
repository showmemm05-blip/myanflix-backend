import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * Query for the admin user list. `search` backs the Users page search box and
 * the manual-deposit dialog's user picker — matched case-insensitively against
 * username, display name and phone, so an account stays findable by whichever
 * of the three the admin has in hand (the rendered label is only one of them).
 */
export class UsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
