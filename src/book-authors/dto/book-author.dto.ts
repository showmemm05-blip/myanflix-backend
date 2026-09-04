import { PartialType } from '@nestjs/mapped-types';
import {
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateBookAuthorDto {
  /**
   * Trimmed BEFORE validation: a whitespace-only name would pass MinLength,
   * be trimmed to "" by the service, and — on rename — fan out an empty
   * author line to every credited book on the website and the app.
   */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /**
   * A portrait's absolute URL, as POST /uploads/image returns it — the same
   * contract actor headshots use. `require_tld: false` because a LAN host
   * has no TLD and must still validate.
   */
  @IsOptional()
  @IsUrl({ require_tld: false })
  imageUrl?: string;

  /** Null clears it; the admin sends null when the textarea is emptied. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  bio?: string | null;
}

export class UpdateBookAuthorDto extends PartialType(CreateBookAuthorDto) {}

/** `limit` is capped at 100 by PaginationQueryDto. */
export class BookAuthorQueryDto extends PaginationQueryDto {
  /** Matches on name — what the author picker types into. */
  @IsOptional()
  @IsString()
  search?: string;
}
