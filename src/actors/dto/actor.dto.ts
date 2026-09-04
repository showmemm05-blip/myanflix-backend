import { PartialType } from '@nestjs/mapped-types';
import {
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class CreateActorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /**
   * A headshot's absolute URL, as POST /uploads/image returns it — the same
   * contract movie posters use. `require_tld: false` because a LAN host has
   * no TLD and must still validate.
   */
  @IsOptional()
  @IsUrl({ require_tld: false })
  imageUrl?: string;
}

export class UpdateActorDto extends PartialType(CreateActorDto) {}

export class ActorQueryDto extends PaginationQueryDto {
  /** Matches on name — what the cast picker types into. */
  @IsOptional()
  @IsString()
  search?: string;
}
