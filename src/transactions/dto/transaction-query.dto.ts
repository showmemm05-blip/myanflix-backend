import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class TransactionQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID('4')
  userId?: string;
}
